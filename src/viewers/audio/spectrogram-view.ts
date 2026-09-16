// Viewport-driven spectrogram: decodes the visible range, transforms it, and
// paints it. Replaces the engine plugin, which only ever works on a whole file
// and so costs seconds-to-forever on long audio.
//
// Split from the DOM on purpose: `paintSpectrogram` and `viewportFrames` are
// pure and tested, and the controller below is the only part that needs a
// canvas.

import {
    computeSpectrogram,
    frequencyAtFraction,
    hopForColumns,
    type FrequencyScale,
    type WindowFunction
} from './spectrogram.js';
import type { AudioWindow } from './audio-window.js';

/** Supplies samples for a frame range: a mono downmix, plus the individual
 *  channels when `keepChannels` is set and the source can provide them. */
export type WindowReader = (
    fromFrame: number,
    frameCount: number,
    signal?: AbortSignal,
    keepChannels?: boolean
) => Promise<AudioWindow>;

export interface Viewport {
    /** Seconds of audio to the left of the visible area. */
    scrollSeconds: number;
    /** Seconds of audio visible. */
    visibleSeconds: number;
    /** Visible width in device-independent pixels. */
    width: number;
}

export interface FrameRange { fromFrame: number; frameCount: number }

/**
 * Frame range a viewport covers, padded by one screen on each side so a small
 * scroll lands on already-decoded audio, and clamped to the track.
 */
export function viewportFrames(
    viewport: Viewport,
    sampleRate: number,
    totalFrames: number,
    overscan = 1
): FrameRange {
    const visible = Math.max(0, viewport.visibleSeconds);
    const padded = visible * (1 + 2 * overscan);
    const from = Math.max(0, Math.floor((viewport.scrollSeconds - visible * overscan) * sampleRate));
    const count = Math.min(totalFrames - from, Math.ceil(padded * sampleRate));
    return { fromFrame: from, frameCount: Math.max(0, count) };
}

/** Stops interpolated from silence to full intensity. */
export type ColorRamp = ReadonlyArray<readonly [number, number, number]>;

/**
 * Default colour map: "roseus" — black → indigo → magenta → orange → white.
 *
 * This is the map the WaveSurfer spectrogram plugin draws with, reproduced
 * entry for entry so a viewer that used to run the plugin looks unchanged. A
 * two-colour ramp is not a substitute: the plugin's midtones are what make a
 * noise floor readable instead of a black field.
 *
 * Stored as packed RGB bytes because 256 literal triples would be a screenful
 * of noise in the middle of this file.
 */
const ROSEUS_RGB =
    '01010101020202020202030302030402040502050603060703070803080a03090c030a0e030c10030d11030e13020f15' +
    '02101702111902121b02131e01142001152201162401172601182800192b001a2d001b2f001b32001c34001d36001e39' +
    '001e3b011f3e01204001204302214503214804224a05234d06234f0823520924540b24560d25590f255b11255e132560' +
    '1526631726651926681b266a1d266c1f266f2126712326732626762826782a267a2c267c2e267e312680332682352584' +
    '3725863a25883c248a3e248b41248d43238f4523904823924a22934c22954f2196512197542098562099581f9a5b1f9b' +
    '5d1e9c5f1d9d621d9e641c9f671c9f691ba06b1ba06e1aa1701aa17219a17519a27718a27918a27c17a27e17a28017a2' +
    '8316a18516a18716a18916a18c16a08e16a090169f92169f94169e96169d99169d9b179c9d179b9f179aa11899a31898' +
    'a51997a71a96a91a95ab1b94ad1c93af1d92b11d91b31e90b51f8eb7208db8218cba228bbc2389be2488c02587c12785' +
    'c32884c52982c62a81c82b80ca2d7ecb2e7dcd2f7bce307ad03278d13377d33475d43674d63772d73971d93a6fda3c6e' +
    'db3d6ddd3f6bde406adf4268e14367e24565e34664e44863e54961e64b60e74d5ee94e5dea505ceb525bec5359ed5558' +
    'ed5757ee5956ef5a54f05c53f15e52f26051f26150f3634ff4654ef5674df5694cf66b4bf66c4af76e4af87049f87248' +
    'f87448f97647f97847fa7a46fa7c46fa7e46fb8046fb8245fb8446fb8646fb8846fc8a46fc8c46fc8e47fc9048fc9248' +
    'fc9449fc964afb984bfb9a4cfb9c4dfb9e4efba050fba251faa453faa655faa857f9aa58f9ac5af8ae5df8b05ff8b261' +
    'f7b463f7b666f6b868f6ba6bf5bc6ef4be70f4c073f3c276f3c379f2c57cf2c77ff1c983f0cb86f0cd89efcf8cefd090' +
    'eed293eed497edd59aedd79eecd9a1ecdaa5ecdca9ecdeacebdfb0ebe1b4ebe2b7ebe4bbebe5bfebe6c2ece8c6ece9c9' +
    'eceacdedecd0ededd4eeeed7efefdbf0f0def1f2e1f2f3e4f3f4e7f4f5eaf6f6edf7f7f0f9f8f2fbf9f5fdfaf7fefbf9';

/** The map used when a caller does not supply one. */
export const DEFAULT_COLOR_MAP: ColorRamp = decodeRamp(ROSEUS_RGB);
const RAMP = DEFAULT_COLOR_MAP;

function decodeRamp(packed: string): ColorRamp {
    const out: Array<readonly [number, number, number]> = [];
    for (let i = 0; i + 5 < packed.length; i += 6) {
        out.push([
            parseInt(packed.slice(i, i + 2), 16),
            parseInt(packed.slice(i + 2, i + 4), 16),
            parseInt(packed.slice(i + 4, i + 6), 16)
        ]);
    }
    return out;
}

function colorFor(intensity: number, out: Uint8ClampedArray, at: number, ramp: ColorRamp): void {
    const t = (intensity / 255) * (ramp.length - 1);
    const index = Math.min(ramp.length - 2, Math.floor(t));
    const frac = t - index;
    const from = ramp[index]!;
    const to = ramp[index + 1]!;
    out[at] = Math.round(from[0] + (to[0] - from[0]) * frac);
    out[at + 1] = Math.round(from[1] + (to[1] - from[1]) * frac);
    out[at + 2] = Math.round(from[2] + (to[2] - from[2]) * frac);
    out[at + 3] = 255;
}

export interface PaintedSpectrogram { columns: number; bins: number }

/**
 * Paints intensities onto a canvas, one pixel column per analysis column and
 * low frequencies at the bottom. Sizing the canvas to the data and letting CSS
 * stretch it keeps the work proportional to the analysis, not the display.
 */
export function paintSpectrogram(
    canvas: HTMLCanvasElement,
    spectrogram: { columns: number; bins: number; data: Uint8Array },
    ramp?: ColorRamp
): PaintedSpectrogram {
    return paintSpectrograms(canvas, [spectrogram], ramp);
}

/**
 * Paints one spectrogram per channel, stacked top to bottom in channel order.
 * Stereo material is rarely identical across channels, and stacking is how the
 * difference becomes visible at all.
 */
export function paintSpectrograms(
    canvas: HTMLCanvasElement,
    layers: ReadonlyArray<{ columns: number; bins: number; data: Uint8Array }>,
    ramp: ColorRamp = RAMP
): PaintedSpectrogram {
    const colors = ramp.length >= 2 ? ramp : RAMP;
    const first = layers[0];
    const columns = first?.columns ?? 0;
    const bins = first?.bins ?? 0;
    const height = bins * Math.max(1, layers.length);
    canvas.width = Math.max(1, columns);
    canvas.height = Math.max(1, height);
    const context = canvas.getContext('2d');
    if (!context || columns === 0 || bins === 0) return { columns, bins };

    const image = context.createImageData(columns, height);
    layers.forEach((layer, index) => {
        const top = index * bins;
        for (let column = 0; column < Math.min(columns, layer.columns); column++) {
            for (let row = 0; row < bins; row++) {
                // Flip vertically: row 0 is the lowest frequency, drawn at the
                // base of its own band.
                const y = top + bins - 1 - row;
                colorFor(layer.data[column * bins + row]!, image.data, (y * columns + column) * 4, colors);
            }
        }
    });
    context.putImageData(image, 0, 0);
    return { columns, bins };
}

/** Frequencies to mark, chosen so the ticks stay legible at any height. */
const LABEL_SPACING_PX = 50;

export interface AxisOptions {
    bins: number;
    layers: number;
    scale: FrequencyScale;
    frequencyMin: number;
    frequencyMax: number;
    color?: string;
    background?: string;
}

const formatHz = (hz: number): string =>
    hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10_000 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`;

/**
 * Draws the frequency axis over the picture, once per stacked channel.
 *
 * Kept on its own canvas: the spectrogram is sized to the analysis and stretched
 * by CSS, which would smear any text drawn into it.
 */
export function paintAxis(canvas: HTMLCanvasElement, options: AxisOptions): number[] {
    const { bins, layers, scale } = options;
    const width = AXIS_WIDTH;
    canvas.width = width;
    canvas.height = Math.max(1, bins * layers);
    const context = canvas.getContext('2d');
    const ticks = Math.max(2, Math.round(bins / LABEL_SPACING_PX));
    const marks: number[] = [];
    for (let i = 0; i <= ticks; i++) {
        marks.push(frequencyAtFraction(i / ticks, scale, options.frequencyMin, options.frequencyMax));
    }
    if (!context) return marks;

    context.clearRect(0, 0, width, canvas.height);
    context.font = '10px sans-serif';
    context.textBaseline = 'middle';
    for (let layer = 0; layer < layers; layer++) {
        const base = layer * bins;
        marks.forEach((hz, i) => {
            const label = formatHz(hz);
            // The topmost tick would sit half outside its band; nudge it in.
            const offset = i === marks.length - 1 ? 6 : i === 0 ? -6 : 0;
            const y = base + bins - (i / ticks) * bins + offset;
            const textWidth = context.measureText(label).width;
            context.fillStyle = options.background ?? 'rgba(0, 0, 0, 0.6)';
            context.fillRect(0, y - 6, textWidth + 8, 12);
            context.fillStyle = options.color ?? '#ffffff';
            context.fillText(label, 4, y);
        });
    }
    return marks;
}

/** Enough for "22.1 kHz" at 10px plus its backing box. */
const AXIS_WIDTH = 64;

export interface SpectrogramViewOptions {
    container: HTMLElement;
    read: WindowReader;
    sampleRate: number;
    totalFrames: number;
    /** Rows of output; also the display height. */
    bins?: number;
    fftSize?: number;
    /** Analysis columns to aim for across the visible width. */
    targetColumns?: number;
    scale?: FrequencyScale;
    /** Draw the frequency axis. Without it the picture cannot be read. */
    labels?: boolean;
    labelsColor?: string;
    labelsBackground?: string;
    /** One spectrogram per channel, stacked. Doubles the work. */
    splitChannels?: boolean;
    frequencyMin?: number;
    frequencyMax?: number;
    windowFunc?: WindowFunction;
    alpha?: number;
    gainDb?: number;
    rangeDb?: number;
    /** Colour ramp from silence to full intensity, at least two stops. The
     *  first stop must be dark: most of a spectrogram is silence. */
    colorMap?: ColorRamp;
    onError?(error: Error): void;
}

export interface SpectrogramView {
    /** Recomputes for a viewport. Calls collapse: only the last one paints. */
    show(viewport: Viewport): void;
    setScale(scale: FrequencyScale): void;
    /** Changes analysis settings and repaints. Only the given fields change. */
    setSettings(settings: SpectrogramSettings): void;
    destroy(): void;
}

/** The analysis knobs a user can move while the view is open. */
export interface SpectrogramSettings {
    scale?: FrequencyScale;
    frequencyMin?: number;
    frequencyMax?: number;
    windowFunc?: WindowFunction;
    alpha?: number;
    gainDb?: number;
    rangeDb?: number;
    splitChannels?: boolean;
    labels?: boolean;
}

const DEFAULT_BINS = 250;
const DEFAULT_FFT_SIZE = 1024;
const DEFAULT_TARGET_COLUMNS = 1200;
/** Scrolling fires continuously; recompute once it settles. */
const SETTLE_MS = 120;

/**
 * Keeps a canvas showing the spectrogram of whatever is on screen.
 *
 * Requests overlap constantly while a user drags, so each new one cancels the
 * last: without that, a drag queues a decode per frame and the tab crawls.
 */
export function createSpectrogramView(options: SpectrogramViewOptions): SpectrogramView {
    const bins = options.bins ?? DEFAULT_BINS;
    const fftSize = options.fftSize ?? DEFAULT_FFT_SIZE;
    const targetColumns = options.targetColumns ?? DEFAULT_TARGET_COLUMNS;
    const settings: Required<Pick<SpectrogramSettings, 'scale' | 'splitChannels' | 'labels'>>
        & SpectrogramSettings = {
        scale: options.scale ?? 'mel',
        splitChannels: options.splitChannels ?? false,
        labels: options.labels ?? false,
        ...(options.frequencyMin !== undefined ? { frequencyMin: options.frequencyMin } : {}),
        ...(options.frequencyMax !== undefined ? { frequencyMax: options.frequencyMax } : {}),
        ...(options.windowFunc !== undefined ? { windowFunc: options.windowFunc } : {}),
        ...(options.alpha !== undefined ? { alpha: options.alpha } : {}),
        ...(options.gainDb !== undefined ? { gainDb: options.gainDb } : {}),
        ...(options.rangeDb !== undefined ? { rangeDb: options.rangeDb } : {})
    };

    const stack = document.createElement('div');
    stack.className = 'omni-audio__spectrogram-stack';
    const canvas = document.createElement('canvas');
    canvas.className = 'omni-audio__spectrogram-canvas';
    canvas.style.height = `${bins}px`;
    const axis = document.createElement('canvas');
    axis.className = 'omni-audio__spectrogram-axis';
    axis.hidden = !settings.labels;
    stack.append(canvas, axis);
    options.container.replaceChildren(stack);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: AbortController | undefined;
    let pending: Viewport | undefined;
    let destroyed = false;

    const drawAxis = (layers: number, sampleRate: number): void => {
        axis.hidden = !settings.labels;
        if (!settings.labels) return;
        axis.style.height = `${bins * layers}px`;
        paintAxis(axis, {
            bins,
            layers,
            scale: settings.scale,
            frequencyMin: settings.frequencyMin ?? 0,
            frequencyMax: settings.frequencyMax ?? sampleRate / 2,
            ...(options.labelsColor ? { color: options.labelsColor } : {}),
            ...(options.labelsBackground ? { background: options.labelsBackground } : {})
        });
    };

    const run = async (viewport: Viewport): Promise<void> => {
        inFlight?.abort();
        const controller = new AbortController();
        inFlight = controller;
        const range = viewportFrames(viewport, options.sampleRate, options.totalFrames);
        if (range.frameCount < fftSize) return;
        try {
            const window = await options.read(
                range.fromFrame, range.frameCount, controller.signal, settings.splitChannels
            );
            if (destroyed || controller.signal.aborted) return;
            // Falls back to the downmix when the reader could not keep channels.
            const sources = settings.splitChannels && window.channels?.length
                ? window.channels
                : [window.samples];
            const analysis = {
                fftSize,
                hopSize: hopForColumns(window.samples.length, targetColumns, fftSize),
                bins,
                scale: settings.scale,
                ...(settings.frequencyMin !== undefined ? { frequencyMin: settings.frequencyMin } : {}),
                ...(settings.frequencyMax !== undefined ? { frequencyMax: settings.frequencyMax } : {}),
                ...(settings.windowFunc !== undefined ? { windowFunc: settings.windowFunc } : {}),
                ...(settings.alpha !== undefined ? { alpha: settings.alpha } : {}),
                ...(settings.gainDb !== undefined ? { gainDb: settings.gainDb } : {}),
                ...(settings.rangeDb !== undefined ? { rangeDb: settings.rangeDb } : {})
            };
            const layers = sources.map((channel) =>
                computeSpectrogram(channel, window.sampleRate, analysis));
            if (destroyed || controller.signal.aborted) return;
            canvas.style.height = `${bins * layers.length}px`;
            paintSpectrograms(canvas, layers, options.colorMap ?? RAMP);
            drawAxis(layers.length, window.sampleRate);
        } catch (error) {
            if (controller.signal.aborted || destroyed) return;
            options.onError?.(error as Error);
        }
    };

    let last: Viewport | undefined;
    const repaint = (): void => {
        const viewport = pending ?? last;
        if (viewport) { pending = viewport; schedule(); }
    };

    const schedule = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            const viewport = pending;
            pending = undefined;
            if (viewport && !destroyed) void run(viewport);
        }, SETTLE_MS);
    };

    return {
        show(viewport): void {
            if (destroyed) return;
            pending = viewport;
            last = viewport;
            schedule();
        },
        setScale(next): void {
            if (next === settings.scale) return;
            settings.scale = next;
            repaint();
        },
        setSettings(next): void {
            if (destroyed) return;
            let changed = false;
            for (const [key, value] of Object.entries(next) as Array<[
                keyof SpectrogramSettings, SpectrogramSettings[keyof SpectrogramSettings]
            ]>) {
                if (value === undefined || settings[key] === value) continue;
                Object.assign(settings, { [key]: value });
                changed = true;
            }
            if (changed) repaint();
        },
        destroy(): void {
            destroyed = true;
            if (timer !== undefined) clearTimeout(timer);
            inFlight?.abort();
            stack.remove();
        }
    };
}
