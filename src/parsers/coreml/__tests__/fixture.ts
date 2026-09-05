/**
 * A minimal protobuf writer plus a stored-only ZIP writer, and the Core ML
 * models the parser and viewer tests read. Field numbers mirror the normative
 * `Model.proto`, `FeatureTypes.proto`, `MIL.proto`, and `NeuralNetwork.proto`
 * schemas, so a fixture that stops matching the parser means one of the two
 * drifted from the published spec.
 */

const encoder = new TextEncoder();

export class ProtoBuilder {
    private readonly parts: Uint8Array[] = [];

    /** Length-delimited (wire 2): a nested message, a string, or raw bytes. */
    message(field: number, value: ProtoBuilder | Uint8Array): this {
        const bytes = value instanceof ProtoBuilder ? value.build() : value;
        this.tag(field, 2);
        this.varintBytes(BigInt(bytes.byteLength));
        this.parts.push(bytes);
        return this;
    }

    string(field: number, value: string): this {
        return this.message(field, encoder.encode(value));
    }

    varint(field: number, value: number | bigint): this {
        this.tag(field, 0);
        // Two's complement over 64 bits, so a negative int64 round-trips.
        const raw = BigInt(value);
        this.varintBytes(raw < 0n ? raw + (1n << 64n) : raw);
        return this;
    }

    bool(field: number, value: boolean): this {
        return this.varint(field, value ? 1 : 0);
    }

    float(field: number, value: number): this {
        this.tag(field, 5);
        const buffer = new Uint8Array(4);
        new DataView(buffer.buffer).setFloat32(0, value, true);
        this.parts.push(buffer);
        return this;
    }

    double(field: number, value: number): this {
        this.tag(field, 1);
        const buffer = new Uint8Array(8);
        new DataView(buffer.buffer).setFloat64(0, value, true);
        this.parts.push(buffer);
        return this;
    }

    /** Packed repeated varint (wire 2), the encoding protoc emits by default. */
    packedVarint(field: number, values: Array<number | bigint>): this {
        const inner = new ProtoBuilder();
        for (const value of values) {
            const raw = BigInt(value);
            inner.varintBytes(raw < 0n ? raw + (1n << 64n) : raw);
        }
        return this.message(field, inner.build());
    }

    packedFloat(field: number, values: number[]): this {
        const buffer = new Uint8Array(values.length * 4);
        const view = new DataView(buffer.buffer);
        values.forEach((value, index) => view.setFloat32(index * 4, value, true));
        return this.message(field, buffer);
    }

    /** A `map<string, M>` entry: key at field 1, value at field 2. */
    mapEntry(field: number, key: string, value: ProtoBuilder | Uint8Array): this {
        return this.message(field, new ProtoBuilder().string(1, key).message(2, value));
    }

    build(): Uint8Array {
        const total = this.parts.reduce((sum, part) => sum + part.byteLength, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const part of this.parts) { out.set(part, offset); offset += part.byteLength; }
        return out;
    }

    private tag(field: number, wire: number): void {
        this.varintBytes((BigInt(field) << 3n) | BigInt(wire));
    }

    private varintBytes(value: bigint): void {
        const bytes: number[] = [];
        let remaining = value;
        do {
            const byte = Number(remaining & 0x7fn);
            remaining >>= 7n;
            bytes.push(remaining > 0n ? byte | 0x80 : byte);
        } while (remaining > 0n);
        this.parts.push(Uint8Array.from(bytes));
    }
}

// ── Feature descriptions ───────────────────────────────────────────────────

/** `FeatureDescription` holding an `ImageFeatureType`. */
function imageFeature(name: string, width: number, height: number, colorSpace = 20): ProtoBuilder {
    const image = new ProtoBuilder().varint(1, width).varint(2, height).varint(3, colorSpace);
    return new ProtoBuilder()
        .string(1, name)
        .string(2, `${name} image`)
        .message(3, new ProtoBuilder().message(4, image));
}

/** `FeatureDescription` holding an `ArrayFeatureType` (FLOAT32 by default). */
function arrayFeature(name: string, shape: number[], dataType = 65568, optional = false): ProtoBuilder {
    const array = new ProtoBuilder().packedVarint(1, shape).varint(2, dataType);
    const type = new ProtoBuilder().message(5, array);
    if (optional) type.bool(1000, true);
    return new ProtoBuilder().string(1, name).message(3, type);
}

/** `FeatureDescription` holding a `DictionaryFeatureType` with string keys. */
function dictionaryFeature(name: string): ProtoBuilder {
    const dictionary = new ProtoBuilder().message(2, new ProtoBuilder());
    return new ProtoBuilder().string(1, name).message(3, new ProtoBuilder().message(6, dictionary));
}

function stringFeature(name: string): ProtoBuilder {
    return new ProtoBuilder().string(1, name).message(3, new ProtoBuilder().message(3, new ProtoBuilder()));
}

/** `Metadata` with the four documented strings plus two user-defined pairs. */
function metadata(): ProtoBuilder {
    // `userDefined` is a map<string, string>, so each entry's value is a plain
    // string at field 2 rather than a nested message.
    const pair = (key: string, value: string): ProtoBuilder =>
        new ProtoBuilder().string(1, key).string(2, value);
    return new ProtoBuilder()
        .string(1, 'Classifies an image into one of two classes.')
        .string(2, '2.1')
        .string(3, 'Omni Viewer')
        .string(4, 'MIT')
        .message(100, pair('com.omni.trained_on', 'fixtures'))
        .message(100, pair('com.omni.source', 'unit-test'));
}

// ── MIL values and types ───────────────────────────────────────────────────

/** `ValueType` wrapping a `TensorType` with constant dimensions. */
function tensorType(dataType: number, dimensions: Array<number | '?'>): ProtoBuilder {
    const tensor = new ProtoBuilder().varint(1, dataType).varint(2, dimensions.length);
    for (const dimension of dimensions) {
        const dim = dimension === '?'
            ? new ProtoBuilder().message(2, new ProtoBuilder().bool(1, false))
            : new ProtoBuilder().message(1, new ProtoBuilder().varint(1, dimension));
        tensor.message(3, dim);
    }
    return new ProtoBuilder().message(1, tensor);
}

function namedValueType(name: string, type: ProtoBuilder): ProtoBuilder {
    return new ProtoBuilder().string(1, name).message(2, type);
}

/** `Value` holding an immediate int32 tensor. */
function immediateInts(values: number[], type = tensorType(23, [values.length])): ProtoBuilder {
    const tensor = new ProtoBuilder().message(2, new ProtoBuilder().packedVarint(1, values));
    return new ProtoBuilder().message(2, type).message(3, new ProtoBuilder().message(1, tensor));
}

/** `Value` holding an immediate string tensor (a scalar attribute). */
function immediateString(value: string): ProtoBuilder {
    const tensor = new ProtoBuilder().message(4, new ProtoBuilder().string(1, value));
    return new ProtoBuilder()
        .message(2, tensorType(2, []))
        .message(3, new ProtoBuilder().message(1, tensor));
}

/** `Value` reading its payload from a weight blob rather than the spec. */
function blobValue(dataType: number, dimensions: number[], file: string, offset: number): ProtoBuilder {
    return new ProtoBuilder()
        .message(2, tensorType(dataType, dimensions))
        .message(5, new ProtoBuilder().string(1, file).varint(2, offset));
}

/** One `Operation.inputs` entry binding a parameter to variable names. */
function boundInput(parameter: string, ...names: string[]): ProtoBuilder {
    const argument = new ProtoBuilder();
    for (const name of names) argument.message(1, new ProtoBuilder().string(1, name));
    return new ProtoBuilder().string(1, parameter).message(2, argument);
}

/** One `Operation.inputs` entry binding a parameter to an inline value. */
function valueInput(parameter: string, value: ProtoBuilder): ProtoBuilder {
    const argument = new ProtoBuilder().message(1, new ProtoBuilder().message(2, value));
    return new ProtoBuilder().string(1, parameter).message(2, argument);
}

interface OperationSpec {
    type: string;
    inputs?: ProtoBuilder[];
    outputs?: ProtoBuilder[];
    blocks?: ProtoBuilder[];
    /** `Operation.attributes` entries, as `[key, Value]` pairs. */
    attributes?: Array<[string, ProtoBuilder]>;
}

function operation(spec: OperationSpec): ProtoBuilder {
    const op = new ProtoBuilder().string(1, spec.type);
    for (const input of spec.inputs ?? []) op.message(2, input);
    for (const output of spec.outputs ?? []) op.message(3, output);
    for (const block of spec.blocks ?? []) op.message(4, block);
    for (const [key, value] of spec.attributes ?? []) op.mapEntry(5, key, value);
    return op;
}

/**
 * A `const` operation as coremltools writes one.
 *
 * `translate_const` emits no inputs at all — the payload lives in
 * `attributes["val"]` beside `attributes["name"]` — so this is the encoding
 * every weight in a real ML Program arrives in.
 */
function constOperation(name: string, value: ProtoBuilder, type: ProtoBuilder): ProtoBuilder {
    return operation({
        type: 'const',
        attributes: [['name', immediateString(name)], ['val', value]],
        outputs: [namedValueType(name, type)]
    });
}

function block(inputs: ProtoBuilder[], outputs: string[], operations: ProtoBuilder[]): ProtoBuilder {
    const built = new ProtoBuilder();
    for (const input of inputs) built.message(1, input);
    for (const output of outputs) built.string(2, output);
    for (const op of operations) built.message(3, op);
    return built;
}

const WEIGHT_BLOB = '@model_path/weights/weight.bin';

/**
 * An ML Program classifier: an image input scaled and convolved with a blob
 * weight, then reduced to a class-probability dictionary. Exercises named
 * operands, immediate values, blob references, and a nested block.
 */
export function coremlProgramFixture(): Uint8Array {
    const main = block(
        [namedValueType('image', tensorType(11, [1, 3, 224, 224]))],
        ['probabilities'],
        [
            constOperation('conv_weight', blobValue(10, [32, 3, 3, 3], WEIGHT_BLOB, 64), tensorType(10, [32, 3, 3, 3])),
            constOperation('conv_bias', blobValue(10, [32], WEIGHT_BLOB, 6976), tensorType(10, [32])),
            operation({
                type: 'conv',
                inputs: [
                    boundInput('x', 'image'),
                    boundInput('weight', 'conv_weight'),
                    boundInput('bias', 'conv_bias'),
                    valueInput('strides', immediateInts([2, 2])),
                    valueInput('pad_type', immediateString('same'))
                ],
                outputs: [namedValueType('conv_out', tensorType(11, [1, 32, 112, 112]))]
            }),
            operation({
                type: 'relu',
                inputs: [boundInput('x', 'conv_out')],
                outputs: [namedValueType('relu_out', tensorType(11, [1, 32, 112, 112]))]
            }),
            operation({
                type: 'cond',
                inputs: [boundInput('pred', 'relu_out')],
                outputs: [namedValueType('branch_out', tensorType(11, [1, 2]))],
                blocks: [block(
                    [],
                    ['inner_out'],
                    [operation({
                        type: 'reduce_mean',
                        inputs: [boundInput('x', 'relu_out'), valueInput('axes', immediateInts([2, 3]))],
                        outputs: [namedValueType('inner_out', tensorType(11, [1, 2]))]
                    })]
                )]
            }),
            operation({
                type: 'softmax',
                inputs: [boundInput('x', 'branch_out'), valueInput('axis', immediateInts([1]))],
                outputs: [namedValueType('probabilities', tensorType(11, [1, 2]))]
            })
        ]
    );
    const fn = new ProtoBuilder()
        .message(1, namedValueType('image', tensorType(11, [1, 3, 224, 224])))
        .string(2, 'CoreML7')
        .mapEntry(3, 'CoreML7', main);
    const program = new ProtoBuilder()
        .varint(1, 1)
        .mapEntry(2, 'main', fn)
        .string(3, 'Generated by the Core ML fixture builder.');

    const description = new ProtoBuilder()
        .message(1, imageFeature('image', 224, 224))
        .message(10, arrayFeature('probabilities', [2]))
        .message(10, dictionaryFeature('classLabelProbs'))
        .string(11, 'classLabel')
        .string(12, 'classLabelProbs')
        .message(100, metadata());

    return new ProtoBuilder()
        .varint(1, 8)
        .message(2, description)
        .message(502, program)
        .build();
}

// ── Neural network fixtures ────────────────────────────────────────────────

/** `WeightParams` carrying `floatValue`s, the encoding a float model uses. */
function floatWeights(count: number): ProtoBuilder {
    return new ProtoBuilder().packedFloat(1, new Array<number>(count).fill(0.5));
}

/** `BorderAmounts` holding `count` symmetric `EdgeSizes` entries. */
function borderAmounts(count: number): ProtoBuilder {
    const built = new ProtoBuilder();
    for (let index = 0; index < count; index++) {
        built.message(10, new ProtoBuilder().varint(1, 1).varint(2, 1));
    }
    return built;
}

/** `WeightParams` carrying quantized `rawValue` bytes. */
function quantizedWeights(bytes: number, bits: number): ProtoBuilder {
    return new ProtoBuilder()
        .message(30, new Uint8Array(bytes))
        .message(40, new ProtoBuilder().varint(1, bits).message(101, new ProtoBuilder()))
        .bool(50, true);
}

interface LayerSpec {
    name: string;
    inputs: string[];
    outputs: string[];
    field: number;
    params?: ProtoBuilder;
    updatable?: boolean;
}

function layer(spec: LayerSpec): ProtoBuilder {
    const built = new ProtoBuilder().string(1, spec.name);
    for (const input of spec.inputs) built.string(2, input);
    for (const output of spec.outputs) built.string(3, output);
    if (spec.updatable) built.bool(10, true);
    built.message(spec.field, spec.params ?? new ProtoBuilder());
    return built;
}

/**
 * A neural network classifier with a convolution, a pooling layer, an inner
 * product, an unmapped layer type, and a custom layer — enough to exercise the
 * layer-type table, the schema-driven attributes, and the structural weight
 * scan all at once.
 */
export function coremlNeuralNetworkFixture(): Uint8Array {
    const convolution = new ProtoBuilder()
        .varint(1, 32).varint(2, 3).varint(10, 1)
        .packedVarint(20, [3, 3]).packedVarint(30, [2, 2]).packedVarint(40, [1, 1])
        // A `ValidPadding` carrying two `EdgeSizes` serializes to 12 bytes, so
        // its body would pass the packed-float length check that identifies a
        // weight tensor. It is the schema, not the shape, that settles this.
        .message(50, new ProtoBuilder().message(1, borderAmounts(2)))
        .bool(70, true)
        .message(90, floatWeights(864))
        .message(91, floatWeights(32));
    const pooling = new ProtoBuilder()
        .varint(1, 1)
        .packedVarint(10, [2, 2]).packedVarint(20, [2, 2])
        .message(31, new ProtoBuilder())
        .bool(60, false);
    const innerProduct = new ProtoBuilder()
        .varint(1, 1024).varint(2, 2).bool(10, true)
        .message(20, quantizedWeights(2048, 8))
        .message(21, floatWeights(2));
    const custom = new ProtoBuilder()
        .string(10, 'OmniCustomLayer')
        .string(40, 'A layer the runtime must register.')
        .message(20, floatWeights(4))
        // A `parameters` map entry whose key is four bytes long also matches
        // the shape of a weight tensor; only the layer's weight-field map
        // keeps it from being read as one.
        .mapEntry(30, 'beta', new ProtoBuilder().bool(50, true));

    const network = new ProtoBuilder()
        .message(1, layer({ name: 'conv1', inputs: ['image'], outputs: ['conv1_out'], field: 100, params: convolution }))
        .message(1, layer({ name: 'relu1', inputs: ['conv1_out'], outputs: ['relu1_out'], field: 130, params: new ProtoBuilder().message(10, new ProtoBuilder()) }))
        .message(1, layer({ name: 'pool1', inputs: ['relu1_out'], outputs: ['pool1_out'], field: 120, params: pooling }))
        // `reorganizeData` has no attribute schema, so it must still resolve
        // its type, operands, and any weight the structural scan finds.
        .message(1, layer({ name: 'shuffle', inputs: ['pool1_out'], outputs: ['shuffle_out'], field: 345, params: new ProtoBuilder().varint(1, 2).varint(2, 2) }))
        .message(1, layer({ name: 'fc', inputs: ['shuffle_out'], outputs: ['logits'], field: 140, params: innerProduct, updatable: true }))
        .message(1, layer({ name: 'custom1', inputs: ['logits'], outputs: ['custom_out'], field: 500, params: custom }))
        .message(1, layer({ name: 'prob', inputs: ['custom_out'], outputs: ['probabilities'], field: 175, params: new ProtoBuilder() }))
        .message(2, new ProtoBuilder().string(1, 'image').message(10, new ProtoBuilder().float(10, 0.0078125)))
        .varint(5, 1)
        .varint(6, 1)
        .message(100, new ProtoBuilder().string(1, 'cat').string(1, 'dog'));

    const description = new ProtoBuilder()
        .message(1, imageFeature('image', 227, 227))
        .message(10, dictionaryFeature('classLabelProbs'))
        .message(10, stringFeature('classLabel'))
        .string(11, 'classLabel')
        .string(12, 'classLabelProbs')
        .message(50, arrayFeature('target', [1], 65568, true))
        .message(100, metadata());

    return new ProtoBuilder()
        .varint(1, 4)
        .message(2, description)
        .bool(10, true)
        .message(403, network)
        .build();
}

/**
 * A recurrent network, the case the structural weight scan exists for: an
 * `uniDirectionalLSTM` has no attribute schema and groups its gate weights one
 * level down in an `LSTMWeightParams`, while its `activations` and `params`
 * submessages hold ordinary floats that must not be counted as weights.
 */
export function coremlRecurrentFixture(): Uint8Array {
    const lstmWeights = new ProtoBuilder()
        .message(1, floatWeights(16))   // inputGateWeightMatrix
        .message(20, floatWeights(16))  // inputGateRecursionMatrix
        .message(40, floatWeights(4));  // inputGateBiasVector
    const params = new ProtoBuilder()
        .bool(10, true).bool(20, true)
        .float(60, 50.0); // cellClipThreshold
    const lstm = new ProtoBuilder()
        .varint(1, 8).varint(2, 4)
        // ActivationParams → ActivationLeakyReLU{ alpha }, a lone float two
        // levels below the layer.
        .message(10, new ProtoBuilder().message(15, new ProtoBuilder().float(1, 0.01)))
        .message(15, params)
        .message(20, lstmWeights);
    const network = new ProtoBuilder()
        .message(1, layer({ name: 'lstm', inputs: ['x'], outputs: ['y'], field: 420, params: lstm }));
    const description = new ProtoBuilder()
        .message(1, arrayFeature('x', [8]))
        .message(10, arrayFeature('y', [4]));
    return new ProtoBuilder().varint(1, 4).message(2, description).message(500, network).build();
}

/** A network whose only layer is a `branch`, so both arms become subgraphs. */
export function coremlBranchFixture(): Uint8Array {
    const arm = (name: string, outputName: string): ProtoBuilder => new ProtoBuilder()
        .message(1, layer({ name, inputs: ['x'], outputs: [outputName], field: 130, params: new ProtoBuilder().message(10, new ProtoBuilder()) }));
    const branch = new ProtoBuilder().message(1, arm('if_relu', 'y')).message(2, arm('else_relu', 'y'));
    const network = new ProtoBuilder()
        .message(1, layer({ name: 'gate', inputs: ['cond', 'x'], outputs: ['y'], field: 605, params: branch }));
    const description = new ProtoBuilder()
        .message(1, arrayFeature('x', [4]))
        .message(1, arrayFeature('cond', [1]))
        .message(10, arrayFeature('y', [4]));
    return new ProtoBuilder().varint(1, 4).message(2, description).message(500, network).build();
}

/**
 * Layers whose parameters are a packed repeated scalar at the top level and
 * that have neither an attribute schema nor a weight-field map — the shape that
 * sends the structural weight scan over bytes that are not a message at all.
 * `reduce*` and `tile` are staples of ONNX and TensorFlow conversions.
 */
export function coremlPackedScalarFixture(): Uint8Array {
    const network = new ProtoBuilder()
        // ReduceSumLayerParams { repeated int64 axes = 1; bool keepDims = 2; }
        .message(1, layer({
            name: 'reduce', inputs: ['x'], outputs: ['reduced'], field: 1270,
            params: new ProtoBuilder().packedVarint(1, [1]).bool(2, true)
        }))
        // TileLayerParams { repeated uint64 reps = 1; }
        .message(1, layer({
            name: 'tile', inputs: ['reduced'], outputs: ['tiled'], field: 920,
            params: new ProtoBuilder().packedVarint(1, [1, 2])
        }))
        // BroadcastToStaticLayerParams { repeated uint64 targetShape = 1; }
        .message(1, layer({
            name: 'broadcast', inputs: ['tiled'], outputs: ['y'], field: 1105,
            params: new ProtoBuilder().packedVarint(1, [1, 3, 224, 224])
        }));
    const description = new ProtoBuilder()
        .message(1, arrayFeature('x', [1, 3, 224, 224]))
        .message(10, arrayFeature('y', [1, 3, 224, 224]));
    return new ProtoBuilder().varint(1, 4).message(2, description).message(500, network).build();
}

/**
 * A feature extractor: `features` is both consumed by the head and declared as
 * a model output, so a sink-only rule would drop it from the graph.
 */
export function coremlDualOutputFixture(): Uint8Array {
    const relu = (): ProtoBuilder => new ProtoBuilder().message(10, new ProtoBuilder());
    const network = new ProtoBuilder()
        .message(1, layer({ name: 'backbone', inputs: ['image'], outputs: ['features'], field: 130, params: relu() }))
        .message(1, layer({ name: 'head', inputs: ['features'], outputs: ['logits'], field: 130, params: relu() }));
    const description = new ProtoBuilder()
        .message(1, arrayFeature('image', [1, 3, 224, 224]))
        .message(10, arrayFeature('features', [1, 512]))
        .message(10, arrayFeature('logits', [1, 1000]));
    return new ProtoBuilder().varint(1, 4).message(2, description).message(500, network).build();
}

/** An ML Program whose `cond` block declares no inputs of its own. */
export function coremlScopedBlockFixture(): Uint8Array {
    const inner = block([], ['inner_out'], [operation({
        type: 'relu',
        inputs: [boundInput('x', 'image')],
        outputs: [namedValueType('inner_out', tensorType(11, [1, 4]))]
    })]);
    const main = block(
        [namedValueType('image', tensorType(11, [1, 4]))],
        ['gated'],
        [operation({
            type: 'cond',
            inputs: [boundInput('pred', 'image')],
            outputs: [namedValueType('gated', tensorType(11, [1, 4]))],
            blocks: [inner]
        })]
    );
    const fn = new ProtoBuilder()
        .message(1, namedValueType('image', tensorType(11, [1, 4])))
        .string(2, 'CoreML7')
        .mapEntry(3, 'CoreML7', main);
    const description = new ProtoBuilder()
        .message(1, arrayFeature('image', [1, 4]))
        .message(10, arrayFeature('gated', [1, 4]));
    return new ProtoBuilder()
        .varint(1, 8)
        .message(2, description)
        .message(502, new ProtoBuilder().varint(1, 1).mapEntry(2, 'main', fn))
        .build();
}

/**
 * An ML Program with a block inside a block, the inner one declaring nothing
 * and the middle one shadowing the function's `image` with its own argument.
 */
export function coremlDeepBlockFixture(): Uint8Array {
    const innermost = block([], ['deep_out'], [operation({
        type: 'relu',
        inputs: [boundInput('x', 'image')],
        outputs: [namedValueType('deep_out', tensorType(11, [1, 4]))]
    })]);
    const middle = block(
        // Shadows the function's `image` — the scope must hold one entry, not two.
        [namedValueType('image', tensorType(11, [1, 4]))],
        ['mid_out'],
        [operation({
            type: 'cond',
            inputs: [boundInput('pred', 'image')],
            outputs: [namedValueType('mid_out', tensorType(11, [1, 4]))],
            blocks: [innermost]
        })]
    );
    const main = block(
        [namedValueType('image', tensorType(11, [1, 4]))],
        ['gated'],
        [operation({
            type: 'while_loop',
            inputs: [boundInput('pred', 'image')],
            outputs: [namedValueType('gated', tensorType(11, [1, 4]))],
            blocks: [middle]
        })]
    );
    const fn = new ProtoBuilder()
        .message(1, namedValueType('image', tensorType(11, [1, 4])))
        .string(2, 'CoreML7')
        .mapEntry(3, 'CoreML7', main);
    const description = new ProtoBuilder()
        .message(1, arrayFeature('image', [1, 4]))
        .message(10, arrayFeature('gated', [1, 4]));
    return new ProtoBuilder()
        .varint(1, 8)
        .message(2, description)
        .message(502, new ProtoBuilder().varint(1, 1).mapEntry(2, 'main', fn))
        .build();
}

/**
 * A network with the two activation arms that carry weight tensors. Both are
 * schema-described *and* hold `WeightParams`, so a schema-first rule that never
 * looks inside would report the layers with no parameters at all.
 */
export function coremlParametricActivationFixture(): Uint8Array {
    const prelu = new ProtoBuilder().message(25, new ProtoBuilder().message(1, floatWeights(4)));
    const softplus = new ProtoBuilder().message(71, new ProtoBuilder()
        .message(1, floatWeights(4))
        .message(2, floatWeights(4)));
    const network = new ProtoBuilder()
        .message(1, layer({ name: 'prelu', inputs: ['x'], outputs: ['a'], field: 130, params: prelu }))
        .message(1, layer({ name: 'softplus', inputs: ['a'], outputs: ['y'], field: 130, params: softplus }));
    const description = new ProtoBuilder()
        .message(1, arrayFeature('x', [4]))
        .message(10, arrayFeature('y', [4]));
    return new ProtoBuilder().varint(1, 4).message(2, description).message(500, network).build();
}

/**
 * A program holding one immediate bool tensor of `count` elements.
 *
 * `should_use_weight_file` moves a constant to the weight blob only for a
 * short list of dtypes; bool is never on it at any specification version, so a
 * `[1, 1, 512, 512]` causal-attention mask is written inline exactly like this.
 */
export function coremlLargeImmediateFixture(count: number): Uint8Array {
    const bools = new ProtoBuilder().message(3, new ProtoBuilder()
        .packedVarint(1, new Array<number>(count).fill(1)));
    const value = new ProtoBuilder().message(3, new ProtoBuilder().message(1, bools));
    const main = block([], ['mask'], [operation({
        type: 'const',
        attributes: [['name', immediateString('mask')], ['val', value]],
        outputs: [namedValueType('mask', tensorType(1, [1, 1, 512, 512]))]
    })]);
    const fn = new ProtoBuilder().string(2, 'CoreML6').mapEntry(3, 'CoreML6', main);
    return new ProtoBuilder()
        .varint(1, 7)
        .message(2, new ProtoBuilder().message(10, arrayFeature('mask', [1, 1, 512, 512])))
        .message(502, new ProtoBuilder().varint(1, 1).mapEntry(2, 'main', fn))
        .build();
}

/**
 * A nested block declaring `count` arguments, for the scope-cost check. The
 * arguments carry no type: an untyped `NamedValueType` claims a single
 * normalized object, so the object budget does not stop the block long before
 * the scope work does.
 */
export function coremlWideBlockFixture(count: number): Uint8Array {
    const inner = new ProtoBuilder();
    for (let index = 0; index < count; index++) {
        inner.message(1, new ProtoBuilder().string(1, `arg${index}`));
    }
    inner.string(2, 'inner_out');
    const main = block([namedValueType('x', tensorType(11, [1]))], ['gated'], [operation({
        type: 'cond',
        inputs: [boundInput('pred', 'x')],
        outputs: [namedValueType('gated', tensorType(11, [1]))],
        blocks: [inner]
    })]);
    const fn = new ProtoBuilder()
        .message(1, namedValueType('x', tensorType(11, [1])))
        .string(2, 'CoreML7')
        .mapEntry(3, 'CoreML7', main);
    return new ProtoBuilder()
        .varint(1, 8)
        .message(2, new ProtoBuilder().message(1, arrayFeature('x', [1])))
        .message(502, new ProtoBuilder().varint(1, 1).mapEntry(2, 'main', fn))
        .build();
}

/**
 * A program that declares its interface on the function's `Block.inputs`
 * rather than on `Function.inputs`, and writes the block's operations before
 * its inputs. Both are legal per `MIL.proto` and neither is what coremltools
 * emits, so only a reader that does not depend on field order handles them.
 */
export function coremlUnorderedBlockFixture(): Uint8Array {
    const inner = block([], ['inner_out'], [operation({
        type: 'relu',
        inputs: [boundInput('x', 'image')],
        outputs: [namedValueType('inner_out', tensorType(11, [1, 4]))]
    })]);
    // Operations (field 3) written before inputs (field 1).
    const main = new ProtoBuilder()
        .message(3, operation({
            type: 'cond',
            inputs: [boundInput('pred', 'image')],
            outputs: [namedValueType('gated', tensorType(11, [1, 4]))],
            blocks: [inner]
        }))
        .string(2, 'gated')
        .message(1, namedValueType('image', tensorType(11, [1, 4])));
    // No `Function.inputs` at all — the block carries the interface.
    const fn = new ProtoBuilder().string(2, 'CoreML7').mapEntry(3, 'CoreML7', main);
    return new ProtoBuilder()
        .varint(1, 8)
        .message(2, new ProtoBuilder()
            .message(1, arrayFeature('image', [1, 4]))
            .message(10, arrayFeature('gated', [1, 4])))
        .message(502, new ProtoBuilder().varint(1, 1).mapEntry(2, 'main', fn))
        .build();
}

/**
 * A k-nearest-neighbour classifier with one int64 label per indexed sample.
 * `add_samples` requires one label per data point, so this vector grows with
 * the index and routinely runs past any cap a document would hold in full.
 */
export function coremlKnnFixture(count: number): Uint8Array {
    const labels = new ProtoBuilder().packedVarint(1, new Array<number>(count).fill(7));
    return new ProtoBuilder()
        .varint(1, 4)
        .message(2, new ProtoBuilder()
            .message(1, arrayFeature('features', [4]))
            .message(10, stringFeature('label'))
            .string(11, 'label'))
        .message(404, new ProtoBuilder().message(101, labels))
        .build();
}

/**
 * An ML Program holding a custom operation as coremltools emits one:
 * `translate_generic_op` rewrites the op type to `custom_layer` and records the
 * registered class under a `class_name` attribute — both spelled differently
 * from the neural network's `custom` layer and its `className`.
 */
export function coremlProgramCustomOpFixture(): Uint8Array {
    const main = block(
        [namedValueType('x', tensorType(11, [1, 4]))],
        ['y'],
        [operation({
            type: 'custom_layer',
            inputs: [boundInput('x', 'x')],
            outputs: [namedValueType('y', tensorType(11, [1, 4]))],
            attributes: [
                ['name', immediateString('my_op')],
                ['class_name', immediateString('OmniProgramOp')],
                ['description', immediateString('Needs a registered runtime class.')]
            ]
        })]
    );
    const fn = new ProtoBuilder()
        .message(1, namedValueType('x', tensorType(11, [1, 4])))
        .string(2, 'CoreML7')
        .mapEntry(3, 'CoreML7', main);
    return new ProtoBuilder()
        .varint(1, 8)
        .message(2, new ProtoBuilder()
            .message(1, arrayFeature('x', [1, 4]))
            .message(10, arrayFeature('y', [1, 4])))
        .message(502, new ProtoBuilder().varint(1, 1).mapEntry(2, 'main', fn))
        .build();
}

/**
 * A small model carrying one metadata string past the per-field text budget —
 * a long licence or an embedded config, both of which real exports contain.
 */
export function coremlBigMetadataFixture(): Uint8Array {
    const long = 'L'.repeat(200_000);
    return new ProtoBuilder()
        .varint(1, 4)
        .message(2, new ProtoBuilder()
            .message(1, arrayFeature('x', [4]))
            .message(10, arrayFeature('y', [4]))
            .message(100, new ProtoBuilder().string(1, 'a description').string(4, long)))
        .message(500, new ProtoBuilder().message(1, layer({
            name: 'relu', inputs: ['x'], outputs: ['y'], field: 130,
            params: new ProtoBuilder().message(10, new ProtoBuilder())
        })))
        .build();
}

/**
 * A k-nearest-neighbour gallery whose string labels, decoded in full, would run
 * past the cumulative text budget — one label per indexed sample, which is how
 * a real gallery grows.
 */
export function coremlLabelGalleryFixture(count: number): Uint8Array {
    // Long labels rather than many of them: the point is to exceed the
    // cumulative text budget when fully decoded, and fewer, longer strings
    // reach that with far less work than a bigger loop.
    const labels = new ProtoBuilder();
    const filler = 'n'.repeat(460);
    for (let index = 0; index < count; index++) labels.string(1, `subject-${index}-${filler}`);
    return new ProtoBuilder()
        .varint(1, 4)
        .message(2, new ProtoBuilder()
            .message(1, arrayFeature('features', [128]))
            .message(10, stringFeature('label'))
            .string(11, 'label'))
        .message(404, new ProtoBuilder().message(100, labels))
        .build();
}

/** An ONNX `ModelProto` header, which opens the same way a Core ML spec does. */
export function onnxLookalikeBytes(): Uint8Array {
    // int64 ir_version = 1; string producer_name = 2; string producer_version = 3;
    return new ProtoBuilder().varint(1, 9).string(2, 'pytorch').string(3, '2.1').build();
}

/**
 * A pipeline classifier: a feature stage followed by a classifier stage that
 * owns the class labels. The wrapper declares none of its own, which is how
 * every shipped Core ML classifier pipeline is built.
 */
export function coremlPipelineClassifierFixture(): Uint8Array {
    const featureStage = new ProtoBuilder()
        .varint(1, 4)
        .message(2, new ProtoBuilder()
            .message(1, imageFeature('image', 28, 28, 10))
            .message(10, arrayFeature('features', [128])))
        .message(500, new ProtoBuilder().message(1, layer({
            name: 'embed', inputs: ['image'], outputs: ['features'], field: 130,
            params: new ProtoBuilder().message(10, new ProtoBuilder())
        })));
    const classifierStage = new ProtoBuilder()
        .varint(1, 4)
        .message(2, new ProtoBuilder()
            .message(1, arrayFeature('features', [128]))
            .message(10, stringFeature('label'))
            .string(11, 'label'))
        // KNearestNeighborsClassifier.stringClassLabels = 100
        .message(404, new ProtoBuilder()
            .message(100, new ProtoBuilder().string(1, 'circle').string(1, 'square').string(1, 'star')));
    const pipeline = new ProtoBuilder()
        .message(1, featureStage).message(1, classifierStage)
        .string(2, 'embedder').string(2, 'classifier');
    const description = new ProtoBuilder()
        .message(1, imageFeature('image', 28, 28, 10))
        .message(10, stringFeature('label'))
        .string(11, 'label');
    return new ProtoBuilder()
        .varint(1, 4)
        .message(2, description)
        .message(200, new ProtoBuilder().message(1, pipeline))
        .build();
}

/** A pipeline whose single stage is a network that itself nests a branch. */
export function coremlNestedPipelineFixture(): Uint8Array {
    const stage = new ProtoBuilder()
        .varint(1, 4)
        .message(2, new ProtoBuilder()
            .message(1, arrayFeature('x', [4]))
            .message(10, arrayFeature('y', [4])))
        .message(500, new ProtoBuilder().message(1, layer({
            name: 'gate', inputs: ['cond', 'x'], outputs: ['y'], field: 605,
            params: new ProtoBuilder()
                .message(1, new ProtoBuilder().message(1, layer({
                    name: 'if_relu', inputs: ['x'], outputs: ['y'], field: 130,
                    params: new ProtoBuilder().message(10, new ProtoBuilder())
                })))
        })));
    const pipeline = new ProtoBuilder().message(1, stage).string(2, 'net');
    const description = new ProtoBuilder()
        .message(1, arrayFeature('x', [4]))
        .message(10, arrayFeature('y', [4]));
    return new ProtoBuilder()
        .varint(1, 4)
        .message(2, description)
        .message(202, pipeline)
        .build();
}

/** A wide single-layer-type network, for the viewer's graph bounding tests. */
export function coremlWideNetworkFixture(count: number): Uint8Array {
    const network = new ProtoBuilder();
    for (let index = 0; index < count; index++) {
        network.message(1, layer({
            name: `relu_${index}`,
            inputs: [index === 0 ? 'x' : `relu_${index - 1}_out`],
            outputs: [index === count - 1 ? 'y' : `relu_${index}_out`],
            field: 130,
            params: new ProtoBuilder().message(10, new ProtoBuilder())
        }));
    }
    const description = new ProtoBuilder()
        .message(1, arrayFeature('x', [8]))
        .message(10, arrayFeature('y', [8]));
    return new ProtoBuilder().varint(1, 4).message(2, description).message(500, network).build();
}

/** A pipeline of a scaler stage and a neural network stage. */
export function coremlPipelineFixture(): Uint8Array {
    const scalerDescription = new ProtoBuilder()
        .message(1, arrayFeature('raw', [4]))
        .message(10, arrayFeature('scaled', [4]));
    const scaler = new ProtoBuilder()
        .varint(1, 4)
        .message(2, scalerDescription)
        // `Scaler` (604) is a parameter block with no graph of its own.
        .message(604, new ProtoBuilder().packedVarint(1, [2]).packedVarint(2, [1]));

    const networkDescription = new ProtoBuilder()
        .message(1, arrayFeature('scaled', [4]))
        .message(10, arrayFeature('prediction', [1]));
    const inner = new ProtoBuilder()
        .message(1, layer({ name: 'fc', inputs: ['scaled'], outputs: ['prediction'], field: 140, params: new ProtoBuilder().varint(1, 4).varint(2, 1).message(20, floatWeights(4)) }));
    const network = new ProtoBuilder()
        .varint(1, 4)
        .message(2, networkDescription)
        .message(303, inner);

    const pipeline = new ProtoBuilder()
        .message(1, scaler)
        .message(1, network)
        .string(2, 'scaler')
        .string(2, 'regressor');

    const description = new ProtoBuilder()
        .message(1, arrayFeature('raw', [4]))
        .message(10, arrayFeature('prediction', [1]))
        .string(11, 'prediction')
        .message(100, metadata());
    return new ProtoBuilder()
        .varint(1, 4)
        .message(2, description)
        .message(201, new ProtoBuilder().message(1, pipeline))
        .build();
}

/** A multi-function model, the Core ML 8 layout an LLM export uses. */
export function coremlMultiFunctionFixture(): Uint8Array {
    const describeFunction = (name: string, length: number): ProtoBuilder => new ProtoBuilder()
        .string(1, name)
        .message(2, arrayFeature('tokens', [1, length], 131104))
        .message(3, arrayFeature('logits', [1, length, 32000], 65552))
        .message(6, arrayFeature('kv_cache', [1, 32, length, 128], 65552));
    const description = new ProtoBuilder()
        .message(20, describeFunction('prompt', 128))
        .message(20, describeFunction('extend', 1))
        .string(21, 'extend')
        .message(100, metadata());
    const fn = new ProtoBuilder()
        .string(2, 'CoreML8')
        .mapEntry(3, 'CoreML8', block([], ['logits'], [operation({
            type: 'identity',
            inputs: [boundInput('x', 'tokens')],
            outputs: [namedValueType('logits', tensorType(10, [1, '?', 32000]))]
        })]));
    return new ProtoBuilder()
        .varint(1, 9)
        .message(2, description)
        .message(502, new ProtoBuilder().varint(1, 1).mapEntry(2, 'main', fn))
        .build();
}

// ── .mlpackage archives ────────────────────────────────────────────────────

interface ArchiveMember {
    name: string;
    data: Uint8Array;
    /** Declared compression method; the bytes are always stored verbatim, so a
     *  non-zero value models a member this parser declines to extract. */
    method?: number;
}

/** Writes a ZIP with stored (uncompressed) members, as coremltools does. */
export function buildZip(members: ArchiveMember[]): Uint8Array {
    const locals: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const member of members) {
        const name = encoder.encode(member.name);
        const local = new Uint8Array(30 + name.byteLength + member.data.byteLength);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, 0x04034b50, true);
        localView.setUint16(4, 20, true);
        localView.setUint16(8, member.method ?? 0, true);
        localView.setUint32(14, crc32(member.data), true);
        localView.setUint32(18, member.data.byteLength, true);
        localView.setUint32(22, member.data.byteLength, true);
        localView.setUint16(26, name.byteLength, true);
        local.set(name, 30);
        local.set(member.data, 30 + name.byteLength);
        locals.push(local);

        const header = new Uint8Array(46 + name.byteLength);
        const headerView = new DataView(header.buffer);
        headerView.setUint32(0, 0x02014b50, true);
        headerView.setUint16(4, 20, true);
        headerView.setUint16(6, 20, true);
        headerView.setUint16(10, member.method ?? 0, true);
        headerView.setUint32(16, crc32(member.data), true);
        headerView.setUint32(20, member.data.byteLength, true);
        headerView.setUint32(24, member.data.byteLength, true);
        headerView.setUint16(28, name.byteLength, true);
        headerView.setUint32(42, offset, true);
        header.set(name, 46);
        central.push(header);
        offset += local.byteLength;
    }
    const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(8, members.length, true);
    eocdView.setUint16(10, members.length, true);
    eocdView.setUint32(12, centralSize, true);
    eocdView.setUint32(16, offset, true);
    return concat([...locals, ...central, eocd]);
}

function concat(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
    return out;
}

function crc32(data: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

export interface PackageOptions {
    /** Folder the bundle sits in, as a Finder-made archive would keep it. */
    prefix?: string;
    /** Omit the manifest, so the parser has to find the spec by convention. */
    withoutManifest?: boolean;
    /** Declare the manifest with a compression method the parser cannot undo. */
    unreadableManifest?: boolean;
    /** Omit the weight blob the program references. */
    withoutWeights?: boolean;
    spec?: Uint8Array;
    weightBytes?: number;
}

/** An `.mlpackage` bundle zipped whole, the shape a shared model arrives in. */
export function coremlPackageFixture(options: PackageOptions = {}): Uint8Array {
    const prefix = options.prefix ?? 'Classifier.mlpackage/';
    const spec = options.spec ?? coremlProgramFixture();
    const members: ArchiveMember[] = [];
    if (!options.withoutManifest) {
        const manifest = {
            fileFormatVersion: '1.0.0',
            itemInfoEntries: {
                '11111111-2222-3333-4444-555555555555': {
                    author: 'com.apple.CoreML',
                    description: 'CoreML Model Specification',
                    name: 'model.mlmodel',
                    path: 'com.apple.CoreML/model.mlmodel'
                },
                '66666666-7777-8888-9999-000000000000': {
                    author: 'com.apple.CoreML',
                    description: 'CoreML Model Weights',
                    name: 'weights',
                    path: 'com.apple.CoreML/weights'
                }
            },
            rootModelIdentifier: '11111111-2222-3333-4444-555555555555'
        };
        members.push({
            name: `${prefix}Manifest.json`,
            data: encoder.encode(JSON.stringify(manifest, null, 2)),
            ...(options.unreadableManifest ? { method: 99 } : {})
        });
    }
    members.push({ name: `${prefix}Data/com.apple.CoreML/model.mlmodel`, data: spec });
    if (!options.withoutWeights) {
        members.push({
            name: `${prefix}Data/com.apple.CoreML/weights/weight.bin`,
            data: new Uint8Array(options.weightBytes ?? 8192)
        });
    }
    return buildZip(members);
}
