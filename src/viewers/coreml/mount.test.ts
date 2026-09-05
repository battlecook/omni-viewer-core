// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
    coremlBranchFixture,
    coremlMultiFunctionFixture,
    coremlNeuralNetworkFixture,
    coremlPackageFixture,
    coremlPipelineFixture,
    coremlProgramCustomOpFixture,
    coremlProgramFixture,
    coremlWideNetworkFixture
} from '../../parsers/coreml/__tests__/fixture.js';
import { parseCoremlSpec } from '../../parsers/coreml/index.js';
import { MountAbortedError } from '../types.js';
import { mountCoremlDocument, mountCoremlViewer } from './index.js';

const ctx = {
    assets: { resolveAssetUrl: async (path: string) => path },
    logger: { log: vi.fn() },
    i18n: {
        t: (key: string, args?: Record<string, string | number>) =>
            key === 'coreml.rows' ? `${args?.shown} / ${args?.total}`
                : key === 'coreml.graphLimited' ? `limited ${args?.shown}/${args?.total}`
                    : key === 'coreml.moreItems' ? `+${args?.count} more`
                        : key === 'coreml.blobPresent' ? `present ${args?.count} ${args?.size}`
                            : key === 'coreml.blobAbsent' ? `absent ${args?.count}`
                                : key
    }
};

const tab = (container: HTMLElement, key: string): HTMLButtonElement =>
    [...container.querySelectorAll('button')].find(button => button.textContent === key) as HTMLButtonElement;

const inspectorOf = (container: HTMLElement): HTMLElement =>
    container.querySelector('.omni-coreml__inspector') as HTMLElement;

const mount = (bytes: Uint8Array, fileName = 'model.mlmodel'): HTMLElement => {
    const container = document.createElement('div');
    mountCoremlDocument(parseCoremlSpec(bytes), fileName, container, ctx, { styleIsolation: 'scoped' });
    return container;
};

describe('mountCoremlViewer', () => {
    it('renders the header, graph, tables, and model info, then disposes cleanly', async () => {
        const container = document.createElement('div');
        const handle = await mountCoremlViewer(
            { fileName: 'classifier.mlmodel', data: coremlProgramFixture() },
            container,
            ctx,
            { styleIsolation: 'scoped' }
        );
        expect(container.textContent).toContain('classifier.mlmodel');
        expect(container.textContent).toContain('iOS 17 · macOS 14 (Core ML 7)');
        // conv, relu, cond, softmax are operations; the two `const` ops are
        // drawn as constants, and the image input and probabilities output
        // get their own cards.
        expect(container.querySelectorAll('.omni-coreml__node--node')).toHaveLength(4);
        expect(container.querySelectorAll('.omni-coreml__node--constant')).toHaveLength(2);
        expect(container.querySelectorAll('.omni-coreml__node--input')).toHaveLength(1);
        expect(container.querySelectorAll('.omni-coreml__node--output')).toHaveLength(1);
        expect(container.querySelectorAll('.omni-coreml__edge').length).toBeGreaterThan(0);

        tab(container, 'coreml.operations').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(6);

        tab(container, 'coreml.io').click();
        expect(container.textContent).toContain('image 224 × 224 RGB');
        expect(container.textContent).toContain('dictionary<string, double>');

        tab(container, 'coreml.weights').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
        expect(container.textContent).toContain('weight.bin+64');
        expect(container.textContent).toContain('absent 2');

        tab(container, 'coreml.modelInfo').click();
        expect(container.textContent).toContain('mlProgram');
        expect(container.textContent).toContain('Omni Viewer');
        expect(container.textContent).toContain('com.omni.source');

        handle.dispose();
        expect(container.children).toHaveLength(0);
        expect(container.classList.contains('omni-viewer')).toBe(false);
    });

    it('inspects an operation with its named operands, attributes, and weights', () => {
        const container = mount(coremlNeuralNetworkFixture(), 'classifier.mlmodel');
        const inspector = inspectorOf(container);
        expect(inspector.textContent).toContain('convolution');
        expect(inspector.textContent).toContain('outputChannels');
        expect(inspector.textContent).toContain('kernelSize');

        const fc = [...container.querySelectorAll<HTMLButtonElement>('.omni-coreml__node--node')]
            .find(card => card.textContent?.includes('innerProduct'))!;
        fc.click();
        expect(fc.classList.contains('omni-coreml__node--selected')).toBe(true);
        expect(inspector.textContent).toContain('weights · RAW');
        expect(inspector.textContent).toContain('linear 8-bit');
        expect(inspector.textContent).toContain('coreml.updatable');
    });

    it('draws a declared input as an input card in every model family', () => {
        // The card kind comes from the graph's declared inputs, so a family
        // that leaves them empty would style its real inputs identically to a
        // dangling operand — and to a constant.
        for (const bytes of [coremlProgramFixture(), coremlNeuralNetworkFixture(), coremlPipelineFixture()]) {
            const container = mount(bytes);
            const inputs = [...container.querySelectorAll<HTMLElement>('.omni-coreml__node--input')];
            expect(inputs).toHaveLength(1);
            expect(inputs[0]!.textContent).not.toContain('coreml.external');
        }
        const network = mount(coremlNeuralNetworkFixture());
        expect(network.querySelector('.omni-coreml__node--input strong')?.textContent).toBe('image');
    });

    it('marks a custom operation and warns about it, in both encodings', () => {
        // An ML Program spells this `custom_layer`, not `custom`; testing the
        // type name would drop the red card and the warning for the format
        // every current export uses.
        for (const bytes of [coremlNeuralNetworkFixture(), coremlProgramCustomOpFixture()]) {
            const container = mount(bytes);
            expect(container.querySelectorAll('.omni-coreml__node--custom')).toHaveLength(1);
            expect(container.querySelector('.omni-coreml__warnings')?.getAttribute('role')).toBe('status');
            expect(container.querySelector('.omni-coreml__warnings')?.textContent)
                .toContain('coreml.warning.customLayers');
        }
    });

    it('navigates into a nested block from the inspector and back via the picker', () => {
        const container = mount(coremlProgramFixture());
        const inspector = inspectorOf(container);
        const cond = [...container.querySelectorAll<HTMLButtonElement>('.omni-coreml__node--node')]
            .find(card => card.textContent?.includes('cond'))!;
        cond.click();
        const link = container.querySelector<HTMLButtonElement>('.omni-coreml__link')!;
        expect(link.textContent).toContain('block');
        link.click();

        const picker = container.querySelector('select') as HTMLSelectElement;
        expect(picker.value).toBe('1');
        expect(container.textContent).toContain('reduce_mean');

        picker.value = '0';
        picker.dispatchEvent(new Event('change', { bubbles: true }));
        expect(container.textContent).toContain('softmax');
    });

    it('offers a branch layer both of its arms as graphs', () => {
        const container = mount(coremlBranchFixture());
        inspectorOf(container);
        const links = [...container.querySelectorAll<HTMLButtonElement>('.omni-coreml__link')];
        expect(links.map(link => link.textContent)).toEqual(['gate · ifBranch', 'gate · elseBranch']);
        links[1]!.click();
        expect(container.textContent).toContain('else_relu');
    });

    it('draws pipeline stages as their own card kind', () => {
        const container = mount(coremlPipelineFixture());
        const stages = [...container.querySelectorAll<HTMLElement>('.omni-coreml__node--stage')];
        expect(stages.map(card => card.querySelector('strong')?.textContent)).toEqual(['scaler', 'regressor']);
        // The scaler carries no graph of its own, so only the regressor links.
        stages[0]!.click();
        expect(container.querySelectorAll('.omni-coreml__link')).toHaveLength(0);
        stages[1]!.click();
        expect(container.querySelectorAll('.omni-coreml__link')).toHaveLength(1);
    });

    it('lists every function on the inputs and outputs tab', () => {
        const container = mount(coremlMultiFunctionFixture());
        tab(container, 'coreml.io').click();
        const text = container.textContent ?? '';
        expect(text).toContain('prompt');
        expect(text).toContain('extend (coreml.default)');
        expect(text).toContain('multiArray INT32[1, 128]');
        expect(container.querySelectorAll('tbody tr')).toHaveLength(6);
    });

    it('hides the graph picker for a single-graph model and bounds a wide graph', () => {
        const single = mount(coremlNeuralNetworkFixture());
        expect((single.querySelector('select') as HTMLSelectElement).hidden).toBe(true);

        const wide = mount(coremlWideNetworkFixture(600));
        expect(wide.querySelectorAll('.omni-coreml__node').length).toBeLessThanOrEqual(400);
        // 600 layers + one graph input + one output, with 240 layers drawn.
        expect(wide.querySelector('.omni-coreml__graph-limit')?.textContent).toBe('limited 242/602');
    });

    it('answers a search the same way on the graph and the operations table', () => {
        const container = mount(coremlNeuralNetworkFixture());
        const search = container.querySelector('input') as HTMLInputElement;
        search.value = 'outputchannels';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        const lit = [...container.querySelectorAll<HTMLElement>('.omni-coreml__node--node')]
            .filter(card => !card.classList.contains('omni-coreml__node--dim'));
        expect(lit.map(card => card.querySelector('strong')?.textContent)).toEqual(['conv1', 'fc']);

        tab(container, 'coreml.operations').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    });

    it('reports no matches rather than an empty table', () => {
        const container = mount(coremlNeuralNetworkFixture());
        tab(container, 'coreml.operations').click();
        const search = container.querySelector('input') as HTMLInputElement;
        search.value = 'nothing-matches-this';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(container.querySelector('.omni-coreml__empty')?.textContent).toBe('coreml.noMatches');
        expect(container.querySelector('.omni-coreml__panel-header span')?.textContent).toBe('0 / 0');
    });

    it('shows the package tab only for a packaged model', async () => {
        const bare = mount(coremlProgramFixture());
        expect(tab(bare, 'coreml.packageContents')).toBeUndefined();

        const container = document.createElement('div');
        await mountCoremlViewer(
            { fileName: 'Classifier.mlpackage', data: coremlPackageFixture() },
            container, ctx, { styleIsolation: 'scoped' }
        );
        expect(container.querySelector('.omni-coreml__badge')?.textContent).toBe('coreml.package');
        tab(container, 'coreml.packageContents').click();
        expect(container.textContent).toContain('Data/com.apple.CoreML/weights/weight.bin');
        expect(container.textContent).toContain('coreml.rootItem');

        tab(container, 'coreml.weights').click();
        expect(container.textContent).toContain('present 2 8.00 KB');
    });

    it('opens on the model info tab when the model carries no graph', () => {
        const container = mount(coremlPipelineFixture());
        // A pipeline does carry a graph, so the graph tab stays selected.
        expect(container.querySelector('.omni-coreml__canvas')).not.toBeNull();
    });

    it('copies the normalized model as JSON and honours an aborted mount', async () => {
        const writeText = vi.fn(async (_text: string) => undefined);
        const container = document.createElement('div');
        mountCoremlDocument(
            parseCoremlSpec(coremlProgramFixture()), 'classifier.mlmodel', container,
            { ...ctx, clipboard: { writeText } }, { styleIsolation: 'scoped' }
        );
        tab(container, 'coreml.copyJson').click();
        await Promise.resolve();
        expect(JSON.parse(writeText.mock.calls[0]![0]).format).toBe('coreml');

        await expect(mountCoremlViewer(
            { fileName: 'classifier.mlmodel', data: coremlProgramFixture() },
            document.createElement('div'),
            ctx,
            { signal: AbortSignal.abort() }
        )).rejects.toBeInstanceOf(MountAbortedError);
    });
});
