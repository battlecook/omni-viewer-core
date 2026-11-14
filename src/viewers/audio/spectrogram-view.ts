// Viewport-driven spectrogram: decodes the visible range, transforms it, and
// paints it. Replaces the engine plugin, which only ever works on a whole file
// and so costs seconds-to-forever on long audio.
//
// The work is bounded by the screen, not the track: one analysis window per
// pixel column, however much audio a column stands for. Zoomed out, the
// windows are sparse samples of the track; zoomed in, they overlap.
//
// Split from the DOM on purpose: `paintSpectrogram`, `viewportFrames` and
// `planColumns` are pure and tested, and the controller below is the only part
// that needs a canvas.

import {
    computeSpectrogram,
    frequencyAtFraction,
    type FrequencyScale,
    type Spectrogram,
    type SpectrogramOptions,
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

/**
 * Paints a batch of columns at `x` without touching the rest of the canvas, so
 * a viewport can fill in piece by piece instead of appearing all at once.
 */
export function paintColumnsAt(
    canvas: HTMLCanvasElement,
    layers: ReadonlyArray<{ columns: number; bins: number; data: Uint8Array }>,
    x: number,
    ramp: ColorRamp = RAMP
): void {
    const colors = ramp.length >= 2 ? ramp : RAMP;
    const first = layers[0];
    const columns = first?.columns ?? 0;
    const bins = first?.bins ?? 0;
    const context = canvas.getContext('2d');
    if (!context || columns === 0 || bins === 0) return;
    const height = bins * layers.length;
    const image = context.createImageData(columns, height);
    layers.forEach((layer, index) => {
        const top = index * bins;
        for (let column = 0; column < Math.min(columns, layer.columns); column++) {
            for (let row = 0; row < bins; row++) {
                const y = top + bins - 1 - row;
                colorFor(layer.data[column * bins + row]!, image.data, (y * columns + column) * 4, colors);
            }
        }
    });
    context.putImageData(image, x, 0);
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

/** Transforms a block of back-to-back analysis windows. Injected so the FFT can
 *  run in a worker; the default runs it in place. */
export type SpectrogramCompute = (
    samples: Float32Array,
    sampleRate: number,
    options: SpectrogramOptions
) => Promise<Spectrogram> | Spectrogram;

export interface SpectrogramViewOptions {
    container: HTMLElement;
    read: WindowReader;
    sampleRate: number;
    totalFrames: number;
    /** Rows of output; also the display height. */
    bins?: number;
    fftSize?: number;
    /** Most analysis columns to spend on one screen width. The view uses one
     *  per pixel up to this. */
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
    /** Where the FFT runs. Defaults to the calling thread. */
    compute?: SpectrogramCompute;
    onError?(error: Error): void;
}

export interface SpectrogramView {
    /** Moves the picture to a viewport at once and recomputes it once the
     *  viewport settles. Calls collapse: only the last one is computed. */
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
const DEFAULT_TARGET_COLUMNS = 1600;
const MIN_COLUMNS_PER_SCREEN = 200;
/** Scrolling fires continuously; recompute once it settles. */
const SETTLE_MS = 120;
/** Extra audio computed on each side, in screens, so a short scroll reveals
 *  finished picture instead of a gap. */
const OVERSCAN = 0.5;
/** Columns transformed per batch. Small enough that one batch is a few
 *  milliseconds of FFT, so painting is progressive and nothing blocks. */
const BATCH_COLUMNS = 64;
/** Gap between two windows, in windows, still read through as one span. */
const SPAN_GAP_WINDOWS = 4;
/** Longest the calling thread is held before yielding to the event loop. */
const SLICE_MS = 12;

export interface ColumnPlan {
    /** Analysis columns across the planned range. */
    columns: number;
    /** Frames each column stands for. Above the FFT size the windows are
     *  sparse samples of the track; below it they overlap. */
    hop: number;
    /** First frame of the planned range. */
    fromFrame: number;
    /** Frames the planned range covers. */
    frameCount: number;
}

/**
 * How many columns a viewport gets and where they sit.
 *
 * One column per pixel, whatever the track length — this is what keeps a
 * two-hour overview as cheap as a ten-second one. Returns undefined when the
 * range is too short to transform.
 */
export function planColumns(
    viewport: Viewport,
    sampleRate: number,
    totalFrames: number,
    fftSize: number,
    targetColumns = DEFAULT_TARGET_COLUMNS
): ColumnPlan | undefined {
    const range = viewportFrames(viewport, sampleRate, totalFrames, OVERSCAN);
    const visibleFrames = Math.max(0, viewport.visibleSeconds) * sampleRate;
    if (range.frameCount < fftSize || visibleFrames <= 0) return undefined;
    const perScreen = Math.max(
        MIN_COLUMNS_PER_SCREEN,
        Math.min(targetColumns, Math.round(viewport.width) || targetColumns)
    );
    const columns = Math.max(1, Math.round(perScreen * (range.frameCount / visibleFrames)));
    return { columns, hop: range.frameCount / columns, fromFrame: range.fromFrame, frameCount: range.frameCount };
}

/** First frame of a column's analysis window, centred on the column. May fall
 *  outside the track at either end; the missing samples read as silence. */
const windowStart = (plan: ColumnPlan, column: number, fftSize: number): number =>
    Math.round(plan.fromFrame + (column + 0.5) * plan.hop - fftSize / 2);

/** A finished or in-progress picture and the stretch of time it covers. */
interface Picture {
    canvas: HTMLCanvasElement;
    startSeconds: number;
    endSeconds: number;
}

/**
 * Keeps a canvas showing the spectrogram of whatever is on screen.
 *
 * Requests overlap constantly while a user drags, so each new one cancels the
 * last: without that, a drag queues a decode per frame and the tab crawls.
 * Until the new picture is complete the previous one stays underneath, moved
 * and stretched to the new viewport, so the pane tracks the waveform at once.
 */
export function createSpectrogramView(options: SpectrogramViewOptions): SpectrogramView {
    const bins = options.bins ?? DEFAULT_BINS;
    const fftSize = options.fftSize ?? DEFAULT_FFT_SIZE;
    const targetColumns = options.targetColumns ?? DEFAULT_TARGET_COLUMNS;
    const compute: SpectrogramCompute = options.compute ?? computeSpectrogram;
    const maxGap = fftSize * SPAN_GAP_WINDOWS;
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

    // Positioning is inline rather than left to the stylesheet: a picture in
    // the wrong place is a wrong picture, and that must not depend on whether
    // the host loaded the CSS.
    const stack = document.createElement('div');
    stack.className = 'omni-audio__spectrogram-stack';
    stack.style.position = 'relative';
    stack.style.overflow = 'hidden';
    stack.style.height = `${bins}px`;
    const axis = document.createElement('canvas');
    axis.className = 'omni-audio__spectrogram-axis';
    axis.hidden = !settings.labels;
    stack.append(axis);
    options.container.replaceChildren(stack);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: AbortController | undefined;
    let pending: Viewport | undefined;
    let last: Viewport | undefined;
    let destroyed = false;
    /** Oldest first; the last entry is the newest picture. */
    let pictures: Picture[] = [];

    const createCanvas = (columns: number, layers: number): HTMLCanvasElement => {
        const canvas = document.createElement('canvas');
        canvas.className = 'omni-audio__spectrogram-canvas';
        canvas.width = Math.max(1, columns);
        canvas.height = Math.max(1, bins * layers);
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.height = '100%';
        return canvas;
    };

    /** Places a picture where its stretch of time falls in the viewport. */
    const place = (picture: Picture, viewport: Viewport): void => {
        const visible = viewport.visibleSeconds;
        if (!(visible > 0)) return;
        const left = (picture.startSeconds - viewport.scrollSeconds) / visible;
        const width = (picture.endSeconds - picture.startSeconds) / visible;
        picture.canvas.style.left = `${left * 100}%`;
        picture.canvas.style.width = `${width * 100}%`;
    };

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

    /**
     * Samples for a batch of columns, as back-to-back windows per channel.
     *
     * Neighbouring windows that touch or nearly touch are read as one span, so
     * a zoomed-in batch is a single read while a zoomed-out one reads only the
     * slivers it transforms — never the long stretches in between. A short gap
     * is read through instead: for a compressed format every separate read
     * pays a decoder pre-roll longer than the gap it would skip.
     */
    const readBatch = async (
        plan: ColumnPlan,
        from: number,
        to: number,
        signal: AbortSignal
    ): Promise<{ layers: Float32Array[] | undefined; sampleRate: number }> => {
        const count = to - from;
        let layers: Float32Array[] | undefined;
        let sampleRate = options.sampleRate;
        let column = from;
        while (column < to) {
            // Grow the span while the next window starts inside or near it.
            let spanEnd = column + 1;
            const spanStart = windowStart(plan, column, fftSize);
            let spanStop = spanStart + fftSize;
            while (spanEnd < to && windowStart(plan, spanEnd, fftSize) <= spanStop + maxGap) {
                spanStop = windowStart(plan, spanEnd, fftSize) + fftSize;
                spanEnd++;
            }
            const readFrom = Math.max(0, spanStart);
            const readCount = Math.min(options.totalFrames, spanStop) - readFrom;
            if (readCount > 0) {
                const window = await options.read(readFrom, readCount, signal, settings.splitChannels);
                if (signal.aborted) throw new Error('spectrogram: aborted');
                // Nothing there (past the real end of the audio): leave silence,
                // and leave the channel count to a read that has samples.
                if (window.samples.length === 0) { column = spanEnd; continue; }
                sampleRate = window.sampleRate;
                // Falls back to the downmix when the reader could not keep channels.
                const sources = settings.splitChannels && window.channels?.length
                    ? window.channels
                    : [window.samples];
                layers ??= sources.map(() => new Float32Array(count * fftSize));
                for (let index = 0; index < layers.length; index++) {
                    const source = sources[index] ?? window.samples;
                    const target = layers[index]!;
                    for (let c = column; c < spanEnd; c++) {
                        // Offsets into the read; anything outside it stays zero.
                        const offset = windowStart(plan, c, fftSize) - window.startFrame;
                        const begin = Math.max(0, offset);
                        const end = Math.min(source.length, offset + fftSize);
                        if (end > begin) {
                            target.set(source.subarray(begin, end), (c - from) * fftSize + (begin - offset));
                        }
                    }
                }
            }
            column = spanEnd;
        }
        return { layers, sampleRate };
    };

    const run = async (viewport: Viewport): Promise<void> => {
        inFlight?.abort();
        const controller = new AbortController();
        inFlight = controller;
        const { signal } = controller;
        const plan = planColumns(viewport, options.sampleRate, options.totalFrames, fftSize, targetColumns);
        if (!plan) return;

        // Batches nearest the middle of the screen first: what the user is
        // looking at fills in before the overscan does.
        const centre = (viewport.scrollSeconds + viewport.visibleSeconds / 2) * options.sampleRate;
        const batches: Array<[number, number]> = [];
        for (let from = 0; from < plan.columns; from += BATCH_COLUMNS) {
            batches.push([from, Math.min(plan.columns, from + BATCH_COLUMNS)]);
        }
        const distance = ([from, to]: [number, number]): number =>
            Math.abs(plan.fromFrame + ((from + to) / 2) * plan.hop - centre);
        batches.sort((a, b) => distance(a) - distance(b));

        const analysis: SpectrogramOptions = {
            fftSize,
            // Windows arrive back to back, one per column.
            hopSize: fftSize,
            bins,
            scale: settings.scale,
            ...(settings.frequencyMin !== undefined ? { frequencyMin: settings.frequencyMin } : {}),
            ...(settings.frequencyMax !== undefined ? { frequencyMax: settings.frequencyMax } : {}),
            ...(settings.windowFunc !== undefined ? { windowFunc: settings.windowFunc } : {}),
            ...(settings.alpha !== undefined ? { alpha: settings.alpha } : {}),
            ...(settings.gainDb !== undefined ? { gainDb: settings.gainDb } : {}),
            ...(settings.rangeDb !== undefined ? { rangeDb: settings.rangeDb } : {})
        };

        let picture: Picture | undefined;
        let layerCount = 0;
        let sliceStart = Date.now();
        /** Batches with no audio behind them, painted as silence at the end —
         *  by then the channel count is known. */
        const silent: Array<[number, number]> = [];
        const begin = (layers: number, sampleRate: number): Picture => {
            layerCount = layers;
            const created: Picture = {
                canvas: createCanvas(plan.columns, layers),
                startSeconds: plan.fromFrame / options.sampleRate,
                endSeconds: (plan.fromFrame + plan.frameCount) / options.sampleRate
            };
            place(created, last ?? viewport);
            stack.style.height = `${bins * layers}px`;
            stack.insertBefore(created.canvas, axis);
            pictures.push(created);
            drawAxis(layers, sampleRate);
            return created;
        };
        try {
            for (const [from, to] of batches) {
                const batch = await readBatch(plan, from, to, signal);
                if (destroyed || signal.aborted) return;
                if (!batch.layers) { silent.push([from, to]); continue; }
                picture ??= begin(batch.layers.length, batch.sampleRate);
                const computed: Spectrogram[] = [];
                for (let index = 0; index < layerCount; index++) {
                    const samples = batch.layers[index] ?? batch.layers[0]!;
                    computed.push(await compute(samples, batch.sampleRate, analysis));
                    if (destroyed || signal.aborted) return;
                }
                paintColumnsAt(picture.canvas, computed, from, options.colorMap ?? RAMP);
                if (Date.now() - sliceStart >= SLICE_MS) {
                    await new Promise<void>((resolve) => setTimeout(resolve, 0));
                    if (destroyed || signal.aborted) return;
                    sliceStart = Date.now();
                }
            }
            picture ??= begin(1, options.sampleRate);
            for (const [from, to] of silent) {
                const blank = { columns: to - from, bins, data: new Uint8Array((to - from) * bins) };
                paintColumnsAt(picture.canvas, Array.from({ length: layerCount }, () => blank), from, options.colorMap ?? RAMP);
            }
            // Complete: the pictures it was drawn over are no longer needed.
            for (const old of pictures) if (old !== picture) old.canvas.remove();
            pictures = [picture];
        } catch (error) {
            if (signal.aborted || destroyed) return;
            options.onError?.(error as Error);
        } finally {
            // An abandoned picture is partial; drop it rather than leave holes
            // on top of the complete one beneath.
            if (signal.aborted && picture && pictures.length > 1) {
                picture.canvas.remove();
                pictures = pictures.filter((entry) => entry !== picture);
            }
        }
    };

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
            for (const picture of pictures) place(picture, viewport);
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
