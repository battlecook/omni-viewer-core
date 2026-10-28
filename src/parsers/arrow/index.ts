import type * as Arrow from 'apache-arrow';
import { DEFAULT_LIMITS, LimitTracker, utf8ByteLength, type Diagnostic, type ParseFailure, type ParseOptions, type ParseOutcome, type ParseResult } from '../types.js';

export const ARROW_INPUT_OWNERSHIP = 'borrows' as const;
export const ARROW_PREVIEW_ROWS = 10_000;
export const ARROW_MAGIC_PREFIX = [0x41, 0x52, 0x52, 0x4f, 0x57, 0x31] as const;

export type ArrowCell = null | boolean | number | string | ArrowCell[] | { [key: string]: ArrowCell };
export interface ArrowField {
    name: string;
    type: string;
    nullable: boolean;
    metadata: Record<string, string>;
    children: ArrowField[];
}
export interface ArrowDocument {
    format: 'file' | 'stream';
    headers: string[];
    fields: ArrowField[];
    metadata: Record<string, string>;
    rows: ArrowCell[][];
    totalRows: number;
    loadedRows: number;
    recordBatches: number;
    compression: Array<'LZ4' | 'ZSTD'>;
    fileSizeBytes: number;
    isLimited: boolean;
}
/** The base entry has no runtime dependency imports (ADR 14). */
export interface ArrowParseDeps {
    arrow: typeof Arrow;
    /** Decode one IPC buffer into exactly expectedBytes bytes. */
    decompressLz4?: (data: Uint8Array, expectedBytes: number) => Uint8Array;
    decompressZstd?: (data: Uint8Array, expectedBytes: number) => Uint8Array;
}
export interface ArrowParseOptions extends ParseOptions {
    previewRows?: number;
    maxColumns?: number;
    maxDepth?: number;
    /** Includes nested values and binary bytes (default 1,000,000). */
    maxCells?: number;
    /** Cumulative serialized preview budget, default 16 MiB. */
    maxPreviewBytes?: number;
}

class ArrowError extends Error {
    constructor(readonly code: ParseFailure['code'], readonly key: string) { super(key); }
}
class PreviewLimit extends Error {}
const invalid = (): never => { throw new ArrowError('corrupted', 'diag.arrow.corrupted'); };
const bounded = (value: number, fallback: number): number => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;

/** JSON string byte count without allocating an escaped copy of an input value. */
function jsonStringBytes(value: string): number {
    let bytes = utf8ByteLength(value) + 2;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code === 0x22 || code === 0x5c || [8, 9, 10, 12, 13].includes(code)) bytes++;
        else if (code < 0x20) bytes += 5;
        else if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) index++;
            else bytes += 3;
        } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 3;
    }
    return bytes;
}

/** Arrow IPC file/stream and Feather V2. Input failures are ParseResults. */
export function parseArrow(input: Uint8Array, deps: ArrowParseDeps, options: ArrowParseOptions = {}): ParseOutcome<ArrowDocument> {
    const started = Date.now();
    const diagnostics: Diagnostic[] = [];
    const finish = (result: ParseResult<ArrowDocument>): ParseOutcome<ArrowDocument> => ({
        result, execution: { workerUsed: false, hardLimitEnforced: false, elapsedMillis: Date.now() - started }
    });
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    const tracker = new LimitTracker(limits, options.signal);
    const checkpoint = () => {
        const violation = tracker.checkpoint();
        if (violation) throw new ArrowError(violation.kind === 'aborted' ? 'aborted' : 'limit-exceeded', violation.kind === 'aborted' ? 'diag.aborted' : 'diag.arrow.limit');
    };
    let reader: Arrow.RecordBatchFileReader | Arrow.RecordBatchStreamReader | undefined;
    const restored: Array<() => void> = [];
    try {
        checkpoint();
        if (input.byteLength > limits.maxInputBytes) throw new ArrowError('limit-exceeded', 'diag.arrow.limit');
        if (input.length >= 4 && input[0] === 0x46 && input[1] === 0x45 && input[2] === 0x41 && input[3] === 0x31) {
            throw new ArrowError('invalid-format', 'diag.arrow.featherV1');
        }
        if (!deps?.arrow) throw new ArrowError('missing-dependency', 'diag.arrow.dependency');
        const { arrow } = deps;
        const maxDepth = bounded(options.maxDepth ?? 64, 64);
        const maxColumns = bounded(options.maxColumns ?? 1024, 1024);
        const maxDecompressed = bounded(limits.maxDecompressedBytes ?? 256 * 1024 * 1024, 256 * 1024 * 1024);
        const previewBytes = bounded(options.maxPreviewBytes ?? limits.maxPreviewBytes ?? 16 * 1024 * 1024, 16 * 1024 * 1024);
        const info = scanIpc(input, arrow, maxDecompressed, checkpoint);
        for (const kind of info.codecs) {
            const decode = kind === arrow.CompressionType.LZ4_FRAME ? deps.decompressLz4 : deps.decompressZstd;
            const previous = arrow.compressionRegistry.get(kind);
            if (!decode) throw new ArrowError('missing-dependency', 'diag.arrow.compression');
            arrow.compressionRegistry.set(kind, { decode(bytes) {
                checkpoint();
                // Arrow passes a subarray immediately after the IPC int64 prefix.
                if (bytes.byteOffset < 8) invalid();
                const size = new DataView(bytes.buffer, bytes.byteOffset - 8, 8).getBigInt64(0, true);
                if (size < 0n || size > BigInt(maxDecompressed)) throw new ArrowError('limit-exceeded', 'diag.arrow.limit');
                const result = decode(bytes, Number(size));
                if (result.byteLength !== Number(size)) invalid();
                return result;
            } });
            // The upstream registry accepts null at runtime; restore absence too.
            restored.push(() => arrow.compressionRegistry.set(kind, previous!));
        }
        reader = arrow.RecordBatchReader.from(input);
        if (!reader.isSync()) invalid();
        reader.open({ autoDestroy: false });
        if (!reader.schema) invalid();
        if (reader.isFile() && reader.numRecordBatches !== info.recordBatches) invalid();
        let fieldCount = 0, schemaBytes = 32;
        const chargeSchema = (bytes: number) => {
            schemaBytes += bytes;
            if (schemaBytes > previewBytes) throw new ArrowError('limit-exceeded', 'diag.arrow.limit');
        };
        const metadata = (entries: ReadonlyMap<string, string>) => {
            const result: Record<string, string> = Object.create(null);
            for (const [key, value] of entries) {
                chargeSchema(jsonStringBytes(key) + jsonStringBytes(value) + 2);
                Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
            }
            return result;
        };
        chargeSchema(0);
        const field = (item: Arrow.Field, depth: number): ArrowField => {
            if (depth > maxDepth || ++fieldCount > maxColumns) throw new ArrowError('limit-exceeded', 'diag.arrow.limit');
            const type = arrow.DataType.isDictionary(item.type) ? item.type.dictionary : item.type;
            const typeName = String(item.type);
            chargeSchema(80 + jsonStringBytes(item.name) + jsonStringBytes(typeName));
            return { name: item.name, type: typeName, nullable: item.nullable,
                metadata: metadata(item.metadata), children: (type.children ?? []).map((child: Arrow.Field) => field(child, depth + 1)) };
        };
        const fields = reader.schema.fields.map(item => field(item, 0));
        const document: ArrowDocument = {
            format: info.format, headers: fields.map(item => item.name), fields,
            metadata: metadata(reader.schema.metadata), rows: [], totalRows: info.totalRows,
            loadedRows: 0, recordBatches: info.recordBatches,
            compression: [...info.codecs].map(kind => kind === arrow.CompressionType.LZ4_FRAME ? 'LZ4' : 'ZSTD'),
            fileSizeBytes: input.byteLength, isLimited: false
        };
        const rowLimit = Math.min(bounded(options.previewRows ?? ARROW_PREVIEW_ROWS, ARROW_PREVIEW_ROWS), bounded(limits.maxEntries, ARROW_PREVIEW_ROWS));
        const maxCells = bounded(options.maxCells ?? 1_000_000, 1_000_000);
        let cells = 0, bytes = schemaBytes;
        const charge = (value: string) => { bytes += jsonStringBytes(value) + 4; if (bytes > previewBytes) throw new PreviewLimit(); return value; };
        const normalize = (value: unknown, type?: Arrow.DataType, depth = 0): ArrowCell => {
            // Dictionary encoding changes storage, not the logical value/depth.
            if (type && arrow.DataType.isDictionary(type)) return normalize(value, type.dictionary, depth);
            if (++cells > maxCells || depth > maxDepth || bytes > previewBytes) throw new PreviewLimit();
            bytes += 8;
            if (value == null) return null;
            if (type && arrow.DataType.isDecimal(type)) {
                const integer = String(value), negative = integer.startsWith('-'), scale = type.scale;
                if (Math.abs(scale) + integer.length > previewBytes - bytes) throw new PreviewLimit();
                const digits = integer.replace(/^-/, '');
                const padded = digits.padStart(Math.max(1, scale + 1), '0');
                return charge((negative ? '-' : '') + (scale > 0 ? `${padded.slice(0, -scale)}.${padded.slice(-scale)}` : digits + '0'.repeat(-scale)));
            }
            if (type && (arrow.DataType.isDate(type) || arrow.DataType.isTimestamp(type)) && typeof value === 'number') {
                const date = new Date(value);
                return charge(Number.isFinite(date.getTime()) ? date.toISOString() : String(value));
            }
            if (typeof value === 'bigint') return charge(value.toString());
            if (typeof value === 'string') return charge(value);
            if (typeof value === 'number') {
                if (!Number.isFinite(value)) return charge(String(value));
                bytes += Math.max(0, String(value).length - 8);
                return value;
            }
            if (typeof value === 'boolean') return value;
            if (type && arrow.DataType.isStruct(type)) {
                const entries = value as Iterable<[string, unknown]>;
                const children = type.children;
                const normalized = [...entries].map(([key, item], i): [string, ArrowCell] => [charge(key), normalize(item, children[i]?.type, depth + 1)]);
                // Arrow permits repeated field names; an object would discard values.
                return new Set(normalized.map(([key]) => key)).size === normalized.length ? Object.fromEntries(normalized) : normalized;
            }
            if (type && arrow.DataType.isMap(type)) {
                const children = type.children[0]?.type.children ?? [];
                const entries: ArrowCell[] = [];
                for (const [key, item] of value as Iterable<[unknown, unknown]>) entries.push([
                    normalize(key, children[0]?.type, depth + 1), normalize(item, children[1]?.type, depth + 1)
                ]);
                return entries;
            }
            if (typeof value === 'object' && Symbol.iterator in value) {
                const result: ArrowCell[] = [];
                const child = type?.children?.[0]?.type;
                for (const item of value as Iterable<unknown>) result.push(normalize(item, child, depth + 1));
                return result;
            }
            return charge(String(value));
        };
        let limited = bytes > previewBytes;
        try {
            if (!limited && rowLimit > 0) for (const batch of reader) {
                checkpoint();
                const vectors = fields.map((_, i) => batch.getChildAt(i));
                for (let row = 0; row < batch.numRows && document.rows.length < rowLimit; row++) {
                    checkpoint();
                    const values = vectors.map((vector, i) => normalize(vector?.get(row), reader!.schema.fields[i]?.type));
                    if (bytes > previewBytes) throw new PreviewLimit();
                    document.rows.push(values);
                }
                if (document.rows.length >= rowLimit) break;
            }
        } catch (error) { if (error instanceof PreviewLimit) limited = true; else throw error; }
        document.loadedRows = document.rows.length;
        document.isLimited = limited || document.loadedRows < document.totalRows;
        if (document.isLimited) diagnostics.push({ severity: 'warning', code: 'arrow.preview-limit', messageKey: 'diag.arrow.preview', args: { loaded: document.loadedRows, total: document.totalRows } });
        checkpoint();
        return finish({ status: document.isLimited ? 'partial' : 'ok', document, diagnostics });
    } catch (error) {
        const failure = error instanceof ArrowError ? error : new ArrowError('corrupted', 'diag.arrow.corrupted');
        return finish({ status: 'failed', failure: { code: failure.code, retryable: failure.code === 'aborted' || failure.code === 'missing-dependency', messageKey: failure.key }, diagnostics });
    } finally {
        try { reader?.cancel(); } catch { /* Malformed readers must not turn a ParseResult into a throw. */ }
        restored.reverse().forEach(restore => restore());
    }
}

/** Metadata-only pass: reject truncation and decompression bombs before decoding. */
function scanIpc(input: Uint8Array, arrow: typeof Arrow, maxDecompressed: number, checkpoint: () => void) {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const isFile = ARROW_MAGIC_PREFIX.every((byte, i) => input[i] === byte);
    let end = input.byteLength, offset = isFile ? 8 : 0;
    if (isFile) {
        if (end < 18 || !ARROW_MAGIC_PREFIX.every((byte, i) => input[end - 6 + i] === byte)) invalid();
        const footerBytes = view.getInt32(end - 10, true);
        end -= 10 + footerBytes;
        if (footerBytes <= 0 || end < 8) invalid();
    }
    let schema = false, totalRows = 0, recordBatches = 0, expanded = 0;
    const codecs = new Set<Arrow.CompressionType>();
    const blocks = new Map<number, IpcBlock>();
    while (offset < end) {
        checkpoint();
        const messageStart = offset;
        if (end - offset < 4) invalid();
        let length = view.getInt32(offset, true); offset += 4;
        if (length === -1) {
            if (end - offset < 4) invalid();
            length = view.getInt32(offset, true); offset += 4;
        }
        if (length === 0) { if (offset !== end) invalid(); break; }
        if (length < 4 || length > end - offset) invalid();
        const message = arrow.Message.decode(input.subarray(offset, offset + length));
        offset += length;
        const bodyLength = message.bodyLength;
        if (!Number.isSafeInteger(bodyLength) || bodyLength < 0 || bodyLength > end - offset) invalid();
        if (message.isSchema()) { if (schema || recordBatches || bodyLength) invalid(); schema = true; }
        else if (message.isRecordBatch() || message.isDictionaryBatch()) {
            // Some IPC file writers keep the schema only in the footer.
            if (!schema && !isFile) invalid();
            const header = message.isRecordBatch() ? message.header() : message.header().data;
            if (isFile) blocks.set(messageStart, { kind: message.isRecordBatch() ? 'record' : 'dictionary', metadataLength: offset - messageStart, bodyLength });
            if (!Number.isSafeInteger(header.length) || header.length < 0) invalid();
            if (message.isRecordBatch()) { totalRows += header.length; recordBatches++; if (!Number.isSafeInteger(totalRows)) invalid(); }
            const codec = header.compression?.type;
            if (header.compression && header.compression.method !== 0) invalid();
            if (codec !== undefined && codec !== arrow.CompressionType.LZ4_FRAME && codec !== arrow.CompressionType.ZSTD) invalid();
            if (codec !== undefined) codecs.add(codec);
            for (const buffer of header.buffers) {
                checkpoint();
                if (!Number.isSafeInteger(buffer.offset) || !Number.isSafeInteger(buffer.length) || buffer.offset < 0 || buffer.length < 0 || buffer.offset + buffer.length > bodyLength) invalid();
                let size = buffer.length;
                if (codec !== undefined && size > 0) {
                    if (size < 8) invalid();
                    const declared = view.getBigInt64(offset + buffer.offset, true);
                    if (declared < -1n) invalid();
                    if (declared > BigInt(maxDecompressed)) throw new ArrowError('limit-exceeded', 'diag.arrow.limit');
                    size = declared === -1n ? size - 8 : Number(declared);
                }
                expanded += size;
                if (expanded > maxDecompressed) throw new ArrowError('limit-exceeded', 'diag.arrow.limit');
            }
        } else invalid();
        offset += bodyLength;
    }
    if (!schema && !isFile) throw new ArrowError('invalid-format', 'diag.arrow.invalid');
    // File readers seek using the footer, including while opening dictionaries.
    // Validate those seek targets before entering the dependency's reader loops.
    if (isFile) validateFooterBlocks(input.subarray(end, input.length - 10), blocks, checkpoint);
    return { format: isFile ? 'file' as const : 'stream' as const, totalRows, recordBatches, codecs };
}

interface IpcBlock { kind: 'record' | 'dictionary'; metadataLength: number; bodyLength: number }

/** The footer stores two FlatBuffer vectors of inline 24-byte Block structs. */
function validateFooterBlocks(footer: Uint8Array, blocks: ReadonlyMap<number, IpcBlock>, checkpoint: () => void): void {
    const view = new DataView(footer.buffer, footer.byteOffset, footer.byteLength);
    const range = (position: number, bytes: number) => {
        if (!Number.isSafeInteger(position) || position < 0 || bytes < 0 || position + bytes > footer.length) invalid();
    };
    const u16 = (position: number) => { range(position, 2); return view.getUint16(position, true); };
    const u32 = (position: number) => { range(position, 4); return view.getUint32(position, true); };
    const table = u32(0);
    range(table, 4);
    const vtable = table - view.getInt32(table, true);
    const vtableBytes = u16(vtable), tableBytes = u16(vtable + 2);
    if (table < 4 || vtableBytes < 4 || vtableBytes % 2 || tableBytes < 4) invalid();
    range(vtable, vtableBytes); range(table, tableBytes);
    const seen = new Set<number>();
    for (const [slot, kind] of [[2, 'dictionary'], [3, 'record']] as const) {
        const vtableField = 4 + slot * 2;
        const field = vtableField < vtableBytes ? u16(vtable + vtableField) : 0;
        if (!field) continue;
        if (field < 4 || field + 4 > tableBytes) invalid();
        const pointer = table + field, relative = u32(pointer);
        if (relative < 4) invalid();
        const vector = pointer + relative, count = u32(vector);
        range(vector + 4, count * 24);
        if (count > blocks.size) invalid();
        for (let index = 0; index < count; index++) {
            checkpoint();
            const position = vector + 4 + index * 24;
            const offset = view.getBigInt64(position, true);
            if (offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
            const target = Number(offset), block = blocks.get(target);
            if (!block || seen.has(target) || block.kind !== kind ||
                view.getInt32(position + 8, true) !== block.metadataLength ||
                view.getBigInt64(position + 16, true) !== BigInt(block.bodyLength)) invalid();
            seen.add(target);
        }
    }
    if (seen.size !== blocks.size) invalid();
}
