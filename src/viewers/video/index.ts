import type { HostContext } from '../../host/index.js';
import { parseVideoInfo } from '../../parsers/video/index.js';
import type { MediaMountOptions } from '../media.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type ViewerHandle, type ViewerInput } from '../types.js';
import {
    createVideoController,
    formatMediaTime,
    VIDEO_SPEED_OPTIONS,
    type VideoController
} from './controller.js';
import { videoViewerCss } from './styles.js';

export { parseVideoInfo } from '../../parsers/video/index.js';
export { videoViewerCss } from './styles.js';
export {
    createVideoController,
    formatMediaTime,
    VIDEO_MIN_ZOOM,
    VIDEO_MAX_ZOOM,
    VIDEO_ZOOM_STEP,
    VIDEO_SPEED_OPTIONS,
    type VideoAction,
    type VideoController,
    type VideoViewState
} from './controller.js';

export type VideoViewerContext = HostContext;
export type VideoMountOptions = MediaMountOptions;

export const VIDEO_VIEWER_META = {
    id: 'video',
    displayNameKey: 'video.title',
    extensions: ['mp4', 'mts', 'm2ts', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mkv'],
    priority: 20,
    requiredServices: [] as const,
    optionalServices: [] as const,
    inputOwnership: 'borrows' as const
};

const SKIP_SECONDS = 10;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

export async function mountVideoViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: VideoViewerContext,
    options: VideoMountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const t = (key: string, args?: Record<string, string | number>): string => ctx.i18n.t(key, args);
    const info = parseVideoInfo(input.fileName, input.data);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

    const root: HTMLElement | ShadowRoot =
        options.styleIsolation !== 'scoped' && container.attachShadow
            ? (container.shadowRoot ?? container.attachShadow({ mode: 'open' }))
            : container;
    if (root === container) container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--video');
    else {
        const style = document.createElement('style');
        style.textContent = videoViewerCss;
        root.append(style);
    }

    const controller: VideoController = createVideoController();
    const disposers: Array<() => void> = [];
    const listen = <E extends Event>(
        target: EventTarget,
        type: string,
        handler: (event: E) => void,
        opts?: AddEventListenerOptions
    ): void => {
        target.addEventListener(type, handler as EventListener, opts);
        disposers.push(() => target.removeEventListener(type, handler as EventListener, opts));
    };

    const shell = element('section', `${VIEWER_ROOT_CLASS} omni-video`);
    shell.tabIndex = 0;

    // Header: file name + mime/size.
    const header = element('header', 'omni-video__header');
    header.append(
        element('div', 'omni-video__title', input.fileName),
        element('div', 'omni-video__meta', `${info.mimeType} · ${formatBytes(input.data.byteLength)}`)
    );

    // File info panel (populated on loadedmetadata).
    const infoPanel = element('div', 'omni-video__info');
    infoPanel.hidden = true;
    const durationValue = infoItem(infoPanel, t('video.info.duration'));
    const resolutionValue = infoItem(infoPanel, t('video.info.resolution'));
    const formatValue = infoItem(infoPanel, t('video.info.format'));
    const sizeValue = infoItem(infoPanel, t('video.info.fileSize'));
    formatValue.textContent = info.format;
    sizeValue.textContent = formatBytes(input.data.byteLength);

    // Toolbar.
    const controls = element('div', 'omni-video__controls');
    const playPause = button(t('video.play'));
    const stop = button(t('video.stop'));
    const skipBack = button(t('video.skipBack', { seconds: SKIP_SECONDS }));
    const skipForward = button(t('video.skipForward', { seconds: SKIP_SECONDS }));
    const transportGroup = element('div', 'omni-video__group');
    transportGroup.append(playPause, stop, skipBack, skipForward);

    const speedGroup = element('div', 'omni-video__group');
    const speedLabel = element('label', 'omni-video__group-label', t('video.speed'));
    const speedSelect = document.createElement('select');
    speedSelect.className = 'omni-video__select';
    for (const speed of VIDEO_SPEED_OPTIONS) {
        const option = document.createElement('option');
        option.value = String(speed);
        option.textContent = `${speed}x`;
        option.selected = speed === 1;
        speedSelect.append(option);
    }
    speedLabel.append(speedSelect);
    speedGroup.append(speedLabel);

    const zoomGroup = element('div', 'omni-video__group');
    const zoomOut = button('−', t('video.zoomOut'));
    const zoomLabel = element('span', 'omni-video__zoom-label', '100%');
    const zoomIn = button('+', t('video.zoomIn'));
    const zoomFit = button(t('video.zoomFit'));
    zoomGroup.append(element('span', 'omni-video__group-label', t('video.zoom')), zoomOut, zoomLabel, zoomIn, zoomFit);
    controls.append(transportGroup, speedGroup, zoomGroup);

    // Progress row.
    const progressRow = element('div', 'omni-video__progress-row');
    const currentTime = element('span', 'omni-video__time', '0:00');
    const bar = element('div', 'omni-video__bar');
    const barFilled = element('div', 'omni-video__bar-filled');
    barFilled.append(element('div', 'omni-video__bar-handle'));
    bar.append(barFilled);
    const totalTime = element('span', 'omni-video__time', '0:00');
    progressRow.append(currentTime, bar, totalTime);

    // Stage.
    const stage = element('main', 'omni-video__stage');
    const wrapper = element('div', 'omni-video__wrapper');
    const video = document.createElement('video');
    video.preload = input.data.byteLength > 50 * 1024 * 1024 ? 'metadata' : 'auto';
    wrapper.append(video);

    const warning = element('div', 'omni-video__warning');
    warning.hidden = true;

    shell.append(header, infoPanel, controls, progressRow, stage, warning);
    root.append(shell);

    const showWarning = (message: string): void => {
        warning.hidden = false;
        warning.textContent = [...info.warnings, message].filter(Boolean).join('\n');
    };
    const setControlsEnabled = (enabled: boolean): void => {
        for (const control of [playPause, stop, skipBack, skipForward, speedSelect, zoomOut, zoomIn, zoomFit]) {
            (control as HTMLButtonElement | HTMLSelectElement).disabled = !enabled;
        }
    };

    let url: string | undefined;
    let hasSource = false;
    if (input.data.byteLength === 0) showWarning(t('video.error.empty'));
    else if (input.data.byteLength > maxBytes) showWarning(t('video.error.tooLarge', { limit: formatBytes(maxBytes) }));
    else {
        try {
            const create = options.createObjectUrl ?? URL.createObjectURL.bind(URL);
            url = create(new Blob([blobPart(input.data)], { type: info.mimeType }));
            video.src = url;
            stage.append(wrapper);
            hasSource = true;
            if (info.warnings.length) showWarning('');
        } catch {
            showWarning(t('video.error.source'));
        }
    }
    setControlsEnabled(hasSource);

    // Media element wiring.
    const refreshProgress = (): void => {
        currentTime.textContent = formatMediaTime(video.currentTime);
        if (Number.isFinite(video.duration) && video.duration > 0) {
            barFilled.style.width = `${(video.currentTime / video.duration) * 100}%`;
        }
    };
    listen(video, 'loadedmetadata', () => {
        totalTime.textContent = formatMediaTime(video.duration);
        durationValue.textContent = formatMediaTime(video.duration);
        if (video.videoWidth && video.videoHeight) resolutionValue.textContent = `${video.videoWidth}×${video.videoHeight}`;
        infoPanel.hidden = false;
    });
    listen(video, 'play', () => { playPause.textContent = t('video.pause'); });
    listen(video, 'pause', () => { playPause.textContent = t('video.play'); });
    listen(video, 'ended', () => { playPause.textContent = t('video.play'); });
    listen(video, 'timeupdate', () => { if (!dragging) refreshProgress(); });
    listen(video, 'error', () => showWarning(t('video.error.decode')));

    // Transport.
    listen(playPause, 'click', () => {
        if (video.paused || video.ended) void video.play()?.catch?.(() => showWarning(t('video.error.decode')));
        else video.pause();
    });
    listen(stop, 'click', () => { video.pause(); video.currentTime = 0; refreshProgress(); });
    listen(skipBack, 'click', () => { video.currentTime = Math.max(0, video.currentTime - SKIP_SECONDS); refreshProgress(); });
    listen(skipForward, 'click', () => {
        const limit = Number.isFinite(video.duration) ? video.duration : video.currentTime + SKIP_SECONDS;
        video.currentTime = Math.min(limit, video.currentTime + SKIP_SECONDS);
        refreshProgress();
    });
    listen(speedSelect, 'change', () => controller.dispatch({ type: 'set-speed', speed: Number(speedSelect.value) }));

    // Seek by click/drag on the progress bar. Document-level listeners are
    // required for drags that leave the bar; both are torn down on dispose.
    let dragging = false;
    const seekToPointer = (event: MouseEvent): void => {
        const rect = bar.getBoundingClientRect();
        if (rect.width <= 0 || !Number.isFinite(video.duration) || video.duration <= 0) return;
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        video.currentTime = ratio * video.duration;
        barFilled.style.width = `${ratio * 100}%`;
        currentTime.textContent = formatMediaTime(video.currentTime);
    };
    listen(bar, 'mousedown', (event: MouseEvent) => {
        if (!hasSource) return;
        dragging = true;
        bar.classList.add('omni-video__bar--dragging');
        seekToPointer(event);
    });
    listen(document, 'mousemove', (event: MouseEvent) => { if (dragging) seekToPointer(event); });
    listen(document, 'mouseup', () => {
        if (!dragging) return;
        dragging = false;
        bar.classList.remove('omni-video__bar--dragging');
    });

    // Zoom.
    listen(zoomIn, 'click', () => controller.dispatch({ type: 'zoom-in' }));
    listen(zoomOut, 'click', () => controller.dispatch({ type: 'zoom-out' }));
    listen(zoomFit, 'click', () => controller.dispatch({ type: 'zoom-fit' }));
    listen(stage, 'wheel', (event: WheelEvent) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        controller.dispatch({ type: event.deltaY > 0 ? 'zoom-out' : 'zoom-in' });
    }, { passive: false });

    const applyState = (state: { zoom: number; speed: number }): void => {
        wrapper.style.transform = state.zoom === 1 ? '' : `scale(${state.zoom})`;
        zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
        stage.classList.toggle('omni-video__stage--zoomed', state.zoom > 1);
        video.playbackRate = state.speed;
        speedSelect.value = String(state.speed);
    };
    disposers.push(controller.subscribe(applyState));

    // Keyboard shortcuts, scoped to the viewer (shell is focusable).
    listen(shell, 'keydown', (event: KeyboardEvent) => {
        if (!hasSource) return;
        const key = event.key;
        if (key === ' ') playPause.click();
        else if (key === 'ArrowLeft') skipBack.click();
        else if (key === 'ArrowRight') skipForward.click();
        else if (key === 'Home') { video.currentTime = 0; refreshProgress(); }
        else if (key === 'End' && Number.isFinite(video.duration)) { video.currentTime = video.duration; refreshProgress(); }
        else if (key === '+' || key === '=') zoomIn.click();
        else if (key === '-') zoomOut.click();
        else if (key === '0') zoomFit.click();
        else return;
        event.preventDefault();
    });

    if (options.signal?.aborted) {
        cleanup();
        throw new MountAbortedError();
    }

    let disposed = false;
    function cleanup(): void {
        video.pause();
        video.removeAttribute('src');
        video.load();
        disposers.forEach((dispose) => dispose());
        if (url) (options.revokeObjectUrl ?? URL.revokeObjectURL.bind(URL))(url);
        shell.remove();
        if (root === container) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--video');
        else root.replaceChildren();
    }
    return {
        dispose(): void {
            if (disposed) return;
            disposed = true;
            cleanup();
        }
    };
}

function element(tag: string, className?: string, text?: string): HTMLElement {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(label: string, title?: string): HTMLButtonElement {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'omni-video__btn';
    node.textContent = label;
    if (title) node.title = title;
    return node;
}

function infoItem(panel: HTMLElement, label: string): HTMLElement {
    const item = element('div', 'omni-video__info-item');
    const value = element('div', 'omni-video__info-value', '--');
    item.append(element('div', 'omni-video__info-label', label), value);
    panel.append(item);
    return value;
}

function blobPart(data: Uint8Array): Uint8Array<ArrayBuffer> {
    return data.buffer instanceof ArrayBuffer ? (data as Uint8Array<ArrayBuffer>) : new Uint8Array(data);
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB'];
    let value = bytes / 1024, index = 0;
    while (value >= 1024 && index < 2) { value /= 1024; index++; }
    return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}
