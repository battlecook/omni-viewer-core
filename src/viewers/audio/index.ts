import type { HostContext } from '../../host/index.js';
import { parseAudioInfo, type AudioInfo } from '../../parsers/audio/index.js';
import { mountMediaViewer, type MediaMountOptions } from '../media.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type ViewerHandle, type ViewerInput } from '../types.js';
import {
    createAudioController,
    type AudioController,
    type AudioViewState,
    type AudioVisualization
} from './controller.js';
import { encodeWavFromFloat32, type AudioDecodeEngine } from './engine.js';
import { audioViewerCss } from './styles.js';
import { formatMediaTime } from '../video/controller.js';

export { parseAudioInfo } from '../../parsers/audio/index.js';
export { audioViewerCss } from './styles.js';
export {
    createAudioController,
    AUDIO_MIN_ZOOM,
    AUDIO_MAX_ZOOM,
    type AudioAction,
    type AudioController,
    type AudioViewState,
    type AudioVisualization
} from './controller.js';
export {
    createAssetAudioEngine,
    createWasmAudioEngine,
    encodeWavFromFloat32,
    type AudioAnalysis,
    type AudioDecodeEngine,
    type AudioEngineModuleLike,
    type DecodedAudio
} from './engine.js';

export type AudioViewerContext = HostContext;

// ---------------------------------------------------------------------------
// Waveform engine contract. Shaped after WaveSurfer v7 but deliberately
// structural: the adapter (or `self-loading.ts`) maps the real library onto
// these interfaces, so the core never imports the optional peer directly.
// ---------------------------------------------------------------------------

export interface AudioPluginHandle { destroy?(): void }

export interface AudioRegionHandle {
    id: string;
    start: number;
    end: number;
    play(): void;
    remove(): void;
}

export interface AudioRegionsHandle extends AudioPluginHandle {
    on(event: string, callback: (region: AudioRegionHandle) => void): unknown;
    clearRegions(): void;
    getRegions(): AudioRegionHandle[];
    enableDragSelection(options: Record<string, unknown>): unknown;
}

export interface AudioWaveSurferHandle {
    on(event: string, callback: (payload?: unknown) => void): unknown;
    registerPlugin<T extends AudioPluginHandle>(plugin: T): T;
    playPause(): void | Promise<void>;
    stop(): void;
    setTime(seconds: number): void;
    setVolume(volume: number): void;
    zoom(pxPerSec: number): void;
    getDuration(): number;
    getCurrentTime(): number;
    getDecodedData(): { numberOfChannels: number; sampleRate: number; duration: number } | null;
    destroy(): void;
}

export interface AudioWaveSurferCreateOptions {
    container: HTMLElement;
    url: string;
    height: number;
    normalize: boolean;
    waveColor: string;
    progressColor: string;
    cursorColor: string;
    /** Precomputed peaks + duration: WaveSurfer then skips decodeAudioData
     *  and streams playback through a media element (large-file mode). */
    peaks?: number[][];
    duration?: number;
}

export interface AudioWaveformLibrary {
    createWaveSurfer(options: AudioWaveSurferCreateOptions): AudioWaveSurferHandle;
    createRegions?(): AudioRegionsHandle;
    createTimeline?(options: { container: HTMLElement }): AudioPluginHandle;
    createSpectrogram?(options: { container: HTMLElement; labels: boolean; height: number; splitChannels: boolean }): AudioPluginHandle;
}

export interface AudioViewerDeps {
    loadWaveform(): Promise<AudioWaveformLibrary>;
    /** Optional WASM decode/analysis engine (viewers/audio/engine.ts):
     *  browser-decode failures fall back to it, and files larger than
     *  `engineAnalyzeBytes` get WASM-computed peaks instead of a full
     *  browser decode. */
    engine?: AudioDecodeEngine;
}

export interface AudioMountOptions extends MediaMountOptions {
    /** Waveform engine (WaveSurfer). Absent → basic `<audio>` player. */
    deps?: AudioViewerDeps;
    /** Files above this size use engine peak analysis (default 50 MiB). */
    engineAnalyzeBytes?: number;
}

export const AUDIO_VIEWER_META = {
    id: 'audio',
    displayNameKey: 'audio.title',
    extensions: ['mp3', 'wav', 'pcm', 'aiff', 'aif', 'aifc', 'amr', 'awb', 'ogg', 'flac', 'ac3', 'aac', 'm4a'],
    priority: 20,
    requiredServices: [] as const,
    optionalServices: [] as const,
    inputOwnership: 'borrows' as const
};

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_ANALYZE_BYTES = 50 * 1024 * 1024;
const ANALYZE_PEAK_COLUMNS = 8000;
const REGION_COLOR = 'rgba(79,193,255,0.25)';

export async function mountAudioViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: AudioViewerContext,
    options: AudioMountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const info = parseAudioInfo(input.fileName, input.data);

    // No engine, engine failed to load, or the file is not mountable as a
    // waveform → the plain media player remains the universal fallback.
    const fallback = (extraWarning?: string): Promise<ViewerHandle> =>
        mountMediaViewer('audio', input, container, ctx, info.mimeType,
            extraWarning ? [...info.warnings, extraWarning] : info.warnings, options);

    if (!options.deps) return fallback();
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (input.data.byteLength === 0 || input.data.byteLength > maxBytes) return fallback();

    let library: AudioWaveformLibrary;
    try { library = await options.deps.loadWaveform(); }
    catch { return fallback(ctx.i18n.t('audio.fallback')); }
    if (options.signal?.aborted) throw new MountAbortedError();

    return mountWaveformViewer(input, container, ctx, info, library, options.deps, options);
}

async function mountWaveformViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: AudioViewerContext,
    info: AudioInfo,
    library: AudioWaveformLibrary,
    deps: AudioViewerDeps,
    options: AudioMountOptions
): Promise<ViewerHandle> {
    const t = (key: string, args?: Record<string, string | number>): string => ctx.i18n.t(key, args);
    const root: HTMLElement | ShadowRoot =
        options.styleIsolation !== 'scoped' && container.attachShadow
            ? (container.shadowRoot ?? container.attachShadow({ mode: 'open' }))
            : container;
    if (root === container) container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--audio');
    else {
        const style = document.createElement('style');
        style.textContent = audioViewerCss;
        root.append(style);
    }

    const controller: AudioController = createAudioController();
    const disposers: Array<() => void> = [];
    let surferDisposers: Array<() => void> = [];
    const listen = (target: EventTarget, type: string, handler: EventListener): void => {
        target.addEventListener(type, handler);
        disposers.push(() => target.removeEventListener(type, handler));
    };
    const wsOn = (
        handle: { on(event: string, callback: never): unknown },
        event: string,
        callback: (payload?: unknown) => void
    ): void => {
        const off = handle.on(event, callback as never);
        if (typeof off === 'function') surferDisposers.push(off as () => void);
    };

    const shell = element('section', `${VIEWER_ROOT_CLASS} omni-audio`);

    const header = element('header', 'omni-audio__header');
    header.append(
        element('div', 'omni-audio__title', input.fileName),
        element('div', 'omni-audio__meta', `${info.mimeType} · ${formatBytes(input.data.byteLength)}`)
    );

    const infoPanel = element('div', 'omni-audio__info');
    const durationValue = infoItem(infoPanel, t('audio.info.duration'));
    const sampleRateValue = infoItem(infoPanel, t('audio.info.sampleRate'));
    const channelsValue = infoItem(infoPanel, t('audio.info.channels'));
    const bitDepthValue = infoItem(infoPanel, t('audio.info.bitDepth'));
    const formatValue = infoItem(infoPanel, t('audio.info.format'));
    const sizeValue = infoItem(infoPanel, t('audio.info.fileSize'));
    formatValue.textContent = info.format;
    sizeValue.textContent = formatBytes(input.data.byteLength);
    if (info.sampleRate) sampleRateValue.textContent = `${info.sampleRate.toLocaleString()} Hz`;
    if (info.channels) channelsValue.textContent = channelLabel(info.channels);
    if (info.bitsPerSample) bitDepthValue.textContent = `${info.bitsPerSample}-bit`;

    const controls = element('div', 'omni-audio__controls');
    const playPause = button(t('audio.play'));
    const stop = button(t('audio.stop'));
    const loop = button(t('audio.loop'));
    const clearRegions = button(t('audio.clearRegions'));
    const transport = element('div', 'omni-audio__group');
    transport.append(playPause, stop, loop, clearRegions);

    const volumeGroup = element('div', 'omni-audio__group');
    const volumeLabel = element('label', 'omni-audio__group-label', t('audio.volume'));
    const volume = document.createElement('input');
    volume.type = 'range'; volume.min = '0'; volume.max = '100'; volume.value = '100';
    volume.className = 'omni-audio__slider';
    volumeLabel.append(volume);
    volumeGroup.append(volumeLabel);

    const zoomGroup = element('div', 'omni-audio__group');
    const zoomOut = button('−', t('audio.zoomOut'));
    const zoomLabel = element('span', 'omni-audio__zoom-label', '×1');
    const zoomIn = button('+', t('audio.zoomIn'));
    const zoomFit = button(t('audio.zoomFit'));
    zoomGroup.append(element('span', 'omni-audio__group-label', t('audio.zoom')), zoomOut, zoomLabel, zoomIn, zoomFit);

    const visGroup = element('div', 'omni-audio__group');
    const visLabel = element('label', 'omni-audio__group-label', t('audio.visualization'));
    const visSelect = document.createElement('select');
    visSelect.className = 'omni-audio__select';
    for (const [value, key] of [['waveform', 'audio.vis.waveform'], ['spectrogram', 'audio.vis.spectrogram']] as const) {
        const option = document.createElement('option');
        option.value = value; option.textContent = t(key);
        visSelect.append(option);
    }
    if (!library.createSpectrogram) visSelect.disabled = true;
    visLabel.append(visSelect);
    visGroup.append(visLabel);

    const time = element('span', 'omni-audio__time', '0:00 / 0:00');
    controls.append(transport, volumeGroup, zoomGroup, visGroup, time);

    const stage = element('div', 'omni-audio__stage');
    const loading = element('div', 'omni-audio__loading', t('audio.loading'));
    const timeline = element('div', 'omni-audio__timeline');
    const waveform = element('div', 'omni-audio__waveform');
    const spectrogram = element('div', 'omni-audio__spectrogram');
    stage.append(loading, timeline, waveform, spectrogram);

    const status = element('div', 'omni-audio__status');
    const warning = element('div', 'omni-audio__warning');
    warning.hidden = info.warnings.length === 0;
    warning.textContent = info.warnings.join('\n');

    shell.append(header, infoPanel, controls, stage, status, warning);
    root.append(shell);

    let url: string | undefined;
    let surfer: AudioWaveSurferHandle | undefined;
    let regions: AudioRegionsHandle | undefined;
    let spectrogramPlugin: AudioPluginHandle | undefined;
    let selectedRegion: AudioRegionHandle | null = null;
    let ready = false;
    let disposed = false;
    let engineTried = false;

    const createUrl = options.createObjectUrl ?? URL.createObjectURL.bind(URL);
    const revoke = options.revokeObjectUrl ?? URL.revokeObjectURL.bind(URL);

    const showWarning = (message: string): void => {
        warning.hidden = false;
        warning.textContent = [...info.warnings, message].filter(Boolean).join('\n');
    };
    const setControlsEnabled = (enabled: boolean): void => {
        for (const control of [playPause, stop, loop, clearRegions, volume, zoomOut, zoomIn, zoomFit]) {
            (control as HTMLButtonElement | HTMLInputElement).disabled = !enabled;
        }
        if (library.createSpectrogram) visSelect.disabled = !enabled;
    };
    setControlsEnabled(false);

    const refreshTime = (): void => {
        if (!surfer) return;
        time.textContent = `${formatMediaTime(surfer.getCurrentTime())} / ${formatMediaTime(surfer.getDuration())}`;
    };
    const refreshStatus = (): void => {
        if (selectedRegion) {
            status.textContent = t('audio.status.region', {
                start: formatMediaTime(selectedRegion.start),
                end: formatMediaTime(selectedRegion.end),
                duration: (selectedRegion.end - selectedRegion.start).toFixed(2)
            }) + (controller.state.loop ? ` · ${t('audio.status.looping')}` : '');
        } else {
            status.textContent = controller.state.loop ? t('audio.status.loopTrack') : '';
        }
    };

    const basePxPerSec = (): number => {
        const width = waveform.clientWidth || 800;
        const duration = surfer?.getDuration() || 0;
        return duration > 0 ? Math.max(1, width / duration) : 1;
    };

    const applyVisualization = (mode: AudioVisualization): void => {
        if (!surfer) return;
        if (mode === 'spectrogram' && !spectrogramPlugin && library.createSpectrogram) {
            const decoded = surfer.getDecodedData();
            spectrogramPlugin = surfer.registerPlugin(library.createSpectrogram({
                container: spectrogram, labels: true, height: 200,
                splitChannels: (decoded?.numberOfChannels ?? 1) > 1
            }));
        }
        if (mode === 'waveform' && spectrogramPlugin) {
            spectrogramPlugin.destroy?.();
            spectrogramPlugin = undefined;
            spectrogram.replaceChildren();
        }
        spectrogram.classList.toggle('omni-audio__spectrogram--active', mode === 'spectrogram');
    };

    const applyState = (state: AudioViewState): void => {
        if (!surfer) return;
        surfer.setVolume(state.volume);
        volume.value = String(Math.round(state.volume * 100));
        zoomLabel.textContent = `×${state.zoom}`;
        loop.classList.toggle('is-active', state.loop);
        if (ready) surfer.zoom(basePxPerSec() * state.zoom);
        applyVisualization(state.visualization);
        visSelect.value = state.visualization;
        refreshStatus();
    };
    disposers.push(controller.subscribe(applyState));

    const teardownSurfer = (): void => {
        for (const dispose of surferDisposers.splice(0)) { try { dispose(); } catch { /* engine own teardown */ } }
        spectrogramPlugin?.destroy?.();
        spectrogramPlugin = undefined;
        try { surfer?.destroy(); } catch { /* already torn down */ }
        surfer = undefined;
        regions = undefined;
        selectedRegion = null;
        ready = false;
        waveform.replaceChildren();
        timeline.replaceChildren();
        spectrogram.replaceChildren();
    };

    const onDecodeFailure = (): void => {
        if (deps.engine && !engineTried) {
            engineTried = true;
            void rebuildViaEngine();
            return;
        }
        loading.remove();
        showWarning(t('audio.error.decode'));
    };

    // Decode in WASM, remux as 16-bit WAV, and rebuild the surfer on a
    // stream every browser can play.
    async function rebuildViaEngine(): Promise<void> {
        try {
            const decoded = await deps.engine!.decode(input.data);
            if (disposed) return;
            const wav = encodeWavFromFloat32(decoded.pcm, decoded.channels, decoded.sampleRate);
            teardownSurfer();
            if (url) { revoke(url); url = undefined; }
            url = createUrl(new Blob([blobPart(wav)], { type: 'audio/wav' }));
            if (!buildSurfer({ url })) onDecodeFailure();
        } catch {
            if (disposed) return;
            loading.remove();
            showWarning(t('audio.error.decode'));
        }
    }

    function buildSurfer(source: { url: string; peaks?: number[][]; duration?: number }): boolean {
        try {
            surfer = library.createWaveSurfer({
                container: waveform, height: 128, normalize: true,
                waveColor: '#4fc1ff', progressColor: '#0e639c', cursorColor: '#ffffff',
                ...source
            });
        } catch {
            return false;
        }
        if (library.createTimeline) surfer.registerPlugin(library.createTimeline({ container: timeline }));
        if (library.createRegions) {
            regions = surfer.registerPlugin(library.createRegions());
            regions.enableDragSelection({ color: REGION_COLOR });
            wsOn(regions, 'region-created', (payload) => {
                selectedRegion = payload as AudioRegionHandle;
                refreshStatus();
            });
            wsOn(regions, 'region-clicked', (payload) => {
                selectedRegion = payload as AudioRegionHandle;
                refreshStatus();
            });
            wsOn(regions, 'region-out', (payload) => {
                const region = payload as AudioRegionHandle;
                if (controller.state.loop && selectedRegion && region.id === selectedRegion.id) region.play();
            });
        }
        wsOn(surfer, 'ready', () => {
            ready = true;
            loading.remove();
            setControlsEnabled(true);
            const decoded = surfer!.getDecodedData();
            durationValue.textContent = formatMediaTime(surfer!.getDuration());
            if (decoded) {
                sampleRateValue.textContent = `${decoded.sampleRate.toLocaleString()} Hz`;
                channelsValue.textContent = channelLabel(decoded.numberOfChannels);
            }
            refreshTime();
            applyState(controller.state);
        });
        wsOn(surfer, 'play', () => { playPause.textContent = t('audio.pause'); });
        wsOn(surfer, 'pause', () => { playPause.textContent = t('audio.play'); });
        wsOn(surfer, 'timeupdate', refreshTime);
        wsOn(surfer, 'finish', () => {
            playPause.textContent = t('audio.play');
            if (controller.state.loop && !selectedRegion && surfer) {
                surfer.setTime(0);
                void surfer.playPause();
            }
        });
        wsOn(surfer, 'error', onDecodeFailure);
        return true;
    }

    try {
        url = createUrl(new Blob([blobPart(input.data)], { type: info.mimeType }));
    } catch {
        teardownShell();
        return mountMediaViewer('audio', input, container, ctx, info.mimeType, info.warnings, options);
    }

    // Large files: analyze peaks in WASM so WaveSurfer skips the expensive
    // (and memory-hungry) browser decode and streams via a media element.
    let initialSource: { url: string; peaks?: number[][]; duration?: number } = { url };
    const analyzeBytes = options.engineAnalyzeBytes ?? DEFAULT_ANALYZE_BYTES;
    if (deps.engine && input.data.byteLength > analyzeBytes) {
        try {
            const analysis = await deps.engine.analyze(input.data, ANALYZE_PEAK_COLUMNS);
            if (options.signal?.aborted) { teardownShell(); if (url) revoke(url); throw new MountAbortedError(); }
            initialSource = { url, peaks: [analysis.peaks], duration: analysis.duration };
            sampleRateValue.textContent = `${analysis.sampleRate.toLocaleString()} Hz`;
            channelsValue.textContent = channelLabel(analysis.channels);
            durationValue.textContent = formatMediaTime(analysis.duration);
        } catch (error) {
            if (error instanceof MountAbortedError) throw error;
            // Analysis is an optimization — fall through to normal decode.
        }
    }

    if (!buildSurfer(initialSource)) {
        if (url) revoke(url);
        teardownShell();
        return mountMediaViewer('audio', input, container, ctx, info.mimeType,
            [...info.warnings, ctx.i18n.t('audio.fallback')], options);
    }

    listen(playPause, 'click', () => { void surfer?.playPause(); });
    listen(stop, 'click', () => { surfer?.stop(); playPause.textContent = t('audio.play'); refreshTime(); });
    listen(loop, 'click', () => controller.dispatch({ type: 'toggle-loop' }));
    listen(clearRegions, 'click', () => {
        regions?.clearRegions();
        selectedRegion = null;
        refreshStatus();
    });
    listen(volume, 'input', () => controller.dispatch({ type: 'set-volume', volume: Number(volume.value) / 100 }));
    listen(zoomIn, 'click', () => controller.dispatch({ type: 'zoom-in' }));
    listen(zoomOut, 'click', () => controller.dispatch({ type: 'zoom-out' }));
    listen(zoomFit, 'click', () => controller.dispatch({ type: 'zoom-fit' }));
    listen(visSelect, 'change', () => controller.dispatch({
        type: 'set-visualization',
        visualization: visSelect.value as AudioVisualization
    }));

    if (options.signal?.aborted) { cleanup(); throw new MountAbortedError(); }

    function teardownShell(): void {
        shell.remove();
        if (root === container) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--audio');
        else root.replaceChildren();
    }
    function cleanup(): void {
        disposers.forEach((dispose) => dispose());
        teardownSurfer();
        if (url) { revoke(url); url = undefined; }
        teardownShell();
    }
    return {
        dispose(): void {
            if (disposed) return;
            disposed = true;
            cleanup();
        }
    };
}

function element(tag: string, className?: string, text?: string): HTMLElement {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(label: string, title?: string): HTMLButtonElement {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'omni-audio__btn';
    node.textContent = label;
    if (title) node.title = title;
    return node;
}

function infoItem(panel: HTMLElement, label: string): HTMLElement {
    const item = element('div', 'omni-audio__info-item');
    const value = element('div', 'omni-audio__info-value', '--');
    item.append(element('div', 'omni-audio__info-label', label), value);
    panel.append(item);
    return value;
}

function channelLabel(channels: number): string {
    return channels === 1 ? '1 (mono)' : channels === 2 ? '2 (stereo)' : String(channels);
}

function blobPart(data: Uint8Array): Uint8Array<ArrayBuffer> {
    return data.buffer instanceof ArrayBuffer ? (data as Uint8Array<ArrayBuffer>) : new Uint8Array(data);
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB'];
    let value = bytes / 1024, index = 0;
    while (value >= 1024 && index < 2) { value /= 1024; index++; }
    return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}
