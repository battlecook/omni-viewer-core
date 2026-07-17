import type { DocxPreviewModule, WordViewerDeps } from './index.js';
import type { SheetModule, ZipModule } from './docx-preprocess.js';
export async function loadWordViewerDeps(): Promise<WordViewerDeps> {
    const [zipImport, module, sheetImport] = await Promise.all([import('jszip' as string), import('docx-preview' as string), import('xlsx' as string)]);
    const zip = (zipImport as { default?: ZipModule }).default ?? zipImport as unknown as ZipModule;
    const sheet = sheetImport as unknown as SheetModule;
    const docx = module.default ?? module;
    return { loadDocxPreview: async () => docx as DocxPreviewModule, loadZip: async () => zip, loadSheet: async () => sheet };
}
