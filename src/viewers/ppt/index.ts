import type { HostContext } from '../../host/index.js';
import { parsePptBinaryVscode } from '../../parsers/ppt-binary/index.js';
import {
    openPptxZip,
    parsePptxLegacy,
    parsePptxVscode,
    type PptxParserDeps
} from '../../parsers/pptx/index.js';
import type {
    Slide,
    SlideDeck,
    SlideElement
} from '../../parsers/slide-model.js';
import type {
    Diagnostic,
    ParseFailure,
    ParseOptions,
    ParseOutcome,
    ResourceLimits
} from '../../parsers/types.js';
import {
    mountPdfViewer,
    type PdfJsModule,
    type PdfViewerHandle
} from '../pdf/index.js';
import {
    MountAbortedError,
    VIEWER_ROOT_CLASS,
    type MountOptions,
    type ViewerInput
} from '../types.js';
import {
    createPptController,
    type PptController,
    type PptViewState
} from './controller.js';
import { getReadableTextColor, renderSlideElement } from './render.js';
import { pptViewerCss } from './styles.js';

export * from './controller.js';
export { pptViewerCss } from './styles.js';
export * from '../../parsers/slide-model.js';

export const PPT_VIEWER_META = {
    id: 'ppt',
    displayNameKey: 'ppt.title',
    extensions: ['pptx', 'ppt'],
    priority: 15,
    requiredServices: [] as const,
    optionalServices: [] as const,
    inputOwnership: 'borrows' as const
};

export interface PptViewerDeps extends Partial<PptxParserDeps> {
    convertToPdf?(input: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>;
    loadPdfjs?(): Promise<PdfJsModule>;
    parseLegacyPptx?(
        input: Uint8Array,
        options: ParseOptions
    ): Promise<ParseOutcome<SlideDeck>>;
}

export interface PptViewerHandle {
    readonly controller: PptController;
    readonly mode: 'slides' | 'pdf';
    dispose(): void;
}

export interface PptElementRenderContext {
    deck: SlideDeck;
    slide: Slide;
    zoom: number;
    fallbackTextColor: string;
    controller: PptController;
}

export interface PptToolbarAction {
    id: string;
    label?: string;
    labelKey?: string;
    title?: string;
    onActivate(context: { deck: SlideDeck; controller: PptController }): void;
}

export interface PptMountOptions extends MountOptions {
    limits?: ResourceLimits;
    diagnostics?: readonly Diagnostic[];
    renderElement?(
        element: SlideElement,
        context: PptElementRenderContext
    ): HTMLElement | undefined;
    renderChart?(
        element: SlideElement,
        context: PptElementRenderContext
    ): HTMLElement | undefined;
    toolbarActions?: readonly PptToolbarAction[];
    onSlideChange?(slideNumber: number): void;
    onDiagnostics?(diagnostics: readonly Diagnostic[]): void;
}

export type PptViewerFailureCode =
    | ParseFailure['code']
    | 'empty-presentation'
    | 'pdf-conversion-required'
    | 'pdf-conversion-failed';

export class PptViewerError extends Error {
    override readonly name = 'PptViewerError';

    constructor(
        readonly code: PptViewerFailureCode,
        message: string,
        readonly causeCode?: PptViewerFailureCode,
        options?: ErrorOptions
    ) {
        super(message, options);
    }
}

const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    text?: string
): HTMLElementTagNameMap[K] => {
    const value = document.createElement(tag);
    if (cls) value.className = cls;
    if (text !== undefined) value.textContent = text;
    return value;
};

const pdfName = (name: string): string => name.replace(/\.pptx?$/i, '.pdf');

async function mountPdfFallback(
    input: ViewerInput,
    container: HTMLElement,
    ctx: HostContext,
    deps: PptViewerDeps,
    options: PptMountOptions,
    causeCode: PptViewerFailureCode,
    originalMessageKey: string
): Promise<PptViewerHandle> {
    if (!deps.convertToPdf) {
        throw new PptViewerError(
            'pdf-conversion-required',
            ctx.i18n.t(originalMessageKey),
            causeCode
        );
    }
    if (!deps.loadPdfjs) {
        throw new PptViewerError(
            'missing-dependency',
            ctx.i18n.t('diag.ppt.pdf-missing-dependency'),
            causeCode
        );
    }

    let bytes: Uint8Array;
    try {
        bytes = await deps.convertToPdf(input.data, options.signal);
    } catch (error) {
        if (options.signal?.aborted) throw new MountAbortedError();
        throw new PptViewerError(
            'pdf-conversion-failed',
            ctx.i18n.t(originalMessageKey),
            causeCode,
            { cause: error }
        );
    }
    if (options.signal?.aborted) throw new MountAbortedError();

    const pdf: PdfViewerHandle = await mountPdfViewer(
        {
            fileName: pdfName(input.fileName),
            data: bytes,
            ...(input.lastModified === undefined
                ? {}
                : { lastModified: input.lastModified })
        },
        container,
        ctx,
        { loadPdfjs: deps.loadPdfjs },
        {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.styleIsolation ? { styleIsolation: options.styleIsolation } : {}),
            ...(options.limits ? { limits: options.limits } : {})
        }
    );
    return {
        controller: createPptController(0),
        mode: 'pdf',
        dispose: () => pdf.dispose()
    };
}

export function mountPptDocument(
    deck: SlideDeck,
    container: HTMLElement,
    ctx: HostContext,
    options: PptMountOptions = {}
): PptViewerHandle {
    if (options.signal?.aborted) throw new MountAbortedError();
    if (deck.totalSlides === 0 || deck.slides.length === 0) {
        throw new PptViewerError(
            'empty-presentation',
            ctx.i18n.t('diag.ppt.empty')
        );
    }
    options.onDiagnostics?.(options.diagnostics ?? []);

    const root: HTMLElement | ShadowRoot =
        options.styleIsolation !== 'scoped' &&
        typeof container.attachShadow === 'function'
            ? (container.shadowRoot ?? container.attachShadow({ mode: 'open' }))
            : container;
    if (root === container) {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--ppt');
    } else {
        root.replaceChildren();
        const style = el('style');
        style.textContent = pptViewerCss;
        root.append(style);
    }

    const frame = el('section', 'omni-ppt');
    const toolbar = el('div', 'omni-ppt__toolbar');
    const prev = el('button', undefined, '‹');
    const next = el('button', undefined, '›');
    const jump = el('select') as HTMLSelectElement;
    const count = el('span');
    const minus = el('button', undefined, '−');
    const plus = el('button', undefined, '+');
    const reset = el('button', undefined, '100%');
    const mode = el('button');
    prev.setAttribute('aria-label', ctx.i18n.t('ppt.previous'));
    next.setAttribute('aria-label', ctx.i18n.t('ppt.next'));
    jump.setAttribute('aria-label', ctx.i18n.t('ppt.jump'));

    deck.slides.forEach((slide) => {
        const option = el('option') as HTMLOptionElement;
        option.value = String(slide.slideNumber);
        const title = slide.elements
            .find((element) => element.isTitle)
            ?.paragraphs
            ?.map((paragraph) => paragraph.text)
            .join(' ');
        option.textContent = `Slide ${slide.slideNumber}${title ? `: ${title}` : ''}`;
        jump.append(option);
    });

    toolbar.append(prev, next, jump, count, minus, reset, plus, mode);
    const controller = createPptController(deck.totalSlides);
    for (const action of options.toolbarActions ?? []) {
        const button = el(
            'button',
            'omni-ppt__toolbar-action',
            action.label ?? (action.labelKey ? ctx.i18n.t(action.labelKey) : action.id)
        );
        button.dataset.actionId = action.id;
        if (action.title) button.title = action.title;
        button.onclick = () => action.onActivate({ deck, controller });
        toolbar.append(button);
    }

    const viewport = el('div', 'omni-ppt__viewport');
    const slides = el('div', 'omni-ppt__slides');
    viewport.append(slides);
    frame.append(toolbar, viewport);
    root.append(frame);

    const renderElement = (
        element: SlideElement,
        slide: Slide,
        state: PptViewState
    ): HTMLElement => {
        const fallbackTextColor = getReadableTextColor(slide.backgroundColor);
        const context: PptElementRenderContext = {
            deck,
            slide,
            zoom: state.zoom,
            fallbackTextColor,
            controller
        };
        const custom = element.type === 'chart'
            ? options.renderChart?.(element, context)
            : undefined;
        return custom
            ?? options.renderElement?.(element, context)
            ?? renderSlideElement(element, fallbackTextColor);
    };

    let lastSlide = controller.state.currentSlide;
    const render = (state: PptViewState = controller.state): void => {
        count.textContent = `${state.currentSlide} / ${state.slideCount}`;
        reset.textContent = `${Math.round(state.zoom * 100)}%`;
        mode.textContent = ctx.i18n.t(
            state.mode === 'continuous' ? 'ppt.mode.single' : 'ppt.mode.continuous'
        );
        jump.value = String(state.currentSlide);
        slides.replaceChildren();
        const shown = state.mode === 'single'
            ? deck.slides.filter((slide) => slide.slideNumber === state.currentSlide)
            : deck.slides;
        shown.forEach((slide) => {
            const article = el('article', 'omni-ppt__slide');
            article.setAttribute('aria-label', `Slide ${slide.slideNumber}`);
            Object.assign(article.style, {
                width: `${slide.widthPx}px`,
                height: `${slide.heightPx}px`,
                background: slide.backgroundColor,
                transform: `scale(${state.zoom})`,
                marginBottom: `${slide.heightPx * (state.zoom - 1)}px`
            });
            slide.elements
                .map((element) =>
                    element.type === 'image' &&
                    !!element.src &&
                    element.width >= slide.widthPx * 0.8 &&
                    element.height >= slide.heightPx * 0.8 &&
                    element.zIndex < 0
                        ? { ...element, zIndex: 0 }
                        : element
                )
                .sort((a, b) => a.zIndex - b.zIndex)
                .forEach((element) => article.append(renderElement(element, slide, state)));
            slides.append(article);
        });
        if (state.currentSlide !== lastSlide) {
            lastSlide = state.currentSlide;
            options.onSlideChange?.(state.currentSlide);
        }
    };

    const scrollCurrent = (): void => {
        if (controller.state.mode !== 'continuous') return;
        slides
            .querySelector<HTMLElement>(
                `[aria-label="Slide ${controller.state.currentSlide}"]`
            )
            ?.scrollIntoView({ block: 'start' });
    };
    const navigate = (
        action:
            | { type: 'previous' }
            | { type: 'next' }
            | { type: 'jump'; slide: number }
    ): void => {
        controller.dispatch(action);
        scrollCurrent();
    };
    const onKeydown = (event: KeyboardEvent): void => {
        if (!(event.ctrlKey || event.metaKey)) return;
        if (event.key === '=' || event.key === '+') {
            event.preventDefault();
            controller.dispatch({ type: 'zoom-in' });
        } else if (event.key === '-') {
            event.preventDefault();
            controller.dispatch({ type: 'zoom-out' });
        } else if (event.key === '0') {
            event.preventDefault();
            controller.dispatch({ type: 'reset-zoom' });
        }
    };

    const off = controller.subscribe(render);
    prev.onclick = () => navigate({ type: 'previous' });
    next.onclick = () => navigate({ type: 'next' });
    jump.onchange = () => navigate({ type: 'jump', slide: Number(jump.value) });
    minus.onclick = () => controller.dispatch({ type: 'zoom-out' });
    plus.onclick = () => controller.dispatch({ type: 'zoom-in' });
    reset.onclick = () => controller.dispatch({ type: 'reset-zoom' });
    mode.onclick = () => controller.dispatch({
        type: 'set-mode',
        mode: controller.state.mode === 'continuous' ? 'single' : 'continuous'
    });
    document.addEventListener('keydown', onKeydown);
    render();
    options.onSlideChange?.(controller.state.currentSlide);

    return {
        controller,
        mode: 'slides',
        dispose() {
            off();
            document.removeEventListener('keydown', onKeydown);
            frame.remove();
        }
    };
}

export async function mountPptViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: HostContext,
    deps: PptViewerDeps = {},
    options: PptMountOptions = {}
): Promise<PptViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const isPptx = input.fileName.toLowerCase().endsWith('.pptx');
    const outcome = isPptx
        ? await parsePptxVscode(input.data, options, {
            ...(deps.renderMetafile ? { renderMetafile: deps.renderMetafile } : {})
        })
        : await parsePptBinaryVscode(input.data, options);
    if (options.signal?.aborted) throw new MountAbortedError();

    if (outcome.result.status === 'failed') {
        options.onDiagnostics?.(outcome.result.diagnostics);
        if (
            outcome.result.failure.code !== 'invalid-format' &&
            outcome.result.failure.code !== 'corrupted'
        ) {
            throw new PptViewerError(
                outcome.result.failure.code,
                ctx.i18n.t(
                    outcome.result.failure.messageKey,
                    outcome.result.failure.args
                )
            );
        }
        return mountPdfFallback(
            input,
            container,
            ctx,
            deps,
            options,
            outcome.result.failure.code,
            outcome.result.failure.messageKey
        );
    }

    let deck: SlideDeck = outcome.result.document;
    let diagnostics: readonly Diagnostic[] = outcome.result.diagnostics;
    if (deck.totalSlides === 0 || deck.slides.length === 0) {
        options.onDiagnostics?.(diagnostics);
        return mountPdfFallback(
            input,
            container,
            ctx,
            deps,
            options,
            'empty-presentation',
            'diag.ppt.empty'
        );
    }
    if (!deck.slides.some((slide) => slide.elements.length > 0)) {
        if (isPptx) {
            const legacy = await (
                deps.parseLegacyPptx?.(input.data, options)
                ?? parsePptxLegacy(
                    input.data,
                    { openZip: deps.openZip ?? openPptxZip },
                    options
                )
            );
            diagnostics = [...diagnostics, ...legacy.result.diagnostics];
            if (
                legacy.result.status !== 'failed' &&
                legacy.result.document.slides.some((slide) => slide.elements.length > 0)
            ) {
                deck = legacy.result.document;
            } else {
                options.onDiagnostics?.(diagnostics);
                return mountPdfFallback(
                    input,
                    container,
                    ctx,
                    deps,
                    options,
                    'empty-presentation',
                    'diag.ppt.empty'
                );
            }
        } else {
            options.onDiagnostics?.(diagnostics);
            return mountPdfFallback(
                input,
                container,
                ctx,
                deps,
                options,
                'empty-presentation',
                'diag.ppt.empty'
            );
        }
    }

    return mountPptDocument(deck, container, ctx, {
        ...options,
        diagnostics
    });
}
