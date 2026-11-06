import type { ClipboardService, FileSaveService, HostContext } from '../../host/index.js';
import { parseEml, type EmlDocument } from '../../parsers/eml/index.js';
import { utf8ByteLength, type Diagnostic } from '../../parsers/types.js';
import { HTML_PREVIEW_MAX_BYTES, HTML_PREVIEW_MAX_DELIMITERS, htmlPreviewDocument } from '../html/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { emlViewerCss } from './styles.js';

export { emlViewerCss } from './styles.js';
export { parseEml, safeEmlFileName, EML_INPUT_OWNERSHIP, EML_MAX_INPUT_BYTES } from '../../parsers/eml/index.js';
export type { EmlDocument, EmlAttachment, EmlHeader, EmlParseOptions } from '../../parsers/eml/index.js';
export const EML_VIEWER_META = {
    id: 'eml', displayNameKey: 'eml.title', extensions: ['eml'], priority: 20,
    requiredServices: [] as const, optionalServices: ['clipboard', 'save'] as const,
    inputOwnership: 'borrows' as const
};
export type EmlViewerContext = HostContext & { clipboard?: ClipboardService; save?: FileSaveService };

const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** Resolve only embedded raster images; the shared HTML sanitizer enforces the frame policy. */
function previewHtml(model: EmlDocument): string | undefined {
    let expandedBytes = utf8ByteLength(model.html);
    if (expandedBytes > HTML_PREVIEW_MAX_BYTES) return undefined;
    let delimiters = 0;
    for (let at = model.html.indexOf('<'); at >= 0; at = model.html.indexOf('<', at + 1)) if (++delimiters > HTML_PREVIEW_MAX_DELIMITERS) return undefined;
    const template = document.createElement('template');
    template.innerHTML = model.html;
    let inlineBytes = 0;
    const urls = new Map<string, string>();
    const embeddedImages = new Map<string, string>();
    for (const image of template.content.querySelectorAll('img[src]')) {
        const src = image.getAttribute('src')!.trim();
        if (!/^cid:/i.test(src)) continue;
        let id = src.slice(4);
        try { id = decodeURIComponent(id); } catch { /* Preserve a malformed ID for lookup. */ }
        const attachment = model.htmlResources.find(item => item.contentId === id);
        if (!attachment || !/^image\/(png|jpeg|gif|webp)$/i.test(attachment.contentType)) continue;
        // srcdoc repeats a data URL for every image, including cache hits.
        // Count occurrences before substitution to bound the serialized frame.
        inlineBytes += attachment.data.length;
        if (inlineBytes > MAX_INLINE_BYTES) return undefined;
        let url = urls.get(id);
        if (!url) {
            const chunks: string[] = [];
            for (let at = 0; at < attachment.data.length; at += 8192) chunks.push(String.fromCharCode(...attachment.data.subarray(at, at + 8192)));
            url = `data:${attachment.contentType};base64,${btoa(chunks.join(''))}`;
            urls.set(id, url);
        }
        expandedBytes += url.length;
        if (expandedBytes > HTML_PREVIEW_MAX_BYTES) return undefined;
        embeddedImages.set(src, url);
    }
    return htmlPreviewDocument(model.html, embeddedImages);
}

export async function mountEmlViewer(input: ViewerInput, container: HTMLElement, ctx: EmlViewerContext, options: MountOptions = {}): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const { result } = parseEml(input.data, options.signal ? { signal: options.signal } : {});
    if (options.signal?.aborted) throw new MountAbortedError();
    const source = new TextDecoder().decode(input.data.subarray(0, MAX_SOURCE_BYTES));
    return mountDocument(result.status === 'failed' ? undefined : result.document, input.fileName, source, input.data.length > MAX_SOURCE_BYTES,
        result.status === 'failed' ? [...result.diagnostics, { severity: 'error', code: result.failure.code, messageKey: result.failure.messageKey }] : result.diagnostics,
        container, ctx, options);
}

function mountDocument(model: EmlDocument | undefined, fileName: string, source: string, sourceTruncated: boolean, diagnostics: Diagnostic[], container: HTMLElement, ctx: EmlViewerContext, options: MountOptions): ViewerHandle {
    const t = ctx.i18n.t.bind(ctx.i18n);
    let root: HTMLElement | ShadowRoot = container;
    let style: HTMLStyleElement | undefined;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && container.attachShadow) {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        style = element('style'); style.textContent = emlViewerCss; root.append(style);
    } else container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--eml');
    const frame = element('section', 'omni-eml');
    const header = element('header', 'omni-eml__header');
    header.append(element('div', 'omni-eml__filename', fileName), element('h1', undefined, model?.subject || t('eml.noSubject')));
    frame.append(header);
    const status = element('div', 'omni-eml__status'); status.setAttribute('role', 'status');
    for (const diagnostic of diagnostics) status.append(element('p', undefined, t(diagnostic.messageKey, diagnostic.args)));
    frame.append(status);
    if (model) {
        const metadata = element('dl', 'omni-eml__metadata');
        for (const field of ['from', 'to', 'cc', 'bcc', 'replyTo', 'date', 'messageId'] as const) {
            if (model[field]) metadata.append(element('dt', undefined, t(`eml.${field}`)), element('dd', undefined, model[field]));
        }
        frame.append(metadata);
    }
    const toolbar = element('div', 'omni-eml__toolbar');
    const content = element('main', 'omni-eml__content');
    const buttons = new Map<string, HTMLButtonElement>();
    const panes = new Map<string, HTMLElement>();
    const listeners: Array<() => void> = [];
    let disposed = false;
    const onClick = (button: HTMLButtonElement, callback: () => void) => {
        const listener = () => { if (!disposed) callback(); };
        button.addEventListener('click', listener);
        listeners.push(() => button.removeEventListener('click', listener));
    };
    const select = (view: string) => {
        for (const [id, pane] of panes) pane.hidden = id !== view;
        for (const [id, button] of buttons) button.setAttribute('aria-pressed', String(id === view));
    };
    const addPane = (id: string, pane: HTMLElement) => {
        const button = element('button', undefined, t(`eml.${id}`)); button.type = 'button';
        onClick(button, () => select(id)); buttons.set(id, button); panes.set(id, pane);
        toolbar.append(button); content.append(pane);
    };
    let preview: HTMLIFrameElement | undefined;
    if (model?.html) {
        const html = previewHtml(model);
        if (html !== undefined) {
            preview = element('iframe', 'omni-eml__html'); preview.title = t('eml.html');
            preview.setAttribute('sandbox', ''); preview.referrerPolicy = 'no-referrer'; preview.srcdoc = html;
            addPane('html', preview);
        } else status.append(element('p', undefined, t('eml.htmlUnavailable')));
    }
    if (model?.text) addPane('text', element('pre', 'omni-eml__text', model.text));
    if (model && !model.text && !model.html) content.append(element('p', 'omni-eml__empty', t('eml.noBody')));
    if (model) {
        const headers = element('dl', 'omni-eml__metadata');
        for (const header of model.headers) headers.append(element('dt', undefined, header.name), element('dd', undefined, header.value));
        addPane('headers', headers);
    }
    const sourcePane = element('div');
    if (sourceTruncated) sourcePane.append(element('p', undefined, t('eml.sourceTruncated', { limit: MAX_SOURCE_BYTES })));
    sourcePane.append(element('pre', 'omni-eml__source', source)); addPane('source', sourcePane);
    const copy = element('button', undefined, t('eml.copyText')); copy.type = 'button';
    copy.disabled = !ctx.clipboard || !model?.text;
    onClick(copy, () => {
        if (!ctx.clipboard || !model?.text) return;
        void ctx.clipboard.writeText(model.text).catch(() => { if (!disposed) status.append(element('p', undefined, t('eml.copyFailed'))); });
    });
    toolbar.append(copy); frame.append(toolbar, content);
    if (model?.attachments.length) {
        const section = element('section', 'omni-eml__attachments');
        section.append(element('h2', undefined, t('eml.attachments', { count: model.attachments.length })));
        const list = element('ul');
        for (const attachment of model.attachments) {
            const row = element('li');
            row.append(element('span', 'omni-eml__attachment-name', attachment.fileName), element('span', 'omni-eml__attachment-type', `${attachment.contentType} · ${attachment.data.length} B`));
            const save = element('button', undefined, t('eml.saveAttachment')); save.type = 'button'; save.disabled = !ctx.save;
            save.setAttribute('aria-label', t('eml.saveNamedAttachment', { name: attachment.fileName }));
            if (!ctx.save) save.title = t('eml.noSave');
            onClick(save, () => {
                if (!ctx.save) return;
                save.disabled = true;
                void ctx.save.saveFile(attachment.fileName, attachment.data.slice(), attachment.contentType)
                    .catch(() => { if (!disposed) status.append(element('p', undefined, t('eml.saveFailed'))); })
                    .finally(() => { if (!disposed) save.disabled = false; });
            });
            row.append(save); list.append(row);
        }
        section.append(list); frame.append(section);
    }
    select(preview ? 'html' : model?.text ? 'text' : 'source');
    root.append(frame);
    return {
        dispose() {
            if (disposed) return;
            disposed = true; for (const remove of listeners) remove();
            preview?.removeAttribute('srcdoc'); frame.remove(); style?.remove();
            if (root === container) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--eml');
        }
    };
}
