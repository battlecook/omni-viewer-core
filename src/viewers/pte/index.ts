import type { ClipboardService, HostContext } from '../../host/index.js';
import {
    parsePte,
    type PteDocument,
    type PteInstruction,
    type PteMethod,
    type PteSegment,
    type PteValue
} from '../../parsers/pte/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { pteViewerCss } from './styles.js';

export { formatFileSize, parsePte, PteParseError } from '../../parsers/pte/index.js';
export type {
    PteAllocation,
    PteChain,
    PteCompileSpec,
    PteDelegate,
    PteDocument,
    PteExtendedHeader,
    PteFrame,
    PteInstruction,
    PteInstructionKind,
    PteMethod,
    PteNamedData,
    PteOperator,
    PteSegment,
    PteSegmentKind,
    PteSummaryItem,
    PteTensor,
    PteTensorStorage,
    PteValue,
    PteValueKind,
    PteWarning
} from '../../parsers/pte/index.js';
export { pteViewerCss } from './styles.js';

export const PTE_VIEWER_META = {
    id: 'pte',
    displayNameKey: 'pte.title',
    extensions: ['pte'] as string[],
    priority: 20,
    requiredServices: [] as const,
    optionalServices: ['clipboard'] as const,
    inputOwnership: 'borrows' as const
};

export type PteViewerContext = HostContext & { clipboard?: ClipboardService };

export async function mountPteViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: PteViewerContext,
    options: MountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const model = parsePte(input.data);
    if (options.signal?.aborted) throw new MountAbortedError();
    return mountPteDocument(model, input.fileName, container, ctx, options);
}

type TabId = 'graph' | 'instructions' | 'values' | 'io' | 'delegates' | 'segments' | 'model';
type Selection = { kind: 'instruction'; instruction: PteInstruction } | { kind: 'value'; value: PteValue };

const MAX_GRAPH_NODES = 240;
const MAX_GRAPH_CARDS = 400;
const MAX_GRAPH_OUTPUT_CARDS = 64;
const MAX_GRAPH_EDGES = 800;
const MAX_TABLE_ROWS = 2000;
const MAX_INSPECTOR_ITEMS = 64;
const GRAPH_NODE_KINDS = new Set<PteInstruction['kind']>(['KernelCall', 'DelegateCall', 'MoveCall']);

export function mountPteDocument(
    model: PteDocument,
    fileName: string,
    container: HTMLElement,
    ctx: PteViewerContext,
    options: MountOptions = {}
): ViewerHandle {
    if (options.signal?.aborted) throw new MountAbortedError();
    let root: HTMLElement | ShadowRoot = container;
    let style: HTMLStyleElement | undefined;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && container.attachShadow) {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        style = element('style');
        style.textContent = pteViewerCss;
        root.append(style);
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--pte');
    }

    const subtitleParts = [model.title || ctx.i18n.t('pte.title'), model.fileSize, ctx.i18n.t('pte.schema', { version: model.version })];
    if (model.backends.length) subtitleParts.push(model.backends.join(', '));
    const frame = element('div', 'omni-pte');
    const header = element('header', 'omni-pte__header');
    const heading = element('div');
    heading.append(
        element('div', 'omni-pte__eyebrow', 'EXECUTORCH'),
        element('h1', undefined, fileName),
        element('div', 'omni-pte__subtitle', subtitleParts.join(' · '))
    );
    header.append(heading);

    const summary = element('section', 'omni-pte__summary');
    for (const item of model.summary) {
        const card = element('div', 'omni-pte__summary-item');
        card.append(element('div', 'omni-pte__summary-value', String(item.value)), element('div', 'omni-pte__summary-label', ctx.i18n.t(item.labelKey)));
        summary.append(card);
    }

    const toolbar = element('div', 'omni-pte__toolbar');
    const search = element('input', 'omni-pte__search') as HTMLInputElement;
    search.type = 'search';
    search.placeholder = ctx.i18n.t('pte.search');
    search.setAttribute('aria-label', ctx.i18n.t('pte.search'));
    const methodPicker = element('select', 'omni-pte__methods') as HTMLSelectElement;
    methodPicker.setAttribute('aria-label', ctx.i18n.t('pte.method'));
    model.methods.forEach(method => {
        const option = element('option', undefined, `${method.index}: ${method.name || ctx.i18n.t('pte.unnamed')}`) as HTMLOptionElement;
        option.value = String(method.index);
        methodPicker.append(option);
    });
    methodPicker.hidden = model.methods.length < 2;
    const tabs = element('div', 'omni-pte__tabs');
    const copy = element('button', undefined, ctx.i18n.t('pte.copyJson')) as HTMLButtonElement;
    copy.type = 'button';
    if (!ctx.clipboard) { copy.disabled = true; copy.title = ctx.i18n.t('common.noClipboard'); }
    toolbar.append(search, methodPicker, tabs, copy);

    const warnings = element('section', 'omni-pte__warnings');
    warnings.setAttribute('role', 'status');
    for (const warning of model.warnings) warnings.append(element('div', undefined, ctx.i18n.t(warning.key, warning.args)));
    warnings.hidden = model.warnings.length === 0;
    const content = element('main', 'omni-pte__content');
    frame.append(header, summary, toolbar, warnings, content);
    root.append(frame);

    const tabItems: Array<[TabId, string]> = [
        ['graph', ctx.i18n.t('pte.graph')], ['instructions', ctx.i18n.t('pte.instructions')],
        ['values', ctx.i18n.t('pte.values')], ['io', ctx.i18n.t('pte.io')],
        ['delegates', ctx.i18n.t('pte.delegates')], ['segments', ctx.i18n.t('pte.segments')],
        ['model', ctx.i18n.t('pte.modelInfo')]
    ];
    const empty: PteMethod = {
        index: 0, name: '', values: [], inputs: [], outputs: [], chains: [], instructions: [], operators: [], delegates: [],
        nonConstBufferSizes: [], inputSpec: '', outputSpec: '', tensorCount: 0, constantCount: 0
    };
    let activeTab: TabId = 'graph';
    let activeMethod = model.methods[0] ?? empty;
    const firstNode = (method: PteMethod): PteInstruction | undefined => method.instructions.find(instruction => GRAPH_NODE_KINDS.has(instruction.kind));
    let selected: Selection | undefined = firstNode(activeMethod) ? { kind: 'instruction', instruction: firstNode(activeMethod)! } : undefined;
    /** Card the selection was made from, so a value drawn twice (input that is also an output) lights one card. */
    let selectedCard: string | undefined;
    let disposed = false;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    const cardSelections = new WeakMap<HTMLElement, Selection>();
    const disposers: Array<() => void> = [];
    const on = (target: EventTarget, type: string, listener: EventListener): void => {
        target.addEventListener(type, listener);
        disposers.push(() => target.removeEventListener(type, listener));
    };

    const valueAt = (index: number): PteValue | undefined => index >= 0 ? activeMethod.values[index] : undefined;
    const valueLabel = (index: number): string => {
        if (index < 0) return ctx.i18n.t('pte.none');
        const value = valueAt(index);
        return value?.tensor?.name || `#${index}`;
    };
    const shapeLabel = (value: PteValue): string => value.tensor ? `${value.tensor.scalarType}[${value.tensor.sizes.join(' × ') || ctx.i18n.t('pte.scalar')}]` : value.preview;
    /** Type + shape for tensors, the kind and rendered value otherwise. */
    const valueDetail = (value: PteValue): string => value.tensor ? shapeLabel(value) : `${value.kind} ${value.preview}`;
    const storageLabel = (value: PteValue): string => value.tensor ? ctx.i18n.t(`pte.storage.${value.tensor.storage}`) : '—';
    const memoryLabel = (value: PteValue): string => {
        const tensor = value.tensor;
        if (!tensor?.allocation) return '—';
        const slot = `mem${tensor.allocation.memoryId} + ${tensor.allocation.memoryOffset}`;
        return tensor.aliasOf === undefined ? slot : `${slot} = #${tensor.aliasOf}`;
    };
    const isConstant = (value: PteValue): boolean =>
        !!value.tensor && value.tensor.storage !== 'planned' && value.tensor.storage !== 'runtime';
    const kindLabel = (instruction: PteInstruction): string => ctx.i18n.t(`pte.kind.${instruction.kind}`);
    const instructionDetail = (instruction: PteInstruction): string =>
        ctx.i18n.t('pte.instructionDetail', { index: instruction.index, chain: instruction.chain });
    /** `destination` counts within its chain; the tables index instructions across all chains. */
    const jumpTarget = (instruction: PteInstruction): string => {
        let flat = instruction.destination;
        let count = -1;
        for (const chain of activeMethod.chains) {
            if (chain.index === instruction.chain) { count = chain.instructionCount; break; }
            flat += chain.instructionCount;
        }
        // The runtime runs `while (index < size)`, so a destination one past
        // the last instruction ends the chain — a legal target that names no
        // instruction. Anything else outside the chain is malformed, and a
        // flattened index for it would point at an unrelated row.
        if (instruction.destination === count) return ctx.i18n.t('pte.jumpEnd');
        return instruction.destination >= 0 && instruction.destination < count
            ? ctx.i18n.t('pte.jumpTo', { index: flat })
            : ctx.i18n.t('pte.jumpInvalid', { index: instruction.destination });
    };
    /** The fields the values table searches, so both tabs answer alike. */
    const valueSearchText = (value: PteValue): string =>
        `#${value.index} ${value.kind} ${value.preview} ${value.tensor?.elementCount ?? ''} ` +
        `${value.tensor?.dataBytes ? formatByteCount(value.tensor.dataBytes) : ''} ${storageLabel(value)} ${memoryLabel(value)}`;

    const showMethod = (index: number): void => {
        const next = model.methods[index];
        if (!next) return;
        activeMethod = next;
        sourceCache.clear();
        methodPicker.value = String(index);
        const node = firstNode(next);
        selected = node ? { kind: 'instruction', instruction: node } : undefined;
        selectedCard = undefined;
        renderContent();
    };

    // Built once: rebuilding the buttons on activation would drop keyboard
    // focus from the tab just pressed.
    const tabButtons = new Map<TabId, HTMLButtonElement>();
    const renderTabs = (): void => {
        if (tabButtons.size === 0) {
            for (const [id, label] of tabItems) {
                const button = element('button', undefined, label);
                button.type = 'button';
                button.onclick = () => { activeTab = id; renderTabs(); renderContent(); };
                tabButtons.set(id, button);
                tabs.append(button);
            }
        }
        for (const [id, button] of tabButtons) button.setAttribute('aria-pressed', String(activeTab === id));
    };

    const renderContent = (): void => {
        content.replaceChildren();
        if (activeTab === 'graph') renderGraph();
        else if (activeTab === 'instructions') renderInstructionTable();
        else if (activeTab === 'values') renderValueTable();
        else if (activeTab === 'io') renderIoTable();
        else if (activeTab === 'delegates') renderDelegateTable();
        else if (activeTab === 'segments') renderSegmentTable();
        else renderModelInfo();
    };

    const query = (): string => search.value.trim().toLowerCase();
    const queryMatches = (values: unknown[]): boolean => {
        const needle = query();
        return !needle || values.some(value => String(value).toLowerCase().includes(needle));
    };

    // Operands are searched up to the inspector's cap: a kernel returning a
    // list of thousands of tensors must not make every keystroke walk them all.
    const instructionMatches = (instruction: PteInstruction, needle: string): boolean =>
        !needle || textMatches(needle, instruction.label, instruction.kind, kindLabel(instruction), instruction.index, instruction.chain, instructionDetail(instruction)) ||
        instruction.inputs.slice(0, MAX_INSPECTOR_ITEMS).some(index => textMatches(needle, valueLabel(index))) ||
        instruction.outputs.slice(0, MAX_INSPECTOR_ITEMS).some(index => textMatches(needle, valueLabel(index)));

    const renderInstructionTable = (): void => {
        const needle = query();
        const result = collectRenderedRows(activeMethod.instructions, instruction => [
            instruction.index,
            instruction.chain,
            kindLabel(instruction),
            instruction.kind === 'KernelCall' || instruction.kind === 'DelegateCall' ? instruction.label
                : instruction.kind === 'JumpFalseCall' ? jumpTarget(instruction) : '—',
            previewItems(instruction.inputs, valueLabel),
            previewItems(instruction.outputs, valueLabel) || '—',
            instruction.args.length
        ], (instruction, row) => instructionMatches(instruction, needle) || queryMatches(row));
        renderTable(
            ctx.i18n.t('pte.instructions'),
            ['pte.column.index', 'pte.column.chain', 'pte.column.kind', 'pte.column.target', 'pte.column.inputs', 'pte.column.outputs', 'pte.column.args'].map(key => ctx.i18n.t(key)),
            result.rows,
            result.total
        );
    };

    const renderValueTable = (): void => {
        const result = collectRenderedRows(activeMethod.values, value => [
            value.index,
            value.kind,
            value.tensor?.name || '—',
            value.tensor ? shapeLabel(value) : value.preview,
            value.tensor?.elementCount || '—',
            value.tensor?.dataBytes ? formatByteCount(value.tensor.dataBytes) : '—',
            storageLabel(value),
            memoryLabel(value)
        ], (value, row) => queryMatches([`#${value.index}`, ...row]));
        renderTable(
            ctx.i18n.t('pte.values'),
            ['pte.column.index', 'pte.column.kind', 'pte.column.name', 'pte.column.typeShape', 'pte.column.elements', 'pte.column.dataSize', 'pte.column.storage', 'pte.column.memory'].map(key => ctx.i18n.t(key)),
            result.rows,
            result.total
        );
    };

    const renderIoTable = (): void => {
        const records: Array<Array<string | number>> = [];
        let total = 0;
        const append = (kind: string, index: number): void => {
            const value = valueAt(index);
            const row: Array<string | number> = [kind, index, valueLabel(index), value ? valueDetail(value) : '—', value ? storageLabel(value) : '—'];
            if (!queryMatches(row)) return;
            total++;
            if (records.length < MAX_TABLE_ROWS) records.push(row);
        };
        for (const index of activeMethod.inputs) append(ctx.i18n.t('pte.kind.input'), index);
        for (const index of activeMethod.outputs) append(ctx.i18n.t('pte.kind.output'), index);
        renderTable(
            ctx.i18n.t('pte.io'),
            ['pte.column.kind', 'pte.column.valueIndex', 'pte.column.name', 'pte.column.typeShape', 'pte.column.storage'].map(key => ctx.i18n.t(key)),
            records,
            total
        );
    };

    const renderDelegateTable = (): void => {
        const result = collectRenderedRows(activeMethod.delegates, delegate => [
            delegate.index,
            delegate.id || '—',
            ctx.i18n.t(`pte.location.${delegate.location}`),
            delegate.dataIndex,
            delegate.dataBytes ? formatByteCount(delegate.dataBytes) : '—',
            delegate.fileOffset || '—',
            previewItems(delegate.compileSpecs, spec => `${spec.key}=${spec.value || ctx.i18n.t('pte.binaryBytes', { bytes: spec.bytes })}`) || '—'
        ], (delegate, row) => queryMatches(row) || delegate.compileSpecs.some(spec => queryMatches([spec.key, spec.value])));
        renderTable(
            ctx.i18n.t('pte.delegates'),
            ['pte.column.index', 'pte.column.backend', 'pte.column.location', 'pte.column.dataIndex', 'pte.column.dataSize', 'pte.column.fileOffset', 'pte.column.compileSpecs'].map(key => ctx.i18n.t(key)),
            result.rows,
            result.total
        );
    };

    const renderSegmentTable = (): void => {
        const segmentStatus = (segment: PteSegment): string =>
            segment.fileOffset ? ctx.i18n.t(segment.inRange ? 'pte.inRange' : 'pte.outOfRange') : ctx.i18n.t('pte.unlocated');
        const result = collectRenderedRows(model.segments, segment => [
            segment.index,
            ctx.i18n.t(`pte.segment.${segment.kind}`),
            segment.offset,
            segment.fileOffset || '—',
            formatByteCount(segment.size),
            segmentStatus(segment),
            previewItems(segment.usedBy, name => name, 8) || '—'
            // Every user is kept for the search, not just the eight shown.
        ], (segment, row) => queryMatches(row) || queryMatches(segment.usedBy));
        renderTable(
            ctx.i18n.t('pte.segments'),
            ['pte.column.index', 'pte.column.kind', 'pte.column.offset', 'pte.column.fileOffset', 'pte.column.dataSize', 'pte.column.status', 'pte.column.usedBy'].map(key => ctx.i18n.t(key)),
            result.rows,
            result.total
        );
    };

    const renderModelInfo = (): void => {
        const rows: Array<[string, string]> = [
            [ctx.i18n.t('pte.info.identifier'), model.identifier || '—'],
            [ctx.i18n.t('pte.info.schemaVersion'), model.version],
            [ctx.i18n.t('pte.info.fileSize'), model.fileSize],
            [ctx.i18n.t('pte.info.extendedHeader'), model.extendedHeader
                ? ctx.i18n.t('pte.info.headerDetail', { program: formatByteCount(model.extendedHeader.programSize), base: model.extendedHeader.segmentBaseOffset, data: model.extendedHeader.segmentDataSize ? formatByteCount(model.extendedHeader.segmentDataSize) : '—' })
                : ctx.i18n.t('pte.info.noHeader')],
            [ctx.i18n.t('pte.info.constants'), `${formatByteCount(model.constantBytes)}${model.constantBufferCount ? ` · ${ctx.i18n.t('pte.info.inlineBuffers', { count: model.constantBufferCount })}` : ''}`],
            [ctx.i18n.t('pte.info.delegateData'), formatByteCount(model.delegateBytes)],
            [ctx.i18n.t('pte.info.backends'), model.backends.join(', ') || '—'],
            [ctx.i18n.t('pte.info.methods'), model.methods.map(method => `${method.index}: ${method.name || ctx.i18n.t('pte.unnamed')} (${method.instructions.length})`).join(', ') || '—'],
            [ctx.i18n.t('pte.info.namedData'), model.namedData.length
                ? `${formatByteCount(model.namedDataBytes)} · ${model.namedData.map(entry => `${entry.key} → #${entry.segmentIndex}`).join(', ')}`
                : '—'],
            [ctx.i18n.t('pte.info.memoryPlan'), activeMethod.nonConstBufferSizes.map((size, index) => `mem${index}: ${formatByteCount(size)}`).join(', ') || '—'],
            [ctx.i18n.t('pte.info.inputSpec'), activeMethod.inputSpec || '—'],
            [ctx.i18n.t('pte.info.outputSpec'), activeMethod.outputSpec || '—']
        ];
        for (const operator of activeMethod.operators) rows.push([`${ctx.i18n.t('pte.info.operator')} ${operator.index}`, operator.label]);
        const visible: Array<[string, string]> = [];
        let total = 0;
        for (const row of rows) {
            if (!queryMatches(row)) continue;
            total++;
            if (visible.length < MAX_TABLE_ROWS) visible.push(row);
        }
        const panel = element('div', 'omni-pte__panel-header');
        panel.append(element('h2', undefined, ctx.i18n.t('pte.modelInfo')), element('span', undefined, ctx.i18n.t('pte.rows', { shown: visible.length, total })));
        const list = element('dl', 'omni-pte__model-info');
        for (const [key, value] of visible) list.append(element('dt', undefined, key), element('dd', undefined, value));
        content.append(panel, list);
    };

    const renderTable = (title: string, headers: string[], rows: Array<Array<string | number>>, total: number): void => {
        const visible = rows.slice(0, MAX_TABLE_ROWS);
        const panel = element('div', 'omni-pte__panel-header');
        panel.append(element('h2', undefined, title), element('span', undefined, ctx.i18n.t('pte.rows', { shown: visible.length, total })));
        const wrap = element('div', 'omni-pte__table-wrap');
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
        if (rows.length === 0) content.append(element('div', 'omni-pte__empty', ctx.i18n.t('pte.noMatches')));
    };

    /**
     * Tensor producers behind an argument: the value itself, or a list's items.
     * Memoized per method: a long list named by many arguments of many calls
     * would otherwise be re-expanded once per mention.
     */
    const sourceCache = new Map<number, number[]>();
    /**
     * An alias reads another value's bytes, so its producer is that value's.
     * The parser stores terminal aliases; the walk is insurance for a document
     * built by hand and is bounded so a cyclic one cannot hang the viewer.
     */
    const rootOf = (index: number): number => {
        let at = index;
        for (let hop = 0; hop < 8; hop++) {
            const next = valueAt(at)?.tensor?.aliasOf;
            if (next === undefined || next === at) break;
            at = next;
        }
        return at;
    };
    const sourcesOf = (index: number): number[] => {
        let sources = sourceCache.get(index);
        if (!sources) {
            const value = valueAt(index);
            sources = value?.items ? [...new Set(value.items.filter(item => item >= 0).map(rootOf))] : index >= 0 ? [rootOf(index)] : [];
            sourceCache.set(index, sources);
        }
        return sources;
    };
    /** Distinct argument indices, so a repeated argument is expanded once. */
    const distinct = (indices: number[]): number[] => indices.length > 1 ? [...new Set(indices)] : indices;

    const renderGraph = (): void => {
        const layout = element('div', 'omni-pte__graph-layout');
        const scroll = element('div', 'omni-pte__graph-scroll');
        const inspector = element('aside', 'omni-pte__inspector');
        const nodes = activeMethod.instructions.filter(instruction => GRAPH_NODE_KINDS.has(instruction.kind));
        const shownNodes = nodes.slice(0, MAX_GRAPH_NODES);
        const positions = graphPositions(shownNodes, sourcesOf);
        const maxDepth = Math.max(0, ...positions.map(item => item.depth));
        const ranks = new Map<number, number>();
        for (const item of positions) ranks.set(item.depth, (ranks.get(item.depth) ?? 0) + 1);

        const graphInputs = new Set(activeMethod.inputs);
        // Sources are counted over *every* node so the "showing X of Y" total
        // does not shrink when the node list is truncated.
        // Each argument index is expanded once across all nodes: a list read
        // by thousands of calls must not be walked once per call.
        const usedValues = new Set<number>();
        const expandedUsed = new Set<number>();
        for (const instruction of nodes) for (const index of instruction.inputs) {
            if (expandedUsed.has(index)) continue;
            expandedUsed.add(index);
            for (const source of sourcesOf(index)) usedValues.add(source);
        }
        // Method inputs come first so a weight-heavy method cannot crowd them
        // out of the card budget.
        // Deduped like the outputs below: a repeated index would stack cards.
        const sourceValues = [
            ...[...new Set(activeMethod.inputs)].map(index => valueAt(index)).filter((value): value is PteValue => !!value),
            ...activeMethod.values.filter(value => !graphInputs.has(value.index) && isConstant(value) && usedValues.has(value.index))
        ];
        const wiredValues = new Set<number>();
        const expandedWired = new Set<number>();
        for (const instruction of shownNodes) for (const index of instruction.inputs) {
            if (expandedWired.has(index)) continue;
            expandedWired.add(index);
            for (const source of sourcesOf(index)) wiredValues.add(source);
        }

        const remainingAfterNodes = Math.max(0, MAX_GRAPH_CARDS - shownNodes.length);
        // A repeated output index would otherwise stack cards at one position.
        const outputValues = [...new Set(activeMethod.outputs)];
        const shownOutputs = outputValues.slice(0, Math.min(MAX_GRAPH_OUTPUT_CARDS, remainingAfterNodes));
        const sourceBudget = Math.max(0, remainingAfterNodes - shownOutputs.length);
        // Sources that actually wire to a drawn node get the budget first.
        const shownSources: PteValue[] = [];
        const collectSources = (wired: boolean): void => {
            for (const value of sourceValues) {
                if (shownSources.length >= sourceBudget) return;
                if (wiredValues.has(value.index) === wired) shownSources.push(value);
            }
        };
        collectSources(true);
        collectSources(false);
        const totalCards = nodes.length + sourceValues.length + outputValues.length;
        const shownCards = shownNodes.length + shownSources.length + shownOutputs.length;

        const width = Math.max(720, (maxDepth + 3) * 220);
        const height = Math.max(420, Math.max(...ranks.values(), shownSources.length, shownOutputs.length, 1) * 86 + 40);
        const canvas = element('div', 'omni-pte__canvas');
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'omni-pte__edges');
        svg.setAttribute('width', String(width));
        svg.setAttribute('height', String(height));

        const cardPositions = new Map<string, { x: number; y: number }>();
        const producer = new Map<number, string>();
        const sourceCards = new Map<number, string>();
        shownSources.forEach((value, index) => {
            cardPositions.set(`value-${value.index}`, { x: 20, y: 20 + index * 86 });
            sourceCards.set(value.index, `value-${value.index}`);
        });
        const rankIndex = new Map<number, number>();
        positions.forEach(item => {
            const index = rankIndex.get(item.depth) ?? 0;
            rankIndex.set(item.depth, index + 1);
            cardPositions.set(item.instruction.id, { x: 220 + item.depth * 220, y: 20 + index * 86 });
        });
        shownOutputs.forEach((valueIndex, index) => cardPositions.set(`output-${valueIndex}`, { x: (maxDepth + 2) * 220, y: 20 + index * 86 }));

        /**
         * Distinct cards feeding an argument. Cached per argument index so a
         * long list read by many nodes costs its length once, and dropped for
         * the lists holding a value whenever that value gains a new producer.
         */
        const cardsBehindCache = new Map<number, string[]>();
        const listsHolding = new Map<number, number[]>();
        const cardsBehind = (index: number): string[] => {
            let cards = cardsBehindCache.get(index);
            if (!cards) {
                const sources = sourcesOf(index);
                const ids = new Set<string>();
                for (const source of sources) {
                    const fromId = producer.get(source) ?? sourceCards.get(source);
                    if (fromId) ids.add(fromId);
                }
                cards = [...ids];
                cardsBehindCache.set(index, cards);
                // Any argument that stands for other values — a list, or an
                // alias standing for the value it shares bytes with — must be
                // dropped when one of those gains a producer. An argument that
                // is its own only source is dropped by index alone.
                if (sources.length !== 1 || sources[0] !== index) {
                    for (const source of sources) {
                        const lists = listsHolding.get(source);
                        if (lists) { if (lists[lists.length - 1] !== index) lists.push(index); }
                        else listsHolding.set(source, [index]);
                    }
                }
            }
            return cards;
        };
        const produce = (source: number, id: string): void => {
            producer.set(source, id);
            cardsBehindCache.delete(source);
            for (const list of listsHolding.get(source) ?? []) cardsBehindCache.delete(list);
        };
        let edgeCount = 0;
        let edgesOmitted = false;
        const drawn = new Set<string>();
        const connect = (fromId: string | undefined, toId: string, output: boolean): void => {
            const from = fromId ? cardPositions.get(fromId) : undefined;
            const to = cardPositions.get(toId);
            if (!from || !to || fromId === toId || drawn.has(`${fromId}→${toId}`)) return;
            if (edgeCount >= MAX_GRAPH_EDGES) { edgesOmitted = true; return; }
            drawn.add(`${fromId}→${toId}`);
            svg.append(graphEdge(from.x + 170, from.y + 27, to.x, to.y + 27, output));
            edgeCount++;
        };
        // Edges follow execution order: a node reads what was written before
        // it, so a value written again later — a mutated buffer, a loop-carried
        // value, both arms of a branch — keeps the edge from its real source.
        for (const item of positions) {
            for (const input of distinct(item.instruction.inputs)) {
                for (const fromId of cardsBehind(input)) connect(fromId, item.instruction.id, false);
            }
            for (const output of distinct(item.instruction.outputs)) {
                for (const source of sourcesOf(output)) produce(source, item.instruction.id);
            }
        }
        // A method output is whatever last wrote it, so these come after the pass.
        for (const valueIndex of shownOutputs) {
            for (const fromId of cardsBehind(valueIndex)) connect(fromId, `output-${valueIndex}`, true);
        }
        canvas.append(svg);

        const addCard = (id: string, title: string, detail: string, kind: string, selection?: Selection, extraSearch = ''): void => {
            const position = cardPositions.get(id);
            if (!position) return;
            const button = element('button', `omni-pte__node omni-pte__node--${kind}`) as HTMLButtonElement;
            button.type = 'button';
            button.style.left = `${position.x}px`;
            button.style.top = `${position.y}px`;
            button.dataset.search = `${title} ${detail} ${extraSearch}`.toLowerCase();
            if (selection) cardSelections.set(button, selection);
            if (selection && selected && sameSelection(selection, selected) && (selectedCard === undefined || selectedCard === id)) button.classList.add('omni-pte__node--selected');
            button.append(element('strong', undefined, title || '—'), element('small', undefined, detail));
            button.onclick = () => {
                if (!selection) return;
                selected = selection;
                selectedCard = id;
                renderInspector(inspector);
                canvas.querySelectorAll('.omni-pte__node--selected').forEach(item => item.classList.remove('omni-pte__node--selected'));
                button.classList.add('omni-pte__node--selected');
            };
            canvas.append(button);
        };
        for (const value of shownSources) {
            addCard(`value-${value.index}`, valueLabel(value.index), valueDetail(value),
                graphInputs.has(value.index) ? 'input' : 'constant', { kind: 'value', value }, valueSearchText(value));
        }
        for (const item of positions) {
            const instruction = item.instruction;
            addCard(instruction.id, instruction.label, instructionDetail(instruction),
                instruction.kind === 'DelegateCall' ? 'delegate' : instruction.kind === 'MoveCall' ? 'move' : 'node',
                { kind: 'instruction', instruction });
        }
        for (const valueIndex of shownOutputs) {
            const value = valueAt(valueIndex);
            addCard(`output-${valueIndex}`, valueLabel(valueIndex), value ? valueDetail(value) : '—', 'output',
                value ? { kind: 'value', value } : undefined, value ? valueSearchText(value) : '');
        }
        if (totalCards > shownCards) scroll.append(element('div', 'omni-pte__graph-limit', ctx.i18n.t('pte.graphLimited', { shown: shownCards, total: totalCards })));
        if (edgesOmitted) scroll.append(element('div', 'omni-pte__graph-limit', ctx.i18n.t('pte.graphEdgesLimited', { count: MAX_GRAPH_EDGES })));
        if (nodes.length === 0) scroll.append(element('div', 'omni-pte__empty', ctx.i18n.t('pte.emptyGraph')));
        scroll.append(canvas);
        renderInspector(inspector);
        layout.append(scroll, inspector);
        content.append(layout);
        applyGraphSearch(canvas);
    };

    const appendFact = (parent: HTMLElement, label: string, value: string): void => {
        const row = element('div', 'omni-pte__attribute');
        row.append(element('b', undefined, label), element('div', undefined, value));
        parent.append(row);
    };

    const renderInspector = (inspector: HTMLElement): void => {
        inspector.replaceChildren();
        if (!selected) { inspector.append(element('div', 'omni-pte__empty', ctx.i18n.t('pte.selectNode'))); return; }
        if (selected.kind === 'value') { renderValueInspector(inspector, selected.value); return; }
        const instruction = selected.instruction;
        inspector.append(
            element('div', 'omni-pte__inspector-kind', kindLabel(instruction)),
            element('h2', undefined, instruction.label),
            element('div', undefined, instructionDetail(instruction))
        );
        appendValueChips(inspector, ctx.i18n.t('pte.inspector.inputs'), instruction.inputs);
        appendValueChips(inspector, ctx.i18n.t('pte.inspector.outputs'), instruction.outputs);
        if (instruction.args.length) {
            inspector.append(element('h3', undefined, ctx.i18n.t('pte.inspector.arguments')));
            instruction.args.slice(0, MAX_INSPECTOR_ITEMS).forEach((index, position) => {
                const value = valueAt(index);
                appendFact(inspector, `${position}: ${valueLabel(index)}`, value ? valueDetail(value) : '—');
            });
            if (instruction.args.length > MAX_INSPECTOR_ITEMS) inspector.append(element('div', 'omni-pte__attribute', ctx.i18n.t('pte.moreItems', { count: instruction.args.length - MAX_INSPECTOR_ITEMS })));
        }
        if (instruction.kind === 'DelegateCall') {
            const delegate = activeMethod.delegates[instruction.delegateIndex];
            inspector.append(element('h3', undefined, ctx.i18n.t('pte.inspector.delegate')));
            if (delegate) {
                appendFact(inspector, ctx.i18n.t('pte.column.backend'), delegate.id || '—');
                appendFact(inspector, ctx.i18n.t('pte.column.location'), `${ctx.i18n.t(`pte.location.${delegate.location}`)} #${delegate.dataIndex}`);
                appendFact(inspector, ctx.i18n.t('pte.column.dataSize'), delegate.dataBytes ? formatByteCount(delegate.dataBytes) : '—');
                for (const spec of delegate.compileSpecs.slice(0, MAX_INSPECTOR_ITEMS)) {
                    appendFact(inspector, spec.key, spec.value || ctx.i18n.t('pte.binaryBytes', { bytes: spec.bytes }));
                }
            } else {
                inspector.append(element('div', 'omni-pte__attribute', ctx.i18n.t('pte.missingDelegate', { index: instruction.delegateIndex })));
            }
        }
        if (instruction.kind === 'JumpFalseCall') appendFact(inspector, ctx.i18n.t('pte.inspector.destination'), jumpTarget(instruction));
        if (instruction.frames.length) {
            inspector.append(element('h3', undefined, ctx.i18n.t('pte.inspector.stackTrace')));
            for (const frame of instruction.frames) {
                const row = element('div', 'omni-pte__attribute');
                row.append(element('b', undefined, `${frame.filename}:${frame.line} ${frame.name}`));
                if (frame.context) row.append(element('div', undefined, frame.context));
                inspector.append(row);
            }
        }
    };

    const renderValueInspector = (inspector: HTMLElement, value: PteValue): void => {
        inspector.append(
            element('div', 'omni-pte__inspector-kind', value.tensor ? storageLabel(value) : value.kind),
            element('h2', undefined, valueLabel(value.index)),
            element('div', undefined, valueDetail(value))
        );
        appendFact(inspector, ctx.i18n.t('pte.column.index'), String(value.index));
        appendFact(inspector, ctx.i18n.t('pte.column.kind'), value.kind);
        const tensor = value.tensor;
        if (!tensor) {
            appendFact(inspector, ctx.i18n.t('pte.inspector.value'), value.preview);
            if (value.items) appendValueChips(inspector, ctx.i18n.t('pte.inspector.items'), value.items);
            return;
        }
        const facts: Array<[string, string]> = [
            [ctx.i18n.t('pte.column.type'), tensor.scalarType],
            [ctx.i18n.t('pte.column.shape'), tensor.sizes.join(' × ') || ctx.i18n.t('pte.scalar')],
            [ctx.i18n.t('pte.info.dimOrder'), tensor.dimOrder.join(', ') || '—'],
            [ctx.i18n.t('pte.column.elements'), tensor.elementCount || '—'],
            [ctx.i18n.t('pte.column.dataSize'), tensor.dataBytes ? formatByteCount(tensor.dataBytes) : '—'],
            [ctx.i18n.t('pte.info.expectedSize'), tensor.expectedBytes ? formatByteCount(tensor.expectedBytes) : '—'],
            [ctx.i18n.t('pte.column.storage'), storageLabel(value)],
            [ctx.i18n.t('pte.info.shapeDynamism'), tensor.shapeDynamism]
        ];
        if (tensor.segmentIndex >= 0) facts.push([ctx.i18n.t('pte.info.segment'), `#${tensor.segmentIndex}`]);
        if (tensor.fileOffset) facts.push([ctx.i18n.t('pte.column.fileOffset'), tensor.fileOffset]);
        if (tensor.dataBufferIndex) facts.push([ctx.i18n.t('pte.info.dataIndex'), String(tensor.dataBufferIndex)]);
        if (tensor.allocation) facts.push([ctx.i18n.t('pte.column.memory'), memoryLabel(value)]);
        if (tensor.aliasOf !== undefined) facts.push([ctx.i18n.t('pte.info.aliasOf'), valueLabel(tensor.aliasOf)]);
        if (tensor.storageOffset) facts.push([ctx.i18n.t('pte.info.storageOffset'), String(tensor.storageOffset)]);
        if (tensor.requiresGrad) facts.push([ctx.i18n.t('pte.info.requiresGrad'), ctx.i18n.t('pte.yes')]);
        if (tensor.device) facts.push([ctx.i18n.t('pte.info.device'), tensor.device]);
        for (const [label, fact] of facts) appendFact(inspector, label, fact);
    };

    const appendValueChips = (parent: HTMLElement, label: string, indices: number[]): void => {
        parent.append(element('h3', undefined, label));
        const chips = element('div', 'omni-pte__chips');
        for (const index of indices.slice(0, MAX_INSPECTOR_ITEMS)) {
            const value = valueAt(index);
            const chip = element('span', 'omni-pte__chip', valueLabel(index));
            chip.title = value ? `#${index} · ${valueDetail(value)}` : valueLabel(index);
            chips.append(chip);
        }
        if (indices.length > MAX_INSPECTOR_ITEMS) chips.append(element('span', 'omni-pte__chip', ctx.i18n.t('pte.moreItems', { count: indices.length - MAX_INSPECTOR_ITEMS })));
        parent.append(chips);
    };

    const applyGraphSearch = (canvas: HTMLElement): void => {
        const needle = query();
        canvas.querySelectorAll<HTMLElement>('.omni-pte__node').forEach(card => {
            const selection = cardSelections.get(card);
            const matches = selection?.kind === 'instruction'
                ? instructionMatches(selection.instruction, needle)
                : card.dataset.search?.includes(needle);
            card.classList.toggle('omni-pte__node--dim', Boolean(needle) && !matches);
        });
    };

    on(search, 'input', () => {
        if (activeTab === 'graph') { const canvas = content.querySelector<HTMLElement>('.omni-pte__canvas'); if (canvas) applyGraphSearch(canvas); }
        else renderContent();
    });
    on(methodPicker, 'change', () => showMethod(Number(methodPicker.value)));
    const showCopyResult = (key: string): void => {
        if (disposed) return;
        copy.textContent = ctx.i18n.t(key);
        if (resetTimer !== undefined) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => { if (!disposed) copy.textContent = ctx.i18n.t('pte.copyJson'); }, 1200);
    };
    const copyFailed = (error: unknown): void => {
        ctx.logger.log('error', `ExecuTorch copy failed: ${error instanceof Error ? error.message : String(error)}`);
        showCopyResult('pte.copyFailed');
    };
    on(copy, 'click', () => {
        if (!ctx.clipboard) return;
        // A method whose kernels return one long tensor list repeats those
        // outputs per instruction once serialized, so the text can outgrow the
        // engine's string limit even for a small file: report that rather than
        // letting the click handler throw.
        let text: string;
        try {
            text = JSON.stringify(model, null, 2);
        } catch (error) {
            copyFailed(error);
            return;
        }
        void ctx.clipboard.writeText(text).then(() => showCopyResult('common.copied')).catch(copyFailed);
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
            if (!(root instanceof ShadowRoot)) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--pte');
        }
    };
}

function sameSelection(a: Selection, b: Selection): boolean {
    if (a.kind === 'instruction' && b.kind === 'instruction') return a.instruction.id === b.instruction.id;
    if (a.kind === 'value' && b.kind === 'value') return a.value.index === b.value.index;
    return false;
}

/** Longest-path depth per node, using the instruction that produced each input value. */
function graphPositions(
    instructions: PteInstruction[],
    sourcesOf: (index: number) => number[]
): Array<{ instruction: PteInstruction; depth: number }> {
    const outputDepth = new Map<number, number>();
    /**
     * Depth a list argument implies, kept current as its tensors are written
     * rather than recomputed per reader: a list read by many nodes must not be
     * walked once per node, and a list whose tensors are written between two
     * reads must not hand the second reader the first one's depth.
     */
    const listDepth = new Map<number, number>();
    /** Lists registered for incremental updates, by the tensor they hold. */
    const listsHolding = new Map<number, number[]>();
    const writtenListDepth = new Map<number, number>();
    const define = (source: number, depth: number): void => {
        outputDepth.set(source, depth);
        // Dropped rather than raised: depths are not monotone along the
        // instruction order, so a rewrite can make a list shallower.
        for (const list of listsHolding.get(source) ?? []) listDepth.delete(list);
    };
    return instructions.map(instruction => {
        let depth = 0;
        for (const input of new Set(instruction.inputs)) {
            const sources = sourcesOf(input);
            let inputDepth = sources.length > 1 ? listDepth.get(input) : undefined;
            if (inputDepth === undefined) {
                inputDepth = 0;
                for (const source of sources) inputDepth = Math.max(inputDepth, (outputDepth.get(source) ?? -1) + 1);
                if (sources.length > 1) {
                    listDepth.set(input, inputDepth);
                    for (const source of sources) {
                        const lists = listsHolding.get(source);
                        if (lists) lists.push(input); else listsHolding.set(source, [input]);
                    }
                }
            }
            depth = Math.max(depth, inputDepth);
        }
        for (const output of new Set(instruction.outputs)) {
            const sources = sourcesOf(output);
            if (sources.length > 1) {
                // A list returned by several nodes is re-applied only when the
                // depth changed, so the common shared-return case costs its
                // length once.
                const written = writtenListDepth.get(output);
                if (written === depth) continue;
                writtenListDepth.set(output, depth);
            }
            for (const source of sources) define(source, depth);
        }
        return { instruction, depth };
    });
}

/** Rows are built first so the search sees exactly what the table shows. */
function collectRenderedRows<T>(
    items: T[],
    toRow: (item: T) => Array<string | number>,
    matches: (item: T, row: Array<string | number>) => boolean
): { rows: Array<Array<string | number>>; total: number } {
    const rows: Array<Array<string | number>> = [];
    let total = 0;
    for (const item of items) {
        const row = toRow(item);
        if (!matches(item, row)) continue;
        total++;
        if (rows.length < MAX_TABLE_ROWS) rows.push(row);
    }
    return { rows, total };
}

function previewItems<T>(items: T[], format: (item: T) => string, limit = 20): string {
    const shown = Math.min(limit, items.length);
    const visible = items.slice(0, shown).map(format).join(', ');
    return items.length > shown ? `${visible}, … (+${items.length - shown})` : visible;
}

function textMatches(query: string, ...values: Array<string | number>): boolean {
    return values.some(value => String(value).toLowerCase().includes(query));
}

function graphEdge(x1: number, y1: number, x2: number, y2: number, output: boolean): SVGPathElement {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const bend = Math.max(28, (x2 - x1) / 2);
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    path.setAttribute('class', `omni-pte__edge${output ? ' omni-pte__edge--output' : ''}`);
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
