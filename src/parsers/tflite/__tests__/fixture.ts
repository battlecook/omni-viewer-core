/**
 * A minimal FlatBuffers writer plus the TFLite models the parser tests read.
 * The writer follows the reference back-to-front layout: children are built
 * first, tables are closed with a vtable, and the root offset is written last.
 */

const encoder = new TextEncoder();

export class FlatBufferBuilder {
    private buf: Uint8Array;
    private view: DataView;
    private space: number;
    private minalign = 1;
    private vtable: number[] = [];
    private vtableInUse = 0;
    private objectStart = 0;
    /** Offsets of every vtable written so far, for deduplication. */
    private vtables: number[] = [];

    constructor(initial = 1024) {
        this.buf = new Uint8Array(initial);
        this.view = new DataView(this.buf.buffer);
        this.space = initial;
    }

    /** Bytes written so far, measured from the end of the buffer. */
    offset(): number { return this.buf.length - this.space; }

    private grow(): void {
        const previous = this.buf;
        const next = new Uint8Array(previous.length * 2);
        next.set(previous, previous.length);
        this.space += previous.length;
        this.buf = next;
        this.view = new DataView(next.buffer);
    }

    private ensure(size: number): void { while (this.space < size) this.grow(); }

    private pad(count: number): void {
        this.ensure(count);
        for (let index = 0; index < count; index++) this.buf[--this.space] = 0;
    }

    prep(size: number, additional: number): void {
        if (size > this.minalign) this.minalign = size;
        const alignSize = ((~(this.offset() + additional)) + 1) & (size - 1);
        this.ensure(alignSize + size + additional);
        this.pad(alignSize);
    }

    writeInt8(value: number): void { this.ensure(1); this.buf[--this.space] = value & 0xff; }
    writeInt16(value: number): void { this.ensure(2); this.space -= 2; this.view.setInt16(this.space, value, true); }
    writeInt32(value: number): void { this.ensure(4); this.space -= 4; this.view.setInt32(this.space, value, true); }
    writeInt64(value: bigint): void { this.ensure(8); this.space -= 8; this.view.setBigInt64(this.space, value, true); }
    writeFloat32(value: number): void { this.ensure(4); this.space -= 4; this.view.setFloat32(this.space, value, true); }

    /** Write a uoffset pointing back at an already-built object. */
    private writeOffset(target: number): void {
        this.prep(4, 0);
        this.writeInt32(this.offset() - target + 4);
    }

    private startVector(elementSize: number, count: number, alignment: number): void {
        this.prep(4, elementSize * count);
        this.prep(alignment, elementSize * count);
    }

    createString(value: string): number {
        const bytes = encoder.encode(value);
        this.prep(1, 0);
        this.writeInt8(0);
        this.startVector(1, bytes.length, 1);
        this.ensure(bytes.length);
        this.space -= bytes.length;
        this.buf.set(bytes, this.space);
        this.writeInt32(bytes.length);
        return this.offset();
    }

    createByteVector(bytes: Uint8Array): number {
        this.startVector(1, bytes.length, 1);
        this.ensure(bytes.length);
        this.space -= bytes.length;
        this.buf.set(bytes, this.space);
        this.writeInt32(bytes.length);
        return this.offset();
    }

    createIntVector(values: readonly number[]): number {
        this.startVector(4, values.length, 4);
        for (let index = values.length - 1; index >= 0; index--) this.writeInt32(values[index]!);
        this.writeInt32(values.length);
        return this.offset();
    }

    createFloatVector(values: readonly number[]): number {
        this.startVector(4, values.length, 4);
        for (let index = values.length - 1; index >= 0; index--) this.writeFloat32(values[index]!);
        this.writeInt32(values.length);
        return this.offset();
    }

    createLongVector(values: readonly bigint[]): number {
        this.startVector(8, values.length, 8);
        for (let index = values.length - 1; index >= 0; index--) this.writeInt64(values[index]!);
        this.writeInt32(values.length);
        return this.offset();
    }

    createShortVector(values: readonly number[]): number {
        this.startVector(2, values.length, 2);
        for (let index = values.length - 1; index >= 0; index--) this.writeInt16(values[index]!);
        this.writeInt32(values.length);
        return this.offset();
    }

    createOffsetVector(offsets: readonly number[]): number {
        this.startVector(4, offsets.length, 4);
        for (let index = offsets.length - 1; index >= 0; index--) this.writeOffset(offsets[index]!);
        this.writeInt32(offsets.length);
        return this.offset();
    }

    startTable(): void {
        this.vtable = [];
        this.vtableInUse = 0;
        this.objectStart = this.offset();
    }

    private slot(field: number): void {
        this.vtable[field] = this.offset();
        if (field >= this.vtableInUse) this.vtableInUse = field + 1;
    }

    addInt8(field: number, value: number): void { this.prep(1, 0); this.writeInt8(value); this.slot(field); }
    addBool(field: number, value: boolean): void { this.addInt8(field, value ? 1 : 0); }
    addInt32(field: number, value: number): void { this.prep(4, 0); this.writeInt32(value); this.slot(field); }
    addInt64(field: number, value: bigint): void { this.prep(8, 0); this.writeInt64(value); this.slot(field); }
    addFloat32(field: number, value: number): void { this.prep(4, 0); this.writeFloat32(value); this.slot(field); }
    addOffset(field: number, target: number): void {
        if (!target) return;
        this.writeOffset(target);
        this.slot(field);
    }

    endTable(): number {
        this.prep(4, 0);
        this.writeInt32(0);
        const vtableLocation = this.offset();
        let index = this.vtableInUse - 1;
        for (; index >= 0 && !this.vtable[index]; index--) { /* trim trailing empty slots */ }
        const trimmed = index + 1;
        for (; index >= 0; index--) {
            this.prep(2, 0);
            this.writeInt16(this.vtable[index] ? vtableLocation - this.vtable[index]! : 0);
        }
        this.prep(2, 0);
        this.writeInt16(vtableLocation - this.objectStart);
        this.prep(2, 0);
        const length = (trimmed + 2) * 2;
        this.writeInt16(length);

        // Reuse an identical vtable when one exists. The reused vtable was
        // written earlier, so it sits at a smaller offset-from-end and the
        // table's soffset comes out negative — the layout flatc produces for
        // the overwhelming majority of tables in a real model.
        const candidate = this.space;
        let existing = 0;
        for (const previous of this.vtables) {
            const other = this.buf.length - previous;
            if (this.view.getInt16(other, true) !== length) continue;
            let same = true;
            for (let offset = 2; offset < length && same; offset += 2) {
                same = this.view.getInt16(candidate + offset, true) === this.view.getInt16(other + offset, true);
            }
            if (same) { existing = previous; break; }
        }
        if (existing) {
            this.space = this.buf.length - vtableLocation;
            this.view.setInt32(this.space, existing - vtableLocation, true);
        } else {
            this.vtables.push(this.offset());
            this.view.setInt32(this.buf.length - vtableLocation, this.offset() - vtableLocation, true);
        }
        return vtableLocation;
    }

    finish(root: number, identifier = 'TFL3'): Uint8Array {
        this.prep(this.minalign, 4 + identifier.length);
        for (let index = identifier.length - 1; index >= 0; index--) this.writeInt8(identifier.charCodeAt(index));
        this.prep(this.minalign, 4);
        this.writeOffset(root);
        return this.buf.slice(this.space);
    }
}

interface TensorSpec {
    name: string;
    type: number;
    shape: number[];
    buffer: number;
    scale?: number[];
    zeroPoint?: bigint[];
    quantizedDimension?: number;
    isVariable?: boolean;
    shapeSignature?: number[];
}

interface OperatorSpec {
    opcodeIndex: number;
    inputs: number[];
    outputs: number[];
    optionsType?: number;
    /** Called between `startTable` and `endTable` for the options table. */
    options?: (builder: FlatBufferBuilder) => void;
    customOptions?: Uint8Array;
    intermediates?: number[];
}

function buildTensor(builder: FlatBufferBuilder, spec: TensorSpec): number {
    const name = builder.createString(spec.name);
    const shape = builder.createIntVector(spec.shape);
    const shapeSignature = spec.shapeSignature ? builder.createIntVector(spec.shapeSignature) : 0;
    let quantization = 0;
    if (spec.scale) {
        const scale = builder.createFloatVector(spec.scale);
        const zeroPoint = builder.createLongVector(spec.zeroPoint ?? spec.scale.map(() => 0n));
        builder.startTable();
        builder.addOffset(2, scale);
        builder.addOffset(3, zeroPoint);
        builder.addInt32(6, spec.quantizedDimension ?? 0);
        quantization = builder.endTable();
    }
    builder.startTable();
    builder.addOffset(0, shape);
    builder.addInt8(1, spec.type);
    builder.addInt32(2, spec.buffer);
    builder.addOffset(3, name);
    builder.addOffset(4, quantization);
    if (spec.isVariable) builder.addBool(5, true);
    builder.addOffset(7, shapeSignature);
    return builder.endTable();
}

function buildOperator(builder: FlatBufferBuilder, spec: OperatorSpec): number {
    const inputs = builder.createIntVector(spec.inputs);
    const outputs = builder.createIntVector(spec.outputs);
    const intermediates = spec.intermediates ? builder.createIntVector(spec.intermediates) : 0;
    const customOptions = spec.customOptions ? builder.createByteVector(spec.customOptions) : 0;
    let options = 0;
    if (spec.options) {
        builder.startTable();
        spec.options(builder);
        options = builder.endTable();
    }
    builder.startTable();
    builder.addInt32(0, spec.opcodeIndex);
    builder.addOffset(1, inputs);
    builder.addOffset(2, outputs);
    if (spec.optionsType) builder.addInt8(3, spec.optionsType);
    builder.addOffset(4, options);
    builder.addOffset(5, customOptions);
    builder.addOffset(8, intermediates);
    return builder.endTable();
}

function buildSubgraph(
    builder: FlatBufferBuilder,
    name: string,
    tensors: TensorSpec[],
    operators: OperatorSpec[],
    inputs: number[],
    outputs: number[]
): number {
    const tensorOffsets = tensors.map(tensor => buildTensor(builder, tensor));
    const operatorOffsets = operators.map(operator => buildOperator(builder, operator));
    const nameOffset = builder.createString(name);
    const tensorVector = builder.createOffsetVector(tensorOffsets);
    const operatorVector = builder.createOffsetVector(operatorOffsets);
    const inputVector = builder.createIntVector(inputs);
    const outputVector = builder.createIntVector(outputs);
    builder.startTable();
    builder.addOffset(0, tensorVector);
    builder.addOffset(1, inputVector);
    builder.addOffset(2, outputVector);
    builder.addOffset(3, operatorVector);
    builder.addOffset(4, nameOffset);
    return builder.endTable();
}

function buildOperatorCode(builder: FlatBufferBuilder, deprecated: number, builtin: number, custom?: string, version = 1): number {
    const customCode = custom ? builder.createString(custom) : 0;
    builder.startTable();
    builder.addInt8(0, deprecated);
    builder.addOffset(1, customCode);
    builder.addInt32(2, version);
    builder.addInt32(3, builtin);
    return builder.endTable();
}

function buildBuffer(builder: FlatBufferBuilder, data?: Uint8Array, offset?: bigint, size?: bigint): number {
    const dataOffset = data ? builder.createByteVector(data) : 0;
    builder.startTable();
    builder.addOffset(0, dataOffset);
    if (offset !== undefined) builder.addInt64(1, offset);
    if (size !== undefined) builder.addInt64(2, size);
    return builder.endTable();
}

/**
 * A two-subgraph classifier: a quantized convolution, a fully-connected layer, a
 * custom detection op, inline and appended weight buffers, runtime metadata, and
 * a signature definition.
 */
export function tfliteFixture(): Uint8Array {
    const builder = new FlatBufferBuilder();
    const buffers = [
        buildBuffer(builder),
        buildBuffer(builder, new Uint8Array(48)),
        buildBuffer(builder, new Uint8Array(16)),
        buildBuffer(builder, encoder.encode('1.14.0\0\0')),
        buildBuffer(builder, undefined, 4096n, 1024n)
    ];

    const main = buildSubgraph(
        builder,
        'main',
        [
            { name: 'input', type: 0, shape: [1, 8, 8, 3], buffer: 0, shapeSignature: [-1, 8, 8, 3] },
            { name: 'conv_weights', type: 9, shape: [4, 1, 1, 3], buffer: 1, scale: [0.1, 0.2, 0.3, 0.4], quantizedDimension: 0 },
            { name: 'conv_bias', type: 2, shape: [4], buffer: 2 },
            { name: 'conv_out', type: 9, shape: [1, 8, 8, 4], buffer: 0, scale: [0.0078125], zeroPoint: [-128n] },
            { name: 'logits', type: 0, shape: [1, 4], buffer: 0 },
            { name: 'appended_weights', type: 9, shape: [1024], buffer: 4 }
        ],
        [
            {
                opcodeIndex: 0, inputs: [0, 1, 2], outputs: [3], optionsType: 1,
                // `padding` is left out entirely: flatc omits any field equal to
                // its schema default, and SAME is the default.
                options: b => {
                    b.addInt32(1, 1); b.addInt32(2, 1);
                    b.addInt8(3, 3); // RELU6
                    b.addInt32(4, 1); b.addInt32(5, 1);
                }
            },
            {
                opcodeIndex: 1, inputs: [3, -1], outputs: [4], optionsType: 8,
                options: b => { b.addInt8(0, 0); b.addBool(2, true); }
            },
            { opcodeIndex: 2, inputs: [4], outputs: [], customOptions: new Uint8Array([1, 2, 3, 4, 5, 6]) },
            { opcodeIndex: 3, inputs: [4], outputs: [], optionsType: 102, options: b => { b.addBool(0, true); } }
        ],
        [0],
        [4]
    );

    const branch = buildSubgraph(
        builder,
        'branch',
        [{ name: 'branch_in', type: 0, shape: [1], buffer: 0 }, { name: 'branch_out', type: 0, shape: [1], buffer: 0 }],
        [{ opcodeIndex: 4, inputs: [0], outputs: [1] }],
        [0],
        [1]
    );

    const operatorCodes = [
        buildOperatorCode(builder, 3, 3, undefined, 3), // CONV_2D
        buildOperatorCode(builder, 9, 9, undefined, 4), // FULLY_CONNECTED
        buildOperatorCode(builder, 32, 32, 'TFLite_Detection_PostProcess'), // CUSTOM
        buildOperatorCode(builder, 127, 128, undefined, 1), // CUMSUM via builtin_code
        buildOperatorCode(builder, 32, 32, 'FlexErf') // Select-TF fallback
    ];

    const metadataName = builder.createString('min_runtime_version');
    builder.startTable();
    builder.addOffset(0, metadataName);
    builder.addInt32(1, 3);
    const metadata = builder.endTable();

    const inputMapName = builder.createString('image');
    builder.startTable();
    builder.addOffset(0, inputMapName);
    builder.addInt32(1, 0);
    const inputMap = builder.endTable();
    const outputMapName = builder.createString('scores');
    builder.startTable();
    builder.addOffset(0, outputMapName);
    builder.addInt32(1, 4);
    const outputMap = builder.endTable();
    const signatureKey = builder.createString('serving_default');
    const signatureInputs = builder.createOffsetVector([inputMap]);
    const signatureOutputs = builder.createOffsetVector([outputMap]);
    builder.startTable();
    builder.addOffset(0, signatureInputs);
    builder.addOffset(1, signatureOutputs);
    builder.addOffset(2, signatureKey);
    builder.addInt32(4, 0);
    const signature = builder.endTable();

    const description = builder.createString('Fixture classifier');
    const operatorCodeVector = builder.createOffsetVector(operatorCodes);
    const subgraphVector = builder.createOffsetVector([main, branch]);
    const bufferVector = builder.createOffsetVector(buffers);
    const metadataVector = builder.createOffsetVector([metadata]);
    const signatureVector = builder.createOffsetVector([signature]);
    const metadataBufferVector = builder.createIntVector([3]);

    builder.startTable();
    builder.addInt32(0, 3);
    builder.addOffset(1, operatorCodeVector);
    builder.addOffset(2, subgraphVector);
    builder.addOffset(3, description);
    builder.addOffset(4, bufferVector);
    builder.addOffset(5, metadataBufferVector);
    builder.addOffset(6, metadataVector);
    builder.addOffset(7, signatureVector);
    const model = builder.endTable();
    return builder.finish(model);
}

/** A model whose only subgraph has no operators. */
export function tfliteEmptyGraphFixture(identifier = 'TFL3', version = 3): Uint8Array {
    const builder = new FlatBufferBuilder();
    const buffer = buildBuffer(builder);
    const subgraph = buildSubgraph(builder, 'empty', [], [], [], []);
    const subgraphVector = builder.createOffsetVector([subgraph]);
    const bufferVector = builder.createOffsetVector([buffer]);
    builder.startTable();
    builder.addInt32(0, version);
    builder.addOffset(2, subgraphVector);
    builder.addOffset(4, bufferVector);
    const model = builder.endTable();
    return builder.finish(model, identifier);
}

/** A model with `count` chained ADD operators, for viewer bounding tests. */
export function tfliteWideGraphFixture(count: number): Uint8Array {
    const builder = new FlatBufferBuilder(1 << 16);
    const buffer = buildBuffer(builder);
    const tensors: TensorSpec[] = [{ name: 'input', type: 0, shape: [1], buffer: 0 }];
    const operators: OperatorSpec[] = [];
    for (let index = 0; index < count; index++) {
        tensors.push({ name: `hidden_${index}`, type: 0, shape: [1], buffer: 0 });
        operators.push({ opcodeIndex: 0, inputs: [index], outputs: [index + 1] });
    }
    const subgraph = buildSubgraph(builder, 'wide', tensors, operators, [0], [count]);
    const operatorCode = buildOperatorCode(builder, 0, 0);
    const operatorCodeVector = builder.createOffsetVector([operatorCode]);
    const subgraphVector = builder.createOffsetVector([subgraph]);
    const bufferVector = builder.createOffsetVector([buffer]);
    builder.startTable();
    builder.addInt32(0, 3);
    builder.addOffset(1, operatorCodeVector);
    builder.addOffset(2, subgraphVector);
    builder.addOffset(4, bufferVector);
    const model = builder.endTable();
    return builder.finish(model);
}

/** A model whose single weight buffer is larger than any per-vector item cap. */
export function tfliteLargeBufferFixture(bytes: number): Uint8Array {
    const builder = new FlatBufferBuilder(bytes * 2 + 1024);
    const buffers = [buildBuffer(builder), buildBuffer(builder, new Uint8Array(bytes))];
    const subgraph = buildSubgraph(
        builder,
        'main',
        [{ name: 'weights', type: 9, shape: [bytes], buffer: 1 }],
        [],
        [],
        [0]
    );
    const subgraphVector = builder.createOffsetVector([subgraph]);
    const bufferVector = builder.createOffsetVector(buffers);
    builder.startTable();
    builder.addInt32(0, 3);
    builder.addOffset(2, subgraphVector);
    builder.addOffset(4, bufferVector);
    const model = builder.endTable();
    return builder.finish(model);
}

/**
 * `count` operator tables whose input and output vectors are all the *same*
 * FlatBuffers offset — a small file that asks for count x length decoded ints.
 */
export function tfliteAliasedVectorFixture(count: number, length: number): Uint8Array {
    const builder = new FlatBufferBuilder(1 << 20);
    const buffer = buildBuffer(builder);
    const shared = builder.createIntVector(new Array(length).fill(0));
    const operators: number[] = [];
    for (let index = 0; index < count; index++) {
        builder.startTable();
        builder.addInt32(0, 0);
        builder.addOffset(1, shared);
        builder.addOffset(2, shared);
        operators.push(builder.endTable());
    }
    const name = builder.createString('aliased');
    const operatorVector = builder.createOffsetVector(operators);
    builder.startTable();
    builder.addOffset(3, operatorVector);
    builder.addOffset(4, name);
    const subgraph = builder.endTable();
    const operatorCode = buildOperatorCode(builder, 0, 0);
    const operatorCodeVector = builder.createOffsetVector([operatorCode]);
    const subgraphVector = builder.createOffsetVector([subgraph]);
    const bufferVector = builder.createOffsetVector([buffer]);
    builder.startTable();
    builder.addInt32(0, 3);
    builder.addOffset(1, operatorCodeVector);
    builder.addOffset(2, subgraphVector);
    builder.addOffset(4, bufferVector);
    const model = builder.endTable();
    return builder.finish(model);
}

/**
 * Exercises the schema corners the ordinary fixtures miss: a `builtin_options_2`
 * union (Operator slots 11/12), an out-of-band custom payload (slots 9/10), and
 * a sparse tensor with both Int32 and Uint16 index vectors.
 */
export function tfliteAdvancedFixture(): Uint8Array {
    const builder = new FlatBufferBuilder(1 << 14);
    const buffer = buildBuffer(builder);

    // SparsityParameters -> DimensionMetadata -> SparseIndexVector unions.
    const segmentValues = builder.createIntVector([0, 2, 4]);
    builder.startTable();
    builder.addOffset(0, segmentValues);
    const segments = builder.endTable();
    const indexValues = builder.createShortVector([0, 1, 0, 1]);
    builder.startTable();
    builder.addOffset(0, indexValues);
    const indices = builder.endTable();
    builder.startTable();
    builder.addInt8(0, 0); // DENSE
    builder.addInt32(1, 4);
    const denseDimension = builder.endTable();
    builder.startTable();
    builder.addInt8(0, 1); // SPARSE_CSR
    builder.addInt8(2, 1); // array_segments_type = Int32Vector
    builder.addOffset(3, segments);
    builder.addInt8(4, 2); // array_indices_type = Uint16Vector
    builder.addOffset(5, indices);
    const sparseDimension = builder.endTable();
    const traversalOrder = builder.createIntVector([0, 1]);
    const blockMap = builder.createIntVector([1]);
    const dimensionVector = builder.createOffsetVector([denseDimension, sparseDimension]);
    builder.startTable();
    builder.addOffset(0, traversalOrder);
    builder.addOffset(1, blockMap);
    builder.addOffset(2, dimensionVector);
    const sparsity = builder.endTable();

    const sparseName = builder.createString('sparse_weights');
    const sparseShape = builder.createIntVector([4, 4]);
    builder.startTable();
    builder.addOffset(0, sparseShape);
    builder.addInt8(1, 0);
    builder.addInt32(2, 0);
    builder.addOffset(3, sparseName);
    builder.addOffset(6, sparsity);
    const sparseTensor = builder.endTable();
    const outName = builder.createString('out');
    builder.startTable();
    builder.addOffset(3, outName);
    builder.addInt32(2, 0);
    const outTensor = builder.endTable();

    // builtin_options_2 = StableHLOCompositeOptions (union type 21).
    const compositeName = builder.createString('odml.scaled_dot_product_attention');
    builder.startTable();
    builder.addOffset(0, compositeName);
    builder.addInt32(1, 0);
    builder.addInt32(4, 2);
    const composite = builder.endTable();
    const compositeInputs = builder.createIntVector([0]);
    const compositeOutputs = builder.createIntVector([1]);
    builder.startTable();
    builder.addInt32(0, 0);
    builder.addOffset(1, compositeInputs);
    builder.addOffset(2, compositeOutputs);
    builder.addInt8(11, 21);
    builder.addOffset(12, composite);
    const compositeOperator = builder.endTable();

    // A custom operator whose payload lives outside the FlatBuffer.
    const largeInputs = builder.createIntVector([1]);
    builder.startTable();
    builder.addInt32(0, 1);
    builder.addOffset(1, largeInputs);
    builder.addInt64(9, 8192n);
    builder.addInt64(10, 65536n);
    const largeOperator = builder.endTable();

    const subgraphName = builder.createString('advanced');
    const tensorVector = builder.createOffsetVector([sparseTensor, outTensor]);
    const operatorVector = builder.createOffsetVector([compositeOperator, largeOperator]);
    const subgraphInputs = builder.createIntVector([0]);
    const subgraphOutputs = builder.createIntVector([1]);
    builder.startTable();
    builder.addOffset(0, tensorVector);
    builder.addOffset(1, subgraphInputs);
    builder.addOffset(2, subgraphOutputs);
    builder.addOffset(3, operatorVector);
    builder.addOffset(4, subgraphName);
    const subgraph = builder.endTable();

    const operatorCodes = [
        buildOperatorCode(builder, 127, 206), // STABLEHLO_COMPOSITE
        buildOperatorCode(builder, 32, 32, 'BigCustom')
    ];
    const operatorCodeVector = builder.createOffsetVector(operatorCodes);
    const subgraphVector = builder.createOffsetVector([subgraph]);
    const bufferVector = builder.createOffsetVector([buffer]);
    builder.startTable();
    builder.addInt32(0, 3);
    builder.addOffset(1, operatorCodeVector);
    builder.addOffset(2, subgraphVector);
    builder.addOffset(4, bufferVector);
    const model = builder.endTable();
    return builder.finish(model);
}

/**
 * Option-decoding edge cases: an IF whose options table is entirely absent (so
 * every field comes from a fallback), a WHILE naming the same subgraph twice, a
 * RESHAPE whose shape vector exceeds the option preview cap, and a tensor with
 * more quantization scales than the preview cap.
 */
export function tfliteOptionEdgeCasesFixture(): Uint8Array {
    const builder = new FlatBufferBuilder(1 << 14);
    const buffers = [buildBuffer(builder), buildBuffer(builder, new Uint8Array(300))];
    const scales = builder.createFloatVector(Array.from({ length: 100 }, (_, index) => index / 100));
    const zeroPoints = builder.createLongVector(Array.from({ length: 100 }, () => 0n));
    builder.startTable();
    builder.addOffset(2, scales);
    builder.addOffset(3, zeroPoints);
    builder.addInt32(6, 0);
    const quantization = builder.endTable();
    const quantName = builder.createString('per_channel');
    const quantShape = builder.createIntVector([100, 1, 1, 3]);
    builder.startTable();
    builder.addOffset(0, quantShape);
    builder.addInt8(1, 9);
    builder.addInt32(2, 1);
    builder.addOffset(3, quantName);
    builder.addOffset(4, quantization);
    const quantTensor = builder.endTable();

    // An IF with no options table at all: every field resolves to its default.
    builder.startTable();
    const emptyOptions = builder.endTable();
    const ifInputs = builder.createIntVector([0]);
    builder.startTable();
    builder.addInt32(0, 0);
    builder.addOffset(1, ifInputs);
    builder.addInt8(3, 92);
    builder.addOffset(4, emptyOptions);
    const ifOperator = builder.endTable();

    builder.startTable();
    builder.addInt32(0, 1);
    builder.addInt32(1, 1);
    const whileOptions = builder.endTable();
    builder.startTable();
    builder.addInt32(0, 1);
    builder.addInt8(3, 93);
    builder.addOffset(4, whileOptions);
    const whileOperator = builder.endTable();

    const newShape = builder.createIntVector(Array.from({ length: 80 }, (_, index) => index));
    builder.startTable();
    builder.addOffset(0, newShape);
    const reshapeOptions = builder.endTable();
    builder.startTable();
    builder.addInt32(0, 2);
    builder.addInt8(3, 17);
    builder.addOffset(4, reshapeOptions);
    const reshapeOperator = builder.endTable();

    const subgraphName = builder.createString('edges');
    const tensorVector = builder.createOffsetVector([quantTensor]);
    const operatorVector = builder.createOffsetVector([ifOperator, whileOperator, reshapeOperator]);
    builder.startTable();
    builder.addOffset(0, tensorVector);
    builder.addOffset(3, operatorVector);
    builder.addOffset(4, subgraphName);
    const subgraph = builder.endTable();
    const operatorCodes = [
        buildOperatorCode(builder, 118, 118),
        buildOperatorCode(builder, 119, 119),
        buildOperatorCode(builder, 22, 22)
    ];
    const operatorCodeVector = builder.createOffsetVector(operatorCodes);
    const subgraphVector = builder.createOffsetVector([subgraph]);
    const bufferVector = builder.createOffsetVector(buffers);
    builder.startTable();
    builder.addInt32(0, 3);
    builder.addOffset(1, operatorCodeVector);
    builder.addOffset(2, subgraphVector);
    builder.addOffset(4, bufferVector);
    const model = builder.endTable();
    return builder.finish(model);
}

/**
 * A schema-3d model whose constant tensor lives in a separate file via
 * `Tensor.external_buffer`, plus `count` activation tensors sharing buffer 0.
 */
export function tfliteExternalBufferFixture(count = 0, declaredId = 7, referencedId = 7): Uint8Array {
    const builder = new FlatBufferBuilder(1 << 14);
    const buffer = buildBuffer(builder);
    const packing = builder.createString('raw');
    builder.startTable();
    builder.addInt32(0, declaredId); // id
    builder.addInt32(1, 0); // group
    builder.addInt64(2, 65536n);
    builder.addInt64(3, 4096n);
    builder.addOffset(4, packing);
    const externalBuffer = builder.endTable();

    const weightName = builder.createString('external_weights');
    const weightShape = builder.createIntVector([4096]);
    builder.startTable();
    builder.addOffset(0, weightShape);
    builder.addInt8(1, 9);
    builder.addInt32(2, 0);
    builder.addOffset(3, weightName);
    builder.addInt32(10, referencedId); // external_buffer id
    const tensors = [builder.endTable()];
    for (let index = 0; index < count; index++) {
        const name = builder.createString(`act_${index}`);
        builder.startTable();
        builder.addInt8(1, 0);
        builder.addInt32(2, 0);
        builder.addOffset(3, name);
        tensors.push(builder.endTable());
    }

    const subgraphName = builder.createString('external');
    const tensorVector = builder.createOffsetVector(tensors);
    builder.startTable();
    builder.addOffset(0, tensorVector);
    builder.addOffset(4, subgraphName);
    const subgraph = builder.endTable();
    const subgraphVector = builder.createOffsetVector([subgraph]);
    const bufferVector = builder.createOffsetVector([buffer]);
    const externalVector = builder.createOffsetVector([externalBuffer]);
    builder.startTable();
    builder.addInt32(0, 3);
    builder.addOffset(2, subgraphVector);
    builder.addOffset(4, bufferVector);
    builder.addOffset(9, externalVector);
    const model = builder.endTable();
    return builder.finish(model);
}

/** A control-flow model: a WHILE operator pointing at cond/body subgraphs. */
export function tfliteControlFlowFixture(): Uint8Array {
    const builder = new FlatBufferBuilder();
    const buffer = buildBuffer(builder);
    const main = buildSubgraph(
        builder,
        'main',
        [{ name: 'counter', type: 2, shape: [], buffer: 0 }, { name: 'result', type: 2, shape: [], buffer: 0 }],
        [{
            opcodeIndex: 0, inputs: [0], outputs: [1], optionsType: 93,
            options: b => { b.addInt32(0, 1); b.addInt32(1, 2); }
        }],
        [0],
        [1]
    );
    const cond = buildSubgraph(builder, 'cond', [{ name: 'cond_in', type: 2, shape: [], buffer: 0 }], [], [0], [0]);
    const body = buildSubgraph(builder, 'body', [{ name: 'body_in', type: 2, shape: [], buffer: 0 }], [], [0], [0]);
    const operatorCode = buildOperatorCode(builder, 119, 119);
    const operatorCodeVector = builder.createOffsetVector([operatorCode]);
    const subgraphVector = builder.createOffsetVector([main, cond, body]);
    const bufferVector = builder.createOffsetVector([buffer]);
    builder.startTable();
    builder.addInt32(0, 3);
    builder.addOffset(1, operatorCodeVector);
    builder.addOffset(2, subgraphVector);
    builder.addOffset(4, bufferVector);
    const model = builder.endTable();
    return builder.finish(model);
}
