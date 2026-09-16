import type { FileSaveService, HostContext } from '../../host/index.js';
import { parseAudioInfo, type AudioInfo } from '../../parsers/audio/index.js';
import { mountMediaViewer, type MediaMountOptions } from '../media.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type ViewerHandle, type ViewerInput } from '../types.js';
import {
    AUDIO_SPECTROGRAM_DEFAULT_SCALE,
    AUDIO_SPECTROGRAM_FREQUENCY_MAXIMA,
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
import { analyzeMp3Source } from './mp3-analyzer.js';
import { decodeMp3Window, readDecodedWindow, readWavWindow } from './audio-window.js';
import {
    createSpectrogramView,
    type ColorRamp,
    type SpectrogramView,
    type WindowReader
} from './spectrogram-view.js';
import type { WindowFunction } from './spectrogram.js';
import { isWebCodecsAvailable } from './webcodecs-decoder.js';
import { iterateMp3Frames, readMp3Info } from './mp3-demux.js';
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
    AUDIO_SPECTROGRAM_FREQUENCY_MAXIMA,
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
export { analyzeMp3Source, type Mp3AnalyzeOptions } from './mp3-analyzer.js';
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
// Streaming mp3 path. The viewer uses it for large files where WebCodecs is
// available; decoding through the host codec does not carry the WASM engine's
// cross-platform bit-equality (DESIGN.md §3-①).
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
    /** Optional: starts playback outright. Preferred over `playPause()`
     *  wherever the intent is "play", since a toggle depends on a state the
     *  engine may not have settled yet. */
    play?(): void | Promise<void>;
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
    /** Rate the engine decodes at. WaveSurfer defaults this to 8000, which
     *  caps a spectrogram at 4 kHz and makes the reported rate wrong, so the
     *  viewer always supplies the source rate (or a sane fallback). */
    sampleRate?: number;
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
    /** Files above this size use peak analysis (default 50 MiB). Applies only
     *  when the decoded size cannot be read from the header. */
    engineAnalyzeBytes?: number;
    /** Peak analysis threshold on *decoded* bytes, used whenever the header
     *  gives enough to compute it (default 400 MiB). File size is a poor proxy:
     *  a 122 MiB WAV decodes to 245 MiB while a same-sized FLAC decodes to
     *  five times that. */
    analyzeDecodedBytes?: number;
    /** Analysis and drawing settings for the spectrogram. Every field has a
     *  working default; an adapter only sets what it wants to differ. */
    spectrogram?: AudioSpectrogramOptions;
}

/** Spectrogram settings an adapter can override, mirroring the options the
 *  WaveSurfer plugin took so a caller can carry its configuration over. */
export interface AudioSpectrogramOptions {
    /** Analysis window in samples; must be a power of two (default 4096). */
    fftSize?: number;
    /** Rows drawn per channel, which is also the pane height (default 250). */
    height?: number;
    windowFunc?: WindowFunction;
    /** Extra shape parameter for `blackman` and `gauss`. */
    alpha?: number;
    /** dB at which a bin reaches full intensity (default 20). */
    gainDb?: number;
    /** dB span below `gainDb` that maps onto the colour ramp (default 80). */
    rangeDb?: number;
    /** Lowest frequency drawn, in Hz (default 0). */
    frequencyMin?: number;
    /** Draw the frequency axis (default true). */
    labels?: boolean;
    labelsColor?: string;
    labelsBackground?: string;
    /** One spectrogram per channel. Defaults to on for stereo material. */
    splitChannels?: boolean;
    /** Colour stops from silence to full intensity. Keep the first stop dark:
     *  most of a spectrogram is silence, and a bright floor buries the signal. */
    colorMap?: ColorRamp;
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
/** Decoded-size threshold. 400 MiB keeps a 12-minute stereo WAV (245 MiB) on
 *  the full-decode path, where the spectrogram and channel levels work. */
const DEFAULT_ANALYZE_DECODED_BYTES = 400 * 1024 * 1024;
const ANALYZE_PEAK_COLUMNS = 8000;
const REGION_COLOR = 'rgba(79,193,255,0.25)';
const WAVE_COLOR = '#4fc1ff';
const PROGRESS_COLOR = '#0e639c';
// Second channel gets its own hue so a stereo split is readable at a glance.
const WAVE_COLOR_SECONDARY = '#2f7d77';
const PROGRESS_COLOR_SECONDARY = '#1f5c58';
// Matches the original viewer: 4096-point FFT at 50% overlap reads as detailed
// without being unusably slow, and 250px gives the mel bands room to separate.
/** Used only when the source rate cannot be read from the file. Wrong for
 *  48 kHz material, but every real format beats WaveSurfer's 8000 default. */
const FALLBACK_DECODE_SAMPLE_RATE = 44100;
/** Floor for the reduced-rate fallback: below this the waveform starts losing
 *  its shape, not just its top octaves. */
const MIN_DECODE_SAMPLE_RATE = 16000;

/** What a full browser decode of this file would cost in memory. */
export interface DecodedSizeEstimate {
    sampleRate: number;
    channels: number;
    frames: number;
    bytes: number;
}

/**
 * Reads rate/channels/length from the container header, without decoding.
 * WAV carries them in `fmt `, and mp3 frame headers give the rate plus an
 * exact frame count for a few tens of milliseconds of work. Formats needing a
 * real decoder return undefined and the caller falls back to file size.
 */
export function estimateDecodedSize(fileName: string, data: Uint8Array): DecodedSizeEstimate | undefined {
    const extension = fileName.toLowerCase().split('.').pop() ?? '';
    try {
        if (extension === 'wav') {
            const info = parseAudioInfo(fileName, data);
            if (!info.sampleRate || !info.channels || !info.bitsPerSample) return undefined;
            const bytesPerFrame = info.channels * (info.bitsPerSample / 8);
            // parseAudioInfo stops at `fmt `, so derive length from the payload
            // that follows the 44-byte canonical header.
            const frames = Math.max(0, Math.floor((data.byteLength - 44) / bytesPerFrame));
            return sized(info.sampleRate, info.channels, frames);
        }
        if (extension === 'mp3') {
            const info = readMp3Info(data);
            let frames = 0;
            for (const frame of iterateMp3Frames(data, info)) frames += frame.samples;
            return sized(info.sampleRate, info.channels, frames);
        }
    } catch {
        // Malformed header — treat as unknown rather than failing the mount.
    }
    return undefined;
}

const sized = (sampleRate: number, channels: number, frames: number): DecodedSizeEstimate =>
    ({ sampleRate, channels, frames, bytes: frames * channels * 4 });

// A 4096-sample analysis window: fine enough to separate the mel bands, and
// large enough that a long track is not chopped into a punishing number of
// columns — the plugin's 512 default would produce eight times as many.
//
// `noverlap` is deliberately left unset. The plugin derives the hop from the
// canvas width; pinning it to 2048 produced twice the necessary columns, each
// one a synchronous FFT on the main thread.
// View-mode glyphs. Literal constants drawn with `currentColor`, so they follow
// the button's own colour in either theme. Bars read as a waveform, the cell
// grid as a spectrogram, and the split as both stacked.
// Transport glyphs, same convention as the view-mode icons.
const ICON_PLAY =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="currentColor">'
    + '<path d="M4 2.5v11l9-5.5z"/></svg>';
const ICON_PAUSE =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="currentColor">'
    + '<rect x="3.5" y="2.5" width="3.5" height="11" rx="0.5"/>'
    + '<rect x="9" y="2.5" width="3.5" height="11" rx="0.5"/></svg>';

const VIS_ICON_WAVEFORM =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">'
    + '<rect x="1" y="6" width="2" height="4" rx="1"/><rect x="4.5" y="3" width="2" height="10" rx="1"/>'
    + '<rect x="8" y="1" width="2" height="14" rx="1"/><rect x="11.5" y="4" width="2" height="8" rx="1"/></svg>';
const VIS_ICON_SPECTROGRAM =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">'
    + '<rect x="1" y="1" width="3" height="3" opacity=".35"/><rect x="5" y="1" width="3" height="3" opacity=".7"/>'
    + '<rect x="9" y="1" width="3" height="3" opacity=".2"/><rect x="1" y="5" width="3" height="3" opacity=".8"/>'
    + '<rect x="5" y="5" width="3" height="3"/><rect x="9" y="5" width="3" height="3" opacity=".5"/>'
    + '<rect x="1" y="9" width="3" height="3" opacity=".25"/><rect x="5" y="9" width="3" height="3" opacity=".55"/>'
    + '<rect x="9" y="9" width="3" height="3" opacity=".85"/></svg>';
const VIS_ICON_BOTH =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">'
    + '<rect x="1" y="3" width="2" height="3" rx="1"/><rect x="5" y="1" width="2" height="7" rx="1"/>'
    + '<rect x="9" y="2" width="2" height="5" rx="1"/><rect x="13" y="3" width="2" height="3" rx="1"/>'
    + '<rect x="1" y="10" width="3" height="3" opacity=".5"/><rect x="5" y="10" width="3" height="3"/>'
    + '<rect x="9" y="10" width="3" height="3" opacity=".35"/><rect x="13" y="10" width="2" height="3" opacity=".7"/></svg>';

const SPECTROGRAM_FFT_SIZE = 4096;
const SPECTROGRAM_HEIGHT = 250;
/** Pixels the engine draws per waveform channel. A stereo file gets one strip
 *  per channel, so the drawn waveform is a multiple of this. */
const WAVEFORM_STRIP_HEIGHT = 128;

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
    // Header-derived facts, read without decoding. Drive both the rate the
    // engine decodes at and the peaks-mode decision.
    const decodedSize = estimateDecodedSize(input.fileName, input.data);
    const spectrogramOptions = options.spectrogram ?? {};
    const sourceSampleRate = info.sampleRate ?? decodedSize?.sampleRate;
    let decodeSampleRate = sourceSampleRate ?? FALLBACK_DECODE_SAMPLE_RATE;

    /**
     * Reader for a window of mono samples, when the format allows decoding one
     * without touching the rest of the file. Its presence is what lets the
     * spectrogram follow the viewport instead of transforming the whole track —
     * including in peaks mode, where no decoded buffer exists at all.
     */
    const fileWindowReader: WindowReader | undefined = (() => {
        const extension = input.fileName.toLowerCase().split('.').pop() ?? '';
        if (extension === 'wav') {
            return (from: number, count: number, signal?: AbortSignal, keepChannels?: boolean) =>
                readWavWindow(createBytesSource(input.data), from, count, {
                    ...(signal ? { signal } : {}),
                    ...(keepChannels ? { keepChannels } : {})
                });
        }
        if (extension === 'mp3' && isWebCodecsAvailable()) {
            return (from: number, count: number, signal?: AbortSignal, keepChannels?: boolean) =>
                decodeMp3Window(input.data, from, count, {
                    ...(signal ? { signal } : {}),
                    ...(keepChannels ? { keepChannels } : {})
                });
        }
        return undefined;
    })();

    /** Audio the engine decoded in full, once there is any. Peaks mode leaves
     *  this null: its buffer is synthetic and holds no samples. */
    let decodedAudio: AudioDecodedData | null = null;
    /** Rate the open view addresses frames in, so a decoded buffer at a
     *  different rate is not indexed with the wrong scale. */
    let windowSampleRate = sourceSampleRate ?? FALLBACK_DECODE_SAMPLE_RATE;

    /**
     * Window of samples for a frame range, from whichever source is cheapest.
     *
     * A fully decoded track is already in memory, so re-reading and re-decoding
     * the file for every viewport would be pure waste; only when there is no
     * such buffer — peaks mode, or before `ready` — does this fall back to
     * decoding a slice of the file.
     */
    const readWindow: WindowReader = async (from, count, signal, keepChannels) => {
        if (decodedAudio && decodedAudio.sampleRate === windowSampleRate) {
            const memory = readDecodedWindow(decodedAudio, from, count, { keepChannels: !!keepChannels });
            if (memory) return memory;
        }
        if (!fileWindowReader) throw new Error('audio: no sample source for this format');
        return fileWindowReader(from, count, signal, keepChannels);
    };

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
    /** Icon transport button. The glyph carries the meaning, so the accessible
     *  name comes from aria-label rather than the (empty) text content. */
    const iconButton = (glyph: string, label: string, modifier: string): HTMLButtonElement => {
        const node = document.createElement('button');
        node.type = 'button';
        node.className = `omni-audio__btn omni-audio__btn--icon ${modifier}`;
        node.innerHTML = glyph;
        node.title = label;
        node.setAttribute('aria-label', label);
        return node;
    };
    const playPause = iconButton(ICON_PLAY, t('audio.play'), 'omni-audio__btn--play');
    let playing = false;
    /** Single source for the transport state: glyph and accessible name move
     *  together, and the click handler reads the same flag. */
    const setPlaying = (next: boolean): void => {
        playing = next;
        playPause.innerHTML = next ? ICON_PAUSE : ICON_PLAY;
        const label = t(next ? 'audio.pause' : 'audio.play');
        playPause.title = label;
        playPause.setAttribute('aria-label', label);
    };

    // Loop is a checkbox that appears with a region, matching the original.
    const loopGroup = element('div', 'omni-audio__group omni-audio__group--loop');
    const loopLabel = element('label', 'omni-audio__toggle');
    const loop = document.createElement('input');
    loop.type = 'checkbox';
    loop.className = 'omni-audio__checkbox';
    // The label says what will repeat, because that changes with the
    // selection: a region loops on its own, and the whole track loops when
    // there is none.
    const loopText = element('span');
    loopLabel.append(loop, loopText);
    loopGroup.append(loopLabel);
    loopGroup.hidden = true;

    const transport = element('div', 'omni-audio__group');
    transport.append(playPause, loopGroup);

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

    // Segmented buttons rather than a dropdown: there are only three modes and
    // the current one should be readable without opening anything. Matches the
    // original viewer's control, drawn with the core's own tokens.
    const visGroup = element('div', 'omni-audio__group');
    const visButtons = element('div', 'omni-audio__modes');
    visButtons.setAttribute('role', 'group');
    visButtons.setAttribute('aria-label', t('audio.visualization'));
    const visModeButtons = new Map<AudioVisualization, HTMLButtonElement>();
    for (const [mode, key, glyph] of [
        ['waveform', 'audio.vis.waveform', VIS_ICON_WAVEFORM],
        ['spectrogram', 'audio.vis.spectrogram', VIS_ICON_SPECTROGRAM],
        ['both', 'audio.vis.both', VIS_ICON_BOTH]
    ] as const) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'omni-audio__mode';
        button.dataset.mode = mode;
        button.title = t(key);
        button.setAttribute('aria-label', t(key));
        button.setAttribute('aria-pressed', 'false');
        button.innerHTML = glyph;
        visButtons.append(button);
        visModeButtons.set(mode, button);
    }
    // The icons carry the meaning; the group keeps its name on aria-label.
    visGroup.append(visButtons);

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

    // A full 22 kHz axis leaves speech and most music crushed into the bottom
    // rows; capping the range is what makes that content readable.
    const frequencyGroup = element('div', 'omni-audio__group omni-audio__group--frequency');
    const frequencyLabel = element('label', 'omni-audio__group-label', t('audio.frequencyRange'));
    const frequencySelect = document.createElement('select');
    frequencySelect.className = 'omni-audio__select';
    for (const hz of AUDIO_SPECTROGRAM_FREQUENCY_MAXIMA) {
        const option = document.createElement('option');
        option.value = String(hz);
        option.textContent = hz === 0
            ? t('audio.frequency.full')
            : t('audio.frequency.limit', { hz: `${hz / 1000} kHz` });
        frequencySelect.append(option);
    }
    frequencySelect.value = '0';
    frequencyLabel.append(frequencySelect);
    frequencyGroup.append(frequencyLabel);
    frequencyGroup.hidden = true;

    const time = element('span', 'omni-audio__time', '0:00 / 0:00');
    controls.append(transport, volumeGroup, zoomGroup, visGroup, scaleGroup, frequencyGroup, time);

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
    const regionField = (className: string, labelKey: string): { field: HTMLElement; input: HTMLInputElement } => {
        const field = element('label', `omni-audio__region-field ${className}`);
        const input = document.createElement('input');
        input.type = 'number';
        input.step = '0.001';
        input.min = '0';
        input.className = 'omni-audio__region-input';
        input.title = t(labelKey);
        input.setAttribute('aria-label', t(labelKey));
        field.append(input);
        regionEditor.append(field);
        return { field, input };
    };
    // Source order follows the original's reading order: start, length, end.
    const startField = regionField('omni-audio__region-field--start', 'audio.region.start');
    const durationField = regionField('omni-audio__region-field--duration', 'audio.region.duration');
    const endField = regionField('omni-audio__region-field--end', 'audio.region.end');
    const regionStartInput = startField.input;
    const regionDurationInput = durationField.input;
    const regionEndInput = endField.input;

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
    let spectrogramView: SpectrogramView | undefined;
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
    /**
     * Whether {@link readWindow} has anything to read from. True for formats we
     * can slice ourselves, and for any format once the engine has decoded it —
     * which is what extends the windowed renderer past wav and mp3.
     */
    const sampleWindowsAvailable = (): boolean =>
        !!fileWindowReader || (!!decodedAudio && typeof decodedAudio.getChannelData === 'function');

    const setControlsEnabled = (enabled: boolean): void => {
        for (const control of [playPause, loop, volume, zoomOut, zoomIn, zoomFit]) {
            (control as HTMLButtonElement | HTMLInputElement).disabled = !enabled;
        }
        // Neither group means anything before the duration is known, and the
        // original viewer kept them out of the toolbar until then.
        zoomGroup.hidden = !enabled;
        loopGroup.hidden = !enabled;
        // The spectrogram plugin renders from decoded samples, which peaks
        // mode deliberately never produces — offering the modes that need them
        // would only hand the user an empty canvas.
        // A window reader works even in peaks mode: it decodes from the file
        // rather than from a decoded buffer that peaks mode never builds.
        const spectrogramUsable = sampleWindowsAvailable()
            || (!!library.createSpectrogram && !peaksMode);
        for (const [mode, button] of visModeButtons) {
            const needsSamples = mode !== 'waveform';
            button.disabled = !enabled || (needsSamples && !spectrogramUsable);
            button.title = needsSamples && peaksMode
                ? t('audio.vis.unavailableLarge')
                : t(`audio.vis.${mode}`);
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

    /**
     * Places the three editors around the region the way the original viewer
     * did: length above the region (over the waveform, centred), start and end
     * below it at the matching edges. Each is clamped to the waveform so a
     * region at either extreme cannot push a field out of view.
     */
    const positionRegionEditor = (region: AudioRegionHandle): void => {
        const element = region.element;
        if (!element) {
            // Unanchored fallback: the editors still work, they just sit in a
            // plain row instead of tracking the region.
            regionEditor.classList.add('omni-audio__region-editor--unanchored');
            for (const { field } of [startField, durationField, endField]) {
                field.style.removeProperty('left');
                field.style.removeProperty('top');
            }
            return;
        }
        regionEditor.classList.remove('omni-audio__region-editor--unanchored');
        const bounds = waveformWrap.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        const left = box.left - bounds.left;
        const right = box.right - bounds.left;
        const top = box.top - bounds.top;
        const bottom = box.bottom - bounds.top;

        const clamp = (x: number, width: number): number =>
            Math.max(0, Math.min(x, Math.max(0, bounds.width - width)));

        // Each boundary field is centred on the edge it edits; anchoring by the
        // box's left corner left the numbers sitting well to the right of the
        // edges they belong to.
        const startWidth = startField.field.offsetWidth;
        const endWidth = endField.field.offsetWidth;
        startField.field.style.left = `${clamp(left - startWidth / 2, startWidth)}px`;
        startField.field.style.top = `${bottom + 6}px`;
        endField.field.style.left = `${clamp(right - endWidth / 2, endWidth)}px`;
        endField.field.style.top = `${bottom + 6}px`;
        // Centred on the region: the transform in the stylesheet pulls it back
        // by half its own width.
        const durationWidth = durationField.field.offsetWidth;
        durationField.field.style.left = `${clamp(left + box.width / 2 - durationWidth / 2, durationWidth) + durationWidth / 2}px`;
        durationField.field.style.top = `${top + 10}px`;
    };

    const syncRegionEditor = (
        region: AudioRegionHandle,
        options: { force?: boolean } = {}
    ): void => {
        const duration = region.end - region.start;
        // Skip the field being typed in, or the caret jumps mid-edit. A commit
        // passes `force`: the typed value has been applied and normalised, so
        // the field has to show the result rather than what was typed.
        const active = options.force
            ? null
            : (root as ShadowRoot).activeElement ?? document.activeElement;
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
            const off = region.on(event, () => {
                syncRegionEditor(region);
                // Dragging moves the region, so the status line has to follow
                // it too — otherwise the editors and the summary disagree.
                refreshStatus();
            });
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
        syncRegionEditor(selectedRegion, { force: true });
        refreshStatus();
    };

    const refreshStatus = (): void => {
        const loopKey = selectedRegion ? 'audio.loop.region' : 'audio.loop.track';
        loopText.textContent = t(loopKey);
        loopLabel.title = t(loopKey);
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
        waveformWrap.classList.remove('has-inline-spectrogram');
        spectrogramView?.destroy();
        spectrogramView = undefined;
        spectrogram.replaceChildren();
    };

    /** Current viewport in seconds, from the engine's own scroll state. */
    let visibleRange: { start: number; end: number } | undefined;
    const showSpectrogramWindow = (): void => {
        if (!spectrogramView || !surfer) return;
        const duration = surfer.getDuration();
        const start = visibleRange?.start ?? 0;
        const end = visibleRange?.end ?? duration;
        spectrogramView.show({
            scrollSeconds: start,
            visibleSeconds: Math.max(0, end - start),
            width: spectrogram.clientWidth || waveform.clientWidth || 1000
        });
    };

    const applyVisualization = (
        mode: AudioVisualization,
        scale: AudioSpectrogramScale,
        frequencyMax: number
    ): void => {
        if (!surfer) return;
        const windowReader = sampleWindowsAvailable();
        const wantsSpectrogram = showsSpectrogram(mode)
            && (windowReader || !!library.createSpectrogram);

        if (wantsSpectrogram && windowReader) {
            // Viewport-driven: decode and transform only what is on screen, so
            // the cost follows the canvas rather than the file. The plugin can
            // only do whole files, which is minutes of work on a long track and
            // impossible in peaks mode where nothing is decoded.
            if (!spectrogramView) {
                // A decoded buffer is the source of truth for the rate when
                // there is one: the engine may have decoded at a reduced rate,
                // and indexing its frames with the file's rate would land in
                // the wrong place.
                const rate = decodedAudio?.sampleRate ?? sourceSampleRate ?? FALLBACK_DECODE_SAMPLE_RATE;
                windowSampleRate = rate;
                spectrogramView = createSpectrogramView({
                    container: spectrogram,
                    read: readWindow,
                    sampleRate: rate,
                    totalFrames: decodedAudio
                        ? Math.round(decodedAudio.duration * rate)
                        : decodedSize?.frames ?? Math.round(surfer.getDuration() * rate),
                    bins: spectrogramOptions.height ?? SPECTROGRAM_HEIGHT,
                    fftSize: spectrogramOptions.fftSize ?? SPECTROGRAM_FFT_SIZE,
                    scale,
                    labels: spectrogramOptions.labels ?? true,
                    // Stereo material differs between channels, and a downmix
                    // hides that. Matches what the plugin did — and the header
                    // count keeps it working in peaks mode, where nothing is
                    // decoded and the plugin could not run at all.
                    splitChannels: spectrogramOptions.splitChannels
                        ?? (decodedAudio?.numberOfChannels ?? decodedSize?.channels ?? 1) > 1,
                    ...(spectrogramOptions.windowFunc ? { windowFunc: spectrogramOptions.windowFunc } : {}),
                    ...(spectrogramOptions.alpha !== undefined ? { alpha: spectrogramOptions.alpha } : {}),
                    ...(spectrogramOptions.gainDb !== undefined ? { gainDb: spectrogramOptions.gainDb } : {}),
                    ...(spectrogramOptions.rangeDb !== undefined ? { rangeDb: spectrogramOptions.rangeDb } : {}),
                    ...(spectrogramOptions.frequencyMin !== undefined
                        ? { frequencyMin: spectrogramOptions.frequencyMin } : {}),
                    ...(spectrogramOptions.labelsColor ? { labelsColor: spectrogramOptions.labelsColor } : {}),
                    ...(spectrogramOptions.labelsBackground
                        ? { labelsBackground: spectrogramOptions.labelsBackground } : {}),
                    ...(spectrogramOptions.colorMap ? { colorMap: spectrogramOptions.colorMap } : {}),
                    ...(frequencyMax > 0 ? { frequencyMax } : {}),
                    onError: (error) => {
                        ctx.logger.log('error', `audio: spectrogram window failed (${error.message})`);
                        showWarning(t('audio.error.spectrogram'));
                    }
                });
            }
            spectrogramView.setSettings({
                scale,
                // 0 means the full range, which the view expresses as Nyquist.
                frequencyMax: frequencyMax > 0 ? frequencyMax : windowSampleRate / 2
            });
            showSpectrogramWindow();
        } else if (wantsSpectrogram) {
            // The plugin bakes the scale in at construction, so switching scales
            // means rebuilding it rather than mutating it.
            if (spectrogramPlugin && scale !== spectrogramScaleInUse) destroySpectrogram();
            if (!spectrogramPlugin) {
                const decoded = surfer.getDecodedData();
                spectrogramScaleInUse = scale;
                // Some builds ignore the container and draw into the waveform's
                // own wrapper; the class scopes the playhead clamp to that case.
                waveformWrap.classList.add('has-inline-spectrogram');
                spectrogramPlugin = surfer.registerPlugin(library.createSpectrogram!({
                    container: spectrogram,
                    labels: spectrogramOptions.labels ?? true,
                    height: spectrogramOptions.height ?? SPECTROGRAM_HEIGHT,
                    splitChannels: (decoded?.numberOfChannels ?? 1) > 1,
                    scale,
                    fftSamples: spectrogramOptions.fftSize ?? SPECTROGRAM_FFT_SIZE
                }));
            }
        }
        if (!wantsSpectrogram && (spectrogramPlugin || spectrogramView)) destroySpectrogram();

        // Collapsed, not hidden. `display: none` takes the waveform out of
        // layout, and the spectrogram plugin derives its hop from that
        // element's width — a width of 0 makes the hop degenerate and the
        // render never finishes. Measured: visible renders a 12-minute track
        // in ~6 s, hidden does not complete in 200 s.
        waveformWrap.classList.toggle('is-collapsed', !showsWaveform(mode));
        spectrogram.classList.toggle('omni-audio__spectrogram--active', wantsSpectrogram);
        scaleGroup.hidden = !wantsSpectrogram;
        // Only the windowed renderer can redraw a narrowed range; the plugin
        // has no such control, so the select would be a dead end there.
        frequencyGroup.hidden = !wantsSpectrogram || !windowReader;
    };

    const applyState = (state: AudioViewState): void => {
        if (!surfer) return;
        surfer.setVolume(state.volume);
        volume.value = String(Math.round(state.volume * 100));
        // The visible window is what the user is actually judging; a bare
        // multiplier says nothing without knowing the track length.
        const duration = surfer.getDuration();
        zoomLabel.textContent = duration > 0 ? formatZoomLabel(duration / state.zoom) : '--';
        loop.checked = state.loop;
        if (ready) surfer.zoom(basePxPerSec() * state.zoom);
        applyVisualization(state.visualization, state.spectrogramScale, state.spectrogramFrequencyMax);
        for (const [mode, button] of visModeButtons) {
            const active = mode === state.visualization;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        }
        scaleSelect.value = state.spectrogramScale;
        frequencySelect.value = String(state.spectrogramFrequencyMax);
        refreshStatus();
    };
    disposers.push(controller.subscribe(applyState));

    const teardownSurfer = (): void => {
        hideRegionEditor();
        for (const dispose of surferDisposers.splice(0)) { try { dispose(); } catch { /* engine own teardown */ } }
        destroySpectrogram();
        visibleRange = undefined;
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
                container: waveform, height: WAVEFORM_STRIP_HEIGHT, normalize: true,
                waveColor: WAVE_COLOR, progressColor: PROGRESS_COLOR, cursorColor: '#ffffff',
                sampleRate: decodeSampleRate,
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
            // One region at a time: a new drag replaces the previous selection
            // rather than stacking on it. The editors and the status line both
            // describe a single region, so leaving older ones on the waveform
            // shows selections nothing can act on.
            wsOn(regions, 'region-created', (payload) => {
                const created = payload as AudioRegionHandle;
                // Select first: removing the old region fires 'region-removed',
                // and that handler clears the selection when the id matches.
                select(created);
                for (const existing of regions?.getRegions() ?? []) {
                    if (existing.id !== created.id) existing.remove();
                }
            });
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
            // Peaks mode's buffer is synthetic — no samples behind it — so it
            // must not become a window source.
            decodedAudio = peaksMode ? null : decoded;
            // The engine draws one strip per channel, so the playhead clamp has
            // to know how many there are — a stereo file is twice as tall.
            const strips = Math.max(1, Math.min(2, decoded?.numberOfChannels ?? decodedSize?.channels ?? 1));
            waveformWrap.style.setProperty('--omni-audio-wave-height', `${strips * WAVEFORM_STRIP_HEIGHT}px`);
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
                // The decoded rate is what we asked the engine to decode at,
                // which for formats we cannot parse is a fallback rather than
                // the file's own rate. Report the header value when there is one.
                const rate = sourceSampleRate ?? decoded.sampleRate;
                sampleRateValue.textContent = `${rate.toLocaleString()} Hz`;
                channelsValue.textContent = channelLabel(decoded.numberOfChannels);
                showChannelStats(decoded);
            }
            refreshTime();
            applyState(controller.state);
        });
        wsOn(surfer, 'play', () => setPlaying(true));
        wsOn(surfer, 'pause', () => setPlaying(false));
        wsOn(surfer, 'timeupdate', refreshTime);
        // The engine reports the visible span directly, so the spectrogram can
        // follow a scroll or zoom without measuring the DOM itself.
        wsOn(surfer, 'scroll', ((start: number, end: number) => {
            visibleRange = { start, end };
            showSpectrogramWindow();
        }) as (payload?: unknown) => void);
        wsOn(surfer, 'zoom', () => showSpectrogramWindow());
        wsOn(surfer, 'finish', () => {
            setPlaying(false);
            if (controller.state.loop && !selectedRegion && surfer) {
                surfer.setTime(0);
                // Not playPause(): on wavesurfer 7.12.1 the engine has not
                // settled its playing flag when 'finish' fires, so the toggle
                // read it as "playing" and stopped the track instead of
                // looping it. Measured — 7.12.12 happens to work either way.
                startPlayback(surfer);
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
    // Prefer the decoded size when the header gives it: that is what a full
    // browser decode actually costs, and it is what peaks mode trades away.
    const large = decodedSize
        ? decodedSize.bytes > (options.analyzeDecodedBytes ?? DEFAULT_ANALYZE_DECODED_BYTES)
        : input.data.byteLength > (options.engineAnalyzeBytes ?? DEFAULT_ANALYZE_BYTES);

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
        /** Runs one streaming analyzer, reporting failure without giving up. */
        const tryStreaming = async (
            label: string,
            run: () => Promise<Parameters<typeof applyAnalysis>[0] & { pyramidByteLength: number }>
        ): Promise<void> => {
            if (analyzed) return;
            try {
                const analysis = await run();
                abortIfCancelled();
                applyAnalysis(analysis);
                analyzed = true;
                ctx.logger.log('info', `audio: ${label} streamed ${analysis.channels}-channel peaks, pyramid ${analysis.pyramidByteLength} bytes`);
            } catch (error) {
                if (error instanceof MountAbortedError) throw error;
                // The streaming readers report cancellation as a plain Error, so
                // check the signal before blaming the format — otherwise closing
                // the viewer mid-analysis reads as "wrong format" and starts the
                // next analyzer on a file the user already walked away from.
                abortIfCancelled();
                // Wrong container for this analyzer is the normal case, so this
                // is not worth surfacing on its own.
                ctx.logger.log('info', `audio: ${label} analysis unavailable (${(error as Error).message})`);
            }
        };

        await tryStreaming('wav', () => analyzeWavSource(
            createBytesSource(input.data),
            ANALYZE_PEAK_COLUMNS,
            options.signal ? { signal: options.signal } : {}
        ));
        // mp3 has no other streaming route: the engine mishandles it, so without
        // this every mp3 is decoded whole however long it is.
        if (!analyzed && isWebCodecsAvailable()) {
            await tryStreaming('mp3', () => analyzeMp3Source(
                input.data,
                ANALYZE_PEAK_COLUMNS,
                options.signal ? { signal: options.signal } : {}
            ));
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

        // Nothing produced peaks, so the browser is about to decode the whole
        // file. Decoding at the source rate would cost `decodedSize.bytes` —
        // 404 MiB for a 20-minute mp3 — which is what takes a tab down. Trade
        // bandwidth for survival: the waveform keeps its shape, the reported
        // sample rate still comes from the header, and only the spectrogram's
        // top octaves are lost.
        if (!analyzed && decodedSize && !peaksMode) {
            const budget = options.analyzeDecodedBytes ?? DEFAULT_ANALYZE_DECODED_BYTES;
            const scaled = Math.floor(decodeSampleRate * (budget / decodedSize.bytes));
            const reduced = Math.max(MIN_DECODE_SAMPLE_RATE, Math.min(decodeSampleRate, scaled));
            if (reduced < decodeSampleRate) {
                ctx.logger.log('warn',
                    `audio: decoding at ${reduced}Hz instead of ${decodeSampleRate}Hz to keep a `
                    + `${Math.round(decodedSize.bytes / 1048576)} MiB decode inside the budget`);
                decodeSampleRate = reduced;
                showWarning(t('audio.warning.reducedFidelity'));
            }
        }
    }

    if (!buildSurfer(initialSource)) {
        if (url) revoke(url);
        teardownShell();
        return mountMediaViewer('audio', input, container, ctx, info.mimeType,
            [...info.warnings, ctx.i18n.t('audio.fallback')], options);
    }

    listen(playPause, 'click', () => {
        if (!surfer) return;
        // A selected region is the thing the user is working on, so play starts
        // at its head rather than wherever the cursor happens to sit.
        if (!playing && selectedRegion) selectedRegion.play();
        else void surfer.playPause();
    });
    listen(loop, 'change', () => controller.dispatch({ type: 'toggle-loop' }));
    // Pressing the waveform away from the selection drops it — the engine moves
    // the playhead to the press on its own, and leaving a region highlighted
    // somewhere else would contradict where playback now is.
    //
    // On pointerdown rather than click: a drag that creates a new region also
    // ends in a click, and acting on that would delete the region just made.
    //
    // The press has to be located through `composedPath()`. The engine renders
    // regions inside its own shadow root, so by the time the event reaches this
    // listener `target` has been retargeted to the shadow host — a containment
    // test against it fails for every press, including one that landed on the
    // region, which dropped the selection instead of starting a drag.
    listen(waveform, 'pointerdown', ((event: Event) => {
        if (!selectedRegion) return;
        const element = selectedRegion.element;
        if (element && pressLandedOn(event, element)) return;
        selectedRegion.remove();
    }) as EventListener);

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
    // Each field commits against the region's own other edge, never against
    // what the other input happens to show: a commit re-renders the fields, and
    // reading a stale one collapsed the region to its minimum length.
    commitOn(regionStartInput, () => {
        if (!selectedRegion) return;
        const start = Number.parseFloat(regionStartInput.value);
        if (!Number.isFinite(start)) { syncRegionEditor(selectedRegion, { force: true }); return; }
        applyRegionBounds(start, selectedRegion.end);
    });
    commitOn(regionEndInput, () => {
        if (!selectedRegion) return;
        const end = Number.parseFloat(regionEndInput.value);
        if (!Number.isFinite(end)) { syncRegionEditor(selectedRegion, { force: true }); return; }
        applyRegionBounds(selectedRegion.start, end);
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
    for (const [mode, button] of visModeButtons) {
        listen(button, 'click', () => controller.dispatch({ type: 'set-visualization', visualization: mode }));
    }
    listen(frequencySelect, 'change', () => controller.dispatch({
        type: 'set-spectrogram-frequency-max',
        hz: Number(frequencySelect.value)
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

/** Starts playback, using the engine's own play when it exposes one. */
function startPlayback(handle: AudioWaveSurferHandle): void {
    if (typeof handle.play === 'function') void handle.play();
    else void handle.playPause();
}

/**
 * Whether a press landed on `element` or inside it.
 *
 * `composedPath()` is the only reliable test: an element inside a shadow root
 * never appears as `event.target` outside that root, so containment alone
 * reports "outside" for a press that visibly landed on it.
 */
function pressLandedOn(event: Event, element: Element): boolean {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (path.length > 0) return path.includes(element);
    const target = event.target as Node | null;
    return !!target && element.contains(target);
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
