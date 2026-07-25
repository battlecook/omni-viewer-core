import type { DocxPreviewModule, WordViewerDeps } from './index.js';
import type { SheetModule, ZipModule } from './docx-preprocess.js';

export interface LoadWordViewerDepsOptions {
    /** Defaults to true. false prevents any xlsx import and disables previews. */
    embeddedSheets?: boolean;
}

export async function loadWordViewerDeps(
    options: LoadWordViewerDepsOptions = {}
): Promise<WordViewerDeps> {
    const [zipImport, module] = await Promise.all([
        import('jszip' as string),
        import('docx-preview' as string)
    ]);
    const zip = (zipImport as { default?: ZipModule }).default ?? zipImport as unknown as ZipModule;
    const docx = module.default ?? module;
    return {
        loadDocxPreview: async () => docx as DocxPreviewModule,
        loadZip: async () => zip,
        ...(options.embeddedSheets === false
            ? {}
            : {
                loadSheet: async () => {
                    const sheetImport = await import('xlsx' as string);
                    return sheetImport as unknown as SheetModule;
                }
            })
    };
}
