import { asciiLower } from '../../parsers/csv/index.js';
import type { OpenApiDocument, OpenApiOperation } from '../../parsers/openapi/index.js';

export type OpenApiTab = 'operations' | 'schemas' | 'security' | 'source';
export const OPENAPI_PAGE_SIZE = 50;
export interface OpenApiViewState { tab: OpenApiTab; search: string; method: string; tag: string; page: number; selectedId: string | null; }
const normalizedSearchText = new WeakMap<OpenApiDocument, Map<string, string>>();

/** DOM-free filtering semantics for adapters that render the model themselves. */
export function filterOpenApiOperations(model: OpenApiDocument, filters: Pick<OpenApiViewState, 'search' | 'method' | 'tag'>): OpenApiOperation[] {
    const query = asciiLower(filters.search.trim());
    let normalized = normalizedSearchText.get(model);
    if (!normalized) { normalized = new Map(); normalizedSearchText.set(model, normalized); }
    const matches = new Map<string, boolean>();
    const tagMatches = new WeakMap<readonly string[], boolean>();
    const tagFilters = new WeakMap<readonly string[], boolean>();
    const textMatches = (value: string): boolean => {
        const cached = matches.get(value);
        if (cached !== undefined) return cached;
        let lower = normalized!.get(value);
        if (lower === undefined) { lower = asciiLower(value); normalized!.set(value, lower); }
        const match = lower.includes(query);
        matches.set(value, match);
        return match;
    };
    return model.operations.filter(operation => {
        if (filters.method && operation.method !== filters.method) return false;
        if (filters.tag) {
            let matched = tagFilters.get(operation.tags);
            if (matched === undefined) { matched = operation.tags.includes(filters.tag); tagFilters.set(operation.tags, matched); }
            if (!matched) return false;
        }
        if (!query) return true;
        if ([operation.path, operation.method, operation.operationId, operation.summary, operation.description].some(textMatches)) return true;
        let matched = tagMatches.get(operation.tags);
        if (matched === undefined) { matched = operation.tags.some(textMatches); tagMatches.set(operation.tags, matched); }
        return matched;
    });
}

export function createOpenApiController(model: OpenApiDocument) {
    let state: OpenApiViewState = { tab: 'operations', search: '', method: '', tag: '', page: 0, selectedId: model.operations[0]?.id ?? null };
    let filtered = filterOpenApiOperations(model, state);
    const listeners = new Set<() => void>();
    return {
        get state(): Readonly<OpenApiViewState> { return state; },
        get filtered(): OpenApiOperation[] { return filtered; },
        update(patch: Partial<OpenApiViewState>): void {
            const filterChanged = patch.search !== undefined || patch.method !== undefined || patch.tag !== undefined;
            state = { ...state, ...patch, ...(filterChanged ? { page: 0 } : {}) };
            if (filterChanged) filtered = filterOpenApiOperations(model, state);
            state.page = Math.max(0, Math.min(Math.floor(state.page), Math.max(0, Math.ceil(filtered.length / OPENAPI_PAGE_SIZE) - 1)));
            const page = filtered.slice(state.page * OPENAPI_PAGE_SIZE, (state.page + 1) * OPENAPI_PAGE_SIZE);
            if (!page.some(operation => operation.id === state.selectedId)) state.selectedId = page[0]?.id ?? null;
            for (const listener of listeners) listener();
        },
        subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); },
        dispose(): void { listeners.clear(); }
    };
}
