// @vitest-environment jsdom
import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CATALOG_EN } from '../../i18n/catalog.en.js';
import {
    mountPdfViewer,
    containPdfSignatureSize,
    type PdfJsDocument,
    type PdfJsLoadingTask,
    type PdfJsModule,
    type PdfViewerContext,
    type PdfViewerDeps
} from './index.js';

// jsdom has no canvas backend, so page/thumb canvases stay blank; the DOM
// structure (thumbs, overlays, chrome) is what these tests exercise.
beforeAll(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

function fakePdfjs(pageCount: number): PdfJsModule {
    const page = {
        getViewport: ({ scale }: { scale: number }) => ({ width: 300 * scale, height: 400 * scale }),
        render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
        getTextContent: async () => ({})
    };
    return {
        getDocument: () => ({
            promise: Promise.resolve({
                numPages: pageCount,
                getPage: async () => page,
                destroy: async () => undefined
            }),
            destroy: () => undefined
        }),
        GlobalWorkerOptions: { workerSrc: '' },
        TextLayer: class {
            async render(): Promise<void> {}
            cancel(): void {}
        }
    };
}

const deps: PdfViewerDeps = { loadPdfjs: async () => fakePdfjs(2) };

function ctx(): PdfViewerContext {
    return {
        assets: { resolveAssetUrl: async path => path },
        logger: { log: vi.fn() },
        i18n: { t: (key, args) => (CATALOG_EN[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(args?.[name] ?? '')) }
    };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const buttonWithText = (root: ParentNode, text: string): HTMLButtonElement => {
    const button = [...root.querySelectorAll('button')]
        .find((candidate) => candidate.textContent === text);
    if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`);
    return button;
};

describe('mountPdfViewer thumbnails', () => {
    it('mirrors markup annotations onto the page thumbnails', async () => {
        const container = document.createElement('div');
        const handle = await mountPdfViewer(
            { fileName: 'sample.pdf', data: new Uint8Array([1]) },
            container, ctx(), {
                ...deps,
                processing: { buildPdf: async () => new Uint8Array([1]) }
            }
        );
        const root = container.shadowRoot!;
        const holders = root.querySelectorAll('.omni-pdf__thumb-page');
        expect(holders).toHaveLength(2);

        handle.controller.dispatch({
            type: 'add-annotation',
            annotation: { kind: 'highlight', page: 1, color: '#ffeb3b', rects: [{ x: 20, y: 40, width: 120, height: 14 }] }
        });
        handle.controller.dispatch({
            type: 'add-annotation',
            annotation: { kind: 'underline', page: 2, color: '#ff0000', rects: [{ x: 10, y: 100, width: 60, height: 12 }] }
        });

        // Thumb scale for a 300pt-wide page is min(0.18, 90/300 = 0.3) = 0.18.
        const highlight = holders[0]!.querySelector<HTMLElement>('.omni-pdf__thumb-annotation.omni-pdf__highlight');
        expect(highlight).not.toBeNull();
        expect(parseFloat(highlight!.style.left)).toBeCloseTo(3.6);
        expect(parseFloat(highlight!.style.width)).toBeCloseTo(21.6);
        expect(highlight!.style.getPropertyValue('--omni-hl-color')).toBe('#ffeb3b');
        expect(holders[0]!.querySelector('.omni-pdf__underline')).toBeNull();
        expect(holders[1]!.querySelector('.omni-pdf__thumb-annotation.omni-pdf__underline')).not.toBeNull();

        const removedId = handle.controller.state.annotations[0]!.id;
        handle.controller.dispatch({ type: 'remove-annotation', id: removedId });
        expect(holders[0]!.querySelector('.omni-pdf__thumb-annotation')).toBeNull();
        expect(holders[1]!.querySelector('.omni-pdf__thumb-annotation')).not.toBeNull();
        handle.dispose();
    });

    it('keeps thumbnail annotations across a layout rebuild (zoom)', async () => {
        const container = document.createElement('div');
        const handle = await mountPdfViewer(
            { fileName: 'sample.pdf', data: new Uint8Array([1]) },
            container, ctx(), deps
        );
        const root = container.shadowRoot!;
        handle.controller.dispatch({
            type: 'add-annotation',
            annotation: { kind: 'highlight', page: 1, color: '#ffeb3b', rects: [{ x: 20, y: 40, width: 120, height: 14 }] }
        });
        handle.controller.dispatch({ type: 'zoom-in' });
        await flush();
        await flush();

        const holders = root.querySelectorAll('.omni-pdf__thumb-page');
        const highlight = holders[0]!.querySelector<HTMLElement>('.omni-pdf__thumb-annotation.omni-pdf__highlight');
        expect(highlight).not.toBeNull();
        // Annotation units are zoom-independent, so the thumb position is too.
        expect(parseFloat(highlight!.style.left)).toBeCloseTo(3.6);
        handle.dispose();
    });

    it('uses display positions after reorder/delete while annotations keep source ids', async () => {
        const container = document.createElement('div');
        const handle = await mountPdfViewer(
            { fileName: 'sample.pdf', data: new Uint8Array([1]) },
            container, ctx(), deps
        );
        const root = container.shadowRoot!;
        handle.controller.dispatch({ type: 'reorder-pages', from: 0, to: 1 });
        handle.controller.dispatch({
            type: 'add-annotation',
            annotation: { kind: 'text', page: 2, x: 1, y: 2, text: 'source-two', size: 12, color: '#000000' }
        });
        await flush();
        await flush();

        expect([...root.querySelectorAll('.omni-pdf__thumb-label')].map((node) => node.textContent))
            .toEqual(['1', '2']);
        expect([...root.querySelectorAll<HTMLElement>('.omni-pdf__page')].map((node) => node.dataset.pageNumber))
            .toEqual(['2', '1']);
        expect(handle.controller.state.annotations[0]?.page).toBe(2);

        const input = root.querySelector<HTMLInputElement>('.omni-pdf__page-input')!;
        input.value = '1';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        expect(input.value).toBe('1');
        expect(root.querySelector('.omni-pdf__thumb[aria-current] .omni-pdf__thumb-label')?.textContent)
            .toBe('1');

        handle.controller.dispatch({ type: 'delete-page', page: 2 });
        await flush();
        await flush();
        expect(input.value).toBe('1');
        expect(root.querySelector('.omni-pdf__page-total')?.textContent).toBe('/ 1');
        expect(root.querySelector('.omni-pdf__thumb-label')?.textContent).toBe('1');
        handle.dispose();
    });
});

describe('PDF signature sizing', () => {
    it.each([
        [1, 1, 60, 60],
        [4, 1, 120, 30],
        [1, 3, 20, 60]
    ])('contains %s:%s without distortion', (width, height, expectedWidth, expectedHeight) => {
        const result = containPdfSignatureSize(width, height);
        expect(result.width).toBeCloseTo(expectedWidth);
        expect(result.height).toBeCloseTo(expectedHeight);
        expect(result.width / result.height).toBeCloseTo(width / height);
    });
});

describe('mountPdfViewer host contracts', () => {
    it.each(['shadow', 'scoped'] as const)(
        'renders and disposes custom toolbar actions in %s mode',
        async (styleIsolation) => {
            const clicked = vi.fn();
            let disabled = false;
            const container = document.createElement('div');
            const handle = await mountPdfViewer(
                { fileName: 'sample.pdf', data: new Uint8Array([1]) },
                container, ctx(), deps,
                {
                    styleIsolation,
                    toolbarActions: [{
                        id: 'share', label: 'Share', title: 'Share PDF', ariaLabel: 'Share this PDF',
                        disabled: () => disabled,
                        onClick: clicked
                    }]
                }
            );
            const root = styleIsolation === 'shadow' ? container.shadowRoot! : container;
            const action = root.querySelector<HTMLButtonElement>('[data-action-id="share"]')!;
            expect(action.title).toBe('Share PDF');
            expect(action.getAttribute('aria-label')).toBe('Share this PDF');
            action.click();
            expect(clicked).toHaveBeenCalledTimes(1);
            disabled = true;
            handle.refreshToolbarActions();
            expect(action.disabled).toBe(true);
            disabled = false;
            handle.refreshToolbarActions();
            handle.dispose();
            action.click();
            expect(clicked).toHaveBeenCalledTimes(1);
            expect(root.childNodes).toHaveLength(0);
        }
    );

    it('uses safe pdf.js options and supports a host worker URL', async () => {
        const getDocument = vi.fn(() => fakePdfjs(1).getDocument({
            data: new Uint8Array([1]), isEvalSupported: false
        }));
        const pdfjs = fakePdfjs(1);
        pdfjs.getDocument = getDocument;
        const context = ctx();
        const resolve = vi.spyOn(context.assets, 'resolveAssetUrl');
        const handle = await mountPdfViewer(
            { fileName: 'sample.pdf', data: new Uint8Array([1]) },
            document.createElement('div'), context, { loadPdfjs: async () => pdfjs },
            { workerSrc: 'host-worker.mjs' }
        );
        expect(resolve).not.toHaveBeenCalled();
        expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe('host-worker.mjs');
        expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ isEvalSupported: false }));
        handle.dispose();
    });

    it('disables zoom buttons at the configured minimum and maximum', async () => {
        const container = document.createElement('div');
        const handle = await mountPdfViewer(
            { fileName: 'sample.pdf', data: new Uint8Array([1]) },
            container, ctx(), deps
        );
        const root = container.shadowRoot!;
        const zoomOut = root.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!;
        const zoomIn = root.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!;
        handle.controller.dispatch({ type: 'set-zoom', zoom: 25 });
        expect(zoomOut.disabled).toBe(true);
        expect(zoomIn.disabled).toBe(false);
        handle.controller.dispatch({ type: 'set-zoom', zoom: 400 });
        expect(zoomOut.disabled).toBe(false);
        expect(zoomIn.disabled).toBe(true);
        handle.dispose();
    });

    it('returns a stable failed handle when worker URL resolution fails', async () => {
        const context = ctx();
        context.assets.resolveAssetUrl = async () => { throw new Error('missing worker'); };
        const container = document.createElement('div');
        const handle = await mountPdfViewer(
            { fileName: 'sample.pdf', data: new Uint8Array([1]) },
            container, context, deps
        );
        expect(handle.controller.state.pageOrder).toEqual([]);
        expect(container.shadowRoot?.querySelector('.omni-pdf__status')?.textContent)
            .toBe('Unable to load the PDF worker asset.');
        handle.dispose();
    });

    it('falls back to the flattened document when a v2 sidecar base is invalid', async () => {
        const pdfjs = fakePdfjs(2);
        const original = await pdfjs.getDocument({ data: new Uint8Array([1]) }).promise;
        original.getAttachments = async () => ({
            layer: {
                filename: 'omni-viewer-layer.json',
                content: new TextEncoder().encode(JSON.stringify({
                    version: 2, pageOrder: [1, 2], annotations: []
                }))
            },
            base: { filename: 'omni-viewer-base.pdf', content: new Uint8Array([0]) }
        });
        const failedDestroy = vi.fn(async () => undefined);
        let call = 0;
        pdfjs.getDocument = () => ++call === 1
            ? { promise: Promise.resolve(original), destroy: vi.fn() }
            : { promise: Promise.reject(new Error('invalid sidecar base')), destroy: failedDestroy };
        const container = document.createElement('div');
        const handle = await mountPdfViewer(
            { fileName: 'saved.pdf', data: new Uint8Array([1]) },
            container, ctx(), { loadPdfjs: async () => pdfjs }
        );
        expect(handle.controller.state.pageOrder).toEqual([1, 2]);
        expect(container.shadowRoot?.querySelectorAll('.omni-pdf__page')).toHaveLength(2);
        expect(failedDestroy).toHaveBeenCalledTimes(1);
        handle.dispose();
    });

    it('delegates hybrid saves and reports progress/success', async () => {
        const largeSource = new Uint8Array(8 * 1024 * 1024);
        const buildPdf = vi.fn(async (_request, control) => {
            control.onProgress(0.5);
            return new Uint8Array([9]);
        });
        const write = vi.fn(async () => undefined);
        const context = { ...ctx(), writeback: { write } };
        const container = document.createElement('div');
        const handle = await mountPdfViewer(
            { fileName: 'sample.pdf', data: largeSource }, container, context,
            { loadPdfjs: async () => fakePdfjs(2), processing: { buildPdf } }
        );
        handle.controller.dispatch({
            type: 'add-annotation',
            annotation: { kind: 'text', page: 1, x: 1, y: 2, text: 'x', size: 12, color: '#000000' }
        });
        buttonWithText(container.shadowRoot!, 'Save').click();
        await flush();
        await flush();
        expect(buildPdf).toHaveBeenCalledWith(
            expect.objectContaining({ mode: 'hybrid' }),
            expect.objectContaining({ signal: expect.any(AbortSignal), onProgress: expect.any(Function) })
        );
        expect(buildPdf.mock.calls[0]![0].source).toBe(largeSource);
        expect(write).toHaveBeenCalledWith(new Uint8Array([9]));
        expect(handle.operation.status).toBe('succeeded');
        expect(handle.isDirty()).toBe(false);
        handle.dispose();
    });

    it('reflects delegated cancellation without losing the open document', async () => {
        const buildPdf = vi.fn((_request, control) => new Promise<Uint8Array>((_resolve, reject) => {
            control.signal.addEventListener('abort', () => {
                reject(new DOMException('cancelled', 'AbortError'));
            }, { once: true });
        }));
        const container = document.createElement('div');
        const handle = await mountPdfViewer(
            { fileName: 'sample.pdf', data: new Uint8Array([1]) },
            container, { ...ctx(), writeback: { write: vi.fn(async () => undefined) } },
            { loadPdfjs: async () => fakePdfjs(2), processing: { buildPdf } }
        );
        handle.controller.dispatch({
            type: 'add-annotation',
            annotation: { kind: 'text', page: 1, x: 1, y: 2, text: 'x', size: 12, color: '#000000' }
        });
        buttonWithText(container.shadowRoot!, 'Save').click();
        expect(handle.operation.status).toBe('running');
        handle.cancelOperation();
        await flush();
        expect(handle.operation.status).toBe('cancelled');
        expect(container.shadowRoot?.querySelectorAll('.omni-pdf__page')).toHaveLength(2);
        handle.dispose();
    });

    it('passes flattened policy and distinguishes Save As cancellation', async () => {
        const completed = vi.fn();
        const saveFile = vi.fn(async () => ({ status: 'cancelled' as const }));
        const container = document.createElement('div');
        const handle = await mountPdfViewer(
            { fileName: 'sample.pdf', data: new Uint8Array([1]) },
            container, { ...ctx(), save: { saveFile } },
            {
                loadPdfjs: async () => fakePdfjs(1),
                processing: { buildPdf: async () => new Uint8Array([8]) }
            },
            { saveMode: 'flattened', onSaveAsComplete: completed }
        );
        expect(container.shadowRoot?.querySelector('.omni-pdf__save-mode')?.textContent).toBe('Compact');
        buttonWithText(container.shadowRoot!, 'Save as').click();
        await flush();
        await flush();
        expect(completed).toHaveBeenCalledWith({ status: 'cancelled' });
        expect(handle.operation.status).toBe('cancelled');
        handle.dispose();
    });

    it('uses the browser pdf-lib fallback when no processing service is provided', async () => {
        const sourceDocument = await PDFDocument.create();
        sourceDocument.addPage([100, 100]);
        const source = await sourceDocument.save();
        const write = vi.fn(async () => undefined);
        const container = document.createElement('div');
        const handle = await mountPdfViewer(
            { fileName: 'sample.pdf', data: source },
            container, { ...ctx(), writeback: { write } },
            { loadPdfjs: async () => fakePdfjs(1), loadPdfLib: () => import('pdf-lib') },
            { saveMode: 'flattened' }
        );
        handle.controller.dispatch({
            type: 'add-annotation',
            annotation: { kind: 'text', page: 1, x: 1, y: 2, text: 'x', size: 12, color: '#000000' }
        });
        buttonWithText(container.shadowRoot!, 'Save').click();
        await flush();
        await flush();
        expect(write).toHaveBeenCalledTimes(1);
        expect(handle.operation.status).toBe('succeeded');
        handle.dispose();
    });

    it('keeps the open document alive when a delegated merge cannot be loaded', async () => {
        const originalDestroy = vi.fn(async () => undefined);
        const failedTaskDestroy = vi.fn(async () => undefined);
        let call = 0;
        const base = fakePdfjs(2);
        base.getDocument = () => {
            call++;
            if (call === 1) {
                return {
                    promise: Promise.resolve({
                        numPages: 2,
                        getPage: async (n: number) => (await fakePdfjs(2).getDocument({ data: new Uint8Array([1]) }).promise).getPage(n),
                        destroy: originalDestroy
                    }),
                    destroy: vi.fn()
                };
            }
            return { promise: Promise.reject(new Error('bad merged PDF')), destroy: failedTaskDestroy };
        };
        const pickFile = vi.fn(async () => ({ fileName: 'second.pdf', data: new Uint8Array([2]) }));
        const mergePdfs = vi.fn(async () => new Uint8Array([3]));
        const container = document.createElement('div');
        const handle = await mountPdfViewer(
            { fileName: 'sample.pdf', data: new Uint8Array([1]) },
            container, { ...ctx(), filePick: { pickFile } },
            { loadPdfjs: async () => base, processing: { mergePdfs } },
            { maxMergeBytes: 1234 }
        );
        buttonWithText(container.shadowRoot!, 'Merge PDF').click();
        await flush();
        await flush();
        expect(pickFile).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 1234 }));
        expect(mergePdfs).toHaveBeenCalledTimes(1);
        expect(failedTaskDestroy).toHaveBeenCalledTimes(1);
        expect(originalDestroy).not.toHaveBeenCalled();
        expect(container.shadowRoot?.querySelectorAll('.omni-pdf__page')).toHaveLength(2);
        expect(handle.operation.status).toBe('failed');
        handle.dispose();
    });

    it('renders text/signature overlays and keeps undo/redo wired through mount', async () => {
        const getContext = vi.mocked(HTMLCanvasElement.prototype.getContext);
        getContext.mockReturnValue({} as CanvasRenderingContext2D);
        try {
            const container = document.createElement('div');
            const handle = await mountPdfViewer(
                { fileName: 'sample.pdf', data: new Uint8Array([1]) },
                container, ctx(), deps
            );
            await flush();
            handle.controller.dispatch({
                type: 'add-annotation',
                annotation: { kind: 'text', page: 1, x: 10, y: 20, text: 'note', size: 12, color: '#000000' }
            });
            handle.controller.dispatch({
                type: 'add-annotation',
                annotation: {
                    kind: 'signature', page: 1, x: 20, y: 30, width: 120, height: 30,
                    dataUrl: 'data:image/png;base64,AAAA'
                }
            });
            const root = container.shadowRoot!;
            expect(root.querySelectorAll('.omni-pdf__annotation')).toHaveLength(2);
            const textId = handle.controller.state.annotations[0]!.id;
            handle.controller.dispatch({ type: 'move-annotation', id: textId, x: 44, y: 55 });
            expect(root.querySelector<HTMLElement>(`[data-annotation-id="${textId}"]`)?.style.left).toBe('44px');
            handle.controller.dispatch({ type: 'remove-annotation', id: textId });
            expect(root.querySelectorAll('.omni-pdf__annotation')).toHaveLength(1);
            handle.controller.dispatch({ type: 'undo' });
            expect(root.querySelectorAll('.omni-pdf__annotation')).toHaveLength(2);
            handle.controller.dispatch({ type: 'redo' });
            expect(root.querySelectorAll('.omni-pdf__annotation')).toHaveLength(1);
            handle.dispose();
        } finally {
            getContext.mockReturnValue(null);
        }
    });

    it('turns text selections into highlight, underline and strikeout annotations', async () => {
        const container = document.createElement('div');
        const handle = await mountPdfViewer(
            { fileName: 'sample.pdf', data: new Uint8Array([1]) },
            container, ctx(), {
                ...deps,
                processing: { buildPdf: async () => new Uint8Array([1]) }
            }
        );
        const root = container.shadowRoot!;
        const wrapper = root.querySelector<HTMLElement>('.omni-pdf__page')!;
        wrapper.getBoundingClientRect = () => ({
            x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 400,
            width: 300, height: 400, toJSON: () => undefined
        });
        const selectionSpy = vi.spyOn(document, 'getSelection');
        const select = () => {
            const removeAllRanges = vi.fn();
            selectionSpy.mockReturnValue({
                isCollapsed: false,
                rangeCount: 1,
                toString: () => 'selected',
                getRangeAt: () => ({
                    getClientRects: () => [{
                        x: 10, y: 20, left: 10, top: 20, right: 60, bottom: 30,
                        width: 50, height: 10, toJSON: () => undefined
                    }]
                }),
                removeAllRanges
            } as unknown as Selection);
            document.dispatchEvent(new Event('selectionchange'));
        };
        try {
            select();
            buttonWithText(root, '✎').click();
            select();
            buttonWithText(root, 'Underline').click();
            root.querySelector<HTMLButtonElement>('.omni-pdf__markup-wrap .omni-pdf__tool')!.click();
            select();
            buttonWithText(root, 'Strikethrough').click();
            root.querySelector<HTMLButtonElement>('.omni-pdf__markup-wrap .omni-pdf__tool')!.click();
            expect(handle.controller.state.annotations.map((annotation) => annotation.kind))
                .toEqual(['highlight', 'underline', 'strikeout']);
        } finally {
            selectionSpy.mockRestore();
            handle.dispose();
        }
    });

    it('uses lazy observers and disconnects them on dispose', async () => {
        const instances: Array<{ observed: Element[]; disconnected: boolean }> = [];
        class FakeIntersectionObserver {
            readonly observed: Element[] = [];
            disconnected = false;
            constructor(_callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {
                instances.push(this);
            }
            observe(element: Element): void { this.observed.push(element); }
            unobserve(): void {}
            disconnect(): void { this.disconnected = true; }
            takeRecords(): IntersectionObserverEntry[] { return []; }
            readonly root = null;
            readonly rootMargin = '';
            readonly thresholds = [];
        }
        vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
        try {
            const handle = await mountPdfViewer(
                { fileName: 'sample.pdf', data: new Uint8Array([1]) },
                document.createElement('div'), ctx(), deps
            );
            expect(instances).toHaveLength(2);
            expect(instances[0]!.observed).toHaveLength(2);
            expect(instances[1]!.observed).toHaveLength(2);
            handle.dispose();
            expect(instances.every((instance) => instance.disconnected)).toBe(true);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('cancels page and thumbnail render tasks on dispose', async () => {
        const getContext = vi.mocked(HTMLCanvasElement.prototype.getContext);
        getContext.mockReturnValue({} as CanvasRenderingContext2D);
        const cancels: Array<ReturnType<typeof vi.fn>> = [];
        const never = new Promise<void>(() => undefined);
        const pdfjs = fakePdfjs(2);
        const loaded = await pdfjs.getDocument({ data: new Uint8Array([1]) }).promise;
        const page = await loaded.getPage(1);
        page.render = () => {
            const cancel = vi.fn();
            cancels.push(cancel);
            return { promise: never, cancel };
        };
        pdfjs.getDocument = () => ({
            promise: Promise.resolve({ ...loaded, getPage: async () => page }),
            destroy: vi.fn()
        });
        try {
            const handle = await mountPdfViewer(
                { fileName: 'sample.pdf', data: new Uint8Array([1]) },
                document.createElement('div'), ctx(), { loadPdfjs: async () => pdfjs }
            );
            await flush();
            expect(cancels.length).toBeGreaterThan(0);
            handle.dispose();
            expect(cancels.every((cancel) => cancel.mock.calls.length === 1)).toBe(true);
        } finally {
            getContext.mockReturnValue(null);
        }
    });
});

describe('mountPdfViewer password lifecycle', () => {
    const passwordError = () => Object.assign(new Error('password'), { name: 'PasswordException' });

    it('destroys the failed task before a successful password retry', async () => {
        const failedDestroy = vi.fn(async () => undefined);
        const pdfjs = fakePdfjs(1);
        const success = pdfjs.getDocument({ data: new Uint8Array([1]) });
        let call = 0;
        pdfjs.getDocument = () => ++call === 1
            ? { promise: Promise.reject(passwordError()), destroy: failedDestroy }
            : success;
        const container = document.createElement('div');
        const mounting = mountPdfViewer(
            { fileName: 'locked.pdf', data: new Uint8Array([1]) },
            container, ctx(), { loadPdfjs: async () => pdfjs }
        );
        await flush();
        const input = container.shadowRoot?.querySelector<HTMLInputElement>('input[type="password"]')!;
        input.value = 'secret';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const handle = await mounting;
        expect(failedDestroy).toHaveBeenCalledTimes(1);
        expect(call).toBe(2);
        handle.dispose();
    });

    it('shows an incorrect-password retry and returns a failed handle on cancel', async () => {
        const destroys = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
        const pdfjs = fakePdfjs(1);
        let call = 0;
        pdfjs.getDocument = () => ({
            promise: Promise.reject(passwordError()),
            destroy: destroys[Math.min(call++, destroys.length - 1)]!
        });
        const container = document.createElement('div');
        const mounting = mountPdfViewer(
            { fileName: 'locked.pdf', data: new Uint8Array([1]) },
            container, ctx(), { loadPdfjs: async () => pdfjs }
        );
        await flush();
        const firstInput = container.shadowRoot?.querySelector<HTMLInputElement>('input[type="password"]')!;
        firstInput.value = 'wrong';
        firstInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await flush();
        expect(container.shadowRoot?.textContent).toContain('Incorrect password. Try again.');
        const passwordModal = container.shadowRoot?.querySelector('.omni-pdf__modal.is-open')!;
        buttonWithText(passwordModal, 'Cancel').click();
        const handle = await mounting;
        expect(destroys.every((destroy) => destroy.mock.calls.length === 1)).toBe(true);
        expect(handle.controller.state.pageOrder).toEqual([]);
        handle.dispose();
    });

    it('aborts a mount that is waiting in the password prompt', async () => {
        const taskDestroy = vi.fn(async () => undefined);
        const pdfjs = fakePdfjs(1);
        pdfjs.getDocument = () => ({ promise: Promise.reject(passwordError()), destroy: taskDestroy });
        const abort = new AbortController();
        const container = document.createElement('div');
        const mounting = mountPdfViewer(
            { fileName: 'locked.pdf', data: new Uint8Array([1]) },
            container, ctx(), { loadPdfjs: async () => pdfjs }, { signal: abort.signal }
        );
        await flush();
        expect(container.shadowRoot?.querySelector('input[type="password"]')).not.toBeNull();
        abort.abort();
        await expect(mounting).rejects.toMatchObject({ name: 'MountAbortedError' });
        expect(taskDestroy).toHaveBeenCalledTimes(1);
        expect(container.shadowRoot?.childNodes).toHaveLength(0);
    });
});
