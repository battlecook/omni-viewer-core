import type { FileSaveService, HostContext } from '../../host/index.js';
import { parseAudioInfo, type AudioInfo } from '../../parsers/audio/index.js';
import { mountMediaViewer, type MediaMountOptions } from '../media.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type ViewerHandle, type ViewerInput } from '../types.js';
import {
    AUDIO_SPECTROGRAM_DEFAULT_SCALE,
    AUDIO_SPECTROGRAM_SCALES,
    createAudioController,
    formatZoomLabel,
    channelStats,
    normalizeRegionBounds,
    showsSpectrogram,
    showsWaveform,
    timelineIntervals,
    zoomCeilingFor,
    zoomCeilingForPeaks,
    type AudioController,
    type AudioSpectrogramScale,
    type AudioViewState,
    type AudioVisualization
} from './controller.js';
import { encodeWavFromFloat32, isEngineSafeForFile, type AudioDecodeEngine } from './engine.js';
import { analyzeWavSource, createBytesSource } from './wav-analyzer.js';
import { audioViewerCss } from './styles.js';
import { formatMediaTime } from '../video/controller.js';

export { parseAudioInfo } from '../../parsers/audio/index.js';
export { audioViewerCss } from './styles.js';
export {
    createAudioController,
    formatZoomLabel,
    normalizeRegionBounds,
    zoomCeilingFor,
    zoomCeilingForPeaks,
    AUDIO_MIN_ZOOM,
    AUDIO_MAX_ZOOM,
    AUDIO_MIN_VISIBLE_SECONDS,
    AUDIO_MIN_VISIBLE_PEAK_COLUMNS,
    AUDIO_REGION_MIN_DURATION,
    AUDIO_SPECTROGRAM_SCALES,
    AUDIO_SPECTROGRAM_DEFAULT_SCALE,
    showsSpectrogram,
    showsWaveform,
    channelStats,
    timelineIntervals,
    type AudioSpectrogramScale,
    type ChannelStats,
    type TimelineIntervals,
    type AudioAction,
    type AudioController,
    type AudioViewState,
    type AudioVisualization,
    type RegionBounds
} from './controller.js';
export {
    analyzeWavSource,
    createBytesSource,
    peakColumns,
    type WaveformAnalysis,
    type WavAnalyzeOptions
} from './wav-analyzer.js';
export {
    createPyramidBuilder,
    envelope,
    pyramidByteLength,
    selectLevel,
    type PeakLevel,
    type PeakPyramid,
    type PyramidBuilder,
    type PyramidBuilderOptions,
    type Envelope
} from './pyramid.js';
export {
    readWavHeader,
    streamWavFrames,
    createBlobAudioSource,
    type AudioByteSource,
    type WavStreamInfo,
    type WavStreamOptions
} from './wav-stream.js';
export {
    AUDIO_WORKER_ASSET_KEY,
    AUDIO_WORKER_DEFAULT_TIMEOUT_MS,
    AudioEngineTimeoutError,
    AudioWorkerUnavailableError,
    createWorkerAudioEngine,
    type WorkerAudioEngineContext,
    type WorkerAudioEngineOptions
} from './worker-engine.js';
// Streaming mp3 path. Reachable by adapters but not wired into the viewer:
// adopting it by default hinges on cross-engine output equality, which is
// unmeasured (docs/viewers/audio.md, follow-ups).
export {
    countMp3Samples,
    id3v2Length,
    iterateMp3Frames,
    parseFrameHeader,
    readMp3Info,
    type Mp3Frame,
    type Mp3Info
} from './mp3-demux.js';
export {
    decodeMp3,
    globalWebCodecs,
    isWebCodecsAvailable,
    type AudioDataLike,
    type AudioDecoderLike,
    type Mp3DecodeOptions,
    type Mp3DecodeResult,
    type WebCodecsEnvironment
} from './webcodecs-decoder.js';
export {
    ENGINE_UNSAFE_EXTENSIONS,
    isEngineSafeForFile,
    createAssetAudioEngine,
    createWasmAudioEngine,
    encodeWavFromFloat32,
    type AudioAnalysis,
    type AudioDecodeEngine,
    type AudioEngineModuleLike,
    type DecodedAudio
} from './engine.js';

export type AudioViewerContext = HostContext & { save?: FileSaveService };

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
    /** Rendered element, used to anchor the time editors over the region.
     *  Optional: without it the editors still work, just unanchored. */
    element?: HTMLElement | null;
    /** Per-region events ('update', 'update-end') so the editors track drags. */
    on?(event: string, callback: () => void): unknown;
    /** Moves the region in place. Absent implementations are re-created via
     *  `AudioRegionsHandle.addRegion` instead. */
    setOptions?(options: { start?: number; end?: number }): void;
}

export interface AudioRegionsHandle extends AudioPluginHandle {
    on(event: string, callback: (region: AudioRegionHandle) => void): unknown;
    clearRegions(): void;
    getRegions(): AudioRegionHandle[];
    enableDragSelection(options: Record<string, unknown>): unknown;
    /** Fallback for engines whose regions cannot be moved in place. */
    addRegion?(options: { start: number; end: number; color?: string }): AudioRegionHandle;
}

/** Decoded audio as the engine reports it. `getChannelData` is optional: in
 *  peaks mode WaveSurfer synthesizes this object from the peak array. */
export interface AudioDecodedData {
    numberOfChannels: number;
    sampleRate: number;
    duration: number;
    getChannelData?(channel: number): Float32Array;
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
    getDecodedData(): AudioDecodedData | null;
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
    /** Bar rendering, matching the original viewer's look. */
    barWidth?: number;
    barGap?: number;
    barRadius?: number;
    cursorWidth?: number;
    /** Per-channel colours; engines without split rendering ignore it. */
    splitChannels?: Array<{ overlay: boolean; waveColor: string; progressColor: string }>;
    /** Precomputed peaks + duration: WaveSurfer then skips decodeAudioData
     *  and streams playback through a media element (large-file mode). */
    peaks?: number[][];
    duration?: number;
}

export interface AudioWaveformLibrary {
    createWaveSurfer(options: AudioWaveSurferCreateOptions): AudioWaveSurferHandle;
    createRegions?(): AudioRegionsHandle;
    createTimeline?(options: {
        container: HTMLElement;
        timeInterval?: number;
        primaryLabelInterval?: number;
        secondaryLabelInterval?: number;
    }): AudioPluginHandle;
    createSpectrogram?(options: {
        container: HTMLElement;
        labels: boolean;
        height: number;
        splitChannels: boolean;
        /** Frequency scale; engines that only do mel may ignore it. */
        scale?: string;
        fftSamples?: number;
        noverlap?: number;
    }): AudioPluginHandle;
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
    optionalServices: ['save'] as const,
    inputOwnership: 'borrows' as const
};

/** Most recently focused audio viewer, so a document-level Space handler only
 *  fires for the one the user is actually looking at (mirrors viewers/hwp). */
let activeKeyboardOwner: object | undefined;

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_ANALYZE_BYTES = 50 * 1024 * 1024;
const ANALYZE_PEAK_COLUMNS = 8000;
const REGION_COLOR = 'rgba(79,193,255,0.25)';
const WAVE_COLOR = '#4fc1ff';
const PROGRESS_COLOR = '#0e639c';
// Second channel gets its own hue so a stereo split is readable at a glance.
const WAVE_COLOR_SECONDARY = '#2f7d77';
const PROGRESS_COLOR_SECONDARY = '#1f5c58';
// Matches the original viewer: 4096-point FFT at 50% overlap reads as detailed
// without being unusably slow, and 250px gives the mel bands room to separate.
const SPECTROGRAM_FFT_SIZE = 4096;
const SPECTROGRAM_OVERLAP = 2048;
const SPECTROGRAM_HEIGHT = 250;

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
    const keyboardOwner = {};
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
    const headerText = element('div', 'omni-audio__header-text');
    headerText.append(
        element('div', 'omni-audio__title', input.fileName),
        element('div', 'omni-audio__meta', `${info.mimeType} · ${formatBytes(input.data.byteLength)}`)
    );
    const download = button(t('audio.download'));
    download.classList.add('omni-audio__btn--download');
    if (!ctx.save) {
        download.disabled = true;
        download.title = t('common.noFileSave');
    }
    header.append(headerText, download);

    const infoPanel = element('div', 'omni-audio__info');
    const durationValue = infoItem(infoPanel, t('audio.info.duration'));
    const sampleRateValue = infoItem(infoPanel, t('audio.info.sampleRate'));
    const channelsValue = infoItem(infoPanel, t('audio.info.channels'));
    const channelDetail = infoDetail(channelsValue);
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
    for (const [value, key] of [
        ['waveform', 'audio.vis.waveform'],
        ['spectrogram', 'audio.vis.spectrogram'],
        ['both', 'audio.vis.both']
    ] as const) {
        const option = document.createElement('option');
        option.value = value; option.textContent = t(key);
        visSelect.append(option);
    }
    if (!library.createSpectrogram) visSelect.disabled = true;
    visLabel.append(visSelect);
    visGroup.append(visLabel);

    const scaleGroup = element('div', 'omni-audio__group omni-audio__group--scale');
    const scaleLabel = element('label', 'omni-audio__group-label', t('audio.spectrogramScale'));
    const scaleSelect = document.createElement('select');
    scaleSelect.className = 'omni-audio__select';
    for (const scale of AUDIO_SPECTROGRAM_SCALES) {
        const option = document.createElement('option');
        option.value = scale; option.textContent = t(`audio.scale.${scale}`);
        scaleSelect.append(option);
    }
    scaleSelect.value = AUDIO_SPECTROGRAM_DEFAULT_SCALE;
    scaleLabel.append(scaleSelect);
    scaleGroup.append(scaleLabel);
    // Only meaningful while a spectrogram is on screen.
    scaleGroup.hidden = true;

    const time = element('span', 'omni-audio__time', '0:00 / 0:00');
    controls.append(transport, volumeGroup, zoomGroup, visGroup, scaleGroup, time);

    const stage = element('div', 'omni-audio__stage');
    const loading = element('div', 'omni-audio__loading', t('audio.loading'));
    const timeline = element('div', 'omni-audio__timeline');
    const waveform = element('div', 'omni-audio__waveform');
    const spectrogram = element('div', 'omni-audio__spectrogram');

    // Numeric editors for the selected region. Dragging alone cannot express
    // an exact boundary, so start/end/length are typeable; they are anchored
    // over the region when the engine exposes its element.
    const regionEditor = element('div', 'omni-audio__region-editor');
    regionEditor.hidden = true;
    const regionField = (className: string, labelKey: string): HTMLInputElement => {
        const wrap = element('label', `omni-audio__region-field ${className}`);
        const input = document.createElement('input');
        input.type = 'number';
        input.step = '0.001';
        input.min = '0';
        input.className = 'omni-audio__region-input';
        input.title = t(labelKey);
        input.setAttribute('aria-label', t(labelKey));
        wrap.append(input);
        regionEditor.append(wrap);
        return input;
    };
    const regionStartInput = regionField('omni-audio__region-field--start', 'audio.region.start');
    const regionDurationInput = regionField('omni-audio__region-field--duration', 'audio.region.duration');
    const regionEndInput = regionField('omni-audio__region-field--end', 'audio.region.end');

    // The editor is a sibling of the waveform, not a child: teardownSurfer()
    // clears the waveform container on every rebuild.
    const waveformWrap = element('div', 'omni-audio__waveform-wrap');
    waveformWrap.append(waveform, regionEditor);
    stage.append(loading, timeline, waveformWrap, spectrogram);

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
    let timelinePlugin: AudioPluginHandle | undefined;
    let timelineDuration = 0;
    let selectedRegion: AudioRegionHandle | null = null;
    let ready = false;
    let disposed = false;
    let engineTried = false;
    /** True once engine peaks replaced the browser decode. In this mode
     *  WaveSurfer synthesizes a fake buffer from the peaks, so anything
     *  derived from `getDecodedData()` is meaningless (see the `ready`
     *  handler and the spectrogram control below). */
    let peaksMode = false;
    /** Columns the peaks were reduced to — the real resolution limit for zoom. */
    let peakColumnCount = 0;
    let spectrogramScaleInUse: AudioSpectrogramScale | undefined;
    // Withheld formats fall back to the browser decode, which is slower on a
    // large file but correct — and correctness is the one the engine cannot
    // currently offer here (see ENGINE_UNSAFE_EXTENSIONS).
    const engine = deps.engine && isEngineSafeForFile(input.fileName) ? deps.engine : undefined;

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
        // The spectrogram plugin renders from decoded samples, which peaks
        // mode deliberately never produces — leaving the control enabled only
        // offers the user an empty canvas.
        if (library.createSpectrogram) {
            visSelect.disabled = !enabled || peaksMode;
            visSelect.title = peaksMode ? t('audio.vis.unavailableLarge') : '';
        }
    };
    setControlsEnabled(false);

    /** Per-channel level readout under the channel count. Needs real samples,
     *  so it stays empty in peaks mode and for engines without getChannelData. */
    const showChannelStats = (decoded: AudioDecodedData): void => {
        if (decoded.numberOfChannels !== 2 || typeof decoded.getChannelData !== 'function') return;
        try {
            const left = channelStats(decoded.getChannelData(0));
            const right = channelStats(decoded.getChannelData(1));
            channelDetail.textContent = t('audio.info.channelLevels', {
                leftPeak: left.peak.toFixed(3), leftRms: left.rms.toFixed(3),
                rightPeak: right.peak.toFixed(3), rightRms: right.rms.toFixed(3)
            });
        } catch {
            // Synthetic buffers can refuse channel access; the readout is optional.
        }
    };

    const refreshTime = (): void => {
        if (!surfer) return;
        time.textContent = `${formatMediaTime(surfer.getCurrentTime())} / ${formatMediaTime(surfer.getDuration())}`;
    };
    let regionSyncCleanup: (() => void) | undefined;

    const positionRegionEditor = (region: AudioRegionHandle): void => {
        const element = region.element;
        if (!element) {
            // Unanchored fallback: the editors still work, they just sit at a
            // fixed spot instead of tracking the region.
            regionEditor.classList.add('omni-audio__region-editor--unanchored');
            regionEditor.style.removeProperty('left');
            regionEditor.style.removeProperty('width');
            return;
        }
        regionEditor.classList.remove('omni-audio__region-editor--unanchored');
        const bounds = waveformWrap.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        // Track the region, but never past either edge of the waveform: a
        // region at the very end would otherwise push the fields out of view.
        const width = regionEditor.offsetWidth || box.width;
        const left = Math.max(0, Math.min(box.left - bounds.left, Math.max(0, bounds.width - width)));
        regionEditor.style.left = `${left}px`;
    };

    const syncRegionEditor = (region: AudioRegionHandle): void => {
        const duration = region.end - region.start;
        // Skip the field being typed in, or the caret jumps mid-edit.
        const active = (root as ShadowRoot).activeElement ?? document.activeElement;
        if (active !== regionStartInput) regionStartInput.value = region.start.toFixed(3);
        if (active !== regionEndInput) regionEndInput.value = region.end.toFixed(3);
        if (active !== regionDurationInput) regionDurationInput.value = duration.toFixed(3);
        positionRegionEditor(region);
    };

    const detachRegionSync = (): void => {
        regionSyncCleanup?.();
        regionSyncCleanup = undefined;
    };

    const showRegionEditor = (region: AudioRegionHandle): void => {
        detachRegionSync();
        regionEditor.hidden = false;
        waveformWrap.classList.add('is-editing-region');
        syncRegionEditor(region);
        if (typeof region.on !== 'function') return;
        const offs: Array<() => void> = [];
        for (const event of ['update', 'update-end']) {
            const off = region.on(event, () => syncRegionEditor(region));
            if (typeof off === 'function') offs.push(off as () => void);
        }
        regionSyncCleanup = () => offs.forEach((off) => off());
    };

    const hideRegionEditor = (): void => {
        detachRegionSync();
        regionEditor.hidden = true;
        waveformWrap.classList.remove('is-editing-region');
    };

    /** Applies typed bounds to the selected region, moving it in place when the
     *  engine supports that and re-creating it otherwise. */
    const applyRegionBounds = (start: number, end: number, preserveStart = false): void => {
        if (!selectedRegion || !surfer) return;
        const bounds = normalizeRegionBounds(start, end, surfer.getDuration(), { preserveStart });
        if (typeof selectedRegion.setOptions === 'function') {
            selectedRegion.setOptions({ start: bounds.start, end: bounds.end });
            selectedRegion.start = bounds.start;
            selectedRegion.end = bounds.end;
        } else if (regions?.addRegion) {
            selectedRegion.remove();
            selectedRegion = regions.addRegion({ ...bounds, color: REGION_COLOR });
        } else {
            // Nothing to apply with — restore the displayed values.
            syncRegionEditor(selectedRegion);
            return;
        }
        syncRegionEditor(selectedRegion);
        refreshStatus();
    };

    const readRegionInputs = (): { start: number; end: number } => ({
        start: Number.parseFloat(regionStartInput.value),
        end: Number.parseFloat(regionEndInput.value)
    });

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

    /** (Re)builds the timeline for a known duration. The plugin fixes its tick
     *  spacing at construction, so a duration that only arrives at 'ready'
     *  means rebuilding rather than updating. */
    const buildTimeline = (duration: number): void => {
        if (!surfer || !library.createTimeline || duration <= 0) return;
        if (timelineDuration === duration) return;
        timelinePlugin?.destroy?.();
        timeline.replaceChildren();
        timelineDuration = duration;
        timelinePlugin = surfer.registerPlugin(library.createTimeline({
            container: timeline,
            ...timelineIntervals(duration, timeline.clientWidth)
        }));
    };

    const destroySpectrogram = (): void => {
        spectrogramPlugin?.destroy?.();
        spectrogramPlugin = undefined;
        spectrogram.replaceChildren();
    };

    const applyVisualization = (mode: AudioVisualization, scale: AudioSpectrogramScale): void => {
        if (!surfer) return;
        const wantsSpectrogram = showsSpectrogram(mode) && !!library.createSpectrogram;
        // The plugin bakes the scale in at construction, so switching scales
        // means rebuilding it rather than mutating it.
        if (wantsSpectrogram && spectrogramPlugin && scale !== spectrogramScaleInUse) destroySpectrogram();
        if (wantsSpectrogram && !spectrogramPlugin) {
            const decoded = surfer.getDecodedData();
            spectrogramScaleInUse = scale;
            spectrogramPlugin = surfer.registerPlugin(library.createSpectrogram!({
                container: spectrogram,
                labels: true,
                height: SPECTROGRAM_HEIGHT,
                splitChannels: (decoded?.numberOfChannels ?? 1) > 1,
                scale,
                fftSamples: SPECTROGRAM_FFT_SIZE,
                noverlap: SPECTROGRAM_OVERLAP
            }));
        }
        if (!wantsSpectrogram && spectrogramPlugin) destroySpectrogram();

        waveformWrap.hidden = !showsWaveform(mode);
        spectrogram.classList.toggle('omni-audio__spectrogram--active', wantsSpectrogram);
        scaleGroup.hidden = !wantsSpectrogram;
    };

    const applyState = (state: AudioViewState): void => {
        if (!surfer) return;
        surfer.setVolume(state.volume);
        volume.value = String(Math.round(state.volume * 100));
        // The visible window is what the user is actually judging; a bare
        // multiplier says nothing without knowing the track length.
        const duration = surfer.getDuration();
        zoomLabel.textContent = duration > 0 ? formatZoomLabel(duration / state.zoom) : '--';
        loop.classList.toggle('is-active', state.loop);
        if (ready) surfer.zoom(basePxPerSec() * state.zoom);
        applyVisualization(state.visualization, state.spectrogramScale);
        visSelect.value = state.visualization;
        scaleSelect.value = state.spectrogramScale;
        refreshStatus();
    };
    disposers.push(controller.subscribe(applyState));

    const teardownSurfer = (): void => {
        hideRegionEditor();
        for (const dispose of surferDisposers.splice(0)) { try { dispose(); } catch { /* engine own teardown */ } }
        spectrogramPlugin?.destroy?.();
        spectrogramPlugin = undefined;
        timelinePlugin = undefined;
        timelineDuration = 0;
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
        if (engine && !engineTried) {
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
            const decoded = await engine!.decode(input.data);
            if (disposed) return;
            const wav = encodeWavFromFloat32(decoded.pcm, decoded.channels, decoded.sampleRate);
            teardownSurfer();
            if (url) { revoke(url); url = undefined; }
            url = createUrl(new Blob([blobPart(wav)], { type: 'audio/wav' }));
            // The rebuilt stream is decoded in full, so the peaks-mode
            // restrictions no longer apply — leaving the flag set would keep
            // the spectrogram disabled and skip the channel readout on a
            // surfer that does have real samples.
            peaksMode = false;
            peakColumnCount = 0;
            if (!buildSurfer({ url })) onDecodeFailure();
            setControlsEnabled(ready);
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
                waveColor: WAVE_COLOR, progressColor: PROGRESS_COLOR, cursorColor: '#ffffff',
                barWidth: 2, barGap: 3, barRadius: 3, cursorWidth: 1,
                splitChannels: [
                    { overlay: false, waveColor: WAVE_COLOR, progressColor: PROGRESS_COLOR },
                    { overlay: false, waveColor: WAVE_COLOR_SECONDARY, progressColor: PROGRESS_COLOR_SECONDARY }
                ],
                ...source
            });
        } catch {
            return false;
        }
        // Only the peaks path knows the duration this early. Everywhere else
        // the timeline is built once 'ready' reports it — passing placeholder
        // intervals here would pin a long track to 1-second ticks and would
        // also be worse than the engine's own adaptive default.
        if (library.createTimeline && source.duration) buildTimeline(source.duration);
        if (library.createRegions) {
            regions = surfer.registerPlugin(library.createRegions());
            regions.enableDragSelection({ color: REGION_COLOR });
            const select = (payload: unknown): void => {
                selectedRegion = payload as AudioRegionHandle;
                showRegionEditor(selectedRegion);
                refreshStatus();
            };
            wsOn(regions, 'region-created', select);
            wsOn(regions, 'region-clicked', select);
            wsOn(regions, 'region-updated', (payload) => {
                if (selectedRegion && (payload as AudioRegionHandle)?.id === selectedRegion.id) {
                    syncRegionEditor(selectedRegion);
                }
            });
            wsOn(regions, 'region-removed', (payload) => {
                if (selectedRegion && (payload as AudioRegionHandle)?.id === selectedRegion.id) {
                    selectedRegion = null;
                    hideRegionEditor();
                    refreshStatus();
                }
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
            // Only now is the duration known, so this is where the zoom range
            // stops being a placeholder and starts reflecting the track.
            const trackDuration = surfer!.getDuration();
            controller.dispatch({
                type: 'set-max-zoom',
                maxZoom: peaksMode
                    ? zoomCeilingForPeaks(trackDuration, peakColumnCount)
                    : zoomCeilingFor(trackDuration)
            });
            buildTimeline(surfer!.getDuration());
            durationValue.textContent = formatMediaTime(surfer!.getDuration());
            // In peaks mode `decoded` is WaveSurfer's synthetic buffer built
            // from our peak array: sampleRate is peaks.length / duration and
            // numberOfChannels is 1. Both would overwrite the real values the
            // engine analysis already wrote.
            if (decoded && !peaksMode) {
                sampleRateValue.textContent = `${decoded.sampleRate.toLocaleString()} Hz`;
                channelsValue.textContent = channelLabel(decoded.numberOfChannels);
                showChannelStats(decoded);
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

    let sourceBlob: Blob;
    try {
        sourceBlob = new Blob([blobPart(input.data)], { type: info.mimeType });
        url = createUrl(sourceBlob);
    } catch {
        teardownShell();
        return mountMediaViewer('audio', input, container, ctx, info.mimeType, info.warnings, options);
    }

    // Large files: precompute peaks so the waveform engine skips the expensive
    // (and memory-hungry) browser decode and streams via a media element.
    //
    // Two analyzers, tried in order. The streaming one reads WAV directly and
    // keeps only a peak pyramid, so it needs no decoder, holds constant memory
    // and preserves channels. The WASM engine covers the formats it cannot
    // read, at the cost of decoding the whole file into the wasm heap.
    let initialSource: { url: string; peaks?: number[][]; duration?: number } = { url };
    const analyzeBytes = options.engineAnalyzeBytes ?? DEFAULT_ANALYZE_BYTES;
    const large = input.data.byteLength > analyzeBytes;

    const applyAnalysis = (analysis: {
        sampleRate: number; channels: number; duration: number; channelPeaks: number[][];
    }): void => {
        initialSource = { url: url!, peaks: analysis.channelPeaks, duration: analysis.duration };
        peaksMode = true;
        peakColumnCount = analysis.channelPeaks[0]?.length ?? 0;
        sampleRateValue.textContent = `${analysis.sampleRate.toLocaleString()} Hz`;
        channelsValue.textContent = channelLabel(analysis.channels);
        durationValue.textContent = formatMediaTime(analysis.duration);
    };
    const abortIfCancelled = (): void => {
        if (!options.signal?.aborted) return;
        teardownShell();
        if (url) revoke(url);
        throw new MountAbortedError();
    };

    if (large) {
        let analyzed = false;
        try {
            const analysis = await analyzeWavSource(
                createBytesSource(input.data),
                ANALYZE_PEAK_COLUMNS,
                options.signal ? { signal: options.signal } : {}
            );
            abortIfCancelled();
            applyAnalysis(analysis);
            analyzed = true;
            ctx.logger.log('info', `audio: streamed ${analysis.channels}-channel peaks, pyramid ${analysis.pyramidByteLength} bytes`);
        } catch (error) {
            if (error instanceof MountAbortedError) throw error;
            // The streaming reader reports cancellation as a plain Error, so
            // check the signal before blaming the format — otherwise closing
            // the viewer mid-analysis reads as "not a WAV" and starts the
            // engine on a file the user already walked away from.
            abortIfCancelled();
            // Not a WAV, or its header is unusable — that is the normal case for
            // every other format, so it is not worth reporting on its own.
            ctx.logger.log('info', `audio: streaming analysis unavailable (${(error as Error).message})`);
        }

        if (!analyzed && !engine && deps.engine) {
            // The engine exists but is withheld for this format, so a file this
            // large is about to take the slow path. Say so rather than letting
            // it look like an unexplained stall.
            ctx.logger.log('warn', `audio: engine withheld for ${input.fileName}, using browser decode`);
            showWarning(t('audio.warning.analysisSkipped'));
        }

        if (!analyzed && engine) {
            try {
                const analysis = await engine.analyze(input.data, ANALYZE_PEAK_COLUMNS);
                abortIfCancelled();
                // The engine reduces every channel to one mono column.
                applyAnalysis({ ...analysis, channelPeaks: [analysis.peaks] });
            } catch (error) {
                if (error instanceof MountAbortedError) throw error;
                // Analysis is an optimization — fall through to normal decode.
                // But the fallback is the whole-file browser decode this path
                // exists to avoid, so the user needs to know why it got slow.
                ctx.logger.log('warn', `audio: peak analysis failed, falling back to browser decode (${(error as Error).message})`);
                showWarning(t('audio.warning.analysisFailed'));
            }
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
        hideRegionEditor();
        refreshStatus();
    });

    if (ctx.save) {
        listen(download, 'click', () => {
            void (async () => {
                try {
                    await ctx.save!.saveFile(input.fileName, input.data, info.mimeType);
                } catch (error) {
                    ctx.logger.log('error', `audio: save failed (${String(error)})`);
                    showWarning(t('audio.error.save'));
                }
            })();
        });
    }

    const commitOn = (input: HTMLInputElement, commit: () => void): void => {
        listen(input, 'change', commit);
        listen(input, 'keydown', ((event: KeyboardEvent) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            commit();
            input.blur();
        }) as EventListener);
    };
    commitOn(regionStartInput, () => {
        const { start, end } = readRegionInputs();
        applyRegionBounds(start, end);
    });
    commitOn(regionEndInput, () => {
        const { start, end } = readRegionInputs();
        applyRegionBounds(start, end);
    });
    commitOn(regionDurationInput, () => {
        if (!selectedRegion) return;
        const length = Number.parseFloat(regionDurationInput.value);
        if (!Number.isFinite(length)) { syncRegionEditor(selectedRegion); return; }
        // Editing the length moves the end, never the start.
        applyRegionBounds(selectedRegion.start, selectedRegion.start + length, true);
    });

    // Space toggles playback, the one shortcut every audio player has. Scoped
    // by the same active-owner guard the hwp viewer uses so stacked viewers do
    // not all react to one keypress.
    shell.tabIndex = -1;
    activeKeyboardOwner = keyboardOwner;
    listen(shell, 'pointerdown', () => { activeKeyboardOwner = keyboardOwner; });
    listen(shell, 'focusin', () => { activeKeyboardOwner = keyboardOwner; });
    listen(document, 'keydown', ((event: KeyboardEvent) => {
        if (activeKeyboardOwner !== keyboardOwner || event.code !== 'Space') return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const target = event.target as HTMLElement | null;
        if (target?.matches?.('input, textarea, select, [contenteditable]')) return;
        if (!ready) return;
        event.preventDefault();
        void surfer?.playPause();
    }) as EventListener);
    listen(volume, 'input', () => controller.dispatch({ type: 'set-volume', volume: Number(volume.value) / 100 }));
    listen(zoomIn, 'click', () => controller.dispatch({ type: 'zoom-in' }));
    listen(zoomOut, 'click', () => controller.dispatch({ type: 'zoom-out' }));
    listen(zoomFit, 'click', () => controller.dispatch({ type: 'zoom-fit' }));
    listen(visSelect, 'change', () => controller.dispatch({
        type: 'set-visualization',
        visualization: visSelect.value as AudioVisualization
    }));
    listen(scaleSelect, 'change', () => controller.dispatch({
        type: 'set-spectrogram-scale',
        scale: scaleSelect.value as AudioSpectrogramScale
    }));

    if (options.signal?.aborted) { cleanup(); throw new MountAbortedError(); }

    function teardownShell(): void {
        shell.remove();
        if (root === container) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--audio');
        else root.replaceChildren();
    }
    function cleanup(): void {
        if (activeKeyboardOwner === keyboardOwner) activeKeyboardOwner = undefined;
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

/** Adds a secondary line under an info value, for detail that is not always
 *  available (channel levels need decoded samples). */
function infoDetail(value: HTMLElement): HTMLElement {
    const detail = element('div', 'omni-audio__info-detail');
    value.parentElement?.append(detail);
    return detail;
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
