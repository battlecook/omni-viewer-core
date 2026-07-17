// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { mountTomlViewer } from './index.js';

const ctx = (writeback?: { write(data: Uint8Array): Promise<void> }) => ({
    assets: { resolveAssetUrl: async (path: string) => path }, i18n: createCatalogI18n(), logger: { log: () => undefined },
    ...(writeback ? { writeback } : {})
});
describe('mountTomlViewer', () => {
    it('keeps an editable source beside a tree/raw preview', async () => {
        const container = document.createElement('div');
        await mountTomlViewer({ fileName: 'a.toml', data: new TextEncoder().encode('a = 1') }, container, ctx());
        const root = container.shadowRoot!;
        expect(root.querySelector('.omni-structured__editor')).not.toBeNull();
        expect(root.querySelector('.omni-structured__tree')).not.toBeNull();
        expect(root.querySelector('.omni-structured__source-key')?.textContent).toContain('a');
        expect(root.querySelector('.omni-structured__source-value')?.textContent).toContain('1');
        const editor = root.querySelector<HTMLTextAreaElement>('.omni-structured__editor')!; expect(editor.readOnly).toBe(false);
        expect(root.querySelector('.omni-structured__editor-pane')).not.toBeNull(); expect(root.querySelector('.omni-structured__preview-pane')).not.toBeNull();
        editor.value = 'changed = true'; editor.dispatchEvent(new Event('input')); expect(root.querySelector('.omni-structured__tree')?.textContent).toContain('changed');
        [...root.querySelectorAll('button')].find(button => button.textContent === 'Raw')!.click();
        expect(root.querySelector<HTMLElement>('.omni-structured__editor-pane')?.style.display).toBe('');
        expect(root.querySelector<HTMLElement>('.omni-structured__raw-preview')?.style.display).toBe('');
    });
    it('offers flat and JSON preview modes', async () => {
        const container = document.createElement('div');
        await mountTomlViewer({ fileName: 'a.toml', data: new TextEncoder().encode('[server]\nhost = "x"\nport = 1') }, container, ctx());
        const root = container.shadowRoot!;
        const modes = [...root.querySelectorAll<HTMLButtonElement>('.omni-structured__preview-modes button')];
        expect(modes.map(button => button.textContent)).toEqual(['Tree', 'Flat', 'JSON', 'Raw']);
        modes.find(button => button.textContent === 'Flat')!.click();
        const flat = root.querySelector<HTMLElement>('.omni-structured__flat')!;
        expect(flat.style.display).toBe('');
        expect(root.querySelector<HTMLElement>('.omni-structured__tree:not(.omni-structured__flat)')?.style.display).toBe('none');
        expect(flat.textContent).toContain('server.host');
        expect(flat.textContent).toContain('server.port');
        modes.find(button => button.textContent === 'JSON')!.click();
        const json = root.querySelector<HTMLElement>('.omni-structured__json-preview')!;
        expect(json.style.display).toBe('');
        expect(flat.style.display).toBe('none');
        expect(JSON.parse(json.textContent!)).toEqual({ server: { host: 'x', port: '1' } });
    });
    it('writes edited source through writeback', async () => {
        const write = vi.fn(async () => undefined); const container = document.createElement('div');
        await mountTomlViewer({ fileName: 'a.toml', data: new TextEncoder().encode('a = 1') }, container, ctx({ write })); const root = container.shadowRoot!; const editor = root.querySelector<HTMLTextAreaElement>('.omni-structured__editor')!; editor.value = 'a = 2'; editor.dispatchEvent(new Event('input')); [...root.querySelectorAll('button')].find(button => button.textContent === 'Save')!.click(); await Promise.resolve(); expect(write).toHaveBeenCalledWith(new TextEncoder().encode('a = 2'));
    });
});
