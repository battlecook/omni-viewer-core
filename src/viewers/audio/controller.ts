// DOM-free presentation state for the waveform audio viewer. Playback time
// and play/pause live on the WaveSurfer instance (the engine owns them); the
// controller holds the pure knobs the toolbar mutates.

export const AUDIO_MIN_ZOOM = 1;
/** Fallback ceiling used until the track duration is known. Once it is, the
 *  viewer raises the ceiling to `zoomCeilingFor(duration)` — a fixed 32x means
 *  a one-hour file can never be zoomed past ~2 minutes per screen. */
export const AUDIO_MAX_ZOOM = 32;
export const AUDIO_VOLUME_STEPS = 100;
/** Shortest region the editor will produce, matching the original viewer. */
export const AUDIO_REGION_MIN_DURATION = 0.1;
/** Most-zoomed-in view shows this many seconds across the waveform. */
export const AUDIO_MIN_VISIBLE_SECONDS = 2;

export type AudioVisualization = 'waveform' | 'spectrogram' | 'both';

/** Frequency scales the spectrogram can be drawn on. */
export type AudioSpectrogramScale = 'linear' | 'mel' | 'bark' | 'erb';
export const AUDIO_SPECTROGRAM_SCALES: readonly AudioSpectrogramScale[] =
    ['linear', 'mel', 'bark', 'erb'];
export const AUDIO_SPECTROGRAM_DEFAULT_SCALE: AudioSpectrogramScale = 'mel';

export const showsWaveform = (mode: AudioVisualization): boolean =>
    mode === 'waveform' || mode === 'both';
export const showsSpectrogram = (mode: AudioVisualization): boolean =>
    mode === 'spectrogram' || mode === 'both';

export interface AudioViewState {
    /** Horizontal zoom multiplier over the fit-to-width pixel density. */
    zoom: number;
    /** Current ceiling for `zoom`, derived from the track duration. */
    maxZoom: number;
    /** 0..1 */
    volume: number;
    loop: boolean;
    visualization: AudioVisualization;
    spectrogramScale: AudioSpectrogramScale;
}

export type AudioAction =
    | { type: 'zoom-in' }
    | { type: 'zoom-out' }
    | { type: 'zoom-fit' }
    | { type: 'set-max-zoom'; maxZoom: number }
    | { type: 'set-volume'; volume: number }
    | { type: 'toggle-loop' }
    | { type: 'set-visualization'; visualization: AudioVisualization }
    | { type: 'set-spectrogram-scale'; scale: AudioSpectrogramScale };

/**
 * Zoom ceiling that lets the most-zoomed-in view show
 * {@link AUDIO_MIN_VISIBLE_SECONDS}. Visible seconds are `duration / zoom`, so
 * the ceiling has to scale with the track.
 */
export function zoomCeilingFor(duration: number): number {
    if (!Number.isFinite(duration) || duration <= 0) return AUDIO_MAX_ZOOM;
    return Math.max(AUDIO_MIN_ZOOM, duration / AUDIO_MIN_VISIBLE_SECONDS);
}

/** Fewest peak columns worth keeping on screen. Below this the waveform is a
 *  handful of stretched bars rather than detail. */
export const AUDIO_MIN_VISIBLE_PEAK_COLUMNS = 250;

/**
 * Zoom ceiling in peaks mode. The whole track is summarized into a fixed number
 * of columns, so zooming past that only stretches bars: a two-hour file at
 * 8000 columns holds ~0.9s per column, and the duration-based ceiling would
 * leave two or three of them on screen pretending to be a waveform.
 */
export function zoomCeilingForPeaks(duration: number, columns: number): number {
    const byDuration = zoomCeilingFor(duration);
    if (!Number.isFinite(columns) || columns <= 0) return byDuration;
    const byResolution = Math.max(AUDIO_MIN_ZOOM, columns / AUDIO_MIN_VISIBLE_PEAK_COLUMNS);
    return Math.min(byDuration, byResolution);
}

/** Compact label for the width of the visible window: `1.5s`, `30s`, `2m`. */
export function formatZoomLabel(visibleSeconds: number): string {
    if (!Number.isFinite(visibleSeconds) || visibleSeconds <= 0) return '--';
    if (visibleSeconds >= 60) return `${Math.round(visibleSeconds / 60)}m`;
    if (visibleSeconds >= 10) return `${Math.round(visibleSeconds)}s`;
    return `${visibleSeconds.toFixed(1)}s`;
}

/** Tick steps that read as round numbers of seconds/minutes. */
const TIMELINE_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
/** Minimum spacing between ticks; below this the labels collide. */
const TIMELINE_MIN_TICK_PIXELS = 100;

export interface TimelineIntervals {
    timeInterval: number;
    primaryLabelInterval: number;
    secondaryLabelInterval: number;
}

/**
 * Tick spacing for the timeline: the smallest round step that still leaves
 * {@link TIMELINE_MIN_TICK_PIXELS} between ticks. Without this the plugin's
 * default spacing produces unreadable labels on long tracks.
 */
export function timelineIntervals(duration: number, width: number): TimelineIntervals {
    if (!Number.isFinite(duration) || duration <= 0) {
        return { timeInterval: 1, primaryLabelInterval: 5, secondaryLabelInterval: 1 };
    }
    const pixelsPerSecond = (width > 0 ? width : 1000) / duration;
    const step = TIMELINE_STEPS.find((candidate) => candidate * pixelsPerSecond >= TIMELINE_MIN_TICK_PIXELS)
        ?? TIMELINE_STEPS[TIMELINE_STEPS.length - 1]!;
    return { timeInterval: step, primaryLabelInterval: step * 5, secondaryLabelInterval: step };
}

export interface ChannelStats { peak: number; rms: number }

/**
 * Peak and RMS of one channel. Sampled rather than exhaustive — a full pass
 * over an hour of audio would block the main thread, and the readout is an
 * indication of level, not a measurement.
 */
export function channelStats(samples: Float32Array, maxSamples = 200_000): ChannelStats {
    if (samples.length === 0) return { peak: 0, rms: 0 };
    const step = Math.max(1, Math.ceil(samples.length / maxSamples));
    let peak = 0;
    let sumSquares = 0;
    let count = 0;
    for (let i = 0; i < samples.length; i += step) {
        const value = samples[i]!;
        const magnitude = value < 0 ? -value : value;
        if (magnitude > peak) peak = magnitude;
        sumSquares += value * value;
        count++;
    }
    return { peak, rms: count > 0 ? Math.sqrt(sumSquares / count) : 0 };
}

export interface RegionBounds { start: number; end: number }

/**
 * Clamps typed region bounds into the track, enforcing
 * {@link AUDIO_REGION_MIN_DURATION}. With `preserveStart` the start is held and
 * the end moves — which is what editing the duration field means; otherwise
 * reversed bounds are swapped so typing an end before the start still works.
 */
export function normalizeRegionBounds(
    start: number,
    end: number,
    duration: number,
    options: { preserveStart?: boolean } = {}
): RegionBounds {
    if (!Number.isFinite(duration) || duration <= 0) return { start: 0, end: 0 };
    const min = Math.min(AUDIO_REGION_MIN_DURATION, duration);

    let from = Number.isFinite(start) ? start : 0;
    let to = Number.isFinite(end) ? end : from + min;
    if (!options.preserveStart && from > to) [from, to] = [to, from];

    from = Math.max(0, Math.min(duration, from));
    to = Math.max(0, Math.min(duration, to));

    if (from + min > to) {
        to = Math.min(duration, from + min);
        // Only when the region is pinned to the very end of the track does the
        // start have to give way to keep the minimum length.
        if (from + min > to) from = Math.max(0, to - min);
    }
    return { start: from, end: to };
}

export interface AudioController {
    readonly state: AudioViewState;
    dispatch(action: AudioAction): void;
    subscribe(listener: (state: AudioViewState) => void): () => void;
}

export function createAudioController(): AudioController {
    let zoom = 1;
    let maxZoom = AUDIO_MAX_ZOOM;
    let volume = 1;
    let loop = false;
    let visualization: AudioVisualization = 'waveform';
    let spectrogramScale: AudioSpectrogramScale = AUDIO_SPECTROGRAM_DEFAULT_SCALE;
    const clampZoom = (value: number): number => Math.min(maxZoom, Math.max(AUDIO_MIN_ZOOM, value));
    const listeners = new Set<(state: AudioViewState) => void>();
    const snapshot = (): AudioViewState =>
        ({ zoom, maxZoom, volume, loop, visualization, spectrogramScale });
    const emit = (): void => listeners.forEach((listener) => listener(snapshot()));
    return {
        get state() { return snapshot(); },
        dispatch(action) {
            const before = snapshot();
            switch (action.type) {
                case 'zoom-in': zoom = clampZoom(zoom * 2); break;
                case 'zoom-out': zoom = clampZoom(zoom / 2); break;
                case 'zoom-fit': zoom = 1; break;
                case 'set-max-zoom':
                    maxZoom = Math.max(AUDIO_MIN_ZOOM, action.maxZoom);
                    zoom = clampZoom(zoom);
                    break;
                case 'set-volume': volume = Math.min(1, Math.max(0, action.volume)); break;
                case 'toggle-loop': loop = !loop; break;
                case 'set-visualization': visualization = action.visualization; break;
                case 'set-spectrogram-scale':
                    if (AUDIO_SPECTROGRAM_SCALES.includes(action.scale)) spectrogramScale = action.scale;
                    break;
            }
            const after = snapshot();
            if (JSON.stringify(before) !== JSON.stringify(after)) emit();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
}
