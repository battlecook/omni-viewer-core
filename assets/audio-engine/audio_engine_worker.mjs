// Worker shell for the WASM audio engine. Deliberately dumb: it owns no
// decode logic, only the message plumbing, because everything here is outside
// the TypeScript build and therefore untypechecked and untested. The engine
// entry points it calls are the same ones viewers/audio/engine.ts calls
// directly on the main thread.
//
// Shipped as an asset (see scripts/build-styles.mjs) and resolved through
// AssetService, matching how pdf.js's worker is delivered.
//
// The module and wasm URLs arrive in the `init` message rather than being
// resolved relative to this file: adapters that serve the core from blob URLs
// (obsidian) have no usable sibling paths.

let modulePromise;

function loadModule(moduleUrl, wasmUrl) {
    modulePromise ??= import(moduleUrl).then((mod) => mod.default({ locateFile: () => wasmUrl }));
    return modulePromise;
}

function openAudio(module, bytes) {
    const pointer = module._malloc(bytes.byteLength);
    module.HEAPU8.set(bytes, pointer);
    const handle = module._decode_audio(pointer, bytes.byteLength);
    module._free(pointer);
    if (!handle) throw new Error('audio engine: unsupported or corrupted stream');
    return {
        handle,
        channels: module._audio_get_channels(handle),
        sampleRate: module._audio_get_sample_rate(handle),
        frames: (module._audio_get_total_frames(handle) >>> 0)
            + module._audio_get_total_frames_high(handle) * 2 ** 32
    };
}

function analyze(module, bytes, width) {
    const audio = openAudio(module, bytes);
    try {
        const columns = Math.max(1, Math.floor(width));
        const peaksPointer = module._generate_peaks(audio.handle, columns) >>> 0;
        if (!peaksPointer) throw new Error('audio engine: peaks generation failed');
        const peaks = [...new Float32Array(module.HEAPF32.buffer, peaksPointer, columns)];
        module._free_buffer(peaksPointer);
        return {
            sampleRate: audio.sampleRate,
            channels: audio.channels,
            duration: audio.sampleRate > 0 ? audio.frames / audio.sampleRate : 0,
            peaks
        };
    } finally {
        module._free_audio(audio.handle);
    }
}

function decode(module, bytes) {
    const audio = openAudio(module, bytes);
    try {
        const samplesPointer = module.getValue(audio.handle, 'i32') >>> 0;
        const length = audio.frames * audio.channels;
        const pcm = new Float32Array(module.HEAPF32.buffer, samplesPointer, length).slice();
        return { sampleRate: audio.sampleRate, channels: audio.channels, frames: audio.frames, pcm };
    } finally {
        module._free_audio(audio.handle);
    }
}

self.onmessage = async (event) => {
    const { id, op, moduleUrl, wasmUrl, bytes, width } = event.data;
    try {
        const module = await loadModule(moduleUrl, wasmUrl);
        if (op === 'analyze') {
            self.postMessage({ id, ok: true, result: analyze(module, bytes, width) });
        } else if (op === 'decode') {
            const result = decode(module, bytes);
            // The PCM is freshly copied here and never touched again, so it can
            // be transferred instead of structured-cloned.
            self.postMessage({ id, ok: true, result }, [result.pcm.buffer]);
        } else {
            throw new Error(`audio engine worker: unknown op ${String(op)}`);
        }
    } catch (error) {
        self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
};
