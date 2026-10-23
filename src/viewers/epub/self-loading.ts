import type { EpubViewerDeps } from './index.js';

/** Convenience loader for web adapters: the sanitizer is the viewer's only peer. */
export async function loadEpubViewerDeps(): Promise<EpubViewerDeps> {
    const purifierModule = await import('dompurify' as string);
    const create = (purifierModule as { default: EpubViewerDeps['createDOMPurify'] }).default;
    return { createDOMPurify: create };
}
