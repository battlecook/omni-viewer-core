import type { MarkdownHeading } from '../../parsers/markdown/index.js';

export type MarkdownViewMode = 'preview' | 'split' | 'source';
export type MarkdownAction =
    | { type: 'set-mode'; mode: MarkdownViewMode }
    | { type: 'set-search'; query: string }
    | { type: 'next-match' }
    | { type: 'select-heading'; id: string }
    | { type: 'edit-source'; source: string }
    | { type: 'undo' }
    | { type: 'redo' }
    | { type: 'mark-saved' }
    | { type: 'copy-code'; code: string };
export interface MarkdownMatch { start: number; end: number; }
export interface MarkdownViewState {
    mode: MarkdownViewMode;
    query: string;
    matchIndex: number;
    selectedHeading?: string;
    source: string;
    savedSource: string;
    dirty: boolean;
    canUndo: boolean;
    canRedo: boolean;
}
export interface MarkdownController {
    readonly state: MarkdownViewState;
    dispatch(action: MarkdownAction): void;
    matches(): readonly MarkdownMatch[];
    subscribe(listener: () => void): () => void;
}

/** State shared by the preview and source editor. History is kept here rather
 * than relying on a textarea's platform-specific undo implementation. */
export function createMarkdownController(text: string, _headings: readonly MarkdownHeading[]): MarkdownController {
    let state: MarkdownViewState = {
        mode: 'preview', query: '', matchIndex: 0, source: text, savedSource: text,
        dirty: false, canUndo: false, canRedo: false
    };
    const undo: string[] = [];
    const redo: string[] = [];
    const listeners = new Set<() => void>();
    const emit = (): void => listeners.forEach(listener => listener());
    const setSource = (source: string): void => {
        state = { ...state, source, dirty: source !== state.savedSource, canUndo: undo.length > 0, canRedo: redo.length > 0 };
    };
    const matches = (): MarkdownMatch[] => {
        const needle = state.query.toLocaleLowerCase();
        if (!needle) return [];
        const haystack = state.source.toLocaleLowerCase();
        const result: MarkdownMatch[] = [];
        for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + Math.max(1, needle.length))) {
            result.push({ start: at, end: at + needle.length });
        }
        return result;
    };
    return {
        get state() { return state; },
        dispatch(action) {
            if (action.type === 'set-mode') state = { ...state, mode: action.mode };
            else if (action.type === 'set-search') state = { ...state, query: action.query, matchIndex: 0 };
            else if (action.type === 'next-match') {
                const count = matches().length;
                state = { ...state, matchIndex: count ? (state.matchIndex + 1) % count : 0 };
            } else if (action.type === 'select-heading') state = { ...state, selectedHeading: action.id };
            else if (action.type === 'edit-source' && action.source !== state.source) {
                undo.push(state.source);
                if (undo.length > 100) undo.shift();
                redo.length = 0;
                setSource(action.source);
            } else if (action.type === 'undo' && undo.length) {
                redo.push(state.source);
                setSource(undo.pop()!);
            } else if (action.type === 'redo' && redo.length) {
                undo.push(state.source);
                setSource(redo.pop()!);
            } else if (action.type === 'mark-saved') {
                state = { ...state, savedSource: state.source, dirty: false };
            }
            emit();
        },
        matches,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    };
}
