// WASM audio decode/analysis engine bridge. The engine (native/audio-engine,
// built to assets/audio-engine/audio_engine.{mjs,wasm}) decodes WAV/MP3/FLAC/
// OGG entirely in WASM. The viewer uses it two ways:
//   1. decode-and-remux: when the browser cannot decode a file, decode in
//      WASM and re-encode to 16-bit PCM WAV that any browser can play.
//   2. analyze: for large files, compute waveform peaks in WASM so WaveSurfer
//      can render without running the whole file through decodeAudioData.

import type { HostContext } from '../../host/index.js';

export interface DecodedAudio {
    sampleRate: number;
    channels: number;
    frames: number;
    /** Interleaved float32 samples, length === frames * channels. */
    pcm: Float32Array;
}

export interface AudioAnalysis {
    sampleRate: number;
    channels: number;
    duration: number;
    /** Mono peak per pixel column, 0..1. */
    peaks: number[];
}

export interface AudioDecodeEngine {
    decode(data: Uint8Array): Promise<DecodedAudio>;
    analyze(data: Uint8Array, width: number): Promise<AudioAnalysis>;
}

/** Emscripten module surface used by the bridge (see native/audio-engine). */
export interface AudioEngineModuleLike {
    HEAPU8: Uint8Array;
    HEAPF32: Float32Array;
    getValue(pointer: number, type: string): number;
    _malloc(size: number): number;
    _free(pointer: number): void;
    _decode_audio(pointer: number, length: number): number;
    _audio_get_channels(audio: number): number;
    _audio_get_sample_rate(audio: number): number;
    _audio_get_total_frames(audio: number): number;
    _audio_get_total_frames_high(audio: number): number;
    _generate_peaks(audio: number, width: number): number;
    _free_audio(audio: number): void;
    _free_buffer(pointer: number): void;
}

interface OpenAudio {
    module: AudioEngineModuleLike;
    handle: number;
    channels: number;
    sampleRate: number;
    frames: number;
}

function openAudio(module: AudioEngineModuleLike, data: Uint8Array): OpenAudio {
    const pointer = module._malloc(data.byteLength);
    module.HEAPU8.set(data, pointer);
    const handle = module._decode_audio(pointer, data.byteLength);
    module._free(pointer);
    if (!handle) throw new Error('audio engine: unsupported or corrupted stream');
    return {
        module,
        handle,
        channels: module._audio_get_channels(handle),
        sampleRate: module._audio_get_sample_rate(handle),
        // >>> 0: the low word is a raw uint32 read back through a signed ABI.
        frames: (module._audio_get_total_frames(handle) >>> 0)
            + module._audio_get_total_frames_high(handle) * 2 ** 32
    };
}

export function createWasmAudioEngine(loadModule: () => Promise<AudioEngineModuleLike>): AudioDecodeEngine {
    let modulePromise: Promise<AudioEngineModuleLike> | undefined;
    const module = (): Promise<AudioEngineModuleLike> => (modulePromise ??= loadModule());
    return {
        async decode(data) {
            const engine = await module();
            const audio = openAudio(engine, data);
            try {
                const samplesPointer = engine.getValue(audio.handle, 'i32') >>> 0;
                const length = audio.frames * audio.channels;
                const pcm = new Float32Array(engine.HEAPF32.buffer, samplesPointer, length).slice();
                return { sampleRate: audio.sampleRate, channels: audio.channels, frames: audio.frames, pcm };
            } finally {
                engine._free_audio(audio.handle);
            }
        },
        async analyze(data, width) {
            const engine = await module();
            const audio = openAudio(engine, data);
            try {
                const columns = Math.max(1, Math.floor(width));
                const peaksPointer = engine._generate_peaks(audio.handle, columns) >>> 0;
                if (!peaksPointer) throw new Error('audio engine: peaks generation failed');
                const peaks = [...new Float32Array(engine.HEAPF32.buffer, peaksPointer, columns)];
                engine._free_buffer(peaksPointer);
                return {
                    sampleRate: audio.sampleRate,
                    channels: audio.channels,
                    duration: audio.sampleRate > 0 ? audio.frames / audio.sampleRate : 0,
                    peaks
                };
            } finally {
                engine._free_audio(audio.handle);
            }
        }
    };
}

/**
 * Engine loader over the platform AssetService: the adapter serves
 * assets/audio-engine/* (chrome: web_accessible_resources, obsidian:
 * blob URLs, web: static files) and this resolves + imports them.
 */
export function createAssetAudioEngine(
    ctx: HostContext,
    importModule: (url: string) => Promise<unknown> = (url) => import(/* @vite-ignore */ /* webpackIgnore: true */ url)
): AudioDecodeEngine {
    return createWasmAudioEngine(async () => {
        const [moduleUrl, wasmUrl] = await Promise.all([
            ctx.assets.resolveAssetUrl('audio-engine/audio_engine.mjs'),
            ctx.assets.resolveAssetUrl('audio-engine/audio_engine.wasm')
        ]);
        const factory = (await importModule(moduleUrl) as { default(options: Record<string, unknown>): Promise<AudioEngineModuleLike> }).default;
        return factory({ locateFile: () => wasmUrl });
    });
}

/** Encode interleaved float32 PCM as a 16-bit little-endian WAV file. */
export function encodeWavFromFloat32(pcm: Float32Array, channels: number, sampleRate: number): Uint8Array {
    const dataSize = pcm.length * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeAscii = (offset: number, text: string): void => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeAscii(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, 'data'); view.setUint32(40, dataSize, true);
    const samples = new Int16Array(buffer, 44);
    for (let i = 0; i < pcm.length; i++) {
        const clamped = Math.max(-1, Math.min(1, pcm[i]!));
        samples[i] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    }
    return new Uint8Array(buffer);
}
