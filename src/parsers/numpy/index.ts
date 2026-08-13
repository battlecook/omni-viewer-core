const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59] as const;
const ZIP_MAGIC = [0x50, 0x4b] as const;
const MAX_ARRAYS = 1000;
const MAX_ARRAY_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_ARRAY_BYTES = 512 * 1024 * 1024;
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
}

interface ParsedDtype {
    byteOrder: NumpyArray['byteOrder'];
    littleEndian: boolean;
    kindCode: string;
    kind: string;
    itemSize: number;
    supported: boolean;
}

/** Parses either a standalone .npy array or a ZIP-backed .npz collection. */
export async function parseNumpy(data: Uint8Array, fileName = 'array.npy'): Promise<NumpyDocument> {
    if (hasPrefix(data, NPY_MAGIC)) return documentFromArrays('NumPy NPY', [parseNpyArray(data, arrayName(fileName))], data.byteLength);
    if (hasPrefix(data, ZIP_MAGIC) || fileName.toLowerCase().endsWith('.npz')) return parseNpz(data);
    return invalid('NumPy NPY', data.byteLength, 'The file is not a NumPy .npy or .npz file.');
}

/** Parses one NPY payload. Object arrays are intentionally never unpickled. */
export function parseNpy(data: Uint8Array, name = 'array'): NumpyDocument {
    if (!hasPrefix(data, NPY_MAGIC)) return invalid('NumPy NPY', data.byteLength, 'The NPY magic signature is missing.');
    return documentFromArrays('NumPy NPY', [parseNpyArray(data, name)], data.byteLength);
}

async function parseNpz(data: Uint8Array): Promise<NumpyDocument> {
    if (!hasPrefix(data, ZIP_MAGIC)) return invalid('NumPy NPZ', data.byteLength, 'The NPZ ZIP signature is missing.');
    try {
        const { default: JSZip } = await import('jszip');
        const zip = await JSZip.loadAsync(data, { checkCRC32: true, createFolders: false });
        const entries = Object.values(zip.files)
            .filter(entry => !entry.dir && entry.name.toLowerCase().endsWith('.npy'))
            .sort((a, b) => a.name.localeCompare(b.name));
        const warnings: string[] = [];
        if (entries.length > MAX_ARRAYS) warnings.push(`Only the first ${MAX_ARRAYS} arrays are shown.`);
        const arrays: NumpyArray[] = [];
        let expandedBytes = 0;
        for (const entry of entries.slice(0, MAX_ARRAYS)) {
            const declaredSize = (entry as typeof entry & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
            if (declaredSize !== undefined && declaredSize > MAX_ARRAY_BYTES) {
                warnings.push(`${entry.name}: the uncompressed array exceeds the ${formatFileSize(MAX_ARRAY_BYTES)} safety limit.`);
                continue;
            }
            if (declaredSize !== undefined && expandedBytes + declaredSize > MAX_TOTAL_ARRAY_BYTES) {
                warnings.push(`Stopped expanding arrays at the ${formatFileSize(MAX_TOTAL_ARRAY_BYTES)} total safety limit.`);
                break;
            }
            const payload = await entry.async('uint8array');
            if (payload.byteLength > MAX_ARRAY_BYTES) {
                warnings.push(`${entry.name}: the uncompressed array exceeds the ${formatFileSize(MAX_ARRAY_BYTES)} safety limit.`);
                continue;
            }
            if (expandedBytes + payload.byteLength > MAX_TOTAL_ARRAY_BYTES) {
                warnings.push(`Stopped expanding arrays at the ${formatFileSize(MAX_TOTAL_ARRAY_BYTES)} total safety limit.`);
                break;
            }
            expandedBytes += payload.byteLength;
            arrays.push(parseNpyArray(payload, entry.name.replace(/\.npy$/i, '')));
        }
        if (!entries.length) warnings.push('The NPZ archive does not contain any .npy arrays.');
        const document = documentFromArrays('NumPy NPZ', arrays, data.byteLength);
        document.warnings.unshift(...warnings);
        return document;
    } catch (error) {
        return invalid('NumPy NPZ', data.byteLength, `The NPZ archive could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function parseNpyArray(data: Uint8Array, name: string): NumpyArray {
    const warnings: string[] = [];
    const empty: NumpyArray = {
        name, dtype: 'unknown', byteOrder: 'not-applicable', kind: 'unknown', shape: [],
        fortranOrder: false, elements: 0, byteLength: 0, values: [], previewTruncated: false, warnings
    };
    if (!hasPrefix(data, NPY_MAGIC) || data.byteLength < 10) {
        warnings.push('Invalid or truncated NPY header.');
        return empty;
    }
    const major = data[6]!;
    const minor = data[7]!;
    const headerLengthBytes = major === 1 ? 2 : major === 2 || major === 3 ? 4 : 0;
    if (!headerLengthBytes || data.byteLength < 8 + headerLengthBytes) {
        warnings.push(`Unsupported NPY format version ${major}.${minor}.`);
        return empty;
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const headerLength = headerLengthBytes === 2 ? view.getUint16(8, true) : view.getUint32(8, true);
    const headerStart = 8 + headerLengthBytes;
    const dataOffset = headerStart + headerLength;
    if (dataOffset > data.byteLength || headerLength === 0) {
        warnings.push('The declared NPY header extends beyond the file.');
        return empty;
    }
    let header: string;
    try {
        header = new TextDecoder(major === 3 ? 'utf-8' : 'latin1', { fatal: true }).decode(data.subarray(headerStart, dataOffset));
    } catch {
        warnings.push('The NPY header text could not be decoded.');
        return empty;
    }
    const descr = header.match(/["']descr["']\s*:\s*(["'])(.*?)\1/s)?.[2];
    const fortranText = header.match(/["']fortran_order["']\s*:\s*(True|False)/)?.[1];
    const shapeText = header.match(/["']shape["']\s*:\s*\(([^)]*)\)/s)?.[1];
    if (!descr || !fortranText || shapeText === undefined) {
        warnings.push('The NPY header is missing a simple dtype, shape, or storage-order declaration. Structured dtypes are not yet decoded.');
        return empty;
    }
    const shape = parseShape(shapeText);
    if (!shape) {
        warnings.push('The NPY shape contains an invalid dimension.');
        return { ...empty, dtype: descr };
    }
    const elements = safeElementCount(shape);
    if (elements === undefined) {
        warnings.push('The NPY element count is outside the safe integer range.');
        return { ...empty, dtype: descr, shape };
    }
    const dtype = parseDtype(descr);
    const payload = data.subarray(dataOffset);
    const expectedBytes = elements * dtype.itemSize;
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes > payload.byteLength) warnings.push('The array payload is shorter than its dtype and shape require.');
    else if (expectedBytes < payload.byteLength) warnings.push('The array payload contains trailing bytes.');
    if (!dtype.supported) {
        warnings.push(dtype.kindCode === 'O'
            ? 'Object arrays are not loaded because doing so would require unsafe pickle deserialization.'
            : `Values with dtype ${descr} are not decoded; metadata is still available.`);
    }
    if (descr.startsWith('=')) warnings.push('Native-endian dtype was interpreted as little-endian.');
    const readableElements = dtype.itemSize > 0 ? Math.min(elements, Math.floor(payload.byteLength / dtype.itemSize)) : 0;
    const previewCount = Math.min(readableElements, NUMPY_PREVIEW_ELEMENT_LIMIT);
    const values = dtype.supported ? decodeValues(payload, dtype, previewCount) : [];
    if (values.length < previewCount) warnings.push('Some preview values could not be decoded.');
    const previewTruncated = readableElements > values.length;
    if (previewTruncated) warnings.push(`Value preview is limited to ${NUMPY_PREVIEW_ELEMENT_LIMIT.toLocaleString('en-US')} elements.`);
    return {
        name, dtype: descr, byteOrder: dtype.byteOrder, kind: dtype.kind, shape,
        fortranOrder: fortranText === 'True', elements, byteLength: payload.byteLength,
        values, previewTruncated, warnings
    };
}

function parseShape(text: string): number[] | undefined {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const parts = trimmed.split(',').map(part => part.trim()).filter(Boolean);
    const shape = parts.map(part => Number(part.replace(/[lL]$/, '')));
    return shape.every(value => Number.isSafeInteger(value) && value >= 0) ? shape : undefined;
}

function parseDtype(descr: string): ParsedDtype {
    const match = /^([<>=|])?([?biufcSUmMVO])(\d+)(?:\[[^\]]+\])?$/.exec(descr);
    if (!match) return { byteOrder: 'not-applicable', littleEndian: true, kindCode: '?', kind: 'unknown', itemSize: 0, supported: false };
    const marker = match[1] ?? '=';
    const kindCode = match[2]!;
    const declaredSize = Number(match[3]);
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
    return { byteOrder, littleEndian: marker !== '>', kindCode, kind: kinds[kindCode] ?? 'unknown', itemSize, supported: validSize };
}

function decodeValues(payload: Uint8Array, dtype: ParsedDtype, count: number): NumpyScalar[] {
    const values: NumpyScalar[] = [];
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    for (let index = 0; index < count; index++) {
        const offset = index * dtype.itemSize;
        try {
            values.push(decodeValue(payload, view, offset, dtype));
        } catch {
            break;
        }
    }
    return values;
}

function decodeValue(bytes: Uint8Array, view: DataView, offset: number, dtype: ParsedDtype): NumpyScalar {
    const le = dtype.littleEndian;
    switch (dtype.kindCode) {
        case '?': case 'b': return view.getUint8(offset) !== 0;
        case 'i':
            if (dtype.itemSize === 1) return view.getInt8(offset);
            if (dtype.itemSize === 2) return view.getInt16(offset, le);
            if (dtype.itemSize === 4) return view.getInt32(offset, le);
            return view.getBigInt64(offset, le).toString();
        case 'u':
            if (dtype.itemSize === 1) return view.getUint8(offset);
            if (dtype.itemSize === 2) return view.getUint16(offset, le);
            if (dtype.itemSize === 4) return view.getUint32(offset, le);
            return view.getBigUint64(offset, le).toString();
        case 'f':
            if (dtype.itemSize === 2) return decodeFloat16(view.getUint16(offset, le));
            return dtype.itemSize === 4 ? view.getFloat32(offset, le) : view.getFloat64(offset, le);
        case 'c': {
            const width = dtype.itemSize / 2;
            const real = width === 4 ? view.getFloat32(offset, le) : view.getFloat64(offset, le);
            const imaginary = width === 4 ? view.getFloat32(offset + width, le) : view.getFloat64(offset + width, le);
            return `${formatNumber(real)}${imaginary < 0 ? '' : '+'}${formatNumber(imaginary)}j`;
        }
        case 'S': {
            const value = bytes.subarray(offset, offset + dtype.itemSize);
            const end = value.indexOf(0);
            return new TextDecoder('latin1').decode(end >= 0 ? value.subarray(0, end) : value);
        }
        case 'U': {
            let result = '';
            for (let cursor = offset; cursor < offset + dtype.itemSize; cursor += 4) {
                const codePoint = view.getUint32(cursor, le);
                if (!codePoint) break;
                result += String.fromCodePoint(codePoint);
            }
            return result;
        }
        case 'm': case 'M': return view.getBigInt64(offset, le).toString();
        default: return '';
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
        warnings
    };
}

function invalid(format: NumpyDocument['format'], bytes: number, warning: string): NumpyDocument {
    return {
        format, title: format === 'NumPy NPZ' ? 'NumPy array archive' : 'NumPy array', fileSize: formatFileSize(bytes),
        arrays: [], summary: [{ label: 'Status', value: 'invalid' }], tables: [], warnings: [warning]
    };
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
