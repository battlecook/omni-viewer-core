import type { ClipboardService, FileSaveService, HostContext } from '../../host/index.js';
import { parseArrow, type ArrowDocument, type ArrowField, type ArrowParseDeps, type ArrowParseOptions } from '../../parsers/arrow/index.js';
import { serializeRowsToTsv } from '../../parsers/csv/index.js';
import { utf8ByteLength, type ParseOutcome } from '../../parsers/types.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { createArrowController, formatArrowCell, type ArrowViewMode } from './controller.js';
import { arrowViewerCss } from './styles.js';

export * from '../../parsers/arrow/index.js';
export * from './controller.js';
export { arrowViewerCss } from './styles.js';
export const ARROW_VIEWER_META = {
    id: 'arrow', displayNameKey: 'arrow.title', extensions: ['arrow', 'feather'], priority: 20,
    requiredServices: [] as const, optionalServices: ['clipboard', 'save'] as const, inputOwnership: 'borrows' as const
};
export const ARROW_COPY_PAYLOAD_LIMIT_BYTES = 1024 * 1024;
export type ArrowViewerContext = HostContext & { clipboard?: ClipboardService; save?: FileSaveService };
export interface ArrowMountOptions extends MountOptions { parse?: ArrowParseOptions }

export async function mountArrowViewer(input: ViewerInput, container: HTMLElement, ctx: ArrowViewerContext, deps: ArrowParseDeps, options: ArrowMountOptions = {}): Promise<ViewerHandle> {
    if (options.signal?.aborted || options.parse?.signal?.aborted) throw new MountAbortedError();
    const parseOptions = { ...options.parse, ...(options.signal ? { signal: options.signal } : {}) };
    const outcome = parseArrow(input.data, deps, parseOptions);
    return mountArrowOutcome(outcome, input.fileName, container, ctx, options);
}

/** Also renders dependency failures from the opt-in self-loading entry. */
export function mountArrowOutcome(outcome: ParseOutcome<ArrowDocument>, fileName: string, container: HTMLElement, ctx: ArrowViewerContext, options: ArrowMountOptions = {}): ViewerHandle {
    if (options.signal?.aborted || options.parse?.signal?.aborted || outcome.result.status === 'failed' && outcome.result.failure.code === 'aborted') throw new MountAbortedError();
    let root: HTMLElement | ShadowRoot = container;
    let style: HTMLStyleElement | undefined;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && container.attachShadow) {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        style = element('style'); style.textContent = arrowViewerCss; root.append(style);
    } else container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--arrow');
    const t = ctx.i18n.t.bind(ctx.i18n);
    const frame = element('section', 'omni-arrow');
    const header = element('header', 'omni-arrow__header');
    header.append(element('h1', undefined, fileName));
    const warnings = element('div', 'omni-arrow__warning'); warnings.setAttribute('role', 'status');
    const status = element('div', 'omni-arrow__status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    frame.append(header, warnings); root.append(frame);
    let disposed = false;
    const off: Array<() => void> = [];
    const on = (target: EventTarget, name: string, handler: EventListener) => {
        target.addEventListener(name, handler); off.push(() => target.removeEventListener(name, handler));
    };
    const handle: ViewerHandle = { dispose() {
        if (disposed) return;
        disposed = true; off.splice(0).forEach(remove => remove()); frame.remove(); style?.remove();
        if (root === container) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--arrow');
    } };
    const { result } = outcome;
    if (result.status === 'failed') {
        warnings.setAttribute('role', 'alert');
        warnings.textContent = t(result.failure.messageKey, result.failure.args);
        return handle;
    }
    const model = result.document, controller = createArrowController(model);
    warnings.textContent = result.diagnostics.map(item => t(item.messageKey, item.args)).join('\n');
    header.append(element('span', 'omni-arrow__summary', t('arrow.summary', { rows: model.totalRows, columns: model.headers.length, batches: model.recordBatches })));
    const bar = element('div', 'omni-arrow__toolbar');
    const search = element('input'); search.type = 'search'; search.placeholder = t('arrow.search'); search.setAttribute('aria-label', t('arrow.search'));
    bar.append(search);
    const tabs = new Map<ArrowViewMode, HTMLButtonElement>();
    for (const mode of ['table', 'schema', 'raw'] as const) {
        const button = element('button', undefined, t(`arrow.${mode}`)); button.type = 'button'; tabs.set(mode, button);
        on(button, 'click', () => controller.dispatch({ type: 'view', mode })); bar.append(button);
    }
    const copy = element('button', undefined, t('arrow.copyTable'));
    const copyJson = element('button', undefined, t('arrow.copyJson'));
    const save = element('button', undefined, t('arrow.exportJson'));
    for (const button of [copy, copyJson]) { button.disabled = !ctx.clipboard; if (!ctx.clipboard) button.title = t('common.noClipboard'); }
    save.disabled = !ctx.save; if (!ctx.save) save.title = t('common.noFileSave');
    bar.append(copy, copyJson, save);
    const content = element('div', 'omni-arrow__content');
    const foot = element('footer', 'omni-arrow__footer');
    const prev = element('button', undefined, t('common.prevPage')), next = element('button', undefined, t('common.nextPage'));
    const page = element('span'), count = element('span');
    const size = element('select'); size.setAttribute('aria-label', t('arrow.pageSize'));
    for (const value of [100, 250, 1000]) { const option = element('option', undefined, String(value)); option.value = String(value); size.append(option); }
    foot.append(prev, page, next, size, count); frame.append(bar, content, foot, status);
    on(search, 'input', () => controller.dispatch({ type: 'search', value: search.value }));
    on(prev, 'click', () => controller.dispatch({ type: 'page', page: controller.state.page - 1 }));
    on(next, 'click', () => controller.dispatch({ type: 'page', page: controller.state.page + 1 }));
    on(size, 'change', () => controller.dispatch({ type: 'page-size', size: Number(size.value) }));
    async function copyText(text: string) {
        if (disposed || !ctx.clipboard) return;
        if (utf8ByteLength(text) > ARROW_COPY_PAYLOAD_LIMIT_BYTES) { status.textContent = t('common.copyTooLarge', { size: utf8ByteLength(text) }); return; }
        try { await ctx.clipboard.writeText(text); if (!disposed) status.textContent = t('common.copied'); }
        catch (error) { ctx.logger.log('error', `arrow copy failed: ${String(error)}`); if (!disposed) status.textContent = t('arrow.actionFailed'); }
    }
    on(copy, 'click', () => { void copyText(serializeRowsToTsv(controller.filteredRows().map(row => row.map(formatArrowCell)), model.headers)); });
    on(copyJson, 'click', () => { void copyText(controller.toJson()); });
    on(save, 'click', () => { void (async () => {
        if (disposed || !ctx.save) return;
        try {
            const result = await ctx.save.saveFile(fileName.replace(/\.(arrow|feather)$/i, '') + '-export.json', new TextEncoder().encode(controller.toJson()), 'application/json');
            if (!disposed && result?.status !== 'cancelled') status.textContent = t('common.saved', { name: result?.status === 'saved' && result.fileName ? result.fileName : fileName.replace(/\.(arrow|feather)$/i, '') + '-export.json' });
        } catch (error) { ctx.logger.log('error', `arrow export failed: ${String(error)}`); if (!disposed) status.textContent = t('arrow.actionFailed'); }
    })(); });
    function render() {
        content.replaceChildren();
        const state = controller.state;
        for (const [mode, button] of tabs) button.setAttribute('aria-pressed', String(state.viewMode === mode));
        foot.hidden = state.viewMode !== 'table'; search.disabled = state.viewMode === 'schema';
        prev.disabled = state.page === 0; next.disabled = state.page + 1 >= state.pageCount;
        page.textContent = t('common.page', { page: state.page + 1, pages: state.pageCount });
        count.textContent = t('arrow.matches', { matched: state.matchedRows, loaded: model.loadedRows });
        if (state.viewMode === 'raw') { content.append(element('pre', undefined, controller.toJson())); return; }
        if (state.viewMode === 'schema') {
            content.append(element('pre', undefined, JSON.stringify({ format: model.format, compression: model.compression, fields: model.fields, metadata: model.metadata }, null, 2)));
            return;
        }
        if (!state.matchedRows) { content.append(element('div', 'omni-arrow__empty', t(model.loadedRows ? 'arrow.noMatches' : 'arrow.empty'))); return; }
        const table = element('table'); table.setAttribute('aria-label', t('arrow.table'));
        const head = element('thead'), heading = element('tr');
        model.fields.forEach((field: ArrowField, column) => {
            const th = element('th'); th.scope = 'col';
            const active = state.sortColumn === column;
            th.setAttribute('aria-sort', active ? state.sortDirection === 'asc' ? 'ascending' : 'descending' : 'none');
            const button = element('button', undefined, field.name + (active ? state.sortDirection === 'asc' ? ' ▲' : ' ▼' : ''));
            button.type = 'button'; button.onclick = () => controller.dispatch({ type: 'sort', column });
            th.append(button, element('span', 'omni-arrow__type', field.type)); heading.append(th);
        });
        head.append(heading);
        const body = element('tbody');
        for (const row of controller.visibleRows()) {
            const tr = element('tr');
            for (const value of row) {
                const text = formatArrowCell(value), td = element('td', value === null ? 'omni-arrow__null' : undefined, text);
                td.title = text; tr.append(td);
            }
            body.append(tr);
        }
        table.append(head, body); content.append(table);
    }
    off.push(controller.subscribe(render)); render();
    return handle;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const item = document.createElement(tag);
    if (tag === 'button') item.setAttribute('type', 'button');
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
}
