// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostContext } from '../../host/index.js';
import { createCatalogI18n } from '../../i18n/index.js';
import {
    mountAudioViewer,
    type AudioPluginHandle,
    type AudioRegionHandle,
    type AudioRegionsHandle,
    type AudioWaveformLibrary,
    type AudioWaveSurferHandle
} from './index.js';
import { createAudioController, AUDIO_MAX_ZOOM } from './controller.js';

function stubCtx(): HostContext {
    return {
        assets: { resolveAssetUrl: async (p) => p },
        i18n: createCatalogI18n(),
        logger: { log: () => undefined }
    };
}

function shadow(container: HTMLElement): ShadowRoot {
    const root = container.shadowRoot;
    if (!root) throw new Error('expected shadow root');
    return root;
}

const input = () => ({ fileName: 'song.mp3', data: Uint8Array.of(1, 2, 3, 4) });
const urlOptions = { createObjectUrl: () => 'blob:test', revokeObjectUrl: vi.fn() };

interface FakeSurfer extends AudioWaveSurferHandle {
    handlers: Map<string, Array<(payload?: unknown) => void>>;
    emit(event: string, payload?: unknown): void;
    calls: string[];
    zoomCalls: number[];
    destroyed: boolean;
}

function fakeSurfer(): FakeSurfer {
    const handlers = new Map<string, Array<(payload?: unknown) => void>>();
    const surfer: FakeSurfer = {
        handlers,
        calls: [],
        zoomCalls: [],
        destroyed: false,
        emit(event, payload) { (handlers.get(event) ?? []).forEach((handler) => handler(payload)); },
        on(event, callback) {
            const list = handlers.get(event) ?? [];
            list.push(callback);
            handlers.set(event, list);
            return () => undefined;
        },
        registerPlugin: (plugin) => plugin,
        playPause() { surfer.calls.push('playPause'); },
        stop() { surfer.calls.push('stop'); },
        setTime(seconds) { surfer.calls.push(`setTime:${seconds}`); },
        setVolume(volume) { surfer.calls.push(`setVolume:${volume}`); },
        zoom(pxPerSec) { surfer.zoomCalls.push(pxPerSec); },
        getDuration: () => 120,
        getCurrentTime: () => 5,
        getDecodedData: () => ({ numberOfChannels: 2, sampleRate: 44100, duration: 120 }),
        destroy() { surfer.destroyed = true; }
    };
    return surfer;
}

function fakeRegions(): AudioRegionsHandle & { handlers: Map<string, Array<(region: AudioRegionHandle) => void>>; cleared: number; emit(event: string, region: AudioRegionHandle): void } {
    const handlers = new Map<string, Array<(region: AudioRegionHandle) => void>>();
    return {
        handlers,
        cleared: 0,
        emit(event, region) { (handlers.get(event) ?? []).forEach((handler) => handler(region)); },
        on(event, callback) {
            const list = handlers.get(event) ?? [];
            list.push(callback);
            handlers.set(event, list);
            return () => undefined;
        },
        clearRegions() { this.cleared++; },
        getRegions: () => [],
        enableDragSelection: () => () => undefined
    };
}

function library(surfer: FakeSurfer, regions?: AudioRegionsHandle, spectrogram?: () => AudioPluginHandle): AudioWaveformLibrary {
    return {
        createWaveSurfer: () => surfer,
        ...(regions ? { createRegions: () => regions } : {}),
        createTimeline: () => ({}),
        ...(spectrogram ? { createSpectrogram: spectrogram } : {})
    };
}

afterEach(() => vi.restoreAllMocks());

describe('audio viewer without waveform deps', () => {
    it('falls back to the plain media player', async () => {
        vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
        vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
        const container = document.createElement('div');
        const handle = await mountAudioViewer(input(), container, stubCtx(), urlOptions);
        const root = shadow(container);
        expect(root.querySelector('audio')).toBeTruthy();
        expect(root.querySelector('.omni-audio')).toBeNull();
        handle.dispose();
    });

    it('falls back with a warning when the engine fails to load', async () => {
        vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
        vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
        const container = document.createElement('div');
        const handle = await mountAudioViewer(input(), container, stubCtx(), {
            ...urlOptions,
            deps: { loadWaveform: () => Promise.reject(new Error('missing')) }
        });
        const root = shadow(container);
        expect(root.querySelector('audio')).toBeTruthy();
        expect(root.textContent).toContain('Waveform engine unavailable');
        handle.dispose();
    });
});

describe('audio viewer with waveform engine', () => {
    it('renders the full toolbar and enables controls once ready', async () => {
        const surfer = fakeSurfer();
        const container = document.createElement('div');
        const handle = await mountAudioViewer(input(), container, stubCtx(), {
            ...urlOptions,
            deps: { loadWaveform: async () => library(surfer) }
        });
        const root = shadow(container);
        const playButton = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Play')!;
        expect(playButton.disabled).toBe(true);
        surfer.emit('ready');
        expect(playButton.disabled).toBe(false);
        expect(root.textContent).toContain('44,100 Hz');
        expect(root.textContent).toContain('2 (stereo)');
        expect(root.querySelector('.omni-audio__time')!.textContent).toBe('0:05 / 2:00');
        playButton.click();
        expect(surfer.calls).toContain('playPause');
        handle.dispose();
        expect(surfer.destroyed).toBe(true);
        expect(root.querySelector('.omni-audio')).toBeNull();
    });

    it('applies zoom multipliers over the fit density', async () => {
        const surfer = fakeSurfer();
        const container = document.createElement('div');
        const handle = await mountAudioViewer(input(), container, stubCtx(), {
            ...urlOptions,
            deps: { loadWaveform: async () => library(surfer) }
        });
        const root = shadow(container);
        surfer.emit('ready');
        surfer.zoomCalls.length = 0;
        const zoomIn = [...root.querySelectorAll('button')].find((b) => b.title === 'Zoom in')!;
        zoomIn.click();
        // jsdom width is 0 → base falls back to 800/120 px/s
        expect(surfer.zoomCalls.at(-1)).toBeCloseTo((800 / 120) * 2);
        expect(root.querySelector('.omni-audio__zoom-label')!.textContent).toBe('×2');
        handle.dispose();
    });

    it('supports region selection, loop replay and clearing', async () => {
        const surfer = fakeSurfer();
        const regions = fakeRegions();
        const container = document.createElement('div');
        const handle = await mountAudioViewer(input(), container, stubCtx(), {
            ...urlOptions,
            deps: { loadWaveform: async () => library(surfer, regions) }
        });
        const root = shadow(container);
        surfer.emit('ready');
        const played: string[] = [];
        const region: AudioRegionHandle = { id: 'r1', start: 3, end: 8.5, play: () => played.push('r1'), remove: () => undefined };
        regions.emit('region-created', region);
        expect(root.querySelector('.omni-audio__status')!.textContent).toContain('0:03 – 0:08');

        regions.emit('region-out', region);
        expect(played).toEqual([]); // loop off

        const loopButton = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Loop')!;
        loopButton.click();
        regions.emit('region-out', region);
        expect(played).toEqual(['r1']);

        const clearButton = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Clear regions')!;
        clearButton.click();
        expect(regions.cleared).toBe(1);
        expect(root.querySelector('.omni-audio__status')!.textContent).not.toContain('0:03');
        handle.dispose();
    });

    it('loops the whole track on finish when no region is selected', async () => {
        const surfer = fakeSurfer();
        const container = document.createElement('div');
        const handle = await mountAudioViewer(input(), container, stubCtx(), {
            ...urlOptions,
            deps: { loadWaveform: async () => library(surfer) }
        });
        const root = shadow(container);
        surfer.emit('ready');
        [...root.querySelectorAll('button')].find((b) => b.textContent === 'Loop')!.click();
        surfer.calls.length = 0;
        surfer.emit('finish');
        expect(surfer.calls).toEqual(['setTime:0', 'playPause']);
        handle.dispose();
    });

    it('toggles the spectrogram plugin through the visualization select', async () => {
        const surfer = fakeSurfer();
        const destroyed: string[] = [];
        const container = document.createElement('div');
        const handle = await mountAudioViewer(input(), container, stubCtx(), {
            ...urlOptions,
            deps: { loadWaveform: async () => library(surfer, undefined, () => ({ destroy: () => destroyed.push('spec') })) }
        });
        const root = shadow(container);
        surfer.emit('ready');
        const select = root.querySelector('select') as HTMLSelectElement;
        select.value = 'spectrogram';
        select.dispatchEvent(new Event('change'));
        expect(root.querySelector('.omni-audio__spectrogram--active')).toBeTruthy();
        select.value = 'waveform';
        select.dispatchEvent(new Event('change'));
        expect(destroyed).toEqual(['spec']);
        handle.dispose();
    });

    it('shows a decode warning on engine error and revokes the URL on dispose', async () => {
        const revoke = vi.fn();
        const surfer = fakeSurfer();
        const container = document.createElement('div');
        const handle = await mountAudioViewer(input(), container, stubCtx(), {
            createObjectUrl: () => 'blob:audio',
            revokeObjectUrl: revoke,
            deps: { loadWaveform: async () => library(surfer) }
        });
        const root = shadow(container);
        surfer.emit('error', new Error('bad codec'));
        const warning = root.querySelector('.omni-audio__warning') as HTMLElement;
        expect(warning.hidden).toBe(false);
        expect(warning.textContent).toContain('could not decode');
        handle.dispose();
        expect(revoke).toHaveBeenCalledWith('blob:audio');
    });
});

describe('audio viewer with WASM decode engine', () => {
    it('rebuilds on a re-encoded WAV when the browser decode fails', async () => {
        const surfers: FakeSurfer[] = [];
        const created: Array<{ url: string; type?: string }> = [];
        const lib: AudioWaveformLibrary = {
            createWaveSurfer: () => { const s = fakeSurfer(); surfers.push(s); return s; }
        };
        const engine = {
            decode: vi.fn(async () => ({ sampleRate: 8000, channels: 1, frames: 4, pcm: new Float32Array([0, 0.5, -0.5, 1]) })),
            analyze: vi.fn()
        };
        const container = document.createElement('div');
        let urlIndex = 0;
        const handle = await mountAudioViewer(input(), container, stubCtx(), {
            createObjectUrl: (blob) => { created.push({ url: `blob:${urlIndex}`, type: blob.type }); return `blob:${urlIndex++}`; },
            revokeObjectUrl: vi.fn(),
            deps: { loadWaveform: async () => lib, engine }
        });
        surfers[0]!.emit('error', new Error('undecodable'));
        await vi.waitFor(() => expect(surfers.length).toBe(2));
        expect(engine.decode).toHaveBeenCalledOnce();
        expect(created[1]?.type).toBe('audio/wav');
        surfers[1]!.emit('ready');
        const root = shadow(container);
        expect((root.querySelector('.omni-audio__warning') as HTMLElement).hidden).toBe(true);
        // A second failure does not retry the engine.
        surfers[1]!.emit('error', new Error('still bad'));
        expect(engine.decode).toHaveBeenCalledOnce();
        expect((root.querySelector('.omni-audio__warning') as HTMLElement).hidden).toBe(false);
        handle.dispose();
    });

    it('feeds WASM peak analysis to the surfer for large files', async () => {
        const createOptions: Array<Record<string, unknown>> = [];
        const surfer = fakeSurfer();
        const lib: AudioWaveformLibrary = {
            createWaveSurfer: (options) => { createOptions.push(options as unknown as Record<string, unknown>); return surfer; }
        };
        const engine = {
            decode: vi.fn(),
            analyze: vi.fn(async () => ({ sampleRate: 44100, channels: 2, duration: 60, peaks: [0.1, 0.9] }))
        };
        const container = document.createElement('div');
        const handle = await mountAudioViewer(input(), container, stubCtx(), {
            ...urlOptions,
            engineAnalyzeBytes: 2, // 4-byte fixture exceeds this
            deps: { loadWaveform: async () => lib, engine }
        });
        expect(engine.analyze).toHaveBeenCalledOnce();
        expect(createOptions[0]?.peaks).toEqual([[0.1, 0.9]]);
        expect(createOptions[0]?.duration).toBe(60);
        const root = shadow(container);
        expect(root.textContent).toContain('44,100 Hz');
        expect(root.textContent).toContain('1:00');
        handle.dispose();
    });
});

describe('audio controller', () => {
    it('doubles and clamps zoom, clamps volume, toggles loop', () => {
        const controller = createAudioController();
        controller.dispatch({ type: 'zoom-in' });
        controller.dispatch({ type: 'zoom-in' });
        expect(controller.state.zoom).toBe(4);
        for (let i = 0; i < 10; i++) controller.dispatch({ type: 'zoom-in' });
        expect(controller.state.zoom).toBe(AUDIO_MAX_ZOOM);
        controller.dispatch({ type: 'zoom-fit' });
        expect(controller.state.zoom).toBe(1);
        controller.dispatch({ type: 'set-volume', volume: 4 });
        expect(controller.state.volume).toBe(1);
        controller.dispatch({ type: 'toggle-loop' });
        expect(controller.state.loop).toBe(true);
    });
});
