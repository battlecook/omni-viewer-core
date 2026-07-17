// dBASE (.dbf) attribute table parser — the sidecar that carries per-feature
// attributes for an ESRI Shapefile. Record order matches .shp record order.

export type DbfValue = string | number | boolean | null;

export interface DbfField {
    name: string;
    /** dBASE type code: C(haracter), N(umeric), F(loat), L(ogical), D(ate)… */
    type: string;
    length: number;
    decimals: number;
}

export interface DbfTable {
    fields: DbfField[];
    records: Array<Record<string, DbfValue>>;
    recordCount: number;
    warnings: string[];
}

export interface DbfParseOptions {
    maxBytes?: number;
    maxRecords?: number;
    /** Text encoding of character fields. DBF predates Unicode; utf-8 with
     *  latin-1 fallback covers the practical corpus. */
    encoding?: string;
    signal?: AbortSignal;
}

const FIELD_DESCRIPTOR_SIZE = 32;
const HEADER_TERMINATOR = 0x0d;
const DELETED_FLAG = 0x2a;

export function parseDbf(data: Uint8Array, options: DbfParseOptions = {}): DbfTable {
    const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    const maxRecords = options.maxRecords ?? 10_000;
    if (options.signal?.aborted) throw new Error('aborted');
    if (data.byteLength > maxBytes) throw new Error(`DBF exceeds the ${maxBytes.toLocaleString()} byte limit.`);
    if (data.byteLength < 32) throw new Error('DBF header is truncated.');

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const declaredRecords = view.getUint32(4, true);
    const headerSize = view.getUint16(8, true);
    const recordSize = view.getUint16(10, true);
    if (headerSize < 33 || headerSize > data.byteLength) throw new Error('DBF header size is invalid.');
    if (recordSize < 1) throw new Error('DBF record size is invalid.');

    const decoder = createDecoder(options.encoding);
    const warnings: string[] = [];
    const fields: DbfField[] = [];
    let cursor = 32;
    while (cursor + FIELD_DESCRIPTOR_SIZE <= headerSize && data[cursor] !== HEADER_TERMINATOR) {
        const nameBytes = data.subarray(cursor, cursor + 11);
        const nul = nameBytes.indexOf(0);
        const name = decoder.decode(nameBytes.subarray(0, nul === -1 ? 11 : nul)).trim();
        fields.push({
            name: name || `FIELD_${fields.length}`,
            type: String.fromCharCode(data[cursor + 11]!),
            length: data[cursor + 16]!,
            decimals: data[cursor + 17]!
        });
        cursor += FIELD_DESCRIPTOR_SIZE;
    }
    if (fields.length === 0) throw new Error('DBF contains no field descriptors.');
    const fieldsSize = fields.reduce((sum, field) => sum + field.length, 0);
    if (fieldsSize + 1 > recordSize) warnings.push('DBF field lengths exceed the declared record size.');

    const records: Array<Record<string, DbfValue>> = [];
    let offset = headerSize;
    let truncated = false;
    while (offset + recordSize <= data.byteLength && records.length < maxRecords) {
        if (options.signal?.aborted) throw new Error('aborted');
        if (data[offset] === 0x1a) break; // EOF marker
        const deleted = data[offset] === DELETED_FLAG;
        if (!deleted) {
            const record: Record<string, DbfValue> = {};
            let at = offset + 1;
            for (const field of fields) {
                if (at + field.length > data.byteLength) { truncated = true; break; }
                record[field.name] = decodeValue(decoder.decode(data.subarray(at, at + field.length)), field);
                at += field.length;
            }
            if (truncated) break;
            records.push(record);
        }
        offset += recordSize;
    }

    if (truncated) warnings.push('DBF parsing stopped at a truncated record.');
    if (declaredRecords > maxRecords && records.length >= maxRecords) {
        warnings.push(`Attribute preview is limited to ${maxRecords.toLocaleString()} of ${declaredRecords.toLocaleString()} records.`);
    } else if (records.length < declaredRecords && !truncated) {
        warnings.push(`DBF declares ${declaredRecords.toLocaleString()} records; ${records.length.toLocaleString()} were readable.`);
    }
    return { fields, records, recordCount: declaredRecords, warnings };
}

function decodeValue(raw: string, field: DbfField): DbfValue {
    const text = raw.replace(/\0/g, '').trim();
    switch (field.type) {
        case 'N': case 'F': {
            if (!text) return null;
            const value = Number(text);
            return Number.isFinite(value) ? value : null;
        }
        case 'L':
            if (/^[YyTt]$/.test(text)) return true;
            if (/^[NnFf]$/.test(text)) return false;
            return null;
        case 'D':
            return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : (text || null);
        default:
            return text;
    }
}

function createDecoder(encoding?: string): TextDecoder {
    for (const candidate of [encoding, 'utf-8', 'latin1']) {
        if (!candidate) continue;
        try { return new TextDecoder(candidate); } catch { /* try next */ }
    }
    return new TextDecoder();
}
