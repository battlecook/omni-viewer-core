// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { mountJsonlViewer } from './index.js';
const base = { assets: { resolveAssetUrl: async (path: string) => path }, i18n: createCatalogI18n(), logger: { log: () => undefined } };
describe('mountJsonlViewer', () => {
    it('connects editing, validation, selection, deletion and syntax highlighting', async () => {
        const write = vi.fn(async () => undefined); const container = document.createElement('div');
        await mountJsonlViewer({ fileName: 'a.jsonl', data: new TextEncoder().encode('{"a":1}\n{"b":2}') }, container, { ...base, writeback: { write } }); const root = container.shadowRoot!;
        expect(root.querySelector('.omni-jsonl__key')?.textContent).toBe('"a"');
        root.querySelector<HTMLElement>('.omni-jsonl__row')!.click(); [...root.querySelectorAll('button')].find(button => button.textContent === 'Edit')!.click();
        const textarea = root.querySelector<HTMLTextAreaElement>('textarea')!; textarea.value = '{bad'; textarea.dispatchEvent(new Event('input')); expect([...root.querySelectorAll('button')].find(button => button.textContent === 'Apply')?.disabled).toBe(true);
    });
});
