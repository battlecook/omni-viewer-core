import { describe, expect, it } from 'vitest';
import { encodeWavFromFloat32 } from './engine.js';
import { createPyramidBuilder } from './pyramid.js';
import { analyzeWavSource, peakColumns } from './wav-analyzer.js';
import type { AudioByteSource } from './wav-stream.js';

function source(bytes: Uint8Array): AudioByteSource & { bytesRead: number } {
    const src = {
        byteLength: bytes.byteLength,
        bytesRead: 0,
        async slice(start: number, end: number) {
            src.bytesRead += end - start;
            return bytes.slice(start, end).buffer as ArrayBuffer;
        }
    };
    return src;
}

/** Stereo WAV whose left channel is loud and right channel quiet. */
function stereoWav(frames: number, left: number, right: number, sampleRate = 44100): Uint8Array {
    const pcm = new Float32Array(frames * 2);
    for (let f = 0; f < frames; f++) {
        pcm[f * 2] = f % 2 ? left : -left;
        pcm[f * 2 + 1] = f % 2 ? right : -right;
    }
    return encodeWavFromFloat32(pcm, 2, sampleRate);
}

describe('wav analyzer', () => {
    it('reports rate, channels and duration from the stream itself', async () => {
        const wav = stereoWav(44100, 0.8, 0.2);
        const analysis = await analyzeWavSource(source(wav), 100);
        expect(analysis.sampleRate).toBe(44100);
        expect(analysis.channels).toBe(2);
        expect(analysis.duration).toBeCloseTo(1, 6);
    });

    // The engine collapses every channel into one mono column; this is the
    // difference the streaming path is meant to restore.
    it('keeps channels separate instead of downmixing', async () => {
        const analysis = await analyzeWavSource(source(stereoWav(44100, 0.8, 0.2)), 50);
        expect(analysis.channelPeaks).toHaveLength(2);
        expect(analysis.channelPeaks[0]).toHaveLength(50);
        for (const value of analysis.channelPeaks[0]!) expect(value).toBeCloseTo(0.8, 2);
        for (const value of analysis.channelPeaks[1]!) expect(value).toBeCloseTo(0.2, 2);
    });

    it('produces the requested number of columns whatever the length', async () => {
        for (const columns of [1, 7, 256, 8000]) {
            const analysis = await analyzeWavSource(source(stereoWav(20000, 0.5, 0.5)), columns);
            expect(analysis.channelPeaks[0], `columns=${columns}`).toHaveLength(columns);
        }
    });

    it('locates a loud passage at the right column', async () => {
        const frames = 40000;
        const pcm = new Float32Array(frames);
        for (let f = 0; f < frames; f++) {
            const loud = f > frames * 0.5 && f < frames * 0.6;
            pcm[f] = (loud ? 0.9 : 0.05) * (f % 2 ? 1 : -1);
        }
        const analysis = await analyzeWavSource(source(encodeWavFromFloat32(pcm, 1, 8000)), 100);
        const columns = analysis.channelPeaks[0]!;
        expect(Math.max(...columns.slice(0, 45))).toBeCloseTo(0.05, 2);
        expect(Math.max(...columns.slice(51, 59))).toBeCloseTo(0.9, 2);
        expect(Math.max(...columns.slice(65))).toBeCloseTo(0.05, 2);
    });

    // Constant memory is the property that removes the format ceiling, so the
    // pyramid must stay a small fraction of the PCM it summarizes.
    it('holds a pyramid far smaller than the decoded audio', async () => {
        const frames = 44100 * 20;
        const analysis = await analyzeWavSource(source(stereoWav(frames, 0.7, 0.7)), 1000);
        const pcmBytes = frames * 2 * 4;
        expect(analysis.pyramidByteLength).toBeLessThan(pcmBytes / 50);
    });

    it('reads a bounded header window plus exactly one pass over the samples', async () => {
        const wav = stereoWav(44100, 0.5, 0.5);
        const src = source(wav);
        await analyzeWavSource(src, 100);
        const headerWindow = Math.min(64 * 1024, wav.byteLength);
        const dataLength = wav.byteLength - 44;
        expect(src.bytesRead).toBe(headerWindow + dataLength);
    });

    it('rejects input that is not a WAV so the caller can fall back', async () => {
        await expect(analyzeWavSource(source(new Uint8Array(2048)), 100)).rejects.toThrow(/RIFF/);
    });

    it('honours an abort signal', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            analyzeWavSource(source(stereoWav(44100, 0.5, 0.5)), 100, { signal: controller.signal })
        ).rejects.toThrow(/aborted/);
    });

    it('reports zero duration for a WAV with no frames', async () => {
        const analysis = await analyzeWavSource(source(encodeWavFromFloat32(new Float32Array(0), 1, 8000)), 10);
        expect(analysis.duration).toBe(0);
        expect(analysis.channelPeaks[0]).toHaveLength(10);
        expect(analysis.channelPeaks[0]!.every((value) => value === 0)).toBe(true);
    });
});

describe('peak columns', () => {
    it('reports magnitude, so a negative-only signal is not flattened', () => {
        const builder = createPyramidBuilder(1, 8000, { baseFramesPerBucket: 4 });
        builder.push(new Float32Array(64).fill(-0.6));
        const columns = peakColumns(builder.finish(), 8);
        expect(columns[0]!.every((value) => Math.abs(value - 0.6) < 1e-6)).toBe(true);
    });
});
