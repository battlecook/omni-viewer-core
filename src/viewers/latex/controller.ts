// DOM-free view state for the LaTeX viewer (docs/viewers/latex.md §8).
//
// Five of these actions match `diagram-controller.ts` exactly. L9 keeps them
// separate on purpose: sharing would mean editing two shipped viewers
// (mermaid, plantuml) to buy deduplication, and the regression risk outweighs
// ~40 lines. When a fourth source-editing viewer appears, extract then.

export type LatexViewMode = 'preview' | 'split' | 'source';

export type LatexAction =
    | { type: 'set-mode'; mode: LatexViewMode }
    | { type: 'select-heading'; id: string }
    | { type: 'edit-source'; source: string }
    | { type: 'undo' }
    | { type: 'redo' }
    | { type: 'mark-saved' };

export interface LatexViewState {
    mode: LatexViewMode;
    selectedHeading?: string;
    source: string;
    savedSource: string;
    dirty: boolean;
    canUndo: boolean;
    canRedo: boolean;
}

export interface LatexController {
    readonly state: LatexViewState;
    dispatch(action: LatexAction): void;
    subscribe(listener: () => void): () => void;
}

const HISTORY_LIMIT = 100;
/**
 * Undo stores whole snapshots, so the entry count alone is not a bound: at the
 * parser's 10 MiB input limit, 100 of them is a gigabyte held for a document the
 * user may only be reading. Oldest snapshots are dropped once the stack exceeds
 * this, which costs depth on huge files and nothing on ordinary ones.
 */
const HISTORY_BUDGET_CHARS = 4 * 1024 * 1024;

/** History lives here rather than in the textarea so undo/redo behaves the
 *  same on every platform. */
export function createLatexController(text: string, mode: LatexViewMode = 'preview'): LatexController {
    let state: LatexViewState = {
        mode, source: text, savedSource: text, dirty: false, canUndo: false, canRedo: false
    };
    const undo: string[] = [];
    const redo: string[] = [];
    const listeners = new Set<() => void>();
    const emit = (): void => listeners.forEach(listener => listener());
    const setSource = (source: string): void => {
        state = { ...state, source, dirty: source !== state.savedSource, canUndo: undo.length > 0, canRedo: redo.length > 0 };
    };
    return {
        get state() { return state; },
        dispatch(action) {
            if (action.type === 'set-mode') state = { ...state, mode: action.mode };
            else if (action.type === 'select-heading') state = { ...state, selectedHeading: action.id };
            else if (action.type === 'edit-source' && action.source !== state.source) {
                undo.push(state.source);
                if (undo.length > HISTORY_LIMIT) undo.shift();
                let held = undo.reduce((sum, entry) => sum + entry.length, 0);
                while (undo.length > 1 && held > HISTORY_BUDGET_CHARS) {
                    held -= undo.shift()!.length;
                }
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
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    };
}
