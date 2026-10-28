import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as arrow from 'apache-arrow';
import { parseArrow, type ArrowDocument, type ArrowParseOptions } from './index.js';
import { loadArrowDeps, parseSelfLoadingArrow } from './self-loading.js';

const table = () => arrow.tableFromArrays({ id: new Int32Array([3, 1, 2]), name: ['gamma', 'alpha', null], flag: [true, false, null] });
const bytes = (format: 'file' | 'stream' = 'file') => arrow.tableToIPC(table(), format);
function footerVector(data: Uint8Array, slot: number): number {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const start = data.length - 10 - view.getInt32(data.length - 10, true);
    const root = start + view.getUint32(start, true);
    const vtable = root - view.getInt32(root, true);
    const field = root + view.getUint16(vtable + 4 + slot * 2, true);
    return field + view.getUint32(field, true);
}
function document(input: Uint8Array, options: ArrowParseOptions = {}): ArrowDocument {
    const { result } = parseArrow(input, { arrow }, options);
    expect(result.status, JSON.stringify(result)).not.toBe('failed');
    if (result.status === 'failed') throw new Error(result.failure.messageKey);
    return result.document;
}

describe('Arrow IPC parser', () => {
    it.each(['file', 'stream'] as const)('reads %s with dictionary strings, booleans and nulls', format => {
        const data = bytes(format), copy = data.slice(), model = document(data);
        expect(model.format).toBe(format);
        expect(model.headers).toEqual(['id', 'name', 'flag']);
        expect(model.rows).toEqual([[3, 'gamma', true], [1, 'alpha', false], [2, null, null]]);
        expect(model.totalRows).toBe(3); expect(model.recordBatches).toBe(1);
        expect(model.isLimited).toBe(false); expect(data).toEqual(copy);
        expect(model.fields[1]?.type).toContain('Dictionary');
    });
    it('reads an unaligned subarray without mutating the input', () => {
        const ipc = bytes(), data = new Uint8Array(ipc.length + 3); data.set(ipc, 3);
        expect(document(data.subarray(3)).rows).toHaveLength(3);
    });
    it('retains empty schemas, field metadata and schema metadata', () => {
        const schema = new arrow.Schema([new arrow.Field('id', new arrow.Int32(), true, new Map([['unit', 'count']]))], new Map([['source', 'test']]));
        const model = document(arrow.tableToIPC(new arrow.Table(schema), 'file'));
        expect(model.headers).toEqual(['id']); expect(model.rows).toEqual([]);
        expect(model.metadata).toEqual({ source: 'test' }); expect(model.fields[0]?.metadata).toEqual({ unit: 'count' });
    });
    it('handles multiple record batches and reports total rows beyond preview', () => {
        const first = arrow.tableFromArrays({ id: new Int32Array([1, 2]) });
        const second = arrow.tableFromArrays({ id: new Int32Array([3, 4]) });
        const ipc = arrow.tableToIPC(first.concat(second), 'file');
        const { result } = parseArrow(ipc, { arrow }, { previewRows: 3 });
        expect(result.status).toBe('partial');
        if (result.status === 'failed') return;
        expect(result.document.rows).toEqual([[1], [2], [3]]); expect(result.document.totalRows).toBe(4);
        expect(result.document.recordBatches).toBe(2);
        expect(result.diagnostics[0]?.messageKey).toBe('diag.arrow.preview');
    });
    it('preserves 64-bit integers, scaled decimals, binary, lists, structs and maps', () => {
        const struct = new arrow.Struct([new arrow.Field('x', new arrow.Int64(), true)]);
        const mapFields = new arrow.Struct<{ key: arrow.Utf8; value: arrow.Int64 }>([new arrow.Field('key', new arrow.Utf8(), false), new arrow.Field('value', new arrow.Int64(), true)]);
        const map = new arrow.Map_<arrow.Utf8, arrow.Int64>(new arrow.Field('entries', mapFields, false));
        const data = new arrow.Table({
            id: arrow.vectorFromArray([9223372036854775807n, null], new arrow.Int64()),
            amount: arrow.vectorFromArray([new Uint32Array([12345, 0, 0, 0]), new Uint32Array([0xffffcfc7, 0xffffffff, 0xffffffff, 0xffffffff])], new arrow.Decimal(2, 20, 128)),
            blob: arrow.vectorFromArray([new Uint8Array([0, 255]), null], new arrow.Binary()),
            list: arrow.vectorFromArray([[1, 2], []], new arrow.List(new arrow.Field('item', new arrow.Int32(), true))),
            struct: arrow.vectorFromArray([{ x: 9007199254740993n }, null], struct),
            map: arrow.vectorFromArray([new Map([['a', 9007199254740993n]]), new Map()], map)
        });
        expect(document(arrow.tableToIPC(data, 'file')).rows).toEqual([
            ['9223372036854775807', '123.45', [0, 255], [1, 2], { x: '9007199254740993' }, [['a', '9007199254740993']]],
            [null, '-123.45', null, [], null, []]
        ]);
    });
    it('formats dates and timestamps as UTC ISO strings and non-finite floats explicitly', () => {
        const data = new arrow.Table({
            date: arrow.vectorFromArray([new Date('2024-01-02T00:00:00Z')], new arrow.DateDay()),
            time: arrow.vectorFromArray([new Date('2024-01-02T03:04:05.123Z')], new arrow.TimestampMillisecond()),
            nan: arrow.vectorFromArray([NaN], new arrow.Float64())
        });
        expect(document(arrow.tableToIPC(data)).rows).toEqual([['2024-01-02T00:00:00.000Z', '2024-01-02T03:04:05.123Z', 'NaN']]);
    });
    it('bounds input, columns, nested cells, rows and preview bytes', () => {
        expect(parseArrow(bytes(), { arrow }, { limits: { maxInputBytes: 1 } }).result.status).toBe('failed');
        expect(parseArrow(bytes(), { arrow }, { maxColumns: 1 }).result.status).toBe('failed');
        expect(document(bytes(), { maxCells: 4 }).loadedRows).toBe(1);
        expect(document(bytes(), { limits: { maxEntries: 1 } }).rows).toHaveLength(1);
        expect(document(bytes(), { previewRows: 0 }).loadedRows).toBe(0);
        expect(parseArrow(bytes(), { arrow }, { maxPreviewBytes: 1 }).result.status).toBe('failed');
    });
    it('applies semantic depth and value budgets equally to dictionary and plain columns', () => {
        const plain = new arrow.Table({ value: arrow.vectorFromArray(['x'], new arrow.Utf8()) });
        const dictionary = arrow.tableFromArrays({ value: ['x'] });
        for (const options of [{ maxDepth: 0 }, { maxCells: 1 }]) {
            for (const input of [plain, dictionary]) {
                const { result } = parseArrow(arrow.tableToIPC(input, 'file'), { arrow }, options);
                expect(result.status).toBe('ok');
                if (result.status !== 'failed') expect(result.document.rows).toEqual([['x']]);
            }
        }
    });
    it.each(['schema', 'field'] as const)('rejects oversized %s metadata before retaining an oversized preview', location => {
        const metadata = new Map([['large', 'x'.repeat(100_000)]]);
        const schema = new arrow.Schema([new arrow.Field('id', new arrow.Int32(), true, location === 'field' ? metadata : undefined)], location === 'schema' ? metadata : undefined);
        const outcome = parseArrow(arrow.tableToIPC(new arrow.Table(schema), 'file'), { arrow }, { maxPreviewBytes: 1000 });
        expect(outcome.result.status).toBe('failed');
        if (outcome.result.status === 'failed') expect(outcome.result.failure.code).toBe('limit-exceeded');
    });
    it('counts JSON escaping in the metadata and row preview budgets', () => {
        const schema = new arrow.Schema([new arrow.Field('id', new arrow.Int32(), true)], new Map([['escaped', '\0'.repeat(1000)]]));
        expect(parseArrow(arrow.tableToIPC(new arrow.Table(schema), 'file'), { arrow }, { maxPreviewBytes: 2000 }).result.status).toBe('failed');
        const strings = arrow.tableToIPC(arrow.tableFromArrays({ value: ['\0'.repeat(1000)] }), 'file');
        expect(document(strings, { maxPreviewBytes: 2000 }).rows).toHaveLength(0);
    });
    it('rejects footer targets, lengths and vector counts before constructing the reader', () => {
        const original = bytes();
        const recordVector = footerVector(original, 3), record = recordVector + 4;
        const dictionary = footerVector(original, 2) + 4;
        const mutations = [
            (view: DataView) => view.setBigInt64(record, view.getBigInt64(dictionary, true), true),
            (view: DataView) => view.setBigInt64(record, BigInt(original.length), true),
            (view: DataView) => view.setInt32(record + 8, view.getInt32(record + 8, true) + 8, true),
            (view: DataView) => view.setBigInt64(record + 16, view.getBigInt64(record + 16, true) + 8n, true),
            (view: DataView) => view.setUint32(recordVector, 0x7fffffff, true)
        ];
        const from = vi.spyOn(arrow.RecordBatchReader, 'from').mockImplementation(() => { throw new Error('Reader must not be entered'); });
        try {
            for (const mutate of mutations) {
                const data = original.slice(); mutate(new DataView(data.buffer));
                const result = parseArrow(data, { arrow }).result;
                expect(result.status === 'failed' && result.failure.code).toBe('corrupted');
            }
            expect(from).not.toHaveBeenCalled();
        } finally { from.mockRestore(); }
    });
    it('rejects Feather V1, invalid bytes, truncated bodies, broken footers, and pre-aborted inputs', () => {
        const old = parseArrow(new TextEncoder().encode('FEA1'), { arrow }).result;
        expect(old.status === 'failed' && old.failure.messageKey).toBe('diag.arrow.featherV1');
        for (const data of [new Uint8Array(), new Uint8Array([1, 2, 3, 4]), bytes().slice(0, -1), bytes('stream').slice(0, -12)]) expect(parseArrow(data, { arrow }).result.status).toBe('failed');
        const controller = new AbortController(); controller.abort();
        const result = parseArrow(bytes(), { arrow }, { signal: controller.signal }).result;
        expect(result.status === 'failed' && result.failure.code).toBe('aborted');
    });
    it('never throws for malformed binary inputs', () => {
        let seed = 12345;
        for (let i = 0; i < 100; i++) {
            const data = new Uint8Array(i * 3);
            for (let j = 0; j < data.length; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; data[j] = seed & 255; }
            expect(() => parseArrow(data, { arrow })).not.toThrow();
        }
    });
});

describe('PyArrow Feather V2 interoperability', () => {
    it('preserves duplicate-named struct children as ordered name/value pairs', async () => {
        const data = new Uint8Array(Buffer.from(readFileSync(new URL('./__tests__/fixtures/duplicate-fields.feather.b64', import.meta.url), 'utf8'), 'base64'));
        const { result } = await parseSelfLoadingArrow(data);
        expect(result.status).toBe('ok');
        if (result.status === 'failed') return;
        expect(result.document.rows).toEqual([[[['x', 1], ['x', 2]]], [[['x', 3], ['x', 4]]]]);
        expect(result.document.fields[0]?.children.map(field => field.name)).toEqual(['x', 'x']);
    });
    it.each(['uncompressed', 'lz4', 'zstd'] as const)('reads %s fixtures generated by Python', async compression => {
        const data = new Uint8Array(Buffer.from(readFileSync(new URL(`./__tests__/fixtures/${compression}.feather.b64`, import.meta.url), 'utf8'), 'base64'));
        const outcome = await parseSelfLoadingArrow(data);
        expect(outcome.result.status, JSON.stringify(outcome.result)).toBe('ok');
        if (outcome.result.status === 'failed') return;
        expect(outcome.result.document.rows).toEqual([
            ['9007199254740993', 'alpha', '123.45', [1, 2], { x: 7 }],
            [null, 'beta', '-0.01', [], null],
            ['-9007199254740993', null, null, null, { x: null }]
        ]);
        expect(outcome.result.document.compression).toEqual(compression === 'uncompressed' ? [] : [compression.toUpperCase()]);
        expect(outcome.result.document.metadata.source).toBe('pyarrow');
        const deps = await loadArrowDeps();
        const beforeLz4 = deps.arrow.compressionRegistry.get(deps.arrow.CompressionType.LZ4_FRAME);
        const beforeZstd = deps.arrow.compressionRegistry.get(deps.arrow.CompressionType.ZSTD);
        parseArrow(data, deps);
        expect(deps.arrow.compressionRegistry.get(deps.arrow.CompressionType.LZ4_FRAME)).toBe(beforeLz4);
        expect(deps.arrow.compressionRegistry.get(deps.arrow.CompressionType.ZSTD)).toBe(beforeZstd);
    });
    it('rejects compressed files before decoding when their declared output exceeds the cap', async () => {
        const data = new Uint8Array(Buffer.from(readFileSync(new URL('./__tests__/fixtures/lz4.feather.b64', import.meta.url), 'utf8'), 'base64'));
        const deps = await loadArrowDeps(); let decoded = false;
        const result = parseArrow(data, { ...deps, decompressLz4() { decoded = true; throw new Error('must not decode'); } }, { limits: { maxDecompressedBytes: 1 } }).result;
        expect(result.status === 'failed' && result.failure.code).toBe('limit-exceeded'); expect(decoded).toBe(false);
        const missing = parseArrow(data, { arrow }).result;
        expect(missing.status === 'failed' && missing.failure.code).toBe('missing-dependency');
    });
    it('rejects ZSTD output-size prefixes that are smaller or larger than the actual output', async () => {
        const original = new Uint8Array(Buffer.from(readFileSync(new URL('./__tests__/fixtures/zstd.feather.b64', import.meta.url), 'utf8'), 'base64'));
        const deps = await loadArrowDeps();
        const originalView = new DataView(original.buffer);
        // The first dictionary's compressed values buffer has twelve output bytes.
        expect(originalView.getBigInt64(736, true)).toBe(12n);
        for (const declared of [4n, 20n]) {
            const data = original.slice(); new DataView(data.buffer).setBigInt64(736, declared, true);
            const result = parseArrow(data, deps).result;
            expect(result.status === 'failed' && result.failure.code).toBe('corrupted');
        }
    });
});
