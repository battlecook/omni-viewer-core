import { ALLOWED_LINK_SCHEMES, type DocumentAssetsService, type HostContext, type NavigationService } from '../../host/index.js';
import { parseNotebook, type NotebookCell, type NotebookParseOptions, type NotebookRepresentation } from '../../parsers/notebook/index.js';
import { bindFragmentAnchor, classifyAnchorTarget } from '../anchors.js';
import { sanitizeSvg } from '../diagram.js';
import type { MarkdownViewerDeps } from '../markdown/index.js';
import { maskMathSegments, mathSegmentLiteral, type MaskedMathSource, type MathSegment } from '../markdown/math.js';
import { MARKDOWN_SANITIZE_PROFILE } from '../markdown/sanitize.js';
import { MATH_SANITIZE_PROFILE } from '../math.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { notebookViewerCss } from './styles.js';

export { parseNotebook, type NotebookDocument, type NotebookCell, type NotebookOutput, type NotebookRepresentation, type NotebookParseOptions } from '../../parsers/notebook/index.js';
export { notebookViewerCss } from './styles.js';
export const NOTEBOOK_VIEWER_META = {
    id: 'notebook', displayNameKey: 'notebook.title', extensions: ['ipynb'], priority: 20,
    requiredServices: [] as const, optionalServices: ['navigation', 'documentAssets'] as const,
    inputOwnership: 'borrows' as const
};
export type NotebookViewerDeps = Pick<MarkdownViewerDeps, 'render' | 'createDOMPurify' | 'highlighter' | 'math'>;
export type NotebookViewerContext = HostContext & { navigation?: NavigationService; documentAssets?: DocumentAssetsService };
export interface NotebookMountOptions extends MountOptions, NotebookParseOptions {}

/** Read-only preview: code is text and outputs are the results saved in the file. */
export async function mountNotebookViewer(
    input: ViewerInput, container: HTMLElement, ctx: NotebookViewerContext,
    deps: NotebookViewerDeps, options: NotebookMountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const parsed = parseNotebook(input.data, options);
    if (parsed.result.status === 'failed') {
        if (parsed.result.failure.code === 'aborted') throw new MountAbortedError();
        throw new Error(ctx.i18n.t(parsed.result.failure.messageKey, parsed.result.failure.args));
    }
    const notebook = parsed.result.document;
    const doc = container.ownerDocument;
    const view = doc.defaultView!;
    const purifier = deps.createDOMPurify(view);
    const t = ctx.i18n.t.bind(ctx.i18n);
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
        const node = doc.createElement(tag); if (className) node.className = className;
        if (text !== undefined) node.textContent = text; return node;
    };
    const disposers: Array<() => void> = [];
    const releases = new Set<() => void>();
    const imageUrls = new Map<NotebookRepresentation, string | null>();
    const attachmentReferences = new Map<string, NotebookRepresentation[]>();
    const nonce = (): string => [...view.crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16)).join('-');
    const attachmentPrefix = `omni-notebook-attachment-${nonce()}/`;
    const classes: string[] = [];
    let disposed = false;
    const on = (node: EventTarget, type: string, listener: EventListener): void => {
        node.addEventListener(type, listener); disposers.push(() => node.removeEventListener(type, listener));
    };
    const shell = el('section', `${VIEWER_ROOT_CLASS} omni-viewer--notebook omni-notebook omni-markdown`);
    const style = el('style'); style.textContent = notebookViewerCss;
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        for (const off of disposers) off();
        for (const release of [...releases]) release();
        imageUrls.clear(); attachmentReferences.clear();
        disposers.length = 0; shell.remove(); style.remove();
        container.classList.remove(...classes);
    };
    const note = (key: string): HTMLElement => el('p', 'omni-notebook__warning', t(key));
    const pre = (text: string, className = 'omni-notebook__text'): HTMLPreElement => el('pre', className, stripAnsi(text));
    const highlight = (code: HTMLElement, source: string, language: string): void => {
        code.textContent = source;
        try {
            if (!deps.highlighter || !language || !deps.highlighter.getLanguage(language)) return;
            code.innerHTML = purifier.sanitize(deps.highlighter.highlight(source, { language, ignoreIllegals: true }).value,
                { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] }); code.classList.add('hljs');
        } catch { code.textContent = source; }
    };
    const math = (segment: MathSegment): HTMLElement => {
        const node = el('span', `omni-markdown__math${segment.display ? ' omni-markdown__math--display' : ''}`);
        const literal = mathSegmentLiteral({ source: segment.source, display: segment.display });
        try {
            if (deps.math) node.innerHTML = purifier.sanitize(deps.math.renderToHtml(segment.source, segment.display), MATH_SANITIZE_PROFILE);
            else node.textContent = literal;
        } catch { node.textContent = literal; }
        return node;
    };
    const imageUrl = (representation: NotebookRepresentation): string | null => {
        if (imageUrls.has(representation)) return imageUrls.get(representation)!;
        const unavailable = (): null => { imageUrls.set(representation, null); return null; };
        if (representation.truncated) return unavailable();
        const retain = (dataUrl: string, blob: Blob): string => {
            // Blob URLs keep repeated attachment references short in the DOM
            // as well as in sanitizer input. Older hosts fall back to data URLs.
            let url = dataUrl;
            if (typeof view.URL.createObjectURL === 'function' && typeof view.URL.revokeObjectURL === 'function') {
                url = view.URL.createObjectURL(blob);
                const release = (): void => { releases.delete(release); view.URL.revokeObjectURL(url); };
                releases.add(release);
            }
            imageUrls.set(representation, url);
            return url;
        };
        try {
            if (representation.mimeType === 'image/svg+xml') {
                // Existing diagram sanitizer; an SVG image keeps its CSS and ids
                // isolated from the notebook and the surrounding host document.
                const svg = sanitizeSvg(representation.text);
                const xml = new view.XMLSerializer().serializeToString(svg);
                return retain(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`, new view.Blob([xml], { type: 'image/svg+xml' }));
            }
            if (!/^image\/(?:png|jpeg|gif|webp)$/.test(representation.mimeType)) return unavailable();
            const base64 = representation.text.replace(/\s/g, '');
            const padding = base64.indexOf('=');
            if (!base64 || base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(base64) ||
                padding >= 0 && (padding < base64.length - 2 || !/^={1,2}$/.test(base64.slice(padding)))) return unavailable();
            const binary = view.atob(base64);
            const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
            return retain(`data:${representation.mimeType};base64,${base64}`, new view.Blob([bytes], { type: representation.mimeType }));
        } catch { return unavailable(); }
    };
    const missingImage = (image: HTMLImageElement): void => image.replaceWith(el('span', 'omni-notebook__note', image.alt || t('notebook.assetUnavailable')));
    const images = (content: ParentNode, cell: NotebookCell): void => {
        for (const image of content.querySelectorAll('img')) {
            const path = image.getAttribute('src') ?? '';
            image.removeAttribute('src'); image.removeAttribute('srcset');
            image.loading = 'lazy';
            on(image, 'error', (() => missingImage(image)) as EventListener);
            if (attachmentReferences.has(path)) {
                const url = attachmentReferences.get(path)!.map(imageUrl).find(Boolean);
                if (url) image.src = url; else missingImage(image);
            }
            else if (path.startsWith('attachment:')) {
                let name = path.slice(11); try { name = decodeURIComponent(name); } catch { /* Literal filename. */ }
                const url = (cell.attachments[name] ?? []).map(imageUrl).find(Boolean);
                if (url) image.src = url; else missingImage(image);
            } else if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(path)) {
                const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]*)$/i.exec(path)!;
                const url = imageUrl({ mimeType: match[1]!.toLowerCase(), text: match[2]!, truncated: false });
                if (url) image.src = url; else missingImage(image);
            } else if (validRelativeAsset(path) && ctx.documentAssets) {
                void ctx.documentAssets.resolve(path).then(asset => {
                    if (!asset) { if (!disposed) missingImage(image); return; }
                    let released = false;
                    const release = (): void => { if (released) return; released = true; releases.delete(release); asset.dispose(); };
                    if (disposed) { release(); return; }
                    releases.add(release); image.src = asset.url;
                }).catch(() => { if (!disposed) missingImage(image); });
            } else { missingImage(image); blockedResources = true; }
        }
    };
    let blockedResources = false;
    const attachmentImages = (html: string, cell: NotebookCell, masked: MaskedMathSource & { prefix: string }): string => {
        // DOMPurify rejects attachment: URLs. Use short inert references while
        // sanitizing; repeating an attachment must not repeat its entire payload.
        // Parsing an inert template handles both quote styles and HTML entities
        // without initiating resource loads. Sanitization still follows below.
        const template = el('template'); template.innerHTML = html;
        if (masked.segments.length) {
            const pattern = new RegExp(`%%${masked.prefix}(\\d+)%%`, 'g');
            const restore = (text: string): string => text.replace(pattern, (token, index: string) => {
                const segment = masked.segments[Number(index)];
                return segment ? mathSegmentLiteral(segment) : token;
            });
            // Let the Markdown parser identify code and metadata. This covers
            // indented/nested code and link destinations/titles without needing
            // to duplicate every Markdown grammar rule in the math scanner.
            for (const node of template.content.querySelectorAll('*')) {
                for (const attribute of [...node.attributes]) {
                    const value = restore(attribute.value);
                    if (value !== attribute.value) node.setAttribute(attribute.name, value);
                }
            }
            const walker = doc.createTreeWalker(template.content, view.NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const node = walker.currentNode as Text;
                if (node.parentElement?.closest('pre,code,kbd,samp')) node.nodeValue = restore(node.nodeValue ?? '');
            }
        }
        for (const image of template.content.querySelectorAll('img')) {
            const path = image.getAttribute('src') ?? '';
            if (!/^attachment:/i.test(path)) continue;
            let name = path.slice(11);
            try { name = decodeURIComponent(name); } catch { /* Literal filename. */ }
            const bundle = cell.attachments[name];
            if (!bundle) continue;
            const reference = `${attachmentPrefix}${attachmentReferences.size}`;
            attachmentReferences.set(reference, bundle);
            image.setAttribute('src', reference);
        }
        return template.innerHTML;
    };
    const maskMath = (source: string, preserveHtml = false) => {
        // A fresh namespace also survives HTML entity/Markdown unescaping:
        // literal text resembling the shared Markdown tokens stays literal.
        let prefix: string;
        do {
            prefix = `omni-notebook-math-${nonce()}-token-`;
        } while (source.includes(prefix));
        return { ...maskMathSegments(source, { tokenPrefix: prefix, preserveHtml, preserveMarkdown: preserveHtml, retainLiteral: true }), prefix };
    };
    const markup = (source: string, cell: NotebookCell, markdown: boolean): HTMLElement => {
        const content = el('div', 'omni-markdown__preview');
        const template = el('template');
        // Markdown math is protected from the Markdown parser. HTML already
        // has structure: masking the whole string would corrupt code/attributes.
        const masked = markdown ? maskMath(source, true) : { masked: source, segments: [], prefix: '' };
        try {
            const html = markdown ? deps.render.parse(masked.masked) : masked.masked;
            template.innerHTML = purifier.sanitize(attachmentImages(html, cell, masked), MARKDOWN_SANITIZE_PROFILE);
            // Template contents are inert: image requests cannot begin before
            // resource attributes are hardened, even while the viewer is detached.
            const fragment = template.content;
            for (const node of fragment.querySelectorAll('audio,video,source,link,meta,base,picture')) {
                node.remove(); blockedResources = true;
            }
            for (const node of fragment.querySelectorAll('[background],[poster],[srcset]')) {
                for (const attribute of ['background', 'poster', 'srcset']) node.removeAttribute(attribute);
                blockedResources = true;
            }
            for (const node of fragment.querySelectorAll('[src]')) if (node.tagName !== 'IMG') {
                node.removeAttribute('src'); blockedResources = true;
            }
            images(fragment, cell);
            for (const code of fragment.querySelectorAll<HTMLElement>('pre > code')) {
                const language = [...code.classList].find(name => name.startsWith('language-'))?.slice(9) ?? '';
                highlight(code, code.textContent ?? '', language);
            }
            const walker = doc.createTreeWalker(fragment, view.NodeFilter.SHOW_TEXT);
            const nodes: Text[] = [];
            while (walker.nextNode()) {
                const node = walker.currentNode as Text;
                if (!node.parentElement?.closest('pre,code,kbd,samp')) nodes.push(node);
            }
            for (const node of nodes) {
                const value = markdown ? { masked: node.nodeValue ?? '', segments: masked.segments, prefix: masked.prefix }
                    : maskMath(node.nodeValue ?? '');
                if (!value.segments.length || !value.masked.includes(`%%${value.prefix}`)) continue;
                const pattern = new RegExp(`(%%${value.prefix}\\d+%%)`);
                const exact = new RegExp(`^%%${value.prefix}(\\d+)%%$`);
                const fragment = doc.createDocumentFragment();
                for (const part of value.masked.split(pattern)) {
                    const match = exact.exec(part);
                    const segment = match ? value.segments[Number(match[1])] : undefined;
                    fragment.append(segment ? math(segment) : doc.createTextNode(part));
                }
                node.replaceWith(fragment);
            }
            content.append(template.content);
        } catch { content.replaceChildren(note('notebook.renderFailed'), pre(source)); }
        return content;
    };
    const rich = (representations: NotebookRepresentation[], cell: NotebookCell): HTMLElement => {
        for (const representation of representations) {
            if (representation.truncated) continue;
            const { mimeType, text } = representation;
            if (mimeType.startsWith('image/')) {
                const url = imageUrl(representation); if (!url) continue;
                const image = el('img', 'omni-notebook__image'); image.alt = t('notebook.imageOutput');
                image.loading = 'lazy'; image.src = url;
                if (representation.width) image.width = representation.width;
                if (representation.height) image.height = representation.height;
                on(image, 'error', (() => missingImage(image)) as EventListener);
                return image;
            }
            if (mimeType === 'text/html' || mimeType === 'text/markdown') return markup(text, cell, mimeType === 'text/markdown');
            if (mimeType === 'text/latex') {
                const content = el('div', 'omni-markdown__preview');
                let expression = text.trim();
                const escaped = (index: number): boolean => {
                    let slashes = 0;
                    for (let cursor = index - 1; cursor >= 0 && expression[cursor] === '\\'; cursor--) slashes++;
                    return slashes % 2 === 1;
                };
                for (const [start, end] of [['$$', '$$'], ['$', '$'], ['\\[', '\\]'], ['\\(', '\\)']] as const) {
                    if (start === '$' && expression.startsWith('$$')) continue;
                    if (expression.length >= start.length + end.length && expression.startsWith(start) && expression.endsWith(end) &&
                        !escaped(expression.length - end.length)) {
                        expression = expression.slice(start.length, -end.length); break;
                    }
                }
                content.append(math({ source: expression, display: true })); return content;
            }
            return pre(text);
        }
        const plain = representations.find(value => value.mimeType === 'text/plain');
        const content = el('div');
        content.append(note(representations.some(value => value.truncated) ? 'notebook.truncatedOutput' : 'notebook.unsupportedOutput'));
        if (plain) content.append(pre(plain.text));
        return content;
    };

    try {
        const header = el('header', 'omni-notebook__header');
        const info = el('div');
        info.append(el('h1', 'omni-notebook__title', input.fileName), el('div', 'omni-notebook__summary',
            t('notebook.summary', { cells: notebook.cells.length, total: notebook.totalCells, outputs: notebook.outputCount, errors: notebook.errorCount })));
        header.append(info, el('span', 'omni-notebook__note', [notebook.kernelName || notebook.language, `nbformat ${notebook.nbformat}.${notebook.nbformatMinor}`].filter(Boolean).join(' · ')));
        const toolbar = el('div', 'omni-notebook__toolbar');
        const search = el('input'); search.type = 'search'; search.placeholder = t('notebook.search'); search.setAttribute('aria-label', t('notebook.search'));
        toolbar.append(search);
        const visibility: Array<{ input: HTMLInputElement; selector: string }> = [];
        for (const [key, selector] of [['notebook.showCode', '.omni-notebook__source'], ['notebook.showOutputs', '.omni-notebook__outputs']] as const) {
            const label = el('label'); const toggle = el('input'); toggle.type = 'checkbox'; toggle.checked = true;
            label.append(toggle, doc.createTextNode(t(key))); toolbar.append(label); visibility.push({ input: toggle, selector });
        }
        shell.append(header, el('div', 'omni-notebook__note', t('notebook.savedOutputs')), toolbar);
        for (const diagnostic of parsed.result.diagnostics) shell.append(el('p', 'omni-notebook__warning', t(diagnostic.messageKey, diagnostic.args)));
        const viewport = el('main', 'omni-notebook__cells'); viewport.setAttribute('aria-label', t('notebook.cells'));
        const cards: HTMLElement[] = [];
        for (const cell of notebook.cells) {
            const card = el('article', 'omni-notebook__cell'); card.dataset.cellIndex = String(cell.index);
            const hasError = cell.outputs.some(output => output.type === 'error');
            const heading = el('header', `omni-notebook__cell-header${hasError ? ' is-error' : ''}`);
            heading.append(el('span', undefined, t('notebook.cell', { index: cell.index + 1 })), el('span', undefined, t(`notebook.${cell.type}`)));
            if (cell.type === 'code') heading.append(el('span', 'omni-notebook__prompt', `In [${cell.executionCount ?? ' '}]:`));
            card.append(heading);
            if (cell.type === 'markdown') card.append(markup(cell.source, cell, true));
            else if (cell.type === 'code') {
                const source = el('details', 'omni-notebook__source'); source.open = !cell.sourceHidden;
                const block = el('pre'), code = el('code'); highlight(code, cell.source, notebook.language);
                block.append(code); source.append(el('summary', undefined, t('notebook.code')), block); card.append(source);
            } else card.append(pre(cell.source, 'omni-notebook__raw'));
            if (cell.outputs.length) {
                const outputs = el('details', 'omni-notebook__outputs'); outputs.open = !cell.outputsHidden;
                outputs.append(el('summary', undefined, t('notebook.outputs', { count: cell.outputs.length })));
                for (const output of cell.outputs) {
                    const content = el('div', 'omni-notebook__output'); content.dataset.outputType = output.type;
                    if (output.type === 'stream') {
                        content.append(el('div', 'omni-notebook__output-label', output.name || 'stdout'),
                            pre(output.text, `omni-notebook__text${output.name === 'stderr' ? ' omni-notebook__stderr' : ''}`));
                    } else if (output.type === 'error') {
                        content.classList.add('omni-notebook__error');
                        content.append(pre([`${output.errorName}${output.errorValue ? `: ${output.errorValue}` : ''}`, output.traceback].filter(Boolean).join('\n')));
                    } else {
                        if (output.type === 'execute_result') content.append(el('div', 'omni-notebook__output-label', `Out [${output.executionCount ?? ' '}]:`));
                        content.append(rich(output.representations, cell));
                    }
                    outputs.append(content);
                }
                card.append(outputs);
            } else if (cell.type === 'code') card.append(el('p', 'omni-notebook__note', t('notebook.noOutputs')));
            cards.push(card); viewport.append(card);
        }
        const empty = el('div', 'omni-notebook__empty', t(notebook.cells.length ? 'notebook.noMatches' : 'notebook.empty'));
        empty.hidden = cards.length > 0; viewport.append(empty); shell.append(viewport);
        if (blockedResources) shell.append(note('notebook.blockedResources'));
        // All cells now exist, so cross-cell fragment links can be bound too.
        for (const anchor of shell.querySelectorAll<HTMLElement>('a,area')) {
            const href = anchor.getAttribute('href') ?? ''; anchor.removeAttribute('href');
            anchor.removeAttribute('target'); anchor.removeAttribute('ping');
            const target = classifyAnchorTarget(href);
            if (target.kind === 'fragment' && bindFragmentAnchor(anchor, target.name, shell, viewport, disposers)) continue;
            if (target.kind !== 'absolute' || !ALLOWED_LINK_SCHEMES.includes(target.url.protocol) || !ctx.navigation) {
                anchor.setAttribute('aria-disabled', 'true'); continue;
            }
            anchor.setAttribute('role', 'link'); anchor.tabIndex = 0;
            const open = (event: Event): void => { event.preventDefault(); void ctx.navigation!.openExternalUrl(href).catch(() => {}); };
            on(anchor, 'click', open);
            on(anchor, 'keydown', ((event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') open(event); }) as EventListener);
        }
        for (const { input: toggle, selector } of visibility) on(toggle, 'change', (() => {
            for (const node of shell.querySelectorAll<HTMLElement>(selector)) node.hidden = !toggle.checked;
        }) as EventListener);
        on(search, 'input', (() => {
            const query = search.value.trim().toLowerCase();
            for (const card of cards) card.hidden = !(card.textContent ?? '').toLowerCase().includes(query);
            empty.hidden = cards.some(card => !card.hidden);
        }) as EventListener);
        if (options.signal?.aborted) throw new MountAbortedError();
        const root = options.styleIsolation !== 'scoped' && typeof container.attachShadow === 'function'
            ? (container.shadowRoot ?? container.attachShadow({ mode: 'open' })) : container;
        if (root !== container) root.append(style);
        else for (const name of [VIEWER_ROOT_CLASS, 'omni-viewer--notebook']) if (!container.classList.contains(name)) {
            classes.push(name); container.classList.add(name);
        }
        root.append(shell);
        return { dispose };
    } catch (error) { dispose(); throw error; }
}

function validRelativeAsset(path: string): boolean {
    try { const decoded = decodeURIComponent(path); return !!decoded && decoded === decoded.trim() && !/[\u0000-\u001f\u007f]/.test(decoded) &&
        !/^(?:[a-z][a-z0-9+.-]*:|[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(decoded); }
    catch { return false; }
}
/** Remove terminal CSI/OSC sequences; never turn a traceback into HTML. */
function stripAnsi(text: string): string {
    return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}
