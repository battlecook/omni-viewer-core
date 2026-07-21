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
    it('syncs the tree and the source caret in both directions', async () => {
        const text = '[server]\nhost = "example.com"\nport = 8080\n';
        const container = document.createElement('div'); document.body.append(container);
        await mountTomlViewer({ fileName: 'a.toml', data: new TextEncoder().encode(text) }, container, ctx());
        const root = container.shadowRoot!; const editor = root.querySelector<HTMLTextAreaElement>('.omni-structured__editor')!;
        const rowFor = (label: string) => [...root.querySelectorAll<HTMLElement>('.omni-structured__tree:not(.omni-structured__flat) .omni-structured__node')].find(row => row.querySelector('.omni-structured__key')?.textContent === label)!;
        rowFor('port').click();
        expect(text.slice(editor.selectionStart, editor.selectionEnd)).toBe('port = 8080');
        expect(rowFor('port').classList.contains('omni-structured__node--selected')).toBe(true);
        editor.selectionStart = editor.selectionEnd = text.indexOf('example.com');
        editor.dispatchEvent(new Event('click'));
        expect(rowFor('host').classList.contains('omni-structured__node--selected')).toBe(true);
        expect(rowFor('port').classList.contains('omni-structured__node--selected')).toBe(false);
        expect(root.querySelector('.omni-structured__status')?.textContent).toContain('server.host');
        container.remove();
    });
    it('shows comments, container previews, and a scoped search with a match count', async () => {
        const container = document.createElement('div');
        await mountTomlViewer({ fileName: 'a.toml', data: new TextEncoder().encode('# listener settings\n[server]\nhost = "example.com"\nport = 8080\n') }, container, ctx());
        const root = container.shadowRoot!; const tree = root.querySelector<HTMLElement>('.omni-structured__tree')!;
        expect(tree.querySelector('.omni-structured__node-comment')?.textContent).toBe('# listener settings');
        expect(tree.textContent).toContain('{ 2 keys }');
        const search = root.querySelector<HTMLInputElement>('.omni-structured__search')!;
        search.value = 'server'; search.dispatchEvent(new Event('input'));
        const status = root.querySelector('.omni-structured__status')!;
        expect(status.textContent).toContain('3 matches');
        const scope = root.querySelector<HTMLSelectElement>('.omni-structured__scope')!;
        expect([...scope.options].map(option => option.value)).toEqual(['all', 'key', 'path', 'value']);
        scope.value = 'value'; scope.dispatchEvent(new Event('change'));
        expect(status.textContent).toContain('0 matches');
    });
    it('makes flat rows navigable and typed', async () => {
        const text = '[server]\nport = 8080\n';
        const container = document.createElement('div'); document.body.append(container);
        await mountTomlViewer({ fileName: 'a.toml', data: new TextEncoder().encode(text) }, container, ctx());
        const root = container.shadowRoot!;
        [...root.querySelectorAll('button')].find(button => button.textContent === 'Flat')!.click();
        const row = root.querySelector<HTMLElement>('.omni-structured__flat-row')!;
        expect(row.querySelector('.omni-structured__kind')?.textContent).toBe('integer');
        row.click();
        const editor = root.querySelector<HTMLTextAreaElement>('.omni-structured__editor')!;
        expect(text.slice(editor.selectionStart, editor.selectionEnd)).toBe('port = 8080');
        container.remove();
    });
    it('writes edited source through writeback', async () => {
        const write = vi.fn(async () => undefined); const container = document.createElement('div');
        await mountTomlViewer({ fileName: 'a.toml', data: new TextEncoder().encode('a = 1') }, container, ctx({ write })); const root = container.shadowRoot!; const editor = root.querySelector<HTMLTextAreaElement>('.omni-structured__editor')!; editor.value = 'a = 2'; editor.dispatchEvent(new Event('input')); [...root.querySelectorAll('button')].find(button => button.textContent === 'Save')!.click(); await Promise.resolve(); expect(write).toHaveBeenCalledWith(new TextEncoder().encode('a = 2'));
    });
});
