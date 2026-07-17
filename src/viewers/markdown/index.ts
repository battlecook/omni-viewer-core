import type { ClipboardService, DocumentAssetsService, FileWritebackService, HostContext, NavigationService } from '../../host/index.js';
import { ALLOWED_LINK_SCHEMES } from '../../host/index.js';
import { parseMarkdown, type MarkdownDocument, type MarkdownParseOptions } from '../../parsers/markdown/index.js';
import type { ResourceLimits } from '../../parsers/types.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { createMarkdownController, type MarkdownViewMode } from './controller.js';
import { maskMathSegments, mathSegmentLiteral, type MathSegment } from './math.js';
import { markdownViewerCss } from './styles.js';

export { parseMarkdown, type MarkdownDocument } from '../../parsers/markdown/index.js';
export { markdownViewerCss } from './styles.js';
export { createMarkdownController, type MarkdownAction, type MarkdownController, type MarkdownViewMode, type MarkdownViewState } from './controller.js';
export { maskMathSegments, mathSegmentLiteral, type MathSegment, type MaskedMathSource } from './math.js';

export const MARKDOWN_VIEWER_META = {
    id: 'markdown', displayNameKey: 'markdown.title',
    extensions: ['md', 'markdown', 'mdown', 'mkdn', 'mkd'], priority: 10,
    requiredServices: [] as const,
    optionalServices: ['clipboard', 'navigation', 'documentAssets', 'writeback'] as const,
    inputOwnership: 'borrows' as const
};

export interface MarkdownRenderer { parse(markdown: string): string; }
export interface DomPurify { sanitize(html: string, options: Record<string, unknown>): string; }
export interface MarkdownHighlighter {
    highlight(source: string, options: { language: string; ignoreIllegals: boolean }): { value: string; language?: string };
    highlightAuto(source: string): { value: string; language?: string };
    getLanguage(language: string): unknown;
}
export interface MarkdownDiagramRenderer {
    renderMermaid?(id: string, source: string): Promise<string>;
    renderPlantUml?(source: string, document: Document): SVGElement;
}
/** TeX → HTML (KaTeX renderToString shape). The output is sanitized before
 *  insertion, so the renderer does not need to be trusted with the DOM. */
export interface MarkdownMathRenderer {
    renderToHtml(source: string, displayMode: boolean): string;
}
export interface MarkdownViewerDeps {
    render: MarkdownRenderer;
    createDOMPurify(window: Window): DomPurify;
    highlighter?: MarkdownHighlighter;
    diagrams?: MarkdownDiagramRenderer;
    math?: MarkdownMathRenderer;
}
export type MarkdownViewerContext = HostContext & {
    clipboard?: ClipboardService; navigation?: NavigationService;
    documentAssets?: DocumentAssetsService; writeback?: FileWritebackService;
};
export interface MarkdownMountOptions extends MountOptions {
    limits?: ResourceLimits;
    markdownLimits?: MarkdownParseOptions['markdownLimits'];
}

const SANITIZE = {
    USE_PROFILES: { html: true }, ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['style', 'srcdoc'], ALLOW_UNKNOWN_PROTOCOLS: false
};
const SVG_SANITIZE = {
    USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['foreignObject'],
    ADD_ATTR: ['dominant-baseline', 'text-anchor', 'viewBox', 'xmlns', 'role', 'aria-roledescription']
};
// KaTeX htmlAndMathml output: spans positioned via inline style, a MathML
// twin for accessibility, and SVG for stretchy delimiters. `style` is allowed
// only inside these fragments — the outer document keeps FORBID_ATTR:style.
const MATH_SANITIZE = {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    ADD_ATTR: ['style', 'aria-hidden', 'encoding', 'definitionurl'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'a', 'img']
};

export async function mountMarkdownViewer(
    input: ViewerInput, container: HTMLElement, ctx: MarkdownViewerContext,
    deps: MarkdownViewerDeps, options: MarkdownMountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const parseOptions: MarkdownParseOptions = {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.limits ? { limits: options.limits } : {}),
        ...(options.markdownLimits ? { markdownLimits: options.markdownLimits } : {})
    };
    const parsed = parseMarkdown(input.data, parseOptions);
    if (parsed.result.status === 'failed') throw new Error(parsed.result.failure.messageKey);
    const doc = parsed.result.document;
    const root: HTMLElement | ShadowRoot = options.styleIsolation !== 'scoped' && typeof container.attachShadow === 'function'
        ? (container.shadowRoot ?? container.attachShadow({ mode: 'open' })) : container;
    if (root === container) container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--markdown');
    else { const style = document.createElement('style'); style.textContent = markdownViewerCss; root.append(style); }

    const t = ctx.i18n.t.bind(ctx.i18n);
    const controller = createMarkdownController(doc.text, doc.headings);
    const disposers: Array<() => void> = [];
    let assetReleases = new Set<() => void>();
    let disposed = false;
    let renderVersion = 0;
    let renderedHtml = '';
    let diagramCount = 0;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
        const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
    };
    const on = (node: EventTarget, type: string, listener: EventListener): void => {
        node.addEventListener(type, listener); disposers.push(() => node.removeEventListener(type, listener));
    };
    const button = (key: string, className = 'omni-markdown__button'): HTMLButtonElement => {
        const node = el('button', className, t(key)); node.type = 'button'; return node;
    };

    const shell = el('section', `${VIEWER_ROOT_CLASS} omni-viewer--markdown omni-markdown`);
    const header = el('header', 'omni-markdown__header');
    const titleBox = el('div');
    titleBox.append(el('div', 'omni-markdown__title', input.fileName), el('div', 'omni-markdown__summary'));
    const status = el('div', 'omni-markdown__status', t('markdown.ready'));
    header.append(titleBox, status);
    const toolbar = el('div', 'omni-markdown__toolbar');
    const modeGroup = el('div', 'omni-markdown__toolbar-group');
    const modeButtons = new Map<MarkdownViewMode, HTMLButtonElement>();
    for (const [mode, key] of [['preview', 'markdown.preview'], ['split', 'markdown.split'], ['source', 'markdown.source']] as const) {
        const node = button(key); node.dataset.viewMode = mode; modeButtons.set(mode, node); modeGroup.append(node);
    }
    const actionGroup = el('div', 'omni-markdown__toolbar-group');
    const renderButton = button('markdown.render', 'omni-markdown__button omni-markdown__button--primary');
    const copyHtmlButton = button('markdown.copyHtml');
    const copySourceButton = button('markdown.copySource');
    const undoButton = button('markdown.undo'); const redoButton = button('markdown.redo');
    actionGroup.append(renderButton, undoButton, redoButton, copyHtmlButton, copySourceButton);
    toolbar.append(modeGroup, actionGroup);
    const workspace = el('main', 'omni-markdown__workspace');
    const previewPanel = el('section', 'omni-markdown__panel omni-markdown__preview-panel');
    const previewHeader = el('div', 'omni-markdown__panel-header');
    const previewCaption = el('span', 'omni-markdown__caption', t('markdown.rendering'));
    previewHeader.append(el('span', undefined, t('markdown.preview')), previewCaption);
    const preview = el('article', 'omni-markdown__preview');
    previewPanel.append(previewHeader, preview);
    const sourcePanel = el('section', 'omni-markdown__panel omni-markdown__source-panel');
    const sourceHeader = el('div', 'omni-markdown__panel-header');
    const sourceCaption = el('span', 'omni-markdown__caption', t('markdown.editable'));
    sourceHeader.append(el('span', undefined, t('markdown.source')), sourceCaption);
    const source = el('textarea', 'omni-markdown__source'); source.spellcheck = false; source.value = doc.text;
    sourcePanel.append(sourceHeader, source);
    workspace.append(previewPanel, sourcePanel);
    const message = el('div', 'omni-markdown__message'); message.hidden = true;
    shell.append(header, toolbar, workspace, message); root.append(shell);

    const releaseAssets = (): void => { for (const release of assetReleases) release(); assetReleases = new Set(); };
    const setStatus = (key: string, kind = ''): void => {
        status.textContent = t(key); status.className = `omni-markdown__status${kind ? ` is-${kind}` : ''}`;
    };
    const showMessage = (text: string): void => { message.textContent = text; message.hidden = !text; };
    const syncState = (): void => {
        const state = controller.state;
        workspace.classList.toggle('is-split', state.mode === 'split');
        previewPanel.hidden = state.mode === 'source'; sourcePanel.hidden = state.mode === 'preview';
        for (const [mode, node] of modeButtons) node.classList.toggle('is-active', mode === state.mode);
        renderButton.classList.toggle('is-dirty', state.dirty); undoButton.disabled = !state.canUndo; redoButton.disabled = !state.canRedo;
        sourceCaption.textContent = t(state.dirty ? 'markdown.edited' : 'markdown.editable');
        if (state.dirty) setStatus('markdown.modified');
    };

    const hardenContent = (version: number): void => {
        preview.querySelectorAll('a').forEach(anchor => {
            const href = anchor.getAttribute('href') ?? ''; anchor.removeAttribute('href');
            if (href.startsWith('#')) { anchor.setAttribute('href', href); return; }
            try {
                const url = new URL(href);
                if (!ALLOWED_LINK_SCHEMES.includes(url.protocol) || !ctx.navigation) throw new Error('blocked');
                anchor.setAttribute('role', 'link'); anchor.tabIndex = 0;
                on(anchor, 'click', (() => void ctx.navigation!.openExternalUrl(href)) as EventListener);
            } catch { anchor.setAttribute('aria-disabled', 'true'); }
        });
        preview.querySelectorAll('img').forEach(image => {
            const path = image.getAttribute('src') ?? ''; image.removeAttribute('src');
            if (!validRelativeAsset(path) || !ctx.documentAssets) { image.replaceWith(document.createTextNode(image.alt || t('markdown.assetUnavailable'))); return; }
            void ctx.documentAssets.resolve(path).then(asset => {
                if (!asset) { if (!disposed && version === renderVersion) image.replaceWith(document.createTextNode(image.alt || t('markdown.assetUnavailable'))); return; }
                let released = false; const release = (): void => { if (!released) { released = true; assetReleases.delete(release); asset.dispose(); } };
                if (disposed || version !== renderVersion) { release(); return; }
                assetReleases.add(release); image.src = asset.url;
                image.addEventListener('load', release, { once: true }); image.addEventListener('error', release, { once: true });
            }).catch(() => { if (!disposed && version === renderVersion) image.replaceWith(document.createTextNode(image.alt || t('markdown.assetUnavailable'))); });
        });
    };

    const renderEnhancements = async (version: number): Promise<void> => {
        diagramCount = 0;
        const purifier = deps.createDOMPurify(window);
        const codes = [...preview.querySelectorAll('pre > code')] as HTMLElement[];
        for (const [index, code] of codes.entries()) {
            const language = codeLanguage(code);
            if (language === 'mermaid' && deps.diagrams?.renderMermaid) {
                diagramCount++; const frame = el('div', 'omni-markdown__diagram omni-markdown__diagram--mermaid'); frame.setAttribute('role', 'img');
                try { frame.innerHTML = purifier.sanitize(await deps.diagrams.renderMermaid(`omni-md-${version}-${index}`, code.textContent ?? ''), SVG_SANITIZE); }
                catch (error) { frame.classList.add('is-invalid'); frame.textContent = errorText(error, t('markdown.diagramFailed')); }
                if (version === renderVersion) code.closest('pre')?.replaceWith(frame);
            } else if (['plantuml', 'puml', 'uml'].includes(language) && deps.diagrams?.renderPlantUml) {
                diagramCount++; const frame = el('div', 'omni-markdown__diagram omni-markdown__diagram--plantuml'); frame.setAttribute('role', 'img');
                try { frame.innerHTML = purifier.sanitize(new XMLSerializer().serializeToString(deps.diagrams.renderPlantUml(code.textContent ?? '', document)), SVG_SANITIZE); }
                catch (error) { frame.classList.add('is-invalid'); frame.textContent = errorText(error, t('markdown.diagramFailed')); }
                code.closest('pre')?.replaceWith(frame);
            } else if (deps.highlighter) {
                const sourceText = code.textContent ?? '';
                const result = language && deps.highlighter.getLanguage(language)
                    ? deps.highlighter.highlight(sourceText, { language, ignoreIllegals: true }) : deps.highlighter.highlightAuto(sourceText);
                code.innerHTML = purifier.sanitize(result.value, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] });
                code.classList.add('hljs'); if (result.language) code.dataset.language = result.language;
            }
        }
    };

    const applyMath = (segments: MathSegment[]): void => {
        if (!segments.length || !deps.math) return;
        const math = deps.math;
        const purifier = deps.createDOMPurify(window);
        const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
        const textNodes: Text[] = [];
        while (walker.nextNode()) {
            const node = walker.currentNode as Text;
            if (node.parentElement?.closest('pre, code, textarea')) continue;
            if (node.nodeValue?.includes('omni-math-token-')) textNodes.push(node);
        }
        for (const node of textNodes) {
            const fragment = document.createDocumentFragment();
            for (const part of (node.nodeValue ?? '').split(/(%%omni-math-token-\d+%%)/)) {
                const match = /^%%omni-math-token-(\d+)%%$/.exec(part);
                const segment = match ? segments[Number(match[1])] : undefined;
                if (!segment) { if (part) fragment.append(document.createTextNode(part)); continue; }
                const holder = el('span', `omni-markdown__math${segment.display ? ' omni-markdown__math--display' : ''}`);
                try { holder.innerHTML = purifier.sanitize(math.renderToHtml(segment.source, segment.display), MATH_SANITIZE); }
                catch { holder.classList.add('is-invalid'); holder.textContent = mathSegmentLiteral(segment); }
                fragment.append(holder);
            }
            node.replaceWith(fragment);
        }
    };

    const boundedRenderSource = (sourceText: string): { source: string; partial: boolean } => {
        const outcome = parseMarkdown(new TextEncoder().encode(sourceText), parseOptions);
        if (outcome.result.status === 'failed') throw new Error(t(outcome.result.failure.messageKey));
        return { source: outcome.result.document.renderText, partial: outcome.result.status === 'partial' };
    };

    const renderMarkdown = async (save: boolean): Promise<void> => {
        const version = ++renderVersion; releaseAssets(); setStatus('markdown.rendering'); showMessage('');
        try {
            // Re-apply the parser limits on every render: the editor may have
            // changed since mount, and marked/DOM must never see an unbounded source.
            const bounded = boundedRenderSource(controller.state.source);
            // Math is lifted out before marked (emphasis would corrupt TeX)
            // and re-inserted into the sanitized DOM afterwards.
            const masked = deps.math ? maskMathSegments(bounded.source) : { masked: bounded.source, segments: [] };
            const sanitizedHtml = deps.createDOMPurify(window).sanitize(deps.render.parse(masked.masked), SANITIZE);
            renderedHtml = sanitizedHtml.replace(/%%omni-math-token-(\d+)%%/g,
                (whole, at: string) => { const segment = masked.segments[Number(at)]; return segment ? mathSegmentLiteral(segment) : whole; });
            preview.replaceChildren();
            const holder = new DOMParser().parseFromString(sanitizedHtml, 'text/html');
            while (holder.body.firstChild) preview.append(holder.body.firstChild);
            preview.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((heading, index) => heading.id = `heading-${index}`);
            hardenContent(version); await renderEnhancements(version);
            if (disposed || version !== renderVersion) return;
            applyMath(masked.segments);
            const lines = controller.state.source ? controller.state.source.split(/\r?\n/).length : 0;
            const words = controller.state.source.match(/\S+/g)?.length ?? 0;
            titleBox.querySelector('.omni-markdown__summary')!.textContent = t('markdown.summary', { lines, words });
            previewCaption.textContent = diagramCount ? t('markdown.renderedDiagrams', { count: diagramCount }) : t('markdown.rendered');
            setStatus('markdown.rendered', 'valid');
            if (bounded.partial) showMessage(t('diag.markdown.limit-exceeded'));
            if (save) await saveSource();
        } catch (error) {
            preview.replaceChildren(); renderedHtml = ''; previewCaption.textContent = t('markdown.renderFailed');
            setStatus('markdown.invalid', 'invalid'); showMessage(errorText(error, t('markdown.renderFailed')));
        }
    };
    const saveSource = async (): Promise<void> => {
        if (!ctx.writeback) { showMessage(t('common.noWriteback')); setStatus('common.saveFailed', 'invalid'); return; }
        try { await ctx.writeback.write(new TextEncoder().encode(controller.state.source)); controller.dispatch({ type: 'mark-saved' }); setStatus('common.savedToOriginal', 'valid'); sourceCaption.textContent = t('common.savedToOriginal'); }
        catch (error) { ctx.logger.log('error', `markdown save failed: ${String(error)}`); setStatus('common.saveFailed', 'invalid'); showMessage(errorText(error, t('common.saveFailed'))); }
    };
    const copy = async (value: string, successKey: string): Promise<void> => {
        if (!ctx.clipboard) return;
        try { await ctx.clipboard.writeText(value); setStatus(successKey, 'valid'); } catch (error) { ctx.logger.log('error', `markdown copy failed: ${String(error)}`); }
    };

    for (const [mode, node] of modeButtons) on(node, 'click', (() => controller.dispatch({ type: 'set-mode', mode })) as EventListener);
    on(source, 'input', (() => controller.dispatch({ type: 'edit-source', source: source.value })) as EventListener);
    on(source, 'keydown', (event => {
        const keyboard = event as KeyboardEvent; const key = keyboard.key.toLowerCase(); const command = keyboard.metaKey || keyboard.ctrlKey;
        if (command && key === 'z') { keyboard.preventDefault(); controller.dispatch({ type: keyboard.shiftKey ? 'redo' : 'undo' }); source.value = controller.state.source; }
        else if (command && key === 'y') { keyboard.preventDefault(); controller.dispatch({ type: 'redo' }); source.value = controller.state.source; }
        else if (command && key === 's') {
            keyboard.preventDefault();
            if (ctx.writeback) void renderMarkdown(true); else void saveSource();
        } else if (keyboard.shiftKey && keyboard.key === 'Enter') {
            keyboard.preventDefault(); void renderMarkdown(Boolean(ctx.writeback));
        }
    }) as EventListener);
    // Render remains useful in read-only adapters. Saving is coupled only when
    // the host actually advertised and supplied writeback.
    on(renderButton, 'click', (() => void renderMarkdown(Boolean(ctx.writeback))) as EventListener);
    on(undoButton, 'click', (() => { controller.dispatch({ type: 'undo' }); source.value = controller.state.source; }) as EventListener);
    on(redoButton, 'click', (() => { controller.dispatch({ type: 'redo' }); source.value = controller.state.source; }) as EventListener);
    on(copyHtmlButton, 'click', (() => void copy(renderedHtml, 'markdown.htmlCopied')) as EventListener);
    on(copySourceButton, 'click', (() => void copy(source.value, 'markdown.sourceCopied')) as EventListener);
    if (!ctx.clipboard) { for (const node of [copyHtmlButton, copySourceButton]) { node.disabled = true; node.title = t('common.noClipboard'); } }
    const off = controller.subscribe(syncState); disposers.push(off);
    syncState(); await renderMarkdown(false);
    if (options.signal?.aborted) { shell.remove(); releaseAssets(); throw new MountAbortedError(); }
    return { dispose() { disposed = true; renderVersion++; releaseAssets(); for (const dispose of disposers.splice(0)) dispose(); shell.remove(); } };
}

function codeLanguage(block: Element): string {
    for (const name of block.classList) if (name.startsWith('language-')) return name.slice(9).toLowerCase(); else if (name.startsWith('lang-')) return name.slice(5).toLowerCase();
    return '';
}
function errorText(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }
function validRelativeAsset(path: string): boolean {
    try { const decoded = decodeURIComponent(path); return !!decoded && !/^(?:[a-z][a-z0-9+.-]*:|[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(decoded); }
    catch { return false; }
}
