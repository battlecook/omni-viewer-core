// Opt-in self-loading entry (ADR 14): the only place in the core where the
// optional peer `xlsx` is actually imported. Platforms whose bundler resolves
// the peer use this; others import `viewers/excel` and inject their own loader
// (e.g. chrome wires its vendored xlsx UMD through resolveAssetUrl).

import type { ViewerInput, MountOptions } from '../types.js';
import {
    mountExcelViewer,
    type ExcelMountOptions,
    type ExcelViewerContext,
    type ExcelViewerDeps,
    type ExcelViewerHandle
} from './index.js';

export * from './index.js';

export const selfLoadingExcelDeps: ExcelViewerDeps = {
    loadXlsx: () => import('xlsx')
};

/** mountExcelViewer with the core's own dynamic-import loader. */
export function mountSelfLoadingExcelViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: ExcelViewerContext,
    options: ExcelMountOptions & MountOptions = {}
): Promise<ExcelViewerHandle> {
    return mountExcelViewer(input, container, ctx, selfLoadingExcelDeps, options);
}
