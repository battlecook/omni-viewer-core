// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
    legacyKerasHdf5,
    nestedKerasArchive,
    plainHdf5
} from '../../parsers/keras/__tests__/fixture.js';
import { parseKeras } from '../../parsers/keras/index.js';
import { MountAbortedError } from '../types.js';
import { mountKerasDocument, mountKerasViewer } from './index.js';

const ctx = {
    assets: { resolveAssetUrl: async (path: string) => path },
    logger: { log: vi.fn() },
    i18n: {
        t: (key: string, args?: Record<string, string | number>) =>
            key === 'keras.rows' ? `${args?.count} rows`
                : key === 'keras.rowsLimited' ? `${args?.shown}/${args?.total}`
                    : key
    }
};

const button = (container: HTMLElement, label: string): HTMLButtonElement =>
    [...container.querySelectorAll('button')].find(node => node.textContent === label) as HTMLButtonElement;
const rows = (container: HTMLElement): HTMLTableRowElement[] =>
    [...container.querySelectorAll<HTMLTableRowElement>('tbody tr')];
const cells = (row: HTMLTableRowElement): string[] => [...row.querySelectorAll('td')].map(cell => cell.textContent ?? '');

describe('mountKerasViewer', () => {
    it('renders layers, weights, configuration, and model info, then disposes cleanly', async () => {
        const container = document.createElement('div');
        const handle = await mountKerasViewer(
            { fileName: 'sequential.h5', data: legacyKerasHdf5() },
            container,
            ctx,
            { styleIsolation: 'scoped' }
        );

        expect(container.textContent).toContain('sequential.h5');
        expect(container.querySelector('.omni-keras__summary')?.textContent).toContain('26');
        expect(rows(container)).toHaveLength(4);
        expect(cells(rows(container)[1]!)).toEqual(['1', 'dense', 'Dense', '—', 'relu', '16', '2', '✓']);
        expect(container.querySelector('.omni-keras__warnings')?.hasAttribute('hidden')).toBe(true);

        button(container, 'keras.tab.weights').click();
        expect(rows(container)).toHaveLength(4);
        expect(cells(rows(container)[0]!)).toEqual([
            'sequential/dense/kernel', 'dense', '3 × 4', 'Float32', '12', '48 bytes',
            '/model_weights/dense/sequential/dense/kernel'
        ]);

        button(container, 'keras.tab.config').click();
        expect(container.querySelector('pre')?.textContent).toContain('"class_name": "Sequential"');

        button(container, 'keras.tab.training').click();
        expect(container.textContent).toContain('categorical_crossentropy');

        button(container, 'keras.tab.model').click();
        const info = container.querySelector('.omni-keras__model-info');
        expect(info?.textContent).toContain('Sequential');
        expect(info?.textContent).toContain('3.15.1');
        // A legacy model has no archive, so the archive tab is not offered.
        expect(button(container, 'keras.tab.files')).toBeUndefined();

        handle.dispose();
        expect(container.innerHTML).toBe('');
        expect(container.classList.contains('omni-viewer')).toBe(false);
    });

    it('expands a layer row into its configuration, weights, and inbound layers', async () => {
        const container = document.createElement('div');
        const model = await parseKeras(nestedKerasArchive(), 'nested.keras');
        const handle = mountKerasDocument(model, 'nested.keras', container, ctx, { styleIsolation: 'scoped' });

        const encoder = rows(container)[1]!;
        expect(encoder.getAttribute('aria-expanded')).toBe('false');
        encoder.click();

        const detail = container.querySelector('.omni-keras__detail');
        expect(detail?.textContent).toContain('keras.detail.inbound');
        expect(detail?.querySelector('.omni-keras__chip')?.textContent).toBe('features');
        expect(detail?.textContent).toContain('trainable');
        expect(rows(container)[1]!.getAttribute('aria-expanded')).toBe('true');

        rows(container)[1]!.click();
        expect(container.querySelector('.omni-keras__detail')).toBeNull();
        handle.dispose();
    });

    it('shows the archive tab and nested layer depth for a .keras model', async () => {
        const container = document.createElement('div');
        const handle = await mountKerasViewer(
            { fileName: 'nested.keras', data: nestedKerasArchive() },
            container,
            ctx,
            { styleIsolation: 'scoped' }
        );

        // The nested sub-model's own layers are indented by one level.
        expect(rows(container).map(row => cells(row)[1])).toEqual([
            'features', 'encoder', '· input_layer_1', '· encoded', 'logits'
        ]);

        button(container, 'keras.tab.files').click();
        expect(rows(container).map(row => cells(row)[0])).toEqual([
            'metadata.json', 'config.json', 'model.weights.h5'
        ]);

        const search = container.querySelector('input') as HTMLInputElement;
        search.value = 'nothing-matches';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(container.querySelector('.omni-keras__empty')?.textContent).toBe('keras.noData');
        handle.dispose();
    });

    it('filters every panel through the search box', async () => {
        const container = document.createElement('div');
        const handle = await mountKerasViewer(
            { fileName: 'sequential.h5', data: legacyKerasHdf5() },
            container,
            ctx,
            { styleIsolation: 'scoped' }
        );
        const search = container.querySelector('input') as HTMLInputElement;

        search.value = 'dropout';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(rows(container)).toHaveLength(1);
        expect(container.querySelector('.omni-keras__panel-header span')?.textContent).toBe('1/4');

        button(container, 'keras.tab.weights').click();
        expect(rows(container)).toHaveLength(0);
        expect(container.querySelector('.omni-keras__empty')?.textContent).toBe('keras.noWeights');

        search.value = 'bias';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(rows(container)).toHaveLength(2);
        handle.dispose();
    });

    it('surfaces parser warnings and an empty layer list for a non-Keras HDF5 file', async () => {
        const container = document.createElement('div');
        const handle = await mountKerasViewer(
            { fileName: 'sensors.h5', data: plainHdf5() },
            container,
            ctx,
            { styleIsolation: 'scoped' }
        );

        const warnings = container.querySelector('.omni-keras__warnings') as HTMLElement;
        expect(warnings.hidden).toBe(false);
        expect(warnings.textContent).toContain('keras.warning.configMissingHdf5');
        expect(container.querySelector('.omni-keras__empty')?.textContent).toBe('keras.noLayers');
        handle.dispose();
    });

    it('copies the model as JSON when the host offers a clipboard', async () => {
        const container = document.createElement('div');
        const writeText = vi.fn().mockResolvedValue(undefined);
        const handle = await mountKerasViewer(
            { fileName: 'sequential.h5', data: legacyKerasHdf5() },
            container,
            { ...ctx, clipboard: { writeText } },
            { styleIsolation: 'scoped' }
        );

        button(container, 'keras.copyJson').click();
        expect(writeText).toHaveBeenCalledOnce();
        expect(JSON.parse(writeText.mock.calls[0]![0] as string)).toMatchObject({ modelClass: 'Sequential' });
        handle.dispose();
    });

    it('disables the copy button without a clipboard service', async () => {
        const container = document.createElement('div');
        const handle = await mountKerasViewer(
            { fileName: 'sequential.h5', data: legacyKerasHdf5() },
            container,
            ctx,
            { styleIsolation: 'scoped' }
        );

        expect(button(container, 'keras.copyJson').disabled).toBe(true);
        handle.dispose();
    });

    it('renders inside a shadow root by default', async () => {
        const container = document.createElement('div');
        const handle = await mountKerasViewer(
            { fileName: 'sequential.h5', data: legacyKerasHdf5() },
            container,
            ctx
        );

        expect(container.shadowRoot?.querySelector('style')?.textContent).toContain('.omni-keras');
        expect(container.shadowRoot?.querySelector('.omni-keras')).not.toBeNull();
        handle.dispose();
        expect(container.shadowRoot?.querySelector('.omni-keras')).toBeNull();
    });

    it('aborts before and after parsing', async () => {
        const container = document.createElement('div');
        const controller = new AbortController();
        controller.abort();
        await expect(mountKerasViewer(
            { fileName: 'sequential.h5', data: legacyKerasHdf5() },
            container,
            ctx,
            { signal: controller.signal }
        )).rejects.toBeInstanceOf(MountAbortedError);
        expect(container.innerHTML).toBe('');
    });
});
