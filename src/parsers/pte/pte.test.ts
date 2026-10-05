import { describe, expect, it } from 'vitest';
import {
    assemblePte,
    buildProgram,
    pteFixture,
    pteForeignIdentifierFixture,
    pteHeaderlessSegmentsFixture,
    pteInlineFixture,
    pteTruncatedSegmentsFixture
} from './__tests__/fixture.js';
import { parsePte, PteParseError } from './index.js';

/**
 * Offset of the first EValue's union type byte in a program whose only value
 * is an `Int`: the byte holding 0x02 that sits inside the EValue table, found
 * by locating the table through the FlatBuffer offsets rather than by scanning.
 */
function findEvalueTypeByte(data: Uint8Array): number {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const u32 = (at: number): number => view.getUint32(at, true);
    const u16 = (at: number): number => view.getUint16(at, true);
    const field = (table: number, slot: number): number => {
        const vtable = table - view.getInt32(table, true);
        const relative = u16(vtable + 4 + slot * 2);
        return relative ? table + relative : 0;
    };
    const indirect = (at: number): number => at + u32(at);
    const program = u32(0);
    const plans = indirect(field(program, 1));
    const plan = indirect(plans + 4);
    const valuesVector = indirect(field(plan, 2));
    const evalue = indirect(valuesVector + 4);
    return field(evalue, 0);
}

/**
 * The timing bounds below are generous guards against super-linear blowups
 * (each case measured in tens of milliseconds, and in seconds to minutes
 * before the fix), not performance assertions — a loaded machine must not
 * turn them red.
 */
describe('parsePte', () => {
    it('reads the extended header, methods, values, and segment-stored constants', () => {
        const model = parsePte(pteFixture());
        expect(model.format).toBe('pte');
        expect(model.identifier).toBe('ET12');
        expect(model.version).toBe('0');
        expect(model.title).toBe('forward');
        expect(model.extendedHeader).toEqual({ length: 32, programSize: expect.any(String), segmentBaseOffset: '2816', segmentDataSize: '392' });
        expect(model.methods.map(method => method.name)).toEqual(['forward', 'delegated']);
        expect(model.backends).toEqual(['XnnpackBackend']);
        expect(model.constantBytes).toBe('80');
        expect(model.delegateBytes).toBe('24');
        expect(model.summary.map(item => item.value)).toEqual([2, 4, 3, 10, 1, '80 B']);

        const forward = model.methods[0]!;
        expect(forward.inputs).toEqual([0]);
        expect(forward.outputs).toEqual([5]);
        expect(forward.operators.map(operator => operator.label)).toEqual(['aten::addmm.out', 'aten::relu.out', 'aten::argmax.out']);
        expect(forward.nonConstBufferSizes).toEqual(['0', '64']);
        expect(forward.inputSpec).toBe('TreeSpec(tuple, None, [*])');
        expect(forward.tensorCount).toBe(8);
        expect(forward.constantCount).toBe(2);

        const weight = forward.values[1]!;
        expect(weight.kind).toBe('Tensor');
        expect(weight.preview).toBe('FLOAT[3 × 4]');
        expect(weight.tensor).toMatchObject({
            name: 'linear.weight', storage: 'segment', segmentIndex: 0, dataBufferIndex: 1,
            fileOffset: '2816', dataBytes: '64', expectedBytes: '48', elementCount: '12', dimOrder: [0, 1]
        });
        // The second slot runs to the end of the segment: 80 - 64 = 16 padded bytes.
        expect(forward.values[2]!.tensor).toMatchObject({ name: 'linear.bias', storage: 'segment', fileOffset: '2880', dataBytes: '16', expectedBytes: '12' });
        expect(forward.values[0]!.tensor).toMatchObject({ storage: 'runtime', dataBytes: '', fileOffset: '' });
        expect(forward.values[4]!.tensor).toMatchObject({ storage: 'planned', allocation: { memoryId: 1, memoryOffset: '0' } });
        expect(forward.values[5]!.tensor).toMatchObject({ shapeDynamism: 'DYNAMIC_BOUND', allocation: { memoryId: 1, memoryOffset: '16' } });
    });

    it('renders every EValue kind and resolves mutable, external, and device-placed tensors', () => {
        const forward = parsePte(pteFixture()).methods[0]!;
        const previews = forward.values.map(value => `${value.kind}:${value.preview}`);
        expect(previews).toEqual([
            'Tensor:FLOAT[1 × 4]', 'Tensor:FLOAT[3 × 4]', 'Tensor:FLOAT[3]', 'Int:1', 'Tensor:FLOAT[1 × 3]', 'Tensor:FLOAT[1 × 3]',
            'IntList:[1, #1]', 'Double:0.5', 'Bool:True', 'String:"hi"', 'TensorList:[#4, #5]', 'Null:None',
            'Tensor:FLOAT[2]', 'Tensor:FLOAT[2 × 2]', 'DoubleList:[0.25, 0.75]', 'BoolList:[True, False]',
            'OptionalTensorList:[#4, None]', 'Tensor:LONG[]'
        ]);
        expect(forward.values[6]!.items).toEqual([3, 1]);
        expect(forward.values[10]!.items).toEqual([4, 5]);
        expect(forward.values[16]!.items).toEqual([4, -1]);
        expect(forward.values[12]!.tensor).toMatchObject({ name: 'running_sum', storage: 'mutable', segmentIndex: 3, fileOffset: '3200', dataBytes: '8' });
        expect(forward.values[13]!.tensor).toMatchObject({ name: 'ext.weight', storage: 'external', dataBytes: '16', fileOffset: '' });
        expect(forward.values[17]!.tensor).toMatchObject({ scalarType: 'LONG', elementCount: '1', device: 'cuda:0' });
    });

    it('splits kernel arguments into inputs and outputs by data flow and keeps stack traces', () => {
        const forward = parsePte(pteFixture()).methods[0]!;
        expect(forward.chains).toEqual([{ index: 0, inputs: [0], outputs: [5], instructionCount: 3 }]);
        expect(forward.instructions.map(instruction => [instruction.kind, instruction.label, instruction.inputs, instruction.outputs])).toEqual([
            ['KernelCall', 'aten::addmm.out', [2, 0, 1, 3, 3], [4]],
            ['KernelCall', 'aten::relu.out', [4], [5]],
            ['KernelCall', 'aten::argmax.out', [5, 3], [17]]
        ]);
        expect(forward.instructions[0]).toMatchObject({ id: 'ins-0-0-0', index: 0, chain: 0, chainIndex: 0, operatorIndex: 0, delegateIndex: -1, args: [2, 0, 1, 3, 3, 4], destination: -1 });
        expect(forward.instructions[0]!.frames).toEqual([{ filename: 'model.py', line: 12, name: 'forward', context: 'return self.linear(x)' }]);
        expect(forward.instructions[2]!.frames).toEqual([]);
    });

    it('reads delegate calls, compile specs, named data, and classifies segments', () => {
        const model = parsePte(pteFixture());
        const delegated = model.methods[1]!;
        expect(delegated.instructions).toHaveLength(1);
        expect(delegated.instructions[0]).toMatchObject({ kind: 'DelegateCall', label: 'XnnpackBackend', delegateIndex: 0, inputs: [0], outputs: [1] });
        expect(delegated.delegates[0]).toEqual({
            index: 0, id: 'XnnpackBackend', location: 'segment', dataIndex: 1, dataBytes: '24', fileOffset: '2944',
            compileSpecs: [{ key: 'is_dynamic', value: 'false', bytes: 5 }, { key: 'blob', value: '', bytes: 3 }]
        });
        expect(model.namedData).toEqual([{ key: 'shared_blob', segmentIndex: 2, size: '8' }]);
        expect(model.segments.map(segment => [segment.kind, segment.offset, segment.fileOffset, segment.size, segment.inRange, segment.usedBy])).toEqual([
            ['constant', '0', '2816', '80', true, ['constant_segment']],
            ['delegate', '128', '2944', '24', true, ['delegated/XnnpackBackend']],
            ['named', '256', '3072', '8', true, ['shared_blob']],
            ['mutable', '384', '3200', '8', true, ['mutable_data_segments[0]']]
        ]);
        expect(model.warnings).toEqual([
            { key: 'pte.warning.delegates', args: { count: 1, names: 'XnnpackBackend' } },
            { key: 'pte.warning.externalTensors', args: { count: 1 } }
        ]);
    });

    it('reads legacy inline constants, inline delegate blobs, and every control-flow instruction', () => {
        const model = parsePte(pteInlineFixture());
        expect(model.extendedHeader).toBeUndefined();
        expect(model.segments).toEqual([]);
        // Two entries in the file, one of them the mandatory placeholder.
        expect(model.constantBufferCount).toBe(1);
        expect(model.constantBytes).toBe('8');
        expect(model.delegateBytes).toBe('15');
        const forward = model.methods[0]!;
        expect(forward.values[1]!.tensor).toMatchObject({ storage: 'inline', dataBytes: '8', expectedBytes: '8', segmentIndex: -1 });
        expect(Number(forward.values[1]!.tensor!.fileOffset)).toBeGreaterThan(0);
        expect(forward.delegates[0]).toMatchObject({ id: 'CustomBackend', location: 'inline', dataIndex: 0, dataBytes: '15' });
        expect(forward.instructions.map(instruction => [instruction.kind, instruction.inputs, instruction.outputs, instruction.destination])).toEqual([
            ['KernelCall', [0, 1], [2], -1],
            ['JumpFalseCall', [3], [], 4],
            ['DelegateCall', [2], [4], -1],
            ['MoveCall', [4], [5], -1],
            ['FreeCall', [2], [], -1],
            ['Unknown', [], [], -1]
        ]);
        expect(model.warnings).toEqual([
            { key: 'pte.warning.delegates', args: { count: 1, names: 'CustomBackend' } },
            { key: 'pte.warning.unknownInstructions', args: { count: 1 } }
        ]);
    });

    it('treats the last argument as the output when every argument is already defined', () => {
        // executorch_prim ops write scalar outputs, which are never "undefined"
        // tensors — the out-variant convention still puts the result last.
        const program = buildProgram({
            methods: [{
                name: 'forward',
                values: [{ kind: 'Int', value: 2n }, { kind: 'Int', value: 3n }, { kind: 'Int', value: 0n }],
                inputs: [0],
                outputs: [2],
                chains: [{ instructions: [{ kind: 'KernelCall', op: 0, args: [0, 1, 2] }] }],
                operators: [['executorch_prim::add', 'Scalar']]
            }]
        });
        const forward = parsePte(program).methods[0]!;
        expect(forward.instructions[0]).toMatchObject({ label: 'executorch_prim::add.Scalar', inputs: [0, 1], outputs: [2] });
    });

    it('collapses the return-value echoes the emitter appends after the out arguments', () => {
        const tensor = (offset: number): { kind: 'Tensor'; value: { type: number; sizes: number[]; allocation: { memoryId: number; offset: number } } } =>
            ({ kind: 'Tensor', value: { type: 6, sizes: [2], allocation: { memoryId: 1, offset } } });
        const program = buildProgram({
            methods: [{
                name: 'forward',
                values: [
                    { kind: 'Tensor', value: { type: 6, sizes: [2] } },
                    tensor(0), tensor(8), tensor(16),
                    { kind: 'TensorList', value: [2, 3] },
                    tensor(24)
                ],
                inputs: [0],
                outputs: [5],
                chains: [{ instructions: [
                    // relu.out(x, out) + echo of out
                    { kind: 'KernelCall', op: 0, args: [0, 1, 1] },
                    // a tuple-returning kernel: two outs, then a TensorList echo of both
                    { kind: 'KernelCall', op: 1, args: [1, 2, 3, 4] },
                    // the echo is a defined value a later call may consume
                    { kind: 'KernelCall', op: 2, args: [4, 5, 5] }
                ] }],
                operators: [['aten::relu', 'out'], ['aten::split', 'out'], ['aten::cat', 'out']]
            }]
        });
        const forward = parsePte(program).methods[0]!;
        expect(forward.instructions.map(instruction => [instruction.inputs, instruction.outputs])).toEqual([
            [[0], [1]],
            [[1], [2, 3]],
            [[4], [5]]
        ]);
    });

    it('does not mistake a tensor list of defined tensors for an output', () => {
        const program = buildProgram({
            methods: [{
                name: 'forward',
                values: [
                    { kind: 'Tensor', value: { type: 6, sizes: [2] } },
                    { kind: 'Tensor', value: { type: 6, sizes: [2] } },
                    { kind: 'TensorList', value: [0, 1] },
                    { kind: 'Int', value: 0n },
                    { kind: 'Tensor', value: { type: 6, sizes: [4], allocation: { memoryId: 1, offset: 0 } } }
                ],
                inputs: [0, 1],
                outputs: [4],
                chains: [{ instructions: [{ kind: 'KernelCall', op: 0, args: [2, 3, 4] }] }],
                operators: [['aten::cat', 'out']]
            }]
        });
        const forward = parsePte(program).methods[0]!;
        expect(forward.instructions[0]).toMatchObject({ inputs: [2, 3], outputs: [4] });
    });

    it('warns about segments it cannot locate or that run past the file', () => {
        const truncated = parsePte(pteTruncatedSegmentsFixture());
        expect(truncated.segments[0]).toMatchObject({ inRange: false, fileOffset: '384' });
        expect(truncated.warnings).toEqual([{ key: 'pte.warning.noInstructions' }, { key: 'pte.warning.segmentsOutOfRange', args: { count: 1 } }]);

        const headerless = parsePte(pteHeaderlessSegmentsFixture());
        expect(headerless.extendedHeader).toBeUndefined();
        expect(headerless.segments[0]).toMatchObject({ inRange: false, fileOffset: '', offset: '0', size: '16' });
        expect(headerless.methods[0]!.values[0]!.tensor).toMatchObject({ storage: 'segment', fileOffset: '', dataBytes: '16' });
        expect(headerless.warnings).toEqual([{ key: 'pte.warning.noInstructions' }, { key: 'pte.warning.headerMissing', args: { count: 1 } }]);
    });

    it('warns about constant data the program never provides', () => {
        const program = buildProgram({
            methods: [{
                name: 'forward',
                values: [
                    { kind: 'Tensor', value: { type: 6, sizes: [2], dataBufferIndex: 7, name: 'w' } },
                    { kind: 'Tensor', value: { type: 99, sizes: [1] } }
                ],
                inputs: [],
                outputs: [0],
                chains: [],
                operators: []
            }],
            segments: [[0n, 8n]],
            constantSegment: { segmentIndex: 0, offsets: [0n, 0n] }
        });
        const model = parsePte(assemblePte(program, [new Uint8Array(8)]));
        expect(model.methods[0]!.values[0]!.tensor).toMatchObject({ storage: 'segment', dataBytes: '', fileOffset: '' });
        expect(model.methods[0]!.values[1]!.tensor!.scalarType).toBe('TYPE_99');
        expect(model.warnings).toEqual([
            { key: 'pte.warning.noInstructions' },
            { key: 'pte.warning.missingData', args: { count: 1 } },
            { key: 'pte.warning.unknownScalarTypes', args: { count: 1 } }
        ]);
    });

    it('reads a mutable tensor with initial state from an inline constant buffer', () => {
        const program = buildProgram({
            methods: [{
                name: 'forward',
                values: [{ kind: 'Tensor', value: { type: 6, sizes: [2], dataBufferIndex: 1, allocation: { memoryId: 1, offset: 0 }, name: 'state' } }],
                inputs: [], outputs: [0], chains: [], operators: []
            }],
            constantBuffers: [new Uint8Array(0), new Uint8Array(8)]
        });
        const model = parsePte(program);
        expect(model.methods[0]!.values[0]!.tensor).toMatchObject({ storage: 'mutable', dataBytes: '8' });
        expect(Number(model.methods[0]!.values[0]!.tensor!.fileOffset)).toBeGreaterThan(0);
        expect(model.warnings.map(warning => warning.key)).not.toContain('pte.warning.missingData');
    });

    it('warns about named data and delegates that name a segment the program never declares', () => {
        const program = buildProgram({
            methods: [{
                name: 'forward',
                values: [{ kind: 'Tensor', value: { type: 6, sizes: [4] } }, { kind: 'Tensor', value: { type: 6, sizes: [4], allocation: { memoryId: 1, offset: 0 } } }],
                inputs: [0], outputs: [1],
                chains: [{ instructions: [{ kind: 'DelegateCall', delegate: 0, args: [0, 1] }] }],
                operators: [],
                delegates: [{ id: 'XnnpackBackend', location: 'segment', index: 7 }]
            }],
            segments: [[0n, 64n]],
            namedData: [{ key: 'weights.bin', segmentIndex: 9 }, { key: 'ok.bin', segmentIndex: 0 }]
        });
        const model = parsePte(assemblePte(program, [new Uint8Array(64)]));
        expect(model.namedData).toEqual([
            { key: 'weights.bin', segmentIndex: 9, size: '' },
            { key: 'ok.bin', segmentIndex: 0, size: '64' }
        ]);
        expect(model.namedDataBytes).toBe('64');
        expect(model.methods[0]!.delegates[0]).toMatchObject({ location: 'segment', dataIndex: 7, dataBytes: '', fileOffset: '' });
        expect(model.warnings).toContainEqual({ key: 'pte.warning.missingSegments', args: { count: 2 } });
    });

    it('counts named data bytes once per segment, whatever names it', () => {
        const program = buildProgram({
            methods: [{ name: 'forward', values: [], inputs: [], outputs: [], chains: [], operators: [] }],
            segments: [[0n, 64n], [128n, 32n]],
            namedData: [{ key: 'a', segmentIndex: 0 }, { key: 'b', segmentIndex: 0 }, { key: 'c', segmentIndex: 1 }]
        });
        const model = parsePte(assemblePte(program, [new Uint8Array(64), new Uint8Array(32)]));
        expect(model.namedDataBytes).toBe('96');
    });

    it('reports inline constant buffers without the mandatory placeholder', () => {
        const program = buildProgram({
            methods: [{
                name: 'forward',
                values: [{ kind: 'Tensor', value: { type: 6, sizes: [12], dataBufferIndex: 1, name: 'w' } }],
                inputs: [], outputs: [0], chains: [], operators: []
            }],
            constantBuffers: [new Uint8Array(0), new Uint8Array(48)]
        });
        const model = parsePte(program);
        expect(model.constantBufferCount).toBe(1);
        expect(model.constantBytes).toBe('48');
    });

    it('treats a subsegment slot that runs past its segment as missing data', () => {
        const program = buildProgram({
            methods: [{
                name: 'forward',
                values: [
                    { kind: 'Tensor', value: { type: 6, sizes: [4], dataBufferIndex: 1, name: 'a' } },
                    { kind: 'Tensor', value: { type: 6, sizes: [4], dataBufferIndex: 2, name: 'b' } },
                    { kind: 'Tensor', value: { type: 6, sizes: [4], dataBufferIndex: 3, name: 'c' } }
                ],
                inputs: [], outputs: [0], chains: [], operators: []
            }],
            segments: [[0n, 64n]],
            constantSegment: { segmentIndex: 0, offsets: [0n, 0n, 1000n, 1n << 62n] }
        });
        const model = parsePte(assemblePte(program, [new Uint8Array(64)]));
        const [a, b, c] = model.methods[0]!.values.map(value => value.tensor!);
        // Slot 1 ends at offset 1000, beyond the 64-byte segment; slots 2 and 3 start beyond it.
        expect(a).toMatchObject({ storage: 'segment', dataBytes: '', fileOffset: '' });
        expect(b).toMatchObject({ dataBytes: '', fileOffset: '' });
        expect(c).toMatchObject({ dataBytes: '', fileOffset: '' });
        expect(model.warnings).toContainEqual({ key: 'pte.warning.missingData', args: { count: 3 } });
    });

    it('accepts a shorter extended header without the segment data size', () => {
        const program = buildProgram({
            methods: [{ name: 'forward', values: [], inputs: [], outputs: [], chains: [], operators: [] }],
            segments: [[0n, 4n]]
        });
        const model = parsePte(assemblePte(program, [new Uint8Array(4)], { headerLength: 24 }));
        expect(model.extendedHeader).toMatchObject({ length: 24, segmentDataSize: '' });
        expect(model.segments[0]).toMatchObject({ kind: 'unused', inRange: true });
    });

    it('counts each shared delegate blob once', () => {
        const method = (name: string): Parameters<typeof buildProgram>[0]['methods'][0] => ({
            name,
            values: [{ kind: 'Tensor', value: { type: 6, sizes: [1] } }, { kind: 'Tensor', value: { type: 6, sizes: [1], allocation: { memoryId: 1, offset: 0 } } }],
            inputs: [0], outputs: [1],
            chains: [{ instructions: [{ kind: 'DelegateCall', delegate: 0, args: [0, 1] }] }],
            operators: [],
            delegates: [{ id: 'XnnpackBackend', location: 'segment', index: 0 }]
        });
        const program = buildProgram({ methods: [method('forward'), method('encode')], segments: [[0n, 100n]] });
        const model = parsePte(assemblePte(program, [new Uint8Array(100)]));
        expect(model.delegateBytes).toBe('100');
        expect(model.summary.find(item => item.labelKey === 'pte.summary.delegates')?.value).toBe(2);
    });

    it('reports EValue kinds it does not know instead of calling them Null', () => {
        const forged = buildProgram({
            methods: [{ name: 'forward', values: [{ kind: 'Int', value: 1n }], inputs: [], outputs: [], chains: [], operators: [] }]
        });
        const evalue = findEvalueTypeByte(forged);
        expect(forged[evalue]).toBe(2);
        forged[evalue] = 42;
        const unknown = parsePte(forged);
        expect(unknown.methods[0]!.values[0]).toMatchObject({ kind: 'Null', preview: 'kind 42' });
        expect(unknown.warnings).toContainEqual({ key: 'pte.warning.unknownValueKinds', args: { count: 1 } });
    });

    it('stays linear when many trailing arguments name one long tensor list', () => {
        const count = 6000;
        const values: Parameters<typeof buildProgram>[0]['methods'][0]['values'] = [];
        for (let index = 0; index < count; index++) values.push({ kind: 'Tensor', value: { type: 6, sizes: [1], allocation: { memoryId: 1, offset: index } } });
        values.push({ kind: 'TensorList', value: Array.from({ length: count }, (_, index) => index) });
        const program = buildProgram({
            methods: [{
                name: 'forward', values, inputs: [], outputs: [],
                chains: [{ instructions: [{ kind: 'KernelCall', op: 0, args: Array.from({ length: count }, () => count) }] }],
                operators: [['aten::stack', 'out']]
            }]
        });
        const started = performance.now();
        const forward = parsePte(program).methods[0]!;
        expect(performance.now() - started).toBeLessThan(4000);
        // The last argument is the return value: the list, so its items are the
        // outputs, and the copy just before it is the `Tensor[] out` argument.
        expect(forward.instructions[0]!.outputs).toHaveLength(count);
        expect(forward.instructions[0]!.inputs).toHaveLength(count - 2);
    });

    it('tolerates a list nested in a list without recursing through it', () => {
        const values: Parameters<typeof buildProgram>[0]['methods'][0]['values'] = [];
        const depth = 50_000;
        for (let index = 0; index < depth; index++) values.push({ kind: 'TensorList', value: [index + 1] });
        values.push({ kind: 'Int', value: 0n });
        const program = buildProgram({
            methods: [{ name: 'forward', values, inputs: [], outputs: [], chains: [{ instructions: [{ kind: 'KernelCall', op: 0, args: [0, depth] }] }], operators: [['aten::x', 'out']] }]
        });
        expect(parsePte(program).methods[0]!.instructions[0]).toMatchObject({ inputs: [0], outputs: [depth] });
    });

    it('collapses a long run of list echoes in linear time', () => {
        const count = 20_000;
        const values: Parameters<typeof buildProgram>[0]['methods'][0]['values'] = [{ kind: 'Tensor', value: { type: 6, sizes: [1], allocation: { memoryId: 1, offset: 0 } } }];
        for (let index = 0; index < count; index++) values.push({ kind: 'TensorList', value: [0] });
        const args = Array.from({ length: count + 1 }, (_, index) => index);
        const program = buildProgram({
            methods: [{ name: 'forward', values, inputs: [], outputs: [], chains: [{ instructions: [{ kind: 'DelegateCall', delegate: 0, args }] }], operators: [], delegates: [{ id: 'X', location: 'inline', index: 0 }] }],
            delegateInline: [new Uint8Array(4)]
        });
        const started = performance.now();
        const instruction = parsePte(program).methods[0]!.instructions[0]!;
        expect(performance.now() - started).toBeLessThan(4000);
        expect(instruction.outputs).toEqual([0]);
    });

    it('scans a fully defined tensor list once, however many calls name it', () => {
        const items = 50_000;
        const calls = 4000;
        const values: Parameters<typeof buildProgram>[0]['methods'][0]['values'] = [{ kind: 'Tensor', value: { type: 6, sizes: [1] } }];
        values.push({ kind: 'TensorList', value: Array.from({ length: items }, () => 0) });
        for (let index = 0; index < calls; index++) values.push({ kind: 'Tensor', value: { type: 6, sizes: [1], allocation: { memoryId: 1, offset: index * 4 } } });
        const program = buildProgram({
            methods: [{
                name: 'forward', values, inputs: [0], outputs: [],
                chains: [{ instructions: Array.from({ length: calls }, (_, index) => ({ kind: 'DelegateCall' as const, delegate: 0, args: [0, 1, index + 2] })) }],
                operators: [], delegates: [{ id: 'X', location: 'inline', index: 0 }]
            }],
            delegateInline: [new Uint8Array(4)]
        });
        const started = performance.now();
        const method = parsePte(program).methods[0]!;
        expect(performance.now() - started).toBeLessThan(4000);
        expect(method.instructions[calls - 1]).toMatchObject({ inputs: [0, 1], outputs: [calls + 1] });
    });

    it('drops only the out-argument positions, keeping an earlier read of the same value', () => {
        // executorch_prim::add.Scalar(i, 1, i) as a lowered loop writes it: the
        // first `i` is read, the last is the return.
        const program = buildProgram({
            methods: [{
                name: 'forward',
                values: [{ kind: 'Int', value: 0n }, { kind: 'Int', value: 1n }],
                inputs: [], outputs: [],
                chains: [{ instructions: [{ kind: 'KernelCall', op: 0, args: [0, 1, 0] }] }],
                operators: [['executorch_prim::add', 'Scalar']]
            }]
        });
        expect(parsePte(program).methods[0]!.instructions[0]).toMatchObject({ inputs: [0, 1], outputs: [0] });
    });

    it('reads a `Tensor[] out` kernel: the list before the echo is the out argument, its tensors the outputs', () => {
        const planned = (offset: number): Parameters<typeof buildProgram>[0]['methods'][0]['values'][0] =>
            ({ kind: 'Tensor', value: { type: 6, sizes: [2], allocation: { memoryId: 1, offset } } });
        const program = buildProgram({
            methods: [{
                name: 'forward',
                values: [{ kind: 'Tensor', value: { type: 6, sizes: [4] } }, planned(0), { kind: 'Int', value: 0n }, planned(0), planned(8), { kind: 'TensorList', value: [3, 4] }],
                inputs: [0], outputs: [3, 4],
                chains: [{ instructions: [
                    { kind: 'KernelCall', op: 0, args: [0, 1, 1] },
                    { kind: 'KernelCall', op: 1, args: [0, 2, 5, 5] }
                ] }],
                operators: [['aten::relu', 'out'], ['aten::unbind_copy', 'int_out']]
            }]
        });
        const method = parsePte(program).methods[0]!;
        expect(method.instructions[1]).toMatchObject({ inputs: [0, 2], outputs: [3, 4] });
        // #3 reuses #1's dead slot but is a fresh output, not an alias.
        expect(method.values[3]!.tensor!.aliasOf).toBeUndefined();
    });

    it('treats et_copy_index as writing its accumulator', () => {
        const planned = (offset: number): Parameters<typeof buildProgram>[0]['methods'][0]['values'][0] =>
            ({ kind: 'Tensor', value: { type: 6, sizes: [2], allocation: { memoryId: 1, offset } } });
        const program = buildProgram({
            methods: [{
                name: 'forward',
                values: [planned(0), { kind: 'Tensor', value: { type: 6, sizes: [2] } }, { kind: 'Int', value: 0n }],
                inputs: [1], outputs: [0],
                chains: [{ instructions: [{ kind: 'KernelCall', op: 0, args: [0, 1, 2] }] }],
                operators: [['executorch_prim::et_copy_index', 'tensor']]
            }]
        });
        expect(parsePte(program).methods[0]!.instructions[0]).toMatchObject({ inputs: [1, 2], outputs: [0] });
    });

    it('counts a scalar a delegate returns after its tensor as a return', () => {
        const program = buildProgram({
            methods: [{
                name: 'forward',
                values: [
                    { kind: 'Tensor', value: { type: 6, sizes: [4] } },
                    { kind: 'Tensor', value: { type: 6, sizes: [4], allocation: { memoryId: 1, offset: 0 } } },
                    { kind: 'Int', value: 0n }
                ],
                inputs: [0], outputs: [1, 2],
                chains: [{ instructions: [{ kind: 'DelegateCall', delegate: 0, args: [0, 1, 2] }] }],
                operators: [], delegates: [{ id: 'X', location: 'inline', index: 0 }]
            }],
            delegateInline: [new Uint8Array(4)]
        });
        expect(parsePte(program).methods[0]!.instructions[0]).toMatchObject({ inputs: [0], outputs: [1, 2] });
    });

    it('expands a list returned by thousands of kernels once', () => {
        const items = 50_000;
        const calls = 4000;
        const values: Parameters<typeof buildProgram>[0]['methods'][0]['values'] = [];
        for (let index = 0; index < items; index++) values.push({ kind: 'Tensor', value: { type: 6, sizes: [1], allocation: { memoryId: 1, offset: index * 4 } } });
        values.push({ kind: 'TensorList', value: Array.from({ length: items }, (_, index) => index) });
        const program = buildProgram({
            methods: [{
                name: 'forward', values, inputs: [], outputs: [],
                chains: [{ instructions: Array.from({ length: calls }, () => ({ kind: 'KernelCall' as const, op: 0, args: [items] })) }],
                operators: [['aten::split', 'out']]
            }]
        });
        const started = performance.now();
        const method = parsePte(program).methods[0]!;
        expect(performance.now() - started).toBeLessThan(6000);
        expect(method.instructions[calls - 1]!.outputs).toBe(method.instructions[0]!.outputs);
        expect(method.instructions[0]!.outputs).toHaveLength(items);
    });

    it('answers alias queries in constant time however many lists hold the value', () => {
        const count = 30_000;
        const values: Parameters<typeof buildProgram>[0]['methods'][0]['values'] = [
            { kind: 'Tensor', value: { type: 6, sizes: [4], allocation: { memoryId: 1, offset: 0 } } },
            { kind: 'Tensor', value: { type: 6, sizes: [4], allocation: { memoryId: 1, offset: 0 } } }
        ];
        for (let index = 0; index < count; index++) values.push({ kind: 'TensorList', value: [1] });
        values.push({ kind: 'Tensor', value: { type: 6, sizes: [4], allocation: { memoryId: 1, offset: 16 } } });
        const program = buildProgram({
            methods: [{
                name: 'forward', values, inputs: [0], outputs: [count + 2],
                chains: [{ instructions: [{ kind: 'DelegateCall', delegate: 0, args: [...Array.from({ length: count }, () => 1), count + 2] }] }],
                operators: [], delegates: [{ id: 'X', location: 'inline', index: 0 }]
            }],
            delegateInline: [new Uint8Array(4)]
        });
        const started = performance.now();
        const method = parsePte(program).methods[0]!;
        expect(performance.now() - started).toBeLessThan(4000);
        expect(method.instructions[0]!.outputs).toEqual([count + 2]);
    });

    it('rejects a boxed int list longer than the item cap instead of shortening it', () => {
        const program = buildProgram({
            methods: [{ name: 'forward', values: [{ kind: 'IntList', value: Array.from({ length: 100_001 }, () => 0n) }], inputs: [], outputs: [], chains: [], operators: [] }]
        });
        expect(() => parsePte(program)).toThrow(PteParseError);
    });

    it('keeps only the leading frames of a long stack trace without charging for the rest', () => {
        const frames = Array.from({ length: 20 }, (_, index) => ({ filename: 'm.py', line: index, name: 'f', context: '' }));
        const program = buildProgram({
            methods: [{
                name: 'forward',
                values: [{ kind: 'Tensor', value: { type: 6, sizes: [1] } }, { kind: 'Tensor', value: { type: 6, sizes: [1], allocation: { memoryId: 1, offset: 0 } } }],
                inputs: [0], outputs: [1],
                chains: [{ instructions: [{ kind: 'KernelCall', op: 0, args: [0, 1] }], stacktrace: [frames] }],
                operators: [['aten::relu', 'out']]
            }]
        });
        const instruction = parsePte(program).methods[0]!.instructions[0]!;
        expect(instruction.frames).toHaveLength(8);
        expect(instruction.frames.map(frame => frame.line)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    describe('memory-plan aliases', () => {
        const planned = (offset: number, sizes = [4]): Parameters<typeof buildProgram>[0]['methods'][0]['values'][0] =>
            ({ kind: 'Tensor', value: { type: 6, sizes, allocation: { memoryId: 1, offset } } });

        it('reads a delegate fed only through aliases and wires the aliases to their producers', () => {
            // D1(x) → A@0; A'@0 aliases A; K(A', w) → B@16; B'@16 and A''@0 alias
            // B and A; D2(B', A'') → C@32, D@48. The emitter gives each alias its
            // own EValue that nothing writes.
            const method = parsePte(buildProgram({
                methods: [{
                    name: 'forward',
                    values: [
                        { kind: 'Tensor', value: { type: 6, sizes: [4] } },   // 0 x
                        planned(0),                                            // 1 A
                        planned(0),                                            // 2 A'
                        { kind: 'Tensor', value: { type: 6, sizes: [4], dataBufferIndex: 1, name: 'w' } }, // 3
                        planned(16),                                           // 4 B
                        planned(16),                                           // 5 B'
                        planned(0),                                            // 6 A''
                        planned(32),                                           // 7 C
                        planned(48)                                            // 8 D
                    ],
                    inputs: [0],
                    outputs: [8],
                    chains: [{ instructions: [
                        { kind: 'DelegateCall', delegate: 0, args: [0, 1] },
                        { kind: 'KernelCall', op: 0, args: [2, 3, 4, 4] },
                        { kind: 'DelegateCall', delegate: 0, args: [5, 6, 7, 8] }
                    ] }],
                    operators: [['aten::mul', 'out']],
                    delegates: [{ id: 'XnnpackBackend', location: 'inline', index: 0 }]
                }],
                constantBuffers: [new Uint8Array(0), new Uint8Array(16)],
                delegateInline: [new Uint8Array(4)]
            })).methods[0]!;
            expect(method.instructions.map(instruction => [instruction.inputs, instruction.outputs])).toEqual([
                [[0], [1]],
                [[2, 3], [4]],
                [[5, 6], [7, 8]]
            ]);
            expect(method.values[2]!.tensor!.aliasOf).toBe(1);
            expect(method.values[5]!.tensor!.aliasOf).toBe(4);
            expect(method.values[6]!.tensor!.aliasOf).toBe(1);
            expect(method.values[7]!.tensor!.aliasOf).toBeUndefined();
        });

        it('does not mistake a fresh output that reuses a dead slot of the same shape for an alias', () => {
            // K1(x) → A@0; K2(A) → B@16; K3(B) → C@0 — C takes A's slot after A dies.
            const method = parsePte(buildProgram({
                methods: [{
                    name: 'forward',
                    values: [{ kind: 'Tensor', value: { type: 6, sizes: [4] } }, planned(0), planned(16), planned(0)],
                    inputs: [0],
                    outputs: [3],
                    chains: [{ instructions: [
                        { kind: 'KernelCall', op: 0, args: [0, 1, 1] },
                        { kind: 'KernelCall', op: 0, args: [1, 2, 2] },
                        { kind: 'KernelCall', op: 0, args: [2, 3, 3] }
                    ] }],
                    operators: [['aten::relu', 'out']]
                }]
            })).methods[0]!;
            expect(method.instructions.map(instruction => [instruction.inputs, instruction.outputs])).toEqual([[[0], [1]], [[1], [2]], [[2], [3]]]);
            expect(method.values[3]!.tensor!.aliasOf).toBeUndefined();
        });

        it('resolves a reshaping view: same bytes, different shape', () => {
            // D1(x) → A@0 [1,1280,1,1]; V@0 [1,1280] is the elided view; D2(V) → O.
            const method = parsePte(buildProgram({
                methods: [{
                    name: 'forward',
                    values: [{ kind: 'Tensor', value: { type: 6, sizes: [1, 1280, 1, 1] } }, planned(0, [1, 1280, 1, 1]), planned(0, [1, 1280]), planned(5120, [1, 1000])],
                    inputs: [0],
                    outputs: [3],
                    chains: [{ instructions: [
                        { kind: 'DelegateCall', delegate: 0, args: [0, 1] },
                        { kind: 'DelegateCall', delegate: 0, args: [2, 3] }
                    ] }],
                    operators: [],
                    delegates: [{ id: 'XnnpackBackend', location: 'inline', index: 0 }]
                }],
                delegateInline: [new Uint8Array(4)]
            })).methods[0]!;
            expect(method.instructions[1]).toMatchObject({ inputs: [2], outputs: [3] });
            expect(method.values[2]!.tensor!.aliasOf).toBe(1);
        });

        it('keeps an alias read by two delegate calls as an input of both', () => {
            // K(x) → A@0; K(x) → P@16; V@0 aliases A; D1(P, V) → O1@32; K(x) → Q@48; D2(Q, V) → O2@64.
            const method = parsePte(buildProgram({
                methods: [{
                    name: 'forward',
                    values: [{ kind: 'Tensor', value: { type: 6, sizes: [4] } }, planned(0), planned(16), planned(0), planned(32), planned(48), planned(64)],
                    inputs: [0],
                    outputs: [4, 6],
                    chains: [{ instructions: [
                        { kind: 'KernelCall', op: 0, args: [0, 1, 1] },
                        { kind: 'KernelCall', op: 0, args: [0, 2, 2] },
                        { kind: 'DelegateCall', delegate: 0, args: [2, 3, 4] },
                        { kind: 'KernelCall', op: 0, args: [0, 5, 5] },
                        { kind: 'DelegateCall', delegate: 0, args: [5, 3, 6] }
                    ] }],
                    operators: [['aten::relu', 'out']],
                    delegates: [{ id: 'XnnpackBackend', location: 'inline', index: 0 }]
                }],
                delegateInline: [new Uint8Array(4)]
            })).methods[0]!;
            expect(method.instructions[2]).toMatchObject({ inputs: [2, 3], outputs: [4] });
            expect(method.instructions[4]).toMatchObject({ inputs: [5, 3], outputs: [6] });
            expect(method.values[3]!.tensor!.aliasOf).toBe(1);
        });

        it('does not reclaim a delegate output that reuses a dead slot even when fed only through an alias', () => {
            // K(x) → A@0; K(A) → B@16; K(B) → C@32; V@32 aliases C; D(V) → O1@16, O2@48; K(O1) → Q@64.
            const method = parsePte(buildProgram({
                methods: [{
                    name: 'forward',
                    values: [{ kind: 'Tensor', value: { type: 6, sizes: [4] } }, planned(0), planned(16), planned(32), planned(32), planned(16), planned(48), planned(64)],
                    inputs: [0],
                    outputs: [6, 7],
                    chains: [{ instructions: [
                        { kind: 'KernelCall', op: 0, args: [0, 1, 1] },
                        { kind: 'KernelCall', op: 0, args: [1, 2, 2] },
                        { kind: 'KernelCall', op: 0, args: [2, 3, 3] },
                        { kind: 'DelegateCall', delegate: 0, args: [4, 5, 6] },
                        { kind: 'KernelCall', op: 0, args: [5, 7, 7] }
                    ] }],
                    operators: [['aten::relu', 'out']],
                    delegates: [{ id: 'XnnpackBackend', location: 'inline', index: 0 }]
                }],
                delegateInline: [new Uint8Array(4)]
            })).methods[0]!;
            expect(method.instructions[3]).toMatchObject({ inputs: [4], outputs: [5, 6] });
            expect(method.values[4]!.tensor!.aliasOf).toBe(3);
            expect(method.values[5]!.tensor!.aliasOf).toBeUndefined();
        });

        it('does not let an unread batch-norm statistic vouch for a delegate output that reuses its slot', () => {
            // bn(x) → out@0, mean@16, invstd@32 (the statistics are never read);
            // D(out) → O1@16, O2@48 where O1 lands on the dead mean's slot; K(O1), K(O2).
            const method = parsePte(buildProgram({
                methods: [{
                    name: 'forward',
                    values: [
                        { kind: 'Tensor', value: { type: 6, sizes: [4] } },
                        planned(0), planned(16), planned(32), { kind: 'TensorList', value: [1, 2, 3] },
                        planned(16), planned(48), planned(64), planned(80)
                    ],
                    inputs: [0],
                    outputs: [7, 8],
                    chains: [{ instructions: [
                        { kind: 'KernelCall', op: 0, args: [0, 1, 2, 3, 4] },
                        { kind: 'DelegateCall', delegate: 0, args: [1, 5, 6] },
                        { kind: 'KernelCall', op: 1, args: [5, 7, 7] },
                        { kind: 'KernelCall', op: 1, args: [6, 8, 8] }
                    ] }],
                    operators: [['aten::_native_batch_norm_legit_no_training', 'out'], ['aten::relu', 'out']],
                    delegates: [{ id: 'XnnpackBackend', location: 'inline', index: 0 }]
                }],
                delegateInline: [new Uint8Array(4)]
            })).methods[0]!;
            expect(method.instructions[1]).toMatchObject({ inputs: [1], outputs: [5, 6] });
            expect(method.values[5]!.tensor!.aliasOf).toBeUndefined();
        });

        it('does not let an unread extra output of a delegate vouch for a later output', () => {
            // D0(x) → A@0 (read later), B@64 (never read); D1(A) → C@64, D@128.
            // C reuses B's slot but is a genuine return of D1.
            const method = parsePte(buildProgram({
                methods: [{
                    name: 'forward',
                    values: [{ kind: 'Tensor', value: { type: 6, sizes: [4] } }, planned(0), planned(64), planned(64), planned(128)],
                    inputs: [0],
                    outputs: [3, 4],
                    chains: [{ instructions: [
                        { kind: 'DelegateCall', delegate: 0, args: [0, 1, 2] },
                        { kind: 'DelegateCall', delegate: 0, args: [1, 3, 4] }
                    ] }],
                    operators: [],
                    delegates: [{ id: 'XnnpackBackend', location: 'inline', index: 0 }]
                }],
                delegateInline: [new Uint8Array(4)]
            })).methods[0]!;
            expect(method.instructions[0]).toMatchObject({ inputs: [0], outputs: [1, 2] });
            expect(method.instructions[1]).toMatchObject({ inputs: [1], outputs: [3, 4] });
            expect(method.values[3]!.tensor!.aliasOf).toBeUndefined();
        });

        it('points a chained alias at the terminal value, not at another alias', () => {
            // relu(x)→#1@0; relu(#2)→#4 reads #2 as an alias of #1; relu(#4)→#2
            // writes that slot again; relu(#3)→#5 then reads #3, whose bytes are
            // the ones #2 now holds — and #2 is itself an alias of #1.
            const method = parsePte(buildProgram({
                methods: [{
                    name: 'forward',
                    values: [{ kind: 'Tensor', value: { type: 6, sizes: [4] } }, planned(0), planned(0), planned(0), planned(16), planned(32)],
                    inputs: [0],
                    outputs: [5],
                    chains: [{ instructions: [
                        { kind: 'KernelCall', op: 0, args: [0, 1, 1] },
                        { kind: 'KernelCall', op: 0, args: [2, 4, 4] },
                        { kind: 'KernelCall', op: 0, args: [4, 2, 2] },
                        { kind: 'KernelCall', op: 0, args: [3, 5, 5] }
                    ] }],
                    operators: [['aten::relu', 'out']]
                }]
            })).methods[0]!;
            expect(method.values[2]!.tensor!.aliasOf).toBe(1);
            // Terminal, not #2: every alias names a value that is not itself one.
            expect(method.values[3]!.tensor!.aliasOf).toBe(1);
            for (const value of method.values) {
                const root = value.tensor?.aliasOf;
                if (root !== undefined) expect(method.values[root]!.tensor!.aliasOf).toBeUndefined();
            }
        });

        it('keeps a method output the delegate writes, even when its slot carried an alias chain', () => {
            // #1..#4 share mem1+0. #2 aliases #1 and is then rewritten, so the
            // slot's occupant is itself an alias; #4 is a fresh delegate output
            // and a method output, and must not be reclaimed as an alias input.
            const method = parsePte(buildProgram({
                methods: [{
                    name: 'forward',
                    values: [
                        { kind: 'Tensor', value: { type: 6, sizes: [4] } },
                        planned(0), planned(0), planned(0), planned(0),
                        planned(16), planned(32), planned(48), planned(64)
                    ],
                    inputs: [0],
                    outputs: [4, 6],
                    chains: [{ instructions: [
                        { kind: 'KernelCall', op: 0, args: [0, 1, 1] },
                        { kind: 'KernelCall', op: 0, args: [2, 7, 7] },
                        { kind: 'KernelCall', op: 0, args: [7, 2, 2] },
                        { kind: 'KernelCall', op: 0, args: [3, 8, 8] },
                        { kind: 'KernelCall', op: 0, args: [0, 5, 5] },
                        { kind: 'DelegateCall', delegate: 0, args: [5, 4, 6] }
                    ] }],
                    operators: [['aten::relu', 'out']],
                    delegates: [{ id: 'XnnpackBackend', location: 'inline', index: 0 }]
                }],
                delegateInline: [new Uint8Array(4)]
            })).methods[0]!;
            expect(method.values[2]!.tensor!.aliasOf).toBe(1);
            expect(method.values[3]!.tensor!.aliasOf).toBe(1);
            expect(method.values[4]!.tensor!.aliasOf).toBeUndefined();
            expect(method.instructions[5]).toMatchObject({ inputs: [5], outputs: [4, 6] });
        });

        it('resolves a list item that only becomes an alias after the list was first read', () => {
            // The loop-body shape: cat(L) reads L at the top, relu writes the
            // slot below it, and the next cat(L) must see the alias.
            const method = parsePte(buildProgram({
                methods: [{
                    name: 'forward',
                    values: [
                        { kind: 'Tensor', value: { type: 6, sizes: [4] } },
                        planned(0), planned(0), { kind: 'TensorList', value: [2] }, planned(16), planned(32)
                    ],
                    inputs: [0],
                    outputs: [4, 5],
                    chains: [{ instructions: [
                        { kind: 'KernelCall', op: 1, args: [3, 4, 4] },
                        { kind: 'KernelCall', op: 0, args: [0, 1, 1] },
                        { kind: 'KernelCall', op: 1, args: [3, 5, 5] }
                    ] }],
                    operators: [['aten::relu', 'out'], ['aten::cat', 'out']]
                }]
            })).methods[0]!;
            expect(method.values[2]!.tensor!.aliasOf).toBe(1);
        });

        it('resolves a waiting list item however many times other lists are read', () => {
            // A long list read many times must not cost a later list its alias:
            // items wait under their slot and resolve when it gains an occupant.
            const big = Array.from({ length: 20_000 }, () => 9_000_000);
            const planned0 = (): Parameters<typeof buildProgram>[0]['methods'][0]['values'][0] =>
                ({ kind: 'Tensor', value: { type: 6, sizes: [1], allocation: { memoryId: 1, offset: 0 } } });
            const instructions = Array.from({ length: 60 }, () => ({ kind: 'KernelCall' as const, op: 0, args: [0, 1] }));
            instructions.push({ kind: 'KernelCall', op: 0, args: [3, 1] });
            const method = parsePte(buildProgram({
                methods: [{
                    name: 'forward',
                    values: [{ kind: 'TensorList', value: big }, planned0(), planned0(), { kind: 'TensorList', value: [2] }],
                    inputs: [], outputs: [1],
                    chains: [{ instructions }],
                    operators: [['aten::cat', 'out']]
                }]
            })).methods[0]!;
            expect(method.values[2]!.tensor!.aliasOf).toBe(1);
        });

        it('does not alias a list item to a writer that only runs after the read', () => {
            // cat reads L = [#1] before anything writes mem1+0; relu writes it
            // afterwards and nothing reads #1 again, so #1 is no alias — and the
            // delegate's own output must stay an output.
            const method = parsePte(buildProgram({
                methods: [{
                    name: 'forward',
                    values: [
                        { kind: 'Tensor', value: { type: 6, sizes: [1] } },
                        { kind: 'Tensor', value: { type: 6, sizes: [1], allocation: { memoryId: 1, offset: 0 } } },
                        { kind: 'TensorList', value: [1] },
                        { kind: 'Tensor', value: { type: 6, sizes: [1], allocation: { memoryId: 1, offset: 32 } } },
                        { kind: 'Tensor', value: { type: 6, sizes: [1], allocation: { memoryId: 1, offset: 0 } } },
                        { kind: 'Tensor', value: { type: 6, sizes: [1], allocation: { memoryId: 1, offset: 64 } } }
                    ],
                    inputs: [0],
                    outputs: [5, 3],
                    chains: [{ instructions: [
                        { kind: 'KernelCall', op: 1, args: [2, 3, 3] },
                        { kind: 'KernelCall', op: 0, args: [0, 4, 4] },
                        { kind: 'DelegateCall', delegate: 0, args: [0, 5] }
                    ] }],
                    operators: [['aten::relu', 'out'], ['aten::cat', 'out']],
                    delegates: [{ id: 'XnnpackBackend', location: 'inline', index: 0 }]
                }],
                delegateInline: [new Uint8Array(4)]
            })).methods[0]!;
            expect(method.values[1]!.tensor!.aliasOf).toBeUndefined();
            expect(method.instructions[2]).toMatchObject({ inputs: [0], outputs: [5] });
        });

        it('counts a move or a conditional jump as a read of a delegate output', () => {
            // K(x) → A@0; K(A) → B@16; D(B) → O1@0 (A's dead slot), O2@32; Move O1 → M.
            const method = parsePte(buildProgram({
                methods: [{
                    name: 'forward',
                    values: [{ kind: 'Tensor', value: { type: 6, sizes: [4] } }, planned(0), planned(16), planned(0), planned(32), planned(48)],
                    inputs: [0],
                    outputs: [4, 5],
                    chains: [{ instructions: [
                        { kind: 'KernelCall', op: 0, args: [0, 1, 1] },
                        { kind: 'KernelCall', op: 0, args: [1, 2, 2] },
                        { kind: 'DelegateCall', delegate: 0, args: [2, 3, 4] },
                        { kind: 'MoveCall', from: 3, to: 5 }
                    ] }],
                    operators: [['aten::relu', 'out']],
                    delegates: [{ id: 'XnnpackBackend', location: 'inline', index: 0 }]
                }],
                delegateInline: [new Uint8Array(4)]
            })).methods[0]!;
            expect(method.instructions[2]).toMatchObject({ inputs: [2], outputs: [3, 4] });
            expect(method.values[3]!.tensor!.aliasOf).toBeUndefined();
        });

        it('takes kernel outputs from the return echo, so slot reuse never confuses them', () => {
            // Every out of bn2 reuses the slot of an unread out of bn1.
            const bn = (input: number, out: number, mean: number, invstd: number, echo: number): { kind: 'KernelCall'; op: number; args: number[] } =>
                ({ kind: 'KernelCall', op: 0, args: [input, out, mean, invstd, echo] });
            const method = parsePte(buildProgram({
                methods: [{
                    name: 'forward',
                    values: [
                        { kind: 'Tensor', value: { type: 6, sizes: [4] } },
                        planned(0), planned(16, [1]), planned(32, [1]), { kind: 'TensorList', value: [1, 2, 3] },
                        planned(48), planned(16, [1]), planned(32, [1]), { kind: 'TensorList', value: [5, 6, 7] }
                    ],
                    inputs: [0],
                    outputs: [5],
                    chains: [{ instructions: [bn(0, 1, 2, 3, 4), bn(1, 5, 6, 7, 8)] }],
                    operators: [['aten::_native_batch_norm_legit_no_training', 'out']]
                }]
            })).methods[0]!;
            expect(method.instructions.map(instruction => [instruction.inputs, instruction.outputs])).toEqual([[[0], [1, 2, 3]], [[1], [5, 6, 7]]]);
            expect(method.values[6]!.tensor!.aliasOf).toBeUndefined();
        });

        it('reclaims an aliased input that follows a defined one in a delegate call', () => {
            // K(x) → A@0; K(x) → P@16; R@0 aliases A; D(P, R) → O1@32, O2@48; K(O1) → Q@64.
            // O1 reuses no slot and is read later, so only R is reclaimed.
            const method = parsePte(buildProgram({
                methods: [{
                    name: 'forward',
                    values: [{ kind: 'Tensor', value: { type: 6, sizes: [4] } }, planned(0), planned(16), planned(0), planned(32), planned(48), planned(64)],
                    inputs: [0],
                    outputs: [5, 6],
                    chains: [{ instructions: [
                        { kind: 'KernelCall', op: 0, args: [0, 1, 1] },
                        { kind: 'KernelCall', op: 0, args: [0, 2, 2] },
                        { kind: 'DelegateCall', delegate: 0, args: [2, 3, 4, 5] },
                        { kind: 'KernelCall', op: 0, args: [4, 6, 6] }
                    ] }],
                    operators: [['aten::relu', 'out']],
                    delegates: [{ id: 'XnnpackBackend', location: 'inline', index: 0 }]
                }],
                delegateInline: [new Uint8Array(4)]
            })).methods[0]!;
            expect(method.instructions[2]).toMatchObject({ inputs: [2, 3], outputs: [4, 5] });
            expect(method.values[3]!.tensor!.aliasOf).toBe(1);
        });
    });

    it('warns about a foreign identifier and an empty program', () => {
        const model = parsePte(pteForeignIdentifierFixture());
        expect(model.identifier).toBe('ET99');
        expect(model.methods).toEqual([]);
        expect(model.warnings).toEqual([
            { key: 'pte.warning.identifier', args: { identifier: 'ET99' } },
            { key: 'pte.warning.noMethods' }
        ]);
    });

    it('rejects files that are too small or point outside the buffer', () => {
        expect(() => parsePte(new Uint8Array(4))).toThrow(PteParseError);
        const bogus = new Uint8Array([0xff, 0xff, 0xff, 0x7f, 0x45, 0x54, 0x31, 0x32, 0, 0, 0, 0]);
        expect(() => parsePte(bogus)).toThrow(PteParseError);
        const truncated = pteFixture().subarray(0, 200);
        expect(() => parsePte(truncated)).toThrow(PteParseError);
    });

    it('produces a JSON-serializable document', () => {
        const model = parsePte(pteFixture());
        expect(JSON.parse(JSON.stringify(model))).toEqual(model);
    });
});
