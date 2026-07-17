// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Hdf5Document } from '../../parsers/hdf5/index.js';
import { mountHdf5Document } from './index.js';

const model: Hdf5Document = {
    format: 'HDF5',
    title: 'Hierarchical Data Format 5',
    fileSize: '2.00 KB',
    summary: [
        { label: 'Groups', value: 2 },
        { label: 'Datasets', value: 2 }
    ],
    tables: [
        { title: 'Datasets (2)', headers: ['Path', 'Shape'], rows: [['/ids', '5'], ['/measurements/temperature', '3 × 4']] },
        { title: 'Groups (2)', headers: ['Path', 'Kind'], rows: [['/', 'Group'], ['/measurements', 'Group']] }
    ],
    rawPreview: '//\n  measurements/\n    temperature [3 × 4] Float64',
    warnings: ['Dense links are not enumerated.']
};

const ctx = {
    assets: { resolveAssetUrl: async (path: string) => path },
    logger: { log: vi.fn() },
    i18n: { t: (key: string, args?: Record<string, string | number>) =>
        key === 'hdf5.matchingRows' ? `${args?.count} matching rows` : key }
};

describe('mountHdf5Document', () => {
    it('renders summaries, searchable tables, structure preview, and warnings', () => {
        const container = document.createElement('div');
        const handle = mountHdf5Document(model, 'sample.h5', container, ctx, { styleIsolation: 'scoped' });

        expect(container.textContent).toContain('sample.h5');
        expect(container.textContent).toContain('Dense links are not enumerated.');
        expect(container.querySelectorAll('tbody tr')).toHaveLength(2);

        const search = container.querySelector('input') as HTMLInputElement;
        search.value = 'temperature';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
        expect(container.textContent).toContain('/measurements/temperature');

        const structure = [...container.querySelectorAll('button')].find(button => button.textContent === 'hdf5.structure') as HTMLButtonElement;
        structure.click();
        expect(container.querySelector('pre')?.textContent).toContain('temperature [3 × 4] Float64');

        handle.dispose();
        expect(container.children).toHaveLength(0);
        expect(container.classList.contains('omni-viewer')).toBe(false);
    });

    it('copies the complete parsed model through the host clipboard', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        const container = document.createElement('div');
        mountHdf5Document(model, 'sample.hdf5', container, { ...ctx, clipboard: { writeText } }, { styleIsolation: 'scoped' });
        const copy = [...container.querySelectorAll('button')].find(button => button.textContent === 'hdf5.copyJson') as HTMLButtonElement;
        copy.click();
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify(model, null, 2)));
    });
});
