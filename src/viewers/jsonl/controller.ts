import { asciiLower } from '../../parsers/csv/index.js';
import { parseJsonl, type JsonlEntry, type JsonlPagedInput } from '../../parsers/jsonl/index.js';
import type { Diagnostic } from '../../parsers/types.js';

export type JsonlAction =
    | { type: 'load-more' }
    | { type: 'load-all' }
    | { type: 'set-search'; search: string }
    | { type: 'select'; id: string; additive?: boolean; range?: boolean }
    | { type: 'edit'; id: string; raw: string }
    | { type: 'insert'; raw?: string }
    | { type: 'delete-selected' }
    | { type: 'move'; from: string; to: string }
    | { type: 'save' };

export interface JsonlViewState {
    status: 'ok' | 'partial' | 'failed';
    loadState: 'preview' | 'complete' | 'loading';
    entries: readonly JsonlEntry[];
    search: string;
    selected: ReadonlySet<string>;
    dirty: boolean;
    visibleCount: number;
    diagnostics: readonly Diagnostic[];
}
export interface JsonlController {
    readonly state: JsonlViewState;
    dispatch(action: JsonlAction): void | Promise<void>;
    subscribe(listener: (state: JsonlViewState) => void): () => void;
    serialize(): string;
    canSave(): boolean;
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const result = new Uint8Array(a.length + b.length); result.set(a); result.set(b, a.length); return result;
};
/** Only newline-terminated records are visible during preview; the trailing
 * bytes are the JNL3 continuation buffer and become a record only at done. */
const finalized = (data: Uint8Array, done: boolean): Uint8Array => {
    if (done) return data;
    for (let i = data.length - 1; i >= 0; i--) if (data[i] === 0x0a) return data.slice(0, i + 1);
    return new Uint8Array();
};

export function createJsonlController(input: Uint8Array | string | JsonlPagedInput): JsonlController {
    const paged = typeof input !== 'string' && 'initialData' in input ? input : null;
    let bytes: Uint8Array = paged ? paged.initialData : typeof input === 'string' ? new TextEncoder().encode(input) : input as Uint8Array;
    let nextId = 1;
    const parsedInitial = parseJsonl(finalized(bytes, !paged?.loadMore)).result;
    let entries: JsonlEntry[] = parsedInitial.status === 'failed' ? [] : parsedInitial.document.entries.map(entry => ({ ...entry, id: `source:${entry.line}` }));
    const state: JsonlViewState = {
        status: parsedInitial.status,
        loadState: paged?.loadMore ? 'preview' : 'complete', entries, search: '', selected: new Set(), dirty: false,
        diagnostics: parsedInitial.diagnostics, visibleCount: 5_000
    };
    const listeners = new Set<(state: JsonlViewState) => void>();
    const notify = (): void => listeners.forEach(listener => listener(state));
    let selectionAnchor: string | null = null;
    const editable = (): boolean => state.loadState === 'complete';
    const renumber = (): void => entries.forEach((entry, index) => { entry.line = index + 1; });
    const lineEnding = (): '\n' | '\r\n' => entries.find(e => e.lineEnding)?.lineEnding === '\r\n' ? '\r\n' : '\n';
    const parseEntry = (raw: string, id: string, line: number): JsonlEntry => {
        const result = parseJsonl(raw).result;
        const entry = result.status === 'failed' ? undefined : result.document.entries[0];
        return entry ? { ...entry, id, line, lineEnding: lineEnding() } : { id, line, raw, lineEnding: lineEnding(), value: null, diagnostics: [] };
    };
    const reparseBytes = (done: boolean): void => {
        const result = parseJsonl(finalized(bytes, done)).result;
        if (result.status === 'failed') { state.status = 'failed'; state.diagnostics = result.diagnostics; return; }
        const existing = new Map(entries.filter(e => e.id.startsWith('source:')).map(e => [`source:${e.line}`, e.id]));
        entries = result.document.entries.map(entry => ({ ...entry, id: existing.get(`source:${entry.line}`) ?? `source:${entry.line}` }));
        state.entries = entries; state.status = result.status; state.diagnostics = result.diagnostics;
    };
    const loadMore = async (): Promise<void> => {
        if (!paged?.loadMore || state.loadState !== 'preview') return;
        state.loadState = 'loading'; notify();
        try { const page = await paged.loadMore(); bytes = concat(bytes, page.data); reparseBytes(page.done); state.loadState = page.done ? 'complete' : 'preview'; }
        catch { state.diagnostics = [...state.diagnostics, { severity: 'error', code: 'jsonl.load-failed', messageKey: 'diag.jsonl.load-failed' }]; state.loadState = 'preview'; }
        notify();
    };
    const loadAll = async (): Promise<void> => { while (state.loadState === 'preview') await loadMore(); };
    return {
        state,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        serialize: () => entries.map((entry, i) => entry.raw + (i === entries.length - 1 ? entry.lineEnding : entry.lineEnding || lineEnding())).join(''),
        canSave: () => editable() && entries.every(entry => !entry.raw.trim() || !entry.diagnostics.some(diagnostic => diagnostic.code === 'invalid-jsonl-line')),
        dispatch(action) {
            if (action.type === 'load-more') return loadMore();
            if (action.type === 'load-all') return loadAll();
            if (action.type === 'set-search') state.search = action.search;
            else if (action.type === 'select') { const selected = action.additive ? new Set(state.selected) : new Set<string>(); if (action.range && selectionAnchor) { const a = entries.findIndex(e => e.id === selectionAnchor), b = entries.findIndex(e => e.id === action.id); if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(entries[i]!.id); } else { selected.has(action.id) && action.additive ? selected.delete(action.id) : selected.add(action.id); selectionAnchor = action.id; } state.selected = selected; }
            else if (action.type === 'edit' && editable()) { const index = entries.findIndex(e => e.id === action.id); if (index >= 0) { const old = entries[index]!; entries[index] = parseEntry(action.raw, old.id, old.line); state.entries = entries; state.dirty = true; } }
            else if (action.type === 'insert' && editable()) { const id = `inserted:${nextId++}`; entries.push(parseEntry(action.raw ?? '{}', id, entries.length + 1)); state.entries = entries; state.dirty = true; }
            else if (action.type === 'delete-selected' && editable()) { entries = entries.filter(e => !state.selected.has(e.id)); renumber(); state.entries = entries; state.selected = new Set(); state.dirty = true; }
            else if (action.type === 'move' && editable()) { const from = entries.findIndex(e => e.id === action.from); const to = entries.findIndex(e => e.id === action.to); if (from >= 0 && to >= 0) { const item = entries.splice(from, 1)[0]; if (item) { entries.splice(to, 0, item); renumber(); state.entries = entries; state.dirty = true; } } }
            notify();
        }
    };
}
