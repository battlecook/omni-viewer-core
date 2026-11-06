import { McapDecompressionLimitError } from './errors.js';

interface ZstdDecoder {
    Decompress: new (ondata: (data: Uint8Array) => void) => { push(data: Uint8Array, final: boolean): unknown };
}
interface Frame { start: number; end: number; contentSize: bigint | undefined }

/** Validate every frame before fzstd can allocate a header-controlled history window. */
export function decodeZstdFrames(input: Uint8Array, expectedBytes: number, zstd: ZstdDecoder, maxWindowBytes: number): Uint8Array {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const fail = (): never => { throw new Error('Invalid or oversized ZSTD frame'); };
    const scan = (visit: (frame: Frame) => void): void => {
        let position = 0, knownOutput = 0n, minimumOutput = 0;
        const requireBytes = (count: number) => { if (count < 0 || count > input.length - position) fail(); };
        const read = (count: number): bigint => {
            requireBytes(count);
            let value = 0n;
            for (let i = 0; i < count; i++) value |= BigInt(input[position++]!) << BigInt(i * 8);
            return value;
        };
        if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || !Number.isSafeInteger(maxWindowBytes) || maxWindowBytes < 0 || !input.length) fail();
        while (position < input.length) {
            const start = position;
            requireBytes(4); const magic = view.getUint32(position, true); position += 4;
            if ((magic & 0xfffffff0) === 0x184d2a50) {
                const length = Number(read(4)); requireBytes(length); position += length; continue;
            }
            if (magic !== 0xfd2fb528) fail();
            const descriptor = Number(read(1));
            if (descriptor & 0x08) fail();
            const singleSegment = !!(descriptor & 0x20), sizeFlag = descriptor >>> 6;
            let window = 0;
            if (!singleSegment) {
                const descriptor = Number(read(1));
                const base = 2 ** (10 + (descriptor >>> 3));
                window = base + base / 8 * (descriptor & 7);
                if (window > maxWindowBytes) throw new McapDecompressionLimitError();
            }
            const dictionaryBytes = [0, 1, 2, 4][descriptor & 3]!;
            // The optional peer has no API for resolving external dictionaries.
            if (read(dictionaryBytes) !== 0n) fail();
            const sizeBytes = sizeFlag ? 2 ** sizeFlag : singleSegment ? 1 : 0;
            const contentSize = sizeBytes ? read(sizeBytes) + (sizeFlag === 1 ? 256n : 0n) : undefined;
            if (contentSize !== undefined) {
                knownOutput += contentSize;
                if (knownOutput > BigInt(expectedBytes)) fail();
                if (singleSegment) {
                    if (contentSize > BigInt(maxWindowBytes)) throw new McapDecompressionLimitError();
                    window = Number(contentSize);
                }
            }
            let last = false;
            while (!last) {
                const block = Number(read(3));
                last = !!(block & 1);
                const type = (block >>> 1) & 3, size = block >>> 3;
                if (type === 3 || size > Math.min(128 * 1024, window)) fail();
                if (type !== 2) { minimumOutput += size; if (minimumOutput > expectedBytes) fail(); }
                const compressedSize = type === 1 ? 1 : size;
                requireBytes(compressedSize); position += compressedSize;
            }
            if (descriptor & 4) { requireBytes(4); position += 4; }
            visit({ start, end: position, contentSize });
        }
    };
    // Two bounded passes avoid retaining a frame object for every empty frame.
    scan(() => undefined);
    const output = new Uint8Array(expectedBytes);
    let written = 0;
    scan(frame => {
        const start = written;
        const decoder = new zstd.Decompress(chunk => {
            if (chunk.length > expectedBytes - written) fail();
            output.set(chunk, written); written += chunk.length;
        });
        decoder.push(input.subarray(frame.start, frame.end), true);
        if (frame.contentSize !== undefined && BigInt(written - start) !== frame.contentSize) fail();
    });
    if (written !== expectedBytes) fail();
    return output;
}
