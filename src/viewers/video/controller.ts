// DOM-free playback presentation state for the video viewer. Time/played
// state lives on the media element (the browser owns it); the controller only
// holds the pure, testable knobs the toolbar mutates: zoom and playback speed.

export const VIDEO_MIN_ZOOM = 0.25;
export const VIDEO_MAX_ZOOM = 4;
export const VIDEO_ZOOM_STEP = 0.25;
export const VIDEO_SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4] as const;

export interface VideoViewState {
    zoom: number;
    speed: number;
}

export type VideoAction =
    | { type: 'zoom-in' }
    | { type: 'zoom-out' }
    | { type: 'zoom-fit' }
    | { type: 'set-zoom'; zoom: number }
    | { type: 'set-speed'; speed: number };

export interface VideoController {
    readonly state: VideoViewState;
    dispatch(action: VideoAction): void;
    subscribe(listener: (state: VideoViewState) => void): () => void;
}

const clampZoom = (zoom: number): number =>
    Math.min(VIDEO_MAX_ZOOM, Math.max(VIDEO_MIN_ZOOM, Math.round(zoom / VIDEO_ZOOM_STEP) * VIDEO_ZOOM_STEP));

export function createVideoController(): VideoController {
    let zoom = 1;
    let speed = 1;
    const listeners = new Set<(state: VideoViewState) => void>();
    const snapshot = (): VideoViewState => ({ zoom, speed });
    const emit = (): void => listeners.forEach((listener) => listener(snapshot()));
    return {
        get state() { return snapshot(); },
        dispatch(action) {
            const before = snapshot();
            switch (action.type) {
                case 'zoom-in': zoom = clampZoom(zoom + VIDEO_ZOOM_STEP); break;
                case 'zoom-out': zoom = clampZoom(zoom - VIDEO_ZOOM_STEP); break;
                case 'zoom-fit': zoom = 1; break;
                case 'set-zoom': zoom = clampZoom(action.zoom); break;
                case 'set-speed':
                    if ((VIDEO_SPEED_OPTIONS as readonly number[]).includes(action.speed)) speed = action.speed;
                    break;
            }
            if (zoom !== before.zoom || speed !== before.speed) emit();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
}

/** mm:ss (or h:mm:ss) display used by the progress row and info panel. */
export function formatMediaTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const whole = Math.floor(seconds);
    const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
    const ms = `${m}:${String(s).padStart(2, '0')}`;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : ms;
}
