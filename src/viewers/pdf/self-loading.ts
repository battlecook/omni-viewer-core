// Opt-in self-loading entry (ADR 14): the only place in the core where the
// optional peers `pdfjs-dist` / `pdf-lib` are actually imported. Platforms
// whose bundler resolves the peers use this; others import `viewers/pdf`
// and inject their own loaders.

import type { ViewerInput } from '../types.js';
import {
    mountPdfViewer,
    type PdfJsModule,
    type PdfMountOptions,
    type PdfViewerContext,
    type PdfViewerDeps,
    type PdfViewerHandle
} from './index.js';

export * from './index.js';

export const selfLoadingPdfDeps: PdfViewerDeps = {
    loadPdfjs: () =>
        import('pdfjs-dist/build/pdf.mjs') as unknown as Promise<PdfJsModule>,
    loadPdfLib: () => import('pdf-lib')
};

/** mountPdfViewer with the core's own dynamic-import loaders. */
export function mountSelfLoadingPdfViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: PdfViewerContext,
    options: PdfMountOptions = {}
): Promise<PdfViewerHandle> {
    return mountPdfViewer(input, container, ctx, selfLoadingPdfDeps, options);
}
