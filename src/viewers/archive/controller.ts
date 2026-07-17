import type { ArchiveEntry } from '../../parsers/archive/index.js';

export interface ArchiveViewState { query: string; selectedId?: number; expanded: ReadonlySet<string>; entries: readonly ArchiveEntry[]; }
export type ArchiveAction = { type: 'set-search'; query: string } | { type: 'select'; entryId: number } | { type: 'toggle-directory'; path: string };
export interface ArchiveController { readonly state: ArchiveViewState; dispatch(action: ArchiveAction): void; visibleEntries(): readonly ArchiveEntry[]; subscribe(listener: () => void): () => void; }

const parent = (path: string): string => path.replace(/\/?[^/]+\/?$/, '');
export function createArchiveController(entries: readonly ArchiveEntry[]): ArchiveController {
    let state: ArchiveViewState = { query: '', expanded: new Set(entries.filter(x => x.isDirectory).map(x => x.path)), entries };
    const listeners = new Set<() => void>(); const emit = () => listeners.forEach(x => x());
    return { get state() { return state; }, dispatch(action) { if (action.type === 'set-search') state = { ...state, query: action.query }; else if (action.type === 'select') state = { ...state, selectedId: action.entryId }; else { const expanded = new Set(state.expanded); expanded.has(action.path) ? expanded.delete(action.path) : expanded.add(action.path); state = { ...state, expanded }; } emit(); }, visibleEntries() { const q = state.query.toLocaleLowerCase(); return state.entries.filter(entry => { if (q) return entry.path.toLocaleLowerCase().includes(q) || state.entries.some(x => x.path.startsWith(`${entry.path.replace(/\/$/, '')}/`) && x.path.toLocaleLowerCase().includes(q)); for (let p = parent(entry.path); p; p = parent(p)) if (!state.expanded.has(p) && !state.expanded.has(`${p}/`)) return false; return true; }); }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}
