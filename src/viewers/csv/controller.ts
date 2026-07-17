// CsvController — the behavior-controller layer for the CSV viewer
// (DESIGN.md §3-②). Pure state machine: no DOM, no host services. The DOM
// renderer is one consumer; web (Vue) can consume it directly to share
// interaction semantics. Conformance kit item 3 (action sequence → normalized
// state) runs against this.
//
// Rows are identified by immutable RowIds (not array indexes) so edit-mode
// insert/delete cannot corrupt sort, search, or row numbering
// (docs/viewers/csv.md §6 편집과 저장).

import type { Diagnostic, ParseFailure, ParseResult } from '../../parsers/types.js';
import {
    parseCsv,
    applySort,
    detectColumnType,
    nextSortState,
    computeStatistics,
    serializeRowsToTsv,
    serializeRowsToJson,
    serializeRowsToCsv,
    type ColumnStats,
    type ColumnType,
    type CsvDelimiter,
    type CsvDocument,
    type CsvParseOptions,
    type SortState
} from '../../parsers/csv/index.js';

export const DEFAULT_PAGE_SIZE = 500;
export const UNDO_STACK_LIMIT = 200;

export type RowId = number;

/** Avoid a full-table scan for each very broad single-character query. */
export const CSV_MIN_SEARCH_LENGTH = 2;

interface EditableRow {
    id: RowId;
    cells: string[];
}

export interface CsvViewState {
    /** Parse status of the current document ('failed' keeps the last good doc absent). */
    status: 'ok' | 'partial' | 'failed';
    /** Failure detail when status is 'failed' — the renderer must surface it. */
    failure: ParseFailure | null;
    diagnostics: Diagnostic[];
    headers: string[];
    columnCount: number;
    rowCount: number;
    delimiter: CsvDelimiter;
    detectionSource: 'auto' | 'extension' | 'override';
    sort: SortState;
    sortedColumnType: ColumnType | null;
    /** Entered search text; queries shorter than CSV_MIN_SEARCH_LENGTH are inactive. */
    search: string;
    /** Rows matching the active search (== rowCount when search is inactive). */
    matchedRowCount: number;
    showRowNumbers: boolean;
    /** Unsaved edits exist (undo back to the save point clears this). */
    dirty: boolean;
    canUndo: boolean;
    canRedo: boolean;
    page: number;
    pageCount: number;
    pageSize: number;
    viewMode: 'table' | 'raw';
    statsVisible: boolean;
    /** RowIds visible on the current page, in display order
     *  (sorted, then search-filtered, then paged). */
    visibleRowIds: RowId[];
}

export type CsvAction =
    | { type: 'sort-column'; columnIndex: number }
    | { type: 'set-delimiter'; delimiter: CsvDelimiter | 'auto' }
    | { type: 'set-search'; search: string }
    | { type: 'set-page'; page: number }
    | { type: 'next-page' }
    | { type: 'prev-page' }
    | { type: 'set-page-size'; pageSize: number }
    | { type: 'toggle-row-numbers' }
    | { type: 'set-view-mode'; mode: 'table' | 'raw' }
    | { type: 'toggle-stats' }
    | { type: 'edit-cell'; rowId: RowId; columnIndex: number; value: string }
    | { type: 'edit-header'; columnIndex: number; value: string }
    | { type: 'insert-row'; afterRowId: RowId | 'end' }
    | { type: 'delete-row'; rowId: RowId }
    | { type: 'insert-column'; columnIndex: number }
    | { type: 'delete-column'; columnIndex: number }
    // Raw-view editing: reparse the edited text (active delimiter forced) and
    // swap the whole in-memory document as one undoable edit. Never touches
    // the file — saving stays behind the explicit Save actions (docs §6).
    | { type: 'replace-document'; text: string }
    | { type: 'undo' }
    | { type: 'redo' };

export interface CsvControllerOptions {
    fileName?: string;
    pageSize?: number;
    limits?: CsvParseOptions['limits'];
}

export interface CsvController {
    readonly state: CsvViewState;
    dispatch(action: CsvAction): void;
    subscribe(listener: (state: CsvViewState) => void): () => void;
    /** Cells of a row by its immutable id (padded to columnCount by the parser). */
    getRowById(rowId: RowId): readonly string[];
    /** 1-based position of the row in the current document order. */
    getRowNumber(rowId: RowId): number;
    /** Column statistics for the current document (computed lazily, cached). */
    getStatistics(): ColumnStats[];
    /** Display result (sorted + filtered) as TSV, headers included. */
    toTsv(): string;
    /** Display result as the csv-export@1 JSON envelope. */
    toJson(): string;
    /** Display result as normalized CSV with the active delimiter (file export). */
    toCsv(): string;
    /** Whole document in original order as normalized CSV (save/writeback —
     *  ignores search and sort so hidden rows are never dropped). */
    toDocumentCsv(): string;
    /** Mark the current edit depth as the saved point (clears dirty). */
    markSaved(): void;
    /** Decoded source text (raw view). */
    readonly rawText: string;
    /** Raw-view text: the verbatim source while the document is unedited,
     *  the normalized document serialization once edits exist. */
    toRawText(): string;
}

// Inverse-operation stack entries (docs §6: undo/redo).
type EditOp =
    | { kind: 'cell'; rowId: RowId; columnIndex: number; prev: string; next: string }
    | { kind: 'header'; columnIndex: number; prev: string; next: string }
    | { kind: 'insert' | 'delete'; row: EditableRow; positions: RowPositions }
    | { kind: 'insert-col'; columnIndex: number; header: string }
    // delete-col snapshots the removed cells by RowId so undo can restore
    // them; rows created after the delete never appear in the map.
    | { kind: 'delete-col'; columnIndex: number; header: string; cells: Map<RowId, string> }
    // Whole-document swap (raw-view edit). Snapshots share row objects with
    // the live document — safe because the LIFO stack reverts any op above
    // this one before it can be crossed.
    | { kind: 'document'; prev: DocumentSnapshot; next: DocumentSnapshot };

interface DocumentSnapshot {
    headers: string[];
    rows: EditableRow[];
    columnCount: number;
    parse: ParseResult<CsvDocument>;
    document: CsvDocument;
}

interface RowPositions {
    order: number;
    sorted: number;
    display: number;
}

export function createCsvController(
    source: string | Uint8Array,
    options: CsvControllerOptions = {}
): CsvController {
    const listeners = new Set<(s: CsvViewState) => void>();

    const text =
        typeof source === 'string'
            ? source
            : new TextDecoder('utf-8', { fatal: false }).decode(source);

    let document: CsvDocument = emptyDocument();
    let parse: ParseResult<CsvDocument>;
    let headers: string[] = [];
    /** Live column count — column insert/delete moves it off the parsed value. */
    let columnCount = 0;
    let rowOrder: EditableRow[] = [];
    let byId = new Map<RowId, EditableRow>();
    let orderPos = new Map<RowId, number>();
    let nextRowId = 0;
    let sort: SortState = { columnIndex: null, direction: null };
    let sortedColumnType: ColumnType | null = null;
    /** Document rows in sorted display order (row references). */
    let sortedRows: EditableRow[] = [];
    /** sortedRows filtered by the active search — always a distinct array. */
    let displayRows: EditableRow[] = [];
    let search = '';
    let showRowNumbers = false;
    let pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    let page = 0;
    let viewMode: 'table' | 'raw' = 'table';
    let statsVisible = false;
    let statsCache: ColumnStats[] | null = null;

    const undoStack: EditOp[] = [];
    let redoStack: EditOp[] = [];
    let savedDepth = 0;
    let savedUnreachable = false;
    /** True once the stack overflowed — an empty undo stack then no longer
     *  proves the document equals the original source text. */
    let opsDropped = false;

    function isDirty(): boolean {
        return savedUnreachable || undoStack.length !== savedDepth;
    }

    function rebuildOrderPos(): void {
        orderPos = new Map();
        rowOrder.forEach((row, i) => orderPos.set(row.id, i));
    }

    function rowMatches(row: EditableRow, term: string): boolean {
        for (const cell of row.cells) {
            if (cell.toLowerCase().includes(term)) return true;
        }
        return false;
    }

    function hasActiveSearch(): boolean {
        return search.length >= CSV_MIN_SEARCH_LENGTH;
    }

    /** Search filters over the sorted display order (docs §6). */
    function refilter(): void {
        if (!hasActiveSearch()) {
            displayRows = sortedRows.slice();
            return;
        }
        const term = search.toLowerCase();
        displayRows = sortedRows.filter((r) => rowMatches(r, term));
    }

    function resort(): void {
        if (sort.columnIndex === null || !sort.direction) {
            sortedRows = rowOrder.slice();
            sortedColumnType = null;
        } else {
            const col = sort.columnIndex;
            sortedColumnType = detectColumnType(rowOrder.map((r) => r.cells[col] ?? ''));
            const positions = applySort(
                identity(rowOrder.length),
                sort,
                (rowIndex, columnIndex) => rowOrder[rowIndex]?.cells[columnIndex] ?? '',
                sortedColumnType
            );
            sortedRows = positions.map((p) => rowOrder[p] as EditableRow);
        }
        refilter();
    }

    function reparse(delimiter: CsvDelimiter | undefined): void {
        const parseOptions: CsvParseOptions = {};
        if (delimiter !== undefined) parseOptions.delimiter = delimiter;
        if (options.fileName !== undefined) parseOptions.fileName = options.fileName;
        if (options.limits !== undefined) parseOptions.limits = options.limits;
        parse = parseCsv(text, parseOptions).result;
        document = parse.status === 'failed' ? emptyDocument() : parse.document;
        headers = [...document.headers];
        columnCount = document.columnCount;
        nextRowId = 0;
        rowOrder = document.rows.map((cells) => ({ id: nextRowId++, cells: [...cells] }));
        byId = new Map(rowOrder.map((r) => [r.id, r]));
        rebuildOrderPos();
        sort = { columnIndex: null, direction: null };
        sortedColumnType = null;
        // The search term survives a reparse and reapplies to the new document.
        resort();
        page = 0;
        statsCache = null;
        undoStack.length = 0;
        redoStack = [];
        savedDepth = 0;
        savedUnreachable = false;
        opsDropped = false;
    }

    // ------------------------------------------------------------- edit ops

    function addRowAt(row: EditableRow, positions: RowPositions): void {
        rowOrder.splice(clamp(positions.order, 0, rowOrder.length), 0, row);
        sortedRows.splice(clamp(positions.sorted, 0, sortedRows.length), 0, row);
        // display === -1 records "was filtered out" — don't resurface it.
        if (positions.display >= 0) {
            displayRows.splice(clamp(positions.display, 0, displayRows.length), 0, row);
        }
        byId.set(row.id, row);
        rebuildOrderPos();
    }

    function removeRow(row: EditableRow): void {
        const removeFrom = (arr: EditableRow[]) => {
            const i = arr.indexOf(row);
            if (i >= 0) arr.splice(i, 1);
        };
        removeFrom(rowOrder);
        removeFrom(sortedRows);
        removeFrom(displayRows);
        byId.delete(row.id);
        rebuildOrderPos();
    }

    // Column ops mutate the shared row objects, so rowOrder / sortedRows /
    // displayRows all see the change without re-deriving. Display order is
    // deliberately untouched (docs §6: edits never reshuffle the view) — the
    // sort column index just shifts with the columns, and deleting the sorted
    // column clears the sort marker while keeping the current order on screen.
    function insertColumnAt(
        columnIndex: number,
        header: string,
        cells?: Map<RowId, string>
    ): void {
        headers.splice(columnIndex, 0, header);
        for (const row of rowOrder) {
            row.cells.splice(columnIndex, 0, cells?.get(row.id) ?? '');
        }
        columnCount++;
        if (sort.columnIndex !== null && sort.columnIndex >= columnIndex) {
            sort = { ...sort, columnIndex: sort.columnIndex + 1 };
        }
    }

    function removeColumnAt(columnIndex: number): void {
        headers.splice(columnIndex, 1);
        for (const row of rowOrder) {
            row.cells.splice(columnIndex, 1);
        }
        columnCount--;
        if (sort.columnIndex !== null) {
            if (sort.columnIndex === columnIndex) {
                sort = { columnIndex: null, direction: null };
                sortedColumnType = null;
            } else if (sort.columnIndex > columnIndex) {
                sort = { ...sort, columnIndex: sort.columnIndex - 1 };
            }
        }
    }

    function applyOp(op: EditOp, direction: 'forward' | 'backward'): void {
        switch (op.kind) {
            case 'cell': {
                const row = byId.get(op.rowId);
                if (row) {
                    row.cells[op.columnIndex] =
                        direction === 'forward' ? op.next : op.prev;
                }
                break;
            }
            case 'header': {
                headers[op.columnIndex] = direction === 'forward' ? op.next : op.prev;
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
            case 'insert-col': {
                if (direction === 'forward') insertColumnAt(op.columnIndex, op.header);
                else removeColumnAt(op.columnIndex);
                break;
            }
            case 'delete-col': {
                if (direction === 'forward') removeColumnAt(op.columnIndex);
                else insertColumnAt(op.columnIndex, op.header, op.cells);
                break;
            }
            case 'document': {
                const target = direction === 'forward' ? op.next : op.prev;
                headers = target.headers;
                rowOrder = target.rows.slice();
                byId = new Map(rowOrder.map((r) => [r.id, r]));
                rebuildOrderPos();
                columnCount = target.columnCount;
                parse = target.parse;
                document = target.document;
                // The sorted column may not exist in the swapped-in document.
                if (sort.columnIndex !== null && sort.columnIndex >= columnCount) {
                    sort = { columnIndex: null, direction: null };
                    sortedColumnType = null;
                }
                resort();
                break;
            }
        }
        statsCache = null;
    }

    function pushOp(op: EditOp): void {
        applyOp(op, 'forward');
        if (redoStack.length > 0) {
            // The saved point may live in the discarded redo branch.
            if (savedDepth > undoStack.length) savedUnreachable = true;
            redoStack = [];
        }
        undoStack.push(op);
        if (undoStack.length > UNDO_STACK_LIMIT) {
            undoStack.shift();
            opsDropped = true;
            if (savedDepth > 0) savedDepth--;
            else savedUnreachable = true;
        }
    }

    function documentCsv(): string {
        return serializeRowsToCsv(
            rowOrder.map((r) => r.cells),
            headers,
            document.delimiter
        );
    }

    /** Verbatim source while provably unedited (original quoting and line
     *  endings preserved); normalized serialization once edits exist. */
    function toRawText(): string {
        return undoStack.length === 0 && !opsDropped ? text : documentCsv();
    }

    // -------------------------------------------------------------- state

    function pageCount(): number {
        return Math.max(1, Math.ceil(displayRows.length / pageSize));
    }

    function buildState(): CsvViewState {
        const start = page * pageSize;
        return {
            status: parse.status,
            failure: parse.status === 'failed' ? parse.failure : null,
            diagnostics: parse.diagnostics,
            headers: [...headers],
            columnCount,
            rowCount: rowOrder.length,
            delimiter: document.delimiter,
            detectionSource: document.detection.source,
            sort,
            sortedColumnType,
            search,
            matchedRowCount: displayRows.length,
            showRowNumbers,
            dirty: isDirty(),
            canUndo: undoStack.length > 0,
            canRedo: redoStack.length > 0,
            page,
            pageCount: pageCount(),
            pageSize,
            viewMode,
            statsVisible,
            visibleRowIds: displayRows.slice(start, start + pageSize).map((r) => r.id)
        };
    }

    let state: CsvViewState;

    function commit(): void {
        state = buildState();
        for (const listener of listeners) listener(state);
    }

    reparse(undefined);
    state = buildState();

    function dispatch(action: CsvAction): void {
        switch (action.type) {
            case 'sort-column': {
                if (action.columnIndex < 0 || action.columnIndex >= columnCount) {
                    return;
                }
                sort = nextSortState(sort, action.columnIndex);
                resort();
                page = 0;
                break;
            }
            case 'set-delimiter': {
                // Reparsing would discard edits (docs §6 dirty guard).
                if (isDirty()) return;
                reparse(action.delimiter === 'auto' ? undefined : action.delimiter);
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
                if (!Number.isInteger(action.pageSize) || action.pageSize <= 0) {
                    return;
                }
                if (action.pageSize === pageSize) return;
                const firstVisiblePosition = page * pageSize;
                pageSize = action.pageSize;
                page = Math.floor(firstVisiblePosition / pageSize);
                break;
            }
            case 'toggle-row-numbers': {
                showRowNumbers = !showRowNumbers;
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
                viewMode = action.mode;
                break;
            }
            case 'toggle-stats': {
                statsVisible = !statsVisible;
                break;
            }
            case 'edit-cell': {
                if (parse.status !== 'ok') return; // docs §6 결정 2
                const row = byId.get(action.rowId);
                if (!row) return;
                if (action.columnIndex < 0 || action.columnIndex >= columnCount) {
                    return;
                }
                const prev = row.cells[action.columnIndex] ?? '';
                if (prev === action.value) return;
                pushOp({
                    kind: 'cell',
                    rowId: action.rowId,
                    columnIndex: action.columnIndex,
                    prev,
                    next: action.value
                });
                break;
            }
            case 'edit-header': {
                if (parse.status !== 'ok') return;
                if (action.columnIndex < 0 || action.columnIndex >= headers.length) {
                    return;
                }
                const prev = headers[action.columnIndex] ?? '';
                if (prev === action.value) return;
                pushOp({
                    kind: 'header',
                    columnIndex: action.columnIndex,
                    prev,
                    next: action.value
                });
                break;
            }
            case 'insert-row': {
                if (parse.status !== 'ok') return;
                const row: EditableRow = {
                    id: nextRowId++,
                    cells: Array.from({ length: columnCount }, () => '')
                };
                let positions: RowPositions;
                if (action.afterRowId === 'end') {
                    positions = {
                        order: rowOrder.length,
                        sorted: sortedRows.length,
                        display: displayRows.length
                    };
                } else {
                    const after = byId.get(action.afterRowId);
                    if (!after) return;
                    // The new row shows right below the clicked one regardless
                    // of sort/filter — an invisible new row cannot be edited.
                    positions = {
                        order: (orderPos.get(after.id) ?? rowOrder.length - 1) + 1,
                        sorted: sortedRows.indexOf(after) + 1 || sortedRows.length,
                        display: displayRows.indexOf(after) + 1 || displayRows.length
                    };
                }
                pushOp({ kind: 'insert', row, positions });
                break;
            }
            case 'delete-row': {
                if (parse.status !== 'ok') return;
                const row = byId.get(action.rowId);
                if (!row) return;
                pushOp({
                    kind: 'delete',
                    row,
                    positions: {
                        order: orderPos.get(row.id) ?? 0,
                        sorted: sortedRows.indexOf(row),
                        display: displayRows.indexOf(row)
                    }
                });
                break;
            }
            case 'insert-column': {
                if (parse.status !== 'ok') return;
                if (action.columnIndex < 0 || action.columnIndex > columnCount) {
                    return;
                }
                pushOp({
                    kind: 'insert-col',
                    columnIndex: action.columnIndex,
                    header: `Column${columnCount + 1}`
                });
                break;
            }
            case 'delete-column': {
                if (parse.status !== 'ok') return;
                // Deleting the last column would leave an unrepresentable
                // zero-column document.
                if (columnCount <= 1) return;
                if (action.columnIndex < 0 || action.columnIndex >= columnCount) {
                    return;
                }
                pushOp({
                    kind: 'delete-col',
                    columnIndex: action.columnIndex,
                    header: headers[action.columnIndex] ?? '',
                    cells: new Map(
                        rowOrder.map((r) => [r.id, r.cells[action.columnIndex] ?? ''])
                    )
                });
                break;
            }
            case 'replace-document': {
                if (parse.status !== 'ok') return;
                if (action.text === toRawText()) return;
                // The active delimiter is forced so mid-edit text never flips
                // the document to a surprise delimiter; switching stays with
                // the delimiter select (and its dirty guard).
                const parseOptions: CsvParseOptions = { delimiter: document.delimiter };
                if (options.fileName !== undefined) parseOptions.fileName = options.fileName;
                if (options.limits !== undefined) parseOptions.limits = options.limits;
                const next = parseCsv(action.text, parseOptions).result;
                // A swap that cannot represent the full text (partial/failed,
                // e.g. over the row limit) is refused; the good document stays.
                // Emptied text parses 'ok' and legitimately empties the document.
                if (next.status !== 'ok') return;
                const nextRows = next.document.rows.map((cells) => ({
                    id: nextRowId++,
                    cells: [...cells]
                }));
                pushOp({
                    kind: 'document',
                    prev: {
                        headers,
                        rows: rowOrder.slice(),
                        columnCount,
                        parse,
                        document
                    },
                    next: {
                        headers: [...next.document.headers],
                        rows: nextRows,
                        columnCount: next.document.columnCount,
                        parse: next,
                        document: next.document
                    }
                });
                page = 0;
                break;
            }
            case 'undo': {
                const op = undoStack.pop();
                if (!op) return;
                applyOp(op, 'backward');
                redoStack.push(op);
                break;
            }
            case 'redo': {
                const op = redoStack.pop();
                if (!op) return;
                applyOp(op, 'forward');
                undoStack.push(op);
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
            return byId.get(rowId)?.cells ?? [];
        },
        getRowNumber(rowId) {
            return (orderPos.get(rowId) ?? -1) + 1;
        },
        getStatistics() {
            if (!statsCache) {
                statsCache = computeStatistics(
                    rowOrder.map((r) => r.cells),
                    headers
                );
            }
            return statsCache;
        },
        toTsv() {
            // Copy targets the current display result: sorted + search-filtered
            // (docs §6). sourceRowsLoaded below stays the unfiltered total.
            return serializeRowsToTsv(
                displayRows.map((r) => r.cells),
                headers
            );
        },
        toJson() {
            return serializeRowsToJson(
                displayRows.map((r) => r.cells),
                headers,
                {
                    scope: 'loaded-results',
                    sourceRowsLoaded: rowOrder.length,
                    sourceFullyScanned: parse.status === 'ok'
                }
            );
        },
        toCsv() {
            return serializeRowsToCsv(
                displayRows.map((r) => r.cells),
                headers,
                document.delimiter
            );
        },
        toDocumentCsv() {
            return documentCsv();
        },
        markSaved() {
            savedDepth = undoStack.length;
            savedUnreachable = false;
            commit();
        },
        rawText: text,
        toRawText
    };
}

function emptyDocument(): CsvDocument {
    return {
        headers: [],
        rows: [],
        columnCount: 0,
        delimiter: ',',
        detection: { delimiter: ',', confidence: 0, source: 'auto' }
    };
}

function identity(n: number): number[] {
    return Array.from({ length: n }, (_, i) => i);
}

function clamp(v: number, min: number, max: number): number {
    return Math.min(Math.max(v, min), max);
}
