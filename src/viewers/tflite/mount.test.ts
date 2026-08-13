// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
    tfliteControlFlowFixture,
    tfliteExternalBufferFixture,
    tfliteOptionEdgeCasesFixture,
    tfliteFixture,
    tfliteWideGraphFixture
} from '../../parsers/tflite/__tests__/fixture.js';
import { parseTflite } from '../../parsers/tflite/index.js';
import { MountAbortedError } from '../types.js';
import { mountTfliteDocument, mountTfliteViewer } from './index.js';

const ctx = {
    assets: { resolveAssetUrl: async (path: string) => path },
    logger: { log: vi.fn() },
    i18n: {
        t: (key: string, args?: Record<string, string | number>) =>
            key === 'tflite.rows' ? `${args?.shown} / ${args?.total}`
                : key === 'tflite.graphLimited' ? `limited ${args?.shown}/${args?.total}`
                    : key
    }
};

const tab = (container: HTMLElement, key: string): HTMLButtonElement =>
    [...container.querySelectorAll('button')].find(button => button.textContent === key) as HTMLButtonElement;

describe('mountTfliteViewer', () => {
    it('renders the graph, tables, and model info, then disposes cleanly', async () => {
        const container = document.createElement('div');
        const handle = await mountTfliteViewer(
            { fileName: 'classifier.tflite', data: tfliteFixture() },
            container,
            ctx,
            { styleIsolation: 'scoped' }
        );
        expect(container.textContent).toContain('classifier.tflite');
        expect(container.querySelectorAll('.omni-tflite__node--node')).toHaveLength(3);
        expect(container.querySelectorAll('.omni-tflite__node--custom')).toHaveLength(1);
        expect(container.querySelectorAll('.omni-tflite__node--input')).toHaveLength(1);
        expect(container.querySelectorAll('.omni-tflite__node--constant')).toHaveLength(2);
        expect(container.querySelectorAll('.omni-tflite__edge').length).toBeGreaterThan(0);

        const operators = tab(container, 'tflite.operators');
        operators.click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(4);
        const search = container.querySelector('input') as HTMLInputElement;
        // Search reaches operand names, so 'conv' also matches the op consuming conv_out.
        search.value = 'conv';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
        search.value = 'conv_2d';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
        expect(container.textContent).toContain('RELU6');

        search.value = '';
        tab(container, 'tflite.tensors').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(6);
        expect(container.textContent).toContain('per-axis[0] × 4');

        tab(container, 'tflite.buffers').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(5);
        expect(container.textContent).toContain('4096');

        tab(container, 'tflite.io').click();
        expect(container.textContent).toContain('serving_default.image');

        tab(container, 'tflite.modelInfo').click();
        expect(container.textContent).toContain('TFLite_Detection_PostProcess');
        expect(container.textContent).toContain('1.14.0');

        handle.dispose();
        expect(container.children).toHaveLength(0);
        expect(container.classList.contains('omni-viewer')).toBe(false);
    });

    it('inspects an operator, dims non-matching graph cards, and shows tensor details', () => {
        const container = document.createElement('div');
        mountTfliteDocument(parseTflite(tfliteFixture()), 'classifier.tflite', container, ctx, { styleIsolation: 'scoped' });
        const inspector = container.querySelector('.omni-tflite__inspector')!;
        expect(inspector.textContent).toContain('CONV_2D');
        expect(inspector.textContent).toContain('fused_activation_function');

        const constant = container.querySelector<HTMLButtonElement>('.omni-tflite__node--constant')!;
        constant.click();
        expect(inspector.textContent).toContain('conv_weights');
        expect(inspector.textContent).toContain('per-axis[0] × 4');
        expect(constant.classList.contains('omni-tflite__node--selected')).toBe(true);

        const search = container.querySelector('input') as HTMLInputElement;
        search.value = 'fully_connected';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        const cards = [...container.querySelectorAll<HTMLElement>('.omni-tflite__node--node')];
        const connected = cards.find(card => card.textContent?.includes('FULLY_CONNECTED'))!;
        expect(connected.classList.contains('omni-tflite__node--dim')).toBe(false);
        expect(cards.filter(card => card.classList.contains('omni-tflite__node--dim')).length).toBeGreaterThan(0);
    });

    it('switches subgraphs from the picker and from a control-flow reference', () => {
        const container = document.createElement('div');
        mountTfliteDocument(parseTflite(tfliteControlFlowFixture()), 'loop.tflite', container, ctx, { styleIsolation: 'scoped' });
        const inspector = container.querySelector('.omni-tflite__inspector')!;
        expect(inspector.textContent).toContain('WHILE');
        const link = [...container.querySelectorAll<HTMLButtonElement>('.omni-tflite__link')]
            .find(button => button.textContent?.includes('body'))!;
        link.click();
        const picker = container.querySelector('select') as HTMLSelectElement;
        expect(picker.value).toBe('2');
        expect(container.textContent).toContain('body_in');

        picker.value = '1';
        picker.dispatchEvent(new Event('change', { bubbles: true }));
        expect(container.textContent).toContain('cond_in');
    });

    it('hides the subgraph picker for single-subgraph models and bounds large graphs', () => {
        const container = document.createElement('div');
        mountTfliteDocument(parseTflite(tfliteWideGraphFixture(600)), 'wide.tflite', container, ctx, { styleIsolation: 'scoped' });
        expect((container.querySelector('select') as HTMLSelectElement).hidden).toBe(true);
        expect(container.querySelectorAll('.omni-tflite__node').length).toBeLessThanOrEqual(400);
        expect(container.querySelector('.omni-tflite__graph-limit')?.textContent).toContain('limited');
    });

    it('counts every graph card in the limit banner, not just the drawn ones', () => {
        const container = document.createElement('div');
        // 600 operators + 1 graph input + 1 output; the operator list is capped
        // at 240, but the total must still reflect the whole subgraph.
        mountTfliteDocument(parseTflite(tfliteWideGraphFixture(600)), 'wide.tflite', container, ctx, { styleIsolation: 'scoped' });
        expect(container.querySelector('.omni-tflite__graph-limit')?.textContent).toBe('limited 242/602');
    });

    it('draws one card per output tensor even when an index is repeated', () => {
        const model = parseTflite(tfliteControlFlowFixture());
        model.subgraphs[0]!.outputs = [1, 1, 1];
        const container = document.createElement('div');
        mountTfliteDocument(model, 'dup.tflite', container, ctx, { styleIsolation: 'scoped' });
        const outputs = [...container.querySelectorAll<HTMLElement>('.omni-tflite__node--output')];
        expect(outputs).toHaveLength(1);
        expect(new Set(outputs.map(card => card.style.top)).size).toBe(1);
    });

    it('reports the true remaining count for a capped quantization list', () => {
        const container = document.createElement('div');
        mountTfliteDocument(parseTflite(tfliteOptionEdgeCasesFixture()), 'edges.tflite', container, ctx, { styleIsolation: 'scoped' });
        container.querySelector<HTMLButtonElement>('.omni-tflite__node--constant')!.click();
        const inspector = container.querySelector('.omni-tflite__inspector')!;
        expect(inspector.textContent).toContain('per-axis[0] × 100');
        // 16 shown of 100 declared, even though the parser kept only 64.
        expect(inspector.textContent).toContain('… (+84)');
    });

    it('offers no subgraph link for a control-flow op that declared none', () => {
        const container = document.createElement('div');
        mountTfliteDocument(parseTflite(tfliteOptionEdgeCasesFixture()), 'edges.tflite', container, ctx, { styleIsolation: 'scoped' });
        const ifCard = [...container.querySelectorAll<HTMLButtonElement>('.omni-tflite__node--node')]
            .find(card => card.textContent?.includes('IF'))!;
        ifCard.click();
        const inspector = container.querySelector('.omni-tflite__inspector')!;
        expect(inspector.textContent).toContain('then_subgraph_index');
        expect(inspector.querySelectorAll('.omni-tflite__link')).toHaveLength(0);
    });

    it('shows every user of a shared buffer via search and an exact remainder', () => {
        const container = document.createElement('div');
        mountTfliteDocument(parseTflite(tfliteExternalBufferFixture(40)), 'shared.tflite', container, ctx, { styleIsolation: 'scoped' });
        tab(container, 'tflite.buffers').click();
        // 41 tensors reference buffer 0; 8 are shown, so the remainder is exact.
        expect(container.querySelector('tbody tr')?.textContent).toContain('… (+33)');
        const search = container.querySelector('input') as HTMLInputElement;
        search.value = 'act_30';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    });

    it('labels a tensor backed by an external file rather than calling it runtime', () => {
        const container = document.createElement('div');
        mountTfliteDocument(parseTflite(tfliteExternalBufferFixture()), 'external.tflite', container, ctx, { styleIsolation: 'scoped' });
        expect(container.querySelector('.omni-tflite__warnings')?.textContent).toContain('tflite.warning.externalBuffers');
        tab(container, 'tflite.tensors').click();
        const row = container.querySelector('tbody tr')!;
        expect(row.textContent).toContain('tflite.storage.external');
        expect(row.textContent).toContain('4.00 KB');
    });

    it('answers a tensor search the same way on the graph tab and the tensors table', () => {
        const container = document.createElement('div');
        mountTfliteDocument(parseTflite(tfliteFixture()), 'classifier.tflite', container, ctx, { styleIsolation: 'scoped' });
        const search = container.querySelector('input') as HTMLInputElement;
        search.value = 'per-axis';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        const lit = [...container.querySelectorAll<HTMLElement>('.omni-tflite__node--constant')]
            .filter(card => !card.classList.contains('omni-tflite__node--dim'));
        expect(lit).toHaveLength(1);
        expect(lit[0]!.textContent).toContain('conv_weights');
    });

    it('matches the shape label it displays, on both the graph and the table', () => {
        const container = document.createElement('div');
        mountTfliteDocument(parseTflite(tfliteControlFlowFixture()), 'loop.tflite', container, ctx, { styleIsolation: 'scoped' });
        const search = container.querySelector('input') as HTMLInputElement;
        search.value = 'tflite.unknownRank';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        tab(container, 'tflite.tensors').click();
        expect(container.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
    });

    it('copies the normalized model as JSON and honours an aborted mount', async () => {
        const writeText = vi.fn(async (_text: string) => undefined);
        const container = document.createElement('div');
        mountTfliteDocument(parseTflite(tfliteFixture()), 'classifier.tflite', container, { ...ctx, clipboard: { writeText } }, { styleIsolation: 'scoped' });
        const copy = tab(container, 'tflite.copyJson');
        copy.click();
        await Promise.resolve();
        expect(JSON.parse(writeText.mock.calls[0]![0]).format).toBe('tflite');

        await expect(mountTfliteViewer(
            { fileName: 'classifier.tflite', data: tfliteFixture() },
            document.createElement('div'),
            ctx,
            { signal: AbortSignal.abort() }
        )).rejects.toBeInstanceOf(MountAbortedError);
    });

    it('renders parser warnings in a status region', () => {
        const container = document.createElement('div');
        mountTfliteDocument(parseTflite(tfliteFixture()), 'classifier.tflite', container, ctx, { styleIsolation: 'scoped' });
        const warnings = container.querySelector('.omni-tflite__warnings')!;
        expect(warnings.getAttribute('role')).toBe('status');
        expect(warnings.textContent).toContain('tflite.warning.customOps');
        expect(warnings.textContent).toContain('tflite.warning.appendedBuffers');
    });
});
