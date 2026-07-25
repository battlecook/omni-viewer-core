export type DiagramKind = 'mermaid' | 'plantuml';
export type DiagramViewMode = 'diagram' | 'split' | 'source';
/** Theme identifiers understood by the two engines. Mermaid honors all four;
 *  PlantUML only 'light'/'dark'. The controller stores whatever the view sets
 *  and hands it back verbatim — validity is the renderer's concern. */
export type DiagramTheme = 'default' | 'dark' | 'forest' | 'neutral' | 'light';
export const MERMAID_THEMES: readonly DiagramTheme[] = ['default', 'dark', 'forest', 'neutral'];
export const PLANTUML_THEMES: readonly DiagramTheme[] = ['light', 'dark'];

export type DiagramAction =
    | { type: 'set-mode'; mode: DiagramViewMode }
    | { type: 'set-theme'; theme: DiagramTheme }
    | { type: 'edit-source'; source: string }
    | { type: 'undo' }
    | { type: 'redo' }
    | { type: 'mark-saved' };

export interface DiagramViewState {
    mode: DiagramViewMode;
    theme: DiagramTheme;
    source: string;
    savedSource: string;
    dirty: boolean;
    canUndo: boolean;
    canRedo: boolean;
}
export interface DiagramController {
    readonly state: DiagramViewState;
    dispatch(action: DiagramAction): void;
    subscribe(listener: () => void): () => void;
}

/** DOM-free state shared by the stage and the source editor. History lives here
 *  rather than in the textarea so undo/redo is deterministic and platform
 *  independent (mirrors createMarkdownController). */
export function createDiagramController(text: string, theme: DiagramTheme): DiagramController {
    let state: DiagramViewState = {
        mode: 'diagram', theme, source: text, savedSource: text,
        dirty: false, canUndo: false, canRedo: false
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
            else if (action.type === 'set-theme') state = { ...state, theme: action.theme };
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
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    };
}
