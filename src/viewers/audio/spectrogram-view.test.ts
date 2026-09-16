// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_COLOR_MAP,
    createSpectrogramView,
    paintAxis,
    paintSpectrogram,
    paintSpectrograms,
    viewportFrames
} from './spectrogram-view.js';
import type { AudioWindow } from './audio-window.js';

const RATE = 44100;

describe('viewport to frames', () => {
    // One screen of padding either side, so a small scroll lands on audio that
    // is already decoded.
    it('pads the visible range by a screen on each side', () => {
        const range = viewportFrames(
            { scrollSeconds: 100, visibleSeconds: 10, width: 1000 }, RATE, RATE * 600
        );
        expect(range.fromFrame).toBe(90 * RATE);
        expect(range.frameCount).toBe(30 * RATE);
    });

    it('clamps at the head of the track', () => {
        const range = viewportFrames(
            { scrollSeconds: 2, visibleSeconds: 10, width: 1000 }, RATE, RATE * 600
        );
        expect(range.fromFrame).toBe(0);
    });

    it('clamps at the tail of the track', () => {
        const total = RATE * 100;
        const range = viewportFrames(
            { scrollSeconds: 95, visibleSeconds: 10, width: 1000 }, RATE, total
        );
        expect(range.fromFrame + range.frameCount).toBeLessThanOrEqual(total);
    });

    // The property the whole design rests on.
    it('asks for the same amount however long the track is', () => {
        const viewport = { scrollSeconds: 30, visibleSeconds: 10, width: 1000 };
        const short = viewportFrames(viewport, RATE, RATE * 120);
        const long = viewportFrames(viewport, RATE, RATE * 60 * 120);
        expect(long.frameCount).toBe(short.frameCount);
    });

    it('asks for nothing when nothing is visible', () => {
        expect(viewportFrames({ scrollSeconds: 0, visibleSeconds: 0, width: 0 }, RATE, RATE).frameCount)
            .toBe(0);
    });
});

describe('painting', () => {
    it('sizes the canvas to the analysis and draws low frequencies at the base', () => {
        const columns = 4;
        const bins = 3;
        const data = new Uint8Array(columns * bins);
        // Row 0 (lowest frequency) is bright, the rest dark.
        for (let column = 0; column < columns; column++) data[column * bins] = 255;

        const canvas = document.createElement('canvas');
        const painted = paintSpectrogram(canvas, { columns, bins, data });
        expect(painted).toEqual({ columns, bins });
        expect(canvas.width).toBe(columns);
        expect(canvas.height).toBe(bins);

        const context = canvas.getContext('2d');
        if (!context) return; // jsdom without canvas support
        const bottom = context.getImageData(0, bins - 1, 1, 1).data;
        const top = context.getImageData(0, 0, 1, 1).data;
        expect(bottom[2]).toBeGreaterThan(top[2]!);
    });

    // Most of a spectrogram is silence. Painting it any colour but near-black
    // turns the whole pane into a flat field with the signal lost inside it.
    it('paints silence black and loud bins bright', () => {
        const columns = 2;
        const bins = 2;
        const data = new Uint8Array([0, 0, 255, 255]); // first column silent
        const canvas = document.createElement('canvas');
        paintSpectrogram(canvas, { columns, bins, data });

        const context = canvas.getContext('2d');
        if (!context) return; // jsdom without canvas support
        const silent = context.getImageData(0, 0, 1, 1).data;
        const loud = context.getImageData(1, 0, 1, 1).data;
        expect(Math.max(silent[0]!, silent[1]!, silent[2]!)).toBeLessThanOrEqual(2);
        expect(silent[3]).toBe(255);
        expect(loud[0]! + loud[1]! + loud[2]!).toBeGreaterThan(600);
    });

    it('survives an empty analysis', () => {
        const canvas = document.createElement('canvas');
        expect(paintSpectrogram(canvas, { columns: 0, bins: 250, data: new Uint8Array(0) }))
            .toEqual({ columns: 0, bins: 250 });
    });
});

describe('spectrogram view', () => {
    const tone = (frames: number): AudioWindow => {
        const samples = new Float32Array(frames);
        for (let i = 0; i < frames; i++) samples[i] = Math.sin(i / 7) * 0.7;
        return { samples, sampleRate: RATE, startFrame: 0 };
    };

    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250));

    it('decodes and paints the visible range', async () => {
        const container = document.createElement('div');
        const read = vi.fn(async (_from: number, count: number) => tone(count));
        const view = createSpectrogramView({
            container, read, sampleRate: RATE, totalFrames: RATE * 600, bins: 32
        });
        view.show({ scrollSeconds: 0, visibleSeconds: 2, width: 800 });
        await settle();

        expect(read).toHaveBeenCalledOnce();
        const canvas = container.querySelector('canvas') as HTMLCanvasElement;
        expect(canvas.height).toBe(32);
        expect(canvas.width).toBeGreaterThan(1);
        view.destroy();
    });

    // Dragging fires continuously; queueing a decode per event is what makes a
    // viewport-driven renderer worse than the thing it replaces.
    it('collapses a burst of viewports into one decode', async () => {
        const container = document.createElement('div');
        const read = vi.fn(async (_from: number, count: number) => tone(count));
        const view = createSpectrogramView({
            container, read, sampleRate: RATE, totalFrames: RATE * 600, bins: 32
        });
        for (let i = 0; i < 20; i++) view.show({ scrollSeconds: i, visibleSeconds: 2, width: 800 });
        await settle();

        expect(read).toHaveBeenCalledOnce();
        // The last viewport wins.
        expect(read.mock.calls[0]![0]).toBe(Math.floor((19 - 2) * RATE));
        view.destroy();
    });

    it('skips a range too short to transform', async () => {
        const container = document.createElement('div');
        const read = vi.fn(async (_from: number, count: number) => tone(count));
        const view = createSpectrogramView({
            container, read, sampleRate: RATE, totalFrames: 500, bins: 32
        });
        view.show({ scrollSeconds: 0, visibleSeconds: 0.001, width: 800 });
        await settle();
        expect(read).not.toHaveBeenCalled();
        view.destroy();
    });

    it('reports a read failure instead of throwing into the void', async () => {
        const container = document.createElement('div');
        const errors: Error[] = [];
        const view = createSpectrogramView({
            container,
            read: async () => { throw new Error('decode exploded'); },
            sampleRate: RATE, totalFrames: RATE * 600, bins: 32,
            onError: (error) => errors.push(error)
        });
        view.show({ scrollSeconds: 0, visibleSeconds: 2, width: 800 });
        await settle();
        expect(errors.map((e) => e.message)).toEqual(['decode exploded']);
        view.destroy();
    });

    it('does no work after destroy', async () => {
        const container = document.createElement('div');
        const read = vi.fn(async (_from: number, count: number) => tone(count));
        const view = createSpectrogramView({
            container, read, sampleRate: RATE, totalFrames: RATE * 600, bins: 32
        });
        view.show({ scrollSeconds: 0, visibleSeconds: 2, width: 800 });
        view.destroy();
        await settle();
        expect(read).not.toHaveBeenCalled();
        expect(container.querySelector('canvas')).toBeNull();
    });
});

describe('stacked channels', () => {
    const layer = (columns: number, bins: number, value: number) => ({
        columns, bins, data: new Uint8Array(columns * bins).fill(value)
    });

    it('gives each channel its own band, in order', () => {
        const canvas = document.createElement('canvas');
        const painted = paintSpectrograms(canvas, [layer(4, 3, 255), layer(4, 3, 0)]);
        expect(painted).toEqual({ columns: 4, bins: 3 });
        expect(canvas.height).toBe(6);
        expect(canvas.width).toBe(4);

        const context = canvas.getContext('2d');
        if (!context) return; // jsdom without canvas support
        const first = context.getImageData(0, 1, 1, 1).data;
        const second = context.getImageData(0, 4, 1, 1).data;
        expect(first[0]! + first[1]! + first[2]!).toBeGreaterThan(600);
        expect(Math.max(second[0]!, second[1]!, second[2]!)).toBeLessThanOrEqual(2);
    });

    it('paints a single channel exactly as before', () => {
        const canvas = document.createElement('canvas');
        paintSpectrogram(canvas, layer(4, 3, 255));
        expect(canvas.height).toBe(3);
    });
});

describe('frequency axis', () => {
    const axisCanvas = () => document.createElement('canvas');

    it('spans the requested range, low to high', () => {
        const marks = paintAxis(axisCanvas(), {
            bins: 200, layers: 1, scale: 'linear', frequencyMin: 0, frequencyMax: 22050
        });
        expect(marks[0]).toBeCloseTo(0, 6);
        expect(marks.at(-1)).toBeCloseTo(22050, 6);
        expect(marks.length).toBeGreaterThan(2);
        // Evenly spaced on a linear scale.
        expect(marks[1]! - marks[0]!).toBeCloseTo(marks[2]! - marks[1]!, 3);
    });

    // The labels have to follow the scale that drew the picture, or they point
    // at the wrong rows.
    it('bunches the low end on a mel scale', () => {
        const marks = paintAxis(axisCanvas(), {
            bins: 200, layers: 1, scale: 'mel', frequencyMin: 0, frequencyMax: 22050
        });
        expect(marks[1]! - marks[0]!).toBeLessThan(marks.at(-1)! - marks.at(-2)!);
    });

    it('honours a narrowed range', () => {
        const marks = paintAxis(axisCanvas(), {
            bins: 200, layers: 1, scale: 'linear', frequencyMin: 1000, frequencyMax: 4000
        });
        expect(marks[0]).toBeCloseTo(1000, 6);
        expect(marks.at(-1)).toBeCloseTo(4000, 6);
    });

    it('sizes itself for every stacked channel', () => {
        const canvas = axisCanvas();
        paintAxis(canvas, {
            bins: 100, layers: 2, scale: 'linear', frequencyMin: 0, frequencyMax: 22050
        });
        expect(canvas.height).toBe(200);
    });
});

describe('spectrogram view settings', () => {
    const stereo = (frames: number): AudioWindow => {
        const samples = new Float32Array(frames);
        const left = new Float32Array(frames);
        const right = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
            left[i] = Math.sin(i / 7) * 0.7;
            right[i] = Math.sin(i / 30) * 0.7;
            samples[i] = (left[i]! + right[i]!) / 2;
        }
        return { samples, channels: [left, right], sampleRate: RATE, startFrame: 0 };
    };
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250));

    it('asks for channels and stacks them only when splitting', async () => {
        const container = document.createElement('div');
        const read = vi.fn(async (
            _from: number, count: number, _signal?: AbortSignal, _keep?: boolean
        ) => stereo(count));
        const view = createSpectrogramView({
            container, read, sampleRate: RATE, totalFrames: RATE * 600, bins: 32,
            splitChannels: true
        });
        view.show({ scrollSeconds: 0, visibleSeconds: 2, width: 800 });
        await settle();

        expect(read.mock.calls[0]![3]).toBe(true);
        const canvas = container.querySelector('canvas') as HTMLCanvasElement;
        expect(canvas.height).toBe(64); // two bands of 32
        view.destroy();
    });

    it('falls back to the downmix when the reader cannot split', async () => {
        const container = document.createElement('div');
        const read = vi.fn(async (_from: number, count: number) => {
            const window = stereo(count);
            return { samples: window.samples, sampleRate: RATE, startFrame: 0 };
        });
        const view = createSpectrogramView({
            container, read, sampleRate: RATE, totalFrames: RATE * 600, bins: 32,
            splitChannels: true
        });
        view.show({ scrollSeconds: 0, visibleSeconds: 2, width: 800 });
        await settle();
        expect((container.querySelector('canvas') as HTMLCanvasElement).height).toBe(32);
        view.destroy();
    });

    it('repaints when a setting changes, without another show', async () => {
        const container = document.createElement('div');
        const read = vi.fn(async (
            _from: number, count: number, _signal?: AbortSignal, _keep?: boolean
        ) => stereo(count));
        const view = createSpectrogramView({
            container, read, sampleRate: RATE, totalFrames: RATE * 600, bins: 32
        });
        view.show({ scrollSeconds: 0, visibleSeconds: 2, width: 800 });
        await settle();
        expect(read).toHaveBeenCalledOnce();

        view.setSettings({ frequencyMax: 4000, windowFunc: 'blackman' });
        await settle();
        expect(read).toHaveBeenCalledTimes(2);
        view.destroy();
    });

    it('ignores a setting that did not change', async () => {
        const container = document.createElement('div');
        const read = vi.fn(async (
            _from: number, count: number, _signal?: AbortSignal, _keep?: boolean
        ) => stereo(count));
        const view = createSpectrogramView({
            container, read, sampleRate: RATE, totalFrames: RATE * 600, bins: 32, scale: 'mel'
        });
        view.show({ scrollSeconds: 0, visibleSeconds: 2, width: 800 });
        await settle();

        view.setSettings({ scale: 'mel' });
        view.setScale('mel');
        await settle();
        expect(read).toHaveBeenCalledOnce();
        view.destroy();
    });

    it('draws the axis only when labels are on', async () => {
        const container = document.createElement('div');
        const read = vi.fn(async (
            _from: number, count: number, _signal?: AbortSignal, _keep?: boolean
        ) => stereo(count));
        const view = createSpectrogramView({
            container, read, sampleRate: RATE, totalFrames: RATE * 600, bins: 32
        });
        view.show({ scrollSeconds: 0, visibleSeconds: 2, width: 800 });
        await settle();
        const axis = container.querySelector('.omni-audio__spectrogram-axis') as HTMLCanvasElement;
        expect(axis.hidden).toBe(true);

        view.setSettings({ labels: true });
        await settle();
        expect(axis.hidden).toBe(false);
        view.destroy();
    });
});

describe('colour ramp', () => {
    // The map the WaveSurfer plugin draws with. A viewer that used to run the
    // plugin has to keep looking the same, and midtones are most of that: a
    // two-stop ramp renders a noise floor as a black field.
    it('defaults to the plugin\'s roseus map', () => {
        expect(DEFAULT_COLOR_MAP).toHaveLength(256);
        expect(DEFAULT_COLOR_MAP[0]).toEqual([1, 1, 1]);
        expect(DEFAULT_COLOR_MAP[64]).toEqual([55, 37, 134]);
        expect(DEFAULT_COLOR_MAP[128]).toEqual([195, 40, 132]);
        expect(DEFAULT_COLOR_MAP[192]).toEqual([252, 148, 73]);
        expect(DEFAULT_COLOR_MAP[255]).toEqual([254, 251, 249]);
    });

    const layer = (value: number) => ({ columns: 1, bins: 1, data: Uint8Array.of(value) });
    const pixel = (canvas: HTMLCanvasElement): number[] | null => {
        const context = canvas.getContext('2d');
        if (!context) return null; // jsdom without canvas support
        const data = context.getImageData(0, 0, 1, 1).data;
        return [data[0]!, data[1]!, data[2]!];
    };

    it('uses the supplied stops', () => {
        const canvas = document.createElement('canvas');
        paintSpectrogram(canvas, layer(255), [[0, 0, 0], [200, 30, 30]]);
        expect(pixel(canvas) ?? [200, 30, 30]).toEqual([200, 30, 30]);
    });

    it('falls back to the default ramp when given too few stops', () => {
        const canvas = document.createElement('canvas');
        paintSpectrogram(canvas, layer(255), [[200, 30, 30]]);
        expect(pixel(canvas) ?? [255, 255, 255]).toEqual([255, 255, 255]);
    });
});
