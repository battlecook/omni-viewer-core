import { parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

export const PARQUET_PREVIEW_BYTES = 50 * 1024 * 1024;
export const PARQUET_PREVIEW_ROWS = 10_000;

export type ParquetCell = null | boolean | number | string | ParquetCell[] | { [key: string]: ParquetCell };

export interface ParquetDocument {
    headers: string[];
    rows: ParquetCell[][];
    schema: ParquetCell;
    totalRows: number;
    loadedRows: number;
    fileSizeBytes: number;
    isLimited: boolean;
}

export interface ParquetParseOptions { maxPreviewBytes?: number; previewRows?: number; rowStart?: number; signal?: AbortSignal }

export async function parseParquet(data: Uint8Array, options: ParquetParseOptions = {}): Promise<ParquetDocument> {
    if (options.signal?.aborted) throw new DOMException('Parsing was cancelled.', 'AbortError');
    const file = {
        byteLength: data.byteLength,
        async slice(start: number, end?: number): Promise<ArrayBuffer> {
            if (options.signal?.aborted) throw new DOMException('Parsing was cancelled.', 'AbortError');
            const part = data.subarray(start, end);
            return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) as ArrayBuffer;
        }
    };
    const metadata = await parquetMetadataAsync(file);
    const schema = parquetSchema(metadata);
    const totalRows = Number(metadata.num_rows ?? 0);
    const rowStart = Math.max(0, options.rowStart ?? 0);
    const shouldChunk = data.byteLength >= (options.maxPreviewBytes ?? PARQUET_PREVIEW_BYTES);
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
        fileSizeBytes: data.byteLength, isLimited: shouldChunk && rowStart + rows.length < totalRows };
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
