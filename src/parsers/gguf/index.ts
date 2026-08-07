import {
    GGMLFileQuantizationType,
    GGMLQuantizationType,
    GGUFValueType,
    gguf,
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
 * The upstream parser necessarily owns the complete tensor index. Do not then
 * multiply that attacker-controlled allocation across the document model,
 * table rows, structure text, and clipboard JSON.
 */
export const GGUF_PREVIEW_ENTRY_LIMIT = 1_000;
/** Total user-controlled characters copied into normalized display structures. */
export const GGUF_NORMALIZED_TEXT_BUDGET = 2_000_000;
/** Admission limits enforced from source bytes before @huggingface/gguf allocates entry objects. */
export const GGUF_PARSE_TENSOR_LIMIT = 100_000;
export const GGUF_PARSE_METADATA_LIMIT = 10_000;
export const GGUF_PARSE_ARRAY_ELEMENT_LIMIT = 1_000_000;
export const GGUF_PARSE_STRING_BYTE_LIMIT = 16 * 1024 * 1024;
const GGUF_PARSE_COMPLEX_ARRAY_LIMIT = 300_000;

/**
 * Parses a remote GGUF URL. Node local files use the abortable `./node` helper.
 * Tensor payload bytes are not decoded; @huggingface/gguf range-reads only the
 * metadata and tensor-info prefix.
 */
export async function parseGgufUri(uri: string, options: GgufParseOptions = {}): Promise<GgufDocument> {
    let remoteFileSize: number | undefined;
    try {
        throwIfAborted(options.signal);
        if (options.fileByteLength !== undefined
            && (!Number.isSafeInteger(options.fileByteLength) || options.fileByteLength < 0)) {
            throw new Error('GGUF host-provided file byte length must be a non-negative safe integer.');
        }
        const fetchImpl = options.fetch ?? globalThis.fetch;
        let sourceHeader: GgufHeaderInfo | undefined;
        let preflighting = true;
        // Replaying the preflight's chunks to the upstream parser is what makes the
        // preflight binding: without a cache hit the parser refetches, and a hostile
        // server can serve small metadata to the preflight and huge metadata to the
        // real parse. Hits require our range keys to match the upstream reader's --
        // see GgufPreflightReader.CHUNK_BYTES for the constant that has to stay in sync.
        const replayCache = new Map<string, CachedRangeResponse>();
        const rangeFetch = validatedRangeFetch(
            fetchImpl,
            options.signal,
            options.fileByteLength,
            (size) => { remoteFileSize = size; },
            (bytes) => {
                const header = parseGgufHeader(bytes);
                validateSourceHeaderResourceLimits(header);
                sourceHeader = header;
            },
            replayCache,
            () => preflighting
        );
        await preflightGgufMetadata(rangeFetch, options.signal);
        preflighting = false;
        const output = await gguf(uri, {
            typedMetadata: true,
            fetch: rangeFetch
        });
        throwIfAborted(options.signal);
        if (!sourceHeader) throw new Error('GGUF source header was not available from the initial range response.');
        const displayFileSize = options.fileSize
            ?? (remoteFileSize === undefined ? 'Unknown' : formatByteSize(remoteFileSize));
        return normalizeGguf(
            output,
            displayFileSize,
            remoteFileSize ?? options.fileByteLength,
            sourceHeader
        );
    } catch (error) {
        if (options.signal?.aborted) throw abortReason(options.signal);
        const displayFileSize = options.fileSize
            ?? (remoteFileSize === undefined ? 'Unknown' : formatByteSize(remoteFileSize));
        return invalid(displayFileSize, errorMessage(error));
    }
}

/** Parses a complete in-memory input while preserving the upstream range-reader path. */
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

/** Converts @huggingface/gguf output to Omni Viewer's JSON-safe document model. */
export function normalizeGguf(
    output: HuggingFaceGgufOutput,
    fileSize = 'Unknown',
    fileByteLength?: number | bigint,
    sourceHeader?: GgufHeaderInfo
): GgufDocument {
    const header = validateHeader(output, sourceHeader);
    if (typeof header === 'string') return invalid(fileSize, header);
    const layout = validateLayout(output, fileByteLength);
    if (typeof layout === 'string') return invalid(fileSize, layout);

    const warnings: GgufWarning[] = [];
    const textBudget = new CharacterBudget(GGUF_NORMALIZED_TEXT_BUDGET);
    const version = header.version;
    const architecture = budgetedScalarMetadata(output, 'general.architecture', textBudget);
    const modelName = budgetedScalarMetadata(output, 'general.name', textBudget);
    const generalType = budgetedScalarMetadata(output, 'general.type', textBudget);
    const typedMetadata = output.typedMetadata as Record<string, TypedMetadataEntry>;
    const metadata: GgufMetadataEntry[] = [];
    let parsedMetadataCount = 0;
    for (const key in typedMetadata) {
        if (!Object.prototype.hasOwnProperty.call(typedMetadata, key) || INTERNAL_METADATA_KEYS.has(key)) continue;
        parsedMetadataCount += 1;
        if (metadata.length < GGUF_PREVIEW_ENTRY_LIMIT) {
            metadata.push(normalizeMetadataEntry(key, typedMetadata[key]!, textBudget));
        }
    }

    const dtypeCounts = new Map<string, number>();
    let totalParameters = 0n;
    let unknownDtype = false;
    const tensors: GgufTensor[] = [];
    const rawPreviewLines: string[] = [];
    for (const tensor of output.tensorInfos) {
        const dtype = quantizationTypeName(Number(tensor.dtype));
        if (dtype.startsWith('UNKNOWN')) unknownDtype = true;
        dtypeCounts.set(dtype, (dtypeCounts.get(dtype) ?? 0) + 1);

        const elements = tensor.shape.reduce((count, dimension) => count * dimension, 1n);
        totalParameters += elements;
        if (tensors.length < GGUF_PREVIEW_ENTRY_LIMIT) {
            const absoluteOffset = layout.tensorDataOffset + tensor.offset;
            const normalized = {
                name: textBudget.take(tensor.name, MAX_IDENTIFIER_CHARS),
                dtype,
                shape: tensor.shape.map(String),
                elements: elements.toString(),
                offset: tensor.offset.toString(),
                absoluteOffset: absoluteOffset.toString()
            };
            tensors.push(normalized);
            rawPreviewLines.push(
                textBudget.take(
                    `${normalized.name}  `
                    + `[${normalized.shape.length ? normalized.shape.join(' × ') : 'scalar'}]  ${normalized.dtype}`,
                    MAX_DISPLAY_STRING_CHARS
                )
            );
        }
    }

    if (unknownDtype || layout.unverifiedTensorStorage) {
        warnings.push({ key: 'gguf.warning.unverifiedDtype' });
    }
    // Only reachable for callers that invoke normalizeGguf without a source header:
    // when one is supplied, validateHeader has already rejected this same mismatch
    // outright, because a verified header makes a disagreeing count an error rather
    // than something worth rendering.
    const declaredMetadataCount = header.metadataCount;
    if (declaredMetadataCount !== undefined && declaredMetadataCount !== BigInt(parsedMetadataCount)) {
        warnings.push({ key: 'gguf.warning.metadataCountMismatch' });
    }
    if (output.tensorInfos.length > tensors.length) {
        warnings.push({
            key: 'gguf.warning.tensorsLimited',
            args: { shown: tensors.length, total: output.tensorInfos.length }
        });
    }
    if (parsedMetadataCount > metadata.length) {
        warnings.push({
            key: 'gguf.warning.metadataLimited',
            args: { shown: metadata.length, total: parsedMetadataCount }
        });
    }
    const fileType = numberMetadata(output, 'general.file_type');
    const quantization = fileType === undefined
        ? dominantDtype(dtypeCounts)
        : fileQuantizationTypeName(fileType);

    const summary: GgufSummaryItem[] = [
        { labelKey: 'gguf.summary.version', value: `GGUF v${version}` },
        { labelKey: 'gguf.summary.architecture', value: architecture ?? '—' },
        { labelKey: 'gguf.summary.tensors', value: output.tensorInfos.length },
        { labelKey: 'gguf.summary.parameters', value: formatBigCount(totalParameters) },
        { labelKey: 'gguf.summary.quantization', value: quantization ?? '—' },
        { labelKey: 'gguf.summary.metadataKeys', value: parsedMetadataCount }
    ];
    if (generalType) summary.splice(2, 0, { labelKey: 'gguf.summary.type', value: generalType });

    const tables: GgufTable[] = [
        {
            titleKey: 'gguf.table.tensors',
            titleArgs: { count: output.tensorInfos.length },
            headerKeys: ['gguf.column.name', 'gguf.column.dtype', 'gguf.column.shape', 'gguf.column.parameters', 'gguf.column.offset'],
            rows: tensors.map((tensor) => [
                textBudget.take(tensor.name, MAX_IDENTIFIER_CHARS),
                tensor.dtype,
                tensor.shape.length ? tensor.shape.join(' × ') : 'scalar',
                tensor.elements,
                tensor.absoluteOffset
            ])
        },
        {
            titleKey: 'gguf.table.metadata',
            titleArgs: { count: parsedMetadataCount },
            headerKeys: ['gguf.column.key', 'gguf.column.type', 'gguf.column.value'],
            rows: metadata.map((entry) => [
                textBudget.take(entry.key, MAX_IDENTIFIER_CHARS),
                entry.type,
                textBudget.take(entry.value, MAX_DISPLAY_STRING_CHARS)
            ])
        }
    ];

    if (textBudget.truncated) {
        warnings.push({ key: 'gguf.warning.textTruncated' });
    }

    const rawPreview = rawPreviewLines.length ? rawPreviewLines.join('\n') : undefined;

    return {
        format: 'gguf',
        title: modelName ?? 'GGUF model',
        fileSize: truncate(fileSize, MAX_FILE_SIZE_LABEL_CHARS),
        ...(version === undefined ? {} : { version }),
        byteOrder: output.littleEndian ? 'little-endian' : 'big-endian',
        tensorDataOffset: layout.tensorDataOffset.toString(),
        summary,
        metadata,
        tensors,
        tables,
        rawPreview,
        warnings
    };
}

interface ValidatedLayout {
    alignment: bigint;
    tensorDataOffset: bigint;
    unverifiedTensorStorage: boolean;
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

function validateLayout(output: HuggingFaceGgufOutput, fileByteLength?: number | bigint): ValidatedLayout | string {
    const rawAlignment = rawMetadata(output)['general.alignment'];
    let alignment: bigint;
    if (rawAlignment === undefined) {
        alignment = DEFAULT_ALIGNMENT;
    } else if (typeof rawAlignment === 'bigint') {
        alignment = rawAlignment;
    } else if (typeof rawAlignment === 'number' && Number.isSafeInteger(rawAlignment)) {
        alignment = BigInt(rawAlignment);
    } else {
        return 'GGUF general.alignment must be a positive uint32 integer.';
    }
    // ggml's loader rejects any alignment that is not a power of two
    // (ggml/src/gguf.cpp: "alignment %zu is not a power of 2"), so a file that gets
    // here is one no llama.cpp-based tool would load. Reject it rather than report
    // offsets nothing else agrees with.
    if (alignment <= 0n || alignment > MAX_UINT32 || (alignment & (alignment - 1n)) !== 0n) {
        return 'GGUF general.alignment must be a uint32 power of two.';
    }
    if (typeof output.tensorDataOffset !== 'bigint' || output.tensorDataOffset < 0n) {
        return 'GGUF tensor data offset is outside the supported non-negative range.';
    }

    const tensorInfoStart = output.tensorInfoByteRange?.[0];
    const tensorInfoEnd = output.tensorInfoByteRange?.[1];
    if (!Number.isSafeInteger(tensorInfoStart)
        || !Number.isSafeInteger(tensorInfoEnd)
        || tensorInfoStart < 0
        || tensorInfoEnd < tensorInfoStart) {
        return 'GGUF tensor index byte range is invalid.';
    }
    // Equivalent to upstream's GGML_PAD bit mask for the power-of-two alignments
    // accepted above, but stays in bigint so it cannot silently lose precision.
    const tensorDataOffset = alignUp(BigInt(tensorInfoEnd), alignment);
    if (tensorDataOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
        return 'GGUF tensor data offset is outside the supported non-negative range.';
    }

    let actualFileSize: bigint | undefined;
    if (fileByteLength !== undefined) {
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
        // With zero tensors there is no tensor data section, so its alignment padding
        // is never written: such files legitimately end at the tensor index. Only the
        // index end (checked above) has to fit. Keep the check strict otherwise — the
        // per-tensor bounds below are computed from this offset.
        if (output.tensorInfos.length > 0 && tensorDataOffset > actualFileSize) {
            return 'GGUF tensor data offset extends past the end of the file.';
        }
    }

    let unverifiedTensorStorage = false;
    for (const tensor of output.tensorInfos) {
        if (typeof tensor.offset !== 'bigint' || tensor.offset < 0n) {
            return 'GGUF tensor offset is outside the supported non-negative range.';
        }
        if (tensor.offset % alignment !== 0n) {
            return `GGUF tensor "${truncate(tensor.name, MAX_IDENTIFIER_CHARS)}" offset is not aligned to general.alignment.`;
        }
        const absoluteOffset = tensorDataOffset + tensor.offset;
        const byteLength = tensorStorageByteLength(tensor);
        if (typeof byteLength === 'string') return byteLength;
        if (byteLength === undefined) {
            unverifiedTensorStorage = true;
            const hasElements = tensor.shape.every((dimension) => dimension > 0n);
            if (actualFileSize !== undefined
                && (absoluteOffset > actualFileSize || (hasElements && absoluteOffset === actualFileSize))) {
                return `GGUF tensor "${truncate(tensor.name, MAX_IDENTIFIER_CHARS)}" starts at or past the end of the file.`;
            }
            continue;
        }
        if (actualFileSize !== undefined) {
            if (absoluteOffset + byteLength > actualFileSize) {
                return `GGUF tensor "${truncate(tensor.name, MAX_IDENTIFIER_CHARS)}" extends past the end of the file.`;
            }
        }
    }
    return { alignment, tensorDataOffset, unverifiedTensorStorage };
}

function storage(blockElements: number, blockBytes: number): GgmlStorageLayout {
    return { blockElements: BigInt(blockElements), blockBytes: BigInt(blockBytes) };
}

function alignUp(offset: bigint, alignment: bigint): bigint {
    return offset + (alignment - offset % alignment) % alignment;
}

function tensorStorageByteLength(
    tensor: HuggingFaceGgufOutput['tensorInfos'][number]
): bigint | string | undefined {
    if (tensor.shape.some((dimension) => typeof dimension !== 'bigint' || dimension < 0n)) {
        return `GGUF tensor "${truncate(tensor.name, MAX_IDENTIFIER_CHARS)}" has an invalid shape.`;
    }

    const dtype = Number(tensor.dtype) as GGMLQuantizationType;
    const storageLayout = GGML_STORAGE_LAYOUTS[dtype];
    if (!storageLayout) return undefined;

    const rowElements = tensor.shape[0] ?? 1n;
    if (rowElements !== 0n && rowElements % storageLayout.blockElements !== 0n) {
        return `GGUF tensor "${truncate(tensor.name, MAX_IDENTIFIER_CHARS)}" shape is not divisible by its dtype block size.`;
    }
    const elements = tensor.shape.reduce((count, dimension) => count * dimension, 1n);
    if (elements === 0n) return 0n;
    return elements / storageLayout.blockElements * storageLayout.blockBytes;
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

interface CachedRangeResponse {
    body: Uint8Array;
    headers: Array<[string, string]>;
    status: number;
    statusText: string;
}

/**
 * Ceiling on replayed preflight bytes. The preflight can only walk as far as the
 * metadata parse limits allow (~25 MB worst case), so this never evicts for a file
 * we would accept; it exists so a future limit change cannot turn the cache into
 * unbounded growth. Evicting only costs a refetch — see replayCache below for why
 * we would rather not take that trade on the metadata region itself.
 */
const REPLAY_CACHE_MAX_BYTES = 48 * 1024 * 1024;

function cacheReplayedRange(cache: Map<string, CachedRangeResponse>, key: string, entry: CachedRangeResponse): void {
    cache.set(key, entry);
    let cachedBytes = 0;
    for (const value of cache.values()) cachedBytes += value.body.byteLength;
    for (const [oldestKey, oldest] of cache) {
        if (cachedBytes <= REPLAY_CACHE_MAX_BYTES) break;
        cache.delete(oldestKey);
        cachedBytes -= oldest.body.byteLength;
    }
}

/**
 * Wraps the transport expected by @huggingface/gguf. A server that ignores
 * Range must be rejected before anybody calls response.arrayBuffer(); otherwise
 * a multi-gigabyte model can be materialized just to inspect its header.
 */
function validatedRangeFetch(
    baseFetch: typeof fetch,
    signal?: AbortSignal,
    expectedFileSize?: number,
    onFileSize?: (size: number) => void,
    onInitialBytes?: (bytes: Uint8Array) => void,
    replayCache?: Map<string, CachedRangeResponse>,
    shouldCache?: () => boolean
): typeof fetch {
    let knownTotal: number | undefined;
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        throwIfAborted(signal);
        const requested = parseRequestedRange(new Headers(init?.headers).get('range'));
        if (!requested) throw new Error('GGUF remote parsing requires a bounded byte Range request.');
        const cacheKey = `${requested.start}-${requested.end}`;
        const cached = replayCache?.get(cacheKey);
        if (cached) {
            replayCache?.delete(cacheKey);
            return new Response(cached.body.slice().buffer as ArrayBuffer, {
                status: cached.status,
                statusText: cached.statusText,
                headers: cached.headers
            });
        }

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
        if (received.start === 0) onInitialBytes?.(body);
        if (replayCache && shouldCache?.()) {
            cacheReplayedRange(replayCache, cacheKey, {
                body,
                headers: [...response.headers.entries()],
                status: response.status,
                statusText: response.statusText
            });
        }
        return new Response(body.buffer as ArrayBuffer, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });
    }) as typeof fetch;
}

function parseGgufHeader(bytes: Uint8Array): GgufHeaderInfo {
    if (bytes.byteLength < 8
        || bytes[0] !== 0x47
        || bytes[1] !== 0x47
        || bytes[2] !== 0x55
        || bytes[3] !== 0x46) {
        throw new Error('Not a valid GGUF file: the source header is incomplete or invalid.');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const littleVersion = view.getUint32(4, true);
    const littleEndian = (littleVersion & 0xffff) !== 0;
    const version = view.getUint32(4, littleEndian);
    if (version !== 1 && version !== 2 && version !== 3) {
        throw new Error(`GGUF source uses unsupported version "${version}".`);
    }

    const countBytes = version === 1 ? 4 : 8;
    const requiredBytes = 8 + countBytes * 2;
    if (bytes.byteLength < requiredBytes) {
        throw new Error('Not a valid GGUF file: the source header is incomplete.');
    }
    const readCount = (offset: number): bigint => version === 1
        ? BigInt(view.getUint32(offset, littleEndian))
        : view.getBigUint64(offset, littleEndian);
    return {
        version,
        tensorCount: readCount(8),
        metadataCount: readCount(8 + countBytes),
        littleEndian
    };
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
    arrayElements: bigint;
    complexArrayElements: bigint;
    stringBytes: bigint;
}

/** Scans metadata without materializing values before the third-party parser runs. */
async function preflightGgufMetadata(fetchRange: typeof fetch, signal?: AbortSignal): Promise<void> {
    const reader = new GgufPreflightReader(fetchRange, signal);
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

    const budget: GgufMetadataBudget = { arrayElements: 0n, complexArrayElements: 0n, stringBytes: 0n };
    for (let index = 0n; index < metadataCount; index += 1n) {
        await scanGgufString(reader, version, littleEndian, budget);
        const type = await reader.readU32(littleEndian);
        await scanGgufMetadataValue(reader, type, version, littleEndian, budget, 0);
    }
}

async function scanGgufMetadataValue(
    reader: GgufPreflightReader,
    type: number,
    version: 1 | 2 | 3,
    littleEndian: boolean,
    budget: GgufMetadataBudget,
    depth: number
): Promise<void> {
    const fixedBytes: Record<number, number> = {
        [GGUFValueType.UINT8]: 1, [GGUFValueType.INT8]: 1,
        [GGUFValueType.UINT16]: 2, [GGUFValueType.INT16]: 2,
        [GGUFValueType.UINT32]: 4, [GGUFValueType.INT32]: 4,
        [GGUFValueType.FLOAT32]: 4, [GGUFValueType.BOOL]: 1,
        [GGUFValueType.UINT64]: 8, [GGUFValueType.INT64]: 8,
        [GGUFValueType.FLOAT64]: 8
    };
    const size = fixedBytes[type];
    if (size !== undefined) {
        await reader.skip(size);
        return;
    }
    if (type === GGUFValueType.STRING) {
        await scanGgufString(reader, version, littleEndian, budget);
        return;
    }
    if (type !== GGUFValueType.ARRAY || depth >= 4) {
        throw new Error(`GGUF metadata contains an unsupported type or nesting depth (${type}).`);
    }

    const subtype = await reader.readU32(littleEndian);
    const length = await reader.readCount(version, littleEndian);
    budget.arrayElements += length;
    if (budget.arrayElements > BigInt(GGUF_PARSE_ARRAY_ELEMENT_LIMIT)) {
        throw new Error(
            `GGUF metadata arrays exceed the cumulative element limit (${GGUF_PARSE_ARRAY_ELEMENT_LIMIT}).`
        );
    }
    const subtypeSize = fixedBytes[subtype];
    if (subtypeSize !== undefined) {
        await reader.skip(Number(length) * subtypeSize);
        return;
    }
    if (subtype !== GGUFValueType.STRING && subtype !== GGUFValueType.ARRAY) {
        throw new Error(`GGUF metadata array uses an unsupported element type (${subtype}).`);
    }
    budget.complexArrayElements += length;
    if (budget.complexArrayElements > BigInt(GGUF_PARSE_COMPLEX_ARRAY_LIMIT)) {
        throw new Error(
            `GGUF string or nested arrays exceed the complex element limit (${GGUF_PARSE_COMPLEX_ARRAY_LIMIT}).`
        );
    }
    for (let index = 0n; index < length; index += 1n) {
        await scanGgufMetadataValue(reader, subtype, version, littleEndian, budget, depth + 1);
    }
}

async function scanGgufString(
    reader: GgufPreflightReader,
    version: 1 | 2 | 3,
    littleEndian: boolean,
    budget: GgufMetadataBudget
): Promise<void> {
    const length = await reader.readCount(version, littleEndian);
    budget.stringBytes += length;
    if (budget.stringBytes > BigInt(GGUF_PARSE_STRING_BYTE_LIMIT)) {
        throw new Error(
            `GGUF metadata strings exceed the cumulative byte limit (${GGUF_PARSE_STRING_BYTE_LIMIT}).`
        );
    }
    await reader.skip(Number(length));
}

class GgufPreflightReader {
    private position = 0;
    private chunkStart = -1;
    private chunk = new Uint8Array();
    /**
     * Must equal @huggingface/gguf's HTTP_CHUNK_SIZE (`2 * 10 ** 6`), and the chunk
     * starts below must stay chunk-aligned the same way upstream's RangeView is
     * (`[this.chunk * HTTP_CHUNK_SIZE, (this.chunk + 1) * HTTP_CHUNK_SIZE - 1]`).
     * Otherwise every replayCache key misses and the preflight stops binding the
     * bytes the parser actually reads. Verified against 0.4.6; recheck on upgrade.
     * The "parses a remote GGUF through validated partial-content responses" test
     * asserts a single fetch, which is what fails if these drift apart.
     */
    private static readonly CHUNK_BYTES = 2_000_000;

    constructor(private readonly fetchRange: typeof fetch, private readonly signal?: AbortSignal) {}

    async read(length: number): Promise<Uint8Array> {
        const result = new Uint8Array(length);
        let written = 0;
        while (written < length) {
            await this.ensureChunk();
            const offset = this.position - this.chunkStart;
            const take = Math.min(length - written, this.chunk.byteLength - offset);
            if (take <= 0) throw new Error('GGUF metadata extends past the end of the file.');
            result.set(this.chunk.subarray(offset, offset + take), written);
            this.position += take;
            written += take;
        }
        return result;
    }

    async skip(length: number): Promise<void> {
        if (!Number.isSafeInteger(length) || length < 0) throw new Error('GGUF metadata length is invalid.');
        let remaining = length;
        while (remaining > 0) {
            await this.ensureChunk();
            const offset = this.position - this.chunkStart;
            const take = Math.min(remaining, this.chunk.byteLength - offset);
            if (take <= 0) throw new Error('GGUF metadata extends past the end of the file.');
            this.position += take;
            remaining -= take;
        }
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

    private async ensureChunk(): Promise<void> {
        if (this.position >= this.chunkStart && this.position < this.chunkStart + this.chunk.byteLength) return;
        throwIfAborted(this.signal);
        const start = Math.floor(this.position / GgufPreflightReader.CHUNK_BYTES) * GgufPreflightReader.CHUNK_BYTES;
        const end = start + GgufPreflightReader.CHUNK_BYTES - 1;
        const response = await this.fetchRange('https://omni-viewer.invalid/gguf-preflight', {
            headers: { Range: `bytes=${start}-${end}` },
            ...(this.signal ? { signal: this.signal } : {})
        });
        if (response.status !== 206) throw new Error('GGUF metadata extends past the end of the file.');
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
