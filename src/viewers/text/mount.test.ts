// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { MountAbortedError, type ViewerHandle } from '../types.js';
import { mountTextViewer, type TextMountOptions } from './index.js';

const ctx = { assets: { resolveAssetUrl: vi.fn() }, i18n: createCatalogI18n(), logger: { log: vi.fn() } };
const handles: ViewerHandle[] = [];
afterEach(() => { handles.splice(0).forEach(handle => handle.dispose()); document.body.replaceChildren(); });
async function mount(text: string | Uint8Array = '한글\ntext', options: TextMountOptions = {}, locale = 'en') {
    const container = document.createElement('div'); document.body.append(container);
    const handle = await mountTextViewer({ fileName: '<notes>.txt', data: typeof text === 'string' ? new TextEncoder().encode(text) : text }, container,
        { ...ctx, i18n: createCatalogI18n(locale) }, options);
    handles.push(handle);
    return { container, handle, root: options.styleIsolation === 'scoped' ? container : container.shadowRoot! };
}

describe('plain text viewer', () => {
    it('renders literal content and filename with whitespace preserved', async () => {
        const text = '  # Title\r\n\t<script>alert(1)</script>\n<img src="https://example.test"> & 😀  ';
        const { root } = await mount(text);
        expect(root.querySelector('pre')?.textContent).toBe(text);
        expect(root.querySelector('strong')?.textContent).toBe('<notes>.txt');
        expect(root.querySelector('script,img,a,iframe,textarea')).toBeNull();
        expect(root.querySelector('pre')?.tabIndex).toBe(0);
        expect(root.querySelector('.omni-text__encoding')?.textContent).toContain('UTF-8');
        expect(root.querySelectorAll('style')).toHaveLength(1);
    });

    it('toggles wrapping without changing text and releases its listener on disposal', async () => {
        const { root, handle } = await mount('a\tb\nlong line');
        const button = root.querySelector('button')!, pre = root.querySelector('pre')!;
        expect(button.getAttribute('aria-pressed')).toBe('true');
        button.click();
        expect(button.getAttribute('aria-pressed')).toBe('false');
        expect(pre.classList.contains('omni-text__content--wrap')).toBe(false);
        expect(pre.textContent).toBe('a\tb\nlong line');
        handle.dispose(); handle.dispose(); button.click();
        expect(button.getAttribute('aria-pressed')).toBe('false');
        expect(pre.textContent).toBe('');
        expect(root.childNodes).toHaveLength(0);
    });

    it('supports scoped styles, an initial wrap preference, and empty files', async () => {
        const { root, container, handle } = await mount('', { styleIsolation: 'scoped', wrap: false });
        expect(container.classList.contains('omni-viewer--text')).toBe(true);
        expect(container.shadowRoot).toBeNull(); expect(root.querySelector('style')).toBeNull();
        expect(root.querySelector('button')?.getAttribute('aria-pressed')).toBe('false');
        expect(root.querySelector('pre')?.textContent).toBe('');
        handle.dispose();
        expect(container.classList.contains('omni-viewer--text')).toBe(false);
    });

    it('marks truncated and malformed previews with localized warnings', async () => {
        const { root } = await mount(new Uint8Array([0x61, 0xff, 0x62]), { parse: { limits: { maxPreviewBytes: 2 } } });
        expect(root.querySelector('pre')?.textContent).toBe('a\ufffd');
        const notes = [...root.querySelectorAll('.omni-text__note')].map(n => n.textContent);
        expect(notes).toHaveLength(2); expect(notes[0]).toContain('not valid utf-8'); expect(notes[1]).toContain('first 2 bytes');
    });

    it('passes explicit encoding options through to the parser', async () => {
        const { root } = await mount(new Uint8Array([0, 0x41, 0, 0x42]), { parse: { encoding: 'utf-16be' } });
        expect(root.querySelector('pre')?.textContent).toBe('AB');
        expect(root.querySelector('.omni-text__encoding')?.textContent).toContain('UTF-16BE');
    });

    it.each(['ko', 'ja', 'zh-CN', 'zh-TW'])('uses localized UI and diagnostics for %s', async locale => {
        const { root } = await mount('abc', { parse: { limits: { maxPreviewBytes: 1 } } }, locale);
        expect(root.querySelector('button')?.textContent).toBe(createCatalogI18n(locale).t('text.wrap'));
        expect(root.querySelector('.omni-text__note')?.textContent).toBe(createCatalogI18n(locale).t('text.truncated', { bytes: 1 }));
        expect(root.textContent).not.toMatch(/text\.(?:title|wrap|encoding|truncated)/);
    });

    it('preserves host DOM and remounts without duplicate styles', async () => {
        const { container, root, handle } = await mount();
        const host = document.createElement('p'); host.textContent = 'host'; root.prepend(host);
        handle.dispose();
        expect(root.textContent).toBe('host');
        const next = await mountTextViewer({ fileName: 'again.txt', data: new TextEncoder().encode('next') }, container, ctx);
        handles.push(next);
        expect(container.shadowRoot?.querySelectorAll('style')).toHaveLength(1);
        expect(container.shadowRoot?.querySelectorAll('.omni-text')).toHaveLength(1);
        next.dispose(); expect(root.textContent).toBe('host');
    });

    it('rejects cancelled, unsupported and oversized input before touching host DOM', async () => {
        const container = document.createElement('div');
        const controller = new AbortController(); controller.abort();
        const input = { fileName: 'notes.txt', data: new TextEncoder().encode('abc') };
        await expect(mountTextViewer(input, container, ctx, { signal: controller.signal })).rejects.toBeInstanceOf(MountAbortedError);
        await expect(mountTextViewer(input, container, ctx, { parse: { signal: controller.signal } })).rejects.toBeInstanceOf(MountAbortedError);
        await expect(mountTextViewer(input, container, ctx, { parse: { limits: { maxInputBytes: 2 } } })).rejects.toThrow();
        await expect(mountTextViewer({ ...input, data: new Uint8Array([0, 0, 0xfe, 0xff]) }, container, ctx)).rejects.toThrow('UTF-32');
        expect(container.shadowRoot).toBeNull(); expect(container.childNodes).toHaveLength(0);
    });
});
