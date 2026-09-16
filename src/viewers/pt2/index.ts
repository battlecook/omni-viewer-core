import type { ClipboardService, HostContext } from '../../host/index.js';
import {
    formatFileSize,
    parsePt2,
    type Pt2Argument,
    type Pt2Document,
    type Pt2Entry,
    type Pt2Graph,
    type Pt2InputSpec,
    type Pt2Model,
    type Pt2Node,
    type Pt2Payload,
    type Pt2Value
} from '../../parsers/pt2/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { pt2ViewerCss } from './styles.js';

export { looksLikePt2Archive, parsePt2, prettySymExpr } from '../../parsers/pt2/index.js';
export type {
    Pt2AotInductorModel,
    Pt2ArchiveEntry,
    Pt2Argument,
    Pt2Document,
    Pt2Entry,
    Pt2EntryCategory,
    Pt2ExtraFile,
    Pt2Graph,
    Pt2InputKind,
    Pt2InputSpec,
    Pt2Layout,
    Pt2Model,
    Pt2Module,
    Pt2ModuleFrame,
    Pt2Node,
    Pt2OperatorCount,
    Pt2OutputKind,
    Pt2OutputSpec,
    Pt2ParseOptions,
    Pt2Payload,
    Pt2PayloadKind,
    Pt2PayloadStatus,
    Pt2RangeConstraint,
    Pt2Value,
    Pt2ValueKind,
    Pt2Warning
} from '../../parsers/pt2/index.js';
export { pt2ViewerCss } from './styles.js';

export const PT2_VIEWER_META = {
    id: 'pt2',
    displayNameKey: 'pt2.title',
    extensions: ['pt2'] as string[],
    priority: 20,
    requiredServices: [] as const,
    optionalServices: ['clipboard'] as const,
    inputOwnership: 'borrows' as const
};

export type Pt2ViewerContext = HostContext & { clipboard?: ClipboardService };

export async function mountPt2Viewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: Pt2ViewerContext,
    options: MountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const model = await parsePt2(input.data, options.signal ? { signal: options.signal } : {});
    if (options.signal?.aborted) throw new MountAbortedError();
    return mountPt2Document(model, input.fileName, container, ctx, options);
}

type TabId = 'graph' | 'nodes' | 'weights' | 'io' | 'modules' | 'model' | 'archive';
type CardKind = 'input' | 'param' | 'buffer' | 'constant' | 'node' | 'hop' | 'output';
/** A selectable graph element: an operator node, or a value produced by a placeholder. */
type Selection = { kind: 'node'; node: Pt2Node } | { kind: 'value'; name: string } | { kind: 'output'; argument: Pt2Argument };
interface Card { id: string; kind: CardKind; title: string; detail: string; selection: Selection; depth: number }

const MAX_GRAPH_NODES = 240;
const MAX_GRAPH_EDGES = 800;
const MAX_TABLE_ROWS = 2000;
const MAX_INSPECTOR_ITEMS = 64;
const CARD_WIDTH = 170;
const COLUMN_GAP = 220;
const ROW_GAP = 86;

/** Mounts an already-parsed package, so adapters can parse off the UI thread. */
export function mountPt2Document(
    pkg: Pt2Document,
    fileName: string,
    container: HTMLElement,
    ctx: Pt2ViewerContext,
    options: MountOptions = {}
): ViewerHandle {
    if (options.signal?.aborted) throw new MountAbortedError();
    let root: HTMLElement | ShadowRoot = container;
    let style: HTMLStyleElement | undefined;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && container.attachShadow) {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        style = element('style');
        style.textContent = pt2ViewerCss;
        root.append(style);
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--pt2');
    }
    const t = (key: string, args?: Record<string, string | number>): string => ctx.i18n.t(key, args);

    let model: Pt2Model | undefined = pkg.models[0];
    let activeTab: TabId = model ? 'graph' : 'archive';
    let selection: Selection | undefined;
    let disposed = false;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;

    const frame = element('div', 'omni-pt2');
    const header = element('header', 'omni-pt2__header');
    const heading = element('div');
    const subtitle = element('div', 'omni-pt2__subtitle');
    heading.append(element('div', 'omni-pt2__eyebrow', pkg.layout === 'legacy' ? t('pt2.eyebrowLegacy') : 'PyTorch Export · PT2'), element('h1', undefined, fileName), subtitle);
    header.append(heading);

    const summary = element('section', 'omni-pt2__summary');
    for (const item of pkg.summary) {
        const card = element('div', 'omni-pt2__summary-item');
        card.append(element('div', 'omni-pt2__summary-value', String(item.value)), element('div', 'omni-pt2__summary-label', t(item.labelKey)));
        summary.append(card);
    }

    const toolbar = element('div', 'omni-pt2__toolbar');
    const search = element('input', 'omni-pt2__search') as HTMLInputElement;
    search.type = 'search';
    search.placeholder = t('pt2.search');
    search.setAttribute('aria-label', t('pt2.search'));
    const modelSelect = element('select', 'omni-pt2__model') as HTMLSelectElement;
    modelSelect.setAttribute('aria-label', t('pt2.selectModel'));
    for (const item of pkg.models) {
        const option = element('option', undefined, item.name) as HTMLOptionElement;
        option.value = item.name;
        modelSelect.append(option);
    }
    modelSelect.hidden = pkg.models.length < 2;
    const tabs = element('div', 'omni-pt2__tabs');
    const copy = element('button', undefined, t('pt2.copyJson')) as HTMLButtonElement;
    copy.type = 'button';
    if (!ctx.clipboard) { copy.disabled = true; copy.title = t('common.noClipboard'); }
    toolbar.append(search, modelSelect, tabs, copy);

    const warnings = element('section', 'omni-pt2__warnings');
    warnings.setAttribute('role', 'status');
    for (const warning of pkg.warnings) warnings.append(element('div', undefined, t(warning.key, warning.args)));
    warnings.hidden = pkg.warnings.length === 0;
    const content = element('main', 'omni-pt2__content');
    frame.append(header, summary, toolbar, warnings, content);
    root.append(frame);

    const tabItems: Array<[TabId, string]> = [
        ['graph', t('pt2.graph')], ['nodes', t('pt2.nodes')], ['weights', t('pt2.weights')], ['io', t('pt2.io')],
        ['modules', t('pt2.modules')], ['model', t('pt2.modelInfo')], ['archive', t('pt2.archive')]
    ];
    const modelTabs: ReadonlySet<TabId> = new Set(['graph', 'nodes', 'weights', 'io', 'modules', 'model']);
    const graphSearchCards = new WeakMap<HTMLElement, Card>();
    const disposers: Array<() => void> = [];
    const on = (target: EventTarget, type: string, listener: EventListener): void => {
        target.addEventListener(type, listener);
        disposers.push(() => target.removeEventListener(type, listener));
    };

    // Per-model indexes: who produces and consumes each top-level value.
    let producers = new Map<string, Pt2Node>();
    let consumers = new Map<string, Pt2Node[]>();
    let specsByArg = new Map<string, Pt2InputSpec>();
    let valuesByName = new Map<string, Pt2Value>();
    let payloadsByPlaceholder = new Map<string, Pt2Payload>();
    const indexModel = (): void => {
        producers = new Map();
        consumers = new Map();
        specsByArg = new Map();
        valuesByName = new Map();
        payloadsByPlaceholder = new Map();
        if (!model) return;
        for (const node of model.graph.nodes) {
            for (const output of node.outputs) for (const ref of output.refs) if (!producers.has(ref)) producers.set(ref, node);
            for (const input of node.inputs) for (const ref of input.refs) push(consumers, ref, node);
        }
        for (const spec of model.inputSpecs) if (spec.arg && !specsByArg.has(spec.arg)) specsByArg.set(spec.arg, spec);
        for (const value of model.graph.values) if (!valuesByName.has(value.name)) valuesByName.set(value.name, value);
        for (const payload of [...model.weights, ...model.constants]) if (payload.placeholder && !payloadsByPlaceholder.has(payload.placeholder)) payloadsByPlaceholder.set(payload.placeholder, payload);
        selection = model.graph.nodes[0] ? { kind: 'node', node: model.graph.nodes[0] } : undefined;
        const opsets = model.opsets.map(item => `${item.label}=${item.value}`).join(', ');
        subtitle.textContent = [
            model.name, model.torchVersion ? `torch ${model.torchVersion}` : '', model.schemaVersion ? t('pt2.schema', { version: model.schemaVersion }) : '',
            opsets ? `opset ${opsets}` : '', pkg.fileSize
        ].filter(Boolean).join(' · ');
    };
    if (model) indexModel();
    else subtitle.textContent = [pkg.archiveFormat ? `archive_format ${pkg.archiveFormat}` : '', pkg.fileSize].filter(Boolean).join(' · ');

    const renderTabs = (): void => {
        tabs.replaceChildren();
        for (const [id, label] of tabItems) {
            if (!model && modelTabs.has(id)) continue;
            const button = element('button', undefined, label);
            button.type = 'button';
            button.setAttribute('aria-pressed', String(activeTab === id));
            button.onclick = () => { activeTab = id; renderTabs(); renderContent(); };
            tabs.append(button);
        }
    };

    const renderContent = (): void => {
        content.replaceChildren();
        if (activeTab === 'archive') renderArchive();
        else if (!model) renderArchive();
        else if (activeTab === 'graph') renderGraph(model);
        else if (activeTab === 'nodes') renderNodeTable(model);
        else if (activeTab === 'weights') renderWeightTable(model);
        else if (activeTab === 'io') renderIoTable(model);
        else if (activeTab === 'modules') renderModuleTable(model);
        else renderModelInfo(model);
    };

    const query = (): string => search.value.trim().toLowerCase();
    const queryMatches = (values: unknown[]): boolean => {
        const q = query();
        return !q || values.some(value => String(value).toLowerCase().includes(q));
    };

    const valueSummary = (name: string): string => {
        const value = valuesByName.get(name);
        if (!value) return name;
        if (value.kind === 'tensor') return `${value.dtype || '?'}[${value.shape.join(', ')}]`;
        if (value.kind === 'custom_obj') return value.detail || 'custom_obj';
        return `${value.kind === 'sym_int' ? 'Sym' : value.kind === 'sym_bool' ? 'SymBool' : 'SymFloat'}(${value.detail || name})`;
    };
    const argumentText = (argument: Pt2Argument): string => argument.name ? `${argument.name}=${argument.text}` : argument.text;
    const outputSummary = (node: Pt2Node): string => {
        const first = node.outputs.find(output => output.refs.length);
        return first ? valueSummary(first.refs[0]!) : node.outputs.length ? node.outputs.map(output => output.text).join(', ') : '—';
    };
    const kindOf = (spec: Pt2InputSpec | undefined): CardKind =>
        spec?.kind === 'parameter' ? 'param' : spec?.kind === 'buffer' ? 'buffer' : spec?.kind === 'tensor_constant' || spec?.kind === 'custom_obj' ? 'constant' : 'input';

    const renderTable = (title: string, headers: string[], rows: Array<Array<string | number>>, total: number): void => {
        const visible = rows.slice(0, MAX_TABLE_ROWS);
        const panel = element('div', 'omni-pt2__panel-header');
        panel.append(element('h2', undefined, title), element('span', undefined, t('pt2.rows', { shown: visible.length, total })));
        const wrap = element('div', 'omni-pt2__table-wrap');
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
        if (rows.length === 0) content.append(element('div', 'omni-pt2__empty', t('pt2.noMatches')));
    };

    const renderNodeTable = (current: Pt2Model): void => {
        const q = query();
        const flat: Array<{ node: Pt2Node; graphName: string }> = [];
        const collect = (graph: Pt2Graph, graphName: string, depth: number): void => {
            for (const node of graph.nodes) {
                flat.push({ node, graphName });
                if (depth < 8) for (const subgraph of node.subgraphs) collect(subgraph.graph, subgraph.name, depth + 1);
            }
        };
        collect(current.graph, '', 0);
        const result = collectRows(flat, item => !q || nodeMatchesSearch(item.node, q) || item.graphName.toLowerCase().includes(q),
            item => [item.node.index, item.node.name, item.node.op, item.node.module || '—', previewItems(item.node.inputs, argumentText), item.node.outputs.map(output => output.refs[0] ? `${output.text}: ${valueSummary(output.refs[0])}` : output.text).join(', ') || '—', item.graphName || '—']);
        renderTable(t('pt2.nodes'), ['pt2.column.index', 'pt2.column.name', 'pt2.column.op', 'pt2.column.module', 'pt2.column.inputs', 'pt2.column.outputs', 'pt2.column.graph'].map(key => t(key)), result.rows, result.total);
    };

    const renderWeightTable = (current: Pt2Model): void => {
        const q = query();
        const result = collectRows([...current.weights, ...current.constants], payload => !q || payloadMatchesSearch(payload, q),
            payload => [t(`pt2.kind.${payload.kind}`), payload.name, payload.placeholder || '—', payload.dtype || '—', payload.shape.join(' × ') || (payload.dtype ? t('pt2.scalar') : '—'), payload.elementCount, formatFileSize(payload.bytes), payload.path || '—', payload.fileSize === null ? '—' : formatFileSize(payload.fileSize), t(`pt2.status.${payload.status}`), payload.preview.join(', ') || '—']);
        renderTable(t('pt2.weights'), ['pt2.column.kind', 'pt2.column.name', 'pt2.column.placeholder', 'pt2.column.dtype', 'pt2.column.shape', 'pt2.column.elements', 'pt2.column.bytes', 'pt2.column.path', 'pt2.column.fileSize', 'pt2.column.status', 'pt2.column.preview'].map(key => t(key)), result.rows, result.total);
    };

    const renderIoTable = (current: Pt2Model): void => {
        const rows: Array<Array<string | number>> = [];
        let total = 0;
        const add = (row: Array<string | number>): void => {
            if (!queryMatches(row)) return;
            total++;
            if (rows.length < MAX_TABLE_ROWS) rows.push(row);
        };
        for (const spec of current.inputSpecs) {
            const detail = spec.kind === 'constant_input' ? spec.value : spec.kind === 'buffer' ? t(spec.persistent === false ? 'pt2.nonPersistent' : 'pt2.persistent') : '';
            add([t('pt2.side.input'), t(`pt2.kind.${spec.kind}`), spec.arg || '—', spec.target || '—', spec.kind === 'constant_input' ? '—' : valueSummary(spec.arg), detail || '—']);
        }
        for (const spec of current.outputSpecs) {
            add([t('pt2.side.output'), t(`pt2.kind.${spec.kind}`), spec.arg || '—', spec.target || '—', valueSummary(spec.arg), '—']);
        }
        renderTable(t('pt2.io'), ['pt2.column.side', 'pt2.column.kind', 'pt2.column.value', 'pt2.column.target', 'pt2.column.typeShape', 'pt2.column.detail'].map(key => t(key)), rows, total);
    };

    const renderModuleTable = (current: Pt2Model): void => {
        const q = query();
        const result = collectRows(current.modules, module => !q || textMatches(q, module.fqn, module.className, ...module.forwardArgNames),
            module => [`${'· '.repeat(module.depth)}${module.fqn || t('pt2.rootModule')}`, module.className || '—', module.nodeCount, module.totalNodeCount, module.hasSignature ? t('pt2.preserved') : '—', module.forwardArgNames.join(', ') || '—', module.inputs.join(', ') || '—', module.outputs.join(', ') || '—']);
        renderTable(t('pt2.modules'), ['pt2.column.module', 'pt2.column.class', 'pt2.column.nodes', 'pt2.column.totalNodes', 'pt2.column.signature', 'pt2.column.forwardArgs', 'pt2.column.inputs', 'pt2.column.outputs'].map(key => t(key)), result.rows, result.total);
    };

    const renderDefinitionList = (title: string, rows: Array<[string, string]>): void => {
        const visible: Array<[string, string]> = [];
        let total = 0;
        for (const row of rows) {
            if (!queryMatches(row)) continue;
            total++;
            if (visible.length < MAX_TABLE_ROWS) visible.push(row);
        }
        const panel = element('div', 'omni-pt2__panel-header');
        panel.append(element('h2', undefined, title), element('span', undefined, t('pt2.rows', { shown: visible.length, total })));
        const dl = element('dl', 'omni-pt2__model-info');
        for (const [key, value] of visible) dl.append(element('dt', undefined, key), element('dd', undefined, value));
        content.append(panel, dl);
    };

    const renderModelInfo = (current: Pt2Model): void => {
        const rows: Array<[string, string]> = [
            [t('pt2.info.model'), current.name],
            [t('pt2.info.torchVersion'), current.torchVersion || '—'],
            [t('pt2.info.schemaVersion'), current.schemaVersion || '—'],
            [t('pt2.info.opsets'), current.opsets.map(item => `${item.label}=${item.value}`).join(', ') || '—'],
            [t('pt2.info.verifiers'), current.verifiers.join(', ') || '—'],
            [t('pt2.info.nodes'), String(current.nodeCount)],
            [t('pt2.info.values'), String(current.graph.values.length)],
            [t('pt2.info.parameters'), String(current.parameterCount)],
            [t('pt2.info.weightBytes'), formatFileSize(current.weightBytes)],
            [t('pt2.info.sampleInputs'), current.sampleInputs ? `${current.sampleInputs.name} (${formatFileSize(current.sampleInputs.size)})` : '—']
        ];
        for (const constraint of current.rangeConstraints) rows.push([`${t('pt2.info.rangeConstraint')}: ${constraint.symbol}`, `[${constraint.min}, ${constraint.max}]`]);
        current.guards.forEach((guard, index) => rows.push([`${t('pt2.info.guard')} ${index + 1}`, guard]));
        for (const operator of current.operators) rows.push([`${t('pt2.info.operator')}: ${operator.op}`, String(operator.count)]);
        for (const item of current.metadata) rows.push([item.label, item.value]);
        renderDefinitionList(t('pt2.modelInfo'), rows);
    };

    const renderArchive = (): void => {
        const rows: Array<[string, string]> = [
            [t('pt2.info.layout'), t(pkg.layout === 'legacy' ? 'pt2.layout.legacy' : 'pt2.layout.pt2')],
            [t('pt2.info.fileSize'), pkg.fileSize],
            [t('pt2.info.prefix'), pkg.prefix || '—'],
            ['archive_format', pkg.archiveFormat || '—'],
            ['archive_version', pkg.archiveVersion || '—'],
            ['byteorder', pkg.byteorder || '—'],
            ['serialization_id', pkg.serializationId || '—'],
            ['.data/version', pkg.dataVersion || '—'],
            [t('pt2.info.models'), pkg.models.map(item => item.name).join(', ') || '—']
        ];
        for (const aoti of pkg.aotInductor) {
            rows.push([`${t('pt2.info.aotInductor')}: ${aoti.name || '—'}`, aoti.files.map(file => file.name.split('/').pop()).join(', ')]);
            for (const item of aoti.metadata) rows.push([`${aoti.name || 'aoti'} · ${item.label}`, item.value]);
        }
        renderDefinitionList(t('pt2.archive'), rows);
        if (pkg.extras.length) {
            content.append(element('h2', 'omni-pt2__section', t('pt2.extraFiles')));
            for (const extra of pkg.extras.slice(0, MAX_INSPECTOR_ITEMS)) {
                if (!queryMatches([extra.name, extra.text])) continue;
                const block = element('div', 'omni-pt2__attribute');
                block.style.margin = '8px 13px';
                block.append(element('b', undefined, `${extra.name} · ${formatFileSize(extra.size)}`));
                if (extra.text) block.append(element('pre', undefined, extra.text));
                content.append(block);
            }
        }
        content.append(element('h2', 'omni-pt2__section', t('pt2.files')));
        const q = query();
        const result = collectRows(pkg.files, file => !q || textMatches(q, file.name, file.category, file.method),
            file => [file.name, t(`pt2.category.${file.category}`), formatFileSize(file.size), formatFileSize(file.compressedSize), file.method]);
        renderTable(t('pt2.files'), ['pt2.column.path', 'pt2.column.category', 'pt2.column.fileSize', 'pt2.column.compressedSize', 'pt2.column.method'].map(key => t(key)), result.rows, result.total);
    };

    // ── Graph ─────────────────────────────────────────────────────────────

    const buildCards = (current: Pt2Model): { cards: Card[]; edges: Array<[string, string, boolean]>; totalCards: number } => {
        const graph = current.graph;
        const cards: Card[] = [];
        const byValue = new Map<string, Card>();
        const nodeCards = new Map<Pt2Node, Card>();
        let total = 0;
        const take = (): boolean => { total++; return cards.length < MAX_GRAPH_NODES; };
        // Placeholders first, in signature order; lifted parameters and constants
        // are moved beside their first consumer once node depths are known.
        for (const input of graph.inputs) {
            const name = input.refs[0];
            if (!name) continue;
            if (!take()) continue;
            const spec = specsByArg.get(name);
            const kind = kindOf(spec);
            const value = valuesByName.get(name);
            const card: Card = {
                id: `value:${name}`, kind,
                title: spec?.target || name,
                detail: value ? `${t(`pt2.kind.${spec?.kind ?? 'user_input'}`)} · ${valueSummary(name)}` : t(`pt2.kind.${spec?.kind ?? 'user_input'}`),
                selection: { kind: 'value', name }, depth: 0
            };
            cards.push(card);
            byValue.set(name, card);
        }
        const depths = new Map<Card, number>();
        for (const node of graph.nodes) {
            if (!take()) continue;
            let depth = 0;
            for (const input of node.inputs) for (const ref of input.refs) {
                const source = byValue.get(ref);
                if (!source) continue;
                const sourceDepth = depths.get(source) ?? (source.kind === 'input' ? 0 : -1);
                depth = Math.max(depth, sourceDepth + 1);
            }
            const card: Card = {
                id: `node:${node.index}`, kind: node.namespace === 'higher_order' ? 'hop' : 'node',
                title: node.name, detail: `${node.op} · ${outputSummary(node)}`,
                selection: { kind: 'node', node }, depth
            };
            depths.set(card, depth);
            cards.push(card);
            nodeCards.set(node, card);
            for (const output of node.outputs) for (const ref of output.refs) if (!byValue.has(ref)) byValue.set(ref, card);
        }
        // A parameter sits one column before the shallowest node that reads it.
        for (const card of cards) {
            if (card.selection.kind !== 'value' || card.kind === 'input') continue;
            const readers = consumers.get(card.selection.name) ?? [];
            const depth = Math.min(...readers.map(node => nodeCards.get(node)?.depth ?? Number.POSITIVE_INFINITY));
            card.depth = Number.isFinite(depth) ? Math.max(0, depth - 1) : 0;
        }
        graph.outputs.forEach((output, index) => {
            const name = output.refs[0];
            if (!take()) return;
            const source = name ? byValue.get(name) : undefined;
            cards.push({
                id: `output:${index}`, kind: 'output', title: output.text,
                detail: name ? valueSummary(name) : t('pt2.kind.user_output'),
                selection: { kind: 'output', argument: output }, depth: (source?.depth ?? -1) + 1
            });
        });
        const edges: Array<[string, string, boolean]> = [];
        for (const node of graph.nodes) {
            const target = nodeCards.get(node);
            if (!target) continue;
            const seen = new Set<string>();
            for (const input of node.inputs) for (const ref of input.refs) {
                const source = byValue.get(ref);
                if (!source || source === target || seen.has(source.id)) continue;
                seen.add(source.id);
                edges.push([source.id, target.id, false]);
            }
        }
        for (const card of cards) {
            if (card.selection.kind !== 'output') continue;
            const name = card.selection.argument.refs[0];
            const source = name ? byValue.get(name) : undefined;
            if (source) edges.push([source.id, card.id, true]);
        }
        return { cards, edges, totalCards: total };
    };

    const renderGraph = (current: Pt2Model): void => {
        const layout = element('div', 'omni-pt2__graph-layout');
        const scroll = element('div', 'omni-pt2__graph-scroll');
        const inspector = element('aside', 'omni-pt2__inspector');
        const { cards, edges, totalCards } = buildCards(current);
        const maxDepth = Math.max(0, ...cards.map(card => card.depth));
        const rankIndex = new Map<number, number>();
        const positions = new Map<string, { x: number; y: number }>();
        for (const card of cards) {
            const index = rankIndex.get(card.depth) ?? 0;
            rankIndex.set(card.depth, index + 1);
            positions.set(card.id, { x: 20 + card.depth * COLUMN_GAP, y: 20 + index * ROW_GAP });
        }
        const width = Math.max(720, (maxDepth + 1) * COLUMN_GAP + 40);
        const height = Math.max(420, Math.max(1, ...rankIndex.values()) * ROW_GAP + 40);
        const canvas = element('div', 'omni-pt2__canvas');
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'omni-pt2__edges'); svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));

        let edgeCount = 0;
        let edgesOmitted = false;
        for (const [from, to, toOutput] of edges) {
            const source = positions.get(from);
            const target = positions.get(to);
            if (!source || !target) continue;
            if (edgeCount >= MAX_GRAPH_EDGES) { edgesOmitted = true; break; }
            svg.append(graphEdge(source.x + CARD_WIDTH, source.y + 27, target.x, target.y + 27, toOutput));
            edgeCount++;
        }
        canvas.append(svg);

        for (const card of cards) {
            const position = positions.get(card.id)!;
            const button = element('button', `omni-pt2__node omni-pt2__node--${card.kind}`) as HTMLButtonElement;
            button.type = 'button'; button.style.left = `${position.x}px`; button.style.top = `${position.y}px`;
            button.title = `${card.title}\n${card.detail}`;
            graphSearchCards.set(button, card);
            button.append(element('strong', undefined, card.title), element('small', undefined, card.detail));
            button.onclick = () => {
                selection = card.selection;
                renderInspector(inspector);
                canvas.querySelectorAll('.omni-pt2__node--selected').forEach(item => item.classList.remove('omni-pt2__node--selected'));
                button.classList.add('omni-pt2__node--selected');
            };
            if (selection && sameSelection(selection, card.selection)) button.classList.add('omni-pt2__node--selected');
            canvas.append(button);
        }
        if (totalCards > cards.length) scroll.append(element('div', 'omni-pt2__graph-limit', t('pt2.graphLimited', { shown: cards.length, total: totalCards })));
        if (edgesOmitted) scroll.append(element('div', 'omni-pt2__graph-limit', t('pt2.graphEdgesLimited', { count: MAX_GRAPH_EDGES })));
        if (cards.length === 0) scroll.append(element('div', 'omni-pt2__empty', t('pt2.emptyGraph')));
        scroll.append(canvas);
        renderInspector(inspector);
        layout.append(scroll, inspector);
        content.append(layout);
        applyGraphSearch(canvas);
    };

    const appendChips = (parent: HTMLElement, label: string, values: string[]): void => {
        parent.append(element('h3', undefined, label));
        const chips = element('div', 'omni-pt2__chips');
        if (values.length === 0) chips.append(element('span', 'omni-pt2__chip', '—'));
        for (const value of values.slice(0, MAX_INSPECTOR_ITEMS)) { const chip = element('span', 'omni-pt2__chip', value); chip.title = value; chips.append(chip); }
        if (values.length > MAX_INSPECTOR_ITEMS) chips.append(element('span', 'omni-pt2__chip', t('pt2.moreItems', { count: values.length - MAX_INSPECTOR_ITEMS })));
        parent.append(chips);
    };
    const appendAttributes = (parent: HTMLElement, label: string, entries: Pt2Entry[]): void => {
        if (!entries.length) return;
        parent.append(element('h3', undefined, label));
        for (const entry of entries.slice(0, MAX_INSPECTOR_ITEMS)) {
            const row = element('div', 'omni-pt2__attribute');
            row.append(element('b', undefined, entry.label), element('div', undefined, entry.value || '—'));
            parent.append(row);
        }
        if (entries.length > MAX_INSPECTOR_ITEMS) parent.append(element('div', 'omni-pt2__attribute', t('pt2.moreItems', { count: entries.length - MAX_INSPECTOR_ITEMS })));
    };
    const valueEntries = (value: Pt2Value | undefined): Pt2Entry[] => {
        if (!value) return [];
        if (value.kind !== 'tensor') return [{ label: t('pt2.column.kind'), value: value.kind }, { label: t('pt2.column.detail'), value: value.detail || '—' }];
        return [
            { label: t('pt2.column.dtype'), value: value.dtype || '—' },
            { label: t('pt2.column.shape'), value: value.shape.join(' × ') || t('pt2.scalar') },
            { label: t('pt2.inspector.strides'), value: value.strides.join(', ') || '—' },
            { label: t('pt2.inspector.storageOffset'), value: value.storageOffset || '0' },
            { label: t('pt2.inspector.device'), value: value.device || '—' },
            { label: t('pt2.inspector.layout'), value: value.layout || '—' },
            { label: t('pt2.inspector.requiresGrad'), value: value.requiresGrad ? 'True' : 'False' }
        ];
    };
    const consumerChips = (name: string): string[] =>
        (consumers.get(name) ?? []).map(node => `→ ${node.name} (${node.op})`);

    const renderInspector = (inspector: HTMLElement): void => {
        inspector.replaceChildren();
        const current = selection;
        if (!current) { inspector.append(element('div', 'omni-pt2__empty', t('pt2.selectNode'))); return; }
        if (current.kind === 'node') {
            const node = current.node;
            inspector.append(
                element('div', 'omni-pt2__inspector-kind', node.target),
                element('h2', undefined, node.name),
                element('div', undefined, `${t('pt2.column.index')} ${node.index}${node.module ? ` · ${t('pt2.column.module')} ${node.module}` : ''}`)
            );
            appendChips(inspector, t('pt2.inspector.inputs'), node.inputs.map(input => {
                const producer = input.refs.map(ref => producers.get(ref)?.name ?? (specsByArg.get(ref) ? specsByArg.get(ref)!.target || ref : '')).filter(Boolean);
                return `${argumentText(input)}${input.kind === 'keyword' ? ' (kw)' : ''}${producer.length ? ` ← ${previewList(producer, 4)}` : ''}`;
            }));
            appendChips(inspector, t('pt2.inspector.outputs'), node.outputs.map(output => {
                const name = output.refs[0];
                const targets = name ? (consumers.get(name) ?? []).map(item => item.name) : [];
                return `${output.text}${name ? `: ${valueSummary(name)}` : ''}${targets.length ? ` → ${previewList(targets, 6)}` : ''}`;
            }));
            if (node.subgraphs.length) {
                inspector.append(element('h3', undefined, t('pt2.inspector.subgraphs')));
                for (const subgraph of node.subgraphs.slice(0, MAX_INSPECTOR_ITEMS)) {
                    const row = element('div', 'omni-pt2__attribute');
                    row.append(element('b', undefined, t('pt2.inspector.subgraph', { name: subgraph.name, nodes: subgraph.graph.nodes.length, inputs: subgraph.graph.inputs.length, outputs: subgraph.graph.outputs.length })));
                    const chips = element('div', 'omni-pt2__chips');
                    for (const inner of subgraph.graph.nodes.slice(0, MAX_INSPECTOR_ITEMS)) { const chip = element('span', 'omni-pt2__chip', `${inner.name} · ${inner.op}`); chip.title = inner.inputs.map(argumentText).join(', '); chips.append(chip); }
                    if (subgraph.graph.nodes.length > MAX_INSPECTOR_ITEMS) chips.append(element('span', 'omni-pt2__chip', t('pt2.moreItems', { count: subgraph.graph.nodes.length - MAX_INSPECTOR_ITEMS })));
                    row.append(chips);
                    inspector.append(row);
                }
            }
            if (node.moduleStack.length) appendChips(inspector, t('pt2.inspector.moduleStack'), node.moduleStack.map(frame => `${frame.fqn || t('pt2.rootModule')} · ${frame.className.split('.').pop() || frame.className}`));
            appendAttributes(inspector, t('pt2.inspector.metadata'), node.metadata);
            if (node.stackTrace) {
                inspector.append(element('h3', undefined, t('pt2.inspector.stackTrace')));
                inspector.append(element('pre', undefined, node.stackTrace));
            }
            return;
        }
        if (current.kind === 'output') {
            const argument = current.argument;
            const name = argument.refs[0];
            const spec = model?.outputSpecs.find(item => item.arg === name);
            inspector.append(
                element('div', 'omni-pt2__inspector-kind', t(`pt2.kind.${spec?.kind ?? 'user_output'}`)),
                element('h2', undefined, argument.text)
            );
            if (spec?.target) inspector.append(element('div', undefined, `${t('pt2.column.target')} ${spec.target}`));
            appendAttributes(inspector, t('pt2.inspector.value'), name ? valueEntries(valuesByName.get(name)) : []);
            const producer = name ? producers.get(name) : undefined;
            appendChips(inspector, t('pt2.inspector.producer'), producer ? [`← ${producer.name} (${producer.op})`] : []);
            return;
        }
        const name = current.name;
        const spec = specsByArg.get(name);
        const payload = payloadsByPlaceholder.get(name);
        inspector.append(
            element('div', 'omni-pt2__inspector-kind', t(`pt2.kind.${spec?.kind ?? 'user_input'}`)),
            element('h2', undefined, spec?.target || name),
            element('div', undefined, `${t('pt2.column.placeholder')} ${name}`)
        );
        appendAttributes(inspector, t('pt2.inspector.value'), valueEntries(valuesByName.get(name)));
        if (payload) {
            inspector.append(element('h3', undefined, t('pt2.inspector.payload')));
            const chips = element('div', 'omni-pt2__chips');
            chips.append(element('span', 'omni-pt2__chip', payload.path || '—'), element('span', 'omni-pt2__chip', t(`pt2.status.${payload.status}`)));
            if (payload.fileSize !== null) chips.append(element('span', 'omni-pt2__chip', t('pt2.inspector.fileSize', { size: formatFileSize(payload.fileSize) })));
            if (payload.bytes) chips.append(element('span', 'omni-pt2__chip', t('pt2.inspector.tensorBytes', { size: formatFileSize(payload.bytes) })));
            inspector.append(chips);
            if (payload.preview.length) {
                const values = element('div', 'omni-pt2__attribute');
                values.append(element('b', undefined, t('pt2.inspector.preview', { count: payload.preview.length })), element('div', undefined, payload.preview.join(', ')));
                inspector.append(values);
            }
        }
        if (spec?.kind === 'buffer') inspector.append(element('div', 'omni-pt2__attribute', t(spec.persistent === false ? 'pt2.nonPersistent' : 'pt2.persistent')));
        appendChips(inspector, t('pt2.inspector.consumers'), consumerChips(name));
    };

    const applyGraphSearch = (canvas: HTMLElement): void => {
        const q = query();
        canvas.querySelectorAll<HTMLElement>('.omni-pt2__node').forEach(button => {
            const card = graphSearchCards.get(button);
            const matches = card ? cardMatchesSearch(card, q) : false;
            button.classList.toggle('omni-pt2__node--dim', Boolean(q) && !matches);
        });
    };
    const cardMatchesSearch = (card: Card, q: string): boolean => {
        if (!q) return true;
        if (card.selection.kind === 'node') return nodeMatchesSearch(card.selection.node, q);
        if (card.selection.kind === 'value') {
            const payload = payloadsByPlaceholder.get(card.selection.name);
            return textMatches(q, card.title, card.detail, card.selection.name) || (payload !== undefined && payloadMatchesSearch(payload, q));
        }
        return textMatches(q, card.title, card.detail);
    };

    on(search, 'input', () => {
        if (activeTab === 'graph' && model) { const canvas = content.querySelector<HTMLElement>('.omni-pt2__canvas'); if (canvas) applyGraphSearch(canvas); }
        else renderContent();
    });
    on(modelSelect, 'change', () => {
        model = pkg.models.find(item => item.name === modelSelect.value) ?? model;
        indexModel();
        renderContent();
    });
    on(copy, 'click', () => {
        if (!ctx.clipboard) return;
        void ctx.clipboard.writeText(JSON.stringify(pkg, null, 2)).then(() => {
            if (disposed) return;
            copy.textContent = t('common.copied');
            if (resetTimer !== undefined) clearTimeout(resetTimer);
            resetTimer = setTimeout(() => { if (!disposed) copy.textContent = t('pt2.copyJson'); }, 1200);
        }).catch(error => ctx.logger.log('error', `PT2 copy failed: ${error instanceof Error ? error.message : String(error)}`));
    });
    renderTabs();
    renderContent();

    return {
        dispose(): void {
            disposed = true;
            if (resetTimer !== undefined) clearTimeout(resetTimer);
            disposers.splice(0).forEach(dispose => dispose());
            frame.remove(); style?.remove();
            if (!(root instanceof ShadowRoot)) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--pt2');
        }
    };
}

function sameSelection(a: Selection, b: Selection): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'node' && b.kind === 'node') return a.node === b.node;
    if (a.kind === 'value' && b.kind === 'value') return a.name === b.name;
    if (a.kind === 'output' && b.kind === 'output') return a.argument === b.argument;
    return false;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
    const list = map.get(key);
    if (list) list.push(value); else map.set(key, [value]);
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

function textMatches(query: string, ...values: Array<string | number>): boolean {
    return values.some(value => String(value).toLowerCase().includes(query));
}

function payloadMatchesSearch(payload: Pt2Payload, query: string): boolean {
    return textMatches(query, payload.name, payload.kind, payload.placeholder, payload.dtype, payload.path, payload.status, payload.device, ...payload.shape, ...payload.preview);
}

function nodeMatchesSearch(node: Pt2Node, query: string, depth = 0): boolean {
    return !query || textMatches(query, node.name, node.target, node.op, node.module, node.stackTrace) ||
        node.inputs.some(input => textMatches(query, input.name, input.text)) ||
        node.outputs.some(output => textMatches(query, output.text)) ||
        node.metadata.some(item => textMatches(query, item.label, item.value)) ||
        node.moduleStack.some(frame => textMatches(query, frame.fqn, frame.className)) ||
        (depth < 8 && node.subgraphs.some(subgraph => textMatches(query, subgraph.name) || subgraph.graph.nodes.some(inner => nodeMatchesSearch(inner, query, depth + 1))));
}

function graphEdge(x1: number, y1: number, x2: number, y2: number, output: boolean): SVGPathElement {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const bend = Math.max(28, (x2 - x1) / 2);
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    path.setAttribute('class', `omni-pt2__edge${output ? ' omni-pt2__edge--output' : ''}`);
    return path;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
