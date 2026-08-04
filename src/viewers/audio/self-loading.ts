// Opt-in self-loading entry (ADR 14): the only place in the core where the
// optional peer `wavesurfer.js` is actually imported. Platforms whose bundler
// resolves the peer use this; others import `viewers/audio` and inject their
// own AudioViewerDeps.

import type { MountOptions, ViewerHandle, ViewerInput } from '../types.js';
import {
    AudioWorkerUnavailableError,
    createAssetAudioEngine,
    createWorkerAudioEngine,
    mountAudioViewer,
    type AudioDecodeEngine,
    type AudioMountOptions,
    type AudioPluginHandle,
    type AudioRegionsHandle,
    type AudioViewerContext,
    type AudioViewerDeps,
    type AudioWaveformLibrary,
    type AudioWaveSurferHandle
} from './index.js';

export * from './index.js';

interface WaveSurferStatic { create(options: Record<string, unknown>): AudioWaveSurferHandle }
interface PluginStatic<T> { create(options?: Record<string, unknown>): T }
type Module<T> = { default?: T } & Partial<T>;

const staticOf = <T>(module: unknown): T => {
    const mod = module as Module<T>;
    return (mod.default ?? mod) as T;
};

export const selfLoadingAudioDeps: AudioViewerDeps = {
    async loadWaveform(): Promise<AudioWaveformLibrary> {
        const WaveSurfer = staticOf<WaveSurferStatic>(await import('wavesurfer.js' as string));
        const [regionsResult, timelineResult, spectrogramResult] = await Promise.allSettled([
            import('wavesurfer.js/dist/plugins/regions.esm.js' as string),
            import('wavesurfer.js/dist/plugins/timeline.esm.js' as string),
            import('wavesurfer.js/dist/plugins/spectrogram.esm.js' as string)
        ]);
        const library: AudioWaveformLibrary = {
            createWaveSurfer: (options) => WaveSurfer.create(options as unknown as Record<string, unknown>)
        };
        if (regionsResult.status === 'fulfilled') {
            const Regions = staticOf<PluginStatic<AudioRegionsHandle>>(regionsResult.value);
            library.createRegions = () => Regions.create();
        }
        if (timelineResult.status === 'fulfilled') {
            const Timeline = staticOf<PluginStatic<AudioPluginHandle>>(timelineResult.value);
            library.createTimeline = (options) => Timeline.create(options as unknown as Record<string, unknown>);
        }
        if (spectrogramResult.status === 'fulfilled') {
            const Spectrogram = staticOf<PluginStatic<AudioPluginHandle>>(spectrogramResult.value);
            library.createSpectrogram = (options) => Spectrogram.create(options as unknown as Record<string, unknown>);
        }
        return library;
    }
};

/**
 * Wraps the worker engine so that a host which cannot start the worker at all
 * — asset key not registered, CSP blocks construction — keeps the in-process
 * engine rather than losing WASM decoding entirely. That capability is the
 * only recovery path for codecs the browser cannot play (AMR, AC3), so it must
 * not disappear just because a worker is unavailable.
 *
 * Only {@link AudioWorkerUnavailableError} triggers the switch. Decode errors
 * and timeouts say something about the file, and re-running them on the main
 * thread would reintroduce the freeze the worker exists to prevent.
 */
export function withInProcessFallback(
    ctx: AudioViewerContext,
    worker: AudioDecodeEngine & { dispose(): void }
): AudioDecodeEngine & { dispose(): void } {
    let inProcess: AudioDecodeEngine | undefined;
    let workerUsable = true;

    const viaFallback = <T>(run: (engine: AudioDecodeEngine) => Promise<T>): Promise<T> => {
        inProcess ??= createAssetAudioEngine(ctx);
        return run(inProcess);
    };
    const attempt = async <T>(run: (engine: AudioDecodeEngine) => Promise<T>): Promise<T> => {
        if (!workerUsable) return viaFallback(run);
        try {
            return await run(worker);
        } catch (error) {
            if (!(error instanceof AudioWorkerUnavailableError)) throw error;
            workerUsable = false;
            ctx.logger.log('warn', `${error.message} — falling back to the in-process engine`);
            return viaFallback(run);
        }
    };

    return {
        decode: (data) => attempt((engine) => engine.decode(data)),
        analyze: (data, width) => attempt((engine) => engine.analyze(data, width)),
        dispose: () => worker.dispose()
    };
}

/** mountAudioViewer with the core's own dynamic-import waveform loader and
 *  the AssetService-served WASM decode engine (assets/audio-engine/*).
 *
 *  The engine runs in a Worker where `Worker` exists: its decode is a
 *  synchronous WASM call that stalls — and on some inputs never returns —
 *  so keeping it off the main thread is what makes it interruptible. Hosts
 *  without `Worker` fall back to the in-process engine. */
export async function mountSelfLoadingAudioViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: AudioViewerContext,
    options: MountOptions & Omit<AudioMountOptions, 'deps'> = {}
): Promise<ViewerHandle> {
    const engine = typeof Worker === 'undefined'
        ? createAssetAudioEngine(ctx)
        : withInProcessFallback(ctx, createWorkerAudioEngine(ctx));
    // This entry point owns the engine it created, so it also owns tearing the
    // worker down. Without this a repeated open/close cycle leaks one worker
    // (and its grown WASM heap) per mount.
    const release = (): void => {
        (engine as Partial<{ dispose(): void }>).dispose?.();
    };

    const deps: AudioViewerDeps = { ...selfLoadingAudioDeps, engine };
    let handle: ViewerHandle;
    try {
        handle = await mountAudioViewer(input, container, ctx, { ...options, deps });
    } catch (error) {
        // Aborted or failed mounts never return a handle to dispose.
        release();
        throw error;
    }
    return {
        dispose(): void {
            try { handle.dispose(); } finally { release(); }
        }
    };
}
