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
import { encodeWavFromFloat32 } from './engine.js';
import { MountAbortedError } from '../types.js';

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
/** mp3 is withheld from the engine (ENGINE_UNSAFE_EXTENSIONS), so tests that
 *  exercise engine behaviour need a format the engine is allowed to handle. */
const engineInput = () => ({ fileName: 'song.flac', data: Uint8Array.of(1, 2, 3, 4) });
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

function library(
    surfer: FakeSurfer,
    regions?: AudioRegionsHandle,
    spectrogram?: NonNullable<AudioWaveformLibrary['createSpectrogram']>
): AudioWaveformLibrary {
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
        // The label reports the visible window, not the multiplier: the fake
        // track is 120 s, so 2x shows one minute.
        const label = root.querySelector('.omni-audio__zoom-label')!;
        expect(label.textContent).toBe('1m');
        [...root.querySelectorAll('button')].find((b) => b.textContent === 'Fit')!.click();
        expect(label.textContent).toBe('2m');
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
        const handle = await mountAudioViewer(engineInput(), container, stubCtx(), {
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
        const handle = await mountAudioViewer(engineInput(), container, stubCtx(), {
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

    // Dragging cannot express an exact boundary, so a selected region exposes
    // typeable start/end/length fields (restored from the original viewer).
    describe('region time editors', () => {
        const selectRegion = async (overrides: Partial<AudioRegionHandle> = {}) => {
            const surfer = fakeSurfer();
            const regions = fakeRegions();
            const container = document.createElement('div');
            const handle = await mountAudioViewer(input(), container, stubCtx(), {
                ...urlOptions,
                deps: { loadWaveform: async () => library(surfer, regions) }
            });
            surfer.emit('ready');
            const region: AudioRegionHandle = {
                id: 'r1',
                start: 10,
                end: 20,
                play: () => undefined,
                remove: () => undefined,
                setOptions(options) {
                    if (options.start !== undefined) region.start = options.start;
                    if (options.end !== undefined) region.end = options.end;
                },
                ...overrides
            };
            regions.emit('region-created', region);
            const root = shadow(container);
            return {
                handle, root, region, surfer, regions,
                editor: root.querySelector('.omni-audio__region-editor') as HTMLElement,
                start: root.querySelector('.omni-audio__region-field--start input') as HTMLInputElement,
                end: root.querySelector('.omni-audio__region-field--end input') as HTMLInputElement,
                duration: root.querySelector('.omni-audio__region-field--duration input') as HTMLInputElement
            };
        };

        it('stays hidden until a region exists', async () => {
            const surfer = fakeSurfer();
            const container = document.createElement('div');
            const handle = await mountAudioViewer(input(), container, stubCtx(), {
                ...urlOptions,
                deps: { loadWaveform: async () => library(surfer, fakeRegions()) }
            });
            surfer.emit('ready');
            expect((shadow(container).querySelector('.omni-audio__region-editor') as HTMLElement).hidden).toBe(true);
            handle.dispose();
        });

        it('shows the selected region bounds and length', async () => {
            const { handle, editor, start, end, duration } = await selectRegion();
            expect(editor.hidden).toBe(false);
            expect(start.value).toBe('10.000');
            expect(end.value).toBe('20.000');
            expect(duration.value).toBe('10.000');
            handle.dispose();
        });

        it('applies a typed start to the region', async () => {
            const { handle, region, start, duration } = await selectRegion();
            start.value = '12.5';
            start.dispatchEvent(new Event('change'));
            expect(region.start).toBe(12.5);
            expect(region.end).toBe(20);
            expect(duration.value).toBe('7.500');
            handle.dispose();
        });

        it('swaps reversed bounds rather than rejecting them', async () => {
            const { handle, region, end } = await selectRegion();
            end.value = '4';
            end.dispatchEvent(new Event('change'));
            expect(region.start).toBe(4);
            expect(region.end).toBe(10);
            handle.dispose();
        });

        it('moves the end, not the start, when the length is typed', async () => {
            const { handle, region, start, end } = await selectRegion();
            const durationInput = start.closest('.omni-audio__region-editor')!
                .querySelector('.omni-audio__region-field--duration input') as HTMLInputElement;
            durationInput.value = '3';
            durationInput.dispatchEvent(new Event('change'));
            expect(region.start).toBe(10);
            expect(region.end).toBe(13);
            expect(end.value).toBe('13.000');
            handle.dispose();
        });

        it('clamps a typed value beyond the track', async () => {
            const { handle, region, end } = await selectRegion();
            end.value = '9999';
            end.dispatchEvent(new Event('change'));
            expect(region.end).toBe(120); // fake surfer duration
            handle.dispose();
        });

        it('commits on Enter as well as change', async () => {
            const { handle, region, start } = await selectRegion();
            start.value = '15';
            start.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            expect(region.start).toBe(15);
            handle.dispose();
        });

        it('tracks drags through the region update event', async () => {
            const listeners: Array<() => void> = [];
            const { handle, region, start, end } = await selectRegion({
                on(_event: string, callback: () => void) { listeners.push(callback); return () => undefined; }
            });
            region.start = 30;
            region.end = 45;
            listeners.forEach((notify) => notify());
            expect(start.value).toBe('30.000');
            expect(end.value).toBe('45.000');
            handle.dispose();
        });

        it('re-creates the region when the engine cannot move it in place', async () => {
            const surfer = fakeSurfer();
            const regions = fakeRegions();
            let added: { start: number; end: number } | undefined;
            let removed = false;
            regions.addRegion = (options) => {
                added = { start: options.start, end: options.end };
                return { id: 'r2', start: options.start, end: options.end, play: () => undefined, remove: () => undefined };
            };
            const container = document.createElement('div');
            const handle = await mountAudioViewer(input(), container, stubCtx(), {
                ...urlOptions,
                deps: { loadWaveform: async () => library(surfer, regions) }
            });
            surfer.emit('ready');
            regions.emit('region-created', {
                id: 'r1', start: 10, end: 20, play: () => undefined, remove: () => { removed = true; }
            });
            const startInput = shadow(container)
                .querySelector('.omni-audio__region-field--start input') as HTMLInputElement;
            startInput.value = '5';
            startInput.dispatchEvent(new Event('change'));
            expect(removed).toBe(true);
            expect(added).toEqual({ start: 5, end: 20 });
            handle.dispose();
        });

        it('hides when regions are cleared', async () => {
            const { handle, root, editor } = await selectRegion();
            [...root.querySelectorAll('button')].find((b) => b.textContent === 'Clear regions')!.click();
            expect(editor.hidden).toBe(true);
            handle.dispose();
        });
    });

    // The plugin fixes its tick spacing at construction, and on the normal
    // path the duration only exists at 'ready'. Building it before then pins a
    // long track to 1-second ticks — worse than the engine's own default.
    describe('timeline intervals', () => {
        const mountWithTimeline = async (extra: Record<string, unknown> = {}) => {
            const created: Array<Record<string, unknown>> = [];
            const destroyed: number[] = [];
            const surfer = fakeSurfer();
            const lib: AudioWaveformLibrary = {
                createWaveSurfer: () => surfer,
                createTimeline: (options) => {
                    created.push(options as unknown as Record<string, unknown>);
                    const index = created.length - 1;
                    return { destroy: () => destroyed.push(index) };
                }
            };
            const container = document.createElement('div');
            const handle = await mountAudioViewer(input(), container, stubCtx(), {
                ...urlOptions, ...extra,
                deps: { loadWaveform: async () => lib }
            });
            return { handle, surfer, created, destroyed };
        };

        it('waits for the duration instead of guessing', async () => {
            const { handle, surfer, created } = await mountWithTimeline();
            expect(created).toHaveLength(0);
            surfer.emit('ready'); // fake duration is 120s
            expect(created).toHaveLength(1);
            // 120s over the 1000px fallback width is 8.33px/s, so the first
            // round step clearing 100px between ticks is 15s.
            expect(created[0]).toMatchObject({ timeInterval: 15, primaryLabelInterval: 75 });
            handle.dispose();
        });

        it('does not rebuild when the duration is unchanged', async () => {
            const { handle, surfer, created } = await mountWithTimeline();
            surfer.emit('ready');
            surfer.emit('ready');
            expect(created).toHaveLength(1);
            handle.dispose();
        });
    });

    describe('download', () => {
        it('saves the original bytes through the host save service', async () => {
            const saved: Array<{ name: string; bytes: number; mime: string }> = [];
            const ctx = {
                ...stubCtx(),
                save: {
                    saveFile: async (name: string, data: Uint8Array, mimeType: string) => {
                        saved.push({ name, bytes: data.byteLength, mime: mimeType });
                    }
                }
            };
            const container = document.createElement('div');
            const handle = await mountAudioViewer(input(), container, ctx, {
                ...urlOptions,
                deps: { loadWaveform: async () => library(fakeSurfer()) }
            });
            const button = [...shadow(container).querySelectorAll('button')]
                .find((b) => b.textContent === 'Download')!;
            expect(button.disabled).toBe(false);
            button.click();
            await Promise.resolve();
            expect(saved).toEqual([{ name: 'song.mp3', bytes: 4, mime: 'audio/mpeg' }]);
            handle.dispose();
        });

        it('disables the button and explains why without the service', async () => {
            const container = document.createElement('div');
            const handle = await mountAudioViewer(input(), container, stubCtx(), {
                ...urlOptions,
                deps: { loadWaveform: async () => library(fakeSurfer()) }
            });
            const button = [...shadow(container).querySelectorAll('button')]
                .find((b) => b.textContent === 'Download')!;
            expect(button.disabled).toBe(true);
            expect(button.title).toContain('unavailable');
            handle.dispose();
        });
    });

    describe('visualization modes', () => {
        const mountWithSpectrogram = async () => {
            const surfer = fakeSurfer();
            const created: Array<Record<string, unknown>> = [];
            const destroyed: number[] = [];
            const lib = library(surfer, undefined, (options) => {
                created.push(options as unknown as Record<string, unknown>);
                const index = created.length - 1;
                return { destroy: () => destroyed.push(index) };
            });
            const container = document.createElement('div');
            const handle = await mountAudioViewer(input(), container, stubCtx(), {
                ...urlOptions,
                deps: { loadWaveform: async () => lib }
            });
            surfer.emit('ready');
            const root = shadow(container);
            const selects = [...root.querySelectorAll('select')];
            return {
                handle, root, created, destroyed,
                vis: selects[0]!,
                scale: selects[1]!,
                wave: root.querySelector('.omni-audio__waveform-wrap') as HTMLElement,
                spectrogram: root.querySelector('.omni-audio__spectrogram') as HTMLElement
            };
        };

        it('offers waveform, spectrogram and both', async () => {
            const { handle, vis } = await mountWithSpectrogram();
            expect([...vis.options].map((o) => o.value)).toEqual(['waveform', 'spectrogram', 'both']);
            handle.dispose();
        });

        it('keeps the waveform visible in both mode', async () => {
            const { handle, vis, wave, spectrogram, created } = await mountWithSpectrogram();
            vis.value = 'both';
            vis.dispatchEvent(new Event('change'));
            expect(wave.hidden).toBe(false);
            expect(spectrogram.classList.contains('omni-audio__spectrogram--active')).toBe(true);
            expect(created).toHaveLength(1);
            handle.dispose();
        });

        it('hides the waveform in spectrogram-only mode', async () => {
            const { handle, vis, wave } = await mountWithSpectrogram();
            vis.value = 'spectrogram';
            vis.dispatchEvent(new Event('change'));
            expect(wave.hidden).toBe(true);
            handle.dispose();
        });

        it('exposes the scale control only while a spectrogram is shown', async () => {
            const { handle, root, vis } = await mountWithSpectrogram();
            const group = root.querySelector('.omni-audio__group--scale') as HTMLElement;
            expect(group.hidden).toBe(true);
            vis.value = 'spectrogram';
            vis.dispatchEvent(new Event('change'));
            expect(group.hidden).toBe(false);
            vis.value = 'waveform';
            vis.dispatchEvent(new Event('change'));
            expect(group.hidden).toBe(true);
            handle.dispose();
        });

        it('builds the spectrogram with mel and the original FFT settings', async () => {
            const { handle, vis, created } = await mountWithSpectrogram();
            vis.value = 'spectrogram';
            vis.dispatchEvent(new Event('change'));
            expect(created[0]).toMatchObject({
                scale: 'mel', fftSamples: 4096, noverlap: 2048, height: 250, labels: true
            });
            handle.dispose();
        });

        // The plugin fixes its scale at construction, so a scale change has to
        // rebuild it rather than mutate it.
        it('rebuilds the spectrogram when the scale changes', async () => {
            const { handle, vis, scale, created, destroyed } = await mountWithSpectrogram();
            vis.value = 'spectrogram';
            vis.dispatchEvent(new Event('change'));
            expect(created).toHaveLength(1);

            scale.value = 'bark';
            scale.dispatchEvent(new Event('change'));
            expect(destroyed).toEqual([0]);
            expect(created).toHaveLength(2);
            expect(created[1]).toMatchObject({ scale: 'bark' });
            handle.dispose();
        });

        it('does not rebuild when the scale is unchanged', async () => {
            const { handle, vis, scale, created } = await mountWithSpectrogram();
            vis.value = 'spectrogram';
            vis.dispatchEvent(new Event('change'));
            scale.value = 'mel';
            scale.dispatchEvent(new Event('change'));
            expect(created).toHaveLength(1);
            handle.dispose();
        });
    });

    describe('keyboard', () => {
        it('toggles playback with Space once ready', async () => {
            const surfer = fakeSurfer();
            const container = document.createElement('div');
            document.body.append(container);
            const handle = await mountAudioViewer(input(), container, stubCtx(), {
                ...urlOptions,
                deps: { loadWaveform: async () => library(surfer) }
            });
            // Ignored before the track is ready.
            document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
            expect(surfer.calls).not.toContain('playPause');

            surfer.emit('ready');
            document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
            expect(surfer.calls).toContain('playPause');
            handle.dispose();
            container.remove();
        });

        it('ignores Space while typing in a region field', async () => {
            const surfer = fakeSurfer();
            const regions = fakeRegions();
            const container = document.createElement('div');
            document.body.append(container);
            const handle = await mountAudioViewer(input(), container, stubCtx(), {
                ...urlOptions,
                deps: { loadWaveform: async () => library(surfer, regions) }
            });
            surfer.emit('ready');
            regions.emit('region-created', {
                id: 'r1', start: 1, end: 2, play: () => undefined, remove: () => undefined
            });
            const startInput = shadow(container)
                .querySelector('.omni-audio__region-field--start input') as HTMLInputElement;
            startInput.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
            expect(surfer.calls).not.toContain('playPause');
            handle.dispose();
            container.remove();
        });

        it('stops responding after dispose', async () => {
            const surfer = fakeSurfer();
            const container = document.createElement('div');
            document.body.append(container);
            const handle = await mountAudioViewer(input(), container, stubCtx(), {
                ...urlOptions,
                deps: { loadWaveform: async () => library(surfer) }
            });
            surfer.emit('ready');
            handle.dispose();
            document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
            expect(surfer.calls).not.toContain('playPause');
            container.remove();
        });
    });

    // The engine mishandles mp3 (see ENGINE_UNSAFE_EXTENSIONS): short inputs
    // never return, long ones return a wrong duration. Until a rebuilt engine
    // ships, mp3 must take the slower browser decode rather than a fast wrong
    // waveform.
    it('withholds the engine for mp3 and warns that the slow path is in use', async () => {
        const surfer = fakeSurfer();
        const lib: AudioWaveformLibrary = { createWaveSurfer: () => surfer };
        const engine = { decode: vi.fn(), analyze: vi.fn() };
        const ctx = stubCtx();
        const container = document.createElement('div');
        const handle = await mountAudioViewer({ ...input(), fileName: 'podcast.mp3' }, container, ctx, {
            ...urlOptions,
            engineAnalyzeBytes: 2,
            deps: { loadWaveform: async () => lib, engine }
        });
        expect(engine.analyze).not.toHaveBeenCalled();
        const warning = shadow(container).querySelector('.omni-audio__warning') as HTMLElement;
        expect(warning.hidden).toBe(false);
        expect(warning.textContent).toContain('Waveform pre-analysis is unavailable');

        // The decode-failure recovery path must stay closed for mp3 too.
        surfer.emit('error', new Error('codec'));
        expect(engine.decode).not.toHaveBeenCalled();
        handle.dispose();
    });

    it('still uses the engine for formats it handles correctly', async () => {
        const surfer = fakeSurfer();
        const lib: AudioWaveformLibrary = { createWaveSurfer: () => surfer };
        const engine = {
            decode: vi.fn(),
            analyze: vi.fn(async () => ({ sampleRate: 44100, channels: 2, duration: 60, peaks: [0.2] }))
        };
        const container = document.createElement('div');
        const handle = await mountAudioViewer({ ...input(), fileName: 'take.flac' }, container, stubCtx(), {
            ...urlOptions,
            engineAnalyzeBytes: 2,
            deps: { loadWaveform: async () => lib, engine }
        });
        expect(engine.analyze).toHaveBeenCalledOnce();
        handle.dispose();
    });

    // WAV needs no decoder, so the streaming pyramid analyzer runs instead of
    // the engine: constant memory, real per-channel columns, and a duration
    // derived from the frames actually seen.
    describe('streaming analysis for WAV', () => {
        const wavInput = (frames: number, left: number, right: number) => ({
            fileName: 'take.wav',
            data: (() => {
                const pcm = new Float32Array(frames * 2);
                for (let f = 0; f < frames; f++) {
                    pcm[f * 2] = f % 2 ? left : -left;
                    pcm[f * 2 + 1] = f % 2 ? right : -right;
                }
                return encodeWavFromFloat32(pcm, 2, 8000);
            })()
        });

        it('prefers the streaming analyzer and never calls the engine', async () => {
            const createOptions: Array<Record<string, unknown>> = [];
            const surfer = fakeSurfer();
            const lib: AudioWaveformLibrary = {
                createWaveSurfer: (o) => { createOptions.push(o as unknown as Record<string, unknown>); return surfer; }
            };
            const engine = { decode: vi.fn(), analyze: vi.fn() };
            const container = document.createElement('div');
            const handle = await mountAudioViewer(wavInput(8000, 0.8, 0.2), container, stubCtx(), {
                ...urlOptions,
                engineAnalyzeBytes: 2,
                deps: { loadWaveform: async () => lib, engine }
            });
            expect(engine.analyze).not.toHaveBeenCalled();

            const peaks = createOptions[0]?.peaks as number[][];
            expect(peaks).toHaveLength(2);
            expect(Math.max(...peaks[0]!)).toBeCloseTo(0.8, 2);
            expect(Math.max(...peaks[1]!)).toBeCloseTo(0.2, 2);
            expect(createOptions[0]?.duration).toBeCloseTo(1, 6);

            const root = shadow(container);
            expect(root.textContent).toContain('8,000 Hz');
            expect(root.textContent).toContain('2 (stereo)');
            handle.dispose();
        });

        it('works with no engine at all', async () => {
            const createOptions: Array<Record<string, unknown>> = [];
            const surfer = fakeSurfer();
            const lib: AudioWaveformLibrary = {
                createWaveSurfer: (o) => { createOptions.push(o as unknown as Record<string, unknown>); return surfer; }
            };
            const container = document.createElement('div');
            const handle = await mountAudioViewer(wavInput(4000, 0.5, 0.5), container, stubCtx(), {
                ...urlOptions,
                engineAnalyzeBytes: 2,
                deps: { loadWaveform: async () => lib }
            });
            expect((createOptions[0]?.peaks as number[][]).length).toBe(2);
            handle.dispose();
        });

        it('falls back to the engine for formats it cannot read', async () => {
            const createOptions: Array<Record<string, unknown>> = [];
            const surfer = fakeSurfer();
            const lib: AudioWaveformLibrary = {
                createWaveSurfer: (o) => { createOptions.push(o as unknown as Record<string, unknown>); return surfer; }
            };
            const engine = {
                decode: vi.fn(),
                analyze: vi.fn(async () => ({ sampleRate: 44100, channels: 2, duration: 60, peaks: [0.3, 0.6] }))
            };
            const container = document.createElement('div');
            const handle = await mountAudioViewer(engineInput(), container, stubCtx(), {
                ...urlOptions,
                engineAnalyzeBytes: 2,
                deps: { loadWaveform: async () => lib, engine }
            });
            expect(engine.analyze).toHaveBeenCalledOnce();
            expect(createOptions[0]?.peaks).toEqual([[0.3, 0.6]]);
            handle.dispose();
        });

        // The streaming reader reports cancellation as a plain Error. Treating
        // that as "not a WAV" would start the engine on a file the user has
        // already closed, delaying teardown by up to the worker timeout.
        it('aborts instead of falling through to the engine when cancelled', async () => {
            const surfer = fakeSurfer();
            const lib: AudioWaveformLibrary = { createWaveSurfer: () => surfer };
            const engine = { decode: vi.fn(), analyze: vi.fn() };

            // Cancellation has to land *inside* the streaming read: the mount
            // already guards the earlier steps, so a signal aborted before them
            // would never exercise this path. The first two reads are those
            // guards; the third is the reader's own per-chunk check, where it
            // throws a plain Error rather than MountAbortedError.
            let reads = 0;
            const signal = { get aborted(): boolean { return ++reads > 2; } } as AbortSignal;

            await expect(mountAudioViewer(
                { fileName: 'take.wav', data: wavInput(40000, 0.5, 0.5).data },
                document.createElement('div'),
                stubCtx(),
                {
                    ...urlOptions,
                    engineAnalyzeBytes: 2,
                    signal,
                    deps: { loadWaveform: async () => lib, engine }
                }
            )).rejects.toBeInstanceOf(MountAbortedError);
            expect(engine.analyze).not.toHaveBeenCalled();
        });

        // 8000 columns for the whole track means zooming past that resolution
        // only stretches bars. The ceiling has to follow the peaks, not the
        // duration.
        it('caps zoom at the peak resolution rather than the duration', async () => {
            const surfer = fakeSurfer();
            surfer.getDuration = () => 7200; // two hours
            const lib: AudioWaveformLibrary = { createWaveSurfer: () => surfer };
            const container = document.createElement('div');
            const handle = await mountAudioViewer(wavInput(8000, 0.5, 0.5), container, stubCtx(), {
                ...urlOptions,
                engineAnalyzeBytes: 2,
                deps: { loadWaveform: async () => lib }
            });
            surfer.emit('ready');

            const root = shadow(container);
            const zoomIn = [...root.querySelectorAll('button')].find((b) => b.title === 'Zoom in')!;
            for (let i = 0; i < 20; i++) zoomIn.click();
            const label = root.querySelector('.omni-audio__zoom-label')!;
            // 8000 columns / 250 minimum visible = 32x, so 7200s / 32 = 225s.
            expect(label.textContent).toBe('4m');
            handle.dispose();
        });

        it('leaves small WAV files on the full-decode path', async () => {
            const createOptions: Array<Record<string, unknown>> = [];
            const surfer = fakeSurfer();
            const lib: AudioWaveformLibrary = {
                createWaveSurfer: (o) => { createOptions.push(o as unknown as Record<string, unknown>); return surfer; }
            };
            const container = document.createElement('div');
            const handle = await mountAudioViewer(wavInput(1000, 0.5, 0.5), container, stubCtx(), {
                ...urlOptions, // default 50 MiB threshold
                deps: { loadWaveform: async () => lib }
            });
            expect(createOptions[0]?.peaks).toBeUndefined();
            handle.dispose();
        });
    });

    // A large file can analyze fine and still fail to play, at which point the
    // engine remuxes it to WAV. That rebuilt stream is decoded in full, so the
    // peaks-mode restrictions have to lift with it.
    it('leaves peaks mode when the engine rebuilds the stream as WAV', async () => {
        const surfers = [fakeSurfer(), fakeSurfer()];
        let index = 0;
        // The rebuilt surfer has real samples, unlike the peaks-mode one.
        surfers[1]!.getDecodedData = () => ({
            numberOfChannels: 2,
            sampleRate: 44100,
            duration: 120,
            getChannelData: (channel: number) =>
                new Float32Array(channel === 0 ? [0.5, -0.5] : [0.25, -0.25])
        });
        const lib = library(surfers[0]!, undefined, () => ({ destroy: () => undefined }));
        lib.createWaveSurfer = () => surfers[index++]!;
        const engine = {
            analyze: vi.fn(async () => ({ sampleRate: 44100, channels: 2, duration: 60, peaks: [0.4] })),
            decode: vi.fn(async () => ({
                sampleRate: 44100, channels: 2, frames: 2,
                pcm: new Float32Array([0.1, 0.2, 0.3, 0.4])
            }))
        };
        const container = document.createElement('div');
        const handle = await mountAudioViewer(engineInput(), container, stubCtx(), {
            ...urlOptions,
            engineAnalyzeBytes: 2,
            deps: { loadWaveform: async () => lib, engine }
        });
        const root = shadow(container);
        const visSelect = root.querySelector('select') as HTMLSelectElement;

        surfers[0]!.emit('ready');
        expect(visSelect.disabled).toBe(true); // peaks mode: no samples to transform

        surfers[0]!.emit('error', new Error('cannot play this codec'));
        await vi.waitFor(() => expect(engine.decode).toHaveBeenCalledOnce());
        surfers[1]!.emit('ready');

        expect(visSelect.disabled).toBe(false);
        expect(root.textContent).toContain('L peak');
        handle.dispose();
    });

    // WaveSurfer answers getDecodedData() in peaks mode with a buffer it
    // synthesizes from the peak array itself (wavesurfer.js@7 wavesurfer.js:373
    // -> decoder.js:64-68): sampleRate is peaks.length / duration and
    // numberOfChannels is the number of peak arrays. Neither describes the
    // real audio, so 'ready' must not let them replace the analysis values.
    it('keeps engine analysis values when the surfer reports a synthetic peaks buffer', async () => {
        const surfer = fakeSurfer();
        const peaks = [0.1, 0.9];
        surfer.getDecodedData = () => ({
            numberOfChannels: 1,
            sampleRate: peaks.length / 60,
            duration: 60
        });
        const lib: AudioWaveformLibrary = { createWaveSurfer: () => surfer };
        const engine = {
            decode: vi.fn(),
            analyze: vi.fn(async () => ({ sampleRate: 44100, channels: 2, duration: 60, peaks }))
        };
        const container = document.createElement('div');
        const handle = await mountAudioViewer(engineInput(), container, stubCtx(), {
            ...urlOptions,
            engineAnalyzeBytes: 2,
            deps: { loadWaveform: async () => lib, engine }
        });
        surfer.emit('ready');
        const root = shadow(container);
        expect(root.textContent).toContain('44,100 Hz');
        expect(root.textContent).toContain('2 (stereo)');
        expect(root.textContent).not.toContain('0.033 Hz');
        expect(root.textContent).not.toContain('1 (mono)');
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
