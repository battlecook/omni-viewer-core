// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { onnxControlFlowFixture, onnxFixture } from '../../parsers/onnx/__tests__/fixture.js';
import { parseOnnx } from '../../parsers/onnx/index.js';
import { createCatalogI18n } from '../../i18n/index.js';
import { MountAbortedError } from '../types.js';
import { mountOnnxDocument, mountOnnxViewer } from './index.js';

const ctx = {
    assets: { resolveAssetUrl: async (path: string) => path },
    logger: { log: vi.fn() },
    i18n: { t: (key: string, args?: Record<string, string | number>) => key === 'onnx.rows' ? `${args?.shown} / ${args?.total}` : key }
};

describe('mountOnnxViewer', () => {
    it('renders an interactive graph, searchable tables, model info, and disposes cleanly', async () => {
        const container = document.createElement('div');
        const handle = await mountOnnxViewer({ fileName: 'classifier.onnx', data: onnxFixture() }, container, ctx, { styleIsolation: 'scoped' });
        expect(container.textContent).toContain('classifier.onnx');
        expect(container.querySelectorAll('.omni-onnx__node--node')).toHaveLength(3);
        expect(container.querySelectorAll('.omni-onnx__node--initializer')).toHaveLength(3);
        expect(container.querySelectorAll('.omni-onnx__edge').length).toBeGreaterThan(0);
        const search = container.querySelector('input') as HTMLInputElement;
        search.value = 'transB';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        const matmulCard = [...container.querySelectorAll<HTMLElement>('.omni-onnx__node--node')].find(node => node.textContent?.includes('MatMul'))!;
        expect(matmulCard.classList.contains('omni-onnx__node--dim')).toBe(false);

        const nodesTab = [...container.querySelectorAll('button')].find(button => button.textContent === 'onnx.nodes') as HTMLButtonElement;
        search.value = '';
        nodesTab.click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
        search.value = 'relu';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
        expect(container.textContent).toContain('Relu');

        const modelTab = [...container.querySelectorAll('button')].find(button => button.textContent === 'onnx.modelInfo') as HTMLButtonElement;
        search.value = '';
        modelTab.click();
        expect(container.textContent).toContain('ai.onnx v18');
        expect(container.textContent).toContain('com.test::Normalize#fast');

        handle.dispose();
        expect(container.children).toHaveLength(0);
        expect(container.classList.contains('omni-viewer')).toBe(false);
    });

    it('bounds all graph cards, including large input and output collections', () => {
        const model = parseOnnx(onnxFixture());
        model.graph.inputs = Array.from({ length: 10_000 }, (_, index) => ({ name: `input-${index}`, type: 'tensor<FLOAT[1]>', description: '', metadata: [] }));
        model.graph.outputs = Array.from({ length: 10_000 }, (_, index) => ({ name: `output-${index}`, type: 'tensor<FLOAT[1]>', description: '', metadata: [] }));
        const container = document.createElement('div');
        mountOnnxDocument(model, 'large.onnx', container, ctx, { styleIsolation: 'scoped' });
        expect(container.querySelectorAll('.omni-onnx__node').length).toBeLessThanOrEqual(400);
        expect(container.querySelector('.omni-onnx__graph-limit')).not.toBeNull();
    });

    it('renders bounded structured control-flow subgraphs in the inspector', () => {
        const container = document.createElement('div');
        mountOnnxDocument(parseOnnx(onnxControlFlowFixture()), 'if.onnx', container, ctx, { styleIsolation: 'scoped' });
        const ifCard = container.querySelector<HTMLButtonElement>('.omni-onnx__node--node')!;
        ifCard.click();
        const inspector = container.querySelector('.omni-onnx__inspector')!;
        expect(inspector.textContent).toContain('then-node');
        expect(inspector.textContent).toContain('else-node');
    });

    it('bounds model and graph metadata rows in the model-info panel', () => {
        const model = parseOnnx(onnxFixture());
        model.metadata = Array.from({ length: 10_000 }, (_, index) => ({ key: `model-${index}`, value: 'x' }));
        model.graph.metadata = Array.from({ length: 10_000 }, (_, index) => ({ key: `graph-${index}`, value: 'y' }));
        const container = document.createElement('div');
        mountOnnxDocument(model, 'metadata.onnx', container, ctx, { styleIsolation: 'scoped' });
        const modelTab = [...container.querySelectorAll('button')].find(button => button.textContent === 'onnx.modelInfo') as HTMLButtonElement;
        modelTab.click();
        expect(container.querySelectorAll('.omni-onnx__model-info dt')).toHaveLength(2000);
        expect(container.querySelector('.omni-onnx__panel-header')?.textContent).toContain('2000 / 200');
    });

    it('searches local functions and device configurations beyond summary previews', () => {
        const model = parseOnnx(onnxFixture());
        const template = model.functions[0]!;
        model.functions = Array.from({ length: 101 }, (_, index) => ({
            ...template, name: `Function${index}`, metadata: [{ key: 'review-key', value: `function-marker-${index}` }]
        }));
        model.configurations = Array.from({ length: 101 }, (_, index) => ({
            name: `Configuration${index}`, numDevices: 1, devices: [`device-marker-${index}`]
        }));
        const container = document.createElement('div');
        mountOnnxDocument(model, 'search-all-model-info.onnx', container, ctx, { styleIsolation: 'scoped' });
        const modelTab = [...container.querySelectorAll('button')].find(button => button.textContent === 'onnx.modelInfo') as HTMLButtonElement;
        modelTab.click();
        const search = container.querySelector('input') as HTMLInputElement;
        for (const query of ['function-marker-100', 'device-marker-100']) {
            search.value = query;
            search.dispatchEvent(new Event('input', { bubbles: true }));
            expect(container.querySelectorAll('.omni-onnx__model-info dt'), query).toHaveLength(1);
        }
    });

    it('keeps topology for dependencies beyond the 64th node port', () => {
        const model = parseOnnx(onnxFixture());
        const producer = model.graph.nodes[0]!;
        const consumer = model.graph.nodes[1]!;
        producer.outputs = Array.from({ length: 65 }, (_, index) => `split-${index}`);
        consumer.inputs = ['split-64'];
        consumer.outputs = ['done'];
        model.graph.nodes = [producer, consumer];
        model.graph.outputs = [{ name: 'done', type: 'tensor<FLOAT[1]>', description: '', metadata: [] }];
        const container = document.createElement('div');
        mountOnnxDocument(model, 'ports.onnx', container, ctx, { styleIsolation: 'scoped' });
        const cards = [...container.querySelectorAll<HTMLElement>('.omni-onnx__node--node')];
        expect(cards).toHaveLength(2);
        expect(Number.parseInt(cards[1]!.style.left)).toBeGreaterThan(Number.parseInt(cards[0]!.style.left));
        expect(container.querySelectorAll('.omni-onnx__edge').length).toBeGreaterThan(0);
    });

    it('searches every port, metadata item, and structured attribute record on graph cards', () => {
        const model = parseOnnx(onnxFixture());
        const node = model.graph.nodes[0]!;
        node.inputs = Array.from({ length: 65 }, (_, index) => `port-${index}`);
        node.metadata = Array.from({ length: 65 }, (_, index) => ({ key: `metadata-${index}`, value: `metadata-value-${index}` }));
        node.attributes[0]!.tensors = [{ ...model.graph.initializers[0]!, name: 'structured-tensor-needle', externalData: [{ key: 'structured-key', value: 'structured-value' }] }];
        const container = document.createElement('div');
        mountOnnxDocument(model, 'complete-search.onnx', container, ctx, { styleIsolation: 'scoped' });
        const search = container.querySelector('input') as HTMLInputElement;
        const card = [...container.querySelectorAll<HTMLElement>('.omni-onnx__node--node')].find(item => item.textContent?.includes('MatMul'))!;
        for (const query of ['port-64', 'metadata-value-64', 'structured-tensor-needle', 'structured-key']) {
            search.value = query;
            search.dispatchEvent(new Event('input', { bubbles: true }));
            expect(card.classList.contains('omni-onnx__node--dim'), query).toBe(false);
        }
    });

    it('warns only when a renderable edge exists beyond the 800-edge limit', () => {
        for (const count of [800, 801]) {
            const model = parseOnnx(onnxFixture());
            const names = Array.from({ length: count }, (_, index) => `edge-${index}`);
            model.graph.inputs = [];
            model.graph.initializers = [];
            model.graph.outputs = [];
            model.graph.nodes = [
                { ...model.graph.nodes[0]!, id: 'many-edge-producer', inputs: [], outputs: names },
                { ...model.graph.nodes[1]!, id: 'many-edge-consumer', inputs: names, outputs: [] }
            ];
            const container = document.createElement('div');
            mountOnnxDocument(model, `${count}-edges.onnx`, container, ctx, { styleIsolation: 'scoped' });
            expect(container.querySelectorAll('.omni-onnx__edge')).toHaveLength(Math.min(count, 800));
            expect(container.textContent?.includes('onnx.graphEdgesLimited'), String(count)).toBe(count > 800);
        }
    });

    it('includes safely omitted structured attributes in preview counts', () => {
        const model = parseOnnx(onnxControlFlowFixture());
        const attribute = model.graph.nodes[0]!.attributes[0]!;
        const graph = attribute.graphs![0]!;
        attribute.graphs = Array.from({ length: 1024 }, () => graph);
        attribute.omitted = { graphs: 1, tensors: 0, sparseTensors: 0, typeProtos: 0 };
        const container = document.createElement('div');
        mountOnnxDocument(model, 'omitted-attributes.onnx', container, ctx, { styleIsolation: 'scoped' });
        container.querySelector<HTMLButtonElement>('.omni-onnx__node--node')!.click();
        expect(container.querySelector('.omni-onnx__inspector')?.textContent).toContain('(+1005)');
    });

    it('shows exact omission counts for type protos and bounded inspector collections', () => {
        const model = parseOnnx(onnxFixture());
        const node = model.graph.nodes[0]!;
        const type = node.attributes.find(item => item.typeProtos?.length)?.typeProtos?.[0]!;
        const tensor = model.graph.initializers[0]!;
        node.attributes = [
            { ...node.attributes[0]!, tensors: Array.from({ length: 9 }, (_, index) => ({ ...tensor, name: `tensor-${index}` })) },
            { ...node.attributes[0]!, name: 'types', value: '', typeProtos: Array.from({ length: 1024 }, () => type), omitted: { graphs: 0, tensors: 0, sparseTensors: 0, typeProtos: 1 } }
        ];
        node.metadata = Array.from({ length: 65 }, (_, index) => ({ key: `key-${index}`, value: 'value' }));
        node.deviceConfigurations = Array.from({ length: 65 }, (_, index) => ({ configurationId: `config-${index}`, pipelineStage: index, sharding: [] }));
        const countCtx = { ...ctx, i18n: { t: (key: string, args?: Record<string, string | number>) => key === 'onnx.moreItems' ? `${args?.count} more` : key } };
        const container = document.createElement('div');
        mountOnnxDocument(model, 'inspector-limits.onnx', container, countCtx, { styleIsolation: 'scoped' });
        const inspectorText = container.querySelector('.omni-onnx__inspector')?.textContent ?? '';
        expect(inspectorText).toContain('(+961)');
        expect(inspectorText.match(/1 more/g)?.length).toBeGreaterThanOrEqual(3);
    });

    it('does not create topology for omitted optional ports', () => {
        const model = parseOnnx(onnxFixture());
        model.graph.inputs = [];
        model.graph.initializers = [];
        model.graph.outputs = [];
        model.graph.nodes = [
            { ...model.graph.nodes[0]!, id: 'optional-producer', inputs: [], outputs: [''] },
            { ...model.graph.nodes[1]!, id: 'optional-consumer', inputs: [''], outputs: [] }
        ];
        const container = document.createElement('div');
        mountOnnxDocument(model, 'optional-ports.onnx', container, ctx, { styleIsolation: 'scoped' });
        const cards = [...container.querySelectorAll<HTMLElement>('.omni-onnx__node--node')];
        expect(cards).toHaveLength(2);
        expect(cards[1]!.style.left).toBe(cards[0]!.style.left);
        expect(container.querySelectorAll('.omni-onnx__edge')).toHaveLength(0);
    });

    it('connects graph inputs and initializers used directly as graph outputs', () => {
        for (const source of ['input', 'initializer'] as const) {
            const model = parseOnnx(onnxFixture());
            model.graph.nodes = [];
            model.graph.inputs = source === 'input'
                ? [model.graph.inputs[0]!]
                : [];
            model.graph.initializers = source === 'initializer'
                ? [model.graph.initializers[0]!]
                : [];
            const name = source === 'input' ? model.graph.inputs[0]!.name : model.graph.initializers[0]!.name;
            model.graph.outputs = [{ name, type: 'tensor<FLOAT[1]>', description: '', metadata: [] }];
            const container = document.createElement('div');
            mountOnnxDocument(model, `${source}-output.onnx`, container, ctx, { styleIsolation: 'scoped' });
            expect(container.querySelectorAll('.omni-onnx__edge'), source).toHaveLength(1);
        }
    });

    it('searches tensor element counts, data sizes, storage labels, and external-data keys', () => {
        const container = document.createElement('div');
        mountOnnxDocument(parseOnnx(onnxFixture(true)), 'tensor-search.onnx', container, ctx, { styleIsolation: 'scoped' });
        const tensorTab = [...container.querySelectorAll('button')].find(button => button.textContent === 'onnx.tensors') as HTMLButtonElement;
        tensorTab.click();
        const search = container.querySelector('input') as HTMLInputElement;
        for (const query of ['12', '48 B', 'external', 'location']) {
            search.value = query;
            search.dispatchEvent(new Event('input', { bubbles: true }));
            expect(container.querySelectorAll('tbody tr').length, query).toBeGreaterThan(0);
        }
    });

    it('localizes summaries, tables, and the node inspector', () => {
        const container = document.createElement('div');
        mountOnnxDocument(parseOnnx(onnxFixture()), 'model.onnx', container, { ...ctx, i18n: createCatalogI18n('ko-KR') }, { styleIsolation: 'scoped' });
        expect(container.textContent).toContain('초기화 텐서');
        expect(container.textContent).toContain('입력');
        const tensorTab = [...container.querySelectorAll('button')].find(button => button.textContent === '텐서') as HTMLButtonElement;
        tensorTab.click();
        expect(container.querySelector('thead')?.textContent).toContain('데이터 크기');
        expect(container.querySelector('thead')?.textContent).toContain('저장 방식');
    });

    it('copies the normalized model and honors the abort contract', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        const container = document.createElement('div');
        await mountOnnxViewer({ fileName: 'model.onnx', data: onnxFixture() }, container, { ...ctx, clipboard: { writeText } }, { styleIsolation: 'scoped' });
        const copy = [...container.querySelectorAll('button')].find(button => button.textContent === 'onnx.copyJson') as HTMLButtonElement;
        copy.click();
        await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
        expect(JSON.parse(writeText.mock.calls[0]![0])).toMatchObject({ format: 'onnx', irVersion: '10' });

        const controller = new AbortController();
        controller.abort();
        await expect(mountOnnxViewer({ fileName: 'model.onnx', data: onnxFixture() }, document.createElement('div'), ctx, { signal: controller.signal }))
            .rejects.toBeInstanceOf(MountAbortedError);
    });
});
