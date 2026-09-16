/**
 * Dependency-free reader for PyTorch `.pt2` packages (`torch.export.save`).
 *
 * A `.pt2` is a ZIP written by `PyTorchFileWriter`: every member sits under a
 * top-level folder named after the file, members are stored (never deflated),
 * and tensor payloads are padded to a 64-byte alignment through the local
 * header's extra field. The layout this reader understands:
 *
 *   <stem>/archive_format                          "pt2"
 *   <stem>/archive_version                         "0"
 *   <stem>/byteorder                               "little" | "big"
 *   <stem>/.data/version, .data/serialization_id   PyTorchFileWriter bookkeeping
 *   <stem>/models/<model>.json                     serialized ExportedProgram (Export IR)
 *   <stem>/data/weights/<model>_weights_config.json  fqn → PayloadMeta
 *   <stem>/data/weights/weight_<n>                 raw storage bytes (or a torch.save pickle)
 *   <stem>/data/constants/<model>_constants_config.json, tensor_<n>, custom_obj_<n>
 *   <stem>/data/sample_inputs/<model>.pt           pickled example inputs
 *   <stem>/data/aotinductor/<model>/…              AOTInductor artifacts (.so, .cpp, metadata)
 *   <stem>/extra/…                                 user files
 *
 * The graph JSON follows `torch/_export/serde/schema.py` (schema 8.x): unions
 * are one-key objects (`{"as_tensor": {"name": …}}`), enums are their integer
 * values (older writers used the member names — both are accepted), and
 * symbolic shapes carry a sympy `srepr` that is pretty-printed here.
 *
 * Weight payloads are never read beyond the leading values decoded for a
 * preview, so a multi-gigabyte package costs nothing beyond its JSON. The
 * pre-PT2 `torch.export.save` layout (`serialized_exported_program.json` next
 * to `serialized_state_dict.pt`) is read on a best-effort basis: the graph is
 * complete, but its weights are torch.save pickles and are listed from the
 * signature only. An AOTInductor-only package (no Export IR at all) opens as
 * an archive listing with its compile metadata.
 */

export interface Pt2SummaryItem { labelKey: string; value: string | number }
export interface Pt2Entry { label: string; value: string }
export interface Pt2Warning { key: string; args?: Record<string, string | number> }

export type Pt2ValueKind = 'tensor' | 'sym_int' | 'sym_bool' | 'sym_float' | 'custom_obj';

/** One named value of a graph: a tensor, a symbolic scalar, or a script object. */
export interface Pt2Value {
    name: string;
    kind: Pt2ValueKind;
    /** Short dtype (`f32`, `bf16`, `i64`); empty for non-tensors. */
    dtype: string;
    /** Dimensions, symbolic ones as pretty-printed expressions (`s0`, `2*s0`). */
    shape: string[];
    strides: string[];
    storageOffset: string;
    device: string;
    layout: string;
    requiresGrad: boolean;
    /** Element count when every dimension is concrete. */
    elementCount: number | null;
    /** Symbolic expression (with its hint) for sym values; class FQN for script objects. */
    detail: string;
}

export interface Pt2Argument {
    /** Schema argument name (`input`, `weight`); empty for positional HOP operands. */
    name: string;
    kind: 'positional' | 'keyword' | '';
    /** Display form of the argument. */
    text: string;
    /** Graph values the argument references. */
    refs: string[];
    /** Sub-graph carried by an `as_graph` argument (control-flow operands). */
    subgraph?: Pt2Graph;
}

export interface Pt2ModuleFrame { fqn: string; className: string }

export interface Pt2Node {
    /** Position inside its own graph. */
    index: number;
    name: string;
    /** Full target (`torch.ops.aten.linear.default`, `torch.ops.higher_order.cond`, `_operator.mul`). */
    target: string;
    /** Target without the `torch.ops.` prefix. */
    op: string;
    /** Operator namespace (`aten`, `higher_order`, `_operator`, …). */
    namespace: string;
    inputs: Pt2Argument[];
    outputs: Pt2Argument[];
    /** nn.Module frames from the outermost module down, when recorded. */
    moduleStack: Pt2ModuleFrame[];
    /** Innermost module FQN (empty for the root). */
    module: string;
    stackTrace: string;
    /** Remaining metadata (`torch_fn`, `source_fn_stack`, `custom`, …). */
    metadata: Pt2Entry[];
    subgraphs: Array<{ name: string; graph: Pt2Graph }>;
}

export interface Pt2Graph {
    inputs: Pt2Argument[];
    outputs: Pt2Argument[];
    nodes: Pt2Node[];
    values: Pt2Value[];
    isSingleTensorReturn: boolean;
}

export type Pt2InputKind = 'user_input' | 'parameter' | 'buffer' | 'tensor_constant' | 'custom_obj' | 'token' | 'constant_input';
export type Pt2OutputKind = 'user_output' | 'loss_output' | 'buffer_mutation' | 'parameter_mutation' | 'gradient_to_parameter' | 'gradient_to_user_input' | 'user_input_mutation' | 'token';

export interface Pt2InputSpec {
    kind: Pt2InputKind;
    /** Graph value (placeholder) name, or the display form of a non-tensor user input. */
    arg: string;
    /** Parameter / buffer / constant FQN, or the user-input name of a constant input. */
    target: string;
    persistent: boolean | undefined;
    /** Literal of a `constant_input`. */
    value: string;
}

export interface Pt2OutputSpec {
    kind: Pt2OutputKind;
    arg: string;
    target: string;
}

export interface Pt2Module {
    fqn: string;
    className: string;
    depth: number;
    /** Nodes whose innermost frame is this module. */
    nodeCount: number;
    /** Nodes that have this module anywhere on their stack. */
    totalNodeCount: number;
    /** True when the export preserved this module's call signature. */
    hasSignature: boolean;
    forwardArgNames: string[];
    inputs: string[];
    outputs: string[];
}

export type Pt2PayloadKind = 'parameter' | 'buffer' | 'tensor_constant' | 'custom_obj' | 'opaque_obj';
export type Pt2PayloadStatus = 'raw' | 'pickled' | 'missing' | 'truncated' | 'unlisted';

/** A parameter, buffer, or constant of one model together with where the archive keeps it. */
export interface Pt2Payload {
    /** Fully-qualified name (`fc.weight`). */
    name: string;
    kind: Pt2PayloadKind;
    /** Placeholder name in the graph (`p_fc_weight`); empty when the graph does not take it. */
    placeholder: string;
    /** Archive member holding the bytes; empty when the config lists none. */
    path: string;
    isParam: boolean;
    dtype: string;
    shape: string[];
    strides: string[];
    storageOffset: number;
    device: string;
    layout: string;
    requiresGrad: boolean;
    elementCount: number;
    /** Bytes the tensor spans inside its storage (0 when unknown). */
    bytes: number;
    /** Size of the archive member (null when absent). */
    fileSize: number | null;
    status: Pt2PayloadStatus;
    preview: string[];
}

export interface Pt2RangeConstraint { symbol: string; min: string; max: string }
export interface Pt2OperatorCount { op: string; count: number }

export interface Pt2Model {
    name: string;
    torchVersion: string;
    schemaVersion: string;
    opsets: Pt2Entry[];
    verifiers: string[];
    guards: string[];
    rangeConstraints: Pt2RangeConstraint[];
    graph: Pt2Graph;
    inputSpecs: Pt2InputSpec[];
    outputSpecs: Pt2OutputSpec[];
    modules: Pt2Module[];
    metadata: Pt2Entry[];
    /** Parameters and buffers (`data/weights/`). */
    weights: Pt2Payload[];
    /** Tensor constants and script objects (`data/constants/`). */
    constants: Pt2Payload[];
    operators: Pt2OperatorCount[];
    /** Nodes including those inside control-flow sub-graphs. */
    nodeCount: number;
    parameterCount: number;
    weightBytes: number;
    sampleInputs: Pt2ArchiveEntry | null;
}

export type Pt2EntryCategory = 'model' | 'weights' | 'constants' | 'sampleInputs' | 'aotinductor' | 'extra' | 'archive' | 'other';

export interface Pt2ArchiveEntry {
    /** Member name with the package folder stripped. */
    name: string;
    size: number;
    compressedSize: number;
    /** 'stored' or 'deflate'; other ZIP methods are reported by number. */
    method: string;
    category: Pt2EntryCategory;
}

export interface Pt2AotInductorModel {
    name: string;
    files: Pt2ArchiveEntry[];
    /** Flattened `*_metadata.json` and `weights_config.json` contents. */
    metadata: Pt2Entry[];
}

export interface Pt2ExtraFile {
    name: string;
    size: number;
    /** Decoded text for small UTF-8 members; empty otherwise. */
    text: string;
}

export type Pt2Layout = 'pt2' | 'legacy';

export interface Pt2Document {
    layout: Pt2Layout;
    fileSize: string;
    /** Folder every member sits under (`model` for `model.pt2`); empty when flat. */
    prefix: string;
    archiveFormat: string;
    archiveVersion: string;
    byteorder: string;
    serializationId: string;
    dataVersion: string;
    models: Pt2Model[];
    aotInductor: Pt2AotInductorModel[];
    extras: Pt2ExtraFile[];
    files: Pt2ArchiveEntry[];
    summary: Pt2SummaryItem[];
    warnings: Pt2Warning[];
}

export interface Pt2ParseOptions {
    signal?: AbortSignal;
    maxJsonBytes?: number;
    maxNodes?: number;
    maxValues?: number;
    maxPayloads?: number;
    /** Values decoded per tensor for the preview. */
    previewValues?: number;
}

const DEFAULT_MAX_JSON_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_NODES = 250_000;
const DEFAULT_MAX_VALUES = 500_000;
const DEFAULT_MAX_PAYLOADS = 100_000;
const DEFAULT_PREVIEW_VALUES = 8;
const MAX_ZIP_ENTRIES = 65_536;
const MAX_MODELS = 64;
const MAX_GRAPH_DEPTH = 16;
const MAX_ARGUMENTS = 512;
const MAX_LIST_ITEMS = 256;
const MAX_TEXT = 4096;
const MAX_STACK_TRACE = 16_384;
const MAX_NODE_METADATA = 32;
const MAX_MODULE_FRAMES = 64;
const MAX_DIMS = 64;
const MAX_EXTRA_TEXT = 64 * 1024;
const MAX_EXTRAS = 256;
const MAX_MODEL_METADATA = 256;
const MAX_EXPRESSION_CHARS = 2048;
const MAX_EXPRESSION_DEPTH = 32;
/** Schema major this reader was written against. */
const SUPPORTED_SCHEMA_MAJOR = 8;

const ZIP_MAGIC = [0x50, 0x4b] as const;
const ARCHIVE_FORMAT_PATH = 'archive_format';
const ARCHIVE_VERSION_PATH = 'archive_version';
const BYTEORDER_PATH = 'byteorder';
const DATA_VERSION_PATH = '.data/version';
const SERIALIZATION_ID_PATH = '.data/serialization_id';
const MODELS_DIR = 'models/';
const WEIGHTS_DIR = 'data/weights/';
const CONSTANTS_DIR = 'data/constants/';
const SAMPLE_INPUTS_DIR = 'data/sample_inputs/';
const AOTINDUCTOR_DIR = 'data/aotinductor/';
const EXTRA_DIR = 'extra/';
const LEGACY_PROGRAM = 'serialized_exported_program.json';
const LEGACY_STATE_DICT = 'serialized_state_dict.pt';
const LEGACY_CONSTANTS = 'serialized_constants.pt';
const LEGACY_EXAMPLE_INPUTS = 'serialized_example_inputs.pt';

// ── Enum tables (torch/_export/serde/schema.py) ─────────────────────────────

interface ScalarTypeInfo { short: string; torch: string; bytes: number }

const SCALAR_TYPES: Record<number, ScalarTypeInfo> = {
    0: { short: 'unknown', torch: 'torch.unknown', bytes: 0 },
    1: { short: 'u8', torch: 'torch.uint8', bytes: 1 },
    2: { short: 'i8', torch: 'torch.int8', bytes: 1 },
    3: { short: 'i16', torch: 'torch.int16', bytes: 2 },
    4: { short: 'i32', torch: 'torch.int32', bytes: 4 },
    5: { short: 'i64', torch: 'torch.int64', bytes: 8 },
    6: { short: 'f16', torch: 'torch.float16', bytes: 2 },
    7: { short: 'f32', torch: 'torch.float32', bytes: 4 },
    8: { short: 'f64', torch: 'torch.float64', bytes: 8 },
    9: { short: 'c32', torch: 'torch.complex32', bytes: 4 },
    10: { short: 'c64', torch: 'torch.complex64', bytes: 8 },
    11: { short: 'c128', torch: 'torch.complex128', bytes: 16 },
    12: { short: 'b8', torch: 'torch.bool', bytes: 1 },
    13: { short: 'bf16', torch: 'torch.bfloat16', bytes: 2 },
    28: { short: 'u16', torch: 'torch.uint16', bytes: 2 },
    29: { short: 'f8e4m3fn', torch: 'torch.float8_e4m3fn', bytes: 1 },
    30: { short: 'f8e5m2', torch: 'torch.float8_e5m2', bytes: 1 },
    31: { short: 'f8e4m3fnuz', torch: 'torch.float8_e4m3fnuz', bytes: 1 },
    32: { short: 'f8e5m2fnuz', torch: 'torch.float8_e5m2fnuz', bytes: 1 },
    33: { short: 'f8e8m0fnu', torch: 'torch.float8_e8m0fnu', bytes: 1 },
    34: { short: 'u32', torch: 'torch.uint32', bytes: 4 },
    35: { short: 'u64', torch: 'torch.uint64', bytes: 8 }
};

const SCALAR_TYPE_NAMES: Record<string, number> = {
    UNKNOWN: 0, BYTE: 1, CHAR: 2, SHORT: 3, INT: 4, LONG: 5, HALF: 6, FLOAT: 7, DOUBLE: 8,
    COMPLEXHALF: 9, COMPLEXFLOAT: 10, COMPLEXDOUBLE: 11, BOOL: 12, BFLOAT16: 13, UINT16: 28,
    FLOAT8E4M3FN: 29, FLOAT8E5M2: 30, FLOAT8E4M3FNUZ: 31, FLOAT8E5M2FNUZ: 32, FLOAT8E8M0FNU: 33,
    UINT32: 34, UINT64: 35
};

const LAYOUTS: Record<number, string> = {
    0: 'unknown', 1: 'torch.sparse_coo', 2: 'torch.sparse_csr', 3: 'torch.sparse_csc',
    4: 'torch.sparse_bsr', 5: 'torch.sparse_bsc', 6: 'torch._mkldnn', 7: 'torch.strided'
};
const LAYOUT_NAMES: Record<string, number> = {
    Unknown: 0, SparseCoo: 1, SparseCsr: 2, SparseCsc: 3, SparseBsr: 4, SparseBsc: 5, _mkldnn: 6, Strided: 7
};

const MEMORY_FORMATS: Record<number, string> = {
    0: 'unknown', 1: 'torch.contiguous_format', 2: 'torch.channels_last', 3: 'torch.channels_last_3d', 4: 'torch.preserve_format'
};
const MEMORY_FORMAT_NAMES: Record<string, number> = {
    Unknown: 0, ContiguousFormat: 1, ChannelsLast: 2, ChannelsLast3d: 3, PreserveFormat: 4
};

const ARGUMENT_KINDS: Record<number, Pt2Argument['kind']> = { 0: '', 1: 'positional', 2: 'keyword' };
const ARGUMENT_KIND_NAMES: Record<string, number> = { UNKNOWN: 0, POSITIONAL: 1, KEYWORD: 2 };

/**
 * True when the bytes are a ZIP whose members include a PT2 `archive_format`
 * marker or the legacy `serialized_exported_program.json`. Reads only the
 * central directory, so it is cheap enough for routing.
 */
export function looksLikePt2Archive(data: Uint8Array): boolean {
    if (!hasPrefix(data, ZIP_MAGIC)) return false;
    const directory = readZipDirectory(data);
    if (!directory) return false;
    return directory.entries.some(entry => isPt2Marker(entry.name));
}

function isPt2Marker(name: string): boolean {
    return name === ARCHIVE_FORMAT_PATH || name.endsWith(`/${ARCHIVE_FORMAT_PATH}`) ||
        name === LEGACY_PROGRAM || name.endsWith(`/${LEGACY_PROGRAM}`);
}

/** Reads a `.pt2` package. Never throws on bad input; aborts throw. */
export async function parsePt2(data: Uint8Array, options: Pt2ParseOptions = {}): Promise<Pt2Document> {
    throwIfAborted(options.signal);
    const warnings: Pt2Warning[] = [];
    if (!hasPrefix(data, ZIP_MAGIC)) return emptyDocument(data.byteLength, [{ key: 'pt2.warning.notZip' }]);
    const directory = readZipDirectory(data);
    if (!directory) return emptyDocument(data.byteLength, [{ key: 'pt2.warning.archiveUnreadable' }]);
    if (directory.truncated) warnings.push({ key: 'pt2.warning.entryLimit', args: { limit: MAX_ZIP_ENTRIES } });

    const prefix = findPrefix(directory.entries);
    const strip = (name: string): string => prefix && name.startsWith(`${prefix}/`) ? name.slice(prefix.length + 1) : name;
    const byName = new Map<string, ZipEntry>();
    for (const entry of directory.entries) {
        const name = strip(entry.name);
        if (!byName.has(name)) byName.set(name, entry);
    }
    const layout: Pt2Layout = byName.has(ARCHIVE_FORMAT_PATH) ? 'pt2' : 'legacy';
    if (layout === 'legacy') {
        if (byName.has(LEGACY_PROGRAM)) warnings.push({ key: 'pt2.warning.legacyLayout' });
        else warnings.push({ key: 'pt2.warning.noArchiveFormat' });
    }

    const files: Pt2ArchiveEntry[] = directory.entries.map(entry => {
        const name = strip(entry.name);
        return {
            name,
            size: entry.uncompressedSize,
            compressedSize: entry.compressedSize,
            method: entry.method === 0 ? 'stored' : entry.method === 8 ? 'deflate' : String(entry.method),
            category: categorize(name)
        };
    });

    // Model names come from models/<name>.json; each brings its own configs.
    const modelNames: string[] = [];
    for (const name of byName.keys()) {
        if (name.startsWith(MODELS_DIR) && name.endsWith('.json') && !name.slice(MODELS_DIR.length, -5).includes('/')) {
            modelNames.push(name.slice(MODELS_DIR.length, -5));
        }
    }
    modelNames.sort(compareText);
    if (layout === 'legacy' && byName.has(LEGACY_PROGRAM)) modelNames.unshift('');
    if (modelNames.length > MAX_MODELS) {
        warnings.push({ key: 'pt2.warning.modelsLimited', args: { shown: MAX_MODELS, total: modelNames.length } });
        modelNames.length = MAX_MODELS;
    }

    const maxJsonBytes = options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
    const requests: MemberRequest[] = [];
    const request = (name: string, inflateLimit: number, sliceLimit = Number.POSITIVE_INFINITY): void => {
        const entry = byName.get(name);
        if (entry) requests.push({ entry, name, inflateLimit, sliceLimit });
    };
    for (const marker of [ARCHIVE_FORMAT_PATH, ARCHIVE_VERSION_PATH, BYTEORDER_PATH, DATA_VERSION_PATH, SERIALIZATION_ID_PATH]) request(marker, MAX_TEXT, MAX_TEXT);
    for (const model of modelNames) {
        if (model === '') { request(LEGACY_PROGRAM, maxJsonBytes); continue; }
        request(`${MODELS_DIR}${model}.json`, maxJsonBytes);
        request(`${WEIGHTS_DIR}${model}_weights_config.json`, maxJsonBytes);
        request(`${CONSTANTS_DIR}${model}_constants_config.json`, maxJsonBytes);
    }
    const extraNames: string[] = [];
    const aotiMetadata: string[] = [];
    for (const name of byName.keys()) {
        if (name.startsWith(EXTRA_DIR) && name.length > EXTRA_DIR.length) {
            if (extraNames.length < MAX_EXTRAS) { extraNames.push(name); request(name, MAX_EXTRA_TEXT, MAX_EXTRA_TEXT); }
        } else if (name.startsWith(AOTINDUCTOR_DIR) && name.endsWith('.json')) {
            aotiMetadata.push(name);
            request(name, MAX_EXTRA_TEXT, MAX_EXTRA_TEXT);
        }
    }
    const members = await readMembers(data, requests, warnings, options);
    throwIfAborted(options.signal);

    const marker = (name: string): string => truncate(decodeText(members.get(name)).trim(), MAX_TEXT);
    const archiveFormat = marker(ARCHIVE_FORMAT_PATH);
    if (layout === 'pt2' && archiveFormat !== 'pt2') warnings.push({ key: 'pt2.warning.unknownArchiveFormat', args: { value: archiveFormat || '—' } });
    const byteorder = marker(BYTEORDER_PATH);
    const littleEndian = byteorder !== 'big';

    const models: Pt2Model[] = [];
    const budget: Budget = {
        nodes: options.maxNodes ?? DEFAULT_MAX_NODES,
        values: options.maxValues ?? DEFAULT_MAX_VALUES,
        payloads: options.maxPayloads ?? DEFAULT_MAX_PAYLOADS,
        nodesDropped: 0,
        valuesDropped: 0,
        payloadsDropped: 0,
        danglingRefs: 0,
        depthExceeded: 0
    };
    for (const modelName of modelNames) {
        throwIfAborted(options.signal);
        const legacy = modelName === '';
        const programName = legacy ? LEGACY_PROGRAM : `${MODELS_DIR}${modelName}.json`;
        const displayName = legacy ? 'model' : modelName;
        const program = decodeJson(members.get(programName), programName, warnings);
        if (!isRecord(program)) {
            if (members.has(programName)) warnings.push({ key: 'pt2.warning.modelUnreadable', args: { name: displayName } });
            continue;
        }
        const weightsConfig = legacy ? undefined : decodeJson(members.get(`${WEIGHTS_DIR}${modelName}_weights_config.json`), `${modelName}_weights_config.json`, warnings);
        const constantsConfig = legacy ? undefined : decodeJson(members.get(`${CONSTANTS_DIR}${modelName}_constants_config.json`), `${modelName}_constants_config.json`, warnings);
        const sampleInputs = files.find(file => file.name === (legacy ? LEGACY_EXAMPLE_INPUTS : `${SAMPLE_INPUTS_DIR}${modelName}.pt`)) ?? null;
        models.push(buildModel({
            name: displayName,
            program,
            weightsConfig: isRecord(weightsConfig) ? weightsConfig : undefined,
            constantsConfig: isRecord(constantsConfig) ? constantsConfig : undefined,
            legacy,
            data,
            byName,
            littleEndian,
            sampleInputs,
            previewValues: options.previewValues ?? DEFAULT_PREVIEW_VALUES,
            budget,
            warnings
        }));
    }
    if (budget.nodesDropped) warnings.push({ key: 'pt2.warning.nodesLimited', args: { count: budget.nodesDropped } });
    if (budget.valuesDropped) warnings.push({ key: 'pt2.warning.valuesLimited', args: { count: budget.valuesDropped } });
    if (budget.payloadsDropped) warnings.push({ key: 'pt2.warning.payloadsLimited', args: { count: budget.payloadsDropped } });
    if (budget.danglingRefs) warnings.push({ key: 'pt2.warning.danglingRefs', args: { count: budget.danglingRefs } });
    if (budget.depthExceeded) warnings.push({ key: 'pt2.warning.subgraphDepth', args: { count: budget.depthExceeded, limit: MAX_GRAPH_DEPTH } });

    const aotInductor = collectAotInductor(files, aotiMetadata, members, warnings);
    const extras: Pt2ExtraFile[] = extraNames.sort(compareText).map(name => {
        const bytes = members.get(name);
        return { name: name.slice(EXTRA_DIR.length), size: byName.get(name)?.uncompressedSize ?? 0, text: bytes ? decodeText(bytes, true) : '' };
    });
    if (models.length === 0) warnings.push({ key: aotInductor.length ? 'pt2.warning.aotiOnly' : 'pt2.warning.noModels' });

    const document: Pt2Document = {
        layout,
        fileSize: formatFileSize(data.byteLength),
        prefix,
        archiveFormat,
        archiveVersion: marker(ARCHIVE_VERSION_PATH),
        byteorder,
        serializationId: marker(SERIALIZATION_ID_PATH),
        dataVersion: marker(DATA_VERSION_PATH),
        models,
        aotInductor,
        extras,
        files,
        summary: [],
        warnings
    };
    document.summary = buildSummary(document);
    return document;
}

function emptyDocument(bytes: number, warnings: Pt2Warning[]): Pt2Document {
    return {
        layout: 'pt2', fileSize: formatFileSize(bytes), prefix: '', archiveFormat: '', archiveVersion: '', byteorder: '',
        serializationId: '', dataVersion: '', models: [], aotInductor: [], extras: [], files: [], summary: [], warnings
    };
}

/**
 * PyTorchFileWriter prefixes every member with the archive name. The prefix
 * is the folder the `archive_format` marker (or the legacy program) sits in;
 * a flat archive has none.
 */
function findPrefix(entries: ZipEntry[]): string {
    for (const entry of entries) {
        if (!isPt2Marker(entry.name)) continue;
        const slash = entry.name.lastIndexOf('/');
        const marker = entry.name.slice(slash + 1);
        const folder = slash < 0 ? '' : entry.name.slice(0, slash);
        // `.data/version` also ends in a known name; only the two markers count.
        if (marker === ARCHIVE_FORMAT_PATH || marker === LEGACY_PROGRAM) return folder;
    }
    return '';
}

function categorize(name: string): Pt2EntryCategory {
    if (name.startsWith(MODELS_DIR) || name === LEGACY_PROGRAM) return 'model';
    if (name.startsWith(WEIGHTS_DIR) || name === LEGACY_STATE_DICT) return 'weights';
    if (name.startsWith(CONSTANTS_DIR) || name === LEGACY_CONSTANTS) return 'constants';
    if (name.startsWith(SAMPLE_INPUTS_DIR) || name === LEGACY_EXAMPLE_INPUTS) return 'sampleInputs';
    if (name.startsWith(AOTINDUCTOR_DIR)) return 'aotinductor';
    if (name.startsWith(EXTRA_DIR)) return 'extra';
    if ([ARCHIVE_FORMAT_PATH, ARCHIVE_VERSION_PATH, BYTEORDER_PATH, DATA_VERSION_PATH, SERIALIZATION_ID_PATH, 'version'].includes(name)) return 'archive';
    return 'other';
}

function buildSummary(document: Pt2Document): Pt2SummaryItem[] {
    const models = document.models;
    const sum = (pick: (model: Pt2Model) => number): number => models.reduce((total, model) => total + pick(model), 0);
    const summary: Pt2SummaryItem[] = [];
    if (models.length !== 1) summary.push({ labelKey: 'pt2.summary.models', value: models.length });
    if (models.length === 0) {
        // Nothing graph-shaped to count: describe the archive instead.
        if (document.aotInductor.length) summary.push({ labelKey: 'pt2.summary.aotInductor', value: document.aotInductor.length });
        summary.push({ labelKey: 'pt2.summary.files', value: document.files.length }, { labelKey: 'pt2.summary.fileSize', value: document.fileSize });
        return summary;
    }
    summary.push(
        { labelKey: 'pt2.summary.nodes', value: sum(model => model.nodeCount) },
        { labelKey: 'pt2.summary.operators', value: new Set(models.flatMap(model => model.operators.map(item => item.op))).size },
        { labelKey: 'pt2.summary.parameters', value: sum(model => model.parameterCount) },
        { labelKey: 'pt2.summary.weights', value: formatFileSize(sum(model => model.weightBytes)) },
        { labelKey: 'pt2.summary.constants', value: sum(model => model.constants.length) },
        { labelKey: 'pt2.summary.io', value: `${sum(model => model.inputSpecs.filter(spec => spec.kind === 'user_input' || spec.kind === 'constant_input').length)} / ${sum(model => model.outputSpecs.filter(spec => spec.kind === 'user_output').length)}` }
    );
    if (document.aotInductor.length) summary.push({ labelKey: 'pt2.summary.aotInductor', value: document.aotInductor.length });
    return summary;
}

// ── ExportedProgram ─────────────────────────────────────────────────────────

interface Budget {
    nodes: number;
    values: number;
    payloads: number;
    nodesDropped: number;
    valuesDropped: number;
    payloadsDropped: number;
    danglingRefs: number;
    depthExceeded: number;
}

interface ModelSource {
    name: string;
    program: Record<string, unknown>;
    weightsConfig: Record<string, unknown> | undefined;
    constantsConfig: Record<string, unknown> | undefined;
    legacy: boolean;
    data: Uint8Array;
    byName: Map<string, ZipEntry>;
    littleEndian: boolean;
    sampleInputs: Pt2ArchiveEntry | null;
    previewValues: number;
    budget: Budget;
    warnings: Pt2Warning[];
}

function buildModel(source: ModelSource): Pt2Model {
    const { program, budget, warnings } = source;
    const graphModule = isRecord(program['graph_module']) ? program['graph_module'] : {};
    const schema = isRecord(program['schema_version']) ? program['schema_version'] : {};
    const schemaMajor = asNumber(schema['major']);
    const schemaVersion = schemaMajor === null ? '' : `${schemaMajor}.${asNumber(schema['minor']) ?? 0}`;
    if (schemaMajor !== null && schemaMajor > SUPPORTED_SCHEMA_MAJOR) {
        warnings.push({ key: 'pt2.warning.schemaVersion', args: { name: source.name, version: schemaVersion, supported: SUPPORTED_SCHEMA_MAJOR } });
    }

    const graph = readGraph(graphModule['graph'], 0, budget);
    const { inputSpecs, outputSpecs } = readSignature(graphModule['signature']);
    const modules = readModules(graphModule['module_call_graph'], graph);

    const operatorCounts = new Map<string, number>();
    let nodeCount = 0;
    walkNodes(graph, node => {
        nodeCount++;
        operatorCounts.set(node.op, (operatorCounts.get(node.op) ?? 0) + 1);
    });
    const operators = [...operatorCounts.entries()]
        .map(([op, count]) => ({ op, count }))
        .sort((a, b) => b.count - a.count || compareText(a.op, b.op));

    const valuesByName = new Map(graph.values.map(value => [value.name, value]));
    const placeholderByTarget = new Map<string, Pt2InputSpec>();
    for (const spec of inputSpecs) if (spec.target) placeholderByTarget.set(`${payloadKindOf(spec.kind)} ${spec.target}`, spec);

    const weights = readPayloads(source, source.weightsConfig, 'weights', inputSpecs, valuesByName);
    const constants = readPayloads(source, source.constantsConfig, 'constants', inputSpecs, valuesByName);
    const pickled = [...weights, ...constants].filter(item => item.status === 'pickled').length;
    const missing = [...weights, ...constants].filter(item => item.status === 'missing').length;
    const truncated = [...weights, ...constants].filter(item => item.status === 'truncated').length;
    if (pickled) warnings.push({ key: 'pt2.warning.pickledPayloads', args: { name: source.name, count: pickled } });
    if (missing) warnings.push({ key: 'pt2.warning.payloadMissing', args: { name: source.name, count: missing } });
    if (truncated) warnings.push({ key: 'pt2.warning.payloadTruncated', args: { name: source.name, count: truncated } });

    const opsets: Pt2Entry[] = [];
    if (isRecord(program['opset_version'])) {
        for (const [key, value] of Object.entries(program['opset_version']).slice(0, MAX_MODEL_METADATA)) opsets.push({ label: key, value: scalarText(value) });
    }
    const rangeConstraints: Pt2RangeConstraint[] = [];
    if (isRecord(program['range_constraints'])) {
        for (const [symbol, range] of Object.entries(program['range_constraints']).slice(0, MAX_MODEL_METADATA)) {
            rangeConstraints.push({
                symbol,
                min: isRecord(range) ? scalarText(range['min_val'], '-∞') : '?',
                max: isRecord(range) ? scalarText(range['max_val'], '∞') : '?'
            });
        }
    }
    const metadata: Pt2Entry[] = [];
    if (isRecord(graphModule['metadata'])) {
        for (const [key, value] of Object.entries(graphModule['metadata']).slice(0, MAX_MODEL_METADATA)) metadata.push({ label: key, value: truncate(scalarText(value), MAX_TEXT) });
    }
    if (isRecord(graphModule['treespec_namedtuple_fields'])) {
        for (const [key, value] of Object.entries(graphModule['treespec_namedtuple_fields']).slice(0, MAX_MODEL_METADATA)) {
            const fields = isRecord(value) ? asStringList(value['field_names']) : [];
            metadata.push({ label: `namedtuple ${key}`, value: fields.join(', ') });
        }
    }

    return {
        name: source.name,
        torchVersion: truncate(asText(program['torch_version']), MAX_TEXT),
        schemaVersion,
        opsets,
        verifiers: asStringList(program['verifiers']),
        guards: asStringList(program['guards_code']).map(guard => truncate(guard, MAX_TEXT)),
        rangeConstraints,
        graph,
        inputSpecs,
        outputSpecs,
        modules,
        metadata,
        weights,
        constants,
        operators,
        nodeCount,
        parameterCount: weights.filter(item => item.kind === 'parameter').reduce((total, item) => total + item.elementCount, 0),
        weightBytes: [...weights, ...constants].reduce((total, item) => total + item.bytes, 0),
        sampleInputs: source.sampleInputs
    };
}

function walkNodes(graph: Pt2Graph, visit: (node: Pt2Node) => void, depth = 0): void {
    if (depth > MAX_GRAPH_DEPTH) return;
    for (const node of graph.nodes) {
        visit(node);
        for (const subgraph of node.subgraphs) walkNodes(subgraph.graph, visit, depth + 1);
    }
}

function readGraph(raw: unknown, depth: number, budget: Budget): Pt2Graph {
    const graph: Pt2Graph = { inputs: [], outputs: [], nodes: [], values: [], isSingleTensorReturn: false };
    if (!isRecord(raw)) return graph;
    if (depth > MAX_GRAPH_DEPTH) { budget.depthExceeded++; return graph; }
    graph.isSingleTensorReturn = raw['is_single_tensor_return'] === true;

    const addValues = (table: unknown, kind: Pt2ValueKind): void => {
        if (!isRecord(table)) return;
        for (const [name, meta] of Object.entries(table)) {
            if (budget.values <= 0) { budget.valuesDropped++; continue; }
            budget.values--;
            graph.values.push(readValue(name, kind, meta));
        }
    };
    addValues(raw['tensor_values'], 'tensor');
    addValues(raw['sym_int_values'], 'sym_int');
    addValues(raw['sym_bool_values'], 'sym_bool');
    addValues(raw['sym_float_values'], 'sym_float');
    addValues(raw['custom_obj_values'], 'custom_obj');

    const known = new Set(graph.values.map(value => value.name));
    const noteRefs = (argument: Pt2Argument): void => {
        for (const ref of argument.refs) if (!known.has(ref)) budget.danglingRefs++;
    };
    graph.inputs = asList(raw['inputs']).slice(0, MAX_ARGUMENTS).map(item => formatArgument(item, depth, budget));
    // Graph inputs are placeholders: they define values rather than use them.
    for (const input of graph.inputs) for (const ref of input.refs) known.add(ref);

    const nodes = asList(raw['nodes']);
    for (let index = 0; index < nodes.length; index++) {
        if (budget.nodes <= 0) { budget.nodesDropped += nodes.length - index; break; }
        budget.nodes--;
        const node = readNode(nodes[index], index, depth, budget);
        for (const input of node.inputs) noteRefs(input);
        for (const output of node.outputs) for (const ref of output.refs) known.add(ref);
        graph.nodes.push(node);
    }
    graph.outputs = asList(raw['outputs']).slice(0, MAX_ARGUMENTS).map(item => formatArgument(item, depth, budget));
    for (const output of graph.outputs) noteRefs(output);
    return graph;
}

function readValue(name: string, kind: Pt2ValueKind, meta: unknown): Pt2Value {
    const value: Pt2Value = {
        name, kind, dtype: '', shape: [], strides: [], storageOffset: '', device: '', layout: '',
        requiresGrad: false, elementCount: null, detail: ''
    };
    if (!isRecord(meta)) return value;
    if (kind === 'tensor') {
        const tensor = readTensorMeta(meta);
        value.dtype = tensor.dtype;
        value.shape = tensor.shape;
        value.strides = tensor.strides;
        value.storageOffset = tensor.storageOffset;
        value.device = tensor.device;
        value.layout = tensor.layout;
        value.requiresGrad = tensor.requiresGrad;
        value.elementCount = tensor.elementCount;
    } else if (kind === 'custom_obj') {
        value.detail = truncate(asText(meta['class_fqn']), MAX_TEXT);
    } else {
        value.detail = formatSym(meta);
    }
    return value;
}

interface TensorMeta {
    dtype: string;
    dtypeCode: number;
    shape: string[];
    sizes: number[] | null;
    strides: string[];
    strideValues: number[] | null;
    storageOffset: string;
    storageOffsetValue: number;
    device: string;
    layout: string;
    requiresGrad: boolean;
    elementCount: number | null;
}

function readTensorMeta(meta: Record<string, unknown>): TensorMeta {
    const dtypeCode = enumCode(meta['dtype'], SCALAR_TYPE_NAMES);
    const sizes = asList(meta['sizes']).slice(0, MAX_DIMS);
    const strides = asList(meta['strides']).slice(0, MAX_DIMS);
    const sizeValues = sizes.map(symIntValue);
    const strideValues = strides.map(symIntValue);
    const storageOffset = symIntValue(meta['storage_offset']) ?? 0;
    const concrete = sizeValues.every((size): size is number => size !== null);
    return {
        dtype: dtypeCode === null ? asText(meta['dtype']) : SCALAR_TYPES[dtypeCode]?.short ?? `dtype${dtypeCode}`,
        dtypeCode: dtypeCode ?? -1,
        shape: sizes.map(formatSym),
        sizes: concrete ? sizeValues : null,
        strides: strides.map(formatSym),
        strideValues: strideValues.every((stride): stride is number => stride !== null) ? strideValues : null,
        storageOffset: formatSym(meta['storage_offset']),
        storageOffsetValue: storageOffset,
        device: formatDevice(meta['device']),
        layout: enumLabel(meta['layout'], LAYOUTS, LAYOUT_NAMES),
        requiresGrad: meta['requires_grad'] === true,
        elementCount: concrete ? sizeValues.reduce((total, size) => total * size, 1) : null
    };
}

function readNode(raw: unknown, index: number, depth: number, budget: Budget): Pt2Node {
    const node: Pt2Node = {
        index, name: '', target: '', op: '', namespace: '', inputs: [], outputs: [],
        moduleStack: [], module: '', stackTrace: '', metadata: [], subgraphs: []
    };
    if (!isRecord(raw)) return node;
    node.target = truncate(asText(raw['target']), MAX_TEXT);
    node.op = node.target.startsWith('torch.ops.') ? node.target.slice('torch.ops.'.length) : node.target;
    node.namespace = node.op.includes('.') ? node.op.slice(0, node.op.indexOf('.')) : '';

    for (const item of asList(raw['inputs']).slice(0, MAX_ARGUMENTS)) {
        const named = isRecord(item) ? item : {};
        const argument = formatArgument(named['arg'], depth, budget);
        argument.name = truncate(asText(named['name']), MAX_TEXT);
        const kindCode = enumCode(named['kind'], ARGUMENT_KIND_NAMES);
        argument.kind = kindCode === null ? '' : ARGUMENT_KINDS[kindCode] ?? '';
        if (argument.subgraph) node.subgraphs.push({ name: argument.text, graph: argument.subgraph });
        node.inputs.push(argument);
    }
    node.outputs = asList(raw['outputs']).slice(0, MAX_ARGUMENTS).map(item => formatArgument(item, depth, budget));
    const declaredName = asText(raw['name']);
    node.name = truncate(declaredName || node.outputs.find(output => output.refs.length)?.refs[0] || `${node.op || 'node'}#${index}`, MAX_TEXT);

    if (isRecord(raw['metadata'])) {
        for (const [key, value] of Object.entries(raw['metadata']).slice(0, MAX_NODE_METADATA)) {
            const text = scalarText(value);
            if (key === 'stack_trace') node.stackTrace = truncate(text, MAX_STACK_TRACE);
            else if (key === 'nn_module_stack') node.moduleStack = parseModuleStack(text);
            else node.metadata.push({ label: key, value: truncate(text, MAX_TEXT) });
        }
    }
    node.module = node.moduleStack.length ? node.moduleStack[node.moduleStack.length - 1]!.fqn : '';
    return node;
}

/** Frame torch inserts for nodes that carry no module stack at all. */
const EMPTY_STACK_HOOK = '_empty_nn_module_stack_from_metadata_hook';

/**
 * `nn_module_stack` is serialized as `key,fqn,class;key,fqn,class` from the
 * outermost module down. Class paths carry no commas, so a plain split is
 * exact; the root frame has an empty FQN.
 */
function parseModuleStack(text: string): Pt2ModuleFrame[] {
    const frames: Pt2ModuleFrame[] = [];
    for (const frame of text.split(';')) {
        if (!frame || frame.startsWith(EMPTY_STACK_HOOK)) continue;
        if (frames.length >= MAX_MODULE_FRAMES) break;
        const parts = frame.split(',');
        if (parts.length >= 3) frames.push({ fqn: truncate(parts[1]!, MAX_TEXT), className: truncate(parts.slice(2).join(','), MAX_TEXT) });
        else frames.push({ fqn: truncate(parts[parts.length - 1]!, MAX_TEXT), className: '' });
    }
    return frames;
}

function readSignature(raw: unknown): { inputSpecs: Pt2InputSpec[]; outputSpecs: Pt2OutputSpec[] } {
    const inputSpecs: Pt2InputSpec[] = [];
    const outputSpecs: Pt2OutputSpec[] = [];
    if (!isRecord(raw)) return { inputSpecs, outputSpecs };
    const inputKinds: Pt2InputKind[] = ['user_input', 'parameter', 'buffer', 'tensor_constant', 'custom_obj', 'token', 'constant_input'];
    const outputKinds: Pt2OutputKind[] = ['user_output', 'loss_output', 'buffer_mutation', 'parameter_mutation', 'gradient_to_parameter', 'gradient_to_user_input', 'user_input_mutation', 'token'];
    for (const item of asList(raw['input_specs']).slice(0, MAX_ARGUMENTS * 8)) {
        const union = unionOf(item);
        if (!union || !inputKinds.includes(union.tag as Pt2InputKind)) continue;
        const kind = union.tag as Pt2InputKind;
        const body = isRecord(union.value) ? union.value : {};
        const spec: Pt2InputSpec = { kind, arg: '', target: '', persistent: undefined, value: '' };
        if (kind === 'constant_input') {
            spec.target = truncate(asText(body['name']), MAX_TEXT);
            spec.value = formatConstantValue(body['value']);
            spec.arg = spec.target;
        } else {
            spec.arg = argumentName(body['arg']);
            spec.target = truncate(asText(body['parameter_name'] ?? body['buffer_name'] ?? body['tensor_constant_name'] ?? body['custom_obj_name']), MAX_TEXT);
            if (kind === 'buffer') spec.persistent = body['persistent'] !== false;
        }
        inputSpecs.push(spec);
    }
    for (const item of asList(raw['output_specs']).slice(0, MAX_ARGUMENTS * 8)) {
        const union = unionOf(item);
        if (!union || !outputKinds.includes(union.tag as Pt2OutputKind)) continue;
        const body = isRecord(union.value) ? union.value : {};
        outputSpecs.push({
            kind: union.tag as Pt2OutputKind,
            arg: argumentName(body['arg']),
            target: truncate(asText(body['buffer_name'] ?? body['parameter_name'] ?? body['user_input_name']), MAX_TEXT)
        });
    }
    return { inputSpecs, outputSpecs };
}

/** Name of a TensorArgument / TokenArgument / CustomObjArgument, or the display form of a general Argument. */
function argumentName(raw: unknown): string {
    if (isRecord(raw) && typeof raw['name'] === 'string') return truncate(raw['name'], MAX_TEXT);
    const noBudget: Budget = { nodes: 0, values: 0, payloads: 0, nodesDropped: 0, valuesDropped: 0, payloadsDropped: 0, danglingRefs: 0, depthExceeded: 0 };
    return formatArgument(raw, MAX_GRAPH_DEPTH, noBudget).text;
}

function formatConstantValue(raw: unknown): string {
    const union = unionOf(raw);
    if (!union) return scalarText(raw);
    if (union.tag === 'as_none') return 'None';
    if (union.tag === 'as_string') return quote(asText(union.value));
    if (union.tag === 'as_bool') return union.value ? 'True' : 'False';
    return scalarText(union.value);
}

function readModules(raw: unknown, graph: Pt2Graph): Pt2Module[] {
    const byFqn = new Map<string, Pt2Module>();
    const ensure = (fqn: string): Pt2Module => {
        let module = byFqn.get(fqn);
        if (!module) {
            module = { fqn, className: '', depth: fqn ? fqn.split('.').length : 0, nodeCount: 0, totalNodeCount: 0, hasSignature: false, forwardArgNames: [], inputs: [], outputs: [] };
            byFqn.set(fqn, module);
        }
        return module;
    };
    for (const item of asList(raw).slice(0, MAX_ARGUMENTS * 8)) {
        if (!isRecord(item)) continue;
        const module = ensure(truncate(asText(item['fqn']), MAX_TEXT));
        const signature = item['signature'];
        if (isRecord(signature)) {
            module.hasSignature = true;
            module.forwardArgNames = asStringList(signature['forward_arg_names']);
            module.inputs = asList(signature['inputs']).slice(0, MAX_ARGUMENTS).map(argumentName);
            module.outputs = asList(signature['outputs']).slice(0, MAX_ARGUMENTS).map(argumentName);
        }
    }
    walkNodes(graph, node => {
        const seen = new Set<string>();
        for (const frame of node.moduleStack) {
            const module = ensure(frame.fqn);
            if (!module.className && frame.className) module.className = frame.className;
            if (!seen.has(frame.fqn)) { module.totalNodeCount++; seen.add(frame.fqn); }
        }
        if (node.moduleStack.length) ensure(node.module).nodeCount++;
    });
    return [...byFqn.values()].sort((a, b) => compareText(a.fqn, b.fqn));
}

// ── Arguments ───────────────────────────────────────────────────────────────

function formatArgument(raw: unknown, depth: number, budget: Budget): Pt2Argument {
    const argument: Pt2Argument = { name: '', kind: '', text: '', refs: [] };
    const union = unionOf(raw);
    if (!union) { argument.text = truncate(scalarText(raw), MAX_TEXT); return argument; }
    const { tag, value } = union;
    const ref = (name: string): string => { argument.refs.push(name); return name; };
    const tensorName = (item: unknown): string => isRecord(item) && typeof item['name'] === 'string' ? ref(truncate(item['name'], MAX_TEXT)) : '?';
    const optionalTensor = (item: unknown): string => {
        const inner = unionOf(item);
        return inner?.tag === 'as_tensor' ? tensorName(inner.value) : 'None';
    };
    const symName = (item: unknown, fallback: (value: unknown) => string): string => {
        const inner = unionOf(item);
        if (!inner) return scalarText(item);
        return inner.tag === 'as_name' ? ref(truncate(asText(inner.value), MAX_TEXT)) : fallback(inner.value);
    };
    const list = (items: unknown, format: (item: unknown) => string): string => {
        const values = asList(items);
        const shown = values.slice(0, MAX_LIST_ITEMS).map(format);
        return `[${shown.join(', ')}${values.length > MAX_LIST_ITEMS ? `, …+${values.length - MAX_LIST_ITEMS}` : ''}]`;
    };
    switch (tag) {
        case 'as_none': argument.text = 'None'; break;
        case 'as_tensor': argument.text = tensorName(value); break;
        case 'as_tensors': argument.text = list(value, tensorName); break;
        case 'as_optional_tensor': argument.text = optionalTensor(value); break;
        case 'as_optional_tensors': argument.text = list(value, optionalTensor); break;
        case 'as_nested_tensors': argument.text = list(value, inner => list(inner, tensorName)); break;
        case 'as_int': case 'as_float': argument.text = numberText(value); break;
        case 'as_ints': case 'as_floats': argument.text = list(value, numberText); break;
        case 'as_int_lists': case 'as_float_lists': argument.text = list(value, inner => list(inner, numberText)); break;
        case 'as_bool': argument.text = value ? 'True' : 'False'; break;
        case 'as_bools': argument.text = list(value, item => item ? 'True' : 'False'); break;
        case 'as_string': case 'as_operator': argument.text = quote(asText(value)); break;
        case 'as_strings': argument.text = list(value, item => quote(asText(item))); break;
        case 'as_sym_int': argument.text = symName(value, numberText); break;
        case 'as_sym_ints': argument.text = list(value, item => symName(item, numberText)); break;
        case 'as_sym_float': argument.text = symName(value, numberText); break;
        case 'as_sym_floats': argument.text = list(value, item => symName(item, numberText)); break;
        case 'as_sym_bool': argument.text = symName(value, item => item ? 'True' : 'False'); break;
        case 'as_sym_bools': argument.text = list(value, item => symName(item, inner => inner ? 'True' : 'False')); break;
        case 'as_scalar_type': {
            const code = enumCode(value, SCALAR_TYPE_NAMES);
            argument.text = code === null ? asText(value) : SCALAR_TYPES[code]?.torch ?? `torch.dtype(${code})`;
            break;
        }
        case 'as_memory_format': argument.text = enumLabel(value, MEMORY_FORMATS, MEMORY_FORMAT_NAMES); break;
        case 'as_layout': argument.text = enumLabel(value, LAYOUTS, LAYOUT_NAMES); break;
        case 'as_device': argument.text = formatDevice(value); break;
        case 'as_complex': {
            const complex = isRecord(value) ? value : {};
            argument.text = `${numberText(complex['real'])}+${numberText(complex['imag'])}j`;
            break;
        }
        case 'as_custom_obj': {
            const custom = isRecord(value) ? value : {};
            const name = ref(truncate(asText(custom['name']), MAX_TEXT));
            argument.text = custom['class_fqn'] ? `${name} (${truncate(asText(custom['class_fqn']), MAX_TEXT)})` : name;
            break;
        }
        case 'as_graph': {
            const graphArgument = isRecord(value) ? value : {};
            argument.text = truncate(asText(graphArgument['name']) || 'graph', MAX_TEXT);
            argument.subgraph = readGraph(graphArgument['graph'], depth + 1, budget);
            break;
        }
        case 'as_string_to_argument': {
            const entries = isRecord(value) ? Object.entries(value).slice(0, MAX_LIST_ITEMS) : [];
            argument.text = `{${entries.map(([key, item]) => {
                const inner = formatArgument(item, depth, budget);
                argument.refs.push(...inner.refs);
                return `${quote(key)}: ${inner.text}`;
            }).join(', ')}}`;
            break;
        }
        default:
            argument.text = `${tag}(${truncate(scalarText(value), 200)})`;
    }
    argument.text = truncate(argument.text, MAX_TEXT);
    return argument;
}

/** The single `{tag: value}` of a serialized `_Union`, or null for anything else. */
function unionOf(raw: unknown): { tag: string; value: unknown } | null {
    if (!isRecord(raw)) return null;
    const keys = Object.keys(raw);
    if (keys.length !== 1) return null;
    const tag = keys[0]!;
    // Older writers spelled `as_none` as an empty tuple, newer ones as `true`.
    return { tag, value: raw[tag] };
}

function symIntValue(raw: unknown): number | null {
    const union = unionOf(raw);
    if (!union) return typeof raw === 'number' ? raw : null;
    if (union.tag === 'as_int' && typeof union.value === 'number') return union.value;
    return null;
}

/** Display form of a SymInt / SymBool / SymFloat: the literal, or the pretty-printed expression. */
function formatSym(raw: unknown): string {
    const union = unionOf(raw);
    if (!union) return scalarText(raw);
    if (union.tag === 'as_expr') {
        const expr = isRecord(union.value) ? union.value : {};
        const text = prettySymExpr(asText(expr['expr_str']));
        const hint = unionOf(expr['hint']);
        return hint ? `${text} (hint ${scalarText(hint.value)})` : text;
    }
    if (union.tag === 'as_bool') return union.value ? 'True' : 'False';
    return scalarText(union.value);
}

function formatDevice(raw: unknown): string {
    if (!isRecord(raw)) return asText(raw);
    const type = truncate(asText(raw['type']), MAX_TEXT);
    const index = raw['index'];
    return typeof index === 'number' ? `${type}:${index}` : type;
}

/** Resolves an enum serialized either as its integer value or its member name. */
function enumCode(raw: unknown, names: Record<string, number>): number | null {
    if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
    if (typeof raw === 'string') {
        if (raw in names) return names[raw]!;
        const numeric = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
        return Number.isNaN(numeric) ? null : numeric;
    }
    return null;
}

function enumLabel(raw: unknown, labels: Record<number, string>, names: Record<string, number>): string {
    const code = enumCode(raw, names);
    if (code === null) return truncate(asText(raw), MAX_TEXT);
    return labels[code] ?? `${code}`;
}

// ── Symbolic expressions ────────────────────────────────────────────────────

/**
 * Pretty-prints a sympy `srepr` such as
 * `Mul(Integer(2), Symbol('s0', positive=True, integer=True))` as `2*s0`.
 * A string that is not an srepr (older writers stored `str(expr)`) or that
 * this printer cannot parse is returned unchanged.
 */
export function prettySymExpr(text: string): string {
    const source = text.trim();
    if (!source || source.length > MAX_EXPRESSION_CHARS || !source.includes('(')) return truncate(source, MAX_TEXT);
    try {
        const parser = new SymExprParser(source);
        const node = parser.parse();
        return parser.position === source.length ? truncate(print(node, Number.NEGATIVE_INFINITY), MAX_TEXT) : source;
    } catch {
        return source;
    }
}

type SymNode = { kind: 'call'; name: string; args: SymNode[] } | { kind: 'string'; value: string } | { kind: 'number'; value: string } | { kind: 'name'; value: string };

class SymExprParser {
    position = 0;
    constructor(private readonly source: string) {}

    parse(depth = 0): SymNode {
        if (depth > MAX_EXPRESSION_DEPTH) throw new Error('depth');
        this.skipSpaces();
        const ch = this.source[this.position];
        if (ch === "'" || ch === '"') return { kind: 'string', value: this.readString(ch) };
        if (ch !== undefined && /[-0-9.]/.test(ch)) return { kind: 'number', value: this.readWhile(/[-+0-9.eE]/) };
        const name = this.readWhile(/[A-Za-z_0-9]/);
        if (!name) throw new Error('token');
        this.skipSpaces();
        if (this.source[this.position] !== '(') return { kind: 'name', value: name };
        this.position++;
        const args: SymNode[] = [];
        for (;;) {
            this.skipSpaces();
            if (this.source[this.position] === ')') { this.position++; break; }
            // Keyword arguments (`positive=True`) qualify a Symbol; they carry no display value.
            const save = this.position;
            const key = this.readWhile(/[A-Za-z_0-9]/);
            this.skipSpaces();
            if (key && this.source[this.position] === '=') { this.position++; this.parse(depth + 1); }
            else { this.position = save; args.push(this.parse(depth + 1)); }
            this.skipSpaces();
            if (this.source[this.position] === ',') this.position++;
            else if (this.source[this.position] !== ')') throw new Error('syntax');
        }
        return { kind: 'call', name, args };
    }

    private skipSpaces(): void { while (this.source[this.position] === ' ') this.position++; }

    private readWhile(pattern: RegExp): string {
        const start = this.position;
        while (this.position < this.source.length && pattern.test(this.source[this.position]!)) this.position++;
        return this.source.slice(start, this.position);
    }

    private readString(quoteChar: string): string {
        const end = this.source.indexOf(quoteChar, this.position + 1);
        if (end < 0) throw new Error('string');
        const value = this.source.slice(this.position + 1, end);
        this.position = end + 1;
        return value;
    }
}

const INFIX: Record<string, { op: string; precedence: number }> = {
    Add: { op: ' + ', precedence: 1 }, Mul: { op: '*', precedence: 2 }, Pow: { op: '**', precedence: 3 },
    Mod: { op: ' % ', precedence: 2 }, PythonMod: { op: ' % ', precedence: 2 }, FloorDiv: { op: '//', precedence: 2 },
    TrueDiv: { op: '/', precedence: 2 }, IntTrueDiv: { op: '/', precedence: 2 }, FloatTrueDiv: { op: '/', precedence: 2 },
    Eq: { op: ' == ', precedence: 0 }, Ne: { op: ' != ', precedence: 0 }, Unequality: { op: ' != ', precedence: 0 }, Equality: { op: ' == ', precedence: 0 },
    Lt: { op: ' < ', precedence: 0 }, Le: { op: ' <= ', precedence: 0 }, Gt: { op: ' > ', precedence: 0 }, Ge: { op: ' >= ', precedence: 0 },
    StrictLessThan: { op: ' < ', precedence: 0 }, LessThan: { op: ' <= ', precedence: 0 }, StrictGreaterThan: { op: ' > ', precedence: 0 }, GreaterThan: { op: ' >= ', precedence: 0 },
    And: { op: ' and ', precedence: -1 }, Or: { op: ' or ', precedence: -2 }
};
const CONSTANTS: Record<string, string> = { Zero: '0', One: '1', NegativeOne: '-1', Half: '1/2', true: 'True', false: 'False', True: 'True', False: 'False' };

function print(node: SymNode, outer: number): string {
    switch (node.kind) {
        case 'string': return node.value;
        case 'number': return node.value;
        case 'name': return CONSTANTS[node.value] ?? node.value;
        case 'call': break;
    }
    const args = node.args;
    const first = args[0];
    switch (node.name) {
        case 'Symbol': return first?.kind === 'string' ? first.value : 'symbol';
        case 'Integer': case 'Float': return first ? print(first, outer) : '?';
        case 'Rational': return args.length === 2 ? `${print(args[0]!, 2)}/${print(args[1]!, 2)}` : print(node, 0);
        case 'Identity': case 'ToFloat': case 'Not': {
            const inner = first ? print(first, node.name === 'Not' ? 4 : 0) : '?';
            return node.name === 'Not' ? `not ${inner}` : node.name === 'ToFloat' ? `float(${inner})` : inner;
        }
        default: break;
    }
    const infix = INFIX[node.name];
    if (infix && args.length >= 2) {
        // `Mul(Integer(-1), x)` reads as `-x`.
        if (node.name === 'Mul' && first && print(first, 0) === '-1' && args.length === 2) {
            const rest = print(args[1]!, infix.precedence);
            return outer > infix.precedence ? `(-${rest})` : `-${rest}`;
        }
        const text = args.map(item => print(item, infix.precedence + (node.name === 'Pow' ? 1 : 0))).join(infix.op);
        return outer > infix.precedence ? `(${text})` : text;
    }
    return `${node.name}(${args.map(item => print(item, Number.NEGATIVE_INFINITY)).join(', ')})`;
}

// ── Payloads ────────────────────────────────────────────────────────────────

function payloadKindOf(kind: Pt2InputKind): Pt2PayloadKind | '' {
    switch (kind) {
        case 'parameter': return 'parameter';
        case 'buffer': return 'buffer';
        case 'tensor_constant': return 'tensor_constant';
        case 'custom_obj': return 'custom_obj';
        default: return '';
    }
}

/**
 * Weights and constants from a `<model>_{weights,constants}_config.json`,
 * joined with the graph signature so every lifted parameter, buffer, and
 * constant is listed even when the archive keeps no payload for it (legacy
 * pickles, AOTInductor-only exports).
 */
function readPayloads(
    source: ModelSource,
    config: Record<string, unknown> | undefined,
    directory: 'weights' | 'constants',
    inputSpecs: Pt2InputSpec[],
    valuesByName: Map<string, Pt2Value>
): Pt2Payload[] {
    const { budget } = source;
    const folder = directory === 'weights' ? WEIGHTS_DIR : CONSTANTS_DIR;
    const specKinds: Pt2InputKind[] = directory === 'weights' ? ['parameter', 'buffer'] : ['tensor_constant', 'custom_obj'];
    const specs = new Map<string, Pt2InputSpec>();
    for (const spec of inputSpecs) if (specKinds.includes(spec.kind) && spec.target && !specs.has(spec.target)) specs.set(spec.target, spec);

    const payloads: Pt2Payload[] = [];
    const listed = new Set<string>();
    const entries = isRecord(config?.['config']) ? Object.entries(config['config']) : [];
    for (const [fqn, meta] of entries) {
        if (budget.payloads <= 0) { budget.payloadsDropped++; continue; }
        budget.payloads--;
        listed.add(fqn);
        const record = isRecord(meta) ? meta : {};
        const spec = specs.get(fqn);
        const pathName = truncate(asText(record['path_name']), MAX_TEXT);
        const isParam = record['is_param'] === true;
        const usePickle = record['use_pickle'] === true;
        const kind: Pt2PayloadKind = spec ? (payloadKindOf(spec.kind) || 'tensor_constant')
            : pathName.startsWith('custom_obj_') ? 'custom_obj'
            : pathName.startsWith('opaque_obj_') ? 'opaque_obj'
            : directory === 'weights' ? (isParam ? 'parameter' : 'buffer') : 'tensor_constant';
        const payload = basePayload(fqn, kind, spec?.arg ?? '', isParam);
        payload.path = pathName ? `${folder}${pathName}` : '';
        const tensorMeta = isRecord(record['tensor_meta']) ? readTensorMeta(record['tensor_meta']) : null;
        const fallback = spec ? valuesByName.get(spec.arg) : undefined;
        applyTensorMeta(payload, tensorMeta, fallback);
        const entry = payload.path ? source.byName.get(payload.path) : undefined;
        payload.fileSize = entry ? entry.uncompressedSize : null;
        if (!entry) payload.status = 'missing';
        else if (usePickle || kind === 'custom_obj' || kind === 'opaque_obj') payload.status = 'pickled';
        else if (tensorMeta && payload.bytes > entry.uncompressedSize) payload.status = 'truncated';
        else {
            payload.status = 'raw';
            if (tensorMeta) payload.preview = previewPayload(source.data, entry, tensorMeta, source.littleEndian, source.previewValues);
        }
        payloads.push(payload);
    }
    for (const [fqn, spec] of specs) {
        if (listed.has(fqn)) continue;
        if (budget.payloads <= 0) { budget.payloadsDropped++; continue; }
        budget.payloads--;
        const kind = payloadKindOf(spec.kind) || 'tensor_constant';
        const payload = basePayload(fqn, kind, spec.arg, kind === 'parameter');
        applyTensorMeta(payload, null, valuesByName.get(spec.arg));
        const legacyFile = source.legacy ? source.byName.get(directory === 'weights' ? LEGACY_STATE_DICT : LEGACY_CONSTANTS) : undefined;
        if (legacyFile) {
            payload.path = directory === 'weights' ? LEGACY_STATE_DICT : LEGACY_CONSTANTS;
            payload.fileSize = legacyFile.uncompressedSize;
            payload.status = 'pickled';
        } else {
            payload.status = 'unlisted';
        }
        payloads.push(payload);
    }
    return payloads;
}

function basePayload(name: string, kind: Pt2PayloadKind, placeholder: string, isParam: boolean): Pt2Payload {
    return {
        name: truncate(name, MAX_TEXT), kind, placeholder, path: '', isParam, dtype: '', shape: [], strides: [], storageOffset: 0,
        device: '', layout: '', requiresGrad: false, elementCount: 0, bytes: 0, fileSize: null, status: 'unlisted', preview: []
    };
}

function applyTensorMeta(payload: Pt2Payload, meta: TensorMeta | null, fallback: Pt2Value | undefined): void {
    if (meta) {
        payload.dtype = meta.dtype;
        payload.shape = meta.shape;
        payload.strides = meta.strides;
        payload.storageOffset = meta.storageOffsetValue;
        payload.device = meta.device;
        payload.layout = meta.layout;
        payload.requiresGrad = meta.requiresGrad;
        payload.elementCount = meta.elementCount ?? 0;
        payload.bytes = storageBytes(meta);
    } else if (fallback && fallback.kind === 'tensor') {
        payload.dtype = fallback.dtype;
        payload.shape = fallback.shape;
        payload.strides = fallback.strides;
        payload.device = fallback.device;
        payload.layout = fallback.layout;
        payload.requiresGrad = fallback.requiresGrad;
        payload.elementCount = fallback.elementCount ?? 0;
        const width = elementBytes(fallback.dtype);
        payload.bytes = fallback.elementCount === null ? 0 : fallback.elementCount * width;
    } else if (fallback) {
        payload.device = fallback.detail;
    }
}

function elementBytes(dtype: string): number {
    for (const info of Object.values(SCALAR_TYPES)) if (info.short === dtype) return info.bytes;
    return 0;
}

/** Bytes from the start of the storage to the last element the tensor touches. */
function storageBytes(meta: TensorMeta): number {
    const width = SCALAR_TYPES[meta.dtypeCode]?.bytes ?? 0;
    if (!width || !meta.sizes) return 0;
    if (meta.sizes.some(size => size === 0)) return 0;
    let span = 1;
    if (meta.strideValues && meta.strideValues.length === meta.sizes.length) {
        for (let axis = 0; axis < meta.sizes.length; axis++) span += (meta.sizes[axis]! - 1) * Math.abs(meta.strideValues[axis]!);
    } else {
        span = meta.sizes.reduce((total, size) => total * size, 1);
    }
    return (meta.storageOffsetValue + span) * width;
}

/** Decode the leading storage elements of a raw payload for display. */
function previewPayload(data: Uint8Array, entry: ZipEntry, meta: TensorMeta, littleEndian: boolean, count: number): string[] {
    const info = SCALAR_TYPES[meta.dtypeCode];
    if (!info || !info.bytes || count <= 0 || !meta.sizes || entry.method !== 0) return [];
    const total = meta.elementCount ?? 0;
    if (total <= 0) return [];
    const bytes = sliceStoredEntry(data, entry);
    if (!bytes) return [];
    const start = meta.storageOffsetValue * info.bytes;
    const available = Math.min(count, total, Math.floor((bytes.byteLength - start) / info.bytes));
    if (available <= 0) return [];
    const view = new DataView(bytes.buffer, bytes.byteOffset + start, available * info.bytes);
    const out: string[] = [];
    for (let index = 0; index < available; index++) {
        const at = index * info.bytes;
        switch (info.short) {
            case 'f32': out.push(formatNumber(view.getFloat32(at, littleEndian))); break;
            case 'f64': out.push(formatNumber(view.getFloat64(at, littleEndian))); break;
            case 'f16': out.push(formatNumber(float16(view.getUint16(at, littleEndian)))); break;
            case 'bf16': out.push(formatNumber(bfloat16(view.getUint16(at, littleEndian)))); break;
            case 'i8': out.push(String(view.getInt8(at))); break;
            case 'u8': out.push(String(view.getUint8(at))); break;
            case 'b8': out.push(view.getUint8(at) ? 'True' : 'False'); break;
            case 'i16': out.push(String(view.getInt16(at, littleEndian))); break;
            case 'u16': out.push(String(view.getUint16(at, littleEndian))); break;
            case 'i32': out.push(String(view.getInt32(at, littleEndian))); break;
            case 'u32': out.push(String(view.getUint32(at, littleEndian))); break;
            case 'i64': out.push(String(view.getBigInt64(at, littleEndian))); break;
            case 'u64': out.push(String(view.getBigUint64(at, littleEndian))); break;
            case 'c32': out.push(`${formatNumber(float16(view.getUint16(at, littleEndian)))}+${formatNumber(float16(view.getUint16(at + 2, littleEndian)))}j`); break;
            case 'c64': out.push(`${formatNumber(view.getFloat32(at, littleEndian))}+${formatNumber(view.getFloat32(at + 4, littleEndian))}j`); break;
            case 'c128': out.push(`${formatNumber(view.getFloat64(at, littleEndian))}+${formatNumber(view.getFloat64(at + 8, littleEndian))}j`); break;
            case 'f8e4m3fn': out.push(formatNumber(float8(view.getUint8(at), 4, 3, 7, false))); break;
            case 'f8e4m3fnuz': out.push(formatNumber(float8(view.getUint8(at), 4, 3, 8, true))); break;
            case 'f8e5m2': out.push(formatNumber(float8(view.getUint8(at), 5, 2, 15, false))); break;
            case 'f8e5m2fnuz': out.push(formatNumber(float8(view.getUint8(at), 5, 2, 16, true))); break;
            case 'f8e8m0fnu': { const raw = view.getUint8(at); out.push(raw === 0xff ? 'NaN' : formatNumber(2 ** (raw - 127))); break; }
            default: return [];
        }
    }
    return out;
}

function float16(bits: number): number {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const fraction = bits & 0x3ff;
    if (exponent === 0) return sign * fraction * 2 ** -24;
    if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
    return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

function bfloat16(bits: number): number {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, bits << 16);
    return view.getFloat32(0);
}

/**
 * IEEE-style 8-bit floats. The `fn` variants have no infinities and one NaN
 * encoding (all ones); the `fnuz` variants reserve only 0x80 for NaN and have
 * no negative zero; e5m2 keeps the IEEE special values.
 */
function float8(bits: number, exponentBits: number, mantissaBits: number, bias: number, fnuz: boolean): number {
    if (fnuz) {
        if (bits === 0x80) return Number.NaN;
    }
    const sign = bits & 0x80 ? -1 : 1;
    const exponent = (bits >> mantissaBits) & ((1 << exponentBits) - 1);
    const mantissa = bits & ((1 << mantissaBits) - 1);
    const maxExponent = (1 << exponentBits) - 1;
    if (!fnuz) {
        if (exponentBits === 4) {
            if (exponent === maxExponent && mantissa === (1 << mantissaBits) - 1) return Number.NaN;
        } else if (exponent === maxExponent) return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY;
    }
    if (exponent === 0) return sign * mantissa * 2 ** (1 - bias - mantissaBits);
    return sign * (1 + mantissa / (1 << mantissaBits)) * 2 ** (exponent - bias);
}

// ── AOTInductor ─────────────────────────────────────────────────────────────

function collectAotInductor(files: Pt2ArchiveEntry[], metadataNames: string[], members: Map<string, Uint8Array>, warnings: Pt2Warning[]): Pt2AotInductorModel[] {
    const byModel = new Map<string, Pt2AotInductorModel>();
    for (const file of files) {
        if (file.category !== 'aotinductor') continue;
        const rest = file.name.slice(AOTINDUCTOR_DIR.length);
        const slash = rest.indexOf('/');
        const modelName = slash < 0 ? '' : rest.slice(0, slash);
        let model = byModel.get(modelName);
        if (!model) { model = { name: modelName, files: [], metadata: [] }; byModel.set(modelName, model); }
        model.files.push(file);
    }
    for (const name of metadataNames) {
        const json = decodeJson(members.get(name), name, warnings);
        if (!isRecord(json)) continue;
        const rest = name.slice(AOTINDUCTOR_DIR.length);
        const slash = rest.indexOf('/');
        const model = byModel.get(slash < 0 ? '' : rest.slice(0, slash));
        if (!model) continue;
        const file = rest.slice(slash + 1);
        for (const [key, value] of Object.entries(json).slice(0, MAX_MODEL_METADATA)) {
            if (model.metadata.length >= MAX_MODEL_METADATA) break;
            const entry = { label: file.endsWith('weights_config.json') ? `weight ${key}` : key, value: truncate(scalarText(value), MAX_TEXT) };
            // Every compiled unit (wrapper, kernel, …) repeats the same platform keys.
            if (!model.metadata.some(item => item.label === entry.label && item.value === entry.value)) model.metadata.push(entry);
        }
    }
    return [...byModel.values()].sort((a, b) => compareText(a.name, b.name));
}

// ── ZIP ─────────────────────────────────────────────────────────────────────

interface ZipEntry {
    name: string;
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
}

interface MemberRequest {
    entry: ZipEntry;
    name: string;
    /** Cap on bytes to inflate, which allocates a copy. */
    inflateLimit: number;
    /** Cap on a stored member; Infinity where viewing it in place is free. */
    sliceLimit: number;
}

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CDFH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;

/**
 * Reads the central directory, following the ZIP64 locator when the classic
 * EOCD fields are saturated. `PyTorchFileWriter` opens miniz in ZIP64 mode, so
 * a large package keeps its real sizes and offsets in the extra field.
 */
function readZipDirectory(data: Uint8Array): { entries: ZipEntry[]; truncated: boolean } | null {
    if (data.byteLength < 22) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let eocd = -1;
    for (let p = data.byteLength - 22; p >= Math.max(0, data.byteLength - (22 + 0xffff)); p--) {
        if (view.getUint32(p, true) !== EOCD_SIG) continue;
        if (p + 22 + view.getUint16(p + 20, true) !== data.byteLength) continue;
        eocd = p;
        break;
    }
    if (eocd < 0) return null;
    let declared = view.getUint16(eocd + 10, true);
    let position = view.getUint32(eocd + 16, true);
    if (declared === 0xffff || position === 0xffffffff) {
        const locator = eocd - 20;
        if (locator < 0 || view.getUint32(locator, true) !== EOCD64_LOCATOR_SIG) return null;
        const eocd64 = readUint64(view, locator + 8);
        if (eocd64 === null || eocd64 + 56 > data.byteLength || view.getUint32(eocd64, true) !== EOCD64_SIG) return null;
        const count = readUint64(view, eocd64 + 32);
        const offset = readUint64(view, eocd64 + 48);
        if (count === null || offset === null) return null;
        declared = count;
        position = offset;
    }

    const entries: ZipEntry[] = [];
    const count = Math.min(declared, MAX_ZIP_ENTRIES);
    for (let index = 0; index < count; index++) {
        if (position + 46 > data.byteLength || view.getUint32(position, true) !== CDFH_SIG) break;
        const nameLength = view.getUint16(position + 28, true);
        const extraLength = view.getUint16(position + 30, true);
        const commentLength = view.getUint16(position + 32, true);
        const nameStart = position + 46;
        if (nameStart + nameLength + extraLength > data.byteLength) break;
        const entry: ZipEntry = {
            name: decodeText(data.subarray(nameStart, nameStart + nameLength)),
            method: view.getUint16(position + 10, true),
            compressedSize: view.getUint32(position + 20, true),
            uncompressedSize: view.getUint32(position + 24, true),
            localHeaderOffset: view.getUint32(position + 42, true)
        };
        applyZip64Extra(view, nameStart + nameLength, extraLength, entry);
        entries.push(entry);
        position = nameStart + nameLength + extraLength + commentLength;
    }
    return { entries, truncated: declared > count };
}

/** Fills saturated 32-bit fields from the ZIP64 extended-information extra field. */
function applyZip64Extra(view: DataView, start: number, length: number, entry: ZipEntry): void {
    let p = start;
    const end = start + length;
    while (p + 4 <= end) {
        const id = view.getUint16(p, true);
        const size = view.getUint16(p + 2, true);
        const body = p + 4;
        if (body + size > end) return;
        if (id === ZIP64_EXTRA_ID) {
            let q = body;
            const take = (): number | null => {
                if (q + 8 > body + size) return null;
                const value = readUint64(view, q);
                q += 8;
                return value;
            };
            if (entry.uncompressedSize === 0xffffffff) entry.uncompressedSize = take() ?? entry.uncompressedSize;
            if (entry.compressedSize === 0xffffffff) entry.compressedSize = take() ?? entry.compressedSize;
            if (entry.localHeaderOffset === 0xffffffff) entry.localHeaderOffset = take() ?? entry.localHeaderOffset;
            return;
        }
        p = body + size;
    }
}

function readUint64(view: DataView, at: number): number | null {
    if (at + 8 > view.byteLength) return null;
    const value = view.getBigUint64(at, true);
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
}

/** Bytes of a stored (uncompressed) member, viewed in place without copying. */
function sliceStoredEntry(data: Uint8Array, entry: ZipEntry): Uint8Array | undefined {
    const offset = entry.localHeaderOffset;
    if (offset < 0 || offset + 30 > data.byteLength) return undefined;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(offset, true) !== LFH_SIG) return undefined;
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const end = start + entry.uncompressedSize;
    if (start > data.byteLength || end > data.byteLength) return undefined;
    return data.subarray(start, end);
}

/**
 * Reads the requested members. Stored members are viewed in place; deflated
 * members (an archive a user re-zipped) need an inflater, and the optional
 * JSZip dependency is loaded once for all of them.
 */
async function readMembers(
    data: Uint8Array,
    requests: readonly MemberRequest[],
    warnings: Pt2Warning[],
    options: Pt2ParseOptions
): Promise<Map<string, Uint8Array>> {
    const bytes = new Map<string, Uint8Array>();
    const deflated: MemberRequest[] = [];
    const tooLarge = (name: string, limit: number): void => {
        warnings.push({ key: 'pt2.warning.memberTooLarge', args: { name, limit: formatFileSize(limit) } });
    };
    for (const request of requests) {
        const { entry, name } = request;
        if (entry.method === 8) {
            if (entry.uncompressedSize > request.inflateLimit) tooLarge(name, request.inflateLimit);
            else deflated.push(request);
            continue;
        }
        if (entry.method !== 0) {
            warnings.push({ key: 'pt2.warning.memberMethod', args: { name, method: entry.method } });
            continue;
        }
        if (entry.uncompressedSize > request.sliceLimit) {
            tooLarge(name, request.sliceLimit);
            continue;
        }
        const stored = sliceStoredEntry(data, entry);
        if (stored) bytes.set(name, stored);
        else warnings.push({ key: 'pt2.warning.memberUnreadable', args: { name } });
    }
    if (!deflated.length) return bytes;

    const module = await import('jszip').catch(() => undefined);
    throwIfAborted(options.signal);
    if (!module) {
        for (const { name } of deflated) warnings.push({ key: 'pt2.warning.inflateUnavailable', args: { name } });
        return bytes;
    }
    try {
        // CRC verification would inflate every member, including weights this
        // viewer never reads, before any limit could apply.
        const archive = await module.default.loadAsync(data, { checkCRC32: false, createFolders: false });
        for (const { entry, name } of deflated) {
            throwIfAborted(options.signal);
            const file = archive.file(entry.name);
            if (file) bytes.set(name, await file.async('uint8array'));
            else warnings.push({ key: 'pt2.warning.memberUnreadable', args: { name } });
        }
    } catch (error) {
        if (options.signal?.aborted) throw error;
        for (const { name } of deflated) {
            if (!bytes.has(name)) warnings.push({ key: 'pt2.warning.memberUnreadable', args: { name } });
        }
    }
    return bytes;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function decodeJson(bytes: Uint8Array | undefined, name: string, warnings: Pt2Warning[]): unknown {
    if (!bytes) return undefined;
    try {
        return JSON.parse(decodeText(bytes));
    } catch {
        warnings.push({ key: 'pt2.warning.jsonUnreadable', args: { name } });
        return undefined;
    }
}

function decodeText(bytes: Uint8Array | undefined, fatal = false): string {
    if (!bytes) return '';
    try {
        return new TextDecoder('utf-8', { fatal }).decode(bytes);
    } catch {
        return '';
    }
}

function hasPrefix(data: Uint8Array, prefix: readonly number[]): boolean {
    return data.byteLength >= prefix.length && prefix.every((byte, index) => data[index] === byte);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asList(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string {
    return typeof value === 'string' ? value : value === undefined || value === null ? '' : scalarText(value);
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringList(value: unknown): string[] {
    return asList(value).slice(0, MAX_LIST_ITEMS).filter((item): item is string => typeof item === 'string').map(item => truncate(item, MAX_TEXT));
}

/** Display form of a JSON scalar; objects are JSON-encoded (bounded by the caller). */
function scalarText(value: unknown, whenNull = 'None'): string {
    if (value === null || value === undefined) return whenNull;
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return numberText(value);
    if (typeof value === 'boolean') return value ? 'True' : 'False';
    try {
        return JSON.stringify(value) ?? '';
    } catch {
        return String(value);
    }
}

/** Floats that JSON cannot carry are written by torch as the strings `Infinity`, `-Infinity`, `NaN`. */
function numberText(value: unknown): string {
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : formatNumber(value);
    if (typeof value === 'string') return value === 'Infinity' ? 'inf' : value === '-Infinity' ? '-inf' : value === 'NaN' ? 'nan' : value;
    return scalarText(value);
}

function formatNumber(value: number): string {
    return Number.isFinite(value) ? String(Number(value.toPrecision(6))) : Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf';
}

function quote(value: string): string {
    return `'${truncate(value, MAX_TEXT).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function truncate(text: string, limit: number): string {
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
}

export function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let scaled = bytes;
    let unit = -1;
    do { scaled /= 1024; unit++; } while (scaled >= 1024 && unit < units.length - 1);
    return `${scaled.toFixed(2)} ${units[unit]}`;
}
