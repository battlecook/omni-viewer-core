import { describe, expect, it } from 'vitest';
import {
    createPyramidBuilder,
    envelope,
    pyramidByteLength,
    selectLevel,
    type PeakPyramid
} from './pyramid.js';

/** Builds a pyramid from a generator, pushing in awkward chunk sizes so that
 *  bucket boundaries never line up with chunk boundaries. */
function build(
    frames: number,
    channels: number,
    sample: (frame: number, channel: number) => number,
    options?: Parameters<typeof createPyramidBuilder>[2]
): PeakPyramid {
    const builder = createPyramidBuilder(channels, 44100, options);
    let frame = 0;
    let chunk = 7;
    while (frame < frames) {
        const take = Math.min(chunk, frames - frame);
        const block = new Float32Array(take * channels);
        for (let f = 0; f < take; f++) {
            for (let c = 0; c < channels; c++) block[f * channels + c] = sample(frame + f, c);
        }
        builder.push(block);
        frame += take;
        chunk = (chunk * 3) % 1000 + 1;
    }
    return builder.finish();
}

describe('peak pyramid builder', () => {
    it('captures the true min and max of every bucket regardless of chunking', () => {
        // One spike per bucket, at a different offset each time, with an
        // opposite-sign spike so min and max are both non-trivial.
        const framesPerBucket = 256;
        const buckets = 40;
        const pyramid = build(framesPerBucket * buckets, 1, (frame) => {
            const bucket = Math.floor(frame / framesPerBucket);
            const offset = frame % framesPerBucket;
            if (offset === bucket % framesPerBucket) return 0.9;
            if (offset === (bucket * 7 + 3) % framesPerBucket) return -0.8;
            return 0;
        }, { baseFramesPerBucket: framesPerBucket });

        const base = pyramid.levels[0]!;
        expect(base.buckets).toBe(buckets);
        for (let b = 0; b < buckets; b++) {
            expect(base.max[b]).toBeCloseTo(0.9, 6);
            expect(base.min[b]).toBeCloseTo(-0.8, 6);
        }
    });

    it('keeps channels independent', () => {
        const pyramid = build(1024, 2, (_frame, channel) => (channel === 0 ? 0.5 : -0.25),
            { baseFramesPerBucket: 256 });
        const base = pyramid.levels[0]!;
        for (let b = 0; b < base.buckets; b++) {
            expect(base.max[b * 2]).toBeCloseTo(0.5, 6);
            expect(base.min[b * 2]).toBeCloseTo(0.5, 6);
            expect(base.max[b * 2 + 1]).toBeCloseTo(-0.25, 6);
            expect(base.min[b * 2 + 1]).toBeCloseTo(-0.25, 6);
        }
    });

    it('closes a trailing partial bucket', () => {
        const pyramid = build(300, 1, () => 0.4, { baseFramesPerBucket: 256 });
        expect(pyramid.frames).toBe(300);
        expect(pyramid.levels[0]!.buckets).toBe(2);
        expect(pyramid.levels[0]!.max[1]).toBeCloseTo(0.4, 6);
    });

    // Each level must be a faithful reduction: a peak visible at level 0 has to
    // survive all the way up, or zooming out would silently hide transients.
    it('preserves extremes through every reduction level', () => {
        const frames = 256 * 5000;
        const spikeFrame = 256 * 3777 + 11;
        const pyramid = build(frames, 1, (frame) => (frame === spikeFrame ? 1 : 0.01), {
            baseFramesPerBucket: 256,
            levelFactor: 8,
            minBuckets: 4
        });
        expect(pyramid.levels.length).toBeGreaterThan(2);
        for (const level of pyramid.levels) {
            let highest = -Infinity;
            for (const value of level.max) highest = Math.max(highest, value);
            expect(highest).toBeCloseTo(1, 6);
        }
    });

    it('rejects reuse after finish', () => {
        const builder = createPyramidBuilder(1, 44100);
        builder.push(new Float32Array(10));
        builder.finish();
        expect(() => builder.push(new Float32Array(1))).toThrow(/after finish/);
        expect(() => builder.finish()).toThrow(/twice/);
    });
});

describe('pyramid level selection', () => {
    it('picks the coarsest level that still fills every pixel', () => {
        const pyramid = build(256 * 20000, 1, () => 0.5, {
            baseFramesPerBucket: 256,
            levelFactor: 8,
            minBuckets: 4
        });
        // Zoomed right in: nothing coarser than level 0 can fill a pixel.
        expect(selectLevel(pyramid, 256).framesPerBucket).toBe(256);
        // Zoomed out: a coarser level covers each pixel, so read fewer buckets.
        expect(selectLevel(pyramid, 2048).framesPerBucket).toBe(2048);
        expect(selectLevel(pyramid, 5000).framesPerBucket).toBe(2048);
        expect(selectLevel(pyramid, 16384).framesPerBucket).toBe(16384);
    });
});

describe('pyramid envelope', () => {
    it('reports the loud half louder than the quiet half', () => {
        const frames = 256 * 4000;
        const pyramid = build(frames, 1, (frame) => (frame < frames / 2 ? 0.2 : 0.9) * (frame % 2 ? 1 : -1),
            { baseFramesPerBucket: 256 });
        const result = envelope(pyramid, 0, 0, frames, 100);
        expect(result.max[0]).toBeCloseTo(0.2, 2);
        expect(result.max[99]).toBeCloseTo(0.9, 2);
        expect(result.min[99]).toBeCloseTo(-0.9, 2);
        expect(result.belowBaseResolution).toBe(false);
    });

    it('resolves a spike at any zoom level', () => {
        const frames = 256 * 8000;
        const spike = Math.floor(frames * 0.75);
        const pyramid = build(frames, 1, (frame) => (frame === spike ? 1 : 0), {
            baseFramesPerBucket: 256,
            levelFactor: 8,
            minBuckets: 4
        });
        for (const pixels of [50, 200, 1000, 4000]) {
            const result = envelope(pyramid, 0, 0, frames, pixels);
            const at = Math.floor((spike / frames) * pixels);
            expect(result.max[at], `pixels=${pixels}`).toBeCloseTo(1, 6);
        }
    });

    it('flags zoom finer than level 0 instead of inventing detail', () => {
        const frames = 256 * 2000;
        const pyramid = build(frames, 1, () => 0.5, { baseFramesPerBucket: 256 });
        // 512 frames across 800 pixels is far finer than one bucket per pixel.
        expect(envelope(pyramid, 0, 0, 512, 800).belowBaseResolution).toBe(true);
        // Full file at 800 pixels is 640 frames per pixel — coarser than a bucket.
        expect(envelope(pyramid, 0, 0, frames, 800).belowBaseResolution).toBe(false);
    });

    it('windows to a sub-range', () => {
        const frames = 256 * 2000;
        const pyramid = build(frames, 1, (frame) => (frame > frames / 2 ? 0.8 : 0), { baseFramesPerBucket: 256 });
        const quiet = envelope(pyramid, 0, 0, frames / 4, 32);
        const loud = envelope(pyramid, 0, frames * 0.6, frames, 32);
        expect(Math.max(...quiet.max)).toBeCloseTo(0, 6);
        expect(Math.max(...loud.max)).toBeCloseTo(0.8, 6);
    });

    it('returns silence rather than Infinity for an empty pyramid', () => {
        const pyramid = createPyramidBuilder(1, 44100).finish();
        const result = envelope(pyramid, 0, 0, 0, 8);
        expect([...result.max]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
        expect([...result.min]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('rejects an out-of-range channel', () => {
        const pyramid = build(1024, 1, () => 0);
        expect(() => envelope(pyramid, 1, 0, 1024, 10)).toThrow(/channel out of range/);
    });
});

describe('pyramid size', () => {
    // The whole point of the structure: summaries cost a fraction of the PCM
    // they summarize, which is what removes the file-length ceiling.
    it('is dramatically smaller than the PCM it summarizes', () => {
        const channels = 2;
        const frames = 44100 * 600; // 10 minutes
        const pyramid = build(frames, channels, (frame) => Math.sin(frame / 50) * 0.5,
            { baseFramesPerBucket: 256 });
        const pcmBytes = frames * channels * 4;
        const ratio = pcmBytes / pyramidByteLength(pyramid);
        expect(ratio).toBeGreaterThan(100);
    });
});
