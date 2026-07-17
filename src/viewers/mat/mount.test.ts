// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { mountMatViewer } from './index.js';

function level4Record(variableName: string, values = [4.5, 9.5]): Uint8Array {
    const name = new TextEncoder().encode(`${variableName}\0`); const data = new Uint8Array(20 + name.length + values.length * 8); const view = new DataView(data.buffer);
    view.setInt32(0, 0, true); view.setInt32(4, 1, true); view.setInt32(8, values.length, true); view.setInt32(12, 0, true); view.setInt32(16, name.length, true); data.set(name, 20); values.forEach((value, index) => view.setFloat64(20 + name.length + index * 8, value, true)); return data;
}

function concat(chunks: Uint8Array[]): Uint8Array {
    const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0)); let offset = 0;
    chunks.forEach(chunk => { result.set(chunk, offset); offset += chunk.length; }); return result;
}

const base = { assets: { resolveAssetUrl: async (path: string) => path }, i18n: createCatalogI18n(), logger: { log: () => undefined } };

describe('mountMatViewer', () => {
    it('renders MAT metadata, filters rows, copies the table, and disposes', async () => {
        const writeText = vi.fn(async (_text: string) => undefined); const container = document.createElement('div');
        const handle = await mountMatViewer({ fileName: 'sample.mat', data: level4Record('matrix') }, container, { ...base, clipboard: { writeText } });
        const root = container.shadowRoot!;
        expect(root.querySelector('.omni-mat__heading')?.textContent).toContain('sample.mat');
        expect(root.querySelector('tbody')?.textContent).toContain('matrix');
        const search = root.querySelector<HTMLInputElement>('.omni-mat__search')!; search.value = 'missing'; search.dispatchEvent(new Event('input'));
        expect(root.querySelector('.omni-mat__empty')?.textContent).toContain('No rows match');
        search.value = 'matrix'; search.dispatchEvent(new Event('input'));
        [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Copy JSON')!.click(); await Promise.resolve();
        const copied = JSON.parse(writeText.mock.calls[0]![0]);
        expect(copied).toMatchObject({ format: 'MAT v4', variables: [expect.objectContaining({ name: 'matrix' })] });
        handle.dispose(); expect(root.childNodes).toHaveLength(0);
    });

    it('limits table rendering to 1,000 rows while retaining the full model', async () => {
        const data = concat(Array.from({ length: 1001 }, (_, index) => level4Record(`variable_${index}`, [index])));
        const container = document.createElement('div');
        await mountMatViewer({ fileName: 'large.mat', data }, container, base);
        const root = container.shadowRoot!;
        expect(root.querySelectorAll('tbody tr')).toHaveLength(1000);
        expect(root.querySelector('.omni-mat__caption')?.textContent).toBe('1000 / 1001 rows shown');
    });
});
