/**
 * Only the enum tables are imported. Reading the file is done here: see
 * preflightGguf, which walks metadata *and* the tensor index from source bytes.
 * These tables are the part of @huggingface/gguf worth depending on -- new ggml
 * quantization types land there, and hand-maintaining them would drift.
 */
import {
    GGMLFileQuantizationType,
    GGMLQuantizationType,
    GGUFValueType,
    type GGUFParseOutput,
    type GGUFTypedMetadata,
    type MetadataValue
} from '@huggingface/gguf';

export interface GgufSummaryItem {
    labelKey: string;
    value: string | number;
}

export interface GgufTable {
    titleKey: string;
    titleArgs: Record<string, string | number>;
    headerKeys: string[];
    rows: Array<Array<string | number>>;
}

export interface GgufWarning {
    key: string;
    args?: Record<string, string | number>;
}

/** JSON-safe metadata row. Large arrays and strings are represented by previews. */
export interface GgufMetadataEntry {
    key: string;
    type: string;
    value: string;
    arrayLength?: number;
}

/** JSON-safe tensor descriptor; all uint64 values remain exact decimal strings. */
export interface GgufTensor {
    name: string;
    dtype: string;
    shape: string[];
    elements: string;
    offset: string;
    absoluteOffset: string;
}

export interface GgufDocument {
    format: 'gguf';
    title: string;
    fileSize: string;
    version?: number;
    byteOrder?: 'little-endian' | 'big-endian';
    tensorDataOffset?: string;
    summary: GgufSummaryItem[];
    metadata: GgufMetadataEntry[];
    tensors: GgufTensor[];
    tables: GgufTable[];
    rawPreview?: string | undefined;
    warnings: GgufWarning[];
    /** Non-localized technical detail retained for diagnostics and copied JSON. */
    errorDetail?: string;
}

export interface GgufParseOptions {
    /** Display value supplied by a host that already knows the complete size. */
    fileSize?: string;
    /** Complete file size used for structural EOF validation. */
    fileByteLength?: number;
    /** Cancels remote range requests and parsing at the next async boundary. */
    signal?: AbortSignal;
    /** Custom transport, primarily for authenticated URLs and tests. */
    fetch?: typeof fetch;
}

export interface GgufBytesParseOptions {
    /** Display value; defaults to the byte array size. */
    fileSize?: string;
    signal?: AbortSignal;
}

export interface GgufHeaderInfo {
    version: 1 | 2 | 3;
    tensorCount: bigint;
    metadataCount: bigint;
    littleEndian: boolean;
}

export type HuggingFaceGgufOutput = GGUFParseOutput & { typedMetadata: GGUFTypedMetadata };

const INTERNAL_METADATA_KEYS = new Set(['version', 'tensor_count', 'kv_count']);
const ARRAY_PREVIEW_ITEMS = 8;
const MAX_DISPLAY_STRING_CHARS = 2_000;
const MAX_ARRAY_ITEM_CHARS = 160;
const MAX_IDENTIFIER_CHARS = 512;
const MAX_FILE_SIZE_LABEL_CHARS = 160;
const MAX_ERROR_MESSAGE_CHARS = 2_000;
const DEFAULT_ALIGNMENT = 32n;
const MAX_UINT32 = 0xffff_ffffn;
interface GgmlStorageLayout { blockElements: bigint; blockBytes: bigint }
/** Exact ggml block layouts mirrored from llama.cpp gguf-py constants. */
const GGML_STORAGE_LAYOUTS: Readonly<Partial<Record<GGMLQuantizationType, GgmlStorageLayout>>> = {
    [GGMLQuantizationType.F32]: storage(1, 4),
    [GGMLQuantizationType.F16]: storage(1, 2),
    [GGMLQuantizationType.Q4_0]: storage(32, 18),
    [GGMLQuantizationType.Q4_1]: storage(32, 20),
    [GGMLQuantizationType.Q5_0]: storage(32, 22),
    [GGMLQuantizationType.Q5_1]: storage(32, 24),
    [GGMLQuantizationType.Q8_0]: storage(32, 34),
    [GGMLQuantizationType.Q8_1]: storage(32, 40),
    [GGMLQuantizationType.Q2_K]: storage(256, 84),
    [GGMLQuantizationType.Q3_K]: storage(256, 110),
    [GGMLQuantizationType.Q4_K]: storage(256, 144),
    [GGMLQuantizationType.Q5_K]: storage(256, 176),
    [GGMLQuantizationType.Q6_K]: storage(256, 210),
    [GGMLQuantizationType.Q8_K]: storage(256, 292),
    [GGMLQuantizationType.IQ2_XXS]: storage(256, 66),
    [GGMLQuantizationType.IQ2_XS]: storage(256, 74),
    [GGMLQuantizationType.IQ3_XXS]: storage(256, 98),
    [GGMLQuantizationType.IQ1_S]: storage(256, 50),
    [GGMLQuantizationType.IQ4_NL]: storage(32, 18),
    [GGMLQuantizationType.IQ3_S]: storage(256, 110),
    [GGMLQuantizationType.IQ2_S]: storage(256, 82),
    [GGMLQuantizationType.IQ4_XS]: storage(256, 136),
    [GGMLQuantizationType.I8]: storage(1, 1),
    [GGMLQuantizationType.I16]: storage(1, 2),
    [GGMLQuantizationType.I32]: storage(1, 4),
    [GGMLQuantizationType.I64]: storage(1, 8),
    [GGMLQuantizationType.F64]: storage(1, 8),
    [GGMLQuantizationType.IQ1_M]: storage(256, 56),
    [GGMLQuantizationType.BF16]: storage(1, 2),
    [GGMLQuantizationType.TQ1_0]: storage(256, 54),
    [GGMLQuantizationType.TQ2_0]: storage(256, 66),
    [GGMLQuantizationType.MXFP4]: storage(32, 17),
    [GGMLQuantizationType.NVFP4]: storage(64, 36),
    [GGMLQuantizationType.Q1_0]: storage(128, 18),
    [GGMLQuantizationType.Q2_0]: storage(64, 18)
};
/**
 * Entries kept for display. The walk visits every metadata key and every tensor,
 * but only this many are retained, so peak memory is independent of how many
 * there are -- and the retained set is not multiplied across the document model,
 * table rows, structure text, and clipboard JSON.
 */
export const GGUF_PREVIEW_ENTRY_LIMIT = 1_000;
/** Total user-controlled characters copied into normalized display structures. */
export const GGUF_NORMALIZED_TEXT_BUDGET = 2_000_000;
/**
 * Structural admission limits, enforced from the source header before the walk
 * starts. These bound how many *entries* a file may declare, which no amount of
 * streaming can make free: each one still has to be visited.
 *
 * Note what is deliberately absent: there is no ceiling on metadata array
 * elements. Array bodies are skipped rather than materialized, so vocabulary size
 * no longer decides whether a document can be built -- the ceiling that rejected
 * ordinary Qwen3 and Llama 3 files in
 * https://github.com/battlecook/vscode-omni-viewer/issues/18 is gone rather than
 * raised. What replaces it is exact instead of tuned: an array cannot declare more
 * elements than the remaining file bytes can physically hold (see readGgufValue).
 */
export const GGUF_PARSE_TENSOR_LIMIT = 100_000;
export const GGUF_PARSE_METADATA_LIMIT = 10_000;
/** Cumulative declared metadata string bytes; caps the text a document may draw from. */
export const GGUF_PARSE_STRING_BYTE_LIMIT = 16 * 1024 * 1024;
/** Mirrors ggml's tensor rank ceiling; llama.cpp writes at most four dimensions. */
const MAX_TENSOR_DIMENSIONS = 8;

/**
 * Parses a remote GGUF URL. Node local files use the abortable `./node` helper.
 * Tensor payload bytes are never read: only the metadata block and the tensor
 * index that follows it are range-read, and array bodies within the metadata are
 * skipped rather than decoded.
 */
export async function parseGgufUri(uri: string, options: GgufParseOptions = {}): Promise<GgufDocument> {
    let remoteFileSize: number | undefined;
    try {
        throwIfAborted(options.signal);
        if (options.fileByteLength !== undefined
            && (!Number.isSafeInteger(options.fileByteLength) || options.fileByteLength < 0)) {
            throw new Error('GGUF host-provided file byte length must be a non-negative safe integer.');
        }
        const rangeFetch = validatedRangeFetch(
            options.fetch ?? globalThis.fetch,
            options.signal,
            options.fileByteLength,
            (size) => { remoteFileSize = size; }
        );
        const source = await preflightGguf(uri, rangeFetch, options.signal);
        throwIfAborted(options.signal);
        const displayFileSize = options.fileSize
            ?? (remoteFileSize === undefined ? 'Unknown' : formatByteSize(remoteFileSize));
        return preflightDocument(source, displayFileSize, remoteFileSize ?? options.fileByteLength);
    } catch (error) {
        if (options.signal?.aborted) throw abortReason(options.signal);
        const displayFileSize = options.fileSize
            ?? (remoteFileSize === undefined ? 'Unknown' : formatByteSize(remoteFileSize));
        return invalid(displayFileSize, errorMessage(error));
    }
}

/** Parses a complete in-memory input through the same range reader as a remote URL. */
export function parseGgufBytes(
    input: Uint8Array,
    options: GgufBytesParseOptions = {}
): Promise<GgufDocument> {
    return parseGgufUri('https://omni-viewer.invalid/in-memory.gguf', {
        fetch: memoryRangeFetch(input),
        fileSize: options.fileSize ?? formatByteSize(input.byteLength),
        fileByteLength: input.byteLength,
        ...(options.signal ? { signal: options.signal } : {})
    });
}

/**
 * Converts @huggingface/gguf output to Omni Viewer's JSON-safe document model.
 * Retained as a public adapter for hosts that call `gguf()` themselves; the
 * viewer's own parse path builds the same document from source bytes and shares
 * every accumulator and check below, so the two cannot drift apart.
 */
export function normalizeGguf(
    output: HuggingFaceGgufOutput,
    fileSize = 'Unknown',
    fileByteLength?: number | bigint,
    sourceHeader?: GgufHeaderInfo
): GgufDocument {
    const header = validateHeader(output, sourceHeader);
    if (typeof header === 'string') return invalid(fileSize, header);

    const alignment = validateAlignment(rawAlignmentValue(rawMetadata(output)['general.alignment']));
    if (typeof alignment === 'string') return invalid(fileSize, alignment);
    // Upstream reports this field too, but we recompute it below: its GGML_PAD is a
    // 32-bit bitwise operation. Only its sign and type are worth checking here.
    if (typeof output.tensorDataOffset !== 'bigint' || output.tensorDataOffset < 0n) {
        return invalid(fileSize, 'GGUF tensor data offset is outside the supported non-negative range.');
    }
    const tensorInfoStart = output.tensorInfoByteRange?.[0];
    const tensorInfoEnd = output.tensorInfoByteRange?.[1];
    if (!Number.isSafeInteger(tensorInfoStart)
        || !Number.isSafeInteger(tensorInfoEnd)
        || tensorInfoStart < 0
        || tensorInfoEnd < tensorInfoStart) {
        return invalid(fileSize, 'GGUF tensor index byte range is invalid.');
    }
    const layout = resolveLayout(alignment, tensorInfoEnd, fileByteLength);
    if (typeof layout === 'string') return invalid(fileSize, layout);

    const text = new CharacterBudget(GGUF_NORMALIZED_TEXT_BUDGET);
    const scalars: GgufScalarMetadata = {
        architecture: budgetedScalarMetadata(output, 'general.architecture', text),
        name: budgetedScalarMetadata(output, 'general.name', text),
        type: budgetedScalarMetadata(output, 'general.type', text),
        fileType: numberMetadata(output, 'general.file_type')
    };
    const typedMetadata = output.typedMetadata as Record<string, TypedMetadataEntry>;
    const metadata: GgufMetadataEntry[] = [];
    let parsedMetadataCount = 0;
    for (const key in typedMetadata) {
        if (!Object.prototype.hasOwnProperty.call(typedMetadata, key) || INTERNAL_METADATA_KEYS.has(key)) continue;
        parsedMetadataCount += 1;
        if (metadata.length < GGUF_PREVIEW_ENTRY_LIMIT) {
            metadata.push(normalizeMetadataEntry(key, typedMetadata[key]!, text));
        }
    }

    const walk = new TensorIndexWalk(alignment, text);
    for (const tensor of output.tensorInfos) {
        const failure = walk.add(tensor.name, tensor.shape, Number(tensor.dtype), tensor.offset);
        if (failure) return invalid(fileSize, failure);
    }

    return assembleGgufDocument({
        version: header.version,
        littleEndian: output.littleEndian,
        metadata,
        metadataCount: parsedMetadataCount,
        // Only reachable for callers that invoke normalizeGguf without a source
        // header: when one is supplied, validateHeader has already rejected this
        // same mismatch outright, because a verified header makes a disagreeing
        // count an error rather than something worth rendering.
        metadataCountMismatch: header.metadataCount !== BigInt(parsedMetadataCount),
        scalars,
        walk,
        layout,
        text
    }, fileSize);
}

interface GgufScalarMetadata {
    architecture?: string | undefined;
    name?: string | undefined;
    type?: string | undefined;
    fileType?: number | undefined;
}

interface GgufAssembly {
    version: 1 | 2 | 3;
    littleEndian: boolean;
    metadata: GgufMetadataEntry[];
    metadataCount: number;
    metadataCountMismatch: boolean;
    scalars: GgufScalarMetadata;
    walk: TensorIndexWalk;
    layout: ResolvedLayout;
    text: CharacterBudget;
}

/**
 * Renders the document from accumulated totals. Every input here is already
 * bounded -- `metadata` and `walk.preview` hold at most GGUF_PREVIEW_ENTRY_LIMIT
 * rows each, and the counts and parameter sum are scalars -- so this stage costs
 * the same whether the file declared ten tensors or a hundred thousand.
 */
function assembleGgufDocument(source: GgufAssembly, fileSize: string): GgufDocument {
    const { walk, layout, text } = source;
    const tensors = walk.finish(layout.tensorDataOffset, layout.fileByteLength);
    if (typeof tensors === 'string') return invalid(fileSize, tensors);

    const warnings: GgufWarning[] = [];
    if (walk.unknownDtype || walk.unverifiedStorage) warnings.push({ key: 'gguf.warning.unverifiedDtype' });
    if (source.metadataCountMismatch) warnings.push({ key: 'gguf.warning.metadataCountMismatch' });
    if (walk.count > tensors.length) {
        warnings.push({
            key: 'gguf.warning.tensorsLimited',
            args: { shown: tensors.length, total: walk.count }
        });
    }
    if (source.metadataCount > source.metadata.length) {
        warnings.push({
            key: 'gguf.warning.metadataLimited',
            args: { shown: source.metadata.length, total: source.metadataCount }
        });
    }

    const rawPreviewLines = tensors.map((tensor) => text.take(
        `${tensor.name}  [${tensor.shape.length ? tensor.shape.join(' × ') : 'scalar'}]  ${tensor.dtype}`,
        MAX_DISPLAY_STRING_CHARS
    ));

    const summary: GgufSummaryItem[] = [
        { labelKey: 'gguf.summary.version', value: `GGUF v${source.version}` },
        { labelKey: 'gguf.summary.architecture', value: source.scalars.architecture ?? '—' },
        { labelKey: 'gguf.summary.tensors', value: walk.count },
        { labelKey: 'gguf.summary.parameters', value: formatBigCount(walk.totalParameters) },
        { labelKey: 'gguf.summary.quantization', value: walk.quantization(source.scalars.fileType) ?? '—' },
        { labelKey: 'gguf.summary.metadataKeys', value: source.metadataCount }
    ];
    if (source.scalars.type) {
        summary.splice(2, 0, { labelKey: 'gguf.summary.type', value: source.scalars.type });
    }

    const tables: GgufTable[] = [
        {
            titleKey: 'gguf.table.tensors',
            titleArgs: { count: walk.count },
            headerKeys: ['gguf.column.name', 'gguf.column.dtype', 'gguf.column.shape', 'gguf.column.parameters', 'gguf.column.offset'],
            rows: tensors.map((tensor) => [
                text.take(tensor.name, MAX_IDENTIFIER_CHARS),
                tensor.dtype,
                tensor.shape.length ? tensor.shape.join(' × ') : 'scalar',
                tensor.elements,
                tensor.absoluteOffset
            ])
        },
        {
            titleKey: 'gguf.table.metadata',
            titleArgs: { count: source.metadataCount },
            headerKeys: ['gguf.column.key', 'gguf.column.type', 'gguf.column.value'],
            rows: source.metadata.map((entry) => [
                text.take(entry.key, MAX_IDENTIFIER_CHARS),
                entry.type,
                text.take(entry.value, MAX_DISPLAY_STRING_CHARS)
            ])
        }
    ];

    if (text.truncated) warnings.push({ key: 'gguf.warning.textTruncated' });

    return {
        format: 'gguf',
        title: source.scalars.name ?? 'GGUF model',
        fileSize: truncate(fileSize, MAX_FILE_SIZE_LABEL_CHARS),
        version: source.version,
        byteOrder: source.littleEndian ? 'little-endian' : 'big-endian',
        tensorDataOffset: layout.tensorDataOffset.toString(),
        summary,
        metadata: source.metadata,
        tensors,
        tables,
        rawPreview: rawPreviewLines.length ? rawPreviewLines.join('\n') : undefined,
        warnings
    };
}

/** A tensor kept for display; its offset stays relative until the layout is known. */
interface PreviewTensor {
    name: string;
    dtype: string;
    shape: string[];
    elements: string;
    offset: bigint;
}

/**
 * Folds the tensor index into constant-size state as it is visited, so callers may
 * stream a hundred thousand entries through `add` while holding only the first
 * GGUF_PREVIEW_ENTRY_LIMIT of them.
 *
 * The bounds check is the part that has to be a fold rather than a per-entry test:
 * a tensor's absolute position needs `tensorDataOffset`, which is not known until
 * the index has been walked to its end. Tracking the single entry that reaches
 * furthest into the file is sufficient -- if that one fits, every other one does.
 */
class TensorIndexWalk {
    readonly preview: PreviewTensor[] = [];
    count = 0;
    totalParameters = 0n;
    unknownDtype = false;
    unverifiedStorage = false;
    private readonly dtypeCounts = new Map<string, number>();
    private furthest: { name: string; end: bigint; startOnly: boolean } | undefined;

    constructor(readonly alignment: bigint, private readonly text: CharacterBudget) {}

    /** Returns a rejection message when the tensor is structurally invalid. */
    add(name: string, shape: readonly bigint[], dtype: number, offset: bigint): string | undefined {
        const label = `GGUF tensor "${truncate(name, MAX_IDENTIFIER_CHARS)}"`;
        if (typeof offset !== 'bigint' || offset < 0n) {
            return 'GGUF tensor offset is outside the supported non-negative range.';
        }
        if (offset % this.alignment !== 0n) return `${label} offset is not aligned to general.alignment.`;
        if (shape.some((dimension) => typeof dimension !== 'bigint' || dimension < 0n)) {
            return `${label} has an invalid shape.`;
        }

        this.count += 1;
        const dtypeName = quantizationTypeName(dtype);
        if (dtypeName.startsWith('UNKNOWN')) this.unknownDtype = true;
        this.dtypeCounts.set(dtypeName, (this.dtypeCounts.get(dtypeName) ?? 0) + 1);
        const elements = shape.reduce((count, dimension) => count * dimension, 1n);
        this.totalParameters += elements;

        const storage = GGML_STORAGE_LAYOUTS[dtype as GGMLQuantizationType];
        let end: bigint;
        let startOnly = false;
        if (storage === undefined) {
            // An unknown dtype has no computable payload length, so only the start
            // can be placed. A tensor with elements must begin strictly inside the
            // file; an empty one may sit exactly at its end.
            this.unverifiedStorage = true;
            startOnly = true;
            end = offset + (shape.every((dimension) => dimension > 0n) ? 1n : 0n);
        } else {
            const rowElements = shape[0] ?? 1n;
            if (rowElements !== 0n && rowElements % storage.blockElements !== 0n) {
                return `${label} shape is not divisible by its dtype block size.`;
            }
            end = offset + (elements === 0n ? 0n : elements / storage.blockElements * storage.blockBytes);
        }
        if (this.furthest === undefined || end > this.furthest.end) {
            this.furthest = { name: truncate(name, MAX_IDENTIFIER_CHARS), end, startOnly };
        }

        if (this.preview.length < GGUF_PREVIEW_ENTRY_LIMIT) {
            this.preview.push({
                name: this.text.take(name, MAX_IDENTIFIER_CHARS),
                dtype: dtypeName,
                shape: shape.map(String),
                elements: elements.toString(),
                offset
            });
        }
        return undefined;
    }

    /** Applies the layout-dependent bounds check and resolves absolute offsets. */
    finish(tensorDataOffset: bigint, fileByteLength?: bigint): GgufTensor[] | string {
        if (fileByteLength !== undefined) {
            // With zero tensors there is no tensor data section, so its alignment
            // padding is never written: such files legitimately end at the tensor
            // index. Keep the check strict otherwise -- the bound below is measured
            // from this offset.
            if (this.count > 0 && tensorDataOffset > fileByteLength) {
                return 'GGUF tensor data offset extends past the end of the file.';
            }
            if (this.furthest !== undefined && tensorDataOffset + this.furthest.end > fileByteLength) {
                return this.furthest.startOnly
                    ? `GGUF tensor "${this.furthest.name}" starts at or past the end of the file.`
                    : `GGUF tensor "${this.furthest.name}" extends past the end of the file.`;
            }
        }
        return this.preview.map((tensor) => ({
            name: tensor.name,
            dtype: tensor.dtype,
            shape: tensor.shape,
            elements: tensor.elements,
            offset: tensor.offset.toString(),
            absoluteOffset: (tensorDataOffset + tensor.offset).toString()
        }));
    }

    quantization(fileType?: number): string | undefined {
        return fileType === undefined ? dominantDtype(this.dtypeCounts) : fileQuantizationTypeName(fileType);
    }
}

interface ResolvedLayout {
    alignment: bigint;
    tensorDataOffset: bigint;
    fileByteLength?: bigint;
}

function rawAlignmentValue(value: MetadataValue | undefined): bigint | string | undefined {
    if (value === undefined) return undefined;
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
    return 'GGUF general.alignment must be a positive uint32 integer.';
}

function validateAlignment(value: bigint | string | undefined): bigint | string {
    if (typeof value === 'string') return value;
    const alignment = value ?? DEFAULT_ALIGNMENT;
    // ggml's loader rejects any alignment that is not a power of two
    // (ggml/src/gguf.cpp: "alignment %zu is not a power of 2"), so a file that gets
    // here is one no llama.cpp-based tool would load. Reject it rather than report
    // offsets nothing else agrees with.
    if (alignment <= 0n || alignment > MAX_UINT32 || (alignment & (alignment - 1n)) !== 0n) {
        return 'GGUF general.alignment must be a uint32 power of two.';
    }
    return alignment;
}

function resolveLayout(
    alignment: bigint,
    tensorInfoEnd: number,
    fileByteLength?: number | bigint
): ResolvedLayout | string {
    // Equivalent to ggml's GGML_PAD bit mask for the power-of-two alignments
    // accepted above, but stays in bigint so it cannot silently lose precision.
    const tensorDataOffset = alignUp(BigInt(tensorInfoEnd), alignment);
    if (tensorDataOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
        return 'GGUF tensor data offset is outside the supported non-negative range.';
    }
    if (fileByteLength === undefined) return { alignment, tensorDataOffset };

    let actualFileSize: bigint;
    if (typeof fileByteLength === 'bigint') {
        actualFileSize = fileByteLength;
    } else if (Number.isSafeInteger(fileByteLength)) {
        actualFileSize = BigInt(fileByteLength);
    } else {
        return 'GGUF file size is outside the supported non-negative range.';
    }
    if (actualFileSize < 0n) return 'GGUF file size is outside the supported non-negative range.';
    if (BigInt(tensorInfoEnd) > actualFileSize) {
        return 'GGUF tensor index extends past the end of the file.';
    }
    return { alignment, tensorDataOffset, fileByteLength: actualFileSize };
}

function validateHeader(
    output: HuggingFaceGgufOutput,
    sourceHeader?: GgufHeaderInfo
): GgufHeaderInfo | string {
    const parsedVersion = numberMetadata(output, 'version');
    const parsedTensorCount = bigintMetadata(output, 'tensor_count');
    const parsedMetadataCount = bigintMetadata(output, 'kv_count');
    if (sourceHeader) {
        const visibleMetadataCount = Object.keys(output.typedMetadata)
            .filter((key) => !INTERNAL_METADATA_KEYS.has(key)).length;
        const reservedFieldMismatch = parsedVersion !== sourceHeader.version
            || parsedTensorCount !== sourceHeader.tensorCount
            || parsedMetadataCount !== sourceHeader.metadataCount;
        const overwrittenKey = BigInt(visibleMetadataCount) !== sourceHeader.metadataCount;
        if (reservedFieldMismatch || overwrittenKey) {
            return 'GGUF metadata collides with parser-reserved header fields or contains duplicate keys.';
        }
        if (sourceHeader.tensorCount !== BigInt(output.tensorInfos.length)) {
            return 'GGUF header tensor count does not match the parsed tensor index.';
        }
        if (sourceHeader.littleEndian !== output.littleEndian) {
            return 'GGUF source header byte order does not match the parsed document.';
        }
        return sourceHeader;
    }

    if (parsedVersion !== 1 && parsedVersion !== 2 && parsedVersion !== 3) {
        return 'GGUF header version is missing or invalid.';
    }
    if (parsedTensorCount === undefined || parsedTensorCount < 0n) {
        return 'GGUF header tensor count is missing or invalid.';
    }
    if (parsedMetadataCount === undefined || parsedMetadataCount < 0n) {
        return 'GGUF header metadata count is missing or invalid.';
    }
    return {
        version: parsedVersion,
        tensorCount: parsedTensorCount,
        metadataCount: parsedMetadataCount,
        littleEndian: output.littleEndian
    };
}

function storage(blockElements: number, blockBytes: number): GgmlStorageLayout {
    return { blockElements: BigInt(blockElements), blockBytes: BigInt(blockBytes) };
}

function alignUp(offset: bigint, alignment: bigint): bigint {
    return offset + (alignment - offset % alignment) % alignment;
}

interface TypedMetadataEntry {
    value: MetadataValue;
    type: GGUFValueType;
    subType?: GGUFValueType;
}

function normalizeMetadataEntry(
    key: string,
    entry: TypedMetadataEntry,
    budget: CharacterBudget
): GgufMetadataEntry {
    const type = valueTypeName(entry.type, entry.subType);
    if (!Array.isArray(entry.value)) {
        return {
            key: budget.take(key, MAX_IDENTIFIER_CHARS),
            type,
            value: budget.take(displayScalar(entry.value), MAX_DISPLAY_STRING_CHARS)
        };
    }

    const preview = entry.value
        .slice(0, ARRAY_PREVIEW_ITEMS)
        .map((value) => displayArrayItem(value));
    const omitted = entry.value.length - preview.length;
    const value = `[${entry.value.length} items] ${preview.join(', ')}${omitted > 0 ? `, … (+${omitted})` : ''}`;
    return {
        key: budget.take(key, MAX_IDENTIFIER_CHARS),
        type,
        value: budget.take(value, MAX_DISPLAY_STRING_CHARS),
        arrayLength: entry.value.length
    };
}

function displayScalar(value: MetadataValue): string {
    if (typeof value === 'string') return truncate(value, MAX_DISPLAY_STRING_CHARS);
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return displayArrayItem(value);
    return String(value);
}

function displayArrayItem(value: MetadataValue): string {
    if (Array.isArray(value)) {
        const preview = value.slice(0, 3).map(displayArrayItem).join(', ');
        return truncate(`[${preview}${value.length > 3 ? ', …' : ''}]`, MAX_ARRAY_ITEM_CHARS);
    }
    if (typeof value === 'string') return JSON.stringify(truncate(value, MAX_ARRAY_ITEM_CHARS));
    if (typeof value === 'bigint') return value.toString();
    return String(value);
}

function valueTypeName(type: GGUFValueType, subType?: GGUFValueType): string {
    const base = enumName(GGUFValueType, Number(type), 'UNKNOWN');
    if (type !== GGUFValueType.ARRAY) return base;
    return subType === undefined ? 'ARRAY' : `ARRAY<${enumName(GGUFValueType, Number(subType), 'UNKNOWN')}>`;
}

function quantizationTypeName(type: number): string {
    return enumName(GGMLQuantizationType, type, 'UNKNOWN');
}

function fileQuantizationTypeName(type: number): string {
    return enumName(GGMLFileQuantizationType, type, 'UNKNOWN');
}

function enumName(values: object, value: number, fallback: string): string {
    const name = (values as Record<number, string | undefined>)[value];
    return name ?? `${fallback}(${value})`;
}

function dominantDtype(counts: ReadonlyMap<string, number>): string | undefined {
    let winner: string | undefined;
    let winnerCount = -1;
    for (const [dtype, count] of counts) {
        if (count > winnerCount) {
            winner = dtype;
            winnerCount = count;
        }
    }
    return winner;
}

function rawMetadata(output: HuggingFaceGgufOutput): Record<string, MetadataValue | undefined> {
    return output.metadata as unknown as Record<string, MetadataValue | undefined>;
}

function scalarMetadata(output: HuggingFaceGgufOutput, key: string): string | undefined {
    const value = rawMetadata(output)[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
    return undefined;
}

function budgetedScalarMetadata(
    output: HuggingFaceGgufOutput,
    key: string,
    budget: CharacterBudget
): string | undefined {
    const value = scalarMetadata(output, key);
    return value === undefined ? undefined : budget.take(value, MAX_IDENTIFIER_CHARS);
}

function numberMetadata(output: HuggingFaceGgufOutput, key: string): number | undefined {
    const value = rawMetadata(output)[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
    return undefined;
}

function bigintMetadata(output: HuggingFaceGgufOutput, key: string): bigint | undefined {
    const value = rawMetadata(output)[key];
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
    return undefined;
}

function truncate(value: string, maxChars: number): string {
    return value.length <= maxChars ? value : `${value.slice(0, maxChars)}… (+${value.length - maxChars} chars)`;
}

class CharacterBudget {
    private remaining: number;
    public truncated = false;

    constructor(limit: number) {
        this.remaining = limit;
    }

    take(value: string, maxChars: number): string {
        const allowed = Math.min(this.remaining, maxChars);
        if (value.length <= allowed) {
            this.remaining -= value.length;
            return value;
        }
        this.truncated = true;
        if (allowed === 0) return '';
        const result = allowed === 1 ? '…' : `${value.slice(0, allowed - 1)}…`;
        this.remaining -= result.length;
        return result;
    }
}

interface ByteRange {
    start: number;
    end: number;
}

interface SatisfiedByteRange extends ByteRange {
    total: number;
}

/**
 * Wraps the transport used by the preflight reader. A server that ignores Range
 * must be rejected before anybody calls response.arrayBuffer(); otherwise a
 * multi-gigabyte model can be materialized just to inspect its header.
 */
function validatedRangeFetch(
    baseFetch: typeof fetch,
    signal?: AbortSignal,
    expectedFileSize?: number,
    onFileSize?: (size: number) => void
): typeof fetch {
    let knownTotal: number | undefined;
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        throwIfAborted(signal);
        const requested = parseRequestedRange(new Headers(init?.headers).get('range'));
        if (!requested) throw new Error('GGUF remote parsing requires a bounded byte Range request.');

        const response = await baseFetch(input, {
            ...init,
            ...(signal ? { signal } : {})
        });
        if (signal?.aborted) {
            cancelResponseBody(response);
            throw abortReason(signal);
        }

        if (response.status === 416) {
            const total = validateUnsatisfiedRangeResponse(response, requested, knownTotal);
            knownTotal = total;
            onFileSize?.(total);
            if (expectedFileSize !== undefined && total !== expectedFileSize) {
                cancelResponseBody(response);
                throw new Error('GGUF Content-Range total does not match the host-provided file byte length.');
            }
            cancelResponseBody(response);
            return new Response(null, {
                status: 416,
                statusText: response.statusText,
                headers: response.headers
            });
        }

        const received = validateRangeResponse(response, requested);
        if (knownTotal !== undefined && received.total !== knownTotal) {
            cancelResponseBody(response);
            throw new Error('GGUF server changed the total file size between range responses.');
        }
        knownTotal = received.total;
        onFileSize?.(received.total);
        if (expectedFileSize !== undefined && received.total !== expectedFileSize) {
            cancelResponseBody(response);
            throw new Error('GGUF Content-Range total does not match the host-provided file byte length.');
        }
        const expectedBytes = received.end - received.start + 1;
        const body = await readBoundedResponse(response, expectedBytes, signal);
        return new Response(body.buffer as ArrayBuffer, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });
    }) as typeof fetch;
}

function validateSourceHeaderResourceLimits(header: GgufHeaderInfo): void {
    if (header.tensorCount > BigInt(GGUF_PARSE_TENSOR_LIMIT)) {
        throw new Error(
            `GGUF tensor count ${header.tensorCount} exceeds the viewer parsing limit (${GGUF_PARSE_TENSOR_LIMIT}).`
        );
    }
    if (header.metadataCount > BigInt(GGUF_PARSE_METADATA_LIMIT)) {
        throw new Error(
            `GGUF metadata count ${header.metadataCount} exceeds the viewer parsing limit (${GGUF_PARSE_METADATA_LIMIT}).`
        );
    }
}

interface GgufMetadataBudget {
    stringBytes: bigint;
    /** Set once the cumulative limit is reached; further strings are skipped. */
    exhausted: boolean;
}

/** Preview of one metadata entry, gathered without materializing whole arrays. */
interface GgufPreflightEntry {
    key: string;
    type: number;
    subType?: number;
    /** Exact declared length; kept as bigint because a declared array can be huge. */
    arrayLength?: bigint;
    /** Display text for a scalar, or for the first ARRAY_PREVIEW_ITEMS array items. */
    preview: string[];
    /**
     * The scalar's text before the shared character budget could truncate it.
     * `general.alignment` and `general.file_type` are parsed from this, so a
     * document whose budget ran out mid-walk still computes correct offsets.
     */
    raw?: string;
}

/** Metadata keys the document model reads as values rather than rendering as rows. */
const SCALAR_METADATA_KEYS = new Set([
    'general.alignment',
    'general.architecture',
    'general.file_type',
    'general.name',
    'general.type'
]);

interface GgufPreflightResult {
    header: GgufHeaderInfo;
    entries: GgufPreflightEntry[];
    /** Captured regardless of the preview cap, so a late key still reaches the model. */
    scalars: Map<string, GgufPreflightEntry>;
    text: CharacterBudget;
    tensors: TensorIndexWalk;
    tensorInfoEnd: number;
}

const FIXED_VALUE_BYTES: Readonly<Record<number, number>> = {
    [GGUFValueType.UINT8]: 1, [GGUFValueType.INT8]: 1,
    [GGUFValueType.UINT16]: 2, [GGUFValueType.INT16]: 2,
    [GGUFValueType.UINT32]: 4, [GGUFValueType.INT32]: 4,
    [GGUFValueType.FLOAT32]: 4, [GGUFValueType.BOOL]: 1,
    [GGUFValueType.UINT64]: 8, [GGUFValueType.INT64]: 8,
    [GGUFValueType.FLOAT64]: 8
};

/**
 * Reads everything the document needs directly from the source bytes: the header,
 * the metadata block, and the tensor index that follows it.
 *
 * Two separate properties keep this constant-memory. Metadata array bodies are
 * skipped past ARRAY_PREVIEW_ITEMS, so a 512K-entry vocabulary costs the same as a
 * 32-entry one. The tensor index is walked to its end -- it has to be, because
 * entries are variable-length and `tensorDataOffset` is the aligned position after
 * the last of them -- but only the first GGUF_PREVIEW_ENTRY_LIMIT are retained,
 * with the rest folded into running sums by TensorIndexWalk.
 */
async function preflightGguf(
    uri: string,
    fetchRange: typeof fetch,
    signal?: AbortSignal
): Promise<GgufPreflightResult> {
    const reader = new GgufPreflightReader(uri, fetchRange, signal);
    const magic = await reader.read(4);
    if (magic[0] !== 0x47 || magic[1] !== 0x47 || magic[2] !== 0x55 || magic[3] !== 0x46) {
        throw new Error('Not a valid GGUF file: invalid magic bytes.');
    }
    const versionBytes = await reader.read(4);
    const versionView = new DataView(versionBytes.buffer, versionBytes.byteOffset, 4);
    const littleVersion = versionView.getUint32(0, true);
    const littleEndian = (littleVersion & 0xffff) !== 0;
    const version = versionView.getUint32(0, littleEndian);
    if (version !== 1 && version !== 2 && version !== 3) {
        throw new Error(`GGUF source uses unsupported version "${version}".`);
    }
    const tensorCount = await reader.readCount(version, littleEndian);
    const metadataCount = await reader.readCount(version, littleEndian);
    const header: GgufHeaderInfo = { version, tensorCount, metadataCount, littleEndian };
    validateSourceHeaderResourceLimits(header);

    const budget: GgufMetadataBudget = { stringBytes: 0n, exhausted: false };
    const text = new CharacterBudget(GGUF_NORMALIZED_TEXT_BUDGET);
    const entries: GgufPreflightEntry[] = [];
    const scalars = new Map<string, GgufPreflightEntry>();
    for (let index = 0n; index < metadataCount; index += 1n) {
        const key = await readGgufString(reader, version, littleEndian, MAX_IDENTIFIER_CHARS, budget) ?? '';
        const type = await reader.readU32(littleEndian);
        const rendered = entries.length < GGUF_PREVIEW_ENTRY_LIMIT;
        const wanted = SCALAR_METADATA_KEYS.has(key);
        // Entries past the preview cap are walked for positioning only. Decoding
        // them would spend the shared text budget on rows nothing renders, and
        // starve the rows that do get rendered.
        const entry = rendered || wanted
            ? { key: rendered ? text.take(key, MAX_IDENTIFIER_CHARS) : key, type, preview: [] }
            : undefined;
        if (entry && rendered) entries.push(entry);
        if (entry && wanted && !scalars.has(key)) scalars.set(key, entry);
        await readGgufValue(
            reader, type, version, littleEndian, budget, rendered ? text : undefined, 0, entry
        );
    }
    // Text dropped by the cumulative string limit is reported the same way any
    // other per-field truncation is.
    if (budget.exhausted) text.truncated = true;

    // Needed before the walk starts: every tensor offset is checked against it.
    const alignment = validateAlignment(preflightAlignment(scalars.get('general.alignment')));
    if (typeof alignment === 'string') throw new Error(alignment);

    const walk = new TensorIndexWalk(alignment, text);
    for (let index = 0n; index < tensorCount; index += 1n) {
        // Tensor names are not charged against the cumulative metadata string
        // budget: they are bounded by GGUF_PARSE_TENSOR_LIMIT and are read one at a
        // time, and a document should not lose its tensor table to a fat vocabulary.
        const name = await readGgufString(reader, version, littleEndian, MAX_IDENTIFIER_CHARS) ?? '';
        const dimensions = await reader.readU32(littleEndian);
        if (dimensions > MAX_TENSOR_DIMENSIONS) {
            throw new Error(
                `GGUF tensor "${truncate(name, MAX_IDENTIFIER_CHARS)}" declares ${dimensions} dimensions, `
                + `more than ggml supports (${MAX_TENSOR_DIMENSIONS}).`
            );
        }
        const shape: bigint[] = [];
        for (let axis = 0; axis < dimensions; axis += 1) {
            shape.push(await reader.readCount(version, littleEndian));
        }
        const dtype = await reader.readU32(littleEndian);
        // The tensor offset is a uint64 in every GGUF version, unlike the sizes above.
        const offsetBytes = await reader.read(8);
        const offset = new DataView(offsetBytes.buffer, offsetBytes.byteOffset, 8)
            .getBigUint64(0, littleEndian);
        const failure = walk.add(name, shape, dtype, offset);
        if (failure) throw new Error(failure);
    }

    return { header, entries, scalars, text, tensors: walk, tensorInfoEnd: reader.position };
}

/** Builds the document from a completed preflight walk. */
function preflightDocument(
    source: GgufPreflightResult,
    fileSize: string,
    fileByteLength?: number
): GgufDocument {
    const { header, entries, scalars, text, tensors: walk } = source;
    const layout = resolveLayout(walk.alignment, source.tensorInfoEnd, fileByteLength);
    if (typeof layout === 'string') return invalid(fileSize, layout);

    return assembleGgufDocument({
        version: header.version,
        littleEndian: header.littleEndian,
        metadata: entries.map(preflightMetadataEntry),
        metadataCount: Number(header.metadataCount),
        // The walk consumes exactly the declared number of entries or fails, so a
        // count that disagrees with the header is not representable here.
        metadataCountMismatch: false,
        scalars: {
            architecture: preflightText(scalars.get('general.architecture'), text),
            name: preflightText(scalars.get('general.name'), text),
            type: preflightText(scalars.get('general.type'), text),
            fileType: preflightUnsigned(scalars.get('general.file_type'))
        },
        walk,
        layout,
        text
    }, fileSize);
}

/** Scalars are stored as their formatted text; only unsigned digits round-trip. */
function preflightUnsigned(entry?: GgufPreflightEntry): number | undefined {
    if (entry?.raw === undefined || entry.arrayLength !== undefined) return undefined;
    if (FIXED_VALUE_BYTES[entry.type] === undefined || !/^\d+$/.test(entry.raw)) return undefined;
    const value = Number(entry.raw);
    return Number.isSafeInteger(value) ? value : undefined;
}

function preflightAlignment(entry?: GgufPreflightEntry): bigint | string | undefined {
    if (entry === undefined) return undefined;
    if (entry.raw === undefined || entry.arrayLength !== undefined
        || FIXED_VALUE_BYTES[entry.type] === undefined || !/^\d+$/.test(entry.raw)) {
        return 'GGUF general.alignment must be a positive uint32 integer.';
    }
    return BigInt(entry.raw);
}

function preflightText(entry: GgufPreflightEntry | undefined, text: CharacterBudget): string | undefined {
    if (entry?.raw === undefined || entry.arrayLength !== undefined) return undefined;
    return text.take(entry.raw, MAX_IDENTIFIER_CHARS);
}

/**
 * Reads one metadata value, advancing the reader past it exactly. `entry`, when
 * given, receives the preview; otherwise the value is walked for budget accounting
 * and reader positioning only. `text`, when given, charges the preview against the
 * shared display budget; `entry.raw` always keeps the uncharged scalar text.
 */
async function readGgufValue(
    reader: GgufPreflightReader,
    type: number,
    version: 1 | 2 | 3,
    littleEndian: boolean,
    budget: GgufMetadataBudget,
    text: CharacterBudget | undefined,
    depth: number,
    entry?: GgufPreflightEntry
): Promise<void> {
    const size = FIXED_VALUE_BYTES[type];
    if (size !== undefined) {
        if (!entry) {
            await reader.skip(size);
            return;
        }
        record(entry, text, formatFixedValue(type, await reader.read(size), littleEndian), depth);
        return;
    }
    if (type === GGUFValueType.STRING) {
        const value = await readGgufString(
            reader, version, littleEndian, entry ? MAX_ARRAY_ITEM_CHARS : 0, budget
        );
        if (!entry) return;
        // Top-level strings read as themselves; array items are quoted, matching
        // displayScalar / displayArrayItem on the upstream-parsed path.
        record(entry, text, depth === 0 ? (value ?? '') : JSON.stringify(value ?? ''), depth);
        return;
    }
    if (type !== GGUFValueType.ARRAY || depth >= 4) {
        throw new Error(`GGUF metadata contains an unsupported type or nesting depth (${type}).`);
    }

    const subtype = await reader.readU32(littleEndian);
    const length = await reader.readCount(version, littleEndian);
    if (entry && depth === 0) {
        entry.subType = subtype;
        entry.arrayLength = length;
    }
    const subtypeSize = FIXED_VALUE_BYTES[subtype];
    if (subtypeSize === undefined && subtype !== GGUFValueType.STRING && subtype !== GGUFValueType.ARRAY) {
        throw new Error(`GGUF metadata array uses an unsupported element type (${subtype}).`);
    }
    // An element cannot be smaller than its own fixed width, or than the length
    // prefix that introduces it. A declared count the rest of the file cannot
    // physically hold is a malformed file rather than a budget question -- and this
    // is what stops a hostile length from driving an unbounded walk, so no tuned
    // element ceiling has to stand in for it.
    const minimumElementBytes = BigInt(subtypeSize ?? (version === 1 ? 4 : 8));
    if (length * minimumElementBytes > reader.remainingBytes) {
        throw new Error(
            `GGUF metadata array declares ${length} elements, more than the remaining file bytes can hold.`
        );
    }

    // Only the head of an array is materialized; nested arrays report their length
    // rather than recursing into a preview, which keeps the walk depth-independent.
    const previewCount = entry && depth === 0
        ? Number(length < BigInt(ARRAY_PREVIEW_ITEMS) ? length : BigInt(ARRAY_PREVIEW_ITEMS))
        : 0;
    for (let index = 0; index < previewCount; index += 1) {
        await readGgufValue(reader, subtype, version, littleEndian, budget, text, depth + 1, entry);
    }
    const remaining = length - BigInt(previewCount);
    if (subtypeSize !== undefined) {
        await reader.skip(Number(remaining * BigInt(subtypeSize)));
    } else {
        for (let index = 0n; index < remaining; index += 1n) {
            await readGgufValue(reader, subtype, version, littleEndian, budget, text, depth + 1);
        }
    }
    if (!entry || depth === 0) return;
    record(entry, text, `[${length} items]`, depth);
}

function record(entry: GgufPreflightEntry, text: CharacterBudget | undefined, value: string, depth: number): void {
    if (depth === 0 && entry.raw === undefined) entry.raw = value;
    entry.preview.push(text ? text.take(value, MAX_DISPLAY_STRING_CHARS) : value);
}

/**
 * Consumes a GGUF string. `maxChars` of 0 skips it entirely; otherwise only the
 * leading bytes that can cover the cap are read, and the tail is skipped. `budget`
 * is omitted for strings outside the metadata block, such as tensor names.
 */
async function readGgufString(
    reader: GgufPreflightReader,
    version: 1 | 2 | 3,
    littleEndian: boolean,
    maxChars: number,
    budget?: GgufMetadataBudget
): Promise<string | undefined> {
    const length = await reader.readCount(version, littleEndian);
    let allowed = maxChars;
    if (budget) {
        budget.stringBytes += length;
        // Past the budget the walk continues but stops decoding: skipping costs
        // nothing and keeps the tensor index reachable, so a file with unusually
        // heavy metadata loses display text rather than its tensor table.
        if (budget.stringBytes > BigInt(GGUF_PARSE_STRING_BYTE_LIMIT)) {
            budget.exhausted = true;
            allowed = 0;
        }
    }
    if (length > reader.remainingBytes) throw new Error(READER_EOF_MESSAGE);
    const byteLength = Number(length);
    if (allowed <= 0) {
        await reader.skip(byteLength);
        return undefined;
    }
    // UTF-8 encodes a code point in at most 4 bytes, so this always covers allowed.
    const head = Math.min(byteLength, allowed * 4);
    const bytes = await reader.read(head);
    await reader.skip(byteLength - head);
    return truncate(new TextDecoder().decode(bytes), allowed);
}

function formatFixedValue(type: number, bytes: Uint8Array, littleEndian: boolean): string {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (type) {
        case GGUFValueType.UINT8: return String(view.getUint8(0));
        case GGUFValueType.INT8: return String(view.getInt8(0));
        case GGUFValueType.UINT16: return String(view.getUint16(0, littleEndian));
        case GGUFValueType.INT16: return String(view.getInt16(0, littleEndian));
        case GGUFValueType.UINT32: return String(view.getUint32(0, littleEndian));
        case GGUFValueType.INT32: return String(view.getInt32(0, littleEndian));
        case GGUFValueType.FLOAT32: return String(view.getFloat32(0, littleEndian));
        case GGUFValueType.FLOAT64: return String(view.getFloat64(0, littleEndian));
        case GGUFValueType.UINT64: return view.getBigUint64(0, littleEndian).toString();
        case GGUFValueType.INT64: return view.getBigInt64(0, littleEndian).toString();
        case GGUFValueType.BOOL: return view.getUint8(0) !== 0 ? 'true' : 'false';
        default: return '';
    }
}

const READER_EOF_MESSAGE = 'GGUF metadata or tensor index extends past the end of the file.';

/**
 * A forward-only cursor over a remote or local file, holding exactly one chunk at
 * a time. Chunks are fetched lazily and replaced rather than accumulated, so peak
 * memory is CHUNK_BYTES regardless of how far the cursor travels.
 */
class GgufPreflightReader {
    private cursor = 0;
    private chunkStart = -1;
    private chunk = new Uint8Array();
    /** Learned from the first Content-Range; every range response carries it. */
    private totalBytes: number | undefined;
    private static readonly CHUNK_BYTES = 2_000_000;

    constructor(
        private readonly uri: string,
        private readonly fetchRange: typeof fetch,
        private readonly signal?: AbortSignal
    ) {}

    get position(): number {
        return this.cursor;
    }

    /** Bytes between the cursor and EOF, for validating declared lengths up front. */
    get remainingBytes(): bigint {
        return BigInt(this.fileBytes - this.cursor);
    }

    async read(length: number): Promise<Uint8Array> {
        const result = new Uint8Array(length);
        let written = 0;
        while (written < length) {
            await this.ensureChunk();
            const offset = this.cursor - this.chunkStart;
            const take = Math.min(length - written, this.chunk.byteLength - offset);
            if (take <= 0) throw new Error(READER_EOF_MESSAGE);
            result.set(this.chunk.subarray(offset, offset + take), written);
            this.cursor += take;
            written += take;
        }
        return result;
    }

    /**
     * Advances without fetching. Skipped bytes are never transferred, so a
     * multi-megabyte vocabulary between two read positions costs no requests at
     * all -- which is why the file size, rather than a short chunk, is what proves
     * the skipped region exists.
     */
    async skip(length: number): Promise<void> {
        if (!Number.isSafeInteger(length) || length < 0) throw new Error('GGUF metadata length is invalid.');
        if (length > this.fileBytes - this.cursor) throw new Error(READER_EOF_MESSAGE);
        this.cursor += length;
    }

    async readU32(littleEndian: boolean): Promise<number> {
        const bytes = await this.read(4);
        return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, littleEndian);
    }

    async readCount(version: 1 | 2 | 3, littleEndian: boolean): Promise<bigint> {
        if (version === 1) return BigInt(await this.readU32(littleEndian));
        const bytes = await this.read(8);
        return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, littleEndian);
    }

    private get fileBytes(): number {
        if (this.totalBytes === undefined) {
            throw new Error('GGUF range responses did not report the total file size.');
        }
        return this.totalBytes;
    }

    private async ensureChunk(): Promise<void> {
        if (this.cursor >= this.chunkStart && this.cursor < this.chunkStart + this.chunk.byteLength) return;
        throwIfAborted(this.signal);
        const start = Math.floor(this.cursor / GgufPreflightReader.CHUNK_BYTES) * GgufPreflightReader.CHUNK_BYTES;
        const end = start + GgufPreflightReader.CHUNK_BYTES - 1;
        const response = await this.fetchRange(this.uri, {
            headers: { Range: `bytes=${start}-${end}` },
            ...(this.signal ? { signal: this.signal } : {})
        });
        if (response.status !== 206) throw new Error(READER_EOF_MESSAGE);
        const total = Number(response.headers.get('content-range')?.match(/\/(\d+)\s*$/)?.[1]);
        if (Number.isSafeInteger(total) && total >= 0) this.totalBytes = total;
        this.chunk = new Uint8Array(await response.arrayBuffer());
        this.chunkStart = start;
    }
}

function parseRequestedRange(value: string | null): ByteRange | undefined {
    const match = value?.match(/^bytes=(\d+)-(\d+)$/i);
    if (!match) return undefined;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return undefined;
    return { start, end };
}

function validateRangeResponse(response: Response, requested: ByteRange): SatisfiedByteRange {
    if (response.status !== 206) {
        cancelResponseBody(response);
        throw new Error(
            `GGUF server must support byte ranges: expected HTTP 206, received ${response.status}.`
        );
    }

    const value = response.headers.get('content-range');
    const match = value?.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
    if (!match) {
        cancelResponseBody(response);
        throw new Error('GGUF server returned an invalid or missing Content-Range header.');
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = Number(match[3]);
    const expectedEnd = Number.isSafeInteger(total) && total > 0
        ? Math.min(requested.end, total - 1)
        : -1;
    const valid = Number.isSafeInteger(start)
        && Number.isSafeInteger(end)
        && Number.isSafeInteger(total)
        && start === requested.start
        && end >= start
        && end === expectedEnd
        && total > end;
    if (!valid) {
        cancelResponseBody(response);
        throw new Error('GGUF server returned a Content-Range that does not match the requested byte range.');
    }
    return { start, end, total };
}

function validateUnsatisfiedRangeResponse(
    response: Response,
    requested: ByteRange,
    knownTotal?: number
): number {
    const value = response.headers.get('content-range');
    const match = value?.match(/^bytes\s+\*\/(\d+)$/i);
    const total = match ? Number(match[1]) : Number.NaN;
    const valid = Number.isSafeInteger(total)
        && total >= 0
        && requested.start >= total
        && (knownTotal === undefined || knownTotal === total);
    if (!valid) {
        cancelResponseBody(response);
        throw new Error('GGUF server returned an invalid Range Not Satisfiable response.');
    }
    return total;
}

async function readBoundedResponse(
    response: Response,
    expectedBytes: number,
    signal?: AbortSignal
): Promise<Uint8Array> {
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) {
        const length = Number(declaredLength);
        if (Number.isSafeInteger(length) && length > expectedBytes) {
            cancelResponseBody(response);
            throw new Error('GGUF range response is larger than its declared Content-Range.');
        }
    }

    if (!response.body) {
        if (expectedBytes === 0) return new Uint8Array();
        throw new Error('GGUF range response did not contain a body.');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
        while (true) {
            throwIfAborted(signal);
            const { done, value } = await reader.read();
            if (done) break;
            byteLength += value.byteLength;
            if (byteLength > expectedBytes) {
                await reader.cancel();
                throw new Error('GGUF range response is larger than its declared Content-Range.');
            }
            chunks.push(value);
        }
    } catch (error) {
        try { await reader.cancel(); } catch { /* already closed */ }
        throw error;
    } finally {
        reader.releaseLock();
    }
    throwIfAborted(signal);
    if (byteLength !== expectedBytes) {
        throw new Error('GGUF range response length does not match its Content-Range.');
    }

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

function cancelResponseBody(response: Response): void {
    if (!response.body) return;
    void response.body.cancel().catch(() => { /* best-effort transport cleanup */ });
}

function memoryRangeFetch(input: Uint8Array): typeof fetch {
    return (async (_resource: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const requested = parseRequestedRange(new Headers(init?.headers).get('range'));
        if (!requested) return new Response(null, { status: 400 });
        if (requested.start >= input.byteLength) {
            return new Response(null, {
                status: 416,
                headers: { 'Content-Range': `bytes */${input.byteLength}` }
            });
        }
        const end = Math.min(requested.end, input.byteLength - 1);
        const bytes = input.slice(requested.start, end + 1);
        return new Response(bytes.buffer as ArrayBuffer, {
            status: 206,
            headers: {
                'Content-Range': `bytes ${requested.start}-${end}/${input.byteLength}`,
                'Content-Length': String(bytes.byteLength)
            }
        });
    }) as typeof fetch;
}

/** Formats a byte count for display. Every GGUF entry point must use this one so
 *  the same file is not labelled "4.00 KB" locally and "4.00 KiB" in memory. */
export function formatByteSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} bytes`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes / 1024;
    let unit = units[0]!;
    for (let index = 1; index < units.length && value >= 1024; index += 1) {
        value /= 1024;
        unit = units[index]!;
    }
    return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted.', 'AbortError');
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function preflightMetadataEntry(entry: GgufPreflightEntry): GgufMetadataEntry {
    const type = valueTypeName(entry.type as GGUFValueType, entry.subType as GGUFValueType | undefined);
    if (entry.arrayLength === undefined) {
        return { key: entry.key, type, value: truncate(entry.preview[0] ?? '', MAX_DISPLAY_STRING_CHARS) };
    }
    const omitted = entry.arrayLength - BigInt(entry.preview.length);
    const value = `[${entry.arrayLength} items] ${entry.preview.join(', ')}`
        + (omitted > 0n ? `, … (+${omitted})` : '');
    return {
        key: entry.key,
        type,
        value: truncate(value, MAX_DISPLAY_STRING_CHARS),
        // The array that tripped the budget can declare a length past 2^53; its exact
        // value stays in the display text above rather than being rounded here.
        ...(entry.arrayLength <= BigInt(Number.MAX_SAFE_INTEGER)
            ? { arrayLength: Number(entry.arrayLength) }
            : {})
    };
}

function invalid(fileSize: string, message: string): GgufDocument {
    return {
        format: 'gguf',
        title: 'GGUF model',
        fileSize: truncate(fileSize, MAX_FILE_SIZE_LABEL_CHARS),
        summary: [{ labelKey: 'gguf.summary.status', value: 'invalid' }],
        metadata: [],
        tensors: [],
        tables: [],
        rawPreview: undefined,
        warnings: [{ key: 'gguf.warning.invalid' }],
        errorDetail: truncate(message, MAX_ERROR_MESSAGE_CHARS)
    };
}

/** Compact exact bigint counts, e.g. 1.20B, 350.0M, 12.3K. */
export function formatBigCount(count: bigint): string {
    const units: Array<[bigint, string]> = [
        [1_000_000_000_000n, 'T'],
        [1_000_000_000n, 'B'],
        [1_000_000n, 'M'],
        [1_000n, 'K']
    ];
    for (const [threshold, suffix] of units) {
        if (count < threshold) continue;
        const tenths = count * 10n / threshold;
        const whole = tenths / 10n;
        const fraction = tenths % 10n;
        return fraction === 0n ? `${whole}${suffix}` : `${whole}.${fraction}${suffix}`;
    }
    return count.toString();
}
