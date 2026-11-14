// Worker shell for the spectrogram transform. Deliberately dumb, like
// audio_engine_worker.mjs: it owns no analysis logic, only the message
// plumbing, because everything here is outside the TypeScript build and
// therefore untypechecked and untested.
//
// The transform is the compiled `viewers/audio/spectrogram.ts`, shipped beside
// this file as `spectrogram_kernel.mjs` (see scripts/build-styles.mjs). Its URL
// arrives with each message rather than being resolved relative to this file:
// adapters that serve the core from blob URLs (obsidian) have no usable
// sibling paths.

let kernelPromise;

self.onmessage = async (event) => {
    const { id, kernelUrl, samples, sampleRate, options } = event.data;
    try {
        kernelPromise ??= import(kernelUrl);
        const { computeSpectrogram } = await kernelPromise;
        const result = computeSpectrogram(samples, sampleRate, options);
        self.postMessage({ id, ok: true, result }, [result.data.buffer]);
    } catch (error) {
        self.postMessage({ id, ok: false, error: String(error?.message ?? error) });
    }
};
