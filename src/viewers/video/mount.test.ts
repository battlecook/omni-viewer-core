// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostContext } from '../../host/index.js';
import { createCatalogI18n } from '../../i18n/index.js';
import { mountVideoViewer } from './index.js';

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

const input = () => ({ fileName: 'clip.mp4', data: Uint8Array.of(1, 2, 3, 4) });
const urlOptions = { createObjectUrl: () => 'blob:test', revokeObjectUrl: vi.fn() };

beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
        this.dispatchEvent(new Event('play'));
        return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('video viewer mount', () => {
    it('renders toolbar, info panel, progress bar and video element', async () => {
        const container = document.createElement('div');
        const handle = await mountVideoViewer(input(), container, stubCtx(), urlOptions);
        const root = shadow(container);
        const labels = [...root.querySelectorAll('button')].map((b) => b.textContent);
        expect(labels).toContain('Play');
        expect(labels).toContain('Stop');
        expect(labels).toContain('Fit');
        expect(root.querySelector('video')).toBeTruthy();
        expect(root.querySelector('.omni-video__bar')).toBeTruthy();
        expect((root.querySelector('.omni-video__info') as HTMLElement).hidden).toBe(true);
        handle.dispose();
        expect(root.querySelector('.omni-video')).toBeNull();
    });

    it('zoom buttons update label and wrapper transform, wheel zoom works', async () => {
        const container = document.createElement('div');
        const handle = await mountVideoViewer(input(), container, stubCtx(), urlOptions);
        const root = shadow(container);
        const zoomLabel = root.querySelector('.omni-video__zoom-label') as HTMLElement;
        const wrapper = root.querySelector('.omni-video__wrapper') as HTMLElement;
        const zoomIn = [...root.querySelectorAll('button')].find((b) => b.title === 'Zoom in')!;
        zoomIn.click();
        expect(zoomLabel.textContent).toBe('125%');
        expect(wrapper.style.transform).toBe('scale(1.25)');

        const stage = root.querySelector('.omni-video__stage') as HTMLElement;
        stage.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, ctrlKey: true, cancelable: true }));
        expect(zoomLabel.textContent).toBe('100%');
        expect(wrapper.style.transform).toBe('');
        handle.dispose();
    });

    it('speed select updates playbackRate through the controller', async () => {
        const container = document.createElement('div');
        const handle = await mountVideoViewer(input(), container, stubCtx(), urlOptions);
        const root = shadow(container);
        const select = root.querySelector('select') as HTMLSelectElement;
        const video = root.querySelector('video') as HTMLVideoElement;
        select.value = '2';
        select.dispatchEvent(new Event('change'));
        expect(video.playbackRate).toBe(2);
        handle.dispose();
    });

    it('play toggles the button label, stop rewinds', async () => {
        const container = document.createElement('div');
        const handle = await mountVideoViewer(input(), container, stubCtx(), urlOptions);
        const root = shadow(container);
        const video = root.querySelector('video') as HTMLVideoElement;
        const playPause = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Play')!;
        playPause.click();
        expect(playPause.textContent).toBe('Pause');
        video.currentTime = 42;
        const stop = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Stop')!;
        stop.click();
        expect(video.currentTime).toBe(0);
        handle.dispose();
    });

    it('shows a warning and disables controls for empty and oversized files', async () => {
        const container = document.createElement('div');
        const handle = await mountVideoViewer({ fileName: 'clip.mp4', data: new Uint8Array() }, container, stubCtx(), urlOptions);
        const root = shadow(container);
        expect((root.querySelector('.omni-video__warning') as HTMLElement).hidden).toBe(false);
        expect(root.querySelector('video')?.isConnected ?? false).toBe(false);
        expect((root.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
        handle.dispose();

        const big = document.createElement('div');
        const bigHandle = await mountVideoViewer(input(), big, stubCtx(), { ...urlOptions, maxBytes: 2 });
        const bigWarning = shadow(big).querySelector('.omni-video__warning') as HTMLElement;
        expect(bigWarning.hidden).toBe(false);
        expect(bigWarning.textContent).toContain('exceeds');
        bigHandle.dispose();
    });

    it('revokes the object URL and removes document listeners on dispose', async () => {
        const revoke = vi.fn();
        const addSpy = vi.spyOn(document, 'addEventListener');
        const removeSpy = vi.spyOn(document, 'removeEventListener');
        const container = document.createElement('div');
        const handle = await mountVideoViewer(input(), container, stubCtx(), {
            createObjectUrl: () => 'blob:test',
            revokeObjectUrl: revoke
        });
        const documentListeners = addSpy.mock.calls.filter(([type]) => type === 'mousemove' || type === 'mouseup');
        expect(documentListeners.length).toBe(2);
        handle.dispose();
        expect(revoke).toHaveBeenCalledWith('blob:test');
        const removed = removeSpy.mock.calls.filter(([type]) => type === 'mousemove' || type === 'mouseup');
        expect(removed.length).toBe(2);
    });

    it('supports scoped style isolation', async () => {
        const container = document.createElement('div');
        const handle = await mountVideoViewer(input(), container, stubCtx(), { ...urlOptions, styleIsolation: 'scoped' });
        expect(container.classList.contains('omni-viewer--video')).toBe(true);
        expect(container.querySelector('.omni-video')).toBeTruthy();
        handle.dispose();
        expect(container.classList.contains('omni-viewer--video')).toBe(false);
    });
});
