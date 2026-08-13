import type { ClipboardService, HostContext } from '../../host/index.js';
import {
    parseTflite,
    type TfliteDocument,
    type TfliteOperator,
    type TfliteSubgraph,
    type TfliteTensor
} from '../../parsers/tflite/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { tfliteViewerCss } from './styles.js';

export { tfliteViewerCss } from './styles.js';

export const TFLITE_VIEWER_META = {
    id: 'tflite',
    displayNameKey: 'tflite.title',
    extensions: ['tflite', 'lite'],
    priority: 20,
    requiredServices: [] as const,
    optionalServices: ['clipboard'] as const,
    inputOwnership: 'borrows' as const
};

export type TfliteViewerContext = HostContext & { clipboard?: ClipboardService };

export async function mountTfliteViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: TfliteViewerContext,
    options: MountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const model = parseTflite(input.data);
    if (options.signal?.aborted) throw new MountAbortedError();
    return mountTfliteDocument(model, input.fileName, container, ctx, options);
}

type TabId = 'graph' | 'operators' | 'tensors' | 'io' | 'buffers' | 'model';
type Selection = { kind: 'operator'; operator: TfliteOperator } | { kind: 'tensor'; tensor: TfliteTensor };

const MAX_GRAPH_NODES = 240;
const MAX_GRAPH_CARDS = 400;
const MAX_GRAPH_OUTPUT_CARDS = 64;
const MAX_GRAPH_EDGES = 800;
const MAX_TABLE_ROWS = 2000;
const MAX_INSPECTOR_ITEMS = 64;

export function mountTfliteDocument(
    model: TfliteDocument,
    fileName: string,
    container: HTMLElement,
    ctx: TfliteViewerContext,
    options: MountOptions = {}
): ViewerHandle {
    if (options.signal?.aborted) throw new MountAbortedError();
    let root: HTMLElement | ShadowRoot = container;
    let style: HTMLStyleElement | undefined;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && container.attachShadow) {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        style = element('style');
        style.textContent = tfliteViewerCss;
        root.append(style);
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--tflite');
    }

    const runtime = model.minRuntimeVersion ? ctx.i18n.t('tflite.runtime', { version: model.minRuntimeVersion }) : ctx.i18n.t('tflite.schema', { version: model.version });
    const frame = element('div', 'omni-tflite');
    const header = element('header', 'omni-tflite__header');
    const heading = element('div');
    heading.append(
        element('div', 'omni-tflite__eyebrow', 'TFLITE'),
        element('h1', undefined, fileName),
        element('div', 'omni-tflite__subtitle', `${model.title || ctx.i18n.t('tflite.title')} · ${model.fileSize} · ${runtime}`)
    );
    header.append(heading);

    const summary = element('section', 'omni-tflite__summary');
    for (const item of model.summary) {
        const card = element('div', 'omni-tflite__summary-item');
        card.append(element('div', 'omni-tflite__summary-value', String(item.value)), element('div', 'omni-tflite__summary-label', ctx.i18n.t(item.labelKey)));
        summary.append(card);
    }

    const toolbar = element('div', 'omni-tflite__toolbar');
    const search = element('input', 'omni-tflite__search') as HTMLInputElement;
    search.type = 'search';
    search.placeholder = ctx.i18n.t('tflite.search');
    search.setAttribute('aria-label', ctx.i18n.t('tflite.search'));
    const subgraphPicker = element('select', 'omni-tflite__subgraphs') as HTMLSelectElement;
    subgraphPicker.setAttribute('aria-label', ctx.i18n.t('tflite.subgraph'));
    model.subgraphs.forEach(subgraph => {
        const option = element('option', undefined, `${subgraph.index}: ${subgraph.name || ctx.i18n.t('tflite.unnamed')}`) as HTMLOptionElement;
        option.value = String(subgraph.index);
        subgraphPicker.append(option);
    });
    subgraphPicker.hidden = model.subgraphs.length < 2;
    const tabs = element('div', 'omni-tflite__tabs');
    const copy = element('button', undefined, ctx.i18n.t('tflite.copyJson')) as HTMLButtonElement;
    copy.type = 'button';
    if (!ctx.clipboard) { copy.disabled = true; copy.title = ctx.i18n.t('common.noClipboard'); }
    toolbar.append(search, subgraphPicker, tabs, copy);

    const warnings = element('section', 'omni-tflite__warnings');
    warnings.setAttribute('role', 'status');
    for (const warning of model.warnings) warnings.append(element('div', undefined, ctx.i18n.t(warning.key, warning.args)));
    warnings.hidden = model.warnings.length === 0;
    const content = element('main', 'omni-tflite__content');
    frame.append(header, summary, toolbar, warnings, content);
    root.append(frame);

    const tabItems: Array<[TabId, string]> = [
        ['graph', ctx.i18n.t('tflite.graph')], ['operators', ctx.i18n.t('tflite.operators')],
        ['tensors', ctx.i18n.t('tflite.tensors')], ['io', ctx.i18n.t('tflite.io')],
        ['buffers', ctx.i18n.t('tflite.buffers')], ['model', ctx.i18n.t('tflite.modelInfo')]
    ];
    const empty: TfliteSubgraph = { index: 0, name: '', tensors: [], operators: [], inputs: [], outputs: [] };
    let activeTab: TabId = 'graph';
    let activeSubgraph = model.subgraphs[0] ?? empty;
    let selected: Selection | undefined = activeSubgraph.operators[0] ? { kind: 'operator', operator: activeSubgraph.operators[0] } : undefined;
    let disposed = false;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    const cardSelections = new WeakMap<HTMLElement, Selection>();
    const disposers: Array<() => void> = [];
    const on = (target: EventTarget, type: string, listener: EventListener): void => {
        target.addEventListener(type, listener);
        disposers.push(() => target.removeEventListener(type, listener));
    };

    const tensorAt = (index: number): TfliteTensor | undefined => index >= 0 ? activeSubgraph.tensors[index] : undefined;
    const tensorLabel = (index: number): string => {
        if (index < 0) return ctx.i18n.t('tflite.optional');
        const tensor = tensorAt(index);
        return tensor ? tensor.name || `#${index}` : `#${index}`;
    };
    // A shapeless tensor is a scalar only when the model says its rank is
    // known; otherwise the shape is genuinely undeclared (dynamic-shape models).
    const shapeLabel = (tensor: TfliteTensor): string =>
        tensor.shape.join(' × ') || ctx.i18n.t(tensor.hasRank ? 'tflite.scalar' : 'tflite.unknownRank');
    const tensorDetail = (tensor: TfliteTensor): string => `${tensor.type}[${shapeLabel(tensor)}]`;
    /** The fields the tensors table searches, so both tabs answer alike. */
    const tensorSearchText = (tensor: TfliteTensor): string =>
        `#${tensor.index} ${tensor.quantization?.summary ?? ''} ${ctx.i18n.t(`tflite.storage.${tensor.location}`)}`;

    const showSubgraph = (index: number): void => {
        const next = model.subgraphs[index];
        if (!next) return;
        activeSubgraph = next;
        subgraphPicker.value = String(index);
        selected = next.operators[0] ? { kind: 'operator', operator: next.operators[0] } : undefined;
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
        else if (activeTab === 'operators') renderOperatorTable();
        else if (activeTab === 'tensors') renderTensorTable();
        else if (activeTab === 'io') renderIoTable();
        else if (activeTab === 'buffers') renderBufferTable();
        else renderModelInfo();
    };

    const query = (): string => search.value.trim().toLowerCase();
    const queryMatches = (values: unknown[]): boolean => {
        const needle = query();
        return !needle || values.some(value => String(value).toLowerCase().includes(needle));
    };

    const operatorMatches = (operator: TfliteOperator, needle: string): boolean =>
        !needle || textMatches(needle, operator.operator, operator.optionsType, operator.index, operator.version) ||
        operator.options.some(option => textMatches(needle, option.name, option.value)) ||
        [...operator.inputs, ...operator.outputs].some(index => textMatches(needle, tensorLabel(index)));

    const renderOperatorTable = (): void => {
        const needle = query();
        const result = collectRows(activeSubgraph.operators, operator => operatorMatches(operator, needle), operator => [
            operator.index,
            operator.operator,
            operator.custom ? ctx.i18n.t('tflite.kind.custom') : ctx.i18n.t('tflite.kind.builtin'),
            operator.version,
            previewItems(operator.inputs, tensorLabel),
            previewItems(operator.outputs, tensorLabel),
            operator.optionsType || '—',
            previewItems(operator.options, option => `${option.name}=${option.value}`) ||
                (operator.custom ? ctx.i18n.t('tflite.customBytes', { bytes: operator.customOptionsBytes }) : '—')
        ]);
        renderTable(
            ctx.i18n.t('tflite.operators'),
            ['tflite.column.index', 'tflite.column.operator', 'tflite.column.kind', 'tflite.column.version', 'tflite.column.inputs', 'tflite.column.outputs', 'tflite.column.optionsType', 'tflite.column.options'].map(key => ctx.i18n.t(key)),
            result.rows,
            result.total
        );
    };

    const renderTensorTable = (): void => {
        const result = collectRows(activeSubgraph.tensors, tensor => queryMatches([
            tensor.index, tensor.name, tensor.type, shapeLabel(tensor), tensor.quantization?.summary ?? '',
            ctx.i18n.t(`tflite.storage.${tensor.location}`)
        ]), tensor => [
            tensor.index,
            tensor.name || '—',
            tensor.type,
            shapeLabel(tensor),
            tensor.elementCount || '—',
            formatByteCount(tensor.dataBytes),
            ctx.i18n.t(`tflite.storage.${tensor.location}`),
            tensor.quantization?.summary || '—',
            tensor.isVariable ? ctx.i18n.t('tflite.variable') : '—'
        ]);
        renderTable(
            ctx.i18n.t('tflite.tensors'),
            ['tflite.column.index', 'tflite.column.name', 'tflite.column.type', 'tflite.column.shape', 'tflite.column.elements', 'tflite.column.dataSize', 'tflite.column.storage', 'tflite.column.quantization', 'tflite.column.variable'].map(key => ctx.i18n.t(key)),
            result.rows,
            result.total
        );
    };

    const renderIoTable = (): void => {
        const records: Array<Array<string | number>> = [];
        let total = 0;
        const append = (row: Array<string | number>): void => {
            if (!queryMatches(row)) return;
            total++;
            if (records.length < MAX_TABLE_ROWS) records.push(row);
        };
        const describe = (index: number): string => {
            const tensor = tensorAt(index);
            return tensor ? tensorDetail(tensor) : '—';
        };
        for (const index of activeSubgraph.inputs) append([ctx.i18n.t('tflite.kind.input'), '—', tensorLabel(index), describe(index), index]);
        for (const index of activeSubgraph.outputs) append([ctx.i18n.t('tflite.kind.output'), '—', tensorLabel(index), describe(index), index]);
        for (const signature of model.signatures) {
            if (signature.subgraphIndex !== activeSubgraph.index) continue;
            for (const entry of signature.inputs) append([ctx.i18n.t('tflite.kind.signatureInput'), `${signature.key}.${entry.name}`, entry.tensorName || tensorLabel(entry.tensorIndex), describe(entry.tensorIndex), entry.tensorIndex]);
            for (const entry of signature.outputs) append([ctx.i18n.t('tflite.kind.signatureOutput'), `${signature.key}.${entry.name}`, entry.tensorName || tensorLabel(entry.tensorIndex), describe(entry.tensorIndex), entry.tensorIndex]);
        }
        renderTable(
            ctx.i18n.t('tflite.io'),
            ['tflite.column.kind', 'tflite.column.signature', 'tflite.column.name', 'tflite.column.typeShape', 'tflite.column.tensorIndex'].map(key => ctx.i18n.t(key)),
            records,
            total
        );
    };

    const renderBufferTable = (): void => {
        // Every user is kept: the preview needs the true count for its remainder,
        // and search must reach a tensor past the eighth one sharing a buffer.
        const users = new Map<number, string[]>();
        for (const subgraph of model.subgraphs) {
            for (const tensor of subgraph.tensors) {
                const list = users.get(tensor.buffer) ?? [];
                list.push(tensor.name || `#${tensor.index}`);
                users.set(tensor.buffer, list);
            }
        }
        const result = collectRows(model.buffers, buffer => queryMatches([
            buffer.index, formatByteCount(buffer.size), ctx.i18n.t(`tflite.storage.${buffer.location}`), ...(users.get(buffer.index) ?? [])
        ]), buffer => [
            buffer.index,
            formatByteCount(buffer.size),
            ctx.i18n.t(`tflite.storage.${buffer.location}`),
            buffer.location === 'appended' ? buffer.offset : '—',
            previewItems(users.get(buffer.index) ?? [], name => name, 8) || '—'
        ]);
        renderTable(
            ctx.i18n.t('tflite.buffers'),
            ['tflite.column.index', 'tflite.column.dataSize', 'tflite.column.storage', 'tflite.column.fileOffset', 'tflite.column.usedBy'].map(key => ctx.i18n.t(key)),
            result.rows,
            result.total
        );
    };

    const renderModelInfo = (): void => {
        const rows: Array<[string, string]> = [
            [ctx.i18n.t('tflite.info.description'), model.description || '—'],
            [ctx.i18n.t('tflite.info.schemaVersion'), model.version],
            [ctx.i18n.t('tflite.info.identifier'), model.identifier || '—'],
            [ctx.i18n.t('tflite.info.minRuntime'), model.minRuntimeVersion || '—'],
            [ctx.i18n.t('tflite.info.fileSize'), model.fileSize],
            [ctx.i18n.t('tflite.info.weights'), formatByteCount(model.weightBytes)],
            [ctx.i18n.t('tflite.info.subgraphs'), model.subgraphs.map(subgraph => `${subgraph.index}: ${subgraph.name || ctx.i18n.t('tflite.unnamed')} (${subgraph.operators.length})`).join(', ') || '—'],
            [ctx.i18n.t('tflite.info.signatures'), model.signatures.map(signature => `${signature.key} → #${signature.subgraphIndex}`).join(', ') || '—']
        ];
        for (const code of model.operatorCodes) {
            rows.push([
                `${ctx.i18n.t('tflite.info.operatorCode')} ${code.index}`,
                `${code.name} · ${code.custom ? ctx.i18n.t('tflite.kind.custom') : ctx.i18n.t('tflite.kind.builtin')} ${code.builtinCode} · v${code.version}`
            ]);
        }
        for (const entry of model.metadata) {
            rows.push([`${ctx.i18n.t('tflite.info.metadata')}: ${entry.name}`, entry.text || ctx.i18n.t('tflite.binaryBuffer', { bytes: formatByteCount(entry.size), buffer: entry.buffer })]);
        }
        const visible: Array<[string, string]> = [];
        let total = 0;
        for (const row of rows) {
            if (!queryMatches(row)) continue;
            total++;
            if (visible.length < MAX_TABLE_ROWS) visible.push(row);
        }
        const panel = element('div', 'omni-tflite__panel-header');
        panel.append(element('h2', undefined, ctx.i18n.t('tflite.modelInfo')), element('span', undefined, ctx.i18n.t('tflite.rows', { shown: visible.length, total })));
        const list = element('dl', 'omni-tflite__model-info');
        for (const [key, value] of visible) list.append(element('dt', undefined, key), element('dd', undefined, value));
        content.append(panel, list);
    };

    const renderTable = (title: string, headers: string[], rows: Array<Array<string | number>>, total: number): void => {
        const visible = rows.slice(0, MAX_TABLE_ROWS);
        const panel = element('div', 'omni-tflite__panel-header');
        panel.append(element('h2', undefined, title), element('span', undefined, ctx.i18n.t('tflite.rows', { shown: visible.length, total })));
        const wrap = element('div', 'omni-tflite__table-wrap');
        const table = element('table');
        const head = element('thead');
        const headRow = element('tr');
        for (const label of headers) headRow.append(element('th', undefined, label));
        head.append(headRow);
        const body = element('tbody');
        for (const row of visible) {
            const rowElement = element('tr');
            for (const cell of row) { const td = element('td', undefined, String(cell)); td.title = String(cell); rowElement.append(td); }
            body.append(rowElement);
        }
        table.append(head, body);
        wrap.append(table);
        content.append(panel, wrap);
        if (rows.length === 0) content.append(element('div', 'omni-tflite__empty', ctx.i18n.t('tflite.noMatches')));
    };

    const renderGraph = (): void => {
        const layout = element('div', 'omni-tflite__graph-layout');
        const scroll = element('div', 'omni-tflite__graph-scroll');
        const inspector = element('aside', 'omni-tflite__inspector');
        const shownOperators = activeSubgraph.operators.slice(0, MAX_GRAPH_NODES);
        const positions = graphPositions(shownOperators);
        const maxDepth = Math.max(0, ...positions.map(item => item.depth));
        const ranks = new Map<number, number>();
        for (const item of positions) ranks.set(item.depth, (ranks.get(item.depth) ?? 0) + 1);

        const graphInputs = new Set(activeSubgraph.inputs);
        // Sources are counted over *every* operator so the "showing X of Y"
        // total does not shrink when the operator list is truncated.
        const usedTensors = new Set<number>();
        for (const operator of activeSubgraph.operators) for (const index of operator.inputs) if (index >= 0) usedTensors.add(index);
        const sourceTensors = activeSubgraph.tensors.filter(tensor =>
            graphInputs.has(tensor.index) || (tensor.location !== 'empty' && usedTensors.has(tensor.index)));
        const wiredTensors = new Set<number>();
        for (const operator of shownOperators) for (const index of operator.inputs) if (index >= 0) wiredTensors.add(index);

        const remainingAfterOperators = Math.max(0, MAX_GRAPH_CARDS - shownOperators.length);
        // A repeated output index would otherwise stack cards at one position.
        const outputTensors = [...new Set(activeSubgraph.outputs)];
        const shownOutputs = outputTensors.slice(0, Math.min(MAX_GRAPH_OUTPUT_CARDS, remainingAfterOperators));
        const sourceBudget = Math.max(0, remainingAfterOperators - shownOutputs.length);
        // Sources that actually wire to a drawn operator get the budget first.
        const shownSources: TfliteTensor[] = [];
        const collectSources = (wired: boolean): void => {
            for (const tensor of sourceTensors) {
                if (shownSources.length >= sourceBudget) return;
                if (wiredTensors.has(tensor.index) === wired) shownSources.push(tensor);
            }
        };
        collectSources(true);
        collectSources(false);
        const totalCards = activeSubgraph.operators.length + sourceTensors.length + outputTensors.length;
        const shownCards = shownOperators.length + shownSources.length + shownOutputs.length;

        const width = Math.max(720, (maxDepth + 3) * 220);
        const height = Math.max(420, Math.max(...ranks.values(), shownSources.length, shownOutputs.length, 1) * 86 + 40);
        const canvas = element('div', 'omni-tflite__canvas');
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'omni-tflite__edges');
        svg.setAttribute('width', String(width));
        svg.setAttribute('height', String(height));

        const cardPositions = new Map<string, { x: number; y: number }>();
        const producer = new Map<number, string>();
        const sourceCards = new Map<number, string>();
        shownSources.forEach((tensor, index) => {
            cardPositions.set(`tensor-${tensor.index}`, { x: 20, y: 20 + index * 86 });
            sourceCards.set(tensor.index, `tensor-${tensor.index}`);
        });
        const rankIndex = new Map<number, number>();
        positions.forEach(item => {
            const index = rankIndex.get(item.depth) ?? 0;
            rankIndex.set(item.depth, index + 1);
            cardPositions.set(item.operator.id, { x: 220 + item.depth * 220, y: 20 + index * 86 });
            for (const output of item.operator.outputs) if (output >= 0) producer.set(output, item.operator.id);
        });
        shownOutputs.forEach((tensorIndex, index) => cardPositions.set(`output-${tensorIndex}`, { x: (maxDepth + 2) * 220, y: 20 + index * 86 }));

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
            for (const input of item.operator.inputs) {
                if (input < 0) continue;
                connect(producer.get(input) ?? sourceCards.get(input), item.operator.id, false);
            }
        }
        for (const tensorIndex of shownOutputs) connect(producer.get(tensorIndex) ?? sourceCards.get(tensorIndex), `output-${tensorIndex}`, true);
        canvas.append(svg);

        const addCard = (id: string, title: string, detail: string, kind: string, selection?: Selection, extraSearch = ''): void => {
            const position = cardPositions.get(id);
            if (!position) return;
            const button = element('button', `omni-tflite__node omni-tflite__node--${kind}`) as HTMLButtonElement;
            button.type = 'button';
            button.style.left = `${position.x}px`;
            button.style.top = `${position.y}px`;
            button.dataset.search = `${title} ${detail} ${extraSearch}`.toLowerCase();
            if (selection) cardSelections.set(button, selection);
            button.append(element('strong', undefined, title || '—'), element('small', undefined, detail));
            button.onclick = () => {
                if (!selection) return;
                selected = selection;
                renderInspector(inspector);
                canvas.querySelectorAll('.omni-tflite__node--selected').forEach(item => item.classList.remove('omni-tflite__node--selected'));
                button.classList.add('omni-tflite__node--selected');
            };
            canvas.append(button);
        };
        for (const tensor of shownSources) {
            addCard(`tensor-${tensor.index}`, tensor.name || `#${tensor.index}`, tensorDetail(tensor),
                graphInputs.has(tensor.index) ? 'input' : 'constant', { kind: 'tensor', tensor }, tensorSearchText(tensor));
        }
        for (const item of positions) {
            addCard(item.operator.id, item.operator.operator, ctx.i18n.t('tflite.opDetail', { index: item.operator.index, version: item.operator.version }),
                item.operator.custom ? 'custom' : 'node', { kind: 'operator', operator: item.operator });
        }
        for (const tensorIndex of shownOutputs) {
            const tensor = tensorAt(tensorIndex);
            addCard(`output-${tensorIndex}`, tensorLabel(tensorIndex), tensor ? tensorDetail(tensor) : '—', 'output',
                tensor ? { kind: 'tensor', tensor } : undefined, tensor ? tensorSearchText(tensor) : '');
        }
        if (totalCards > shownCards) scroll.append(element('div', 'omni-tflite__graph-limit', ctx.i18n.t('tflite.graphLimited', { shown: shownCards, total: totalCards })));
        if (edgesOmitted) scroll.append(element('div', 'omni-tflite__graph-limit', ctx.i18n.t('tflite.graphEdgesLimited', { count: MAX_GRAPH_EDGES })));
        scroll.append(canvas);
        renderInspector(inspector);
        layout.append(scroll, inspector);
        content.append(layout);
        applyGraphSearch(canvas);
    };

    const renderInspector = (inspector: HTMLElement): void => {
        inspector.replaceChildren();
        if (!selected) { inspector.append(element('div', 'omni-tflite__empty', ctx.i18n.t('tflite.selectNode'))); return; }
        if (selected.kind === 'tensor') { renderTensorInspector(inspector, selected.tensor); return; }
        const operator = selected.operator;
        inspector.append(
            element('div', 'omni-tflite__inspector-kind', operator.custom ? ctx.i18n.t('tflite.kind.custom') : ctx.i18n.t('tflite.kind.builtin')),
            element('h2', undefined, operator.operator),
            element('div', undefined, ctx.i18n.t('tflite.opDetail', { index: operator.index, version: operator.version }))
        );
        appendTensorChips(inspector, ctx.i18n.t('tflite.inspector.inputs'), operator.inputs);
        appendTensorChips(inspector, ctx.i18n.t('tflite.inspector.outputs'), operator.outputs);
        if (operator.intermediates.length) appendTensorChips(inspector, ctx.i18n.t('tflite.inspector.intermediates'), operator.intermediates);
        if (operator.options.length) {
            inspector.append(element('h3', undefined, `${ctx.i18n.t('tflite.inspector.options')}${operator.optionsType ? ` · ${operator.optionsType}` : ''}`));
            for (const option of operator.options.slice(0, MAX_INSPECTOR_ITEMS)) {
                const row = element('div', 'omni-tflite__attribute');
                row.append(element('b', undefined, option.name), element('div', undefined, option.value));
                inspector.append(row);
            }
            if (operator.options.length > MAX_INSPECTOR_ITEMS) inspector.append(element('div', 'omni-tflite__attribute', ctx.i18n.t('tflite.moreItems', { count: operator.options.length - MAX_INSPECTOR_ITEMS })));
        } else if (operator.optionsType) {
            inspector.append(element('h3', undefined, ctx.i18n.t('tflite.inspector.options')), element('div', 'omni-tflite__attribute', operator.optionsType));
        }
        if (operator.custom || operator.customOptionsBytes !== '0') {
            inspector.append(
                element('h3', undefined, ctx.i18n.t('tflite.inspector.customOptions')),
                element('div', 'omni-tflite__attribute', `${ctx.i18n.t('tflite.customBytes', { bytes: operator.customOptionsBytes })} · ${operator.customOptionsFormat}`)
            );
        }
        if (operator.subgraphRefs.length) {
            inspector.append(element('h3', undefined, ctx.i18n.t('tflite.inspector.subgraphs')));
            for (const index of operator.subgraphRefs) {
                const target = model.subgraphs[index];
                const link = element('button', 'omni-tflite__link', `#${index} ${target?.name || ctx.i18n.t('tflite.unnamed')}`) as HTMLButtonElement;
                link.type = 'button';
                link.disabled = !target;
                link.onclick = () => showSubgraph(index);
                inspector.append(link);
            }
        }
    };

    const renderTensorInspector = (inspector: HTMLElement, tensor: TfliteTensor): void => {
        inspector.append(
            element('div', 'omni-tflite__inspector-kind', ctx.i18n.t(`tflite.storage.${tensor.location}`)),
            element('h2', undefined, tensor.name || `#${tensor.index}`),
            element('div', undefined, tensorDetail(tensor))
        );
        const facts: Array<[string, string]> = [
            [ctx.i18n.t('tflite.column.index'), String(tensor.index)],
            [ctx.i18n.t('tflite.column.elements'), tensor.elementCount || '—'],
            [ctx.i18n.t('tflite.column.dataSize'), formatByteCount(tensor.dataBytes)],
            [ctx.i18n.t('tflite.info.expectedSize'), tensor.expectedBytes ? formatByteCount(tensor.expectedBytes) : '—'],
            [ctx.i18n.t('tflite.column.buffer'), String(tensor.buffer)]
        ];
        if (tensor.shapeSignature.length) facts.push([ctx.i18n.t('tflite.info.shapeSignature'), tensor.shapeSignature.join(' × ')]);
        if (tensor.isVariable) facts.push([ctx.i18n.t('tflite.column.variable'), ctx.i18n.t('tflite.variable')]);
        for (const [label, value] of facts) {
            const row = element('div', 'omni-tflite__attribute');
            row.append(element('b', undefined, label), element('div', undefined, value));
            inspector.append(row);
        }
        if (tensor.quantization) {
            inspector.append(element('h3', undefined, ctx.i18n.t('tflite.column.quantization')));
            const quantization = element('div', 'omni-tflite__attribute');
            quantization.append(element('b', undefined, tensor.quantization.summary || '—'));
            // The remainder comes from the declared count, not the capped array,
            // so a per-channel tensor reports how many scales it really has.
            if (tensor.quantization.scale.length) {
                quantization.append(element('div', undefined,
                    `scale: ${previewItems(tensor.quantization.scale, String, 16, tensor.quantization.scaleCount)}`));
            }
            if (tensor.quantization.zeroPoint.length) {
                quantization.append(element('div', undefined,
                    `zero: ${previewItems(tensor.quantization.zeroPoint, value => value, 16, tensor.quantization.zeroPointCount)}`));
            }
            inspector.append(quantization);
        }
        if (tensor.sparsity) {
            const sparsity = tensor.sparsity;
            inspector.append(element('h3', undefined, ctx.i18n.t('tflite.info.sparsity')));
            const row = element('div', 'omni-tflite__attribute');
            row.append(element('div', undefined,
                `${ctx.i18n.t('tflite.info.traversalOrder')}: ${previewItems(sparsity.traversalOrder, String, 16, sparsity.traversalOrderCount) || '—'}`));
            if (sparsity.blockMapCount) {
                row.append(element('div', undefined,
                    `${ctx.i18n.t('tflite.info.blockMap')}: ${previewItems(sparsity.blockMap, String, 16, sparsity.blockMapCount)}`));
            }
            for (const dimension of sparsity.dimensions.slice(0, 8)) {
                const segments = previewItems(dimension.arraySegments, String, 8, dimension.arraySegmentCount);
                row.append(element('div', undefined,
                    `${dimension.format} · ${dimension.denseSize}${segments ? ` · ${segments}` : ''}`));
            }
            if (sparsity.dimensionCount > 8) {
                row.append(element('div', undefined, ctx.i18n.t('tflite.moreItems', { count: sparsity.dimensionCount - 8 })));
            }
            inspector.append(row);
        }
    };

    const appendTensorChips = (parent: HTMLElement, label: string, indices: number[]): void => {
        parent.append(element('h3', undefined, label));
        const chips = element('div', 'omni-tflite__chips');
        for (const index of indices.slice(0, MAX_INSPECTOR_ITEMS)) {
            const tensor = tensorAt(index);
            const chip = element('span', 'omni-tflite__chip', tensorLabel(index));
            chip.title = tensor ? `${tensor.name} · ${tensorDetail(tensor)}` : tensorLabel(index);
            chips.append(chip);
        }
        if (indices.length > MAX_INSPECTOR_ITEMS) chips.append(element('span', 'omni-tflite__chip', ctx.i18n.t('tflite.moreItems', { count: indices.length - MAX_INSPECTOR_ITEMS })));
        parent.append(chips);
    };

    const applyGraphSearch = (canvas: HTMLElement): void => {
        const needle = query();
        canvas.querySelectorAll<HTMLElement>('.omni-tflite__node').forEach(card => {
            const selection = cardSelections.get(card);
            const matches = selection?.kind === 'operator'
                ? operatorMatches(selection.operator, needle)
                : card.dataset.search?.includes(needle);
            card.classList.toggle('omni-tflite__node--dim', Boolean(needle) && !matches);
        });
    };

    on(search, 'input', () => {
        if (activeTab === 'graph') { const canvas = content.querySelector<HTMLElement>('.omni-tflite__canvas'); if (canvas) applyGraphSearch(canvas); }
        else renderContent();
    });
    on(subgraphPicker, 'change', () => showSubgraph(Number(subgraphPicker.value)));
    on(copy, 'click', () => {
        if (!ctx.clipboard) return;
        void ctx.clipboard.writeText(JSON.stringify(model, null, 2)).then(() => {
            if (disposed) return;
            copy.textContent = ctx.i18n.t('common.copied');
            if (resetTimer !== undefined) clearTimeout(resetTimer);
            resetTimer = setTimeout(() => { if (!disposed) copy.textContent = ctx.i18n.t('tflite.copyJson'); }, 1200);
        }).catch(error => ctx.logger.log('error', `TFLite copy failed: ${error instanceof Error ? error.message : String(error)}`));
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
            if (!(root instanceof ShadowRoot)) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--tflite');
        }
    };
}

/** Longest-path depth per operator, using the tensor that produced each input. */
function graphPositions(operators: TfliteOperator[]): Array<{ operator: TfliteOperator; depth: number }> {
    const outputDepth = new Map<number, number>();
    return operators.map(operator => {
        let depth = 0;
        for (const input of operator.inputs) {
            if (input < 0) continue;
            depth = Math.max(depth, (outputDepth.get(input) ?? -1) + 1);
        }
        for (const output of operator.outputs) if (output >= 0) outputDepth.set(output, depth);
        return { operator, depth };
    });
}

function collectRows<T>(
    items: T[],
    matches: (item: T) => boolean,
    toRow: (item: T) => Array<string | number>
): { rows: Array<Array<string | number>>; total: number } {
    const rows: Array<Array<string | number>> = [];
    let total = 0;
    for (const item of items) {
        if (!matches(item)) continue;
        total++;
        if (rows.length < MAX_TABLE_ROWS) rows.push(toRow(item));
    }
    return { rows, total };
}

/** `total` defaults to the array length, but may exceed it when the parser
 *  already capped the list — the remainder must reflect the declared count. */
function previewItems<T>(items: T[], format: (item: T) => string, limit = 20, total = items.length): string {
    const shown = Math.min(limit, items.length);
    const visible = items.slice(0, shown).map(format).join(', ');
    return total > shown ? `${visible}, … (+${total - shown})` : visible;
}

function textMatches(query: string, ...values: Array<string | number>): boolean {
    return values.some(value => String(value).toLowerCase().includes(query));
}

function graphEdge(x1: number, y1: number, x2: number, y2: number, output: boolean): SVGPathElement {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const bend = Math.max(28, (x2 - x1) / 2);
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    path.setAttribute('class', `omni-tflite__edge${output ? ' omni-tflite__edge--output' : ''}`);
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
