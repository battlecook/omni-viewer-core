import type { ClipboardService, HostContext } from '../../host/index.js';
import {
    formatFileSize,
    parseOpenVino,
    type OpenVinoConstant,
    type OpenVinoDocument,
    type OpenVinoLayer,
    type OpenVinoMetadata,
    type OpenVinoPort
} from '../../parsers/openvino/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { openvinoViewerCss } from './styles.js';

export { looksLikeOpenVinoIr, parseOpenVino, previewConstant, OpenVinoParseError } from '../../parsers/openvino/index.js';
export type {
    OpenVinoConstant,
    OpenVinoConstantStatus,
    OpenVinoDocument,
    OpenVinoEdge,
    OpenVinoLayer,
    OpenVinoMetadata,
    OpenVinoOperatorCount,
    OpenVinoParseOptions,
    OpenVinoPort,
    OpenVinoWarning
} from '../../parsers/openvino/index.js';
export { openvinoViewerCss } from './styles.js';

export const OPENVINO_VIEWER_META = {
    id: 'openvino',
    displayNameKey: 'openvino.title',
    /** Never claimed by extension: `.xml` is shared with every other XML
     *  dialect, so routing is by content (looksLikeOpenVinoIr) only. */
    extensions: [] as string[],
    priority: 20,
    requiredServices: [] as const,
    optionalServices: ['clipboard'] as const,
    inputOwnership: 'borrows' as const
};

export type OpenVinoViewerContext = HostContext & { clipboard?: ClipboardService };

/** The `.bin` that accompanies the `.xml`. The core receives one file as
 *  ViewerInput; the adapter reads the same-named neighbour and passes it here.
 *  The topology renders without it — only constant previews and range checks
 *  need the weights. */
export interface OpenVinoSidecars {
    bin?: Uint8Array;
}

export interface OpenVinoMountOptions extends MountOptions {
    sidecars?: OpenVinoSidecars;
}

export async function mountOpenVinoViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: OpenVinoViewerContext,
    options: OpenVinoMountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const weights = options.sidecars?.bin;
    const model = parseOpenVino(input.data, { ...(weights ? { weights } : {}), ...(options.signal ? { signal: options.signal } : {}) });
    if (options.signal?.aborted) throw new MountAbortedError();
    return mountOpenVinoDocument(model, input.fileName, container, ctx, options);
}

type TabId = 'graph' | 'layers' | 'constants' | 'io' | 'model';
type CardKind = 'input' | 'const' | 'node' | 'output';
const MAX_GRAPH_NODES = 240;
const MAX_GRAPH_EDGES = 800;
const MAX_TABLE_ROWS = 2000;
const MAX_INSPECTOR_ITEMS = 64;
const CARD_WIDTH = 170;
const COLUMN_GAP = 220;
const ROW_GAP = 86;

/** Mounts an already-parsed model, so adapters can parse off the UI thread. */
export function mountOpenVinoDocument(
    model: OpenVinoDocument,
    fileName: string,
    container: HTMLElement,
    ctx: OpenVinoViewerContext,
    options: MountOptions = {}
): ViewerHandle {
    if (options.signal?.aborted) throw new MountAbortedError();
    let root: HTMLElement | ShadowRoot = container;
    let style: HTMLStyleElement | undefined;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && container.attachShadow) {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        style = element('style');
        style.textContent = openvinoViewerCss;
        root.append(style);
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--openvino');
    }
    const t = (key: string, args?: Record<string, string | number>): string => ctx.i18n.t(key, args);

    const frame = element('div', 'omni-openvino');
    const header = element('header', 'omni-openvino__header');
    const heading = element('div');
    const weightsLabel = model.weightsSize === null ? t('openvino.noBin') : t('openvino.binSize', { size: model.weightsSize });
    heading.append(
        element('div', 'omni-openvino__eyebrow', 'OpenVINO IR'),
        element('h1', undefined, fileName),
        element('div', 'omni-openvino__subtitle', `${model.name || t('openvino.unnamed')} · ${t('openvino.irVersion', { version: model.irVersion || '?' })} · ${model.fileSize} · ${weightsLabel}`)
    );
    header.append(heading);

    const summary = element('section', 'omni-openvino__summary');
    for (const item of model.summary) {
        const card = element('div', 'omni-openvino__summary-item');
        card.append(element('div', 'omni-openvino__summary-value', String(item.value)), element('div', 'omni-openvino__summary-label', t(item.labelKey)));
        summary.append(card);
    }

    const toolbar = element('div', 'omni-openvino__toolbar');
    const search = element('input', 'omni-openvino__search') as HTMLInputElement;
    search.type = 'search';
    search.placeholder = t('openvino.search');
    search.setAttribute('aria-label', t('openvino.search'));
    const tabs = element('div', 'omni-openvino__tabs');
    const copy = element('button', undefined, t('openvino.copyJson')) as HTMLButtonElement;
    copy.type = 'button';
    if (!ctx.clipboard) { copy.disabled = true; copy.title = t('common.noClipboard'); }
    toolbar.append(search, tabs, copy);

    const warnings = element('section', 'omni-openvino__warnings');
    warnings.setAttribute('role', 'status');
    for (const warning of model.warnings) warnings.append(element('div', undefined, t(warning.key, warning.args)));
    warnings.hidden = model.warnings.length === 0;
    const content = element('main', 'omni-openvino__content');
    frame.append(header, summary, toolbar, warnings, content);
    root.append(frame);

    const tabItems: Array<[TabId, string]> = [
        ['graph', t('openvino.graph')], ['layers', t('openvino.layers')],
        ['constants', t('openvino.constants')], ['io', t('openvino.io')],
        ['model', t('openvino.modelInfo')]
    ];
    let activeTab: TabId = 'graph';
    let selectedLayer: OpenVinoLayer | undefined = model.layers.find(layer => layer.type !== 'Const') ?? model.layers[0];
    let disposed = false;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    const layersById = new Map<string, OpenVinoLayer>();
    for (const layer of model.layers) if (!layersById.has(layer.id)) layersById.set(layer.id, layer);
    const incoming = new Map<string, Array<{ layer: OpenVinoLayer; fromPort: string; toPort: string }>>();
    const outgoing = new Map<string, Array<{ layer: OpenVinoLayer; fromPort: string; toPort: string }>>();
    for (const edge of model.edges) {
        const from = layersById.get(edge.fromLayer);
        const to = layersById.get(edge.toLayer);
        if (!from || !to) continue;
        push(incoming, to.id, { layer: from, fromPort: edge.fromPort, toPort: edge.toPort });
        push(outgoing, from.id, { layer: to, fromPort: edge.fromPort, toPort: edge.toPort });
    }
    const graphSearchLayers = new WeakMap<HTMLElement, OpenVinoLayer>();
    const disposers: Array<() => void> = [];
    const on = (target: EventTarget, type: string, listener: EventListener): void => {
        target.addEventListener(type, listener);
        disposers.push(() => target.removeEventListener(type, listener));
    };

    const renderTabs = (): void => {
        tabs.replaceChildren();
        for (const [id, label] of tabItems) {
            const button = element('button', undefined, label);
            button.type = 'button';
            button.setAttribute('aria-pressed', String(activeTab === id));
            button.onclick = () => { activeTab = id; renderTabs(); renderContent(); };
            tabs.append(button);
        }
    };

    const renderContent = (): void => {
        content.replaceChildren();
        if (activeTab === 'graph') renderGraph();
        else if (activeTab === 'layers') renderLayerTable();
        else if (activeTab === 'constants') renderConstantTable();
        else if (activeTab === 'io') renderIoTable();
        else renderModelInfo();
    };

    const query = (): string => search.value.trim().toLowerCase();
    const queryMatches = (values: unknown[]): boolean => {
        const q = query();
        return !q || values.some(value => String(value).toLowerCase().includes(q));
    };

    const producerPort = (layer: OpenVinoLayer, port: OpenVinoPort | undefined): OpenVinoPort | undefined => {
        if (!port) return undefined;
        const source = (incoming.get(layer.id) ?? []).find(item => item.toPort === port.id);
        return source?.layer.outputs.find(item => item.id === source.fromPort);
    };
    const portSummary = (port: OpenVinoPort): string => `${port.precision || '?'}[${port.dims.join('×') || t('openvino.scalar')}]`;
    const portList = (ports: OpenVinoPort[]): string => previewItems(ports, port => `${port.id}: ${portSummary(port)}`);
    const layerKind = (layer: OpenVinoLayer): CardKind =>
        model.inputs.includes(layer) ? 'input' : layer.type === 'Result' ? 'output' : layer.type === 'Const' ? 'const' : 'node';

    const renderLayerTable = (): void => {
        const q = query();
        const result = collectRows(model.layers, layer => !q || layerMatchesSearch(layer, q),
            layer => [layer.id, layer.name || '—', layer.bodies.length ? `${layer.type || t('openvino.unknown')} (${previewItems(layer.bodies, body => `${body.kind}: ${body.layers.length}`, 8)})` : layer.type || t('openvino.unknown'), layer.version || '—', portList(layer.inputs), portList(layer.outputs), metadataPreview(layer.attributes), metadataPreview(layer.rtInfo)]);
        renderTable(
            t('openvino.layers'),
            ['openvino.column.id', 'openvino.column.name', 'openvino.column.type', 'openvino.column.version', 'openvino.column.inputs', 'openvino.column.outputs', 'openvino.column.attributes', 'openvino.column.rtInfo'].map(key => t(key)),
            result.rows,
            result.total
        );
    };

    const renderConstantTable = (): void => {
        const q = query();
        const result = collectRows(model.constants, constant => !q || constantMatchesSearch(constant, q),
            constant => [constant.layerId, constant.layerName || '—', constant.kind, constant.elementType || '?', constant.shape.join(' × ') || t('openvino.scalar'), constant.elementCount, constant.offset, formatFileSize(constant.size), t(`openvino.status.${constant.status}`), constant.preview.join(', ') || '—']);
        renderTable(
            t('openvino.constants'),
            ['openvino.column.id', 'openvino.column.name', 'openvino.column.kind', 'openvino.column.type', 'openvino.column.shape', 'openvino.column.elements', 'openvino.column.offset', 'openvino.column.dataSize', 'openvino.column.status', 'openvino.column.preview'].map(key => t(key)),
            result.rows,
            result.total
        );
    };

    const renderIoTable = (): void => {
        const records: Array<Array<string | number>> = [];
        let total = 0;
        const append = (kind: string, layers: OpenVinoLayer[], side: 'inputs' | 'outputs'): void => {
            for (const layer of layers) {
                const port = layer[side][0];
                // A Result names the model output itself (IR v11 output_names);
                // otherwise tensor names live on the producing output port.
                const names = side === 'outputs' ? port?.names ?? [] : layer.outputNames.length ? layer.outputNames : producerPort(layer, port)?.names ?? [];
                const row = [kind, layer.id, layer.name || '—', names.join(', ') || '—', port ? portSummary(port) : '—', metadataPreview(layer.attributes)];
                if (!queryMatches(row)) continue;
                total++;
                if (records.length < MAX_TABLE_ROWS) records.push(row);
            }
        };
        append(t('openvino.kind.input'), model.inputs, 'outputs');
        append(t('openvino.kind.output'), model.outputs, 'inputs');
        renderTable(t('openvino.io'), ['openvino.column.kind', 'openvino.column.id', 'openvino.column.name', 'openvino.column.tensorNames', 'openvino.column.typeShape', 'openvino.column.attributes'].map(key => t(key)), records, total);
    };

    const renderModelInfo = (): void => {
        const rows: Array<[string, string]> = [
            [t('openvino.info.name'), model.name || '—'],
            [t('openvino.info.irVersion'), model.irVersion || '—'],
            [t('openvino.info.opsets'), model.opsets.join(', ') || '—'],
            [t('openvino.info.xmlSize'), model.fileSize],
            [t('openvino.info.binSize'), model.weightsSize ?? t('openvino.noBin')],
            [t('openvino.info.referencedBytes'), formatFileSize(model.referencedBytes)],
            [t('openvino.info.layers'), String(model.layers.length)],
            [t('openvino.info.edges'), String(model.edges.length)]
        ];
        for (const operator of model.operators) rows.push([`${t('openvino.info.operator')}: ${operator.type || t('openvino.unknown')}${operator.version ? ` (${operator.version})` : ''}`, String(operator.count)]);
        for (const item of model.metadata) rows.push([item.key, item.value]);
        const visible: Array<[string, string]> = [];
        let total = 0;
        for (const row of rows) {
            if (!queryMatches(row)) continue;
            total++;
            if (visible.length < MAX_TABLE_ROWS) visible.push(row);
        }
        const panel = element('div', 'omni-openvino__panel-header');
        panel.append(element('h2', undefined, t('openvino.modelInfo')), element('span', undefined, t('openvino.rows', { shown: visible.length, total })));
        const dl = element('dl', 'omni-openvino__model-info');
        for (const [key, value] of visible) dl.append(element('dt', undefined, key), element('dd', undefined, value));
        content.append(panel, dl);
    };

    const renderTable = (title: string, headers: string[], rows: Array<Array<string | number>>, total: number): void => {
        const visible = rows.slice(0, MAX_TABLE_ROWS);
        const panel = element('div', 'omni-openvino__panel-header');
        panel.append(element('h2', undefined, title), element('span', undefined, t('openvino.rows', { shown: visible.length, total })));
        const wrap = element('div', 'omni-openvino__table-wrap');
        const table = element('table');
        const head = element('thead');
        const tr = element('tr');
        for (const label of headers) tr.append(element('th', undefined, label));
        head.append(tr);
        const body = element('tbody');
        for (const row of visible) {
            const rowElement = element('tr');
            for (const cell of row) { const td = element('td', undefined, String(cell)); td.title = String(cell); rowElement.append(td); }
            body.append(rowElement);
        }
        table.append(head, body);
        wrap.append(table);
        content.append(panel, wrap);
        if (rows.length === 0) content.append(element('div', 'omni-openvino__empty', t('openvino.noMatches')));
    };

    const renderGraph = (): void => {
        const layout = element('div', 'omni-openvino__graph-layout');
        const scroll = element('div', 'omni-openvino__graph-scroll');
        const inspector = element('aside', 'omni-openvino__inspector');
        const shown = model.layers.slice(0, MAX_GRAPH_NODES);
        const shownIds = new Set(shown.map(layer => layer.id));
        const positions = graphPositions(shown, incoming);
        const maxDepth = Math.max(0, ...positions.map(item => item.depth));
        const rankIndex = new Map<number, number>();
        const cardPositions = new Map<string, { x: number; y: number }>();
        for (const item of positions) {
            const index = rankIndex.get(item.depth) ?? 0;
            rankIndex.set(item.depth, index + 1);
            cardPositions.set(item.layer.id, { x: 20 + item.depth * COLUMN_GAP, y: 20 + index * ROW_GAP });
        }
        const width = Math.max(720, (maxDepth + 1) * COLUMN_GAP + 40);
        const height = Math.max(420, Math.max(1, ...rankIndex.values()) * ROW_GAP + 40);
        const canvas = element('div', 'omni-openvino__canvas');
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'omni-openvino__edges'); svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));

        let edgeCount = 0;
        let edgesOmitted = false;
        for (const edge of model.edges) {
            if (!shownIds.has(edge.fromLayer) || !shownIds.has(edge.toLayer)) continue;
            const source = cardPositions.get(edge.fromLayer);
            const target = cardPositions.get(edge.toLayer);
            if (!source || !target) continue;
            if (edgeCount >= MAX_GRAPH_EDGES) { edgesOmitted = true; break; }
            const toResult = layersById.get(edge.toLayer)?.type === 'Result';
            svg.append(graphEdge(source.x + CARD_WIDTH, source.y + 27, target.x, target.y + 27, toResult));
            edgeCount++;
        }
        canvas.append(svg);

        for (const item of positions) {
            const layer = item.layer;
            const position = cardPositions.get(layer.id)!;
            const kind = layerKind(layer);
            const button = element('button', `omni-openvino__node omni-openvino__node--${kind}`) as HTMLButtonElement;
            button.type = 'button'; button.style.left = `${position.x}px`; button.style.top = `${position.y}px`;
            graphSearchLayers.set(button, layer);
            const detail = layer.type === 'Const' && layer.constants[0]
                ? `${layer.constants[0].elementType}[${layer.constants[0].shape.join('×')}]`
                : layer.outputs[0] ? `${layer.type || t('openvino.unknown')} · ${portSummary(layer.outputs[0])}` : layer.type || t('openvino.unknown');
            button.append(element('strong', undefined, layer.name || layer.type || t('openvino.unknown')), element('small', undefined, detail));
            button.onclick = () => {
                selectedLayer = layer;
                renderInspector(inspector);
                canvas.querySelectorAll('.omni-openvino__node--selected').forEach(item => item.classList.remove('omni-openvino__node--selected'));
                button.classList.add('omni-openvino__node--selected');
            };
            if (layer === selectedLayer) button.classList.add('omni-openvino__node--selected');
            canvas.append(button);
        }
        if (model.layers.length > shown.length) scroll.append(element('div', 'omni-openvino__graph-limit', t('openvino.graphLimited', { shown: shown.length, total: model.layers.length })));
        if (edgesOmitted) scroll.append(element('div', 'omni-openvino__graph-limit', t('openvino.graphEdgesLimited', { count: MAX_GRAPH_EDGES })));
        scroll.append(canvas);
        renderInspector(inspector);
        layout.append(scroll, inspector);
        content.append(layout);
        applyGraphSearch(canvas);
    };

    const renderInspector = (inspector: HTMLElement): void => {
        inspector.replaceChildren();
        const layer = selectedLayer;
        if (!layer) { inspector.append(element('div', 'omni-openvino__empty', t('openvino.selectLayer'))); return; }
        inspector.append(
            element('div', 'omni-openvino__inspector-kind', `${layer.type || t('openvino.unknown')}${layer.version ? ` · ${layer.version}` : ''}`),
            element('h2', undefined, layer.name || layer.type || t('openvino.unknown')),
            element('div', undefined, `${t('openvino.column.id')} ${layer.id}`)
        );
        const sources = incoming.get(layer.id) ?? [];
        const sinks = outgoing.get(layer.id) ?? [];
        appendChips(inspector, t('openvino.inspector.inputs'), layer.inputs.map(port => {
            const source = sources.find(item => item.toPort === port.id);
            return `${port.id}: ${portSummary(port)}${source ? ` ← ${source.layer.name || source.layer.type}:${source.fromPort}` : ''}`;
        }));
        appendChips(inspector, t('openvino.inspector.outputs'), layer.outputs.map(port => {
            const targets = sinks.filter(item => item.fromPort === port.id).map(item => item.layer.name || item.layer.type);
            const names = port.names.length ? ` (${port.names.join(', ')})` : '';
            return `${port.id}: ${portSummary(port)}${names}${targets.length ? ` → ${previewList(targets, 6)}` : ''}`;
        }));
        if (layer.attributes.length) {
            inspector.append(element('h3', undefined, t('openvino.inspector.attributes')));
            for (const attribute of layer.attributes.slice(0, MAX_INSPECTOR_ITEMS)) {
                const row = element('div', 'omni-openvino__attribute');
                row.append(element('b', undefined, attribute.key), element('div', undefined, attribute.value || '—'));
                inspector.append(row);
            }
            if (layer.attributes.length > MAX_INSPECTOR_ITEMS) inspector.append(element('div', 'omni-openvino__attribute', t('openvino.moreItems', { count: layer.attributes.length - MAX_INSPECTOR_ITEMS })));
        }
        for (const constant of layer.constants) {
            inspector.append(element('h3', undefined, constant.kind === 'data' ? t('openvino.inspector.weights') : `${t('openvino.inspector.weights')} · ${constant.kind}`));
            const chips = element('div', 'omni-openvino__chips');
            chips.append(
                element('span', 'omni-openvino__chip', `${constant.elementType || '?'}[${constant.shape.join(' × ') || t('openvino.scalar')}]`),
                element('span', 'omni-openvino__chip', t('openvino.inspector.range', { offset: constant.offset, size: formatFileSize(constant.size) })),
                element('span', 'omni-openvino__chip', t(`openvino.status.${constant.status}`))
            );
            inspector.append(chips);
            if (constant.preview.length) {
                const values = element('div', 'omni-openvino__attribute');
                values.append(element('b', undefined, t('openvino.inspector.preview', { count: constant.preview.length })), element('div', undefined, constant.preview.join(', ')));
                inspector.append(values);
            }
        }
        if (layer.bodies.length) {
            inspector.append(element('h3', undefined, t('openvino.inspector.bodies')));
            for (const body of layer.bodies.slice(0, MAX_INSPECTOR_ITEMS)) {
                const row = element('div', 'omni-openvino__attribute');
                row.append(element('b', undefined, t('openvino.inspector.body', { kind: body.kind, layers: body.layers.length, edges: body.edges.length })));
                const chips = element('div', 'omni-openvino__chips');
                for (const inner of body.layers.slice(0, MAX_INSPECTOR_ITEMS)) { const chip = element('span', 'omni-openvino__chip', `${inner.name || inner.type} · ${inner.type}`); chip.title = inner.name; chips.append(chip); }
                if (body.layers.length > MAX_INSPECTOR_ITEMS) chips.append(element('span', 'omni-openvino__chip', t('openvino.moreItems', { count: body.layers.length - MAX_INSPECTOR_ITEMS })));
                row.append(chips);
                inspector.append(row);
            }
            if (layer.bodies.length > MAX_INSPECTOR_ITEMS) inspector.append(element('div', 'omni-openvino__attribute', t('openvino.moreItems', { count: layer.bodies.length - MAX_INSPECTOR_ITEMS })));
        }
        const portRtInfo = (ports: OpenVinoPort[], label: string): OpenVinoMetadata[] =>
            ports.flatMap(port => port.rtInfo.map(item => ({ key: `${label} ${port.id} · ${item.key}`, value: item.value })));
        const rtInfo = [...layer.rtInfo, ...portRtInfo(layer.inputs, t('openvino.inspector.inputPort')), ...portRtInfo(layer.outputs, t('openvino.inspector.outputPort'))];
        if (rtInfo.length) {
            inspector.append(element('h3', undefined, t('openvino.column.rtInfo')));
            const chips = element('div', 'omni-openvino__chips');
            for (const item of rtInfo.slice(0, MAX_INSPECTOR_ITEMS)) { const chip = element('span', 'omni-openvino__chip', `${item.key}=${item.value}`); chip.title = `${item.key}=${item.value}`; chips.append(chip); }
            if (rtInfo.length > MAX_INSPECTOR_ITEMS) chips.append(element('span', 'omni-openvino__chip', t('openvino.moreItems', { count: rtInfo.length - MAX_INSPECTOR_ITEMS })));
            inspector.append(chips);
        }
    };

    const appendChips = (parent: HTMLElement, label: string, values: string[]): void => {
        parent.append(element('h3', undefined, label));
        const chips = element('div', 'omni-openvino__chips');
        if (values.length === 0) chips.append(element('span', 'omni-openvino__chip', '—'));
        for (const value of values.slice(0, MAX_INSPECTOR_ITEMS)) { const chip = element('span', 'omni-openvino__chip', value); chip.title = value; chips.append(chip); }
        if (values.length > MAX_INSPECTOR_ITEMS) chips.append(element('span', 'omni-openvino__chip', t('openvino.moreItems', { count: values.length - MAX_INSPECTOR_ITEMS })));
        parent.append(chips);
    };

    const applyGraphSearch = (canvas: HTMLElement): void => {
        const q = query();
        canvas.querySelectorAll<HTMLElement>('.omni-openvino__node').forEach(card => {
            const layer = graphSearchLayers.get(card);
            const matches = layer ? layerMatchesSearch(layer, q) : false;
            card.classList.toggle('omni-openvino__node--dim', Boolean(q) && !matches);
        });
    };

    on(search, 'input', () => {
        if (activeTab === 'graph') { const canvas = content.querySelector<HTMLElement>('.omni-openvino__canvas'); if (canvas) applyGraphSearch(canvas); }
        else renderContent();
    });
    on(copy, 'click', () => {
        if (!ctx.clipboard) return;
        void ctx.clipboard.writeText(JSON.stringify(model, null, 2)).then(() => {
            if (disposed) return;
            copy.textContent = t('common.copied');
            if (resetTimer !== undefined) clearTimeout(resetTimer);
            resetTimer = setTimeout(() => { if (!disposed) copy.textContent = t('openvino.copyJson'); }, 1200);
        }).catch(error => ctx.logger.log('error', `OpenVINO copy failed: ${error instanceof Error ? error.message : String(error)}`));
    });
    renderTabs();
    renderContent();

    return {
        dispose(): void {
            disposed = true;
            if (resetTimer !== undefined) clearTimeout(resetTimer);
            disposers.splice(0).forEach(dispose => dispose());
            frame.remove(); style?.remove();
            if (!(root instanceof ShadowRoot)) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--openvino');
        }
    };
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
    const list = map.get(key);
    if (list) list.push(value); else map.set(key, [value]);
}

/** Column = longest incoming path, walking layers in file order (an IR lists
 *  layers topologically, so a producer precedes its consumers). */
function graphPositions(
    layers: OpenVinoLayer[],
    incoming: Map<string, Array<{ layer: OpenVinoLayer }>>
): Array<{ layer: OpenVinoLayer; depth: number }> {
    const depths = new Map<string, number>();
    return layers.map(layer => {
        let depth = 0;
        for (const source of incoming.get(layer.id) ?? []) {
            const sourceDepth = depths.get(source.layer.id);
            if (sourceDepth !== undefined) depth = Math.max(depth, sourceDepth + 1);
        }
        depths.set(layer.id, depth);
        return { layer, depth };
    });
}

function collectRows<T>(
    items: T[],
    matches: (item: T) => boolean,
    toRow: (item: T, index: number) => Array<string | number>
): { rows: Array<Array<string | number>>; total: number } {
    const rows: Array<Array<string | number>> = [];
    let total = 0;
    items.forEach((item, index) => {
        if (!matches(item)) return;
        total++;
        if (rows.length < MAX_TABLE_ROWS) rows.push(toRow(item, index));
    });
    return { rows, total };
}

function previewList(items: string[], limit = 20): string {
    return previewItems(items, item => item, limit);
}

function previewItems<T>(items: T[], format: (item: T) => string, limit = 20): string {
    const visible = items.slice(0, limit).map(format).join(', ');
    return items.length > limit ? `${visible}, … (+${items.length - limit})` : visible;
}

function metadataPreview(metadata: OpenVinoMetadata[]): string {
    return previewItems(metadata, item => `${item.key}=${item.value}`);
}

function textMatches(query: string, ...values: Array<string | number>): boolean {
    return values.some(value => String(value).toLowerCase().includes(query));
}

function metadataMatches(metadata: OpenVinoMetadata[], query: string): boolean {
    return metadata.some(item => textMatches(query, item.key, item.value));
}

function portMatches(port: OpenVinoPort, query: string): boolean {
    return textMatches(query, port.id, port.precision, ...port.names, ...port.dims) || metadataMatches(port.rtInfo, query);
}

function constantMatchesSearch(constant: OpenVinoConstant, query: string): boolean {
    return textMatches(query, constant.layerId, constant.layerName, constant.kind, constant.elementType, constant.offset, constant.size, constant.status, ...constant.shape, ...constant.preview);
}

function layerMatchesSearch(layer: OpenVinoLayer, query: string, depth = 0): boolean {
    return !query || textMatches(query, layer.id, layer.name, layer.type, layer.version, ...layer.outputNames) ||
        metadataMatches(layer.attributes, query) || metadataMatches(layer.rtInfo, query) ||
        layer.inputs.some(port => portMatches(port, query)) || layer.outputs.some(port => portMatches(port, query)) ||
        layer.constants.some(constant => constantMatchesSearch(constant, query)) ||
        (depth < 8 && layer.bodies.some(body => body.layers.some(inner => layerMatchesSearch(inner, query, depth + 1))));
}

function graphEdge(x1: number, y1: number, x2: number, y2: number, output: boolean): SVGPathElement {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const bend = Math.max(28, (x2 - x1) / 2);
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    path.setAttribute('class', `omni-openvino__edge${output ? ' omni-openvino__edge--output' : ''}`);
    return path;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
