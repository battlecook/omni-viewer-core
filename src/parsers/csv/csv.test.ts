import { describe, expect, it } from 'vitest';
import {
    parseCsv,
    serializeRowsToCsv,
    detectDelimiter,
    nextSortState,
    detectColumnType,
    applySort,
    parseDateKey,
    naturalCompare,
    computeStatistics,
    serializeRowsToTsv,
    serializeRowsToJson,
    formatStatNumber,
    formatPercent
} from './index.js';

const enc = new TextEncoder();

function okDoc(input: string | Uint8Array, options?: Parameters<typeof parseCsv>[1]) {
    const { result } = parseCsv(input, options);
    if (result.status === 'failed') {
        throw new Error(`unexpected failure: ${result.failure.code}`);
    }
    return result.document;
}

describe('parseCsv', () => {
    it('parses headers and rows', () => {
        const doc = okDoc('name,age\nalice,30\nbob,25\n');
        expect(doc.headers).toEqual(['name', 'age']);
        expect(doc.rows).toEqual([
            ['alice', '30'],
            ['bob', '25']
        ]);
        expect(doc.columnCount).toBe(2);
    });

    it('accepts Uint8Array input with BOM', () => {
        const doc = okDoc(enc.encode('﻿a,b\n1,2\n'));
        expect(doc.headers).toEqual(['a', 'b']);
        expect(doc.rows).toEqual([['1', '2']]);
    });

    it('handles quoted fields with embedded delimiter, newline, and ""', () => {
        const doc = okDoc('a,b\n"x,y","line1\nline2"\n"he said ""hi""",z\n');
        expect(doc.rows).toEqual([
            ['x,y', 'line1\nline2'],
            ['he said "hi"', 'z']
        ]);
    });

    it('normalizes CRLF and CR line endings', () => {
        const doc = okDoc('a,b\r\n1,2\r3,4\r\n');
        expect(doc.rows).toEqual([
            ['1', '2'],
            ['3', '4']
        ]);
    });

    it('pads ragged rows (longest row raises columnCount) and reports a diagnostic', () => {
        const { result } = parseCsv('a,b,c\n1,2\n1,2,3,4\n');
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;
        // columnCount = max(headers, rows) = 4 → headers padded, short row padded.
        expect(result.document.headers).toEqual(['a', 'b', 'c', 'Column 4']);
        expect(result.document.rows).toEqual([
            ['1', '2', '', ''],
            ['1', '2', '3', '4']
        ]);
        const ragged = result.diagnostics.find((d) => d.code === 'csv.ragged-rows');
        expect(ragged?.args).toEqual({ count: 1 });
    });

    it('auto-detects semicolon and tab delimiters', () => {
        expect(okDoc('a;b;c\n1;2;3\n4;5;6\n').delimiter).toBe(';');
        expect(okDoc('a\tb\n1\t2\n').delimiter).toBe('\t');
    });

    it('uses the .tsv extension shortcut', () => {
        const doc = okDoc('a\tb\n1\t2\n', { fileName: 'data.TSV' });
        expect(doc.detection).toEqual({ delimiter: '\t', confidence: 1, source: 'extension' });
    });

    it('honors a delimiter override', () => {
        const doc = okDoc('a|b\n1|2\n', { delimiter: '|' });
        expect(doc.detection.source).toBe('override');
        expect(doc.rows).toEqual([['1', '2']]);
    });

    it('generates headers when hasHeader is false', () => {
        const doc = okDoc('1,2\n3,4\n', { hasHeader: false });
        expect(doc.headers).toEqual(['Column 1', 'Column 2']);
        expect(doc.rows.length).toBe(2);
    });

    it('returns partial with a limit diagnostic when maxEntries is hit', () => {
        const lines = ['h'];
        for (let i = 0; i < 100; i++) lines.push(String(i));
        const { result } = parseCsv(lines.join('\n'), { limits: { maxEntries: 10 } });
        expect(result.status).toBe('partial');
        if (result.status !== 'partial') return;
        expect(result.document.rows.length).toBeLessThan(100);
        expect(result.diagnostics.some((d) => d.code === 'limit-exceeded')).toBe(true);
    });

    it('fails with limit-exceeded when input bytes exceed the cap', () => {
        const { result } = parseCsv(enc.encode('a,b\n1,2\n'), {
            limits: { maxInputBytes: 4 }
        });
        expect(result.status).toBe('failed');
        if (result.status !== 'failed') return;
        expect(result.failure.code).toBe('limit-exceeded');
    });

    it('enforces maxInputBytes for string inputs too (UTF-8 byte length)', () => {
        // '😀😀' is 2 UTF-16 code units each but 4 UTF-8 bytes each.
        const { result } = parseCsv('😀😀', { limits: { maxInputBytes: 7 } });
        expect(result.status).toBe('failed');
        if (result.status !== 'failed') return;
        expect(result.failure.code).toBe('limit-exceeded');
        expect(parseCsv('😀😀', { limits: { maxInputBytes: 8 } }).result.status).toBe('ok');
    });

    it('applies maxEntries to a final record without a trailing newline', () => {
        const { result } = parseCsv('a', {
            hasHeader: false,
            limits: { maxEntries: 0 }
        });
        expect(result.status).toBe('partial');
        if (result.status !== 'partial') return;
        expect(result.diagnostics.some((d) => d.code === 'limit-exceeded')).toBe(true);
    });

    it('fails with aborted when the signal is already aborted', () => {
        const controller = new AbortController();
        controller.abort();
        const { result } = parseCsv('a,b\n1,2\n', { signal: controller.signal });
        expect(result.status).toBe('failed');
        if (result.status !== 'failed') return;
        expect(result.failure.code).toBe('aborted');
        expect(result.failure.retryable).toBe(true);
    });

    it('is deterministic: same input, identical result object', () => {
        const input = 'a;b\n1;2\n"x;y";3\nbad,row\n';
        const a = parseCsv(input).result;
        const b = parseCsv(input).result;
        expect(a).toEqual(b);
    });

    it('handles an empty file', () => {
        const doc = okDoc('');
        expect(doc.headers).toEqual([]);
        expect(doc.rows).toEqual([]);
    });
});

describe('detectDelimiter', () => {
    it('prefers the consistent delimiter over a one-line outlier', () => {
        const text = 'a,b\nc,d\ne,f\ng,h\nx|y|z|w|v|u|t|s|r\n';
        expect(detectDelimiter(text).delimiter).toBe(',');
    });

    it('ignores delimiters inside quoted spans', () => {
        const text = '"a;b";c\n"d;e";f\n';
        expect(detectDelimiter(text).delimiter).toBe(';');
    });

    it('falls back to comma with confidence 0 for a single column', () => {
        expect(detectDelimiter('one\ntwo\n')).toEqual({ delimiter: ',', confidence: 0 });
    });
});

describe('sort', () => {
    it('cycles asc -> desc -> none and restarts on a new column', () => {
        let s = nextSortState({ columnIndex: null, direction: null }, 0);
        expect(s).toEqual({ columnIndex: 0, direction: 'asc' });
        s = nextSortState(s, 0);
        expect(s).toEqual({ columnIndex: 0, direction: 'desc' });
        s = nextSortState(s, 0);
        expect(s).toEqual({ columnIndex: null, direction: null });
        s = nextSortState({ columnIndex: 0, direction: 'asc' }, 2);
        expect(s).toEqual({ columnIndex: 2, direction: 'asc' });
    });

    it('detects column types deterministically', () => {
        expect(detectColumnType(['1', '2.5', '-3'])).toBe('number');
        expect(detectColumnType(['2024-01-02', '2023-12-31'])).toBe('date');
        expect(detectColumnType(['2024-01-02', 'not a date'])).toBe('text');
        expect(detectColumnType(['1234', 'abc'])).toBe('text');
        expect(detectColumnType(['', '  '])).toBe('text');
    });

    it('parseDateKey handles ISO shapes and rejects garbage', () => {
        expect(parseDateKey('2024-01-02')).toBe(Date.UTC(2024, 0, 2));
        expect(parseDateKey('2024/01/02')).toBe(Date.UTC(2024, 0, 2));
        expect(parseDateKey('2024-01-02T03:04:05')).toBe(Date.UTC(2024, 0, 2, 3, 4, 5));
        expect(parseDateKey('2024-01-02 03:04:05.250Z')).toBe(
            Date.UTC(2024, 0, 2, 3, 4, 5, 250)
        );
        expect(parseDateKey('2024-01-02T00:00+09:00')).toBe(
            Date.UTC(2024, 0, 1, 15, 0)
        );
        expect(parseDateKey('1234')).toBeNull();
        expect(parseDateKey('01/02/2024')).toBeNull();
        expect(parseDateKey('2024-13-01')).toBeNull();
        // Nonexistent calendar dates must not normalize (2024-02-31 != Mar 2).
        expect(parseDateKey('2024-02-31')).toBeNull();
        expect(parseDateKey('2023-02-29')).toBeNull();
        expect(parseDateKey('2024-02-29')).toBe(Date.UTC(2024, 1, 29)); // leap year
        expect(parseDateKey('2024-04-31')).toBeNull();
        // Timezone offsets outside -12:00..+14:00 (or minutes > 59) are garbage.
        expect(parseDateKey('2024-01-02T00:00+99:99')).toBeNull();
        expect(parseDateKey('2024-01-02T00:00+10:60')).toBeNull();
        expect(parseDateKey('2024-01-02T00:00+14:30')).toBeNull();
        expect(parseDateKey('2024-01-02T00:00+14:00')).toBe(
            Date.UTC(2024, 0, 1, 10, 0)
        );
        expect(parseDateKey('2024-01-02T00:00-12:45')).toBe(
            Date.UTC(2024, 0, 2, 12, 45)
        );
    });

    it('sorts numeric columns numerically with empties at the bottom', () => {
        const rows = [['10'], ['2'], [''], ['1']];
        const get = (r: number, c: number) => rows[r]?.[c] ?? '';
        const asc = applySort([0, 1, 2, 3], { columnIndex: 0, direction: 'asc' }, get);
        expect(asc).toEqual([3, 1, 0, 2]);
        const desc = applySort([0, 1, 2, 3], { columnIndex: 0, direction: 'desc' }, get);
        expect(desc).toEqual([0, 1, 3, 2]);
    });

    it('natural-compares text ("item10" after "item9")', () => {
        expect(naturalCompare('item9', 'item10')).toBeLessThan(0);
        expect(naturalCompare('Item2', 'item10')).toBeLessThan(0);
        expect(naturalCompare('a', 'a')).toBe(0);
    });

    it('is stable for equal keys', () => {
        const rows = [['x'], ['x'], ['x']];
        const get = (r: number, c: number) => rows[r]?.[c] ?? '';
        expect(applySort([0, 1, 2], { columnIndex: 0, direction: 'asc' }, get)).toEqual([
            0, 1, 2
        ]);
    });
});

describe('statistics', () => {
    it('computes per-column stats with numeric detection', () => {
        const stats = computeStatistics(
            [
                ['1', 'a'],
                ['2', ''],
                ['', 'c']
            ],
            ['n', 's']
        );
        expect(stats[0]?.numeric).toEqual({ count: 2, mean: 1.5, min: 1, max: 2 });
        expect(stats[0]?.nullCount).toBe(1);
        expect(stats[1]?.numeric).toBeNull();
        expect(stats[1]?.nullPercent).toBeCloseTo(1 / 3);
    });

    it('serializes TSV with escaping and JSON as the csv-export@1 envelope', () => {
        expect(serializeRowsToTsv([['a\tb', 'plain']], ['h1', 'h2'])).toBe(
            'h1\th2\n"a\tb"\tplain'
        );
        const meta = {
            scope: 'loaded-results',
            sourceRowsLoaded: 1,
            sourceFullyScanned: true
        } as const;
        expect(JSON.parse(serializeRowsToJson([['1', '2']], ['a', 'b'], meta))).toEqual({
            format: 'omni-viewer/csv-export@1',
            headers: ['a', 'b'],
            rows: [['1', '2']],
            metadata: meta
        });
    });

    it('serializes normalized CSV with RFC-4180 quoting per delimiter', () => {
        expect(
            serializeRowsToCsv(
                [['plain', 'has,comma', 'has "quote"', 'line\nbreak']],
                ['a', 'b', 'c', 'd'],
                ','
            )
        ).toBe('a,b,c,d\nplain,"has,comma","has ""quote""","line\nbreak"');
        // With a semicolon delimiter, commas need no quoting but semicolons do.
        expect(serializeRowsToCsv([['x,y', 'x;y']], ['h1', 'h2'], ';')).toBe(
            'h1;h2\nx,y;"x;y"'
        );
        // Round-trip: parse(serialize(doc)) preserves the cells.
        const cells = [['a,b', 'c"d', 'e\nf']];
        const text = serializeRowsToCsv(cells, ['h1', 'h2', 'h3'], ',');
        const doc = okDoc(text);
        expect(doc.rows).toEqual(cells);
    });

    it('envelope preserves duplicate and empty headers verbatim', () => {
        const parsed = JSON.parse(
            serializeRowsToJson([['kim', 'lee', '']], ['name', 'name', ''], {
                scope: 'loaded-results',
                sourceRowsLoaded: 1,
                sourceFullyScanned: true
            })
        );
        expect(parsed.headers).toEqual(['name', 'name', '']);
        expect(parsed.rows).toEqual([['kim', 'lee', '']]);
    });

    it('formats stat numbers and percents', () => {
        expect(formatStatNumber(3)).toBe('3');
        expect(formatStatNumber(1.23456)).toBe('1.2346');
        expect(formatPercent(0.5)).toBe('50%');
        expect(formatPercent(1 / 3)).toBe('33.3%');
    });
});
