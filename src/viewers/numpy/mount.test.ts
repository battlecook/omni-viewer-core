// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { NumpyDocument } from '../../parsers/numpy/index.js';
import { mountNumpyDocument } from './index.js';

const model: NumpyDocument = {
    format: 'NumPy NPZ', title: 'NumPy array archive', fileSize: '1.2 KB',
    summary: [{ label: 'Arrays', value: 2 }, { label: 'Elements', value: 14 }],
    arrays: [
        {
            name: 'cube', dtype: '<i4', byteOrder: 'little', kind: 'signed integer', shape: [2, 2, 3],
            fortranOrder: false, elements: 12, byteLength: 48, values: [...Array(12).keys()], previewTruncated: false, warnings: []
        },
        {
            name: 'flags', dtype: '|b1', byteOrder: 'not-applicable', kind: 'boolean', shape: [2],
            fortranOrder: false, elements: 2, byteLength: 2, values: [true, false], previewTruncated: false, warnings: []
        }
    ],
    tables: [{
        title: 'Arrays (2)', headers: ['Name', 'Dtype', 'Shape', 'Order', 'Elements', 'Data size'],
        rows: [['cube', '<i4', '2 × 2 × 3', 'C', 12, '48 bytes'], ['flags', '|b1', '2', 'C', 2, '2 bytes']]
    }],
    warnings: ['cube: preview warning']
};

const ctx = {
    assets: { resolveAssetUrl: async (path: string) => path }, logger: { log: vi.fn() },
    i18n: { t: (key: string, args?: Record<string, string | number>) => key === 'numpy.gridShown' ? `${args?.rows} rows` : key }
};

describe('mountNumpyDocument', () => {
    it('renders an array grid and changes higher-dimensional slices', () => {
        const container = document.createElement('div');
        const handle = mountNumpyDocument(model, 'model.npz', container, ctx, { styleIsolation: 'scoped' });

        expect(container.textContent).toContain('model.npz');
        expect(container.textContent).toContain('preview warning');
        expect([...container.querySelectorAll('tbody td')].map(cell => cell.textContent)).toEqual(['0', '1', '2', '3', '4', '5']);

        const slice = container.querySelector('input[type=number]') as HTMLInputElement;
        slice.value = '1'; slice.dispatchEvent(new Event('change', { bubbles: true }));
        expect([...container.querySelectorAll('tbody td')].map(cell => cell.textContent)).toEqual(['6', '7', '8', '9', '10', '11']);

        handle.dispose();
        expect(container.children).toHaveLength(0);
        expect(container.classList.contains('omni-viewer')).toBe(false);
    });

    it('switches arrays, opens metadata, and copies the parsed model', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        const container = document.createElement('div');
        mountNumpyDocument(model, 'model.npz', container, { ...ctx, clipboard: { writeText } }, { styleIsolation: 'scoped' });

        const select = container.querySelector('select') as HTMLSelectElement;
        select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true }));
        expect(container.textContent).toContain('boolean');
        expect([...container.querySelectorAll('tbody td')].map(cell => cell.textContent)).toEqual(['true', 'false']);

        const arrays = [...container.querySelectorAll('button')].find(button => button.textContent === 'numpy.arrays')! as HTMLButtonElement;
        arrays.click();
        expect(container.textContent).toContain('cube');
        expect(container.textContent).toContain('flags');

        const copy = [...container.querySelectorAll('button')].find(button => button.textContent === 'numpy.copyJson')! as HTMLButtonElement;
        copy.click();
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify(model, null, 2)));
    });
});
