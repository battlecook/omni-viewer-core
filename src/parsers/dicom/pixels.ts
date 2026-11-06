import type { DicomDocument, DicomFrame } from './model.js';

/** Decode only the requested native frame; never allocate an entire volume. */
export function decodeDicomFrame(document: DicomDocument, frame = 0): DicomFrame {
    if (document.previewIssue) throw new Error(document.previewIssue.messageKey);
    const image = document.image;
    if (!Number.isInteger(frame) || frame < 0 || frame >= image.frames) throw new Error('DICOM frame index is out of range.');
    const count = image.rows * image.columns, color = image.samplesPerPixel === 3;
    const bytesPerSample = image.bitsAllocated / 8;
    const offset = frame * count * image.samplesPerPixel * bytesPerSample;
    const bytes = document.pixelData, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const wordSwapped = !document.littleEndian && document.elements.find(e => e.depth === 0 && e.tag === '7FE00010')?.vr === 'OW';
    const byteAt = (index: number) => bytes[wordSwapped ? index ^ 1 : index]!;
    if (color) {
        const pixels = new Uint8ClampedArray(count * 3);
        for (let p = 0; p < count; p++) {
            const at = (channel: number) => byteAt(offset + (image.planarConfiguration === 1 ? channel * count + p : p * 3 + channel));
            const a = at(0), b = at(1), c = at(2);
            if (image.photometricInterpretation === 'YBR_FULL') {
                pixels[p * 3] = a + 1.402 * (c - 128);
                pixels[p * 3 + 1] = a - .344136 * (b - 128) - .714136 * (c - 128);
                pixels[p * 3 + 2] = a + 1.772 * (b - 128);
            } else { pixels[p * 3] = a; pixels[p * 3 + 1] = b; pixels[p * 3 + 2] = c; }
        }
        return { width: image.columns, height: image.rows, pixels, color: true, inverted: false, windowCenter: 128, windowWidth: 256, voiFunction: 'LINEAR' };
    }
    const pixels = new Float64Array(count), shift = image.highBit + 1 - image.bitsStored;
    const range = 2 ** image.bitsStored, mask = range - 1, sign = range / 2;
    const paddingMin = Math.min(image.paddingValue ?? NaN, image.paddingRangeLimit ?? image.paddingValue ?? NaN);
    const paddingMax = Math.max(image.paddingValue ?? NaN, image.paddingRangeLimit ?? image.paddingValue ?? NaN);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < count; i++) {
        const raw = bytesPerSample === 1 ? byteAt(offset + i) : view.getUint16(offset + i * 2, document.littleEndian);
        let sample = (raw >>> shift) & mask;
        if (image.signed && sample >= sign) sample -= range;
        const value = sample * image.slope + image.intercept;
        if (!Number.isFinite(value) || Math.abs(value) > 3.4028234663852886e38) throw new Error('DICOM rescaled pixel value is out of range.');
        pixels[i] = value;
        if (!(sample >= paddingMin && sample <= paddingMax)) { min = Math.min(min, value); max = Math.max(max, value); }
    }
    if (!Number.isFinite(min)) min = max = 0;
    const voiFunction = ['LINEAR', 'LINEAR_EXACT', 'SIGMOID'].includes(image.voiFunction) ? image.voiFunction : 'LINEAR';
    const validWindow = image.windowCenter !== undefined && image.windowWidth !== undefined && image.windowWidth >= (voiFunction === 'LINEAR' ? 1 : Number.MIN_VALUE);
    return {
        width: image.columns, height: image.rows, pixels, color: false, inverted: image.photometricInterpretation === 'MONOCHROME1',
        windowCenter: validWindow ? image.windowCenter! : (min + max + 1) / 2,
        windowWidth: validWindow ? image.windowWidth! : Math.max(1, max - min + 1),
        voiFunction: validWindow ? voiFunction : 'LINEAR'
    };
}

/** PS3.3 C.11.2 windowing, followed by MONOCHROME1 / user inversion. */
export function renderDicomFrame(frame: DicomFrame, options: { windowCenter?: number; windowWidth?: number; invert?: boolean } = {}): Uint8ClampedArray {
    const center = options.windowCenter ?? frame.windowCenter, width = options.windowWidth ?? frame.windowWidth;
    if (!Number.isFinite(center) || !Number.isFinite(width) || width <= 0 || (frame.voiFunction === 'LINEAR' && width < 1)) throw new Error('Invalid DICOM window center or width.');
    const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);
    const invert = frame.inverted !== (options.invert ?? false);
    for (let i = 0; i < frame.width * frame.height; i++) {
        for (let c = 0; c < 3; c++) {
            const sample = frame.pixels[frame.color ? i * 3 + c : i]!;
            const level = frame.color ? sample : frame.voiFunction === 'SIGMOID' ? 255 / (1 + Math.exp(-4 * (sample - center) / width))
                : frame.voiFunction === 'LINEAR_EXACT' ? ((sample - center) / width + .5) * 255
                : width === 1 ? sample <= center - .5 ? 0 : 255
                : ((sample - (center - .5)) / (width - 1) + .5) * 255;
            const bounded = Math.max(0, Math.min(255, level));
            rgba[i * 4 + c] = invert ? 255 - bounded : bounded;
        }
        rgba[i * 4 + 3] = 255;
    }
    return rgba;
}
