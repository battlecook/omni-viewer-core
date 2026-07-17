import type { ClipboardService, HostContext } from '../../host/index.js';
import { parseAutomotive, type AutomotiveFormat, type AutomotiveTable, type AutomotiveViewerModel } from '../../parsers/automotive/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { automotiveViewerCss } from './styles.js';

export { automotiveViewerCss } from './styles.js';
export type AutomotiveViewerContext = HostContext & { clipboard?: ClipboardService };

export async function mountAutomotiveViewer(
    format: AutomotiveFormat,
    input: ViewerInput,
    container: HTMLElement,
    ctx: AutomotiveViewerContext,
    options: MountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const model = parseAutomotive(format, input.data);
    if (options.signal?.aborted) throw new MountAbortedError();
    const disposers: Array<() => void> = [];
    let root: HTMLElement | ShadowRoot = container;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && container.attachShadow) {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        const style = element('style');
        style.textContent = automotiveViewerCss;
        root.append(style);
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--automotive');
    }

    const frame = element('div', 'omni-auto');
    const header = element('header', 'omni-auto__header');
    const heading = element('div');
    heading.append(element('div', 'omni-auto__eyebrow', model.format), element('strong', 'omni-auto__title', input.fileName));
    const subtitle = element('div', 'omni-auto__subtitle', `${model.title} · ${formatBytes(model.fileSizeBytes)}`);
    heading.append(subtitle);
    header.append(heading);
    const summary = element('section', 'omni-auto__summary');
    model.summary.forEach(item => {
        const card = element('div', 'omni-auto__summary-item');
        const value = element('div', 'omni-auto__summary-value', String(item.value));
        value.title = String(item.value);
        card.append(value, element('div', 'omni-auto__summary-label', item.label));
        summary.append(card);
    });

    const toolbar = element('div', 'omni-auto__toolbar');
    const search = element('input') as HTMLInputElement;
    search.type = 'search';
    search.placeholder = ctx.i18n.t('automotive.search');
    search.setAttribute('aria-label', ctx.i18n.t('automotive.search'));
    const tabs = element('div', 'omni-auto__tabs');
    const copy = element('button', undefined, ctx.i18n.t('automotive.copyJson')) as HTMLButtonElement;
    copy.type = 'button';
    if (!ctx.clipboard) { copy.disabled = true; copy.title = ctx.i18n.t('common.noClipboard'); }
    toolbar.append(search, tabs, copy);
    const warnings = element('section', 'omni-auto__warnings');
    warnings.hidden = model.warnings.length === 0;
    model.warnings.forEach(warning => warnings.append(element('div', undefined, warning)));
    const content = element('main', 'omni-auto__content');
    frame.append(header, summary, toolbar, warnings, content);
    root.append(frame);

    let active = 0;
    let raw = false;
    const on = (target: EventTarget, type: string, listener: EventListener): void => {
        target.addEventListener(type, listener);
        disposers.push(() => target.removeEventListener(type, listener));
    };
    const activate = (index: number, showRaw: boolean): void => { active = index; raw = showRaw; renderTabs(); render(); };
    const renderTabs = (): void => {
        tabs.replaceChildren();
        model.tables.forEach((table, index) => {
            const button = element('button', undefined, table.title) as HTMLButtonElement;
            button.type = 'button';
            button.setAttribute('aria-pressed', String(!raw && active === index));
            button.onclick = () => activate(index, false);
            tabs.append(button);
        });
        if (model.rawPreview !== undefined) {
            const button = element('button', undefined, ctx.i18n.t('automotive.rawPreview')) as HTMLButtonElement;
            button.type = 'button';
            button.setAttribute('aria-pressed', String(raw));
            button.onclick = () => activate(active, true);
            tabs.append(button);
        }
    };
    const render = (): void => {
        content.replaceChildren();
        if (raw) { content.append(element('pre', 'omni-auto__raw', model.rawPreview ?? '')); return; }
        const table = model.tables[active];
        if (!table) { content.append(element('div', 'omni-auto__empty', ctx.i18n.t('automotive.noData'))); return; }
        renderTable(content, table, search.value.trim().toLowerCase(), ctx.i18n.t.bind(ctx.i18n));
    };
    on(search, 'input', render);
    on(copy, 'click', () => {
        if (!ctx.clipboard) return;
        void ctx.clipboard.writeText(JSON.stringify(model, null, 2)).catch(error => ctx.logger.log('error', `automotive copy failed: ${String(error)}`));
    });
    renderTabs();
    render();
    return {
        dispose() {
            disposers.splice(0).forEach(dispose => dispose());
            frame.remove();
            if (root instanceof ShadowRoot) root.replaceChildren();
            else container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--automotive');
        }
    };
}

function renderTable(container: HTMLElement, table: AutomotiveTable, query: string, t: (key: string, args?: Record<string, string | number>) => string): void {
    const rows = query ? table.rows.filter(row => row.some(cell => String(cell).toLowerCase().includes(query))) : table.rows;
    const shown = rows.slice(0, 1000);
    const header = element('div', 'omni-auto__panel-header');
    header.append(element('h2', 'omni-auto__panel-title', table.title), element('span', 'omni-auto__caption', t('automotive.rowsShown', { shown: shown.length, total: rows.length })));
    const wrap = element('div', 'omni-auto__table-wrap');
    const tableElement = element('table');
    const head = element('thead');
    const headRow = element('tr');
    table.headers.forEach(value => headRow.append(element('th', undefined, value)));
    head.append(headRow);
    const body = element('tbody');
    shown.forEach(row => {
        const tr = element('tr');
        row.forEach(value => { const td = element('td', undefined, String(value)); td.title = String(value); tr.append(td); });
        body.append(tr);
    });
    tableElement.append(head, body);
    wrap.append(tableElement);
    container.append(header, wrap);
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
