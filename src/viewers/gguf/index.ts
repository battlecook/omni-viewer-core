import type { ClipboardService, HostContext } from '../../host/index.js';
import {
    GGUF_PREVIEW_ENTRY_LIMIT,
    parseGgufBytes,
    parseGgufUri,
    type GgufDocument,
    type GgufTable
} from '../../parsers/gguf/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { ggufViewerCss } from './styles.js';

export { ggufViewerCss } from './styles.js';

export const GGUF_VIEWER_META = {
    id: 'gguf',
    displayNameKey: 'gguf.title',
    extensions: ['gguf'],
    priority: 20,
    requiredServices: [] as const,
    optionalServices: ['clipboard'] as const,
    inputOwnership: 'borrows' as const
};

export type GgufViewerContext = HostContext & { clipboard?: ClipboardService };

export interface GgufViewerInput {
    uri: string;
    fileName: string;
    fileSize?: string;
}

/** Parses common in-memory viewer input and mounts the GGUF viewer. */
export function mountGgufViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: GgufViewerContext,
    options?: MountOptions
): Promise<ViewerHandle>;
/** Parses a remote URI and mounts the GGUF viewer. Node paths use parseGgufFile + mountGgufDocument. */
export function mountGgufViewer(
    input: GgufViewerInput,
    container: HTMLElement,
    ctx: GgufViewerContext,
    options?: MountOptions
): Promise<ViewerHandle>;
export async function mountGgufViewer(
    input: ViewerInput | GgufViewerInput,
    container: HTMLElement,
    ctx: GgufViewerContext,
    options: MountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    let document: GgufDocument;
    try {
        document = 'data' in input
            ? await parseGgufBytes(input.data, {
                ...(options.signal ? { signal: options.signal } : {})
            })
            : await parseGgufUri(input.uri, {
                ...(input.fileSize === undefined ? {} : { fileSize: input.fileSize }),
                ...(options.signal ? { signal: options.signal } : {})
            });
    } catch (error) {
        if (options.signal?.aborted) throw new MountAbortedError();
        throw error;
    }
    if (options.signal?.aborted) throw new MountAbortedError();
    return mountGgufDocument(document, input.fileName, container, ctx, options);
}

/** Mounts a pre-parsed JSON-safe model, which is the preferred VS Code path. */
export function mountGgufDocument(
    document: GgufDocument,
    fileName: string,
    container: HTMLElement,
    ctx: GgufViewerContext,
    options: MountOptions = {}
): ViewerHandle {
    if (options.signal?.aborted) throw new MountAbortedError();
    let root: HTMLElement | ShadowRoot = container;
    let injectedStyle: HTMLStyleElement | undefined;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && container.attachShadow) {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        const style = element('style');
        style.textContent = ggufViewerCss;
        root.append(style);
        injectedStyle = style;
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--gguf');
    }

    const frame = element('div', 'omni-gguf');
    const header = element('header', 'omni-gguf__header');
    const heading = element('div');
    heading.append(
        element('div', 'omni-gguf__eyebrow', document.format),
        element('h1', undefined, fileName),
        element('div', 'omni-gguf__subtitle', `${document.title} · ${document.fileSize}`)
    );
    header.append(heading);

    const summary = element('section', 'omni-gguf__summary');
    for (const item of document.summary) {
        const card = element('div', 'omni-gguf__summary-item');
        card.append(
            element('div', 'omni-gguf__summary-value', String(item.value)),
            element('div', 'omni-gguf__summary-label', ctx.i18n.t(item.labelKey))
        );
        summary.append(card);
    }

    const toolbar = element('div', 'omni-gguf__toolbar');
    const search = element('input', 'omni-gguf__search') as HTMLInputElement;
    search.type = 'search';
    search.placeholder = ctx.i18n.t('gguf.search');
    search.setAttribute('aria-label', ctx.i18n.t('gguf.search'));
    const tabs = element('div', 'omni-gguf__tabs');
    const copy = element('button', undefined, ctx.i18n.t('gguf.copyJson')) as HTMLButtonElement;
    copy.type = 'button';
    if (!ctx.clipboard) {
        copy.disabled = true;
        copy.title = ctx.i18n.t('common.noClipboard');
    }
    toolbar.append(search, tabs, copy);

    const warnings = element('section', 'omni-gguf__warnings');
    warnings.setAttribute('role', 'status');
    for (const warning of document.warnings) {
        warnings.append(element('div', undefined, ctx.i18n.t(warning.key, warning.args)));
    }
    // The localized warning only says the file is unusable. The parser's reason for
    // saying so is the one thing that tells a user which file is broken and how, so
    // show it rather than leaving it reachable only through Copy JSON.
    if (document.errorDetail) {
        warnings.append(element('div', 'omni-gguf__warning-detail', document.errorDetail));
    }
    warnings.hidden = warnings.childElementCount === 0;
    const content = element('main', 'omni-gguf__content');
    frame.append(header, summary, toolbar, warnings, content);
    root.append(frame);

    let activeTab = 0;
    let raw = false;
    let disposed = false;
    let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
    const disposers: Array<() => void> = [];
    const on = (target: EventTarget, type: string, listener: EventListener): void => {
        target.addEventListener(type, listener);
        disposers.push(() => target.removeEventListener(type, listener));
    };

    const renderTabs = (): void => {
        tabs.replaceChildren();
        document.tables.forEach((table, index) => {
            const button = element('button', undefined, ctx.i18n.t(table.titleKey, table.titleArgs));
            button.type = 'button';
            button.setAttribute('aria-pressed', String(!raw && activeTab === index));
            button.onclick = () => { activeTab = index; raw = false; renderTabs(); renderContent(); };
            tabs.append(button);
        });
        if (document.rawPreview) {
            const button = element('button', undefined, ctx.i18n.t('gguf.structure'));
            button.type = 'button';
            button.setAttribute('aria-pressed', String(raw));
            button.onclick = () => { raw = true; renderTabs(); renderContent(); };
            tabs.append(button);
        }
    };

    const matchingRows = (table: GgufTable): Array<Array<string | number>> => {
        const query = search.value.trim().toLowerCase();
        if (!query) return table.rows;
        return table.rows.filter((row) => row.some((cell) => String(cell).toLowerCase().includes(query)));
    };

    const renderContent = (): void => {
        content.replaceChildren();
        if (raw) {
            content.append(element('pre', undefined, document.rawPreview ?? ''));
            return;
        }
        const table = document.tables[activeTab];
        if (!table) {
            content.append(element('div', 'omni-gguf__empty', ctx.i18n.t('gguf.noData')));
            return;
        }
        const rows = matchingRows(table);
        // Same cap the parser applies, so documents from parseGguf* never hit this
        // branch; it is the DOM backstop for a GgufDocument a host built itself.
        const visible = rows.slice(0, GGUF_PREVIEW_ENTRY_LIMIT);
        const panelHeader = element('div', 'omni-gguf__panel-header');
        panelHeader.append(
            element('h2', undefined, ctx.i18n.t(table.titleKey, table.titleArgs)),
            element('span', undefined, ctx.i18n.t(
                rows.length > visible.length ? 'gguf.matchingRowsLimited' : 'gguf.matchingRows',
                rows.length > visible.length ? { visible: visible.length, total: rows.length } : { count: rows.length }
            ))
        );
        const wrap = element('div', 'omni-gguf__table-wrap');
        const tableElement = element('table');
        const head = element('thead');
        const headerRow = element('tr');
        for (const key of table.headerKeys) headerRow.append(element('th', undefined, ctx.i18n.t(key)));
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
    on(copy, 'click', () => { void copyJson(); });

    const copyJson = async (): Promise<void> => {
        if (!ctx.clipboard || disposed) return;
        copy.disabled = true;
        try {
            await ctx.clipboard.writeText(JSON.stringify(document, null, 2));
            if (disposed) return;
            copy.textContent = ctx.i18n.t('common.copied');
            if (copyResetTimer !== undefined) clearTimeout(copyResetTimer);
            copyResetTimer = setTimeout(() => {
                if (!disposed) copy.textContent = ctx.i18n.t('gguf.copyJson');
            }, 1_200);
        } catch (error) {
            ctx.logger.log('error', `gguf copy failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            if (!disposed) copy.disabled = false;
        }
    };
    renderTabs();
    renderContent();

    return {
        dispose(): void {
            disposed = true;
            if (copyResetTimer !== undefined) clearTimeout(copyResetTimer);
            disposers.splice(0).forEach((dispose) => dispose());
            frame.remove();
            injectedStyle?.remove();
            if (!(root instanceof ShadowRoot)) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--gguf');
        }
    };
}

function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
