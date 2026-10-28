import type { HostContext } from '../../host/index.js';
import { parseFont } from '../../parsers/font/index.js';
import type { ParseOptions } from '../../parsers/types.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { fontViewerCss } from './styles.js';

export { fontViewerCss } from './styles.js';
export * from '../../parsers/font/index.js';
export interface FontMountOptions extends MountOptions, ParseOptions {}
export const FONT_VIEWER_META = {
    id: 'font', displayNameKey: 'font.title', extensions: ['ttf', 'otf', 'woff'], priority: 20,
    magicSignatures: [
        [{ offset: 0, bytes: [0, 1, 0, 0] }], [{ offset: 0, bytes: [0x4f, 0x54, 0x54, 0x4f] }],
        [{ offset: 0, bytes: [0x74, 0x72, 0x75, 0x65] }], [{ offset: 0, bytes: [0x77, 0x4f, 0x46, 0x46] }]
    ],
    requiredServices: [] as const, optionalServices: [] as const, inputOwnership: 'borrows' as const
};
let nextFamily = 0;

/** Loads local bytes via FontFace; never installs the font or requests a URL. */
export async function mountFontViewer(input: ViewerInput, container: HTMLElement, ctx: HostContext, options: FontMountOptions = {}): Promise<ViewerHandle> {
    const signal = options.signal;
    const check = () => { if (signal?.aborted) throw new MountAbortedError(); };
    check();
    const { result } = await parseFont(input.data, options);
    check();
    if (result.status === 'failed') throw new Error(ctx.i18n.t(result.failure.messageKey, result.failure.args));
    const model = result.document, doc = container.ownerDocument, t = ctx.i18n.t.bind(ctx.i18n);
    const family = `omni-font-${++nextFamily}`;
    let face: FontFace | undefined, available = false;
    const FontFaceClass = doc.defaultView?.FontFace;
    if (FontFaceClass && doc.fonts) {
        try {
            face = new FontFaceClass(family, new Uint8Array(input.data).buffer);
            let cancel: (() => void) | undefined;
            try {
                await Promise.race([
                    face.load(),
                    new Promise<never>((_, reject) => {
                        cancel = () => reject(new MountAbortedError());
                        signal?.addEventListener('abort', cancel, { once: true });
                        if (signal?.aborted) cancel();
                    })
                ]);
            } finally { if (cancel) signal?.removeEventListener('abort', cancel); }
            check();
            doc.fonts.add(face); available = true;
        } catch { check(); }
    }
    check();
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
        const node = doc.createElement(tag); node.className = `omni-font__${cls}`;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const shell = el('section', 'frame'); shell.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--font', 'omni-font');
    const heading = el('header', 'header');
    heading.append(el('h2', 'title', model.fullName || model.family || input.fileName), el('p', 'filename', input.fileName));
    const warnings = el('div', 'warnings'); warnings.setAttribute('role', 'status');
    for (const diagnostic of result.diagnostics) warnings.append(el('p', 'warning', t(diagnostic.messageKey, diagnostic.args)));
    if (!available) warnings.append(el('p', 'warning', t('font.unavailable')));
    warnings.hidden = !warnings.childNodes.length;
    const content = el('main', 'content');
    const metadata = el('dl', 'metadata');
    const fields: Array<[string, string | number]> = [
        ['format', model.format], ['family', model.family], ['style', model.subfamily], ['postScriptName', model.postScriptName],
        ['version', model.version], ['glyphCount', model.glyphCount], ['unitsPerEm', model.unitsPerEm], ['weight', model.weight],
        ['copyright', model.copyright], ['license', model.license]
    ];
    for (const [key, value] of fields) if (value !== '') metadata.append(el('dt', 'label', t(`font.${key}`)), el('dd', 'value', String(value)));
    const preview = el('section', 'preview'); preview.hidden = !available;
    const textLabel = el('label', 'text-label', t('font.sample'));
    const text = el('textarea', 'text'); text.value = t('font.defaultSample'); text.maxLength = 4096; text.rows = 3; textLabel.append(text);
    const sizeLabel = el('label', 'size-label', t('font.size'));
    const size = el('input', 'size'); size.type = 'range'; size.min = '12'; size.max = '120'; size.value = '48';
    const sizeValue = el('output', 'size-value', '48 px'); sizeLabel.append(size, sizeValue);
    const specimen = el('div', 'specimen', text.value); specimen.style.fontFamily = `"${family}"`;
    specimen.style.fontSize = '48px'; specimen.style.fontWeight = String(model.weight); specimen.style.fontStyle = model.italic ? 'italic' : 'normal';
    const controls = el('div', 'controls'); controls.append(sizeLabel);
    preview.append(textLabel, el('p', 'hint', t('font.fallback')), controls, specimen);
    const glyphPanel = el('section', 'characters'); glyphPanel.hidden = !available;
    const searchLabel = el('label', 'search-label', t('font.search'));
    const search = el('input', 'search'); search.type = 'search'; search.maxLength = 128; searchLabel.append(search);
    const grid = el('div', 'grid'); grid.setAttribute('role', 'list'); grid.setAttribute('aria-label', t('font.characters'));
    const pagination = el('div', 'pagination');
    const previous = el('button', 'previous', t('font.previous')), next = el('button', 'next', t('font.next'));
    previous.type = next.type = 'button';
    const status = el('span', 'status'); status.setAttribute('role', 'status'); pagination.append(previous, status, next);
    glyphPanel.append(el('h3', 'section-title', t('font.characters')), searchLabel, grid, pagination);
    content.append(metadata, preview, glyphPanel); shell.append(heading, warnings, content);
    const listeners: Array<() => void> = [];
    const on = (target: EventTarget, type: string, handler: EventListener) => {
        target.addEventListener(type, handler); listeners.push(() => target.removeEventListener(type, handler));
    };
    let page = 0;
    const render = () => {
        const query = search.value.trim().toUpperCase();
        const characters = model.characters.filter(c => !query || String.fromCodePoint(c.codePoint).toUpperCase().includes(query) || `U+${c.codePoint.toString(16).toUpperCase().padStart(4, '0')}`.includes(query));
        const pages = Math.max(1, Math.ceil(characters.length / 128)); page = Math.min(page, pages - 1);
        grid.replaceChildren();
        for (const c of characters.slice(page * 128, (page + 1) * 128)) {
            const code = `U+${c.codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
            const cell = el('div', 'glyph'); cell.setAttribute('role', 'listitem'); cell.title = t('font.glyph', { code, index: c.glyphIndex });
            const char = el('span', 'character', String.fromCodePoint(c.codePoint)); char.style.fontFamily = `"${family}"`;
            cell.append(char, el('span', 'code', code)); grid.append(cell);
        }
        if (!characters.length) grid.append(el('p', 'empty', t('font.empty')));
        previous.disabled = page === 0; next.disabled = page + 1 === pages;
        status.textContent = t('font.page', { page: page + 1, pages, count: characters.length });
    };
    on(text, 'input', () => { specimen.textContent = text.value.slice(0, 4096); });
    on(size, 'input', () => { specimen.style.fontSize = `${size.value}px`; sizeValue.textContent = `${size.value} px`; });
    on(search, 'input', () => { page = 0; render(); });
    on(previous, 'click', () => { if (page > 0) page--; render(); });
    on(next, 'click', () => { page++; render(); });
    const axes = new Map<string, number>();
    const applyAxes = () => {
        specimen.style.fontVariationSettings = [...axes].map(([tag, n]) => `"${tag.replace(/["\\]/g, '\\$&')}" ${n}`).join(', ');
    };
    for (const axis of model.axes) {
        const label = el('label', 'axis-label', axis.tag), slider = el('input', 'axis'), value = el('output', 'axis-value', String(axis.default));
        slider.type = 'range'; slider.min = String(axis.min); slider.max = String(axis.max); slider.step = 'any'; slider.value = String(axis.default);
        axes.set(axis.tag, axis.default); label.append(slider, value); controls.append(label);
        on(slider, 'input', () => {
            axes.set(axis.tag, Number(slider.value)); value.textContent = slider.value;
            applyAxes();
        });
    }
    if (axes.size) applyAxes();
    render();
    const root = options.styleIsolation === 'scoped' ? container : container.shadowRoot ?? container.attachShadow({ mode: 'open' });
    let style: HTMLStyleElement | undefined;
    if (root !== container) { style = doc.createElement('style'); style.textContent = fontViewerCss; root.append(style); }
    root.append(shell);
    let disposed = false;
    return { dispose() {
        if (disposed) return; disposed = true;
        listeners.splice(0).forEach(remove => remove()); shell.remove(); style?.remove();
        if (face && available) doc.fonts.delete(face);
    } };
}
