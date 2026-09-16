// Spectrogram computation, DOM-free and decoder-free.
//
// Ported from `native/audio-engine/audio_engine.c` (`generate_spectrogram`),
// which in turn replicates the WaveSurfer plugin's pipeline: Hann window →
// FFT → frequency-scale filter bank → dB → 8-bit colour index. Keeping the
// same pipeline means the windowed renderer looks like the whole-file one it
// replaces.
//
// The point of doing it here rather than in the plugin is the input: this takes
// *a window of samples*, so cost follows the viewport instead of the file. A
// two-hour track costs the same as a ten-second one.

export type FrequencyScale = 'linear' | 'logarithmic' | 'mel' | 'bark' | 'erb';

/** Analysis windows, matching the engine plugin's set. */
export type WindowFunction =
    | 'bartlett' | 'bartlettHann' | 'blackman' | 'cosine' | 'gauss'
    | 'hamming' | 'hann' | 'lanczoz' | 'rectangular' | 'triangular';

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

/** Window coefficients. `alpha` is only consulted by blackman and gauss. */
export function windowCoefficients(
    size: number,
    kind: WindowFunction = 'hann',
    alpha?: number
): Float32Array {
    const out = new Float32Array(size);
    const last = size - 1;
    for (let i = 0; i < size; i++) {
        switch (kind) {
            case 'rectangular': out[i] = 1; break;
            case 'hann': out[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / last)); break;
            case 'hamming': out[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / last); break;
            case 'bartlett': out[i] = (2 / last) * (last / 2 - Math.abs(i - last / 2)); break;
            case 'triangular': out[i] = (2 / size) * (size / 2 - Math.abs(i - last / 2)); break;
            case 'bartlettHann':
                out[i] = 0.62 - 0.48 * Math.abs(i / last - 0.5) - 0.38 * Math.cos((2 * Math.PI * i) / last);
                break;
            case 'blackman': {
                const a = alpha ?? 0.16;
                out[i] = (1 - a) / 2
                    - 0.5 * Math.cos((2 * Math.PI * i) / last)
                    + (a / 2) * Math.cos((4 * Math.PI * i) / last);
                break;
            }
            case 'cosine': out[i] = Math.cos((i * Math.PI) / last - Math.PI / 2); break;
            case 'gauss': {
                const a = alpha ?? 0.25;
                out[i] = Math.exp(-0.5 * ((i - last / 2) / ((a * last) / 2)) ** 2);
                break;
            }
            case 'lanczoz': out[i] = sinc((2 * i) / last - 1); break;
        }
    }
    return out;
}

export interface SpectrogramOptions {
    /** Samples per analysis window; must be a power of two. */
    fftSize?: number;
    /** Samples advanced between windows. Defaults to `fftSize / 4`. */
    hopSize?: number;
    /** Output rows. Defaults to `fftSize / 2`. */
    bins?: number;
    scale?: FrequencyScale;
    /** Lowest frequency drawn, in Hz. */
    frequencyMin?: number;
    /** Highest frequency drawn, in Hz. Defaults to Nyquist. Narrowing this is
     *  the direct answer to a spectrogram whose content all sits at the bottom. */
    frequencyMax?: number;
    windowFunc?: WindowFunction;
    /** Extra shape parameter for blackman and gauss. */
    alpha?: number;
    /** Headroom below full scale, in dB, at which a bin reaches full
     *  intensity: the white point sits at `-gainDb` dBFS. Default 20, which
     *  is the convention the WaveSurfer plugin uses — raising it brightens. */
    gainDb?: number;
    /** dB span below the white point that maps onto 0..255. */
    rangeDb?: number;
}

export interface Spectrogram {
    /** Number of analysis windows. */
    columns: number;
    /** Rows per column, low frequency first. */
    bins: number;
    /** Column-major 8-bit intensities, `columns * bins` long. */
    data: Uint8Array;
}

const DEFAULT_FFT_SIZE = 1024;
const DEFAULT_GAIN_DB = 20;
const DEFAULT_RANGE_DB = 80;
/** Floor for the log: silence would otherwise be -Infinity dB. */
const MIN_MAGNITUDE = 1e-12;

// Scale conversions, matching the plugin's own set.
const toMel = (hz: number): number => 2595 * Math.log10(1 + hz / 700);
const fromMel = (mel: number): number => 700 * (10 ** (mel / 2595) - 1);
const toBark = (hz: number): number => {
    let bark = (26.81 * hz) / (1960 + hz) - 0.53;
    if (bark < 2) bark += 0.15 * (2 - bark);
    if (bark > 20.1) bark += 0.22 * (bark - 20.1);
    return bark;
};
const fromBark = (bark: number): number => {
    let value = bark;
    if (value < 2) value = (value - 0.3) / 0.85;
    if (value > 20.1) value = (value + 4.422) / 1.22;
    return ((value + 0.53) / (26.28 - value)) * 1960;
};
const toLog = (hz: number): number => Math.log10(Math.max(1, hz));
const fromLog = (value: number): number => 10 ** value;
const ERB_SCALE = (1000 * Math.LN10) / 107.939;
const toErb = (hz: number): number => ERB_SCALE * Math.log10(1 + 0.00437 * hz);
const fromErb = (erb: number): number => (10 ** (erb / ERB_SCALE) - 1) / 0.00437;

const forward = (scale: FrequencyScale): (hz: number) => number =>
    scale === 'mel' ? toMel : scale === 'bark' ? toBark : scale === 'erb' ? toErb
        : scale === 'logarithmic' ? toLog : (hz) => hz;
const inverse = (scale: FrequencyScale): (value: number) => number =>
    scale === 'mel' ? fromMel : scale === 'bark' ? fromBark : scale === 'erb' ? fromErb
        : scale === 'logarithmic' ? fromLog : (value) => value;

/**
 * Frequency at a fraction of the height, 0 at the bottom.
 *
 * The axis is only readable with labels on it, and the labels have to follow
 * whichever scale drew the picture — evenly spaced rows are far from evenly
 * spaced hertz on mel or log.
 */
export function frequencyAtFraction(
    fraction: number,
    scale: FrequencyScale,
    minHz: number,
    maxHz: number
): number {
    const toScale = forward(scale);
    const fromScale = inverse(scale);
    const low = toScale(Math.max(0, minHz));
    const high = toScale(Math.max(minHz, maxHz));
    return fromScale(low + Math.min(1, Math.max(0, fraction)) * (high - low));
}

/** In-place radix-2 FFT. Tables are precomputed per size and reused. */
function createFft(size: number): (real: Float32Array, imag: Float32Array) => void {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error(`spectrogram: fftSize must be a power of two, got ${size}`);
    const levels = Math.log2(size);
    const cos = new Float32Array(size / 2);
    const sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
        cos[i] = Math.cos((2 * Math.PI * i) / size);
        sin[i] = Math.sin((2 * Math.PI * i) / size);
    }
    // Bit-reversal permutation, precomputed so the hot loop stays arithmetic.
    const reversed = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
        let bits = 0;
        for (let bit = 0; bit < levels; bit++) bits = (bits << 1) | ((i >>> bit) & 1);
        reversed[i] = bits;
    }

    return (real, imag) => {
        for (let i = 0; i < size; i++) {
            const j = reversed[i]!;
            if (j > i) {
                let swap = real[i]!; real[i] = real[j]!; real[j] = swap;
                swap = imag[i]!; imag[i] = imag[j]!; imag[j] = swap;
            }
        }
        for (let span = 2; span <= size; span *= 2) {
            const half = span / 2;
            const step = size / span;
            for (let start = 0; start < size; start += span) {
                for (let i = start, k = 0; i < start + half; i++, k += step) {
                    const pair = i + half;
                    const tre = real[pair]! * cos[k]! + imag[pair]! * sin[k]!;
                    const tim = -real[pair]! * sin[k]! + imag[pair]! * cos[k]!;
                    real[pair] = real[i]! - tre; imag[pair] = imag[i]! - tim;
                    real[i] = real[i]! + tre; imag[i] = imag[i]! + tim;
                }
            }
        }
    };
}

interface Filter { lo: number; weightLo: number; weightHi: number }

/** Where each output row samples the linear FFT bins, with the interpolation
 *  weights between the two neighbours. */
function filterBank(
    bins: number,
    fftSize: number,
    sampleRate: number,
    scale: FrequencyScale,
    minHz: number,
    maxHz: number
): Filter[] {
    const toScale = forward(scale);
    const fromScale = inverse(scale);
    const nyquist = sampleRate / 2;
    const low = toScale(Math.max(0, Math.min(minHz, nyquist)));
    const high = toScale(Math.max(low, Math.min(maxHz, nyquist)));
    const hzPerBin = sampleRate / fftSize;
    const bank: Filter[] = new Array(bins);
    for (let row = 0; row < bins; row++) {
        const centerHz = fromScale(low + (row / bins) * (high - low));
        const exact = centerHz / hzPerBin;
        const lo = Math.floor(exact);
        const frac = exact - lo;
        bank[row] = { lo, weightLo: 1 - frac, weightHi: frac };
    }
    return bank;
}

/**
 * Intensities for one window of interleaved-free mono samples.
 *
 * Channels are the caller's business: pass a single channel, or a downmix.
 * Columns run left to right in time, rows low to high in frequency.
 */
export function computeSpectrogram(
    samples: Float32Array,
    sampleRate: number,
    options: SpectrogramOptions = {}
): Spectrogram {
    const fftSize = options.fftSize ?? DEFAULT_FFT_SIZE;
    const hopSize = options.hopSize ?? Math.max(1, Math.floor(fftSize / 4));
    const bins = options.bins ?? fftSize / 2;
    const scale = options.scale ?? 'mel';
    const gainDb = options.gainDb ?? DEFAULT_GAIN_DB;
    const rangeDb = options.rangeDb ?? DEFAULT_RANGE_DB;
    if (hopSize < 1) throw new Error('spectrogram: hopSize must be >= 1');
    if (bins < 1) throw new Error('spectrogram: bins must be >= 1');
    if (rangeDb <= 0) throw new Error('spectrogram: rangeDb must be > 0');

    const fft = createFft(fftSize);
    const columns = samples.length >= fftSize
        ? Math.floor((samples.length - fftSize) / hopSize) + 1
        : 0;
    const data = new Uint8Array(Math.max(0, columns) * bins);
    if (columns <= 0) return { columns: 0, bins, data };

    const window = windowCoefficients(fftSize, options.windowFunc ?? 'hann', options.alpha);

    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);
    const halfBins = fftSize / 2;
    const magnitudes = new Float32Array(halfBins);
    const bank = filterBank(
        bins, fftSize, sampleRate, scale,
        options.frequencyMin ?? 0,
        options.frequencyMax ?? sampleRate / 2
    );
    const norm = 2 / fftSize;
    // White point sits `gainDb` below full scale and `rangeDb` more reaches
    // black. This is the WaveSurfer plugin's convention (it maps with a white
    // point of `-gainDB`); taking `gainDb` as an absolute ceiling instead put
    // the floor 40 dB higher and rendered ordinary material almost entirely
    // black.
    const whiteDb = -gainDb;
    const floorDb = whiteDb - rangeDb;

    for (let column = 0; column < columns; column++) {
        const offset = column * hopSize;
        for (let i = 0; i < fftSize; i++) {
            real[i] = samples[offset + i]! * window[i]!;
            imag[i] = 0;
        }
        fft(real, imag);
        for (let bin = 0; bin < halfBins; bin++) {
            const re = real[bin]!;
            const im = imag[bin]!;
            magnitudes[bin] = norm * Math.sqrt(re * re + im * im);
        }
        const base = column * bins;
        for (let row = 0; row < bins; row++) {
            const { lo, weightLo, weightHi } = bank[row]!;
            const hi = lo + 1;
            let magnitude: number;
            if (lo >= halfBins) magnitude = MIN_MAGNITUDE;
            else if (hi >= halfBins) magnitude = magnitudes[lo]! * weightLo;
            else magnitude = magnitudes[lo]! * weightLo + magnitudes[hi]! * weightHi;
            if (magnitude < MIN_MAGNITUDE) magnitude = MIN_MAGNITUDE;
            const db = 20 * Math.log10(magnitude);
            data[base + row] = db <= floorDb ? 0
                : db >= whiteDb ? 255
                : Math.round(((db - floorDb) / rangeDb) * 255);
        }
    }
    return { columns, bins, data };
}

/**
 * Hop that spreads `sampleCount` over roughly `targetColumns`, clamped so a
 * window always overlaps its neighbour and never degenerates. This is what
 * keeps the cost tied to the canvas rather than the file.
 */
export function hopForColumns(sampleCount: number, targetColumns: number, fftSize: number): number {
    if (targetColumns < 1) return fftSize;
    const ideal = Math.floor(sampleCount / targetColumns);
    return Math.max(1, Math.min(fftSize, ideal));
}
