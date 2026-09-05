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

/** Random-access source used to inspect a safetensors file without loading its payload. */
export interface SafetensorsSource {
    /** Complete file size in bytes. */
    readonly size: number;
    /** Reads up to `length` bytes at the absolute `offset`. */
    read(offset: number, length: number, signal?: AbortSignal): Uint8Array | Promise<Uint8Array>;
}

export interface SafetensorsSourceParseOptions {
    fileSize?: string;
    signal?: AbortSignal;
}

/** One tensor as declared in the safetensors header. */
export interface SafetensorsTensor {
    /**
     * Display form of the declared name: a name longer than the viewer's budget
     * is elided in the middle, so this is not guaranteed to round-trip back to
     * the header. Real tensor names are far below the budget and pass through.
     */
    name: string;
    /** Display form of the declared dtype, elided on the same budget as `name`. */
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
 * "__metadata__" string map), followed by the raw tensor buffer. Use
 * {@link parseSafetensorsSource} for large files: it reads only the 8-byte length
 * prefix and JSON header. {@link parseSafetensors} remains the compatibility API
 * for callers that already have the complete file in memory.
 *
 * Reference: https://github.com/huggingface/safetensors
 */

const HEADER_LENGTH_BYTES = 8;
// A safetensors header is JSON metadata only; real files stay well under this.
// The cap guards against a corrupt length field claiming gigabytes of "header".
// It matches MAX_HEADER_SIZE in the reference implementation.
const MAX_HEADER_BYTES = 100_000_000;
// What this viewer will actually parse. The spec bound above is far past
// anything a real model produces (a 50,000-tensor model's header is a few MB),
// and `JSON.parse` on a header near it costs seconds on the host's UI thread —
// measured at 16 s for a 95 MB header — with no way to stream or interrupt it.
// Such a file is refused with an explanation instead of freezing the tab.
const MAX_PARSED_HEADER_BYTES = 16_000_000;
const METADATA_KEY = '__metadata__';
// The largest real models declare a few thousand tensors. The cap is two
// orders of magnitude above that, and exists because everything past this
// point — a row per tensor, the sort, the preview text — is synchronous work
// on the host's UI thread. A header claiming millions of entries is hostile,
// not a model, and must not be able to freeze the tab that opened it.
const MAX_TENSOR_ENTRIES = 50_000;
// The entry cap alone bounds row count, not size: one entry may carry a
// megabytes-long name, and every name is held three times over (the tensor
// record, the table cell, the structure preview). Real names run tens of
// characters, so these budgets are invisible to any genuine model.
const MAX_TENSOR_NAME_CHARS = 512;
const MAX_PREVIEW_CHARS = 1_000_000;
// `shape` is only validated element-wise, so its length is attacker-chosen too,
// and the rendered text expands roughly 2x over its JSON source.
const MAX_SHAPE_DIMS = 32;
// The "Data types" card is one line of text; a hostile header can declare a
// distinct dtype per tensor.
const MAX_SUMMARY_DTYPES = 32;
// `__metadata__` is a free-form string map, and a row per entry is the same
// UI-thread hazard as a row per tensor. Real models carry a handful of keys.
const MAX_METADATA_ENTRIES = 10_000;

/**
 * Bits per element for the dtypes supported by safetensors 0.8.
 *
 * Null-prototype on purpose: `dtype` is attacker-controlled text out of the
 * file, and a plain object literal would resolve `"constructor"` or
 * `"toString"` to an inherited function instead of `undefined`, which then
 * blew up in `BigInt()` and made the whole file unviewable.
 */
const DTYPE_BITS: Record<string, number> = Object.assign(
    Object.create(null) as Record<string, number>,
    {
        F64: 64, C64: 64, I64: 64, U64: 64,
        F32: 32, I32: 32, U32: 32,
        F16: 16, BF16: 16, I16: 16, U16: 16,
        I8: 8, U8: 8, BOOL: 8,
        F8_E4M3: 8, F8_E5M2: 8, F8_E8M0: 8,
        F8_E4M3FNUZ: 8, F8_E5M2FNUZ: 8,
        F6_E2M3: 6, F6_E3M2: 6, F4: 4
    }
);

interface RawTensorEntry {
    dtype?: unknown;
    shape?: unknown;
    data_offsets?: unknown;
}

export function parseSafetensors(
    input: Uint8Array,
    fileSize = formatFileSize(input.byteLength)
): SafetensorsDocument {
    return parseSafetensorsHeader(input, input.byteLength, fileSize);
}

/**
 * Reads and parses only the safetensors header from a random-access source.
 * The tensor payload range is validated against `source.size` but never read.
 */
export async function parseSafetensorsSource(
    source: SafetensorsSource,
    options: SafetensorsSourceParseOptions = {}
): Promise<SafetensorsDocument> {
    const fileSize = options.fileSize ?? formatFileSize(source.size);
    if (!Number.isSafeInteger(source.size) || source.size < 0) {
        return invalid(fileSize, 'File size is out of range.');
    }

    throwIfAborted(options.signal);
    const prefix = await source.read(0, HEADER_LENGTH_BYTES, options.signal);
    throwIfAborted(options.signal);
    if (prefix.byteLength < HEADER_LENGTH_BYTES) {
        return invalid(fileSize, 'File is too small to contain a safetensors header.');
    }

    const headerLength = readHeaderLength(prefix);
    const lengthIssue = validateHeaderLength(headerLength);
    if (lengthIssue) return invalid(fileSize, lengthIssue);

    const headerEnd = HEADER_LENGTH_BYTES + headerLength;
    if (headerEnd > source.size) {
        return invalid(fileSize, 'Declared header length extends past the end of the file.');
    }

    const jsonHeader = await source.read(HEADER_LENGTH_BYTES, headerLength, options.signal);
    throwIfAborted(options.signal);
    if (jsonHeader.byteLength < headerLength) {
        return invalid(fileSize, 'The complete safetensors header could not be read.');
    }

    const headerBytes = new Uint8Array(headerEnd);
    headerBytes.set(prefix.subarray(0, HEADER_LENGTH_BYTES));
    headerBytes.set(jsonHeader.subarray(0, headerLength), HEADER_LENGTH_BYTES);
    return parseSafetensorsHeader(headerBytes, source.size, fileSize);
}

/**
 * Parses bytes containing the 8-byte length prefix and complete JSON header.
 * `totalFileBytes` is the size of the original file and is used to validate
 * tensor offsets without requiring tensor payload bytes in `input`.
 */
export function parseSafetensorsHeader(
    input: Uint8Array,
    totalFileBytes: number,
    fileSize = formatFileSize(totalFileBytes)
): SafetensorsDocument {
    const warnings: string[] = [];

    if (input.byteLength < HEADER_LENGTH_BYTES) {
        return invalid(fileSize, 'File is too small to contain a safetensors header.');
    }

    if (!Number.isSafeInteger(totalFileBytes) || totalFileBytes < 0) {
        return invalid(fileSize, 'File size is out of range.');
    }

    const headerLength = readHeaderLength(input);
    const lengthIssue = validateHeaderLength(headerLength);
    if (lengthIssue) return invalid(fileSize, lengthIssue);
    const headerEnd = HEADER_LENGTH_BYTES + headerLength;
    if (headerEnd > totalFileBytes) {
        return invalid(fileSize, 'Declared header length extends past the end of the file.');
    }
    if (headerEnd > input.byteLength) {
        return invalid(fileSize, 'The complete safetensors header could not be read.');
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

    let textTruncated = false;
    let shapeTruncated = false;

    /**
     * Elided in the middle, not the tail: long tensor names differ by their
     * suffix (`...layers.31.mlp.down_proj.weight`), so cutting the end would
     * render distinct tensors as identical rows. Both cuts back off a lone
     * surrogate — tensor names carry CJK and emoji often enough that a blind
     * code-unit slice would leave a replacement glyph in the table.
     */
    const clamp = (value: string): string => {
        if (value.length <= MAX_TENSOR_NAME_CHARS) return value;
        textTruncated = true;
        let head = value.slice(0, Math.ceil((MAX_TENSOR_NAME_CHARS - 1) / 2));
        let tail = value.slice(value.length - (MAX_TENSOR_NAME_CHARS - 1 - head.length));
        if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
        if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
        return `${head}…${tail}`;
    };

    /**
     * Shortened by whole dimensions only. Running the character clamp over a
     * `' × '`-joined list would splice one dimension into another and print a
     * number the shape never declared.
     */
    const shapeLabel = (shape: readonly number[]): string => {
        if (!shape.length) return 'scalar';
        let shown = Math.min(shape.length, MAX_SHAPE_DIMS);
        let text = shape.slice(0, shown).join(' × ');
        while (shown > 1 && text.length > MAX_TENSOR_NAME_CHARS) {
            shown -= 1;
            text = shape.slice(0, shown).join(' × ');
        }
        if (shown === shape.length) return text;
        shapeTruncated = true;
        return `${text} × …`;
    };

    // Null-prototype: a `__proto__` key out of the file would otherwise hit
    // Object.prototype's setter and be silently dropped instead of listed.
    const metadata = Object.create(null) as Record<string, string>;
    const rawMeta = header[METADATA_KEY];
    let metadataIssue = false;
    // Counted separately from the entries the header declares: non-string
    // values are reported by `metadataIssue` and never occupy a slot, so
    // counting them here would claim truncation on a map that fit in full.
    let metadataKept = 0;
    let metadataDropped = 0;
    if (rawMeta !== undefined) {
        if (rawMeta !== null && typeof rawMeta === 'object' && !Array.isArray(rawMeta)) {
            const rawMetaMap = rawMeta as Record<string, unknown>;
            for (const key in rawMetaMap) {
                if (typeof rawMetaMap[key] !== 'string') {
                    metadataIssue = true;
                } else if (metadataKept < MAX_METADATA_ENTRIES) {
                    metadata[clamp(key)] = clamp(rawMetaMap[key] as string);
                    metadataKept += 1;
                } else {
                    metadataDropped += 1;
                }
            }
        } else {
            metadataIssue = true;
        }
    }
    // Counted after clamping, not from `metadataKept`: two keys longer than the
    // clamp that differ only in their middle collapse onto one row, and a title
    // disagreeing with the rows under it is the divergence the display strings
    // exist to prevent. Bounded by the cap, so the key walk is free.
    const metadataCount = Object.keys(metadata).length;
    if (metadataDropped) {
        warnings.push(
            `This header declares ${metadataKept + metadataDropped} "__metadata__" entries; only the first ${MAX_METADATA_ENTRIES} are listed.`
        );
    }
    if (metadataIssue) warnings.push('Some "__metadata__" values are not strings and were ignored.');

    const dataBufferSize = totalFileBytes - headerEnd;
    // `shapeText` lives on the record so the table and the preview cannot
    // diverge, and so clamping happens before the warnings are assembled.
    // `name` and `dtype` are already their display form by the time they land
    // here, so they need no second copy.
    interface TensorRow extends SafetensorsTensor { shapeText: string }
    const tensors: TensorRow[] = [];
    const dtypeCounts = new Map<string, number>();
    let totalElements = 0;
    let unknownDtype = false;
    let entryIssue = false;
    let rangeIssue = false;
    const validRanges: Array<[number, number]> = [];

    // Counted with `for...in` rather than `Object.entries().filter().slice()`:
    // a hostile header can declare a million entries, and materializing a pair
    // array per entry (twice) costs more than everything the cap was added to
    // avoid. `__metadata__` is not a tensor, so it must not consume a slot —
    // counting it would drop one real tensor and claim truncation on a file
    // that fit.
    let declaredEntries = 0;
    const entryNames: string[] = [];
    for (const name in header) {
        if (name === METADATA_KEY) continue;
        declaredEntries += 1;
        if (entryNames.length < MAX_TENSOR_ENTRIES) entryNames.push(name);
    }
    const overflowed = declaredEntries > MAX_TENSOR_ENTRIES;

    for (const name of entryNames) {
        const entry = header[name] as RawTensorEntry | null;
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

        const dtypeLabel = clamp(dtype);
        tensors.push({
            name: clamp(name), dtype: dtypeLabel, shape, dataOffsets: [begin, end],
            elements: elementCount, byteLength,
            shapeText: shapeLabel(shape)
        });
        totalElements += elementCount;
        dtypeCounts.set(dtypeLabel, (dtypeCounts.get(dtypeLabel) ?? 0) + 1);

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
        // Two tensors claiming the same bytes is a contradiction in any subset
        // of the list, so overlap is caught even when the list was truncated.
        // Holes and the EOF total only mean something once every entry has
        // been read — a truncated list is guaranteed to leave both.
        if (begin < coveredUntil || (!overflowed && begin !== coveredUntil)) rangeIssue = true;
        coveredUntil = Math.max(coveredUntil, end);
    }
    if (!overflowed && coveredUntil !== dataBufferSize) rangeIssue = true;

    if (overflowed) {
        warnings.push(
            `This header declares ${declaredEntries} entries; only the first ${MAX_TENSOR_ENTRIES} are listed.`
        );
    }
    if (textTruncated) warnings.push('Some names or metadata values were too long to show in full and were shortened.');
    if (shapeTruncated) warnings.push('Some tensor shapes have too many dimensions to show in full.');
    if (entryIssue) warnings.push('Some tensor entries have an invalid dtype, shape, or data offset declaration.');
    if (unknownDtype) warnings.push('Some tensors use a dtype this viewer does not recognize.');
    if (rangeIssue) warnings.push('Some tensor byte ranges are inconsistent with their dtype and shape.');

    const dtypeList = [...dtypeCounts.keys()].sort();
    const dtypeSummary = dtypeList.length
        ? dtypeList.slice(0, MAX_SUMMARY_DTYPES).join(', ')
            + (dtypeList.length > MAX_SUMMARY_DTYPES ? `, +${dtypeList.length - MAX_SUMMARY_DTYPES} more` : '')
        : '—';
    const summary: SafetensorsSummaryItem[] = [
        { label: 'Tensors', value: tensors.length },
        { label: 'Parameters', value: formatCount(totalElements) },
        { label: 'Data types', value: dtypeSummary }
    ];
    if (metadataCount) {
        summary.push({ label: 'Metadata keys', value: metadataCount });
    }

    const tables: SafetensorsTable[] = [
        {
            title: `Tensors (${tensors.length})`,
            headers: ['Name', 'Dtype', 'Shape', 'Parameters', 'Size'],
            rows: tensors.map(tensor => [
                tensor.name,
                tensor.dtype,
                tensor.shapeText,
                tensor.elements,
                formatFileSize(tensor.byteLength)
            ])
        }
    ];
    if (metadataCount) {
        tables.push({
            title: `Metadata (${metadataCount})`,
            headers: ['Key', 'Value'],
            rows: Object.entries(metadata).map(([key, value]) => [key, value])
        });
    }

    // Built under a budget rather than mapped-and-joined: the preview is a
    // second full copy of every name, and it is the largest single string the
    // host is handed.
    let preview = '';
    let previewTruncated = false;
    for (const tensor of tensors) {
        if (preview.length >= MAX_PREVIEW_CHARS) {
            previewTruncated = true;
            break;
        }
        preview += `${preview ? '\n' : ''}${tensor.name}  [${tensor.shapeText}]  ${tensor.dtype}`;
    }
    if (previewTruncated) preview += '\n…';
    const rawPreview = tensors.length ? preview : undefined;

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

function readHeaderLength(input: Uint8Array): number {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    return Number(view.getBigUint64(0, true));
}

function validateHeaderLength(headerLength: number): string | undefined {
    if (!Number.isSafeInteger(headerLength) || headerLength <= 0 || headerLength > MAX_HEADER_BYTES) {
        return 'Header length is out of range; the file is not a valid safetensors file.';
    }
    // Reported separately from the range error: such a file is well-formed,
    // it is only too large for this viewer to open.
    if (headerLength > MAX_PARSED_HEADER_BYTES) {
        return `This header is ${formatFileSize(headerLength)}, which is too large to display.`;
    }
    return undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
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
