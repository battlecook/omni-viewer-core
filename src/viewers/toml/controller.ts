import { asciiLower } from '../../parsers/csv/index.js';
import { parseToml, type TomlNode } from '../../parsers/toml/index.js';
import type { Diagnostic } from '../../parsers/types.js';

export type TomlAction =
    | { type: 'set-mode'; mode: 'tree' | 'flat' | 'json' | 'raw' }
    | { type: 'set-search'; search: string }
    | { type: 'toggle-node'; id: string }
    | { type: 'expand-all' }
    | { type: 'collapse-all' }
    | { type: 'edit-source'; text: string };
export interface TomlViewState {
    status: 'ok' | 'partial' | 'failed'; root: TomlNode | null; text: string; mode: 'tree' | 'flat' | 'json' | 'raw';
    diagnostics: readonly Diagnostic[]; search: string; expanded: ReadonlySet<string>;
}
export interface TomlController {
    readonly state: TomlViewState; dispatch(action: TomlAction): void;
    subscribe(listener: (state: TomlViewState) => void): () => void;
    nodePath(id: string): string; nodeValue(id: string): string; nodeJson(id: string): string; documentJson(): string;
}

export function createTomlController(input: Uint8Array | string): TomlController {
    const listeners = new Set<(state: TomlViewState) => void>();
    const nodes = new Map<string, TomlNode>();
    const decode = (value: Uint8Array | string): string => typeof value === 'string' ? value : new TextDecoder().decode(value);
    const state: TomlViewState = { status: 'ok', root: null, text: decode(input), mode: 'tree', diagnostics: [], search: '', expanded: new Set() };
    const index = (): void => {
        nodes.clear(); const result = parseToml(state.text).result;
        state.status = result.status; state.diagnostics = result.diagnostics; state.root = result.status === 'failed' ? null : result.document.root;
        const walk = (node: TomlNode): void => { nodes.set(node.path || '$', node); for (const child of node.children ?? []) walk(child); };
        if (state.root) walk(state.root);
    };
    const plain = (node: TomlNode): unknown => node.children ? node.kind === 'array' ? node.children.map(plain) : Object.fromEntries(node.children.map(child => [child.key, plain(child)])) : node.kind === 'integer' || node.kind === 'float' || node.kind === 'datetime' ? node.raw : node.value;
    const notify = (): void => listeners.forEach(listener => listener(state));
    index();
    if (state.root) state.expanded = new Set([state.root.path || '$', ...(state.root.children ?? []).filter(node => !!node.children?.length).map(node => node.path)]);
    return {
        state,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        nodePath: id => nodes.get(id)?.path ?? '', nodeValue: id => nodes.get(id)?.raw ?? '',
        nodeJson: id => JSON.stringify(plain(nodes.get(id) ?? state.root!), null, 2),
        documentJson: () => state.root ? JSON.stringify(plain(state.root), null, 2) : '',
        dispatch(action) {
            if (action.type === 'edit-source') { state.text = action.text; index(); }
            else if (action.type === 'set-mode') state.mode = action.mode;
            else if (action.type === 'set-search') {
                state.search = action.search; const query = asciiLower(action.search);
                if (query) nodes.forEach(node => { if (asciiLower(`${node.key} ${node.path} ${node.raw}`).includes(query)) { let current: TomlNode | undefined = node; while (current) { state.expanded = new Set([...state.expanded, current.path || '$']); current = [...nodes.values()].find(candidate => candidate.children?.includes(current!)); } } });
            } else if (action.type === 'toggle-node') { const expanded = new Set(state.expanded); expanded.has(action.id) ? expanded.delete(action.id) : expanded.add(action.id); state.expanded = expanded; }
            else if (action.type === 'expand-all') state.expanded = new Set(nodes.keys());
            else state.expanded = new Set();
            notify();
        }
    };
}
