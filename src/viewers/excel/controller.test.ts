import { describe, expect, it } from 'vitest';
import type { ParseResult } from '../../parsers/types.js';
import type { ExcelCell, ExcelSheet, ExcelWorkbook } from '../../parsers/excel/index.js';
import { createExcelController } from './controller.js';

/** Build an ExcelSheet from an AOA of display strings (row 0 is the header). */
function sheetFromAoa(name: string, aoa: string[][]): ExcelSheet {
    const cells: ExcelCell[] = [];
    let maxCol = 0;
    aoa.forEach((row, r) => {
        row.forEach((text, c) => {
            if (text !== '') cells.push({ r, c, t: 'text', v: text, w: text });
            if (c + 1 > maxCol) maxCol = c + 1;
        });
    });
    return {
        name,
        usedRange: aoa.length ? { r0: 0, c0: 0, r1: aoa.length - 1, c1: Math.max(0, maxCol - 1) } : null,
        cells,
        rowCount: aoa.length,
        columnCount: maxCol
    };
}

function okResult(...sheets: ExcelSheet[]): ParseResult<ExcelWorkbook> {
    return {
        status: 'ok',
        document: { sheetNames: sheets.map((s) => s.name), sheets, date1904: false },
        diagnostics: []
    };
}

const people = sheetFromAoa('People', [
    ['name', 'age'],
    ['bob', '9'],
    ['alice', '10'],
    ['carol', '2']
]);

describe('createExcelController — initial state', () => {
    it('derives headers, rows, and sheet metadata', () => {
        const c = createExcelController(okResult(people));
        expect(c.state.sheetNames).toEqual(['People']);
        expect(c.state.sheetIndex).toBe(0);
        expect(c.state.headers).toEqual(['name', 'age']);
        expect(c.state.columnCount).toBe(2);
        expect(c.state.rowCount).toBe(3);
        expect(c.state.visibleRows).toEqual([
            ['bob', '9'],
            ['alice', '10'],
            ['carol', '2']
        ]);
    });

    it('reflects a failed parse as an empty workbook', () => {
        const failed: ParseResult<ExcelWorkbook> = {
            status: 'failed',
            failure: { code: 'invalid-format', retryable: false, messageKey: 'diag.excel.invalid-format' },
            diagnostics: []
        };
        const c = createExcelController(failed);
        expect(c.state.status).toBe('failed');
        expect(c.state.failure?.code).toBe('invalid-format');
        expect(c.state.sheetNames).toEqual([]);
        expect(c.state.visibleRows).toEqual([]);
    });
});

describe('createExcelController — sort (deterministic, CSV reuse)', () => {
    it('cycles asc → desc → none with numeric ordering', () => {
        const c = createExcelController(okResult(people));
        c.dispatch({ type: 'sort-column', columnIndex: 1 });
        expect(c.state.sort).toEqual({ columnIndex: 1, direction: 'asc' });
        expect(c.state.visibleRows.map((r) => r[1])).toEqual(['2', '9', '10']); // numeric, not lexical

        c.dispatch({ type: 'sort-column', columnIndex: 1 });
        expect(c.state.sort.direction).toBe('desc');
        expect(c.state.visibleRows.map((r) => r[1])).toEqual(['10', '9', '2']);

        c.dispatch({ type: 'sort-column', columnIndex: 1 });
        expect(c.state.sort).toEqual({ columnIndex: null, direction: null });
        expect(c.state.visibleRows.map((r) => r[0])).toEqual(['bob', 'alice', 'carol']); // original order
    });

    it('ignores out-of-range columns', () => {
        const c = createExcelController(okResult(people));
        c.dispatch({ type: 'sort-column', columnIndex: 9 });
        expect(c.state.sort.columnIndex).toBeNull();
    });
});

describe('createExcelController — search', () => {
    it('filters rows and counts matched rows and cells', () => {
        const c = createExcelController(okResult(sheetFromAoa('S', [
            ['a', 'b'],
            ['xx', 'x'],
            ['y', 'z']
        ])));
        c.dispatch({ type: 'set-search', search: 'x' });
        expect(c.state.matchedRowCount).toBe(1);
        expect(c.state.matchedCellCount).toBe(2); // 'xx' and 'x'
        expect(c.state.visibleRows).toEqual([['xx', 'x']]);
    });

    it('clears the filter on empty search', () => {
        const c = createExcelController(okResult(people));
        c.dispatch({ type: 'set-search', search: 'alice' });
        expect(c.state.matchedRowCount).toBe(1);
        c.dispatch({ type: 'set-search', search: '' });
        expect(c.state.matchedRowCount).toBe(3);
    });
});

describe('createExcelController — editing: type inference', () => {
    function typedCell(c: ReturnType<typeof createExcelController>, r: number, col: number) {
        // r is the data-row index; header is row 0 in the exported sheet.
        return c.getWorkbook().sheets[0]!.cells.find((x) => x.r === r + 1 && x.c === col);
    }

    it('infers number / date / text from the edited value', () => {
        const c = createExcelController(okResult(people));
        const bob = c.state.visibleRowIds[0]!;
        c.dispatch({ type: 'edit-cell', rowId: bob, columnIndex: 1, value: '99' });
        expect(typedCell(c, 0, 1)).toMatchObject({ t: 'number', v: 99 });

        c.dispatch({ type: 'edit-cell', rowId: bob, columnIndex: 1, value: '2021-05-01' });
        expect(typedCell(c, 0, 1)).toMatchObject({ t: 'date', v: '2021-05-01' });

        c.dispatch({ type: 'edit-cell', rowId: bob, columnIndex: 1, value: 'n/a' });
        expect(typedCell(c, 0, 1)).toMatchObject({ t: 'text', v: 'n/a' });
    });

    it('edits the intended row identified by RowId even after sorting', () => {
        const c = createExcelController(okResult(people));
        c.dispatch({ type: 'sort-column', columnIndex: 1 }); // asc: carol(2), bob(9), alice(10)
        const firstId = c.state.visibleRowIds[0]!; // carol
        c.dispatch({ type: 'edit-cell', rowId: firstId, columnIndex: 0, value: 'cara' });
        expect(c.state.visibleRows[0]![0]).toBe('cara');
    });
});

describe('createExcelController — editing: undo/redo/dirty', () => {
    it('tracks dirty and clears it on markSaved', () => {
        const c = createExcelController(okResult(people));
        expect(c.state.dirty).toBe(false);
        c.dispatch({ type: 'edit-cell', rowId: c.state.visibleRowIds[0]!, columnIndex: 0, value: 'z' });
        expect(c.state.dirty).toBe(true);
        expect(c.state.workbookDirty).toBe(true);
        c.markSaved();
        expect(c.state.dirty).toBe(false);
        expect(c.state.workbookDirty).toBe(false);
    });

    it('undoes and redoes a cell edit', () => {
        const c = createExcelController(okResult(people));
        const id = c.state.visibleRowIds[0]!;
        c.dispatch({ type: 'edit-cell', rowId: id, columnIndex: 0, value: 'zzz' });
        expect(c.state.visibleRows[0]![0]).toBe('zzz');
        expect(c.state.canUndo).toBe(true);
        c.dispatch({ type: 'undo' });
        expect(c.state.visibleRows[0]![0]).toBe('bob');
        expect(c.state.canRedo).toBe(true);
        c.dispatch({ type: 'redo' });
        expect(c.state.visibleRows[0]![0]).toBe('zzz');
    });

    it('edits headers and inserts/deletes rows', () => {
        const c = createExcelController(okResult(people));
        c.dispatch({ type: 'edit-header', columnIndex: 0, value: 'Name' });
        expect(c.state.headers[0]).toBe('Name');

        const before = c.state.rowCount;
        c.dispatch({ type: 'insert-row', afterRowId: 'end' });
        expect(c.state.rowCount).toBe(before + 1);
        const lastId = c.state.visibleRowIds[c.state.visibleRowIds.length - 1]!;
        c.dispatch({ type: 'delete-row', rowId: lastId });
        expect(c.state.rowCount).toBe(before);
    });

    it('ignores edits on a non-ok (partial) parse', () => {
        const partial: ParseResult<ExcelWorkbook> = {
            status: 'partial',
            document: { sheetNames: ['People'], sheets: [people], date1904: false },
            diagnostics: []
        };
        const c = createExcelController(partial);
        expect(c.state.editable).toBe(false);
        c.dispatch({ type: 'edit-cell', rowId: c.state.visibleRowIds[0]!, columnIndex: 0, value: 'x' });
        expect(c.state.visibleRows[0]![0]).toBe('bob');
    });

    it('preserves per-sheet edits and undo history across sheet switches', () => {
        const c = createExcelController(okResult(people, sheetFromAoa('Other', [['k'], ['one']])));
        c.dispatch({ type: 'edit-cell', rowId: c.state.visibleRowIds[0]!, columnIndex: 0, value: 'bobby' });
        c.dispatch({ type: 'switch-sheet', index: 1 });
        expect(c.state.dirty).toBe(false); // Other sheet untouched
        expect(c.state.workbookDirty).toBe(true); // People still dirty
        c.dispatch({ type: 'switch-sheet', index: 0 });
        expect(c.state.visibleRows[0]![0]).toBe('bobby');
        expect(c.state.canUndo).toBe(true);
    });
});

describe('createExcelController — pagination', () => {
    const big = sheetFromAoa('Big', [['h'], ...Array.from({ length: 250 }, (_, i) => [`r${i}`])]);

    it('pages by pageSize', () => {
        const c = createExcelController(okResult(big), { pageSize: 100 });
        expect(c.state.pageCount).toBe(3);
        expect(c.state.visibleRows).toHaveLength(100);
        c.dispatch({ type: 'next-page' });
        expect(c.state.page).toBe(1);
        expect(c.state.visibleRows[0]).toEqual(['r100']);
        c.dispatch({ type: 'set-page', page: 99 });
        expect(c.state.page).toBe(2); // clamped
        expect(c.state.visibleRows).toHaveLength(50);
        c.dispatch({ type: 'prev-page' });
        expect(c.state.page).toBe(1);
    });
});

describe('createExcelController — sheet switch resets state', () => {
    it('switches sheet and resets sort/search/page', () => {
        const c = createExcelController(okResult(
            people,
            sheetFromAoa('Other', [['k'], ['one'], ['two']])
        ), { pageSize: 100 });
        c.dispatch({ type: 'sort-column', columnIndex: 1 });
        c.dispatch({ type: 'set-search', search: 'alice' });

        c.dispatch({ type: 'switch-sheet', index: 1 });
        expect(c.state.sheetIndex).toBe(1);
        expect(c.state.sheetName).toBe('Other');
        expect(c.state.headers).toEqual(['k']);
        expect(c.state.sort.columnIndex).toBeNull();
        expect(c.state.search).toBe('');
        expect(c.state.visibleRows).toEqual([['one'], ['two']]);
    });

    it('ignores an out-of-range or same sheet index', () => {
        const c = createExcelController(okResult(people));
        c.dispatch({ type: 'switch-sheet', index: 5 });
        expect(c.state.sheetIndex).toBe(0);
        c.dispatch({ type: 'switch-sheet', index: 0 });
        expect(c.state.sheetIndex).toBe(0);
    });
});

describe('createExcelController — raw view + copy', () => {
    it('disables search in raw mode and shows all rows', () => {
        const c = createExcelController(okResult(people));
        c.dispatch({ type: 'set-search', search: 'alice' });
        expect(c.state.matchedRowCount).toBe(1);
        c.dispatch({ type: 'set-view-mode', mode: 'raw' });
        expect(c.state.viewMode).toBe('raw');
        expect(c.state.matchedRowCount).toBe(3); // search inactive in raw mode
    });

    it('serializes display result as TSV and JSON', () => {
        const c = createExcelController(okResult(people));
        c.dispatch({ type: 'set-search', search: 'alice' });
        expect(c.toTsv()).toBe('name\tage\nalice\t10');

        const json = JSON.parse(c.toJson());
        expect(json.format).toBe('excel-export@1');
        expect(json.sheetName).toBe('People');
        expect(json.rows).toEqual([['alice', '10']]);
        expect(json.metadata.filteredRows).toBe(1);
    });

    it('raw json holds the full unfiltered sheet', () => {
        const c = createExcelController(okResult(people));
        c.dispatch({ type: 'set-search', search: 'alice' });
        const raw = JSON.parse(c.rawJson());
        expect(raw.rows).toHaveLength(3);
    });
});

describe('createExcelController — subscribe', () => {
    it('notifies listeners on dispatch and unsubscribes', () => {
        const c = createExcelController(okResult(people));
        let count = 0;
        const off = c.subscribe(() => count++);
        c.dispatch({ type: 'next-page' });
        c.dispatch({ type: 'sort-column', columnIndex: 0 });
        expect(count).toBe(2);
        off();
        c.dispatch({ type: 'sort-column', columnIndex: 0 });
        expect(count).toBe(2);
    });
});
