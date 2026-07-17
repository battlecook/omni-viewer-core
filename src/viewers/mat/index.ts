import type { ClipboardService, HostContext } from '../../host/index.js';
import { parseMat, type MatDocument, type MatTable } from '../../parsers/mat/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { matViewerCss } from './styles.js';

export { parseMat } from '../../parsers/mat/index.js';
export type { MatDocument, MatTable, MatVariable } from '../../parsers/mat/index.js';
export { matViewerCss } from './styles.js';

export const MAT_VIEWER_META = {
    id: 'mat', displayNameKey: 'mat.title', extensions: ['mat'], priority: 20,
    requiredServices: [] as const, optionalServices: ['clipboard'] as const,
    inputOwnership: 'borrows' as const
};

export type MatViewerContext = HostContext & { clipboard?: ClipboardService };
export const MAT_RENDER_ROW_LIMIT = 1000;

export async function mountMatViewer(input: ViewerInput, container: HTMLElement, ctx: MatViewerContext, options: MountOptions = {}): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const model = await parseMat(input.data);
    if (options.signal?.aborted) throw new MountAbortedError();
    const t = ctx.i18n.t.bind(ctx.i18n);
    let root: HTMLElement | ShadowRoot = container;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && typeof container.attachShadow === 'function') {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        const style = document.createElement('style'); style.textContent = matViewerCss; root.append(style);
    } else container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--mat');

    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
        const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
    };
    const disposers: Array<() => void> = [];
    const on = (target: EventTarget, type: string, listener: EventListener): void => { target.addEventListener(type, listener); disposers.push(() => target.removeEventListener(type, listener)); };
    const frame = el('div', 'omni-mat');
    const header = el('header', 'omni-mat__header');
    const heading = el('div', 'omni-mat__heading');
    heading.append(el('h1', undefined, input.fileName), el('div', 'omni-mat__subtitle', `${model.title} · ${model.fileSize}`));
    header.append(el('div', 'omni-mat__mark', 'MAT'), heading);
    const summary = el('section', 'omni-mat__summary');
    model.summary.forEach(item => { const card = el('div', 'omni-mat__stat'); card.append(el('span', 'omni-mat__stat-label', item.label), el('span', 'omni-mat__stat-value', String(item.value))); summary.append(card); });
    const toolbar = el('nav', 'omni-mat__toolbar');
    const content = el('main', 'omni-mat__content');
    const search = el('input', 'omni-mat__search') as HTMLInputElement; search.type = 'search'; search.placeholder = t('mat.search'); search.setAttribute('aria-label', t('mat.search'));
    const copy = el('button', undefined, t('mat.copyJson')) as HTMLButtonElement; copy.type = 'button'; copy.disabled = !ctx.clipboard; copy.title = ctx.clipboard ? '' : t('common.noClipboard');
    type View = number | 'raw'; let active: View = 0;
    const buttons = new Map<View, HTMLButtonElement>();
    const addViewButton = (view: View, label: string): void => { const button = el('button', undefined, label) as HTMLButtonElement; button.type = 'button'; button.dataset.view = String(view); on(button, 'click', () => { active = view; render(); }); buttons.set(view, button); toolbar.append(button); };
    model.tables.forEach((table, index) => addViewButton(index, table.title));
    if (model.rawPreview) addViewButton('raw', t('mat.rawPreview'));
    toolbar.append(copy, search);
    const warnings = model.warnings.length ? el('div', 'omni-mat__warnings', model.warnings.join(' · ')) : null;

    const activeTable = (): MatTable | undefined => typeof active === 'number' ? model.tables[active] : undefined;
    const filteredRows = (table: MatTable): MatTable['rows'] => {
        const query = search.value.trim().toLocaleLowerCase();
        return query ? table.rows.filter(row => row.some(value => String(value).toLocaleLowerCase().includes(query))) : table.rows;
    };
    const renderTable = (table: MatTable): void => {
        const wrap = el('div', 'omni-mat__table-wrap'); const tableNode = el('table'); const head = el('thead'); const headRow = el('tr');
        table.headers.forEach(value => headRow.append(el('th', undefined, value))); head.append(headRow); tableNode.append(head);
        const body = el('tbody'); const rows = filteredRows(table); const shown = rows.slice(0, MAT_RENDER_ROW_LIMIT);
        shown.forEach(row => { const tr = el('tr'); row.forEach(value => { const td = el('td', undefined, String(value)); td.title = String(value); tr.append(td); }); body.append(tr); });
        tableNode.append(body); wrap.append(tableNode);
        if (rows.length) content.append(el('div', 'omni-mat__caption', t('mat.rowsShown', { shown: shown.length, total: rows.length })), wrap);
        else content.append(el('div', 'omni-mat__empty', t('mat.noMatches')));
    };
    const render = (): void => {
        content.replaceChildren(); buttons.forEach((button, view) => button.setAttribute('aria-pressed', String(view === active)));
        search.hidden = active === 'raw'; copy.disabled = !ctx.clipboard;
        const table = activeTable(); if (table) renderTable(table); else content.append(el('pre', 'omni-mat__raw', model.rawPreview ?? ''));
    };
    on(search, 'input', render);
    on(copy, 'click', () => {
        if (!ctx.clipboard) return;
        void ctx.clipboard.writeText(JSON.stringify(model, null, 2)).catch(error => ctx.logger.log('error', `MAT JSON copy failed: ${String(error)}`));
    });
    frame.append(header, summary, toolbar, content); if (warnings) frame.append(warnings); root.append(frame); render();
    return { dispose() { disposers.splice(0).forEach(dispose => dispose()); frame.remove(); if (root instanceof ShadowRoot) root.replaceChildren(); else container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--mat'); } };
}
