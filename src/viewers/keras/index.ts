import type { ClipboardService, HostContext } from '../../host/index.js';
import {
    formatCount,
    parseKeras,
    type KerasDocument,
    type KerasEntry,
    type KerasLayer,
    type KerasWeight
} from '../../parsers/keras/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { kerasViewerCss } from './styles.js';

export { looksLikeKerasHdf5, parseKeras } from '../../parsers/keras/index.js';
export type {
    KerasArchiveEntry,
    KerasDocument,
    KerasEntry,
    KerasLayer,
    KerasWarning,
    KerasWeight
} from '../../parsers/keras/index.js';
export { kerasViewerCss } from './styles.js';

export const KERAS_VIEWER_META = {
    id: 'keras',
    displayNameKey: 'keras.title',
    extensions: ['keras'],
    priority: 20,
    requiredServices: [] as const,
    optionalServices: ['clipboard'] as const,
    inputOwnership: 'borrows' as const
};

export type KerasViewerContext = HostContext & { clipboard?: ClipboardService };

/** Rows rendered per table before the panel reports what it omitted. */
export const KERAS_TABLE_ROW_LIMIT = 2000;

type TabId = 'layers' | 'weights' | 'config' | 'training' | 'files' | 'model';

export async function mountKerasViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: KerasViewerContext,
    options: MountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    let model: KerasDocument;
    try {
        model = await parseKeras(input.data, input.fileName, { ...(options.signal ? { signal: options.signal } : {}) });
    } catch (error) {
        if (options.signal?.aborted) throw new MountAbortedError();
        throw error;
    }
    if (options.signal?.aborted) throw new MountAbortedError();
    return mountKerasDocument(model, input.fileName, container, ctx, options);
}

/** Mounts an already-parsed model, so adapters can parse off the UI thread. */
export function mountKerasDocument(
    model: KerasDocument,
    fileName: string,
    container: HTMLElement,
    ctx: KerasViewerContext,
    options: MountOptions = {}
): ViewerHandle {
    if (options.signal?.aborted) throw new MountAbortedError();
    const t = ctx.i18n.t.bind(ctx.i18n);
    let root: HTMLElement | ShadowRoot = container;
    let injectedStyle: HTMLStyleElement | undefined;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && typeof container.attachShadow === 'function') {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        const style = element('style');
        style.textContent = kerasViewerCss;
        root.append(style);
        injectedStyle = style;
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--keras');
    }

    const formatLabel = t(model.format === 'Keras v3' ? 'keras.document.v3' : 'keras.document.hdf5');
    const subtitle = [
        model.modelClass || t('keras.title'),
        model.fileSize,
        model.kerasVersion ? t('keras.version', { version: model.kerasVersion }) : formatLabel
    ].join(' · ');

    const frame = element('div', 'omni-keras');
    const header = element('header', 'omni-keras__header');
    const heading = element('div');
    heading.append(
        element('div', 'omni-keras__eyebrow', 'KERAS'),
        element('h1', undefined, fileName),
        element('div', 'omni-keras__subtitle', subtitle)
    );
    header.append(heading);

    const summary = element('section', 'omni-keras__summary');
    for (const item of model.summary) {
        const card = element('div', 'omni-keras__summary-item');
        const value = item.value === 'invalid' ? t('keras.invalid') : String(item.value);
        card.append(
            element('div', 'omni-keras__summary-value', value),
            element('div', 'omni-keras__summary-label', t(item.labelKey))
        );
        summary.append(card);
    }

    const toolbar = element('div', 'omni-keras__toolbar');
    const search = element('input', 'omni-keras__search') as HTMLInputElement;
    search.type = 'search';
    search.placeholder = t('keras.search');
    search.setAttribute('aria-label', t('keras.search'));
    const tabs = element('div', 'omni-keras__tabs');
    const copy = element('button', undefined, t('keras.copyJson')) as HTMLButtonElement;
    copy.type = 'button';
    if (!ctx.clipboard) {
        copy.disabled = true;
        copy.title = t('common.noClipboard');
    }
    toolbar.append(search, tabs, copy);

    const warnings = element('section', 'omni-keras__warnings');
    warnings.setAttribute('role', 'status');
    for (const warning of model.warnings) warnings.append(element('div', undefined, t(warning.key, warning.args)));
    warnings.hidden = model.warnings.length === 0;
    const content = element('main', 'omni-keras__content');
    frame.append(header, summary, toolbar, warnings, content);
    root.append(frame);

    const available: Array<[TabId, string]> = [
        ['layers', t('keras.tab.layers')],
        ['weights', t('keras.tab.weights')],
        ['config', t('keras.tab.config')],
        ['training', t('keras.tab.training')],
        ...(model.files.length ? [['files', t('keras.tab.files')] as [TabId, string]] : []),
        ['model', t('keras.tab.model')]
    ];
    let activeTab: TabId = 'layers';
    const expanded = new Set<number>();
    let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
    const disposers: Array<() => void> = [];
    const on = (target: EventTarget, type: string, listener: EventListener): void => {
        target.addEventListener(type, listener);
        disposers.push(() => target.removeEventListener(type, listener));
    };

    const query = (): string => search.value.trim().toLowerCase();
    const matches = (...fields: Array<string | number | undefined>): boolean => {
        const needle = query();
        return !needle || fields.some(field => field !== undefined && String(field).toLowerCase().includes(needle));
    };

    const renderTabs = (): void => {
        tabs.replaceChildren();
        for (const [id, label] of available) {
            const button = element('button', undefined, label) as HTMLButtonElement;
            button.type = 'button';
            button.setAttribute('aria-pressed', String(activeTab === id));
            button.onclick = () => {
                activeTab = id;
                renderTabs();
                renderContent();
            };
            tabs.append(button);
        }
    };

    /** Panel heading with `shown / total`, where total counts unfiltered rows. */
    const panel = (title: string, shown: number, total: number): HTMLElement => {
        const node = element('div', 'omni-keras__panel-header');
        node.append(
            element('h2', undefined, title),
            element('span', undefined, shown === total
                ? t('keras.rows', { count: total })
                : t('keras.rowsLimited', { shown, total }))
        );
        return node;
    };

    const table = (headers: string[], rows: HTMLTableRowElement[]): HTMLElement => {
        const wrap = element('div', 'omni-keras__table-wrap');
        const node = element('table');
        const head = element('thead');
        const headRow = element('tr');
        for (const label of headers) headRow.append(element('th', undefined, label));
        head.append(headRow);
        const body = element('tbody');
        body.append(...rows);
        node.append(head, body);
        wrap.append(node);
        return wrap;
    };

    const cell = (value: string | number, className?: string): HTMLTableCellElement => {
        const node = element('td', className, String(value));
        node.title = String(value);
        return node;
    };

    const renderLayers = (): void => {
        const filtered = model.layers.filter(layer =>
            matches(layer.name, layer.className, layer.activation, layer.inputShape, ...layer.inbound));
        const visible = filtered.slice(0, KERAS_TABLE_ROW_LIMIT);
        const rows: HTMLTableRowElement[] = [];
        for (const layer of visible) {
            const row = element('tr', 'omni-keras__row');
            row.tabIndex = 0;
            row.setAttribute('aria-expanded', String(expanded.has(layer.index)));
            const name = element('td', 'omni-keras__name');
            // Nested sub-model layers are indented rather than given their own
            // table, so the flattened order still reads as the model's order.
            name.append(element('span', 'omni-keras__kind', '· '.repeat(layer.depth)), document.createTextNode(layer.name || '—'));
            name.title = layer.name;
            row.append(
                cell(layer.index, 'omni-keras__num'),
                name,
                cell(layer.className || '—'),
                cell(layer.inputShape || '—'),
                cell(layer.activation || '—'),
                cell(formatCount(layer.parameters), 'omni-keras__num'),
                cell(layer.weights.length, 'omni-keras__num'),
                cell(layer.trainable === undefined ? '—' : layer.trainable ? '✓' : '✗')
            );
            const toggle = (): void => {
                if (expanded.has(layer.index)) expanded.delete(layer.index);
                else expanded.add(layer.index);
                renderContent();
            };
            row.onclick = toggle;
            row.onkeydown = event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggle();
                }
            };
            rows.push(row);
            if (expanded.has(layer.index)) rows.push(layerDetail(layer));
        }
        content.append(
            panel(t('keras.tab.layers'), visible.length, model.layers.length),
            rows.length
                ? table([
                    '#', t('keras.column.name'), t('keras.column.type'), t('keras.column.inputShape'),
                    t('keras.column.activation'), t('keras.column.parameters'), t('keras.column.weights'),
                    t('keras.column.trainable')
                ], rows)
                : element('div', 'omni-keras__empty', t('keras.noLayers'))
        );
    };

    const layerDetail = (layer: KerasLayer): HTMLTableRowElement => {
        const row = element('tr', 'omni-keras__detail');
        const body = element('td');
        body.colSpan = 8;
        if (layer.module || layer.registeredName || layer.dtype) {
            body.append(section(t('keras.detail.identity'), [
                ...(layer.module ? [{ label: 'module', value: layer.module }] : []),
                ...(layer.registeredName ? [{ label: 'registered_name', value: layer.registeredName }] : []),
                ...(layer.dtype ? [{ label: 'dtype', value: layer.dtype }] : [])
            ]));
        }
        if (layer.inbound.length) {
            const chips = element('div', 'omni-keras__chips');
            for (const name of layer.inbound) chips.append(element('span', 'omni-keras__chip', name));
            body.append(element('h3', undefined, t('keras.detail.inbound')), chips);
        }
        if (layer.weights.length) {
            body.append(section(t('keras.detail.weights'), layer.weights.map(weight => ({
                label: weight.name,
                value: `${formatShape(weight.shape)} · ${weight.type} · ${formatCount(weight.parameters)}`
            }))));
        }
        if (layer.config.length) body.append(section(t('keras.detail.config'), layer.config));
        if (!body.childNodes.length) body.append(element('div', 'omni-keras__empty', t('keras.noData')));
        row.append(body);
        return row;
    };

    const section = (title: string, entries: readonly KerasEntry[]): DocumentFragment => {
        const fragment = document.createDocumentFragment();
        fragment.append(element('h3', undefined, title));
        const grid = element('div', 'omni-keras__detail-grid');
        for (const entry of entries) {
            const node = element('div', 'omni-keras__attribute');
            node.append(element('b', undefined, `${entry.label}: `), document.createTextNode(entry.value));
            grid.append(node);
        }
        fragment.append(grid);
        return fragment;
    };

    const renderWeights = (): void => {
        // A nested sub-model can repeat an outer layer's name, so the column
        // shows the owning layer's path rather than the ambiguous leaf name.
        const owner = (weight: KerasWeight): string => weight.owner.join(' / ') || weight.layer || '—';
        const filtered = model.weights.filter(weight =>
            matches(weight.name, owner(weight), weight.path, weight.type, formatShape(weight.shape)));
        const visible = filtered.slice(0, KERAS_TABLE_ROW_LIMIT);
        content.append(
            panel(t('keras.tab.weights'), visible.length, model.weights.length),
            visible.length
                ? table([
                    t('keras.column.name'), t('keras.column.layer'), t('keras.column.shape'),
                    t('keras.column.dtype'), t('keras.column.parameters'), t('keras.column.bytes'),
                    t('keras.column.path')
                ], visible.map((weight: KerasWeight) => {
                    const row = element('tr');
                    row.append(
                        cell(weight.name), cell(owner(weight)), cell(formatShape(weight.shape)),
                        cell(weight.type), cell(formatCount(weight.parameters), 'omni-keras__num'),
                        cell(formatBytes(weight.bytes), 'omni-keras__num'), cell(weight.path)
                    );
                    return row;
                }))
                : element('div', 'omni-keras__empty', t('keras.noWeights'))
        );
    };

    const renderEntries = (title: string, entries: readonly KerasEntry[], emptyKey: string): void => {
        const filtered = entries.filter(entry => matches(entry.label, entry.value));
        const visible = filtered.slice(0, KERAS_TABLE_ROW_LIMIT);
        content.append(
            panel(title, visible.length, entries.length),
            visible.length
                ? table([t('keras.column.field'), t('keras.column.value')], visible.map(entry => {
                    const row = element('tr');
                    row.append(cell(entry.label), cell(entry.value));
                    return row;
                }))
                : element('div', 'omni-keras__empty', t(emptyKey))
        );
    };

    const renderFiles = (): void => {
        const filtered = model.files.filter(file => matches(file.name, file.method));
        const visible = filtered.slice(0, KERAS_TABLE_ROW_LIMIT);
        content.append(
            panel(t('keras.tab.files'), visible.length, model.files.length),
            visible.length
                ? table([
                    t('keras.column.name'), t('keras.column.size'),
                    t('keras.column.compressed'), t('keras.column.method')
                ], visible.map(file => {
                    const row = element('tr');
                    row.append(
                        cell(file.name), cell(formatBytes(file.size), 'omni-keras__num'),
                        cell(formatBytes(file.compressedSize), 'omni-keras__num'), cell(file.method)
                    );
                    return row;
                }))
                : element('div', 'omni-keras__empty', t('keras.noData'))
        );
    };

    const renderConfig = (): void => {
        if (!model.configText) {
            content.append(element('div', 'omni-keras__empty', t('keras.noConfig')));
            return;
        }
        content.append(element('pre', undefined, model.configText));
    };

    const renderModelInfo = (): void => {
        const rows: KerasEntry[] = [
            { label: t('keras.model.format'), value: formatLabel },
            { label: t('keras.model.class'), value: model.modelClass || '—' },
            { label: t('keras.model.name'), value: model.modelName || '—' },
            { label: t('keras.model.kerasVersion'), value: model.kerasVersion || '—' },
            ...(model.backend ? [{ label: t('keras.model.backend'), value: model.backend }] : []),
            ...(model.dateSaved ? [{ label: t('keras.model.dateSaved'), value: model.dateSaved }] : []),
            { label: t('keras.model.fileSize'), value: model.fileSize },
            { label: t('keras.model.parameters'), value: formatCount(totalParameters(model)) },
            ...(model.inputs.length ? [{ label: t('keras.model.inputs'), value: model.inputs.join(', ') }] : []),
            ...(model.outputs.length ? [{ label: t('keras.model.outputs'), value: model.outputs.join(', ') }] : []),
            ...model.metadata
        ];
        const list = element('dl', 'omni-keras__model-info');
        for (const row of rows.filter(entry => matches(entry.label, entry.value))) {
            list.append(element('dt', undefined, row.label), element('dd', undefined, row.value));
        }
        content.append(list.childNodes.length ? list : element('div', 'omni-keras__empty', t('keras.noData')));
    };

    const renderContent = (): void => {
        content.replaceChildren();
        if (activeTab === 'layers') renderLayers();
        else if (activeTab === 'weights') renderWeights();
        else if (activeTab === 'config') renderConfig();
        else if (activeTab === 'training') renderEntries(t('keras.tab.training'), model.training, 'keras.noTraining');
        else if (activeTab === 'files') renderFiles();
        else renderModelInfo();
    };

    on(search, 'input', () => renderContent());
    on(copy, 'click', () => {
        if (!ctx.clipboard) return;
        void ctx.clipboard.writeText(JSON.stringify(model, undefined, 2))
            .catch((error: unknown) => ctx.logger.log('error', `Keras JSON copy failed: ${String(error)}`));
        copy.textContent = t('common.copied');
        if (copyResetTimer !== undefined) clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(() => { copy.textContent = t('keras.copyJson'); }, 1200);
    });
    renderTabs();
    renderContent();

    return {
        dispose(): void {
            if (copyResetTimer !== undefined) clearTimeout(copyResetTimer);
            disposers.splice(0).forEach(dispose => dispose());
            frame.remove();
            injectedStyle?.remove();
            if (!(root instanceof ShadowRoot)) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--keras');
        }
    };
}

function totalParameters(model: KerasDocument): number {
    return model.weights.reduce((sum, weight) => sum + weight.parameters, 0);
}

function formatShape(shape: readonly number[]): string {
    return shape.length ? shape.join(' × ') : 'scalar';
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} bytes`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = units[0]!;
    for (let index = 1; index < units.length && value >= 1024; index++) {
        value /= 1024;
        unit = units[index]!;
    }
    return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
