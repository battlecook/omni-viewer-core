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
