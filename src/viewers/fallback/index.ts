// Shared fallback viewer — the terminal node of every fallback chain
// (DESIGN.md §7, ADR 30). Text preview when the bytes decode as UTF-8,
// hex dump otherwise. Identical on every platform by construction.

import type { HostContext } from '../../host/index.js';
import {
    MountAbortedError,
    VIEWER_ROOT_CLASS,
    type MountOptions,
    type ViewerHandle,
    type ViewerInput
} from '../types.js';
import { fallbackViewerCss } from './styles.js';

export { fallbackViewerCss } from './styles.js';

export const FALLBACK_VIEWER_META = {
    id: 'fallback',
    displayNameKey: 'fallback.title.text',
    extensions: [] as string[],
    priority: -1,
    requiredServices: [] as const,
    optionalServices: [] as const,
    inputOwnership: 'borrows' as const
};

const TEXT_PREVIEW_BYTES = 256 * 1024;
const HEX_PREVIEW_BYTES = 4 * 1024;
const HEX_BYTES_PER_LINE = 16;

export interface FallbackMountOptions extends MountOptions {
    /** Why the fallback is showing (catalog key), e.g. 'fallback.reason.missing-dependency'. */
    reasonKey?: string;
}

export async function mountFallbackViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: HostContext,
    options: FallbackMountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();

    const isolation = options.styleIsolation ?? 'shadow';
    let root: HTMLElement | ShadowRoot;
    if (isolation === 'shadow' && typeof container.attachShadow === 'function') {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = fallbackViewerCss;
        root.appendChild(style);
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--fallback');
        root = container;
    }

    const t = ctx.i18n.t.bind(ctx.i18n);
    const frame = document.createElement('div');
    frame.className = 'omni-fallback';

    if (options.reasonKey) {
        const reason = document.createElement('div');
        reason.className = 'omni-fallback__reason';
        reason.textContent = t(options.reasonKey);
        frame.appendChild(reason);
    }

    const text = tryDecodeText(input.data);
    const title = document.createElement('div');
    title.className = 'omni-fallback__title';
    title.textContent =
        text !== null ? t('fallback.title.text') : t('fallback.title.hex');
    frame.appendChild(title);

    const pre = document.createElement('pre');
    pre.className = 'omni-fallback__content';

    let truncatedAt: number | null = null;
    if (text !== null) {
        pre.textContent = text.content;
        if (text.truncated) truncatedAt = TEXT_PREVIEW_BYTES;
    } else {
        pre.textContent = hexDump(input.data.subarray(0, HEX_PREVIEW_BYTES));
        if (input.data.byteLength > HEX_PREVIEW_BYTES) truncatedAt = HEX_PREVIEW_BYTES;
    }
    frame.appendChild(pre);

    if (truncatedAt !== null) {
        const note = document.createElement('div');
        note.className = 'omni-fallback__note';
        note.textContent = t('fallback.truncated', { bytes: truncatedAt });
        frame.appendChild(note);
    }

    root.appendChild(frame);

    return {
        dispose() {
            if (root instanceof ShadowRoot) {
                root.replaceChildren();
            } else {
                root.replaceChildren();
                root.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--fallback');
            }
        }
    };
}

function tryDecodeText(
    data: Uint8Array
): { content: string; truncated: boolean } | null {
    const slice = data.subarray(0, TEXT_PREVIEW_BYTES);
    try {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(slice);
        // Control characters (other than tab/newline/CR) mean "not really text".
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(content)) return null;
        return { content, truncated: data.byteLength > TEXT_PREVIEW_BYTES };
    } catch {
        // A multi-byte sequence cut at the slice boundary would throw; retry
        // with a few bytes trimmed before concluding "binary".
        if (data.byteLength > TEXT_PREVIEW_BYTES) {
            try {
                const trimmed = new TextDecoder('utf-8', { fatal: true }).decode(
                    slice.subarray(0, TEXT_PREVIEW_BYTES - 4)
                );
                // eslint-disable-next-line no-control-regex
                if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(trimmed)) return null;
                return { content: trimmed, truncated: true };
            } catch {
                return null;
            }
        }
        return null;
    }
}

function hexDump(data: Uint8Array): string {
    const lines: string[] = [];
    for (let offset = 0; offset < data.byteLength; offset += HEX_BYTES_PER_LINE) {
        const chunk = data.subarray(offset, offset + HEX_BYTES_PER_LINE);
        const hex: string[] = [];
        let ascii = '';
        for (let i = 0; i < HEX_BYTES_PER_LINE; i++) {
            const byte = chunk[i];
            if (byte === undefined) {
                hex.push('  ');
                continue;
            }
            hex.push(byte.toString(16).padStart(2, '0'));
            ascii += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
        }
        lines.push(
            `${offset.toString(16).padStart(8, '0')}  ${hex.slice(0, 8).join(' ')}  ${hex
                .slice(8)
                .join(' ')}  |${ascii}|`
        );
    }
    return lines.join('\n');
}
