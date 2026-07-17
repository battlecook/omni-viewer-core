const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_START_NAMESPACE_TYPE = 0x0100;
const RES_XML_END_NAMESPACE_TYPE = 0x0101;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const NO_INDEX = 0xffffffff;

interface BinaryXmlAttribute { namespaceUri: string | null; name: string; value: string; }
interface BinaryXmlElement { namespaceUri: string | null; name: string; attributes: BinaryXmlAttribute[]; }
interface StringPool { strings: string[]; }
interface ChunkHeader { type: number; headerSize: number; size: number; }
export interface DecodedArchivePreview { content: string; }

class Reader {
    readonly view: DataView;
    constructor(readonly bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
    u8(offset: number): number | undefined { return offset < this.bytes.length ? this.view.getUint8(offset) : undefined; }
    u16(offset: number): number | undefined { return offset + 2 <= this.bytes.length ? this.view.getUint16(offset, true) : undefined; }
    u32(offset: number): number | undefined { return offset + 4 <= this.bytes.length ? this.view.getUint32(offset, true) : undefined; }
}

export function tryDecodeArchiveEntryPreview(entryPath: string, bytes: Uint8Array): DecodedArchivePreview | null {
    if (!entryPath.toLocaleLowerCase().endsWith('.xml')) return null;
    const reader = new Reader(bytes);
    const xml = readChunkHeader(reader, 0);
    if (!xml || xml.type !== RES_XML_TYPE || xml.headerSize < 8 || xml.size > bytes.length || readChunkHeader(reader, xml.headerSize)?.type !== RES_STRING_POOL_TYPE) return null;
    const stringPool = parseStringPool(reader);
    if (!stringPool) return null;

    const namespaceStack = new Map<string, string[]>();
    const prefixByUri = new Map<string, string>();
    const pendingNamespaces = new Map<string, string>();
    const elements: BinaryXmlElement[] = [];
    const lines = ['<?xml version="1.0" encoding="utf-8"?>'];
    let offset = xml.headerSize;
    while (offset + 8 <= bytes.length) {
        const chunk = readChunkHeader(reader, offset);
        if (!chunk || chunk.size <= 0 || offset + chunk.size > bytes.length) return null;
        if (chunk.type === RES_XML_START_NAMESPACE_TYPE || chunk.type === RES_XML_END_NAMESPACE_TYPE) {
            if (!parseNamespace(reader, offset, stringPool, namespaceStack, prefixByUri, pendingNamespaces, chunk.type === RES_XML_START_NAMESPACE_TYPE)) return null;
        } else if (chunk.type === RES_XML_START_ELEMENT_TYPE) {
            const element = parseStartElement(reader, offset, chunk, stringPool);
            if (!element) return null;
            const parts = [qualifyName(element.namespaceUri, element.name, prefixByUri)];
            const declarations = [...pendingNamespaces].map(([uri, prefix]) => prefix ? `xmlns:${prefix}="${escapeXml(uri)}"` : `xmlns="${escapeXml(uri)}"`);
            pendingNamespaces.clear();
            parts.push(...declarations, ...element.attributes.map(attribute => `${qualifyName(attribute.namespaceUri, attribute.name, prefixByUri)}="${escapeXml(attribute.value)}"`));
            lines.push(`${'  '.repeat(elements.length)}<${parts.join(' ')}>`);
            elements.push(element);
        } else if (chunk.type === RES_XML_END_ELEMENT_TYPE) {
            const element = parseEndElement(reader, offset, stringPool);
            if (!element) return null;
            const current = elements.pop();
            if (current && (current.name !== element.name || current.namespaceUri !== element.namespaceUri)) return null;
            lines.push(`${'  '.repeat(elements.length)}</${qualifyName(element.namespaceUri, element.name, prefixByUri)}>`);
        }
        offset += chunk.size;
    }
    return lines.length > 1 ? { content: lines.join('\n') } : null;
}

function parseStringPool(reader: Reader): StringPool | null {
    const start = 8; const header = readChunkHeader(reader, start);
    if (!header || header.type !== RES_STRING_POOL_TYPE || header.headerSize < 28 || start + header.size > reader.bytes.length) return null;
    const count = reader.u32(start + 8); const flags = reader.u32(start + 16); const stringsStart = reader.u32(start + 20);
    if (count === undefined || flags === undefined || stringsStart === undefined || count > (header.size - header.headerSize) / 4) return null;
    const utf8 = (flags & 0x100) !== 0; const strings: string[] = [];
    for (let index = 0; index < count; index++) {
        const relative = reader.u32(start + header.headerSize + index * 4);
        if (relative === undefined) return null;
        const absolute = start + stringsStart + relative;
        if (absolute >= start + header.size) return null;
        const value = utf8 ? readUtf8String(reader, absolute, start + header.size) : readUtf16String(reader, absolute, start + header.size);
        if (value === null) return null;
        strings.push(value);
    }
    return { strings };
}

function readUtf8String(reader: Reader, offset: number, limit: number): string | null {
    const chars = readLength8(reader, offset); if (!chars) return null;
    const bytes = readLength8(reader, offset + chars[1]); if (!bytes) return null;
    const start = offset + chars[1] + bytes[1]; const end = start + bytes[0];
    return end <= limit ? new TextDecoder().decode(reader.bytes.subarray(start, end)) : null;
}

function readUtf16String(reader: Reader, offset: number, limit: number): string | null {
    const length = readLength16(reader, offset); if (!length) return null;
    const start = offset + length[1]; const end = start + length[0] * 2;
    return end <= limit ? new TextDecoder('utf-16le').decode(reader.bytes.subarray(start, end)) : null;
}

function readLength8(reader: Reader, offset: number): [number, number] | null {
    const first = reader.u8(offset); if (first === undefined) return null;
    if ((first & 0x80) === 0) return [first, 1];
    const second = reader.u8(offset + 1); return second === undefined ? null : [((first & 0x7f) << 8) | second, 2];
}

function readLength16(reader: Reader, offset: number): [number, number] | null {
    const first = reader.u16(offset); if (first === undefined) return null;
    if ((first & 0x8000) === 0) return [first, 2];
    const second = reader.u16(offset + 2); return second === undefined ? null : [((first & 0x7fff) << 16) | second, 4];
}

function parseNamespace(reader: Reader, offset: number, pool: StringPool, stack: Map<string, string[]>, prefixes: Map<string, string>, pending: Map<string, string>, start: boolean): boolean {
    const prefixIndex = reader.u32(offset + 16); const uriIndex = reader.u32(offset + 20);
    if (prefixIndex === undefined || uriIndex === undefined) return false;
    const prefix = getString(pool, prefixIndex) ?? ''; const uri = getString(pool, uriIndex);
    if (!uri) return true;
    if (start) { const values = stack.get(uri) ?? []; values.push(prefix); stack.set(uri, values); prefixes.set(uri, prefix); pending.set(uri, prefix); }
    else { const values = stack.get(uri); values?.pop(); if (!values?.length) { stack.delete(uri); prefixes.delete(uri); pending.delete(uri); } else prefixes.set(uri, values[values.length - 1]!); }
    return true;
}

function parseStartElement(reader: Reader, offset: number, header: ChunkHeader, pool: StringPool): BinaryXmlElement | null {
    const namespaceIndex = reader.u32(offset + 16); const nameIndex = reader.u32(offset + 20);
    const attributeStart = reader.u16(offset + 24); const attributeSize = reader.u16(offset + 26); const count = reader.u16(offset + 28);
    if (header.headerSize < 16 || namespaceIndex === undefined || nameIndex === undefined || attributeStart === undefined || attributeSize === undefined || count === undefined || attributeSize < 20) return null;
    const name = getString(pool, nameIndex); if (!name) return null;
    const attributes: BinaryXmlAttribute[] = []; let position = offset + 16 + attributeStart;
    for (let index = 0; index < count; index++, position += attributeSize) {
        if (position + attributeSize > offset + header.size) return null;
        const namespace = reader.u32(position); const attributeName = reader.u32(position + 4); const raw = reader.u32(position + 8); const type = reader.u8(position + 15); const data = reader.u32(position + 16);
        if (namespace === undefined || attributeName === undefined || raw === undefined || type === undefined || data === undefined) return null;
        const resolvedName = getString(pool, attributeName); if (!resolvedName) return null;
        attributes.push({ namespaceUri: getString(pool, namespace), name: resolvedName, value: formatTypedValue(type, data, getString(pool, raw), pool) });
    }
    return { namespaceUri: getString(pool, namespaceIndex), name, attributes };
}

function parseEndElement(reader: Reader, offset: number, pool: StringPool): BinaryXmlElement | null {
    const namespace = reader.u32(offset + 16); const nameIndex = reader.u32(offset + 20);
    if (namespace === undefined || nameIndex === undefined) return null;
    const name = getString(pool, nameIndex); return name ? { namespaceUri: getString(pool, namespace), name, attributes: [] } : null;
}

function formatTypedValue(type: number, data: number, raw: string | null, pool: StringPool): string {
    if (raw) return raw;
    switch (type) {
        case 0x00: return '';
        case 0x01: return `@0x${data.toString(16).padStart(8, '0')}`;
        case 0x02: return `?0x${data.toString(16).padStart(8, '0')}`;
        case 0x03: return getString(pool, data) ?? '';
        case 0x04: return String(bitsToFloat(data));
        case 0x05: return formatComplex(data, ['px','dp','sp','pt','in','mm']);
        case 0x06: return formatComplex(data, ['%','%p']);
        case 0x10: return String(data | 0);
        case 0x11: return `0x${data.toString(16)}`;
        case 0x12: return data ? 'true' : 'false';
        case 0x1c: case 0x1d: case 0x1e: case 0x1f: return `#${data.toString(16).padStart(8, '0')}`;
        default: return `0x${data.toString(16)}`;
    }
}

function bitsToFloat(data: number): number { const view = new DataView(new ArrayBuffer(4)); view.setUint32(0, data, true); return view.getFloat32(0, true); }
function formatComplex(data: number, units: string[]): string { const mantissa = (data & 0xffffff00) >> 8; const radix = (data >> 4) & 3; return `${mantissa * ([1 / 2 ** 23, 1 / 2 ** 15, 1 / 2 ** 7, 1][radix] ?? 1)}${units[data & 0xf] ?? ''}`; }
function qualifyName(uri: string | null, name: string, prefixes: Map<string, string>): string { const prefix = uri ? prefixes.get(uri) : undefined; return prefix ? `${prefix}:${name}` : name; }
function getString(pool: StringPool, index: number): string | null { return index === NO_INDEX ? null : pool.strings[index] ?? null; }
function readChunkHeader(reader: Reader, offset: number): ChunkHeader | null { const type = reader.u16(offset); const headerSize = reader.u16(offset + 2); const size = reader.u32(offset + 4); return type === undefined || headerSize === undefined || size === undefined ? null : { type, headerSize, size }; }
function escapeXml(value: string): string { return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;'); }
