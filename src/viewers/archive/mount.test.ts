// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { mountArchiveViewer } from './index.js';

const context = { assets: { resolveAssetUrl: async (path: string) => path }, i18n: createCatalogI18n(), logger: { log: () => undefined } };

describe('mountArchiveViewer', () => {
    it('renders the VS Code archive layout and previews selected entries', async () => {
        const close = vi.fn();
        const extract = vi.fn(async () => new TextEncoder().encode('hello archive'));
        const container = document.createElement('div');
        const mounted = await mountArchiveViewer({ fileName: 'sample.zip', data: new Uint8Array(42) }, container, context, { openArchive: async () => ({ entries: [{ entryId: 0, path: 'readme.txt', isDirectory: false, compressedSize: 8, uncompressedSize: 13 }], extract, close }) });
        const root = container.shadowRoot!;
        expect(root.querySelector('h1')?.textContent).toBe('sample.zip');
        expect(root.querySelectorAll('.omni-archive__stat')).toHaveLength(4);
        expect(root.querySelector('.omni-archive__path')?.textContent).toBe('readme.txt');
        root.querySelector<HTMLElement>('.omni-archive__entry')!.click();
        await Promise.resolve(); await Promise.resolve();
        expect(root.querySelector('.omni-archive__preview')?.textContent).toBe('hello archive');
        expect(root.querySelector('.omni-archive__entry')?.classList.contains('is-selected')).toBe(true);
        mounted.dispose(); expect(close).toHaveBeenCalledOnce();
    });

    it('filters rows and activates a row with the keyboard', async () => {
        const container = document.createElement('div'); const extract = vi.fn(async () => new Uint8Array([0, 1]));
        await mountArchiveViewer({ fileName: 'a.zip', data: new Uint8Array(1) }, container, context, { openArchive: async () => ({ entries: [{ entryId: 1, path: 'a.txt', isDirectory: false }, { entryId: 2, path: 'b.bin', isDirectory: false }], extract, close() {} }) });
        const root = container.shadowRoot!; const search = root.querySelector<HTMLInputElement>('input')!; search.value = 'b'; search.dispatchEvent(new Event('input'));
        expect(root.querySelectorAll('.omni-archive__entry')).toHaveLength(1);
        root.querySelector<HTMLElement>('.omni-archive__entry')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(extract).toHaveBeenCalledWith(2, expect.objectContaining({ maxBytes: expect.any(Number) }));
    });

    it('toggles directories and renders only a window of a large archive', async () => {
        const entries = [
            { entryId: 0, path: 'dir/', isDirectory: true },
            { entryId: 1, path: 'dir/child.txt', isDirectory: false },
            ...Array.from({ length: 1_000 }, (_, index) => ({ entryId: index + 2, path: `file-${index}.txt`, isDirectory: false }))
        ];
        const container = document.createElement('div');
        await mountArchiveViewer({ fileName: 'large.zip', data: new Uint8Array(1) }, container, context, { openArchive: async () => ({ entries, extract: async () => new Uint8Array(), close() {} }) });
        const root = container.shadowRoot!;
        expect(root.querySelectorAll('.omni-archive__entry').length).toBeLessThan(100);
        root.querySelector<HTMLElement>('[data-entry-id="0"]')!.click();
        expect(root.querySelector('[data-entry-id="1"]')).toBeNull();
    });

    it('keeps the scroll window after a scroll instead of snapping back to the top', async () => {
        const entries = Array.from({ length: 1_000 }, (_, index) => ({ entryId: index, path: `file-${index}.txt`, isDirectory: false }));
        const container = document.createElement('div');
        await mountArchiveViewer({ fileName: 'large.zip', data: new Uint8Array(1) }, container, context, { openArchive: async () => ({ entries, extract: async () => new Uint8Array(), close() {} }) });
        const root = container.shadowRoot!;
        const tableWrap = root.querySelector<HTMLElement>('.omni-archive__table-wrap')!;
        const tbody = root.querySelector('tbody')!;
        // Browsers clamp scrollTop to the scrollable height, so an emptied tbody
        // reports 0 — the exact condition that used to reset the viewport.
        Object.defineProperty(tableWrap, 'scrollTop', { get: () => (tbody.querySelector('.omni-archive__entry') ? 4_300 : 0), configurable: true });
        tableWrap.dispatchEvent(new Event('scroll'));
        expect(root.querySelector('.omni-archive__path')?.textContent).not.toBe('file-0.txt');
        expect(root.querySelector<HTMLElement>('[data-entry-id="100"]')).not.toBeNull();
    });

    it('leaves the rows and the focused entry untouched while the window is unchanged', async () => {
        const entries = Array.from({ length: 1_000 }, (_, index) => ({ entryId: index, path: `file-${index}.txt`, isDirectory: false }));
        const container = document.createElement('div'); document.body.append(container);
        await mountArchiveViewer({ fileName: 'large.zip', data: new Uint8Array(1) }, container, context, { openArchive: async () => ({ entries, extract: async () => new TextEncoder().encode('body'), close() {} }) });
        const root = container.shadowRoot!;
        const tableWrap = root.querySelector<HTMLElement>('.omni-archive__table-wrap')!;
        const tbody = root.querySelector('tbody')!;
        let pos = 0;
        Object.defineProperty(tableWrap, 'scrollTop', { get: () => (tbody.querySelector('.omni-archive__entry') ? pos : 0), set: (value: number) => { pos = value; }, configurable: true });
        pos = 4_300; tableWrap.dispatchEvent(new Event('scroll'));
        const selected = root.querySelector<HTMLElement>('[data-entry-id="105"]')!;
        selected.focus(); selected.click();
        await Promise.resolve(); await Promise.resolve();
        // Selecting must patch the row in place — a rebuild here is what threw the
        // viewport back to the top as soon as a scrolled-to row was clicked.
        expect(root.querySelector<HTMLElement>('[data-entry-id="105"]')).toBe(selected);
        expect(selected.classList.contains('is-selected')).toBe(true);
        expect(root.activeElement).toBe(selected);
        expect(pos).toBe(4_300);
        expect(root.querySelector('.omni-archive__path')?.textContent).toBe('file-92.txt');
        // A tick inside the overscan margin must not recycle rows, or the focused
        // row is destroyed and the browser drags the viewport back to the top.
        pos = 4_320; tableWrap.dispatchEvent(new Event('scroll'));
        expect(root.querySelector<HTMLElement>('[data-entry-id="105"]')).toBe(selected);
        expect(root.activeElement).toBe(selected);
        // A tick past the margin repaints, and focus follows to the new row.
        pos = 6_000; tableWrap.dispatchEvent(new Event('scroll'));
        expect(root.querySelector('.omni-archive__path')?.textContent).toBe('file-131.txt');
        container.remove();
    });

    it('saves the selected entry when the optional save service is present', async () => {
        const saveFile = vi.fn(async () => undefined); const bytes = new TextEncoder().encode('saved');
        const container = document.createElement('div');
        await mountArchiveViewer({ fileName: 'a.zip', data: new Uint8Array(1) }, container, { ...context, save: { saveFile } }, { openArchive: async () => ({ entries: [{ entryId: 6, path: 'nested/', isDirectory: true }, { entryId: 7, path: 'nested/report.txt', isDirectory: false, uncompressedSize: bytes.length, mimeType: 'text/plain' }], extract: async () => bytes, close() {} }) });
        const root = container.shadowRoot!;
        root.querySelector<HTMLElement>('[data-entry-id="7"]')!.click(); await Promise.resolve();
        root.querySelector<HTMLButtonElement>('.omni-archive__save')!.click();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        expect(saveFile).toHaveBeenCalledWith('report.txt', bytes, 'text/plain');
    });

    it('mounts a streaming source lazily without any file bytes and closes its handle', async () => {
        const close = vi.fn();
        const extract = vi.fn(async () => new TextEncoder().encode('stream body'));
        const openArchive = vi.fn(async () => ({ entries: [{ entryId: 0, path: 'notes.txt', isDirectory: false, uncompressedSize: 11 }], extract, close }));
        const container = document.createElement('div');
        const mounted = await mountArchiveViewer({ fileName: 'huge.tar', totalSize: 9_000_000_000, openArchive }, container, context);
        const root = container.shadowRoot!;
        expect(root.querySelector('h1')?.textContent).toBe('huge.tar');
        expect(openArchive).toHaveBeenCalledOnce();
        root.querySelector<HTMLElement>('[data-entry-id="0"]')!.click();
        await Promise.resolve(); await Promise.resolve();
        expect(root.querySelector('.omni-archive__preview')?.textContent).toBe('stream body');
        mounted.dispose(); expect(close).toHaveBeenCalledOnce();
    });

    it('prefers the streaming save hook over buffered extraction', async () => {
        const saveEntry = vi.fn(async () => 'report.txt');
        const extract = vi.fn(async () => new Uint8Array([1]));
        const container = document.createElement('div');
        await mountArchiveViewer({ fileName: 'a.tar', totalSize: 100, openArchive: async () => ({ entries: [{ entryId: 7, path: 'report.txt', isDirectory: false, uncompressedSize: 5 }], extract, close() {} }) }, container, { ...context, saveEntry: { saveEntry } });
        const root = container.shadowRoot!;
        root.querySelector<HTMLElement>('[data-entry-id="7"]')!.click(); await Promise.resolve();
        extract.mockClear();
        root.querySelector<HTMLButtonElement>('.omni-archive__save')!.click();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        expect(saveEntry).toHaveBeenCalledOnce();
        expect(extract).not.toHaveBeenCalled();
    });

    it('renders an inline image preview for an image entry (magic-byte confirmed)', async () => {
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const container = document.createElement('div');
        await mountArchiveViewer({ fileName: 'a.zip', data: new Uint8Array(1) }, container, context, { openArchive: async () => ({ entries: [{ entryId: 0, path: 'pic.png', isDirectory: false, uncompressedSize: png.length }], extract: async () => png, close() {} }) }, { createObjectUrl: () => 'blob:img', revokeObjectUrl: () => undefined });
        const root = container.shadowRoot!;
        root.querySelector<HTMLElement>('[data-entry-id="0"]')!.click();
        await Promise.resolve(); await Promise.resolve();
        expect(root.querySelector<HTMLImageElement>('.omni-archive__image')?.getAttribute('src')).toBe('blob:img');
    });

    it('renders an inline audio player for an audio entry', async () => {
        const container = document.createElement('div');
        await mountArchiveViewer({ fileName: 'a.zip', data: new Uint8Array(1) }, container, context, { openArchive: async () => ({ entries: [{ entryId: 0, path: 'song.mp3', isDirectory: false, uncompressedSize: 4 }], extract: async () => new Uint8Array([1, 2, 3, 4]), close() {} }) }, { createObjectUrl: () => 'blob:audio', revokeObjectUrl: () => undefined });
        const root = container.shadowRoot!;
        root.querySelector<HTMLElement>('[data-entry-id="0"]')!.click();
        await Promise.resolve(); await Promise.resolve();
        expect(root.querySelector<HTMLAudioElement>('.omni-archive__audio')?.getAttribute('src')).toBe('blob:audio');
    });

    it('renders an inline video player for a video entry', async () => {
        const container = document.createElement('div');
        await mountArchiveViewer({ fileName: 'a.zip', data: new Uint8Array(1) }, container, context, { openArchive: async () => ({ entries: [{ entryId: 0, path: 'clip.mp4', isDirectory: false, uncompressedSize: 4 }], extract: async () => new Uint8Array([1, 2, 3, 4]), close() {} }) }, { createObjectUrl: () => 'blob:video', revokeObjectUrl: () => undefined });
        const root = container.shadowRoot!;
        root.querySelector<HTMLElement>('[data-entry-id="0"]')!.click();
        await Promise.resolve(); await Promise.resolve();
        expect(root.querySelector<HTMLVideoElement>('.omni-archive__video')?.getAttribute('src')).toBe('blob:video');
    });

    it('does not let a late file extraction overwrite a subsequently selected directory', async () => {
        let finish!: (bytes: Uint8Array) => void;
        const delayed = new Promise<Uint8Array>(resolve => { finish = resolve; });
        const container = document.createElement('div');
        await mountArchiveViewer({ fileName: 'a.zip', data: new Uint8Array(1) }, container, context, { openArchive: async () => ({ entries: [{ entryId: 0, path: 'dir/', isDirectory: true }, { entryId: 1, path: 'file.txt', isDirectory: false }], extract: async () => delayed, close() {} }) });
        const root = container.shadowRoot!;
        root.querySelector<HTMLElement>('[data-entry-id="1"]')!.click();
        root.querySelector<HTMLElement>('[data-entry-id="0"]')!.click();
        finish(new TextEncoder().encode('late file result'));
        await delayed; await Promise.resolve(); await Promise.resolve();
        expect(root.querySelector('.omni-archive__preview')?.textContent).toBe('This entry contains child items rather than file content.');
        expect(root.querySelector('.omni-archive__preview')?.textContent).not.toContain('late file result');
    });
});
