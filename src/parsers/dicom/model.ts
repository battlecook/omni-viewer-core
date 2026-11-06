export interface DicomParseOptions {
    maxBytes?: number;
    maxElements?: number;
    maxDepth?: number;
    maxPixels?: number;
    maxFrames?: number;
    /** Required for raw datasets that do not use the default little-endian syntax. */
    transferSyntaxUid?: string;
}

export interface DicomElement {
    /** Uppercase group/element pair, e.g. 00100010. */
    tag: string;
    name: string;
    vr: string;
    depth: number;
    length: number;
    /** Bounded, display-only value; bulk binary data is never expanded. */
    value: string;
}

export interface DicomDiagnostic {
    messageKey: string;
    args?: Record<string, string | number>;
}

export interface DicomImage {
    rows: number;
    columns: number;
    frames: number;
    samplesPerPixel: number;
    photometricInterpretation: string;
    planarConfiguration: number;
    bitsAllocated: number;
    bitsStored: number;
    highBit: number;
    signed: boolean;
    slope: number;
    intercept: number;
    windowCenter: number | undefined;
    windowWidth: number | undefined;
    voiFunction: string;
    pixelSpacing: readonly number[];
    paddingValue: number | undefined;
    paddingRangeLimit: number | undefined;
}

export interface DicomDocument {
    hasPreamble: boolean;
    transferSyntaxUid: string;
    littleEndian: boolean;
    elements: DicomElement[];
    /** Top-level values only; nested sequences cannot overwrite image attributes. */
    values: Readonly<Record<string, string>>;
    image: DicomImage;
    /** Borrows the input bytes. Empty for missing or encapsulated Pixel Data. */
    pixelData: Uint8Array;
    previewIssue: DicomDiagnostic | undefined;
    diagnostics: DicomDiagnostic[];
}

export interface DicomFrame {
    width: number;
    height: number;
    /** Rescaled grayscale samples, or interleaved RGB samples. */
    pixels: Float32Array | Float64Array | Uint8ClampedArray;
    color: boolean;
    inverted: boolean;
    windowCenter: number;
    windowWidth: number;
    voiFunction: string;
}
