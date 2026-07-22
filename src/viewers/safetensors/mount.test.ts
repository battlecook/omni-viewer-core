// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import type { SafetensorsDocument } from '../../parsers/safetensors/index.js';
import { createSafetensorsBlobSource, mountSafetensorsDocument, mountSafetensorsViewer } from './index.js';

const model: SafetensorsDocument = {
    format: 'safetensors',
    title: 'Safetensors tensor collection',
    fileSize: '2.00 KB',
    summary: [
        { label: 'Tensors', value: 2 },
        { label: 'Parameters', value: '9' }
    ],
    tables: [
        { title: 'Tensors (2)', headers: ['Name', 'Dtype', 'Shape'], rows: [['model.weight', 'F32', '2 × 3'], ['model.bias', 'F32', '3']] },
        { title: 'Metadata (1)', headers: ['Key', 'Value'], rows: [['producer', 'unit-test']] }
    ],
    rawPreview: 'model.weight  [2 × 3]  F32\nmodel.bias  [3]  F32',
    warnings: ['Some tensors use a dtype this viewer does not recognize.']
};

const ctx = {
    assets: { resolveAssetUrl: async (path: string) => path },
    logger: { log: vi.fn() },
    i18n: { t: (key: string, args?: Record<string, string | number>) =>
        key === 'safetensors.matchingRows' ? `${args?.count} matching rows` : key }
};

describe('mountSafetensorsDocument', () => {
    it('renders summaries, searchable tables, structure preview, and warnings', () => {
        const container = document.createElement('div');
        const handle = mountSafetensorsDocument(model, 'model.safetensors', container, ctx, { styleIsolation: 'scoped' });

        expect(container.textContent).toContain('model.safetensors');
        expect(container.textContent).toContain('does not recognize');
        expect(container.querySelectorAll('tbody tr')).toHaveLength(2);

        const search = container.querySelector('input') as HTMLInputElement;
        search.value = 'bias';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
        expect(container.textContent).toContain('model.bias');

        const structure = [...container.querySelectorAll('button')].find(button => button.textContent === 'safetensors.structure') as HTMLButtonElement;
        structure.click();
        expect(container.querySelector('pre')?.textContent).toContain('model.weight  [2 × 3]  F32');

        handle.dispose();
        expect(container.children).toHaveLength(0);
        expect(container.classList.contains('omni-viewer')).toBe(false);
    });

    it('copies the complete parsed model through the host clipboard', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        const container = document.createElement('div');
        mountSafetensorsDocument(model, 'model.safetensors', container, { ...ctx, clipboard: { writeText } }, { styleIsolation: 'scoped' });
        const copy = [...container.querySelectorAll('button')].find(button => button.textContent === 'safetensors.copyJson') as HTMLButtonElement;
        copy.click();
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify(model, null, 2)));
    });

    it('mounts from Blob range reads without loading the tensor payload', async () => {
        const headerJson = new TextEncoder().encode(JSON.stringify({
            weight: { dtype: 'U8', shape: [1024], data_offsets: [0, 1024] }
        }));
        const file = new Uint8Array(8 + headerJson.byteLength + 1024);
        new DataView(file.buffer).setBigUint64(0, BigInt(headerJson.byteLength), true);
        file.set(headerJson, 8);
        const blob = new NodeBlob([file]) as unknown as Blob;
        const slice = vi.spyOn(blob, 'slice');
        const container = document.createElement('div');

        const handle = await mountSafetensorsViewer(
            createSafetensorsBlobSource(blob, 'large.safetensors'),
            container,
            ctx,
            { styleIsolation: 'scoped' }
        );

        expect(slice).toHaveBeenNthCalledWith(1, 0, 8);
        expect(slice).toHaveBeenNthCalledWith(2, 8, 8 + headerJson.byteLength);
        expect(slice).toHaveBeenCalledTimes(2);
        expect(container.textContent).toContain('large.safetensors');
        handle.dispose();
    });
});
