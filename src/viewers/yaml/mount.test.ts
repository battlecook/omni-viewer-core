// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { loadYamlParserDeps } from '../../parsers/yaml/self-loading.js';
import { mountYamlViewer } from './index.js';
const context = { assets: { resolveAssetUrl: async (path: string) => path }, i18n: createCatalogI18n(), logger: { log: () => undefined } };
describe('mountYamlViewer', () => {
    it('mounts source and selected-document tree panes', async () => {
        const container = document.createElement('div');
        await mountYamlViewer({ fileName: 'a.yaml', data: new TextEncoder().encode('first: 1') }, container, context, { deps: { parse: () => [{ first: 1 }, { second: 2 }] } });
        const root = container.shadowRoot!;
        expect(root.querySelector('.omni-structured__editor')).not.toBeNull();
        expect(root.querySelector('.omni-structured__editor-pane')).not.toBeNull(); expect(root.querySelector('.omni-structured__preview-pane')).not.toBeNull(); expect(root.querySelector('.omni-structured__source-key')).not.toBeNull();
        const select = root.querySelector<HTMLSelectElement>('select')!; select.value = '1'; select.dispatchEvent(new Event('change'));
        expect(root.querySelector('.omni-structured__tree')?.textContent).toContain('second');
    });
    it('sizes the source editor to the document so it drives the pane height', async () => {
        const container = document.createElement('div');
        await mountYamlViewer({ fileName: 'a.yaml', data: new TextEncoder().encode('a: 1\nb: 2\nc: 3') }, container, context, { deps: await loadYamlParserDeps() });
        const root = container.shadowRoot!;
        expect(root.querySelector<HTMLTextAreaElement>('.omni-structured__editor')?.rows).toBe(4);
        expect(root.querySelector('.omni-structured__preview-body .omni-structured__tree')).not.toBeNull();
    });
    it('interpolates diagnostic args into the rendered message', async () => {
        const container = document.createElement('div');
        await mountYamlViewer({ fileName: 'a.yaml', data: new TextEncoder().encode('a: 1\na: 2') }, container, context, { deps: await loadYamlParserDeps() });
        expect(container.shadowRoot!.querySelector('.omni-structured__diagnostics')?.textContent).toContain('Duplicate key "a"');
    });
});
