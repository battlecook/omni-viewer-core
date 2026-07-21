import type { ClipboardService, HostContext } from '../../host/index.js';
import { parseSafetensors, type SafetensorsDocument, type SafetensorsTable } from '../../parsers/safetensors/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { safetensorsViewerCss } from './styles.js';

export { safetensorsViewerCss } from './styles.js';

export const SAFETENSORS_VIEWER_META = {
    id: 'safetensors',
    displayNameKey: 'safetensors.title',
    extensions: ['safetensors'],
    priority: 20,
    requiredServices: [] as const,
    optionalServices: ['clipboard'] as const,
    inputOwnership: 'borrows' as const
};

export type SafetensorsViewerContext = HostContext & { clipboard?: ClipboardService };

export async function mountSafetensorsViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: SafetensorsViewerContext,
    options: MountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const document = parseSafetensors(input.data);
    if (options.signal?.aborted) throw new MountAbortedError();
    return mountSafetensorsDocument(document, input.fileName, container, ctx, options);
}

/** Mount a pre-parsed model, allowing Node adapters to retain random-access parsing. */
export function mountSafetensorsDocument(
    document: SafetensorsDocument,
    fileName: string,
    container: HTMLElement,
    ctx: SafetensorsViewerContext,
    options: MountOptions = {}
): ViewerHandle {
    if (options.signal?.aborted) throw new MountAbortedError();
    let root: HTMLElement | ShadowRoot = container;
    let injectedStyle: HTMLStyleElement | undefined;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && container.attachShadow) {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        const style = element('style');
        style.textContent = safetensorsViewerCss;
        root.append(style);
        injectedStyle = style;
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--safetensors');
    }

    const frame = element('div', 'omni-safetensors');
    const header = element('header', 'omni-safetensors__header');
    const heading = element('div');
    heading.append(
        element('div', 'omni-safetensors__eyebrow', document.format),
        element('h1', undefined, fileName),
        element('div', 'omni-safetensors__subtitle', `${document.title} · ${document.fileSize}`)
    );
    header.append(heading);

    const summary = element('section', 'omni-safetensors__summary');
    for (const item of document.summary) {
        const card = element('div', 'omni-safetensors__summary-item');
        card.append(
            element('div', 'omni-safetensors__summary-value', String(item.value)),
            element('div', 'omni-safetensors__summary-label', item.label)
        );
        summary.append(card);
    }

    const toolbar = element('div', 'omni-safetensors__toolbar');
    const search = element('input', 'omni-safetensors__search') as HTMLInputElement;
    search.type = 'search';
    search.placeholder = ctx.i18n.t('safetensors.search');
    search.setAttribute('aria-label', ctx.i18n.t('safetensors.search'));
    const tabs = element('div', 'omni-safetensors__tabs');
    const copy = element('button', undefined, ctx.i18n.t('safetensors.copyJson')) as HTMLButtonElement;
    copy.type = 'button';
    if (!ctx.clipboard) {
        copy.disabled = true;
        copy.title = ctx.i18n.t('common.noClipboard');
    }
    toolbar.append(search, tabs, copy);

    const warnings = element('section', 'omni-safetensors__warnings');
    warnings.setAttribute('role', 'status');
    for (const warning of document.warnings) warnings.append(element('div', undefined, warning));
    if (document.warnings.length === 0) warnings.hidden = true;
    const content = element('main', 'omni-safetensors__content');
    frame.append(header, summary, toolbar, warnings, content);
    root.append(frame);

    let activeTab = 0;
    let raw = false;
    let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
    const disposers: Array<() => void> = [];
    const on = (target: EventTarget, type: string, listener: EventListener): void => {
        target.addEventListener(type, listener);
        disposers.push(() => target.removeEventListener(type, listener));
    };

    const renderTabs = (): void => {
        tabs.replaceChildren();
        document.tables.forEach((table, index) => {
            const button = element('button', undefined, table.title);
            button.type = 'button';
            button.setAttribute('aria-pressed', String(!raw && activeTab === index));
            button.onclick = () => { activeTab = index; raw = false; renderTabs(); renderContent(); };
            tabs.append(button);
        });
        if (document.rawPreview) {
            const button = element('button', undefined, ctx.i18n.t('safetensors.structure'));
            button.type = 'button';
            button.setAttribute('aria-pressed', String(raw));
            button.onclick = () => { raw = true; renderTabs(); renderContent(); };
            tabs.append(button);
        }
    };

    const matchingRows = (table: SafetensorsTable): Array<Array<string | number>> => {
        const query = search.value.trim().toLowerCase();
        if (!query) return table.rows;
        return table.rows.filter(row => row.some(cell => String(cell).toLowerCase().includes(query)));
    };

    const renderContent = (): void => {
        content.replaceChildren();
        if (raw) {
            content.append(element('pre', undefined, document.rawPreview ?? ''));
            return;
        }
        const table = document.tables[activeTab];
        if (!table) {
            content.append(element('div', 'omni-safetensors__empty', ctx.i18n.t('safetensors.noData')));
            return;
        }
        const rows = matchingRows(table);
        const visible = rows.slice(0, 1000);
        const panelHeader = element('div', 'omni-safetensors__panel-header');
        panelHeader.append(
            element('h2', undefined, table.title),
            element('span', undefined, ctx.i18n.t(
                rows.length > visible.length ? 'safetensors.matchingRowsLimited' : 'safetensors.matchingRows',
                rows.length > visible.length ? { visible: visible.length, total: rows.length } : { count: rows.length }
            ))
        );
        const wrap = element('div', 'omni-safetensors__table-wrap');
        const tableElement = element('table');
        const head = element('thead');
        const headerRow = element('tr');
        for (const label of table.headers) headerRow.append(element('th', undefined, label));
        head.append(headerRow);
        const body = element('tbody');
        for (const row of visible) {
            const tr = element('tr');
            for (const cell of row) {
                const value = String(cell);
                const td = element('td', undefined, value);
                td.title = value;
                tr.append(td);
            }
            body.append(tr);
        }
        tableElement.append(head, body);
        wrap.append(tableElement);
        content.append(panelHeader, wrap);
    };

    on(search, 'input', () => renderContent());
    on(copy, 'click', () => {
        if (!ctx.clipboard) return;
        void ctx.clipboard.writeText(JSON.stringify(document, null, 2));
        copy.textContent = ctx.i18n.t('common.copied');
        if (copyResetTimer !== undefined) clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(() => { copy.textContent = ctx.i18n.t('safetensors.copyJson'); }, 1200);
    });
    renderTabs();
    renderContent();

    return {
        dispose(): void {
            if (copyResetTimer !== undefined) clearTimeout(copyResetTimer);
            disposers.splice(0).forEach(dispose => dispose());
            frame.remove();
            injectedStyle?.remove();
            if (!(root instanceof ShadowRoot)) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--safetensors');
        }
    };
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
