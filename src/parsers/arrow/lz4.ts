export interface Lz4BlockDecoder {
    decompressBlock(input: Uint8Array, output: Uint8Array, start: number, length: number, written: number): number;
}
export type XxHash32 = (seed: number, input: Uint8Array, start: number, length: number) => number;

/** Decode LZ4 framing ourselves: lz4js 0.2 skips block checksums before payloads. */
export function decodeLz4Frame(input: Uint8Array, expectedBytes: number, decoder: Lz4BlockDecoder, hash: XxHash32): Uint8Array {
    const output = new Uint8Array(expectedBytes);
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const fail = (): never => { throw new Error('Invalid LZ4 frame'); };
    let position = 0, written = 0, frames = 0;
    const requireBytes = (length: number) => { if (length < 0 || length > input.length - position) fail(); };
    const u32 = () => { requireBytes(4); const result = view.getUint32(position, true); position += 4; return result; };
    while (position < input.length) {
        const magic = u32();
        if ((magic & 0xfffffff0) === 0x184d2a50) { const length = u32(); requireBytes(length); position += length; continue; }
        if (magic !== 0x184d2204) fail();
        frames++;
        requireBytes(2);
        const descriptor = position, flags = input[position++]!, blockDescriptor = input[position++]!;
        const blockCode = (blockDescriptor >>> 4) & 7;
        if ((flags & 0xc0) !== 0x40 || (flags & 2) || (blockDescriptor & 0x8f) || blockCode < 4 || blockCode > 7) fail();
        const maxBlock = 2 ** (8 + 2 * blockCode), frameStart = written;
        let contentSize: bigint | undefined;
        if (flags & 8) {
            requireBytes(8); contentSize = view.getBigUint64(position, true); position += 8;
            if (contentSize > BigInt(expectedBytes - written)) fail();
        }
        // External dictionaries are not available in an IPC body buffer.
        if ((flags & 1) && u32() !== 0) fail();
        requireBytes(1);
        if (input[position] !== ((hash(0, input, descriptor, position - descriptor) >>> 8) & 255)) fail();
        position++;
        for (;;) {
            const header = u32();
            if (header === 0) break;
            const length = header & 0x7fffffff, start = position, blockStart = written;
            if (length > maxBlock) fail();
            requireBytes(length); position += length;
            if ((flags & 0x10) && u32() !== hash(0, input, start, length)) fail();
            if (header & 0x80000000) {
                if (length > expectedBytes - written) fail();
                output.set(input.subarray(start, start + length), written); written += length;
            } else {
                const predicted = validateBlock(input, start, length, written, (flags & 0x20) ? blockStart : frameStart, Math.min(expectedBytes, blockStart + maxBlock));
                written = decoder.decompressBlock(input, output, start, length, written);
                if (written !== predicted) fail();
            }
        }
        if (contentSize !== undefined && contentSize !== BigInt(written - frameStart)) fail();
        if ((flags & 4) && u32() !== hash(0, output, frameStart, written - frameStart)) fail();
    }
    if (!frames || written !== expectedBytes) fail();
    return output;
}

/** Validate reads, match distances and output bounds before the dependency copies. */
function validateBlock(input: Uint8Array, start: number, length: number, written: number, historyStart: number, outputLimit: number): number {
    const end = start + length;
    let position = start;
    const fail = (): never => { throw new Error('Invalid LZ4 block'); };
    const extended = (initial: number) => {
        let count = initial;
        if (initial === 15) {
            let next: number;
            do {
                if (position >= end) fail();
                next = input[position++]!; count += next;
                if (count > outputLimit - written) fail();
            } while (next === 255);
        }
        return count;
    };
    while (position < end) {
        const token = input[position++]!, literals = extended(token >>> 4);
        if (literals > end - position || literals > outputLimit - written) fail();
        position += literals; written += literals;
        if (position === end) return written;
        if (end - position < 2) fail();
        const distance = input[position]! | (input[position + 1]! << 8); position += 2;
        if (distance === 0 || distance > written - historyStart) fail();
        const matches = extended(token & 15) + 4;
        if (matches > outputLimit - written) fail();
        written += matches;
    }
    return written;
}
