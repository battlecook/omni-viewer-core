import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseExcel } from './index.js';
import { serializeWorkbook } from './serialize.js';

const deps = { xlsx: XLSX };

/** Parse .xlsx bytes into the core model (the input to serializeWorkbook). */
function modelFrom(aoa: unknown[][], sheetName = 'Sheet1') {
    const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
    const { result } = parseExcel(bytes, deps);
    if (result.status === 'failed') throw new Error('fixture parse failed');
    return result.document;
}

/** Round-trip: model -> serializeWorkbook -> parseExcel -> model. */
function roundTrip(aoa: unknown[][], sheetName = 'Sheet1') {
    const bytes = serializeWorkbook(modelFrom(aoa, sheetName), XLSX);
    const { result } = parseExcel(bytes, deps);
    if (result.status === 'failed') throw new Error(`re-parse failed: ${result.failure.code}`);
    return result.document;
}

function cell(document: ReturnType<typeof roundTrip>, r: number, c: number) {
    return document.sheets[0]!.cells.find((x) => x.r === r && x.c === c);
}

describe('serializeWorkbook — type preservation (fixes the all-text bug)', () => {
    it('keeps numbers as numbers', () => {
        const doc = roundTrip([['n'], [42], [3.14]]);
        expect(cell(doc, 1, 0)).toMatchObject({ t: 'number', v: 42 });
        expect(cell(doc, 2, 0)).toMatchObject({ t: 'number', v: 3.14 });
    });

    it('keeps booleans as booleans', () => {
        const doc = roundTrip([['b'], [true], [false]]);
        expect(cell(doc, 1, 0)).toMatchObject({ t: 'boolean', v: true });
        expect(cell(doc, 2, 0)).toMatchObject({ t: 'boolean', v: false });
    });

    it('keeps text as text', () => {
        const doc = roundTrip([['s'], ['hello']]);
        expect(cell(doc, 1, 0)).toMatchObject({ t: 'text', v: 'hello' });
    });

    it('keeps dates as date-typed cells with the same calendar value', () => {
        const doc = roundTrip([['d'], [new Date(2020, 0, 15)]]);
        const d = cell(doc, 1, 0)!;
        expect(d.t).toBe('date');
        expect(d.v).toBe('2020-01-15');
    });

    it('round-trips a mixed-type row without stringifying anything', () => {
        const doc = roundTrip([['n', 's', 'b', 'd'], [7, 'x', true, new Date(2021, 5, 1)]]);
        expect(cell(doc, 1, 0)?.t).toBe('number');
        expect(cell(doc, 1, 1)?.t).toBe('text');
        expect(cell(doc, 1, 2)?.t).toBe('boolean');
        expect(cell(doc, 1, 3)?.t).toBe('date');
    });
});

describe('serializeWorkbook — structure', () => {
    it('preserves multiple sheets and their names', () => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['one'], [1]]), 'First');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['two'], [2]]), 'Second');
        const { result } = parseExcel(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })), deps);
        if (result.status === 'failed') throw new Error('fixture failed');

        const bytes = serializeWorkbook(result.document, XLSX);
        const out = parseExcel(bytes, deps).result;
        if (out.status === 'failed') throw new Error('re-parse failed');
        expect(out.document.sheetNames).toEqual(['First', 'Second']);
    });

    it('produces a readable workbook for an empty model', () => {
        const bytes = serializeWorkbook({ sheetNames: [], sheets: [], date1904: false }, XLSX);
        const { result } = parseExcel(bytes, deps);
        expect(result.status).not.toBe('failed');
    });
});
