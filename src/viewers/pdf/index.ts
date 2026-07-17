// PDF viewer — DOM renderer over pdf.js (DESIGN.md §3-②, docs/viewers/pdf.md).
//
// Base entry rule (ADR 14): no external imports here. pdf.js and pdf-lib are
// injected through `PdfViewerDeps`; `viewers/pdf/self-loading` supplies the
// dynamic-import loaders for platforms whose bundler can resolve the optional
// peers. Without `loadPdfLib` the editing features render disabled with a
// reason (degraded mode, ADR 24) — reading always works.
//
// CSP rules: no eval, no inline handlers, no innerHTML. No window.prompt /
// alert / confirm — those are blocked inside the VS Code webview, so text
// annotations use an inline input overlay instead.

import type {
    FilePickService,
    FileSaveService,
    FileWritebackService,
    HostContext
} from '../../host/index.js';
import {
    MountAbortedError,
    VIEWER_ROOT_CLASS,
    type MountOptions,
    type ViewerHandle,
    type ViewerInput
} from '../types.js';
import {
    createPdfController,
    mergeHighlightRects,
    PDF_ZOOM_LEVELS,
    type PdfController,
    type PdfViewState
} from './controller.js';
import {
    buildEditedPdf,
    buildSavedPdf,
    mergePdfBytes,
    parseLayer,
    savedPdfName,
    SIDECAR_LAYER_NAME,
    SIDECAR_ORIGINAL_NAME,
    type ParsedLayer,
    type PdfLibModule
} from './editing.js';
import { pdfViewerCss } from './styles.js';

export { createPdfController, PDF_ZOOM_LEVELS } from './controller.js';
export type { PdfController, PdfAction, PdfViewState, PdfAnnotation } from './controller.js';
export { pdfViewerCss } from './styles.js';
export { buildEditedPdf, mergePdfBytes, savedPdfName } from './editing.js';
export type { PdfLibModule } from './editing.js';

/** Viewer metadata — single source for the registry codegen (DESIGN.md §7). */
export const PDF_VIEWER_META = {
    id: 'pdf',
    displayNameKey: 'pdf.title',
    extensions: ['pdf'],
    priority: 20,
    requiredServices: [] as const,
    optionalServices: ['save', 'writeback', 'filePick'] as const,
    inputOwnership: 'borrows' as const
};

export type PdfViewerContext = HostContext & {
    save?: FileSaveService;
    writeback?: FileWritebackService;
    filePick?: FilePickService;
};

// Minimal structural types for the injected pdf.js module — kept local so the
// base entry needs no pdfjs-dist types at its public surface.
/** Opaque pdf.js viewport — passed straight back to render()/TextLayer. */
export type PdfJsViewport = { width: number; height: number };
export interface PdfJsPage {
    getViewport(options: { scale: number }): PdfJsViewport;
    render(options: {
        canvasContext: CanvasRenderingContext2D;
        viewport: unknown;
    }): { promise: Promise<void>; cancel(): void };
    /** Text runs + geometry, fed as-is into TextLayer as textContentSource. */
    getTextContent(): Promise<unknown>;
}
/** pdf.js v4 TextLayer — positions transparent, selectable spans over canvas. */
export interface PdfJsTextLayer {
    render(): Promise<void>;
    cancel(): void;
}
export interface PdfJsDocument {
    numPages: number;
    getPage(n: number): Promise<PdfJsPage>;
    destroy(): Promise<void>;
    /** Embedded files keyed by name; used to read the hybrid sidecar. */
    getAttachments?(): Promise<Record<string, { filename: string; content: Uint8Array }> | null>;
}
export interface PdfJsLoadingTask {
    promise: Promise<PdfJsDocument>;
    destroy(): void;
}
export interface PdfJsModule {
    getDocument(options: { data: Uint8Array; password?: string }): PdfJsLoadingTask;
    GlobalWorkerOptions: { workerSrc: string };
    TextLayer: new (options: {
        textContentSource: unknown;
        container: HTMLElement;
        viewport: unknown;
    }) => PdfJsTextLayer;
}

/** External modules the viewer needs, injected by the adapter (ADR 14). */
export interface PdfViewerDeps {
    loadPdfjs(): Promise<PdfJsModule>;
    /** Editing dependency (save / save-as / merge / annotation stamping).
     *  Absent -> editing controls disabled with a reason. */
    loadPdfLib?(): Promise<PdfLibModule>;
}

export interface PdfViewerHandle extends ViewerHandle {
    readonly controller: PdfController;
    isDirty(): boolean;
}

const THUMB_FALLBACK_RENDER_COUNT = 10;

interface PageRecord {
    pageNumber: number;
    page: PdfJsPage;
    wrapper: HTMLElement;
    rendered: boolean;
    rendering: boolean;
    task: { cancel(): void } | undefined;
    textLayer: PdfJsTextLayer | undefined;
}

function isPasswordError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        (error as { name?: string }).name === 'PasswordException'
    );
}

export async function mountPdfViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: PdfViewerContext,
    deps: PdfViewerDeps,
    options: MountOptions = {}
): Promise<PdfViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const t = ctx.i18n.t.bind(ctx.i18n);

    // ------------------------------------------------------------- root/frame
    const isolation = options.styleIsolation ?? 'shadow';
    let root: HTMLElement | ShadowRoot;
    if (isolation === 'shadow' && typeof container.attachShadow === 'function') {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        root.replaceChildren();
        const style = document.createElement('style');
        style.textContent = pdfViewerCss;
        root.appendChild(style);
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--pdf');
        root = container;
    }

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

    const frame = el('div', 'omni-pdf');
    const header = el('div', 'omni-pdf__header');
    const title = el('div', 'omni-pdf__title', input.fileName);
    const toolbar = el('div', 'omni-pdf__toolbar');
    const pageInfo = el('span', 'omni-pdf__page-info');
    const pageInput = el('input', 'omni-pdf__page-input') as HTMLInputElement;
    pageInput.type = 'number';
    pageInput.min = '1';
    pageInput.step = '1';
    pageInput.value = '1';
    pageInput.setAttribute('aria-label', t('pdf.goToPage'));
    const pageTotal = el('span', 'omni-pdf__page-total', '/ 0');
    pageInfo.append(pageInput, pageTotal);
    header.append(title, toolbar);
    const zoomBar = el('div', 'omni-pdf__zoom');
    const body = el('div', 'omni-pdf__body');
    const thumbs = el('div', 'omni-pdf__thumbs');
    const pages = el('div', 'omni-pdf__pages');
    body.append(thumbs, pages);
    const status = el('div', 'omni-pdf__status', t('pdf.loading'));
    status.setAttribute('aria-live', 'polite');
    frame.append(header, zoomBar, body, status);
    root.appendChild(frame);

    // ------------------------------------------------------------- lifecycle
    let disposed = false;
    let doc: PdfJsDocument | undefined;
    let loadingTask: PdfJsLoadingTask | undefined;
    let pageObserver: IntersectionObserver | undefined;
    let thumbObserver: IntersectionObserver | undefined;
    let records: PageRecord[] = [];
    let renderEpoch = 0;
    let currentPage = 1;
    let tool: 'view' | 'text' | 'signature' = 'view';
    let highlightColor = '#ffeb3b';
    let underlineColor = '#000000';
    let strikeoutColor = '#000000';
    let markupKind: 'highlight' | 'underline' | 'strikeout' = 'highlight';
    let pageLayout: 'single' | 'spread-odd' | 'spread-even' = 'single';
    let matchThemeColors = false;
    let sourceBytes = input.data;
    /** A merge changed the document without going through the edit stack. */
    let mergedSinceSave = false;
    let pdfLib: PdfLibModule | undefined;
    let unsubscribe: (() => void) | undefined;
    let controller: PdfController = createPdfController(0);
    /** Layout inputs of the last rebuild — annotation-only changes skip it. */
    let layoutKey = '';

    const abortListener = () => {
        loadingTask?.destroy();
    };
    options.signal?.addEventListener('abort', abortListener, { once: true });

    function throwIfAborted(): void {
        if (options.signal?.aborted) {
            teardown();
            throw new MountAbortedError();
        }
    }

    function teardown(): void {
        disposed = true;
        document.removeEventListener('keydown', keyHandler);
        document.removeEventListener('selectionchange', syncMarkupAvailability);
        options.signal?.removeEventListener('abort', abortListener);
        unsubscribe?.();
        pageObserver?.disconnect();
        thumbObserver?.disconnect();
        for (const record of records) {
            record.task?.cancel();
            record.textLayer?.cancel();
        }
        records = [];
        void doc?.destroy();
        doc = undefined;
        root.replaceChildren();
        if (root === container) {
            container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--pdf');
        }
    }

    const keyHandler = (keyEvent: KeyboardEvent) => {
        const target = keyEvent.target;
        if (
            (keyEvent.key === 'Delete' || keyEvent.key === 'Backspace')
            && !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
        ) {
            const selectedId = controller.state.selectedAnnotationId;
            const selected = controller.state.annotations.find((annotation) => annotation.id === selectedId);
            if (selected) {
                keyEvent.preventDefault();
                controller.dispatch({ type: 'remove-annotation', id: selected.id });
                return;
            }
        }
        if ((!keyEvent.metaKey && !keyEvent.ctrlKey) || keyEvent.altKey || keyEvent.key.toLowerCase() !== 'z') return;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
        keyEvent.preventDefault();
        controller.dispatch({ type: keyEvent.shiftKey ? 'redo' : 'undo' });
    };
    document.addEventListener('keydown', keyHandler);

    // -------------------------------------------------------------- pdf.js
    const pdfjs = await deps.loadPdfjs();
    throwIfAborted();
    pdfjs.GlobalWorkerOptions.workerSrc = await ctx.assets.resolveAssetUrl(
        'assets/pdfjs/pdf.worker.min.mjs'
    );
    throwIfAborted();

    async function loadDocument(
        bytes: Uint8Array,
        password?: string
    ): Promise<PdfJsDocument> {
        const request: { data: Uint8Array; password?: string } = {
            // pdf.js transfers the buffer to its worker; keep ours intact.
            data: bytes.slice()
        };
        if (password !== undefined) request.password = password;
        loadingTask = pdfjs.getDocument(request);
        try {
            return await loadingTask.promise;
        } finally {
            loadingTask = undefined;
        }
    }

    /**
     * Read the hybrid sidecar (pristine source + layer JSON) from a document's
     * attachments. Returns null unless BOTH parts are present and the layer
     * parses — a lone layer over already-flattened pages would double up.
     */
    async function readSidecar(
        d: PdfJsDocument
    ): Promise<{ pristine: Uint8Array; layer: ParsedLayer } | null> {
        try {
            const attachments = await d.getAttachments?.();
            if (!attachments) return null;
            let pristine: Uint8Array | undefined;
            let layerText: string | undefined;
            for (const entry of Object.values(attachments)) {
                if (entry.filename === SIDECAR_ORIGINAL_NAME) pristine = entry.content;
                else if (entry.filename === SIDECAR_LAYER_NAME) {
                    layerText = new TextDecoder().decode(entry.content);
                }
            }
            if (!pristine || layerText === undefined) return null;
            const layer = parseLayer(layerText);
            return layer ? { pristine, layer } : null;
        } catch {
            return null;
        }
    }

    // ------------------------------------------------------- password prompt
    function askPassword(retry: boolean): Promise<string | null> {
        return new Promise((resolve) => {
            const overlay = el('div', 'omni-pdf__modal is-open');
            const panel = el('div', 'omni-pdf__panel');
            panel.appendChild(el('div', undefined, t('pdf.passwordRequired')));
            if (retry) {
                panel.appendChild(
                    el('div', 'omni-pdf__error', t('pdf.passwordIncorrect'))
                );
            }
            const inputEl = el('input');
            inputEl.type = 'password';
            inputEl.setAttribute('aria-label', t('pdf.password'));
            const actions = el('div', 'omni-pdf__panel-actions');
            const cancel = el('button', undefined, t('pdf.cancel'));
            cancel.type = 'button';
            const submit = el('button', undefined, t('pdf.passwordSubmit'));
            submit.type = 'button';
            actions.append(cancel, submit);
            panel.append(inputEl, actions);
            overlay.appendChild(panel);
            frame.appendChild(overlay);

            const finish = (value: string | null) => {
                overlay.remove();
                resolve(value);
            };
            submit.addEventListener('click', () => finish(inputEl.value));
            cancel.addEventListener('click', () => finish(null));
            inputEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') finish(inputEl.value);
                if (e.key === 'Escape') finish(null);
            });
            inputEl.focus();
        });
    }

    // --------------------------------------------------------------- toolbar
    const editingAvailable = typeof deps.loadPdfLib === 'function';

    function toolButton(
        labelKey: string,
        onClick: () => void,
        parent: HTMLElement = toolbar
    ): HTMLButtonElement {
        const b = el('button', 'omni-pdf__tool', t(labelKey));
        b.type = 'button';
        b.addEventListener('click', onClick);
        parent.appendChild(b);
        return b;
    }

    /** Degraded mode (ADR 24): disabled with a reason, never hidden. */
    function degrade(button: HTMLButtonElement, reasonKey: string): void {
        button.disabled = true;
        button.title = t(reasonKey);
    }

    toolbar.appendChild(pageInfo);
    const textBtn = toolButton('pdf.annotationText', () => {
        tool = tool === 'text' ? 'view' : 'text';
        syncToolButtons();
        status.textContent = tool === 'text' ? t('pdf.textPlace') : '';
    });
    const signatureBtn = toolButton('pdf.signature', () => {
        tool = tool === 'signature' ? 'view' : 'signature';
        syncToolButtons();
        status.textContent = tool === 'signature' ? t('pdf.signaturePlace') : '';
    });
    const markupWrap = el('div', 'omni-pdf__markup-wrap');
    toolbar.appendChild(markupWrap);
    const highlightBtn = toolButton('✎', () => {
        if (captureMarkup(markupKind)) status.textContent = '';
    }, markupWrap);
    // Avoid moving focus to the toolbar before its click handler reads the
    // browser selection (some hosts otherwise clear it on mousedown).
    highlightBtn.addEventListener('mousedown', (event) => event.preventDefault());
    const markupMenuBtn = el('button', 'omni-pdf__markup-menu-btn', '⌄');
    markupMenuBtn.type = 'button';
    markupMenuBtn.setAttribute('aria-label', t('pdf.markupOptions'));
    markupMenuBtn.setAttribute('aria-expanded', 'false');
    const markupMenu = el('div', 'omni-pdf__markup-menu');
    markupMenu.setAttribute('role', 'menu');
    const colorInput = (labelKey: string, initial: string, onChange: (value: string) => void) => {
        const input = el('input', 'omni-pdf__highlight-color') as HTMLInputElement;
        input.type = 'color';
        input.value = initial;
        input.setAttribute('aria-label', t(labelKey));
        input.title = t(labelKey);
        input.addEventListener('input', () => onChange(input.value));
        return input;
    };
    const highlightColorInput = colorInput('pdf.highlightColor', highlightColor, (value) => {
        highlightColor = value;
    });
    const underlineColorInput = colorInput('pdf.underlineColor', underlineColor, (value) => {
        underlineColor = value;
    });
    const strikeoutColorInput = colorInput('pdf.strikeoutColor', strikeoutColor, (value) => {
        strikeoutColor = value;
    });
    const markupChoice = (
        kind: typeof markupKind,
        labelKey: string,
        input: HTMLInputElement
    ): HTMLButtonElement => {
        const row = el('div', 'omni-pdf__markup-choice');
        const button = el('button', undefined, t(labelKey));
        button.type = 'button';
        button.setAttribute('role', 'menuitemradio');
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', () => {
            markupKind = kind;
            syncMarkupKind();
            markupMenu.classList.remove('is-open');
            markupMenuBtn.setAttribute('aria-expanded', 'false');
        });
        row.append(button, input);
        markupMenu.appendChild(row);
        return button;
    };
    const highlightChoiceBtn = markupChoice('highlight', 'pdf.highlight', highlightColorInput);
    const underlineBtn = markupChoice('underline', 'pdf.underline', underlineColorInput);
    const strikeoutBtn = markupChoice('strikeout', 'pdf.strikeout', strikeoutColorInput);
    function syncMarkupKind(): void {
        const current = markupKind === 'highlight' ? '✎' : markupKind === 'underline' ? 'U̲' : 'S̶';
        const labelKey = markupKind === 'highlight'
            ? 'pdf.highlight'
            : markupKind === 'underline' ? 'pdf.underline' : 'pdf.strikeout';
        highlightBtn.textContent = current;
        highlightBtn.setAttribute('aria-label', t(labelKey));
        highlightBtn.title = t(labelKey);
        for (const [kind, button] of [
            ['highlight', highlightChoiceBtn],
            ['underline', underlineBtn],
            ['strikeout', strikeoutBtn]
        ] as const) button.setAttribute('aria-checked', String(kind === markupKind));
    }
    syncMarkupKind();
    markupWrap.append(highlightBtn, markupMenuBtn, markupMenu);
    markupMenuBtn.addEventListener('click', () => {
        const isOpen = markupMenu.classList.toggle('is-open');
        markupMenuBtn.setAttribute('aria-expanded', String(isOpen));
    });
    const resetBtn = toolButton('pdf.resetPages', () =>
        controller.dispatch({ type: 'reset-pages' })
    );
    const saveBtn = toolButton('pdf.save', () => void save());
    const saveAsBtn = toolButton('pdf.saveAs', () => void saveAs());
    const mergeBtn = toolButton('pdf.merge', () => void merge());

    function syncToolButtons(): void {
        textBtn.setAttribute('aria-pressed', String(tool === 'text'));
        signatureBtn.setAttribute('aria-pressed', String(tool === 'signature'));
        // Placement tools need raw canvas clicks; view mode keeps text selectable.
        pages.classList.toggle(
            'omni-pdf__pages--placing',
            tool === 'text' || tool === 'signature'
        );
    }
    syncToolButtons();

    if (!editingAvailable) {
        for (const b of [textBtn, signatureBtn, highlightBtn, markupMenuBtn, highlightChoiceBtn, underlineBtn, strikeoutBtn, resetBtn, saveBtn, saveAsBtn, mergeBtn]) {
            degrade(b, 'pdf.editingUnavailable');
        }
        highlightColorInput.disabled = true;
        underlineColorInput.disabled = true;
        strikeoutColorInput.disabled = true;
    } else {
        if (!ctx.writeback) degrade(saveBtn, 'common.noWriteback');
        if (!ctx.save) degrade(saveAsBtn, 'common.noFileSave');
        if (!ctx.filePick) degrade(mergeBtn, 'pdf.noFilePick');
    }

    function syncMarkupAvailability(): void {
        if (!editingAvailable) return;
        const enabled = activeSelection() !== null;
        highlightBtn.disabled = !enabled;
        markupMenuBtn.disabled = !enabled;
        highlightChoiceBtn.disabled = !enabled;
        underlineBtn.disabled = !enabled;
        strikeoutBtn.disabled = !enabled;
        if (!enabled) {
            markupMenu.classList.remove('is-open');
            markupMenuBtn.setAttribute('aria-expanded', 'false');
        }
    }
    document.addEventListener('selectionchange', syncMarkupAvailability);
    pages.addEventListener('mouseup', () => requestAnimationFrame(syncMarkupAvailability));
    syncMarkupAvailability();

    const zoomOutBtn = el('button', 'omni-pdf__zoom-btn', '−');
    zoomOutBtn.type = 'button';
    zoomOutBtn.setAttribute('aria-label', t('pdf.zoomOut'));
    zoomOutBtn.addEventListener('click', () => controller.dispatch({ type: 'zoom-out' }));
    const zoomLevel = el('span', 'omni-pdf__zoom-level');
    zoomLevel.setAttribute('aria-live', 'polite');
    const zoomInBtn = el('button', 'omni-pdf__zoom-btn', '+');
    zoomInBtn.type = 'button';
    zoomInBtn.setAttribute('aria-label', t('pdf.zoomIn'));
    zoomInBtn.addEventListener('click', () => controller.dispatch({ type: 'zoom-in' }));
    const viewMenuWrap = el('div', 'omni-pdf__view-menu-wrap');
    const viewMenuBtn = el('button', 'omni-pdf__view-menu-btn', '⌄');
    viewMenuBtn.type = 'button';
    viewMenuBtn.setAttribute('aria-label', t('pdf.viewOptions'));
    viewMenuBtn.setAttribute('aria-expanded', 'false');
    const viewMenu = el('div', 'omni-pdf__view-menu');
    viewMenu.setAttribute('role', 'menu');
    const fitWidthBtn = el('button', undefined, t('pdf.fitWidth'));
    const fitHeightBtn = el('button', undefined, t('pdf.fitHeight'));
    const singlePageBtn = el('button', undefined, t('pdf.singlePage'));
    const spreadOddBtn = el('button', undefined, t('pdf.twoPagesOdd'));
    const spreadEvenBtn = el('button', undefined, t('pdf.twoPagesEven'));
    const themeBtn = el('button', undefined, t('pdf.matchTheme'));
    const separator = document.createElement('hr');
    const separator2 = document.createElement('hr');
    for (const button of [fitWidthBtn, fitHeightBtn, singlePageBtn, spreadOddBtn, spreadEvenBtn, themeBtn]) {
        button.type = 'button';
        button.setAttribute('role', 'menuitemcheckbox');
        button.setAttribute('aria-checked', 'false');
    }
    viewMenu.append(fitWidthBtn, fitHeightBtn, separator, singlePageBtn, spreadOddBtn, spreadEvenBtn, separator2, themeBtn);
    viewMenuWrap.append(viewMenuBtn, viewMenu);
    zoomBar.append(zoomOutBtn, zoomLevel, zoomInBtn, viewMenuWrap);

    const closeViewMenu = () => {
        viewMenu.classList.remove('is-open');
        viewMenuBtn.setAttribute('aria-expanded', 'false');
    };
    viewMenuBtn.addEventListener('click', () => {
        const isOpen = viewMenu.classList.toggle('is-open');
        viewMenuBtn.setAttribute('aria-expanded', String(isOpen));
    });
    viewMenu.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeViewMenu();
            viewMenuBtn.focus();
        }
    });

    function fitPage(axis: 'width' | 'height'): void {
        const current = records.find((record) => record.pageNumber === currentPage) ?? records[0];
        if (!current) return;
        const viewport = current.page.getViewport({ scale: 1 });
        const available = axis === 'width'
            ? pages.clientWidth - 40
            : pages.clientHeight - 40;
        const dimension = axis === 'width' ? viewport.width : viewport.height;
        if (available > 0 && dimension > 0) {
            controller.dispatch({ type: 'set-zoom', zoom: available * 100 / dimension });
        }
        closeViewMenu();
    }

    function setPageLayout(next: typeof pageLayout): void {
        pageLayout = next;
        singlePageBtn.setAttribute('aria-checked', String(next === 'single'));
        spreadOddBtn.setAttribute('aria-checked', String(next === 'spread-odd'));
        spreadEvenBtn.setAttribute('aria-checked', String(next === 'spread-even'));
        pages.classList.toggle('omni-pdf__pages--spread', next !== 'single');
        void rebuildLayout();
        closeViewMenu();
    }

    fitWidthBtn.addEventListener('click', () => fitPage('width'));
    fitHeightBtn.addEventListener('click', () => fitPage('height'));
    singlePageBtn.addEventListener('click', () => setPageLayout('single'));
    spreadOddBtn.addEventListener('click', () => setPageLayout('spread-odd'));
    spreadEvenBtn.addEventListener('click', () => setPageLayout('spread-even'));
    themeBtn.addEventListener('click', () => {
        matchThemeColors = !matchThemeColors;
        pages.classList.toggle('omni-pdf__pages--theme', matchThemeColors);
        themeBtn.setAttribute('aria-checked', String(matchThemeColors));
        closeViewMenu();
    });
    setPageLayout('single');

    // ------------------------------------------------------ signature modal
    const signatureModal = el('div', 'omni-pdf__modal');
    const signaturePanel = el('div', 'omni-pdf__panel');
    const signatureLabel = el('label', 'omni-pdf__field', t('pdf.signatureColor'));
    const signatureColorInput = el('input') as HTMLInputElement;
    signatureColorInput.type = 'color';
    signatureColorInput.value = '#000000';
    signatureColorInput.setAttribute('aria-label', t('pdf.signatureColor'));
    signatureLabel.appendChild(signatureColorInput);
    const signatureCanvas = el('canvas');
    signatureCanvas.width = 480;
    signatureCanvas.height = 180;
    signatureCanvas.className = 'omni-pdf__signature-pad';
    const signatureActions = el('div', 'omni-pdf__panel-actions');
    const clearSignatureBtn = el('button', undefined, t('pdf.signatureClear'));
    clearSignatureBtn.type = 'button';
    const cancelSignatureBtn = el('button', undefined, t('pdf.cancel'));
    cancelSignatureBtn.type = 'button';
    const useSignatureBtn = el('button', undefined, t('pdf.signatureUse'));
    useSignatureBtn.type = 'button';
    signatureActions.append(clearSignatureBtn, cancelSignatureBtn, useSignatureBtn);
    signaturePanel.append(signatureLabel, signatureCanvas, signatureActions);
    signatureModal.appendChild(signaturePanel);
    frame.appendChild(signatureModal);

    const signatureContext = signatureCanvas.getContext('2d');
    let signing = false;
    let pendingSignaturePosition: { page: number; x: number; y: number } | undefined;

    const clearPad = () => {
        signatureContext?.clearRect(0, 0, signatureCanvas.width, signatureCanvas.height);
    };
    const padPoint = (event: PointerEvent) => {
        const box = signatureCanvas.getBoundingClientRect();
        return {
            x: ((event.clientX - box.left) * signatureCanvas.width) / (box.width || 1),
            y: ((event.clientY - box.top) * signatureCanvas.height) / (box.height || 1)
        };
    };
    signatureCanvas.addEventListener('pointerdown', (event) => {
        if (!signatureContext) return;
        signing = true;
        signatureCanvas.setPointerCapture?.(event.pointerId);
        const p = padPoint(event);
        signatureContext.beginPath();
        signatureContext.moveTo(p.x, p.y);
    });
    signatureCanvas.addEventListener('pointermove', (event) => {
        if (!signing || !signatureContext) return;
        const p = padPoint(event);
        signatureContext.lineTo(p.x, p.y);
        signatureContext.strokeStyle = signatureColorInput.value;
        signatureContext.lineWidth = 2.5;
        signatureContext.lineCap = 'round';
        signatureContext.stroke();
    });
    signatureCanvas.addEventListener('pointerup', () => {
        signing = false;
    });
    clearSignatureBtn.addEventListener('click', clearPad);
    cancelSignatureBtn.addEventListener('click', () => {
        signatureModal.classList.remove('is-open');
        tool = 'view';
        syncToolButtons();
    });
    useSignatureBtn.addEventListener('click', () => {
        const image = trimmedSignature();
        const position = pendingSignaturePosition;
        if (!image || !position) return;
        pendingSignaturePosition = undefined;
        signatureModal.classList.remove('is-open');
        tool = 'view';
        syncToolButtons();
        controller.dispatch({
            type: 'add-annotation',
            annotation: {
                kind: 'signature',
                page: position.page,
                x: position.x,
                y: position.y,
                width: 120,
                height: 60,
                dataUrl: image
            }
        });
    });

    function trimmedSignature(): string | undefined {
        const pixels = signatureContext?.getImageData(
            0,
            0,
            signatureCanvas.width,
            signatureCanvas.height
        );
        if (!pixels) return undefined;
        let minX = signatureCanvas.width;
        let minY = signatureCanvas.height;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < signatureCanvas.height; y++) {
            for (let x = 0; x < signatureCanvas.width; x++) {
                if ((pixels.data[(y * signatureCanvas.width + x) * 4 + 3] ?? 0) > 0) {
                    minX = Math.min(minX, x);
                    minY = Math.min(minY, y);
                    maxX = Math.max(maxX, x);
                    maxY = Math.max(maxY, y);
                }
            }
        }
        if (maxX < minX) return undefined;
        const pad = 8;
        const crop = document.createElement('canvas');
        crop.width = maxX - minX + 1 + pad * 2;
        crop.height = maxY - minY + 1 + pad * 2;
        crop.getContext('2d')?.drawImage(
            signatureCanvas,
            minX,
            minY,
            maxX - minX + 1,
            maxY - minY + 1,
            pad,
            pad,
            maxX - minX + 1,
            maxY - minY + 1
        );
        return crop.toDataURL('image/png');
    }

    /** Rasterize user-added text for portable PDF flattening. The sidecar
     * keeps the original string, size and color, so Omni can still edit it. */
    function rasterizeText(text: string, size: number, color: string): {
        rasterDataUrl: string;
        rasterWidth: number;
        rasterHeight: number;
    } {
        const padding = 2;
        const scale = Math.max(2, globalThis.devicePixelRatio || 1);
        const measure = document.createElement('canvas').getContext('2d');
        if (!measure) {
            return { rasterDataUrl: '', rasterWidth: 0, rasterHeight: 0 };
        }
        measure.font = `${size}px sans-serif`;
        const width = Math.ceil(measure.measureText(text).width + padding * 2);
        const height = Math.ceil(size * 1.3 + padding * 2);
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(width * scale);
        canvas.height = Math.ceil(height * scale);
        const context = canvas.getContext('2d');
        if (!context) return { rasterDataUrl: '', rasterWidth: 0, rasterHeight: 0 };
        context.scale(scale, scale);
        context.font = `${size}px sans-serif`;
        context.textBaseline = 'top';
        context.fillStyle = color;
        context.fillText(text, padding, padding);
        return { rasterDataUrl: canvas.toDataURL('image/png'), rasterWidth: width, rasterHeight: height };
    }

    // -------------------------------------------------------- text overlay
    /** Inline text-annotation controls (window.prompt is blocked in webviews). */
    function openTextInput(wrapper: HTMLElement, pageNumber: number, x: number, y: number): void {
        const scale = controller.state.zoom / 100;
        const editor = el('div', 'omni-pdf__text-editor');
        const inputEl = el('input', 'omni-pdf__text-input');
        inputEl.type = 'text';
        inputEl.placeholder = t('pdf.annotationText');
        inputEl.setAttribute('aria-label', t('pdf.annotationText'));
        const sizeInput = el('input') as HTMLInputElement;
        sizeInput.type = 'number';
        sizeInput.min = '8';
        sizeInput.max = '96';
        sizeInput.step = '1';
        sizeInput.value = '16';
        sizeInput.className = 'omni-pdf__text-size-input';
        sizeInput.setAttribute('aria-label', t('pdf.annotationSize'));
        const colorInput = el('input') as HTMLInputElement;
        colorInput.type = 'color';
        colorInput.value = '#000000';
        colorInput.className = 'omni-pdf__color-input';
        colorInput.setAttribute('aria-label', t('pdf.annotationColor'));
        editor.style.left = `${x * scale}px`;
        editor.style.top = `${y * scale}px`;
        editor.append(inputEl, sizeInput, colorInput);
        let done = false;
        const finish = (commit: boolean) => {
            if (done) return;
            done = true;
            const text = inputEl.value.trim();
            editor.remove();
            tool = 'view';
            syncToolButtons();
            if (commit && text) {
                const size = Math.min(96, Math.max(8, Number(sizeInput.value) || 16));
                const raster = rasterizeText(text, size, colorInput.value);
                controller.dispatch({
                    type: 'add-annotation',
                    annotation: { kind: 'text', page: pageNumber, x, y, text, size, color: colorInput.value, ...raster }
                });
            }
        };
        inputEl.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(true);
            if (e.key === 'Escape') finish(false);
        });
        inputEl.addEventListener('blur', (event) => {
            const next = event.relatedTarget;
            if (next instanceof Node && editor.contains(next)) return;
            finish(true);
        });
        wrapper.appendChild(editor);
        inputEl.focus();
    }

    // ------------------------------------------------------- highlight tool
    /** In shadow isolation the text lives in the shadow root, so prefer its
     *  selection API (Chromium) and fall back to the document selection.
     *  Chromium may return an empty Selection object for one of these APIs,
     *  so do not let that mask the other API's real range. */
    function activeSelection(): Selection | null {
        const shadow = root as ShadowRoot & { getSelection?: () => Selection | null };
        const shadowSelection = shadow.getSelection?.();
        const documentSelection = document.getSelection();
        return [shadowSelection, documentSelection].find(
            (selection): selection is Selection =>
                !!selection && !selection.isCollapsed && selection.rangeCount > 0
        ) ?? null;
    }

    /** Turn the current selection into a portable text markup annotation. */
    function captureMarkup(kind: 'highlight' | 'underline' | 'strikeout'): boolean {
        const color = kind === 'highlight'
            ? highlightColor
            : kind === 'underline' ? underlineColor : strikeoutColor;
        const selection = activeSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            ctx.logger.log('info', '[pdf highlight] no active text selection');
            return false;
        }
        ctx.logger.log(
            'info',
            `[pdf ${kind}] selection ranges=${selection.rangeCount} textLength=${selection.toString().length}`
        );
        const scale = controller.state.zoom / 100;
        const byPage = new Map<number, { x: number; y: number; width: number; height: number }[]>();
        for (let i = 0; i < selection.rangeCount; i++) {
            for (const rect of Array.from(selection.getRangeAt(i).getClientRects())) {
                if (rect.width < 1 || rect.height < 1) continue;
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const record = records.find((r) => {
                    const b = r.wrapper.getBoundingClientRect();
                    return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom;
                });
                if (!record) continue;
                const b = record.wrapper.getBoundingClientRect();
                const list = byPage.get(record.pageNumber) ?? [];
                list.push({
                    x: (rect.left - b.left) / scale,
                    y: (rect.top - b.top) / scale,
                    width: rect.width / scale,
                    height: rect.height / scale
                });
                byPage.set(record.pageNumber, list);
            }
        }
        if (byPage.size === 0) {
            ctx.logger.log('info', '[pdf highlight] selection has no PDF page rectangles');
            return false;
        }
        for (const [page, rects] of byPage) {
            controller.dispatch({
                type: 'add-annotation',
                annotation: { kind, page, rects: mergeHighlightRects(rects), color }
            });
        }
        selection.removeAllRanges();
        ctx.logger.log('info', `[pdf ${kind}] added pages=${byPage.size}`);
        return true;
    }

    function captureHighlight(): boolean {
        return captureMarkup('highlight');
    }

    // ------------------------------------------------------- annotations UI
    function renderOverlays(record: PageRecord): void {
        for (const node of record.wrapper.querySelectorAll('.omni-pdf__annotation')) {
            node.remove();
        }
        const scale = controller.state.zoom / 100;
        for (const annotation of controller.state.annotations) {
            if (annotation.page !== record.pageNumber) continue;
            if (annotation.kind === 'highlight' || annotation.kind === 'underline' || annotation.kind === 'strikeout') {
                const rects = mergeHighlightRects(annotation.rects);
                const deleteRect = rects.reduce((best, rect) =>
                    rect.y < best.y || (rect.y === best.y && rect.x + rect.width > best.x + best.width)
                        ? rect
                        : best
                );
                const setGroupHover = (hovered: boolean): void => {
                    for (const node of record.wrapper.querySelectorAll<HTMLElement>('.omni-pdf__markup')) {
                        if (node.dataset.annotationId === annotation.id) {
                            node.classList.toggle('is-hovered', hovered);
                        }
                    }
                };
                for (const rect of rects) {
                    const box = el(
                        'div',
                        `omni-pdf__annotation omni-pdf__markup omni-pdf__${annotation.kind}`
                    );
                    box.dataset.annotationId = annotation.id;
                    box.tabIndex = 0;
                    box.setAttribute('role', 'button');
                    box.setAttribute('aria-label', t(
                        annotation.kind === 'highlight'
                            ? 'pdf.highlight'
                            : annotation.kind === 'underline' ? 'pdf.underline' : 'pdf.strikeout'
                    ));
                    if (controller.state.selectedAnnotationId === annotation.id) {
                        box.classList.add('is-selected');
                    }
                    box.style.left = `${rect.x * scale}px`;
                    box.style.top = `${rect.y * scale}px`;
                    box.style.width = `${rect.width * scale}px`;
                    box.style.height = `${rect.height * scale}px`;
                    box.style.setProperty('--omni-hl-color', annotation.color);
                    box.title = t(
                        annotation.kind === 'highlight'
                            ? 'pdf.highlight'
                            : annotation.kind === 'underline' ? 'pdf.underline' : 'pdf.strikeout'
                    );
                    box.addEventListener('click', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        controller.dispatch({ type: 'select-annotation', id: annotation.id });
                    });
                    box.addEventListener('pointerenter', () => setGroupHover(true));
                    box.addEventListener('pointerleave', (event) => {
                        const next = event.relatedTarget;
                        const nextHighlight = next instanceof Element
                            ? next.closest<HTMLElement>('.omni-pdf__markup')
                            : null;
                        if (nextHighlight?.dataset.annotationId !== annotation.id) {
                            setGroupHover(false);
                        }
                    });
                    if (rect === deleteRect) {
                        const deleteButton = el('button', 'omni-pdf__annotation-delete', '×');
                        deleteButton.type = 'button';
                        deleteButton.setAttribute('aria-label', t('pdf.deleteAnnotation'));
                        deleteButton.addEventListener('pointerdown', (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                        });
                        deleteButton.addEventListener('click', (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            controller.dispatch({ type: 'remove-annotation', id: annotation.id });
                        });
                        box.appendChild(deleteButton);
                    }
                    record.wrapper.appendChild(box);
                }
                continue;
            }
            const overlay = el('div', 'omni-pdf__annotation');
            overlay.tabIndex = 0;
            overlay.setAttribute('role', 'button');
            overlay.setAttribute('aria-label', annotation.kind === 'text' ? annotation.text : t('pdf.signature'));
            if (controller.state.selectedAnnotationId === annotation.id) {
                overlay.classList.add('is-selected');
            }
            overlay.style.left = `${annotation.x * scale}px`;
            overlay.style.top = `${annotation.y * scale}px`;
            if (annotation.kind === 'text') {
                overlay.textContent = annotation.text;
                overlay.style.fontSize = `${annotation.size * scale}px`;
                overlay.style.color = annotation.color;
            } else {
                const image = el('img');
                image.src = annotation.dataUrl;
                image.alt = t('pdf.signature');
                image.style.width = `${annotation.width * scale}px`;
                image.style.height = `${annotation.height * scale}px`;
                overlay.appendChild(image);
            }
            let dragStart: { x: number; y: number; clientX: number; clientY: number } | undefined;
            overlay.addEventListener('pointerdown', (event) => {
                if ((event.target as HTMLElement).closest('.omni-pdf__annotation-delete')) return;
                event.preventDefault();
                event.stopPropagation();
                dragStart = {
                    x: annotation.x,
                    y: annotation.y,
                    clientX: event.clientX,
                    clientY: event.clientY
                };
                overlay.classList.add('is-selected');
                overlay.setPointerCapture?.(event.pointerId);
            });
            overlay.addEventListener('pointermove', (event) => {
                if (!dragStart) return;
                const x = dragStart.x + (event.clientX - dragStart.clientX) / scale;
                const y = dragStart.y + (event.clientY - dragStart.clientY) / scale;
                overlay.style.left = `${x * scale}px`;
                overlay.style.top = `${y * scale}px`;
            });
            overlay.addEventListener('pointerup', (event) => {
                if (!dragStart) return;
                const x = dragStart.x + (event.clientX - dragStart.clientX) / scale;
                const y = dragStart.y + (event.clientY - dragStart.clientY) / scale;
                dragStart = undefined;
                overlay.focus({ preventScroll: true });
                controller.dispatch({ type: 'move-annotation', id: annotation.id, x, y });
                controller.dispatch({ type: 'select-annotation', id: annotation.id });
            });
            const deleteButton = el('button', 'omni-pdf__annotation-delete', '×');
            deleteButton.type = 'button';
            deleteButton.setAttribute('aria-label', t('pdf.deleteAnnotation'));
            deleteButton.addEventListener('pointerdown', (event) => {
                event.preventDefault();
                event.stopPropagation();
            });
            deleteButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                controller.dispatch({ type: 'remove-annotation', id: annotation.id });
            });
            overlay.appendChild(deleteButton);
            record.wrapper.appendChild(overlay);
        }
    }

    // -------------------------------------------------------------- render
    async function renderPage(record: PageRecord, epoch: number): Promise<void> {
        if (disposed || epoch !== renderEpoch || record.rendered || record.rendering) return;
        record.rendering = true;
        const viewport = record.page.getViewport({ scale: controller.state.zoom / 100 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.setAttribute('role', 'img');
        canvas.setAttribute(
            'aria-label',
            t('common.page', { page: record.pageNumber, pages: controller.state.pageOrder.length })
        );
        const canvasContext = canvas.getContext('2d');
        if (!canvasContext) {
            record.rendering = false;
            return;
        }
        record.wrapper.replaceChildren(canvas);
        const task = record.page.render({ canvasContext, viewport });
        record.task = task;
        try {
            await task.promise;
            if (!disposed && epoch === renderEpoch) {
                record.rendered = true;
                await renderTextLayer(record, viewport, epoch);
                renderOverlays(record);
            }
        } catch {
            // Cancellation during zoom / reload is expected.
        } finally {
            record.rendering = false;
            record.task = undefined;
        }
    }

    /** Overlay pdf.js's selectable text layer on the rendered canvas so users
     *  can select/copy text and (later) highlight it. */
    async function renderTextLayer(
        record: PageRecord,
        viewport: PdfJsViewport,
        epoch: number
    ): Promise<void> {
        try {
            const textContentSource = await record.page.getTextContent();
            if (disposed || epoch !== renderEpoch) return;
            // Keep pdf.js's conventional class as well as our scoped class:
            // integrations may provide the upstream text-layer rules, while
            // the scoped rules below cover shadow-root rendering.
            const container = el('div', 'omni-pdf__text-layer textLayer');
            container.style.setProperty('--scale-factor', String(controller.state.zoom / 100));
            container.style.width = `${Math.floor(viewport.width)}px`;
            container.style.height = `${Math.floor(viewport.height)}px`;
            const textLayer = new pdfjs.TextLayer({ textContentSource, container, viewport });
            record.textLayer?.cancel();
            record.textLayer = textLayer;
            await textLayer.render();
            if (disposed || epoch !== renderEpoch) {
                textLayer.cancel();
                return;
            }
            // Insert under annotation overlays (which renderOverlays appends next).
            record.wrapper.appendChild(container);
            ctx.logger.log(
                'info',
                `[pdf text-layer] page=${record.pageNumber} rendered children=${container.childElementCount}`
            );
        } catch (error) {
            // Cancellation during zoom/reload is normal, but log other cases
            // so a host integration can diagnose missing selectable text.
            if (!disposed && epoch === renderEpoch) {
                ctx.logger.log('info', `[pdf text-layer] page=${record.pageNumber} failed: ${String(error)}`);
            }
        }
    }

    function setCurrentPage(pageNumber: number): void {
        currentPage = pageNumber;
        pageInput.value = String(currentPage);
        pageTotal.textContent = `/ ${records.length}`;
        records.forEach((record, index) => {
            (thumbs.children[index] as HTMLElement | undefined)?.toggleAttribute(
                'aria-current',
                record.pageNumber === currentPage
            );
        });
    }

    function goToPageInput(): void {
        const pageNumber = Number(pageInput.value);
        const record = records.find((item) => item.pageNumber === pageNumber);
        if (!record) {
            pageInput.value = String(currentPage);
            return;
        }
        scrollToPage(record);
        setCurrentPage(pageNumber);
    }

    pageInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        goToPageInput();
        pageInput.blur();
    });
    pageInput.addEventListener('change', goToPageInput);

    function scrollToPage(record: PageRecord): void {
        const before = pages.scrollTop;
        const viewport = pages.getBoundingClientRect();
        const page = record.wrapper.getBoundingClientRect();
        ctx.logger.log(
            'info',
            `[pdf navigation] request page=${record.pageNumber} scrollTop=${before} ` +
            `viewport=${viewport.top},${viewport.height} page=${page.top},${page.height}`
        );
        // The page panel has its own fixed-height scrollport, so a single
        // coordinate-based movement is enough. Combining this with
        // scrollIntoView applied the same offset twice.
        pages.scrollTop = Math.max(0, pages.scrollTop + page.top - viewport.top);
        requestAnimationFrame(() => {
            ctx.logger.log(
                'info',
                `[pdf navigation] result page=${record.pageNumber} scrollTop=${pages.scrollTop} ` +
                `delta=${pages.scrollTop - before}`
            );
        });
    }

    function syncCurrentPageFromViewport(): void {
        const viewport = pages.getBoundingClientRect();
        const visible = records.filter((record) => {
            const box = record.wrapper.getBoundingClientRect();
            return box.bottom > viewport.top && box.top < viewport.bottom;
        });
        if (visible.length === 0) return;
        const current = visible.find((record) => {
            const box = record.wrapper.getBoundingClientRect();
            return box.top <= viewport.top && box.bottom > viewport.top;
        }) ?? visible.sort((a, b) => {
            const aDistance = Math.abs(a.wrapper.getBoundingClientRect().top - viewport.top);
            const bDistance = Math.abs(b.wrapper.getBoundingClientRect().top - viewport.top);
            return aDistance - bDistance;
        })[0];
        if (current) setCurrentPage(current.pageNumber);
    }

    pages.addEventListener('scroll', syncCurrentPageFromViewport, { passive: true });

    async function rebuildLayout(): Promise<void> {
        if (!doc || disposed) return;
        // Preserve the source page the reader is actually viewing.  `currentPage`
        // alone is not sufficient here: the lazy-render observer deliberately
        // observes pages outside the viewport as well.
        const previousViewport = pages.getBoundingClientRect();
        const visibleBeforeRebuild = records
            .filter((record) => {
                const box = record.wrapper.getBoundingClientRect();
                return box.bottom > previousViewport.top && box.top < previousViewport.bottom;
            })
            .sort((a, b) => {
                const aDistance = Math.abs(a.wrapper.getBoundingClientRect().top - previousViewport.top);
                const bDistance = Math.abs(b.wrapper.getBoundingClientRect().top - previousViewport.top);
                return aDistance - bDistance;
            })[0];
        const pageToRestore = visibleBeforeRebuild?.pageNumber ?? currentPage;
        // Retain where the reader was within the page, rather than only its
        // page number. This keeps zoom from jumping to a page boundary.
        const pageOffsetRatio = visibleBeforeRebuild
            ? Math.max(0, Math.min(1, (
                previousViewport.top - visibleBeforeRebuild.wrapper.getBoundingClientRect().top
            ) / Math.max(1, visibleBeforeRebuild.wrapper.getBoundingClientRect().height)))
            : 0;
        const epoch = ++renderEpoch;
        pageObserver?.disconnect();
        thumbObserver?.disconnect();
        for (const record of records) {
            record.task?.cancel();
            record.textLayer?.cancel();
        }
        records = [];
        pages.replaceChildren();
        thumbs.replaceChildren();

        const scale = controller.state.zoom / 100;
        const pageTotal = controller.state.pageOrder.length;
        const thumbRenderers: Array<{ element: HTMLElement; render: () => void }> = [];

        for (const pageNumber of controller.state.pageOrder) {
            const page = await doc.getPage(pageNumber);
            if (disposed || epoch !== renderEpoch) return;
            const viewport = page.getViewport({ scale });

            const wrapper = el('div', 'omni-pdf__page');
            wrapper.dataset.pageNumber = String(pageNumber);
            wrapper.style.width = `${viewport.width}px`;
            wrapper.style.height = `${viewport.height}px`;
            wrapper.appendChild(
                el('div', 'omni-pdf__placeholder', t('common.page', { page: pageNumber, pages: pageTotal }))
            );
            wrapper.addEventListener('click', (event) => {
                const target = event.target;
                if (target instanceof Element && target.closest('.omni-pdf__annotation')) return;
                if (tool !== 'text' && tool !== 'signature') {
                    if (controller.state.selectedAnnotationId) {
                        controller.dispatch({ type: 'select-annotation', id: null });
                    }
                    return;
                }
                if (target !== wrapper && !(target instanceof HTMLCanvasElement)) return;
                const bounds = wrapper.getBoundingClientRect();
                const currentScale = controller.state.zoom / 100;
                const x = (event.clientX - bounds.left) / currentScale;
                const y = (event.clientY - bounds.top) / currentScale;
                if (tool === 'text') {
                    openTextInput(wrapper, pageNumber, x, y);
                } else {
                    pendingSignaturePosition = { page: pageNumber, x, y };
                    clearPad();
                    signatureModal.classList.add('is-open');
                }
            });
            if (pageLayout === 'spread-even' && records.length === 0) {
                const blank = el('div', 'omni-pdf__spread-blank');
                blank.style.width = `${viewport.width}px`;
                blank.style.height = `${viewport.height}px`;
                pages.appendChild(blank);
            }
            pages.appendChild(wrapper);
            const record: PageRecord = {
                pageNumber,
                page,
                wrapper,
                rendered: false,
                rendering: false,
                task: undefined,
                textLayer: undefined
            };
            records.push(record);

            // --- thumbnail (lazy-rendered — docs §5: never all at once) ---
            const thumb = el('button', 'omni-pdf__thumb');
            thumb.type = 'button';
            thumb.setAttribute(
                'aria-label',
                t('common.page', { page: pageNumber, pages: pageTotal })
            );
            const thumbCanvas = el('canvas');
            const thumbViewport = page.getViewport({
                scale: Math.min(0.18, 90 / (viewport.width / scale || 1))
            });
            thumbCanvas.width = Math.floor(thumbViewport.width);
            thumbCanvas.height = Math.floor(thumbViewport.height);
            let thumbRendered = false;
            const renderThumb = () => {
                if (thumbRendered || disposed || epoch !== renderEpoch) return;
                thumbRendered = true;
                const thumbContext = thumbCanvas.getContext('2d');
                if (!thumbContext) return;
                void page
                    .render({ canvasContext: thumbContext, viewport: thumbViewport })
                    .promise.catch(() => undefined);
            };
            thumbRenderers.push({ element: thumb, render: renderThumb });
            const label = el('span', 'omni-pdf__thumb-label', String(pageNumber));
            thumb.append(thumbCanvas, label);
            thumb.addEventListener('click', () => {
                // Keep thumbnail navigation inside the PDF scroll container.
                scrollToPage(record);
                setCurrentPage(pageNumber);
            });

            thumb.draggable = true;
            thumb.addEventListener('dragstart', (event) => {
                event.dataTransfer?.setData('text/plain', String(pageNumber));
                thumb.classList.add('is-dragging');
            });
            thumb.addEventListener('dragend', () => {
                for (const node of [...thumbs.children]) {
                    node.classList.remove('is-dragging', 'drop-before', 'drop-after');
                }
            });
            thumb.addEventListener('dragover', (event) => {
                event.preventDefault();
                for (const node of [...thumbs.children]) {
                    node.classList.remove('drop-before', 'drop-after');
                }
                const rect = thumb.getBoundingClientRect();
                thumb.classList.add(
                    event.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after'
                );
            });
            thumb.addEventListener('dragleave', () =>
                thumb.classList.remove('drop-before', 'drop-after')
            );
            thumb.addEventListener('drop', (event) => {
                event.preventDefault();
                const order = controller.state.pageOrder;
                const from = order.indexOf(Number(event.dataTransfer?.getData('text/plain')));
                let to = order.indexOf(pageNumber);
                if (thumb.classList.contains('drop-after')) to += 1;
                if (from >= 0 && to >= 0) {
                    if (from < to) to--;
                    controller.dispatch({
                        type: 'reorder-pages',
                        from,
                        to: Math.min(to, order.length - 1)
                    });
                }
            });
            if (editingAvailable) {
                const remove = el('button', 'omni-pdf__thumb-remove', '×');
                remove.type = 'button';
                remove.setAttribute('aria-label', t('pdf.deletePage'));
                remove.addEventListener('click', (event) => {
                    event.stopPropagation();
                    controller.dispatch({ type: 'delete-page', page: pageNumber });
                });
                thumb.appendChild(remove);
            }
            thumbs.appendChild(thumb);
        }

        if (typeof IntersectionObserver === 'function') {
            pageObserver = new IntersectionObserver(
                (entries) => {
                    for (const entry of entries) {
                        if (!entry.isIntersecting) continue;
                        const record = records.find((item) => item.wrapper === entry.target);
                        if (!record) continue;
                        void renderPage(record, epoch);
                    }
                },
                { root: pages, rootMargin: '150% 0px 150% 0px', threshold: 0 }
            );
            for (const record of records) pageObserver.observe(record.wrapper);

            thumbObserver = new IntersectionObserver(
                (entries) => {
                    for (const entry of entries) {
                        if (!entry.isIntersecting) continue;
                        thumbRenderers.find((item) => item.element === entry.target)?.render();
                    }
                },
                { root: thumbs, rootMargin: '100% 0px 100% 0px', threshold: 0 }
            );
            for (const item of thumbRenderers) thumbObserver.observe(item.element);
        } else {
            // No observer support: render the current page and nearby thumbs.
            for (const item of thumbRenderers.slice(0, THUMB_FALLBACK_RENDER_COUNT)) {
                item.render();
            }
        }

        const current =
            records.find((record) => record.pageNumber === pageToRestore) ?? records[0];
        if (current) {
            setCurrentPage(current.pageNumber);
            void renderPage(current, epoch);
            // Do not use scrollIntoView here: it may scroll the host document
            // as well as the PDF list. Restrict restoration to the PDF list.
            if (visibleBeforeRebuild) {
                pages.scrollTop = Math.max(
                    0,
                    current.wrapper.offsetTop + current.wrapper.offsetHeight * pageOffsetRatio
                );
            }
        }
        syncCurrentPageFromViewport();
        status.textContent = `${records.length} ${t('pdf.pages')}`;
    }

    function refreshChrome(): void {
        const state = controller.state;
        zoomLevel.textContent = `${state.zoom}%`;
        zoomOutBtn.disabled = state.zoom === PDF_ZOOM_LEVELS[0];
        zoomInBtn.disabled = state.zoom === PDF_ZOOM_LEVELS[PDF_ZOOM_LEVELS.length - 1];
        if (editingAvailable && ctx.writeback) {
            saveBtn.disabled = !(state.dirty || mergedSinceSave);
        }
    }

    /** Full rebuild only when zoom / page structure changed; annotation-only
     *  changes just refresh the overlays (no canvas re-render, no scroll loss). */
    function onStateChange(): void {
        const state = controller.state;
        const nextKey = JSON.stringify({ zoom: state.zoom, pageOrder: state.pageOrder });
        refreshChrome();
        if (nextKey !== layoutKey) {
            layoutKey = nextKey;
            void rebuildLayout();
            return;
        }
        for (const record of records) {
            if (record.rendered) renderOverlays(record);
        }
    }

    function adoptController(next: PdfController): void {
        unsubscribe?.();
        controller = next;
        layoutKey = JSON.stringify({
            zoom: next.state.zoom,
            pageOrder: next.state.pageOrder
        });
        unsubscribe = next.subscribe(onStateChange);
    }

    // ------------------------------------------------------- editing actions
    async function ensurePdfLib(): Promise<PdfLibModule> {
        if (!deps.loadPdfLib) throw new Error('pdf-lib unavailable');
        pdfLib ??= await deps.loadPdfLib();
        return pdfLib;
    }

    function stateForSave(): PdfViewState {
        const state = controller.state;
        return {
            ...state,
            annotations: state.annotations.map((annotation) => {
                if (
                    annotation.kind !== 'text'
                    || (annotation.rasterDataUrl && annotation.rasterWidth && annotation.rasterHeight)
                ) return annotation;
                return { ...annotation, ...rasterizeText(annotation.text, annotation.size, annotation.color) };
            })
        };
    }

    async function save(): Promise<void> {
        if (!ctx.writeback || saveBtn.disabled) return;
        try {
            const lib = await ensurePdfLib();
            // Flatten from the pristine base (not the on-disk flattened copy),
            // embedding the sidecar so overlays stay removable on reopen. The
            // in-memory session keeps `sourceBytes` pristine + the live layer;
            // we only rebaseline the dirty marker.
            const data = await buildSavedPdf(lib, sourceBytes, stateForSave());
            await ctx.writeback.write(data);
            mergedSinceSave = false;
            controller.dispatch({ type: 'mark-saved' });
            refreshChrome();
            status.textContent = t('common.savedToOriginal');
        } catch (error) {
            ctx.logger.log('error', `pdf save failed: ${String(error)}`);
            status.textContent = t('common.saveFailed');
        }
    }

    async function saveAs(): Promise<void> {
        if (!ctx.save || saveAsBtn.disabled) return;
        try {
            const lib = await ensurePdfLib();
            // Keep the same hybrid sidecar as Save so a Save As document can
            // be reopened in Omni Viewer with all overlays still editable.
            // Other PDF readers continue to see the flattened result.
            const data = await buildSavedPdf(lib, sourceBytes, stateForSave());
            await ctx.save.saveFile(savedPdfName(input.fileName), data, 'application/pdf');
            status.textContent = t('common.saved', { name: savedPdfName(input.fileName) });
        } catch (error) {
            ctx.logger.log('error', `pdf save-as failed: ${String(error)}`);
            status.textContent = t('common.saveFailed');
        }
    }

    async function merge(): Promise<void> {
        if (!ctx.filePick || mergeBtn.disabled) return;
        const picked = await ctx.filePick.pickFile({ accept: ['application/pdf', '.pdf'] });
        if (!picked || disposed) return;
        try {
            status.textContent = t('pdf.merging');
            const lib = await ensurePdfLib();
            // `sourceBytes` is the pristine base while the controller holds
            // the live reorder/delete/annotation layer. Keep that layer and
            // append the new source pages to its current visible order.
            const previousState = controller.state;
            const previousSourcePageCount = doc?.numPages ?? sourceBytes.length;
            const merged = await mergePdfBytes(lib, sourceBytes, picked.data);
            await doc?.destroy();
            doc = await loadDocument(merged);
            if (disposed) {
                void doc.destroy();
                return;
            }
            sourceBytes = merged;
            currentPage = 1;
            // The merged pages exist only in memory until the user saves.
            mergedSinceSave = true;
            const appendedPages = Array.from(
                { length: Math.max(0, doc.numPages - previousSourcePageCount) },
                (_, index) => previousSourcePageCount + index + 1
            );
            adoptController(createPdfController(doc.numPages, {
                pageOrder: [...previousState.pageOrder, ...appendedPages],
                annotations: previousState.annotations
            }));
            refreshChrome();
            await rebuildLayout();
            status.textContent = t('pdf.mergeComplete');
        } catch (error) {
            ctx.logger.log('error', `pdf merge failed: ${String(error)}`);
            status.textContent = t('pdf.mergeFailed');
        }
    }

    // ------------------------------------------------------------- open doc
    let password: string | undefined;
    for (;;) {
        try {
            doc = await loadDocument(sourceBytes, password);
            break;
        } catch (error) {
            throwIfAborted();
            if (isPasswordError(error)) {
                const entered = await askPassword(password !== undefined);
                throwIfAborted();
                if (entered !== null) {
                    password = entered;
                    continue;
                }
                status.textContent = t('pdf.passwordRequired');
            } else {
                ctx.logger.log('error', `pdf load failed: ${String(error)}`);
                status.textContent = t('pdf.loadFailed');
            }
            status.classList.add('omni-pdf__status--error');
            // Stable failed handle: one empty controller, normal dispose.
            const failedController = createPdfController(0);
            return {
                get controller() {
                    return failedController;
                },
                isDirty: () => false,
                dispose: teardown
            };
        }
    }
    throwIfAborted();

    // Hybrid rehydration: if this file was saved by us, its visible pages are
    // flattened but it carries the pristine source + layer JSON. Render/edit
    // from the pristine base and restore the overlays as a removable layer.
    const sidecar = await readSidecar(doc);
    if (sidecar) {
        await doc.destroy();
        sourceBytes = sidecar.pristine;
        doc = await loadDocument(sourceBytes, password);
        throwIfAborted();
        adoptController(createPdfController(doc.numPages, sidecar.layer));
    } else {
        adoptController(createPdfController(doc.numPages));
    }
    refreshChrome();
    await rebuildLayout();
    throwIfAborted();

    return {
        get controller() {
            return controller;
        },
        isDirty: () => controller.state.dirty || mergedSinceSave,
        dispose: teardown
    };
}
