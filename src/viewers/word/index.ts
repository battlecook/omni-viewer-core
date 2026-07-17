import { ALLOWED_LINK_SCHEMES, type HostContext, type NavigationService, type PrintService } from '../../host/index.js';
import { DocBinaryParser } from '../../parsers/doc-binary/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { createWordController, type WordController } from './controller.js';
import { wordViewerCss } from './styles.js';
import { DocxDecompressionLimitError, preprocessDocx, type ChartModel, type DocxPlaceholder, type SheetModule, type ZipModule } from './docx-preprocess.js';
import { paginateLegacyDocument } from './paginate.js';
import { normalizeDocxPreviewDom } from './normalize-docx.js';

export * from './controller.js';
export { wordViewerCss } from './styles.js';

export const WORD_VIEWER_META = { id: 'word', displayNameKey: 'word.title', extensions: ['docx', 'doc'], priority: 15, requiredServices: [] as const, optionalServices: ['print', 'navigation'] as const, inputOwnership: 'consumes' as const };
export const WORD_MAX_INPUT_BYTES = 50 * 1024 * 1024;

export interface DocxPreviewModule {
    renderAsync(data: ArrayBuffer | Uint8Array, body: HTMLElement, styleContainer?: HTMLElement, options?: Record<string, unknown>): Promise<unknown>;
}
export interface WordViewerDeps { loadDocxPreview(): Promise<DocxPreviewModule>; loadZip(): Promise<ZipModule>; loadSheet?(): Promise<SheetModule> }
export type WordViewerContext = HostContext & { print?: PrintService; navigation?: NavigationService };
export interface WordViewerHandle extends ViewerHandle { readonly controller: WordController }

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node;
};

export async function mountWordViewer(input: ViewerInput, container: HTMLElement, ctx: WordViewerContext, deps: Partial<WordViewerDeps> = {}, options: MountOptions = {}): Promise<WordViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    if (input.data.byteLength > WORD_MAX_INPUT_BYTES) throw new Error(ctx.i18n.t('diag.word.limit-exceeded'));
    const root: HTMLElement | ShadowRoot = options.styleIsolation !== 'scoped' && typeof container.attachShadow === 'function' ? (container.shadowRoot ?? container.attachShadow({ mode: 'open' })) : container;
    root.replaceChildren();
    if (root === container) container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--word'); else { const style = el('style'); style.textContent = wordViewerCss; root.append(style); }
    const frame = el('section', 'omni-word');
    const header = el('header', 'omni-word__header');
    header.append(el('span', 'omni-word__title', `📄 ${input.fileName}`), el('span', 'omni-word__meta', `${formatBytes(input.data.byteLength)} · ${input.fileName.toLowerCase().endsWith('.docx') ? 'DOCX' : 'legacy DOC'}`));
    const toolbar = el('div', 'omni-word__toolbar');
    const out = el('button', undefined, '−'), level = el('span', 'omni-word__zoom', '100%'), inc = el('button', undefined, '+'), reset = el('button', undefined, ctx.i18n.t('word.reset')), print = el('button', undefined, ctx.i18n.t('word.print'));
    out.type = inc.type = reset.type = print.type = 'button'; out.setAttribute('aria-label', ctx.i18n.t('word.zoomOut')); inc.setAttribute('aria-label', ctx.i18n.t('word.zoomIn')); reset.setAttribute('aria-label', ctx.i18n.t('word.reset')); print.setAttribute('aria-label', ctx.i18n.t('word.print'));
    if (!ctx.print) { print.disabled = true; print.title = ctx.i18n.t('word.printUnavailable'); }
    toolbar.append(out, level, inc, reset, print);
    const viewport = el('main', 'omni-word__viewport'); const content = el('div', 'omni-word__content'); content.setAttribute('role', 'document'); viewport.append(content); frame.append(header, toolbar, viewport); root.append(frame);
    const controller = createWordController(); const disposers: Array<() => void> = [];
    const listen = (target: EventTarget, name: string, fn: EventListener): void => { target.addEventListener(name, fn); disposers.push(() => target.removeEventListener(name, fn)); };
    const off = controller.subscribe((state) => { content.style.transform = `scale(${state.zoom})`; level.textContent = `${Math.round(state.zoom * 100)}%`; });
    out.onclick = () => controller.dispatch({ type: 'zoom-out' }); inc.onclick = () => controller.dispatch({ type: 'zoom-in' }); reset.onclick = () => controller.dispatch({ type: 'reset-zoom' }); print.onclick = () => void ctx.print?.print();
    listen(frame, 'keydown', ((event: KeyboardEvent) => { if (!(event.ctrlKey || event.metaKey)) return; if (event.key === '+' || event.key === '=') controller.dispatch({ type: 'zoom-in' }); else if (event.key === '-') controller.dispatch({ type: 'zoom-out' }); else if (event.key === '0') controller.dispatch({ type: 'reset-zoom' }); else if (event.key.toLowerCase() === 'p' && ctx.print) void ctx.print.print(); else return; event.preventDefault(); }) as EventListener);
    listen(viewport, 'wheel', ((event: WheelEvent) => { if (!(event.ctrlKey || event.metaKey)) return; event.preventDefault(); controller.dispatch({ type: event.deltaY < 0 ? 'zoom-in' : 'zoom-out' }); }) as EventListener);
    try {
        if (input.fileName.toLowerCase().endsWith('.docx')) {
            content.classList.add('word-content', 'docx-mode');
            content.classList.remove('legacy-mode');
            if (!deps.loadDocxPreview) throw new Error(ctx.i18n.t('diag.word.missing-dependency'));
            if (!deps.loadZip) throw new Error(ctx.i18n.t('diag.word.missing-dependency'));
            const [docx, zip, sheet] = await Promise.all([deps.loadDocxPreview(), deps.loadZip(), deps.loadSheet?.()]); if (options.signal?.aborted) throw new MountAbortedError();
            const prepared = await preprocessDocx(input.data, zip, sheet);
            await docx.renderAsync(prepared.data, content, content, { inWrapper: true, breakPages: true, ignoreWidth: false, ignoreHeight: false, ignoreFonts: false, renderHeaders: true, renderFooters: true });
            injectDocxPlaceholders(content, prepared.placeholders);
            normalizeDocxPreviewDom(content);
            secureDocxDom(content, ctx, disposers);
        } else {
            content.classList.add('word-content', 'legacy-mode');
            if (!deps.loadSheet) ctx.logger.log('warn', 'word: legacy embedded workbook previews disabled because loadSheet is unavailable');
            if (!deps.loadZip) ctx.logger.log('warn', 'word: legacy embedded package/chart previews disabled because loadZip is unavailable');
            const [legacyZip, legacySheet] = await Promise.all([deps.loadZip?.(), deps.loadSheet?.()]);
            const legacyHtml = await DocBinaryParser.parseBytes(input.data, { jszip: legacyZip, xlsx: legacySheet });
            const parsed = new DOMParser().parseFromString(legacyHtml, 'text/html');
            parsed.querySelectorAll('script:not(.ov-doc-legacy-section-meta),iframe,object,embed').forEach((node) => node.remove());
            const fragment = document.createDocumentFragment(); for (const child of [...parsed.body.childNodes]) fragment.append(document.importNode(child, true)); content.append(fragment);
            secureDocxDom(content, ctx, disposers);
            paginateLegacyDocument(content);
        }
    } catch (error) {
        if (error instanceof MountAbortedError) { off(); disposers.forEach((dispose) => dispose()); frame.remove(); throw error; }
        content.replaceChildren(el('div', 'omni-word__error', error instanceof DocxDecompressionLimitError ? ctx.i18n.t('diag.word.decompression-limit') : error instanceof Error ? error.message : String(error)));
    }
    return { controller, dispose() { off(); disposers.forEach((dispose) => dispose()); frame.remove(); } };
}

function formatBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

function injectDocxPlaceholders(root: HTMLElement, placeholders: DocxPlaceholder[]): void {
    for (const placeholder of placeholders) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node: Node | null;
        while ((node = walker.nextNode())) { const value = node.textContent ?? ''; const index = value.indexOf(placeholder.token); if (index < 0 || !node.parentNode) continue; const fragment = document.createDocumentFragment(); if (index) fragment.append(value.slice(0, index)); fragment.append(placeholder.kind === 'chart' ? renderChart(placeholder.chart) : renderEmbeddedSheet(placeholder.title, placeholder.rows)); if (index + placeholder.token.length < value.length) fragment.append(value.slice(index + placeholder.token.length)); node.parentNode.replaceChild(fragment, node); break; }
    }
}

function renderEmbeddedSheet(title: string, rows: string[][]): HTMLElement {
    const section = el('section', 'omni-word__embedded-sheet'); section.append(el('h3', undefined, title)); const table = el('table', 'omni-word__legacy-table'); rows.forEach((row, rowIndex) => { const tr = el('tr'); row.forEach((value) => tr.append(el(rowIndex ? 'td' : 'th', undefined, value))); table.append(tr); }); section.append(table); return section;
}

function renderChart(chart: ChartModel): HTMLElement {
    const card = el('figure', 'omni-word__chart'); card.setAttribute('aria-label', chart.title || 'Chart'); if (chart.title) card.append(el('figcaption', undefined, chart.title));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 640 300'); svg.setAttribute('role', 'img'); const max = Math.max(1, ...chart.series.flatMap((series) => series.values)); const group = 520 / Math.max(1, chart.categories.length), bar = group / Math.max(1, chart.series.length + 1);
    chart.series.forEach((series, seriesIndex) => series.values.forEach((value, valueIndex) => { const rect = document.createElementNS(svg.namespaceURI, 'rect'); const height = Math.max(0, value) / max * 220; rect.setAttribute('x', String(70 + valueIndex * group + seriesIndex * bar)); rect.setAttribute('y', String(250 - height)); rect.setAttribute('width', String(Math.max(2, bar - 2))); rect.setAttribute('height', String(height)); rect.setAttribute('fill', series.color); svg.append(rect); })); card.append(svg); const legend = el('div', 'omni-word__chart-legend'); chart.series.forEach((series) => { const item = el('span', undefined, series.name); item.style.borderLeft = `12px solid ${series.color}`; legend.append(item); }); card.append(legend); return card;
}

function secureDocxDom(root: HTMLElement, ctx: WordViewerContext, disposers: Array<() => void>): void {
    root.querySelectorAll('img,source,video,audio').forEach((node) => { for (const attr of ['src', 'srcset']) { const value = node.getAttribute(attr); if (value && /^(?:https?:)?\/\//i.test(value)) node.removeAttribute(attr); } });
    root.querySelectorAll('a').forEach((anchor) => { const href = anchor.getAttribute('href') ?? ''; anchor.removeAttribute('href'); anchor.removeAttribute('target'); let allowed = false; try { allowed = ALLOWED_LINK_SCHEMES.includes(new URL(href).protocol); } catch { allowed = false; } if (!allowed || !ctx.navigation) { anchor.setAttribute('aria-disabled', 'true'); return; } anchor.setAttribute('role', 'link'); anchor.tabIndex = 0; const open = (event: Event): void => { event.preventDefault(); void ctx.navigation?.openExternalUrl(href); }; anchor.addEventListener('click', open); disposers.push(() => anchor.removeEventListener('click', open)); });
    root.querySelectorAll('iframe,object,embed,script:not(.ov-doc-legacy-section-meta)').forEach((node) => node.remove());
}
