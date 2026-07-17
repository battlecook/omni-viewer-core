// Opt-in self-loading entry (ADR 14): the only place in the core where the
// optional peer `wavesurfer.js` is actually imported. Platforms whose bundler
// resolves the peer use this; others import `viewers/audio` and inject their
// own AudioViewerDeps.

import type { MountOptions, ViewerHandle, ViewerInput } from '../types.js';
import {
    createAssetAudioEngine,
    mountAudioViewer,
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

/** mountAudioViewer with the core's own dynamic-import waveform loader and
 *  the AssetService-served WASM decode engine (assets/audio-engine/*). */
export function mountSelfLoadingAudioViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: AudioViewerContext,
    options: MountOptions & Omit<AudioMountOptions, 'deps'> = {}
): Promise<ViewerHandle> {
    const deps: AudioViewerDeps = { ...selfLoadingAudioDeps, engine: createAssetAudioEngine(ctx) };
    return mountAudioViewer(input, container, ctx, { ...options, deps });
}
