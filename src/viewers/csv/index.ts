// CSV viewer — DOM renderer consuming CsvController (DESIGN.md §3-②).
//
// CSP rules: no eval, no inline handlers, no innerHTML — all rendering goes
// through createElement/textContent. Mount is async and renders inside a
// shadow root by default (§6 reverse-contamination contract).
//
// Optional services: `clipboard`. Degraded mode (core contract, ADR 24):
// without it the copy buttons render disabled with an explanatory tooltip —
// never hidden.

import type {
    ClipboardService,
    FileSaveService,
    FileWritebackService,
    HostContext
} from '../../host/index.js';
import {
    MountAbortedError,
    VIEWER_ROOT_CLASS,
    type MountOptions,
    type ViewerHandle,
    type ViewerInput
} from '../types.js';
import { formatPercent, formatStatNumber, DELIMITER_PRIORITY, type CsvDelimiter } from '../../parsers/csv/index.js';
import { utf8ByteLength, type ResourceLimits } from '../../parsers/types.js';
import {
    createCsvController,
    CSV_MIN_SEARCH_LENGTH,
    type CsvController,
    type CsvViewState
} from './controller.js';
import { csvViewerCss } from './styles.js';

export { createCsvController, DEFAULT_PAGE_SIZE } from './controller.js';
export type { CsvController, CsvViewState, CsvAction, CsvControllerOptions } from './controller.js';
export { csvViewerCss } from './styles.js';

/** Viewer metadata — single source for the registry codegen (DESIGN.md §7). */
export const CSV_VIEWER_META = {
    id: 'csv',
    displayNameKey: 'csv.tableView',
    extensions: ['csv', 'tsv'],
    priority: 10,
    requiredServices: [] as const,
    optionalServices: ['clipboard', 'save', 'writeback'] as const,
    inputOwnership: 'borrows' as const
};

export type CsvViewerContext = HostContext & {
    clipboard?: ClipboardService;
    save?: FileSaveService;
    writeback?: FileWritebackService;
};

/** CSV mount handle: dirty inspection lets hosts guard against re-renders
 *  that would discard unsaved edits (docs §6). */
export interface CsvViewerHandle extends ViewerHandle {
    isDirty(): boolean;
}

/** Export file name: strip the extension, append -export, pick the extension
 *  by the active delimiter (docs/viewers/csv.md §6). */
export function exportFileName(sourceName: string, delimiter: string): string {
    const stem = sourceName.replace(/\.[^./\\]+$/, '') || sourceName;
    return `${stem}-export${delimiter === '\t' ? '.tsv' : '.csv'}`;
}

/** Suggested filename for Save As. The host's FileSaveService presents the
 * destination picker; this only supplies its initial filename. */
export function saveAsFileName(sourceName: string, delimiter: string): string {
    const stem = sourceName.replace(/\.[^./\\]+$/, '') || sourceName;
    return `${stem}${delimiter === '\t' ? '.tsv' : '.csv'}`;
}

export interface CsvMountOptions extends MountOptions {
    /** Parser resource limits (docs/parsers/csv.md); adapters may tighten them. */
    limits?: ResourceLimits;
    pageSize?: number;
}

/** Clipboard copy guard (docs/viewers/csv.md §6): larger payloads are refused. */
export const COPY_PAYLOAD_LIMIT_BYTES = 1024 * 1024;

/** Cells at least this long (or containing a newline) get a full-content tooltip. */
export const CELL_TOOLTIP_MIN_CHARS = 50;

const MIN_COLUMN_WIDTH = 40;
const FALLBACK_COLUMN_WIDTH = 120;

/** Header single-click sort is deferred briefly so a double-click can win and
 *  open the rename editor instead (docs §6). */
export const SORT_CLICK_DELAY_MS = 250;

const DELIMITER_LABEL_KEYS: Record<CsvDelimiter, string> = {
    ',': 'csv.delimiter.comma',
    ';': 'csv.delimiter.semicolon',
    '\t': 'csv.delimiter.tab',
    '|': 'csv.delimiter.pipe'
};

export async function mountCsvViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: CsvViewerContext,
    options: CsvMountOptions = {}
): Promise<CsvViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();

    const controllerOptions: Parameters<typeof createCsvController>[1] = {
        fileName: input.fileName
    };
    if (options.limits !== undefined) controllerOptions.limits = options.limits;
    if (options.pageSize !== undefined) controllerOptions.pageSize = options.pageSize;
    const controller = createCsvController(input.data, controllerOptions);

    const isolation = options.styleIsolation ?? 'shadow';
    let root: HTMLElement | ShadowRoot;
    if (isolation === 'shadow' && typeof container.attachShadow === 'function') {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = csvViewerCss;
        root.appendChild(style);
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--csv');
        root = container;
    }

    const t = ctx.i18n.t.bind(ctx.i18n);
    const disposers: Array<() => void> = [];
    let toastTimer: ReturnType<typeof setTimeout> | null = null;
    /** Session-scoped column widths (px), per data column; null entry = auto.
     *  Non-null array means the table runs in fixed layout (docs §6). */
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
    const frame = el('div', 'omni-csv');
    frame.style.position = 'relative';

    const toolbar = el('div', 'omni-csv__toolbar');

    const delimiterLabel = el('label', undefined, t('csv.delimiter'));
    const delimiterSelect = el('select');
    // "Auto detect" re-runs detection; the select value always shows the
    // delimiter currently in effect, so choosing auto snaps back to the
    // detected one (docs/viewers/csv.md §2).
    const autoOpt = el('option', undefined, t('csv.delimiter.auto'));
    autoOpt.value = 'auto';
    delimiterSelect.appendChild(autoOpt);
    for (const d of DELIMITER_PRIORITY) {
        const opt = el('option', undefined, t(DELIMITER_LABEL_KEYS[d]));
        opt.value = d;
        delimiterSelect.appendChild(opt);
    }
    delimiterLabel.appendChild(delimiterSelect);
    on(delimiterSelect, 'change', () => {
        const value = delimiterSelect.value;
        controller.dispatch({
            type: 'set-delimiter',
            delimiter: value === 'auto' ? 'auto' : (value as CsvDelimiter)
        });
    });

    const searchInput = el('input', 'omni-csv__search');
    searchInput.type = 'search';
    searchInput.minLength = CSV_MIN_SEARCH_LENGTH;
    searchInput.placeholder = t('csv.search');
    searchInput.setAttribute('aria-label', t('csv.search'));
    on(searchInput, 'input', () => {
        controller.dispatch({ type: 'set-search', search: searchInput.value });
    });

    const rowNumToggle = el('button', undefined, t('csv.rowNumbers'));
    rowNumToggle.type = 'button';
    on(rowNumToggle, 'click', () => controller.dispatch({ type: 'toggle-row-numbers' }));

    const pageSizeLabel = el('label', undefined, t('csv.pageSize'));
    const pageSizeSelect = el('select');
    for (const size of [100, 200, 500, 1000]) {
        const opt = el('option', undefined, String(size));
        opt.value = String(size);
        pageSizeSelect.appendChild(opt);
    }
    pageSizeLabel.appendChild(pageSizeSelect);
    on(pageSizeSelect, 'change', () => {
        controller.dispatch({
            type: 'set-page-size',
            pageSize: Number(pageSizeSelect.value)
        });
    });

    const viewToggle = el('button', undefined, t('csv.rawView'));
    viewToggle.type = 'button';
    on(viewToggle, 'click', () => {
        controller.dispatch({
            type: 'set-view-mode',
            mode: controller.state.viewMode === 'table' ? 'raw' : 'table'
        });
    });

    const statsToggle = el('button', undefined, t('csv.statistics'));
    statsToggle.type = 'button';
    on(statsToggle, 'click', () => controller.dispatch({ type: 'toggle-stats' }));

    const copyTsvBtn = el('button', undefined, t('csv.copyTsv'));
    copyTsvBtn.type = 'button';
    const copyJsonBtn = el('button', undefined, t('csv.copyJson'));
    copyJsonBtn.type = 'button';
    const clipboard = ctx.clipboard;
    if (clipboard) {
        on(copyTsvBtn, 'click', () => void copy(clipboard, controller.toTsv()));
        on(copyJsonBtn, 'click', () => void copy(clipboard, controller.toJson()));
    } else {
        // Degraded mode: disabled with reason, identical on every platform.
        for (const btn of [copyTsvBtn, copyJsonBtn]) {
            btn.disabled = true;
            btn.title = t('common.noClipboard');
        }
    }

    const undoBtn = el('button', undefined, '↶');
    undoBtn.type = 'button';
    undoBtn.setAttribute('aria-label', t('csv.undo'));
    on(undoBtn, 'click', () => controller.dispatch({ type: 'undo' }));

    const redoBtn = el('button', undefined, '↷');
    redoBtn.type = 'button';
    redoBtn.setAttribute('aria-label', t('csv.redo'));
    on(redoBtn, 'click', () => controller.dispatch({ type: 'redo' }));

    const addRowBtn = el('button', undefined, t('csv.addRow'));
    addRowBtn.type = 'button';
    on(addRowBtn, 'click', () =>
        controller.dispatch({ type: 'insert-row', afterRowId: 'end' })
    );

    const saveBtn = el('button', undefined, t('csv.save'));
    saveBtn.type = 'button';
    const writeback = ctx.writeback;
    if (writeback) {
        on(saveBtn, 'click', () => void saveDocument(writeback));
    } else {
        // Degraded mode (docs §6 결정 1): editing works, saving points to export.
        saveBtn.disabled = true;
        saveBtn.title = t('common.noWriteback');
    }

    const saveAsBtn = el('button', undefined, t('csv.saveAs'));
    saveAsBtn.type = 'button';
    const save = ctx.save;
    if (save) {
        on(saveAsBtn, 'click', () => void saveAsDocument(save));
    } else {
        saveAsBtn.disabled = true;
        saveAsBtn.title = t('common.noFileSave');
    }

    const dirtyBadge = el('span', 'omni-csv__dirty');

    async function saveDocument(service: FileWritebackService): Promise<void> {
        try {
            // Save covers the whole document in original order — never the
            // filtered/sorted display result (docs §6).
            const bytes = new TextEncoder().encode(controller.toDocumentCsv());
            await service.write(bytes);
            controller.markSaved();
            showToast(t('common.savedToOriginal'));
        } catch (error) {
            ctx.logger.log('error', `csv save failed: ${String(error)}`);
            showToast(t('common.saveFailed'));
        }
    }

    /** Save As delegates the destination picker to the host adapter. Unlike
     *  export, it always writes the whole edited document in document order. */
    async function saveAsDocument(service: FileSaveService): Promise<void> {
        const state = controller.state;
        const name = saveAsFileName(input.fileName, state.delimiter);
        const mime =
            state.delimiter === '\t' ? 'text/tab-separated-values' : 'text/csv';
        try {
            const bytes = new TextEncoder().encode(controller.toDocumentCsv());
            await service.saveFile(name, bytes, mime);
            controller.markSaved();
            showToast(t('common.saved', { name }));
        } catch (error) {
            ctx.logger.log('error', `csv save-as failed: ${String(error)}`);
            showToast(t('common.saveFailed'));
        }
    }

    // Undo/redo shortcuts while editing (shadow-root local, disposed with us).
    on(frame, 'keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
        e.preventDefault();
        controller.dispatch({ type: e.shiftKey ? 'redo' : 'undo' });
    });

    const exportBtn = el('button', undefined, t('csv.exportFile'));
    exportBtn.type = 'button';
    exportBtn.title = t('csv.exportFile.hint');
    exportBtn.setAttribute('aria-label', t('csv.exportFile.hint'));
    if (save) {
        on(exportBtn, 'click', () => void exportFile(save));
    } else {
        // Degraded mode (ADR 24): disabled with reason, never hidden.
        exportBtn.disabled = true;
        exportBtn.title = t('common.noFileSave');
    }

    async function exportFile(service: FileSaveService): Promise<void> {
        const state = controller.state;
        const name = exportFileName(input.fileName, state.delimiter);
        const mime =
            state.delimiter === '\t' ? 'text/tab-separated-values' : 'text/csv';
        try {
            const bytes = new TextEncoder().encode(controller.toCsv());
            await service.saveFile(name, bytes, mime);
            showToast(t('common.saved', { name }));
        } catch (error) {
            ctx.logger.log('error', `csv export failed: ${String(error)}`);
        }
    }

    async function copy(service: ClipboardService, payload: string): Promise<void> {
        const payloadBytes = utf8ByteLength(payload);
        if (payloadBytes > COPY_PAYLOAD_LIMIT_BYTES) {
            showToast(t('common.copyTooLarge', { size: payloadBytes }));
            return;
        }
        try {
            await service.writeText(payload);
            showToast(t('common.copied'));
        } catch (error) {
            ctx.logger.log('error', `csv copy failed: ${String(error)}`);
        }
    }

    const meta = el('span', 'omni-csv__meta');

    toolbar.append(
        delimiterLabel,
        searchInput,
        viewToggle,
        statsToggle,
        rowNumToggle,
        pageSizeLabel,
        undoBtn,
        redoBtn,
        addRowBtn,
        saveBtn,
        saveAsBtn,
        copyTsvBtn,
        copyJsonBtn,
        exportBtn,
        el('span', 'omni-csv__spacer'),
        dirtyBadge,
        meta
    );

    const diagnosticsBar = el('div', 'omni-csv__diagnostics');
    const body = el('div', 'omni-csv__body');

    const footer = el('div', 'omni-csv__footer');
    const prevBtn = el('button', undefined, '‹');
    prevBtn.type = 'button';
    prevBtn.setAttribute('aria-label', t('common.prevPage'));
    const nextBtn = el('button', undefined, '›');
    nextBtn.type = 'button';
    nextBtn.setAttribute('aria-label', t('common.nextPage'));
    const pageInfo = el('span', 'omni-csv__meta');
    on(prevBtn, 'click', () => controller.dispatch({ type: 'prev-page' }));
    on(nextBtn, 'click', () => controller.dispatch({ type: 'next-page' }));
    footer.append(prevBtn, pageInfo, nextBtn);

    frame.append(toolbar, diagnosticsBar, body, footer);
    root.appendChild(frame);

    function showToast(message: string): void {
        const existing = frame.querySelector('.omni-csv__toast');
        existing?.remove();
        const toast = el('div', 'omni-csv__toast', message);
        frame.appendChild(toast);
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.remove(), 1500);
    }

    function closeContextMenu(): void {
        contextMenuCleanup?.();
        contextMenuCleanup = null;
    }

    /** Right-click row menu: insert below / delete (docs §6). */
    function openRowContextMenu(event: MouseEvent, rowId: number): void {
        closeContextMenu();
        const menu = el('div', 'omni-csv__menu');
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
        item(t('csv.insertRowBelow'), () =>
            controller.dispatch({ type: 'insert-row', afterRowId: rowId })
        );
        item(t('csv.deleteRow'), () =>
            controller.dispatch({ type: 'delete-row', rowId })
        );

        const frameRect = frame.getBoundingClientRect();
        menu.style.left = `${event.clientX - frameRect.left}px`;
        menu.style.top = `${event.clientY - frameRect.top}px`;
        frame.appendChild(menu);

        const onOutside = (e: Event) => {
            // Events crossing the shadow boundary have their `target` retargeted
            // to the host, so `menu.contains(e.target)` is unreliable here.
            // `composedPath()` keeps the real nodes traversed through the shadow.
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
        inputEl.className = 'omni-csv__cell-input';
        inputEl.value = current;
        let done = false;
        const finish = (commitValue: boolean) => {
            if (done) return;
            done = true;
            if (commitValue && inputEl.value !== current) {
                commit(inputEl.value); // dispatch triggers a re-render
            } else {
                render(controller.state); // restore the original cell
            }
        };
        inputEl.addEventListener('keydown', (e) => {
            // Keep typing out of the sort/undo shortcuts.
            e.stopPropagation();
            if (e.key === 'Enter') {
                e.preventDefault();
                finish(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                finish(false);
            }
        });
        inputEl.addEventListener('blur', () => finish(true));
        // Editing input must not bubble a click back into sort/edit handlers.
        inputEl.addEventListener('click', (e) => e.stopPropagation());
        cell.replaceChildren(inputEl);
        inputEl.focus();
        if (typeof inputEl.select === 'function') inputEl.select();
    }

    // --- state-driven rendering --------------------------------------------
    function render(state: CsvViewState): void {
        delimiterSelect.value = state.delimiter;
        // Delimiter switching reparses and would discard edits (docs §6).
        delimiterSelect.disabled = state.dirty;
        if (searchInput.value !== state.search) searchInput.value = state.search;
        pageSizeSelect.value = String(state.pageSize);
        rowNumToggle.setAttribute('aria-pressed', String(state.showRowNumbers));

        // Editing controls surface once editing has started (docs §6) — pure
        // readers never see them. "Add row" also shows for empty documents.
        const editingActive = state.dirty || state.canUndo || state.canRedo;
        for (const btn of [undoBtn, redoBtn, saveBtn]) {
            btn.style.display = editingActive ? '' : 'none';
        }
        addRowBtn.style.display =
            editingActive || (state.rowCount === 0 && state.status === 'ok') ? '' : 'none';
        undoBtn.disabled = !state.canUndo;
        redoBtn.disabled = !state.canRedo;
        if (ctx.writeback) saveBtn.disabled = !state.dirty;
        dirtyBadge.textContent = state.dirty ? t('common.unsaved') : '';
        viewToggle.textContent =
            state.viewMode === 'table' ? t('csv.rawView') : t('csv.tableView');
        viewToggle.setAttribute('aria-pressed', String(state.viewMode === 'raw'));
        statsToggle.setAttribute('aria-pressed', String(state.statsVisible));
        const hasActiveSearch = state.search.length >= CSV_MIN_SEARCH_LENGTH;
        const rowSummary =
            hasActiveSearch
                ? t('common.rowsMatched', {
                      matched: state.matchedRowCount,
                      total: state.rowCount
                  })
                : t('common.rows', { count: state.rowCount });
        meta.textContent = `${rowSummary} · ${t('common.columns', {
            count: state.columnCount
        })}`;

        diagnosticsBar.replaceChildren();
        const hasNotices = state.diagnostics.length > 0 || state.failure !== null;
        diagnosticsBar.style.display = hasNotices ? '' : 'none';
        if (state.failure) {
            // Failed parses must surface their reason — never a bare empty
            // table (docs/viewers/csv.md §2).
            diagnosticsBar.appendChild(
                el(
                    'div',
                    'omni-csv__diag-error',
                    t(state.failure.messageKey, state.failure.args)
                )
            );
        }
        for (const diag of state.diagnostics) {
            diagnosticsBar.appendChild(
                el('div', undefined, t(diag.messageKey, diag.args))
            );
        }

        body.replaceChildren();
        if (state.viewMode === 'raw') {
            body.appendChild(el('pre', 'omni-csv__raw', controller.rawText));
        } else if (state.rowCount === 0) {
            body.appendChild(el('div', 'omni-csv__empty', t('csv.empty')));
        } else if (hasActiveSearch && state.matchedRowCount === 0) {
            body.appendChild(el('div', 'omni-csv__empty', t('csv.noMatches')));
        } else {
            const table = renderTable(state);
            body.appendChild(table);
            if (state.statsVisible) {
                // The stats row sticks right below the header row; its offset
                // is the measured header height (0 in JSDOM — harmless).
                const headRow = table.querySelector('thead tr');
                const headHeight = (headRow as HTMLElement | null)?.offsetHeight ?? 0;
                table.style.setProperty('--omni-csv-head-h', `${headHeight}px`);
            }
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

    function renderTable(state: CsvViewState): HTMLTableElement {
        const table = el('table', 'omni-csv__table');

        // Session column widths survive re-renders; a column-count change
        // (delimiter switch) invalidates them.
        if (columnWidths && columnWidths.length !== state.columnCount) {
            columnWidths = null;
        }
        const editable = state.status === 'ok';
        const colgroup = el('colgroup');
        if (state.showRowNumbers) colgroup.appendChild(el('col'));
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

        /** Keep the table exactly as wide as its frozen data columns. The
         *  resize interaction then transfers width between two adjacent
         *  columns while the total table width stays constant. */
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
            columnWidths.forEach((w, i) => {
                const col = dataCols[i];
                if (col && w != null) col.style.width = `${w}px`;
            });
            applyFixedLayout();
        }

        function startResize(event: MouseEvent, columnIndex: number): void {
            event.preventDefault();
            event.stopPropagation();
            activeResizeCleanup?.();
            freezeWidths();
            const adjacentColumnIndex = columnIndex + 1;
            // A handle sits on the right edge of its header, so it divides
            // this column and the next one. There is no adjacent column on
            // the far right edge to trade width with.
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
        if (state.showRowNumbers) {
            // Current document row numbers (1-based) — not sortable.
            const numTh = el('th', 'omni-csv__rownum', '#');
            numTh.setAttribute('aria-label', t('csv.rowNumbers'));
            headRow.appendChild(numTh);
        }
        state.headers.forEach((header, columnIndex) => {
            const th = el('th');
            th.appendChild(el('span', undefined, header));
            const hint = editable ? t('csv.header.hint') : t('csv.sort.hint');
            th.title =
                header.length > CELL_TOOLTIP_MIN_CHARS ? `${header}\n${hint}` : hint;
            th.setAttribute('role', 'columnheader');
            dataThs.push(th);

            const handle = el('span', 'omni-csv__resize-handle');
            handle.title = t('csv.resizeColumn');
            handle.addEventListener('pointerdown', (e) =>
                startResize(e as MouseEvent, columnIndex)
            );
            // A click that follows a resize drag must not toggle the sort.
            handle.addEventListener('click', (e) => e.stopPropagation());
            handle.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                if (!columnWidths) return;
                columnWidths[columnIndex] = null;
                if (columnWidths.every((w) => w == null)) columnWidths = null;
                render(controller.state);
            });
            th.appendChild(handle);
            if (state.sort.columnIndex === columnIndex && state.sort.direction) {
                th.setAttribute(
                    'aria-sort',
                    state.sort.direction === 'asc' ? 'ascending' : 'descending'
                );
                th.appendChild(
                    el(
                        'span',
                        'omni-csv__sort-indicator',
                        state.sort.direction === 'asc' ? '▲' : '▼'
                    )
                );
            }
            // Per-render elements: listeners are collected with the nodes.
            // Single click sorts (deferred so a double-click can win); double
            // click renames the header (docs §6).
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
                if (th.querySelector('input')) return;
                if (!editable) {
                    showToast(t('csv.editUnavailable'));
                    return;
                }
                startInlineEdit(th, controller.state.headers[columnIndex] ?? '', (value) =>
                    controller.dispatch({ type: 'edit-header', columnIndex, value })
                );
            });
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        if (state.statsVisible) {
            thead.appendChild(renderStatsRow(state));
        }
        table.appendChild(thead);

        const tbody = el('tbody');
        for (const rowId of state.visibleRowIds) {
            const tr = el('tr');
            if (editable) {
                // Row insert/delete live in a right-click menu (docs §6) —
                // no permanent ops column cluttering the table.
                tr.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    openRowContextMenu(e as MouseEvent, rowId);
                });
            }
            if (state.showRowNumbers) {
                tr.appendChild(
                    el('td', 'omni-csv__rownum', String(controller.getRowNumber(rowId)))
                );
            }
            const cells = controller.getRowById(rowId);
            for (let c = 0; c < state.columnCount; c++) {
                const columnIndex = c;
                const text = cells[c] ?? '';
                const td = el('td', undefined, text);
                // Truncated long cells reveal their full content on hover.
                if (text.length > CELL_TOOLTIP_MIN_CHARS || text.includes('\n')) {
                    td.title = text;
                }
                td.addEventListener('dblclick', () => {
                    if (td.querySelector('input')) return;
                    if (!editable) {
                        showToast(t('csv.editUnavailable'));
                        return;
                    }
                    startInlineEdit(td, controller.getRowById(rowId)[columnIndex] ?? '', (value) =>
                        controller.dispatch({
                            type: 'edit-cell',
                            rowId,
                            columnIndex,
                            value
                        })
                    );
                });
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        return table;
    }

    /** Second sticky thead row: per-column compact stats, details in the
     *  tooltip. Stats cover the whole document regardless of the search
     *  filter (docs §2). */
    function renderStatsRow(state: CsvViewState): HTMLTableRowElement {
        const stats = controller.getStatistics();
        const row = el('tr', 'omni-csv__stats-row');
        if (state.showRowNumbers) {
            row.appendChild(el('th', 'omni-csv__rownum', ''));
        }
        for (let c = 0; c < state.columnCount; c++) {
            const stat = stats[c];
            const cell = el('th');
            if (!stat) {
                row.appendChild(cell);
                continue;
            }
            const parts = [t('csv.stats.compact.count', { count: stat.count })];
            if (stat.nullCount > 0) {
                parts.push(
                    t('csv.stats.compact.nulls', {
                        percent: formatPercent(stat.nullPercent)
                    })
                );
            }
            if (stat.numeric) {
                parts.push(
                    t('csv.stats.compact.numeric', {
                        mean: formatStatNumber(stat.numeric.mean),
                        min: formatStatNumber(stat.numeric.min),
                        max: formatStatNumber(stat.numeric.max)
                    })
                );
            }
            cell.textContent = parts.join(' · ');

            const details = [
                `${t('csv.stats.count')} ${stat.count} / ${stat.total}`,
                `${t('csv.stats.nulls')} ${stat.nullCount} (${formatPercent(stat.nullPercent)})`
            ];
            if (stat.numeric) {
                details.push(
                    `${t('csv.stats.mean')} ${formatStatNumber(stat.numeric.mean)}`,
                    `${t('csv.stats.min')} ${formatStatNumber(stat.numeric.min)}`,
                    `${t('csv.stats.max')} ${formatStatNumber(stat.numeric.max)}`
                );
            }
            cell.title = details.join(' · ');
            row.appendChild(cell);
        }
        return row;
    }

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
        activeResizeCleanup?.();
        closeContextMenu();
        if (pendingSortTimer) clearTimeout(pendingSortTimer);
        if (toastTimer) clearTimeout(toastTimer);
        if (root instanceof ShadowRoot) {
            root.replaceChildren();
        } else {
            root.replaceChildren();
            root.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--csv');
        }
    }

    return {
        dispose: cleanup,
        isDirty: () => controller.state.dirty
    };
}
