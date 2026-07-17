// Image viewer — DOM renderer consuming ImageController (DESIGN.md §3-②,
// docs/viewers/image.md). CSP rules: no eval, no inline handlers, no innerHTML.
// Mount is async and renders inside a shadow root by default (§6).
//
// Optional services (image.md §2, I8): `save` (Save As PNG), `writeback`
// (out of v1 scope), `backgroundRemoval`, `spriteDetection`. All degrade — the
// tool renders disabled with a reason, never hidden. The four current platforms
// gate `save` in their smoke, but core keeps degraded mode for future hosts.

import type {
    FileSaveService,
    FileWritebackService,
    HostContext,
    ImageBackgroundRemovalService,
    ImageSpriteDetectionService,
    RgbaImage
} from '../../host/index.js';
import {
    MountAbortedError,
    VIEWER_ROOT_CLASS,
    type MountOptions,
    type ViewerHandle,
    type ViewerInput
} from '../types.js';
import {
    createImageController,
    filterToCss,
    makeAnnotation,
    type Annotation,
    type FilterPreset,
    type ImageController,
    type ImageViewState
} from './controller.js';
import { decodeImage, type DecodedImage } from './decode.js';
import { canvasEditable, IMAGE_LIMITS } from './limits.js';
import { imageViewerCss } from './styles.js';

export { createImageController } from './controller.js';
export type { ImageController, ImageViewState, ImageAction, Annotation } from './controller.js';
export { decodeImage, detectImageMime, isSvgText, isAnimated } from './decode.js';
export type { ImageLoadResult, ImageDocument, ImageMime } from './decode.js';
export { IMAGE_LIMITS, canvasEditable } from './limits.js';
export { imageViewerCss } from './styles.js';

/** Viewer metadata — single source for the registry codegen (DESIGN.md §7). */
export const IMAGE_VIEWER_META = {
    id: 'image',
    displayNameKey: 'image.title',
    extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'],
    priority: 15,
    requiredServices: [] as const,
    optionalServices: ['save', 'writeback', 'backgroundRemoval', 'spriteDetection'] as const,
    inputOwnership: 'borrows' as const
};

export type ImageViewerContext = HostContext & {
    save?: FileSaveService;
    writeback?: FileWritebackService;
    backgroundRemoval?: ImageBackgroundRemovalService;
    spriteDetection?: ImageSpriteDetectionService;
};

export interface ImageViewerHandle extends ViewerHandle {
    isDirty(): boolean;
}

export interface ImageMountOptions extends MountOptions {
    maxInputBytes?: number;
    maxDecodedPixels?: number;
}

/**
 * Export file name (image.md I7): the edited image always saves as PNG, so the
 * proposed name is coerced to `.png` regardless of the source extension. This
 * is an intentional compatibility change — the UI announces it.
 */
export function imageExportFileName(sourceName: string): string {
    const stem = sourceName.replace(/\.[^./\\]+$/, '') || sourceName;
    return `${stem}-edited.png`;
}

const PRESET_KEYS: Record<FilterPreset, string> = {
    original: 'image.preset.original',
    bright: 'image.preset.bright',
    dark: 'image.preset.dark',
    vintage: 'image.preset.vintage',
    bw: 'image.preset.bw'
};

export async function mountImageViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: ImageViewerContext,
    options: ImageMountOptions = {}
): Promise<ImageViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();

    const controller = createImageController();

    const isolation = options.styleIsolation ?? 'shadow';
    let root: HTMLElement | ShadowRoot;
    if (isolation === 'shadow' && typeof container.attachShadow === 'function') {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = imageViewerCss;
        root.appendChild(style);
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--image');
        root = container;
    }

    const t = ctx.i18n.t.bind(ctx.i18n);
    const disposers: Array<() => void> = [];
    let toastTimer: ReturnType<typeof setTimeout> | null = null;
    let decoded: DecodedImage | null = null;

    const el = <K extends keyof HTMLElementTagNameMap>(
        tag: K,
        className?: string,
        text?: string
    ): HTMLElementTagNameMap[K] => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const on = <K extends keyof HTMLElementEventMap>(
        target: HTMLElement,
        type: K,
        handler: (ev: HTMLElementEventMap[K]) => void
    ): void => {
        target.addEventListener(type, handler as EventListener);
        disposers.push(() => target.removeEventListener(type, handler as EventListener));
    };
    // jsdom (and canvas-less environments) throw from getContext — treat as
    // "no 2d context available" so rendering degrades instead of crashing.
    const ctx2d = (canvas: HTMLCanvasElement): CanvasRenderingContext2D | null => {
        try {
            return canvas.getContext('2d');
        } catch {
            return null;
        }
    };
    const button = (label: string, ariaLabel?: string): HTMLButtonElement => {
        const b = el('button', undefined, label);
        b.type = 'button';
        if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
        return b;
    };

    // --- static frame -------------------------------------------------------
    const frame = el('div', 'omni-image');
    const toolbar = el('div', 'omni-image__toolbar');

    const zoomOutBtn = button('−', t('image.zoomOut'));
    const zoomInBtn = button('+', t('image.zoomIn'));
    const fitBtn = button(t('image.fit'));
    const actualBtn = button('100%');
    const zoomLabel = el('span', 'omni-image__meta');
    const rotateBtn = button('⟳', t('image.rotate'));
    const flipHBtn = button('⇋', t('image.flipH'));
    const flipVBtn = button('⇅', t('image.flipV'));
    const gridBtn = button(t('image.grid'));
    const resetBtn = button(t('image.reset'));

    const presetSelect = el('select');
    presetSelect.setAttribute('aria-label', t('image.filter'));
    for (const key of ['original', 'bright', 'dark', 'vintage', 'bw'] as FilterPreset[]) {
        const opt = el('option', undefined, t(PRESET_KEYS[key]));
        opt.value = key;
        presetSelect.appendChild(opt);
    }

    const bgBtn = button(t('image.tool.removeBackground'));
    const spriteBtn = button(t('image.tool.detectSprites'));
    const saveBtn = button(t('image.saveAsPng'));

    const spacer = el('span', 'omni-image__spacer');
    const meta = el('span', 'omni-image__meta');

    on(zoomOutBtn, 'click', () => controller.dispatch({ type: 'zoom-out' }));
    on(zoomInBtn, 'click', () => controller.dispatch({ type: 'zoom-in' }));
    on(fitBtn, 'click', () => controller.dispatch({ type: 'fit' }));
    on(actualBtn, 'click', () => controller.dispatch({ type: 'actual-size' }));
    on(rotateBtn, 'click', () => controller.dispatch({ type: 'rotate-cw' }));
    on(flipHBtn, 'click', () => controller.dispatch({ type: 'flip-h' }));
    on(flipVBtn, 'click', () => controller.dispatch({ type: 'flip-v' }));
    on(gridBtn, 'click', () => controller.dispatch({ type: 'toggle-grid' }));
    on(resetBtn, 'click', () => controller.dispatch({ type: 'reset' }));
    on(presetSelect, 'change', () =>
        controller.dispatch({ type: 'set-preset', preset: presetSelect.value as FilterPreset })
    );

    wireOptionalService(bgBtn, ctx.backgroundRemoval, 'image.tool.removeBackground.unavailable', () =>
        runBackgroundRemoval()
    );
    wireOptionalService(spriteBtn, ctx.spriteDetection, 'image.tool.detectSprites.unavailable', () =>
        runSpriteDetection()
    );
    if (ctx.save) {
        on(saveBtn, 'click', () => void saveAsPng(ctx.save as FileSaveService));
    } else {
        saveBtn.disabled = true;
        saveBtn.title = t('common.noFileSave');
    }

    function wireOptionalService(
        btn: HTMLButtonElement,
        service: unknown,
        unavailableKey: string,
        run: () => void
    ): void {
        if (service) {
            on(btn, 'click', run);
        } else {
            btn.disabled = true;
            btn.title = t(unavailableKey);
        }
    }

    toolbar.append(
        zoomOutBtn, zoomInBtn, fitBtn, actualBtn, zoomLabel,
        rotateBtn, flipHBtn, flipVBtn, gridBtn, presetSelect, resetBtn,
        bgBtn, spriteBtn, saveBtn,
        spacer, meta
    );

    const diagnosticsBar = el('div', 'omni-image__diagnostics');
    const stage = el('div', 'omni-image__stage');
    const canvasWrap = el('div', 'omni-image__canvas-wrap');
    const baseCanvas = el('canvas');
    const overlay = el('canvas', 'omni-image__overlay');
    overlay.tabIndex = 0;
    overlay.setAttribute('role', 'img');
    const ariaLive = el('div', 'omni-image__aria-live');
    ariaLive.setAttribute('aria-live', 'polite');
    canvasWrap.append(baseCanvas, overlay);
    stage.append(canvasWrap, ariaLive);

    frame.append(toolbar, diagnosticsBar, stage);
    root.appendChild(frame);

    function showToast(message: string): void {
        frame.querySelector('.omni-image__toast')?.remove();
        const toast = el('div', 'omni-image__toast', message);
        frame.appendChild(toast);
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.remove(), 1600);
    }

    // --- annotation drawing (pointer) --------------------------------------
    let drawing: { startX: number; startY: number; stroke?: { x: number; y: number }[] } | null = null;

    function toSourceCoords(ev: PointerEvent): { x: number; y: number } {
        const rect = overlay.getBoundingClientRect();
        const m = controller.state.meta;
        const nw = m?.width ?? overlay.width;
        const nh = m?.height ?? overlay.height;
        // Maps display → source via the bounding-box ratio. Rotation-aware
        // inverse mapping is a follow-up (image.md I5); accurate at rotation 0.
        const x = rect.width ? ((ev.clientX - rect.left) / rect.width) * nw : 0;
        const y = rect.height ? ((ev.clientY - rect.top) / rect.height) * nh : 0;
        return { x, y };
    }

    on(overlay, 'pointerdown', (ev) => {
        const state = controller.state;
        if (!state.editingEnabled || state.status === 'failed') return;
        overlay.focus();
        const p = toSourceCoords(ev as PointerEvent);
        if (state.tool === 'select') {
            controller.dispatch({ type: 'select-annotation', id: hitTest(p, state.annotations) });
            return;
        }
        if (state.tool === 'text') {
            const text = ''; // inline text entry (no window.prompt — image.md §3)
            const ann = makeAnnotation({ type: 'text', x: p.x, y: p.y, text, style: { ...state.style } });
            controller.dispatch({ type: 'add-annotation', annotation: ann });
            startTextEdit(ann.id);
            return;
        }
        drawing = { startX: p.x, startY: p.y };
        if (state.tool === 'brush' || state.tool === 'eraser') {
            drawing.stroke = [{ x: p.x, y: p.y }];
        }
        overlay.setPointerCapture?.((ev as PointerEvent).pointerId);
    });

    on(overlay, 'pointermove', (ev) => {
        if (!drawing) return;
        const p = toSourceCoords(ev as PointerEvent);
        if (drawing.stroke) {
            drawing.stroke.push({ x: p.x, y: p.y });
            renderOverlay(controller.state, drawing);
        } else {
            renderOverlay(controller.state, drawing, p);
        }
    });

    on(overlay, 'pointerup', (ev) => {
        if (!drawing) return;
        const state = controller.state;
        const p = toSourceCoords(ev as PointerEvent);
        const s = { ...state.style };
        let ann: Annotation | null = null;
        if (drawing.stroke) {
            drawing.stroke.push({ x: p.x, y: p.y });
            ann = makeAnnotation({ type: 'stroke', points: drawing.stroke, erase: state.tool === 'eraser', style: s });
        } else if (state.tool === 'rectangle' || state.tool === 'circle') {
            const x = Math.min(drawing.startX, p.x);
            const y = Math.min(drawing.startY, p.y);
            const w = Math.abs(p.x - drawing.startX);
            const h = Math.abs(p.y - drawing.startY);
            if (w > 1 && h > 1) ann = makeAnnotation({ type: state.tool, x, y, w, h, style: s });
        } else if (state.tool === 'line') {
            ann = makeAnnotation({ type: 'line', x1: drawing.startX, y1: drawing.startY, x2: p.x, y2: p.y, style: s });
        }
        drawing = null;
        if (ann) controller.dispatch({ type: 'add-annotation', annotation: ann });
        else renderAll(controller.state);
    });

    // Keyboard editing (image.md I5): delete / escape / arrow nudge.
    on(overlay, 'keydown', (ev) => {
        const e = ev as KeyboardEvent;
        const state = controller.state;
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (state.selectedId) { e.preventDefault(); controller.dispatch({ type: 'delete-annotation' }); }
        } else if (e.key === 'Escape') {
            controller.dispatch({ type: 'select-annotation', id: null });
        } else if (e.key.startsWith('Arrow') && state.selectedId) {
            e.preventDefault();
            const step = e.shiftKey ? 10 : 1;
            const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
            const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
            controller.dispatch({ type: 'move-annotation', dx, dy });
        }
    });

    // Global keyboard shortcuts (not while typing in an input).
    on(frame, 'keydown', (ev) => {
        const e = ev as KeyboardEvent;
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            controller.dispatch({ type: 'undo' });
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            if (ctx.save) void saveAsPng(ctx.save);
        } else if (!e.ctrlKey && !e.metaKey) {
            if (e.key === '+' || e.key === '=') controller.dispatch({ type: 'zoom-in' });
            else if (e.key === '-') controller.dispatch({ type: 'zoom-out' });
            else if (e.key === '0') controller.dispatch({ type: 'actual-size' });
            else if (e.key.toLowerCase() === 'f') controller.dispatch({ type: 'fit' });
            else if (e.key.toLowerCase() === 'r') controller.dispatch({ type: 'rotate-cw' });
        }
    });

    function startTextEdit(id: string): void {
        const ann = controller.state.annotations.find((a) => a.id === id);
        if (!ann || ann.type !== 'text') return;
        const inputEl = el('input');
        inputEl.type = 'text';
        inputEl.value = ann.text;
        inputEl.style.position = 'absolute';
        const rect = overlay.getBoundingClientRect();
        const m = controller.state.meta;
        const sx = m && m.width ? rect.width / m.width : 1;
        const sy = m && m.height ? rect.height / m.height : 1;
        inputEl.style.left = `${ann.x * sx}px`;
        inputEl.style.top = `${ann.y * sy}px`;
        canvasWrap.appendChild(inputEl);
        inputEl.focus();
        let done = false;
        const finish = (commit: boolean) => {
            if (done) return;
            done = true;
            if (commit && inputEl.value) {
                controller.dispatch({ type: 'update-annotation', id, patch: { text: inputEl.value } });
            } else {
                controller.dispatch({ type: 'delete-annotation', id });
            }
            inputEl.remove();
        };
        inputEl.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        inputEl.addEventListener('blur', () => finish(true));
    }

    // --- optional service runners ------------------------------------------
    async function runBackgroundRemoval(): Promise<void> {
        const service = ctx.backgroundRemoval;
        if (!service || !decoded?.source) return;
        showToast(t('image.bgRemoval.working'));
        try {
            const src = readRgba(decoded.source);
            if (!src) return;
            const out = await service.removeBackground(src);
            paintRgba(out);
            renderAll(controller.state);
        } catch (error) {
            ctx.logger.log('error', `bg removal failed: ${String(error)}`);
            showToast(t('image.bgRemoval.failed'));
        }
    }

    async function runSpriteDetection(): Promise<void> {
        const service = ctx.spriteDetection;
        if (!service || !decoded?.source) return;
        showToast(t('image.spriteDetection.working'));
        try {
            const src = readRgba(decoded.source);
            if (!src) return;
            const contours = await service.detectSprites(src);
            // v1: overlay the detected boxes for visual confirmation.
            renderOverlay(controller.state, null, undefined, contours.map((c) => c.box));
        } catch (error) {
            ctx.logger.log('error', `sprite detection failed: ${String(error)}`);
            showToast(t('image.spriteDetection.failed'));
        }
    }

    function readRgba(source: CanvasImageSource & { width: number; height: number }): RgbaImage | null {
        const c = document.createElement('canvas');
        c.width = source.width;
        c.height = source.height;
        const g = ctx2d(c);
        if (!g) return null;
        g.drawImage(source, 0, 0);
        try {
            const img = g.getImageData(0, 0, c.width, c.height);
            return { width: c.width, height: c.height, data: img.data };
        } catch {
            return null;
        }
    }

    function paintRgba(rgba: RgbaImage): void {
        const g = ctx2d(baseCanvas);
        if (!g) return;
        baseCanvas.width = rgba.width;
        baseCanvas.height = rgba.height;
        const imgData = g.createImageData(rgba.width, rgba.height);
        imgData.data.set(rgba.data);
        g.putImageData(imgData, 0, 0);
    }

    // --- Save As PNG (compose transform + filter + annotations) ------------
    async function saveAsPng(service: FileSaveService): Promise<void> {
        const state = controller.state;
        if (!decoded?.source || !state.meta || !state.editingEnabled) return;
        try {
            const blob = await composePng(decoded.source, state);
            if (!blob) return;
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const name = imageExportFileName(input.fileName);
            await service.saveFile(name, bytes, 'image/png');
            showToast(t('common.saved', { name }));
        } catch (error) {
            ctx.logger.log('error', `image save failed: ${String(error)}`);
            showToast(t('common.saveFailed'));
        }
    }

    // --- state-driven rendering --------------------------------------------
    function renderAll(state: ImageViewState): void {
        // Toolbar reflected state
        zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
        fitBtn.setAttribute('aria-pressed', String(state.fitMode));
        flipHBtn.setAttribute('aria-pressed', String(state.flipH));
        flipVBtn.setAttribute('aria-pressed', String(state.flipV));
        gridBtn.setAttribute('aria-pressed', String(state.grid.visible));
        presetSelect.value = state.preset ?? 'original';
        zoomInBtn.disabled = state.zoom >= 5;
        zoomOutBtn.disabled = state.zoom <= 0.1;
        const editDisabled = !state.editingEnabled || state.status === 'failed';
        for (const b of [rotateBtn, flipHBtn, flipVBtn, presetSelect, bgBtn, spriteBtn]) {
            (b as HTMLButtonElement).disabled = editDisabled || (b === bgBtn && !ctx.backgroundRemoval) || (b === spriteBtn && !ctx.spriteDetection);
        }
        if (ctx.save) saveBtn.disabled = editDisabled;

        if (state.meta) {
            meta.textContent = `${state.meta.width}×${state.meta.height} · ${mimeShort(state.meta.mime)} · ${formatBytes(state.meta.byteLength)}`;
        } else {
            meta.textContent = '';
        }

        // Diagnostics
        diagnosticsBar.replaceChildren();
        const hasNotices = state.diagnostics.length > 0 || state.failure;
        diagnosticsBar.style.display = hasNotices ? '' : 'none';
        if (state.failure) {
            diagnosticsBar.appendChild(el('div', 'omni-image__diag-error', t(state.failure.messageKey, state.failure.args)));
        }
        for (const d of state.diagnostics) {
            diagnosticsBar.appendChild(el('div', undefined, t(d.messageKey, d.args)));
        }

        // View transform (display-only; not exported)
        const transforms = [`scale(${state.zoom})`, `rotate(${state.rotation}deg)`];
        if (state.flipH) transforms.push('scaleX(-1)');
        if (state.flipV) transforms.push('scaleY(-1)');
        canvasWrap.style.transform = transforms.join(' ');
        baseCanvas.style.filter = filterToCss(state.filter);

        // aria-live summary
        ariaLive.textContent = t('image.status', {
            zoom: Math.round(state.zoom * 100),
            rotation: state.rotation
        });
        overlay.setAttribute('aria-label', input.fileName + (state.meta ? ` ${state.meta.width}×${state.meta.height}` : ''));

        renderOverlay(state, null);
    }

    function renderOverlay(
        state: ImageViewState,
        pending: { startX: number; startY: number; stroke?: { x: number; y: number }[] } | null,
        pendingEnd?: { x: number; y: number },
        boxes?: { x: number; y: number; width: number; height: number }[]
    ): void {
        if (!state.meta) return; // nothing decoded yet — skip canvas work entirely
        const g = ctx2d(overlay);
        if (!g) return;
        overlay.width = state.meta.width;
        overlay.height = state.meta.height;
        g.clearRect(0, 0, overlay.width, overlay.height);
        if (state.grid.visible) drawGrid(g, state);
        for (const a of state.annotations) drawAnnotation(g, a, a.id === state.selectedId);
        if (pending) drawPending(g, state, pending, pendingEnd);
        if (boxes) {
            g.strokeStyle = '#3bd6e2';
            g.lineWidth = 2;
            for (const b of boxes) g.strokeRect(b.x, b.y, b.width, b.height);
        }
    }

    // Subscribe + first paint
    const unsubscribe = controller.subscribe(renderAll);

    // --- decode (async, abortable) -----------------------------------------
    const decodeOpts: Parameters<typeof decodeImage>[1] = {};
    if (options.signal) decodeOpts.signal = options.signal;
    if (options.maxInputBytes !== undefined) decodeOpts.maxInputBytes = options.maxInputBytes;
    if (options.maxDecodedPixels !== undefined) decodeOpts.maxDecodedPixels = options.maxDecodedPixels;

    decoded = await decodeImage({ fileName: input.fileName, data: input.data }, decodeOpts);

    if (options.signal?.aborted) {
        decoded.dispose();
        cleanup();
        throw new MountAbortedError();
    }

    const load = decoded.load;
    if (load.status === 'failed') {
        controller.setDocument({ status: 'failed', failure: load.failure, diagnostics: load.diagnostics });
    } else {
        const doc = load.document;
        const editable = canvasEditable(doc.width, doc.height, {
            ...IMAGE_LIMITS,
            ...(options.maxInputBytes ? { maxInputBytes: options.maxInputBytes } : {})
        });
        const diags = [...load.diagnostics];
        if (!editable) {
            diags.push({ severity: 'warning', code: 'canvas-limit', messageKey: 'diag.image.limit-exceeded.canvas' });
        }
        // Paint the decoded bitmap into the base canvas at natural size.
        baseCanvas.width = doc.width;
        baseCanvas.height = doc.height;
        const g = ctx2d(baseCanvas);
        if (g && decoded.source) g.drawImage(decoded.source, 0, 0);
        controller.setDocument({
            status: editable ? load.status : 'partial',
            diagnostics: diags,
            meta: doc,
            editingEnabled: editable
        });
    }

    function cleanup(): void {
        unsubscribe();
        for (const dispose of disposers) dispose();
        disposers.length = 0;
        if (toastTimer) clearTimeout(toastTimer);
        decoded?.dispose();
        decoded = null;
        if (root instanceof ShadowRoot) {
            root.replaceChildren();
        } else {
            root.replaceChildren();
            root.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--image');
        }
    }

    return {
        dispose: cleanup,
        isDirty: () => controller.state.dirty
    };
}

// --- pure-ish drawing helpers ----------------------------------------------

function hitTest(p: { x: number; y: number }, annotations: readonly Annotation[]): string | null {
    // Topmost annotation whose bounding box contains the point.
    for (let i = annotations.length - 1; i >= 0; i--) {
        const a = annotations[i] as Annotation;
        const box = boundingBox(a);
        if (p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h) return a.id;
    }
    return null;
}

function boundingBox(a: Annotation): { x: number; y: number; w: number; h: number } {
    switch (a.type) {
        case 'rectangle':
        case 'circle':
            return { x: a.x, y: a.y, w: a.w, h: a.h };
        case 'line':
            return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
        case 'text':
            return { x: a.x, y: a.y - a.style.fontSize, w: Math.max(20, a.text.length * a.style.fontSize * 0.6), h: a.style.fontSize * 1.4 };
        case 'stroke': {
            const xs = a.points.map((q) => q.x);
            const ys = a.points.map((q) => q.y);
            const x = Math.min(...xs), y = Math.min(...ys);
            return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
        }
    }
}

function drawGrid(g: CanvasRenderingContext2D, state: ImageViewState): void {
    const { grid, meta } = state;
    if (!meta) return;
    g.strokeStyle = 'rgba(255,255,255,0.4)';
    g.lineWidth = 1;
    let stepX: number, stepY: number;
    if (grid.mode === 'cell-size') {
        stepX = grid.cellWidth;
        stepY = grid.cellHeight;
    } else {
        stepX = meta.width / grid.cols;
        stepY = meta.height / grid.rows;
    }
    if (stepX <= 0 || stepY <= 0) return;
    for (let x = stepX; x < meta.width; x += stepX) {
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, meta.height); g.stroke();
    }
    for (let y = stepY; y < meta.height; y += stepY) {
        g.beginPath(); g.moveTo(0, y); g.lineTo(meta.width, y); g.stroke();
    }
}

function drawAnnotation(g: CanvasRenderingContext2D, a: Annotation, selected: boolean): void {
    g.save();
    g.strokeStyle = a.style.color;
    g.fillStyle = a.style.color;
    g.lineWidth = a.type === 'stroke' ? a.style.brushSize : 2;
    g.globalAlpha = a.style.borderOpacity;
    switch (a.type) {
        case 'rectangle':
            if (a.style.fillOpacity > 0) { g.globalAlpha = a.style.fillOpacity; g.fillRect(a.x, a.y, a.w, a.h); g.globalAlpha = a.style.borderOpacity; }
            g.strokeRect(a.x, a.y, a.w, a.h);
            break;
        case 'circle':
            g.beginPath();
            g.ellipse(a.x + a.w / 2, a.y + a.h / 2, a.w / 2, a.h / 2, 0, 0, Math.PI * 2);
            if (a.style.fillOpacity > 0) { g.globalAlpha = a.style.fillOpacity; g.fill(); g.globalAlpha = a.style.borderOpacity; }
            g.stroke();
            break;
        case 'line':
            g.beginPath(); g.moveTo(a.x1, a.y1); g.lineTo(a.x2, a.y2); g.stroke();
            break;
        case 'text':
            g.globalAlpha = 1;
            g.font = `${a.style.fontSize}px sans-serif`;
            g.fillText(a.text, a.x, a.y);
            break;
        case 'stroke':
            g.globalAlpha = a.erase ? 1 : a.style.borderOpacity;
            g.globalCompositeOperation = a.erase ? 'destination-out' : 'source-over';
            g.lineCap = 'round';
            g.lineJoin = 'round';
            g.beginPath();
            a.points.forEach((p, i) => (i === 0 ? g.moveTo(p.x, p.y) : g.lineTo(p.x, p.y)));
            g.stroke();
            break;
    }
    g.restore();
    if (selected) {
        const box = boundingBox(a);
        g.save();
        g.strokeStyle = '#3b82f6';
        g.setLineDash([4, 3]);
        g.strokeRect(box.x - 2, box.y - 2, box.w + 4, box.h + 4);
        g.restore();
    }
}

function drawPending(
    g: CanvasRenderingContext2D,
    state: ImageViewState,
    pending: { startX: number; startY: number; stroke?: { x: number; y: number }[] },
    end?: { x: number; y: number }
): void {
    g.save();
    g.strokeStyle = state.style.color;
    g.lineWidth = state.tool === 'brush' || state.tool === 'eraser' ? state.style.brushSize : 2;
    if (pending.stroke) {
        g.lineCap = 'round';
        g.beginPath();
        pending.stroke.forEach((p, i) => (i === 0 ? g.moveTo(p.x, p.y) : g.lineTo(p.x, p.y)));
        g.stroke();
    } else if (end) {
        if (state.tool === 'rectangle') {
            g.strokeRect(pending.startX, pending.startY, end.x - pending.startX, end.y - pending.startY);
        } else if (state.tool === 'circle') {
            g.beginPath();
            g.ellipse((pending.startX + end.x) / 2, (pending.startY + end.y) / 2, Math.abs(end.x - pending.startX) / 2, Math.abs(end.y - pending.startY) / 2, 0, 0, Math.PI * 2);
            g.stroke();
        } else if (state.tool === 'line') {
            g.beginPath(); g.moveTo(pending.startX, pending.startY); g.lineTo(end.x, end.y); g.stroke();
        }
    }
    g.restore();
}

/**
 * Compose the export PNG in *source pixel* coordinates (image.md §5): rotation/
 * flip/filter and every annotation are baked in; grid and sprite overlays are
 * not. The original bytes are never mutated.
 */
async function composePng(
    source: CanvasImageSource & { width: number; height: number },
    state: ImageViewState
): Promise<Blob | null> {
    const swap = state.rotation === 90 || state.rotation === 270;
    const outW = swap ? source.height : source.width;
    const outH = swap ? source.width : source.height;
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    let g: CanvasRenderingContext2D | null = null;
    try {
        g = canvas.getContext('2d');
    } catch {
        g = null;
    }
    if (!g) return null;

    g.save();
    g.translate(outW / 2, outH / 2);
    g.rotate((state.rotation * Math.PI) / 180);
    g.scale(state.flipH ? -1 : 1, state.flipV ? -1 : 1);
    if ('filter' in g) (g as { filter: string }).filter = filterToCss(state.filter);
    g.drawImage(source, -source.width / 2, -source.height / 2);
    g.restore();

    // Annotations are already in source coordinates; draw them over the composed
    // image in the same source space (before rotation would misplace them, so we
    // draw into a second pass aligned to the un-rotated source, then… v1 keeps it
    // simple: annotations are composed at rotation 0). For rotated exports the
    // annotation overlay alignment is a follow-up (image.md §5 fixture work).
    if ('filter' in g) (g as { filter: string }).filter = 'none';
    for (const a of state.annotations) drawAnnotation(g, a, false);

    return await new Promise<Blob | null>((resolve) => {
        if (typeof canvas.toBlob === 'function') canvas.toBlob(resolve, 'image/png');
        else resolve(null);
    });
}

function mimeShort(mime: string): string {
    return mime.replace('image/', '').toUpperCase();
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
