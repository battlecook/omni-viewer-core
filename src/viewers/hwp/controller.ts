export interface HwpViewState { zoom: number }
export type HwpAction = { type: 'zoom-in' } | { type: 'zoom-out' } | { type: 'reset-zoom' };
export interface HwpController {
    readonly state: HwpViewState;
    dispatch(action: HwpAction): void;
    subscribe(listener: (state: HwpViewState) => void): () => void;
}

export const HWP_MIN_ZOOM = 0.25;
export const HWP_MAX_ZOOM = 2.5;
export const HWP_ZOOM_STEP = 0.1;

export function createHwpController(): HwpController {
    let zoom = 1;
    const listeners = new Set<(state: HwpViewState) => void>();
    const snapshot = (): HwpViewState => ({ zoom });
    const emit = (): void => listeners.forEach((listener) => listener(snapshot()));
    return {
        get state() { return snapshot(); },
        dispatch(action) {
            if (action.type === 'zoom-in') zoom = Math.min(HWP_MAX_ZOOM, Math.round((zoom + HWP_ZOOM_STEP) * 100) / 100);
            if (action.type === 'zoom-out') zoom = Math.max(HWP_MIN_ZOOM, Math.round((zoom - HWP_ZOOM_STEP) * 100) / 100);
            if (action.type === 'reset-zoom') zoom = 1;
            emit();
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    };
}
