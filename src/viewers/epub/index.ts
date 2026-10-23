// EPUB viewer: a reflowable reading pane with the book's table of contents,
// chapter navigation, text scaling, and a metadata panel.
//
// `parseEpub` reads the package; chapters and images are inflated on demand
// through `openEpubArchive`, one spine document at a time. Chapter markup goes
// through `prepareChapter` (inert parse → DOMPurify → reference rewrite) before
// it reaches the live DOM, container images are shown from blob URLs that are
// revoked when the chapter changes, internal links navigate the spine, and
// external links go through the host NavigationService only (ADR 25).

import type { HostContext, NavigationService } from '../../host/index.js';
import { ALLOWED_LINK_SCHEMES } from '../../host/index.js';
import {
    EPUB_DEFAULT_MAX_CHAPTER_BYTES,
    EPUB_DEFAULT_MAX_RESOURCE_BYTES,
    EpubReadError,
    decodeMarkupText,
    isExternalHref,
    openEpubArchive,
    parseEpub,
    resolveEpubHref,
    type EpubArchive,
    type DecodedText,
    type EpubDocument,
    type EpubInflate,
    type EpubSpineItem,
    type EpubTocEntry
} from '../../parsers/epub/index.js';
import type { Diagnostic, ParseFailure, ResourceLimits } from '../../parsers/types.js';
import { revealFragmentTarget } from '../anchors.js';
import type { DomPurify } from '../math.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { createEpubController, EPUB_FONT_SCALE_STEP, type EpubPanel } from './controller.js';
import { ANCHOR_ATTRIBUTE, countTagStarts, dropMarkupEntities, EPUB_MAX_CHAPTER_ELEMENTS, guessImageType, tooManyAttributes, LINK_ATTRIBUTE, prepareChapter, RESOURCE_ATTRIBUTE, stripSvgReferences } from './content.js';
import { epubViewerCss } from './styles.js';

export {
    EPUB_DEFAULT_MAX_CHAPTER_BYTES,
    EPUB_DEFAULT_MAX_DECOMPRESSED_BYTES,
    EPUB_DEFAULT_MAX_ITEMS,
    EPUB_DEFAULT_MAX_RESOURCE_BYTES,
    EPUB_INPUT_OWNERSHIP,
    EpubArchive,
    EpubReadError,
    decodeMarkupText,
    isExternalHref,
    openEpubArchive,
    parseEpub,
    resolveEpubHref
} from '../../parsers/epub/index.js';
export type * from '../../parsers/epub/model.js';
export type { EpubInflate, EpubParseOptions } from '../../parsers/epub/index.js';
export {
    createEpubController,
    EPUB_DEFAULT_FONT_SCALE,
    EPUB_FONT_SCALE_STEP,
    EPUB_MAX_FONT_SCALE,
    EPUB_MIN_FONT_SCALE,
    type EpubAction,
    type EpubController,
    type EpubPanel,
    type EpubViewState
} from './controller.js';
export { EPUB_MAX_CHAPTER_ELEMENTS, EPUB_SANITIZE_PROFILE, prepareChapter, type PreparedChapter } from './content.js';
export { epubViewerCss } from './styles.js';

export const EPUB_VIEWER_META = {
    id: 'epub',
    displayNameKey: 'epub.title',
    extensions: ['epub'] as string[],
    priority: 20,
    requiredServices: [] as const,
    optionalServices: ['navigation'] as const,
    inputOwnership: 'borrows' as const
};

export interface EpubViewerDeps {
    /** DOMPurify factory (the `dompurify` default export). Chapters are never inserted unsanitized. */
    createDOMPurify(window: Window): DomPurify;
}

export type EpubViewerContext = HostContext & { navigation?: NavigationService };

export interface EpubMountOptions extends MountOptions {
    limits?: ResourceLimits;
    /** Raw-deflate inflater for hosts without `DecompressionStream`. */
    inflate?: EpubInflate;
    /** Largest single image read (default EPUB_DEFAULT_MAX_RESOURCE_BYTES). */
    maxResourceBytes?: number;
    /** Largest single chapter read (default EPUB_DEFAULT_MAX_CHAPTER_BYTES; always clamped to maxResourceBytes). */
    maxChapterBytes?: number;
    /** Most elements a chapter may have before it is refused (default EPUB_MAX_CHAPTER_ELEMENTS). */
    maxChapterElements?: number;
    /** Spine index to open first (default: the first linear document). */
    initialIndex?: number;
}

export interface EpubViewerHandle extends ViewerHandle {
    /** Spine index of the open document. */
    currentIndex(): number;
    /** Opens a spine document, optionally at a fragment. */
    goTo(index: number, fragment?: string): void;
}

/** Image types a blob URL may carry (IMAGE_BLOB_TYPES); anything else is served as opaque bytes. */
const IMAGE_BLOB_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml']);
const SVG_IMAGE_SANITIZE_PROFILE = Object.freeze({
    USE_PROFILES: Object.freeze({ svg: true, svgFilters: true }),
    FORBID_TAGS: Object.freeze(['style', 'foreignObject'])
});
/** Image members inflated at once; a chapter with hundreds of images must not inflate them all together. */
const IMAGE_READ_CONCURRENCY = 4;

/** Runs at most IMAGE_READ_CONCURRENCY tasks at a time, in order. */
function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
    let active = 0;
    const queue: Array<() => void> = [];
    const next = (): void => {
        if (active >= limit) return;
        const start = queue.shift();
        if (start) start();
    };
    return task => new Promise((resolve, reject) => {
        queue.push(() => {
            active++;
            task().then(resolve, reject).finally(() => {
                active--;
                next();
            });
        });
        next();
    });
}

/** Elements an SVG image may hold before it is shown as its alt text instead. */
const MAX_SVG_IMAGE_ELEMENTS = 50_000;
/** Bytes an SVG image may have; real figures and covers are far smaller. */
const MAX_SVG_IMAGE_BYTES = 4 * 1024 * 1024;

/** Diagnostics listed in Book info; the rest are summarized in one line. */
const MAX_LISTED_DIAGNOSTICS = 200;

/** Decoded chapter texts kept for quick back-and-forth navigation. */
const CHAPTER_CACHE_SIZE = 6;

export async function mountEpubViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: EpubViewerContext,
    deps: EpubViewerDeps,
    options: EpubMountOptions = {}
): Promise<EpubViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const outcome = await parseEpub(input.data, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.limits ? { limits: options.limits } : {}),
        ...(options.inflate ? { inflate: options.inflate } : {})
    });
    if (options.signal?.aborted) throw new MountAbortedError();

    const root: HTMLElement | ShadowRoot = options.styleIsolation !== 'scoped' && typeof container.attachShadow === 'function'
        ? (container.shadowRoot ?? container.attachShadow({ mode: 'open' }))
        : container;
    let style: HTMLStyleElement | undefined;
    if (root !== container) {
        style = document.createElement('style');
        style.textContent = epubViewerCss;
        root.append(style);
    }
    const t = ctx.i18n.t.bind(ctx.i18n);
    const shell = el('section', `${VIEWER_ROOT_CLASS} omni-viewer--epub omni-epub`);
    root.append(shell);

    const result = outcome.result;
    if (result.status === 'failed') {
        renderFailure(shell, input.fileName, result.failure, t);
        return {
            dispose() { shell.remove(); style?.remove(); },
            currentIndex: () => -1,
            goTo: () => undefined
        };
    }

    const book = result.document;
    const archive = openEpubArchive(input.data, {
        ...(options.inflate ? { inflate: options.inflate } : {}),
        ...(options.limits?.maxDecompressedBytes !== undefined ? { maxDecompressedBytes: options.limits.maxDecompressedBytes } : {})
    });
    // parseEpub already opened the same bytes, so this cannot fail in practice.
    if (!archive) {
        renderFailure(shell, input.fileName, { code: 'invalid-format', retryable: false, messageKey: 'diag.epub.not-zip' }, t);
        return { dispose() { shell.remove(); style?.remove(); }, currentIndex: () => -1, goTo: () => undefined };
    }
    const view = new EpubView(book, archive, result.diagnostics, result.status === 'partial', shell, input.fileName, ctx, deps, options);
    try {
        await view.start();
    } catch (error) {
        view.dispose();
        style?.remove();
        throw error;
    }
    return {
        dispose() { view.dispose(); style?.remove(); },
        currentIndex: () => view.currentIndex(),
        goTo: (index, fragment) => view.goTo(index, fragment)
    };
}

function renderFailure(shell: HTMLElement, fileName: string, failure: ParseFailure, t: (key: string, args?: Record<string, string | number>) => string): void {
    const header = el('header', 'omni-epub__header');
    const titles = el('div');
    titles.append(el('div', 'omni-epub__eyebrow', t('epub.title')), el('h1', 'omni-epub__title', fileName));
    header.append(titles);
    const body = el('div', 'omni-epub__viewport');
    const page = el('div', 'omni-epub__page');
    const message = el('div', 'omni-epub__message is-error', t(failure.messageKey, failure.args));
    message.setAttribute('role', 'alert');
    page.append(message);
    body.append(page);
    shell.append(header, body);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

interface TocLink {
    entry: EpubTocEntry;
    button: HTMLButtonElement;
}

class EpubView {
    private readonly t: (key: string, args?: Record<string, string | number>) => string;
    private readonly controller;
    private readonly disposers: Array<() => void> = [];
    /** Listeners and blob URLs that belong to the chapter on screen. */
    private chapterDisposers: Array<() => void> = [];
    private readonly chapterCache = new Map<number, DecodedText>();
    private readonly mediaTypes = new Map<string, string>();
    private readonly spineByPath = new Map<string, EpubSpineItem>();
    private readonly maxResourceBytes: number;
    private readonly maxChapterBytes: number;
    private readonly maxChapterElements: number;
    private renderVersion = 0;
    private disposed = false;
    /** Cancels every archive read for the view's lifetime; the mount signal only feeds it until start() settles. */
    private readonly lifetime = new AbortController();
    private unlinkMountSignal: (() => void) | undefined;
    /** Cancels the reads (text and images) of the chapter on screen when it is left. */
    private chapterAbort = new AbortController();
    /** One limiter per view, so leaving a chapter mid-load cannot stack two chapters' reads. */
    private readonly limitImageReads = createLimiter(IMAGE_READ_CONCURRENCY);
    private renderedIndex = -1;
    private tocLinks: TocLink[] = [];
    /** id → element for the chapter on screen (see indexFragments). */
    private fragments = new Map<string, HTMLElement>();
    /** Fragment to keep on screen while the chapter's images load and grow above it. */
    private anchor: string | undefined;
    private coverUrl: string | undefined;

    private readonly toolbar = el('div', 'omni-epub__toolbar');
    private readonly tocButton = el('button');
    private readonly infoButton = el('button');
    private readonly previousButton = el('button');
    private readonly nextButton = el('button');
    private readonly chapterSelect = el('select', 'omni-epub__select');
    private readonly position = el('span', 'omni-epub__position');
    private readonly smallerButton = el('button');
    private readonly largerButton = el('button');
    private readonly scaleLabel = el('button', 'omni-epub__scale');
    /** Polite announcement of text-size changes for screen readers. */
    private readonly scaleStatus = el('span', 'omni-epub__sr-only');
    private appliedScale: number | undefined;
    private readonly warnings = el('div', 'omni-epub__warnings');
    private readonly side = el('aside', 'omni-epub__side');
    private readonly tocPanel = el('nav');
    private readonly infoPanel = el('section', 'omni-epub__info');
    private readonly viewport = el('main', 'omni-epub__viewport');
    private readonly page = el('article', 'omni-epub__page');
    private readonly pager = el('div', 'omni-epub__pager');
    private readonly pagerPrevious = el('button');
    private readonly pagerNext = el('button');

    constructor(
        private readonly book: EpubDocument,
        private readonly archive: EpubArchive,
        private readonly diagnostics: readonly Diagnostic[],
        private readonly partial: boolean,
        private readonly shell: HTMLElement,
        private readonly fileName: string,
        private readonly ctx: EpubViewerContext,
        private readonly deps: EpubViewerDeps,
        private readonly options: EpubMountOptions
    ) {
        this.t = ctx.i18n.t.bind(ctx.i18n);
        this.maxResourceBytes = options.maxResourceBytes ?? EPUB_DEFAULT_MAX_RESOURCE_BYTES;
        this.maxChapterBytes = Math.min(options.maxChapterBytes ?? EPUB_DEFAULT_MAX_CHAPTER_BYTES, this.maxResourceBytes);
        this.maxChapterElements = options.maxChapterElements ?? EPUB_MAX_CHAPTER_ELEMENTS;
        for (const item of book.manifest) if (item.path) this.mediaTypes.set(item.path, item.mediaType);
        // First spine item per path, the same rule the parser's TOC mapping uses.
        for (const item of book.spine) if (item.path && !this.spineByPath.has(item.path)) this.spineByPath.set(item.path, item);
        this.controller = createEpubController(book.spine, {
            ...(options.initialIndex !== undefined ? { index: options.initialIndex } : {})
        });
    }

    currentIndex(): number {
        return this.controller.state.index;
    }

    goTo(index: number, fragment?: string): void {
        if (this.disposed) return;
        if (this.controller.dispatch({ type: 'go', index, ...(fragment ? { fragment } : {}) })) void this.renderChapter();
    }

    async start(): Promise<void> {
        const mountSignal = this.options.signal;
        if (mountSignal) {
            // MountOptions.signal cancels initialization only; a host that
            // mounts with AbortSignal.timeout() must not break later reading.
            const forward = (): void => this.lifetime.abort();
            mountSignal.addEventListener('abort', forward, { once: true });
            this.unlinkMountSignal = () => mountSignal.removeEventListener('abort', forward);
        }
        try {
            await this.initialize();
        } finally {
            this.unlinkMountSignal?.();
            this.unlinkMountSignal = undefined;
        }
    }

    private async initialize(): Promise<void> {
        this.build();
        this.applyPanel();
        this.applyScale();
        void this.loadCover();
        await this.renderChapter();
        if (this.options.signal?.aborted) throw new MountAbortedError();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.renderVersion++;
        this.unlinkMountSignal?.();
        this.lifetime.abort();
        this.releaseChapter();
        if (this.coverUrl) URL.revokeObjectURL(this.coverUrl);
        for (const dispose of this.disposers.splice(0)) dispose();
        this.shell.remove();
    }

    // ── Construction ──

    private on(node: EventTarget, type: string, listener: EventListener, target = this.disposers): void {
        node.addEventListener(type, listener);
        target.push(() => node.removeEventListener(type, listener));
    }

    private button(node: HTMLButtonElement, key: string, label?: string): HTMLButtonElement {
        node.type = 'button';
        node.textContent = label ?? this.t(key);
        node.title = this.t(key);
        node.setAttribute('aria-label', this.t(key));
        return node;
    }

    private build(): void {
        const { book, t } = this;
        const metadata = book.metadata;
        const header = el('header', 'omni-epub__header');
        const titles = el('div');
        const authors = metadata.creators.map(creator => creator.name).join(', ');
        const subtitle = [authors, this.fileName].filter(Boolean).join(' · ');
        titles.append(
            el('div', 'omni-epub__eyebrow', t('epub.eyebrow', { version: book.version || '?' })),
            el('h1', 'omni-epub__title', metadata.title || this.fileName),
            el('div', 'omni-epub__subtitle', subtitle)
        );
        header.append(titles);

        const panels = el('div', 'omni-epub__group');
        this.button(this.tocButton, 'epub.contents');
        this.button(this.infoButton, 'epub.info');
        panels.append(this.tocButton, this.infoButton);

        const navigation = el('div', 'omni-epub__group');
        this.button(this.previousButton, 'epub.previous', '‹');
        this.button(this.nextButton, 'epub.next', '›');
        this.chapterSelect.setAttribute('aria-label', t('epub.chapter'));
        for (const item of book.spine) {
            const option = el('option', undefined, this.chapterLabel(item));
            option.value = String(item.index);
            this.chapterSelect.append(option);
        }
        this.position.setAttribute('aria-live', 'polite');
        navigation.append(this.previousButton, this.chapterSelect, this.nextButton, this.position);

        const scale = el('div', 'omni-epub__group');
        this.button(this.smallerButton, 'epub.textSmaller', 'A−');
        this.button(this.largerButton, 'epub.textLarger', 'A+');
        this.button(this.scaleLabel, 'epub.textReset');
        this.scaleStatus.setAttribute('role', 'status');
        scale.append(this.smallerButton, this.scaleLabel, this.largerButton, this.scaleStatus);
        // A group, not role="toolbar": the controls stay individually tabbable
        // and do not promise arrow-key movement between them.
        this.toolbar.setAttribute('role', 'group');
        this.toolbar.setAttribute('aria-label', t('epub.toolbar'));
        this.toolbar.append(panels, navigation, el('span', 'omni-epub__spacer'), scale);

        const notes = this.diagnostics.filter(diagnostic => diagnostic.severity !== 'info');
        this.warnings.setAttribute('role', 'status');
        // Only a partial book gets the band; warnings on a fully readable one
        // (a wrong mimetype) stay in Book info.
        if (this.partial) {
            this.warnings.textContent = t('epub.partial', { count: notes.length });
        } else {
            this.warnings.hidden = true;
        }

        this.tocPanel.setAttribute('aria-label', t('epub.contents'));
        this.buildToc();
        this.buildInfo();
        this.side.append(this.tocPanel, this.infoPanel);

        this.page.setAttribute('role', 'document');
        this.page.setAttribute('aria-live', 'off');
        this.button(this.pagerPrevious, 'epub.previous', `‹ ${t('epub.previous')}`);
        this.button(this.pagerNext, 'epub.next', `${t('epub.next')} ›`);
        this.pager.append(this.pagerPrevious, this.pagerNext);
        this.viewport.tabIndex = 0;
        this.viewport.setAttribute('aria-label', t('epub.reader'));
        this.viewport.append(this.page, this.pager);
        const body = el('div', 'omni-epub__body');
        body.append(this.side, this.viewport);
        this.shell.append(header, this.toolbar, this.warnings, body);

        const step = (direction: 1 | -1): void => {
            if (this.controller.dispatch({ type: direction === 1 ? 'next' : 'previous' })) void this.renderChapter();
        };
        this.on(this.previousButton, 'click', () => step(-1));
        this.on(this.nextButton, 'click', () => step(1));
        this.on(this.pagerPrevious, 'click', () => step(-1));
        this.on(this.pagerNext, 'click', () => step(1));
        this.on(this.chapterSelect, 'change', () => this.goTo(Number(this.chapterSelect.value)));
        this.on(this.tocButton, 'click', () => this.togglePanel('toc'));
        this.on(this.infoButton, 'click', () => this.togglePanel('info'));
        const font = (delta: number): void => {
            if (this.controller.dispatch({ type: 'font', delta })) this.applyScale();
        };
        this.on(this.smallerButton, 'click', () => font(-EPUB_FONT_SCALE_STEP));
        this.on(this.largerButton, 'click', () => font(EPUB_FONT_SCALE_STEP));
        this.on(this.scaleLabel, 'click', () => {
            if (this.controller.dispatch({ type: 'font-reset' })) this.applyScale();
        });
        this.on(this.tocPanel, 'click', (event) => {
            const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.omni-epub__toc-link');
            const link = this.tocLinks.find(candidate => candidate.button === button);
            if (!link || link.button.disabled) return;
            this.goTo(link.entry.spineIndex, link.entry.fragment);
        });
        this.on(this.viewport, 'scroll', () => this.highlightToc());
        // Once the reader scrolls on their own, late images must not yank the view back.
        for (const type of ['wheel', 'pointerdown', 'touchstart', 'keydown']) {
            this.on(this.viewport, type, (event) => {
                // Activating a link by keyboard is a jump, not reader scrolling: the
                // link's own handler has just set the anchor this keydown would clear.
                // makeLink's handler runs first at the target and prevents the default
                // for the keys it consumes; any other key (Space scrolling) still counts.
                if (type === 'keydown' && event.defaultPrevented) return;
                this.anchor = undefined;
            });
        }
        const settleImage = (): void => {
            if (!this.anchor) return;
            const target = this.fragmentTarget(this.anchor);
            if (!target) return;
            this.viewport.scrollTop += target.getBoundingClientRect().top - this.viewport.getBoundingClientRect().top;
        };
        // load/error do not bubble; capture them for every image in the page.
        this.page.addEventListener('load', settleImage, true);
        this.page.addEventListener('error', settleImage, true);
        this.disposers.push(() => {
            this.page.removeEventListener('load', settleImage, true);
            this.page.removeEventListener('error', settleImage, true);
        });
        this.on(this.shell, 'keydown', (event) => this.onKeyDown(event as KeyboardEvent));
    }

    private chapterLabel(item: EpubSpineItem): string {
        return item.title || this.t('epub.section', { number: item.index + 1 });
    }

    private buildToc(): void {
        const { book, t } = this;
        const title = el('h2', 'omni-epub__side-title', t('epub.contents'));
        const list = el('ul', 'omni-epub__toc');
        this.tocLinks = [];
        const appendEntries = (parent: HTMLUListElement, entries: readonly EpubTocEntry[]): void => {
            // `hidden` only keeps entries out of the book's own content flow; a
            // reading system's navigation UI shows them (EPUB 3.3 §7.4.1).
            for (const entry of entries) {
                const item = el('li');
                if (!entry.path) {
                    item.append(el('span', 'omni-epub__toc-heading', entry.label));
                } else {
                    const button = el('button', 'omni-epub__toc-link', entry.label || t('epub.untitled'));
                    button.type = 'button';
                    button.title = entry.label;
                    if (entry.spineIndex < 0) button.disabled = true;
                    item.append(button);
                    this.tocLinks.push({ entry, button });
                }
                if (entry.children.length > 0) {
                    const nested = el('ul');
                    appendEntries(nested, entry.children);
                    item.append(nested);
                }
                parent.append(item);
            }
        };
        if (book.toc.length > 0) {
            appendEntries(list, book.toc);
        } else {
            // No navigation document: the spine itself is the table of contents.
            // Same order the controller reads in: linear items, or all of them when none is linear.
            const listed = book.spine.some(item => item.linear) ? book.spine.filter(item => item.linear) : book.spine;
            const synthesized: EpubTocEntry[] = listed.map(item => ({
                label: this.chapterLabel(item), path: item.path, fragment: '', spineIndex: item.index, hidden: false, children: []
            }));
            appendEntries(list, synthesized);
        }
        this.tocPanel.append(title, list);
    }

    private buildInfo(): void {
        const { book, t } = this;
        const metadata = book.metadata;
        const title = el('h2', 'omni-epub__side-title', t('epub.info'));
        const rows: Array<[string, string]> = [];
        const add = (key: string, value: string): void => {
            if (value) rows.push([t(key), value]);
        };
        const people = (list: typeof metadata.creators): string =>
            list.map(person => (person.role && person.role !== 'aut' ? `${person.name} (${person.role})` : person.name)).join('\n');
        add('epub.meta.title', metadata.title);
        add('epub.meta.otherTitles', metadata.otherTitles.join('\n'));
        add('epub.meta.creators', people(metadata.creators));
        add('epub.meta.contributors', people(metadata.contributors));
        add('epub.meta.publisher', metadata.publisher);
        add('epub.meta.date', metadata.date);
        add('epub.meta.modified', metadata.modified);
        add('epub.meta.language', metadata.languages.join(', '));
        add('epub.meta.identifiers', metadata.identifiers.map(id => (id.scheme ? `${id.scheme}: ${id.value}` : id.value)).join('\n'));
        add('epub.meta.series', metadata.series ? (metadata.seriesIndex ? `${metadata.series} #${metadata.seriesIndex}` : metadata.series) : '');
        add('epub.meta.subjects', metadata.subjects.join('\n'));
        add('epub.meta.description', metadata.description);
        add('epub.meta.rights', metadata.rights);
        add('epub.meta.source', metadata.source);
        add('epub.meta.version', book.version);
        add('epub.meta.layout', t(book.layout === 'pre-paginated' ? 'epub.layout.fixed' : 'epub.layout.reflowable'));
        if (book.direction !== 'default') add('epub.meta.direction', t(book.direction === 'rtl' ? 'epub.direction.rtl' : 'epub.direction.ltr'));
        add('epub.meta.chapters', String(book.spine.length));
        add('epub.meta.files', String(book.fileCount));
        add('epub.meta.package', book.packagePath);

        const list = el('dl', 'omni-epub__meta');
        for (const [label, value] of rows) list.append(el('dt', undefined, label), el('dd', undefined, value));
        this.infoPanel.append(title);
        const cover = el('img', 'omni-epub__cover');
        cover.alt = t('epub.cover');
        cover.hidden = true;
        this.infoPanel.append(cover, list);
        const notes = this.diagnostics;
        if (notes.length > 0) {
            const diagnostics = el('ul', 'omni-epub__diagnostics');
            diagnostics.setAttribute('aria-label', t('epub.diagnostics'));
            // Bounded: a hostile package can produce thousands of per-item diagnostics.
            for (const diagnostic of notes.slice(0, MAX_LISTED_DIAGNOSTICS)) {
                const text = t(diagnostic.messageKey, diagnostic.args);
                diagnostics.append(el('li', undefined, diagnostic.location ? `${text} (${diagnostic.location})` : text));
            }
            if (notes.length > MAX_LISTED_DIAGNOSTICS) {
                diagnostics.append(el('li', undefined, t('epub.moreDiagnostics', { count: notes.length - MAX_LISTED_DIAGNOSTICS })));
            }
            this.infoPanel.append(diagnostics);
        }
    }

    private async loadCover(): Promise<void> {
        const cover = this.infoPanel.querySelector<HTMLImageElement>('.omni-epub__cover');
        if (!cover || !this.book.coverPath || typeof URL.createObjectURL !== 'function') return;
        try {
            const bytes = await this.archive.read(this.book.coverPath, this.maxResourceBytes, this.lifetime.signal);
            if (this.disposed) return;
            const blob = this.imageBlob(this.book.coverPath, bytes);
            if (!blob) return;
            this.coverUrl = URL.createObjectURL(blob);
            cover.src = this.coverUrl;
            cover.hidden = false;
        } catch {
            // The cover is decoration; an unreadable one is simply not shown.
        }
    }

    // ── State application ──

    private togglePanel(panel: Exclude<EpubPanel, 'none'>): void {
        if (this.controller.dispatch({ type: 'toggle-panel', panel })) this.applyPanel();
    }

    private applyPanel(): void {
        const panel = this.controller.state.panel;
        this.side.hidden = panel === 'none';
        this.tocPanel.hidden = panel !== 'toc';
        this.infoPanel.hidden = panel !== 'info';
        this.tocButton.setAttribute('aria-pressed', String(panel === 'toc'));
        this.infoButton.setAttribute('aria-pressed', String(panel === 'info'));
    }

    private applyScale(): void {
        const scale = this.controller.state.fontScale;
        this.page.style.setProperty('--epub-scale', String(scale / 100));
        this.scaleLabel.textContent = `${scale}%`;
        // The accessible name carries the visible value (WCAG 2.5.3) and the action.
        const name = this.t('epub.textScale', { scale });
        this.scaleLabel.setAttribute('aria-label', name);
        this.scaleLabel.title = name;
        // Announce changes only, not the initial size at mount.
        if (this.appliedScale !== undefined && this.appliedScale !== scale) this.scaleStatus.textContent = name;
        this.appliedScale = scale;
    }

    private applyNavigation(): void {
        const { index } = this.controller.state;
        const hasPrevious = this.controller.neighbor(-1) >= 0;
        const hasNext = this.controller.neighbor(1) >= 0;
        // A button disabled while focused drops focus to <body>; hand it to the reading pane.
        const losing = [
            ...(!hasPrevious ? [this.previousButton, this.pagerPrevious] : []),
            ...(!hasNext ? [this.nextButton, this.pagerNext] : [])
        ];
        if (losing.some(button => this.focusWithin(button))) this.viewport.focus({ preventScroll: true });
        this.previousButton.disabled = !hasPrevious;
        this.pagerPrevious.disabled = !hasPrevious;
        this.nextButton.disabled = !hasNext;
        this.pagerNext.disabled = !hasNext;
        this.chapterSelect.value = String(index);
        const progress = this.controller.progress();
        this.position.textContent = this.t('epub.position', { position: progress.position, total: progress.total });
    }

    private onKeyDown(event: KeyboardEvent): void {
        const target = event.target as HTMLElement | null;
        if (target && (target.localName === 'select' || target.localName === 'input' || target.isContentEditable)) return;
        const mod = event.ctrlKey || event.metaKey;
        if (mod && (event.key === '=' || event.key === '+')) {
            event.preventDefault();
            if (this.controller.dispatch({ type: 'font', delta: EPUB_FONT_SCALE_STEP })) this.applyScale();
            return;
        }
        if (mod && event.key === '-') {
            event.preventDefault();
            if (this.controller.dispatch({ type: 'font', delta: -EPUB_FONT_SCALE_STEP })) this.applyScale();
            return;
        }
        if (mod && event.key === '0') {
            event.preventDefault();
            if (this.controller.dispatch({ type: 'font-reset' })) this.applyScale();
            return;
        }
        if (mod || event.altKey || event.shiftKey) return;
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        // Arrow keys on a control belong to the control, not to page turning.
        // Only real controls own arrow keys. Book links and anchors do not —
        // a jump focuses its target, often a footnote's back-link, and page
        // turning must keep working from there.
        if (target?.closest('button, .omni-epub__side')) return;
        // A wide code block or table scrolls sideways with these keys; leave them to it.
        if (target && this.scrollsHorizontally(target)) return;
        // Right-to-left books turn pages the other way.
        const forward = this.book.direction === 'rtl' ? event.key === 'ArrowLeft' : event.key === 'ArrowRight';
        event.preventDefault();
        if (this.controller.dispatch({ type: forward ? 'next' : 'previous' })) void this.renderChapter();
    }

    // ── Chapter rendering ──

    /** Aborts when the chapter is left or the view is disposed. */
    private chapterSignal(): AbortSignal {
        const chapter = this.chapterAbort.signal;
        return typeof AbortSignal.any === 'function' ? AbortSignal.any([chapter, this.lifetime.signal]) : chapter;
    }

    private releaseChapter(): void {
        this.chapterAbort.abort();
        this.chapterAbort = new AbortController();
        for (const dispose of this.chapterDisposers.splice(0)) dispose();
    }

    private message(key: string, args?: Record<string, string | number>, error = true): HTMLElement {
        const node = el('div', `omni-epub__message${error ? ' is-error' : ''}`, this.t(key, args));
        node.setAttribute('role', error ? 'alert' : 'status');
        return node;
    }

    private async chapterText(item: EpubSpineItem): Promise<DecodedText> {
        const cached = this.chapterCache.get(item.index);
        if (cached !== undefined) return cached;
        const decoded = await this.archive.readText(item.path, this.maxChapterBytes, this.chapterSignal());
        this.chapterCache.set(item.index, decoded);
        if (this.chapterCache.size > CHAPTER_CACHE_SIZE) {
            const oldest = this.chapterCache.keys().next().value;
            if (oldest !== undefined) this.chapterCache.delete(oldest);
        }
        return decoded;
    }

    private async renderChapter(): Promise<void> {
        if (this.disposed) return;
        const { index, fragment } = this.controller.state;
        const item = this.book.spine[index];
        this.applyNavigation();
        if (!item) return;
        if (index === this.renderedIndex) {
            // Same document: only scroll. Bumping the version here would orphan
            // the chapter's still-pending image loads.
            this.reveal(fragment);
            this.highlightToc();
            return;
        }
        const version = ++this.renderVersion;

        // Swapping the page out from under a focused link would drop focus to
        // <body>, where the shell's keyboard handling no longer hears it.
        const focusWasInPage = this.focusWithin(this.page);
        this.releaseChapter();
        this.page.replaceChildren();
        this.fragments = new Map();
        this.page.removeAttribute('lang');
        this.page.removeAttribute('dir');
        this.page.setAttribute('aria-busy', 'true');
        this.renderedIndex = -1;

        let content: Node[];
        let blocked = 0;
        let unsupportedEncoding = '';
        let lang = '';
        let dir = '';
        if (item.encrypted) content = [this.message('epub.chapter.encrypted')];
        else if (item.kind === 'unsupported') content = [this.message('epub.chapter.unsupported', { mediaType: item.mediaType || '?' })];
        else if (!item.present) content = [this.message('epub.chapter.missing', { path: item.path })];
        else {
            try {
                const decoded = await this.chapterText(item);
                if (this.disposed || version !== this.renderVersion) return;
                unsupportedEncoding = decoded.unsupportedEncoding;
                const prepared = prepareChapter(decoded.text, item.kind, item.path, this.deps.createDOMPurify(window), document, this.maxChapterElements);
                // Adopted, not deep-cloned: the prepared nodes are never reused, and
                // cloning a wide MathML element is quadratic.
                content = [document.adoptNode(prepared.fragment)];
                if (prepared.tooLarge) content = [this.message('epub.read.too-large', { path: item.path })];
                // A recovered parse that yields nothing is a failure, not a blank page.
                if (!prepared.tooLarge && prepared.empty && (prepared.recovered || item.kind === 'html')) {
                    content = [this.message('epub.chapter.renderFailed', { path: item.path })];
                }
                blocked = prepared.blocked;
                lang = prepared.lang;
                dir = prepared.dir;
            } catch (error) {
                if (this.disposed || version !== this.renderVersion) return;
                if (error instanceof EpubReadError && error.code === 'aborted') {
                    this.page.removeAttribute('aria-busy');
                    return;
                }
                if (error instanceof EpubReadError) content = [this.message(`epub.read.${error.code}`, { path: item.path })];
                else {
                    this.ctx.logger.log('error', `epub: rendering ${item.path} failed: ${error instanceof Error ? error.message : String(error)}`);
                    content = [this.message('epub.chapter.renderFailed', { path: item.path })];
                }
            }
        }

        // Through a fragment: spreading a chapter's top-level nodes as call
        // arguments overflows the stack past ~100k nodes.
        const chapterNodes = document.createDocumentFragment();
        for (const node of content) chapterNodes.append(node);
        this.page.replaceChildren(chapterNodes);
        // A chapter without its own language inherits the package's.
        const pageLang = lang || this.book.metadata.languages[0] || '';
        if (pageLang) this.page.setAttribute('lang', pageLang);
        if (dir === 'rtl' || dir === 'ltr' || dir === 'auto') this.page.setAttribute('dir', dir);
        if (blocked > 0) this.page.append(el('p', 'omni-epub__note', this.t('epub.blocked', { count: blocked })));
        // A legacy encoding the core cannot decode was read as UTF-8; say why the text may be garbled.
        if (unsupportedEncoding) this.page.prepend(el('p', 'omni-epub__note', this.t('diag.epub.encoding', { encoding: unsupportedEncoding })));
        this.page.removeAttribute('aria-busy');
        this.renderedIndex = index;
        this.indexFragments();
        this.hardenLinks(item);
        this.loadImages(version);
        this.reveal(fragment, focusWasInPage);
        this.highlightToc();
    }

    /**
     * One id → element index per rendered chapter, so every fragment lookup (link
     * hardening, reveal, re-anchoring, contents scroll-spy) is O(1) instead of a
     * scan of every [id] — thousands of broken `#links` must not cost N × M.
     */
    private indexFragments(): void {
        this.fragments = new Map();
        // Keyed by the book's own id: the DOM ids are namespaced per render.
        for (const element of this.page.querySelectorAll<HTMLElement>(`[${ANCHOR_ATTRIBUTE}]`)) {
            const anchor = element.getAttribute(ANCHOR_ATTRIBUTE)!;
            if (!this.fragments.has(anchor)) this.fragments.set(anchor, element);
        }
    }

    /** First element whose id is `name`, raw then percent-decoded (renderers differ on encoding). */
    private fragmentTarget(name: string): HTMLElement | null {
        const direct = this.fragments.get(name);
        if (direct) return direct;
        try {
            const decoded = decodeURIComponent(name);
            return decoded === name ? null : this.fragments.get(decoded) ?? null;
        } catch {
            return null;
        }
    }

    private reveal(fragment: string, keepFocus = false): void {
        const target = fragment ? this.fragmentTarget(fragment) : null;
        this.anchor = target ? fragment : undefined;
        if (target) revealFragmentTarget(target, this.viewport);
        else {
            this.viewport.scrollTop = 0;
            if (keepFocus) this.viewport.focus({ preventScroll: true });
        }
    }

    /** True when `from` or an ancestor below the viewport can still scroll sideways. */
    private scrollsHorizontally(from: Element): boolean {
        for (let node: Element | null = from; node && node !== this.viewport && this.viewport.contains(node); node = node.parentElement) {
            if (node.scrollWidth <= node.clientWidth) continue;
            const overflow = getComputedStyle(node).overflowX;
            if (overflow === 'auto' || overflow === 'scroll') return true;
        }
        return false;
    }

    private focusWithin(element: HTMLElement): boolean {
        const root = element.getRootNode() as Document | ShadowRoot;
        const active = root.activeElement;
        return active !== null && element.contains(active);
    }

    private hardenLinks(item: EpubSpineItem): void {
        for (const anchor of [...this.page.querySelectorAll<HTMLElement>(`[${LINK_ATTRIBUTE}]`)]) {
            const href = anchor.getAttribute(LINK_ATTRIBUTE) ?? '';
            anchor.removeAttribute(LINK_ATTRIBUTE);
            const disable = (): void => anchor.setAttribute('aria-disabled', 'true');
            if (href.startsWith('#')) {
                // Same path as any other jump (goTo → reveal), so the target stays
                // anchored while images above it are still loading.
                const name = href.slice(1);
                if (!name || !this.fragmentTarget(name)) disable();
                else this.makeLink(anchor, () => this.goTo(this.controller.state.index, name), true);
                continue;
            }
            if (isExternalHref(href)) {
                let url: URL | undefined;
                try { url = new URL(href); } catch { url = undefined; }
                const navigation = this.ctx.navigation;
                if (!url || !navigation || !ALLOWED_LINK_SCHEMES.includes(url.protocol)) {
                    disable();
                    continue;
                }
                this.makeLink(anchor, () => void navigation.openExternalUrl(url.href));
                continue;
            }
            const resolved = resolveEpubHref(item.path, href);
            const found = resolved ? this.archive.find(resolved.path)?.name ?? resolved.path : '';
            const target = found ? this.spineByPath.get(found) : undefined;
            if (!resolved || !target) {
                disable();
                continue;
            }
            this.makeLink(anchor, () => this.goTo(target.index, resolved.fragment));
        }
    }

    private makeLink(anchor: HTMLElement, activate: () => void, space = false): void {
        anchor.setAttribute('role', 'link');
        anchor.tabIndex = 0;
        const onClick = (event: Event): void => {
            event.preventDefault();
            activate();
        };
        const onKey = (event: Event): void => {
            const { key } = event as KeyboardEvent;
            if (key === 'Enter' || (space && (key === ' ' || key === 'Spacebar'))) onClick(event);
        };
        this.on(anchor, 'click', onClick, this.chapterDisposers);
        this.on(anchor, 'keydown', onKey, this.chapterDisposers);
    }

    /**
     * Blob for a container image. The type comes from an image allow-list, not
     * straight from the book's manifest: a blob URL lives in the host's origin,
     * and "open image in new tab" would run a `text/html` one as a document.
     * SVG is sanitized for the same reason.
     */
    private imageBlob(path: string, bytes: Uint8Array): Blob | undefined {
        const declared = this.mediaTypes.get(path) ?? '';
        const type = IMAGE_BLOB_TYPES.has(declared) ? declared : guessImageType(path);
        if (!IMAGE_BLOB_TYPES.has(type)) return new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
        if (type !== 'image/svg+xml') return new Blob([new Uint8Array(bytes)], { type });
        // Refuse an over-dense SVG before parsing it (the parse is the cost).
        if (bytes.byteLength > MAX_SVG_IMAGE_BYTES) return undefined;
        const svgText = dropMarkupEntities(decodeMarkupText(bytes).text);
        if (countTagStarts(svgText, MAX_SVG_IMAGE_ELEMENTS) > MAX_SVG_IMAGE_ELEMENTS) return undefined;
        // Parse as XML (so DTD entities such as Illustrator's `&ns_svg;` expand),
        // sanitize the tree in place, and serialize as XML: DOMPurify's own HTML
        // serialization writes `&nbsp;`, which is not well-formed SVG.
        const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        const root = parsed.documentElement;
        if (!root || parsed.getElementsByTagName('parsererror').length > 0 || root.localName !== 'svg') {
            return undefined;
        }
        // Same reasoning as chapters: an over-dense SVG falls back to its alt text.
        if (parsed.getElementsByTagName('*').length > MAX_SVG_IMAGE_ELEMENTS || tooManyAttributes(parsed)) return undefined;
        const purifier = this.deps.createDOMPurify(window) as DomPurify & { sanitize(node: Node, options: Record<string, unknown>): unknown };
        try {
            purifier.sanitize(root, { ...SVG_IMAGE_SANITIZE_PROFILE, IN_PLACE: true });
        } catch {
            // DOMPurify refuses some roots in place (a prefixed `<svg:svg>`); show the alt text instead.
            return undefined;
        }
        stripSvgReferences(root);
        return new Blob([new XMLSerializer().serializeToString(root)], { type });
    }

    private loadImages(version: number): void {
        const signal = this.chapterSignal();
        const nodes = [...this.page.querySelectorAll<Element>(`img[${RESOURCE_ATTRIBUTE}], image[${RESOURCE_ATTRIBUTE}]`)];
        if (nodes.length === 0) return;
        const canBlob = typeof URL.createObjectURL === 'function';
        const urls = new Map<string, Promise<string | undefined>>();
        const urlFor = (path: string): Promise<string | undefined> => {
            let pending = urls.get(path);
            if (!pending) {
                // A queued read for a chapter already left is skipped, not started.
                pending = this.limitImageReads(() => (signal.aborted
                    ? Promise.reject(new EpubReadError('aborted', path))
                    : this.archive.read(path, this.maxResourceBytes, signal)).then(bytes => {
                    if (this.disposed || version !== this.renderVersion) return undefined;
                    const blob = this.imageBlob(path, bytes);
                    if (!blob) return undefined;
                    const url = URL.createObjectURL(blob);
                    this.chapterDisposers.push(() => URL.revokeObjectURL(url));
                    return url;
                }, () => undefined));
                urls.set(path, pending);
            }
            return pending;
        };
        for (const node of nodes) {
            const path = node.getAttribute(RESOURCE_ATTRIBUTE) ?? '';
            node.removeAttribute(RESOURCE_ATTRIBUTE);
            const resolvedPath = this.archive.find(path)?.name;
            const fallback = (): void => {
                const alt = node.getAttribute('alt');
                const hadFocus = (node.getRootNode() as Document | ShadowRoot).activeElement === node;
                if (node.localName === 'img') {
                    // An HTML image becomes a span (its alt text, or empty) that keeps
                    // its id, so links and the fragment index still point at a
                    // rendered, focusable element.
                    const standIn = document.createElement('span');
                    if (alt) standIn.textContent = `[${alt}]`;
                    const anchor = node.getAttribute(ANCHOR_ATTRIBUTE);
                    if (anchor !== null) {
                        standIn.id = node.id;
                        standIn.setAttribute(ANCHOR_ATTRIBUTE, anchor);
                        if (this.fragments.get(anchor) === node) this.fragments.set(anchor, standIn);
                    }
                    node.replaceWith(standIn);
                    // A jump may have focused the image already; keep focus on its stand-in.
                    if (hadFocus) {
                        standIn.tabIndex = -1;
                        standIn.focus({ preventScroll: true });
                    }
                    return;
                }
                // An SVG <image> cannot be swapped for HTML inside <svg>: hide it and
                // point its id at the enclosing <svg> (links to it were already
                // enabled), handing any focus to the reader.
                node.setAttribute('data-omni-epub-blocked', '');
                const svgRoot = (node as SVGElement).ownerSVGElement as unknown as HTMLElement | null;
                const anchor = node.getAttribute(ANCHOR_ATTRIBUTE);
                if (anchor !== null && this.fragments.get(anchor) === node) {
                    if (svgRoot) this.fragments.set(anchor, svgRoot);
                    else this.fragments.delete(anchor);
                }
                if (hadFocus) this.viewport.focus({ preventScroll: true });
            };
            if (!canBlob || !resolvedPath) {
                fallback();
                continue;
            }
            void urlFor(resolvedPath).then(url => {
                if (this.disposed || version !== this.renderVersion) return;
                if (!url) {
                    fallback();
                    return;
                }
                if (node.localName === 'img') node.setAttribute('src', url);
                else if (node.localName === 'image' && node.namespaceURI === 'http://www.w3.org/2000/svg') node.setAttribute('href', url);
            });
        }
    }

    // ── Contents highlighting ──

    /** Marks the contents entry for the passage on screen (scroll-spy within the chapter). */
    private highlightToc(): void {
        const { index } = this.controller.state;
        const candidates = this.tocLinks.filter(link => link.entry.spineIndex === index);
        let active: TocLink | undefined = candidates.find(link => !link.entry.fragment) ?? candidates[0];
        const sections = candidates.filter(link => link.entry.fragment);
        if (sections.length > 0 && this.renderedIndex === index) {
            const top = this.viewport.getBoundingClientRect().top + 24;
            for (const link of sections) {
                const target = this.fragmentTarget(link.entry.fragment);
                if (target && target.getBoundingClientRect().top <= top) active = link;
            }
        }
        for (const link of this.tocLinks) {
            const isActive = link === active;
            link.button.classList.toggle('is-active', isActive);
            if (isActive) link.button.setAttribute('aria-current', 'true');
            else link.button.removeAttribute('aria-current');
        }
    }
}
