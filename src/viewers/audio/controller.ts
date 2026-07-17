// DOM-free presentation state for the waveform audio viewer. Playback time
// and play/pause live on the WaveSurfer instance (the engine owns them); the
// controller holds the pure knobs the toolbar mutates.

export const AUDIO_MIN_ZOOM = 1;
export const AUDIO_MAX_ZOOM = 32;
export const AUDIO_VOLUME_STEPS = 100;

export type AudioVisualization = 'waveform' | 'spectrogram';

export interface AudioViewState {
    /** Horizontal zoom multiplier over the fit-to-width pixel density. */
    zoom: number;
    /** 0..1 */
    volume: number;
    loop: boolean;
    visualization: AudioVisualization;
}

export type AudioAction =
    | { type: 'zoom-in' }
    | { type: 'zoom-out' }
    | { type: 'zoom-fit' }
    | { type: 'set-volume'; volume: number }
    | { type: 'toggle-loop' }
    | { type: 'set-visualization'; visualization: AudioVisualization };

export interface AudioController {
    readonly state: AudioViewState;
    dispatch(action: AudioAction): void;
    subscribe(listener: (state: AudioViewState) => void): () => void;
}

const clampZoom = (zoom: number): number => Math.min(AUDIO_MAX_ZOOM, Math.max(AUDIO_MIN_ZOOM, zoom));

export function createAudioController(): AudioController {
    let zoom = 1;
    let volume = 1;
    let loop = false;
    let visualization: AudioVisualization = 'waveform';
    const listeners = new Set<(state: AudioViewState) => void>();
    const snapshot = (): AudioViewState => ({ zoom, volume, loop, visualization });
    const emit = (): void => listeners.forEach((listener) => listener(snapshot()));
    return {
        get state() { return snapshot(); },
        dispatch(action) {
            const before = snapshot();
            switch (action.type) {
                case 'zoom-in': zoom = clampZoom(zoom * 2); break;
                case 'zoom-out': zoom = clampZoom(zoom / 2); break;
                case 'zoom-fit': zoom = 1; break;
                case 'set-volume': volume = Math.min(1, Math.max(0, action.volume)); break;
                case 'toggle-loop': loop = !loop; break;
                case 'set-visualization': visualization = action.visualization; break;
            }
            const after = snapshot();
            if (JSON.stringify(before) !== JSON.stringify(after)) emit();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
}
