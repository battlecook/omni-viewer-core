import { describe, expect, it } from 'vitest';
import { encodeWavFromFloat32 } from './engine.js';
import {
    readWavHeader,
    streamWavFrames,
    type AudioByteSource,
    type WavStreamInfo
} from './wav-stream.js';

/** Counts range reads so tests can prove the file is never read whole. */
function source(bytes: Uint8Array): AudioByteSource & { reads: number; bytesRead: number } {
    return {
        byteLength: bytes.byteLength,
        reads: 0,
        bytesRead: 0,
        async slice(this: { reads: number; bytesRead: number }, start: number, end: number) {
            this.reads++;
            this.bytesRead += end - start;
            return bytes.slice(start, end).buffer;
        }
    } as AudioByteSource & { reads: number; bytesRead: number };
}

async function collect(src: AudioByteSource, info: WavStreamInfo, chunkFrames?: number): Promise<number[]> {
    const all: number[] = [];
    for await (const chunk of streamWavFrames(src, info, chunkFrames ? { chunkFrames } : {})) {
        all.push(...chunk);
    }
    return all;
}

describe('wav header', () => {
    it('reads channels, rate, depth and frame count', async () => {
        const wav = encodeWavFromFloat32(new Float32Array(600), 2, 44100);
        const info = await readWavHeader(source(wav));
        expect(info.channels).toBe(2);
        expect(info.sampleRate).toBe(44100);
        expect(info.bitsPerSample).toBe(16);
        expect(info.float).toBe(false);
        expect(info.frames).toBe(300);
        expect(info.dataOffset).toBe(44);
    });

    it('reads only the header window, not the file', async () => {
        const wav = encodeWavFromFloat32(new Float32Array(2_000_000), 2, 44100);
        const src = source(wav);
        await readWavHeader(src);
        expect(src.reads).toBe(1);
        expect(src.bytesRead).toBeLessThanOrEqual(64 * 1024);
        expect(src.bytesRead).toBeLessThan(wav.byteLength / 10);
    });

    it('skips chunks that precede fmt/data', async () => {
        const wav = encodeWavFromFloat32(new Float32Array(20), 1, 8000);
        // Splice a LIST chunk between the header and fmt.
        const list = new Uint8Array(8 + 10);
        list.set([0x4c, 0x49, 0x53, 0x54]); // 'LIST'
        new DataView(list.buffer).setUint32(4, 10, true);
        const spliced = new Uint8Array(wav.byteLength + list.byteLength);
        spliced.set(wav.subarray(0, 12), 0);
        spliced.set(list, 12);
        spliced.set(wav.subarray(12), 12 + list.byteLength);
        new DataView(spliced.buffer).setUint32(4, spliced.byteLength - 8, true);

        const info = await readWavHeader(source(spliced));
        expect(info.channels).toBe(1);
        expect(info.frames).toBe(20);
    });

    it('rejects non-RIFF input', async () => {
        await expect(readWavHeader(source(new Uint8Array(64)))).rejects.toThrow(/RIFF/);
    });

    it('rejects a truncated file', async () => {
        await expect(readWavHeader(source(new Uint8Array(4)))).rejects.toThrow(/too short/);
    });
});

describe('wav streaming', () => {
    it('round-trips samples written by encodeWavFromFloat32', async () => {
        const pcm = new Float32Array([0, 0.25, -0.25, 0.5, -0.5, 0.75]);
        const wav = encodeWavFromFloat32(pcm, 2, 44100);
        const src = source(wav);
        const info = await readWavHeader(src);
        const out = await collect(src, info);
        expect(out).toHaveLength(pcm.length);
        for (let i = 0; i < pcm.length; i++) expect(out[i]).toBeCloseTo(pcm[i]!, 4);
    });

    it('produces identical samples no matter the chunk size', async () => {
        const pcm = new Float32Array(4096).map((_, i) => Math.sin(i / 7) * 0.9);
        const wav = encodeWavFromFloat32(pcm, 2, 44100);
        const info = await readWavHeader(source(wav));
        const big = await collect(source(wav), info, 4096);
        const small = await collect(source(wav), info, 13);
        expect(small).toEqual(big);
    });

    // Flat memory is the property that removes the file-length ceiling: the
    // reader must hold one chunk, not the file.
    it('holds only one chunk regardless of length', async () => {
        const frames = 200_000;
        const wav = encodeWavFromFloat32(new Float32Array(frames * 2), 2, 44100);
        const src = source(wav);
        const info = await readWavHeader(src);
        let largestChunk = 0;
        let seenFrames = 0;
        for await (const chunk of streamWavFrames(src, info, { chunkFrames: 1024 })) {
            largestChunk = Math.max(largestChunk, chunk.byteLength);
            seenFrames += chunk.length / info.channels;
        }
        expect(seenFrames).toBe(frames);
        expect(largestChunk).toBe(1024 * 2 * 4);
        expect(largestChunk).toBeLessThan(wav.byteLength / 50);
    });

    it('honours an abort signal mid-stream', async () => {
        const wav = encodeWavFromFloat32(new Float32Array(100_000), 1, 44100);
        const src = source(wav);
        const info = await readWavHeader(src);
        const controller = new AbortController();
        const iterate = async (): Promise<void> => {
            let chunks = 0;
            for await (const _ of streamWavFrames(src, info, { chunkFrames: 1000, signal: controller.signal })) {
                if (++chunks === 3) controller.abort();
            }
        };
        await expect(iterate()).rejects.toThrow(/aborted/);
    });

    it('decodes 8-bit, 24-bit and 32-bit float payloads', async () => {
        const cases: Array<{ bits: number; float: boolean; write(view: DataView): void; expected: number }> = [
            { bits: 8, float: false, write: (v) => v.setUint8(0, 192), expected: 0.5 },
            { bits: 24, float: false, write: (v) => { v.setUint8(0, 0); v.setUint8(1, 0); v.setUint8(2, 0x40); }, expected: 0.5 },
            { bits: 32, float: true, write: (v) => v.setFloat32(0, 0.5, true), expected: 0.5 }
        ];
        for (const { bits, float, write, expected } of cases) {
            const bytes = bits / 8;
            const buffer = new ArrayBuffer(44 + bytes);
            const view = new DataView(buffer);
            const put = (offset: number, text: string): void => {
                for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
            };
            put(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); put(8, 'WAVE');
            put(12, 'fmt '); view.setUint32(16, 16, true);
            view.setUint16(20, float ? 3 : 1, true);
            view.setUint16(22, 1, true);
            view.setUint32(24, 8000, true);
            view.setUint32(28, 8000 * bytes, true);
            view.setUint16(32, bytes, true);
            view.setUint16(34, bits, true);
            put(36, 'data'); view.setUint32(40, bytes, true);
            write(new DataView(buffer, 44));

            const src = source(new Uint8Array(buffer));
            const info = await readWavHeader(src);
            expect(info.bitsPerSample, `${bits}-bit`).toBe(bits);
            const out = await collect(src, info);
            expect(out[0], `${bits}-bit${float ? ' float' : ''}`).toBeCloseTo(expected, 2);
        }
    });
});
