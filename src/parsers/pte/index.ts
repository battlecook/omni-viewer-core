/**
 * Dependency-free ExecuTorch program (`.pte`) reader.
 *
 * A `.pte` is a FlatBuffer following `executorch/schema/program.fbs` (file
 * identifier `ET12`), optionally followed by data segments — constant
 * tensors, delegate blobs, mutable initial state, named blobs — that the
 * extended header (`eh00`, inserted right after the identifier) locates.
 * Segment payloads are never decoded: the reader keeps the methods, their
 * values, instructions, operators and delegates, and where every byte of
 * data lives. Vtable slots follow the normative schema.
 */

export interface PteSummaryItem { labelKey: string; value: string | number }
export interface PteWarning { key: string; args?: Record<string, string | number> }

/**
 * Where a tensor's bytes come from:
 * - `inline`: `Program.constant_buffer` (pre-2024-09 writers)
 * - `segment`: the constant data segment addressed by `constant_segment`
 * - `mutable`: initial state in a `mutable_data_segments` entry
 * - `external`: a separate `.ptd` file, keyed by the tensor's name
 * - `planned`: a memory-planned activation (no data in the file)
 * - `runtime`: a value the caller or an instruction supplies at run time
 */
export type PteTensorStorage = 'inline' | 'segment' | 'mutable' | 'external' | 'planned' | 'runtime';

export type PteValueKind =
    | 'Null' | 'Int' | 'Bool' | 'Double' | 'Tensor' | 'String'
    | 'IntList' | 'DoubleList' | 'BoolList' | 'TensorList' | 'OptionalTensorList';

export interface PteAllocation { memoryId: number; memoryOffset: string }

export interface PteTensor {
    scalarType: string;
    sizes: number[];
    dimOrder: number[];
    storageOffset: number;
    requiresGrad: boolean;
    dataBufferIndex: number;
    allocation?: PteAllocation;
    layout: number;
    shapeDynamism: string;
    /** `fully_qualified_name`, e.g. `linear.weight`; empty for activations. */
    name: string;
    storage: PteTensorStorage;
    /** Segment carrying the payload for `segment` / `mutable` storage. */
    segmentIndex: number;
    /** Absolute file offset of the payload, empty when there is none in the file. */
    fileOffset: string;
    /**
     * Bytes reserved for this tensor: exact for inline storage, the
     * alignment-padded slot for segment storage, empty when unknowable.
     */
    dataBytes: string;
    /** Bytes the scalar type and sizes imply; empty when unknowable. */
    expectedBytes: string;
    elementCount: string;
    /** `cuda:1` and the like; empty for the default CPU placement. */
    device: string;
    /**
     * Earlier value whose memory-planned slot this tensor shares: the emitter
     * gives a view or alias node its own EValue, so an instruction may read a
     * tensor nothing wrote — its bytes are those of `aliasOf`. Always the
     * terminal value of a chain of such aliases, never another alias.
     */
    aliasOf?: number;
}

export interface PteValue {
    index: number;
    kind: PteValueKind;
    /** Scalar values, capped list previews, or tensor type + shape. */
    preview: string;
    tensor?: PteTensor;
    /**
     * EValue indices for the boxed lists: `TensorList` / `OptionalTensorList`
     * (`-1` = None) and `IntList`, whose items point at `Int` values so that a
     * runtime-determined SymInt can sit in a list.
     */
    items?: number[];
}

export interface PteOperator {
    index: number;
    name: string;
    overload: string;
    /** `name.overload`, the form kernel registries use. */
    label: string;
}

export interface PteCompileSpec { key: string; value: string; bytes: number }

export interface PteDelegate {
    index: number;
    /** Backend id, e.g. `XnnpackBackend`. */
    id: string;
    location: 'inline' | 'segment';
    /** Index into `backend_delegate_data` or `segments`, per `location`. */
    dataIndex: number;
    dataBytes: string;
    fileOffset: string;
    compileSpecs: PteCompileSpec[];
}

export type PteInstructionKind = 'KernelCall' | 'DelegateCall' | 'MoveCall' | 'JumpFalseCall' | 'FreeCall' | 'Unknown';

export interface PteFrame { filename: string; line: number; name: string; context: string }

export interface PteInstruction {
    id: string;
    /** Position within the method's flattened instruction list. */
    index: number;
    chain: number;
    /** Position within the chain — what `JumpFalseCall.destination` targets. */
    chainIndex: number;
    kind: PteInstructionKind;
    /** Operator label, backend id, or the call kind for the other calls. */
    label: string;
    operatorIndex: number;
    delegateIndex: number;
    /** EValue indices exactly as stored (kernel / delegate calls). */
    args: number[];
    /** `args` split by data flow: out-variant kernels write their trailing arguments. */
    inputs: number[];
    outputs: number[];
    /** `JumpFalseCall` target within the chain, `-1` otherwise. */
    destination: number;
    frames: PteFrame[];
}

export interface PteChain { index: number; inputs: number[]; outputs: number[]; instructionCount: number }

export interface PteMethod {
    index: number;
    name: string;
    values: PteValue[];
    inputs: number[];
    outputs: number[];
    chains: PteChain[];
    instructions: PteInstruction[];
    operators: PteOperator[];
    delegates: PteDelegate[];
    /** Memory-planned arena sizes, one per memory id. */
    nonConstBufferSizes: string[];
    /** pytree specs of the traced module's inputs and outputs. */
    inputSpec: string;
    outputSpec: string;
    tensorCount: number;
    constantCount: number;
}

export type PteSegmentKind = 'constant' | 'mutable' | 'delegate' | 'named' | 'unused';

export interface PteSegment {
    index: number;
    /** Offset relative to the segment base, as the file stores it. */
    offset: string;
    /** Absolute file offset, empty when no extended header locates the base. */
    fileOffset: string;
    size: string;
    kind: PteSegmentKind;
    /** False when the segment extends past the end of the file. */
    inRange: boolean;
    usedBy: string[];
}

export interface PteNamedData { key: string; segmentIndex: number; size: string }

export interface PteExtendedHeader {
    length: number;
    programSize: string;
    segmentBaseOffset: string;
    /** Empty for the 24-byte header older writers emit, which has no such field. */
    segmentDataSize: string;
}

export interface PteDocument {
    format: 'pte';
    title: string;
    fileSize: string;
    identifier: string;
    version: string;
    extendedHeader?: PteExtendedHeader;
    methods: PteMethod[];
    segments: PteSegment[];
    namedData: PteNamedData[];
    /** Distinct backend ids across every method's delegates. */
    backends: string[];
    /** Inline `constant_buffer` payloads, excluding the mandatory index-0 placeholder. */
    constantBufferCount: number;
    /** Constant tensor bytes stored in the file (inline or in the constant segment). */
    constantBytes: string;
    /** Delegate blob bytes stored in the file (inline or in segments). */
    delegateBytes: string;
    /** Bytes in the segments `named_data` entries point at, counted once per segment. */
    namedDataBytes: string;
    summary: PteSummaryItem[];
    warnings: PteWarning[];
}

export class PteParseError extends Error {
    override readonly name = 'PteParseError';
}

const MAX_DEPTH = 64;
const MAX_OBJECTS = 400_000;
const MAX_ITEMS = 100_000;
/** Whole-file ceiling on decoded vector elements; byte payloads are never decoded. */
const MAX_TOTAL_ITEMS = 8_000_000;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_TOTAL_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_LIST_PREVIEW = 16;
const MAX_TENSOR_RANK = 1024;
/** Beyond this the count is not a real tensor, and wide bigints get slow. */
const MAX_TENSOR_PRODUCT_BITS = 128;
const MAX_COMPILE_SPEC_TEXT = 256;
const MAX_FRAMES = 8;
/** Stack traces are decoded for the leading instructions only; later ones keep none. */
const MAX_TRACED_INSTRUCTIONS = 2000;
const MAX_SPEC_TEXT = 4096;
const FILE_IDENTIFIER = 'ET12';
const EXTENDED_HEADER_MAGIC = 'eh00';
const EXTENDED_HEADER_OFFSET = 8;
const EXTENDED_HEADER_MIN_LENGTH = 24;
const decoder = new TextDecoder('utf-8');

/** `executorch_flatbuffer.ScalarType`, which mirrors c10's numbering. */
const SCALAR_TYPES: Record<number, string> = {
    0: 'BYTE', 1: 'CHAR', 2: 'SHORT', 3: 'INT', 4: 'LONG', 5: 'HALF', 6: 'FLOAT', 7: 'DOUBLE',
    8: 'COMPLEXHALF', 9: 'COMPLEXFLOAT', 10: 'COMPLEXDOUBLE', 11: 'BOOL', 12: 'QINT8', 13: 'QUINT8',
    14: 'QINT32', 15: 'BFLOAT16', 16: 'QUINT4X2', 17: 'QUINT2X4', 18: 'BITS1X8', 19: 'BITS2X4',
    20: 'BITS4X2', 21: 'BITS8', 22: 'BITS16', 23: 'FLOAT8E5M2', 24: 'FLOAT8E4M3FN',
    25: 'FLOAT8E5M2FNUZ', 26: 'FLOAT8E4M3FNUZ', 27: 'UINT16', 28: 'UINT32', 29: 'UINT64',
    30: 'UINT1', 31: 'UINT2', 32: 'UINT3', 33: 'UINT4', 34: 'UINT5', 35: 'UINT6', 36: 'UINT7',
    37: 'INT1', 38: 'INT2', 39: 'INT3', 40: 'INT4', 41: 'INT5', 42: 'INT6', 43: 'INT7',
    44: 'FLOAT8E8M0FNU', 45: 'FLOAT4E2M1FNX2'
};

/** Bits per element; packed sub-byte types count the bits one element occupies. */
const SCALAR_BITS: Record<number, number> = {
    0: 8, 1: 8, 2: 16, 3: 32, 4: 64, 5: 16, 6: 32, 7: 64, 8: 32, 9: 64, 10: 128, 11: 8,
    12: 8, 13: 8, 14: 32, 15: 16, 16: 4, 17: 2, 18: 1, 19: 2, 20: 4, 21: 8, 22: 16,
    23: 8, 24: 8, 25: 8, 26: 8, 27: 16, 28: 32, 29: 64,
    30: 8, 31: 8, 32: 8, 33: 8, 34: 8, 35: 8, 36: 8, 37: 8, 38: 8, 39: 8, 40: 8, 41: 8, 42: 8, 43: 8,
    44: 8, 45: 4
};

const VALUE_KINDS: Record<number, PteValueKind> = {
    1: 'Null', 2: 'Int', 3: 'Bool', 4: 'Double', 5: 'Tensor', 6: 'String',
    7: 'IntList', 8: 'DoubleList', 9: 'BoolList', 10: 'TensorList', 11: 'OptionalTensorList'
};

const INSTRUCTION_KINDS: Record<number, PteInstructionKind> = {
    1: 'KernelCall', 2: 'DelegateCall', 3: 'MoveCall', 4: 'JumpFalseCall', 5: 'FreeCall'
};

const SHAPE_DYNAMISM: Record<number, string> = { 0: 'STATIC', 1: 'DYNAMIC_BOUND', 2: 'DYNAMIC_UNBOUND' };
const DEVICE_TYPES: Record<number, string> = { 0: 'cpu', 1: 'cuda' };
const TENSOR_DATA_LOCATION_EXTERNAL = 1;
/** The one lowered-loop kernel the emitter writes without a trailing return: `(accumulator, slice, index)`. */
const COPY_INDEX_OPERATOR = 'executorch_prim::et_copy_index.tensor';
const DELEGATE_DATA_SEGMENT = 1;

interface ParseState { objects: number; textBytes: number; items: number }

/** A capped view of a vector plus the length the file declared. */
interface Preview<T> { values: T[]; length: number }

class FlatBufferReader {
    private readonly view: DataView;

    constructor(readonly bytes: Uint8Array, readonly state: ParseState) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    require(offset: number, size: number): void {
        if (!Number.isSafeInteger(offset) || offset < 0 || size < 0 || offset + size > this.bytes.byteLength) {
            throw new PteParseError('ExecuTorch FlatBuffer offset is out of range.');
        }
    }

    claimObject(): void {
        if (++this.state.objects > MAX_OBJECTS) throw new PteParseError('ExecuTorch normalized-object limit exceeded.');
    }

    /**
     * Charge decoded vector elements against a whole-file budget. Per-vector
     * caps alone are not enough: FlatBuffers lets many tables share one vector
     * offset, so a small file can otherwise ask for tables × elements values.
     */
    claimItems(count: number): void {
        this.state.items += count;
        if (this.state.items > MAX_TOTAL_ITEMS) throw new PteParseError('ExecuTorch decoded-element limit exceeded.');
    }

    i8(offset: number): number { this.require(offset, 1); return this.view.getInt8(offset); }
    u8(offset: number): number { this.require(offset, 1); return this.view.getUint8(offset); }
    u16(offset: number): number { this.require(offset, 2); return this.view.getUint16(offset, true); }
    i32(offset: number): number { this.require(offset, 4); return this.view.getInt32(offset, true); }
    u32(offset: number): number { this.require(offset, 4); return this.view.getUint32(offset, true); }
    i64(offset: number): bigint { this.require(offset, 8); return this.view.getBigInt64(offset, true); }
    u64(offset: number): bigint { this.require(offset, 8); return this.view.getBigUint64(offset, true); }
    f64(offset: number): number { this.require(offset, 8); return this.view.getFloat64(offset, true); }

    /** Follow a uoffset stored at `offset` to the object it points at. */
    indirect(offset: number): number {
        const target = offset + this.u32(offset);
        this.require(target, 0);
        return target;
    }

    text(start: number, length: number): string {
        if (length > MAX_TEXT_BYTES) throw new PteParseError('ExecuTorch text field exceeds the per-field limit.');
        this.state.textBytes += length;
        if (this.state.textBytes > MAX_TOTAL_TEXT_BYTES) throw new PteParseError('ExecuTorch cumulative text limit exceeded.');
        this.require(start, length);
        return decoder.decode(this.bytes.subarray(start, start + length));
    }
}

/** One FlatBuffers table: a vtable lookup plus bounds-checked field accessors. */
class Table {
    private readonly vtable: number;
    private readonly vtableBytes: number;

    constructor(readonly fb: FlatBufferReader, readonly pos: number, readonly depth: number) {
        if (depth > MAX_DEPTH) throw new PteParseError('ExecuTorch FlatBuffer nesting is too deep.');
        fb.claimObject();
        const vtable = pos - fb.i32(pos);
        if (vtable < 0) throw new PteParseError('ExecuTorch table points at an invalid vtable.');
        this.vtable = vtable;
        this.vtableBytes = fb.u16(vtable);
        if (this.vtableBytes < 4) throw new PteParseError('ExecuTorch vtable is too short.');
        fb.require(vtable, this.vtableBytes);
    }

    /** Absolute position of a field, or 0 when the slot is absent. */
    field(slot: number): number {
        const entry = 4 + slot * 2;
        if (entry + 2 > this.vtableBytes) return 0;
        const relative = this.fb.u16(this.vtable + entry);
        return relative === 0 ? 0 : this.pos + relative;
    }

    bool(slot: number, fallback = false): boolean {
        const at = this.field(slot);
        return at ? this.fb.u8(at) !== 0 : fallback;
    }

    byte(slot: number, fallback = 0): number {
        const at = this.field(slot);
        return at ? this.fb.i8(at) : fallback;
    }

    ubyte(slot: number, fallback = 0): number {
        const at = this.field(slot);
        return at ? this.fb.u8(at) : fallback;
    }

    int(slot: number, fallback = 0): number {
        const at = this.field(slot);
        return at ? this.fb.i32(at) : fallback;
    }

    uint(slot: number, fallback = 0): number {
        const at = this.field(slot);
        return at ? this.fb.u32(at) : fallback;
    }

    long(slot: number, fallback = 0n): bigint {
        const at = this.field(slot);
        return at ? this.fb.i64(at) : fallback;
    }

    ulong(slot: number, fallback = 0n): bigint {
        const at = this.field(slot);
        return at ? this.fb.u64(at) : fallback;
    }

    double(slot: number, fallback = 0): number {
        const at = this.field(slot);
        return at ? this.fb.f64(at) : fallback;
    }

    string(slot: number): string {
        const at = this.field(slot);
        if (!at) return '';
        const start = this.fb.indirect(at);
        return this.fb.text(start + 4, this.fb.u32(start));
    }

    table(slot: number): Table | undefined {
        const at = this.field(slot);
        return at ? new Table(this.fb, this.fb.indirect(at), this.depth + 1) : undefined;
    }

    /**
     * Element start and count for a vector field, validated against the buffer.
     * No item cap here: a constant `Buffer` is a byte vector whose length is the
     * whole payload, and the bounds check already ties any declared length to
     * bytes that actually exist in the file.
     */
    vector(slot: number, elementSize: number): { start: number; length: number } | undefined {
        const at = this.field(slot);
        if (!at) return undefined;
        const start = this.fb.indirect(at);
        const length = this.fb.u32(start);
        this.fb.require(start + 4, length * elementSize);
        return { start: start + 4, length };
    }

    /** Structural int vector: an over-long declaration is an error, not a preview. */
    intVector(slot: number, limit = MAX_ITEMS): number[] {
        const vector = this.vector(slot, 4);
        if (!vector) return [];
        if (vector.length > limit) throw new PteParseError('ExecuTorch vector item limit exceeded.');
        this.fb.claimItems(vector.length);
        const values: number[] = [];
        for (let index = 0; index < vector.length; index++) values.push(this.fb.i32(vector.start + index * 4));
        return values;
    }

    /** Structural unsigned 64-bit vector (segment and subsegment offsets). */
    ulongVector(slot: number, limit = MAX_ITEMS): bigint[] {
        const vector = this.vector(slot, 8);
        if (!vector) return [];
        if (vector.length > limit) throw new PteParseError('ExecuTorch vector item limit exceeded.');
        this.fb.claimItems(vector.length);
        const values: bigint[] = [];
        for (let index = 0; index < vector.length; index++) values.push(this.fb.u64(vector.start + index * 8));
        return values;
    }

    /** Structural signed 64-bit vector (boxed int-list items are EValue indices). */
    longVector(slot: number, limit = MAX_ITEMS): bigint[] {
        const vector = this.vector(slot, 8);
        if (!vector) return [];
        if (vector.length > limit) throw new PteParseError('ExecuTorch vector item limit exceeded.');
        this.fb.claimItems(vector.length);
        const values: bigint[] = [];
        for (let index = 0; index < vector.length; index++) values.push(this.fb.i64(vector.start + index * 8));
        return values;
    }

    ubyteVector(slot: number, limit = MAX_ITEMS): number[] {
        const vector = this.vector(slot, 1);
        if (!vector) return [];
        if (vector.length > limit) throw new PteParseError('ExecuTorch vector item limit exceeded.');
        this.fb.claimItems(vector.length);
        const values: number[] = [];
        for (let index = 0; index < vector.length; index++) values.push(this.fb.u8(vector.start + index));
        return values;
    }

    /**
     * Display-only vectors: capped at `limit`, but the declared `length` comes
     * back too so callers can report an exact remainder rather than inventing
     * one from the capped array.
     */
    longVectorPreview(slot: number, limit: number): Preview<string> {
        return this.previewVector(slot, 8, limit, (start, index) => this.fb.i64(start + index * 8).toString());
    }

    doubleVectorPreview(slot: number, limit: number): Preview<number> {
        return this.previewVector(slot, 8, limit, (start, index) => this.fb.f64(start + index * 8));
    }

    boolVectorPreview(slot: number, limit: number): Preview<boolean> {
        return this.previewVector(slot, 1, limit, (start, index) => this.fb.u8(start + index) !== 0);
    }

    private previewVector<T>(slot: number, size: number, limit: number, read: (start: number, index: number) => T): Preview<T> {
        const vector = this.vector(slot, size);
        if (!vector) return { values: [], length: 0 };
        const shown = Math.min(vector.length, limit);
        this.fb.claimItems(shown);
        const values: T[] = [];
        for (let index = 0; index < shown; index++) values.push(read(vector.start, index));
        return { values, length: vector.length };
    }

    /** Byte-vector extent without copying the payload. */
    byteVector(slot: number): { start: number; length: number } | undefined {
        return this.vector(slot, 1);
    }

    tableVector(slot: number, limit = MAX_ITEMS): Table[] {
        const vector = this.vector(slot, 4);
        if (!vector) return [];
        if (vector.length > limit) throw new PteParseError('ExecuTorch vector item limit exceeded.');
        return this.readTables(vector, vector.length);
    }

    /** The leading `count` tables of a vector; the rest are never constructed or charged. */
    tableVectorHead(slot: number, count: number): Table[] {
        const vector = this.vector(slot, 4);
        if (!vector) return [];
        return this.readTables(vector, Math.min(count, vector.length));
    }

    private readTables(vector: { start: number; length: number }, count: number): Table[] {
        this.fb.claimItems(count);
        const tables: Table[] = [];
        for (let index = 0; index < count; index++) {
            const at = vector.start + index * 4;
            tables.push(new Table(this.fb, this.fb.indirect(at), this.depth + 1));
        }
        return tables;
    }
}

interface SegmentRecord {
    offset: bigint;
    size: bigint;
    /** Absolute payload position, undefined without an extended header. */
    fileOffset?: bigint;
    inRange: boolean;
    kind: PteSegmentKind;
    usedBy: string[];
}

interface SubsegmentOffsets { segmentIndex: number; offsets: bigint[] }

/** Everything a tensor needs to resolve its `data_buffer_idx` to bytes. */
interface DataIndex {
    /** Inline `constant_buffer` storage extents, index 0 being the placeholder. */
    inline: Array<{ start: number; length: number }>;
    constantSegment?: SubsegmentOffsets;
    mutableSegments: SubsegmentOffsets[];
    segments: SegmentRecord[];
    counters: { external: number; missing: number; unknownTypes: number; missingSegments: number };
}

/** Parse an ExecuTorch program without decoding segment or buffer payloads. */
export function parsePte(data: Uint8Array): PteDocument {
    if (data.byteLength < 8) throw new PteParseError('The file is too small to be an ExecuTorch program.');
    const fb = new FlatBufferReader(data, { objects: 0, textBytes: 0, items: 0 });
    const identifier = readIdentifier(data);
    const extendedHeader = readExtendedHeader(fb);
    const rootOffset = fb.u32(0);
    if (rootOffset < 4 || rootOffset >= data.byteLength) throw new PteParseError('The ExecuTorch root table offset is out of range.');
    const program = new Table(fb, rootOffset, 0);

    const version = program.uint(0);
    const segmentBase = extendedHeader ? toBigInt(extendedHeader.segmentBaseOffset) : undefined;
    const segments = program.tableVector(4).map((table): SegmentRecord => {
        const offset = table.ulong(0);
        const size = table.ulong(1);
        const fileOffset = segmentBase === undefined ? undefined : segmentBase + offset;
        return {
            offset,
            size,
            ...(fileOffset === undefined ? {} : { fileOffset }),
            inRange: fileOffset !== undefined && fileOffset + size <= BigInt(data.byteLength),
            kind: 'unused',
            usedBy: []
        };
    });
    const constantSegment = readSubsegmentOffsets(program.table(5));
    const mutableSegments = program.tableVector(6).map(readSubsegmentOffsets).filter((entry): entry is SubsegmentOffsets => entry !== undefined);
    const inline = program.tableVector(2).map(table => table.byteVector(0) ?? { start: 0, length: 0 });
    const delegateInline = program.tableVector(3).map(table => table.byteVector(0) ?? { start: 0, length: 0 });
    // Counted while the segments are walked; the index this feeds is built below.
    const missingSegments = { count: 0 };
    const namedData = program.tableVector(7).map((table): PteNamedData => {
        const segmentIndex = table.uint(1);
        const key = table.string(0);
        const segment = segments[segmentIndex];
        if (segment) { segment.kind = 'named'; segment.usedBy.push(key); }
        else missingSegments.count++;
        // An entry naming a segment the program never declared has no size to report.
        return { key, segmentIndex, size: segment ? segment.size.toString() : '' };
    });
    const claim = (entry: SubsegmentOffsets | undefined, kind: PteSegmentKind, user: string): void => {
        const segment = entry && segments[entry.segmentIndex];
        if (!segment) return;
        segment.kind = kind;
        segment.usedBy.push(user);
    };
    claim(constantSegment, 'constant', 'constant_segment');
    mutableSegments.forEach((entry, index) => claim(entry, 'mutable', `mutable_data_segments[${index}]`));

    const index: DataIndex = {
        inline,
        ...(constantSegment ? { constantSegment } : {}),
        mutableSegments,
        segments,
        counters: { external: 0, missing: 0, unknownTypes: 0, missingSegments: missingSegments.count }
    };
    const unknown = { instructions: 0, values: 0 };
    const methods = program.tableVector(1).map((table, methodIndex) =>
        parseMethod(table, methodIndex, fb, index, delegateInline, unknown));

    const primary = methods[0];
    const instructionCount = methods.reduce((total, method) => total + method.instructions.length, 0);
    const tensorCount = methods.reduce((total, method) => total + method.tensorCount, 0);
    const operatorCount = methods.reduce((total, method) => total + method.operators.length, 0);
    const delegateCount = methods.reduce((total, method) => total + method.delegates.length, 0);
    const backends = [...new Set(methods.flatMap(method => method.delegates.map(delegate => delegate.id)))];
    const constantBytes = constantSegment && segments[constantSegment.segmentIndex]
        ? segments[constantSegment.segmentIndex]!.size
        : inline.reduce((total, buffer) => total + BigInt(buffer.length), 0n);
    // The serializer stores identical delegate payloads once, so two delegates
    // (in one method or across methods) can share a blob; count each blob once.
    const delegateBlobs = new Map<string, bigint>();
    for (const delegate of methods.flatMap(method => method.delegates)) {
        delegateBlobs.set(`${delegate.location}:${delegate.dataIndex}`, toBigInt(delegate.dataBytes));
    }
    const delegateBytes = [...delegateBlobs.values()].reduce((total, bytes) => total + bytes, 0n);
    // Several keys can name one segment, so each segment counts once.
    const namedSegments = new Map<number, bigint>();
    for (const entry of namedData) {
        const segment = segments[entry.segmentIndex];
        if (segment) namedSegments.set(entry.segmentIndex, segment.size);
    }
    const namedDataBytes = [...namedSegments.values()].reduce((total, bytes) => total + bytes, 0n);

    const warnings: PteWarning[] = [];
    if (identifier !== FILE_IDENTIFIER) warnings.push({ key: 'pte.warning.identifier', args: { identifier: identifier || '—' } });
    if (methods.length === 0) warnings.push({ key: 'pte.warning.noMethods' });
    else if (instructionCount === 0) warnings.push({ key: 'pte.warning.noInstructions' });
    if (segments.length > 0 && !extendedHeader) warnings.push({ key: 'pte.warning.headerMissing', args: { count: segments.length } });
    const outOfRange = extendedHeader ? segments.filter(segment => !segment.inRange).length : 0;
    if (outOfRange > 0) warnings.push({ key: 'pte.warning.segmentsOutOfRange', args: { count: outOfRange } });
    if (backends.length > 0) warnings.push({ key: 'pte.warning.delegates', args: { count: delegateCount, names: preview(backends, 8) } });
    if (index.counters.external > 0) warnings.push({ key: 'pte.warning.externalTensors', args: { count: index.counters.external } });
    if (index.counters.missing > 0) warnings.push({ key: 'pte.warning.missingData', args: { count: index.counters.missing } });
    if (index.counters.missingSegments > 0) warnings.push({ key: 'pte.warning.missingSegments', args: { count: index.counters.missingSegments } });
    if (index.counters.unknownTypes > 0) warnings.push({ key: 'pte.warning.unknownScalarTypes', args: { count: index.counters.unknownTypes } });
    if (unknown.values > 0) warnings.push({ key: 'pte.warning.unknownValueKinds', args: { count: unknown.values } });
    if (unknown.instructions > 0) warnings.push({ key: 'pte.warning.unknownInstructions', args: { count: unknown.instructions } });

    return {
        format: 'pte',
        title: primary?.name ?? '',
        fileSize: formatFileSize(data.byteLength),
        identifier,
        version: String(version),
        ...(extendedHeader ? { extendedHeader } : {}),
        methods,
        segments: segments.map((segment, segmentIndex): PteSegment => ({
            index: segmentIndex,
            offset: segment.offset.toString(),
            fileOffset: segment.fileOffset?.toString() ?? '',
            size: segment.size.toString(),
            kind: segment.kind,
            inRange: segment.inRange,
            usedBy: segment.usedBy
        })),
        namedData,
        backends,
        constantBufferCount: Math.max(0, inline.length - 1),
        constantBytes: constantBytes.toString(),
        delegateBytes: delegateBytes.toString(),
        namedDataBytes: namedDataBytes.toString(),
        summary: [
            { labelKey: 'pte.summary.methods', value: methods.length },
            { labelKey: 'pte.summary.instructions', value: instructionCount },
            { labelKey: 'pte.summary.operators', value: operatorCount },
            { labelKey: 'pte.summary.tensors', value: tensorCount },
            { labelKey: 'pte.summary.delegates', value: delegateCount },
            { labelKey: 'pte.summary.constants', value: formatFileSize(constantBytes) }
        ],
        warnings
    };
}

function readIdentifier(data: Uint8Array): string {
    let identifier = '';
    for (let index = 4; index < 8; index++) {
        const byte = data[index]!;
        if (byte < 0x20 || byte > 0x7e) return '';
        identifier += String.fromCharCode(byte);
    }
    return identifier;
}

/**
 * The serializer inserts the extended header right after the file identifier
 * only when the program carries segments; a segment-free file has none and
 * its FlatBuffer simply continues at offset 8.
 */
function readExtendedHeader(fb: FlatBufferReader): PteExtendedHeader | undefined {
    const at = EXTENDED_HEADER_OFFSET;
    if (fb.bytes.byteLength < at + EXTENDED_HEADER_MIN_LENGTH) return undefined;
    for (let index = 0; index < 4; index++) {
        if (fb.bytes[at + index] !== EXTENDED_HEADER_MAGIC.charCodeAt(index)) return undefined;
    }
    const length = fb.u32(at + 4);
    if (length < EXTENDED_HEADER_MIN_LENGTH) return undefined;
    const programSize = fb.u64(at + 8);
    const segmentBaseOffset = fb.u64(at + 16);
    // The segment data size postdates the format; shorter headers omit it.
    const segmentDataSize = length >= 32 && fb.bytes.byteLength >= at + 32 ? fb.u64(at + 24) : undefined;
    return {
        length,
        programSize: programSize.toString(),
        segmentBaseOffset: segmentBaseOffset.toString(),
        segmentDataSize: segmentDataSize?.toString() ?? ''
    };
}

function readSubsegmentOffsets(table: Table | undefined): SubsegmentOffsets | undefined {
    if (!table) return undefined;
    return { segmentIndex: table.uint(0), offsets: table.ulongVector(1) };
}

function parseMethod(
    table: Table,
    methodIndex: number,
    fb: FlatBufferReader,
    index: DataIndex,
    delegateInline: Array<{ start: number; length: number }>,
    unknown: { instructions: number; values: number }
): PteMethod {
    const name = table.string(0);
    const meta = table.table(1);
    const values = table.tableVector(2).map((value, valueIndex) => parseValue(value, valueIndex, index, unknown));
    for (const value of values) {
        if (value.kind !== 'IntList' || !value.items) continue;
        const shown = value.items.slice(0, MAX_LIST_PREVIEW).map(item => {
            const target = values[item];
            return target?.kind === 'Int' ? target.preview : `#${item}`;
        });
        value.preview = `[${shown.join(', ')}${value.items.length > shown.length ? `, … (+${value.items.length - shown.length})` : ''}]`;
    }
    const inputs = table.intVector(3);
    const outputs = table.intVector(4);
    const operators = table.tableVector(6).map((operator, operatorIndex): PteOperator => {
        const opName = operator.string(0);
        const overload = operator.string(1);
        return { index: operatorIndex, name: opName, overload, label: overload ? `${opName}.${overload}` : opName };
    });
    const delegates = table.tableVector(7).map((delegate, delegateIndex) => parseDelegate(delegate, delegateIndex, methodIndex, name, index, delegateInline, fb));
    const sizes = table.longVectorPreview(8, MAX_ITEMS);

    // Data flow: a value is defined once the caller, a constant, or an
    // earlier instruction supplies it. Out-variant kernels and delegate calls
    // write their trailing arguments, so the not-yet-defined tail of the
    // argument list is the instruction's output set.
    const defined = new Set<number>();
    // Memory-planned slot → the latest value defined into it. Two values with
    // one slot signature are either aliases (a view got its own EValue) or
    // successive occupants of a reused slot; the file does not say which.
    const occupant = new Map<string, number>();
    // Keyed on the byte extent rather than the dim list: the usual alias is a
    // reshaping view, which keeps the bytes and changes the shape.
    const signatureOf = (index: number): string | undefined => {
        const tensor = values[index]?.tensor;
        if (!tensor?.allocation) return undefined;
        return `${tensor.allocation.memoryId}:${tensor.allocation.memoryOffset}:${tensor.scalarType}:${tensor.expectedBytes || tensor.sizes.join('x')}`;
    };
    /** Instruction that produced each value; `-1` for inputs and constants. */
    const definedAt = new Map<number, number>();
    /** Roots that already have a resolved alias. */
    const aliased = new Set<number>();
    /**
     * Secondary outputs of multi-output kernels — batch-norm statistics, pool
     * indices — are routinely never read, so their freed slot says nothing
     * about a later occupant; they never vouch for an alias.
     */
    const secondaryOutputs = new Set<number>();
    let current = -1;
    const define = (index: number): void => {
        defined.add(index);
        definedAt.set(index, current);
        const signature = signatureOf(index);
        if (signature === undefined) return;
        occupant.set(signature, index);
        // Items of a list read while this slot was still empty have been
        // waiting for it — the loop-body shape, where the list is read at the
        // top and the slot written at the bottom. Only an item a later
        // instruction still reads can be that: one never read again was read
        // before anything wrote its bytes, and claiming it aliases this write
        // would point backwards in time. A mention is static, so an item that
        // fails here fails for every later writer too and is dropped.
        const waiting = waitingForSlot.get(signature);
        if (!waiting) return;
        waitingForSlot.delete(signature);
        for (const item of waiting) if (mentionedAfter(item, current)) resolveAlias(item);
    };
    /** The defined value an undefined planned tensor would alias, if any. */
    const aliasFor = (index: number): number | undefined => {
        if (defined.has(index)) return undefined;
        const signature = signatureOf(index);
        const root = signature === undefined ? undefined : occupant.get(signature);
        return root === undefined || root === index ? undefined : root;
    };
    // An undefined tensor an instruction *reads* can only be an alias: nothing
    // else could have put bytes in it.
    /**
     * Each list is walked once, however many calls name it. An item whose slot
     * has no occupant yet waits under that slot's signature instead of being
     * looked at again on the next read, so nothing is missed and no list is
     * ever re-walked.
     */
    const walkedLists = new Set<number>();
    const waitingForSlot = new Map<string, Set<number>>();
    // Likewise a list returned by many kernels is expanded once and its
    // tensors defined once; the instructions then share one output array.
    const expandedLists = new Map<number, number[]>();
    const definedLists = new Set<number>();
    const listOutputs = (index: number): number[] | undefined => {
        const items = values[index]?.items;
        if (!items) return undefined;
        let expanded = expandedLists.get(index);
        if (!expanded) { expanded = items.filter(item => item >= 0); expandedLists.set(index, expanded); }
        return expanded;
    };
    const resolveAlias = (index: number): void => {
        const value = values[index];
        if (value?.items) {
            if (walkedLists.has(index)) return;
            walkedLists.add(index);
            // Items are tensor indices by schema; a list nested in a list is
            // malformed and is left alone rather than recursed into.
            for (const item of value.items) {
                if (item < 0 || values[item]?.items) continue;
                resolveAlias(item);
                if (defined.has(item)) continue;
                const signature = signatureOf(item);
                if (signature === undefined) continue;
                const waiting = waitingForSlot.get(signature);
                if (waiting) waiting.add(item);
                else waitingForSlot.set(signature, new Set([item]));
            }
            return;
        }
        const root = aliasFor(index);
        if (root === undefined || !value?.tensor) return;
        // The occupant may itself be an alias once it has been written into;
        // every stored `aliasOf` is terminal, so one hop reaches the terminal.
        const terminal = values[root]?.tensor?.aliasOf ?? root;
        if (terminal === index) return;
        value.tensor.aliasOf = terminal;
        // Both links are vouched for: `looksLikeAlias` asks about the slot's
        // immediate occupant, which is the one this alias actually read.
        aliased.add(root);
        aliased.add(terminal);
        defined.add(index);
    };
    for (const input of inputs) define(input);
    for (const value of values) {
        if (!value.tensor) { if (!value.items) defined.add(value.index); continue; }
        if (value.tensor.storage !== 'planned' && value.tensor.storage !== 'runtime') define(value.index);
    }
    // List values are defined when every item is; the per-instruction cache
    // keeps a long list named by many trailing arguments from being rescanned
    // once per argument (`defined` does not change while a call is split).
    const listCache = new Map<number, boolean>();
    const isDefined = (valueIndex: number): boolean => {
        if (defined.has(valueIndex)) return true;
        const value = values[valueIndex];
        if (!value?.items) return false;
        let known = listCache.get(valueIndex);
        if (known === undefined) {
            known = value.items.every(item => item < 0 || defined.has(item));
            listCache.set(valueIndex, known);
            // `defined` only grows, so a list found complete stays complete.
            if (known) defined.add(valueIndex);
        }
        return known;
    };
    const isTensorLike = (valueIndex: number): boolean => {
        const value = values[valueIndex];
        return !!value && (value.kind === 'Tensor' || value.kind === 'TensorList' || value.kind === 'OptionalTensorList');
    };
    const isScalar = (valueIndex: number): boolean => {
        const kind = values[valueIndex]?.kind;
        return kind === 'Int' || kind === 'Bool' || kind === 'Double';
    };

    const chains: PteChain[] = [];
    const instructions: PteInstruction[] = [];
    // Last instruction (flattened index) naming each value among its
    // arguments, list items included. An alias is read once and never named
    // again, which is what tells it apart from an output in the ambiguous
    // zone below.
    const lastMention = new Map<number, number>();
    const methodOutputs = new Set(outputs);
    // Lists are mentioned by index; an item counts as mentioned wherever a
    // list holding it is. Indexed once so a long list named by many calls
    // costs its length once rather than once per mention.
    const listsHolding = new Map<number, number[]>();
    for (const value of values) {
        for (const item of value.items ?? []) {
            if (item < 0) continue;
            const lists = listsHolding.get(item);
            if (lists) { if (lists[lists.length - 1] !== value.index) lists.push(value.index); } else listsHolding.set(item, [value.index]);
        }
    }
    interface Call { kind: PteInstructionKind; call: Table | undefined; args: number[]; chainIndex: number; chainPosition: number; trace: Table | undefined }
    const calls: Call[] = [];
    table.tableVector(5).forEach((chain, chainIndex) => {
        const instructionTables = chain.tableVector(2);
        const traces = instructionTables.length > 0 ? chain.tableVector(3) : [];
        chains.push({ index: chainIndex, inputs: chain.intVector(0), outputs: chain.intVector(1), instructionCount: instructionTables.length });
        instructionTables.forEach((instruction, chainPosition) => {
            const kindCode = instruction.ubyte(0);
            const kind = INSTRUCTION_KINDS[kindCode] ?? 'Unknown';
            if (kind === 'Unknown') unknown.instructions++;
            const call = kind === 'Unknown' ? undefined : instruction.table(1);
            const args = call && (kind === 'KernelCall' || kind === 'DelegateCall') ? call.intVector(1) : [];
            for (const arg of args) lastMention.set(arg, calls.length);
            // A move or a conditional jump reads its value too; a free does not.
            if (call && (kind === 'MoveCall' || kind === 'JumpFalseCall')) lastMention.set(call.int(0), calls.length);
            calls.push({ kind, call, args, chainIndex, chainPosition, trace: traces[chainPosition] });
        });
    });
    // Folded once now that every mention is known: a value held by many lists
    // must not rescan them on every query.
    const lastListMention = new Map<number, number>();
    for (const [item, lists] of listsHolding) {
        let latest = -1;
        for (const list of lists) latest = Math.max(latest, lastMention.get(list) ?? -1);
        lastListMention.set(item, latest);
    }
    const mentionedAfter = (index: number, flatIndex: number): boolean =>
        (lastMention.get(index) ?? -1) > flatIndex || (lastListMention.get(index) ?? -1) > flatIndex;
    /** Never named by any instruction but its producer: its bytes reach readers only through aliases. */
    const unread = (index: number): boolean => !mentionedAfter(index, definedAt.get(index) ?? -1);
    /**
     * Whether an undefined tensor in an output position is really an alias
     * the call reads. The file cannot say outright — a fresh output routinely
     * reuses the slot of a dead tensor of the same size — so two signs are
     * taken: the slot's occupant has never been read directly and has no
     * alias yet (so something must still read its bytes), or the candidate
     * itself is never named again (an output is normally read later, an alias
     * has done its one job).
     */
    const looksLikeAlias = (index: number, flatIndex: number): boolean => {
        const root = aliasFor(index);
        if (root === undefined) return false;
        // A method output is read by the caller, so it is never "unnamed".
        return (!mentionedAfter(index, flatIndex) && !methodOutputs.has(index)) ||
            (unread(root) && !aliased.has(root) && !secondaryOutputs.has(root));
    };

    calls.forEach(({ kind, call, args, chainIndex, chainPosition, trace }) => {
        {
            const record: PteInstruction = {
                id: `ins-${methodIndex}-${chainIndex}-${chainPosition}`,
                index: instructions.length,
                chain: chainIndex,
                chainIndex: chainPosition,
                kind,
                label: kind,
                operatorIndex: -1,
                delegateIndex: -1,
                args: [],
                inputs: [],
                outputs: [],
                destination: -1,
                frames: instructions.length < MAX_TRACED_INSTRUCTIONS ? parseFrames(trace) : []
            };
            if (call && (kind === 'KernelCall' || kind === 'DelegateCall')) {
                const target = call.int(0);
                record.args = args;
                if (kind === 'KernelCall') {
                    record.operatorIndex = target;
                    record.label = operators[target]?.label ?? `op[${target}]`;
                } else {
                    record.delegateIndex = target;
                    record.label = delegates[target]?.id || `delegate[${target}]`;
                }
                listCache.clear();
                current = record.index;
                let written: number[];
                if (kind === 'KernelCall' && record.args.length > 0) {
                    // The emitter appends the call's return value after the
                    // schema arguments: the out tensor itself for a single-out
                    // kernel, a TensorList of the out tensors for several, or a
                    // fresh scalar for a symbolic op. So the last argument
                    // names the outputs exactly. The out arguments of an
                    // out-variant sit just before it — the echoed value itself
                    // (a tensor, or a `Tensor[] out`), or the list's tensors one
                    // by one — and only those positions are dropped from the
                    // inputs: an earlier mention of the same value is a read
                    // (`add.Scalar(i, 1, i)` in a lowered loop).
                    const count = record.args.length;
                    const last = record.args[count - 1]!;
                    const listed = listOutputs(last);
                    let outArgs = 0;
                    if (record.operatorIndex >= 0 && operators[record.operatorIndex]?.label === COPY_INDEX_OPERATOR) {
                        // No return is appended; the accumulator in front is written.
                        record.outputs = [record.args[0]!];
                        record.inputs = record.args.slice(1);
                        written = record.outputs;
                    } else {
                        if (count >= 2 && record.args[count - 2] === last) outArgs = 1;
                        else if (listed && listed.length > 0 && count - 1 >= listed.length &&
                            listed.every((item, position) => record.args[count - 1 - listed.length + position] === item)) outArgs = listed.length;
                        record.inputs = record.args.slice(0, count - 1 - outArgs);
                        record.outputs = listed ?? [last];
                        if (listed && !definedLists.has(last)) for (const output of listed.slice(1)) secondaryOutputs.add(output);
                        written = listed ? (definedLists.has(last) ? [last] : [...listed, last]) : [last];
                        if (listed) definedLists.add(last);
                    }
                } else {
                    // A delegate call carries its inputs, then its outputs,
                    // with nothing to mark the boundary. Out-variant kernels
                    // and delegates write their trailing arguments, so the
                    // not-yet-defined tail is the output set — except that
                    // aliases the call reads land there too, since nothing
                    // wrote them. Inputs come first, so reclaim the leading
                    // candidates that look like aliases; the last argument is
                    // always written.
                    // A SymInt / bool / float the delegate returns is a fresh
                    // scalar after its tensor returns; trailing scalars count
                    // as returns only when an undefined tensor precedes them.
                    let end = record.args.length;
                    while (end > 0 && isScalar(record.args[end - 1]!)) end--;
                    let split = end;
                    while (split > 0 && isTensorLike(record.args[split - 1]!) && !isDefined(record.args[split - 1]!)) split--;
                    if (split === end) split = record.args.length;
                    while (split < record.args.length - 1 && isTensorLike(record.args[split]!) && !isDefined(record.args[split]!) && looksLikeAlias(record.args[split]!, record.index)) split++;
                    if (split === record.args.length && split > 0) split--;
                    record.inputs = record.args.slice(0, split);
                    written = record.args.slice(split);
                    record.outputs = collapseReturnEchoes([...new Set(written)], values);
                    // As with a multi-output kernel, an extra return a delegate
                    // leaves unread says nothing about a later occupant of its slot.
                    for (const output of record.outputs.slice(1)) secondaryOutputs.add(output);
                }
                for (const input of new Set(record.inputs)) resolveAlias(input);
                for (const output of written) define(output);
            } else if (call && kind === 'MoveCall') {
                record.inputs = [call.int(0)];
                record.outputs = [call.int(1)];
                current = record.index;
                resolveAlias(call.int(0));
                define(call.int(1));
            } else if (call && kind === 'JumpFalseCall') {
                record.inputs = [call.int(0)];
                record.destination = call.int(1);
                resolveAlias(call.int(0));
            } else if (call && kind === 'FreeCall') {
                record.inputs = [call.int(0)];
            }
            instructions.push(record);
        }
    });

    return {
        index: methodIndex,
        name,
        values,
        inputs,
        outputs,
        chains,
        instructions,
        operators,
        delegates,
        nonConstBufferSizes: sizes.values,
        inputSpec: clampText(meta?.string(0) ?? ''),
        outputSpec: clampText(meta?.string(1) ?? ''),
        tensorCount: values.filter(value => value.tensor).length,
        constantCount: values.filter(value => value.tensor && (value.tensor.storage === 'inline' || value.tensor.storage === 'segment')).length
    };
}

/**
 * The emitter appends a call's return values after its `out` arguments, and
 * for an out-variant they alias those very tensors: the same index again
 * (already folded by the caller's Set), or a TensorList holding the out
 * tensors of a tuple-returning kernel. Dropping the list echo leaves each
 * produced tensor listed once; the echo stays a defined value for later uses.
 */
function collapseReturnEchoes(outputs: number[], values: PteValue[]): number[] {
    const kept = new Set(outputs);
    let end = outputs.length;
    while (end > 1) {
        const echo = outputs[end - 1]!;
        const last = values[echo];
        if (!last?.items || last.items.length === 0) break;
        kept.delete(echo);
        if (!last.items.every(item => item < 0 || kept.has(item))) { kept.add(echo); break; }
        end--;
    }
    return end === outputs.length ? outputs : outputs.slice(0, end);
}

function parseFrames(list: Table | undefined): PteFrame[] {
    if (!list) return [];
    return list.tableVectorHead(0, MAX_FRAMES).map(frame => ({
        filename: frame.string(0),
        line: frame.int(1),
        name: frame.string(2),
        context: frame.string(3)
    }));
}

function parseValue(table: Table, valueIndex: number, index: DataIndex, unknown: { values: number }): PteValue {
    const kindCode = table.ubyte(0);
    const kind = VALUE_KINDS[kindCode];
    // A union code the schema does not define, or a defined one whose payload
    // table is missing: neither is a value this reader can describe, so it is
    // reported rather than passed off as a Null.
    if (kind === undefined || kindCode === 0) {
        if (kindCode !== 0) unknown.values++;
        return { index: valueIndex, kind: 'Null', preview: kindCode === 0 ? 'None' : `kind ${kindCode}` };
    }
    const value = table.table(1);
    if (!value) { unknown.values++; return { index: valueIndex, kind: 'Null', preview: `kind ${kindCode}` }; }
    switch (kind) {
        case 'Null': return { index: valueIndex, kind, preview: 'None' };
        case 'Int': return { index: valueIndex, kind, preview: value.long(0).toString() };
        case 'Bool': return { index: valueIndex, kind, preview: value.bool(0) ? 'True' : 'False' };
        case 'Double': return { index: valueIndex, kind, preview: formatNumber(value.double(0)) };
        case 'String': return { index: valueIndex, kind, preview: JSON.stringify(clampText(value.string(0))) };
        case 'IntList': {
            // Boxed: items are EValue indices, resolved to their ints once every
            // value is read. Structural like TensorList, so an over-long
            // declaration is an error rather than a silently shortened list.
            const items = value.longVector(0).map(Number);
            return { index: valueIndex, kind, preview: '', items };
        }
        case 'DoubleList': return { index: valueIndex, kind, preview: listPreview(value.doubleVectorPreview(0, MAX_LIST_PREVIEW), formatNumber) };
        case 'BoolList': return { index: valueIndex, kind, preview: listPreview(value.boolVectorPreview(0, MAX_LIST_PREVIEW), item => item ? 'True' : 'False') };
        case 'TensorList':
        case 'OptionalTensorList': {
            const items = value.intVector(0);
            const shown = items.slice(0, MAX_LIST_PREVIEW).map(item => item < 0 ? 'None' : `#${item}`);
            return { index: valueIndex, kind, preview: `[${shown.join(', ')}${items.length > shown.length ? `, … (+${items.length - shown.length})` : ''}]`, items };
        }
        case 'Tensor': {
            const tensor = parseTensor(value, index);
            return { index: valueIndex, kind, preview: `${tensor.scalarType}[${tensor.sizes.join(' × ')}]`, tensor };
        }
    }
}

function parseTensor(table: Table, index: DataIndex): PteTensor {
    const typeCode = table.byte(0);
    if (SCALAR_TYPES[typeCode] === undefined) index.counters.unknownTypes++;
    const sizes = table.intVector(2, MAX_TENSOR_RANK);
    const dataBufferIndex = table.uint(5);
    const allocationTable = table.table(6);
    const extra = table.table(9);
    const name = extra?.string(1) ?? '';
    const external = extra?.byte(2) === TENSOR_DATA_LOCATION_EXTERNAL;
    const mutableSegmentIndex = extra ? Number(extra.ulong(0)) : 0;
    const deviceType = extra?.byte(3) ?? 0;
    const deviceIndex = extra?.byte(4) ?? 0;
    const allocation = allocationTable
        ? { memoryId: allocationTable.uint(0), memoryOffset: ((BigInt(allocationTable.uint(2)) << 32n) | BigInt(allocationTable.uint(1))).toString() }
        : undefined;

    const elementCount = tensorElementCount(sizes);
    const bits = SCALAR_BITS[typeCode] ?? 0;
    const expectedBytes = elementCount !== undefined && bits ? (elementCount * BigInt(bits) + 7n) / 8n : undefined;

    let storage: PteTensorStorage;
    let segmentIndex = -1;
    let fileOffset: bigint | undefined;
    let dataBytes: bigint | undefined;
    if (external) {
        storage = 'external';
        index.counters.external++;
        dataBytes = expectedBytes;
    } else if (dataBufferIndex === 0) {
        storage = allocation ? 'planned' : 'runtime';
    } else if (allocation) {
        // Mutable with an initial state: the bytes live in a mutable data
        // segment — or, for a writer that still inlines constants, in the
        // inline buffer the index names.
        storage = 'mutable';
        const buffer = index.inline.length > 0 ? index.inline[dataBufferIndex] : undefined;
        const entry = index.inline.length > 0 ? undefined : index.mutableSegments[mutableSegmentIndex];
        const slot = entry ? subsegmentSlot(entry, dataBufferIndex, index.segments) : undefined;
        if (buffer) { fileOffset = BigInt(buffer.start); dataBytes = BigInt(buffer.length); }
        else if (slot) { segmentIndex = entry!.segmentIndex; fileOffset = slot.fileOffset; dataBytes = slot.size; }
        else index.counters.missing++;
    } else if (index.inline.length > 0) {
        storage = 'inline';
        const buffer = index.inline[dataBufferIndex];
        if (buffer) { fileOffset = BigInt(buffer.start); dataBytes = BigInt(buffer.length); }
        else index.counters.missing++;
    } else {
        storage = 'segment';
        const entry = index.constantSegment;
        const slot = entry ? subsegmentSlot(entry, dataBufferIndex, index.segments) : undefined;
        if (slot) { segmentIndex = entry!.segmentIndex; fileOffset = slot.fileOffset; dataBytes = slot.size; }
        else index.counters.missing++;
    }

    const dynamism = table.byte(8);
    return {
        scalarType: SCALAR_TYPES[typeCode] ?? `TYPE_${typeCode}`,
        sizes,
        dimOrder: table.ubyteVector(3, MAX_TENSOR_RANK),
        storageOffset: table.int(1),
        requiresGrad: table.bool(4),
        dataBufferIndex,
        ...(allocation ? { allocation } : {}),
        layout: table.byte(7),
        shapeDynamism: SHAPE_DYNAMISM[dynamism] ?? `DYNAMISM_${dynamism}`,
        name,
        storage,
        segmentIndex,
        fileOffset: fileOffset?.toString() ?? '',
        dataBytes: dataBytes?.toString() ?? '',
        expectedBytes: expectedBytes?.toString() ?? '',
        elementCount: elementCount?.toString() ?? '',
        device: deviceType === 0 && deviceIndex === 0 ? '' : `${DEVICE_TYPES[deviceType] ?? `device${deviceType}`}:${deviceIndex}`
    };
}

/**
 * A subsegment slot spans from its offset to the next offset (or the end of
 * the segment), so the slot includes the alignment padding the writer added
 * after the payload.
 */
function subsegmentSlot(entry: SubsegmentOffsets, dataIndex: number, segments: SegmentRecord[]): { fileOffset?: bigint; size: bigint } | undefined {
    const segment = segments[entry.segmentIndex];
    const start = entry.offsets[dataIndex];
    if (!segment || start === undefined) return undefined;
    const end = dataIndex + 1 < entry.offsets.length ? entry.offsets[dataIndex + 1]! : segment.size;
    // A slot that runs backwards or past its segment names no bytes.
    if (end < start || end > segment.size) return undefined;
    return {
        ...(segment.fileOffset === undefined ? {} : { fileOffset: segment.fileOffset + start }),
        size: end - start
    };
}

function parseDelegate(
    table: Table,
    delegateIndex: number,
    methodIndex: number,
    methodName: string,
    index: DataIndex,
    inline: Array<{ start: number; length: number }>,
    fb: FlatBufferReader
): PteDelegate {
    const id = table.string(0);
    const processed = table.table(1);
    const location = processed?.byte(0) === DELEGATE_DATA_SEGMENT ? 'segment' : 'inline';
    const dataIndex = processed?.uint(1) ?? 0;
    let dataBytes = '';
    let fileOffset = '';
    if (location === 'segment') {
        const segment = index.segments[dataIndex];
        if (segment) {
            segment.kind = 'delegate';
            segment.usedBy.push(`${methodName || `method[${methodIndex}]`}/${id || `delegate[${delegateIndex}]`}`);
            dataBytes = segment.size.toString();
            fileOffset = segment.fileOffset?.toString() ?? '';
        } else index.counters.missingSegments++;
    } else {
        const buffer = inline[dataIndex];
        if (buffer) { dataBytes = String(buffer.length); fileOffset = String(buffer.start); }
        else index.counters.missingSegments++;
    }
    const compileSpecs = table.tableVector(2).map((spec): PteCompileSpec => {
        const bytes = spec.byteVector(1);
        return {
            key: spec.string(0),
            value: bytes ? decodeSpecText(fb, bytes) : '',
            bytes: bytes?.length ?? 0
        };
    });
    return { index: delegateIndex, id, location, dataIndex, dataBytes, fileOffset, compileSpecs };
}

/** Compile specs are usually short text (`"true"`, a JSON snippet); binary ones show a size only. */
function decodeSpecText(fb: FlatBufferReader, extent: { start: number; length: number }): string {
    if (extent.length === 0 || extent.length > MAX_COMPILE_SPEC_TEXT) return '';
    const bytes = fb.bytes.subarray(extent.start, extent.start + extent.length);
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    for (let index = 0; index < end; index++) {
        const byte = bytes[index]!;
        if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) return '';
    }
    return end === 0 ? '' : fb.text(extent.start, end);
}

function tensorElementCount(sizes: number[]): bigint | undefined {
    if (sizes.length === 0) return 1n;
    if (sizes.some(dimension => dimension < 0)) return undefined;
    let bits = 0;
    for (const dimension of sizes) {
        if (dimension === 0) return 0n;
        if (dimension === 1) continue;
        bits += 32 - Math.clz32(dimension);
        if (bits > MAX_TENSOR_PRODUCT_BITS) return undefined;
    }
    let count = 1n;
    for (const dimension of sizes) if (dimension !== 1) count *= BigInt(dimension);
    return count;
}

/** Render a capped vector, flagging the entries the cap dropped. */
function listPreview<T>(preview: Preview<T>, format: (value: T) => string): string {
    const shown = preview.values.map(format).join(', ');
    const omitted = preview.length - preview.values.length;
    return `[${shown}${omitted > 0 ? `, … (+${omitted})` : ''}]`;
}

function clampText(text: string): string {
    return text.length > MAX_SPEC_TEXT ? `${text.slice(0, MAX_SPEC_TEXT)}…` : text;
}

function preview(items: string[], limit: number): string {
    return items.length > limit ? `${items.slice(0, limit).join(', ')}, …` : items.join(', ');
}

function toBigInt(value: string): bigint {
    return /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function formatNumber(value: number): string {
    return Number.isFinite(value) ? String(Number(value.toPrecision(7))) : String(value);
}

export function formatFileSize(bytes: number | bigint): string {
    const value = typeof bytes === 'bigint' ? Number(bytes) : bytes;
    if (!Number.isFinite(value) || value < 0) return String(bytes);
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let scaled = value;
    let unit = -1;
    do { scaled /= 1024; unit++; } while (scaled >= 1024 && unit < units.length - 1);
    return `${scaled.toFixed(2)} ${units[unit]}`;
}
