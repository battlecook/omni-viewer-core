import type { HostContext } from '../../host/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { htmlViewerCss } from './styles.js';

export { htmlViewerCss } from './styles.js';

export const HTML_VIEWER_META = {
    id: 'html', displayNameKey: 'html.title', extensions: ['html', 'htm'] as string[], priority: 10,
    requiredServices: [] as const, optionalServices: [] as const,
    inputOwnership: 'borrows' as const
};

/** Avoid decoding and embedding an unbounded document in both the source pane and iframe. */
export const HTML_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
export const HTML_PREVIEW_MAX_DELIMITERS = 20_000;
const SOURCE_HEAD_BYTES = 256 * 1024;

function hasExcessiveMarkup(source: string): boolean {
    // Every parsed element needs source markup. Count delimiters before any
    // DOM parsing so dense, small files cannot create an unbounded DOM tree.
    let count = 0;
    for (let index = source.indexOf('<'); index !== -1; index = source.indexOf('<', index + 1)) {
        if (++count > HTML_PREVIEW_MAX_DELIMITERS) return true;
    }
    return false;
}

// The iframe has an opaque origin and no sandbox permissions. This policy is
// deliberately inside srcdoc as well: host CSPs cannot be relied on to protect
// the frame in every adapter. Inline CSS and embedded images remain usable.
const PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; navigate-to 'none'";

function tagEnd(source: string, from: number): number {
    let quote = '';
    for (let index = from; index < source.length; index++) {
        const char = source[index];
        if (quote) { if (char === quote) quote = ''; }
        else if (char === '"' || char === "'") quote = char;
        else if (char === '>') return index;
    }
    return -1;
}

/** Scan opening tags without mistaking comments, attributes, or raw text for markup. */
function* openingTags(source: string): Generator<{ name: string; attributes: string }> {
    let index = 0;
    let templateDepth = 0;
    while (index < source.length) {
        const start = source.indexOf('<', index);
        if (start < 0) return;
        if (source.startsWith('<!--', start)) {
            const end = source.indexOf('-->', start + 4);
            index = end < 0 ? source.length : end + 3;
            continue;
        }
        const templateEnd = /^<\/template(?=[\s/>])/i.exec(source.slice(start, start + 32));
        if (templateEnd && templateDepth > 0) {
            const end = tagEnd(source, start + templateEnd[0].length);
            if (end < 0) return;
            templateDepth--;
            index = end + 1;
            continue;
        }
        const found = /^<([a-z][\w:-]*)\b/i.exec(source.slice(start, start + 64));
        if (!found) { index = start + 1; continue; }
        const name = found[1]!.toLowerCase();
        const end = tagEnd(source, start + found[0].length);
        if (end < 0) return;
        index = end + 1;
        if (name === 'template') { templateDepth++; continue; }
        if (templateDepth === 0) yield { name, attributes: source.slice(start + found[0].length, end) };
        if (['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'noembed', 'noframes'].includes(name)) {
            const closing = new RegExp(`</${name}(?=[\\s/>])`, 'ig');
            closing.lastIndex = index;
            const match = closing.exec(source);
            const closeEnd = match ? tagEnd(source, closing.lastIndex) : -1;
            index = closeEnd < 0 ? source.length : closeEnd + 1;
        }
    }
}

function safeRootAttributes(source: string, tag: 'html' | 'body'): string {
    // Parsing a complete document in a template drops its root elements. Read
    // their opening tags separately so selectors like body.page still work.
    let match: { name: string; attributes: string } | undefined;
    for (const candidate of openingTags(source)) {
        if (candidate.name === tag) { match = candidate; break; }
    }
    if (!match) return '';
    const holder = document.createElement('template');
    holder.innerHTML = `<div${match.attributes}></div>`;
    const element = holder.content.firstElementChild;
    if (!element) return '';
    return [...element.attributes]
        .filter(({ name }) => ['class', 'id', 'lang', 'dir', 'style'].includes(name) || name.startsWith('data-'))
        .map(({ name, value }) => ` ${name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}\"`)
        .join('');
}

/** Honor a BOM or an early HTML charset declaration before decoding bytes. */
export function decodeHtmlText(data: Uint8Array): string {
    let encoding = 'utf-8';
    if (data[0] === 0xff && data[1] === 0xfe) encoding = 'utf-16le';
    else if (data[0] === 0xfe && data[1] === 0xff) encoding = 'utf-16be';
    else if (!(data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf)) {
        const head = Array.from(data.subarray(0, 1024), byte => String.fromCharCode(byte)).join('');
        for (const tag of openingTags(head)) {
            if (tag.name !== 'meta') continue;
            const holder = document.createElement('template');
            holder.innerHTML = `<meta${tag.attributes}>`;
            const meta = holder.content.firstElementChild;
            const contentCharset = /charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;]+))/i.exec(meta?.getAttribute('content') ?? '');
            const declared = meta?.getAttribute('charset') ??
                (meta?.getAttribute('http-equiv')?.toLowerCase() === 'content-type'
                    ? contentCharset?.[1] ?? contentCharset?.[2] ?? contentCharset?.[3]
                    : undefined);
            if (declared) { encoding = declared; break; }
        }
    }
    try { return new TextDecoder(encoding).decode(data); }
    catch { return new TextDecoder('utf-8').decode(data); }
}

export function htmlPreviewDocument(source: string): string {
    // Template contents are inert and do not load resources while being parsed.
    // Strip navigation and resource attributes too: frame self-navigation is
    // possible in some engines even with an empty sandbox and navigate-to CSP.
    const template = document.createElement('template');
    template.innerHTML = source;
    // <noscript> changes parsing mode when the sandbox disables scripts: its
    // text can become active markup in the iframe, so remove the whole node.
    // Nested templates can become declarative shadow roots when reparsed in
    // srcdoc, and their children are invisible to querySelectorAll here.
    template.content.querySelectorAll('script,noscript,template,base,link,meta,iframe,frame,frameset,object,embed,form,portal').forEach(node => node.remove());
    template.content.querySelectorAll('*').forEach(node => {
        for (const attribute of [...node.attributes]) {
            const name = attribute.name.toLowerCase();
            const value = attribute.value.trim();
            if (name.startsWith('on') || ['srcdoc', 'srcset', 'ping', 'action', 'formaction', 'poster', 'background'].includes(name)) {
                node.removeAttributeNode(attribute);
            } else if (name === 'href' || name === 'xlink:href') {
                if (!value.startsWith('#')) node.removeAttributeNode(attribute);
            } else if (name === 'src') {
                if (node.localName !== 'img' || !/^data:image\/(?:png|jpeg|gif|webp|svg\+xml)(?:;[^,]*)?,/i.test(value)) node.removeAttributeNode(attribute);
            }
        }
    });
    // The policy is before all untrusted content, including malformed heads.
    return `<!doctype html><html${safeRootAttributes(source, 'html')}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"></head><body${safeRootAttributes(source, 'body')}>${template.innerHTML}</body></html>`;
}

export async function mountHtmlViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: HostContext,
    options: MountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();

    const isolation = options.styleIsolation ?? 'shadow';
    let root: HTMLElement | ShadowRoot;
    if (isolation === 'shadow' && typeof container.attachShadow === 'function') {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = htmlViewerCss;
        root.append(style);
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--html');
        root = container;
    }

    const t = ctx.i18n.t.bind(ctx.i18n);
    const frame = document.createElement('section');
    frame.className = 'omni-html';

    const header = document.createElement('header');
    header.className = 'omni-html__header';
    const title = document.createElement('strong');
    title.className = 'omni-html__title';
    title.textContent = input.fileName;
    header.append(title);

    const tabs = document.createElement('div');
    tabs.className = 'omni-html__tabs';
    const previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.textContent = t('html.preview');
    const sourceButton = document.createElement('button');
    sourceButton.type = 'button';
    sourceButton.textContent = t('html.source');
    tabs.append(previewButton, sourceButton);
    header.append(tabs);
    frame.append(header);

    const tooLarge = input.data.byteLength > HTML_PREVIEW_MAX_BYTES;
    const bytes = tooLarge ? input.data.subarray(0, SOURCE_HEAD_BYTES) : input.data;
    const source = decodeHtmlText(bytes);
    const tooComplex = !tooLarge && hasExcessiveMarkup(source);
    const sourceOnly = tooLarge || tooComplex;

    const preview = document.createElement('iframe');
    preview.className = 'omni-html__preview';
    preview.title = t('html.preview');
    preview.setAttribute('sandbox', '');
    preview.referrerPolicy = 'no-referrer';
    // An oversized document is source-only, avoiding partial active markup.
    if (!sourceOnly) preview.srcdoc = htmlPreviewDocument(source);

    const sourcePane = document.createElement('pre');
    sourcePane.className = 'omni-html__source';
    sourcePane.textContent = source;

    if (sourceOnly) {
        const note = document.createElement('p');
        note.className = 'omni-html__note';
        note.textContent = tooLarge
            ? t('html.tooLarge', { limit: HTML_PREVIEW_MAX_BYTES })
            : t('html.tooComplex');
        frame.append(note);
    }
    frame.append(preview, sourcePane);
    root.append(frame);

    const setView = (view: 'preview' | 'source'): void => {
        preview.hidden = view !== 'preview';
        sourcePane.hidden = view !== 'source';
        previewButton.setAttribute('aria-pressed', String(view === 'preview'));
        sourceButton.setAttribute('aria-pressed', String(view === 'source'));
    };
    previewButton.disabled = sourceOnly;
    previewButton.addEventListener('click', () => setView('preview'));
    sourceButton.addEventListener('click', () => setView('source'));
    setView(sourceOnly ? 'source' : 'preview');

    return {
        dispose() {
            preview.removeAttribute('srcdoc');
            root.replaceChildren();
            if (root === container) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--html');
        }
    };
}
