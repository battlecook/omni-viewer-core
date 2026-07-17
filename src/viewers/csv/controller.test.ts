import { describe, expect, it } from 'vitest';
import { createCsvController } from './controller.js';

const SAMPLE = 'name,score\ncarol,10\nalice,2\nbob,\ndave,9\n';

describe('CsvController', () => {
    it('exposes parsed state after creation', () => {
        const c = createCsvController(SAMPLE);
        expect(c.state.status).toBe('ok');
        expect(c.state.headers).toEqual(['name', 'score']);
        expect(c.state.rowCount).toBe(4);
        expect(c.state.visibleRowIds).toEqual([0, 1, 2, 3]);
    });

    it('action sequence: sort asc -> desc -> none (empties always at bottom)', () => {
        const c = createCsvController(SAMPLE);
        c.dispatch({ type: 'sort-column', columnIndex: 1 });
        expect(c.state.sort).toEqual({ columnIndex: 1, direction: 'asc' });
        expect(c.state.sortedColumnType).toBe('number');
        expect(c.state.visibleRowIds).toEqual([1, 3, 0, 2]);

        c.dispatch({ type: 'sort-column', columnIndex: 1 });
        expect(c.state.visibleRowIds).toEqual([0, 3, 1, 2]);

        c.dispatch({ type: 'sort-column', columnIndex: 1 });
        expect(c.state.sort).toEqual({ columnIndex: null, direction: null });
        expect(c.state.visibleRowIds).toEqual([0, 1, 2, 3]);
    });

    it('set-delimiter reparses and resets sort/page', () => {
        const c = createCsvController('a;b\n1;2\n3;4\n');
        expect(c.state.delimiter).toBe(';');
        c.dispatch({ type: 'sort-column', columnIndex: 0 });
        c.dispatch({ type: 'set-delimiter', delimiter: ',' });
        expect(c.state.delimiter).toBe(',');
        expect(c.state.detectionSource).toBe('override');
        expect(c.state.sort).toEqual({ columnIndex: null, direction: null });
        expect(c.state.columnCount).toBe(1);
        c.dispatch({ type: 'set-delimiter', delimiter: 'auto' });
        expect(c.state.delimiter).toBe(';');
        expect(c.state.detectionSource).toBe('auto');
    });

    it('paginates and clamps page navigation', () => {
        const lines = ['h'];
        for (let i = 0; i < 25; i++) lines.push(String(i));
        const c = createCsvController(lines.join('\n'), { pageSize: 10 });
        expect(c.state.pageCount).toBe(3);
        expect(c.state.visibleRowIds.length).toBe(10);

        c.dispatch({ type: 'next-page' });
        expect(c.state.page).toBe(1);
        c.dispatch({ type: 'set-page', page: 99 });
        expect(c.state.page).toBe(2);
        expect(c.state.visibleRowIds.length).toBe(5);
        c.dispatch({ type: 'prev-page' });
        c.dispatch({ type: 'prev-page' });
        c.dispatch({ type: 'prev-page' });
        expect(c.state.page).toBe(0);
    });

    it('sorting resets to the first page', () => {
        const lines = ['h'];
        for (let i = 0; i < 25; i++) lines.push(String(i));
        const c = createCsvController(lines.join('\n'), { pageSize: 10 });
        c.dispatch({ type: 'next-page' });
        c.dispatch({ type: 'sort-column', columnIndex: 0 });
        expect(c.state.page).toBe(0);
    });

    it('toggles view mode and stats', () => {
        const c = createCsvController(SAMPLE);
        c.dispatch({ type: 'set-view-mode', mode: 'raw' });
        expect(c.state.viewMode).toBe('raw');
        c.dispatch({ type: 'toggle-stats' });
        expect(c.state.statsVisible).toBe(true);
        c.dispatch({ type: 'toggle-stats' });
        expect(c.state.statsVisible).toBe(false);
    });

    it('notifies subscribers and stops after unsubscribe', () => {
        const c = createCsvController(SAMPLE);
        const seen: string[] = [];
        const unsub = c.subscribe((s) => seen.push(s.viewMode));
        c.dispatch({ type: 'set-view-mode', mode: 'raw' });
        unsub();
        c.dispatch({ type: 'set-view-mode', mode: 'table' });
        expect(seen).toEqual(['raw']);
    });

    it('serializes TSV/JSON in display (sorted) order using the export envelope', () => {
        const c = createCsvController(SAMPLE);
        c.dispatch({ type: 'sort-column', columnIndex: 1 });
        const tsv = c.toTsv().split('\n');
        expect(tsv[0]).toBe('name\tscore');
        expect(tsv[1]).toBe('alice\t2');

        const json = JSON.parse(c.toJson());
        expect(json.format).toBe('omni-viewer/csv-export@1');
        expect(json.headers).toEqual(['name', 'score']);
        expect(json.rows[0]).toEqual(['alice', '2']);
        expect(json.metadata).toEqual({
            scope: 'loaded-results',
            sourceRowsLoaded: 4,
            sourceFullyScanned: true
        });
    });

    it('exposes the failure on failed parses (state.failure)', () => {
        const c = createCsvController('a,b\n1,2\n', {
            limits: { maxInputBytes: 2 }
        });
        expect(c.state.status).toBe('failed');
        expect(c.state.failure?.code).toBe('limit-exceeded');
        expect(c.state.rowCount).toBe(0);
    });

    it('search filters over sorted order, resets page, and reports match count', () => {
        const c = createCsvController('name,score\ncarol,10\nalice,2\nCALVIN,9\nbob,\n');
        c.dispatch({ type: 'sort-column', columnIndex: 1 }); // asc: alice, CALVIN, carol, bob('')
        c.dispatch({ type: 'set-search', search: 'cA' });
        expect(c.state.matchedRowCount).toBe(2);
        expect(c.state.rowCount).toBe(4);
        // Sorted order preserved within matches: CALVIN(9) before carol(10).
        expect(c.state.visibleRowIds.map((i) => c.getRowById(i)[0])).toEqual([
            'CALVIN',
            'carol'
        ]);
        expect(c.state.page).toBe(0);
        // Copy targets the filtered display result.
        expect(c.toTsv().split('\n')).toEqual(['name\tscore', 'CALVIN\t9', 'carol\t10']);
        const json = JSON.parse(c.toJson());
        expect(json.rows.length).toBe(2);
        expect(json.metadata.sourceRowsLoaded).toBe(4); // unfiltered total
        // Clearing the search restores everything.
        c.dispatch({ type: 'set-search', search: '' });
        expect(c.state.matchedRowCount).toBe(4);
    });

    it('does not filter until the search query reaches two characters', () => {
        const c = createCsvController('name\nanna\nbob\n');
        c.dispatch({ type: 'set-search', search: 'a' });
        expect(c.state.search).toBe('a');
        expect(c.state.matchedRowCount).toBe(2);
        expect(c.state.visibleRowIds.map((i) => c.getRowById(i)[0])).toEqual(['anna', 'bob']);

        c.dispatch({ type: 'set-search', search: 'an' });
        expect(c.state.matchedRowCount).toBe(1);
        expect(c.state.visibleRowIds.map((i) => c.getRowById(i)[0])).toEqual(['anna']);
    });

    it('search paginates the filtered results and survives a reparse', () => {
        const lines = ['h'];
        for (let i = 0; i < 30; i++) lines.push(i % 2 === 0 ? `even${i}` : `odd${i}`);
        const c = createCsvController(lines.join('\n'), { pageSize: 10 });
        c.dispatch({ type: 'set-search', search: 'even' });
        expect(c.state.matchedRowCount).toBe(15);
        expect(c.state.pageCount).toBe(2);
        c.dispatch({ type: 'set-delimiter', delimiter: ';' });
        expect(c.state.search).toBe('even');
        expect(c.state.matchedRowCount).toBe(15);
    });

    it('page size changes keep the current first row visible and reject garbage', () => {
        const lines = ['h'];
        for (let i = 0; i < 250; i++) lines.push(String(i));
        const c = createCsvController(lines.join('\n'), { pageSize: 100 });
        c.dispatch({ type: 'set-page', page: 2 }); // rows 200..249
        c.dispatch({ type: 'set-page-size', pageSize: 500 });
        expect(c.state.pageSize).toBe(500);
        expect(c.state.page).toBe(0); // row 200 visible on page 0 of 500
        c.dispatch({ type: 'set-page-size', pageSize: 100 });
        c.dispatch({ type: 'set-page', page: 2 });
        c.dispatch({ type: 'set-page-size', pageSize: 200 });
        expect(c.state.page).toBe(1); // first row 200 -> page 1 of 200-size pages

        for (const bad of [0, -5, 2.5, Number.NaN]) {
            c.dispatch({ type: 'set-page-size', pageSize: bad });
            expect(c.state.pageSize).toBe(200);
        }
    });

    it('toggles row numbers', () => {
        const c = createCsvController('a\n1\n');
        expect(c.state.showRowNumbers).toBe(false);
        c.dispatch({ type: 'toggle-row-numbers' });
        expect(c.state.showRowNumbers).toBe(true);
    });

    it('toCsv exports the filtered+sorted display result with the active delimiter', () => {
        const c = createCsvController('name;score\ncarol;10\nalice;2\nbob;9\n');
        c.dispatch({ type: 'sort-column', columnIndex: 1 });
        c.dispatch({ type: 'set-search', search: 'ol' }); // carol
        expect(c.toCsv()).toBe('name;score\ncarol;10');
    });

    it('computes statistics lazily', () => {
        const c = createCsvController(SAMPLE);
        const stats = c.getStatistics();
        expect(stats[1]?.numeric?.min).toBe(2);
        expect(stats[1]?.nullCount).toBe(1);
    });

    it('edit-cell and edit-header change data, undo/redo round-trips, dirty tracks the save point', () => {
        const c = createCsvController('name,score\nkim,1\nlee,2\n');
        expect(c.state.dirty).toBe(false);

        c.dispatch({ type: 'edit-cell', rowId: 0, columnIndex: 0, value: 'park' });
        c.dispatch({ type: 'edit-header', columnIndex: 1, value: 'points' });
        expect(c.getRowById(0)).toEqual(['park', '1']);
        expect(c.state.headers).toEqual(['name', 'points']);
        expect(c.state.dirty).toBe(true);
        expect(c.state.canUndo).toBe(true);

        c.dispatch({ type: 'undo' });
        expect(c.state.headers).toEqual(['name', 'score']);
        c.dispatch({ type: 'undo' });
        expect(c.getRowById(0)).toEqual(['kim', '1']);
        expect(c.state.dirty).toBe(false); // back at the save point
        expect(c.state.canRedo).toBe(true);

        c.dispatch({ type: 'redo' });
        expect(c.getRowById(0)).toEqual(['park', '1']);
        expect(c.state.dirty).toBe(true);
    });

    it('markSaved clears dirty; editing past a save point keeps dirty semantics', () => {
        const c = createCsvController('a\n1\n');
        c.dispatch({ type: 'edit-cell', rowId: 0, columnIndex: 0, value: 'x' });
        expect(c.state.dirty).toBe(true);
        c.markSaved();
        expect(c.state.dirty).toBe(false);
        c.dispatch({ type: 'edit-cell', rowId: 0, columnIndex: 0, value: 'y' });
        expect(c.state.dirty).toBe(true);
        c.dispatch({ type: 'undo' });
        expect(c.state.dirty).toBe(false); // back at the saved depth

        // Undoing back to the exact saved content is clean again —
        // the discarded branch ('y') was never the saved state.
        c.dispatch({ type: 'edit-cell', rowId: 0, columnIndex: 0, value: 'z' });
        expect(c.state.canRedo).toBe(false);
        c.dispatch({ type: 'undo' });
        expect(c.state.dirty).toBe(false);
    });

    it('a save point discarded with the redo branch stays unreachable (always dirty)', () => {
        const c = createCsvController('a\n1\n');
        c.dispatch({ type: 'edit-cell', rowId: 0, columnIndex: 0, value: 'x' });
        c.dispatch({ type: 'edit-cell', rowId: 0, columnIndex: 0, value: 'y' });
        c.markSaved(); // saved at depth 2 ('y')
        c.dispatch({ type: 'undo' }); // depth 1
        c.dispatch({ type: 'edit-cell', rowId: 0, columnIndex: 0, value: 'z' });
        // 'y' (the saved state) now lives in the discarded redo branch.
        expect(c.state.dirty).toBe(true);
        c.dispatch({ type: 'undo' });
        expect(c.state.dirty).toBe(true); // depth 1 != saved content
        c.dispatch({ type: 'undo' });
        expect(c.state.dirty).toBe(true); // original != saved content
    });

    it('insert-row places the new row below its anchor everywhere; delete removes it', () => {
        const c = createCsvController('n\n30\n10\n20\n');
        c.dispatch({ type: 'sort-column', columnIndex: 0 }); // display: 10,20,30
        c.dispatch({ type: 'insert-row', afterRowId: 1 }); // below "10" (id 1)
        const ids = c.state.visibleRowIds;
        expect(ids[0]).toBe(1);
        expect(c.getRowById(ids[1] as number)).toEqual(['']); // new empty row right below
        // Document order: 30,10,new,20 → row numbers reflect current positions.
        expect(c.getRowNumber(ids[1] as number)).toBe(3);
        expect(c.state.rowCount).toBe(4);

        c.dispatch({ type: 'delete-row', rowId: ids[1] as number });
        expect(c.state.rowCount).toBe(3);
        c.dispatch({ type: 'undo' }); // restore the deleted row at its old spot
        expect(c.state.rowCount).toBe(4);
        expect(c.state.visibleRowIds[1]).toBe(ids[1]);
    });

    it('insert-column adds an empty named column at the index; undo/redo round-trips', () => {
        const c = createCsvController('name,score\nkim,1\nlee,2\n');
        c.dispatch({ type: 'insert-column', columnIndex: 1 }); // between name and score
        expect(c.state.headers).toEqual(['name', 'Column3', 'score']);
        expect(c.state.columnCount).toBe(3);
        expect(c.getRowById(0)).toEqual(['kim', '', '1']);
        expect(c.state.dirty).toBe(true);

        // The new column is editable immediately (columnCount validation moved).
        c.dispatch({ type: 'edit-cell', rowId: 0, columnIndex: 1, value: 'x' });
        expect(c.getRowById(0)).toEqual(['kim', 'x', '1']);

        c.dispatch({ type: 'undo' }); // cell edit
        c.dispatch({ type: 'undo' }); // column insert
        expect(c.state.headers).toEqual(['name', 'score']);
        expect(c.state.columnCount).toBe(2);
        expect(c.getRowById(0)).toEqual(['kim', '1']);
        expect(c.state.dirty).toBe(false);

        c.dispatch({ type: 'redo' });
        c.dispatch({ type: 'redo' });
        expect(c.getRowById(0)).toEqual(['kim', 'x', '1']);

        // Out-of-range indexes are ignored; end insertion is allowed.
        c.dispatch({ type: 'insert-column', columnIndex: 99 });
        expect(c.state.columnCount).toBe(3);
        c.dispatch({ type: 'insert-column', columnIndex: 3 });
        expect(c.state.headers).toEqual(['name', 'Column3', 'score', 'Column4']);
    });

    it('delete-column snapshots values for undo and refuses to delete the last column', () => {
        const c = createCsvController('name,score\nkim,1\nlee,2\n');
        c.dispatch({ type: 'delete-column', columnIndex: 0 });
        expect(c.state.headers).toEqual(['score']);
        expect(c.getRowById(0)).toEqual(['1']);
        expect(c.toDocumentCsv()).toBe('score\n1\n2');

        // Last remaining column cannot be deleted.
        c.dispatch({ type: 'delete-column', columnIndex: 0 });
        expect(c.state.columnCount).toBe(1);

        c.dispatch({ type: 'undo' });
        expect(c.state.headers).toEqual(['name', 'score']);
        expect(c.getRowById(0)).toEqual(['kim', '1']);
        expect(c.getRowById(1)).toEqual(['lee', '2']);
        expect(c.state.dirty).toBe(false);
    });

    it('column ops shift the sorted column index; deleting it clears the sort in place', () => {
        const c = createCsvController('name,score\ncarol,10\nalice,2\ndave,9\n');
        c.dispatch({ type: 'sort-column', columnIndex: 1 }); // by score asc
        expect(c.state.visibleRowIds).toEqual([1, 2, 0]);

        // Insert before the sorted column: index shifts, order untouched.
        c.dispatch({ type: 'insert-column', columnIndex: 0 });
        expect(c.state.sort).toEqual({ columnIndex: 2, direction: 'asc' });
        expect(c.state.visibleRowIds).toEqual([1, 2, 0]);

        // Delete an unrelated column: index shifts back.
        c.dispatch({ type: 'delete-column', columnIndex: 0 });
        expect(c.state.sort).toEqual({ columnIndex: 1, direction: 'asc' });

        // Delete the sorted column: sort marker clears, display order stays.
        c.dispatch({ type: 'delete-column', columnIndex: 1 });
        expect(c.state.sort).toEqual({ columnIndex: null, direction: null });
        expect(c.state.sortedColumnType).toBeNull();
        expect(c.state.visibleRowIds).toEqual([1, 2, 0]);
    });

    it('rejects column edits on partial parses', () => {
        const lines = ['h,g'];
        for (let i = 0; i < 20; i++) lines.push(`${i},${i}`);
        const c = createCsvController(lines.join('\n'), { limits: { maxEntries: 5 } });
        expect(c.state.status).toBe('partial');
        c.dispatch({ type: 'insert-column', columnIndex: 0 });
        c.dispatch({ type: 'delete-column', columnIndex: 0 });
        expect(c.state.columnCount).toBe(2);
        expect(c.state.dirty).toBe(false);
    });

    it('rejects edit actions on partial parses and delimiter changes while dirty', () => {
        const lines = ['h'];
        for (let i = 0; i < 20; i++) lines.push(String(i));
        const partial = createCsvController(lines.join('\n'), { limits: { maxEntries: 5 } });
        expect(partial.state.status).toBe('partial');
        partial.dispatch({ type: 'edit-cell', rowId: 0, columnIndex: 0, value: 'x' });
        partial.dispatch({ type: 'insert-row', afterRowId: 'end' });
        expect(partial.state.dirty).toBe(false);
        expect(partial.getRowById(0)).toEqual(['0']);

        const c = createCsvController('a;b\n1;2\n');
        c.dispatch({ type: 'edit-cell', rowId: 0, columnIndex: 0, value: 'x' });
        c.dispatch({ type: 'set-delimiter', delimiter: ',' });
        expect(c.state.delimiter).toBe(';'); // rejected — edits preserved
        expect(c.getRowById(0)).toEqual(['x', '2']);
    });

    it('save serializes the whole document in original order, ignoring search/sort', () => {
        const c = createCsvController('n\n30\n10\n20\n');
        c.dispatch({ type: 'sort-column', columnIndex: 0 });
        c.dispatch({ type: 'set-search', search: '10' });
        c.dispatch({ type: 'edit-cell', rowId: 1, columnIndex: 0, value: '11' });
        expect(c.toDocumentCsv()).toBe('n\n30\n11\n20');
        // Display-scoped export stays filtered.
        expect(c.toCsv()).toBe('n\n11');
    });

    it('same action sequence yields identical normalized state (conformance shape)', () => {
        const run = () => {
            const c = createCsvController(SAMPLE);
            c.dispatch({ type: 'sort-column', columnIndex: 1 });
            c.dispatch({ type: 'sort-column', columnIndex: 0 });
            c.dispatch({ type: 'toggle-stats' });
            return c.state;
        };
        expect(run()).toEqual(run());
    });
});
