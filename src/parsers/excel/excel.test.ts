import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
    parseExcel,
    sheetToAoa,
    EXCEL_INPUT_OWNERSHIP,
    type ExcelParseDeps,
    type ExcelSheet,
    type ExcelWorkbook
} from './index.js';

const deps: ExcelParseDeps = { xlsx: XLSX };

/** Build .xlsx bytes from an array-of-arrays for a single sheet. */
function xlsxBytes(sheetName: string, aoa: unknown[][]): Uint8Array {
    const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

function okDoc(bytes: Uint8Array, options?: Parameters<typeof parseExcel>[2]): ExcelWorkbook {
    const { result } = parseExcel(bytes, deps, options);
    if (result.status === 'failed') throw new Error(`unexpected failure: ${result.failure.code}`);
    return result.document;
}

function cellAt(sheet: ExcelSheet, r: number, c: number) {
    return sheet.cells.find((cell) => cell.r === r && cell.c === c);
}

describe('parseExcel', () => {
    it('parses a single sheet into a sparse coordinate grid', () => {
        const bytes = xlsxBytes('People', [
            ['name', 'age'],
            ['alice', 30],
            ['bob', 25]
        ]);
        const doc = okDoc(bytes);

        expect(doc.sheetNames).toEqual(['People']);
        const sheet = doc.sheets[0]!;
        expect(sheet.usedRange).toEqual({ r0: 0, c0: 0, r1: 2, c1: 1 });
        expect(sheet.rowCount).toBe(3);
        expect(sheet.columnCount).toBe(2);

        expect(cellAt(sheet, 0, 0)).toMatchObject({ t: 'text', v: 'name', w: 'name' });
        expect(cellAt(sheet, 1, 0)).toMatchObject({ t: 'text', v: 'alice' });
        expect(cellAt(sheet, 1, 1)).toMatchObject({ t: 'number', v: 30, w: '30' });
        expect(cellAt(sheet, 2, 1)).toMatchObject({ t: 'number', v: 25 });
    });

    it('preserves cells row-major', () => {
        const doc = okDoc(xlsxBytes('S', [['a', 'b'], ['c', 'd']]));
        const coords = doc.sheets[0]!.cells.map((c) => `${c.r},${c.c}`);
        expect(coords).toEqual(['0,0', '0,1', '1,0', '1,1']);
    });

    it('maps value types (number / text / boolean / date)', () => {
        const bytes = xlsxBytes('Types', [
            ['n', 's', 'b', 'd'],
            [42, 'hi', true, new Date(2020, 0, 15)]
        ]);
        const sheet = okDoc(bytes).sheets[0]!;
        expect(cellAt(sheet, 1, 0)).toMatchObject({ t: 'number', v: 42 });
        expect(cellAt(sheet, 1, 1)).toMatchObject({ t: 'text', v: 'hi' });
        expect(cellAt(sheet, 1, 2)).toMatchObject({ t: 'boolean', v: true });

        const dateCell = cellAt(sheet, 1, 3)!;
        expect(dateCell.t).toBe('date');
        expect(dateCell.v).toBe('2020-01-15');
    });

    it('handles multiple sheets', () => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['one']]), 'First');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['two']]), 'Second');
        const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));

        const doc = okDoc(bytes);
        expect(doc.sheetNames).toEqual(['First', 'Second']);
        expect(doc.sheets).toHaveLength(2);
        expect(cellAt(doc.sheets[1]!, 0, 0)).toMatchObject({ v: 'two' });
    });

    it('reports an empty workbook with a diagnostic', () => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Blank');
        const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));

        const { result } = parseExcel(bytes, deps);
        expect(result.status).toBe('ok');
        expect(result.diagnostics.map((d) => d.code)).toContain('excel.empty-workbook');
    });

    it('declares consumes ownership', () => {
        expect(EXCEL_INPUT_OWNERSHIP).toBe('consumes');
    });

    it('rejects archives that declare more uncompressed data than the limit', () => {
        const bytes = xlsxBytes('S', [['a', 'b'], [1, 2]]);
        const { result, execution } = parseExcel(bytes, deps, { limits: { maxDecompressedBytes: 1 } });
        expect(result.status).toBe('failed');
        if (result.status === 'failed') {
            expect(result.failure.code).toBe('limit-exceeded');
            expect(result.failure.messageKey).toBe('diag.limit-exceeded.decompressed');
        }
        expect(execution.hardLimitEnforced).toBe(false);
    });

    it('reads merges and column/row sizes for grid mode (X3)', () => {
        const ws = XLSX.utils.aoa_to_sheet([['title', '', ''], ['a', 'b', 'c']]);
        ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }]; // A1:C1
        ws['!cols'] = [{ wpx: 120 }, { wpx: 60 }, {}];
        ws['!rows'] = [{ hpx: 40 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Grid');
        const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));

        const sheet = okDoc(bytes).sheets[0]!;
        expect(sheet.merges).toEqual([{ r0: 0, c0: 0, r1: 0, c1: 2 }]);
        expect(sheet.columnWidthsPx?.[0]).toBe(120);
        expect(sheet.columnWidthsPx?.[1]).toBe(60);
        expect(sheet.rowHeightsPx?.[0]).toBe(40);
    });

    it('reads xlsb and ods bytes (SheetJS auto-detects format)', () => {
        for (const bookType of ['xlsb', 'ods'] as const) {
            const ws = XLSX.utils.aoa_to_sheet([['name', 'age'], ['alice', 30]]);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'People');
            const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType }));
            const doc = okDoc(bytes);
            expect(cellAt(doc.sheets[0]!, 1, 1)).toMatchObject({ t: 'number', v: 30 });
        }
    });
});

describe('parseExcel limits and failures', () => {
    it('fails when input exceeds maxInputBytes', () => {
        const bytes = xlsxBytes('S', [['a']]);
        const { result } = parseExcel(bytes, deps, { limits: { maxInputBytes: 10 } });
        expect(result.status).toBe('failed');
        if (result.status === 'failed') expect(result.failure.code).toBe('limit-exceeded');
    });

    it('returns partial + limit-exceeded when cells exceed maxEntries', () => {
        const bytes = xlsxBytes('S', [
            ['a', 'b', 'c'],
            ['d', 'e', 'f'],
            ['g', 'h', 'i']
        ]);
        const { result } = parseExcel(bytes, deps, { limits: { maxEntries: 5 } });
        expect(result.status).toBe('partial');
        if (result.status !== 'failed') {
            expect(result.diagnostics.map((d) => d.code)).toContain('limit-exceeded');
            expect(result.document.sheets[0]!.cells.length).toBeLessThanOrEqual(6);
        }
    });

    it('fails as aborted when the signal is already aborted', () => {
        const bytes = xlsxBytes('S', [['a']]);
        const { result } = parseExcel(bytes, deps, { signal: AbortSignal.abort() });
        expect(result.status).toBe('failed');
        if (result.status === 'failed') expect(result.failure.code).toBe('aborted');
    });

    // SheetJS is lenient and rarely throws on arbitrary bytes, so the failure
    // mapping is exercised with a stub that throws — this pins password vs
    // invalid-format routing without depending on SheetJS internals.
    it('maps a read throw to invalid-format', () => {
        const throwing: ExcelParseDeps = {
            xlsx: { read: () => { throw new Error('bad zip'); } } as unknown as ExcelParseDeps['xlsx']
        };
        const { result } = parseExcel(xlsxBytes('S', [['a']]), throwing);
        expect(result.status).toBe('failed');
        if (result.status === 'failed') expect(result.failure.code).toBe('invalid-format');
    });

    it('maps an encryption throw to password-required (retryable)', () => {
        const throwing: ExcelParseDeps = {
            xlsx: { read: () => { throw new Error('File is password-protected'); } } as unknown as ExcelParseDeps['xlsx']
        };
        const { result } = parseExcel(xlsxBytes('S', [['a']]), throwing);
        expect(result.status).toBe('failed');
        if (result.status === 'failed') {
            expect(result.failure.code).toBe('password-required');
            expect(result.failure.retryable).toBe(true);
        }
    });
});

describe('sheetToAoa', () => {
    it('derives headers + rows and fills missing cells with empty strings', () => {
        const doc = okDoc(xlsxBytes('S', [
            ['a', 'b', 'c'],
            ['x', null, 'z']
        ]));
        const aoa = sheetToAoa(doc.sheets[0]!);
        expect(aoa.headers).toEqual(['a', 'b', 'c']);
        expect(aoa.rows).toEqual([['x', '', 'z']]);
    });

    it('treats every used row as data when hasHeader is false', () => {
        const doc = okDoc(xlsxBytes('S', [['a', 'b'], ['c', 'd']]));
        const aoa = sheetToAoa(doc.sheets[0]!, false);
        expect(aoa.headers).toEqual(['', '']);
        expect(aoa.rows).toEqual([['a', 'b'], ['c', 'd']]);
    });

    it('returns empty for a sheet with no used range', () => {
        expect(sheetToAoa({ name: 'e', usedRange: null, cells: [], rowCount: 0, columnCount: 0 }))
            .toEqual({ headers: [], rows: [] });
    });
});
