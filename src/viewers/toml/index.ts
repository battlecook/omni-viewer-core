import type { ClipboardService, FileSaveService, FileWritebackService, HostContext } from '../../host/index.js'; import type { MountOptions, ViewerHandle, ViewerInput } from '../types.js'; import { mountStructured } from '../structured.js'; import { structuredViewerCss } from '../structured-styles.js'; import { createTomlController } from './controller.js';
export * from './controller.js'; export { structuredViewerCss as tomlViewerCss } from '../structured-styles.js';
export const TOML_VIEWER_META = { id: 'toml', displayNameKey: 'toml.treeView', extensions: ['toml'], priority: 10, requiredServices: [] as const, optionalServices: ['clipboard', 'save', 'writeback'] as const, inputOwnership: 'borrows' as const };

/** Lightweight TOML source highlighting that preserves the editable textarea. */
function renderTomlSource(target: HTMLElement, text: string): void {
    target.replaceChildren();
    const span = (className: string, value: string) => {
        const node = document.createElement('span'); node.className = className; node.textContent = value; return node;
    };
    for (const line of text.split('\n')) {
        const commentAt = line.search(/\s#/);
        const source = commentAt >= 0 ? line.slice(0, commentAt) : line;
        const comment = commentAt >= 0 ? line.slice(commentAt) : '';
        const table = /^(\s*\[\[?.+?\]?\]\s*)$/.exec(source);
        const assignment = /^(\s*[^=]+?\s*)(=)(.*)$/.exec(source);
        if (table) target.appendChild(span('omni-structured__source-table', source));
        else if (assignment) {
            target.append(span('omni-structured__source-key', assignment[1]!), document.createTextNode('='), span('omni-structured__source-value', assignment[3]!));
        } else target.appendChild(document.createTextNode(source));
        if (comment) target.appendChild(span('omni-structured__source-comment', comment));
        target.appendChild(document.createTextNode('\n'));
    }
}

export function mountTomlViewer(input: ViewerInput, container: HTMLElement, ctx: HostContext & { clipboard?: ClipboardService; save?: FileSaveService; writeback?: FileWritebackService }, options: MountOptions = {}): Promise<ViewerHandle> { return Promise.resolve(mountStructured(input, container, ctx, options, 'omni-viewer--toml', structuredViewerCss, createTomlController(input.data), renderTomlSource)); }
