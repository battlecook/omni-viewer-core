import { describe, expect, it } from 'vitest';
import {
    FlatBufferBuilder,
    tfliteAdvancedFixture,
    tfliteControlFlowFixture,
    tfliteEmptyGraphFixture,
    tfliteFixture,
    tfliteAliasedVectorFixture,
    tfliteLargeBufferFixture,
    tfliteWideGraphFixture
} from './__tests__/fixture.js';
import { parseTflite, TfliteParseError } from './index.js';

describe('parseTflite', () => {
    const model = parseTflite(tfliteFixture());
    const main = model.subgraphs[0]!;

    it('reads the model header, description, and summary counts', () => {
        expect(model.format).toBe('tflite');
        expect(model.identifier).toBe('TFL3');
        expect(model.version).toBe('3');
        expect(model.description).toBe('Fixture classifier');
        expect(model.title).toBe('main');
        expect(model.subgraphs).toHaveLength(2);
        expect(model.summary).toEqual([
            { labelKey: 'tflite.summary.operators', value: 5 },
            { labelKey: 'tflite.summary.tensors', value: 8 },
            { labelKey: 'tflite.summary.subgraphs', value: 2 },
            { labelKey: 'tflite.summary.operatorCodes', value: 5 },
            { labelKey: 'tflite.summary.weights', value: '1.07 KB' },
            { labelKey: 'tflite.summary.version', value: 3 }
        ]);
    });

    it('resolves builtin, custom, and placeholder operator codes', () => {
        expect(model.operatorCodes.map(code => code.name)).toEqual([
            'CONV_2D', 'FULLY_CONNECTED', 'TFLite_Detection_PostProcess', 'CUMSUM', 'FlexErf'
        ]);
        // Codes at or above the placeholder come from `builtin_code`, not the byte.
        expect(model.operatorCodes[3]).toMatchObject({ builtinCode: 128, custom: false, version: 1 });
        expect(model.operatorCodes[2]).toMatchObject({ custom: true, customCode: 'TFLite_Detection_PostProcess' });
        expect(model.operatorCodes[0]).toMatchObject({ builtinCode: 3, version: 3 });
    });

    it('decodes builtin options with enum labels and skips schema defaults', () => {
        expect(main.operators[0]).toMatchObject({
            id: 'op-0-0', operator: 'CONV_2D', optionsType: 'Conv2DOptions', inputs: [0, 1, 2], outputs: [3]
        });
        expect(main.operators[0]!.options).toEqual([
            { name: 'padding', value: 'SAME' },
            { name: 'stride_w', value: '1' },
            { name: 'stride_h', value: '1' },
            { name: 'fused_activation_function', value: 'RELU6' }
        ]);
        expect(main.operators[1]!.options).toEqual([{ name: 'keep_num_dims', value: 'true' }]);
        expect(main.operators[3]!.options).toEqual([{ name: 'exclusive', value: 'true' }]);
    });

    it('records custom operator payload sizes without reading them', () => {
        expect(main.operators[2]).toMatchObject({
            operator: 'TFLite_Detection_PostProcess', custom: true, customOptionsBytes: '6',
            customOptionsFormat: 'FLEXBUFFERS', optionsType: '', options: []
        });
    });

    it('reads tensor types, shapes, quantization, and buffer storage', () => {
        expect(main.tensors[0]).toMatchObject({
            name: 'input', type: 'FLOAT32', shape: [1, 8, 8, 3], shapeSignature: [-1, 8, 8, 3],
            elementCount: '192', expectedBytes: '768', location: 'empty', dataBytes: '0'
        });
        expect(main.tensors[1]).toMatchObject({ type: 'INT8', location: 'inline', dataBytes: '48', expectedBytes: '12' });
        expect(main.tensors[1]!.quantization).toMatchObject({
            zeroPoint: ['0', '0', '0', '0'], quantizedDimension: 0, summary: 'per-axis[0] × 4'
        });
        // float32 round-trip, so compare against the nearest representable values.
        expect(main.tensors[1]!.quantization!.scale.map(value => Number(value.toFixed(3)))).toEqual([0.1, 0.2, 0.3, 0.4]);
        expect(main.tensors[3]!.quantization?.summary).toBe('scale=0.0078125 · zero=-128');
    });

    it('reports buffers stored outside the FlatBuffer', () => {
        expect(model.buffers[4]).toEqual({ index: 4, size: '1024', offset: '4096', location: 'appended' });
        expect(main.tensors[5]).toMatchObject({ name: 'appended_weights', location: 'appended', dataBytes: '1024' });
        expect(model.weightBytes).toBe('1096');
    });

    it('decodes metadata text buffers and signature definitions', () => {
        expect(model.metadata).toEqual([{ name: 'min_runtime_version', buffer: 3, size: '8', text: '1.14.0' }]);
        expect(model.minRuntimeVersion).toBe('1.14.0');
        expect(model.metadataBuffers).toEqual([3]);
        expect(model.signatures).toEqual([{
            key: 'serving_default',
            subgraphIndex: 0,
            inputs: [{ name: 'image', tensorIndex: 0, tensorName: 'input' }],
            outputs: [{ name: 'scores', tensorIndex: 4, tensorName: 'logits' }]
        }]);
    });

    it('warns about custom operators, Select-TF fallbacks, and appended buffers', () => {
        expect(model.warnings).toEqual([
            { key: 'tflite.warning.customOps', args: { count: 1, names: 'TFLite_Detection_PostProcess' } },
            { key: 'tflite.warning.flexOps', args: { count: 1 } },
            { key: 'tflite.warning.appendedBuffers', args: { count: 1 } }
        ]);
    });

    it('surfaces the subgraphs a control-flow operator delegates to', () => {
        const controlFlow = parseTflite(tfliteControlFlowFixture());
        const whileOp = controlFlow.subgraphs[0]!.operators[0]!;
        expect(whileOp.operator).toBe('WHILE');
        expect(whileOp.optionsType).toBe('WhileOptions');
        expect(whileOp.subgraphRefs).toEqual([1, 2]);
        expect(whileOp.options).toEqual([
            { name: 'cond_subgraph_index', value: '1' },
            { name: 'body_subgraph_index', value: '2' }
        ]);
    });

    it('warns about an unexpected file identifier, schema version, and empty graph', () => {
        const unusual = parseTflite(tfliteEmptyGraphFixture('TFL2', 4));
        expect(unusual.warnings).toEqual([
            { key: 'tflite.warning.identifier', args: { identifier: 'TFL2' } },
            { key: 'tflite.warning.version', args: { version: 4 } },
            { key: 'tflite.warning.emptyGraph' }
        ]);
    });

    it('parses a large chained graph without exceeding its object budget', () => {
        const wide = parseTflite(tfliteWideGraphFixture(500));
        expect(wide.subgraphs[0]!.operators).toHaveLength(500);
        expect(wide.subgraphs[0]!.tensors).toHaveLength(501);
    });

    it('reads weight buffers far larger than the per-vector item cap', () => {
        const large = parseTflite(tfliteLargeBufferFixture(2_000_000));
        expect(large.subgraphs[0]!.tensors[0]).toMatchObject({ location: 'inline', dataBytes: '2000000' });
        expect(large.weightBytes).toBe('2000000');
    });

    it('rejects a tensor whose declared rank exceeds the supported maximum', () => {
        const builder = new FlatBufferBuilder(1 << 14);
        builder.startTable();
        const buffer = builder.endTable();
        const shape = builder.createIntVector(new Array(1025).fill(1));
        builder.startTable();
        builder.addOffset(0, shape);
        builder.addInt32(2, 0);
        const tensor = builder.endTable();
        const tensorVector = builder.createOffsetVector([tensor]);
        builder.startTable();
        builder.addOffset(0, tensorVector);
        const subgraph = builder.endTable();
        const subgraphVector = builder.createOffsetVector([subgraph]);
        const bufferVector = builder.createOffsetVector([buffer]);
        builder.startTable();
        builder.addInt32(0, 3);
        builder.addOffset(2, subgraphVector);
        builder.addOffset(4, bufferVector);
        const model = builder.endTable();
        expect(() => parseTflite(builder.finish(model))).toThrow(/item limit/);
    });

    it('rejects files that are too small, mis-rooted, or truncated', () => {
        expect(() => parseTflite(new Uint8Array(4))).toThrow(TfliteParseError);
        const data = tfliteFixture();
        const badRoot = data.slice();
        new DataView(badRoot.buffer).setUint32(0, data.byteLength + 16, true);
        expect(() => parseTflite(badRoot)).toThrow(/root table offset/);
        expect(() => parseTflite(data.slice(0, Math.floor(data.byteLength / 2)))).toThrow(TfliteParseError);
    });

    it('rejects a table whose vtable points outside the buffer', () => {
        const data = tfliteFixture();
        const corrupt = data.slice();
        const root = new DataView(corrupt.buffer).getUint32(0, true);
        // A huge positive soffset drives the vtable position negative.
        new DataView(corrupt.buffer).setInt32(root, 0x7fffffff, true);
        expect(() => parseTflite(corrupt)).toThrow(TfliteParseError);
    });

    it('keeps a model viewable when one tensor has an invalid dimension', () => {
        const builder = new FlatBufferBuilder();
        builder.startTable();
        const buffer = builder.endTable();
        const shape = builder.createIntVector([2, -3]);
        builder.startTable();
        builder.addOffset(0, shape);
        builder.addInt8(1, 0);
        builder.addInt32(2, 0);
        const tensor = builder.endTable();
        const tensorVector = builder.createOffsetVector([tensor]);
        builder.startTable();
        builder.addOffset(0, tensorVector);
        const subgraph = builder.endTable();
        const subgraphVector = builder.createOffsetVector([subgraph]);
        const bufferVector = builder.createOffsetVector([buffer]);
        builder.startTable();
        builder.addInt32(0, 3);
        builder.addOffset(2, subgraphVector);
        builder.addOffset(4, bufferVector);
        const model = builder.endTable();
        // A bad dimension degrades the display-only element count instead of
        // making the whole model unviewable; the shape is still shown as stored.
        const odd = parseTflite(builder.finish(model));
        expect(odd.subgraphs[0]!.tensors[0]).toMatchObject({
            shape: [2, -3], elementCount: '0', expectedBytes: '0'
        });
    });

    it('caps decoded elements across vectors that many tables alias', () => {
        // One shared index vector referenced by every operator would otherwise
        // decode tables × elements values from a small file.
        expect(() => parseTflite(tfliteAliasedVectorFixture(400, 60_000)))
            .toThrow(/decoded-element limit/);
        expect(parseTflite(tfliteAliasedVectorFixture(4, 1_000)).subgraphs[0]!.operators).toHaveLength(4);
    });

    it('decodes builtin_options_2, out-of-band custom payloads, and sparsity', () => {
        const advanced = parseTflite(tfliteAdvancedFixture());
        const [composite, large] = advanced.subgraphs[0]!.operators;
        expect(composite).toMatchObject({
            operator: 'STABLEHLO_COMPOSITE', optionsType: 'StableHLOCompositeOptions', subgraphRefs: [0]
        });
        expect(composite!.options).toEqual([
            { name: 'name', value: 'odml.scaled_dot_product_attention' },
            { name: 'decomposition_subgraph_index', value: '0' },
            { name: 'version', value: '2' }
        ]);
        // `large_custom_options_size` supersedes the inline custom_options vector.
        expect(large).toMatchObject({ operator: 'BigCustom', custom: true, customOptionsBytes: '65536' });

        const sparsity = advanced.subgraphs[0]!.tensors[0]!.sparsity!;
        expect(sparsity).toMatchObject({ traversalOrder: [0, 1], blockMap: [1], truncated: false });
        expect(sparsity.dimensions).toEqual([
            { format: 'DENSE', denseSize: 4, arraySegments: [], arrayIndices: [], truncated: false },
            { format: 'SPARSE_CSR', denseSize: 0, arraySegments: [0, 2, 4], arrayIndices: [0, 1, 0, 1], truncated: false }
        ]);
    });

    it('reads tables that share a deduplicated vtable (negative soffset)', () => {
        // flatc reuses a matching vtable, which leaves it *after* the table it
        // describes and makes the table's soffset negative. That is the layout of
        // the overwhelming majority of tables in a real model, so it must decode.
        const builder = new FlatBufferBuilder();
        const tables = [7, 9, 11, 13].map(value => {
            builder.startTable();
            builder.addInt32(0, value);
            return builder.endTable();
        });
        const data = builder.finish(tables[0]!);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const soffsets = tables.map(table => view.getInt32(data.length - table, true));
        // Once the inline layout repeats, every further table reuses a vtable.
        expect(soffsets.filter(soffset => soffset < 0).length).toBeGreaterThan(0);

        // And a whole model built from structurally identical tables round-trips.
        const aliased = parseTflite(tfliteAliasedVectorFixture(3, 2));
        expect(aliased.subgraphs[0]!.operators.map(operator => operator.inputs)).toEqual([[0, 0], [0, 0], [0, 0]]);
    });

    it('distinguishes a scalar from a tensor of unknown rank', () => {
        const model = parseTflite(tfliteFixture());
        expect(model.subgraphs[0]!.tensors[0]!.hasRank).toBe(true);
        const controlFlow = parseTflite(tfliteControlFlowFixture());
        // `counter` is declared with an empty shape and no has_rank flag.
        expect(controlFlow.subgraphs[0]!.tensors[0]).toMatchObject({ shape: [], hasRank: false });
    });
});
