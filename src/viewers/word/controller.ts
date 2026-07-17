export interface WordViewState { zoom: number }
export type WordAction = { type: 'zoom-in' } | { type: 'zoom-out' } | { type: 'reset-zoom' };
export interface WordController {
    readonly state: WordViewState;
    dispatch(action: WordAction): void;
    subscribe(listener: (state: WordViewState) => void): () => void;
}

export const WORD_MIN_ZOOM = 0.25;
export const WORD_MAX_ZOOM = 2.5;
export const WORD_ZOOM_STEP = 0.1;

export function createWordController(): WordController {
    let zoom = 1;
    const listeners = new Set<(state: WordViewState) => void>();
    const snapshot = (): WordViewState => ({ zoom });
    const emit = (): void => listeners.forEach((listener) => listener(snapshot()));
    return {
        get state() { return snapshot(); },
        dispatch(action) {
            if (action.type === 'zoom-in') zoom = Math.min(WORD_MAX_ZOOM, Math.round((zoom + WORD_ZOOM_STEP) * 100) / 100);
            if (action.type === 'zoom-out') zoom = Math.max(WORD_MIN_ZOOM, Math.round((zoom - WORD_ZOOM_STEP) * 100) / 100);
            if (action.type === 'reset-zoom') zoom = 1;
            emit();
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    };
}
