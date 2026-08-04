// WebCodecs bridge: decodes demuxed mp3 frames with the browser's own decoder
// and emits interleaved float32, which is exactly what the pyramid builder
// consumes.
//
// WebCodecs is a browser API, not a dependency — `AudioDecoder` is a global
// where it exists. It streams by design, so nothing here ever holds the whole
// decoded signal, and it covers codecs the WASM engine cannot (aac) as well as
// the one it gets wrong (mp3).
//
// The trade-off is deliberate and belongs to the caller: output comes from the
// host's decoder, so it is not guaranteed identical across browsers the way
// the WASM engine's is (DESIGN.md §3-① determinism). Use it where speed and
// codec coverage matter more than cross-platform bit equality.

import { iterateMp3Frames, readMp3Info, type Mp3Info } from './mp3-demux.js';

/** Minimal structural view of the globals, so the module type-checks without
 *  DOM lib support and can be driven by a fake in tests. */
export interface AudioDataLike {
    numberOfFrames: number;
    numberOfChannels: number;
    format: string | null;
    allocationSize(options: { planeIndex: number; format?: string }): number;
    copyTo(destination: ArrayBufferView, options: { planeIndex: number; format?: string }): void;
    close(): void;
}

export interface AudioDecoderLike {
    decodeQueueSize: number;
    configure(config: { codec: string; sampleRate: number; numberOfChannels: number }): void;
    decode(chunk: unknown): void;
    flush(): Promise<void>;
    close(): void;
}

export interface WebCodecsEnvironment {
    AudioDecoder: {
        new(init: { output(data: AudioDataLike): void; error(error: Error): void }): AudioDecoderLike;
        isConfigSupported?(config: { codec: string; sampleRate: number; numberOfChannels: number }):
            Promise<{ supported: boolean }>;
    };
    EncodedAudioChunk: new(init: { type: 'key'; timestamp: number; duration: number; data: Uint8Array }) => unknown;
}

/** The environment when running in a browser that has WebCodecs. */
export function globalWebCodecs(): WebCodecsEnvironment | undefined {
    const scope = globalThis as unknown as Partial<WebCodecsEnvironment>;
    return scope.AudioDecoder && scope.EncodedAudioChunk
        ? scope as WebCodecsEnvironment
        : undefined;
}

export function isWebCodecsAvailable(): boolean {
    return globalWebCodecs() !== undefined;
}

/** Interleaves an AudioData into `out`, handling both planar and packed
 *  layouts — Chrome hands back f32-planar for mp3, but the spec allows f32. */
function interleave(data: AudioDataLike, out: Float32Array, plane: Float32Array): number {
    const { numberOfChannels: channels, numberOfFrames: frames } = data;
    const packed = data.format === 'f32';
    if (packed) {
        data.copyTo(out.subarray(0, frames * channels), { planeIndex: 0, format: 'f32' });
        return frames * channels;
    }
    for (let c = 0; c < channels; c++) {
        const view = plane.subarray(0, frames);
        data.copyTo(view, { planeIndex: c, format: 'f32-planar' });
        for (let f = 0; f < frames; f++) out[f * channels + c] = view[f]!;
    }
    return frames * channels;
}

export interface Mp3DecodeOptions {
    /** Injected for tests; defaults to the browser globals. */
    environment?: WebCodecsEnvironment;
    /** Decode requests allowed in flight before awaiting the queue. */
    maxQueue?: number;
    signal?: AbortSignal;
}

export interface Mp3DecodeResult {
    info: Mp3Info;
    /** Frames actually delivered by the decoder. */
    frames: number;
}

const DEFAULT_MAX_QUEUE = 32;
const sleep = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Decodes an mp3 with WebCodecs, invoking `onFrames` with interleaved float32
 * as the decoder produces it. Nothing accumulates here: memory is one decoded
 * packet, so this composes with the streaming pyramid builder.
 */
export async function decodeMp3(
    bytes: Uint8Array,
    onFrames: (interleaved: Float32Array, channels: number) => void,
    options: Mp3DecodeOptions = {}
): Promise<Mp3DecodeResult> {
    const environment = options.environment ?? globalWebCodecs();
    if (!environment) throw new Error('webcodecs: AudioDecoder is not available in this environment');
    const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    const info = readMp3Info(bytes);

    let out = new Float32Array(0);
    let plane = new Float32Array(0);
    let delivered = 0;
    let failure: Error | undefined;

    const decoder = new environment.AudioDecoder({
        output(data) {
            try {
                const needed = data.numberOfFrames * data.numberOfChannels;
                if (out.length < needed) out = new Float32Array(needed);
                if (plane.length < data.numberOfFrames) plane = new Float32Array(data.numberOfFrames);
                const written = interleave(data, out, plane);
                delivered += data.numberOfFrames;
                onFrames(out.subarray(0, written), data.numberOfChannels);
            } catch (error) {
                failure ??= error as Error;
            } finally {
                data.close();
            }
        },
        error(error) {
            failure ??= error;
        }
    });

    try {
        decoder.configure({ codec: 'mp3', sampleRate: info.sampleRate, numberOfChannels: info.channels });
        let timestamp = 0;
        for (const frame of iterateMp3Frames(bytes, info)) {
            if (failure) break;
            if (options.signal?.aborted) throw new Error('webcodecs: aborted');
            const duration = Math.round(frame.samples / info.sampleRate * 1e6);
            decoder.decode(new environment.EncodedAudioChunk({
                type: 'key', // every mp3 frame is independently decodable
                timestamp,
                duration,
                data: bytes.subarray(frame.offset, frame.offset + frame.length)
            }));
            timestamp += duration;
            // Without backpressure a long file queues hundreds of thousands of
            // packets and the decoder's own buffering becomes the memory hog
            // this design exists to avoid.
            while (decoder.decodeQueueSize > maxQueue && !failure) await sleep();
        }
        await decoder.flush();
    } finally {
        try { decoder.close(); } catch { /* already closed after an error */ }
    }

    if (failure) throw failure;
    return { info, frames: delivered };
}
