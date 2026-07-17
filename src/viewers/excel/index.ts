// Excel viewer — DOM renderer consuming ExcelController (DESIGN.md §3-②,
// docs/viewers/excel.md §3).
//
// Base entry rule (ADR 14): no runtime `import 'xlsx'` here. SheetJS is
// injected through `ExcelViewerDeps.loadXlsx`; `viewers/excel/self-loading`
// supplies the dynamic-import loader. If loading fails the viewer renders a
// visible missing-dependency reason (degraded, ADR 24) — never a blank frame.
//
// CSP rules: no eval, no inline handlers, no innerHTML — createElement /
// textContent only. Mount is async and renders inside a shadow root by default
// (§6 reverse-contamination contract).
//
// Optional services: `clipboard`. Without it the copy buttons render disabled
// with an explanatory tooltip (degraded mode, ADR 24) — never hidden.

import type { ClipboardService, FileSaveService, HostContext } from '../../host/index.js';
import {
    MountAbortedError,
    VIEWER_ROOT_CLASS,
    type MountOptions,
    type ViewerHandle,
    type ViewerInput
} from '../types.js';
import type { ParseResult } from '../../parsers/types.js';
import { utf8ByteLength, type ResourceLimits } from '../../parsers/types.js';
import {
    parseExcel,
    serializeWorkbook,
    type ExcelParseDeps,
    type ExcelWorkbook
} from '../../parsers/excel/index.js';
import {
    createExcelController,
    EXCEL_DEFAULT_PAGE_SIZE,
    type ExcelController,
    type ExcelViewState
} from './controller.js';
import { excelViewerCss } from './styles.js';
import type { GridView } from './grid.js';

export { createExcelController, EXCEL_DEFAULT_PAGE_SIZE } from './controller.js';
export { buildGridView } from './grid.js';
export type { GridView, GridCell, GridRow } from './grid.js';
export type {
    ExcelController,
    ExcelViewState,
    ExcelAction,
    ExcelControllerOptions
} from './controller.js';
export { excelViewerCss } from './styles.js';

/** Viewer metadata — single source for the registry codegen (DESIGN.md §7). */
export const EXCEL_VIEWER_META = {
    id: 'excel',
    displayNameKey: 'excel.tableView',
    extensions: ['xlsx', 'xlsm', 'xlsb', 'ods', 'xls'],
    priority: 15,
    requiredServices: [] as const,
    optionalServices: ['clipboard', 'save'] as const,
    inputOwnership: 'consumes' as const
};

export type ExcelViewerContext = HostContext & {
    clipboard?: ClipboardService;
    save?: FileSaveService;
};

/** SheetJS module, injected by the adapter (ADR 14). Same shape the parser
 *  consumes, so the loaded module flows straight into parseExcel. */
export interface ExcelViewerDeps {
    loadXlsx(): Promise<ExcelParseDeps['xlsx']>;
}

export interface ExcelMountOptions extends MountOptions {
    /** Parser resource limits (docs/viewers/excel.md §4); adapters may tighten. */
    limits?: ResourceLimits;
    pageSize?: number;
}

export type ExcelViewerHandle = ViewerHandle;

/** Clipboard copy guard (docs/viewers/excel.md §3, X7): larger payloads refused. */
export const EXCEL_COPY_PAYLOAD_LIMIT_BYTES = 1024 * 1024;
const EXCEL_MIME_TYPE =
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const MIN_COLUMN_WIDTH = 40;
const FALLBACK_COLUMN_WIDTH = 120;

/** Header single-click sort is deferred briefly so a double-click can win and
 *  open the rename editor instead (matches the CSV viewer). */
const SORT_CLICK_DELAY_MS = 250;

export async function mountExcelViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: ExcelViewerContext,
    deps: ExcelViewerDeps,
    options: ExcelMountOptions = {}
): Promise<ExcelViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();

    // Load SheetJS + parse (both async) before we own any DOM.
    let result: ParseResult<ExcelWorkbook>;
    let xlsx: ExcelParseDeps['xlsx'] | null = null;
    try {
        xlsx = await deps.loadXlsx();
        if (options.signal?.aborted) throw new MountAbortedError();
        const parseOptions = options.limits !== undefined ? { limits: options.limits } : {};
        result = parseExcel(input.data, { xlsx }, parseOptions).result;
    } catch (err) {
        if (err instanceof MountAbortedError) throw err;
        ctx.logger.log('error', `excel: xlsx load failed: ${String(err)}`);
        // Missing dependency is a visible, uniform degraded state (ADR 24) —
        // the adapter's fallback chain (§7) sits above this.
        result = {
            status: 'failed',
            failure: {
                code: 'missing-dependency',
                retryable: false,
                messageKey: 'diag.excel.missing-dependency'
            },
            diagnostics: []
        };
    }

    const controllerOptions =
        options.pageSize !== undefined ? { pageSize: options.pageSize } : {};
    const controller = createExcelController(result, controllerOptions);

    const isolation = options.styleIsolation ?? 'shadow';
    let root: HTMLElement | ShadowRoot;
    if (isolation === 'shadow' && typeof container.attachShadow === 'function') {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = excelViewerCss;
        root.appendChild(style);
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--excel');
        root = container;
    }

    const t = ctx.i18n.t.bind(ctx.i18n);
    const disposers: Array<() => void> = [];
    let toastTimer: ReturnType<typeof setTimeout> | null = null;
    /** Session-scoped widths for the displayed sheet; null means auto width. */
    let columnWidths: (number | null)[] | null = null;
    let activeResizeCleanup: (() => void) | null = null;
    let pendingSortTimer: ReturnType<typeof setTimeout> | null = null;
    let contextMenuCleanup: (() => void) | null = null;

    const el = <K extends keyof HTMLElementTagNameMap>(
        tag: K,
        className?: string,
        text?: string
    ): HTMLElementTagNameMap[K] => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };

    const on = <K extends keyof HTMLElementEventMap>(
        target: HTMLElement,
        type: K,
        handler: (ev: HTMLElementEventMap[K]) => void
    ): void => {
        target.addEventListener(type, handler as EventListener);
        disposers.push(() => target.removeEventListener(type, handler as EventListener));
    };

    // --- static frame -------------------------------------------------------
    const frame = el('div', 'omni-excel');
    frame.style.position = 'relative';

    const toolbar = el('div', 'omni-excel__toolbar');

    const sheetLabel = el('label', undefined, t('excel.sheet'));
    const sheetSelect = el('select');
    sheetSelect.setAttribute('aria-label', t('excel.sheet'));
    sheetLabel.appendChild(sheetSelect);
    on(sheetSelect, 'change', () =>
        controller.dispatch({ type: 'switch-sheet', index: Number(sheetSelect.value) })
    );

    const searchInput = el('input', 'omni-excel__search');
    searchInput.type = 'search';
    searchInput.placeholder = t('excel.search');
    searchInput.setAttribute('aria-label', t('excel.search'));
    on(searchInput, 'input', () =>
        controller.dispatch({ type: 'set-search', search: searchInput.value })
    );

    // Three view modes (X3): Table (editable data), Grid (read-only WYSIWYG),
    // Raw (JSON). A select keeps all three reachable in one control.
    const viewModeSelect = el('select');
    viewModeSelect.setAttribute('aria-label', t('excel.viewMode'));
    for (const [value, key] of [
        ['table', 'excel.tableViewLabel'],
        ['grid', 'excel.gridView'],
        ['raw', 'excel.rawView']
    ] as const) {
        const opt = el('option', undefined, t(key));
        opt.value = value;
        viewModeSelect.appendChild(opt);
    }
    on(viewModeSelect, 'change', () =>
        controller.dispatch({
            type: 'set-view-mode',
            mode: viewModeSelect.value as 'table' | 'grid' | 'raw'
        })
    );

    const copyTsvBtn = el('button', undefined, t('excel.copyTsv'));
    copyTsvBtn.type = 'button';
    const copyJsonBtn = el('button', undefined, t('excel.copyJson'));
    copyJsonBtn.type = 'button';
    const clipboard = ctx.clipboard;
    if (clipboard) {
        on(copyTsvBtn, 'click', () => void copy(clipboard, controller.toTsv()));
        on(copyJsonBtn, 'click', () => void copy(clipboard, controller.toJson()));
    } else {
        for (const btn of [copyTsvBtn, copyJsonBtn]) {
            btn.disabled = true;
            btn.title = t('common.noClipboard');
        }
    }

    // Export re-serializes the original parsed model with cell types preserved
    // (parsers/excel serializeWorkbook), not the display strings — so numbers,
    // dates, and booleans survive the round-trip. Read-only: this is save-as, no
    // editing / writeback (docs/viewers/excel.md §1, X7).
    const exportBtn = el('button', undefined, t('excel.export'));
    exportBtn.type = 'button';
    const save = ctx.save;
    if (!save || !xlsx) {
        // Degraded mode (ADR 24): export needs both a save service and SheetJS.
        exportBtn.disabled = true;
        exportBtn.title = t('common.noFileSave');
    } else {
        on(exportBtn, 'click', () => void exportWorkbook(save));
    }

    function exportFileName(fileName: string): string {
        const stem = fileName.replace(/\.[^./\\]+$/, '') || 'spreadsheet';
        return `${stem}.xlsx`;
    }

    async function exportWorkbook(service: FileSaveService): Promise<void> {
        if (!xlsx || controller.state.status === 'failed') return;
        try {
            const data = serializeWorkbook(controller.getWorkbook(), xlsx);
            const name = exportFileName(input.fileName);
            await service.saveFile(name, data, EXCEL_MIME_TYPE);
            // Exported bytes now match the in-session edits — clear the dirty flag.
            controller.markSaved();
            showToast(t('common.saved', { name }));
        } catch (error) {
            ctx.logger.log('error', `excel export failed: ${String(error)}`);
            showToast(t('common.saveFailed'));
        }
    }

    // Editing controls (X-편집): shown once editing has started (docs §3).
    const undoBtn = el('button', undefined, '↶');
    undoBtn.type = 'button';
    undoBtn.setAttribute('aria-label', t('excel.undo'));
    on(undoBtn, 'click', () => controller.dispatch({ type: 'undo' }));

    const redoBtn = el('button', undefined, '↷');
    redoBtn.type = 'button';
    redoBtn.setAttribute('aria-label', t('excel.redo'));
    on(redoBtn, 'click', () => controller.dispatch({ type: 'redo' }));

    const dirtyBadge = el('span', 'omni-excel__dirty');
    const meta = el('span', 'omni-excel__meta');

    toolbar.append(
        sheetLabel,
        searchInput,
        viewModeSelect,
        undoBtn,
        redoBtn,
        copyTsvBtn,
        copyJsonBtn,
        exportBtn,
        el('span', 'omni-excel__spacer'),
        dirtyBadge,
        meta
    );

    const diagnosticsBar = el('div', 'omni-excel__diagnostics');
    const body = el('div', 'omni-excel__body');

    const footer = el('div', 'omni-excel__footer');
    const prevBtn = el('button', undefined, '‹');
    prevBtn.type = 'button';
    prevBtn.setAttribute('aria-label', t('common.prevPage'));
    const nextBtn = el('button', undefined, '›');
    nextBtn.type = 'button';
    nextBtn.setAttribute('aria-label', t('common.nextPage'));
    const pageInfo = el('span', 'omni-excel__meta');
    on(prevBtn, 'click', () => controller.dispatch({ type: 'prev-page' }));
    on(nextBtn, 'click', () => controller.dispatch({ type: 'next-page' }));
    footer.append(prevBtn, pageInfo, nextBtn);

    frame.append(toolbar, diagnosticsBar, body, footer);
    root.appendChild(frame);

    function showToast(message: string): void {
        frame.querySelector('.omni-excel__toast')?.remove();
        const toast = el('div', 'omni-excel__toast', message);
        frame.appendChild(toast);
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.remove(), 1500);
    }

    async function copy(service: ClipboardService, payload: string): Promise<void> {
        const payloadBytes = utf8ByteLength(payload);
        if (payloadBytes > EXCEL_COPY_PAYLOAD_LIMIT_BYTES) {
            showToast(t('common.copyTooLarge', { size: payloadBytes }));
            return;
        }
        try {
            await service.writeText(payload);
            showToast(t('common.copied'));
        } catch (error) {
            ctx.logger.log('error', `excel copy failed: ${String(error)}`);
        }
    }

    function closeContextMenu(): void {
        contextMenuCleanup?.();
        contextMenuCleanup = null;
    }

    /** Right-click row menu: insert below / delete (docs §3, CSV parity). */
    function openRowContextMenu(event: MouseEvent, rowId: number): void {
        closeContextMenu();
        const menu = el('div', 'omni-excel__menu');
        menu.setAttribute('role', 'menu');
        const item = (label: string, action: () => void) => {
            const btn = el('button', undefined, label);
            btn.type = 'button';
            btn.setAttribute('role', 'menuitem');
            btn.addEventListener('click', () => {
                closeContextMenu();
                action();
            });
            menu.appendChild(btn);
        };
        item(t('excel.insertRowBelow'), () =>
            controller.dispatch({ type: 'insert-row', afterRowId: rowId })
        );
        item(t('excel.deleteRow'), () => controller.dispatch({ type: 'delete-row', rowId }));

        const frameRect = frame.getBoundingClientRect();
        menu.style.left = `${event.clientX - frameRect.left}px`;
        menu.style.top = `${event.clientY - frameRect.top}px`;
        frame.appendChild(menu);

        // Events crossing the shadow boundary retarget to the host, so use
        // composedPath to detect clicks inside the menu.
        const onOutside = (e: Event) => {
            if (e.composedPath().includes(menu)) return;
            closeContextMenu();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closeContextMenu();
        };
        window.addEventListener('pointerdown', onOutside, true);
        window.addEventListener('keydown', onKey, true);
        contextMenuCleanup = () => {
            window.removeEventListener('pointerdown', onOutside, true);
            window.removeEventListener('keydown', onKey, true);
            menu.remove();
        };
    }

    /** Swap a cell's content for a text input; Enter/blur commits, Esc cancels. */
    function startInlineEdit(
        cell: HTMLElement,
        current: string,
        commit: (value: string) => void
    ): void {
        const inputEl = document.createElement('input');
        inputEl.type = 'text';
        inputEl.className = 'omni-excel__cell-input';
        inputEl.value = current;
        let done = false;
        const finish = (commitValue: boolean) => {
            if (done) return;
            done = true;
            if (commitValue && inputEl.value !== current) commit(inputEl.value);
            else render(controller.state);
        };
        inputEl.addEventListener('keydown', (e) => {
            e.stopPropagation(); // keep typing out of sort/undo shortcuts
            if (e.key === 'Enter') {
                e.preventDefault();
                finish(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                finish(false);
            }
        });
        inputEl.addEventListener('blur', () => finish(true));
        inputEl.addEventListener('click', (e) => e.stopPropagation());
        cell.replaceChildren(inputEl);
        inputEl.focus();
        if (typeof inputEl.select === 'function') inputEl.select();
    }

    // --- state-driven rendering --------------------------------------------
    function render(state: ExcelViewState): void {
        // Sheet options rebuild only when the set changes (stable identity).
        if (sheetSelect.options.length !== state.sheetNames.length) {
            sheetSelect.replaceChildren();
            state.sheetNames.forEach((name, index) => {
                const opt = el('option', undefined, name);
                opt.value = String(index);
                sheetSelect.appendChild(opt);
            });
        }
        sheetSelect.value = String(state.sheetIndex);
        sheetSelect.style.display = state.sheetNames.length > 1 ? '' : 'none';
        sheetLabel.style.display = state.sheetNames.length > 1 ? '' : 'none';

        if (searchInput.value !== state.search) searchInput.value = state.search;
        searchInput.disabled = state.viewMode === 'raw';
        viewModeSelect.value = state.viewMode;

        // Undo/redo surface once editing has started (docs §3); pure readers
        // never see them. Dirty badge + save enablement track unsaved edits.
        const editingActive = state.dirty || state.canUndo || state.canRedo;
        for (const btn of [undoBtn, redoBtn]) btn.style.display = editingActive ? '' : 'none';
        undoBtn.disabled = !state.canUndo;
        redoBtn.disabled = !state.canRedo;
        dirtyBadge.textContent = state.workbookDirty ? t('common.unsaved') : '';

        // Search highlights in table (row filter) and grid (cell highlight);
        // it is inactive in raw mode.
        const term = state.viewMode !== 'raw' && state.search ? state.search.toLowerCase() : '';
        const tableSearch = state.viewMode === 'table' && term !== '';
        const rowSummary = tableSearch
            ? t('common.rowsMatched', { matched: state.matchedRowCount, total: state.rowCount })
            : t('common.rows', { count: state.rowCount });
        let metaText = `${rowSummary} · ${t('common.columns', { count: state.columnCount })}`;
        if (tableSearch) {
            metaText += ` · ${t('excel.matchedCells', { count: state.matchedCellCount })}`;
        }
        meta.textContent = metaText;

        diagnosticsBar.replaceChildren();
        const hasNotices = state.diagnostics.length > 0 || state.failure !== null;
        diagnosticsBar.style.display = hasNotices ? '' : 'none';
        if (state.failure) {
            diagnosticsBar.appendChild(
                el('div', 'omni-excel__diag-error', t(state.failure.messageKey, state.failure.args))
            );
        }
        for (const diag of state.diagnostics) {
            diagnosticsBar.appendChild(el('div', undefined, t(diag.messageKey, diag.args)));
        }

        body.replaceChildren();
        if (state.viewMode === 'raw') {
            body.appendChild(el('pre', 'omni-excel__raw', controller.rawJson()));
        } else if (state.viewMode === 'grid') {
            const grid = controller.getGrid();
            if (!grid || grid.rows.length === 0) {
                body.appendChild(el('div', 'omni-excel__empty', t('excel.empty')));
            } else {
                if (grid.truncatedRows !== null) {
                    body.appendChild(
                        el('div', 'omni-excel__diag-error', t('excel.gridTruncated', { count: grid.truncatedRows }))
                    );
                }
                body.appendChild(renderGrid(grid, term));
            }
        } else if (state.rowCount === 0) {
            body.appendChild(el('div', 'omni-excel__empty', t('excel.empty')));
        } else {
            body.appendChild(renderTable(state, tableSearch));
        }

        const showPager = state.pageCount > 1 && state.viewMode === 'table';
        footer.style.display = showPager ? '' : 'none';
        if (showPager) {
            pageInfo.textContent = t('common.page', {
                page: state.page + 1,
                pages: state.pageCount
            });
            prevBtn.disabled = state.page === 0;
            nextBtn.disabled = state.page >= state.pageCount - 1;
        }
    }

    function renderTable(state: ExcelViewState, searchActive: boolean): HTMLTableElement {
        const table = el('table', 'omni-excel__table');
        const term = searchActive ? state.search.toLowerCase() : '';

        // A sheet with a different column count cannot share frozen widths.
        if (columnWidths && columnWidths.length !== state.columnCount) {
            columnWidths = null;
        }
        const colgroup = el('colgroup');
        const dataCols: HTMLTableColElement[] = [];
        for (let c = 0; c < state.columnCount; c++) {
            const col = el('col');
            const width = columnWidths?.[c];
            if (width != null) col.style.width = `${width}px`;
            dataCols.push(col);
            colgroup.appendChild(col);
        }
        table.appendChild(colgroup);
        if (columnWidths) applyFixedLayout();

        const dataThs: HTMLTableCellElement[] = [];

        /** Keep a fixed total width while a boundary transfers width between
         * adjacent columns, matching the CSV viewer interaction. */
        function applyFixedLayout(): void {
            if (!columnWidths) return;
            const width = columnWidths.reduce<number>((total, columnWidth) =>
                total + (columnWidth ?? 0), 0
            );
            table.style.tableLayout = 'fixed';
            table.style.width = `${width}px`;
            table.style.minWidth = '0';
        }

        function freezeWidths(): void {
            if (columnWidths) return;
            columnWidths = dataThs.map((th) =>
                Math.max(th.offsetWidth || FALLBACK_COLUMN_WIDTH, MIN_COLUMN_WIDTH)
            );
            columnWidths.forEach((width, index) => {
                const col = dataCols[index];
                if (col && width != null) col.style.width = `${width}px`;
            });
            applyFixedLayout();
        }

        function startResize(event: MouseEvent, columnIndex: number): void {
            event.preventDefault();
            event.stopPropagation();
            activeResizeCleanup?.();
            freezeWidths();
            const adjacentColumnIndex = columnIndex + 1;
            if (!columnWidths || adjacentColumnIndex >= columnWidths.length) return;

            const frozenWidths = columnWidths;
            const startX = event.clientX;
            const startWidth = frozenWidths[columnIndex] ?? FALLBACK_COLUMN_WIDTH;
            const startAdjacentWidth =
                frozenWidths[adjacentColumnIndex] ?? FALLBACK_COLUMN_WIDTH;
            const onMove = (ev: Event) => {
                const requestedDelta = Math.round((ev as MouseEvent).clientX - startX);
                const delta = Math.min(
                    Math.max(requestedDelta, MIN_COLUMN_WIDTH - startWidth),
                    startAdjacentWidth - MIN_COLUMN_WIDTH
                );
                frozenWidths[columnIndex] = startWidth + delta;
                frozenWidths[adjacentColumnIndex] = startAdjacentWidth - delta;
                const col = dataCols[columnIndex];
                const adjacentCol = dataCols[adjacentColumnIndex];
                if (col) col.style.width = `${frozenWidths[columnIndex]}px`;
                if (adjacentCol) {
                    adjacentCol.style.width = `${frozenWidths[adjacentColumnIndex]}px`;
                }
            };
            const onUp = () => activeResizeCleanup?.();
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            activeResizeCleanup = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                activeResizeCleanup = null;
            };
        }

        const thead = el('thead');
        const headRow = el('tr');
        state.headers.forEach((header, columnIndex) => {
            const th = el('th');
            th.appendChild(el('span', undefined, header));
            th.setAttribute('role', 'columnheader');
            th.title = t('excel.sortHint');
            dataThs.push(th);

            const resizeHandle = el('span', 'omni-excel__resize-handle');
            resizeHandle.title = t('excel.resizeColumn');
            resizeHandle.addEventListener('pointerdown', (event) =>
                startResize(event as MouseEvent, columnIndex)
            );
            // Do not let a completed resize trigger header sorting.
            resizeHandle.addEventListener('click', (event) => event.stopPropagation());
            resizeHandle.addEventListener('dblclick', (event) => {
                event.stopPropagation();
                if (!columnWidths) return;
                columnWidths[columnIndex] = null;
                if (columnWidths.every((width) => width == null)) columnWidths = null;
                render(controller.state);
            });
            th.appendChild(resizeHandle);
            if (state.sort.columnIndex === columnIndex && state.sort.direction) {
                th.setAttribute(
                    'aria-sort',
                    state.sort.direction === 'asc' ? 'ascending' : 'descending'
                );
                th.appendChild(
                    el(
                        'span',
                        'omni-excel__sort-indicator',
                        state.sort.direction === 'asc' ? '▲' : '▼'
                    )
                );
            }
            // Single click sorts (deferred so a double-click can win); double
            // click renames the header when editable (docs §3, CSV parity).
            th.addEventListener('click', () => {
                if (th.querySelector('input')) return;
                if (pendingSortTimer) clearTimeout(pendingSortTimer);
                pendingSortTimer = setTimeout(() => {
                    pendingSortTimer = null;
                    controller.dispatch({ type: 'sort-column', columnIndex });
                }, SORT_CLICK_DELAY_MS);
            });
            th.addEventListener('dblclick', () => {
                if (pendingSortTimer) {
                    clearTimeout(pendingSortTimer);
                    pendingSortTimer = null;
                }
                if (th.querySelector('input') || !state.editable) return;
                startInlineEdit(th, state.headers[columnIndex] ?? '', (value) =>
                    controller.dispatch({ type: 'edit-header', columnIndex, value })
                );
            });
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = el('tbody');
        state.visibleRows.forEach((row, rowOffset) => {
            const rowId = state.visibleRowIds[rowOffset] ?? -1;
            const tr = el('tr');
            if (state.editable) {
                // Row insert/delete live in a right-click menu (no ops column).
                tr.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    openRowContextMenu(e as MouseEvent, rowId);
                });
            }
            for (let c = 0; c < state.columnCount; c++) {
                const columnIndex = c;
                const text = row[columnIndex] ?? '';
                const td = el('td', undefined, text);
                if (term && text.toLowerCase().includes(term)) {
                    td.classList.add('omni-excel__hit');
                }
                if (state.editable) {
                    td.title = t('excel.editHint');
                    td.addEventListener('dblclick', () => {
                        if (td.querySelector('input')) return;
                        startInlineEdit(td, controller.getRowById(rowId)[columnIndex] ?? '', (value) =>
                            controller.dispatch({ type: 'edit-cell', rowId, columnIndex, value })
                        );
                    });
                }
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        return table;
    }

    /** Read-only WYSIWYG grid (X3): file column widths / row heights, merged
     *  cells (rowspan/colspan), and per-cell inline styles from the source. */
    function renderGrid(grid: GridView, term: string): HTMLTableElement {
        const table = el('table', 'omni-excel__grid');
        const colgroup = el('colgroup');
        for (const width of grid.cols) {
            const col = el('col');
            col.style.width = `${width}px`;
            colgroup.appendChild(col);
        }
        table.appendChild(colgroup);

        const tbody = el('tbody');
        for (const row of grid.rows) {
            const tr = el('tr');
            tr.style.height = `${row.heightPx}px`;
            for (const cell of row.cells) {
                const td = el('td', undefined, cell.text);
                if (cell.rowSpan > 1) td.rowSpan = cell.rowSpan;
                if (cell.colSpan > 1) td.colSpan = cell.colSpan;
                // Inline style from file data — CSP allows the style attribute.
                Object.assign(td.style, cell.style);
                if (term && cell.text.toLowerCase().includes(term)) {
                    td.classList.add('omni-excel__hit');
                }
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        return table;
    }

    // Undo/redo shortcuts while editing (frame-local, disposed with us).
    on(frame, 'keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
        e.preventDefault();
        controller.dispatch({ type: e.shiftKey ? 'redo' : 'undo' });
    });
    frame.tabIndex = -1;

    const unsubscribe = controller.subscribe(render);
    render(controller.state);

    if (options.signal?.aborted) {
        cleanup();
        throw new MountAbortedError();
    }

    function cleanup(): void {
        unsubscribe();
        for (const dispose of disposers) dispose();
        disposers.length = 0;
        if (toastTimer) clearTimeout(toastTimer);
        if (pendingSortTimer) clearTimeout(pendingSortTimer);
        activeResizeCleanup?.();
        closeContextMenu();
        if (root instanceof ShadowRoot) {
            root.replaceChildren();
        } else {
            root.replaceChildren();
            root.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--excel');
        }
    }

    return { dispose: cleanup };
}
