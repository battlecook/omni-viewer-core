// Waveform analysis for WAV without the WASM engine.
//
// The engine's analyze() decodes the whole file to float32 PCM before reducing
// it to peaks, which is what caps compressed formats well below the nominal
// 2 GiB heap and what forces a mono downmix. WAV needs no decoder at all, so
// this streams the samples through the peak pyramid instead: memory is one
// chunk plus the pyramid, and the result keeps its channels.
//
// Output is shaped for the waveform engine's precomputed-peaks input, so this
// is a drop-in replacement for the engine on the large-file path rather than a
// new rendering mode.

import { createPyramidBuilder, envelope, pyramidByteLength, type PeakPyramid } from './pyramid.js';
import { readWavHeader, streamWavFrames, type AudioByteSource } from './wav-stream.js';

export interface WaveformAnalysis {
    sampleRate: number;
    channels: number;
    duration: number;
    /** One column array per channel, 0..1, ready to hand to the engine. */
    channelPeaks: number[][];
    /** Bytes held by the pyramid the columns were read from — reported so
     *  callers can log the saving against the PCM they avoided. */
    pyramidByteLength: number;
}

export interface WavAnalyzeOptions {
    signal?: AbortSignal;
    /** Frames per range read. */
    chunkFrames?: number;
    /** Yield to the event loop every N chunks so a long pass does not block
     *  painting. Set 0 to run straight through (worker, Node). */
    yieldEvery?: number;
}

const DEFAULT_YIELD_EVERY = 8;
/** A macrotask, not a microtask: awaiting a resolved promise keeps the same
 *  task and never lets the browser paint. */
const yieldToEventLoop = (): Promise<void> =>
    new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * Peak columns per channel for a WAV byte source.
 *
 * Columns are magnitudes rather than a signed min/max envelope: the engine's
 * peaks input is a sample array, and feeding it an interleaved envelope only
 * renders correctly when its canvas maps exactly two samples per pixel. A true
 * envelope needs a renderer that takes min/max directly.
 */
export async function analyzeWavSource(
    source: AudioByteSource,
    columns: number,
    options: WavAnalyzeOptions = {}
): Promise<WaveformAnalysis> {
    const info = await readWavHeader(source);
    const builder = createPyramidBuilder(info.channels, info.sampleRate);
    const streamOptions = {
        ...(options.chunkFrames ? { chunkFrames: options.chunkFrames } : {}),
        ...(options.signal ? { signal: options.signal } : {})
    };
    const yieldEvery = options.yieldEvery ?? DEFAULT_YIELD_EVERY;
    let chunks = 0;
    for await (const chunk of streamWavFrames(source, info, streamOptions)) {
        builder.push(chunk);
        if (yieldEvery > 0 && ++chunks % yieldEvery === 0) await yieldToEventLoop();
    }
    const pyramid = builder.finish();
    return {
        sampleRate: info.sampleRate,
        channels: info.channels,
        duration: pyramid.frames > 0 ? pyramid.frames / info.sampleRate : 0,
        channelPeaks: peakColumns(pyramid, Math.max(1, Math.floor(columns))),
        pyramidByteLength: pyramidByteLength(pyramid)
    };
}

/** Magnitude column per channel, read from whichever pyramid level matches. */
export function peakColumns(pyramid: PeakPyramid, columns: number): number[][] {
    const result: number[][] = [];
    for (let channel = 0; channel < pyramid.channels; channel++) {
        const band = envelope(pyramid, channel, 0, pyramid.frames, columns);
        const values = new Array<number>(columns);
        for (let i = 0; i < columns; i++) {
            const low = band.min[i]!;
            const high = band.max[i]!;
            values[i] = Math.max(low < 0 ? -low : low, high < 0 ? -high : high);
        }
        result.push(values);
    }
    return result;
}

/** Byte source over bytes already in memory — the viewer's case, since
 *  `ViewerInput` hands over the whole file. Reads are plain subarray copies;
 *  responsiveness comes from `yieldEvery`, not from the source. */
export function createBytesSource(bytes: Uint8Array): AudioByteSource {
    return {
        byteLength: bytes.byteLength,
        async slice(start, end) {
            const from = Math.max(0, Math.min(bytes.byteLength, start));
            const to = Math.max(from, Math.min(bytes.byteLength, end));
            return bytes.slice(from, to).buffer as ArrayBuffer;
        }
    };
}
