// JSON behavior controller (DESIGN.md §3-②) — DOM-free interaction state for
// the JSON viewer. The DOM renderer is one consumer; the conformance kit drives
// this directly (docs/viewers/json.md 부록 A). Decisions: default view = source
// (J9), source has three forms (J14), toolbox routing = vscode (J11/부록 B-1),
// search over key/path/type/value (J16). Toolbox transforms live in
// transforms.ts (부록 B).

import type { Diagnostic, ParseFailure } from '../../parsers/types.js';
import { decodeUtf8 } from '../../parsers/types.js';
import {
    parseJson,
    type JsonDocument,
    type JsonNode,
    type JsonParseOptions,
    type JsonValueKind
} from '../../parsers/json/index.js';
import {
    base64Decode,
    base64Encode,
    escapeText,
    jsonToCsv,
    jsonToXml,
    jsonToYaml,
    serialize,
    toPlainValue,
    unescapeText,
    type TransformResult
} from './transforms.js';

export type JsonViewMode = 'tree' | 'source';
export type JsonSourceForm = 'verbatim' | 'pretty' | 'minified';

export type JsonToolAction =
    | 'pretty'
    | 'minify'
    | 'sort-keys'
    | 'validate'
    | 'to-csv'
    | 'to-xml'
    | 'to-yaml'
    | 'escape'
    | 'unescape'
    | 'base64-encode'
    | 'base64-decode';

export interface JsonStatusMessage {
    key: string;
    args?: Record<string, string | number>;
}

export interface JsonToolResult {
    action: JsonToolAction;
    titleKey: string;
    output: string;
    error?: JsonStatusMessage;
}

export type JsonAction =
    | { type: 'set-view-mode'; mode: JsonViewMode }
    | { type: 'set-source-form'; form: JsonSourceForm }
    | { type: 'toggle-node'; id: string }
    | { type: 'expand-all' }
    | { type: 'collapse-all' }
    | { type: 'set-search'; search: string }
    | { type: 'next-match' }
    | { type: 'prev-match' }
    | { type: 'run-tool'; action: JsonToolAction }
    | { type: 'apply-result-to-editor' }
    | { type: 'dismiss-result' }
    | { type: 'edit-scratchpad'; text: string };

export interface JsonStatistics {
    total: number;
    maxDepth: number;
    counts: Record<JsonValueKind, number>;
}

export interface JsonViewState {
    status: 'ok' | 'partial' | 'failed';
    viewMode: JsonViewMode;
    sourceForm: JsonSourceForm;
    root: JsonNode | null;
    expanded: ReadonlySet<string>;
    search: string;
    matchCount: number;
    currentMatch: number;
    scratchpad: string;
    toolResult: JsonToolResult | null;
    statusMessage: JsonStatusMessage | null;
    statistics: JsonStatistics | null;
    diagnostics: Diagnostic[];
    failure: ParseFailure | null;
}

export interface JsonController {
    readonly state: JsonViewState;
    dispatch(action: JsonAction): void;
    subscribe(listener: (state: JsonViewState) => void): () => void;
    /** Verbatim source (J14) — the current editable text, valid or not (J20). */
    verbatimText(): string;
    /** The text for the active source form (verbatim / pretty / minified). */
    sourceText(): string;
    /** Stable id of a node, used for toggle/copy/match addressing (P1b). */
    nodeId(node: JsonNode): string | undefined;
    /** JSONPath of a node by id (copy Path, J16). */
    nodePath(id: string): string;
    /** Copyable value of a node by id (copy Value, J16). */
    nodeValue(id: string): string;
    /** Ordered matching node ids (conformance kit — DOM-free). */
    readonly matches: readonly string[];
}

export interface JsonControllerOptions {
    limits?: JsonParseOptions['limits'];
    maxDepth?: number;
}

const TOOL_MESSAGE: Record<string, string> = {
    pretty: 'json.tool.formatted',
    minify: 'json.tool.minified',
    'sort-keys': 'json.tool.sorted',
    escape: 'json.tool.escaped',
    unescape: 'json.tool.unescaped',
    'base64-encode': 'json.tool.base64Encoded',
    'base64-decode': 'json.tool.base64Decoded'
};

const CONVERTER_TITLE: Record<string, string> = {
    'to-csv': 'json.tool.csvOutput',
    'to-xml': 'json.tool.xmlOutput',
    'to-yaml': 'json.tool.yamlOutput'
};

const TRANSFORM_ERROR: Record<string, string> = {
    'invalid-unicode': 'json.tool.unescapeFailed',
    'invalid-hex': 'json.tool.unescapeFailed',
    trailing: 'json.tool.unescapeFailed',
    'invalid-base64': 'json.tool.base64Failed',
    'csv-requires-objects': 'json.tool.csvRequiresObjects'
};

export function createJsonController(
    input: Uint8Array | string,
    options: JsonControllerOptions = {}
): JsonController {
    const listeners = new Set<(state: JsonViewState) => void>();

    // Fallback verbatim text so a failed parse still shows the source (J20).
    const decodedInput =
        typeof input === 'string' ? input : decodeUtf8(input);

    // Nodes are addressed by a unique id, not by JSONPath: duplicate object
    // keys share a path (e.g. both '$.a' in {"a":1,"a":2}) but must be toggled,
    // searched, and copied independently (P1b). The id equals the path when
    // unique and gets a '#n' suffix for duplicates, so the common case stays
    // path-readable while duplicates stay addressable.
    let nodeById = new Map<string, JsonNode>();
    let idOf = new WeakMap<JsonNode, string>();
    let parentIdOf = new Map<string, string | null>();
    let order: string[] = [];
    let matchList: string[] = [];

    /** Re-parse `text` and rebuild the derived indices; returns core fields. */
    const analyze = (text: string) => {
        const parseOptions: JsonParseOptions = {};
        if (options.limits !== undefined) parseOptions.limits = options.limits;
        if (options.maxDepth !== undefined) parseOptions.maxDepth = options.maxDepth;
        const { result } = parseJson(text, parseOptions);

        nodeById = new Map();
        idOf = new WeakMap();
        parentIdOf = new Map();
        order = [];
        let root: JsonNode | null = null;
        let statistics: JsonStatistics | null = null;

        if (result.status !== 'failed') {
            root = (result.document as JsonDocument).root;
            const counts: Record<JsonValueKind, number> = {
                object: 0,
                array: 0,
                string: 0,
                number: 0,
                boolean: 0,
                null: 0
            };
            let total = 0;
            let maxDepth = 0;
            const walk = (node: JsonNode, parentId: string | null): void => {
                let id = node.path;
                if (nodeById.has(id)) {
                    let n = 2;
                    while (nodeById.has(`${node.path}#${n}`)) n++;
                    id = `${node.path}#${n}`;
                }
                nodeById.set(id, node);
                idOf.set(node, id);
                parentIdOf.set(id, parentId);
                order.push(id);
                total++;
                counts[node.kind]++;
                if (node.depth > maxDepth) maxDepth = node.depth;
                for (const child of node.children ?? []) walk(child, id);
            };
            walk(root, null);
            statistics = { total, maxDepth, counts };
        }

        return {
            status: result.status,
            root,
            statistics,
            diagnostics: result.diagnostics,
            failure: result.status === 'failed' ? result.failure : null
        };
    };

    /** Container node ids at depth < 2 (J9 initial expand: depth 0 and 1). */
    const initialExpanded = (): Set<string> => {
        const set = new Set<string>();
        for (const id of order) {
            const node = nodeById.get(id)!;
            if ((node.kind === 'object' || node.kind === 'array') && node.depth < 2) {
                set.add(id);
            }
        }
        return set;
    };

    const isContainer = (node: JsonNode): boolean =>
        node.kind === 'object' || node.kind === 'array';

    const searchableText = (node: JsonNode): string => {
        let valueText = '';
        if (node.kind === 'string') valueText = typeof node.value === 'string' ? node.value : '';
        else if (node.kind === 'number') valueText = node.rawNumber ?? '';
        else if (node.kind === 'boolean') valueText = String(node.value);
        else if (node.kind === 'null') valueText = 'null';
        return `${node.key} ${node.path} ${node.kind} ${valueText}`.toLowerCase();
    };

    const recomputeMatches = (query: string): void => {
        matchList = [];
        const q = query.trim().toLowerCase();
        if (!q) return;
        for (const id of order) {
            if (searchableText(nodeById.get(id)!).includes(q)) matchList.push(id);
        }
    };

    /** Expand every ancestor container of the current matches (chrome). */
    const expandMatchAncestors = (expanded: Set<string>): void => {
        for (const id of matchList) {
            let parent = parentIdOf.get(id) ?? null;
            while (parent) {
                expanded.add(parent);
                parent = parentIdOf.get(parent) ?? null;
            }
        }
    };

    const initial = analyze(decodedInput);
    const state: JsonViewState = {
        status: initial.status,
        viewMode: 'tree', // Preview defaults to the navigable tree.
        sourceForm: 'pretty', // J14 (vscode text = re-serialized pretty)
        root: initial.root,
        expanded: initialExpanded(),
        search: '',
        matchCount: 0,
        currentMatch: -1,
        scratchpad: decodedInput,
        toolResult: null,
        statusMessage: null,
        statistics: initial.statistics,
        diagnostics: initial.diagnostics,
        failure: initial.failure
    };

    const notify = (): void => {
        for (const listener of listeners) listener(state);
    };

    /** Apply a fresh scratchpad text: re-parse, refresh derived state. */
    const setScratchpad = (text: string): void => {
        const next = analyze(text);
        state.scratchpad = text;
        state.status = next.status;
        state.root = next.root;
        state.statistics = next.statistics;
        state.diagnostics = next.diagnostics;
        state.failure = next.failure;
        // The tree changed (edit/transform) and node ids are regenerated, so
        // apply the initial expand rule to the new tree rather than carrying
        // over stale ids — new depth-1 containers get expanded (P2a).
        recomputeMatches(state.search);
        state.matchCount = matchList.length;
        state.currentMatch = matchList.length ? 0 : -1;
        const expanded = initialExpanded();
        expandMatchAncestors(expanded);
        state.expanded = expanded;
    };

    const replaceScratchpad = (text: string, messageKey: string): void => {
        setScratchpad(text);
        state.statusMessage = { key: messageKey };
    };

    const requireValidRoot = (): JsonNode | null =>
        state.status === 'ok' && state.root ? state.root : null;

    /** Show raw-text conversions for review without overwriting the editor. */
    const runRawResult = (action: JsonToolAction, result: TransformResult | string): void => {
        const transformed = typeof result === 'string' ? { ok: true as const, output: result } : result;
        state.toolResult = {
            action,
            titleKey: TOOL_MESSAGE[action]!,
            output: transformed.ok ? transformed.output : '',
            ...(transformed.ok
                ? {}
                : { error: { key: TRANSFORM_ERROR[transformed.error] ?? 'json.tool.failed' } })
        };
    };

    /** Chain Base64 operations through their latest successful result while
     * leaving the editor's original JSON untouched. */
    const base64Input = (): string => {
        const previous = state.toolResult;
        return previous
            && !previous.error
            && (previous.action === 'base64-encode' || previous.action === 'base64-decode')
            ? previous.output
            : state.scratchpad;
    };

    const runConverter = (
        action: 'to-csv' | 'to-xml' | 'to-yaml',
        convert: (value: unknown) => TransformResult
    ): void => {
        const root = requireValidRoot();
        if (!root) {
            state.toolResult = {
                action,
                titleKey: CONVERTER_TITLE[action]!,
                output: '',
                error: { key: 'json.tool.invalid' }
            };
            return;
        }
        const result = convert(toPlainValue(root));
        state.toolResult = {
            action,
            titleKey: CONVERTER_TITLE[action]!,
            output: result.ok ? result.output : '',
            ...(result.ok ? {} : { error: { key: TRANSFORM_ERROR[result.error] ?? 'json.tool.failed' } })
        };
    };

    const runTool = (action: JsonToolAction): void => {
        state.statusMessage = null;
        switch (action) {
            case 'pretty': {
                const root = requireValidRoot();
                if (root) replaceScratchpad(serialize(root, true), TOOL_MESSAGE.pretty!);
                else state.statusMessage = { key: 'json.tool.invalid' };
                break;
            }
            case 'minify': {
                const root = requireValidRoot();
                if (root) replaceScratchpad(serialize(root, false), TOOL_MESSAGE.minify!);
                else state.statusMessage = { key: 'json.tool.invalid' };
                break;
            }
            case 'sort-keys': {
                const root = requireValidRoot();
                if (root) replaceScratchpad(serialize(root, true, true), TOOL_MESSAGE['sort-keys']!);
                else state.statusMessage = { key: 'json.tool.invalid' };
                break;
            }
            case 'validate': {
                const root = requireValidRoot();
                if (root) {
                    const summary =
                        root.kind === 'array'
                            ? `Array(${root.children?.length ?? 0})`
                            : root.kind;
                    state.statusMessage = { key: 'json.tool.valid', args: { summary } };
                } else {
                    state.statusMessage = { key: 'json.tool.invalid' };
                }
                break;
            }
            case 'escape':
                runRawResult('escape', escapeText(state.scratchpad));
                break;
            case 'unescape':
                runRawResult('unescape', unescapeText(state.scratchpad));
                break;
            case 'base64-encode':
                runRawResult('base64-encode', base64Encode(base64Input()));
                break;
            case 'base64-decode':
                runRawResult('base64-decode', base64Decode(base64Input()));
                break;
            case 'to-csv':
                runConverter('to-csv', jsonToCsv);
                break;
            case 'to-xml':
                runConverter('to-xml', jsonToXml);
                break;
            case 'to-yaml':
                runConverter('to-yaml', (v) => jsonToYaml(v));
                break;
        }
    };

    const dispatch = (action: JsonAction): void => {
        switch (action.type) {
            case 'set-view-mode':
                state.viewMode = action.mode;
                break;
            case 'set-source-form':
                state.sourceForm = action.form;
                break;
            case 'toggle-node': {
                const node = nodeById.get(action.id);
                if (!node || !isContainer(node)) return;
                const expanded = new Set(state.expanded);
                if (expanded.has(action.id)) expanded.delete(action.id);
                else expanded.add(action.id);
                state.expanded = expanded;
                break;
            }
            case 'expand-all': {
                const expanded = new Set<string>();
                for (const id of order) {
                    if (isContainer(nodeById.get(id)!)) expanded.add(id);
                }
                state.expanded = expanded;
                break;
            }
            case 'collapse-all':
                state.expanded =
                    state.root && isContainer(state.root) && order.length
                        ? new Set([order[0]!])
                        : new Set();
                break;
            case 'set-search': {
                state.search = action.search;
                recomputeMatches(action.search);
                state.matchCount = matchList.length;
                state.currentMatch = matchList.length ? 0 : -1;
                const expanded = new Set(state.expanded);
                expandMatchAncestors(expanded);
                state.expanded = expanded;
                break;
            }
            case 'next-match':
                if (matchList.length) {
                    state.currentMatch = (state.currentMatch + 1) % matchList.length;
                }
                break;
            case 'prev-match':
                if (matchList.length) {
                    state.currentMatch =
                        (state.currentMatch - 1 + matchList.length) % matchList.length;
                }
                break;
            case 'run-tool':
                runTool(action.action);
                break;
            case 'apply-result-to-editor':
                if (state.toolResult && !state.toolResult.error) {
                    setScratchpad(state.toolResult.output);
                    state.toolResult = null;
                    state.statusMessage = { key: 'json.tool.applied' };
                }
                break;
            case 'dismiss-result':
                state.toolResult = null;
                break;
            case 'edit-scratchpad':
                setScratchpad(action.text);
                state.statusMessage = null;
                break;
        }
        notify();
    };

    const nodeValue = (id: string): string => {
        const node = nodeById.get(id);
        if (!node) return '';
        if (isContainer(node)) return serialize(node, true);
        if (node.kind === 'string') return typeof node.value === 'string' ? node.value : '';
        if (node.kind === 'number') return node.rawNumber ?? '';
        if (node.kind === 'boolean') return String(node.value);
        return 'null';
    };

    const sourceText = (): string => {
        if (state.sourceForm === 'verbatim') return state.scratchpad;
        if (state.root && state.status === 'ok') {
            return serialize(state.root, state.sourceForm === 'pretty');
        }
        // Can't re-serialize invalid JSON — show the verbatim text instead.
        return state.scratchpad;
    };

    return {
        get state() {
            return state;
        },
        dispatch,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        verbatimText: () => state.scratchpad,
        sourceText,
        nodeId: (node) => idOf.get(node),
        nodePath: (id) => nodeById.get(id)?.path ?? id,
        nodeValue,
        get matches() {
            return matchList;
        }
    };
}
