const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const concat = (...parts: Uint8Array[]): Uint8Array => {
    const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
    return result;
};
const varint = (input: number | bigint): Uint8Array => {
    let value = BigInt.asUintN(64, BigInt(input));
    const bytes: number[] = [];
    do { const byte = Number(value & 0x7fn); value >>= 7n; bytes.push(byte | (value ? 0x80 : 0)); } while (value);
    return new Uint8Array(bytes);
};
const v = (field: number, value: number | bigint): Uint8Array => concat(varint(field << 3), varint(value));
const b = (field: number, value: Uint8Array | string): Uint8Array => {
    const bytes = typeof value === 'string' ? text(value) : value;
    return concat(varint((field << 3) | 2), varint(bytes.byteLength), bytes);
};
const message = (field: number, ...fields: Uint8Array[]): Uint8Array => b(field, concat(...fields));
const valueInfo = (name: string, dims: Array<string | number>): Uint8Array => {
    const dimensions = dims.map(dim => message(1, typeof dim === 'number' ? v(1, dim) : b(2, dim)));
    const shape = message(2, ...dimensions);
    const tensorType = message(1, v(1, 1), shape);
    return concat(b(1, name), message(2, tensorType), message(4, b(1, 'semantic'), b(2, 'feature')));
};

export function onnxFixture(external = false): Uint8Array {
    const tensor = concat(
        b(1, concat(varint(3), varint(4))), v(2, 1), b(8, 'weight'),
        ...(external
            ? [message(13, b(1, 'location'), b(2, 'weight.bin')), message(13, b(1, 'length'), b(2, '48')), v(14, 1)]
            : [b(9, new Uint8Array(48))]), message(16, b(1, 'tensor.role'), b(2, 'weight'))
    );
    const stringTensor = concat(b(1, varint(2)), v(2, 8), b(6, 'cat'), b(6, 'horse'), b(8, 'labels'));
    const sparseValues = concat(b(1, varint(2)), v(2, 1), b(8, 'sparse_weight'), b(9, new Uint8Array(8)));
    const sparseIndices = concat(b(1, varint(2)), v(2, 7), b(9, new Uint8Array(16)));
    const sparseTensor = concat(message(1, sparseValues), message(2, sparseIndices), b(3, concat(varint(3), varint(4))));
    const attribute = concat(b(1, 'transB'), v(3, 1), v(20, 2));
    const typeAttribute = concat(b(1, 'cast_type'), message(14, message(1, v(1, 1))), v(20, 13));
    const sparseAttribute = concat(b(1, 'mask'), message(22, sparseTensor), v(20, 11));
    const matmul = concat(b(1, 'input'), b(1, 'weight'), b(2, 'hidden'), b(3, 'dense'), b(4, 'MatMul'), message(5, attribute), message(5, typeAttribute), message(5, sparseAttribute), message(9, b(1, 'node.kind'), b(2, 'dense')));
    const relu = concat(b(1, 'hidden'), b(2, 'output'), b(3, 'activation'), b(4, 'Relu'));
    const localCall = concat(b(1, 'output'), b(2, 'final'), b(3, 'normalize'), b(4, 'Normalize'), b(7, 'com.test'), b(8, 'fast'));
    const graph = concat(
        message(1, matmul), message(1, relu), message(1, localCall), b(2, 'classifier'), message(5, tensor), message(5, stringTensor), message(15, sparseTensor),
        message(11, valueInfo('input', ['batch', 3])), message(12, valueInfo('final', ['batch', 4])),
        message(13, valueInfo('hidden', ['batch', 4])), b(10, 'A small test graph')
    );
    const referenceAttribute = concat(b(1, 'alpha'), b(13, 'Forwarded from the function'), v(20, 1), b(21, 'alpha'));
    const functionNode = concat(b(1, 'x'), b(2, 'y'), b(4, 'Identity'), message(5, referenceAttribute));
    const localFunction = concat(
        b(1, 'Normalize'), b(4, 'x'), b(5, 'y'), b(6, 'alpha'), message(7, functionNode),
        message(9, b(1, ''), v(2, 18)), b(10, 'com.test'),
        message(12, valueInfo('y', ['batch', 4])), b(13, 'fast'), message(14, b(1, 'function.kind'), b(2, 'normalization'))
    );
    return concat(
        v(1, 10), b(2, 'unit-test'), b(3, '1.0'), v(5, 7), b(6, 'Fixture model'),
        message(7, graph), message(8, b(1, ''), v(2, 18)), message(14, b(1, 'license'), b(2, 'MIT')), message(25, localFunction),
        b(99, 'future-compatible-field')
    );
}

export function onnxControlFlowFixture(): Uint8Array {
    const thenNode = concat(b(1, 'x'), b(2, 'then-y'), b(3, 'then-node'), b(4, 'Identity'));
    const elseNode = concat(b(1, 'x'), b(1, 'x'), b(2, 'else-y'), b(3, 'else-node'), b(4, 'Add'));
    const thenGraph = concat(message(1, thenNode), b(2, 'then-branch'));
    const elseGraph = concat(message(1, elseNode), b(2, 'else-branch'));
    const thenAttribute = concat(b(1, 'then_branch'), message(6, thenGraph), v(20, 5));
    const elseAttribute = concat(b(1, 'else_branch'), message(6, elseGraph), v(20, 5));
    const ifNode = concat(b(1, 'cond'), b(2, 'y'), b(3, 'condition'), b(4, 'If'), message(5, thenAttribute), message(5, elseAttribute));
    const graph = concat(message(1, ifNode), b(2, 'control-flow'));
    return concat(v(1, 10), message(7, graph), message(8, b(1, ''), v(2, 18)));
}

export function onnxAttributeListFixture(count: number): Uint8Array {
    const values = Array.from({ length: count }, (_, index) => v(8, index));
    const attribute = concat(b(1, 'axes'), ...values, v(20, 7));
    const node = concat(b(2, 'y'), b(4, 'Constant'), message(5, attribute));
    return concat(v(1, 10), message(7, message(1, node), b(2, 'attributes')), message(8, b(1, ''), v(2, 18)));
}

export function onnxStructuredAttributeFixture(count: number, externalAt = -1): Uint8Array {
    const graphs = Array.from({ length: count }, (_, index) => {
        const initializer = index === externalAt
            ? message(5,
                b(1, varint(1)), v(2, 1), b(8, `weight-${index}`),
                message(13, b(1, 'location'), b(2, `weight-${index}.bin`)),
                message(13, b(1, 'length'), b(2, '4')), v(14, 1))
            : new Uint8Array();
        return message(11, b(2, `branch-${index}`), initializer);
    });
    const attribute = concat(b(1, 'branches'), ...graphs, v(20, 10));
    const node = concat(b(2, 'y'), b(4, 'Switch'), message(5, attribute));
    return concat(v(1, 10), message(7, b(2, 'structured-attributes'), message(1, node)), message(8, b(1, ''), v(2, 18)));
}

export function onnxTypeProtoAttributeFixture(count: number): Uint8Array {
    const types = Array.from({ length: count }, (_, index) => message(15, message(1, v(1, index % 2 ? 7 : 1))));
    const attribute = concat(b(1, 'types'), ...types, v(20, 14));
    const node = concat(b(2, 'y'), b(4, 'TypeSwitch'), message(5, attribute));
    return concat(v(1, 10), message(7, b(2, 'type-protos'), message(1, node)), message(8, b(1, ''), v(2, 18)));
}

export function onnxSparseMetadataFixture(): Uint8Array {
    const values = concat(
        b(1, varint(2)), v(2, 1), message(3, v(1, 1), v(2, 3)), b(8, 'values'), b(12, 'sparse values'),
        message(16, b(1, 'role'), b(2, 'values'))
    );
    const indices = concat(
        b(1, varint(2)), v(2, 7), message(3, v(1, 4), v(2, 6)), b(8, 'indices'), b(12, 'sparse indices'),
        message(16, b(1, 'role'), b(2, 'indices'))
    );
    const sparse = concat(message(1, values), message(2, indices), b(3, concat(varint(3), varint(4))));
    return concat(v(1, 10), message(7, b(2, 'sparse-metadata'), message(15, sparse)), message(8, b(1, ''), v(2, 18)));
}

export function onnxTensorDimsFixture(dims: Array<number | bigint>): Uint8Array {
    const tensor = concat(b(1, concat(...dims.map(varint))), v(2, 1), b(8, 'shape'));
    return concat(v(1, 10), message(7, b(2, 'dimensions'), message(5, tensor)), message(8, b(1, ''), v(2, 18)));
}

export function onnxEmptyNodesFixture(count: number): Uint8Array {
    const nodes = Array.from({ length: count }, () => message(1));
    return concat(v(1, 10), message(7, b(2, 'many-empty-nodes'), ...nodes), message(8, b(1, ''), v(2, 18)));
}

export function onnxSemanticMetadataFixture(): Uint8Array {
    const dimension = concat(v(1, 3), b(3, 'DATA_CHANNEL'));
    const shape = message(2, message(1, dimension));
    const tensorType = message(1, v(1, 1), shape);
    const type = concat(tensorType, b(6, 'IMAGE'));
    const input = concat(b(1, 'pixels'), message(2, type));
    const tensor = concat(b(1, varint(10)), v(2, 1), message(3, v(1, 2), v(2, 5)), b(8, 'slice'));
    const graph = concat(b(2, 'semantic-metadata'), message(5, tensor), message(11, input));
    return concat(v(1, 10), message(7, graph), message(8, b(1, ''), v(2, 18)));
}

export function onnxTypeDimensionsFixture(count: number): Uint8Array {
    const dimensions = Array.from({ length: count }, () => message(1));
    const tensorType = message(1, v(1, 1), message(2, ...dimensions));
    const input = concat(b(1, 'wide-shape'), message(2, tensorType));
    return concat(v(1, 10), message(7, b(2, 'wide-shape'), message(11, input)), message(8, b(1, ''), v(2, 18)));
}

export function onnxTextBudgetFixture(length: number, count: number): Uint8Array {
    const value = 'x'.repeat(length);
    const nodes = Array.from({ length: count }, () => message(1, b(3, value), b(4, 'Identity')));
    return concat(v(1, 10), message(7, b(2, 'text-budget'), ...nodes), message(8, b(1, ''), v(2, 18)));
}

export function onnxSignedDeviceFixture(): Uint8Array {
    const nodeDevice = concat(b(1, 'signed-device'), v(3, -1));
    const node = concat(b(4, 'Identity'), message(10, nodeDevice));
    const configuration = concat(b(1, 'signed-device'), v(2, -1));
    return concat(v(1, 13), message(7, b(2, 'signed-int32'), message(1, node)), message(8, b(1, ''), v(2, 24)), message(26, configuration));
}

export function onnxModernFieldsFixture(): Uint8Array {
    const simple = concat(v(1, 4), v(3, 2));
    const shardedAxis = concat(v(1, 0), message(2, simple));
    const group0 = concat(v(1, 0), b(2, concat(varint(0), varint(1))));
    const group1 = concat(v(1, 1), b(2, concat(varint(2), varint(3))));
    const sharding = concat(b(1, 'x'), b(2, concat(varint(0), varint(1))), message(3, group0), message(3, group1), message(4, shardedAxis));
    const nodeDevice = concat(b(1, 'two-gpu'), message(2, sharding), v(3, 1));
    const node = concat(b(1, 'x'), b(2, 'y'), b(4, 'Identity'), message(10, nodeDevice));
    const quantization = concat(b(1, 'x'), message(2, b(1, 'SCALE_TENSOR'), b(2, 'x_scale')));
    const graph = concat(message(1, node), b(2, 'modern'), message(14, quantization));
    const trainingGraph = concat(b(2, 'training-step'), message(1, concat(b(1, 'y'), b(2, 'loss'), b(4, 'ReduceMean'))));
    const training = concat(message(2, trainingGraph), message(4, b(1, 'weight'), b(2, 'updated_weight')));
    const configuration = concat(b(1, 'two-gpu'), v(2, 2), b(3, 'cuda:0'), b(3, 'cuda:1'));
    return concat(v(1, 13), message(7, graph), message(8, b(1, ''), v(2, 24)), message(20, training), message(26, configuration));
}

export function onnxExternalAttributeFixture(): Uint8Array {
    const tensor = concat(
        b(1, varint(1)), v(2, 1), b(8, 'constant'),
        message(13, b(1, 'location'), b(2, 'constant.bin')), message(13, b(1, 'length'), b(2, '4')),
        v(14, 1), message(16, b(1, 'tensor.scope'), b(2, 'attribute'))
    );
    const attribute = concat(b(1, 'value'), message(5, tensor), v(20, 4));
    const node = concat(b(2, 'y'), b(4, 'Constant'), message(5, attribute));
    return concat(v(1, 10), message(7, b(2, 'external-attribute'), message(1, node)), message(8, b(1, ''), v(2, 18)));
}

export function onnxMalformedPackedAttribute(kind: 'float' | 'int'): Uint8Array {
    const payload = kind === 'float'
        ? concat(new Uint8Array(65 * 4), new Uint8Array([0xff]))
        : concat(new Uint8Array(65), new Uint8Array([0x80]));
    const attribute = concat(b(1, 'values'), b(kind === 'float' ? 7 : 8, payload), v(20, kind === 'float' ? 6 : 7));
    const node = concat(b(2, 'y'), b(4, 'Constant'), message(5, attribute));
    return concat(v(1, 10), message(7, b(2, 'malformed-packed'), message(1, node)), message(8, b(1, ''), v(2, 18)));
}

export function onnxFunctionDefaultExternalFixture(): Uint8Array {
    const tensor = concat(
        b(1, varint(1)), v(2, 1), message(13, b(1, 'location'), b(2, 'default.bin')),
        message(13, b(1, 'length'), b(2, '4')), v(14, 1)
    );
    const attribute = concat(b(1, 'default_value'), message(5, tensor), v(20, 4));
    const fn = concat(b(1, 'WithDefault'), b(4, 'x'), b(5, 'y'), message(11, attribute), b(10, 'com.test'));
    return concat(v(1, 10), message(7, b(2, 'function-default')), message(8, b(1, ''), v(2, 18)), message(25, fn));
}
