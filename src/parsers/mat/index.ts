import { Hdf5Parser } from '../hdf5/index.js';

const HDF5_SIGNATURE = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const MAT_V5_HEADER_BYTES = 128;
const MAX_VARIABLES = 5000;
const MAX_PREVIEW_VALUES = 24;
const MAX_DECOMPRESSED_BLOCK_BYTES = 256 * 1024 * 1024;

const MI_INT8 = 1;
const MI_UINT8 = 2;
const MI_INT16 = 3;
const MI_UINT16 = 4;
const MI_INT32 = 5;
const MI_UINT32 = 6;
const MI_SINGLE = 7;
const MI_DOUBLE = 9;
const MI_INT64 = 12;
const MI_UINT64 = 13;
const MI_MATRIX = 14;
const MI_COMPRESSED = 15;
const MI_UTF8 = 16;
const MI_UTF16 = 17;
const MI_UTF32 = 18;

const MX_CLASSES: Record<number, string> = {
    1: 'cell', 2: 'struct', 3: 'object', 4: 'char', 5: 'sparse',
    6: 'double', 7: 'single', 8: 'int8', 9: 'uint8', 10: 'int16',
    11: 'uint16', 12: 'int32', 13: 'uint32', 14: 'int64', 15: 'uint64'
};

const MI_TYPES: Record<number, string> = {
    [MI_INT8]: 'miINT8', [MI_UINT8]: 'miUINT8', [MI_INT16]: 'miINT16',
    [MI_UINT16]: 'miUINT16', [MI_INT32]: 'miINT32', [MI_UINT32]: 'miUINT32',
    [MI_SINGLE]: 'miSINGLE', [MI_DOUBLE]: 'miDOUBLE', [MI_INT64]: 'miINT64',
    [MI_UINT64]: 'miUINT64', [MI_MATRIX]: 'miMATRIX', [MI_COMPRESSED]: 'miCOMPRESSED',
    [MI_UTF8]: 'miUTF8', [MI_UTF16]: 'miUTF16', [MI_UTF32]: 'miUTF32'
};

type Endian = 'LE' | 'BE';

interface DataElement {
    type: number;
    size: number;
    dataOffset: number;
    nextOffset: number;
}

export interface MatVariable {
    name: string;
    className: string;
    dimensions: number[];
    dataType: string;
    bytes: number;
    preview: string;
    attributes: string[];
}

export interface MatSummaryItem {
    label: string;
    value: string | number;
}

export interface MatTable {
    title: string;
    headers: string[];
    rows: Array<Array<string | number>>;
}

export interface MatDocument {
    format: 'MAT v4' | 'MAT v5/v6/v7' | 'MAT v7.3';
    title: string;
    fileSize: string;
    summary: MatSummaryItem[];
    tables: MatTable[];
    variables: MatVariable[];
    rawPreview?: string | undefined;
    warnings: string[];
}

/** Parse MATLAB Level 4, Level 5 (v5/v6/v7), and HDF5-backed v7.3 files. */
export async function parseMat(data: Uint8Array, fileSize = formatFileSize(data.byteLength)): Promise<MatDocument> {
    if (findHdf5SignatureOffset(data) >= 0) return parseHdf5Mat(data, fileSize);
    if (isLevel5(data)) return parseLevel5(data, fileSize);
    return parseLevel4(data, fileSize);
}

export function isMatLevel5(data: Uint8Array): boolean {
    return isLevel5(data);
}

function parseHdf5Mat(data: Uint8Array, fileSize: string): MatDocument {
    const hdf5 = Hdf5Parser.parse(data, fileSize);
    return {
        format: 'MAT v7.3',
        title: 'MATLAB MAT-file (HDF5)',
        fileSize,
        summary: [
            { label: 'MAT version', value: '7.3' },
            ...hdf5.summary.filter(item => item.label !== 'Format')
        ],
        tables: hdf5.tables,
        variables: [],
        rawPreview: hdf5.rawPreview,
        warnings: [
            ...hdf5.warnings,
            'MAT v7.3 files are HDF5 containers. Variables are shown from HDF5 metadata; large dataset payloads are not loaded.'
        ]
    };
}

async function parseLevel5(data: Uint8Array, fileSize: string): Promise<MatDocument> {
    const endian: Endian = ascii(data, 126, 128) === 'IM' ? 'LE' : 'BE';
    const headerText = cleanText(latin1(data.subarray(0, 116)));
    const version = readUInt16(data, 124, endian);
    const variables: MatVariable[] = [];
    const warnings: string[] = [];
    const stats = { skipped: 0, compressed: 0 };
    await parseLevel5Elements(data, MAT_V5_HEADER_BYTES, data.length, endian, variables, warnings, stats);

    if (variables.length >= MAX_VARIABLES) warnings.push(`Variable table is limited to the first ${MAX_VARIABLES} entries.`);
    if (stats.skipped > 0) warnings.push(`${stats.skipped} non-matrix top-level data element(s) were skipped.`);

    return makeClassicDocument('MAT v5/v6/v7', 'MATLAB MAT-file', fileSize, variables, [
        { label: 'MAT version', value: versionLabel(headerText) },
        { label: 'Header version', value: version },
        { label: 'Endian', value: endian === 'LE' ? 'little' : 'big' },
        { label: 'Variables', value: variables.length }
    ], headerText, data, warnings);
}

async function parseLevel5Elements(
    data: Uint8Array,
    start: number,
    end: number,
    endian: Endian,
    variables: MatVariable[],
    warnings: string[],
    stats: { skipped: number; compressed: number }
): Promise<void> {
    let offset = start;
    while (offset + 8 <= end && variables.length < MAX_VARIABLES) {
        const element = readElement(data, offset, endian);
        if (!element || element.nextOffset <= offset || element.dataOffset + element.size > end) {
            warnings.push(`Stopped at byte ${offset}: invalid data element tag.`);
            break;
        }
        if (element.type === MI_MATRIX) {
            try {
                variables.push(parseMatrix(data, element, endian));
            } catch (error) {
                warnings.push(`Unable to decode matrix at byte ${offset}: ${error instanceof Error ? error.message : 'unknown error'}.`);
            }
        } else if (element.type === MI_COMPRESSED) {
            stats.compressed++;
            try {
                const inflated = await inflateZlib(data.subarray(element.dataOffset, element.dataOffset + element.size));
                await parseLevel5Elements(inflated, 0, inflated.length, endian, variables, warnings, stats);
            } catch (error) {
                warnings.push(`Unable to expand compressed data element at byte ${offset}: ${error instanceof Error ? error.message : 'unknown error'}.`);
            }
        } else if (element.type !== 0 || element.size !== 0) {
            stats.skipped++;
        }
        offset = element.nextOffset;
    }
}

function parseMatrix(data: Uint8Array, element: DataElement, endian: Endian): MatVariable {
    let cursor = element.dataOffset;
    const end = Math.min(element.dataOffset + element.size, data.length);
    const flags = nextElement(data, cursor, endian, end);
    if (!flags) throw new Error('missing array flags');
    cursor = flags.nextOffset;
    const flagValue = flags.size >= 4 ? readUInt32(data, flags.dataOffset, endian) : 0;
    const classId = flagValue & 0xff;

    const dimensionsElement = nextElement(data, cursor, endian, end);
    if (!dimensionsElement) throw new Error('missing dimensions');
    cursor = dimensionsElement.nextOffset;
    const dimensions: number[] = [];
    for (let i = 0; i + 4 <= dimensionsElement.size; i += 4) dimensions.push(readInt32(data, dimensionsElement.dataOffset + i, endian));

    const nameElement = nextElement(data, cursor, endian, end);
    if (!nameElement) throw new Error('missing variable name');
    cursor = nameElement.nextOffset;
    const name = decodeElementText(data, nameElement, endian);
    const valueElement = nextElement(data, cursor, endian, end);

    return {
        name,
        className: MX_CLASSES[classId] || `mxCLASS${classId}`,
        dimensions,
        dataType: valueElement ? MI_TYPES[valueElement.type] || `miTYPE${valueElement.type}` : '-',
        bytes: element.size,
        preview: valueElement ? previewElement(data, valueElement, endian, classId, dimensions) : '',
        attributes: matrixAttributes(flagValue)
    };
}

function parseLevel4(data: Uint8Array, fileSize: string): MatDocument {
    const variants = (['LE', 'BE'] as Endian[]).map(endian => {
        const result = tryParseLevel4(data, endian);
        return { ...result, endian, score: result.variables.length * 100 - result.warnings.length * 10 };
    });
    const best = variants.sort((a, b) => b.score - a.score)[0]!;
    const warnings = [...best.warnings];
    if (best.variables.length === 0) warnings.push('No MAT v4 matrix records were decoded. The file may be corrupt or use an unsupported private extension.');
    return makeClassicDocument('MAT v4', 'MATLAB Level 4 MAT-file', fileSize, best.variables, [
        { label: 'MAT version', value: '4' },
        { label: 'Endian', value: best.endian === 'LE' ? 'little' : 'big' },
        { label: 'Variables', value: best.variables.length }
    ], hexPreview(data), data, warnings);
}

function tryParseLevel4(data: Uint8Array, endian: Endian): { variables: MatVariable[]; warnings: string[] } {
    const variables: MatVariable[] = [];
    const warnings: string[] = [];
    let offset = 0;
    while (offset + 20 <= data.length && variables.length < MAX_VARIABLES) {
        const type = readInt32(data, offset, endian);
        const rows = readInt32(data, offset + 4, endian);
        const cols = readInt32(data, offset + 8, endian);
        const imagf = readInt32(data, offset + 12, endian);
        const nameLength = readInt32(data, offset + 16, endian);
        if (rows < 0 || cols < 0 || nameLength <= 0 || nameLength > 4096 || imagf < 0 || imagf > 1) {
            if (offset === 0) warnings.push('Header values did not look like MAT v4 records.');
            break;
        }
        const nameOffset = offset + 20;
        const dataOffset = nameOffset + nameLength;
        if (dataOffset > data.length) { warnings.push(`Stopped at byte ${offset}: variable name extends beyond the file.`); break; }
        const name = latin1(data.subarray(nameOffset, dataOffset)).replace(/\0+$/g, '');
        const numericType = ((type % 10) + 10) % 10;
        const width = level4BytesPerValue(numericType);
        const valueCount = rows * cols * (imagf ? 2 : 1);
        const dataBytes = valueCount * width;
        const nextOffset = dataOffset + dataBytes;
        if (!Number.isSafeInteger(valueCount) || valueCount < 0 || nextOffset > data.length) { warnings.push(`Stopped at byte ${offset}: matrix payload extends beyond the file.`); break; }
        variables.push({
            name,
            className: level4ClassName(numericType),
            dimensions: [rows, cols],
            dataType: `MOPT ${type}`,
            bytes: 20 + nameLength + dataBytes,
            attributes: imagf ? ['complex'] : [],
            preview: previewLevel4(data, dataOffset, Math.min(rows * cols, MAX_PREVIEW_VALUES), numericType, endian)
        });
        offset = nextOffset;
    }
    return { variables, warnings };
}

function makeClassicDocument(format: MatDocument['format'], title: string, fileSize: string, variables: MatVariable[], summary: MatSummaryItem[], rawPreview: string, data: Uint8Array, warnings: string[]): MatDocument {
    return {
        format, title, fileSize, summary, variables, rawPreview, warnings,
        tables: [
            {
                title: `Variables (${variables.length})`,
                headers: ['Name', 'Class', 'Size', 'Storage', 'Bytes', 'Attributes', 'Preview'],
                rows: variables.map(variable => [variable.name || '<unnamed>', variable.className, formatDimensions(variable.dimensions), variable.dataType, variable.bytes, variable.attributes.join(', ') || '-', variable.preview || '-'])
            },
            { title: 'Header preview', headers: ['Offset', 'Hex', 'ASCII'], rows: hexRows(data.subarray(0, Math.min(data.length, 256))) }
        ]
    };
}

function isLevel5(data: Uint8Array): boolean {
    if (data.length < MAT_V5_HEADER_BYTES) return false;
    const header = latin1(data.subarray(0, 116));
    const endian = ascii(data, 126, 128);
    return /^MATLAB\s+(?:5\.0|7\.)\s+MAT-file/i.test(header) || endian === 'IM' || endian === 'MI';
}

function readElement(data: Uint8Array, offset: number, endian: Endian): DataElement | null {
    if (offset + 4 > data.length) return null;
    const raw = readUInt32(data, offset, endian);
    const smallType = readUInt16(data, offset, endian);
    const smallSize = readUInt16(data, offset + 2, endian);
    if (smallSize > 0 && smallSize <= 4 && offset + 8 <= data.length) return { type: smallType, size: smallSize, dataOffset: offset + 4, nextOffset: offset + 8 };
    if (offset + 8 > data.length) return null;
    const size = readUInt32(data, offset + 4, endian);
    // miCOMPRESSED payloads are not required to carry the usual 64-bit
    // padding; real MATLAB v7 files commonly place the next tag immediately.
    const nextOffset = raw === MI_COMPRESSED ? offset + 8 + size : align8(offset + 8 + size);
    if (!Number.isSafeInteger(nextOffset)) return null;
    return { type: raw, size, dataOffset: offset + 8, nextOffset };
}

function nextElement(data: Uint8Array, offset: number, endian: Endian, end: number): DataElement | null {
    const element = readElement(data, offset, endian);
    if (!element || element.dataOffset + element.size > data.length || element.dataOffset > end) return null;
    return element.nextOffset <= end + 8 ? element : null;
}

function previewElement(data: Uint8Array, element: DataElement, endian: Endian, classId: number, dimensions: number[]): string {
    if (classId === 4) return quotePreview(decodeElementText(data, element, endian));
    if (classId === 1 || classId === 2 || classId === 3) return `${formatDimensions(dimensions)} ${MX_CLASSES[classId]}`;
    if (classId === 5) return 'sparse matrix';
    const values = previewNumericValues(data, element, endian);
    return values.length ? values.join(', ') : `${element.size} bytes`;
}

function previewNumericValues(data: Uint8Array, element: DataElement, endian: Endian): string[] {
    const values: string[] = [];
    const end = Math.min(element.dataOffset + element.size, data.length);
    const width = bytesPerMiType(element.type);
    if (width <= 0) return values;
    for (let offset = element.dataOffset; offset + width <= end && values.length < MAX_PREVIEW_VALUES; offset += width) values.push(readNumeric(data, offset, element.type, endian));
    if ((end - element.dataOffset) / width > values.length) values.push('...');
    return values;
}

function decodeElementText(data: Uint8Array, element: DataElement, endian: Endian): string {
    const bytes = data.subarray(element.dataOffset, Math.min(element.dataOffset + element.size, data.length));
    if (element.type === MI_UTF16 || element.type === MI_UINT16) return cleanText(decodeUtf16(bytes, endian));
    if (element.type === MI_UTF32) {
        const chars: string[] = [];
        for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
            const codePoint = readUInt32(bytes, offset, endian);
            if (codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) chars.push(String.fromCodePoint(codePoint));
        }
        return cleanText(chars.join(''));
    }
    return cleanText(element.type === MI_UTF8 ? new TextDecoder().decode(bytes) : latin1(bytes));
}

function matrixAttributes(flags: number): string[] {
    const attributes: string[] = [];
    if (flags & 0x0800) attributes.push('complex');
    if (flags & 0x0400) attributes.push('global');
    if (flags & 0x0200) attributes.push('logical');
    return attributes;
}

function level4BytesPerValue(type: number): number { return [8, 4, 4, 2, 2, 1][type] ?? 8; }
function level4ClassName(type: number): string { return ['double', 'single', 'int32', 'int16', 'uint16', 'uint8'][type] ?? `type ${type}`; }

function previewLevel4(data: Uint8Array, offset: number, count: number, type: number, endian: Endian): string {
    const values: string[] = [];
    const width = level4BytesPerValue(type);
    for (let i = 0; i < count && offset + width <= data.length; i++) values.push(readLevel4Numeric(data, offset + i * width, type, endian));
    if (count >= MAX_PREVIEW_VALUES) values.push('...');
    return values.join(', ');
}

function readLevel4Numeric(data: Uint8Array, offset: number, type: number, endian: Endian): string {
    const view = viewAt(data, offset);
    const le = endian === 'LE';
    switch (type) {
    case 0: return formatNumber(view.getFloat64(0, le));
    case 1: return formatNumber(view.getFloat32(0, le));
    case 2: return String(view.getInt32(0, le));
    case 3: return String(view.getInt16(0, le));
    case 4: return String(view.getUint16(0, le));
    case 5: return String(view.getUint8(0));
    default: return '?';
    }
}

function readNumeric(data: Uint8Array, offset: number, type: number, endian: Endian): string {
    const view = viewAt(data, offset);
    const le = endian === 'LE';
    switch (type) {
    case MI_INT8: return String(view.getInt8(0));
    case MI_UINT8: return String(view.getUint8(0));
    case MI_INT16: return String(view.getInt16(0, le));
    case MI_UINT16: return String(view.getUint16(0, le));
    case MI_INT32: return String(view.getInt32(0, le));
    case MI_UINT32: return String(view.getUint32(0, le));
    case MI_SINGLE: return formatNumber(view.getFloat32(0, le));
    case MI_DOUBLE: return formatNumber(view.getFloat64(0, le));
    case MI_INT64: return String(view.getBigInt64(0, le));
    case MI_UINT64: return String(view.getBigUint64(0, le));
    default: return '?';
    }
}

function bytesPerMiType(type: number): number {
    if (type === MI_INT8 || type === MI_UINT8 || type === MI_UTF8) return 1;
    if (type === MI_INT16 || type === MI_UINT16 || type === MI_UTF16) return 2;
    if (type === MI_INT32 || type === MI_UINT32 || type === MI_SINGLE || type === MI_UTF32) return 4;
    if (type === MI_DOUBLE || type === MI_INT64 || type === MI_UINT64) return 8;
    return 0;
}

function viewAt(data: Uint8Array, offset: number): DataView { return new DataView(data.buffer, data.byteOffset + offset, data.byteLength - offset); }
function readUInt16(data: Uint8Array, offset: number, endian: Endian): number { return viewAt(data, offset).getUint16(0, endian === 'LE'); }
function readInt32(data: Uint8Array, offset: number, endian: Endian): number { return viewAt(data, offset).getInt32(0, endian === 'LE'); }
function readUInt32(data: Uint8Array, offset: number, endian: Endian): number { return viewAt(data, offset).getUint32(0, endian === 'LE'); }
function align8(value: number): number { return Math.ceil(value / 8) * 8; }
function formatDimensions(dimensions: number[]): string { return dimensions.length ? dimensions.join(' × ') : 'scalar'; }
function formatNumber(value: number): string { return Number.isFinite(value) ? Number(value.toPrecision(8)).toString() : String(value); }
function cleanText(value: string): string { return value.replace(/\0+$/g, '').trim(); }
function quotePreview(value: string): string { const single = value.replace(/\s+/g, ' ').trim(); return single ? `"${single.length > 120 ? `${single.slice(0, 120)}...` : single}"` : ''; }
function matchesBytes(data: Uint8Array, signature: readonly number[]): boolean { return data.length >= signature.length && signature.every((byte, index) => data[index] === byte); }
function findHdf5SignatureOffset(data: Uint8Array): number {
    let offset = 0;
    while (offset + HDF5_SIGNATURE.length <= data.length) {
        if (matchesBytes(data.subarray(offset), HDF5_SIGNATURE)) return offset;
        offset = offset === 0 ? 512 : offset * 2;
    }
    return -1;
}
async function inflateZlib(compressed: Uint8Array): Promise<Uint8Array> {
    if (typeof DecompressionStream === 'undefined') throw new Error('zlib decompression is unavailable in this environment');
    const stream = new Blob([compressed.slice()]).stream().pipeThrough(new DecompressionStream('deflate'));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_DECOMPRESSED_BLOCK_BYTES) throw new Error(`decompressed block exceeds ${MAX_DECOMPRESSED_BLOCK_BYTES} bytes`);
            chunks.push(value);
        }
    } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
}
function ascii(data: Uint8Array, start: number, end: number): string { return String.fromCharCode(...data.subarray(start, end)); }
function latin1(data: Uint8Array): string { return new TextDecoder('latin1').decode(data); }
function decodeUtf16(data: Uint8Array, endian: Endian): string {
    if (endian === 'LE') return new TextDecoder('utf-16le').decode(data);
    const swapped = new Uint8Array(data.length);
    for (let i = 0; i + 1 < data.length; i += 2) { swapped[i] = data[i + 1]!; swapped[i + 1] = data[i]!; }
    return new TextDecoder('utf-16le').decode(swapped);
}
function versionLabel(header: string): string { const match = header.match(/MATLAB\s+([0-9.]+)\s+MAT-file/i); return match ? (match[1]!.startsWith('7') ? match[1]!.replace(/\.0$/, '') : match[1]!) : '5/6/7'; }
function formatFileSize(bytes: number): string { if (bytes < 1024) return `${bytes} bytes`; const units = ['KB', 'MB', 'GB', 'TB']; let value = bytes; let unit = -1; do { value /= 1024; unit++; } while (value >= 1024 && unit < units.length - 1); return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`; }
function hexPreview(data: Uint8Array): string { return hexRows(data.subarray(0, Math.min(data.length, 256))).map(row => `${row[0]}  ${row[1]}  ${row[2]}`).join('\n'); }
function hexRows(data: Uint8Array): Array<Array<string>> {
    const rows: Array<Array<string>> = [];
    for (let offset = 0; offset < data.length; offset += 16) {
        const slice = data.subarray(offset, Math.min(offset + 16, data.length));
        const hex = Array.from(slice, byte => byte.toString(16).padStart(2, '0')).join(' ');
        const printable = Array.from(slice, byte => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('');
        rows.push([`0x${offset.toString(16).padStart(4, '0')}`, hex, printable]);
    }
    return rows;
}
