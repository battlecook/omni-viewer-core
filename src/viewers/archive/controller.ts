import type { ArchiveEntry } from '../../parsers/archive/index.js';

export interface ArchiveViewState { query: string; selectedId?: number; expanded: ReadonlySet<string>; entries: readonly ArchiveEntry[]; }
export type ArchiveAction = { type: 'set-search'; query: string } | { type: 'select'; entryId: number } | { type: 'toggle-directory'; path: string };
export interface ArchiveController { readonly state: ArchiveViewState; dispatch(action: ArchiveAction): void; visibleEntries(): readonly ArchiveEntry[]; subscribe(listener: () => void): () => void; }

const parent = (path: string): string => path.replace(/\/?[^/]+\/?$/, '');

/** Adds view-only directory entries for archives that contain `a/b.txt` but
 * omit an explicit `a/` record. Original entries and IDs are left untouched.
 * Synthetic IDs are negative because decoder-owned entry IDs are non-negative. */
export function addImplicitArchiveDirectories(entries: readonly ArchiveEntry[], maxSyntheticDirectories = 100_000): readonly ArchiveEntry[] {
    const explicit = new Set(entries.filter(entry => entry.isDirectory).map(entry => entry.path.replace(/\\/g, '/').replace(/\/+$/, '')));
    const synthetic = new Set<string>();
    const result: ArchiveEntry[] = [];
    let nextSyntheticId = -1;
    for (const entry of entries) {
        const normalized = entry.path.replace(/\\/g, '/').replace(/^\/+/, '');
        const segments = normalized.split('/').filter(Boolean);
        for (let depth = 1; depth < segments.length && synthetic.size < maxSyntheticDirectories; depth++) {
            const path = segments.slice(0, depth).join('/');
            if (explicit.has(path) || synthetic.has(path)) continue;
            synthetic.add(path);
            result.push({ entryId: nextSyntheticId--, path: `${path}/`, isDirectory: true });
        }
        result.push(entry);
    }
    return result;
}

export function createArchiveController(entries: readonly ArchiveEntry[]): ArchiveController {
    let state: ArchiveViewState = { query: '', expanded: new Set(entries.filter(x => x.isDirectory).map(x => x.path)), entries };
    const listeners = new Set<() => void>(); const emit = () => listeners.forEach(x => x());
    return { get state() { return state; }, dispatch(action) { if (action.type === 'set-search') state = { ...state, query: action.query }; else if (action.type === 'select') state = { ...state, selectedId: action.entryId }; else { const expanded = new Set(state.expanded); expanded.has(action.path) ? expanded.delete(action.path) : expanded.add(action.path); state = { ...state, expanded }; } emit(); }, visibleEntries() { const q = state.query.toLocaleLowerCase(); return state.entries.filter(entry => { if (q) return entry.path.toLocaleLowerCase().includes(q) || state.entries.some(x => x.path.startsWith(`${entry.path.replace(/\/$/, '')}/`) && x.path.toLocaleLowerCase().includes(q)); for (let p = parent(entry.path); p; p = parent(p)) if (!state.expanded.has(p) && !state.expanded.has(`${p}/`)) return false; return true; }); }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}
