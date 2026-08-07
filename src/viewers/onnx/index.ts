import type { ClipboardService, HostContext } from '../../host/index.js';
import { parseOnnx, type OnnxAttribute, type OnnxDocument, type OnnxMetadata, type OnnxNode } from '../../parsers/onnx/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { onnxViewerCss } from './styles.js';

export { onnxViewerCss } from './styles.js';

export const ONNX_VIEWER_META = {
    id: 'onnx',
    displayNameKey: 'onnx.title',
    extensions: ['onnx'],
    priority: 20,
    requiredServices: [] as const,
    optionalServices: ['clipboard'] as const,
    inputOwnership: 'borrows' as const
};

export type OnnxViewerContext = HostContext & { clipboard?: ClipboardService };

export async function mountOnnxViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: OnnxViewerContext,
    options: MountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const model = parseOnnx(input.data);
    if (options.signal?.aborted) throw new MountAbortedError();
    return mountOnnxDocument(model, input.fileName, container, ctx, options);
}

type TabId = 'graph' | 'nodes' | 'tensors' | 'io' | 'model';
const MAX_GRAPH_NODES = 240;
const MAX_GRAPH_CARDS = 400;
const MAX_GRAPH_OUTPUT_CARDS = 64;
const MAX_GRAPH_EDGES = 800;
const MAX_NODE_PORTS = 64;
const MAX_TABLE_ROWS = 2000;
const MAX_INSPECTOR_ITEMS = 64;

export function mountOnnxDocument(
    model: OnnxDocument,
    fileName: string,
    container: HTMLElement,
    ctx: OnnxViewerContext,
    options: MountOptions = {}
): ViewerHandle {
    if (options.signal?.aborted) throw new MountAbortedError();
    let root: HTMLElement | ShadowRoot = container;
    let style: HTMLStyleElement | undefined;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && container.attachShadow) {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        style = element('style');
        style.textContent = onnxViewerCss;
        root.append(style);
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--onnx');
    }

    const frame = element('div', 'omni-onnx');
    const header = element('header', 'omni-onnx__header');
    const heading = element('div');
    heading.append(
        element('div', 'omni-onnx__eyebrow', 'ONNX'),
        element('h1', undefined, fileName),
        element('div', 'omni-onnx__subtitle', `${model.title || ctx.i18n.t('onnx.title')} · ${model.fileSize} · ${model.producer || ctx.i18n.t('onnx.unknown')}`)
    );
    header.append(heading);

    const summary = element('section', 'omni-onnx__summary');
    for (const item of model.summary) {
        const card = element('div', 'omni-onnx__summary-item');
        card.append(element('div', 'omni-onnx__summary-value', String(item.value)), element('div', 'omni-onnx__summary-label', ctx.i18n.t(item.labelKey)));
        summary.append(card);
    }

    const toolbar = element('div', 'omni-onnx__toolbar');
    const search = element('input', 'omni-onnx__search') as HTMLInputElement;
    search.type = 'search';
    search.placeholder = ctx.i18n.t('onnx.search');
    search.setAttribute('aria-label', ctx.i18n.t('onnx.search'));
    const tabs = element('div', 'omni-onnx__tabs');
    const copy = element('button', undefined, ctx.i18n.t('onnx.copyJson')) as HTMLButtonElement;
    copy.type = 'button';
    if (!ctx.clipboard) { copy.disabled = true; copy.title = ctx.i18n.t('common.noClipboard'); }
    toolbar.append(search, tabs, copy);

    const warnings = element('section', 'omni-onnx__warnings');
    warnings.setAttribute('role', 'status');
    for (const warning of model.warnings) warnings.append(element('div', undefined, ctx.i18n.t(warning.key, warning.args)));
    warnings.hidden = model.warnings.length === 0;
    const content = element('main', 'omni-onnx__content');
    frame.append(header, summary, toolbar, warnings, content);
    root.append(frame);

    const tabItems: Array<[TabId, string]> = [
        ['graph', ctx.i18n.t('onnx.graph')], ['nodes', ctx.i18n.t('onnx.nodes')],
        ['tensors', ctx.i18n.t('onnx.tensors')], ['io', ctx.i18n.t('onnx.io')],
        ['model', ctx.i18n.t('onnx.modelInfo')]
    ];
    let activeTab: TabId = 'graph';
    let selectedNode = model.graph.nodes[0];
    let disposed = false;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    const graphSearchNodes = new WeakMap<HTMLElement, OnnxNode>();
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
        else if (activeTab === 'nodes') renderNodeTable();
        else if (activeTab === 'tensors') renderTensorTable();
        else if (activeTab === 'io') renderIoTable();
        else renderModelInfo();
    };

    const queryMatches = (values: unknown[]): boolean => {
        const query = search.value.trim().toLowerCase();
        return !query || values.some(value => String(value).toLowerCase().includes(query));
    };

    const renderNodeTable = (): void => {
        const query = search.value.trim().toLowerCase();
        const result = collectRows(model.graph.nodes, node => !query || nodeMatchesSearch(node, query),
        (node, index) => [index + 1, node.name || '—', node.operator || ctx.i18n.t('onnx.unknown'), node.domain || 'ai.onnx', node.overload || '—', previewList(node.inputs), previewList(node.outputs), previewItems(node.attributes, item => `${item.name}=${displayAttributeValue(item)}`), metadataPreview(node.metadata)]);
        renderTable(
            ctx.i18n.t('onnx.nodes'),
            ['onnx.column.index', 'onnx.column.name', 'onnx.column.operator', 'onnx.column.domain', 'onnx.column.overload', 'onnx.column.inputs', 'onnx.column.outputs', 'onnx.column.attributes', 'onnx.column.metadata'].map(key => ctx.i18n.t(key)),
            result.rows,
            result.total
        );
    };

    const renderTensorTable = (): void => {
        const query = search.value.trim().toLowerCase();
        const result = collectRows(model.graph.initializers, tensor => {
            const storage = ctx.i18n.t(`onnx.storage.${tensor.storage}.${tensor.location}`);
            return !query || [tensor.name, tensor.dataType, tensor.elementCount, formatByteCount(tensor.dataBytes), storage]
                .some(value => value.toLowerCase().includes(query)) || tensor.shape.some(value => value.toLowerCase().includes(query)) ||
                tensor.externalData.some(item => `${item.key} ${item.value}`.toLowerCase().includes(query)) ||
                tensor.metadata.some(item => `${item.key} ${item.value}`.toLowerCase().includes(query));
        },
        tensor => [tensor.name, tensor.dataType, tensor.shape.join(' × ') || ctx.i18n.t('onnx.scalar'), tensor.elementCount, formatByteCount(tensor.dataBytes), ctx.i18n.t(`onnx.storage.${tensor.storage}.${tensor.location}`), metadataPreview(tensor.metadata)]);
        renderTable(
            ctx.i18n.t('onnx.tensors'),
            ['onnx.column.name', 'onnx.column.type', 'onnx.column.shape', 'onnx.column.elements', 'onnx.column.dataSize', 'onnx.column.storage', 'onnx.column.metadata'].map(key => ctx.i18n.t(key)),
            result.rows,
            result.total
        );
    };

    const renderIoTable = (): void => {
        const records: Array<Array<string | number>> = [];
        let total = 0;
        const append = (kind: string, values: typeof model.graph.inputs): void => {
            for (const value of values) {
                const row = [kind, value.name, value.type, value.description, metadataPreview(value.metadata)];
                if (!queryMatches(row)) continue;
                total++;
                if (records.length < MAX_TABLE_ROWS) records.push(row);
            }
        };
        append(ctx.i18n.t('onnx.kind.input'), model.graph.inputs);
        append(ctx.i18n.t('onnx.kind.output'), model.graph.outputs);
        append(ctx.i18n.t('onnx.kind.value'), model.graph.values);
        renderTable(ctx.i18n.t('onnx.io'), ['onnx.column.kind', 'onnx.column.name', 'onnx.column.typeShape', 'onnx.column.description', 'onnx.column.metadata'].map(key => ctx.i18n.t(key)), records, total);
    };

    const renderModelInfo = (): void => {
        const baseInfo: Array<[string, string]> = [
            [ctx.i18n.t('onnx.info.graph'), model.graph.name || '—'], [ctx.i18n.t('onnx.info.irVersion'), model.irVersion], [ctx.i18n.t('onnx.info.modelVersion'), model.modelVersion],
            [ctx.i18n.t('onnx.info.producer'), model.producer || ctx.i18n.t('onnx.unknown')], [ctx.i18n.t('onnx.info.domain'), model.domain || '—'],
            [ctx.i18n.t('onnx.info.opsets'), model.opsets.map(item => `${item.domain} v${item.version}`).join(', ') || '—'],
            [ctx.i18n.t('onnx.info.description'), model.description || model.graph.description || '—'],
            [ctx.i18n.t('onnx.info.functions'), previewItems(model.functions, item => `${item.domain || 'ai.onnx'}::${item.name}${item.overload ? `#${item.overload}` : ''} (${item.nodes.length})`, 100) || '—'],
            [ctx.i18n.t('onnx.info.training'), String(model.trainingInfo.length)],
            [ctx.i18n.t('onnx.info.configurations'), previewItems(model.configurations, item => `${item.name} (${item.numDevices})`, 100) || '—'],
            [ctx.i18n.t('onnx.info.quantization'), String(model.graph.quantization.length)]
        ];
        const visible: Array<[string, string]> = [];
        let total = 0;
        const append = (row: [string, string]): void => {
            if (!queryMatches(row)) return;
            total++;
            if (visible.length < MAX_TABLE_ROWS) visible.push(row);
        };
        baseInfo.forEach(append);
        for (const item of model.functions) append([
            `${item.domain || 'ai.onnx'}::${item.name}${item.overload ? `#${item.overload}` : ''}`,
            `${previewList(item.inputs)} → ${previewList(item.outputs)} · ${previewItems(item.values, value => `${value.name}: ${value.type}`)}${item.description ? ` · ${item.description}` : ''}${item.metadata.length ? ` · ${metadataPreview(item.metadata)}` : ''}`
        ]);
        for (const item of model.configurations) append([
            item.name || ctx.i18n.t('onnx.unknown'),
            `${item.numDevices} · ${previewList(item.devices, 100)}`
        ]);
        for (const item of model.metadata) append([item.key, item.value]);
        for (const item of model.graph.metadata) append([`${ctx.i18n.t('onnx.info.graphMetadata')}: ${item.key}`, item.value]);
        const panel = element('div', 'omni-onnx__panel-header');
        panel.append(element('h2', undefined, ctx.i18n.t('onnx.modelInfo')), element('span', undefined, ctx.i18n.t('onnx.rows', { shown: visible.length, total })));
        const dl = element('dl', 'omni-onnx__model-info');
        for (const [key, value] of visible) dl.append(element('dt', undefined, key), element('dd', undefined, value));
        content.append(panel, dl);
    };

    const renderTable = (title: string, headers: string[], rows: Array<Array<string | number>>, total: number): void => {
        const visible = rows.slice(0, MAX_TABLE_ROWS);
        const panel = element('div', 'omni-onnx__panel-header');
        panel.append(element('h2', undefined, title), element('span', undefined, ctx.i18n.t('onnx.rows', { shown: visible.length, total })));
        const wrap = element('div', 'omni-onnx__table-wrap');
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
        if (rows.length === 0) content.append(element('div', 'omni-onnx__empty', ctx.i18n.t('onnx.noMatches')));
    };

    const renderGraph = (): void => {
        const layout = element('div', 'omni-onnx__graph-layout');
        const scroll = element('div', 'omni-onnx__graph-scroll');
        const inspector = element('aside', 'omni-onnx__inspector');
        const shownNodes = model.graph.nodes.slice(0, MAX_GRAPH_NODES);
        const positions = graphPositions(shownNodes);
        const maxDepth = Math.max(0, ...positions.map(item => item.depth));
        const ranks = new Map<number, number>();
        for (const item of positions) ranks.set(item.depth, (ranks.get(item.depth) ?? 0) + 1);
        const initializerNames = new Set(model.graph.initializers.map(tensor => tensor.name));
        const inputValues = model.graph.inputs.filter(value => !initializerNames.has(value.name));
        const usedInputs = new Set<string>();
        for (const node of shownNodes) for (const input of node.inputs) if (input) usedInputs.add(input);
        const remainingAfterNodes = Math.max(0, MAX_GRAPH_CARDS - shownNodes.length);
        const shownOutputs = model.graph.outputs.slice(0, Math.min(MAX_GRAPH_OUTPUT_CARDS, remainingAfterNodes));
        const sourceBudget = Math.max(0, remainingAfterNodes - shownOutputs.length);
        const shownSources: Array<{ id: string; name: string; detail: string; kind: 'input' | 'initializer' }> = [];
        const collectSources = (used: boolean): void => {
            for (const value of inputValues) {
                if (shownSources.length >= sourceBudget) return;
                if (usedInputs.has(value.name) === used) shownSources.push({ id: `input:${value.name}`, name: value.name, detail: value.type, kind: 'input' });
            }
            for (const tensor of model.graph.initializers) {
                if (shownSources.length >= sourceBudget) return;
                if (usedInputs.has(tensor.name) === used) shownSources.push({
                    id: `initializer:${tensor.name}`, name: tensor.name,
                    detail: `${tensor.dataType}[${tensor.shape.join(' × ')}]`, kind: 'initializer'
                });
            }
        };
        collectSources(true);
        collectSources(false);
        const totalCards = model.graph.nodes.length + inputValues.length + model.graph.initializers.length + model.graph.outputs.length;
        const shownCards = shownNodes.length + shownSources.length + shownOutputs.length;
        const width = Math.max(720, (maxDepth + 3) * 220);
        const height = Math.max(420, Math.max(...ranks.values(), shownSources.length, shownOutputs.length, 1) * 86 + 40);
        const canvas = element('div', 'omni-onnx__canvas');
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'omni-onnx__edges'); svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
        const cardPositions = new Map<string, { x: number; y: number }>();
        const producer = new Map<string, string>();
        const sourceByValue = new Map<string, string>();

        shownSources.forEach((source, index) => {
            cardPositions.set(source.id, { x: 20, y: 20 + index * 86 });
            sourceByValue.set(source.name, source.id);
        });
        const rankIndex = new Map<number, number>();
        positions.forEach(item => {
            const index = rankIndex.get(item.depth) ?? 0;
            rankIndex.set(item.depth, index + 1);
            cardPositions.set(item.node.id, { x: 220 + item.depth * 220, y: 20 + index * 86 });
            item.node.outputs.forEach(output => { if (output) producer.set(output, item.node.id); });
        });
        shownOutputs.forEach((value, index) => cardPositions.set(`output:${value.name}`, { x: (maxDepth + 2) * 220, y: 20 + index * 86 }));

        let edgeCount = 0;
        let edgesOmitted = false;
        for (const item of positions) {
            const target = cardPositions.get(item.node.id)!;
            for (const input of item.node.inputs) {
                if (!input) continue;
                const sourceId = producer.get(input) ?? sourceByValue.get(input);
                const source = sourceId ? cardPositions.get(sourceId) : undefined;
                if (!source) continue;
                if (edgeCount < MAX_GRAPH_EDGES) { svg.append(graphEdge(source.x + 170, source.y + 27, target.x, target.y + 27, false)); edgeCount++; }
                else edgesOmitted = true;
            }
        }
        for (const output of shownOutputs) {
            const sourceId = producer.get(output.name) ?? sourceByValue.get(output.name);
            const source = sourceId ? cardPositions.get(sourceId) : undefined;
            const target = cardPositions.get(`output:${output.name}`);
            if (!source || !target) continue;
            if (edgeCount < MAX_GRAPH_EDGES) { svg.append(graphEdge(source.x + 170, source.y + 27, target.x, target.y + 27, true)); edgeCount++; }
            else edgesOmitted = true;
        }
        canvas.append(svg);

        const addCard = (id: string, title: string, detail: string, kind: 'input' | 'initializer' | 'node' | 'output', node?: OnnxNode): void => {
            const position = cardPositions.get(id);
            if (!position) return;
            const button = element('button', `omni-onnx__node omni-onnx__node--${kind}`) as HTMLButtonElement;
            button.type = 'button'; button.style.left = `${position.x}px`; button.style.top = `${position.y}px`;
            if (node) graphSearchNodes.set(button, node); else button.dataset.search = `${title} ${detail}`.toLowerCase();
            button.append(element('strong', undefined, title || '—'), element('small', undefined, detail));
            if (node) button.onclick = () => { selectedNode = node; renderInspector(inspector); canvas.querySelectorAll('.omni-onnx__node--selected').forEach(item => item.classList.remove('omni-onnx__node--selected')); button.classList.add('omni-onnx__node--selected'); };
            canvas.append(button);
        };
        shownSources.forEach(source => addCard(source.id, source.name, source.detail, source.kind));
        positions.forEach(item => addCard(item.node.id, item.node.name || item.node.operator || ctx.i18n.t('onnx.unknown'), item.node.operator || ctx.i18n.t('onnx.unknown'), 'node', item.node));
        shownOutputs.forEach(value => addCard(`output:${value.name}`, value.name, value.type, 'output'));
        if (totalCards > shownCards) scroll.append(element('div', 'omni-onnx__graph-limit', ctx.i18n.t('onnx.graphLimited', { shown: shownCards, total: totalCards })));
        if (edgesOmitted) scroll.append(element('div', 'omni-onnx__graph-limit', ctx.i18n.t('onnx.graphEdgesLimited', { count: MAX_GRAPH_EDGES })));
        scroll.append(canvas);
        renderInspector(inspector);
        layout.append(scroll, inspector);
        content.append(layout);
        applyGraphSearch(canvas);
    };

    const renderInspector = (inspector: HTMLElement): void => {
        inspector.replaceChildren();
        const node = selectedNode;
        if (!node) { inspector.append(element('div', 'omni-onnx__empty', ctx.i18n.t('onnx.selectNode'))); return; }
        inspector.append(
            element('div', 'omni-onnx__inspector-kind', node.domain || 'ai.onnx'),
            element('h2', undefined, node.name || node.operator || ctx.i18n.t('onnx.unknown')),
            element('div', undefined, `${node.operator || ctx.i18n.t('onnx.unknown')}${node.overload ? ` #${node.overload}` : ''}`)
        );
        appendChips(inspector, ctx.i18n.t('onnx.inspector.inputs'), node.inputs);
        appendChips(inspector, ctx.i18n.t('onnx.inspector.outputs'), node.outputs);
        const subgraphBudget = { remaining: 128, omitted: 0 };
        if (node.attributes.length) {
            inspector.append(element('h3', undefined, ctx.i18n.t('onnx.inspector.attributes')));
            for (const attribute of node.attributes.slice(0, MAX_INSPECTOR_ITEMS)) {
                const row = element('div', 'omni-onnx__attribute');
                row.append(element('b', undefined, `${attribute.name} · ${attribute.type}`), element('div', undefined, displayAttributeValue(attribute) || '—'));
                if (attribute.description) row.append(element('div', undefined, attribute.description));
                const tensors = [...(attribute.tensors ?? []), ...(attribute.sparseTensors ?? [])];
                for (const tensor of tensors.slice(0, 8)) {
                    const detail = element('div', 'omni-onnx__chip', `${tensor.name || ctx.i18n.t('onnx.unknown')} · ${ctx.i18n.t(`onnx.storage.${tensor.storage}.${tensor.location}`)} · ${formatByteCount(tensor.dataBytes)}`);
                    detail.title = [...tensor.externalData, ...tensor.metadata].map(item => `${item.key}=${item.value}`).join(', ');
                    row.append(detail);
                }
                const omittedTensors = (attribute.omitted?.tensors ?? 0) + (attribute.omitted?.sparseTensors ?? 0);
                if (tensors.length + omittedTensors > 8) row.append(element('div', 'omni-onnx__chip', ctx.i18n.t('onnx.moreItems', { count: tensors.length + omittedTensors - 8 })));
                for (const graph of attribute.graphs ?? []) appendSubgraph(row, graph, 0, subgraphBudget);
                subgraphBudget.omitted += attribute.omitted?.graphs ?? 0;
                inspector.append(row);
            }
            if (node.attributes.length > MAX_INSPECTOR_ITEMS) inspector.append(element('div', 'omni-onnx__attribute', ctx.i18n.t('onnx.moreItems', { count: node.attributes.length - MAX_INSPECTOR_ITEMS })));
            if (subgraphBudget.omitted > 0) inspector.append(element('div', 'omni-onnx__attribute', ctx.i18n.t('onnx.moreItems', { count: subgraphBudget.omitted })));
        }
        if (node.metadata.length) {
            inspector.append(element('h3', undefined, ctx.i18n.t('onnx.column.metadata')));
            const metadata = element('div', 'omni-onnx__chips');
            for (const item of node.metadata.slice(0, MAX_INSPECTOR_ITEMS)) metadata.append(element('span', 'omni-onnx__chip', `${item.key}=${item.value}`));
            if (node.metadata.length > MAX_INSPECTOR_ITEMS) metadata.append(element('span', 'omni-onnx__chip', ctx.i18n.t('onnx.moreItems', { count: node.metadata.length - MAX_INSPECTOR_ITEMS })));
            inspector.append(metadata);
        }
        if (node.deviceConfigurations.length) {
            inspector.append(element('h3', undefined, ctx.i18n.t('onnx.info.deviceConfiguration')));
            for (const configuration of node.deviceConfigurations.slice(0, MAX_INSPECTOR_ITEMS)) {
                inspector.append(element('div', 'omni-onnx__attribute', `${configuration.configurationId} · ${ctx.i18n.t('onnx.info.pipelineStage')} ${configuration.pipelineStage} · ${configuration.sharding.length}`));
            }
            if (node.deviceConfigurations.length > MAX_INSPECTOR_ITEMS) inspector.append(element('div', 'omni-onnx__attribute', ctx.i18n.t('onnx.moreItems', { count: node.deviceConfigurations.length - MAX_INSPECTOR_ITEMS })));
        }
        if (node.description) { inspector.append(element('h3', undefined, ctx.i18n.t('onnx.inspector.description')), element('div', undefined, node.description)); }
    };

    const displayAttributeValue = (attribute: OnnxAttribute): string => {
        if (attribute.graphs?.length) return previewItems(attribute.graphs, graph => ctx.i18n.t('onnx.graphSummary', { name: graph.name || ctx.i18n.t('onnx.unknown'), count: graph.nodes.length }), 20, attribute.omitted?.graphs);
        if (attribute.sparseTensors?.length) return previewItems(attribute.sparseTensors, tensor => ctx.i18n.t('onnx.sparseSummary', { type: tensor.dataType, shape: tensor.shape.join(' × '), count: tensor.sparse?.nonZeroCount ?? 0 }), 20, attribute.omitted?.sparseTensors);
        if (attribute.tensors?.length) return previewItems(attribute.tensors, tensor => `${tensor.dataType}[${tensor.shape.join(' × ')}]`, 20, attribute.omitted?.tensors);
        if (attribute.typeProtos?.length) return previewItems(attribute.typeProtos, type => type.display, 64, attribute.omitted?.typeProtos);
        return attribute.value;
    };

    const appendChips = (parent: HTMLElement, label: string, values: string[]): void => {
        parent.append(element('h3', undefined, label));
        const chips = element('div', 'omni-onnx__chips');
        for (const value of values.slice(0, MAX_INSPECTOR_ITEMS)) { const chip = element('span', 'omni-onnx__chip', value || ctx.i18n.t('onnx.optional')); chip.title = value; chips.append(chip); }
        if (values.length > MAX_INSPECTOR_ITEMS) chips.append(element('span', 'omni-onnx__chip', ctx.i18n.t('onnx.moreItems', { count: values.length - MAX_INSPECTOR_ITEMS })));
        parent.append(chips);
    };

    const appendSubgraph = (parent: HTMLElement, graph: OnnxDocument['graph'], depth: number, budget: { remaining: number; omitted: number }): void => {
        if (depth > 2 || budget.remaining <= 0) { budget.omitted += countSubgraphItems(graph); return; }
        budget.remaining--;
        const box = element('div', 'omni-onnx__attribute');
        box.append(element('b', undefined, `${graph.name || ctx.i18n.t('onnx.graph')} · ${graph.nodes.length}`));
        const nodes = element('div', 'omni-onnx__chips');
        for (const node of graph.nodes) {
            if (budget.remaining <= 0) {
                budget.omitted += 1;
                for (const attribute of node.attributes) {
                    for (const nested of attribute.graphs ?? []) budget.omitted += countSubgraphItems(nested);
                    budget.omitted += attribute.omitted?.graphs ?? 0;
                }
                continue;
            }
            budget.remaining--;
            nodes.append(element('span', 'omni-onnx__chip', node.name || node.operator));
            for (const attribute of node.attributes) {
                for (const nested of attribute.graphs ?? []) appendSubgraph(box, nested, depth + 1, budget);
                budget.omitted += attribute.omitted?.graphs ?? 0;
            }
        }
        box.append(nodes);
        parent.append(box);
    };

    const applyGraphSearch = (canvas: HTMLElement): void => {
        const query = search.value.trim().toLowerCase();
        canvas.querySelectorAll<HTMLElement>('.omni-onnx__node').forEach(card => {
            const node = graphSearchNodes.get(card);
            const matches = node ? nodeMatchesSearch(node, query) : card.dataset.search?.includes(query);
            card.classList.toggle('omni-onnx__node--dim', Boolean(query) && !matches);
        });
    };

    on(search, 'input', () => {
        if (activeTab === 'graph') { const canvas = content.querySelector<HTMLElement>('.omni-onnx__canvas'); if (canvas) applyGraphSearch(canvas); }
        else renderContent();
    });
    on(copy, 'click', () => {
        if (!ctx.clipboard) return;
        void ctx.clipboard.writeText(JSON.stringify(model, null, 2)).then(() => {
            if (disposed) return;
            copy.textContent = ctx.i18n.t('common.copied');
            if (resetTimer !== undefined) clearTimeout(resetTimer);
            resetTimer = setTimeout(() => { if (!disposed) copy.textContent = ctx.i18n.t('onnx.copyJson'); }, 1200);
        }).catch(error => ctx.logger.log('error', `ONNX copy failed: ${error instanceof Error ? error.message : String(error)}`));
    });
    renderTabs();
    renderContent();

    return {
        dispose(): void {
            disposed = true;
            if (resetTimer !== undefined) clearTimeout(resetTimer);
            disposers.splice(0).forEach(dispose => dispose());
            frame.remove(); style?.remove();
            if (!(root instanceof ShadowRoot)) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--onnx');
        }
    };
}

function graphPositions(nodes: OnnxNode[]): Array<{ node: OnnxNode; depth: number }> {
    const outputDepth = new Map<string, number>();
    return nodes.map(node => {
        let depth = 0;
        for (const input of node.inputs) if (input) depth = Math.max(depth, (outputDepth.get(input) ?? -1) + 1);
        node.outputs.forEach(output => { if (output) outputDepth.set(output, depth); });
        return { node, depth };
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

function previewItems<T>(items: T[], format: (item: T) => string, limit = 20, omitted = 0): string {
    const visible = items.slice(0, limit).map(format).join(', ');
    const total = items.length + omitted;
    return total > limit ? `${visible}, … (+${total - limit})` : visible;
}

function metadataPreview(metadata: OnnxMetadata[]): string {
    return previewItems(metadata, item => `${item.key}=${item.value}`);
}

function textMatches(query: string, ...values: Array<string | number>): boolean {
    return values.some(value => String(value).toLowerCase().includes(query));
}

function metadataMatches(metadata: OnnxMetadata[], query: string): boolean {
    return metadata.some(item => textMatches(query, item.key, item.value));
}

function attributeMatchesSearch(attribute: OnnxAttribute, query: string): boolean {
    return textMatches(query, attribute.name, attribute.type, attribute.value, attribute.reference, attribute.description) ||
        (attribute.typeProtos ?? []).some(type => typeInfoMatchesSearch(type, query)) ||
        [...(attribute.tensors ?? []), ...(attribute.sparseTensors ?? [])].some(tensor =>
            textMatches(query, tensor.name, tensor.dataType, tensor.description, tensor.elementCount, tensor.dataBytes, tensor.location, tensor.storage, ...tensor.shape) ||
            metadataMatches(tensor.externalData, query) || metadataMatches(tensor.metadata, query) ||
            Boolean(tensor.sparse && (attributeTensorMatches(tensor.sparse.values, query) || attributeTensorMatches(tensor.sparse.indices, query)))) ||
        (attribute.graphs ?? []).some(graph => graphMatchesSearch(graph, query));
}

function attributeTensorMatches(tensor: NonNullable<OnnxAttribute['tensors']>[number], query: string): boolean {
    return textMatches(query, tensor.name, tensor.dataType, tensor.description, tensor.elementCount, tensor.dataBytes, tensor.location, tensor.storage, ...tensor.shape) ||
        metadataMatches(tensor.externalData, query) || metadataMatches(tensor.metadata, query);
}

function typeInfoMatchesSearch(type: NonNullable<OnnxAttribute['typeProtos']>[number], query: string): boolean {
    return textMatches(query, type.display, type.denotation, ...type.dimensions.flatMap(item => [item.value, item.denotation])) ||
        type.children.some(child => typeInfoMatchesSearch(child, query));
}

function graphMatchesSearch(graph: OnnxDocument['graph'], query: string): boolean {
    return textMatches(query, graph.name, graph.description) || metadataMatches(graph.metadata, query) ||
        [...graph.inputs, ...graph.outputs, ...graph.values].some(value =>
            textMatches(query, value.name, value.type, value.description) || metadataMatches(value.metadata, query) || Boolean(value.typeInfo && typeInfoMatchesSearch(value.typeInfo, query))) ||
        graph.initializers.some(tensor => attributeTensorMatches(tensor, query)) ||
        graph.quantization.some(item => textMatches(query, item.tensorName) || metadataMatches(item.parameters, query)) ||
        graph.nodes.some(node => nodeMatchesSearch(node, query));
}

function nodeMatchesSearch(node: OnnxNode, query: string): boolean {
    return textMatches(query, node.name, node.operator, node.domain, node.overload, node.description, ...node.inputs, ...node.outputs) ||
        node.attributes.some(attribute => attributeMatchesSearch(attribute, query)) || metadataMatches(node.metadata, query) ||
        node.deviceConfigurations.some(configuration =>
            textMatches(query, configuration.configurationId, configuration.pipelineStage) || configuration.sharding.some(spec =>
                textMatches(query, spec.tensorName, ...spec.devices, ...spec.axes) || spec.deviceGroups.some(group => textMatches(query, group.index, ...group.devices))));
}

function countSubgraphItems(graph: OnnxDocument['graph']): number {
    return 1 + graph.nodes.reduce((total, node) => total + 1 + node.attributes.reduce((attributeTotal, attribute) =>
        attributeTotal + (attribute.graphs ?? []).reduce((graphTotal, nested) => graphTotal + countSubgraphItems(nested), 0) + (attribute.omitted?.graphs ?? 0), 0), 0);
}

function graphEdge(x1: number, y1: number, x2: number, y2: number, output: boolean): SVGPathElement {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const bend = Math.max(28, (x2 - x1) / 2);
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    path.setAttribute('class', `omni-onnx__edge${output ? ' omni-onnx__edge--output' : ''}`);
    return path;
}

function formatByteCount(value: string): string {
    if (!/^\d+$/.test(value)) return value;
    const bytes = BigInt(value);
    if (bytes < 1024n) return `${bytes} B`;
    const number = Number(bytes);
    if (!Number.isFinite(number)) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let scaled = number;
    let unit = -1;
    do { scaled /= 1024; unit++; } while (scaled >= 1024 && unit < units.length - 1);
    return `${scaled.toFixed(2)} ${units[unit]}`;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
