import type { ClipboardService, DocumentAssetsService, FileSaveService, FileWritebackService, HostContext, NavigationService } from '../../host/index.js';
import { ALLOWED_LINK_SCHEMES } from '../../host/index.js';
import { parseMarkdown, type MarkdownDocument, type MarkdownParseOptions } from '../../parsers/markdown/index.js';
import type { ResourceLimits } from '../../parsers/types.js';
import { bindFragmentAnchor, classifyAnchorTarget } from '../anchors.js';
import { MATH_SANITIZE_PROFILE, type DomPurify, type MathRenderer } from '../math.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { createMarkdownController, type MarkdownViewMode } from './controller.js';
import { maskMathSegments, mathSegmentLiteral, type MathSegment } from './math.js';
import {
    assignSourceLines, createScrollPairs, measureLineTops, projectScroll, scanSourceBlocks,
    SOURCE_LINE_ATTRIBUTE, type ScrollPair
} from './source-map.js';
import { markdownViewerCss } from './styles.js';

export { parseMarkdown, type MarkdownDocument } from '../../parsers/markdown/index.js';
export { markdownViewerCss } from './styles.js';
export { createMarkdownController, type MarkdownAction, type MarkdownController, type MarkdownViewMode, type MarkdownViewState } from './controller.js';
export { maskMathSegments, mathSegmentLiteral, type MathSegment, type MaskedMathSource } from './math.js';
export {
    assignSourceLines, projectScroll, scanSourceBlocks, SOURCE_LINE_ATTRIBUTE,
    type ScrollPair, type SourceBlock, type SourceBlockKind
} from './source-map.js';

export const MARKDOWN_VIEWER_META = {
    id: 'markdown', displayNameKey: 'markdown.title',
    extensions: ['md', 'markdown', 'mdown', 'mkdn', 'mkd'], priority: 10,
    requiredServices: [] as const,
    optionalServices: ['clipboard', 'navigation', 'documentAssets', 'writeback', 'save'] as const,
    inputOwnership: 'borrows' as const
};

export interface MarkdownRenderer { parse(markdown: string): string; }
export { type DomPurify, type MathRenderer } from '../math.js';
export interface MarkdownHighlighter {
    highlight(source: string, options: { language: string; ignoreIllegals: boolean }): { value: string; language?: string };
    highlightAuto(source: string): { value: string; language?: string };
    getLanguage(language: string): unknown;
}
export interface MarkdownDiagramRenderer {
    renderMermaid?(id: string, source: string): Promise<string>;
    renderPlantUml?(source: string, document: Document): SVGElement;
}
/** @deprecated Use the shared `MathRenderer` (`../math.js`) — kept as an alias
 *  so adapters written against this name keep compiling. */
export type MarkdownMathRenderer = MathRenderer;
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
    save?: FileSaveService;
};
export interface MarkdownMountOptions extends MountOptions {
    limits?: ResourceLimits;
    markdownLimits?: MarkdownParseOptions['markdownLimits'];
    /** Whether split view keeps the two panes scrolled to the same place.
     *  On by default, and not exposed in the viewer's own chrome — a host that
     *  wants it configurable should drive this from its own settings. */
    scrollSync?: boolean;
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
    let liveTimer: ReturnType<typeof setTimeout> | undefined;
    const scrollSyncEnabled = options.scrollSync ?? true;
    // Rebuilt lazily on the first scroll after a render, edit, or mode change,
    // because measuring anchors needs settled layout.
    let scrollPairs: { toPreview: ScrollPair[]; toSource: ScrollPair[] } | undefined;
    // Which pane drove the scroll currently being propagated. A programmatic
    // scrollTop write echoes back one event on the other pane; that echo is
    // swallowed here so the two panes cannot chase each other.
    let scrollDriver: 'source' | 'preview' | undefined;
    // Heading offsets share the scroll map's lifetime: both are pixel positions
    // that only a layout change can move, and both are rebuilt on first use.
    let headingOffsets: number[] | undefined;
    // `undefined` means "follow the mode"; the toggle is what pins it.
    let tocPreferred: boolean | undefined;
    let tocEntries: Array<{ id: string; heading: HTMLElement; link: HTMLElement }> = [];
    // Only a mode change moves the panels; heading selection must not invalidate
    // the measured anchors, or every scroll-spy update would force a remeasure.
    let lastMode: MarkdownViewMode = 'preview';
    /** Drop every cached pixel position. Anything that can move content inside
     *  the preview — a render, an edit, a panel resize, a late-arriving image —
     *  has to come through here, or the anchors describe a stale layout. */
    const invalidateMeasurements = (): void => { scrollPairs = undefined; headingOffsets = undefined; };
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
    const tocButton = button('markdown.toc');
    modeGroup.append(tocButton);
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
    // The outline shares the preview panel's scroll region so it stays beside
    // the prose it indexes rather than competing with the source pane.
    const previewBody = el('div', 'omni-markdown__preview-body');
    const toc = el('nav', 'omni-markdown__toc');
    toc.setAttribute('aria-label', t('markdown.toc'));
    const tocList = el('ul', 'omni-markdown__toc-list');
    toc.append(tocList);
    const preview = el('article', 'omni-markdown__preview');
    previewBody.append(toc, preview);
    previewPanel.append(previewHeader, previewBody);
    const sourcePanel = el('section', 'omni-markdown__panel omni-markdown__source-panel');
    const sourceHeader = el('div', 'omni-markdown__panel-header');
    const sourceCaption = el('span', 'omni-markdown__caption', t('markdown.editable'));
    sourceHeader.append(el('span', undefined, t('markdown.source')), sourceCaption);
    // The textarea stays the editable surface; a highlighted <pre> is layered
    // behind it (transparent textarea text, visible caret) so the source shows
    // syntax highlighting while keeping native editing/selection behaviour.
    const sourceWrap = el('div', 'omni-markdown__source-wrap');
    const sourceHighlight = el('pre', 'omni-markdown__source-highlight'); sourceHighlight.setAttribute('aria-hidden', 'true');
    const sourceHighlightCode = el('code');
    sourceHighlight.append(sourceHighlightCode);
    const source = el('textarea', 'omni-markdown__source'); source.spellcheck = false; source.value = doc.text;
    sourceWrap.append(sourceHighlight, source);
    sourcePanel.append(sourceHeader, sourceWrap);
    workspace.append(previewPanel, sourcePanel);
    const message = el('div', 'omni-markdown__message'); message.hidden = true;
    shell.append(header, toolbar, workspace, message); root.append(shell);

    const releaseAssets = (): void => { for (const release of assetReleases) release(); assetReleases = new Set(); };
    const setStatus = (key: string, kind = ''): void => {
        status.textContent = t(key); status.className = `omni-markdown__status${kind ? ` is-${kind}` : ''}`;
    };
    const showMessage = (text: string): void => { message.textContent = text; message.hidden = !text; };
    const highlightToc = (): void => {
        for (const entry of tocEntries) {
            const active = entry.id === controller.state.selectedHeading;
            entry.link.classList.toggle('is-active', active);
            if (active) entry.link.setAttribute('aria-current', 'true'); else entry.link.removeAttribute('aria-current');
        }
    };
    // Split already divides the width two ways, so a third column makes both
    // panes cramped. The outline steps aside there until the reader asks for it.
    const tocShouldShow = (): boolean => tocPreferred ?? controller.state.mode !== 'split';
    const applyTocVisibility = (): void => {
        const shown = tocShouldShow() && tocEntries.length > 0;
        tocButton.disabled = !tocEntries.length;
        tocButton.classList.toggle('is-active', shown);
        tocButton.setAttribute('aria-pressed', String(shown));
        if (toc.hidden === !shown) return;
        toc.hidden = !shown;
        invalidateMeasurements(); // the preview's width just changed
    };
    const syncState = (): void => {
        const state = controller.state;
        if (state.mode !== lastMode) { lastMode = state.mode; invalidateMeasurements(); }
        applyTocVisibility();
        highlightToc();
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
            const target = classifyAnchorTarget(href);
            // Restoring `href` would not scroll anything under the default shadow
            // isolation, where document-level fragment lookup cannot see the target.
            if (target.kind === 'fragment' && bindFragmentAnchor(anchor, target.name, preview, preview, disposers)) return;
            if (target.kind !== 'absolute' || !ALLOWED_LINK_SCHEMES.includes(target.url.protocol) || !ctx.navigation) { anchor.setAttribute('aria-disabled', 'true'); return; }
            anchor.setAttribute('role', 'link'); anchor.tabIndex = 0;
            on(anchor, 'click', (() => void ctx.navigation!.openExternalUrl(href)) as EventListener);
        });
        preview.querySelectorAll('img').forEach(image => {
            const path = image.getAttribute('src') ?? ''; image.removeAttribute('src');
            if (!validRelativeAsset(path) || !ctx.documentAssets) { image.replaceWith(document.createTextNode(image.alt || t('markdown.assetUnavailable'))); return; }
            void ctx.documentAssets.resolve(path).then(asset => {
                if (!asset) { if (!disposed && version === renderVersion) image.replaceWith(document.createTextNode(image.alt || t('markdown.assetUnavailable'))); return; }
                let released = false; const release = (): void => { if (!released) { released = true; assetReleases.delete(release); asset.dispose(); } };
                if (disposed || version !== renderVersion) { release(); return; }
                assetReleases.add(release); image.src = asset.url;
                // An image settling changes the preview's height well after the
                // anchors were measured, so the map has to be dropped with it.
                const settle = (): void => { release(); invalidateMeasurements(); };
                image.addEventListener('load', settle, { once: true }); image.addEventListener('error', settle, { once: true });
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
                try { holder.innerHTML = purifier.sanitize(math.renderToHtml(segment.source, segment.display), MATH_SANITIZE_PROFILE); }
                catch { holder.classList.add('is-invalid'); holder.textContent = mathSegmentLiteral(segment); }
                fragment.append(holder);
            }
            node.replaceWith(fragment);
        }
    };

    /** Distance from the preview's top within which a heading counts as current. */
    const SPY_THRESHOLD_PX = 12;
    const previewOffsetOf = (node: HTMLElement): number =>
        node.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop;
    // Built from the rendered headings rather than the parser's source index:
    // the index counts `#` inside fenced code and misses setext headings, and
    // only the rendered element gives a scroll target and a `data-source-line`.
    const buildToc = (): void => {
        const found: Array<{ heading: HTMLElement; id: string; level: string; text: string }> = [];
        for (const node of preview.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
            const heading = node as HTMLElement;
            const text = headingLabel(heading);
            if (text) found.push({ heading, id: heading.id, level: heading.tagName.slice(1), text });
        }
        const unchanged = found.length === tocEntries.length && found.every((item, index) => {
            const entry = tocEntries[index]!;
            return entry.id === item.id && entry.link.dataset.level === item.level && entry.link.textContent === item.text;
        });
        if (unchanged) {
            // The live preview re-renders every 250ms while typing. Replacing
            // entries that read the same would scroll the outline back to the
            // top and throw keyboard focus out of it on every keystroke; only
            // the heading elements behind them actually changed.
            for (const [index, item] of found.entries()) tocEntries[index]!.heading = item.heading;
        } else {
            tocList.replaceChildren();
            tocEntries = found.map(item => {
                const link = el('button', 'omni-markdown__toc-link', item.text);
                link.type = 'button'; link.title = item.text;
                link.dataset.level = item.level; link.dataset.headingId = item.id;
                const listItem = el('li'); listItem.append(link); tocList.append(listItem);
                return { id: item.id, heading: item.heading, link };
            });
        }
        applyTocVisibility();
        highlightToc();
    };
    const revealHeading = (id: string): void => {
        const entry = tocEntries.find(item => item.id === id);
        if (!entry) return;
        controller.dispatch({ type: 'select-heading', id });
        // Left as a plain scrollTop write so the preview's own scroll handler
        // still runs and carries the source pane along in split mode.
        preview.scrollTop = Math.max(0, previewOffsetOf(entry.heading) - SPY_THRESHOLD_PX);
    };
    // Marks the last heading at or above the top of the viewport. Dispatches
    // only on change, so scrolling does not churn controller subscribers.
    // Offsets are cached because this runs on every scroll event: measuring each
    // heading per frame reads the layout O(headings) times for a result that
    // cannot have changed without an invalidation.
    const spyHeading = (): void => {
        if (!tocEntries.length) return;
        if (!headingOffsets) {
            const base = preview.getBoundingClientRect().top - preview.scrollTop;
            headingOffsets = tocEntries.map(entry => entry.heading.getBoundingClientRect().top - base);
        }
        const top = preview.scrollTop;
        let current;
        if (preview.scrollHeight - preview.clientHeight - top <= 1) {
            // The last screenful holds every heading that never reaches the top
            // edge. Ranking by "has passed the top" freezes there on whichever
            // one last did, leaving the closing sections unreachable however far
            // down the reader is — at the end, the end of the outline is current.
            current = tocEntries[tocEntries.length - 1]!.id;
        } else {
            current = tocEntries[0]!.id;
            for (const [index, entry] of tocEntries.entries()) {
                if (headingOffsets[index]! - top > SPY_THRESHOLD_PX) break;
                current = entry.id;
            }
        }
        if (current !== controller.state.selectedHeading) controller.dispatch({ type: 'select-heading', id: current });
    };

    // Pair every anchored preview element with the pixel offset of its source
    // line, plus both scroll extents, so the ends of the two panes always meet.
    const buildScrollPairs = (): { toPreview: ScrollPair[]; toSource: ScrollPair[] } => {
        const anchored = [...preview.querySelectorAll(`[${SOURCE_LINE_ATTRIBUTE}]`)] as HTMLElement[];
        const sourceTops = measureLineTops(sourceHighlight, source.value, anchored.map(node => Number(node.getAttribute(SOURCE_LINE_ATTRIBUTE))));
        const previewBase = preview.getBoundingClientRect().top - preview.scrollTop;
        const maxSource = Math.max(0, source.scrollHeight - source.clientHeight);
        const maxPreview = Math.max(0, preview.scrollHeight - preview.clientHeight);
        const collector = createScrollPairs();
        collector.push(0, 0);
        for (const [index, node] of anchored.entries()) {
            const top = sourceTops[index];
            if (top === undefined) continue;
            const previewTop = node.getBoundingClientRect().top - previewBase;
            // Anchors inside the last screenful sit past an extent. Clamping them
            // here would occupy the terminal pair's `from`, and the extents that
            // follow would then be dropped for not ascending — leaving the last
            // screen of the document unreachable. The terminal pair covers them.
            if (top >= maxSource || previewTop >= maxPreview) continue;
            collector.push(top, previewTop);
        }
        collector.push(maxSource, maxPreview);
        return { toPreview: collector.pairs, toSource: collector.pairs.map(({ from, to }) => ({ from: to, to: from })) };
    };
    const applyScroll = (target: HTMLElement, value: number, driver: 'source' | 'preview'): void => {
        const next = Math.max(0, Math.min(Math.max(0, target.scrollHeight - target.clientHeight), Math.round(value)));
        // A write that changes nothing emits no event, so claiming the driver
        // slot here would swallow the other pane's next genuine scroll.
        if (Math.abs(target.scrollTop - next) < 1) return;
        scrollDriver = driver;
        target.scrollTop = next;
    };
    const syncScroll = (from: 'source' | 'preview'): void => {
        if (!scrollSyncEnabled || controller.state.mode !== 'split') return;
        scrollPairs ??= buildScrollPairs();
        if (from === 'source') applyScroll(preview, projectScroll(source.scrollTop, scrollPairs.toPreview), 'source');
        else applyScroll(source, projectScroll(preview.scrollTop, scrollPairs.toSource), 'preview');
    };

    const boundedRenderSource = (sourceText: string): { source: string; partial: boolean } => {
        const outcome = parseMarkdown(new TextEncoder().encode(sourceText), parseOptions);
        if (outcome.result.status === 'failed') throw new Error(t(outcome.result.failure.messageKey));
        return { source: outcome.result.document.renderText, partial: outcome.result.status === 'partial' };
    };

    const renderMarkdown = async (save: boolean): Promise<void> => {
        if (liveTimer) { clearTimeout(liveTimer); liveTimer = undefined; }
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
            // Every heading gets a stable id, but a slug the renderer already
            // emitted wins: in-document `#slug` links are written against those.
            // These ids are the preview's own; MarkdownHeading.id from the parser
            // is a source-order handle and is not expected to match them.
            const takenIds = new Set([...preview.querySelectorAll('[id]')].map(node => node.id));
            preview.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((heading, index) => {
                if (heading.id) return;
                // A renderer slug can itself be `heading-2`; duplicate ids would send
                // `#heading-2` to whichever element comes first in document order.
                let id = `heading-${index}`;
                for (let suffix = 1; takenIds.has(id); suffix++) id = `heading-${index}-${suffix}`;
                heading.id = id; takenIds.add(id);
            });
            hardenContent(version); await renderEnhancements(version);
            if (disposed || version !== renderVersion) return;
            applyMath(masked.segments);
            // Anchored last: enhancers replace whole elements (a fenced block
            // becomes a diagram frame), which would discard attributes set
            // earlier. Lines come from the unmasked source so they address the
            // editor's text, not the math-masked copy handed to the renderer.
            assignSourceLines(preview, scanSourceBlocks(bounded.source));
            invalidateMeasurements();
            buildToc(); spyHeading();
            const lines = controller.state.source ? controller.state.source.split(/\r?\n/).length : 0;
            const words = controller.state.source.match(/\S+/g)?.length ?? 0;
            titleBox.querySelector('.omni-markdown__summary')!.textContent = t('markdown.summary', { lines, words });
            previewCaption.textContent = diagramCount ? t('markdown.renderedDiagrams', { count: diagramCount }) : t('markdown.rendered');
            setStatus('markdown.rendered', 'valid');
            if (bounded.partial) showMessage(t('diag.markdown.limit-exceeded'));
            if (save) await saveSource();
        } catch (error) {
            preview.replaceChildren(); invalidateMeasurements(); buildToc();
            renderedHtml = ''; previewCaption.textContent = t('markdown.renderFailed');
            setStatus('markdown.invalid', 'invalid'); showMessage(errorText(error, t('markdown.renderFailed')));
        }
    };
    const saveSource = async (): Promise<void> => {
        const bytes = new TextEncoder().encode(controller.state.source);
        if (ctx.writeback) {
            try { await ctx.writeback.write(bytes); controller.dispatch({ type: 'mark-saved' }); setStatus('common.savedToOriginal', 'valid'); sourceCaption.textContent = t('common.savedToOriginal'); }
            catch (error) { ctx.logger.log('error', `markdown save failed: ${String(error)}`); setStatus('common.saveFailed', 'invalid'); showMessage(errorText(error, t('common.saveFailed'))); }
            return;
        }
        if (ctx.save) {
            // Download fallback saves a copy, not the original — the dirty
            // state is intentionally kept (no mark-saved).
            try { await ctx.save.saveFile(input.fileName, bytes, 'text/markdown'); setStatus('common.savedToOriginal', 'valid'); }
            catch (error) { ctx.logger.log('error', `markdown save failed: ${String(error)}`); setStatus('common.saveFailed', 'invalid'); showMessage(errorText(error, t('common.saveFailed'))); }
            return;
        }
        showMessage(t('common.noWriteback')); setStatus('common.saveFailed', 'invalid');
    };
    const copy = async (value: string, successKey: string): Promise<void> => {
        if (!ctx.clipboard) return;
        try { await ctx.clipboard.writeText(value); setStatus(successKey, 'valid'); } catch (error) { ctx.logger.log('error', `markdown copy failed: ${String(error)}`); }
    };

    // Paint the highlight overlay from the current textarea value. Highlight.js
    // markup is sanitized to spans-only before insertion; the trailing newline
    // keeps the final source line at full height so the overlay never clips.
    // The textarea scrolls and the overlay behind it does not, so a vertical
    // scrollbar narrows only the textarea's content box. The two then wrap at
    // different columns and the caret drifts away from the glyphs it sits
    // between. `clientWidth` already excludes the scrollbar, whose width varies
    // by platform and by whether it overlays, so the overlay is pinned to it
    // rather than to a guess.
    const matchOverlayWidth = (): void => {
        const width = source.clientWidth;
        if (width > 0) sourceHighlight.style.width = `${width}px`;
    };
    const highlightSource = (): void => {
        matchOverlayWidth();
        const text = source.value;
        let html: string;
        if (deps.highlighter && deps.highlighter.getLanguage('markdown')) {
            try {
                const result = deps.highlighter.highlight(text, { language: 'markdown', ignoreIllegals: true });
                html = deps.createDOMPurify(window).sanitize(result.value, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] });
            } catch { html = escapeHtml(text); }
        } else {
            html = escapeHtml(text);
        }
        sourceHighlightCode.innerHTML = `${html}\n`;
    };
    // Debounced live preview: typing (or undo/redo) refreshes the rendered
    // panel without saving, so the split view stays in sync as you edit.
    const scheduleLiveRender = (): void => {
        // The edit already moved the source lines the anchors were measured at,
        // so drop them now rather than after the debounce settles.
        invalidateMeasurements();
        if (liveTimer) clearTimeout(liveTimer);
        liveTimer = setTimeout(() => { liveTimer = undefined; void renderMarkdown(false); }, 250);
    };
    const syncSourceFromState = (): void => {
        source.value = controller.state.source; highlightSource(); scheduleLiveRender();
    };
    // Save is a document-level action, so it is handled on the shell (below)
    // rather than only inside the textarea — otherwise Ctrl/Cmd+S while focus
    // sits on a toolbar button or the preview would fall through to the host's
    // native "save page" dialog. Writeback overwrites the original; without it
    // we fall back to a downloaded copy via saveSource().
    const saveDocument = (): void => {
        if (ctx.writeback) void renderMarkdown(true); else void saveSource();
    };

    for (const [mode, node] of modeButtons) on(node, 'click', (() => controller.dispatch({ type: 'set-mode', mode })) as EventListener);
    on(source, 'input', (() => { controller.dispatch({ type: 'edit-source', source: source.value }); highlightSource(); scheduleLiveRender(); }) as EventListener);
    on(source, 'scroll', (() => {
        // The overlay tracks the textarea even for echoed scrolls — it is not a
        // sync target, it is the same surface.
        sourceHighlight.scrollTop = source.scrollTop; sourceHighlight.scrollLeft = source.scrollLeft;
        if (scrollDriver === 'preview') { scrollDriver = undefined; return; }
        syncScroll('source');
    }) as EventListener);
    on(preview, 'scroll', (() => {
        // The outline tracks the viewport even for echoed scrolls — it reflects
        // position rather than driving it.
        spyHeading();
        if (scrollDriver === 'source') { scrollDriver = undefined; return; }
        syncScroll('preview');
    }) as EventListener);
    // Delegated so a re-render can replace every entry without accumulating
    // listeners — the live preview rebuilds this list every 250ms while typing.
    on(tocList, 'click', (event => {
        const id = (event.target as HTMLElement | null)?.closest<HTMLElement>('.omni-markdown__toc-link')?.dataset.headingId;
        if (id) revealHeading(id);
    }) as EventListener);
    on(tocButton, 'click', (() => { tocPreferred = !tocShouldShow(); applyTocVisibility(); }) as EventListener);
    on(source, 'keydown', (event => {
        const keyboard = event as KeyboardEvent; const key = keyboard.key.toLowerCase(); const command = keyboard.metaKey || keyboard.ctrlKey;
        if (command && key === 'z') { keyboard.preventDefault(); controller.dispatch({ type: keyboard.shiftKey ? 'redo' : 'undo' }); syncSourceFromState(); }
        else if (command && key === 'y') { keyboard.preventDefault(); controller.dispatch({ type: 'redo' }); syncSourceFromState(); }
        else if (keyboard.shiftKey && keyboard.key === 'Enter') {
            keyboard.preventDefault(); void renderMarkdown(Boolean(ctx.writeback));
        }
    }) as EventListener);
    // Viewer-wide save: catches Ctrl/Cmd+S bubbling from anywhere inside the
    // viewer (textarea, toolbar, preview) so the host's page-save never wins.
    on(shell, 'keydown', (event => {
        const keyboard = event as KeyboardEvent;
        if ((keyboard.metaKey || keyboard.ctrlKey) && keyboard.key.toLowerCase() === 's') {
            keyboard.preventDefault(); saveDocument();
        }
    }) as EventListener);
    // Render remains useful in read-only adapters. Saving is coupled only when
    // the host actually advertised and supplied writeback.
    on(renderButton, 'click', (() => void renderMarkdown(Boolean(ctx.writeback))) as EventListener);
    on(undoButton, 'click', (() => { controller.dispatch({ type: 'undo' }); syncSourceFromState(); }) as EventListener);
    on(redoButton, 'click', (() => { controller.dispatch({ type: 'redo' }); syncSourceFromState(); }) as EventListener);
    on(copyHtmlButton, 'click', (() => void copy(renderedHtml, 'markdown.htmlCopied')) as EventListener);
    on(copySourceButton, 'click', (() => void copy(source.value, 'markdown.sourceCopied')) as EventListener);
    if (!ctx.clipboard) { for (const node of [copyHtmlButton, copySourceButton]) { node.disabled = true; node.title = t('common.noClipboard'); } }
    // Resizing the container or a late web font rewraps both panes, moving every
    // measured position without touching the document.
    if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(() => { invalidateMeasurements(); matchOverlayWidth(); });
        observer.observe(workspace);
        // The textarea resizes on its own when the mode changes the grid.
        observer.observe(source);
        disposers.push(() => observer.disconnect());
    }
    const off = controller.subscribe(syncState); disposers.push(off);
    syncState(); highlightSource(); await renderMarkdown(false);
    if (options.signal?.aborted) { shell.remove(); releaseAssets(); throw new MountAbortedError(); }
    return { dispose() { disposed = true; renderVersion++; if (liveTimer) clearTimeout(liveTimer); releaseAssets(); for (const dispose of disposers.splice(0)) dispose(); shell.remove(); } };
}

/** Flat text for an outline entry. Rendered math contributes twice to
 *  `textContent` — KaTeX emits a visual copy alongside a MathML twin — so the
 *  presentation copy, which is the `aria-hidden` one, is dropped first. */
function headingLabel(heading: HTMLElement): string {
    const clone = heading.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove());
    return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}
function codeLanguage(block: Element): string {
    for (const name of block.classList) if (name.startsWith('language-')) return name.slice(9).toLowerCase(); else if (name.startsWith('lang-')) return name.slice(5).toLowerCase();
    return '';
}
function errorText(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }
function escapeHtml(value: string): string {
    return value.replace(/[&<>]/g, ch => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
}
function validRelativeAsset(path: string): boolean {
    try { const decoded = decodeURIComponent(path); return !!decoded && !/^(?:[a-z][a-z0-9+.-]*:|[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(decoded); }
    catch { return false; }
}
