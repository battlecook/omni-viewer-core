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
        play() { surfer.calls.push('play'); },
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

function fakeRegions(): AudioRegionsHandle & { handlers: Map<string, Array<(region: AudioRegionHandle) => void>>; emit(event: string, region: AudioRegionHandle): void } {
    const handlers = new Map<string, Array<(region: AudioRegionHandle) => void>>();
    return {
        handlers,
        emit(event, region) { (handlers.get(event) ?? []).forEach((handler) => handler(region)); },
        on(event, callback) {
            const list = handlers.get(event) ?? [];
            list.push(callback);
            handlers.set(event, list);
            return () => undefined;
        },
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
        const playButton = root.querySelector('.omni-audio__btn--play') as HTMLButtonElement;
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

    describe('transport', () => {
        const mountWithRegion = async () => {
            const surfer = fakeSurfer();
            const regions = fakeRegions();
            const played: string[] = [];
            const container = document.createElement('div');
            const handle = await mountAudioViewer(input(), container, stubCtx(), {
                ...urlOptions,
                deps: { loadWaveform: async () => library(surfer, regions) }
            });
            surfer.emit('ready');
            const root = shadow(container);
            return {
                handle, root, surfer, regions, played,
                play: root.querySelector('.omni-audio__btn--play') as HTMLButtonElement,
                select: () => regions.emit('region-created', {
                    id: 'r1', start: 3, end: 8,
                    play: () => played.push('r1'),
                    remove: () => undefined
                })
            };
        };

        // A selected region is what the user is working on, so playback should
        // start at its head rather than wherever the cursor happens to sit.
        it('starts at the region head when one is selected', async () => {
            const { handle, play, select, played, surfer } = await mountWithRegion();
            select();
            play.click();
            expect(played).toEqual(['r1']);
            expect(surfer.calls).not.toContain('playPause');
            handle.dispose();
        });

        it('plays from the cursor when no region is selected', async () => {
            const { handle, play, played, surfer } = await mountWithRegion();
            play.click();
            expect(played).toEqual([]);
            expect(surfer.calls).toContain('playPause');
            handle.dispose();
        });

        // One button, two states: pressing it while playing must pause rather
        // than restart the region.
        it('pauses instead of restarting once playback is under way', async () => {
            const { handle, play, select, played, surfer } = await mountWithRegion();
            select();
            play.click();
            surfer.emit('play');
            expect(play.getAttribute('aria-label')).toBe('Pause');

            surfer.calls.length = 0;
            play.click();
            expect(played).toEqual(['r1']); // not played a second time
            expect(surfer.calls).toEqual(['playPause']);

            surfer.emit('pause');
            expect(play.getAttribute('aria-label')).toBe('Play');
            handle.dispose();
        });

        it('offers a single transport button', async () => {
            const { handle, root } = await mountWithRegion();
            expect(root.querySelectorAll('.omni-audio__btn--icon')).toHaveLength(1);
            handle.dispose();
        });
    });

    // Zoom means nothing before the duration is known, and the original viewer
    // kept the group out of the toolbar until then.
    it('reveals the zoom group only once ready', async () => {
        const surfer = fakeSurfer();
        const container = document.createElement('div');
        const handle = await mountAudioViewer(input(), container, stubCtx(), {
            ...urlOptions,
            deps: { loadWaveform: async () => library(surfer) }
        });
        const group = [...shadow(container).querySelectorAll('.omni-audio__group')]
            .find((g) => g.querySelector('.omni-audio__zoom-label')) as HTMLElement;
        expect(group.hidden).toBe(true);
        surfer.emit('ready');
        expect(group.hidden).toBe(false);
        handle.dispose();
    });

    it('marks the active view mode instead of hiding it behind a menu', async () => {
        const surfer = fakeSurfer();
        const container = document.createElement('div');
        const handle = await mountAudioViewer(input(), container, stubCtx(), {
            ...urlOptions,
            deps: { loadWaveform: async () => library(surfer, undefined, () => ({ destroy: () => undefined })) }
        });
        surfer.emit('ready');
        const root = shadow(container);
        const button = (mode: string): HTMLButtonElement =>
            root.querySelector(`.omni-audio__mode[data-mode="${mode}"]`) as HTMLButtonElement;

        expect(button('waveform').getAttribute('aria-pressed')).toBe('true');
        expect(button('both').getAttribute('aria-pressed')).toBe('false');
        button('both').click();
        expect(button('both').getAttribute('aria-pressed')).toBe('true');
        expect(button('both').classList.contains('is-active')).toBe(true);
        expect(button('waveform').getAttribute('aria-pressed')).toBe('false');
        handle.dispose();
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

        const loopBox = root.querySelector('.omni-audio__checkbox') as HTMLInputElement;
        const loopGroup = loopBox.closest('.omni-audio__group--loop') as HTMLElement;
        expect(loopGroup.hidden).toBe(false);
        // The label names what the toggle will repeat, which the selection decides.
        expect(loopGroup.textContent).toBe('Loop region');
        // jsdom does not fire 'change' for a checkbox click; browsers do.
        loopBox.checked = true;
        loopBox.dispatchEvent(new Event('change'));
        regions.emit('region-out', region);
        expect(played).toEqual(['r1']);

        regions.emit('region-removed', region);
        expect(root.querySelector('.omni-audio__status')!.textContent).not.toContain('0:03');
        expect(loopGroup.textContent).toBe('Loop track');
        handle.dispose();
    });

    // Whole-track looping has to be reachable without first making a region:
    // the toggle is in the toolbar from 'ready' onwards, and what it repeats
    // follows the selection.
    it('loops the whole track on finish once no region is selected', async () => {
        const surfer = fakeSurfer();
        const regions = fakeRegions();
        const container = document.createElement('div');
        const handle = await mountAudioViewer(input(), container, stubCtx(), {
            ...urlOptions,
            deps: { loadWaveform: async () => library(surfer, regions) }
        });
        const root = shadow(container);
        surfer.emit('ready');

        const loopGroup = root.querySelector('.omni-audio__group--loop') as HTMLElement;
        expect(loopGroup.hidden).toBe(false);
        expect(loopGroup.textContent).toBe('Loop track');

        const loopBox = root.querySelector('.omni-audio__checkbox') as HTMLInputElement;
        loopBox.checked = true;
        loopBox.dispatchEvent(new Event('change'));

        surfer.calls.length = 0;
        surfer.emit('finish');
        // play(), not playPause(): wavesurfer 7.12.1 has not settled its
        // playing flag when 'finish' fires, so the toggle read it as "playing"
        // and stopped the track instead of looping it.
        expect(surfer.calls).toEqual(['setTime:0', 'play']);
        handle.dispose();
    });

    it('falls back to the toggle when the engine exposes no play', async () => {
        const surfer = fakeSurfer();
        delete (surfer as { play?: unknown }).play;
        const regions = fakeRegions();
        const container = document.createElement('div');
        const handle = await mountAudioViewer(input(), container, stubCtx(), {
            ...urlOptions,
            deps: { loadWaveform: async () => library(surfer, regions) }
        });
        const root = shadow(container);
        surfer.emit('ready');
        const loopBox = root.querySelector('.omni-audio__checkbox') as HTMLInputElement;
        loopBox.checked = true;
        loopBox.dispatchEvent(new Event('change'));

        surfer.calls.length = 0;
        surfer.emit('finish');
        expect(surfer.calls).toEqual(['setTime:0', 'playPause']);
        handle.dispose();
    });

    it('toggles the spectrogram plugin through the view-mode buttons', async () => {
        const surfer = fakeSurfer();
        const destroyed: string[] = [];
        const container = document.createElement('div');
        const handle = await mountAudioViewer(input(), container, stubCtx(), {
            ...urlOptions,
            deps: { loadWaveform: async () => library(surfer, undefined, () => ({ destroy: () => destroyed.push('spec') })) }
        });
        const root = shadow(container);
        surfer.emit('ready');
        const mode = (value: string): HTMLButtonElement =>
            root.querySelector(`.omni-audio__mode[data-mode="${value}"]`) as HTMLButtonElement;
        mode('spectrogram').click();
        expect(root.querySelector('.omni-audio__spectrogram--active')).toBeTruthy();
        mode('waveform').click();
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

        // A value typed past the opposite edge becomes that edge: the other
        // boundary stays where it is.
        it('swaps reversed bounds rather than rejecting them', async () => {
            const { handle, region, end } = await selectRegion(); // 10..20
            end.value = '4';
            end.dispatchEvent(new Event('change'));
            expect(region.start).toBe(4);
            expect(region.end).toBe(10);
            handle.dispose();
        });

        it('swaps the same way when the start is typed past the end', async () => {
            const { handle, region, start, end } = await selectRegion(); // 10..20
            start.value = '35';
            start.dispatchEvent(new Event('change'));
            expect(region.start).toBe(20);
            expect(region.end).toBe(35);
            expect(start.value).toBe('20.000');
            expect(end.value).toBe('35.000');
            handle.dispose();
        });

        // Each field commits against the region's own other edge. Reading the
        // other *input* instead is what collapsed a region to the 0.1s minimum:
        // Enter commits twice (keydown and change), and the second pass saw the
        // field it had just rewritten alongside the one still holding the typed
        // text. (jsdom reports no focus inside a shadow root, so the focus half
        // of that sequence is covered by the browser check, not here.)
        it('commits against the region, not whatever the other field shows', async () => {
            const { handle, region, start, end } = await selectRegion(); // 10..20
            end.value = '999';
            start.value = '12';
            start.dispatchEvent(new Event('change'));
            expect(region.start).toBe(12);
            expect(region.end).toBe(20);
            expect(end.value).toBe('20.000');
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
            const { handle, root, region, start, end } = await selectRegion({
                on(_event: string, callback: () => void) { listeners.push(callback); return () => undefined; }
            });
            region.start = 30;
            region.end = 45;
            listeners.forEach((notify) => notify());
            expect(start.value).toBe('30.000');
            expect(end.value).toBe('45.000');
            // The summary has to move with the editors; showing the bounds the
            // region had when it was selected contradicts the fields.
            expect(root.querySelector('.omni-audio__status')!.textContent)
                .toContain('0:30');
            handle.dispose();
        });

        // Pressing away from the selection drops it: the engine moves the
        // playhead there, and a highlight somewhere else would contradict it.
        describe('pressing the waveform away from the selection', () => {
            const mountWithAnchoredRegion = async () => {
                const surfer = fakeSurfer();
                const regions = fakeRegions();
                const container = document.createElement('div');
                const handle = await mountAudioViewer(input(), container, stubCtx(), {
                    ...urlOptions,
                    deps: { loadWaveform: async () => library(surfer, regions) }
                });
                surfer.emit('ready');
                const root = shadow(container);
                const waveform = root.querySelector('.omni-audio__waveform') as HTMLElement;

                // The region element has to live inside the waveform for the
                // containment check to mean anything.
                const regionElement = document.createElement('div');
                waveform.append(regionElement);
                let removed = false;
                const region: AudioRegionHandle = {
                    id: 'r1', start: 3, end: 8, element: regionElement,
                    play: () => undefined,
                    remove: () => { removed = true; regions.emit('region-removed', region); }
                };
                regions.emit('region-created', region);
                return { handle, root, waveform, regionElement, wasRemoved: () => removed };
            };

            it('drops the selection', async () => {
                const { handle, root, waveform, wasRemoved } = await mountWithAnchoredRegion();
                waveform.dispatchEvent(new Event('pointerdown', { bubbles: true }));
                expect(wasRemoved()).toBe(true);
                expect((root.querySelector('.omni-audio__region-editor') as HTMLElement).hidden).toBe(true);
                handle.dispose();
            });

            it('keeps the selection when the press lands on the region', async () => {
                const { handle, root, regionElement, wasRemoved } = await mountWithAnchoredRegion();
                regionElement.dispatchEvent(new Event('pointerdown', { bubbles: true }));
                expect(wasRemoved()).toBe(false);
                expect((root.querySelector('.omni-audio__region-editor') as HTMLElement).hidden).toBe(false);
                handle.dispose();
            });

            it('keeps the selection when the press lands on a resize handle', async () => {
                const { handle, regionElement, wasRemoved } = await mountWithAnchoredRegion();
                const handleEl = document.createElement('div');
                regionElement.append(handleEl);
                handleEl.dispatchEvent(new Event('pointerdown', { bubbles: true }));
                expect(wasRemoved()).toBe(false);
                handle.dispose();
            });

            // What the engine actually does: regions are rendered inside its
            // own shadow root, so the event this listener sees has been
            // retargeted to the shadow host. Testing containment against that
            // target reports "outside" for every press, which dropped the
            // selection instead of letting the region be dragged.
            it('keeps the selection when the region lives in the engine shadow root', async () => {
                const surfer = fakeSurfer();
                const regions = fakeRegions();
                const container = document.createElement('div');
                const handle = await mountAudioViewer(input(), container, stubCtx(), {
                    ...urlOptions,
                    deps: { loadWaveform: async () => library(surfer, regions) }
                });
                surfer.emit('ready');
                const root = shadow(container);
                const waveform = root.querySelector('.omni-audio__waveform') as HTMLElement;

                const host = document.createElement('div');
                waveform.append(host);
                const regionElement = document.createElement('div');
                host.attachShadow({ mode: 'open' }).append(regionElement);

                let removed = false;
                const region: AudioRegionHandle = {
                    id: 'r1', start: 3, end: 8, element: regionElement,
                    play: () => undefined,
                    remove: () => { removed = true; regions.emit('region-removed', region); }
                };
                regions.emit('region-created', region);

                regionElement.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
                expect(removed).toBe(false);
                expect((root.querySelector('.omni-audio__region-editor') as HTMLElement).hidden).toBe(false);

                // A press elsewhere in the waveform still drops it.
                waveform.dispatchEvent(new Event('pointerdown', { bubbles: true }));
                expect(removed).toBe(true);
                handle.dispose();
            });

            it('does nothing when there is no selection', async () => {
                const surfer = fakeSurfer();
                const container = document.createElement('div');
                const handle = await mountAudioViewer(input(), container, stubCtx(), {
                    ...urlOptions,
                    deps: { loadWaveform: async () => library(surfer, fakeRegions()) }
                });
                surfer.emit('ready');
                const waveform = shadow(container).querySelector('.omni-audio__waveform') as HTMLElement;
                expect(() => waveform.dispatchEvent(new Event('pointerdown', { bubbles: true }))).not.toThrow();
                handle.dispose();
            });
        });

        // The toolbar carries no region controls beyond the loop toggle: a
        // region is dropped by pressing the waveform outside it.
        it('offers no clear-regions button', async () => {
            const { handle, root } = await selectRegion();
            expect([...root.querySelectorAll('button')].map((b) => b.textContent))
                .not.toContain('Clear regions');
            handle.dispose();
        });

        it('reserves space under the waveform only while the editor is shown', async () => {
            const { handle, root, regions, region } = await selectRegion();
            const wrap = root.querySelector('.omni-audio__waveform-wrap') as HTMLElement;
            expect(wrap.classList.contains('is-editing-region')).toBe(true);
            regions.emit('region-removed', region);
            expect(wrap.classList.contains('is-editing-region')).toBe(false);
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

        // Dragging a new selection replaces the old one. The editors and the
        // status line describe a single region, so leaving earlier ones on the
        // waveform shows selections nothing can act on.
        it('drops the previous region when a new one is dragged', async () => {
            const surfer = fakeSurfer();
            const regions = fakeRegions();
            const live: AudioRegionHandle[] = [];
            regions.getRegions = () => [...live];

            const makeRegion = (id: string, start: number, end: number): AudioRegionHandle => {
                const region: AudioRegionHandle = {
                    id, start, end,
                    play: () => undefined,
                    remove: () => {
                        live.splice(live.indexOf(region), 1);
                        regions.emit('region-removed', region);
                    }
                };
                live.push(region);
                return region;
            };

            const container = document.createElement('div');
            const handle = await mountAudioViewer(input(), container, stubCtx(), {
                ...urlOptions,
                deps: { loadWaveform: async () => library(surfer, regions) }
            });
            surfer.emit('ready');

            regions.emit('region-created', makeRegion('r1', 1, 2));
            expect(live.map((r) => r.id)).toEqual(['r1']);

            regions.emit('region-created', makeRegion('r2', 5, 6));
            expect(live.map((r) => r.id)).toEqual(['r2']);

            // The survivor is the one the editors describe.
            const start = shadow(container)
                .querySelector('.omni-audio__region-field--start input') as HTMLInputElement;
            expect(start.value).toBe('5.000');
            expect((shadow(container).querySelector('.omni-audio__region-editor') as HTMLElement).hidden).toBe(false);
            handle.dispose();
        });

        it('keeps the clicked region when selecting an existing one', async () => {
            const surfer = fakeSurfer();
            const regions = fakeRegions();
            const region: AudioRegionHandle = {
                id: 'r1', start: 3, end: 4, play: () => undefined, remove: () => undefined
            };
            regions.getRegions = () => [region];
            const container = document.createElement('div');
            const handle = await mountAudioViewer(input(), container, stubCtx(), {
                ...urlOptions,
                deps: { loadWaveform: async () => library(surfer, regions) }
            });
            surfer.emit('ready');
            regions.emit('region-clicked', region);
            const start = shadow(container)
                .querySelector('.omni-audio__region-field--start input') as HTMLInputElement;
            expect(start.value).toBe('3.000');
            handle.dispose();
        });

        // The original viewer put the length above the region and the bounds
        // below it. jsdom has no layout, so the geometry is injected.
        it('places length above the region and start/end below it', async () => {
            const surfer = fakeSurfer();
            const regions = fakeRegions();
            const container = document.createElement('div');
            const handle = await mountAudioViewer(input(), container, stubCtx(), {
                ...urlOptions,
                deps: { loadWaveform: async () => library(surfer, regions) }
            });
            surfer.emit('ready');

            const root = shadow(container);
            const wrap = root.querySelector('.omni-audio__waveform-wrap') as HTMLElement;
            const rect = (left: number, top: number, right: number, bottom: number): DOMRect =>
                ({ left, top, right, bottom, width: right - left, height: bottom - top } as DOMRect);
            wrap.getBoundingClientRect = () => rect(0, 0, 1000, 128);

            const regionElement = document.createElement('div');
            regionElement.getBoundingClientRect = () => rect(200, 0, 400, 128);
            regions.emit('region-created', {
                id: 'r1', start: 2, end: 4, element: regionElement,
                play: () => undefined, remove: () => undefined
            });

            const at = (selector: string): { left: number; top: number } => {
                const field = root.querySelector(selector) as HTMLElement;
                return { left: Number.parseFloat(field.style.left), top: Number.parseFloat(field.style.top) };
            };
            const start = at('.omni-audio__region-field--start');
            const duration = at('.omni-audio__region-field--duration');
            const end = at('.omni-audio__region-field--end');

            expect(duration.top).toBeLessThan(start.top);   // length sits above
            expect(start.top).toBe(end.top);                // bounds share a row
            expect(duration.left).toBe(300);                // centre of 200..400
            expect(start.left).toBeLessThan(duration.left);
            expect(end.left).toBeGreaterThan(duration.left);
            handle.dispose();
        });

        it('keeps every field inside the waveform for a region at the edge', async () => {
            const surfer = fakeSurfer();
            const regions = fakeRegions();
            const container = document.createElement('div');
            const handle = await mountAudioViewer(input(), container, stubCtx(), {
                ...urlOptions,
                deps: { loadWaveform: async () => library(surfer, regions) }
            });
            surfer.emit('ready');

            const root = shadow(container);
            const wrap = root.querySelector('.omni-audio__waveform-wrap') as HTMLElement;
            const rect = (left: number, top: number, right: number, bottom: number): DOMRect =>
                ({ left, top, right, bottom, width: right - left, height: bottom - top } as DOMRect);
            wrap.getBoundingClientRect = () => rect(0, 0, 1000, 128);

            const regionElement = document.createElement('div');
            regionElement.getBoundingClientRect = () => rect(980, 0, 1000, 128); // hard right
            regions.emit('region-created', {
                id: 'r1', start: 118, end: 120, element: regionElement,
                play: () => undefined, remove: () => undefined
            });

            for (const selector of ['--start', '--duration', '--end']) {
                const field = root.querySelector(`.omni-audio__region-field${selector}`) as HTMLElement;
                const left = Number.parseFloat(field.style.left);
                expect(left, selector).toBeGreaterThanOrEqual(0);
                expect(left, selector).toBeLessThanOrEqual(1000);
            }
            handle.dispose();
        });

        it('hides when the region goes away', async () => {
            const { handle, regions, region, editor } = await selectRegion();
            regions.emit('region-removed', region);
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
            const mode = (value: string): HTMLButtonElement =>
                root.querySelector(`.omni-audio__mode[data-mode="${value}"]`) as HTMLButtonElement;
            return {
                handle, root, created, destroyed,
                mode,
                scale: root.querySelector('.omni-audio__group--scale select') as HTMLSelectElement,
                wave: root.querySelector('.omni-audio__waveform-wrap') as HTMLElement,
                spectrogram: root.querySelector('.omni-audio__spectrogram') as HTMLElement
            };
        };

        it('offers waveform, spectrogram and both', async () => {
            const { handle, root } = await mountWithSpectrogram();
            expect([...root.querySelectorAll('.omni-audio__mode')].map((b) => (b as HTMLElement).dataset.mode))
                .toEqual(['waveform', 'spectrogram', 'both']);
            handle.dispose();
        });

        it('keeps the waveform visible in both mode', async () => {
            const { handle, mode, wave, spectrogram, created } = await mountWithSpectrogram();
            mode('both').click();
            expect(wave.classList.contains('is-collapsed')).toBe(false);
            expect(spectrogram.classList.contains('omni-audio__spectrogram--active')).toBe(true);
            expect(created).toHaveLength(1);
            handle.dispose();
        });

        // Collapsed, never `hidden`: display:none drops the waveform from
        // layout, and the spectrogram plugin reads its width to pick the hop.
        // Measured on a 12-minute track — width 0 never finishes rendering,
        // a real width renders in ~6 s.
        it('collapses rather than hides the waveform in spectrogram-only mode', async () => {
            const { handle, mode, wave } = await mountWithSpectrogram();
            mode('spectrogram').click();
            expect(wave.classList.contains('is-collapsed')).toBe(true);
            expect(wave.hidden).toBe(false);
            handle.dispose();
        });

        // The playhead clamp that keeps the cursor off an inline spectrogram is
        // scoped to that case and sized to the waveform. Unscoped at a fixed
        // 128px it cut the second channel's played overlay away entirely: a
        // stereo file draws one 128px strip per channel.
        it('clamps the playhead only while an inline spectrogram is mounted', async () => {
            const { handle, mode, wave } = await mountWithSpectrogram();
            expect(wave.classList.contains('has-inline-spectrogram')).toBe(false);
            mode('spectrogram').click();
            expect(wave.classList.contains('has-inline-spectrogram')).toBe(true);
            mode('waveform').click();
            expect(wave.classList.contains('has-inline-spectrogram')).toBe(false);
            handle.dispose();
        });

        it('sizes the clamp to every channel strip', async () => {
            const { handle, wave } = await mountWithSpectrogram();
            // The fake decodes as stereo, so the waveform is two strips tall.
            expect(wave.style.getPropertyValue('--omni-audio-wave-height')).toBe('256px');
            handle.dispose();
        });

        it('restores the waveform when switching back', async () => {
            const { handle, mode, wave } = await mountWithSpectrogram();
            mode('spectrogram').click();
            mode('waveform').click();
            expect(wave.classList.contains('is-collapsed')).toBe(false);
            handle.dispose();
        });

        it('exposes the scale control only while a spectrogram is shown', async () => {
            const { handle, root, mode } = await mountWithSpectrogram();
            const group = root.querySelector('.omni-audio__group--scale') as HTMLElement;
            expect(group.hidden).toBe(true);
            mode('spectrogram').click();
            expect(group.hidden).toBe(false);
            mode('waveform').click();
            expect(group.hidden).toBe(true);
            handle.dispose();
        });

        // noverlap must stay unset: the plugin derives the hop from the canvas
        // width, and pinning it doubled the column count — each column a
        // synchronous FFT, which froze the tab on a 12-minute track.
        it('builds the spectrogram with mel and lets the plugin choose the hop', async () => {
            const { handle, mode, created } = await mountWithSpectrogram();
            mode('spectrogram').click();
            expect(created[0]).toMatchObject({
                scale: 'mel', fftSamples: 4096, height: 250, labels: true
            });
            expect(created[0]).not.toHaveProperty('noverlap');
            handle.dispose();
        });

        // The plugin fixes its scale at construction, so a scale change has to
        // rebuild it rather than mutate it.
        it('rebuilds the spectrogram when the scale changes', async () => {
            const { handle, mode, scale, created, destroyed } = await mountWithSpectrogram();
            mode('spectrogram').click();
            expect(created).toHaveLength(1);

            scale.value = 'bark';
            scale.dispatchEvent(new Event('change'));
            expect(destroyed).toEqual([0]);
            expect(created).toHaveLength(2);
            expect(created[1]).toMatchObject({ scale: 'bark' });
            handle.dispose();
        });

        it('does not rebuild when the scale is unchanged', async () => {
            const { handle, mode, scale, created } = await mountWithSpectrogram();
            mode('spectrogram').click();
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
    // WaveSurfer decodes at 8000 Hz unless told otherwise, which caps a
    // spectrogram at 4 kHz and makes the reported rate wrong. The original
    // viewer passed a rate; the port dropped it.
    describe('decode sample rate', () => {
        const captureOptions = async (file: { fileName: string; data: Uint8Array }) => {
            const created: Array<Record<string, unknown>> = [];
            const surfer = fakeSurfer();
            const lib: AudioWaveformLibrary = {
                createWaveSurfer: (o) => { created.push(o as unknown as Record<string, unknown>); return surfer; }
            };
            const container = document.createElement('div');
            const handle = await mountAudioViewer(file, container, stubCtx(), {
                ...urlOptions,
                deps: { loadWaveform: async () => lib }
            });
            return { handle, container, surfer, options: created[0]! };
        };

        it('decodes a WAV at the rate in its header', async () => {
            const data = encodeWavFromFloat32(new Float32Array(2000), 2, 48000);
            const { handle, options } = await captureOptions({ fileName: 'take.wav', data });
            expect(options.sampleRate).toBe(48000);
            handle.dispose();
        });

        it('decodes an mp3 at the rate in its frame header', async () => {
            // MPEG-1 Layer III, 128 kbps, 44.1 kHz stereo.
            const one = (() => {
                const header = [0xff, 0xfb, 0x90, 0x00];
                const bytes = new Uint8Array(417);
                bytes.set(header);
                return bytes;
            })();
            const data = new Uint8Array(417 * 4);
            for (let i = 0; i < 4; i++) data.set(one, i * 417);
            const { handle, options } = await captureOptions({ fileName: 'song.mp3', data });
            expect(options.sampleRate).toBe(44100);
            handle.dispose();
        });

        it('never leaves the engine on its 8000 Hz default', async () => {
            const { handle, options } = await captureOptions({
                fileName: 'unknown.flac', data: Uint8Array.of(1, 2, 3, 4)
            });
            expect(options.sampleRate).toBe(44100);
            handle.dispose();
        });

        it('reports the header rate rather than the rate it decoded at', async () => {
            const data = encodeWavFromFloat32(new Float32Array(2000), 2, 48000);
            const { handle, container, surfer } = await captureOptions({ fileName: 'take.wav', data });
            surfer.emit('ready'); // fake decoded data claims 44100
            expect(shadow(container).textContent).toContain('48,000 Hz');
            expect(shadow(container).textContent).not.toContain('44,100 Hz');
            handle.dispose();
        });
    });

    // File size is a poor proxy for what a decode costs: a 122 MiB WAV decodes
    // to 245 MiB while a same-sized FLAC decodes to five times that.
    describe('peaks-mode threshold', () => {
        const mountWav = async (frames: number, extra: Record<string, unknown> = {}) => {
            const created: Array<Record<string, unknown>> = [];
            const surfer = fakeSurfer();
            const lib: AudioWaveformLibrary = {
                createWaveSurfer: (o) => { created.push(o as unknown as Record<string, unknown>); return surfer; }
            };
            const handle = await mountAudioViewer(
                { fileName: 'take.wav', data: encodeWavFromFloat32(new Float32Array(frames * 2), 2, 44100) },
                document.createElement('div'), stubCtx(),
                { ...urlOptions, ...extra, deps: { loadWaveform: async () => lib } }
            );
            return { handle, options: created[0]! };
        };

        it('keeps a WAV whose decode fits on the full-decode path', async () => {
            // 1 MiB of decoded audio, far under the threshold.
            const { handle, options } = await mountWav(131072, { analyzeDecodedBytes: 8 * 1024 * 1024 });
            expect(options.peaks).toBeUndefined();
            handle.dispose();
        });

        it('switches to peaks once the decode would exceed the budget', async () => {
            const { handle, options } = await mountWav(131072, { analyzeDecodedBytes: 512 * 1024 });
            expect(options.peaks).toBeDefined();
            handle.dispose();
        });

        // The file is ~0.5 MiB but decodes to ~1 MiB: judging by file size
        // would have kept it on the full-decode path.
        it('judges by decoded size, not file size', async () => {
            const { handle, options } = await mountWav(131072, {
                analyzeDecodedBytes: 512 * 1024,
                engineAnalyzeBytes: 100 * 1024 * 1024
            });
            expect(options.peaks).toBeDefined();
            handle.dispose();
        });

        it('falls back to file size for formats it cannot measure', async () => {
            const created: Array<Record<string, unknown>> = [];
            const surfer = fakeSurfer();
            const lib: AudioWaveformLibrary = {
                createWaveSurfer: (o) => { created.push(o as unknown as Record<string, unknown>); return surfer; }
            };
            const engine = {
                decode: vi.fn(),
                analyze: vi.fn(async () => ({ sampleRate: 44100, channels: 2, duration: 60, peaks: [0.5] }))
            };
            const handle = await mountAudioViewer(engineInput(), document.createElement('div'), stubCtx(), {
                ...urlOptions,
                engineAnalyzeBytes: 2, // 4-byte flac fixture exceeds this
                deps: { loadWaveform: async () => lib, engine }
            });
            expect(engine.analyze).toHaveBeenCalledOnce();
            expect(created[0]!.peaks).toBeDefined();
            handle.dispose();
        });
    });

    // Without this path every mp3 is decoded whole however long it is — a
    // 20-minute file expands to ~400 MiB and takes the tab down.
    // The payoff of the windowed renderer: a spectrogram on files where the
    // whole-file plugin cannot run at all, peaks mode included.
    describe('windowed spectrogram', () => {
        const wavInput = (frames: number) => ({
            fileName: 'take.wav',
            data: encodeWavFromFloat32(
                Float32Array.from({ length: frames * 2 }, (_, i) => Math.sin(i / 7) * 0.6),
                2, 44100
            )
        });

        const mountWav = async (frames: number, extra: Record<string, unknown> = {}) => {
            const surfer = fakeSurfer();
            const pluginBuilds: number[] = [];
            const lib = library(surfer, undefined, () => { pluginBuilds.push(1); return { destroy: () => undefined }; });
            const container = document.createElement('div');
            const handle = await mountAudioViewer(wavInput(frames), container, stubCtx(), {
                ...urlOptions, ...extra, deps: { loadWaveform: async () => lib }
            });
            surfer.emit('ready');
            const root = shadow(container);
            return {
                handle, root, surfer, pluginBuilds,
                mode: (value: string) => root.querySelector(`.omni-audio__mode[data-mode="${value}"]`) as HTMLButtonElement,
                canvas: () => root.querySelector('.omni-audio__spectrogram-canvas') as HTMLCanvasElement | null
            };
        };

        const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

        it('renders its own canvas instead of building the whole-file plugin', async () => {
            const { handle, mode, canvas, pluginBuilds } = await mountWav(20000);
            mode('spectrogram').click();
            await settle();
            expect(canvas()).not.toBeNull();
            expect(pluginBuilds).toHaveLength(0);
            handle.dispose();
        });

        // The plugin needs a decoded buffer, which peaks mode never builds — so
        // this used to be simply unavailable on large files.
        it('stays available in peaks mode', async () => {
            const { handle, mode, canvas } = await mountWav(20000, { analyzeDecodedBytes: 2 });
            expect(mode('spectrogram').disabled).toBe(false);
            mode('spectrogram').click();
            await settle();
            expect(canvas()).not.toBeNull();
            handle.dispose();
        });

        it('redraws when the visible range scrolls', async () => {
            const { handle, mode, canvas, surfer } = await mountWav(200000);
            mode('spectrogram').click();
            await settle();
            const before = canvas()!.width;

            surfer.emit('scroll', 10);
            // The fake emitter passes one argument, so the range collapses to a
            // point and the view asks for the whole track instead — either way
            // a redraw must happen without throwing.
            await settle();
            expect(canvas()!.width).toBeGreaterThan(0);
            expect(before).toBeGreaterThan(0);
            handle.dispose();
        });

        it('releases the canvas when leaving spectrogram modes', async () => {
            const { handle, mode, canvas } = await mountWav(20000);
            mode('spectrogram').click();
            await settle();
            expect(canvas()).not.toBeNull();
            mode('waveform').click();
            expect(canvas()).toBeNull();
            handle.dispose();
        });

        // flac has no windowed reader, so the plugin stays in charge there.
        it('leaves formats it cannot window to the plugin', async () => {
            const surfer = fakeSurfer();
            const pluginBuilds: number[] = [];
            const lib = library(surfer, undefined, () => { pluginBuilds.push(1); return { destroy: () => undefined }; });
            const container = document.createElement('div');
            const handle = await mountAudioViewer(engineInput(), container, stubCtx(), {
                ...urlOptions, deps: { loadWaveform: async () => lib }
            });
            surfer.emit('ready');
            const root = shadow(container);
            (root.querySelector('.omni-audio__mode[data-mode="spectrogram"]') as HTMLButtonElement).click();
            expect(pluginBuilds).toHaveLength(1);
            expect(root.querySelector('.omni-audio__spectrogram-canvas')).toBeNull();
            handle.dispose();
        });

        // Once the engine has decoded a track, its samples are in memory: every
        // format becomes windowable, and re-decoding the file per viewport
        // would be pure waste.
        it('windows a format it cannot parse once the engine has decoded it', async () => {
            const surfer = fakeSurfer();
            surfer.getDecodedData = () => ({
                numberOfChannels: 2,
                sampleRate: 44100,
                duration: 120,
                getChannelData: (channel: number) =>
                    Float32Array.from({ length: 44100 * 4 }, (_, i) =>
                        Math.sin(i / (channel === 0 ? 7 : 11)) * 0.6)
            });
            const pluginBuilds: number[] = [];
            const lib = library(surfer, undefined, () => { pluginBuilds.push(1); return { destroy: () => undefined }; });
            const container = document.createElement('div');
            const handle = await mountAudioViewer(engineInput(), container, stubCtx(), {
                ...urlOptions, deps: { loadWaveform: async () => lib }
            });
            surfer.emit('ready');
            const root = shadow(container);
            (root.querySelector('.omni-audio__mode[data-mode="spectrogram"]') as HTMLButtonElement).click();
            await settle();
            expect(root.querySelector('.omni-audio__spectrogram-canvas')).not.toBeNull();
            expect(pluginBuilds).toHaveLength(0);
            handle.dispose();
        });

        it('offers the frequency range only where a window reader can honour it', async () => {
            const { handle, root, mode } = await mountWav(20000);
            const group = () => root.querySelector('.omni-audio__group--frequency') as HTMLElement;
            expect(group().hidden).toBe(true);
            mode('spectrogram').click();
            await settle();
            expect(group().hidden).toBe(false);
            expect([...group().querySelectorAll('option')].map((o) => o.value))
                .toEqual(['0', '2000', '4000', '8000', '16000']);
            mode('waveform').click();
            expect(group().hidden).toBe(true);
            handle.dispose();
        });

        it('redraws when a frequency ceiling is chosen', async () => {
            const { handle, root, mode, canvas } = await mountWav(200000);
            mode('spectrogram').click();
            await settle();
            const before = canvas()!.height;

            const select = root.querySelector('.omni-audio__group--frequency select') as HTMLSelectElement;
            select.value = '4000';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            await settle();
            expect(canvas()!.height).toBe(before);
            expect(canvas()!.width).toBeGreaterThan(0);
            handle.dispose();
        });

        // The waveform library is stereo here, so both channels get a band.
        it('stacks a band per channel and sizes the canvas for them', async () => {
            const { handle, mode, canvas } = await mountWav(200000);
            mode('spectrogram').click();
            await settle();
            expect(canvas()!.height).toBe(500);
            handle.dispose();
        });

        it('honours spectrogram options from the mount call', async () => {
            const { handle, mode, canvas } = await mountWav(200000, {
                spectrogram: { height: 64, fftSize: 512, splitChannels: false, labels: false }
            });
            mode('spectrogram').click();
            await settle();
            expect(canvas()!.height).toBe(64);
            const axis = canvas()!.parentElement!.querySelector('.omni-audio__spectrogram-axis') as HTMLCanvasElement;
            expect(axis.hidden).toBe(true);
            handle.dispose();
        });
    });

    describe('streaming analysis for mp3', () => {
        const mp3Bytes = (frames: number): Uint8Array => {
            const header = [0xff, 0xfb, 0x90, 0x00];
            const out = new Uint8Array(417 * frames);
            for (let i = 0; i < frames; i++) out.set(header, i * 417);
            return out;
        };

        /** Minimal WebCodecs stand-in installed as a global for the viewer. */
        const installWebCodecs = (): void => {
            class FakeDecoder {
                decodeQueueSize = 0;
                constructor(private init: { output(data: unknown): void }) {}
                configure(): void { /* nothing */ }
                decode(): void {
                    this.init.output({
                        numberOfFrames: 1152,
                        numberOfChannels: 2,
                        format: 'f32-planar',
                        allocationSize: () => 1152 * 4,
                        copyTo: (destination: ArrayBufferView) => (destination as Float32Array).fill(0.5, 0, 1152),
                        close: () => undefined
                    });
                }
                async flush(): Promise<void> { /* synchronous fake */ }
                close(): void { /* nothing */ }
            }
            vi.stubGlobal('AudioDecoder', FakeDecoder);
            vi.stubGlobal('EncodedAudioChunk', class { constructor(public init: unknown) {} });
        };

        afterEach(() => vi.unstubAllGlobals());

        it('feeds mp3 peaks to the surfer instead of decoding the whole file', async () => {
            installWebCodecs();
            const created: Array<Record<string, unknown>> = [];
            const surfer = fakeSurfer();
            const lib: AudioWaveformLibrary = {
                createWaveSurfer: (o) => { created.push(o as unknown as Record<string, unknown>); return surfer; }
            };
            const handle = await mountAudioViewer(
                { fileName: 'long.mp3', data: mp3Bytes(400) },
                document.createElement('div'), stubCtx(),
                { ...urlOptions, analyzeDecodedBytes: 2, deps: { loadWaveform: async () => lib } }
            );
            const peaks = created[0]?.peaks as number[][];
            expect(peaks).toHaveLength(2);
            expect(Math.max(...peaks[0]!)).toBeCloseTo(0.5, 2);
            expect(created[0]?.duration).toBeCloseTo(400 * 1152 / 44100, 4);
            handle.dispose();
        });

        // Chrome-only capability, so the viewer must still open elsewhere.
        it('falls back to the browser decode where WebCodecs is missing', async () => {
            const created: Array<Record<string, unknown>> = [];
            const surfer = fakeSurfer();
            const lib: AudioWaveformLibrary = {
                createWaveSurfer: (o) => { created.push(o as unknown as Record<string, unknown>); return surfer; }
            };
            const handle = await mountAudioViewer(
                { fileName: 'long.mp3', data: mp3Bytes(400) },
                document.createElement('div'), stubCtx(),
                { ...urlOptions, analyzeDecodedBytes: 2, deps: { loadWaveform: async () => lib } }
            );
            expect(created[0]?.peaks).toBeUndefined();
            handle.dispose();
        });
    });

    // When nothing can produce peaks the browser decodes everything, and at the
    // source rate that is what takes a tab down. Trading bandwidth keeps it up.
    describe('reduced-rate fallback', () => {
        const mountLargeWav = async (frames: number, budget: number) => {
            const created: Array<Record<string, unknown>> = [];
            const surfer = fakeSurfer();
            const lib: AudioWaveformLibrary = {
                createWaveSurfer: (o) => { created.push(o as unknown as Record<string, unknown>); return surfer; }
            };
            // A WAV the streaming analyzer cannot read: valid RIFF, broken fmt.
            const data = encodeWavFromFloat32(new Float32Array(frames * 2), 2, 44100);
            data[20] = 0x63; // unsupported format tag
            const container = document.createElement('div');
            const handle = await mountAudioViewer(
                { fileName: 'broken.wav', data }, container, stubCtx(),
                { ...urlOptions, analyzeDecodedBytes: budget, deps: { loadWaveform: async () => lib } }
            );
            return { handle, container, options: created[0]! };
        };

        it('lowers the decode rate rather than letting the decode blow the budget', async () => {
            const { handle, container, options } = await mountLargeWav(200000, 64 * 1024);
            expect(options.sampleRate).toBeLessThan(44100);
            expect(options.sampleRate).toBeGreaterThanOrEqual(16000);
            expect(shadow(container).textContent).toContain('reduced quality');
            handle.dispose();
        });

        it('leaves the rate alone when the decode already fits', async () => {
            const { handle, options } = await mountLargeWav(1000, 64 * 1024 * 1024);
            expect(options.sampleRate).toBe(44100);
            handle.dispose();
        });
    });

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
                analyzeDecodedBytes: 2, // WAV is judged by decoded size
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
                analyzeDecodedBytes: 2, // WAV is judged by decoded size
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
                    analyzeDecodedBytes: 2, // WAV is judged by decoded size
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
                analyzeDecodedBytes: 2, // WAV is judged by decoded size
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
        const spectrogramButton = root.querySelector('.omni-audio__mode[data-mode="spectrogram"]') as HTMLButtonElement;

        surfers[0]!.emit('ready');
        expect(spectrogramButton.disabled).toBe(true); // peaks mode: no samples to transform

        surfers[0]!.emit('error', new Error('cannot play this codec'));
        await vi.waitFor(() => expect(engine.decode).toHaveBeenCalledOnce());
        surfers[1]!.emit('ready');

        expect(spectrogramButton.disabled).toBe(false);
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
