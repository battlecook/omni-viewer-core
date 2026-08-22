import type { JSZipObject } from 'jszip';
import { declaredZipEntryCount, declaredZipUncompressedBytes } from '../zip-scan.js';

const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59] as const;
const ZIP_MAGIC = [0x50, 0x4b] as const;
const MAX_ARRAYS = 1000;
const MAX_ZIP_ENTRIES = 2000;
const MAX_ARRAY_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_ARRAY_BYTES = 512 * 1024 * 1024;
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_RANK = 64;
const MAX_STRING_VALUE_CHARS = 4096;
const MAX_PREVIEW_TEXT_CHARS = 1_000_000;
const MAX_STRING_ITEM_BYTES = 1024 * 1024;
export const NUMPY_PREVIEW_ELEMENT_LIMIT = 100_000;

export type NumpyScalar = string | number | boolean;

export interface NumpyArray {
    name: string;
    dtype: string;
    byteOrder: 'little' | 'big' | 'not-applicable' | 'native';
    kind: string;
    shape: number[];
    fortranOrder: boolean;
    elements: number;
    byteLength: number;
    values: NumpyScalar[];
    previewTruncated: boolean;
    warnings: string[];
    diagnostics?: NumpyDiagnostic[];
}

export interface NumpySummaryItem {
    label: string;
    value: string | number;
}

export interface NumpyTable {
    title: string;
    headers: string[];
    rows: Array<Array<string | number>>;
}

export interface NumpyDocument {
    format: 'NumPy NPY' | 'NumPy NPZ';
    title: string;
    fileSize: string;
    arrays: NumpyArray[];
    summary: NumpySummaryItem[];
    tables: NumpyTable[];
    warnings: string[];
    diagnostics?: NumpyDiagnostic[];
}

export interface NumpyDiagnostic {
    code: string;
    args?: Record<string, string | number>;
}

export interface NumpyParseOptions {
    signal?: AbortSignal;
}

interface ParsedDtype {
    byteOrder: NumpyArray['byteOrder'];
    littleEndian: boolean;
    kindCode: string;
    kind: string;
    itemSize: number;
    supported: boolean;
    fixedWidth: boolean;
}

interface PreviewBudget { remaining: number; textRemaining: number }
interface HeaderPair { key: string; value: string }
interface ZipByteStream {
    on(event: 'data', callback: (chunk: Uint8Array) => void): ZipByteStream;
    on(event: 'error', callback: (error: Error) => void): ZipByteStream;
    on(event: 'end', callback: () => void): ZipByteStream;
    pause(): ZipByteStream;
    resume(): ZipByteStream;
}
type StreamableZipObject = JSZipObject & {
    internalStream(type: 'uint8array'): ZipByteStream;
    _data?: { crc32?: number };
};

class ZipEntryLimitError extends Error {}
class ZipTotalLimitError extends Error {}
class ZipCrcError extends Error {}

/** Parses either a standalone .npy array or a ZIP-backed .npz collection. */
export async function parseNumpy(data: Uint8Array, fileName = 'array.npy', options: NumpyParseOptions = {}): Promise<NumpyDocument> {
    throwIfAborted(options.signal);
    const budget = { remaining: NUMPY_PREVIEW_ELEMENT_LIMIT, textRemaining: MAX_PREVIEW_TEXT_CHARS };
    if (hasPrefix(data, NPY_MAGIC)) return documentFromArrays('NumPy NPY', [parseNpyArray(data, arrayName(fileName), budget, options.signal)], data.byteLength);
    if (hasPrefix(data, ZIP_MAGIC) || fileName.toLowerCase().endsWith('.npz')) return parseNpz(data, options, budget);
    return invalid('NumPy NPY', data.byteLength, 'notNumpy', 'The file is not a NumPy .npy or .npz file.');
}

/** Parses one NPY payload. Object arrays are intentionally never unpickled. */
export function parseNpy(data: Uint8Array, name = 'array', options: NumpyParseOptions = {}): NumpyDocument {
    throwIfAborted(options.signal);
    if (!hasPrefix(data, NPY_MAGIC)) return invalid('NumPy NPY', data.byteLength, 'npyMagic', 'The NPY magic signature is missing.');
    return documentFromArrays('NumPy NPY', [parseNpyArray(data, name, { remaining: NUMPY_PREVIEW_ELEMENT_LIMIT, textRemaining: MAX_PREVIEW_TEXT_CHARS }, options.signal)], data.byteLength);
}

async function parseNpz(data: Uint8Array, options: NumpyParseOptions, budget: PreviewBudget): Promise<NumpyDocument> {
    if (!hasPrefix(data, ZIP_MAGIC)) return invalid('NumPy NPZ', data.byteLength, 'npzMagic', 'The NPZ ZIP signature is missing.');
    const declaredBytes = declaredZipUncompressedBytes(data);
    const declaredEntries = declaredZipEntryCount(data);
    if (declaredBytes === null || declaredBytes > MAX_TOTAL_ARRAY_BYTES) {
        return invalid('NumPy NPZ', data.byteLength, 'npzDeclaredSize', `The NPZ declared uncompressed size exceeds ${formatFileSize(MAX_TOTAL_ARRAY_BYTES)}.`, { limit: formatFileSize(MAX_TOTAL_ARRAY_BYTES) });
    }
    if (declaredEntries === null || declaredEntries > MAX_ZIP_ENTRIES) {
        return invalid('NumPy NPZ', data.byteLength, 'npzEntryCount', `The NPZ archive exceeds the ${MAX_ZIP_ENTRIES} entry safety limit.`, { limit: MAX_ZIP_ENTRIES });
    }
    try {
        throwIfAborted(options.signal);
        const { default: JSZip } = await import('jszip');
        throwIfAborted(options.signal);
        // CRC verification would inflate every member, including unrelated
        // files, before our per-entry limits can run. Selected NPY members are
        // instead expanded through the bounded stream below.
        const zip = await JSZip.loadAsync(data, { checkCRC32: false, createFolders: false });
        throwIfAborted(options.signal);
        const entries = Object.values(zip.files)
            .filter(entry => !entry.dir && entry.name.toLowerCase().endsWith('.npy'))
            .sort((a, b) => a.name.localeCompare(b.name));
        const warnings: string[] = [];
        const diagnostics: NumpyDiagnostic[] = [];
        const warn = (code: string, message: string, args?: Record<string, string | number>): void => { warnings.push(message); diagnostics.push({ code, ...(args ? { args } : {}) }); };
        if (entries.length > MAX_ARRAYS) warn('npzArrayCount', `Only the first ${MAX_ARRAYS} arrays are shown.`, { limit: MAX_ARRAYS });
        const arrays: NumpyArray[] = [];
        const expansionBudget = { remaining: MAX_TOTAL_ARRAY_BYTES };
        for (const entry of entries.slice(0, MAX_ARRAYS)) {
            throwIfAborted(options.signal);
            let payload: Uint8Array;
            try {
                payload = await readZipEntryBounded(entry, MAX_ARRAY_BYTES, expansionBudget, options.signal);
            } catch (error) {
                if (options.signal?.aborted) throw error;
                if (error instanceof ZipTotalLimitError) {
                    warn('npzTotalSize', `Stopped expanding arrays at the ${formatFileSize(MAX_TOTAL_ARRAY_BYTES)} total safety limit.`, { limit: formatFileSize(MAX_TOTAL_ARRAY_BYTES) });
                    break;
                }
                if (error instanceof ZipEntryLimitError) {
                    warn('npzArraySize', `${entry.name}: the uncompressed array exceeds the ${formatFileSize(MAX_ARRAY_BYTES)} safety limit.`, { name: entry.name, limit: formatFileSize(MAX_ARRAY_BYTES) });
                    continue;
                }
                if (error instanceof ZipCrcError) {
                    warn('npzCrc', `${entry.name}: CRC validation failed; the array was skipped.`, { name: entry.name });
                    continue;
                }
                const reason = error instanceof Error ? error.message : String(error);
                warn('npzEntryRead', `${entry.name}: the array member could not be decompressed and was skipped: ${reason}`, { name: entry.name, reason });
                continue;
            }
            arrays.push(parseNpyArray(payload, entry.name.replace(/\.npy$/i, ''), budget, options.signal));
        }
        if (!entries.length) warn('npzNoArrays', 'The NPZ archive does not contain any .npy arrays.');
        const document = documentFromArrays('NumPy NPZ', arrays, data.byteLength);
        document.warnings.unshift(...warnings);
        document.diagnostics?.unshift(...diagnostics);
        return document;
    } catch (error) {
        if (options.signal?.aborted) throw abortReason(options.signal);
        const reason = error instanceof Error ? error.message : String(error);
        return invalid('NumPy NPZ', data.byteLength, 'npzRead', `The NPZ archive could not be read: ${reason}`, { reason });
    }
}

function parseNpyArray(data: Uint8Array, name: string, budget: PreviewBudget, signal?: AbortSignal): NumpyArray {
    const warnings: string[] = [];
    const diagnostics: NumpyDiagnostic[] = [];
    const warn = (code: string, message: string, args?: Record<string, string | number>): void => { warnings.push(message); diagnostics.push({ code, ...(args ? { args } : {}) }); };
    const empty: NumpyArray = {
        name, dtype: 'unknown', byteOrder: 'not-applicable', kind: 'unknown', shape: [],
        fortranOrder: false, elements: 0, byteLength: 0, values: [], previewTruncated: false, warnings, diagnostics
    };
    throwIfAborted(signal);
    if (!hasPrefix(data, NPY_MAGIC) || data.byteLength < 10) {
        warn('npyHeader', 'Invalid or truncated NPY header.');
        return empty;
    }
    const major = data[6]!;
    const minor = data[7]!;
    const headerLengthBytes = major === 1 ? 2 : major === 2 || major === 3 ? 4 : 0;
    if (!headerLengthBytes || minor !== 0) {
        warn('npyVersion', `Unsupported NPY format version ${major}.${minor}.`, { version: `${major}.${minor}` });
        return empty;
    }
    if (data.byteLength < 8 + headerLengthBytes) {
        warn('npyHeader', 'Invalid or truncated NPY header.');
        return empty;
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const headerLength = headerLengthBytes === 2 ? view.getUint16(8, true) : view.getUint32(8, true);
    const headerStart = 8 + headerLengthBytes;
    const dataOffset = headerStart + headerLength;
    if (dataOffset > data.byteLength || headerLength === 0) {
        warn('npyHeaderBounds', 'The declared NPY header extends beyond the file.');
        return empty;
    }
    if (headerLength > MAX_HEADER_BYTES) {
        warn('npyHeaderSize', `The NPY header exceeds the ${formatFileSize(MAX_HEADER_BYTES)} safety limit.`, { limit: formatFileSize(MAX_HEADER_BYTES) });
        return empty;
    }
    let header: string;
    try {
        header = new TextDecoder(major === 3 ? 'utf-8' : 'latin1', { fatal: true }).decode(data.subarray(headerStart, dataOffset));
    } catch {
        warn('npyHeaderDecode', 'The NPY header text could not be decoded.');
        return empty;
    }
    const pairs = parseSimpleHeader(header, signal);
    if (!pairs || new Set(pairs.map(pair => pair.key)).size !== pairs.length || pairs.length !== 3) {
        warn('npyHeaderGrammar', 'The NPY header contains duplicate fields or unsupported trailing syntax.');
        return empty;
    }
    const headerValues = new Map(pairs.map(pair => [pair.key, pair.value]));
    const descrRaw = headerValues.get('descr');
    const fortranText = headerValues.get('fortran_order');
    const shapeRaw = headerValues.get('shape');
    const descr = descrRaw && (descrRaw[0] === '"' || descrRaw[0] === "'") ? descrRaw.slice(1, -1) : undefined;
    const shapeText = shapeRaw?.match(/^\(([^)]*)\)$/s)?.[1];
    if (!descr || (fortranText !== 'True' && fortranText !== 'False') || shapeText === undefined) {
        warn('npyHeaderFields', 'The NPY header is missing a simple dtype, shape, or storage-order declaration. Structured dtypes are not yet decoded.');
        return empty;
    }
    const shape = parseShape(shapeText);
    if (!shape) {
        warn('npyShape', 'The NPY shape contains an invalid dimension.');
        return { ...empty, dtype: descr };
    }
    if (shape.length > MAX_RANK) {
        warn('npyRank', `The NPY array rank exceeds the ${MAX_RANK}-axis safety limit.`, { limit: MAX_RANK });
        return { ...empty, dtype: descr };
    }
    const elements = safeElementCount(shape);
    if (elements === undefined) {
        warn('npyElementCount', 'The NPY element count is outside the safe integer range.');
        return { ...empty, dtype: descr, shape };
    }
    const dtype = parseDtype(descr);
    const payload = data.subarray(dataOffset);
    const expectedBytes = elements * dtype.itemSize;
    if (dtype.fixedWidth && (!Number.isSafeInteger(expectedBytes) || expectedBytes > payload.byteLength)) warn('payloadShort', 'The array payload is shorter than its dtype and shape require.');
    else if (dtype.fixedWidth && expectedBytes < payload.byteLength) warn('payloadTrailing', 'The array payload contains trailing bytes.');
    if (!dtype.supported) {
        if (dtype.kindCode === 'O') warn('objectUnsafe', 'Object arrays are not loaded because doing so would require unsafe pickle deserialization.');
        else warn('dtypeUnsupported', `Values with dtype ${descr} are not decoded; metadata is still available.`, { dtype: descr });
    }
    const stringItemTooWide = dtype.supported && (dtype.kindCode === 'S' || dtype.kindCode === 'U') && dtype.itemSize > MAX_STRING_ITEM_BYTES;
    if (stringItemTooWide) warn('stringItemSize', `String values wider than ${formatFileSize(MAX_STRING_ITEM_BYTES)} are not decoded.`, { limit: formatFileSize(MAX_STRING_ITEM_BYTES) });
    if (descr.startsWith('=')) warn('nativeEndian', 'Native-endian dtype was interpreted as little-endian.');
    const zeroWidthString = dtype.supported && dtype.itemSize === 0 && (dtype.kindCode === 'S' || dtype.kindCode === 'U');
    const readableElements = zeroWidthString ? elements : dtype.itemSize > 0 ? Math.min(elements, Math.floor(payload.byteLength / dtype.itemSize)) : 0;
    const previewCount = stringItemTooWide ? 0 : Math.min(readableElements, budget.remaining);
    const decoded = dtype.supported && !stringItemTooWide ? decodeValues(payload, dtype, previewCount, budget, signal) : { values: [], textTruncated: false };
    const values = decoded.values;
    budget.remaining -= values.length;
    if (values.length < previewCount && !decoded.textTruncated) warn('previewDecode', 'Some preview values could not be decoded.');
    if (decoded.textTruncated) warn('textPreviewLimit', `String previews are limited to ${MAX_STRING_VALUE_CHARS} characters per value and ${MAX_PREVIEW_TEXT_CHARS} characters per document.`, { perValue: MAX_STRING_VALUE_CHARS, total: MAX_PREVIEW_TEXT_CHARS });
    const previewTruncated = dtype.supported && !stringItemTooWide && (readableElements > values.length || decoded.textTruncated);
    if (dtype.supported && !stringItemTooWide && readableElements > previewCount) warn('previewLimit', `The document value preview is limited to ${NUMPY_PREVIEW_ELEMENT_LIMIT.toLocaleString('en-US')} elements.`, { limit: NUMPY_PREVIEW_ELEMENT_LIMIT });
    return {
        name, dtype: descr, byteOrder: dtype.byteOrder, kind: dtype.kind, shape,
        fortranOrder: fortranText === 'True', elements, byteLength: payload.byteLength,
        values, previewTruncated, warnings, diagnostics
    };
}

function parseShape(text: string): number[] | undefined {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const trailingComma = trimmed.endsWith(',');
    const parts = trimmed.split(',').map(part => part.trim());
    if (trailingComma) parts.pop();
    if (!parts.length || parts.some(part => !part) || (parts.length === 1 && !trailingComma)) return undefined;
    if (!parts.every(part => /^\d+[lL]?$/.test(part))) return undefined;
    const shape = parts.map(part => Number(part.replace(/[lL]$/, '')));
    return shape.every(value => Number.isSafeInteger(value) && value >= 0) ? shape : undefined;
}

function parseSimpleHeader(header: string, signal?: AbortSignal): HeaderPair[] | undefined {
    let cursor = 0;
    const pairs: HeaderPair[] = [];
    const check = (): void => { if ((cursor & 0xfff) === 0) throwIfAborted(signal); };
    const whitespace = (): void => { while (cursor < header.length && /\s/.test(header[cursor]!)) { cursor++; check(); } };
    const quoted = (): { text: string; raw: string } | undefined => {
        const quote = header[cursor];
        if (quote !== '"' && quote !== "'") return undefined;
        const start = cursor++;
        while (cursor < header.length && header[cursor] !== quote) {
            // Escaped Python strings and structured dtypes are intentionally
            // outside this viewer's simple-header grammar.
            if (header[cursor] === '\\' || header[cursor] === '\n' || header[cursor] === '\r') return undefined;
            cursor++; check();
        }
        if (cursor >= header.length) return undefined;
        cursor++;
        return { text: header.slice(start + 1, cursor - 1), raw: header.slice(start, cursor) };
    };
    whitespace();
    if (header[cursor++] !== '{') return undefined;
    while (true) {
        whitespace();
        if (header[cursor] === '}') { cursor++; break; }
        const key = quoted();
        if (!key) return undefined;
        whitespace();
        if (header[cursor++] !== ':') return undefined;
        whitespace();
        let value: string;
        const string = quoted();
        if (string) value = string.raw;
        else if (header.startsWith('True', cursor)) { value = 'True'; cursor += 4; }
        else if (header.startsWith('False', cursor)) { value = 'False'; cursor += 5; }
        else if (header[cursor] === '(') {
            const start = cursor++;
            while (cursor < header.length && header[cursor] !== ')') { cursor++; check(); }
            if (cursor >= header.length) return undefined;
            cursor++;
            value = header.slice(start, cursor);
        } else return undefined;
        pairs.push({ key: key.text, value });
        whitespace();
        if (header[cursor] === ',') {
            cursor++; whitespace();
            if (header[cursor] === '}') { cursor++; break; }
            continue;
        }
        if (header[cursor] === '}') { cursor++; break; }
        return undefined;
    }
    whitespace();
    return cursor === header.length ? pairs : undefined;
}

function parseDtype(descr: string): ParsedDtype {
    const match = /^([<>=|])?([?biufcSUmMVO])(\d+)?(\[[^\]]+\])?$/.exec(descr);
    if (!match) return { byteOrder: 'not-applicable', littleEndian: true, kindCode: '?', kind: 'unknown', itemSize: 0, supported: false, fixedWidth: false };
    const marker = match[1] ?? '=';
    const kindCode = match[2]!;
    const declaredSize = match[3] === undefined ? 0 : Number(match[3]);
    const unit = match[4];
    const unitMatch = unit?.match(/^\[(\d+)?(Y|M|W|D|h|m|s|ms|us|ns|ps|fs|as)\]$/);
    const multiplier = unitMatch?.[1] === undefined ? undefined : Number(unitMatch[1]);
    const validTimeUnit = unit === undefined || (unitMatch !== null && (multiplier === undefined || Number.isSafeInteger(multiplier) && multiplier <= 0x7fffffff));
    if (unit !== undefined && (kindCode !== 'm' && kindCode !== 'M' || !validTimeUnit)) {
        return { byteOrder: 'not-applicable', littleEndian: true, kindCode, kind: 'unknown', itemSize: 0, supported: false, fixedWidth: false };
    }
    // NumPy's U suffix is a count of UTF-32 code points; other simple dtype
    // suffixes are byte widths.
    const itemSize = kindCode === 'U' ? declaredSize * 4 : declaredSize;
    const byteOrder = marker === '<' ? 'little' : marker === '>' ? 'big' : marker === '=' ? 'native' : 'not-applicable';
    const kinds: Record<string, string> = {
        '?': 'boolean', b: 'boolean', i: 'signed integer', u: 'unsigned integer', f: 'floating point',
        c: 'complex', S: 'byte string', U: 'Unicode string', m: 'timedelta', M: 'datetime', V: 'void', O: 'object'
    };
    const validSize = (kindCode === '?' || kindCode === 'b') ? itemSize === 1
        : (kindCode === 'i' || kindCode === 'u') ? [1, 2, 4, 8].includes(itemSize)
        : kindCode === 'f' ? [2, 4, 8].includes(itemSize)
        : kindCode === 'c' ? [8, 16].includes(itemSize)
        : kindCode === 'S' ? itemSize >= 0
        : kindCode === 'U' ? declaredSize >= 0
        : (kindCode === 'm' || kindCode === 'M') ? itemSize === 8
        : false;
    return {
        byteOrder, littleEndian: marker !== '>', kindCode, kind: kinds[kindCode] ?? 'unknown',
        itemSize, supported: validSize, fixedWidth: kindCode !== 'O' && (itemSize > 0 || validSize)
    };
}

function decodeValues(
    payload: Uint8Array,
    dtype: ParsedDtype,
    count: number,
    budget: PreviewBudget,
    signal?: AbortSignal
): { values: NumpyScalar[]; textTruncated: boolean } {
    const values: NumpyScalar[] = [];
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let textTruncated = false;
    for (let index = 0; index < count; index++) {
        if ((index & 0xfff) === 0) throwIfAborted(signal);
        if ((dtype.kindCode === 'S' || dtype.kindCode === 'U') && dtype.itemSize > 0 && budget.textRemaining === 0) {
            textTruncated = true;
            break;
        }
        const offset = index * dtype.itemSize;
        try {
            const decoded = decodeValue(payload, view, offset, dtype, budget, signal);
            values.push(decoded.value);
            textTruncated ||= decoded.textTruncated;
        } catch (error) {
            if (signal?.aborted) throw abortReason(signal);
            break;
        }
    }
    return { values, textTruncated };
}

function decodeValue(
    bytes: Uint8Array,
    view: DataView,
    offset: number,
    dtype: ParsedDtype,
    budget: PreviewBudget,
    signal?: AbortSignal
): { value: NumpyScalar; textTruncated: boolean } {
    const le = dtype.littleEndian;
    switch (dtype.kindCode) {
        case '?': case 'b': return { value: view.getUint8(offset) !== 0, textTruncated: false };
        case 'i':
            if (dtype.itemSize === 1) return { value: view.getInt8(offset), textTruncated: false };
            if (dtype.itemSize === 2) return { value: view.getInt16(offset, le), textTruncated: false };
            if (dtype.itemSize === 4) return { value: view.getInt32(offset, le), textTruncated: false };
            return { value: view.getBigInt64(offset, le).toString(), textTruncated: false };
        case 'u':
            if (dtype.itemSize === 1) return { value: view.getUint8(offset), textTruncated: false };
            if (dtype.itemSize === 2) return { value: view.getUint16(offset, le), textTruncated: false };
            if (dtype.itemSize === 4) return { value: view.getUint32(offset, le), textTruncated: false };
            return { value: view.getBigUint64(offset, le).toString(), textTruncated: false };
        case 'f':
            if (dtype.itemSize === 2) return { value: decodeFloat16(view.getUint16(offset, le)), textTruncated: false };
            return { value: dtype.itemSize === 4 ? view.getFloat32(offset, le) : view.getFloat64(offset, le), textTruncated: false };
        case 'c': {
            const width = dtype.itemSize / 2;
            const real = width === 4 ? view.getFloat32(offset, le) : view.getFloat64(offset, le);
            const imaginary = width === 4 ? view.getFloat32(offset + width, le) : view.getFloat64(offset + width, le);
            const negative = imaginary < 0 || Object.is(imaginary, -0);
            return { value: `${formatNumber(real)}${negative ? '-' : '+'}${formatNumber(Math.abs(imaginary))}j`, textTruncated: false };
        }
        case 'S': {
            const outputLimit = Math.min(MAX_STRING_VALUE_CHARS, budget.textRemaining);
            let sourceEnd = dtype.itemSize;
            while (sourceEnd > 0 && bytes[offset + sourceEnd - 1] === 0) {
                if ((sourceEnd & 0xfff) === 0) throwIfAborted(signal);
                sourceEnd--;
            }
            let result = '';
            let cursor = 0;
            for (; cursor < sourceEnd; cursor++) {
                if ((cursor & 0xfff) === 0) throwIfAborted(signal);
                const byte = bytes[offset + cursor]!;
                const token = byte === 0 ? '\\0' : byte >= 0x20 && byte <= 0x7e && byte !== 0x5c
                    ? String.fromCharCode(byte)
                    : `\\x${byte.toString(16).padStart(2, '0')}`;
                if (result.length + token.length > outputLimit) break;
                result += token;
            }
            const truncated = cursor < sourceEnd;
            if (truncated && outputLimit > 0) result = result.length < outputLimit ? result + '…' : result.slice(0, outputLimit - 1) + '…';
            budget.textRemaining = Math.max(0, budget.textRemaining - result.length);
            return { value: result, textTruncated: truncated };
        }
        case 'U': {
            const codePoints = dtype.itemSize / 4;
            const outputLimit = Math.min(MAX_STRING_VALUE_CHARS, budget.textRemaining);
            let sourceEnd = codePoints;
            while (sourceEnd > 0 && view.getUint32(offset + (sourceEnd - 1) * 4, le) === 0) {
                if ((sourceEnd & 0xfff) === 0) throwIfAborted(signal);
                sourceEnd--;
            }
            let result = '';
            let cursor = 0;
            for (; cursor < sourceEnd; cursor++) {
                if ((cursor & 0xfff) === 0) throwIfAborted(signal);
                const codePoint = view.getUint32(offset + cursor * 4, le);
                const token = codePoint === 0 ? '\\0' : codePoint === 0x5c ? '\\\\' : String.fromCodePoint(codePoint);
                if (result.length + token.length > outputLimit) break;
                result += token;
            }
            const truncated = cursor < sourceEnd;
            if (truncated && outputLimit > 0) result = result.length < outputLimit ? result + '…' : result.slice(0, outputLimit - 1) + '…';
            budget.textRemaining = Math.max(0, budget.textRemaining - result.length);
            return { value: result, textTruncated: truncated };
        }
        case 'm': case 'M': return { value: view.getBigInt64(offset, le).toString(), textTruncated: false };
        default: return { value: '', textTruncated: false };
    }
}

function decodeFloat16(bits: number): number {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >>> 10) & 0x1f;
    const fraction = bits & 0x3ff;
    if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
    if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
    return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function documentFromArrays(format: NumpyDocument['format'], arrays: NumpyArray[], bytes: number): NumpyDocument {
    const totalElements = arrays.reduce((sum, array) => sum + array.elements, 0);
    const dtypeSet = [...new Set(arrays.map(array => array.dtype))];
    const warnings = arrays.flatMap(array => array.warnings.map(warning => arrays.length > 1 ? `${array.name}: ${warning}` : warning));
    const diagnostics = arrays.flatMap(array => (array.diagnostics ?? []).map(diagnostic => ({
        code: diagnostic.code,
        args: { ...(diagnostic.args ?? {}), ...(arrays.length > 1 ? { name: array.name } : {}) }
    })));
    return {
        format,
        title: format === 'NumPy NPZ' ? 'NumPy array archive' : 'NumPy array',
        fileSize: formatFileSize(bytes),
        arrays,
        summary: [
            { label: 'Arrays', value: arrays.length },
            { label: 'Elements', value: formatCount(totalElements) },
            { label: 'Data types', value: dtypeSet.length ? dtypeSet.join(', ') : '—' }
        ],
        tables: [{
            title: `Arrays (${arrays.length})`,
            headers: ['Name', 'Dtype', 'Shape', 'Order', 'Elements', 'Data size'],
            rows: arrays.map(array => [
                array.name, array.dtype, formatShape(array.shape), array.fortranOrder ? 'Fortran' : 'C',
                array.elements, formatFileSize(array.byteLength)
            ])
        }],
        warnings,
        diagnostics
    };
}

function invalid(
    format: NumpyDocument['format'],
    bytes: number,
    code: string,
    warning: string,
    args?: Record<string, string | number>
): NumpyDocument {
    return {
        format, title: format === 'NumPy NPZ' ? 'NumPy array archive' : 'NumPy array', fileSize: formatFileSize(bytes),
        arrays: [], summary: [{ label: 'Status', value: 'invalid' }], tables: [], warnings: [warning],
        diagnostics: [{ code, ...(args ? { args } : {}) }]
    };
}

function readZipEntryBounded(
    entry: JSZipObject,
    entryLimit: number,
    totalBudget: { remaining: number },
    signal?: AbortSignal
): Promise<Uint8Array> {
    throwIfAborted(signal);
    return new Promise<Uint8Array>((resolve, reject) => {
        const stream = (entry as StreamableZipObject).internalStream('uint8array');
        const expectedCrc = (entry as StreamableZipObject)._data?.crc32;
        const chunks: Uint8Array[] = [];
        let total = 0;
        let crc = 0xffffffff;
        let settled = false;
        const finish = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', abort);
            callback();
        };
        const abort = (): void => {
            stream.pause();
            finish(() => reject(signal ? abortReason(signal) : new DOMException('The operation was aborted.', 'AbortError')));
        };
        signal?.addEventListener('abort', abort, { once: true });
        stream.on('data', (chunk: Uint8Array) => {
            if (settled) return;
            total += chunk.byteLength;
            totalBudget.remaining -= chunk.byteLength;
            if (totalBudget.remaining < 0) {
                stream.pause();
                finish(() => reject(new ZipTotalLimitError(`The total uncompressed data exceeds the ${formatFileSize(MAX_TOTAL_ARRAY_BYTES)} safety limit.`)));
                return;
            }
            if (total > entryLimit) {
                stream.pause();
                finish(() => reject(new ZipEntryLimitError(`The uncompressed array exceeds the ${formatFileSize(entryLimit)} safety limit.`)));
                return;
            }
            crc = updateCrc32(crc, chunk);
            chunks.push(chunk);
        });
        stream.on('error', (error: Error) => finish(() => reject(error)));
        stream.on('end', () => finish(() => {
            const actualCrc = (crc ^ 0xffffffff) >>> 0;
            if (expectedCrc === undefined || actualCrc !== (expectedCrc >>> 0)) {
                reject(new ZipCrcError('The ZIP member CRC does not match its central-directory declaration.'));
                return;
            }
            const output = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
            resolve(output);
        }));
        if (!settled) stream.resume();
    });
}

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let value = 0; value < table.length; value++) {
        let crc = value;
        for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
        table[value] = crc >>> 0;
    }
    return table;
})();

function updateCrc32(crc: number, bytes: Uint8Array): number {
    let value = crc;
    for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
    return value >>> 0;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');
}

function safeElementCount(shape: readonly number[]): number | undefined {
    let result = 1;
    for (const dimension of shape) {
        if (dimension !== 0 && result > Number.MAX_SAFE_INTEGER / dimension) return undefined;
        result *= dimension;
    }
    return result;
}

function hasPrefix(data: Uint8Array, prefix: readonly number[]): boolean {
    return data.byteLength >= prefix.length && prefix.every((byte, index) => data[index] === byte);
}

function arrayName(fileName: string): string {
    const part = fileName.split(/[\\/]/).pop() ?? fileName;
    return part.replace(/\.npy$/i, '') || 'array';
}

function formatShape(shape: readonly number[]): string {
    return shape.length ? shape.join(' × ') : 'scalar';
}

function formatNumber(value: number): string {
    return Object.is(value, -0) ? '-0' : String(value);
}

function formatCount(count: number): string {
    if (count < 1000) return String(count);
    for (const [threshold, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
        if (count >= threshold) {
            const value = count / threshold;
            return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2) + suffix;
        }
    }
    return String(count);
}

export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} bytes`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = units[0]!;
    for (let index = 1; index < units.length && value >= 1024; index++) { value /= 1024; unit = units[index]!; }
    return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}
