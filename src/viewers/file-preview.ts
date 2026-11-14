import type { HostContext } from '../host/index.js';
import type { ParseOptions, ParseResult } from '../parsers/types.js';
import { filePreviewCss } from './file-preview-styles.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from './types.js';

type Translate = HostContext['i18n']['t'];
export const SVG_NS = 'http://www.w3.org/2000/svg';
export type FilePreviewOptions = MountOptions & ParseOptions;

export interface PreviewUi {
    doc: Document;
    t: Translate;
    body: HTMLElement;
    el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K];
    button(text: string, action: () => void): HTMLButtonElement;
}
export function mountFilePreview<T>(
    input: ViewerInput, container: HTMLElement, ctx: HostContext, options: FilePreviewOptions,
    id: string, result: ParseResult<T>, render: (ui: PreviewUi, model: T) => void | (() => void)
): ViewerHandle {
    if (options.signal?.aborted || (result.status === 'failed' && result.failure.code === 'aborted')) throw new MountAbortedError();
    const doc = container.ownerDocument;
    const t = ctx.i18n.t.bind(ctx.i18n);
    const el: PreviewUi['el'] = (tag, text, className) => {
        const node = doc.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (className) node.className = className;
        return node;
    };
    const shell = el('section', undefined, `${VIEWER_ROOT_CLASS} omni-file-preview omni-viewer--${id}`);
    shell.append(el('h2', t(`${id}.title`)), el('p', input.fileName));
    const status = el('div', undefined, 'preview-warning');
    status.setAttribute('role', 'status');
    for (const diagnostic of result.diagnostics) status.append(el('p', t(diagnostic.messageKey, diagnostic.args)));
    if (result.status === 'failed') status.append(el('p', t(result.failure.messageKey, result.failure.args)));
    shell.append(status);
    const body = el('div');
    shell.append(body);
    const ui: PreviewUi = {
        doc, t, el, body,
        button(text, action) {
            const node = el('button', text);
            node.type = 'button';
            node.addEventListener('click', action);
            return node;
        }
    };
    const root = options.styleIsolation === 'scoped' ? container : container.shadowRoot ?? container.attachShadow({ mode: 'open' });
    const style = root === container ? undefined : el('style', filePreviewCss);
    if (style) root.append(style);
    root.append(shell);
    let clean: void | (() => void);
    try {
        clean = result.status === 'failed' ? undefined : render(ui, result.document);
    } catch (error) {
        shell.remove();
        style?.remove();
        throw error;
    }
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        clean?.();
        shell.remove();
        style?.remove();
    };
    if (options.signal?.aborted) {
        dispose();
        throw new MountAbortedError();
    }
    return { dispose };
}

export function svgElement<K extends keyof SVGElementTagNameMap>(
    doc: Document, tag: K, attributes: Record<string, string | number> = {}
): SVGElementTagNameMap[K] {
    const element = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    return element;
}

/** Refit on attachment or host resize without re-rendering a page. */
export function observePreviewWidth(scroll: HTMLElement, resize: () => void): (() => void) | undefined {
    const ResizeObserver = scroll.ownerDocument.defaultView?.ResizeObserver;
    if (!ResizeObserver) return;
    let width = scroll.clientWidth;
    const observer = new ResizeObserver(() => {
        const next = scroll.clientWidth;
        if (next <= 0 || next === width) return;
        width = next;
        resize();
    });
    observer.observe(scroll);
    return () => observer.disconnect();
}

export function previewLines(lines: Iterable<string>, limit = 64 * 1024): string {
    const parts: string[] = [];
    let length = 0;
    for (const line of lines) {
        const separator = parts.length ? '\n' : '';
        const remaining = limit - length - separator.length;
        if (line.length > remaining) {
            return (parts.join('') + separator + line.slice(0, Math.max(0, remaining))).slice(0, limit - 1) + '…';
        }
        parts.push(separator, line);
        length += separator.length + line.length;
    }
    return parts.join('');
}

export function previewDetails(ui: PreviewUi, fields: readonly (readonly [string, string])[]): HTMLDListElement {
    const list = ui.el('dl');
    for (const [name, value] of fields) {
        if (value) list.append(ui.el('dt', name), ui.el('dd', value.slice(0, 64 * 1024)));
    }
    return list;
}

export function previewPager(ui: PreviewUi, toolbar: HTMLElement, onPage: (index: number) => void) {
    let index = 0, total = 0;
    const status = ui.el('span');
    status.setAttribute('aria-live', 'polite');
    const go = (page: number) => {
        index = Math.max(0, Math.min(page, total - 1));
        update();
        onPage(index);
    };
    const previous = ui.button(ui.t('preview.previous'), () => go(index - 1));
    const next = ui.button(ui.t('preview.next'), () => go(index + 1));
    const update = () => {
        previous.disabled = index === 0;
        next.disabled = index + 1 >= total;
        status.textContent = ui.t('preview.page', { current: total ? index + 1 : 0, total });
    };
    toolbar.append(previous, status, next);
    return { reset: (count: number) => { total = count; go(0); } };
}

interface PreviewFilter<T> {
    label: string;
    value: (row: T) => string | readonly string[];
    format?: (value: string) => string;
}
interface PreviewTable<T> {
    rows: readonly T[];
    headers: string[];
    cells: (row: T) => string[];
    details: (row: T) => Node;
    filters?: PreviewFilter<T>[];
}
export function renderPreviewTable<T>(ui: PreviewUi, model: PreviewTable<T>): void {
    const pageSize = 50;
    const toolbar = ui.el('div', undefined, 'preview-toolbar');
    const search = ui.el('input');
    search.type = 'search';
    search.placeholder = ui.t('preview.search');
    search.setAttribute('aria-label', search.placeholder);
    toolbar.append(search);
    const valuesOf = (filter: PreviewFilter<T>, row: T): readonly string[] => {
        const value = filter.value(row);
        return typeof value === 'string' ? [value] : value;
    };
    const filters = (model.filters ?? []).map(filter => {
        const select = ui.el('select');
        const label = ui.el('label', filter.label);
        const values = new Set<string>();
        for (const row of model.rows) {
            for (const value of valuesOf(filter, row)) if (value) values.add(value);
            if (values.size > 500) break;
        }
        // Large cardinalities stay searchable without creating an option per row.
        if (values.size > 500) {
            const input = ui.el('input');
            input.type = 'search';
            label.append(input);
            toolbar.append(label);
            return { control: input, filter };
        }
        select.append(ui.el('option', ui.t('preview.all')));
        select.options[0]!.value = '';
        for (const value of [...values].sort()) {
            const option = ui.el('option', (filter.format?.(value) ?? value).slice(0, 2048));
            option.value = value;
            select.append(option);
        }
        label.append(select);
        toolbar.append(label);
        return { control: select, filter };
    });
    const scroll = ui.el('div', undefined, 'preview-scroll');
    const table = ui.el('table');
    const head = table.createTHead().insertRow();
    for (const name of model.headers) {
        const cell = ui.el('th', name);
        cell.scope = 'col';
        head.append(cell);
    }
    const body = table.createTBody();
    scroll.append(table);
    const details = ui.el('div');
    const total = ui.el('p');
    total.setAttribute('aria-live', 'polite');
    let filtered = model.rows;
    const cache = model.rows.map(row => model.cells(row));
    const indexes = new Map(model.rows.map((row, index) => [row, index]));
    const pager = previewPager(ui, toolbar, index => {
        body.replaceChildren();
        details.replaceChildren();
        let selected: HTMLButtonElement | undefined;
        for (const row of filtered.slice(index * pageSize, (index + 1) * pageSize)) {
            const tr = body.insertRow();
            const values = cache[indexes.get(row)!]!;
            for (let column = 0; column < values.length; column++) {
                const cell = tr.insertCell();
                if (column !== 0) cell.textContent = values[column]!.slice(0, 2048);
                else {
                    const button = ui.button(values[column]!.slice(0, 2048) || '–', () => {
                        selected?.setAttribute('aria-pressed', 'false');
                        selected = button;
                        button.setAttribute('aria-pressed', 'true');
                        details.replaceChildren(model.details(row));
                    });
                    button.setAttribute('aria-pressed', 'false');
                    cell.append(button);
                }
            }
        }
    });
    const update = () => {
        const query = search.value.trim().toLowerCase();
        const active = filters.flatMap(({ control, filter }) => {
            if (control.tagName === 'SELECT') {
                return control.value ? [(row: T) => valuesOf(filter, row).includes(control.value)] : [];
            }
            const value = control.value.trim().toLowerCase();
            if (!value) return [];
            const matches = new Map<string, boolean>();
            return [(row: T) => valuesOf(filter, row).some(actual => {
                const known = matches.get(actual);
                if (known !== undefined) return known;
                const match = actual.toLowerCase().includes(value);
                matches.set(actual, match);
                return match;
            })];
        });
        const searchMatches = new Map<string, boolean>();
        const containsQuery = (value: string) => {
            const known = searchMatches.get(value);
            if (known !== undefined) return known;
            const match = value.toLowerCase().includes(query);
            searchMatches.set(value, match);
            return match;
        };
        filtered = model.rows.filter((row, index) =>
            (!query || cache[index]!.some(containsQuery)) && active.every(match => match(row)));
        total.textContent = ui.t('preview.matches', { count: filtered.length, total: model.rows.length });
        pager.reset(Math.ceil(filtered.length / pageSize));
    };
    search.addEventListener('input', update);
    for (const { control } of filters) control.addEventListener(control.tagName === 'SELECT' ? 'change' : 'input', update);
    ui.body.append(toolbar, total, scroll, details);
    update();
}
