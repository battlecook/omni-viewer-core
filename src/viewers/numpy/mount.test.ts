// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import type { NumpyDocument } from '../../parsers/numpy/index.js';
import { mountNumpyDocument, numpyJsonReplacer } from './index.js';

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

    it('localizes metadata, dtype kinds, axes, and structured diagnostics', () => {
        const container = document.createElement('div');
        const localized: NumpyDocument = {
            ...model,
            diagnostics: [{ code: 'previewLimit', args: { limit: 100000, name: 'cube' } }]
        };
        mountNumpyDocument(localized, 'model.npz', container, { ...ctx, i18n: createCatalogI18n('ko-KR') }, { styleIsolation: 'scoped' });
        expect(container.textContent).toContain('NumPy 배열 아카이브');
        expect(container.textContent).toContain('부호 있는 정수');
        expect(container.textContent).toContain('축 0');
        expect(container.textContent).toContain('문서 값 미리보기는 100000개 요소로 제한됩니다.');
        expect(container.textContent).not.toContain('signed integer');
    });

    it('distinguishes an exhausted document preview budget from an unsupported dtype', () => {
        const container = document.createElement('div');
        const limited: NumpyDocument = {
            ...model,
            arrays: [{ ...model.arrays[0]!, values: [], previewTruncated: true, diagnostics: [{ code: 'previewLimit' }] }],
            tables: []
        };
        mountNumpyDocument(limited, 'limited.npz', container, ctx, { styleIsolation: 'scoped' });
        expect(container.textContent).toContain('numpy.previewLimited');
        expect(container.textContent).not.toContain('numpy.previewUnavailable');
    });

    it('preserves non-finite floating values and negative zero in copied JSON', () => {
        const encoded = JSON.stringify({ values: [Number.NaN, Infinity, -Infinity, -0, 1] }, numpyJsonReplacer);
        expect(encoded).toBe('{"values":["NaN","Infinity","-Infinity","-0",1]}');
    });

    it('renders negative zero distinctly in the value grid', () => {
        const container = document.createElement('div');
        const negativeZero: NumpyDocument = {
            ...model,
            arrays: [{ ...model.arrays[0]!, shape: [1], elements: 1, values: [-0] }],
            tables: []
        };
        mountNumpyDocument(negativeZero, 'zero.npy', container, ctx, { styleIsolation: 'scoped' });
        expect(container.querySelector('tbody td')?.textContent).toBe('-0');
    });

    it('does not describe a decode failure as an exhausted preview budget', () => {
        const container = document.createElement('div');
        const failed: NumpyDocument = {
            ...model,
            arrays: [{
                ...model.arrays[0]!, values: [], previewTruncated: true,
                diagnostics: [{ code: 'previewDecode' }]
            }],
            tables: []
        };
        mountNumpyDocument(failed, 'failed.npz', container, ctx, { styleIsolation: 'scoped' });
        expect(container.textContent).toContain('numpy.previewUnavailable');
        expect(container.textContent).not.toContain('numpy.previewLimited');
    });

    it('renders an explicit empty state for an empty higher-rank array', () => {
        const container = document.createElement('div');
        const empty: NumpyDocument = {
            ...model,
            arrays: [{ ...model.arrays[0]!, shape: [0, 2, 3], elements: 0, values: [] }],
            tables: []
        };
        mountNumpyDocument(empty, 'empty.npy', container, ctx, { styleIsolation: 'scoped' });
        expect(container.textContent).toContain('numpy.emptyArray');
        expect(container.querySelector('.omni-numpy__grid')).toBeNull();
        expect(container.querySelector('input[type=number]')).toBeNull();
    });
});
