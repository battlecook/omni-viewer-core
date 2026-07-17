import type { HostContext } from '../../host/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { createHwpController, type HwpController } from './controller.js';
import { hwpViewerCss } from './styles.js';

export * from './controller.js';
export { hwpViewerCss } from './styles.js';

export const HWP_VIEWER_META = { id: 'hwp', displayNameKey: 'hwp.title', extensions: ['hwp', 'hwpx'], priority: 15, requiredServices: [] as const, optionalServices: [] as const, inputOwnership: 'consumes' as const };
export const HWP_MAX_INPUT_BYTES = 50 * 1024 * 1024;
export const HWP_MAX_RENDERED_PAGES = 100;
export const SUPPORTED_DEPENDENCY_VERSIONS = { rhwp: '0.7.3' } as const;

export interface RhwpDocument {
    pageCount(): number;
    renderPageSvg(pageIndex: number): string;
    free?(): void;
}
export interface RhwpModule { HwpDocument: new (data: Uint8Array) => RhwpDocument }
export interface HwpViewerDeps { loadRhwp(): Promise<RhwpModule> }
export interface HwpViewerHandle extends ViewerHandle { readonly controller: HwpController }
export class HwpViewerError extends Error {
    constructor(readonly code: 'missing-dependency' | 'invalid-format' | 'corrupted' | 'limit-exceeded', readonly messageKey: string, options?: ErrorOptions) {
        super(messageKey, options); this.name = 'HwpViewerError';
    }
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node;
};
let activeKeyboardOwner: object | undefined;

type MeasureTextWidth = (font: string, text: string) => number;
const measureTarget = globalThis as typeof globalThis & { measureTextWidth?: MeasureTextWidth };
let measureUsers = 0;
let originalMeasure: MeasureTextWidth | undefined;
let sharedMeasure: MeasureTextWidth | undefined;

function installMeasureTextWidth(): () => void {
    if (measureUsers++ > 0) return releaseMeasureTextWidth;
    originalMeasure = measureTarget.measureTextWidth;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    sharedMeasure = (font, text) => {
        if (!context) return String(text ?? '').length * 10;
        context.font = font || '10px sans-serif';
        return context.measureText(String(text ?? '')).width;
    };
    measureTarget.measureTextWidth = sharedMeasure;
    return releaseMeasureTextWidth;
}

function releaseMeasureTextWidth(): void {
    if (measureUsers === 0 || --measureUsers > 0) return;
    if (originalMeasure) measureTarget.measureTextWidth = originalMeasure; else delete measureTarget.measureTextWidth;
    originalMeasure = undefined; sharedMeasure = undefined;
}

function svgElement(markup: string): SVGElement {
    const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const svg = parsed.documentElement;
    if (svg.localName !== 'svg' || parsed.querySelector('parsererror')) throw new HwpViewerError('corrupted', 'diag.hwp.corrupted');
    sanitizeSvg(svg);
    return document.importNode(svg, true) as unknown as SVGElement;
}

const FORBIDDEN_SVG_ELEMENTS = new Set(['script', 'style', 'foreignobject', 'iframe', 'object', 'embed', 'audio', 'video', 'animate', 'animatemotion', 'animatetransform', 'set', 'mpath']);
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'poster']);
const LOCAL_URL_PATTERN = /^url\(\s*(['"]?)#[A-Za-z_][\w:.-]*\1\s*\)$/i;
const LOCAL_FRAGMENT_PATTERN = /^#[A-Za-z_][\w:.-]*$/;
// rhwp 0.7.3 emits embedded raster pictures as data URIs. SVG is deliberately
// excluded because it can carry active content. TIFF is safe to retain but may
// remain undecodable on browsers without native TIFF support.
const SAFE_RASTER_DATA_PATTERN = /^data:image\/(?:png|jpe?g|gif|webp|bmp|x-bmp|x-ms-bmp|tiff);base64,[a-z0-9+/=\s]+$/i;

/** Fixed core policy for SVG derived from untrusted document bytes (ADR 25). */
function sanitizeSvg(root: Element): void {
    for (const node of [root, ...root.querySelectorAll('*')]) {
        if (FORBIDDEN_SVG_ELEMENTS.has(node.localName.toLowerCase())) { node.remove(); continue; }
        for (const attribute of [...node.attributes]) {
            const name = attribute.localName.toLowerCase();
            const value = attribute.value.trim();
            if (name.startsWith('on') || name === 'srcdoc') { node.removeAttributeNode(attribute); continue; }
            if (name === 'style') {
                if (!isSafeSvgStyle(value)) node.removeAttributeNode(attribute);
                continue;
            }
            if (URL_ATTRIBUTES.has(name) || name === 'xlink:href') {
                const localReference = LOCAL_FRAGMENT_PATTERN.test(value);
                const rasterImage = node.localName.toLowerCase() === 'image' && SAFE_RASTER_DATA_PATTERN.test(value);
                if (!localReference && !rasterImage) node.removeAttributeNode(attribute);
                continue;
            }
            if (/url\s*\(/i.test(value) && !LOCAL_URL_PATTERN.test(value)) node.removeAttributeNode(attribute);
        }
    }
}

function isSafeSvgStyle(style: string): boolean {
    if (/@import|expression\s*\(|javascript\s*:|data\s*:/i.test(style)) return false;
    const urls = style.match(/url\([^)]*\)/gi) ?? [];
    return urls.every((url) => LOCAL_URL_PATTERN.test(url));
}

export async function mountHwpViewer(input: ViewerInput, container: HTMLElement, ctx: HostContext, deps: Partial<HwpViewerDeps> = {}, options: MountOptions = {}): Promise<HwpViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    if (input.data.byteLength > HWP_MAX_INPUT_BYTES) throw new HwpViewerError('limit-exceeded', 'diag.hwp.limit-exceeded');
    const root: HTMLElement | ShadowRoot = options.styleIsolation !== 'scoped' && typeof container.attachShadow === 'function' ? (container.shadowRoot ?? container.attachShadow({ mode: 'open' })) : container;
    root.replaceChildren();
    let ownedStyle: HTMLStyleElement | undefined;
    if (root === container) container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--hwp'); else { ownedStyle = el('style'); ownedStyle.textContent = hwpViewerCss; root.append(ownedStyle); }
    const frame = el('section', 'omni-hwp');
    const header = el('header', 'omni-hwp__header');
    const title = el('span', 'omni-hwp__title', `📄 ${input.fileName}`);
    const meta = el('span', 'omni-hwp__meta', `${formatBytes(input.data.byteLength)} · ${input.fileName.toLowerCase().endsWith('.hwpx') ? 'HWPX' : 'HWP'}`);
    header.append(title, meta);
    const toolbar = el('div', 'omni-hwp__toolbar');
    const out = el('button', undefined, '−'), level = el('span', 'omni-hwp__zoom', '100%'), inc = el('button', undefined, '+'), reset = el('button', undefined, ctx.i18n.t('hwp.reset'));
    out.type = inc.type = reset.type = 'button'; out.setAttribute('aria-label', ctx.i18n.t('hwp.zoomOut')); inc.setAttribute('aria-label', ctx.i18n.t('hwp.zoomIn')); reset.setAttribute('aria-label', ctx.i18n.t('hwp.reset'));
    toolbar.append(out, level, inc, reset);
    const viewport = el('main', 'omni-hwp__viewport'); const content = el('div', 'omni-hwp__content'); content.setAttribute('role', 'document'); const loading = el('div', 'omni-hwp__status omni-hwp__loading', ctx.i18n.t('hwp.loading')); viewport.append(content, loading); frame.append(header, toolbar, viewport); root.append(frame);
    const controller = createHwpController(); const disposers: Array<() => void> = []; const restoreMeasure = installMeasureTextWidth(); let rhwpDocument: RhwpDocument | undefined; let cleaned = false; let loadedRhwp: RhwpModule | undefined; const keyboardOwner = {};
    activeKeyboardOwner = keyboardOwner;
    const freeDocument = (): void => { const current = rhwpDocument; rhwpDocument = undefined; current?.free?.(); };
    const cleanup = (): void => { if (cleaned) return; cleaned = true; if (activeKeyboardOwner === keyboardOwner) activeKeyboardOwner = undefined; off(); disposers.forEach((dispose) => dispose()); freeDocument(); restoreMeasure(); frame.remove(); ownedStyle?.remove(); if (root === container) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--hwp'); };
    const listen = (target: EventTarget, name: string, fn: EventListener, listenerOptions?: AddEventListenerOptions): void => { target.addEventListener(name, fn, listenerOptions); disposers.push(() => target.removeEventListener(name, fn, listenerOptions)); };
    const off = controller.subscribe((state) => { content.style.transform = `scale(${state.zoom})`; level.textContent = `${Math.round(state.zoom * 100)}%`; });
    listen(out, 'click', () => controller.dispatch({ type: 'zoom-out' })); listen(inc, 'click', () => controller.dispatch({ type: 'zoom-in' })); listen(reset, 'click', () => controller.dispatch({ type: 'reset-zoom' }));
    listen(frame, 'pointerdown', () => { activeKeyboardOwner = keyboardOwner; }); listen(frame, 'focusin', () => { activeKeyboardOwner = keyboardOwner; });
    listen(document, 'keydown', ((event: KeyboardEvent) => { if (activeKeyboardOwner !== keyboardOwner || !(event.ctrlKey || event.metaKey)) return; if (event.key === '+' || event.key === '=') controller.dispatch({ type: 'zoom-in' }); else if (event.key === '-') controller.dispatch({ type: 'zoom-out' }); else if (event.key === '0') controller.dispatch({ type: 'reset-zoom' }); else return; event.preventDefault(); }) as EventListener);
    listen(viewport, 'wheel', ((event: WheelEvent) => { if (!(event.ctrlKey || event.metaKey)) return; event.preventDefault(); controller.dispatch({ type: event.deltaY < 0 ? 'zoom-in' : 'zoom-out' }); }) as EventListener, { passive: false });
    try {
        if (!deps.loadRhwp) throw new HwpViewerError('missing-dependency', 'diag.hwp.missing-dependency');
        try { loadedRhwp = await deps.loadRhwp(); } catch (cause) { throw new HwpViewerError('missing-dependency', 'diag.hwp.missing-dependency', { cause }); }
        if (options.signal?.aborted) throw new MountAbortedError();
        try { rhwpDocument = new loadedRhwp.HwpDocument(input.data); } catch (cause) { throw new HwpViewerError('invalid-format', 'diag.hwp.invalid-format', { cause }); }
        const count = rhwpDocument.pageCount();
        if (!Number.isSafeInteger(count) || count < 0) throw new HwpViewerError('corrupted', 'diag.hwp.corrupted');
        let renderedCount = Math.min(count, HWP_MAX_RENDERED_PAGES);
        meta.textContent += ` · ${ctx.i18n.t('hwp.pages', { count })}`;
        try {
            renderPageRange(rhwpDocument, 0, renderedCount, content, ctx, options.signal);
        } finally { freeDocument(); }
        loading.remove();
        if (count > renderedCount) {
            const status = el('div', 'omni-hwp__status'); const progress = el('span', undefined, ctx.i18n.t('diag.hwp.page-limit', { rendered: renderedCount, total: count })); const more = el('button', 'omni-hwp__load-more', ctx.i18n.t('hwp.loadMorePages'));
            more.type = 'button'; status.append(progress, more); content.append(status);
            listen(more, 'click', (async () => {
                if (cleaned || !loadedRhwp) return; more.disabled = true;
                let batchDocument: RhwpDocument | undefined; const batchStart = renderedCount;
                try {
                    batchDocument = new loadedRhwp.HwpDocument(input.data);
                    const next = Math.min(count, batchStart + HWP_MAX_RENDERED_PAGES);
                    renderPageRange(batchDocument, batchStart, next, content, ctx, options.signal, status);
                    renderedCount = next;
                    if (renderedCount >= count) status.remove(); else { progress.textContent = ctx.i18n.t('diag.hwp.page-limit', { rendered: renderedCount, total: count }); more.disabled = false; }
                } catch (error) {
                    for (const page of [...content.querySelectorAll('.omni-hwp__page')]) if (Number(page.getAttribute('data-page-index')) >= batchStart) page.remove();
                    progress.textContent = ctx.i18n.t('diag.hwp.corrupted'); more.disabled = false;
                    ctx.logger.log('error', `hwp: additional page render failed: ${String(error)}`);
                } finally { batchDocument?.free?.(); }
            }) as EventListener);
        }
        if (count === 0) content.append(el('div', 'omni-hwp__status', ctx.i18n.t('hwp.empty')));
    } catch (error) {
        cleanup();
        if (error instanceof MountAbortedError || error instanceof HwpViewerError) throw error;
        ctx.logger.log('error', `hwp: renderer failed: ${String(error)}`);
        throw new HwpViewerError(deps.loadRhwp ? 'corrupted' : 'missing-dependency', deps.loadRhwp ? 'diag.hwp.corrupted' : 'diag.hwp.missing-dependency', { cause: error });
    }
    return { controller, dispose: cleanup };
}

function renderPageRange(documentHandle: RhwpDocument, start: number, end: number, content: HTMLElement, ctx: HostContext, signal?: AbortSignal, before?: Element): void {
    for (let pageIndex = start; pageIndex < end; pageIndex++) {
        if (signal?.aborted) throw new MountAbortedError();
        const page = el('section', 'omni-hwp__page'); page.dataset.pageIndex = String(pageIndex); page.setAttribute('aria-label', ctx.i18n.t('hwp.pageLabel', { page: pageIndex + 1 })); page.append(svgElement(documentHandle.renderPageSvg(pageIndex)));
        if (before) content.insertBefore(page, before); else content.append(page);
    }
}

function formatBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
