import { describe, expect, it } from 'vitest';
import { OnnxParseError, parseOnnx } from './index.js';
import { onnxAttributeListFixture, onnxControlFlowFixture, onnxEmptyNodesFixture, onnxExternalAttributeFixture, onnxFixture, onnxFunctionDefaultExternalFixture, onnxMalformedPackedAttribute, onnxModernFieldsFixture, onnxSemanticMetadataFixture, onnxSignedDeviceFixture, onnxSparseMetadataFixture, onnxStructuredAttributeFixture, onnxTensorDimsFixture, onnxTextBudgetFixture, onnxTypeDimensionsFixture, onnxTypeProtoAttributeFixture } from './__tests__/fixture.js';

describe('parseOnnx', () => {
    it('reads model, graph, node, type, attribute, and tensor metadata without decoding weights', () => {
        const document = parseOnnx(onnxFixture());
        expect(document).toMatchObject({
            format: 'onnx', irVersion: '10', modelVersion: '7', producer: 'unit-test 1.0', title: 'classifier'
        });
        expect(document.opsets).toEqual([{ domain: 'ai.onnx', version: '18' }]);
        expect(document.metadata).toEqual([{ key: 'license', value: 'MIT' }]);
        expect(document.graph.nodes).toHaveLength(3);
        expect(document.graph.nodes[0]).toMatchObject({
            name: 'dense', operator: 'MatMul', inputs: ['input', 'weight'], outputs: ['hidden']
        });
        expect(document.graph.nodes[0]?.attributes.find(item => item.name === 'transB')).toMatchObject({ name: 'transB', type: 'INT', value: '1' });
        expect(document.graph.nodes[0]?.attributes.find(item => item.name === 'cast_type')).toMatchObject({ name: 'cast_type', type: 'TYPE_PROTO', value: 'tensor<FLOAT>' });
        expect(document.graph.nodes[0]?.attributes.find(item => item.name === 'mask')).toMatchObject({ type: 'SPARSE_TENSOR' });
        expect(document.graph.nodes[2]).toMatchObject({ operator: 'Normalize', domain: 'com.test', overload: 'fast' });
        expect(document.graph.nodes[0]?.metadata).toEqual([{ key: 'node.kind', value: 'dense' }]);
        expect(document.graph.inputs[0]).toMatchObject({ name: 'input', type: 'tensor<FLOAT[batch, 3]>' });
        expect(document.graph.initializers[0]).toMatchObject({
            name: 'weight', dataType: 'FLOAT', shape: ['3', '4'], elementCount: '12', dataBytes: '48', location: 'embedded'
        });
        expect(document.graph.initializers[0]?.metadata).toEqual([{ key: 'tensor.role', value: 'weight' }]);
        expect(document.graph.inputs[0]?.metadata).toEqual([{ key: 'semantic', value: 'feature' }]);
        expect(document.graph.initializers[1]).toMatchObject({ name: 'labels', dataType: 'STRING', dataBytes: '8', storage: 'dense' });
        expect(document.graph.initializers[2]).toMatchObject({
            name: 'sparse_weight', dataType: 'FLOAT', shape: ['3', '4'], elementCount: '12', dataBytes: '24', storage: 'sparse',
            sparse: { nonZeroCount: '2', indicesType: 'INT64', indicesShape: ['2'], indicesDataBytes: '16' }
        });
        expect(document.functions[0]).toMatchObject({ name: 'Normalize', domain: 'com.test', overload: 'fast', inputs: ['x'], outputs: ['y'] });
        expect(document.functions[0]?.nodes[0]).toMatchObject({ operator: 'Identity' });
        expect(document.functions[0]?.nodes[0]?.attributes[0]).toMatchObject({
            name: 'alpha', reference: 'alpha', description: 'Forwarded from the function', value: '$ref(alpha)'
        });
        expect(document.functions[0]?.values[0]).toMatchObject({ name: 'y', type: 'tensor<FLOAT[batch, 4]>' });
        expect(document.warnings).toEqual([]);
    });

    it('retains external tensor locations and reports that payloads are not loaded', () => {
        const document = parseOnnx(onnxFixture(true));
        expect(document.graph.initializers[0]?.location).toBe('external');
        expect(document.graph.initializers[0]?.externalData).toContainEqual({ key: 'location', value: 'weight.bin' });
        expect(document.warnings).toContainEqual({ key: 'onnx.warning.externalData', args: { count: 1 } });
    });

    it('rejects empty, truncated, and non-ONNX protobuf data', () => {
        expect(() => parseOnnx(new Uint8Array())).toThrow(OnnxParseError);
        expect(() => parseOnnx(new Uint8Array([0x0a, 0x05, 0x01]))).toThrow(/Truncated/);
        expect(() => parseOnnx(new Uint8Array([0x12, 0x01, 0x78]))).toThrow(/IR version/);
        expect(() => parseOnnx(new Uint8Array([0x08, 0x8a, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02, 0x3a, 0x00]))).toThrow(/uint64/);
        expect(() => parseOnnx(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x10, 0x00]))).toThrow(/field tag/);
    });

    it('preserves structured control-flow subgraphs', () => {
        const document = parseOnnx(onnxControlFlowFixture());
        const attributes = document.graph.nodes[0]?.attributes ?? [];
        expect(attributes.find(item => item.name === 'then_branch')?.graphs?.[0]).toMatchObject({
            name: 'then-branch', nodes: [{ name: 'then-node', operator: 'Identity' }]
        });
        expect(attributes.find(item => item.name === 'else_branch')?.graphs?.[0]).toMatchObject({
            name: 'else-branch', nodes: [{ name: 'else-node', operator: 'Add' }]
        });
    });

    it('rejects unsafe tensor ranks, products, and negative dimensions', () => {
        expect(() => parseOnnx(onnxTensorDimsFixture([-1]))).toThrow(/negative/);
        expect(() => parseOnnx(onnxTensorDimsFixture(Array.from({ length: 70 }, () => 0x7fffffffffffffffn)))).toThrow(/element count/);
        expect(() => parseOnnx(onnxTensorDimsFixture(Array.from({ length: 1025 }, () => 1)))).toThrow(/item limit|rank/);
    });

    it('bounds normalized-object amplification from repeated empty messages', () => {
        expect(() => parseOnnx(onnxEmptyNodesFixture(25_001))).toThrow(/normalized-object limit/);
        expect(() => parseOnnx(onnxTypeDimensionsFixture(25_001))).toThrow(/normalized-object limit/);
    });

    it('rejects overlong identity strings and excessive cumulative text without truncation collisions', () => {
        expect(() => parseOnnx(onnxTextBudgetFixture(65_537, 1))).toThrow(/per-field limit/);
        expect(() => parseOnnx(onnxTextBudgetFixture(65_536, 65))).toThrow(/cumulative text limit/);
    });

    it('decodes signed int32 device fields with the protobuf width', () => {
        const document = parseOnnx(onnxSignedDeviceFixture());
        expect(document.configurations[0]?.numDevices).toBe(-1);
        expect(document.graph.nodes[0]?.deviceConfigurations[0]?.pipelineStage).toBe(-1);
    });

    it('preserves tensor segments and type and dimension denotations', () => {
        const document = parseOnnx(onnxSemanticMetadataFixture());
        expect(document.graph.initializers[0]?.segment).toEqual({ begin: '2', end: '5' });
        expect(document.graph.inputs[0]?.typeInfo).toMatchObject({
            display: 'tensor<FLOAT[3]>', denotation: 'IMAGE',
            dimensions: [{ value: '3', denotation: 'DATA_CHANNEL' }]
        });
    });

    it('marks attribute previews truncated only when a 65th item exists', () => {
        expect(parseOnnx(onnxAttributeListFixture(63)).graph.nodes[0]?.attributes[0]?.value).not.toContain('…');
        expect(parseOnnx(onnxAttributeListFixture(64)).graph.nodes[0]?.attributes[0]?.value).not.toContain('…');
        expect(parseOnnx(onnxAttributeListFixture(65)).graph.nodes[0]?.attributes[0]?.value).toContain('…');
    });

    it('retains structured attributes past the preview boundary and reports safe-bound omissions', () => {
        const retained = parseOnnx(onnxStructuredAttributeFixture(65));
        expect(retained.graph.nodes[0]?.attributes[0]?.graphs).toHaveLength(65);
        expect(retained.graph.nodes[0]?.attributes[0]?.omitted).toBeUndefined();

        const bounded = parseOnnx(onnxStructuredAttributeFixture(1025, 1024));
        expect(bounded.graph.nodes[0]?.attributes[0]?.graphs).toHaveLength(1024);
        expect(bounded.graph.nodes[0]?.attributes[0]?.omitted).toEqual({ graphs: 1, tensors: 0, sparseTensors: 0, typeProtos: 0 });
        expect(bounded.warnings).toContainEqual({ key: 'onnx.warning.externalData', args: { count: 1 } });
    });

    it('retains repeated type protos past previews and reports the safe-bound omission count', () => {
        const retained = parseOnnx(onnxTypeProtoAttributeFixture(65)).graph.nodes[0]?.attributes[0];
        expect(retained?.typeProtos).toHaveLength(65);
        expect(retained?.omitted).toBeUndefined();

        const bounded = parseOnnx(onnxTypeProtoAttributeFixture(1025)).graph.nodes[0]?.attributes[0];
        expect(bounded?.typeProtos).toHaveLength(1024);
        expect(bounded?.omitted).toEqual({ graphs: 0, tensors: 0, sparseTensors: 0, typeProtos: 1 });
    });

    it('preserves both constituent tensor records of sparse tensors', () => {
        const sparse = parseOnnx(onnxSparseMetadataFixture()).graph.initializers[0]?.sparse;
        expect(sparse?.values).toMatchObject({ name: 'values', segment: { begin: '1', end: '3' }, description: 'sparse values', metadata: [{ key: 'role', value: 'values' }] });
        expect(sparse?.indices).toMatchObject({ name: 'indices', segment: { begin: '4', end: '6' }, description: 'sparse indices', metadata: [{ key: 'role', value: 'indices' }] });
    });

    it('preserves training, quantization, and multi-device configuration fields from current IR models', () => {
        const document = parseOnnx(onnxModernFieldsFixture());
        expect(document.irVersion).toBe('13');
        expect(document.trainingInfo[0]?.algorithm).toMatchObject({ name: 'training-step', nodes: [{ operator: 'ReduceMean' }] });
        expect(document.trainingInfo[0]?.updateBindings).toEqual([{ key: 'weight', value: 'updated_weight' }]);
        expect(document.configurations).toEqual([{ name: 'two-gpu', numDevices: 2, devices: ['cuda:0', 'cuda:1'] }]);
        expect(document.graph.quantization).toEqual([{ tensorName: 'x', parameters: [{ key: 'SCALE_TENSOR', value: 'x_scale' }] }]);
        expect(document.graph.nodes[0]?.deviceConfigurations[0]).toMatchObject({
            configurationId: 'two-gpu', pipelineStage: 1,
            sharding: [{ tensorName: 'x', devices: ['0', '1'], deviceGroups: [{ index: '0', devices: ['0', '1'] }, { index: '1', devices: ['2', '3'] }], axes: ['0:4/2'] }]
        });
    });

    it('retains structured external attribute tensors and includes them in warnings', () => {
        const document = parseOnnx(onnxExternalAttributeFixture());
        expect(document.graph.nodes[0]?.attributes[0]?.tensors?.[0]).toMatchObject({
            name: 'constant', location: 'external', dataBytes: '4', metadata: [{ key: 'tensor.scope', value: 'attribute' }]
        });
        expect(document.warnings).toContainEqual({ key: 'onnx.warning.externalData', args: { count: 1 } });
    });

    it('validates malformed data after the packed attribute preview boundary', () => {
        expect(() => parseOnnx(onnxMalformedPackedAttribute('float'))).toThrow(/invalid length|Truncated/);
        expect(() => parseOnnx(onnxMalformedPackedAttribute('int'))).toThrow(/varint|end/i);
    });

    it('counts external tensors used by function default attributes', () => {
        const document = parseOnnx(onnxFunctionDefaultExternalFixture());
        expect(document.functions[0]?.attributeDefaults[0]?.tensors?.[0]).toMatchObject({ location: 'external' });
        expect(document.warnings).toContainEqual({ key: 'onnx.warning.externalData', args: { count: 1 } });
    });
});
