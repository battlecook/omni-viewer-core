// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { buildProgram, pteFixture, pteHeaderlessSegmentsFixture, pteInlineFixture } from '../../parsers/pte/__tests__/fixture.js';
import { parsePte } from '../../parsers/pte/index.js';
import { MountAbortedError } from '../types.js';
import { mountPteDocument, mountPteViewer } from './index.js';

const ctx = {
    assets: { resolveAssetUrl: async (path: string) => path },
    logger: { log: vi.fn() },
    i18n: {
        t: (key: string, args?: Record<string, string | number>) =>
            key === 'pte.rows' ? `${args?.shown} / ${args?.total}`
                : key === 'pte.graphLimited' ? `limited ${args?.shown}/${args?.total}`
                    : key === 'pte.instructionDetail' ? `#${args?.index} · chain ${args?.chain}`
                        // Interpolated so the tests can see which instruction a jump names.
                        : key === 'pte.jumpTo' || key === 'pte.jumpInvalid' ? `${key} ${args?.index}`
                            : key
    }
};

const tab = (container: HTMLElement, key: string): HTMLButtonElement =>
    [...container.querySelectorAll('button')].find(button => button.textContent === key) as HTMLButtonElement;

const search = (container: HTMLElement, text: string): void => {
    const input = container.querySelector('input') as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
};

/** A method with `count` chained kernel calls, for graph-limit tests. */
function wideProgram(count: number): Uint8Array {
    const values: Parameters<typeof buildProgram>[0]['methods'][0]['values'] = [{ kind: 'Tensor', value: { type: 6, sizes: [2] } }];
    for (let index = 0; index < count; index++) values.push({ kind: 'Tensor', value: { type: 6, sizes: [2], allocation: { memoryId: 1, offset: index * 8 } } });
    return buildProgram({
        methods: [{
            name: 'forward',
            values,
            inputs: [0],
            outputs: [count],
            chains: [{ instructions: Array.from({ length: count }, (_, index) => ({ kind: 'KernelCall' as const, op: 0, args: [index, index + 1] })) }],
            operators: [['aten::relu', 'out']]
        }]
    });
}

describe('mountPteViewer', () => {
    it('renders the graph, tables, and model info, then disposes cleanly', async () => {
        const container = document.createElement('div');
        const handle = await mountPteViewer({ fileName: 'model.pte', data: pteFixture() }, container, ctx, { styleIsolation: 'scoped' });
        expect(container.textContent).toContain('model.pte');
        expect(container.querySelector('.omni-pte__subtitle')?.textContent).toContain('XnnpackBackend');
        expect(container.querySelectorAll('.omni-pte__node--node')).toHaveLength(3);
        expect(container.querySelectorAll('.omni-pte__node--input')).toHaveLength(1);
        // linear.weight and linear.bias feed addmm; the mutable buffer and the
        // external tensor are constants nothing consumes, so they stay off the graph.
        expect(container.querySelectorAll('.omni-pte__node--constant')).toHaveLength(2);
        expect(container.querySelectorAll('.omni-pte__node--output')).toHaveLength(1);
        expect(container.querySelectorAll('.omni-pte__edge').length).toBeGreaterThan(0);
        expect(container.querySelectorAll('.omni-pte__edge--output')).toHaveLength(1);

        tab(container, 'pte.instructions').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
        expect(container.textContent).toContain('aten::addmm.out');
        search(container, 'relu');
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
        search(container, 'linear.weight');
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);

        search(container, '');
        tab(container, 'pte.values').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(18);
        expect(container.textContent).toContain('pte.storage.segment');
        expect(container.textContent).toContain('mem1 + 16');
        search(container, 'pte.storage.external');
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
        expect(container.textContent).toContain('ext.weight');

        search(container, '');
        tab(container, 'pte.io').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
        expect(container.textContent).toContain('pte.kind.output');

        tab(container, 'pte.delegates').click();
        expect(container.querySelector('.omni-pte__empty')).not.toBeNull();

        tab(container, 'pte.segments').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(4);
        expect(container.textContent).toContain('pte.segment.delegate');
        expect(container.textContent).toContain('shared_blob');

        tab(container, 'pte.modelInfo').click();
        expect(container.textContent).toContain('ET12');
        // Named data carries its own byte total, which no other row accounts for.
        expect(container.textContent).toContain('8 B · shared_blob → #2');
        expect(container.textContent).toContain('pte.info.headerDetail');
        expect(container.textContent).toContain('TreeSpec(tuple, None, [*])');
        expect(container.textContent).toContain('aten::argmax.out');

        handle.dispose();
        expect(container.children).toHaveLength(0);
        expect(container.classList.contains('omni-viewer')).toBe(false);
    });

    it('inspects an instruction, dims non-matching graph cards, and shows tensor details', () => {
        const container = document.createElement('div');
        mountPteDocument(parsePte(pteFixture()), 'model.pte', container, ctx, { styleIsolation: 'scoped' });
        const inspector = container.querySelector('.omni-pte__inspector')!;
        expect(inspector.textContent).toContain('aten::addmm.out');
        expect(inspector.textContent).toContain('pte.inspector.arguments');
        expect(inspector.textContent).toContain('Int 1');
        expect(inspector.textContent).toContain('model.py:12 forward');
        expect(inspector.textContent).toContain('return self.linear(x)');

        const constant = container.querySelector<HTMLButtonElement>('.omni-pte__node--constant')!;
        constant.click();
        expect(inspector.textContent).toContain('linear.weight');
        expect(inspector.textContent).toContain('pte.storage.segment');
        expect(inspector.textContent).toContain('2816');
        expect(inspector.textContent).toContain('48 B');
        expect(constant.classList.contains('omni-pte__node--selected')).toBe(true);

        search(container, 'argmax');
        const cards = [...container.querySelectorAll<HTMLElement>('.omni-pte__node--node')];
        const lit = cards.find(card => card.textContent?.includes('aten::argmax.out'))!;
        expect(lit.classList.contains('omni-pte__node--dim')).toBe(false);
        expect(cards.filter(card => card.classList.contains('omni-pte__node--dim'))).toHaveLength(2);
    });

    it('switches methods from the picker and shows delegate details', () => {
        const container = document.createElement('div');
        mountPteDocument(parsePte(pteFixture()), 'model.pte', container, ctx, { styleIsolation: 'scoped' });
        const picker = container.querySelector('select') as HTMLSelectElement;
        expect(picker.hidden).toBe(false);
        picker.value = '1';
        picker.dispatchEvent(new Event('change', { bubbles: true }));
        expect(container.querySelectorAll('.omni-pte__node--delegate')).toHaveLength(1);
        const inspector = container.querySelector('.omni-pte__inspector')!;
        expect(inspector.textContent).toContain('XnnpackBackend');
        expect(inspector.textContent).toContain('is_dynamic');
        expect(inspector.textContent).toContain('false');
        expect(inspector.textContent).toContain('pte.binaryBytes');

        tab(container, 'pte.delegates').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
        expect(container.textContent).toContain('pte.location.segment');
        expect(container.textContent).toContain('is_dynamic=false');
    });

    it('lists control-flow instructions and draws moves as graph nodes', () => {
        const container = document.createElement('div');
        mountPteDocument(parsePte(pteInlineFixture()), 'legacy.pte', container, ctx, { styleIsolation: 'scoped' });
        expect((container.querySelector('select') as HTMLSelectElement).hidden).toBe(true);
        expect(container.querySelectorAll('.omni-pte__node--node')).toHaveLength(1);
        expect(container.querySelectorAll('.omni-pte__node--delegate')).toHaveLength(1);
        expect(container.querySelectorAll('.omni-pte__node--move')).toHaveLength(1);
        tab(container, 'pte.instructions').click();
        const rows = [...container.querySelectorAll('tbody tr')].map(row => row.textContent);
        expect(rows).toHaveLength(6);
        expect(rows[1]).toContain('pte.kind.JumpFalseCall');
        expect(rows[1]).toContain('pte.jumpTo');
        expect(rows[5]).toContain('pte.kind.Unknown');
        tab(container, 'pte.modelInfo').click();
        expect(container.textContent).toContain('pte.info.noHeader');
        expect(container.textContent).toContain('pte.info.inlineBuffers');
    });

    it('re-columns a node when a list it reads gains a deeper producer', () => {
        // relu(x)→#1; cat(L)→#4 with L=[#1,#2]; relu(x)→#5; relu(#5)→#2; cat(L)→#6.
        // The second cat reads L after #2 is produced two levels deep, so it
        // must sit past that producer rather than beside it.
        const planned = (offset: number): Parameters<typeof buildProgram>[0]['methods'][0]['values'][0] =>
            ({ kind: 'Tensor', value: { type: 6, sizes: [2], allocation: { memoryId: 1, offset } } });
        const model = parsePte(buildProgram({
            methods: [{
                name: 'forward',
                values: [{ kind: 'Tensor', value: { type: 6, sizes: [2] } }, planned(0), planned(8), { kind: 'TensorList', value: [1, 2] }, planned(16), planned(24), planned(32)],
                inputs: [0],
                outputs: [4, 6],
                chains: [{ instructions: [
                    { kind: 'KernelCall', op: 0, args: [0, 1, 1] },
                    { kind: 'KernelCall', op: 1, args: [3, 4, 4] },
                    { kind: 'KernelCall', op: 0, args: [0, 5, 5] },
                    { kind: 'KernelCall', op: 0, args: [5, 2, 2] },
                    { kind: 'KernelCall', op: 1, args: [3, 6, 6] }
                ] }],
                operators: [['aten::relu', 'out'], ['aten::cat', 'out']]
            }]
        }));
        const container = document.createElement('div');
        mountPteDocument(model, 'lists.pte', container, ctx, { styleIsolation: 'scoped' });
        const columns = [...container.querySelectorAll<HTMLElement>('.omni-pte__node--node')].map(card => card.style.left);
        expect(columns).toEqual(['220px', '440px', '220px', '440px', '660px']);
    });

    it('wires a mutated buffer from its real source, not from the node that rewrites it', () => {
        // add(x, kv) → y; add(x, y) → kv. The second call writes kv, which the
        // first one reads, so the first must still be fed by the kv card.
        const model = parsePte(buildProgram({
            methods: [{
                name: 'forward',
                values: [
                    { kind: 'Tensor', value: { type: 6, sizes: [4] } },
                    { kind: 'Tensor', value: { type: 6, sizes: [4], dataBufferIndex: 1, allocation: { memoryId: 1, offset: 0 }, name: 'kv' } },
                    { kind: 'Tensor', value: { type: 6, sizes: [4], allocation: { memoryId: 1, offset: 16 } } }
                ],
                inputs: [0],
                outputs: [2],
                chains: [{ instructions: [
                    { kind: 'KernelCall', op: 0, args: [0, 1, 2, 2] },
                    { kind: 'KernelCall', op: 0, args: [0, 2, 1, 1] }
                ] }],
                operators: [['aten::add', 'out']]
            }],
            constantBuffers: [new Uint8Array(0), new Uint8Array(16)]
        }));
        const container = document.createElement('div');
        mountPteDocument(model, 'kv.pte', container, ctx, { styleIsolation: 'scoped' });
        const edges = [...container.querySelectorAll('.omni-pte__edge')].map(edge => edge.getAttribute('d')!);
        // `M x1 y1 C …, …, x2 y2`: the start x and the end x of the curve.
        const span = (d: string): [number, number] => {
            const numbers = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
            return [numbers[0]!, numbers[numbers.length - 2]!];
        };
        // Every edge runs left to right: nothing is fed by a node drawn after it.
        expect(edges.every(d => { const [x1, x2] = span(d); return x1 < x2; })).toBe(true);
        // The kv card (second source row, y = 106) feeds the first node.
        expect(edges.some(d => d.startsWith('M 190 133'))).toBe(true);
    });

    it('rewires an alias and a one-item list when their value gains a new producer', () => {
        const planned = (offset: number): Parameters<typeof buildProgram>[0]['methods'][0]['values'][0] =>
            ({ kind: 'Tensor', value: { type: 6, sizes: [4], allocation: { memoryId: 1, offset } } });
        /** Cards feeding the card at (left, top), by the anchor each edge starts from. */
        const feeds = (container: HTMLElement, left: number, top: number): string[] =>
            [...container.querySelectorAll('.omni-pte__edge')]
                .map(edge => edge.getAttribute('d')!)
                .filter(d => d.endsWith(`${left} ${top + 27}`))
                .map(d => d.slice(2, d.indexOf(' C')));

        // #3 aliases #1 (same slot). D→#1; relu(#3)→#2; relu(x)→#1 rewrites it;
        // relu(#3)→#4 must then read the rewrite, not the delegate.
        const aliasModel = parsePte(buildProgram({
            methods: [{
                name: 'forward',
                values: [{ kind: 'Tensor', value: { type: 6, sizes: [4] } }, planned(0), planned(16), planned(0), planned(32)],
                inputs: [0],
                outputs: [2, 4],
                chains: [{ instructions: [
                    { kind: 'DelegateCall', delegate: 0, args: [0, 1] },
                    { kind: 'KernelCall', op: 0, args: [3, 2, 2] },
                    { kind: 'KernelCall', op: 0, args: [0, 1, 1] },
                    { kind: 'KernelCall', op: 0, args: [3, 4, 4] }
                ] }],
                operators: [['aten::relu', 'out']],
                delegates: [{ id: 'XnnpackBackend', location: 'inline', index: 0 }]
            }],
            delegateInline: [new Uint8Array(4)]
        }));
        expect(aliasModel.methods[0]!.values[3]!.tensor!.aliasOf).toBe(1);
        const aliasContainer = document.createElement('div');
        mountPteDocument(aliasModel, 'alias.pte', aliasContainer, ctx, { styleIsolation: 'scoped' });
        // The delegate sits at (220, 20) and the rewrite at (220, 106); the last
        // reader of the alias is at (440, 106) and must be fed by the rewrite.
        expect(feeds(aliasContainer, 440, 106)).toEqual(['390 133']);

        // A one-item list read before and after its tensor is produced.
        const listModel = parsePte(buildProgram({
            methods: [{
                name: 'forward',
                values: [{ kind: 'Tensor', value: { type: 6, sizes: [4] } }, planned(0), planned(16), { kind: 'TensorList', value: [2] }, planned(32), planned(48)],
                inputs: [0],
                outputs: [1, 5],
                chains: [{ instructions: [
                    { kind: 'KernelCall', op: 1, args: [3, 1, 1] },
                    { kind: 'KernelCall', op: 0, args: [0, 2, 2] },
                    { kind: 'KernelCall', op: 1, args: [3, 4, 4] },
                    { kind: 'KernelCall', op: 0, args: [4, 5, 5] }
                ] }],
                operators: [['aten::relu', 'out'], ['aten::cat', 'out']]
            }]
        }));
        const listContainer = document.createElement('div');
        mountPteDocument(listModel, 'list.pte', listContainer, ctx, { styleIsolation: 'scoped' });
        const nodes = [...listContainer.querySelectorAll<HTMLElement>('.omni-pte__node--node')];
        const at = (left: string, top: string): HTMLElement | undefined =>
            nodes.find(node => node.style.left === left && node.style.top === top);
        // relu writing #2 sits at (220, 106); the second cat reads the list
        // holding it and is placed one column further along, at (440, 20).
        expect(at('220px', '106px')!.textContent).toContain('aten::relu.out');
        expect(at('440px', '20px')!.textContent).toContain('aten::cat.out');
        expect(feeds(listContainer, 440, 20)).toEqual(['390 133']);
        // The first cat read the list before anything produced its tensor.
        expect(feeds(listContainer, 220, 20)).toEqual([]);
    });

    it('resolves a jump destination to the flattened instruction index', () => {
        const model = parsePte(buildProgram({
            methods: [{
                name: 'forward',
                values: [
                    { kind: 'Tensor', value: { type: 6, sizes: [4] } },
                    { kind: 'Bool', value: true },
                    { kind: 'Tensor', value: { type: 6, sizes: [4], allocation: { memoryId: 1, offset: 0 } } },
                    { kind: 'Tensor', value: { type: 6, sizes: [4], allocation: { memoryId: 1, offset: 16 } } }
                ],
                inputs: [0],
                outputs: [3],
                chains: [
                    { instructions: [{ kind: 'KernelCall', op: 0, args: [0, 2, 2] }] },
                    { instructions: [
                        { kind: 'JumpFalseCall', cond: 1, destination: 2 },
                        { kind: 'KernelCall', op: 0, args: [2, 3, 3] },
                        { kind: 'KernelCall', op: 0, args: [0, 3, 3] }
                    ] }
                ],
                operators: [['aten::relu', 'out']]
            }]
        }));
        const container = document.createElement('div');
        mountPteDocument(model, 'cond.pte', container, ctx, { styleIsolation: 'scoped' });
        tab(container, 'pte.instructions').click();
        // Chain 1 position 2 is flattened instruction 3, not 2.
        const jumpRow = [...container.querySelectorAll('tbody tr')].find(row => row.textContent?.includes('pte.kind.JumpFalseCall'))!;
        expect(jumpRow.querySelectorAll('td')[3]!.textContent).toBe('pte.jumpTo 3');
    });

    it('reads a jump one past the last instruction as ending the chain', () => {
        const model = parsePte(buildProgram({
            methods: [{
                name: 'forward',
                values: [{ kind: 'Tensor', value: { type: 6, sizes: [4] } }, { kind: 'Bool', value: true }, { kind: 'Tensor', value: { type: 6, sizes: [4], allocation: { memoryId: 1, offset: 0 } } }],
                inputs: [0],
                outputs: [2],
                // The runtime runs `while (index < size)`, so destination 2 in a
                // two-instruction chain is the emitter's "skip the false branch".
                chains: [{ instructions: [
                    { kind: 'JumpFalseCall', cond: 1, destination: 2 },
                    { kind: 'KernelCall', op: 0, args: [0, 2, 2] }
                ] }],
                operators: [['aten::relu', 'out']]
            }]
        }));
        const container = document.createElement('div');
        mountPteDocument(model, 'end.pte', container, ctx, { styleIsolation: 'scoped' });
        tab(container, 'pte.instructions').click();
        const row = [...container.querySelectorAll('tbody tr')].find(item => item.textContent?.includes('pte.kind.JumpFalseCall'))!;
        expect(row.querySelectorAll('td')[3]!.textContent).toBe('pte.jumpEnd');
    });

    it('says so when a jump destination lies outside its chain', () => {
        const model = parsePte(buildProgram({
            methods: [{
                name: 'forward',
                values: [{ kind: 'Tensor', value: { type: 6, sizes: [4] } }, { kind: 'Bool', value: true }, { kind: 'Tensor', value: { type: 6, sizes: [4], allocation: { memoryId: 1, offset: 0 } } }],
                inputs: [0],
                outputs: [2],
                chains: [
                    { instructions: [{ kind: 'KernelCall', op: 0, args: [0, 2, 2] }] },
                    { instructions: [{ kind: 'JumpFalseCall', cond: 1, destination: 99 }] }
                ],
                operators: [['aten::relu', 'out']]
            }]
        }));
        const container = document.createElement('div');
        mountPteDocument(model, 'jump.pte', container, ctx, { styleIsolation: 'scoped' });
        tab(container, 'pte.instructions').click();
        const row = [...container.querySelectorAll('tbody tr')].find(item => item.textContent?.includes('pte.kind.JumpFalseCall'))!;
        expect(row.querySelectorAll('td')[3]!.textContent).toBe('pte.jumpInvalid 99');
    });

    it('draws one card for a repeated method input and an edge into a list-valued output', () => {
        const model = parsePte(buildProgram({
            methods: [{
                name: 'forward',
                values: [
                    { kind: 'Tensor', value: { type: 6, sizes: [4] } },
                    { kind: 'Tensor', value: { type: 6, sizes: [4], allocation: { memoryId: 1, offset: 0 } } },
                    { kind: 'Tensor', value: { type: 6, sizes: [4], allocation: { memoryId: 1, offset: 16 } } },
                    { kind: 'TensorList', value: [1, 2] }
                ],
                inputs: [0, 0],
                outputs: [3],
                chains: [{ instructions: [{ kind: 'KernelCall', op: 0, args: [0, 1, 2, 3] }] }],
                operators: [['aten::split', 'out']]
            }]
        }));
        const container = document.createElement('div');
        mountPteDocument(model, 'dup.pte', container, ctx, { styleIsolation: 'scoped' });
        const inputs = [...container.querySelectorAll<HTMLElement>('.omni-pte__node--input')];
        expect(inputs).toHaveLength(1);
        expect(inputs[0]!.style.top).toBe('20px');
        // The output card holds the list, whose tensors the kernel produced.
        expect(container.querySelectorAll('.omni-pte__edge--output')).toHaveLength(1);
    });

    it('columns a list reader by the current depth of its tensors, not a stale maximum', () => {
        const planned = (offset: number): Parameters<typeof buildProgram>[0]['methods'][0]['values'][0] =>
            ({ kind: 'Tensor', value: { type: 6, sizes: [4], allocation: { memoryId: 1, offset } } });
        // #1 is written at depth 2 (x → a → b → #1) and #2 at depth 0; a reader
        // of L = [#1, #2] is then at depth 3. Rewriting both at depth 1 must
        // bring the next reader back to depth 2, not leave it at 4.
        const model = parsePte(buildProgram({
            methods: [{
                name: 'forward',
                values: [
                    { kind: 'Tensor', value: { type: 6, sizes: [4] } },
                    planned(0), planned(16), { kind: 'TensorList', value: [1, 2] },
                    planned(32), planned(48), planned(64), planned(80), planned(96)
                ],
                inputs: [0],
                outputs: [6, 8],
                chains: [{ instructions: [
                    { kind: 'KernelCall', op: 0, args: [0, 4, 4] },
                    { kind: 'KernelCall', op: 0, args: [4, 5, 5] },
                    { kind: 'KernelCall', op: 0, args: [5, 1, 1] },
                    { kind: 'KernelCall', op: 0, args: [0, 2, 2] },
                    { kind: 'KernelCall', op: 1, args: [3, 6, 6] },
                    { kind: 'KernelCall', op: 0, args: [0, 7, 7] },
                    { kind: 'KernelCall', op: 0, args: [7, 1, 1] },
                    { kind: 'KernelCall', op: 0, args: [7, 2, 2] },
                    { kind: 'KernelCall', op: 1, args: [3, 8, 8] }
                ] }],
                operators: [['aten::relu', 'out'], ['aten::cat', 'out']]
            }]
        }));
        const container = document.createElement('div');
        mountPteDocument(model, 'depth.pte', container, ctx, { styleIsolation: 'scoped' });
        const cats = [...container.querySelectorAll<HTMLElement>('.omni-pte__node--node')]
            .filter(card => card.textContent?.includes('aten::cat.out'));
        expect(cats).toHaveLength(2);
        // Depth 3 → 220 + 3×220 = 880; depth 2 → 660.
        expect(cats.map(card => card.style.left)).toEqual(['880px', '660px']);
    });

    it('bounds large graphs and counts every card in the limit banner', () => {
        const container = document.createElement('div');
        // 600 kernel calls + 1 input + 1 output; nodes are capped at 240.
        mountPteDocument(parsePte(wideProgram(600)), 'wide.pte', container, ctx, { styleIsolation: 'scoped' });
        expect(container.querySelectorAll('.omni-pte__node').length).toBeLessThanOrEqual(400);
        expect(container.querySelector('.omni-pte__graph-limit')?.textContent).toBe('limited 242/602');
    });

    it('keeps the method input on the graph when constants exceed the card budget', () => {
        // 420 weights all feeding one kernel call: the input sits at value #420,
        // after every weight, and must still be drawn ahead of them.
        const values: Parameters<typeof buildProgram>[0]['methods'][0]['values'] = [];
        for (let index = 0; index < 420; index++) values.push({ kind: 'Tensor', value: { type: 6, sizes: [1], dataBufferIndex: index + 1 } });
        values.push({ kind: 'Tensor', value: { type: 6, sizes: [1] } }, { kind: 'Tensor', value: { type: 6, sizes: [1], allocation: { memoryId: 1, offset: 0 } } });
        const model = parsePte(buildProgram({
            methods: [{ name: 'forward', values, inputs: [420], outputs: [421], chains: [{ instructions: [{ kind: 'KernelCall', op: 0, args: [420, ...Array.from({ length: 420 }, (_, index) => index), 421] }] }], operators: [['aten::stack', 'out']] }],
            constantBuffers: Array.from({ length: 421 }, () => new Uint8Array(4))
        }));
        const container = document.createElement('div');
        mountPteDocument(model, 'wide.pte', container, ctx, { styleIsolation: 'scoped' });
        expect(container.querySelectorAll('.omni-pte__node--input')).toHaveLength(1);
        expect(container.querySelector<HTMLElement>('.omni-pte__node--input')?.style.top).toBe('20px');
        expect(container.querySelectorAll('.omni-pte__node').length).toBeLessThanOrEqual(400);
    });

    it('draws one card per output value even when an index is repeated', () => {
        const model = parsePte(pteFixture());
        model.methods[0]!.outputs = [5, 5, 5];
        const container = document.createElement('div');
        mountPteDocument(model, 'dup.pte', container, ctx, { styleIsolation: 'scoped' });
        expect(container.querySelectorAll('.omni-pte__node--output')).toHaveLength(1);
    });

    it('shows an empty-graph notice for a method without calls', () => {
        const model = parsePte(buildProgram({ methods: [{ name: 'forward', values: [], inputs: [], outputs: [], chains: [], operators: [] }] }));
        const container = document.createElement('div');
        mountPteDocument(model, 'empty.pte', container, ctx, { styleIsolation: 'scoped' });
        expect(container.querySelector('.omni-pte__graph-scroll .omni-pte__empty')?.textContent).toBe('pte.emptyGraph');
        expect(container.querySelector('.omni-pte__inspector')?.textContent).toBe('pte.selectNode');
    });

    it('answers a value search the same way on the graph tab and the values table', () => {
        const container = document.createElement('div');
        mountPteDocument(parsePte(pteFixture()), 'model.pte', container, ctx, { styleIsolation: 'scoped' });
        search(container, 'linear.bias');
        const lit = [...container.querySelectorAll<HTMLElement>('.omni-pte__node--constant')]
            .filter(card => !card.classList.contains('omni-pte__node--dim'));
        expect(lit).toHaveLength(1);
        expect(lit[0]!.textContent).toContain('linear.bias');
        tab(container, 'pte.values').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    });

    it('matches the shape label it displays on both the graph and the values table', () => {
        const container = document.createElement('div');
        mountPteDocument(parsePte(pteFixture()), 'model.pte', container, ctx, { styleIsolation: 'scoped' });
        search(container, 'pte.scalar');
        tab(container, 'pte.values').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
        expect(container.querySelector('tbody tr')?.textContent).toContain('LONG[pte.scalar]');
    });

    it('highlights the selected card on first render and after returning to the graph', () => {
        const container = document.createElement('div');
        mountPteDocument(parsePte(pteFixture()), 'model.pte', container, ctx, { styleIsolation: 'scoped' });
        const selectedCard = (): HTMLElement | null => container.querySelector('.omni-pte__node--selected');
        expect(selectedCard()?.textContent).toContain('aten::addmm.out');
        container.querySelector<HTMLButtonElement>('.omni-pte__node--constant')!.click();
        expect(selectedCard()?.textContent).toContain('linear.weight');
        tab(container, 'pte.values').click();
        tab(container, 'pte.graph').click();
        expect(container.querySelectorAll('.omni-pte__node--selected')).toHaveLength(1);
        expect(selectedCard()?.textContent).toContain('linear.weight');
        expect(container.querySelector('.omni-pte__inspector')?.textContent).toContain('linear.weight');
    });

    it('mounts a method whose calls all name one long tensor list in linear time', () => {
        const count = 3000;
        const values: Parameters<typeof buildProgram>[0]['methods'][0]['values'] = [];
        for (let index = 0; index < count; index++) values.push({ kind: 'Tensor', value: { type: 6, sizes: [1] } });
        values.push({ kind: 'TensorList', value: Array.from({ length: count }, (_, index) => index) });
        values.push({ kind: 'Tensor', value: { type: 6, sizes: [1], allocation: { memoryId: 1, offset: 0 } } });
        const args = Array.from({ length: count }, () => count).concat(count + 1);
        const model = parsePte(buildProgram({
            methods: [{
                name: 'forward', values, inputs: Array.from({ length: count }, (_, index) => index), outputs: [count + 1],
                chains: [{ instructions: Array.from({ length: 4 }, () => ({ kind: 'KernelCall' as const, op: 0, args })) }],
                operators: [['aten::stack', 'out']]
            }]
        }));
        const container = document.createElement('div');
        const started = performance.now();
        mountPteDocument(model, 'lists.pte', container, ctx, { styleIsolation: 'scoped' });
        expect(performance.now() - started).toBeLessThan(6000);
        expect(container.querySelectorAll('.omni-pte__node--node')).toHaveLength(4);
    });

    it('draws edges through memory-plan aliases and names the alias in the inspector', () => {
        const planned = (offset: number): Parameters<typeof buildProgram>[0]['methods'][0]['values'][0] =>
            ({ kind: 'Tensor', value: { type: 6, sizes: [4], allocation: { memoryId: 1, offset } } });
        // D1(x) → #1; K(x) → #3; #4 aliases #3 and #5 aliases #1; D2(#4, #5) → #6.
        // #5 is returned as well as D2's result.
        const model = parsePte(buildProgram({
            methods: [{
                name: 'forward',
                values: [{ kind: 'Tensor', value: { type: 6, sizes: [4] } }, planned(0), planned(48), planned(16), planned(16), planned(0), planned(32)],
                inputs: [0],
                outputs: [6, 5],
                chains: [{ instructions: [
                    { kind: 'DelegateCall', delegate: 0, args: [0, 1] },
                    { kind: 'KernelCall', op: 0, args: [0, 3, 3] },
                    { kind: 'DelegateCall', delegate: 0, args: [4, 5, 6] }
                ] }],
                operators: [['aten::relu', 'out']],
                delegates: [{ id: 'XnnpackBackend', location: 'inline', index: 0 }]
            }],
            delegateInline: [new Uint8Array(4)]
        }));
        const container = document.createElement('div');
        mountPteDocument(model, 'residual.pte', container, ctx, { styleIsolation: 'scoped' });
        // x→D1, x→K, K→D2 (via #4), D1→D2 (via #5), D2→#6, D1→#5 (via alias)
        expect(container.querySelectorAll('.omni-pte__edge')).toHaveLength(6);
        expect(container.querySelectorAll('.omni-pte__edge--output')).toHaveLength(2);
        const delegates = [...container.querySelectorAll<HTMLElement>('.omni-pte__node--delegate')];
        expect(delegates.map(card => card.style.left)).toEqual(['220px', '440px']);
        const aliasOutput = [...container.querySelectorAll<HTMLElement>('.omni-pte__node--output')].find(card => card.textContent?.includes('#5'))!;
        aliasOutput.click();
        const inspector = container.querySelector('.omni-pte__inspector')!;
        expect(inspector.textContent).toContain('pte.info.aliasOf#1');
        expect(inspector.textContent).toContain('mem1 + 0 = #1');
        tab(container, 'pte.values').click();
        expect([...container.querySelectorAll('tbody tr')][5]?.textContent).toContain('mem1 + 0 = #1');
    });

    it('mounts thousands of nodes that all read one long list in linear time', () => {
        const count = 6000;
        const values: Parameters<typeof buildProgram>[0]['methods'][0]['values'] = [];
        for (let index = 0; index < count; index++) values.push({ kind: 'Tensor', value: { type: 6, sizes: [1], dataBufferIndex: index + 1 } });
        values.push({ kind: 'TensorList', value: Array.from({ length: count }, (_, index) => index) });
        for (let index = 0; index < count; index++) values.push({ kind: 'Tensor', value: { type: 6, sizes: [1], allocation: { memoryId: 1, offset: index * 4 } } });
        const model = parsePte(buildProgram({
            methods: [{
                name: 'forward', values, inputs: [], outputs: [count * 2],
                chains: [{ instructions: Array.from({ length: count }, (_, index) => ({ kind: 'KernelCall' as const, op: 0, args: [count, count + 1 + index, count + 1 + index] })) }],
                operators: [['aten::cat', 'out']]
            }],
            constantBuffers: Array.from({ length: count + 1 }, () => new Uint8Array(4))
        }));
        const container = document.createElement('div');
        const started = performance.now();
        mountPteDocument(model, 'lists.pte', container, ctx, { styleIsolation: 'scoped' });
        expect(performance.now() - started).toBeLessThan(6000);
        expect(container.querySelectorAll('.omni-pte__node--node')).toHaveLength(240);
    });

    it('lights one card for a pass-through value and finds a card by its index text', () => {
        const model = parsePte(buildProgram({
            methods: [{
                name: 'forward',
                values: [{ kind: 'Tensor', value: { type: 6, sizes: [4] } }, { kind: 'Tensor', value: { type: 6, sizes: [4], allocation: { memoryId: 1, offset: 0 } } }],
                inputs: [0],
                outputs: [0, 1],
                chains: [{ instructions: [{ kind: 'KernelCall', op: 0, args: [0, 1, 1] }] }],
                operators: [['aten::relu', 'out']]
            }]
        }));
        const container = document.createElement('div');
        mountPteDocument(model, 'pass.pte', container, ctx, { styleIsolation: 'scoped' });
        const outputCard = [...container.querySelectorAll<HTMLElement>('.omni-pte__node--output')].find(card => card.textContent?.includes('#0'))!;
        outputCard.click();
        expect(container.querySelectorAll('.omni-pte__node--selected')).toHaveLength(1);
        tab(container, 'pte.values').click();
        tab(container, 'pte.graph').click();
        const lit = container.querySelectorAll<HTMLElement>('.omni-pte__node--selected');
        expect(lit).toHaveLength(1);
        expect(lit[0]!.classList.contains('omni-pte__node--output')).toBe(true);

        search(container, 'chain 0');
        expect(container.querySelector('.omni-pte__node--node')?.classList.contains('omni-pte__node--dim')).toBe(false);
        tab(container, 'pte.instructions').click();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    });

    it('finds a value by its #index label and a segment by its status on their tables', () => {
        const container = document.createElement('div');
        mountPteDocument(parsePte(pteFixture()), 'model.pte', container, ctx, { styleIsolation: 'scoped' });
        search(container, '#4');
        tab(container, 'pte.values').click();
        const rows = [...container.querySelectorAll('tbody tr')].map(row => row.firstElementChild?.textContent);
        expect(rows).toContain('4');
        tab(container, 'pte.segments').click();
        search(container, 'pte.inRange');
        expect(container.querySelectorAll('tbody tr')).toHaveLength(4);
    });

    it('keeps keyboard focus on a tab after activating it and searches what the delegates table shows', () => {
        const container = document.createElement('div');
        document.body.append(container);
        mountPteDocument(parsePte(pteFixture()), 'model.pte', container, ctx, { styleIsolation: 'scoped' });
        const values = tab(container, 'pte.values');
        values.focus();
        values.click();
        expect(document.activeElement).toBe(values);
        expect(values.getAttribute('aria-pressed')).toBe('true');
        expect(tab(container, 'pte.graph').getAttribute('aria-pressed')).toBe('false');

        const picker = container.querySelector('select') as HTMLSelectElement;
        picker.value = '1';
        picker.dispatchEvent(new Event('change', { bubbles: true }));
        tab(container, 'pte.delegates').click();
        search(container, '2944');
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
        search(container, 'pte.binaryBytes');
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
        container.remove();
    });

    it('searches every cell the values and segments tables display, and answers alike on the graph', () => {
        const container = document.createElement('div');
        mountPteDocument(parsePte(pteFixture()), 'model.pte', container, ctx, { styleIsolation: 'scoped' });
        tab(container, 'pte.values').click();
        search(container, '16 B');
        expect(container.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
        // #5 is the method output, drawn as a card and listed in the table.
        search(container, 'mem1 + 16');
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
        // The graph dims by the same text, so the slot search lights that card.
        tab(container, 'pte.graph').click();
        const lit = [...container.querySelectorAll<HTMLElement>('.omni-pte__node')]
            .filter(card => !card.classList.contains('omni-pte__node--dim'));
        expect(lit).toHaveLength(1);
        expect(lit[0]!.classList.contains('omni-pte__node--output')).toBe(true);

        tab(container, 'pte.segments').click();
        search(container, '2816');
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
        search(container, '384');
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    });

    it('labels segments it cannot locate rather than calling them out of range', () => {
        const container = document.createElement('div');
        mountPteDocument(parsePte(pteHeaderlessSegmentsFixture()), 'headerless.pte', container, ctx, { styleIsolation: 'scoped' });
        tab(container, 'pte.segments').click();
        const row = container.querySelector('tbody tr')!;
        expect(row.textContent).toContain('pte.unlocated');
        expect(row.textContent).not.toContain('pte.outOfRange');
    });

    it('reports a copy that fails instead of throwing out of the click handler', async () => {
        const writeText = vi.fn(async (_text: string) => undefined);
        const container = document.createElement('div');
        mountPteDocument(parsePte(pteFixture()), 'model.pte', container, { ...ctx, clipboard: { writeText } }, { styleIsolation: 'scoped' });
        const copy = tab(container, 'pte.copyJson');
        // A model too large to serialize throws here, synchronously in the handler.
        const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => { throw new RangeError('Invalid string length'); });
        expect(() => copy.click()).not.toThrow();
        stringify.mockRestore();
        expect(writeText).not.toHaveBeenCalled();
        expect(copy.textContent).toBe('pte.copyFailed');
        expect(ctx.logger.log).toHaveBeenCalledWith('error', expect.stringContaining('Invalid string length'));

        // A rejected clipboard write reports the same way.
        const rejecting = vi.fn(async (_text: string) => { throw new Error('denied'); });
        const other = document.createElement('div');
        mountPteDocument(parsePte(pteFixture()), 'model.pte', other, { ...ctx, clipboard: { writeText: rejecting } }, { styleIsolation: 'scoped' });
        const otherCopy = tab(other, 'pte.copyJson');
        otherCopy.click();
        await Promise.resolve();
        await Promise.resolve();
        expect(otherCopy.textContent).toBe('pte.copyFailed');
        expect(tab(other, 'pte.copyJson')).toBeUndefined();
    });

    it('copies the normalized model as JSON and honours an aborted mount', async () => {
        const writeText = vi.fn(async (_text: string) => undefined);
        const container = document.createElement('div');
        mountPteDocument(parsePte(pteFixture()), 'model.pte', container, { ...ctx, clipboard: { writeText } }, { styleIsolation: 'scoped' });
        tab(container, 'pte.copyJson').click();
        await Promise.resolve();
        expect(JSON.parse(writeText.mock.calls[0]![0]).format).toBe('pte');

        await expect(mountPteViewer(
            { fileName: 'model.pte', data: pteFixture() },
            document.createElement('div'),
            ctx,
            { signal: AbortSignal.abort() }
        )).rejects.toBeInstanceOf(MountAbortedError);
    });

    it('renders parser warnings in a status region and isolates styles by default', async () => {
        const container = document.createElement('div');
        const handle = await mountPteViewer({ fileName: 'model.pte', data: pteFixture() }, container, ctx);
        const root = container.shadowRoot!;
        expect(root.querySelector('style')).not.toBeNull();
        const warnings = root.querySelector('.omni-pte__warnings')!;
        expect(warnings.getAttribute('role')).toBe('status');
        expect(warnings.textContent).toContain('pte.warning.delegates');
        expect(warnings.textContent).toContain('pte.warning.externalTensors');
        handle.dispose();
        expect(root.childNodes).toHaveLength(0);
    });
});
