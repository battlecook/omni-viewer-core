// Decoding a *range* of samples rather than a whole file.
//
// This is what lets the spectrogram follow the viewport: a two-hour track only
// ever has a screenful decoded at a time. The peak pyramid already gave the
// waveform that property; the spectrogram needs real samples, so it needs this.
//
// Output is a mono downmix by default — one spectrum is what a spectrogram
// draws, and the FFT input stays half the size for stereo. Readers can keep the
// individual channels when the view wants to draw them separately.

import { readMp3Info, iterateMp3Frames, type Mp3Info } from './mp3-demux.js';
import { readWavHeader, streamWavFrames, type AudioByteSource } from './wav-stream.js';
import { globalWebCodecs, type WebCodecsEnvironment } from './webcodecs-decoder.js';

export interface AudioWindow {
    /** Mono samples covering the requested range — the downmix, always present
     *  so callers that do not split channels need no branching. */
    samples: Float32Array;
    /** Per-channel samples, when the reader was asked to keep them. */
    channels?: Float32Array[];
    sampleRate: number;
    /** First sample actually returned, which may precede the request when the
     *  decoder needed to start earlier. */
    startFrame: number;
}

export interface WindowOptions {
    signal?: AbortSignal;
    /** Keep per-channel samples alongside the downmix. Costs one array per
     *  channel, so it is opt-in. */
    keepChannels?: boolean;
    /** Injected for tests; defaults to the browser globals. */
    environment?: WebCodecsEnvironment;
}

const throwIfAborted = (signal?: AbortSignal): void => {
    if (signal?.aborted) throw new Error('audio window: aborted');
};

/** Splits an interleaved block into per-channel buffers at `offset`. */
function splitInto(interleaved: Float32Array, channels: number, out: Float32Array[], offset: number): void {
    const frames = Math.floor(interleaved.length / channels);
    const room = Math.max(0, (out[0]?.length ?? 0) - offset);
    const take = Math.min(frames, room);
    for (let c = 0; c < channels; c++) {
        const target = out[c];
        if (!target) continue;
        for (let f = 0; f < take; f++) target[offset + f] = interleaved[f * channels + c]!;
    }
}

/** Averages an interleaved block into `out` at `offset`, returning frames written. */
function downmixInto(interleaved: Float32Array, channels: number, out: Float32Array, offset: number): number {
    const frames = Math.floor(interleaved.length / channels);
    const room = Math.max(0, out.length - offset);
    const take = Math.min(frames, room);
    for (let f = 0; f < take; f++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += interleaved[f * channels + c]!;
        out[offset + f] = sum / channels;
    }
    return take;
}

/**
 * WAV window. Samples sit uncompressed at a known offset, so this is a single
 * range read — no decoder and nothing outside the window is touched.
 */
export async function readWavWindow(
    source: AudioByteSource,
    fromFrame: number,
    frameCount: number,
    options: WindowOptions = {}
): Promise<AudioWindow> {
    const info = await readWavHeader(source);
    const start = Math.max(0, Math.min(fromFrame, info.frames));
    const count = Math.max(0, Math.min(frameCount, info.frames - start));
    const samples = new Float32Array(count);
    if (count === 0) return { samples, sampleRate: info.sampleRate, startFrame: start };

    const bytesPerFrame = info.channels * (info.bitsPerSample / 8);
    // A view over just the window, so streamWavFrames reads nothing else.
    const windowSource: AudioByteSource = {
        byteLength: info.dataOffset + (start + count) * bytesPerFrame,
        slice: (from, to) => source.slice(from, to)
    };
    const windowInfo = { ...info, dataOffset: info.dataOffset + start * bytesPerFrame, frames: count };

    const channels = options.keepChannels
        ? Array.from({ length: info.channels }, () => new Float32Array(count))
        : undefined;
    let written = 0;
    for await (const chunk of streamWavFrames(windowSource, windowInfo, {
        ...(options.signal ? { signal: options.signal } : {})
    })) {
        throwIfAborted(options.signal);
        if (channels) splitInto(chunk, info.channels, channels, written);
        written += downmixInto(chunk, info.channels, samples, written);
        if (written >= count) break;
    }
    return { samples, sampleRate: info.sampleRate, startFrame: start, ...(channels ? { channels } : {}) };
}

/** Audio the engine has already decoded, as `getDecodedData()` exposes it. */
export interface DecodedBuffer {
    numberOfChannels: number;
    sampleRate: number;
    getChannelData?(channel: number): Float32Array;
}

/**
 * Window taken straight from a buffer the engine already decoded.
 *
 * On the full-decode path those samples are sitting in memory, so re-reading
 * and re-decoding the file for every viewport is pure waste. Returns undefined
 * when the buffer is synthetic (peaks mode builds one with no channel data),
 * which is the caller's signal to fall back to a real decoder.
 */
export function readDecodedWindow(
    decoded: DecodedBuffer | null | undefined,
    fromFrame: number,
    frameCount: number,
    options: WindowOptions = {}
): AudioWindow | undefined {
    if (!decoded || typeof decoded.getChannelData !== 'function') return undefined;
    let first: Float32Array;
    try {
        first = decoded.getChannelData(0);
    } catch {
        return undefined; // synthetic buffers refuse channel access
    }
    if (!first || first.length === 0) return undefined;

    const start = Math.max(0, Math.min(fromFrame, first.length));
    const count = Math.max(0, Math.min(frameCount, first.length - start));
    const channelCount = Math.max(1, decoded.numberOfChannels);
    const samples = new Float32Array(count);
    const channels = options.keepChannels
        ? Array.from({ length: channelCount }, () => new Float32Array(count))
        : undefined;

    for (let c = 0; c < channelCount; c++) {
        const source = c === 0 ? first : decoded.getChannelData(c);
        if (!source) continue;
        for (let f = 0; f < count; f++) {
            const value = source[start + f] ?? 0;
            samples[f] = (samples[f] ?? 0) + value / channelCount;
            if (channels) channels[c]![f] = value;
        }
    }
    return {
        samples,
        sampleRate: decoded.sampleRate,
        startFrame: start,
        ...(channels ? { channels } : {})
    };
}

/** MPEG frames decoded before the target so the bit reservoir is primed —
 *  without this the first window starts with audible garbage. */
const MP3_PREROLL_FRAMES = 12;

/**
 * mp3 window. Frame headers give an exact byte offset for any sample position,
 * so only the frames covering the range (plus a short pre-roll) are handed to
 * the decoder.
 *
 * Requires WebCodecs. The engine cannot help here: it decodes whole files and
 * mishandles mp3 besides.
 */
export async function decodeMp3Window(
    bytes: Uint8Array,
    fromFrame: number,
    frameCount: number,
    options: WindowOptions = {}
): Promise<AudioWindow> {
    const environment = options.environment ?? globalWebCodecs();
    if (!environment) throw new Error('audio window: WebCodecs is not available in this environment');
    const info = readMp3Info(bytes);
    const plan = planMp3Window(bytes, info, fromFrame, frameCount);
    const samples = new Float32Array(Math.max(0, plan.count));
    if (plan.packets.length === 0 || plan.count === 0) {
        return { samples, sampleRate: info.sampleRate, startFrame: plan.start };
    }

    // Samples arrive from the pre-roll onwards; skip forward to the request.
    let skip = plan.start - plan.decodeStart;
    let written = 0;
    let failure: Error | undefined;
    let channels: Float32Array[] | undefined;

    const decoder = new environment.AudioDecoder({
        output(data) {
            try {
                const channelCount = data.numberOfChannels;
                const frames = data.numberOfFrames;
                const packed = data.format === 'f32';
                const scratch = new Float32Array(frames * channelCount);
                if (packed) {
                    data.copyTo(scratch, { planeIndex: 0, format: 'f32' });
                } else {
                    const plane = new Float32Array(frames);
                    for (let c = 0; c < channelCount; c++) {
                        data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
                        for (let f = 0; f < frames; f++) scratch[f * channelCount + c] = plane[f]!;
                    }
                }
                if (skip >= frames) { skip -= frames; return; }
                const usable = skip > 0 ? scratch.subarray(skip * channelCount) : scratch;
                skip = 0;
                if (options.keepChannels) {
                    channels ??= Array.from({ length: channelCount }, () => new Float32Array(plan.count));
                    splitInto(usable, channelCount, channels, written);
                }
                written += downmixInto(usable, channelCount, samples, written);
            } catch (error) {
                failure ??= error as Error;
            } finally {
                data.close();
            }
        },
        error(error) { failure ??= error; }
    });

    try {
        decoder.configure({ codec: 'mp3', sampleRate: info.sampleRate, numberOfChannels: info.channels });
        let timestamp = 0;
        for (const packet of plan.packets) {
            if (failure || written >= plan.count) break;
            throwIfAborted(options.signal);
            const duration = Math.round((packet.samples / info.sampleRate) * 1e6);
            decoder.decode(new environment.EncodedAudioChunk({
                type: 'key',
                timestamp,
                duration,
                data: bytes.subarray(packet.offset, packet.offset + packet.length)
            }));
            timestamp += duration;
        }
        await decoder.flush();
    } finally {
        try { decoder.close(); } catch { /* already closed after an error */ }
    }
    if (failure) throw failure;
    return { samples, sampleRate: info.sampleRate, startFrame: plan.start, ...(channels ? { channels } : {}) };
}

interface Mp3WindowPlan {
    /** First sample the caller asked for, clamped to the stream. */
    start: number;
    /** Samples to return. */
    count: number;
    /** First sample the decoder will emit, at or before `start`. */
    decodeStart: number;
    packets: Array<{ offset: number; length: number; samples: number }>;
}

/**
 * Which MPEG frames cover a sample range. Exported for tests: the mapping from
 * samples to frames is the part worth pinning down, and it needs no decoder.
 */
export function planMp3Window(
    bytes: Uint8Array,
    info: Mp3Info,
    fromFrame: number,
    frameCount: number
): Mp3WindowPlan {
    const frames: Array<{ offset: number; length: number; samples: number; at: number }> = [];
    let cursor = 0;
    for (const frame of iterateMp3Frames(bytes, info)) {
        frames.push({ ...frame, at: cursor });
        cursor += frame.samples;
    }
    const total = cursor;
    const start = Math.max(0, Math.min(fromFrame, total));
    const count = Math.max(0, Math.min(frameCount, total - start));
    if (frames.length === 0 || count === 0) {
        return { start, count, decodeStart: start, packets: [] };
    }

    let first = frames.findIndex((frame) => frame.at + frame.samples > start);
    if (first === -1) first = frames.length - 1;
    const preroll = Math.max(0, first - MP3_PREROLL_FRAMES);
    const end = start + count;
    let last = frames.findIndex((frame) => frame.at >= end);
    if (last === -1) last = frames.length;

    return {
        start,
        count,
        decodeStart: frames[preroll]!.at,
        packets: frames.slice(preroll, last).map(({ offset, length, samples }) => ({ offset, length, samples }))
    };
}
