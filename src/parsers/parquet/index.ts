import { parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

export const PARQUET_PREVIEW_BYTES = 50 * 1024 * 1024;
export const PARQUET_PREVIEW_ROWS = 10_000;

export type ParquetCell = null | boolean | number | string | ParquetCell[] | { [key: string]: ParquetCell };

/** Raw hyparquet footer metadata, threaded back in to skip re-reading the footer. */
export type ParquetFileMetadata = Awaited<ReturnType<typeof parquetMetadataAsync>>;

export interface ParquetDocument {
    headers: string[];
    rows: ParquetCell[][];
    schema: ParquetCell;
    totalRows: number;
    loadedRows: number;
    fileSizeBytes: number;
    isLimited: boolean;
    /** Footer metadata of this parse, reusable as {@link ParquetParseOptions.metadata}. */
    fileMetadata?: ParquetFileMetadata;
}

export interface ParquetParseOptions {
    maxPreviewBytes?: number;
    previewRows?: number;
    rowStart?: number;
    signal?: AbortSignal;
    /**
     * Footer metadata from an earlier parse of the same source. Chunked loading
     * re-enters this function once per "load more", and without this every chunk
     * re-reads the footer — free for a buffer source, but a full extra round trip
     * when `slice()` is bridged to another process (DESIGN.md 메모리 규율 —
     * 랜덤액세스 입력).
     */
    metadata?: ParquetFileMetadata;
}

/**
 * Random-access source: hyparquet's `AsyncBuffer` shape. The decoder consumes it
 * natively, so a lazy host (Blob range reads, Node `fs.open/read`) can supply one
 * directly and only the footer + requested row-group pages are ever read
 * (DESIGN.md 메모리 규율 — 랜덤액세스 입력). {@link parseParquet} remains the
 * compatibility entry point for callers that already hold the whole file.
 */
export interface ParquetSource {
    byteLength: number;
    slice(start: number, end?: number): ArrayBuffer | Promise<ArrayBuffer>;
}

/** Parses from a fully in-memory buffer. Wraps the bytes into a {@link ParquetSource}. */
export async function parseParquet(data: Uint8Array, options: ParquetParseOptions = {}): Promise<ParquetDocument> {
    const source: ParquetSource = {
        byteLength: data.byteLength,
        slice(start, end) {
            const part = data.subarray(start, end);
            return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) as ArrayBuffer;
        }
    };
    return parseParquetSource(source, options);
}

/** Parses from a random-access source, materializing only the footer + preview pages. */
export async function parseParquetSource(source: ParquetSource, options: ParquetParseOptions = {}): Promise<ParquetDocument> {
    if (options.signal?.aborted) throw new DOMException('Parsing was cancelled.', 'AbortError');
    const file = options.signal ? withAbort(source, options.signal) : source;
    const metadata = options.metadata ?? await parquetMetadataAsync(file);
    const schema = parquetSchema(metadata);
    const totalRows = Number(metadata.num_rows ?? 0);
    const rowStart = Math.max(0, options.rowStart ?? 0);
    const shouldChunk = source.byteLength >= (options.maxPreviewBytes ?? PARQUET_PREVIEW_BYTES);
    const readOptions: Parameters<typeof parquetReadObjects>[0] = { file, metadata, compressors };
    if (shouldChunk) {
        readOptions.rowStart = rowStart;
        readOptions.rowEnd = rowStart + (options.previewRows ?? PARQUET_PREVIEW_ROWS);
    }
    const objects = await parquetReadObjects(readOptions);
    if (options.signal?.aborted) throw new DOMException('Parsing was cancelled.', 'AbortError');
    const headers = objects[0] ? Object.keys(objects[0]) : extractColumnNames(schema);
    if (headers.length === 0) throw new Error('Could not extract column names from Parquet file.');
    const types = collectColumnTypes(schema);
    const rows = objects.map((row) => headers.map((header) => convertValue(row[header], types.get(header))));
    return { headers, rows, schema: convertValue(schema), totalRows, loadedRows: rows.length,
        fileSizeBytes: source.byteLength, isLimited: shouldChunk && rowStart + rows.length < totalRows, fileMetadata: metadata };
}

/** Wraps a source so each range read observes cancellation (parity with the buffer path). */
function withAbort(source: ParquetSource, signal: AbortSignal): ParquetSource {
    return {
        byteLength: source.byteLength,
        slice(start, end) {
            if (signal.aborted) throw new DOMException('Parsing was cancelled.', 'AbortError');
            return source.slice(start, end);
        }
    };
}

interface ColumnType { logicalType?: string; convertedType?: string }
function convertValue(value: unknown, type?: ColumnType): ParquetCell {
    if (value == null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value as ParquetCell;
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Date) return type?.logicalType === 'DATE' || type?.convertedType === 'DATE'
        ? value.toISOString().slice(0, 10) : value.toISOString();
    if (value instanceof Uint8Array) return Array.from(value) as unknown as ParquetCell;
    if (Array.isArray(value)) return value.map((item) => convertValue(item));
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convertValue(v)]));
    return String(value);
}
function extractColumnNames(node: any): string[] {
    if (!node) return [];
    const children = Array.isArray(node.children) ? node.children : [];
    if (!children.length && node.element?.name) return [node.path?.length ? node.path.join('.') : node.element.name];
    return children.flatMap(extractColumnNames);
}
function collectColumnTypes(node: any, out = new Map<string, ColumnType>()): Map<string, ColumnType> {
    const children = Array.isArray(node?.children) ? node.children : [];
    if (!children.length && node?.element?.name) out.set(node.path?.length ? node.path.join('.') : node.element.name,
        { logicalType: node.element.logical_type?.type, convertedType: node.element.converted_type });
    children.forEach((child: any) => collectColumnTypes(child, out));
    return out;
}
