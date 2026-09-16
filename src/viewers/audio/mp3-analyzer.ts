// Waveform analysis for mp3 without the WASM engine.
//
// Completes the streaming path for the format that needed it most: the engine
// mishandles mp3 (see ENGINE_UNSAFE_EXTENSIONS) and the WAV reader cannot touch
// it, so every mp3 used to be decoded whole by the browser no matter its size —
// a 20-minute file expands to roughly 400 MiB of PCM.
//
// Here the frames are separated by `mp3-demux`, decoded packet by packet by the
// browser's own decoder, and folded straight into a peak pyramid. Nothing holds
// more than one packet, so memory is independent of length.
//
// WebCodecs is required. Callers fall back to the previous behaviour when it is
// absent (`isWebCodecsAvailable`), and should be aware that decoding through the
// host's codec does not carry the cross-platform bit-equality the WASM engine
// offers (DESIGN.md §3-①).

import { createPyramidBuilder, pyramidByteLength, type PyramidBuilder } from './pyramid.js';
import { readMp3Info } from './mp3-demux.js';
import { peakColumns, type WaveformAnalysis } from './wav-analyzer.js';
import { decodeMp3, globalWebCodecs, type WebCodecsEnvironment } from './webcodecs-decoder.js';

export interface Mp3AnalyzeOptions {
    signal?: AbortSignal;
    /** Injected for tests; defaults to the browser globals. */
    environment?: WebCodecsEnvironment;
}

/** Peak columns per channel for an mp3, via WebCodecs and the peak pyramid. */
export async function analyzeMp3Source(
    bytes: Uint8Array,
    columns: number,
    options: Mp3AnalyzeOptions = {}
): Promise<WaveformAnalysis> {
    const environment = options.environment ?? globalWebCodecs();
    if (!environment) throw new Error('mp3 analysis: WebCodecs is not available in this environment');

    const info = readMp3Info(bytes);
    let builder: PyramidBuilder | undefined;
    // The decoder reports its own channel count, which is what the samples are
    // actually laid out as; the frame header is only a hint.
    let channels = info.channels;

    await decodeMp3(bytes, (interleaved, decodedChannels) => {
        if (!builder) {
            channels = decodedChannels;
            builder = createPyramidBuilder(decodedChannels, info.sampleRate);
        }
        builder.push(interleaved);
    }, {
        environment,
        ...(options.signal ? { signal: options.signal } : {})
    });

    if (!builder) throw new Error('mp3 analysis: decoder produced no audio');
    const pyramid = builder.finish();
    return {
        sampleRate: info.sampleRate,
        channels,
        duration: pyramid.frames > 0 ? pyramid.frames / info.sampleRate : 0,
        channelPeaks: peakColumns(pyramid, Math.max(1, Math.floor(columns))),
        pyramidByteLength: pyramidByteLength(pyramid)
    };
}
