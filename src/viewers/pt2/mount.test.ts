// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { aotiArchive, legacyArchive, multiArchive, richArchive, tinyArchive } from '../../parsers/pt2/__tests__/fixture.js';
import { parsePt2 } from '../../parsers/pt2/index.js';
import { createCatalogI18n } from '../../i18n/index.js';
import { MountAbortedError } from '../types.js';
import { mountPt2Document, mountPt2Viewer } from './index.js';

const ctx = {
    assets: { resolveAssetUrl: async (path: string) => path },
    logger: { log: vi.fn() },
    i18n: { t: (key: string, args?: Record<string, string | number>) => key === 'pt2.rows' ? `${args?.shown} / ${args?.total}` : key }
};

const buttons = (container: HTMLElement) => [...container.querySelectorAll('button')];
const tab = (container: HTMLElement, key: string) => buttons(container).find(button => button.textContent === key) as HTMLButtonElement;
const cards = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('.omni-pt2__node')];
const card = (container: HTMLElement, title: string) => cards(container).find(item => item.querySelector('strong')?.textContent === title)!;
const setSearch = (container: HTMLElement, value: string) => {
    const search = container.querySelector('input') as HTMLInputElement;
    search.value = value;
    search.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('mountPt2Viewer', () => {
    it('renders the graph, inspector, searchable tables, and disposes cleanly', async () => {
        const container = document.createElement('div');
        const handle = await mountPt2Viewer({ fileName: 'tiny.pt2', data: tinyArchive() }, container, ctx, { styleIsolation: 'scoped' });
        expect(container.textContent).toContain('tiny.pt2');
        expect(container.textContent).toContain('PyTorch Export · PT2');
        expect(container.textContent).toContain('torch 2.14.0');
        expect(container.querySelector<HTMLElement>('.omni-pt2__warnings')!.hidden).toBe(true);
        expect(container.querySelector<HTMLElement>('.omni-pt2__model')!.hidden).toBe(true);

        // 5 placeholders + 5 nodes + 2 outputs.
        expect(cards(container)).toHaveLength(12);
        expect(container.querySelectorAll('.omni-pt2__node--input')).toHaveLength(2);
        expect(container.querySelectorAll('.omni-pt2__node--param')).toHaveLength(2);
        expect(container.querySelectorAll('.omni-pt2__node--buffer')).toHaveLength(1);
        expect(container.querySelectorAll('.omni-pt2__node--output')).toHaveLength(2);
        expect(container.querySelectorAll('.omni-pt2__edge')).toHaveLength(11);
        expect(container.querySelectorAll('.omni-pt2__edge--output')).toHaveLength(2);

        // Consumers sit right of producers; a parameter sits one column before its reader.
        const left = (title: string) => Number.parseFloat(card(container, title).style.left);
        expect(left('linear')).toBeGreaterThan(left('x'));
        expect(left('relu')).toBeGreaterThan(left('linear'));
        expect(left('fc.weight')).toBe(left('x'));
        expect(left('scale')).toBe(left('relu'));
        expect(left('add')).toBeGreaterThan(left('mul'));

        const inspector = container.querySelector('.omni-pt2__inspector')!;
        expect(inspector.textContent).toContain('torch.ops.aten.linear.default'); // first node is preselected
        expect(inspector.textContent).toContain('input=x');
        expect(inspector.textContent).toContain('weight=p_fc_weight ← fc.weight');
        expect(inspector.textContent).toContain('linear: f32[s17 (hint 2), 3] → relu');
        expect(inspector.textContent).toContain('model.py');
        card(container, 'fc.weight').click();
        expect(inspector.textContent).toContain('pt2.kind.parameter');
        expect(inspector.textContent).toContain('data/weights/weight_0');
        expect(inspector.textContent).toContain('pt2.status.raw');
        expect(inspector.textContent).toContain('0.5, -1.25, 2');
        expect(inspector.textContent).toContain('→ linear (aten.linear.default)');
        card(container, 'add').click();
        expect(inspector.textContent).toContain('other=y');
        expect(inspector.textContent).toContain('pt2.inspector.moduleStack');
        const outputCard = cards(container).filter(item => item.classList.contains('omni-pt2__node--output'))[1]!;
        outputCard.click();
        expect(inspector.textContent).toContain('pt2.kind.user_output');
        expect(inspector.textContent).toContain('← sum_1 (aten.sum.default)');

        setSearch(container, 'relu');
        expect(container.querySelectorAll('.omni-pt2__node--dim')).toHaveLength(10); // relu node + mul (which reads relu)
        setSearch(container, 'fc.');
        expect(cards(container).filter(item => !item.classList.contains('omni-pt2__node--dim')).map(item => item.querySelector('strong')?.textContent)).toEqual(['fc.weight', 'fc.bias']);

        tab(container, 'pt2.nodes').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
        setSearch(container, 'relu');
        expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
        setSearch(container, '');
        expect(container.querySelectorAll('tbody tr')).toHaveLength(5);
        expect(container.textContent).toContain('aten.linear.default');

        tab(container, 'pt2.weights').click();
        const weightRows = [...container.querySelectorAll('tbody tr')].map(row => row.textContent);
        expect(weightRows).toHaveLength(3);
        expect(weightRows[0]).toContain('fc.weight');
        expect(weightRows[0]).toContain('3 × 4');
        expect(weightRows[2]).toContain('pt2.kind.buffer');

        tab(container, 'pt2.io').click();
        const ioRows = [...container.querySelectorAll('tbody tr')].map(row => row.textContent);
        expect(ioRows).toHaveLength(7);
        expect(ioRows[2]).toContain('pt2.persistent');
        expect(ioRows[3]).toContain('pt2.kind.user_input');
        expect(ioRows[5]).toContain('pt2.side.output');

        tab(container, 'pt2.modules').click();
        const moduleRows = [...container.querySelectorAll('tbody tr')].map(row => row.textContent);
        expect(moduleRows).toHaveLength(3);
        expect(moduleRows[0]).toContain('pt2.rootModule');
        expect(moduleRows[0]).toContain('pt2.preserved');
        expect(moduleRows[2]).toContain('· fc');

        tab(container, 'pt2.modelInfo').click();
        expect(container.textContent).toContain('pt2.info.rangeConstraint: s17');
        expect(container.textContent).toContain('[1, 64]');
        expect(container.textContent).toContain("L['x'].size()[0]");
        setSearch(container, 'operator');
        expect(container.querySelectorAll('dd')).toHaveLength(5);

        tab(container, 'pt2.archive').click();
        setSearch(container, '');
        expect(container.textContent).toContain('archive_format');
        expect(container.textContent).toContain('pt2.layout.pt2');
        expect(container.querySelectorAll('tbody tr')).toHaveLength(12);
        expect(container.textContent).toContain('pt2.category.weights');

        handle.dispose();
        expect(container.innerHTML).toBe('');
        expect(container.classList.contains('omni-viewer')).toBe(false);
    });

    it('shows control-flow sub-graphs, constants, and payload statuses', async () => {
        const container = document.createElement('div');
        const handle = await mountPt2Viewer({ fileName: 'rich.pt2', data: richArchive() }, container, ctx, { styleIsolation: 'scoped' });
        const warnings = container.querySelector<HTMLElement>('.omni-pt2__warnings')!;
        expect(warnings.hidden).toBe(false);
        expect(warnings.textContent).toContain('pt2.warning.payloadMissing');
        expect(container.querySelectorAll('.omni-pt2__node--hop')).toHaveLength(1);
        expect(container.querySelectorAll('.omni-pt2__node--constant')).toHaveLength(2);

        const inspector = container.querySelector('.omni-pt2__inspector')!;
        card(container, 'cond').click();
        expect(inspector.textContent).toContain('torch.ops.higher_order.cond');
        expect(inspector.textContent).toContain('pt2.inspector.subgraph');
        expect(inspector.textContent).toContain('mul · aten.mul.Tensor');
        expect(inspector.textContent).toContain('add · aten.add.Tensor');
        expect(inspector.textContent).toContain('custom');
        card(container, 'half').click();
        expect(inspector.textContent).toContain('pt2.kind.tensor_constant');
        expect(inspector.textContent).toContain('f16');
        expect(inspector.textContent).toContain('1, 2');
        card(container, 'sub.bn.running_mean').click();
        expect(inspector.textContent).toContain('pt2.status.truncated');
        expect(inspector.textContent).toContain('pt2.nonPersistent');

        // The sub-graph nodes are searchable from the graph and listed in the node table.
        setSearch(container, 'false_graph');
        expect(cards(container).filter(item => !item.classList.contains('omni-pt2__node--dim')).map(item => item.querySelector('strong')?.textContent)).toEqual(['cond']);
        tab(container, 'pt2.nodes').click();
        const rows = [...container.querySelectorAll('tbody tr')].map(row => row.textContent);
        expect(rows).toHaveLength(2);
        expect(rows[1]).toContain('false_graph_0');
        setSearch(container, '');
        expect(container.querySelectorAll('tbody tr')).toHaveLength(16);

        tab(container, 'pt2.weights').click();
        const weightRows = [...container.querySelectorAll('tbody tr')].map(row => row.textContent);
        expect(weightRows).toHaveLength(8);
        expect(weightRows[6]).toContain('pt2.status.missing');
        expect(weightRows[7]).toContain('pt2.kind.custom_obj');
        expect(weightRows[7]).toContain('pt2.status.pickled');

        tab(container, 'pt2.io').click();
        const ioRows = [...container.querySelectorAll('tbody tr')].map(row => row.textContent);
        expect(ioRows[7]).toContain('pt2.kind.constant_input');
        expect(ioRows[7]).toContain('3');
        expect(ioRows[9]).toContain('pt2.kind.buffer_mutation');
        expect(ioRows[9]).toContain('counter');
        expect(ioRows[10]).toContain('Sym(2*s77 (hint 4))');
        handle.dispose();
    });

    it('switches between the programs of a multi-model package and lists extra files', async () => {
        const container = document.createElement('div');
        const handle = await mountPt2Viewer({ fileName: 'multi.pt2', data: multiArchive() }, container, ctx, { styleIsolation: 'scoped' });
        const select = container.querySelector<HTMLSelectElement>('.omni-pt2__model')!;
        expect(select.hidden).toBe(false);
        expect([...select.options].map(option => option.value)).toEqual(['decoder', 'encoder']);
        expect(container.textContent).toContain('decoder · torch 2.14.0');
        expect(cards(container).length).toBeGreaterThan(12);
        select.value = 'encoder';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        expect(container.textContent).toContain('encoder · torch 2.14.0');
        expect(cards(container)).toHaveLength(12);
        tab(container, 'pt2.archive').click();
        expect(container.textContent).toContain('pt2.extraFiles');
        expect(container.textContent).toContain('note.txt');
        expect(container.querySelector('pre')?.textContent).toBe('{"k": 1}');
        handle.dispose();
    });

    it('opens an AOTInductor-only package on the archive tab and a legacy archive with its notice', async () => {
        const container = document.createElement('div');
        const handle = await mountPt2Viewer({ fileName: 'aoti.pt2', data: aotiArchive() }, container, ctx, { styleIsolation: 'scoped' });
        expect(buttons(container).map(button => button.textContent)).toEqual(['pt2.archive', 'pt2.copyJson']);
        expect(container.textContent).toContain('pt2.warning.aotiOnly');
        expect(container.textContent).toContain('pt2.info.aotInductor: model');
        expect(container.textContent).toContain('AOTI_PLATFORM');
        expect(container.textContent).toContain('abc.wrapper.so');
        handle.dispose();

        const legacy = document.createElement('div');
        const legacyHandle = await mountPt2Viewer({ fileName: 'old.pt2', data: legacyArchive() }, legacy, ctx, { styleIsolation: 'scoped' });
        expect(legacy.textContent).toContain('pt2.eyebrowLegacy');
        expect(legacy.textContent).toContain('pt2.warning.legacyLayout');
        expect(cards(legacy)).toHaveLength(12);
        card(legacy, 'fc.weight').click();
        expect(legacy.querySelector('.omni-pt2__inspector')!.textContent).toContain('pt2.status.pickled');
        legacyHandle.dispose();
    });

    it('copies the document as JSON, uses shadow DOM by default, and honours abort signals', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        const container = document.createElement('div');
        const handle = await mountPt2Viewer({ fileName: 'tiny.pt2', data: tinyArchive() }, container, { ...ctx, clipboard: { writeText } });
        expect(container.shadowRoot).not.toBeNull();
        expect(container.shadowRoot!.querySelector('style')?.textContent).toContain('.omni-pt2');
        const copy = [...container.shadowRoot!.querySelectorAll('button')].find(button => button.textContent === 'pt2.copyJson')!;
        copy.click();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(JSON.parse(writeText.mock.calls[0]![0] as string).models[0].name).toBe('model');
        handle.dispose();
        expect(container.shadowRoot!.childNodes).toHaveLength(0);

        const controller = new AbortController();
        controller.abort();
        await expect(mountPt2Viewer({ fileName: 'tiny.pt2', data: tinyArchive() }, document.createElement('div'), ctx, { signal: controller.signal })).rejects.toBeInstanceOf(MountAbortedError);
        const parsed = await parsePt2(tinyArchive());
        expect(() => mountPt2Document(parsed, 'tiny.pt2', document.createElement('div'), ctx, { signal: controller.signal })).toThrow(MountAbortedError);
    });

    it('renders every label through the English catalog', async () => {
        const container = document.createElement('div');
        const i18n = createCatalogI18n('en');
        const handle = await mountPt2Viewer({ fileName: 'rich.pt2', data: richArchive() }, container, { ...ctx, i18n }, { styleIsolation: 'scoped' });
        for (const key of ['pt2.graph', 'pt2.nodes', 'pt2.weights', 'pt2.io', 'pt2.modules', 'pt2.modelInfo', 'pt2.archive']) {
            const button = buttons(container).find(item => item.textContent === i18n.t(key))!;
            button.click();
            expect(container.textContent).not.toMatch(/pt2\.[a-zA-Z.]+/);
        }
        buttons(container).find(item => item.textContent === i18n.t('pt2.graph'))!.click();
        card(container, 'cond').click();
        expect(container.querySelector('.omni-pt2__inspector')!.textContent).toContain('Sub-graphs');
        expect(container.textContent).not.toMatch(/pt2\.[a-zA-Z.]+/);
        handle.dispose();
    });
});
