export interface SafetensorsSummaryItem {
    label: string;
    value: string | number;
}

export interface SafetensorsTable {
    title: string;
    headers: string[];
    rows: Array<Array<string | number>>;
}

export interface SafetensorsDocument {
    format: 'safetensors';
    title: string;
    fileSize: string;
    summary: SafetensorsSummaryItem[];
    tables: SafetensorsTable[];
    rawPreview?: string | undefined;
    warnings: string[];
}

/** One tensor as declared in the safetensors header. */
export interface SafetensorsTensor {
    name: string;
    dtype: string;
    shape: number[];
    /** [begin, end) byte range inside the tensor data buffer. */
    dataOffsets: [number, number];
    /** Product of `shape` (1 for a scalar / empty shape). */
    elements: number;
    /** `end - begin`, the bytes the tensor occupies. */
    byteLength: number;
}

/**
 * Minimal safetensors (.safetensors) header reader.
 *
 * The format is a fixed 8-byte little-endian header length, followed by a UTF-8
 * JSON header (tensor name → {dtype, shape, data_offsets}, plus an optional
 * "__metadata__" string map), followed by the raw tensor buffer. Only the header
 * is decoded here — the tensor payloads are never read, so inspecting a
 * multi-gigabyte checkpoint stays cheap.
 *
 * Reference: https://github.com/huggingface/safetensors
 */

const HEADER_LENGTH_BYTES = 8;
// A safetensors header is JSON metadata only; real files stay well under this.
// The cap guards against a corrupt length field claiming gigabytes of "header".
const MAX_HEADER_BYTES = 100_000_000;
const METADATA_KEY = '__metadata__';

/** Bits per element for the dtypes supported by safetensors 0.8. */
const DTYPE_BITS: Record<string, number> = {
    F64: 64, C64: 64, I64: 64, U64: 64,
    F32: 32, I32: 32, U32: 32,
    F16: 16, BF16: 16, I16: 16, U16: 16,
    I8: 8, U8: 8, BOOL: 8,
    F8_E4M3: 8, F8_E5M2: 8, F8_E8M0: 8,
    F8_E4M3FNUZ: 8, F8_E5M2FNUZ: 8,
    F6_E2M3: 6, F6_E3M2: 6, F4: 4
};

interface RawTensorEntry {
    dtype?: unknown;
    shape?: unknown;
    data_offsets?: unknown;
}

export function parseSafetensors(
    input: Uint8Array,
    fileSize = formatFileSize(input.byteLength)
): SafetensorsDocument {
    const warnings: string[] = [];

    if (input.byteLength < HEADER_LENGTH_BYTES) {
        return invalid(fileSize, 'File is too small to contain a safetensors header.');
    }

    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const headerLength = Number(view.getBigUint64(0, true));

    if (!Number.isSafeInteger(headerLength) || headerLength <= 0 || headerLength > MAX_HEADER_BYTES) {
        return invalid(fileSize, 'Header length is out of range; the file is not a valid safetensors file.');
    }
    const headerEnd = HEADER_LENGTH_BYTES + headerLength;
    if (headerEnd > input.byteLength) {
        return invalid(fileSize, 'Declared header length extends past the end of the file.');
    }

    const headerBytes = input.subarray(HEADER_LENGTH_BYTES, headerEnd);
    if (headerBytes[0] !== 0x7b) {
        return invalid(fileSize, 'The safetensors header must begin with a JSON object.');
    }

    let header: Record<string, unknown>;
    try {
        const json = new TextDecoder('utf-8', { fatal: true }).decode(headerBytes);
        const parsed = JSON.parse(json) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return invalid(fileSize, 'The safetensors header is not a JSON object.');
        }
        header = parsed as Record<string, unknown>;
    } catch {
        return invalid(fileSize, 'The safetensors header is not valid JSON.');
    }

    const metadata: Record<string, string> = {};
    const rawMeta = header[METADATA_KEY];
    let metadataIssue = false;
    if (rawMeta !== undefined) {
        if (rawMeta !== null && typeof rawMeta === 'object' && !Array.isArray(rawMeta)) {
            for (const [key, value] of Object.entries(rawMeta as Record<string, unknown>)) {
                if (typeof value === 'string') metadata[key] = value;
                else metadataIssue = true;
            }
        } else {
            metadataIssue = true;
        }
    }
    if (metadataIssue) warnings.push('Some "__metadata__" values are not strings and were ignored.');

    const dataBufferSize = input.byteLength - headerEnd;
    const tensors: SafetensorsTensor[] = [];
    const dtypeCounts = new Map<string, number>();
    let totalElements = 0;
    let unknownDtype = false;
    let entryIssue = false;
    let rangeIssue = false;
    const validRanges: Array<[number, number]> = [];

    for (const [name, rawValue] of Object.entries(header)) {
        if (name === METADATA_KEY) continue;
        const entry = rawValue as RawTensorEntry | null;
        const dtypeValid = typeof entry?.dtype === 'string';
        const dtype = dtypeValid ? entry.dtype as string : 'unknown';
        const shapeValid = Array.isArray(entry?.shape)
            && entry.shape.every(n => Number.isSafeInteger(n) && (n as number) >= 0);
        const shape = shapeValid ? entry!.shape as number[] : [];
        const offsets = Array.isArray(entry?.data_offsets) ? entry.data_offsets : [];
        const offsetsValid = offsets.length === 2
            && offsets.every(n => Number.isSafeInteger(n) && (n as number) >= 0);
        const begin = offsetsValid ? offsets[0] as number : 0;
        const end = offsetsValid ? offsets[1] as number : 0;
        if (!dtypeValid || !shapeValid || !offsetsValid) entryIssue = true;

        const elements = safeElementCount(shape);
        if (elements === undefined) entryIssue = true;
        const elementCount = elements ?? 0;
        const byteLength = Math.max(0, end - begin);

        tensors.push({ name, dtype, shape, dataOffsets: [begin, end], elements: elementCount, byteLength });
        totalElements += elementCount;
        dtypeCounts.set(dtype, (dtypeCounts.get(dtype) ?? 0) + 1);

        const bits = DTYPE_BITS[dtype];
        if (bits === undefined) {
            unknownDtype = true;
        } else if (elements !== undefined) {
            const expectedBits = BigInt(elements) * BigInt(bits);
            if (expectedBits % 8n !== 0n || expectedBits / 8n !== BigInt(byteLength)) rangeIssue = true;
        }
        if (!offsetsValid || end < begin || end > dataBufferSize) {
            rangeIssue = true;
        } else {
            validRanges.push([begin, end]);
        }
    }

    // Header keys have no defined order; sort tensors by their data offset so the
    // table reads in storage order.
    tensors.sort((a, b) => a.dataOffsets[0] - b.dataOffsets[0] || a.dataOffsets[1] - b.dataOffsets[1]);

    // A valid safetensors data buffer is packed from byte zero to EOF without
    // holes or overlaps. Empty tensors may repeat the current offset.
    validRanges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let coveredUntil = 0;
    for (const [begin, end] of validRanges) {
        if (begin !== coveredUntil) rangeIssue = true;
        coveredUntil = Math.max(coveredUntil, end);
    }
    if (coveredUntil !== dataBufferSize) rangeIssue = true;

    if (entryIssue) warnings.push('Some tensor entries have an invalid dtype, shape, or data offset declaration.');
    if (unknownDtype) warnings.push('Some tensors use a dtype this viewer does not recognize.');
    if (rangeIssue) warnings.push('Some tensor byte ranges are inconsistent with their dtype and shape.');

    const dtypeList = [...dtypeCounts.keys()].sort();
    const summary: SafetensorsSummaryItem[] = [
        { label: 'Tensors', value: tensors.length },
        { label: 'Parameters', value: formatCount(totalElements) },
        { label: 'Data types', value: dtypeList.length ? dtypeList.join(', ') : '—' }
    ];
    if (Object.keys(metadata).length) {
        summary.push({ label: 'Metadata keys', value: Object.keys(metadata).length });
    }

    const tables: SafetensorsTable[] = [
        {
            title: `Tensors (${tensors.length})`,
            headers: ['Name', 'Dtype', 'Shape', 'Parameters', 'Size'],
            rows: tensors.map(tensor => [
                tensor.name,
                tensor.dtype,
                tensor.shape.length ? tensor.shape.join(' × ') : 'scalar',
                tensor.elements,
                formatFileSize(tensor.byteLength)
            ])
        }
    ];
    if (Object.keys(metadata).length) {
        tables.push({
            title: `Metadata (${Object.keys(metadata).length})`,
            headers: ['Key', 'Value'],
            rows: Object.entries(metadata).map(([key, value]) => [key, value])
        });
    }

    const rawPreview = tensors.length
        ? tensors
            .map(tensor => `${tensor.name}  [${tensor.shape.length ? tensor.shape.join(' × ') : 'scalar'}]  ${tensor.dtype}`)
            .join('\n')
        : undefined;

    return {
        format: 'safetensors',
        title: 'Safetensors tensor collection',
        fileSize,
        summary,
        tables,
        rawPreview,
        warnings
    };
}

function safeElementCount(shape: readonly number[]): number | undefined {
    let count = 1;
    for (const dimension of shape) {
        if (!Number.isSafeInteger(dimension) || dimension < 0) return undefined;
        if (dimension !== 0 && count > Number.MAX_SAFE_INTEGER / dimension) return undefined;
        count *= dimension;
    }
    return count;
}

function invalid(fileSize: string, message: string): SafetensorsDocument {
    return {
        format: 'safetensors',
        title: 'Safetensors tensor collection',
        fileSize,
        summary: [{ label: 'Status', value: 'invalid' }],
        tables: [],
        rawPreview: undefined,
        warnings: [message]
    };
}

/** Compact parameter counts, e.g. 1.20B, 350.0M, 12.3K. */
export function formatCount(count: number): string {
    if (count < 1000) return String(count);
    const units: Array<[number, string]> = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [threshold, suffix] of units) {
        if (count >= threshold) {
            const value = count / threshold;
            return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2) + suffix;
        }
    }
    return String(count);
}

export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return String(bytes) + ' bytes';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = units[0]!;
    for (let i = 1; i < units.length && value >= 1024; i++) {
        value /= 1024;
        unit = units[i]!;
    }
    return value.toFixed(value >= 10 ? 1 : 2) + ' ' + unit;
}
