import { asciiLower } from '../../parsers/csv/index.js';
import { parseToml, type TomlNode, type TomlRange } from '../../parsers/toml/index.js';
import type { Diagnostic } from '../../parsers/types.js';

/** Which part of a node the search box looks at. */
export type TomlSearchScope = 'all' | 'key' | 'path' | 'value';
export const TOML_SEARCH_SCOPES: readonly TomlSearchScope[] = ['all', 'key', 'path', 'value'];

export type TomlAction =
    | { type: 'set-mode'; mode: 'tree' | 'flat' | 'json' | 'raw' }
    | { type: 'set-search'; search: string }
    | { type: 'set-search-scope'; scope: TomlSearchScope }
    | { type: 'select-node'; id: string | null }
    | { type: 'select-offset'; offset: number }
    | { type: 'toggle-node'; id: string }
    | { type: 'expand-all' }
    | { type: 'collapse-all' }
    | { type: 'edit-source'; text: string };
export interface TomlViewState {
    status: 'ok' | 'partial' | 'failed'; root: TomlNode | null; text: string; mode: 'tree' | 'flat' | 'json' | 'raw';
    diagnostics: readonly Diagnostic[]; search: string; searchScope: TomlSearchScope; searchScopes: readonly TomlSearchScope[];
    matchCount: number; selected: string | null; expanded: ReadonlySet<string>;
}
export interface TomlController {
    readonly state: TomlViewState; dispatch(action: TomlAction): void;
    subscribe(listener: (state: TomlViewState) => void): () => void;
    nodePath(id: string): string; nodeValue(id: string): string; nodeJson(id: string): string; documentJson(): string;
    /** Source range of a node, for hosts that reveal it in an editor. */
    nodeRange(id: string): TomlRange | null;
    /** Deepest node covering a caret offset, for hosts syncing the other way. */
    nodeAtOffset(offset: number): string | null;
    nodeMatches(node: { key: string; path: string; raw?: string; value?: unknown }): boolean;
}

export function createTomlController(input: Uint8Array | string): TomlController {
    const listeners = new Set<(state: TomlViewState) => void>();
    const nodes = new Map<string, TomlNode>();
    const decode = (value: Uint8Array | string): string => typeof value === 'string' ? value : new TextDecoder().decode(value);
    const state: TomlViewState = { status: 'ok', root: null, text: decode(input), mode: 'tree', diagnostics: [], search: '', searchScope: 'all', searchScopes: TOML_SEARCH_SCOPES, matchCount: 0, selected: null, expanded: new Set() };
    const index = (): void => {
        nodes.clear(); const result = parseToml(state.text).result;
        state.status = result.status; state.diagnostics = result.diagnostics; state.root = result.status === 'failed' ? null : result.document.root;
        const walk = (node: TomlNode): void => { nodes.set(node.path || '$', node); for (const child of node.children ?? []) walk(child); };
        if (state.root) walk(state.root);
        if (state.selected && !nodes.has(state.selected)) state.selected = null;
    };
    const plain = (node: TomlNode): unknown => node.children ? node.kind === 'array' ? node.children.map(plain) : Object.fromEntries(node.children.map(child => [child.key, plain(child)])) : node.kind === 'integer' || node.kind === 'float' || node.kind === 'datetime' ? node.raw : node.value;
    const haystack = (node: { key: string; path: string; raw?: string; value?: unknown }, scope: TomlSearchScope): string => {
        const value = node.raw || String(node.value ?? '');
        return scope === 'key' ? node.key : scope === 'path' ? node.path : scope === 'value' ? value : `${node.key} ${node.path} ${value}`;
    };
    const matches = (node: { key: string; path: string; raw?: string; value?: unknown }): boolean => {
        const query = asciiLower(state.search.trim());
        return !query || asciiLower(haystack(node, state.searchScope)).includes(query);
    };
    const countMatches = (): void => {
        state.matchCount = state.search.trim() ? [...nodes.values()].filter(node => node !== state.root && matches(node)).length : 0;
    };
    const parentOf = (node: TomlNode): TomlNode | undefined => [...nodes.values()].find(candidate => candidate.children?.includes(node));
    const revealMatches = (): void => {
        if (!state.search.trim()) return;
        nodes.forEach(node => { if (matches(node)) { let current: TomlNode | undefined = node; while (current) { state.expanded = new Set([...state.expanded, current.path || '$']); current = parentOf(current); } } });
    };
    const nodeAtOffset = (offset: number): string | null => {
        // The tightest range wins, so a caret inside an inline table member
        // selects that member rather than the whole declaration.
        let best: TomlNode | undefined;
        for (const node of nodes.values()) {
            const range = node.range; if (!range || node === state.root || offset < range.start || offset >= range.end) continue;
            if (!best || range.end - range.start < best.range!.end - best.range!.start) best = node;
        }
        return best ? best.path || '$' : null;
    };
    /** Expand every ancestor so a selection made in the source is visible. */
    const select = (id: string | null): void => {
        state.selected = id !== null && nodes.has(id) ? id : null;
        let current = state.selected ? parentOf(nodes.get(state.selected)!) : undefined;
        while (current) { state.expanded = new Set([...state.expanded, current.path || '$']); current = parentOf(current); }
    };
    const notify = (): void => listeners.forEach(listener => listener(state));
    index();
    if (state.root) state.expanded = new Set([state.root.path || '$', ...(state.root.children ?? []).filter(node => !!node.children?.length).map(node => node.path)]);
    return {
        state,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        nodePath: id => nodes.get(id)?.path ?? '', nodeValue: id => nodes.get(id)?.raw ?? '',
        nodeJson: id => JSON.stringify(plain(nodes.get(id) ?? state.root!), null, 2),
        documentJson: () => state.root ? JSON.stringify(plain(state.root), null, 2) : '',
        nodeRange: id => nodes.get(id)?.range ?? null,
        nodeMatches: matches,
        nodeAtOffset,
        dispatch(action) {
            if (action.type === 'edit-source') { state.text = action.text; index(); countMatches(); }
            else if (action.type === 'set-mode') state.mode = action.mode;
            else if (action.type === 'set-search') { state.search = action.search; countMatches(); revealMatches(); }
            else if (action.type === 'set-search-scope') { state.searchScope = action.scope; countMatches(); revealMatches(); }
            else if (action.type === 'select-node') select(action.id);
            else if (action.type === 'select-offset') select(nodeAtOffset(action.offset));
            else if (action.type === 'toggle-node') { const expanded = new Set(state.expanded); expanded.has(action.id) ? expanded.delete(action.id) : expanded.add(action.id); state.expanded = expanded; }
            else if (action.type === 'expand-all') state.expanded = new Set(nodes.keys());
            else state.expanded = new Set();
            notify();
        }
    };
}
