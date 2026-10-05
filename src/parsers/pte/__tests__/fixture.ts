/**
 * ExecuTorch programs the parser and viewer tests read, written with the
 * FlatBuffers builder the TFLite fixtures share. Table slots follow
 * `executorch/schema/program.fbs`; `assemblePte` reproduces what
 * `serialize_pte_binary` does after the FlatBuffer is built — the extended
 * header inserted after the identifier, and the segments appended at an
 * aligned base offset.
 */
import { FlatBufferBuilder } from '../../tflite/__tests__/fixture.js';

const encoder = new TextEncoder();

export const SEGMENT_ALIGNMENT = 128;

interface TensorSpec {
    type: number;
    sizes: number[];
    dataBufferIndex?: number;
    allocation?: { memoryId: number; offset: number };
    name?: string;
    external?: boolean;
    mutableSegmentIndex?: number;
    shapeDynamism?: number;
    dimOrder?: number[];
    device?: { type: number; index: number };
}

type ValueSpec =
    | { kind: 'Null' }
    | { kind: 'Int'; value: bigint }
    | { kind: 'Bool'; value: boolean }
    | { kind: 'Double'; value: number }
    | { kind: 'String'; value: string }
    | { kind: 'IntList'; value: bigint[] }
    | { kind: 'DoubleList'; value: number[] }
    | { kind: 'BoolList'; value: boolean[] }
    | { kind: 'TensorList'; value: number[] }
    | { kind: 'OptionalTensorList'; value: number[] }
    | { kind: 'Tensor'; value: TensorSpec };

const VALUE_UNION: Record<ValueSpec['kind'], number> = {
    Null: 1, Int: 2, Bool: 3, Double: 4, Tensor: 5, String: 6,
    IntList: 7, DoubleList: 8, BoolList: 9, TensorList: 10, OptionalTensorList: 11
};

type InstructionSpec =
    | { kind: 'KernelCall'; op: number; args: number[] }
    | { kind: 'DelegateCall'; delegate: number; args: number[] }
    | { kind: 'MoveCall'; from: number; to: number }
    | { kind: 'JumpFalseCall'; cond: number; destination: number }
    | { kind: 'FreeCall'; value: number }
    | { kind: 'Unknown' };

const INSTRUCTION_UNION: Record<InstructionSpec['kind'], number> = {
    KernelCall: 1, DelegateCall: 2, MoveCall: 3, JumpFalseCall: 4, FreeCall: 5, Unknown: 9
};

interface FrameSpec { filename: string; line: number; name: string; context: string }

interface ChainSpec {
    inputs?: number[];
    outputs?: number[];
    instructions: InstructionSpec[];
    /** One frame list per instruction (parallel array). */
    stacktrace?: FrameSpec[][];
}

interface DelegateSpec {
    id: string;
    location: 'inline' | 'segment';
    index: number;
    compileSpecs?: Array<{ key: string; value: Uint8Array }>;
}

interface MethodSpec {
    name: string;
    values: ValueSpec[];
    inputs: number[];
    outputs: number[];
    chains: ChainSpec[];
    operators: Array<[name: string, overload: string]>;
    delegates?: DelegateSpec[];
    nonConstBufferSizes?: bigint[];
    inputSpec?: string;
    outputSpec?: string;
}

interface ProgramSpec {
    version?: number;
    methods: MethodSpec[];
    /** Deprecated inline constant buffers (index 0 is the placeholder). */
    constantBuffers?: Uint8Array[];
    delegateInline?: Uint8Array[];
    /** `(offset, size)` pairs relative to the segment base. */
    segments?: Array<[offset: bigint, size: bigint]>;
    constantSegment?: { segmentIndex: number; offsets: bigint[] };
    mutableSegments?: Array<{ segmentIndex: number; offsets: bigint[] }>;
    namedData?: Array<{ key: string; segmentIndex: number }>;
    identifier?: string;
}

function buildTensor(b: FlatBufferBuilder, spec: TensorSpec): number {
    const sizes = b.createIntVector(spec.sizes);
    const dimOrder = b.createByteVector(new Uint8Array(spec.dimOrder ?? spec.sizes.map((_, index) => index)));
    let allocation = 0;
    if (spec.allocation) {
        b.startTable();
        b.addInt32(0, spec.allocation.memoryId);
        b.addInt32(1, spec.allocation.offset);
        allocation = b.endTable();
    }
    let extra = 0;
    if (spec.name !== undefined || spec.external || spec.mutableSegmentIndex !== undefined || spec.device) {
        const name = spec.name !== undefined ? b.createString(spec.name) : 0;
        b.startTable();
        if (spec.mutableSegmentIndex !== undefined) b.addInt64(0, BigInt(spec.mutableSegmentIndex));
        b.addOffset(1, name);
        if (spec.external) b.addInt8(2, 1);
        if (spec.device) { b.addInt8(3, spec.device.type); b.addInt8(4, spec.device.index); }
        extra = b.endTable();
    }
    b.startTable();
    b.addInt8(0, spec.type);
    b.addOffset(2, sizes);
    b.addOffset(3, dimOrder);
    if (spec.dataBufferIndex) b.addInt32(5, spec.dataBufferIndex);
    b.addOffset(6, allocation);
    if (spec.shapeDynamism) b.addInt8(8, spec.shapeDynamism);
    b.addOffset(9, extra);
    return b.endTable();
}

function buildValue(b: FlatBufferBuilder, spec: ValueSpec): number {
    let payload: number;
    switch (spec.kind) {
        case 'Null': b.startTable(); payload = b.endTable(); break;
        case 'Int': b.startTable(); b.addInt64(0, spec.value); payload = b.endTable(); break;
        case 'Bool': b.startTable(); b.addBool(0, spec.value); payload = b.endTable(); break;
        case 'Double': b.startTable(); b.addFloat64(0, spec.value); payload = b.endTable(); break;
        case 'String': { const text = b.createString(spec.value); b.startTable(); b.addOffset(0, text); payload = b.endTable(); break; }
        case 'IntList': { const items = b.createLongVector(spec.value); b.startTable(); b.addOffset(0, items); payload = b.endTable(); break; }
        case 'DoubleList': { const items = b.createDoubleVector(spec.value); b.startTable(); b.addOffset(0, items); payload = b.endTable(); break; }
        case 'BoolList': { const items = b.createByteVector(new Uint8Array(spec.value.map(item => item ? 1 : 0))); b.startTable(); b.addOffset(0, items); payload = b.endTable(); break; }
        case 'TensorList':
        case 'OptionalTensorList': { const items = b.createIntVector(spec.value); b.startTable(); b.addOffset(0, items); payload = b.endTable(); break; }
        case 'Tensor': payload = buildTensor(b, spec.value); break;
    }
    b.startTable();
    b.addInt8(0, VALUE_UNION[spec.kind]);
    b.addOffset(1, payload);
    return b.endTable();
}

function buildInstruction(b: FlatBufferBuilder, spec: InstructionSpec): number {
    let payload = 0;
    switch (spec.kind) {
        case 'KernelCall': { const args = b.createIntVector(spec.args); b.startTable(); b.addInt32(0, spec.op); b.addOffset(1, args); payload = b.endTable(); break; }
        case 'DelegateCall': { const args = b.createIntVector(spec.args); b.startTable(); b.addInt32(0, spec.delegate); b.addOffset(1, args); payload = b.endTable(); break; }
        case 'MoveCall': b.startTable(); b.addInt32(0, spec.from); b.addInt32(1, spec.to); payload = b.endTable(); break;
        case 'JumpFalseCall': b.startTable(); b.addInt32(0, spec.cond); b.addInt32(1, spec.destination); payload = b.endTable(); break;
        case 'FreeCall': b.startTable(); b.addInt32(0, spec.value); payload = b.endTable(); break;
        case 'Unknown': b.startTable(); payload = b.endTable(); break;
    }
    b.startTable();
    b.addInt8(0, INSTRUCTION_UNION[spec.kind]);
    b.addOffset(1, payload);
    return b.endTable();
}

function buildFrameList(b: FlatBufferBuilder, frames: FrameSpec[]): number {
    const items = frames.map(frame => {
        const filename = b.createString(frame.filename);
        const name = b.createString(frame.name);
        const context = b.createString(frame.context);
        b.startTable();
        b.addOffset(0, filename);
        b.addInt32(1, frame.line);
        b.addOffset(2, name);
        b.addOffset(3, context);
        return b.endTable();
    });
    const vector = b.createOffsetVector(items);
    b.startTable();
    b.addOffset(0, vector);
    return b.endTable();
}

function buildChain(b: FlatBufferBuilder, spec: ChainSpec): number {
    const instructions = b.createOffsetVector(spec.instructions.map(instruction => buildInstruction(b, instruction)));
    const stacktrace = spec.stacktrace ? b.createOffsetVector(spec.stacktrace.map(frames => buildFrameList(b, frames))) : 0;
    const inputs = b.createIntVector(spec.inputs ?? []);
    const outputs = b.createIntVector(spec.outputs ?? []);
    b.startTable();
    b.addOffset(0, inputs);
    b.addOffset(1, outputs);
    b.addOffset(2, instructions);
    b.addOffset(3, stacktrace);
    return b.endTable();
}

function buildDelegate(b: FlatBufferBuilder, spec: DelegateSpec): number {
    const id = b.createString(spec.id);
    const specs = b.createOffsetVector((spec.compileSpecs ?? []).map(entry => {
        const key = b.createString(entry.key);
        const value = b.createByteVector(entry.value);
        b.startTable();
        b.addOffset(0, key);
        b.addOffset(1, value);
        return b.endTable();
    }));
    b.startTable();
    if (spec.location === 'segment') b.addInt8(0, 1);
    b.addInt32(1, spec.index);
    const processed = b.endTable();
    b.startTable();
    b.addOffset(0, id);
    b.addOffset(1, processed);
    b.addOffset(2, specs);
    return b.endTable();
}

function buildMethod(b: FlatBufferBuilder, spec: MethodSpec): number {
    const name = b.createString(spec.name);
    let meta = 0;
    if (spec.inputSpec !== undefined || spec.outputSpec !== undefined) {
        const input = b.createString(spec.inputSpec ?? '');
        const output = b.createString(spec.outputSpec ?? '');
        b.startTable();
        b.addOffset(0, input);
        b.addOffset(1, output);
        meta = b.endTable();
    }
    const values = b.createOffsetVector(spec.values.map(value => buildValue(b, value)));
    const inputs = b.createIntVector(spec.inputs);
    const outputs = b.createIntVector(spec.outputs);
    const chains = b.createOffsetVector(spec.chains.map(chain => buildChain(b, chain)));
    const operators = b.createOffsetVector(spec.operators.map(([opName, overload]) => {
        const nameOffset = b.createString(opName);
        const overloadOffset = b.createString(overload);
        b.startTable();
        b.addOffset(0, nameOffset);
        b.addOffset(1, overloadOffset);
        return b.endTable();
    }));
    const delegates = b.createOffsetVector((spec.delegates ?? []).map(delegate => buildDelegate(b, delegate)));
    const sizes = b.createLongVector(spec.nonConstBufferSizes ?? []);
    b.startTable();
    b.addOffset(0, name);
    b.addOffset(1, meta);
    b.addOffset(2, values);
    b.addOffset(3, inputs);
    b.addOffset(4, outputs);
    b.addOffset(5, chains);
    b.addOffset(6, operators);
    b.addOffset(7, delegates);
    b.addOffset(8, sizes);
    return b.endTable();
}

function buildSubsegment(b: FlatBufferBuilder, spec: { segmentIndex: number; offsets: bigint[] }): number {
    const offsets = b.createLongVector(spec.offsets);
    b.startTable();
    b.addInt32(0, spec.segmentIndex);
    b.addOffset(1, offsets);
    return b.endTable();
}

/** Serialize a Program FlatBuffer (no extended header, no segments). */
export function buildProgram(spec: ProgramSpec): Uint8Array {
    const b = new FlatBufferBuilder(4096);
    const methods = b.createOffsetVector(spec.methods.map(method => buildMethod(b, method)));
    const constantBuffers = spec.constantBuffers
        ? b.createOffsetVector(spec.constantBuffers.map(bytes => { const storage = b.createByteVector(bytes); b.startTable(); b.addOffset(0, storage); return b.endTable(); }))
        : 0;
    const delegateInline = spec.delegateInline
        ? b.createOffsetVector(spec.delegateInline.map(bytes => { const data = b.createByteVector(bytes); b.startTable(); b.addOffset(0, data); return b.endTable(); }))
        : 0;
    const segments = spec.segments
        ? b.createOffsetVector(spec.segments.map(([offset, size]) => { b.startTable(); b.addInt64(0, offset); b.addInt64(1, size); return b.endTable(); }))
        : 0;
    const constantSegment = spec.constantSegment ? buildSubsegment(b, spec.constantSegment) : 0;
    const mutableSegments = spec.mutableSegments ? b.createOffsetVector(spec.mutableSegments.map(entry => buildSubsegment(b, entry))) : 0;
    const namedData = spec.namedData
        ? b.createOffsetVector(spec.namedData.map(entry => { const key = b.createString(entry.key); b.startTable(); b.addOffset(0, key); b.addInt32(1, entry.segmentIndex); return b.endTable(); }))
        : 0;
    b.startTable();
    if (spec.version) b.addInt32(0, spec.version);
    b.addOffset(1, methods);
    b.addOffset(2, constantBuffers);
    b.addOffset(3, delegateInline);
    b.addOffset(4, segments);
    b.addOffset(5, constantSegment);
    b.addOffset(6, mutableSegments);
    b.addOffset(7, namedData);
    const program = b.endTable();
    return b.finish(program, spec.identifier ?? 'ET12');
}

const alignUp = (value: number, alignment: number): number => Math.ceil(value / alignment) * alignment;

/**
 * Insert the extended header after the identifier and append the segment
 * data at an aligned base, the way `serialize_pte_binary` lays a file out.
 * `segments` are placed back to back, each aligned to `SEGMENT_ALIGNMENT`.
 */
export function assemblePte(program: Uint8Array, segments: Uint8Array[], options: { headerLength?: number; segmentDataSize?: number } = {}): Uint8Array {
    const headerLength = options.headerLength ?? 32;
    const paddedHeader = alignUp(headerLength, 16);
    const programSize = program.byteLength + paddedHeader;
    const base = alignUp(programSize, SEGMENT_ALIGNMENT);
    let cursor = 0;
    const placements = segments.map(segment => { const at = cursor; cursor = alignUp(at + segment.byteLength, SEGMENT_ALIGNMENT); return at; });
    const dataSize = segments.length ? placements[segments.length - 1]! + segments[segments.length - 1]!.byteLength : 0;
    const file = new Uint8Array(base + dataSize);
    const view = new DataView(file.buffer);
    view.setUint32(0, new DataView(program.buffer, program.byteOffset).getUint32(0, true) + paddedHeader, true);
    file.set(program.subarray(4, 8), 4);
    file.set(encoder.encode('eh00'), 8);
    view.setUint32(12, headerLength, true);
    view.setBigUint64(16, BigInt(programSize), true);
    view.setBigUint64(24, BigInt(base), true);
    if (headerLength >= 32) view.setBigUint64(32, BigInt(options.segmentDataSize ?? dataSize), true);
    file.set(program.subarray(8), 8 + paddedHeader);
    segments.forEach((segment, index) => file.set(segment, base + placements[index]!));
    return file;
}

/** Segment offsets `assemblePte` assigns, so a spec can reference them. */
export function segmentOffsets(sizes: number[]): bigint[] {
    let cursor = 0;
    return sizes.map(size => { const at = cursor; cursor = alignUp(at + size, SEGMENT_ALIGNMENT); return BigInt(at); });
}

const FLOAT = 6;
const LONG = 4;

/**
 * Two methods over four segments:
 * - `forward`: addmm + relu over a segment-stored weight and bias, plus one
 *   value of every other EValue kind, a mutable buffer with initial state in a
 *   mutable data segment, and a tensor stored externally (.ptd).
 * - `delegated`: a single XNNPACK delegate call whose blob sits in segment 1.
 * Segment 2 is a named data blob; segment 3 holds the mutable buffer's state.
 */
export function pteFixture(): Uint8Array {
    const weight = new Uint8Array(48).fill(1);
    const bias = new Uint8Array(12).fill(2);
    const constant = new Uint8Array(80);
    constant.set(weight, 0);
    constant.set(bias, 64);
    const delegateBlob = encoder.encode('XNN0-blob-payload-bytes!');
    const named = encoder.encode('namedblb');
    const mutableState = new Uint8Array(8).fill(3);
    const sizes = [constant.byteLength, delegateBlob.byteLength, named.byteLength, mutableState.byteLength];
    const offsets = segmentOffsets(sizes);
    const program = buildProgram({
        methods: [{
            name: 'forward',
            values: [
                { kind: 'Tensor', value: { type: FLOAT, sizes: [1, 4] } },
                { kind: 'Tensor', value: { type: FLOAT, sizes: [3, 4], dataBufferIndex: 1, name: 'linear.weight' } },
                { kind: 'Tensor', value: { type: FLOAT, sizes: [3], dataBufferIndex: 2, name: 'linear.bias' } },
                { kind: 'Int', value: 1n },
                { kind: 'Tensor', value: { type: FLOAT, sizes: [1, 3], allocation: { memoryId: 1, offset: 0 } } },
                { kind: 'Tensor', value: { type: FLOAT, sizes: [1, 3], allocation: { memoryId: 1, offset: 16 }, shapeDynamism: 1 } },
                { kind: 'IntList', value: [3n, 1n] },
                { kind: 'Double', value: 0.5 },
                { kind: 'Bool', value: true },
                { kind: 'String', value: 'hi' },
                { kind: 'TensorList', value: [4, 5] },
                { kind: 'Null' },
                { kind: 'Tensor', value: { type: FLOAT, sizes: [2], dataBufferIndex: 1, allocation: { memoryId: 1, offset: 32 }, name: 'running_sum', mutableSegmentIndex: 0 } },
                { kind: 'Tensor', value: { type: FLOAT, sizes: [2, 2], name: 'ext.weight', external: true } },
                { kind: 'DoubleList', value: [0.25, 0.75] },
                { kind: 'BoolList', value: [true, false] },
                { kind: 'OptionalTensorList', value: [4, -1] },
                { kind: 'Tensor', value: { type: LONG, sizes: [], allocation: { memoryId: 1, offset: 48 }, device: { type: 1, index: 0 } } }
            ],
            inputs: [0],
            outputs: [5],
            chains: [{
                inputs: [0],
                outputs: [5],
                instructions: [
                    { kind: 'KernelCall', op: 0, args: [2, 0, 1, 3, 3, 4] },
                    { kind: 'KernelCall', op: 1, args: [4, 5] },
                    { kind: 'KernelCall', op: 2, args: [5, 3, 17] }
                ],
                stacktrace: [
                    [{ filename: 'model.py', line: 12, name: 'forward', context: 'return self.linear(x)' }],
                    [{ filename: 'model.py', line: 13, name: 'forward', context: 'return torch.relu(y)' }],
                    []
                ]
            }],
            operators: [['aten::addmm', 'out'], ['aten::relu', 'out'], ['aten::argmax', 'out']],
            nonConstBufferSizes: [0n, 64n],
            inputSpec: 'TreeSpec(tuple, None, [*])',
            outputSpec: 'TreeSpec(tuple, None, [*])'
        }, {
            name: 'delegated',
            values: [
                { kind: 'Tensor', value: { type: FLOAT, sizes: [1, 4] } },
                { kind: 'Tensor', value: { type: FLOAT, sizes: [1, 3], allocation: { memoryId: 1, offset: 0 } } }
            ],
            inputs: [0],
            outputs: [1],
            chains: [{ instructions: [{ kind: 'DelegateCall', delegate: 0, args: [0, 1] }] }],
            operators: [],
            delegates: [{
                id: 'XnnpackBackend',
                location: 'segment',
                index: 1,
                compileSpecs: [{ key: 'is_dynamic', value: encoder.encode('false') }, { key: 'blob', value: new Uint8Array([0, 1, 2]) }]
            }],
            nonConstBufferSizes: [0n, 16n]
        }],
        segments: sizes.map((size, index) => [offsets[index]!, BigInt(size)]),
        constantSegment: { segmentIndex: 0, offsets: [0n, 0n, 64n] },
        mutableSegments: [{ segmentIndex: 3, offsets: [0n, 0n] }],
        namedData: [{ key: 'shared_blob', segmentIndex: 2 }]
    });
    return assemblePte(program, [constant, delegateBlob, named, mutableState]);
}

/**
 * A pre-segment file: constants inline in `constant_buffer`, an inline
 * delegate blob, no extended header, and a chain exercising every
 * control-flow instruction plus an instruction of an unknown kind.
 */
export function pteInlineFixture(): Uint8Array {
    return buildProgram({
        methods: [{
            name: 'forward',
            values: [
                { kind: 'Tensor', value: { type: FLOAT, sizes: [2] } },
                { kind: 'Tensor', value: { type: FLOAT, sizes: [2], dataBufferIndex: 1, name: 'w' } },
                { kind: 'Tensor', value: { type: FLOAT, sizes: [2], allocation: { memoryId: 1, offset: 0 } } },
                { kind: 'Bool', value: true },
                { kind: 'Tensor', value: { type: FLOAT, sizes: [2], allocation: { memoryId: 1, offset: 8 } } },
                { kind: 'Tensor', value: { type: FLOAT, sizes: [2], allocation: { memoryId: 1, offset: 16 } } }
            ],
            inputs: [0],
            outputs: [5],
            chains: [{
                instructions: [
                    { kind: 'KernelCall', op: 0, args: [0, 1, 2] },
                    { kind: 'JumpFalseCall', cond: 3, destination: 4 },
                    { kind: 'DelegateCall', delegate: 0, args: [2, 4] },
                    { kind: 'MoveCall', from: 4, to: 5 },
                    { kind: 'FreeCall', value: 2 },
                    { kind: 'Unknown' }
                ]
            }],
            operators: [['aten::mul', 'out']],
            delegates: [{ id: 'CustomBackend', location: 'inline', index: 0 }]
        }],
        constantBuffers: [new Uint8Array(0), new Uint8Array(8).fill(7)],
        delegateInline: [encoder.encode('inline-delegate')]
    });
}

/** Segments declared with an extended header that points past the end of the file. */
export function pteTruncatedSegmentsFixture(): Uint8Array {
    const program = buildProgram({
        methods: [{
            name: 'forward',
            values: [{ kind: 'Tensor', value: { type: FLOAT, sizes: [4], dataBufferIndex: 1, name: 'w' } }],
            inputs: [],
            outputs: [0],
            chains: [],
            operators: []
        }],
        segments: [[0n, 16n]],
        constantSegment: { segmentIndex: 0, offsets: [0n, 0n] }
    });
    const full = assemblePte(program, [new Uint8Array(16)]);
    return full.subarray(0, full.byteLength - 8);
}

/** Segments declared without any extended header to locate them. */
export function pteHeaderlessSegmentsFixture(): Uint8Array {
    return buildProgram({
        methods: [{
            name: 'forward',
            values: [{ kind: 'Tensor', value: { type: FLOAT, sizes: [4], dataBufferIndex: 1, name: 'w' } }],
            inputs: [],
            outputs: [0],
            chains: [],
            operators: []
        }],
        segments: [[0n, 16n]],
        constantSegment: { segmentIndex: 0, offsets: [0n, 0n] }
    });
}

export function pteForeignIdentifierFixture(): Uint8Array {
    return buildProgram({ identifier: 'ET99', methods: [] });
}
