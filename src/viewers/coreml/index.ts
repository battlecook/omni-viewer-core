import type { ClipboardService, HostContext } from '../../host/index.js';
import {
    parseCoreml,
    type CoremlDocument,
    type CoremlFeature,
    type CoremlGraph,
    type CoremlNode,
    type CoremlValue,
    type CoremlWeight
} from '../../parsers/coreml/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { coremlViewerCss } from './styles.js';

export { coremlViewerCss } from './styles.js';

export const COREML_VIEWER_META = {
    id: 'coreml',
    displayNameKey: 'coreml.title',
    extensions: ['mlmodel', 'mlpackage'],
    priority: 20,
    requiredServices: [] as const,
    optionalServices: ['clipboard'] as const,
    inputOwnership: 'borrows' as const
};

export type CoremlViewerContext = HostContext & { clipboard?: ClipboardService };

export async function mountCoremlViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: CoremlViewerContext,
    options: MountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    let model: CoremlDocument;
    try {
        model = await parseCoreml(input.data, { ...(options.signal ? { signal: options.signal } : {}) });
    } catch (error) {
        // A mid-parse abort surfaces as a parse error; the mount contract asks
        // for MountAbortedError instead.
        if (options.signal?.aborted) throw new MountAbortedError();
        throw error;
    }
    if (options.signal?.aborted) throw new MountAbortedError();
    return mountCoremlDocument(model, input.fileName, container, ctx, options);
}

type TabId = 'graph' | 'operations' | 'io' | 'weights' | 'package' | 'model';
type Selection =
    | { kind: 'node'; node: CoremlNode }
    | { kind: 'value'; value: CoremlValue; role: 'input' | 'output' };

const MAX_GRAPH_NODES = 240;
const MAX_GRAPH_CARDS = 400;
const MAX_GRAPH_OUTPUT_CARDS = 64;
const MAX_GRAPH_EDGES = 800;
const MAX_TABLE_ROWS = 2000;
const MAX_INSPECTOR_ITEMS = 64;

export function mountCoremlDocument(
    model: CoremlDocument,
    fileName: string,
    container: HTMLElement,
    ctx: CoremlViewerContext,
    options: MountOptions = {}
): ViewerHandle {
    if (options.signal?.aborted) throw new MountAbortedError();
    let root: HTMLElement | ShadowRoot = container;
    let style: HTMLStyleElement | undefined;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && container.attachShadow) {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        style = element('style');
        style.textContent = coremlViewerCss;
        root.append(style);
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--coreml');
    }

    const frame = element('div', 'omni-coreml');
    const header = element('header', 'omni-coreml__header');
    const heading = element('div');
    const title = element('h1', undefined, fileName);
    if (model.packaged) title.append(element('span', 'omni-coreml__badge', ctx.i18n.t('coreml.package')));
    if (model.isUpdatable) title.append(element('span', 'omni-coreml__badge', ctx.i18n.t('coreml.updatable')));
    const availability = model.availability || ctx.i18n.t('coreml.specVersion', { version: model.specificationVersion });
    heading.append(
        element('div', 'omni-coreml__eyebrow', 'CORE ML'),
        title,
        element('div', 'omni-coreml__subtitle', `${model.title || ctx.i18n.t('coreml.title')} · ${model.fileSize} · ${availability}`)
    );
    header.append(heading);

    const summary = element('section', 'omni-coreml__summary');
    for (const item of model.summary) {
        const card = element('div', 'omni-coreml__summary-item');
        card.append(
            element('div', 'omni-coreml__summary-value', String(item.value)),
            element('div', 'omni-coreml__summary-label', ctx.i18n.t(item.labelKey))
        );
        summary.append(card);
    }

    const toolbar = element('div', 'omni-coreml__toolbar');
    const search = element('input', 'omni-coreml__search') as HTMLInputElement;
    search.type = 'search';
    search.placeholder = ctx.i18n.t('coreml.search');
    search.setAttribute('aria-label', ctx.i18n.t('coreml.search'));
    const graphPicker = element('select', 'omni-coreml__subgraphs') as HTMLSelectElement;
    graphPicker.setAttribute('aria-label', ctx.i18n.t('coreml.graph'));
    model.graphs.forEach((graph, index) => {
        // Nesting is shown with an indent so a block reads as belonging to the
        // function above it, which a flat list of names would not convey.
        const option = element('option', undefined,
            `${' '.repeat(graph.depth * 2)}${graph.name || ctx.i18n.t('coreml.unnamed')}`) as HTMLOptionElement;
        option.value = String(index);
        graphPicker.append(option);
    });
    graphPicker.hidden = model.graphs.length < 2;
    const tabs = element('div', 'omni-coreml__tabs');
    const copy = element('button', undefined, ctx.i18n.t('coreml.copyJson')) as HTMLButtonElement;
    copy.type = 'button';
    if (!ctx.clipboard) { copy.disabled = true; copy.title = ctx.i18n.t('common.noClipboard'); }
    toolbar.append(search, graphPicker, tabs, copy);

    const warnings = element('section', 'omni-coreml__warnings');
    warnings.setAttribute('role', 'status');
    for (const warning of model.warnings) warnings.append(element('div', undefined, ctx.i18n.t(warning.key, warning.args)));
    warnings.hidden = model.warnings.length === 0;
    const content = element('main', 'omni-coreml__content');
    frame.append(header, summary, toolbar, warnings, content);
    root.append(frame);

    const tabItems: Array<[TabId, string]> = [
        ['graph', ctx.i18n.t('coreml.graph')],
        ['operations', ctx.i18n.t('coreml.operations')],
        ['io', ctx.i18n.t('coreml.io')],
        ['weights', ctx.i18n.t('coreml.weights')],
        ...(model.package ? [['package', ctx.i18n.t('coreml.packageContents')] as [TabId, string]] : []),
        ['model', ctx.i18n.t('coreml.modelInfo')]
    ];
    const empty: CoremlGraph = {
        id: '', name: '', kind: 'network', opset: '', parentId: '', depth: 0,
        inputs: [], outputs: [], nodes: [], description: ''
    };
    let activeTab: TabId = model.graphs.length > 0 ? 'graph' : 'model';
    let activeGraph = model.graphs[0] ?? empty;
    let selected: Selection | undefined = firstSelection(activeGraph);
    let disposed = false;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    const cardSelections = new WeakMap<HTMLElement, Selection>();
    const disposers: Array<() => void> = [];
    const on = (target: EventTarget, type: string, listener: EventListener): void => {
        target.addEventListener(type, listener);
        disposers.push(() => target.removeEventListener(type, listener));
    };

    const showGraph = (id: string): void => {
        const index = model.graphs.findIndex(graph => graph.id === id);
        if (index < 0) return;
        activeGraph = model.graphs[index]!;
        graphPicker.value = String(index);
        selected = firstSelection(activeGraph);
        if (activeTab !== 'graph' && activeTab !== 'operations') activeTab = 'graph';
        renderTabs();
        renderContent();
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
        else if (activeTab === 'operations') renderOperationTable();
        else if (activeTab === 'io') renderIoTable();
        else if (activeTab === 'weights') renderWeightTable();
        else if (activeTab === 'package') renderPackageTable();
        else renderModelInfo();
    };

    const query = (): string => search.value.trim().toLowerCase();
    const queryMatches = (values: unknown[]): boolean => {
        const needle = query();
        return !needle || values.some(value => String(value).toLowerCase().includes(needle));
    };

    /** Everything a node card and its table row both expose to search. */
    const nodeMatches = (node: CoremlNode, needle: string): boolean =>
        !needle ||
        textMatches(needle, node.name, node.type, node.description) ||
        node.inputs.some(port => textMatches(needle, port.name, ...port.values.map(item => item.text))) ||
        node.outputs.some(value => textMatches(needle, value.name, value.type)) ||
        node.attributes.some(item => textMatches(needle, item.key, item.value)) ||
        node.weights.some(weight => weightMatches(weight, needle));

    const weightMatches = (weight: CoremlWeight, needle: string): boolean =>
        textMatches(needle, weight.name, weight.dataType, weight.file, weight.offset,
            weight.quantization, weight.byteLength, formatByteCount(weight.byteLength), ...weight.shape);

    const portLabel = (node: CoremlNode): string =>
        previewItems(node.inputs, port => {
            const bound = port.values.map(item => item.text).join(', ');
            return port.name ? `${port.name}=${bound}` : bound;
        });

    const renderOperationTable = (): void => {
        const needle = query();
        const result = collectRows(activeGraph.nodes, node => nodeMatches(node, needle), (node, index) => [
            index + 1,
            node.name || '—',
            node.type,
            ctx.i18n.t(`coreml.kind.${node.kind}`),
            portLabel(node),
            previewItems(node.outputs, value => value.type ? `${value.name}: ${value.type}` : value.name),
            previewItems(node.attributes, item => `${item.key}=${item.value}`) || '—',
            previewItems(node.weights, weight => `${weight.name} ${formatByteCount(weight.byteLength)}`) || '—'
        ]);
        renderTable(
            `${ctx.i18n.t('coreml.operations')} · ${activeGraph.name || ctx.i18n.t('coreml.unnamed')}`,
            ['coreml.column.index', 'coreml.column.name', 'coreml.column.type', 'coreml.column.kind',
                'coreml.column.inputs', 'coreml.column.outputs', 'coreml.column.attributes',
                'coreml.column.weights'].map(key => ctx.i18n.t(key)),
            result.rows,
            result.total
        );
    };

    const renderIoTable = (): void => {
        const rows: Array<Array<string | number>> = [];
        let total = 0;
        const append = (functionName: string, kind: string, features: CoremlFeature[]): void => {
            for (const feature of features) {
                const row = [
                    functionName, kind, feature.name, feature.type,
                    feature.flexibility || '—',
                    feature.optional ? ctx.i18n.t('coreml.optional') : '—',
                    feature.description || previewItems(feature.details, item => `${item.key}=${item.value}`) || '—'
                ];
                if (!queryMatches(row)) continue;
                total++;
                if (rows.length < MAX_TABLE_ROWS) rows.push(row);
            }
        };
        for (const item of model.functions) {
            const label = item.isDefault && model.functions.length > 1
                ? `${item.name} (${ctx.i18n.t('coreml.default')})`
                : item.name;
            append(label, ctx.i18n.t('coreml.kind.input'), item.inputs);
            append(label, ctx.i18n.t('coreml.kind.output'), item.outputs);
            append(label, ctx.i18n.t('coreml.kind.state'), item.state);
            append(label, ctx.i18n.t('coreml.kind.trainingInput'), item.trainingInputs);
        }
        renderTable(
            ctx.i18n.t('coreml.io'),
            ['coreml.column.function', 'coreml.column.kind', 'coreml.column.name', 'coreml.column.typeShape',
                'coreml.column.flexibility', 'coreml.column.optional', 'coreml.column.description']
                .map(key => ctx.i18n.t(key)),
            rows,
            total
        );
    };

    const renderWeightTable = (): void => {
        const needle = query();
        const rows: Array<Array<string | number>> = [];
        let total = 0;
        for (const graph of model.graphs) {
            for (const node of graph.nodes) {
                for (const weight of node.weights) {
                    if (needle && !weightMatches(weight, needle) && !textMatches(needle, node.name, graph.name)) continue;
                    total++;
                    if (rows.length >= MAX_TABLE_ROWS) continue;
                    rows.push([
                        graph.name || ctx.i18n.t('coreml.unnamed'),
                        node.name,
                        weight.name,
                        weight.dataType,
                        weight.shape.join(' × ') || '—',
                        weight.elementCount === '0' ? '—' : weight.elementCount,
                        formatByteCount(weight.byteLength),
                        ctx.i18n.t(`coreml.storage.${weight.storage}`),
                        weight.storage === 'blob' ? `${shortName(weight.file)}+${weight.offset}` : weight.quantization || '—'
                    ]);
                }
            }
        }
        renderTable(
            ctx.i18n.t('coreml.weights'),
            ['coreml.column.graph', 'coreml.column.node', 'coreml.column.parameter', 'coreml.column.type',
                'coreml.column.shape', 'coreml.column.elements', 'coreml.column.dataSize',
                'coreml.column.storage', 'coreml.column.location'].map(key => ctx.i18n.t(key)),
            rows,
            total
        );
        if (model.weightFiles.length > 0) {
            const panel = element('div', 'omni-coreml__panel-header');
            panel.append(element('h2', undefined, ctx.i18n.t('coreml.weightFiles')));
            const list = element('dl', 'omni-coreml__model-info');
            for (const file of model.weightFiles) {
                list.append(
                    element('dt', undefined, file.name),
                    element('dd', undefined, ctx.i18n.t(file.present ? 'coreml.blobPresent' : 'coreml.blobAbsent', {
                        count: file.referenceCount,
                        referenced: formatByteCount(file.referencedBytes),
                        size: file.present ? formatByteCount(file.byteLength) : '—'
                    }))
                );
            }
            content.append(panel, list);
        }
    };

    const renderPackageTable = (): void => {
        const pkg = model.package;
        if (!pkg) return;
        const rows: Array<Array<string | number>> = [];
        let total = 0;
        for (const item of pkg.items) {
            const row = [
                ctx.i18n.t('coreml.kind.manifestItem'), item.name, item.path,
                formatByteCount(item.byteLength),
                `${item.description}${item.isRoot ? ` · ${ctx.i18n.t('coreml.rootItem')}` : ''}`
            ];
            if (!queryMatches(row)) continue;
            total++;
            if (rows.length < MAX_TABLE_ROWS) rows.push(row);
        }
        for (const file of pkg.files) {
            const row = [ctx.i18n.t('coreml.kind.archiveMember'), shortName(file.name), file.name,
                formatByteCount(file.byteLength), file.method];
            if (!queryMatches(row)) continue;
            total++;
            if (rows.length < MAX_TABLE_ROWS) rows.push(row);
        }
        renderTable(
            ctx.i18n.t('coreml.packageContents'),
            ['coreml.column.kind', 'coreml.column.name', 'coreml.column.path', 'coreml.column.dataSize',
                'coreml.column.description'].map(key => ctx.i18n.t(key)),
            rows,
            total
        );
    };

    const renderModelInfo = (): void => {
        const rows: Array<[string, string]> = [];
        let total = 0;
        const append = (key: string, value: string): void => {
            if (!queryMatches([key, value])) return;
            total++;
            if (rows.length < MAX_TABLE_ROWS) rows.push([key, value]);
        };
        append(ctx.i18n.t('coreml.info.modelType'), model.modelType);
        append(ctx.i18n.t('coreml.info.specVersion'), String(model.specificationVersion));
        append(ctx.i18n.t('coreml.info.availability'), model.availability || ctx.i18n.t('coreml.unknown'));
        append(ctx.i18n.t('coreml.info.description'), model.shortDescription || '—');
        append(ctx.i18n.t('coreml.info.author'), model.author || '—');
        append(ctx.i18n.t('coreml.info.license'), model.license || '—');
        append(ctx.i18n.t('coreml.info.version'), model.versionString || '—');
        append(ctx.i18n.t('coreml.info.updatable'), ctx.i18n.t(model.isUpdatable ? 'coreml.yes' : 'coreml.no'));
        append(ctx.i18n.t('coreml.info.fileSize'), model.fileSize);
        append(ctx.i18n.t('coreml.info.functions'), previewItems(model.functions, item => item.name) || '—');
        if (model.functions.length > 1) append(ctx.i18n.t('coreml.info.defaultFunction'), model.defaultFunctionName || '—');
        append(ctx.i18n.t('coreml.info.graphs'), previewItems(model.graphs, graph =>
            `${graph.name || ctx.i18n.t('coreml.unnamed')} (${graph.nodes.length})`) || '—');
        if (model.classLabels.kind) {
            append(
                ctx.i18n.t('coreml.info.classLabels'),
                `${model.classLabels.total} · ${previewItems(model.classLabels.values, value => value, 20, model.classLabels.total)}`
            );
        }
        if (model.package) {
            append(ctx.i18n.t('coreml.info.packageVersion'), model.package.formatVersion || '—');
            append(ctx.i18n.t('coreml.info.modelPath'), model.package.modelPath);
        }
        for (const item of model.userDefined) append(item.key, item.value);
        const panel = element('div', 'omni-coreml__panel-header');
        panel.append(
            element('h2', undefined, ctx.i18n.t('coreml.modelInfo')),
            element('span', undefined, ctx.i18n.t('coreml.rows', { shown: rows.length, total }))
        );
        const list = element('dl', 'omni-coreml__model-info');
        for (const [key, value] of rows) list.append(element('dt', undefined, key), element('dd', undefined, value));
        content.append(panel, list);
    };

    const renderTable = (
        heading: string,
        headers: string[],
        rows: Array<Array<string | number>>,
        total: number
    ): void => {
        const visible = rows.slice(0, MAX_TABLE_ROWS);
        const panel = element('div', 'omni-coreml__panel-header');
        panel.append(
            element('h2', undefined, heading),
            element('span', undefined, ctx.i18n.t('coreml.rows', { shown: visible.length, total }))
        );
        const wrap = element('div', 'omni-coreml__table-wrap');
        const table = element('table');
        const head = element('thead');
        const headRow = element('tr');
        for (const label of headers) headRow.append(element('th', undefined, label));
        head.append(headRow);
        const body = element('tbody');
        for (const row of visible) {
            const rowElement = element('tr');
            for (const cell of row) {
                const td = element('td', undefined, String(cell));
                td.title = String(cell);
                rowElement.append(td);
            }
            body.append(rowElement);
        }
        table.append(head, body);
        wrap.append(table);
        content.append(panel, wrap);
        if (rows.length === 0) content.append(element('div', 'omni-coreml__empty', ctx.i18n.t('coreml.noMatches')));
    };

    const renderGraph = (): void => {
        const layout = element('div', 'omni-coreml__graph-layout');
        const scroll = element('div', 'omni-coreml__graph-scroll');
        const inspector = element('aside', 'omni-coreml__inspector');
        const shownNodes = activeGraph.nodes.slice(0, MAX_GRAPH_NODES);
        const positions = graphPositions(shownNodes);
        const maxDepth = Math.max(0, ...positions.map(item => item.depth));
        const ranks = new Map<number, number>();
        for (const item of positions) ranks.set(item.depth, (ranks.get(item.depth) ?? 0) + 1);

        // A value produced by no node in this graph is a source: a declared
        // graph input, or a name the enclosing scope supplied to a block.
        const produced = new Set<string>();
        for (const node of activeGraph.nodes) for (const output of node.outputs) produced.add(output.name);
        const sources: CoremlValue[] = [...activeGraph.inputs];
        const seen = new Set(sources.map(value => value.name));
        for (const node of activeGraph.nodes) {
            for (const port of node.inputs) {
                for (const value of port.values) {
                    // Literals are rendered inline on the card, not as cards.
                    if (!value.variable || produced.has(value.text) || seen.has(value.text)) continue;
                    seen.add(value.text);
                    sources.push({ name: value.text, type: '' });
                }
            }
        }
        const wired = new Set<string>();
        for (const node of shownNodes) for (const port of node.inputs) for (const value of port.values) wired.add(value.text);

        const remaining = Math.max(0, MAX_GRAPH_CARDS - shownNodes.length);
        const outputNames = [...new Set(activeGraph.outputs)];
        const shownOutputs = outputNames.slice(0, Math.min(MAX_GRAPH_OUTPUT_CARDS, remaining));
        const sourceBudget = Math.max(0, remaining - shownOutputs.length);
        const shownSources: CoremlValue[] = [];
        const collectSources = (connected: boolean): void => {
            for (const value of sources) {
                if (shownSources.length >= sourceBudget) return;
                if (wired.has(value.name) === connected) shownSources.push(value);
            }
        };
        collectSources(true);
        collectSources(false);
        const totalCards = activeGraph.nodes.length + sources.length + outputNames.length;
        const shownCards = shownNodes.length + shownSources.length + shownOutputs.length;

        const width = Math.max(720, (maxDepth + 3) * 220);
        const height = Math.max(420, Math.max(...ranks.values(), shownSources.length, shownOutputs.length, 1) * 86 + 40);
        const canvas = element('div', 'omni-coreml__canvas');
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'omni-coreml__edges');
        svg.setAttribute('width', String(width));
        svg.setAttribute('height', String(height));

        const cardPositions = new Map<string, { x: number; y: number }>();
        const producer = new Map<string, string>();
        const sourceCards = new Map<string, string>();
        shownSources.forEach((value, index) => {
            cardPositions.set(`source-${value.name}`, { x: 20, y: 20 + index * 86 });
            sourceCards.set(value.name, `source-${value.name}`);
        });
        const rankIndex = new Map<number, number>();
        positions.forEach(item => {
            const index = rankIndex.get(item.depth) ?? 0;
            rankIndex.set(item.depth, index + 1);
            cardPositions.set(item.node.id, { x: 220 + item.depth * 220, y: 20 + index * 86 });
            for (const output of item.node.outputs) producer.set(output.name, item.node.id);
        });
        shownOutputs.forEach((name, index) =>
            cardPositions.set(`output-${name}`, { x: (maxDepth + 2) * 220, y: 20 + index * 86 }));

        let edgeCount = 0;
        let edgesOmitted = false;
        const connect = (fromId: string | undefined, toId: string, output: boolean): void => {
            const from = fromId ? cardPositions.get(fromId) : undefined;
            const to = cardPositions.get(toId);
            if (!from || !to) return;
            if (edgeCount >= MAX_GRAPH_EDGES) { edgesOmitted = true; return; }
            svg.append(graphEdge(from.x + 170, from.y + 27, to.x, to.y + 27, output));
            edgeCount++;
        };
        for (const item of positions) {
            for (const port of item.node.inputs) {
                for (const value of port.values) {
                    if (!value.variable) continue;
                    connect(producer.get(value.text) ?? sourceCards.get(value.text), item.node.id, false);
                }
            }
        }
        for (const name of shownOutputs) connect(producer.get(name) ?? sourceCards.get(name), `output-${name}`, true);
        canvas.append(svg);

        const addCard = (
            id: string,
            cardTitle: string,
            detail: string,
            kind: string,
            selection?: Selection,
            extraSearch = ''
        ): void => {
            const position = cardPositions.get(id);
            if (!position) return;
            const button = element('button', `omni-coreml__node omni-coreml__node--${kind}`) as HTMLButtonElement;
            button.type = 'button';
            button.style.left = `${position.x}px`;
            button.style.top = `${position.y}px`;
            button.dataset.search = `${cardTitle} ${detail} ${extraSearch}`.toLowerCase();
            if (selection) cardSelections.set(button, selection);
            button.append(element('strong', undefined, cardTitle || '—'), element('small', undefined, detail));
            button.onclick = () => {
                if (!selection) return;
                selected = selection;
                renderInspector(inspector);
                canvas.querySelectorAll('.omni-coreml__node--selected')
                    .forEach(item => item.classList.remove('omni-coreml__node--selected'));
                button.classList.add('omni-coreml__node--selected');
            };
            canvas.append(button);
        };
        for (const value of shownSources) {
            const declared = activeGraph.inputs.some(item => item.name === value.name);
            addCard(`source-${value.name}`, value.name, value.type || ctx.i18n.t('coreml.external'),
                declared ? 'input' : 'constant', { kind: 'value', value, role: 'input' });
        }
        for (const item of positions) {
            addCard(item.node.id, item.node.name, item.node.type, cardKind(item.node),
                { kind: 'node', node: item.node });
        }
        for (const name of shownOutputs) {
            const value = producedValue(activeGraph, name) ?? { name, type: '' };
            addCard(`output-${name}`, name, value.type || '—', 'output', { kind: 'value', value, role: 'output' });
        }
        if (totalCards > shownCards) {
            scroll.append(element('div', 'omni-coreml__graph-limit',
                ctx.i18n.t('coreml.graphLimited', { shown: shownCards, total: totalCards })));
        }
        if (edgesOmitted) {
            scroll.append(element('div', 'omni-coreml__graph-limit',
                ctx.i18n.t('coreml.graphEdgesLimited', { count: MAX_GRAPH_EDGES })));
        }
        scroll.append(canvas);
        renderInspector(inspector);
        layout.append(scroll, inspector);
        content.append(layout);
        applyGraphSearch(canvas);
    };

    const renderInspector = (inspector: HTMLElement): void => {
        inspector.replaceChildren();
        if (!selected) { inspector.append(element('div', 'omni-coreml__empty', ctx.i18n.t('coreml.selectNode'))); return; }
        if (selected.kind === 'value') {
            const { value, role } = selected;
            inspector.append(
                element('div', 'omni-coreml__inspector-kind', ctx.i18n.t(`coreml.kind.${role}`)),
                element('h2', undefined, value.name),
                element('div', undefined, value.type || ctx.i18n.t('coreml.unknown'))
            );
            const feature = findFeature(model, value.name);
            if (feature) {
                appendFacts(inspector, [
                    [ctx.i18n.t('coreml.column.typeShape'), feature.type],
                    ...(feature.flexibility ? [[ctx.i18n.t('coreml.column.flexibility'), feature.flexibility] as [string, string]] : []),
                    ...(feature.optional ? [[ctx.i18n.t('coreml.column.optional'), ctx.i18n.t('coreml.yes')] as [string, string]] : []),
                    ...feature.details.map(item => [item.key, item.value] as [string, string])
                ]);
            }
            return;
        }
        const node = selected.node;
        inspector.append(
            element('div', 'omni-coreml__inspector-kind', ctx.i18n.t(`coreml.kind.${node.kind}`)),
            element('h2', undefined, node.name),
            element('div', undefined, node.type)
        );
        if (node.inputs.length) {
            inspector.append(element('h3', undefined, ctx.i18n.t('coreml.inspector.inputs')));
            for (const port of node.inputs.slice(0, MAX_INSPECTOR_ITEMS)) {
                const row = element('div', 'omni-coreml__attribute');
                if (port.name) row.append(element('b', undefined, port.name));
                row.append(element('div', undefined, port.values.map(item => item.text).join(', ') || '—'));
                inspector.append(row);
            }
            if (node.inputs.length > MAX_INSPECTOR_ITEMS) {
                inspector.append(element('div', 'omni-coreml__attribute',
                    ctx.i18n.t('coreml.moreItems', { count: node.inputs.length - MAX_INSPECTOR_ITEMS })));
            }
        }
        if (node.outputs.length) {
            inspector.append(element('h3', undefined, ctx.i18n.t('coreml.inspector.outputs')));
            const chips = element('div', 'omni-coreml__chips');
            for (const value of node.outputs.slice(0, MAX_INSPECTOR_ITEMS)) {
                const chip = element('span', 'omni-coreml__chip', value.type ? `${value.name}: ${value.type}` : value.name);
                chip.title = chip.textContent ?? '';
                chips.append(chip);
            }
            if (node.outputs.length > MAX_INSPECTOR_ITEMS) {
                chips.append(element('span', 'omni-coreml__chip',
                    ctx.i18n.t('coreml.moreItems', { count: node.outputs.length - MAX_INSPECTOR_ITEMS })));
            }
            inspector.append(chips);
        }
        if (node.attributes.length) {
            inspector.append(element('h3', undefined, ctx.i18n.t('coreml.inspector.attributes')));
            appendFacts(inspector, node.attributes.slice(0, MAX_INSPECTOR_ITEMS).map(item => [item.key, item.value]));
            if (node.attributes.length > MAX_INSPECTOR_ITEMS) {
                inspector.append(element('div', 'omni-coreml__attribute',
                    ctx.i18n.t('coreml.moreItems', { count: node.attributes.length - MAX_INSPECTOR_ITEMS })));
            }
        }
        if (node.weights.length) {
            inspector.append(element('h3', undefined, ctx.i18n.t('coreml.inspector.weights')));
            for (const weight of node.weights.slice(0, MAX_INSPECTOR_ITEMS)) {
                const row = element('div', 'omni-coreml__attribute');
                row.append(element('b', undefined,
                    `${weight.name} · ${weight.dataType}${weight.shape.length ? `[${weight.shape.join(' × ')}]` : ''}`));
                const detail = [
                    formatByteCount(weight.byteLength),
                    ctx.i18n.t(`coreml.storage.${weight.storage}`),
                    weight.storage === 'blob' ? `${shortName(weight.file)}+${weight.offset}` : weight.quantization
                ].filter(Boolean).join(' · ');
                row.append(element('div', 'omni-coreml__weight', detail));
                if (weight.updatable) row.append(element('div', 'omni-coreml__weight', ctx.i18n.t('coreml.updatable')));
                inspector.append(row);
            }
            if (node.weights.length > MAX_INSPECTOR_ITEMS) {
                inspector.append(element('div', 'omni-coreml__attribute',
                    ctx.i18n.t('coreml.moreItems', { count: node.weights.length - MAX_INSPECTOR_ITEMS })));
            }
        }
        if (node.graphs.length) {
            inspector.append(element('h3', undefined, ctx.i18n.t('coreml.inspector.graphs')));
            for (const id of node.graphs) {
                const target = model.graphs.find(graph => graph.id === id);
                const link = element('button', 'omni-coreml__link',
                    target?.name || ctx.i18n.t('coreml.unnamed')) as HTMLButtonElement;
                link.type = 'button';
                link.disabled = !target;
                link.onclick = () => showGraph(id);
                inspector.append(link);
            }
        }
        if (node.description) {
            inspector.append(element('h3', undefined, ctx.i18n.t('coreml.column.description')),
                element('div', undefined, node.description));
        }
    };

    const appendFacts = (parent: HTMLElement, facts: Array<[string, string]>): void => {
        for (const [label, value] of facts) {
            const row = element('div', 'omni-coreml__attribute');
            row.append(element('b', undefined, label), element('div', undefined, value || '—'));
            parent.append(row);
        }
    };

    const applyGraphSearch = (canvas: HTMLElement): void => {
        const needle = query();
        canvas.querySelectorAll<HTMLElement>('.omni-coreml__node').forEach(card => {
            const selection = cardSelections.get(card);
            const matches = selection?.kind === 'node'
                ? nodeMatches(selection.node, needle)
                : card.dataset.search?.includes(needle);
            card.classList.toggle('omni-coreml__node--dim', Boolean(needle) && !matches);
        });
    };

    on(search, 'input', () => {
        if (activeTab === 'graph') {
            const canvas = content.querySelector<HTMLElement>('.omni-coreml__canvas');
            if (canvas) applyGraphSearch(canvas);
        } else renderContent();
    });
    on(graphPicker, 'change', () => {
        const graph = model.graphs[Number(graphPicker.value)];
        if (graph) showGraph(graph.id);
    });
    on(copy, 'click', () => {
        if (!ctx.clipboard) return;
        void ctx.clipboard.writeText(JSON.stringify(model, null, 2)).then(() => {
            if (disposed) return;
            copy.textContent = ctx.i18n.t('common.copied');
            if (resetTimer !== undefined) clearTimeout(resetTimer);
            resetTimer = setTimeout(() => { if (!disposed) copy.textContent = ctx.i18n.t('coreml.copyJson'); }, 1200);
        }).catch(error => ctx.logger.log('error', `Core ML copy failed: ${error instanceof Error ? error.message : String(error)}`));
    });
    renderTabs();
    renderContent();

    return {
        dispose(): void {
            disposed = true;
            if (resetTimer !== undefined) clearTimeout(resetTimer);
            disposers.splice(0).forEach(dispose => dispose());
            frame.remove();
            style?.remove();
            if (!(root instanceof ShadowRoot)) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--coreml');
        }
    };
}

function firstSelection(graph: CoremlGraph): Selection | undefined {
    const node = graph.nodes[0];
    if (node) return { kind: 'node', node };
    const input = graph.inputs[0];
    return input ? { kind: 'value', value: input, role: 'input' } : undefined;
}

function cardKind(node: CoremlNode): string {
    if (node.kind === 'stage') return 'stage';
    // The parser resolves what "custom" means in each encoding; testing the
    // type name here would only recognize the neural network's spelling.
    if (node.custom) return 'custom';
    if (node.constant) return 'constant';
    return 'node';
}

function producedValue(graph: CoremlGraph, name: string): CoremlValue | undefined {
    for (const node of graph.nodes) {
        const match = node.outputs.find(value => value.name === name);
        if (match) return match;
    }
    return graph.inputs.find(value => value.name === name);
}

/** The declared feature matching a graph value, so the inspector can show it. */
function findFeature(model: CoremlDocument, name: string): CoremlFeature | undefined {
    for (const item of model.functions) {
        const match = [...item.inputs, ...item.outputs, ...item.state].find(feature => feature.name === name);
        if (match) return match;
    }
    return undefined;
}

/** Longest-path depth per node, using the node that produced each operand. */
function graphPositions(nodes: CoremlNode[]): Array<{ node: CoremlNode; depth: number }> {
    const outputDepth = new Map<string, number>();
    return nodes.map(node => {
        let depth = 0;
        for (const port of node.inputs) {
            for (const value of port.values) {
                if (!value.variable) continue;
                depth = Math.max(depth, (outputDepth.get(value.text) ?? -1) + 1);
            }
        }
        for (const output of node.outputs) outputDepth.set(output.name, depth);
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

function previewItems<T>(items: T[], format: (item: T) => string, limit = 20, total = items.length): string {
    const shown = Math.min(limit, items.length);
    const visible = items.slice(0, shown).map(format).join(', ');
    return total > shown ? `${visible}, … (+${total - shown})` : visible;
}

function textMatches(query: string, ...values: Array<string | number>): boolean {
    return values.some(value => String(value).toLowerCase().includes(query));
}

function shortName(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(slash + 1) : path;
}

function graphEdge(x1: number, y1: number, x2: number, y2: number, output: boolean): SVGPathElement {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const bend = Math.max(28, (x2 - x1) / 2);
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    path.setAttribute('class', `omni-coreml__edge${output ? ' omni-coreml__edge--output' : ''}`);
    return path;
}

function formatByteCount(value: string): string {
    if (!/^\d+$/.test(value)) return value || '—';
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
