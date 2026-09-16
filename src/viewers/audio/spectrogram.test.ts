import { describe, expect, it } from 'vitest';
import {
    computeSpectrogram,
    hopForColumns,
    windowCoefficients,
    type FrequencyScale,
    type WindowFunction
} from './spectrogram.js';

const SAMPLE_RATE = 44100;

/** Full-scale sine at `hz`. */
function tone(hz: number, samples: number, rate = SAMPLE_RATE): Float32Array {
    const out = new Float32Array(samples);
    for (let i = 0; i < samples; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate);
    return out;
}

/** Row holding the most energy in a column. */
function loudestRow(data: Uint8Array, bins: number, column: number): number {
    let best = 0;
    let bestValue = -1;
    for (let row = 0; row < bins; row++) {
        const value = data[column * bins + row]!;
        if (value > bestValue) { bestValue = value; best = row; }
    }
    return best;
}

describe('spectrogram', () => {
    it('puts a pure tone in one place and leaves the rest dark', () => {
        const result = computeSpectrogram(tone(1000, 8192), SAMPLE_RATE, { fftSize: 1024, scale: 'linear' });
        expect(result.columns).toBeGreaterThan(0);
        expect(result.bins).toBe(512);

        const row = loudestRow(result.data, result.bins, 2);
        // Linear scale: row ≈ hz / (rate / 2) * bins = 1000 / 22050 * 512 ≈ 23.
        expect(row).toBeGreaterThan(19);
        expect(row).toBeLessThan(28);

        // Far from the tone the bins should be at the floor.
        const far = result.data[2 * result.bins + 400]!;
        expect(far).toBe(0);
    });

    it('tracks the tone upward as its frequency rises', () => {
        const rows = [500, 2000, 8000].map((hz) => {
            const result = computeSpectrogram(tone(hz, 8192), SAMPLE_RATE, { fftSize: 1024, scale: 'linear' });
            return loudestRow(result.data, result.bins, 2);
        });
        expect(rows[0]!).toBeLessThan(rows[1]!);
        expect(rows[1]!).toBeLessThan(rows[2]!);
    });

    // Perceptual scales stretch the low end, so the same tone sits higher up
    // the axis than it would on a linear one.
    it('places a low tone higher on a perceptual scale than on a linear one', () => {
        const at = (scale: FrequencyScale): number => {
            const result = computeSpectrogram(tone(500, 8192), SAMPLE_RATE, { fftSize: 1024, scale });
            return loudestRow(result.data, result.bins, 2);
        };
        const linear = at('linear');
        for (const scale of ['mel', 'bark', 'erb'] as const) {
            expect(at(scale), scale).toBeGreaterThan(linear);
        }
    });

    it('reports silence as zero everywhere', () => {
        const result = computeSpectrogram(new Float32Array(4096), SAMPLE_RATE, { fftSize: 1024 });
        expect(result.columns).toBeGreaterThan(0);
        expect(result.data.every((value) => value === 0)).toBe(true);
    });

    it('derives the column count from the hop', () => {
        const samples = tone(1000, 4096);
        const wide = computeSpectrogram(samples, SAMPLE_RATE, { fftSize: 1024, hopSize: 1024 });
        const dense = computeSpectrogram(samples, SAMPLE_RATE, { fftSize: 1024, hopSize: 256 });
        expect(wide.columns).toBe(4);   // (4096 - 1024) / 1024 + 1
        expect(dense.columns).toBe(13); // (4096 - 1024) / 256 + 1
        expect(dense.data.length).toBe(13 * dense.bins);
    });

    it('returns nothing for a window shorter than the FFT', () => {
        const result = computeSpectrogram(new Float32Array(100), SAMPLE_RATE, { fftSize: 1024 });
        expect(result).toMatchObject({ columns: 0, bins: 512 });
        expect(result.data).toHaveLength(0);
    });

    it('honours a reduced bin count', () => {
        const result = computeSpectrogram(tone(1000, 4096), SAMPLE_RATE, { fftSize: 1024, bins: 64 });
        expect(result.bins).toBe(64);
        expect(result.data).toHaveLength(result.columns * 64);
    });

    // The white point sits `gainDb` *below* full scale (the plugin's
    // convention), so anything loud saturates and the interesting detail is in
    // the quiet end — which is where a spectrogram is actually read.
    it('maps level onto intensity with the white point below full scale', () => {
        const peakOf = (gain: number): number => {
            const samples = tone(1000, 4096);
            for (let i = 0; i < samples.length; i++) samples[i]! *= gain;
            const result = computeSpectrogram(samples, SAMPLE_RATE, { fftSize: 1024, scale: 'linear' });
            return result.data[2 * result.bins + loudestRow(result.data, result.bins, 2)]!;
        };
        const veryQuiet = peakOf(0.0005);  // about -72 dBFS
        const quiet = peakOf(0.01);        // about -46 dBFS
        const fullScale = peakOf(1);

        expect(veryQuiet).toBeLessThan(quiet);
        expect(quiet).toBeGreaterThan(120);
        expect(quiet).toBeLessThan(220);
        // At and above the white point everything is saturated.
        expect(fullScale).toBe(255);
        expect(peakOf(50)).toBe(255);
        // Below the floor (white - rangeDb = -100 dBFS) nothing is drawn.
        expect(peakOf(1e-6)).toBe(0);
    });

    it('rejects an FFT size that is not a power of two', () => {
        expect(() => computeSpectrogram(tone(1000, 4096), SAMPLE_RATE, { fftSize: 1000 }))
            .toThrow(/power of two/);
    });

    // The cost of a window must not depend on how long the file is — that is
    // the whole reason this exists.
    it('costs the same for a window regardless of the source length', () => {
        const window = tone(1000, 1 << 16);
        const columns = computeSpectrogram(window, SAMPLE_RATE, {
            fftSize: 1024,
            hopSize: hopForColumns(window.length, 2000, 1024)
        }).columns;
        expect(columns).toBeGreaterThan(1500);
        expect(columns).toBeLessThanOrEqual(2100);
    });
});

describe('frequency range', () => {
    // A spectrogram of voice or music over a 22 kHz axis leaves everything
    // squashed against the bottom; narrowing the range is the direct fix.
    it('spreads a narrowed range over the full height', () => {
        const full = computeSpectrogram(tone(1000, 8192), SAMPLE_RATE, { fftSize: 1024, scale: 'linear' });
        const zoomed = computeSpectrogram(tone(1000, 8192), SAMPLE_RATE, {
            fftSize: 1024, scale: 'linear', frequencyMax: 2000
        });
        expect(loudestRow(zoomed.data, zoomed.bins, 2))
            .toBeGreaterThan(loudestRow(full.data, full.bins, 2) * 5);
    });

    it('drops content outside the range', () => {
        const result = computeSpectrogram(tone(8000, 8192), SAMPLE_RATE, {
            fftSize: 1024, scale: 'linear', frequencyMax: 2000
        });
        // The tone sits above the ceiling, so every row should be near the floor.
        const column = result.data.slice(2 * result.bins, 3 * result.bins);
        expect(Math.max(...column)).toBeLessThan(60);
    });

    it('honours a raised floor', () => {
        const result = computeSpectrogram(tone(4000, 8192), SAMPLE_RATE, {
            fftSize: 1024, scale: 'linear', frequencyMin: 2000, frequencyMax: 6000
        });
        const row = loudestRow(result.data, result.bins, 2);
        // 4 kHz is the midpoint of 2–6 kHz.
        expect(row / result.bins).toBeGreaterThan(0.35);
        expect(row / result.bins).toBeLessThan(0.65);
    });
});

describe('window functions', () => {
    it('produces the documented shapes', () => {
        expect([...windowCoefficients(8, 'rectangular')]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
        // An odd length puts the peak exactly on a sample, so it reaches 1.
        const hann = windowCoefficients(9, 'hann');
        expect(hann[0]).toBeCloseTo(0, 6);
        expect(hann[8]).toBeCloseTo(0, 6);
        expect(hann[4]).toBeCloseTo(1, 6);
        // Hamming does not reach zero at the edges; that is what distinguishes it.
        expect(windowCoefficients(8, 'hamming')[0]).toBeCloseTo(0.08, 4);
    });

    it('covers every kind without producing NaN', () => {
        const kinds: WindowFunction[] = [
            'bartlett', 'bartlettHann', 'blackman', 'cosine', 'gauss',
            'hamming', 'hann', 'lanczoz', 'rectangular', 'triangular'
        ];
        for (const kind of kinds) {
            const coefficients = windowCoefficients(64, kind);
            expect(coefficients.every((value) => Number.isFinite(value)), kind).toBe(true);
        }
    });

    it('lets alpha reshape blackman and gauss', () => {
        expect(windowCoefficients(64, 'gauss', 0.1)[10])
            .not.toBeCloseTo(windowCoefficients(64, 'gauss', 0.5)[10]!, 3);
        expect(windowCoefficients(64, 'blackman', 0.05)[10])
            .not.toBeCloseTo(windowCoefficients(64, 'blackman', 0.5)[10]!, 3);
    });

    it('still finds the tone whichever window is used', () => {
        const hann = computeSpectrogram(tone(2000, 8192), SAMPLE_RATE, { fftSize: 1024, scale: 'linear' });
        const blackman = computeSpectrogram(tone(2000, 8192), SAMPLE_RATE, {
            fftSize: 1024, scale: 'linear', windowFunc: 'blackman'
        });
        expect(Math.abs(
            loudestRow(hann.data, hann.bins, 2) - loudestRow(blackman.data, blackman.bins, 2)
        )).toBeLessThanOrEqual(2);
    });
});

describe('logarithmic scale', () => {
    it('places tones in rising order', () => {
        const rows = [200, 1000, 8000].map((hz) => {
            const result = computeSpectrogram(tone(hz, 8192), SAMPLE_RATE, {
                fftSize: 1024, scale: 'logarithmic'
            });
            return loudestRow(result.data, result.bins, 2);
        });
        expect(rows[0]!).toBeLessThan(rows[1]!);
        expect(rows[1]!).toBeLessThan(rows[2]!);
    });
});

describe('hop for a target column count', () => {
    it('spreads the window over roughly the requested columns', () => {
        expect(hopForColumns(1_000_000, 2000, 1024)).toBe(500);
        expect(hopForColumns(2_000_000, 2000, 1024)).toBe(1000);
    });

    it('never exceeds the FFT size, so windows keep overlapping the signal', () => {
        expect(hopForColumns(100_000_000, 2000, 1024)).toBe(1024);
    });

    it('never drops below one sample', () => {
        expect(hopForColumns(10, 2000, 1024)).toBe(1);
        expect(hopForColumns(1000, 0, 1024)).toBe(1024);
    });
});
