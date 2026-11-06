import type { HostContext } from '../../host/index.js';
import { parseText, type TextParseOptions } from '../../parsers/text/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { textViewerCss } from './styles.js';

export { textViewerCss } from './styles.js';

export const TEXT_VIEWER_META = {
    id: 'text', displayNameKey: 'text.title', extensions: ['txt'] as string[], priority: 10,
    requiredServices: [] as const, optionalServices: [] as const,
    inputOwnership: 'borrows' as const
};

export interface TextMountOptions extends MountOptions {
    parse?: TextParseOptions;
    /** Soft wrapping is enabled by default; original text is never changed. */
    wrap?: boolean;
}

export async function mountTextViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: HostContext,
    options: TextMountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted || options.parse?.signal?.aborted) throw new MountAbortedError();
    const { result } = parseText(input.data, {
        ...options.parse,
        ...(options.signal ? { signal: options.signal } : {})
    });
    const t = ctx.i18n.t.bind(ctx.i18n);
    if (result.status === 'failed') {
        if (result.failure.code === 'aborted') throw new MountAbortedError();
        throw new Error(t(result.failure.messageKey, result.failure.args));
    }

    // Validate and decode before acquiring DOM resources, so failures leave
    // the host container untouched.
    let root: HTMLElement | ShadowRoot;
    let style: HTMLStyleElement | undefined;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && typeof container.attachShadow === 'function') {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        style = document.createElement('style');
        style.textContent = textViewerCss;
        root.append(style);
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--text');
        root = container;
    }

    const frame = document.createElement('section');
    frame.className = 'omni-text';
    frame.setAttribute('aria-label', t('text.title'));
    const header = document.createElement('header');
    header.className = 'omni-text__header';
    const title = document.createElement('strong');
    title.className = 'omni-text__title';
    title.textContent = input.fileName;
    title.title = input.fileName;
    const encoding = document.createElement('span');
    encoding.className = 'omni-text__encoding';
    encoding.textContent = t('text.encoding', { encoding: result.document.encoding.toUpperCase() });
    const wrap = document.createElement('button');
    wrap.type = 'button';
    wrap.className = 'omni-text__wrap';
    wrap.textContent = t('text.wrap');
    header.append(title, encoding, wrap);
    frame.append(header);

    for (const diagnostic of result.diagnostics) {
        const note = document.createElement('p');
        note.className = 'omni-text__note';
        note.textContent = t(diagnostic.messageKey, diagnostic.args);
        frame.append(note);
    }

    const pre = document.createElement('pre');
    pre.className = 'omni-text__content';
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', t('text.title'));
    // Text must stay literal: HTML, Markdown and URLs are never interpreted.
    pre.textContent = result.document.text;
    let wrapped = options.wrap ?? true;
    const updateWrap = () => {
        wrap.setAttribute('aria-pressed', String(wrapped));
        pre.classList.toggle('omni-text__content--wrap', wrapped);
    };
    const toggleWrap = () => { wrapped = !wrapped; updateWrap(); };
    updateWrap();
    wrap.addEventListener('click', toggleWrap);
    frame.append(pre);
    root.append(frame);

    let disposed = false;
    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            wrap.removeEventListener('click', toggleWrap);
            pre.textContent = '';
            frame.remove();
            style?.remove();
            if (root === container) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--text');
        }
    };
}
