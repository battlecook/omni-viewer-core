// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { IR_LOOP_XML, IR_V11_XML, IR_V7_XML, encode, irV11Weights } from '../../parsers/openvino/__tests__/fixture.js';
import { parseOpenVino } from '../../parsers/openvino/index.js';
import { createCatalogI18n } from '../../i18n/index.js';
import { MountAbortedError } from '../types.js';
import { mountOpenVinoDocument, mountOpenVinoViewer } from './index.js';

const ctx = {
    assets: { resolveAssetUrl: async (path: string) => path },
    logger: { log: vi.fn() },
    i18n: { t: (key: string, args?: Record<string, string | number>) => key === 'openvino.rows' ? `${args?.shown} / ${args?.total}` : key }
};

const buttons = (container: HTMLElement) => [...container.querySelectorAll('button')];
const tab = (container: HTMLElement, key: string) => buttons(container).find(button => button.textContent === key) as HTMLButtonElement;

describe('mountOpenVinoViewer', () => {
    it('renders the graph, inspector, searchable tables, and disposes cleanly', async () => {
        const container = document.createElement('div');
        const handle = await mountOpenVinoViewer({ fileName: 'tiny_mlp.xml', data: encode(IR_V11_XML) }, container, ctx, { styleIsolation: 'scoped', sidecars: { bin: irV11Weights() } });
        expect(container.textContent).toContain('tiny_mlp.xml');
        expect(container.textContent).toContain('OpenVINO IR');
        expect(container.querySelectorAll('.omni-openvino__node')).toHaveLength(7);
        expect(container.querySelectorAll('.omni-openvino__node--input')).toHaveLength(1);
        expect(container.querySelectorAll('.omni-openvino__node--const')).toHaveLength(2);
        expect(container.querySelectorAll('.omni-openvino__node--output')).toHaveLength(1);
        expect(container.querySelectorAll('.omni-openvino__edge')).toHaveLength(6);
        expect(container.querySelectorAll('.omni-openvino__edge--output')).toHaveLength(1);
        expect(container.querySelector<HTMLElement>('.omni-openvino__warnings')!.hidden).toBe(true);

        // Layers on the same column never overlap; consumers sit right of producers.
        const left = (name: string) => Number.parseFloat([...container.querySelectorAll<HTMLElement>('.omni-openvino__node')].find(card => card.querySelector('strong')?.textContent === name)!.style.left);
        expect(left('fc')).toBeGreaterThan(left('input'));
        expect(left('relu')).toBeGreaterThan(left('add'));

        const inspector = container.querySelector('.omni-openvino__inspector')!;
        expect(inspector.textContent).toContain('input'); // first non-Const layer is preselected
        const weightsCard = [...container.querySelectorAll<HTMLButtonElement>('.omni-openvino__node--const')].find(card => card.textContent?.includes('fc/weights'))!;
        weightsCard.click();
        expect(inspector.textContent).toContain('openvino.inspector.weights');
        expect(inspector.textContent).toContain('0.5, -1.25, 2');
        expect(inspector.textContent).toContain('openvino.status.available');
        const biasCard = [...container.querySelectorAll<HTMLButtonElement>('.omni-openvino__node--const')].find(card => card.textContent?.includes('fc/bias'))!;
        biasCard.click();
        expect(inspector.textContent).toContain('decompression=');
        const matmul = [...container.querySelectorAll<HTMLButtonElement>('.omni-openvino__node--node')].find(card => card.textContent?.includes('MatMul'))!;
        matmul.click();
        expect(inspector.textContent).toContain('← input:0');
        expect(inspector.textContent).toContain('→ add');
        expect(inspector.textContent).toContain('transpose_b');
        expect(inspector.textContent).toContain('layout');

        const search = container.querySelector('input') as HTMLInputElement;
        search.value = 'relu';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        // Matches the ReLU layer and the Result whose output_names include "relu".
        const dimmed = container.querySelectorAll('.omni-openvino__node--dim');
        expect(dimmed).toHaveLength(5);

        tab(container, 'openvino.layers').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
        expect(container.textContent).toContain('ReLU');
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(container.querySelectorAll('tbody tr')).toHaveLength(7);

        tab(container, 'openvino.constants').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
        expect(container.textContent).toContain('4 × 2');

        tab(container, 'openvino.io').click();
        const rows = [...container.querySelectorAll('tbody tr')].map(row => row.textContent);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toContain('input, x');
        expect(rows[1]).toContain('openvino.kind.output');
        expect(rows[1]).toContain('logits, relu'); // the Result's output_names, not its own input port

        tab(container, 'openvino.modelInfo').click();
        expect(container.textContent).toContain('conversion_parameters.framework');
        expect(container.textContent).toContain('pytorch');
        expect(container.textContent).toContain('opset1');

        handle.dispose();
        expect(container.children).toHaveLength(0);
        expect(container.classList.contains('omni-viewer')).toBe(false);
    });

    it('renders without a .bin and surfaces the parser warnings', async () => {
        const container = document.createElement('div');
        await mountOpenVinoViewer({ fileName: 'legacy.xml', data: encode(IR_V7_XML) }, container, ctx, { styleIsolation: 'scoped' });
        const warnings = container.querySelector<HTMLElement>('.omni-openvino__warnings')!;
        expect(warnings.hidden).toBe(false);
        expect(warnings.textContent).toContain('openvino.warning.legacyVersion');
        expect(warnings.textContent).toContain('openvino.warning.noWeights');
        expect(container.textContent).toContain('openvino.noBin');
        tab(container, 'openvino.constants').click();
        expect(container.textContent).toContain('openvino.status.unchecked');
    });

    it('shows control-flow bodies in the inspector, layer table, and search', async () => {
        const container = document.createElement('div');
        await mountOpenVinoViewer({ fileName: 'loop.xml', data: encode(IR_LOOP_XML) }, container, ctx, { styleIsolation: 'scoped' });
        expect(container.querySelectorAll('.omni-openvino__node')).toHaveLength(4);
        const loop = [...container.querySelectorAll<HTMLButtonElement>('.omni-openvino__node--node')].find(card => card.textContent?.includes('Loop'))!;
        loop.click();
        const inspector = container.querySelector('.omni-openvino__inspector')!;
        expect(inspector.textContent).toContain('openvino.inspector.bodies');
        expect(inspector.textContent).toContain('body_add');
        expect(inspector.textContent).toContain('layout=[N]');
        expect(inspector.textContent).toContain('openvino.inspector.inputPort 1 · fused_names=loop_cond');
        const search = container.querySelector('input') as HTMLInputElement;
        search.value = 'body_add';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(loop.classList.contains('omni-openvino__node--dim')).toBe(false);
        expect(container.querySelectorAll('.omni-openvino__node--dim')).toHaveLength(3);
        tab(container, 'openvino.layers').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
        expect(container.textContent).toContain('body: 4');
        search.value = '';
        tab(container, 'openvino.constants').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
        tab(container, 'openvino.io').click();
        const rows = [...container.querySelectorAll('tbody tr')].map(row => row.textContent);
        expect(rows[0]).toContain('x,0, alias');
        expect(rows[1]).toContain('y'); // no output_names → producer port's tensor name
    });

    it('bounds graph cards, edges, and table rows', () => {
        const model = parseOpenVino(encode(IR_V11_XML));
        model.layers = Array.from({ length: 5000 }, (_, index) => ({ id: String(index), name: `l${index}`, type: 'Relu', version: 'opset1', attributes: [], inputs: [], outputs: [], rtInfo: [], outputNames: [], constants: [], bodies: [] }));
        model.edges = Array.from({ length: 4999 }, (_, index) => ({ fromLayer: String(index), fromPort: '0', toLayer: String(index + 1), toPort: '0' }));
        const container = document.createElement('div');
        mountOpenVinoDocument(model, 'large.xml', container, ctx, { styleIsolation: 'scoped' });
        expect(container.querySelectorAll('.omni-openvino__node')).toHaveLength(240);
        expect(container.querySelectorAll('.omni-openvino__graph-limit')).toHaveLength(1);
        tab(container, 'openvino.layers').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(2000);
        expect(container.querySelector('.omni-openvino__panel-header')?.textContent).toContain('2000 / 5000');
    });

    it('caps drawn connections and says so', () => {
        const model = parseOpenVino(encode(IR_V11_XML));
        model.layers = Array.from({ length: 60 }, (_, index) => ({ id: String(index), name: `l${index}`, type: 'Relu', version: 'opset1', attributes: [], inputs: [], outputs: [], rtInfo: [], outputNames: [], constants: [], bodies: [] }));
        model.edges = [];
        for (let from = 0; from < 60; from++) for (let to = from + 1; to < 60; to++) model.edges.push({ fromLayer: String(from), fromPort: '0', toLayer: String(to), toPort: '0' });
        expect(model.edges.length).toBeGreaterThan(800);
        const container = document.createElement('div');
        mountOpenVinoDocument(model, 'dense.xml', container, ctx, { styleIsolation: 'scoped' });
        expect(container.querySelectorAll('.omni-openvino__edge')).toHaveLength(800);
        expect(container.querySelector('.omni-openvino__graph-limit')?.textContent).toBe('openvino.graphEdgesLimited');
    });

    it('copies the document as JSON when a clipboard is available', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        const container = document.createElement('div');
        await mountOpenVinoViewer({ fileName: 'm.xml', data: encode(IR_V11_XML) }, container, { ...ctx, clipboard: { writeText } }, { styleIsolation: 'scoped' });
        tab(container, 'openvino.copyJson').click();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(JSON.parse(writeText.mock.calls[0]![0] as string).name).toBe('tiny_mlp');
    });

    it('mounts into a shadow root by default and speaks the catalog', async () => {
        const container = document.createElement('div');
        await mountOpenVinoViewer({ fileName: 'm.xml', data: encode(IR_V11_XML) }, container, { ...ctx, i18n: createCatalogI18n('en') });
        expect(container.shadowRoot?.querySelector('h1')?.textContent).toBe('m.xml');
        expect(container.shadowRoot?.textContent).toContain('IR v11');
    });

    it('rejects an aborted mount and invalid input', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(mountOpenVinoViewer({ fileName: 'm.xml', data: encode(IR_V11_XML) }, document.createElement('div'), ctx, { signal: controller.signal })).rejects.toBeInstanceOf(MountAbortedError);
        await expect(mountOpenVinoViewer({ fileName: 'a.xml', data: encode('<AUTOSAR/>') }, document.createElement('div'), ctx)).rejects.toThrow(/root element/);
    });
});
