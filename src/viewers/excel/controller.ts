// ExcelController — the behavior-controller layer for the Excel viewer
// (DESIGN.md §3-②, docs/viewers/excel.md §3). Pure state machine: no DOM, no
// host services, no SheetJS. It consumes an already-parsed
// ParseResult<ExcelWorkbook> and drives sheet switch, sort, search, pagination,
// raw-view toggle, copy, and CELL EDITING (X-편집, promoted to v1 scope).
//
// Editing mirrors the CSV controller engine (src/viewers/csv/controller.ts):
// immutable RowIds so sort/filter can't misroute an edit, an inverse-op
// undo/redo stack, and dirty tracking against a saved point. The Excel-specific
// part is that cells are TYPED (EditableCell {t,v,w}); an edited value's type is
// inferred (inferEditedCell) so type-preserving export (serializeWorkbook) keeps
// numbers/dates as numbers/dates rather than text. Edits live in a per-sheet
// working model so switching sheets preserves them.
//
// Sort reuses the CSV deterministic comparators (X2). Save-as export only —
// no writeback to the original file, no formula recalculation.

import type { Diagnostic, ParseFailure, ParseResult } from '../../parsers/types.js';
import {
    applySort,
    detectColumnType,
    nextSortState,
    parseDateKey,
    serializeRowsToTsv,
    type ColumnType,
    type SortState
} from '../../parsers/csv/index.js';
import type { ExcelCellType, ExcelCell, ExcelSheet, ExcelWorkbook } from '../../parsers/excel/index.js';
import { buildGridView, type GridView } from './grid.js';

export const EXCEL_DEFAULT_PAGE_SIZE = 100;
export const EXCEL_UNDO_STACK_LIMIT = 200;

export type RowId = number;

/** A typed, editable cell — display text (`w`) plus the value/type used for
 *  type-preserving export. */
interface EditableCell {
    t: ExcelCellType;
    v: string | number | boolean | null;
    w: string;
}

interface EditableRow {
    id: RowId;
    cells: EditableCell[];
}

interface WorkingSheet {
    name: string;
    headers: EditableCell[];
    rowOrder: EditableRow[];
    byId: Map<RowId, EditableRow>;
    columnCount: number;
    nextRowId: number;
    undoStack: EditOp[];
    redoStack: EditOp[];
    savedDepth: number;
    savedUnreachable: boolean;
}

interface RowPositions {
    order: number;
    sorted: number;
    display: number;
}

type EditOp =
    | { kind: 'cell'; rowId: RowId; columnIndex: number; prev: EditableCell; next: EditableCell }
    | { kind: 'header'; columnIndex: number; prev: EditableCell; next: EditableCell }
    | { kind: 'insert' | 'delete'; row: EditableRow; positions: RowPositions };

export interface ExcelViewState {
    status: 'ok' | 'partial' | 'failed';
    failure: ParseFailure | null;
    diagnostics: Diagnostic[];
    sheetNames: string[];
    sheetIndex: number;
    sheetName: string;
    headers: string[];
    columnCount: number;
    /** Data rows in the current sheet (excludes the header row). */
    rowCount: number;
    sort: SortState;
    sortedColumnType: ColumnType | null;
    search: string;
    matchedRowCount: number;
    matchedCellCount: number;
    page: number;
    pageCount: number;
    pageSize: number;
    /** 'table' = editable data table, 'grid' = read-only WYSIWYG (X3), 'raw' = JSON. */
    viewMode: 'table' | 'grid' | 'raw';
    /** Current page's rows (display strings), sorted then search-filtered. */
    visibleRows: string[][];
    /** RowIds for visibleRows, in the same order — stable across sort/filter. */
    visibleRowIds: RowId[];
    /** Editing is possible only for a fully parsed workbook (status 'ok'). */
    editable: boolean;
    canUndo: boolean;
    canRedo: boolean;
    /** Current sheet has unsaved edits. */
    dirty: boolean;
    /** Any sheet in the workbook has unsaved edits (drives the save button). */
    workbookDirty: boolean;
}

export type ExcelAction =
    | { type: 'switch-sheet'; index: number }
    | { type: 'sort-column'; columnIndex: number }
    | { type: 'set-search'; search: string }
    | { type: 'set-page'; page: number }
    | { type: 'next-page' }
    | { type: 'prev-page' }
    | { type: 'set-page-size'; pageSize: number }
    | { type: 'set-view-mode'; mode: 'table' | 'grid' | 'raw' }
    | { type: 'edit-cell'; rowId: RowId; columnIndex: number; value: string }
    | { type: 'edit-header'; columnIndex: number; value: string }
    | { type: 'insert-row'; afterRowId: RowId | 'end' }
    | { type: 'delete-row'; rowId: RowId }
    | { type: 'undo' }
    | { type: 'redo' };

export interface ExcelControllerOptions {
    pageSize?: number;
}

export interface ExcelController {
    readonly state: ExcelViewState;
    dispatch(action: ExcelAction): void;
    subscribe(listener: (state: ExcelViewState) => void): () => void;
    /** Display cells (`w`) of a row by its immutable id. */
    getRowById(rowId: RowId): readonly string[];
    /** Display result (sorted + filtered) as TSV, headers included (copy). */
    toTsv(): string;
    /** Display result as an excel-export@1 JSON envelope (copy). */
    toJson(): string;
    /** Full current sheet as pretty JSON, unfiltered (raw view). */
    rawJson(): string;
    /** Workbook with in-session edits applied — for type-preserving export
     *  (serializeWorkbook). Untouched sheets return their original model. */
    getWorkbook(): ExcelWorkbook;
    /** Grid-mode view (X3) of the current sheet — read-only render of the
     *  original parsed file (styles/merges/dims), independent of edits. */
    getGrid(): GridView | null;
    /** Mark the current edit depth of every sheet as saved (clears dirty). */
    markSaved(): void;
}

export function createExcelController(
    result: ParseResult<ExcelWorkbook>,
    options: ExcelControllerOptions = {}
): ExcelController {
    const listeners = new Set<(s: ExcelViewState) => void>();
    const pageSizeDefault = options.pageSize ?? EXCEL_DEFAULT_PAGE_SIZE;
    const editable = result.status === 'ok';

    const workbook: ExcelWorkbook =
        result.status === 'failed'
            ? { sheetNames: [], sheets: [], date1904: false }
            : result.document;

    /** Per-sheet mutable working models — created on first load/edit. */
    const working = new Map<number, WorkingSheet>();

    // Current-sheet runtime view state.
    let sheetIndex = 0;
    let ws: WorkingSheet | null = null;
    let sortedRows: EditableRow[] = [];
    let displayRows: EditableRow[] = [];
    let sort: SortState = { columnIndex: null, direction: null };
    let sortedColumnType: ColumnType | null = null;
    let search = '';
    let matchedCellCount = 0;
    let pageSize = pageSizeDefault;
    let page = 0;
    let viewMode: 'table' | 'grid' | 'raw' = 'table';
    let rawCache: string | null = null;
    /** Grid views (X3) are derived from the original sheet, cached per sheet. */
    const gridCache = new Map<number, GridView>();

    function getWorkingSheet(index: number): WorkingSheet | null {
        const existing = working.get(index);
        if (existing) return existing;
        const sheet = workbook.sheets[index];
        if (!sheet) return null;
        const built = deriveWorkingSheet(sheet);
        working.set(index, built);
        return built;
    }

    function hasActiveSearch(): boolean {
        return viewMode === 'table' && search.length > 0;
    }

    function rowText(row: EditableRow, c: number): string {
        return row.cells[c]?.w ?? '';
    }

    function refilter(): void {
        if (!hasActiveSearch()) {
            displayRows = sortedRows.slice();
            matchedCellCount = 0;
            return;
        }
        const term = search.toLowerCase();
        const filtered: EditableRow[] = [];
        let cells = 0;
        for (const row of sortedRows) {
            let hit = false;
            for (const cell of row.cells) {
                if (cell.w.toLowerCase().includes(term)) {
                    cells++;
                    hit = true;
                }
            }
            if (hit) filtered.push(row);
        }
        displayRows = filtered;
        matchedCellCount = cells;
    }

    function resort(): void {
        const rows = ws?.rowOrder ?? [];
        if (sort.columnIndex === null || !sort.direction) {
            sortedRows = rows.slice();
            sortedColumnType = null;
        } else {
            const col = sort.columnIndex;
            sortedColumnType = detectColumnType(rows.map((r) => rowText(r, col)));
            const positions = applySort(
                rows.map((_, i) => i),
                sort,
                (rowIndex, columnIndex) => rowText(rows[rowIndex] as EditableRow, columnIndex),
                sortedColumnType
            );
            sortedRows = positions.map((p) => rows[p] as EditableRow);
        }
        refilter();
    }

    function loadSheet(index: number): void {
        sheetIndex = index;
        ws = getWorkingSheet(index);
        sort = { columnIndex: null, direction: null };
        sortedColumnType = null;
        search = '';
        matchedCellCount = 0;
        page = 0;
        rawCache = null;
        resort();
    }

    function pageCount(): number {
        return Math.max(1, Math.ceil(displayRows.length / pageSize));
    }

    // --- editing ------------------------------------------------------------

    function isDirty(sheet: WorkingSheet): boolean {
        return sheet.savedUnreachable || sheet.undoStack.length !== sheet.savedDepth;
    }

    function workbookDirty(): boolean {
        for (const sheet of working.values()) {
            if (isDirty(sheet)) return true;
        }
        return false;
    }

    function applyOp(op: EditOp, direction: 'forward' | 'backward'): void {
        if (!ws) return;
        switch (op.kind) {
            case 'cell': {
                const row = ws.byId.get(op.rowId);
                if (row) row.cells[op.columnIndex] = direction === 'forward' ? op.next : op.prev;
                break;
            }
            case 'header': {
                ws.headers[op.columnIndex] = direction === 'forward' ? op.next : op.prev;
                break;
            }
            case 'insert': {
                if (direction === 'forward') addRowAt(op.row, op.positions);
                else removeRow(op.row);
                break;
            }
            case 'delete': {
                if (direction === 'forward') removeRow(op.row);
                else addRowAt(op.row, op.positions);
                break;
            }
        }
        rawCache = null;
    }

    function addRowAt(row: EditableRow, positions: RowPositions): void {
        if (!ws) return;
        ws.rowOrder.splice(clamp(positions.order, 0, ws.rowOrder.length), 0, row);
        sortedRows.splice(clamp(positions.sorted, 0, sortedRows.length), 0, row);
        if (positions.display >= 0) {
            displayRows.splice(clamp(positions.display, 0, displayRows.length), 0, row);
        }
        ws.byId.set(row.id, row);
    }

    function removeRow(row: EditableRow): void {
        if (!ws) return;
        const drop = (arr: EditableRow[]) => {
            const i = arr.indexOf(row);
            if (i >= 0) arr.splice(i, 1);
        };
        drop(ws.rowOrder);
        drop(sortedRows);
        drop(displayRows);
        ws.byId.delete(row.id);
    }

    function pushOp(op: EditOp): void {
        if (!ws) return;
        applyOp(op, 'forward');
        if (ws.redoStack.length > 0) {
            if (ws.savedDepth > ws.undoStack.length) ws.savedUnreachable = true;
            ws.redoStack = [];
        }
        ws.undoStack.push(op);
        if (ws.undoStack.length > EXCEL_UNDO_STACK_LIMIT) {
            ws.undoStack.shift();
            if (ws.savedDepth > 0) ws.savedDepth--;
            else ws.savedUnreachable = true;
        }
    }

    // --- state --------------------------------------------------------------

    function buildState(): ExcelViewState {
        const start = page * pageSize;
        const pageRows = displayRows.slice(start, start + pageSize);
        return {
            status: result.status,
            failure: result.status === 'failed' ? result.failure : null,
            diagnostics: result.diagnostics,
            sheetNames: [...workbook.sheetNames],
            sheetIndex,
            sheetName: ws?.name ?? '',
            headers: ws ? ws.headers.map((c) => c.w) : [],
            columnCount: ws?.columnCount ?? 0,
            rowCount: ws?.rowOrder.length ?? 0,
            sort,
            sortedColumnType,
            search,
            matchedRowCount: displayRows.length,
            matchedCellCount,
            page,
            pageCount: pageCount(),
            pageSize,
            viewMode,
            visibleRows: pageRows.map((r) => r.cells.map((c) => c.w)),
            visibleRowIds: pageRows.map((r) => r.id),
            editable,
            canUndo: (ws?.undoStack.length ?? 0) > 0,
            canRedo: (ws?.redoStack.length ?? 0) > 0,
            dirty: ws ? isDirty(ws) : false,
            workbookDirty: workbookDirty()
        };
    }

    let state: ExcelViewState;

    function commit(): void {
        state = buildState();
        for (const listener of listeners) listener(state);
    }

    loadSheet(0);
    state = buildState();

    function dispatch(action: ExcelAction): void {
        switch (action.type) {
            case 'switch-sheet': {
                if (
                    action.index < 0 ||
                    action.index >= workbook.sheets.length ||
                    action.index === sheetIndex
                ) {
                    return;
                }
                loadSheet(action.index);
                break;
            }
            case 'sort-column': {
                if (!ws || action.columnIndex < 0 || action.columnIndex >= ws.columnCount) return;
                sort = nextSortState(sort, action.columnIndex);
                resort();
                page = 0;
                break;
            }
            case 'set-search': {
                if (action.search === search) return;
                search = action.search;
                refilter();
                page = 0;
                break;
            }
            case 'set-page-size': {
                if (!Number.isInteger(action.pageSize) || action.pageSize <= 0) return;
                if (action.pageSize === pageSize) return;
                const firstVisible = page * pageSize;
                pageSize = action.pageSize;
                page = Math.floor(firstVisible / pageSize);
                break;
            }
            case 'set-page': {
                page = clamp(action.page, 0, pageCount() - 1);
                break;
            }
            case 'next-page': {
                page = clamp(page + 1, 0, pageCount() - 1);
                break;
            }
            case 'prev-page': {
                page = clamp(page - 1, 0, pageCount() - 1);
                break;
            }
            case 'set-view-mode': {
                if (action.mode === viewMode) return;
                viewMode = action.mode;
                refilter();
                page = clamp(page, 0, pageCount() - 1);
                break;
            }
            case 'edit-cell': {
                if (!editable || !ws) return;
                const row = ws.byId.get(action.rowId);
                if (!row || action.columnIndex < 0 || action.columnIndex >= ws.columnCount) return;
                const prev = row.cells[action.columnIndex] ?? emptyCell();
                const next = inferEditedCell(action.value);
                if (cellsEqual(prev, next)) return;
                pushOp({ kind: 'cell', rowId: action.rowId, columnIndex: action.columnIndex, prev, next });
                break;
            }
            case 'edit-header': {
                if (!editable || !ws) return;
                if (action.columnIndex < 0 || action.columnIndex >= ws.columnCount) return;
                const prev = ws.headers[action.columnIndex] ?? emptyCell();
                const next: EditableCell = { t: 'text', v: action.value, w: action.value };
                if (cellsEqual(prev, next)) return;
                pushOp({ kind: 'header', columnIndex: action.columnIndex, prev, next });
                break;
            }
            case 'insert-row': {
                if (!editable || !ws) return;
                const row: EditableRow = {
                    id: ws.nextRowId++,
                    cells: Array.from({ length: ws.columnCount }, emptyCell)
                };
                let positions: RowPositions;
                if (action.afterRowId === 'end') {
                    positions = { order: ws.rowOrder.length, sorted: sortedRows.length, display: displayRows.length };
                } else {
                    const after = ws.byId.get(action.afterRowId);
                    if (!after) return;
                    positions = {
                        order: ws.rowOrder.indexOf(after) + 1 || ws.rowOrder.length,
                        sorted: sortedRows.indexOf(after) + 1 || sortedRows.length,
                        display: displayRows.indexOf(after) + 1 || displayRows.length
                    };
                }
                pushOp({ kind: 'insert', row, positions });
                break;
            }
            case 'delete-row': {
                if (!editable || !ws) return;
                const row = ws.byId.get(action.rowId);
                if (!row) return;
                pushOp({
                    kind: 'delete',
                    row,
                    positions: {
                        order: ws.rowOrder.indexOf(row),
                        sorted: sortedRows.indexOf(row),
                        display: displayRows.indexOf(row)
                    }
                });
                break;
            }
            case 'undo': {
                if (!ws) return;
                const op = ws.undoStack.pop();
                if (!op) return;
                applyOp(op, 'backward');
                ws.redoStack.push(op);
                break;
            }
            case 'redo': {
                if (!ws) return;
                const op = ws.redoStack.pop();
                if (!op) return;
                applyOp(op, 'forward');
                ws.undoStack.push(op);
                break;
            }
        }
        commit();
    }

    return {
        get state() {
            return state;
        },
        dispatch,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getRowById(rowId) {
            return ws?.byId.get(rowId)?.cells.map((c) => c.w) ?? [];
        },
        toTsv() {
            return serializeRowsToTsv(
                displayRows.map((r) => r.cells.map((c) => c.w)),
                ws ? ws.headers.map((c) => c.w) : []
            );
        },
        toJson() {
            const headers = ws ? ws.headers.map((c) => c.w) : [];
            return JSON.stringify(
                {
                    format: 'excel-export@1',
                    sheetName: ws?.name ?? '',
                    headers,
                    rows: displayRows.map((r) => r.cells.map((c) => c.w)),
                    metadata: {
                        totalRows: ws?.rowOrder.length ?? 0,
                        filteredRows: displayRows.length,
                        columns: headers.length,
                        searchActive: hasActiveSearch()
                    }
                },
                null,
                2
            );
        },
        rawJson() {
            if (rawCache === null) {
                const headers = ws ? ws.headers.map((c) => c.w) : [];
                rawCache = JSON.stringify(
                    {
                        sheetName: ws?.name ?? '',
                        headers,
                        rows: (ws?.rowOrder ?? []).map((r) => r.cells.map((c) => c.w)),
                        metadata: { totalRows: ws?.rowOrder.length ?? 0, columns: headers.length }
                    },
                    null,
                    2
                );
            }
            return rawCache;
        },
        getWorkbook() {
            const sheets = workbook.sheetNames.map((name, index) => {
                const edited = working.get(index);
                if (edited) return workingToSheet(edited);
                return workbook.sheets[index] ?? emptySheet(name);
            });
            return { sheetNames: [...workbook.sheetNames], sheets, date1904: workbook.date1904 };
        },
        getGrid() {
            const sheet = workbook.sheets[sheetIndex];
            if (!sheet) return null;
            let grid = gridCache.get(sheetIndex);
            if (!grid) {
                grid = buildGridView(sheet);
                gridCache.set(sheetIndex, grid);
            }
            return grid;
        },
        markSaved() {
            for (const sheet of working.values()) {
                sheet.savedDepth = sheet.undoStack.length;
                sheet.savedUnreachable = false;
            }
            commit();
        }
    };
}

// --- helpers ---------------------------------------------------------------

function emptyCell(): EditableCell {
    return { t: 'text', v: '', w: '' };
}

function cellsEqual(a: EditableCell, b: EditableCell): boolean {
    return a.t === b.t && a.v === b.v && a.w === b.w;
}

/** Infer a cell's type from an edited string (docs/viewers/excel.md §3): a
 *  finite number is numeric, an ISO-shaped value is a date (parseDateKey —
 *  deterministic, ADR 41), everything else is text. */
function inferEditedCell(value: string): EditableCell {
    const trimmed = value.trim();
    if (trimmed !== '' && Number.isFinite(Number(trimmed))) {
        return { t: 'number', v: Number(trimmed), w: value };
    }
    if (parseDateKey(trimmed) !== null) {
        return { t: 'date', v: trimmed, w: value };
    }
    return { t: 'text', v: value, w: value };
}

function deriveWorkingSheet(sheet: ExcelSheet): WorkingSheet {
    const range = sheet.usedRange;
    const columnCount = range ? range.c1 - range.c0 + 1 : 0;
    const headers: EditableCell[] = [];
    const rowOrder: EditableRow[] = [];
    const byId = new Map<RowId, EditableRow>();

    if (range) {
        const grid = new Map<string, ExcelCell>();
        for (const cell of sheet.cells) grid.set(`${cell.r}:${cell.c}`, cell);
        const cellAt = (r: number, c: number): EditableCell => {
            const found = grid.get(`${r}:${c}`);
            return found ? { t: found.t, v: found.v, w: found.w } : emptyCell();
        };
        for (let c = range.c0; c <= range.c1; c++) headers.push(cellAt(range.r0, c));
        let nextId = 0;
        for (let r = range.r0 + 1; r <= range.r1; r++) {
            const cells: EditableCell[] = [];
            for (let c = range.c0; c <= range.c1; c++) cells.push(cellAt(r, c));
            const row: EditableRow = { id: nextId++, cells };
            rowOrder.push(row);
            byId.set(row.id, row);
        }
        return {
            name: sheet.name,
            headers,
            rowOrder,
            byId,
            columnCount,
            nextRowId: nextId,
            undoStack: [],
            redoStack: [],
            savedDepth: 0,
            savedUnreachable: false
        };
    }

    return {
        name: sheet.name,
        headers,
        rowOrder,
        byId,
        columnCount,
        nextRowId: 0,
        undoStack: [],
        redoStack: [],
        savedDepth: 0,
        savedUnreachable: false
    };
}

/** Rebuild a sparse, typed ExcelSheet from an edited working model (origin
 *  normalized to A1). Empty text cells are omitted to keep the model sparse. */
function workingToSheet(ws: WorkingSheet): ExcelSheet {
    const cells: ExcelCell[] = [];
    const push = (r: number, c: number, cell: EditableCell): void => {
        if (cell.t === 'text' && cell.v === '' && cell.w === '') return;
        cells.push({ r, c, t: cell.t, v: cell.v, w: cell.w });
    };
    ws.headers.forEach((cell, c) => push(0, c, cell));
    ws.rowOrder.forEach((row, ri) => {
        row.cells.forEach((cell, c) => push(ri + 1, c, cell));
    });

    const rowCount = ws.rowOrder.length + (ws.columnCount > 0 ? 1 : 0);
    const usedRange =
        ws.columnCount > 0 && rowCount > 0
            ? { r0: 0, c0: 0, r1: rowCount - 1, c1: ws.columnCount - 1 }
            : null;

    return { name: ws.name, usedRange, cells, rowCount, columnCount: ws.columnCount };
}

function emptySheet(name: string): ExcelSheet {
    return { name, usedRange: null, cells: [], rowCount: 0, columnCount: 0 };
}

function clamp(v: number, min: number, max: number): number {
    return Math.min(Math.max(v, min), max);
}
