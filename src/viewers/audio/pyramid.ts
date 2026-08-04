// Multi-resolution peak pyramid — the data structure desktop audio editors use
// to draw a waveform of any length in time proportional to the viewport rather
// than the file.
//
// The engine's current approach decodes a whole file to float32 PCM and scans
// it once (native/audio-engine: decode_audio + generate_peaks), which costs
// `frames * channels * 4` bytes of live memory and yields a single fixed
// resolution. This module inverts both properties:
//
//   - The builder consumes PCM in chunks and keeps only bucket accumulators
//     plus the level-0 arrays, so peak memory is a function of *duration*, not
//     of the decoded size — roughly 220x smaller at 44.1 kHz stereo.
//   - Levels are successive reductions of level 0, so a viewport query reads
//     O(pixels) buckets at whichever level matches the zoom, independent of
//     how long the file is.
//
// Deliberately DOM-free and decoder-free (ADR 39): it accepts float32 frames
// from any source — the WAV reader here, a WASM decode, or WebCodecs later.

/** One reduction level. `min`/`max` are channel-major: channel `c` bucket `b`
 *  lives at `b * channels + c`. */
export interface PeakLevel {
    /** Frames summarized by each bucket at this level. */
    framesPerBucket: number;
    buckets: number;
    min: Float32Array;
    max: Float32Array;
}

export interface PeakPyramid {
    channels: number;
    sampleRate: number;
    frames: number;
    /** Ascending `framesPerBucket`; `levels[0]` is the finest. */
    levels: PeakLevel[];
}

export interface PyramidBuilderOptions {
    /** Frames per bucket at level 0. 256 keeps level 0 ~220x smaller than
     *  float32 PCM while still resolving well past normal zoom. */
    baseFramesPerBucket?: number;
    /** Reduction ratio between levels. */
    levelFactor?: number;
    /** Stop reducing once a level holds fewer buckets than this — further
     *  levels would be smaller than a viewport and save nothing. */
    minBuckets?: number;
}

export interface PyramidBuilder {
    /** Feed interleaved float32 frames. Chunk boundaries are irrelevant: a
     *  bucket may span any number of pushes. */
    push(interleaved: Float32Array): void;
    /** Closes the trailing partial bucket and derives the upper levels. */
    finish(): PeakPyramid;
}

const DEFAULT_BASE_FRAMES_PER_BUCKET = 256;
const DEFAULT_LEVEL_FACTOR = 8;
const DEFAULT_MIN_BUCKETS = 512;

/** Growable Float32Array. Level 0's length is not known while streaming, and
 *  doubling keeps the copies logarithmic. */
class Growable {
    private data: Float32Array;
    private used = 0;

    constructor(initialCapacity: number) {
        this.data = new Float32Array(Math.max(1, initialCapacity));
    }

    push(value: number): void {
        if (this.used === this.data.length) {
            const grown = new Float32Array(this.data.length * 2);
            grown.set(this.data);
            this.data = grown;
        }
        this.data[this.used++] = value;
    }

    /** Trimmed copy; the builder drops its own reference afterwards. */
    take(): Float32Array {
        return this.data.slice(0, this.used);
    }
}

export function createPyramidBuilder(
    channels: number,
    sampleRate: number,
    options: PyramidBuilderOptions = {}
): PyramidBuilder {
    if (channels < 1) throw new Error('pyramid: channels must be >= 1');
    const baseFramesPerBucket = options.baseFramesPerBucket ?? DEFAULT_BASE_FRAMES_PER_BUCKET;
    const levelFactor = options.levelFactor ?? DEFAULT_LEVEL_FACTOR;
    const minBuckets = options.minBuckets ?? DEFAULT_MIN_BUCKETS;
    if (baseFramesPerBucket < 1) throw new Error('pyramid: baseFramesPerBucket must be >= 1');
    if (levelFactor < 2) throw new Error('pyramid: levelFactor must be >= 2');

    // Guessing ~1 minute of audio keeps early doubling cheap without
    // over-allocating for short files.
    const initialBuckets = Math.max(1, Math.ceil(sampleRate * 60 / baseFramesPerBucket)) * channels;
    const min = new Growable(initialBuckets);
    const max = new Growable(initialBuckets);

    const bucketMin = new Float32Array(channels).fill(Infinity);
    const bucketMax = new Float32Array(channels).fill(-Infinity);
    let framesInBucket = 0;
    let frames = 0;
    let finished = false;

    const flushBucket = (): void => {
        for (let c = 0; c < channels; c++) {
            min.push(bucketMin[c]!);
            max.push(bucketMax[c]!);
            bucketMin[c] = Infinity;
            bucketMax[c] = -Infinity;
        }
        framesInBucket = 0;
    };

    return {
        push(interleaved: Float32Array): void {
            if (finished) throw new Error('pyramid: push after finish');
            const frameCount = Math.floor(interleaved.length / channels);
            let offset = 0;
            for (let f = 0; f < frameCount; f++) {
                for (let c = 0; c < channels; c++) {
                    const sample = interleaved[offset++]!;
                    if (sample < bucketMin[c]!) bucketMin[c] = sample;
                    if (sample > bucketMax[c]!) bucketMax[c] = sample;
                }
                if (++framesInBucket === baseFramesPerBucket) flushBucket();
            }
            frames += frameCount;
        },

        finish(): PeakPyramid {
            if (finished) throw new Error('pyramid: finish called twice');
            finished = true;
            if (framesInBucket > 0) flushBucket();

            const base: PeakLevel = {
                framesPerBucket: baseFramesPerBucket,
                buckets: 0,
                min: min.take(),
                max: max.take()
            };
            base.buckets = base.min.length / channels;

            const levels: PeakLevel[] = [base];
            while (true) {
                const finer = levels[levels.length - 1]!;
                const buckets = Math.ceil(finer.buckets / levelFactor);
                if (finer.buckets <= minBuckets || buckets === finer.buckets) break;
                levels.push(reduce(finer, channels, levelFactor, buckets));
            }
            return { channels, sampleRate, frames, levels };
        }
    };
}

function reduce(finer: PeakLevel, channels: number, factor: number, buckets: number): PeakLevel {
    const min = new Float32Array(buckets * channels);
    const max = new Float32Array(buckets * channels);
    for (let b = 0; b < buckets; b++) {
        const from = b * factor;
        const to = Math.min(from + factor, finer.buckets);
        for (let c = 0; c < channels; c++) {
            let lo = Infinity;
            let hi = -Infinity;
            for (let s = from; s < to; s++) {
                const value = finer.min[s * channels + c]!;
                const peak = finer.max[s * channels + c]!;
                if (value < lo) lo = value;
                if (peak > hi) hi = peak;
            }
            min[b * channels + c] = lo;
            max[b * channels + c] = hi;
        }
    }
    return { framesPerBucket: finer.framesPerBucket * factor, buckets, min, max };
}

/** Total bytes held by the pyramid — the number worth comparing against
 *  `frames * channels * 4` for the equivalent decoded PCM. */
export function pyramidByteLength(pyramid: PeakPyramid): number {
    return pyramid.levels.reduce((total, level) => total + level.min.byteLength + level.max.byteLength, 0);
}

/**
 * Coarsest level that still gives at least one bucket per pixel. Using the
 * coarsest such level is what makes a query cost O(pixels): a finer one would
 * read proportionally more buckets for identical output.
 */
export function selectLevel(pyramid: PeakPyramid, framesPerPixel: number): PeakLevel {
    let chosen = pyramid.levels[0]!;
    for (const level of pyramid.levels) {
        if (level.framesPerBucket <= framesPerPixel) chosen = level;
        else break;
    }
    return chosen;
}

export interface Envelope {
    /** Per-pixel min/max for one channel. */
    min: Float32Array;
    max: Float32Array;
    /** Level actually read. */
    framesPerBucket: number;
    /** True when the zoom is finer than level 0, so this is interpolated from
     *  bucket summaries rather than real samples and the caller should decode
     *  the visible window if it wants true detail. */
    belowBaseResolution: boolean;
}

/**
 * Min/max envelope for `[startFrame, endFrame)` of one channel, at `pixels`
 * columns. Reads O(pixels * levelFactor) buckets regardless of file length.
 */
export function envelope(
    pyramid: PeakPyramid,
    channel: number,
    startFrame: number,
    endFrame: number,
    pixels: number
): Envelope {
    if (channel < 0 || channel >= pyramid.channels) throw new Error('pyramid: channel out of range');
    if (pixels < 1) throw new Error('pyramid: pixels must be >= 1');
    const from = Math.max(0, Math.min(startFrame, pyramid.frames));
    const to = Math.max(from, Math.min(endFrame, pyramid.frames));
    const framesPerPixel = (to - from) / pixels;
    const level = selectLevel(pyramid, framesPerPixel);
    const { channels } = pyramid;

    const min = new Float32Array(pixels);
    const max = new Float32Array(pixels);
    for (let p = 0; p < pixels; p++) {
        const pixelStart = from + framesPerPixel * p;
        const pixelEnd = from + framesPerPixel * (p + 1);
        let bucketFrom = Math.floor(pixelStart / level.framesPerBucket);
        let bucketTo = Math.ceil(pixelEnd / level.framesPerBucket);
        // A pixel narrower than a bucket still has to read the bucket it lands in.
        if (bucketTo <= bucketFrom) bucketTo = bucketFrom + 1;
        bucketFrom = Math.min(bucketFrom, level.buckets - 1);
        bucketTo = Math.min(bucketTo, level.buckets);

        let lo = Infinity;
        let hi = -Infinity;
        for (let b = bucketFrom; b < bucketTo; b++) {
            const value = level.min[b * channels + channel]!;
            const peak = level.max[b * channels + channel]!;
            if (value < lo) lo = value;
            if (peak > hi) hi = peak;
        }
        // Empty range (zero-length file): report silence rather than Infinity.
        min[p] = lo === Infinity ? 0 : lo;
        max[p] = hi === -Infinity ? 0 : hi;
    }
    return {
        min,
        max,
        framesPerBucket: level.framesPerBucket,
        belowBaseResolution: framesPerPixel < pyramid.levels[0]!.framesPerBucket
    };
}
