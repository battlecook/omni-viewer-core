/**
 * Dependency-free TFLite / LiteRT FlatBuffer metadata reader.
 *
 * Buffer payloads are deliberately skipped: the viewer needs subgraph topology,
 * operator codes and options, tensor types, shapes, and quantization, not the
 * model weights in memory. Vtable slots follow the normative `schema.fbs`
 * (schema version 3, file identifier `TFL3`).
 */

export interface TfliteSummaryItem { labelKey: string; value: string | number }
export interface TfliteWarning { key: string; args?: Record<string, string | number> }
export interface TfliteAttribute { name: string; value: string }

export type TfliteBufferLocation = 'empty' | 'inline' | 'appended';

export interface TfliteBuffer {
    index: number;
    /** Payload size in bytes as a decimal string (appended buffers exceed 2^53). */
    size: string;
    /** File offset for appended payloads, `0` while the payload is inline. */
    offset: string;
    location: TfliteBufferLocation;
}

export interface TfliteOperatorCode {
    index: number;
    builtinCode: number;
    name: string;
    customCode: string;
    version: number;
    custom: boolean;
}

export interface TfliteQuantization {
    scale: number[];
    zeroPoint: string[];
    min: number[];
    max: number[];
    quantizedDimension: number;
    detailsType: string;
    truncated: boolean;
    summary: string;
}

export interface TfliteDimensionMetadata {
    format: string;
    denseSize: number;
    arraySegments: number[];
    arrayIndices: number[];
    truncated: boolean;
}

export interface TfliteSparsity {
    traversalOrder: number[];
    blockMap: number[];
    dimensions: TfliteDimensionMetadata[];
    /** Set when the dimension list itself was capped. */
    truncated: boolean;
}

export interface TfliteTensor {
    index: number;
    name: string;
    type: string;
    shape: number[];
    shapeSignature: number[];
    buffer: number;
    location: TfliteBufferLocation;
    /** Bytes actually stored for this tensor, from its buffer. */
    dataBytes: string;
    /** Bytes the declared type and shape imply, for comparison with dataBytes. */
    expectedBytes: string;
    elementCount: string;
    isVariable: boolean;
    hasRank: boolean;
    quantization?: TfliteQuantization;
    sparsity?: TfliteSparsity;
}

export interface TfliteOperator {
    id: string;
    index: number;
    opcodeIndex: number;
    operator: string;
    custom: boolean;
    version: number;
    inputs: number[];
    outputs: number[];
    intermediates: number[];
    optionsType: string;
    options: TfliteAttribute[];
    customOptionsBytes: string;
    customOptionsFormat: string;
    /** Subgraph indices this operator delegates to (IF / WHILE / CALL_ONCE). */
    subgraphRefs: number[];
}

export interface TfliteSubgraph {
    index: number;
    name: string;
    tensors: TfliteTensor[];
    operators: TfliteOperator[];
    inputs: number[];
    outputs: number[];
}

export interface TfliteMetadataEntry {
    name: string;
    buffer: number;
    size: string;
    /** Decoded payload when the buffer holds short printable text. */
    text: string;
}

export interface TfliteTensorMap { name: string; tensorIndex: number; tensorName: string }

export interface TfliteSignature {
    key: string;
    subgraphIndex: number;
    inputs: TfliteTensorMap[];
    outputs: TfliteTensorMap[];
}

export interface TfliteDocument {
    format: 'tflite';
    title: string;
    fileSize: string;
    version: string;
    identifier: string;
    description: string;
    /** Interpreter version from the `min_runtime_version` metadata buffer. */
    minRuntimeVersion: string;
    subgraphs: TfliteSubgraph[];
    operatorCodes: TfliteOperatorCode[];
    buffers: TfliteBuffer[];
    metadata: TfliteMetadataEntry[];
    metadataBuffers: number[];
    signatures: TfliteSignature[];
    /** Total bytes held by all buffers, inline and appended. */
    weightBytes: string;
    summary: TfliteSummaryItem[];
    warnings: TfliteWarning[];
}

export class TfliteParseError extends Error {
    override readonly name = 'TfliteParseError';
}

const MAX_DEPTH = 64;
const MAX_OBJECTS = 200_000;
const MAX_ITEMS = 100_000;
/** Whole-file ceiling on decoded vector elements; byte payloads are never decoded. */
const MAX_TOTAL_ITEMS = 4_000_000;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_TOTAL_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_QUANTIZATION_ITEMS = 64;
const MAX_OPTION_ITEMS = 64;
const MAX_SPARSITY_ITEMS = 64;
const MAX_TENSOR_RANK = 1024;
const MAX_TENSOR_PRODUCT_BITS = 4096;
const MAX_METADATA_TEXT_BYTES = 512;
const FILE_IDENTIFIER = 'TFL3';
const CUSTOM_OPERATOR_CODE = 32;
/** Codes at or above the placeholder live in `builtin_code`, not the byte field. */
const PLACEHOLDER_OPERATOR_CODE = 127;
const decoder = new TextDecoder('utf-8');

const TENSOR_TYPES: Record<number, string> = {
    0: 'FLOAT32', 1: 'FLOAT16', 2: 'INT32', 3: 'UINT8', 4: 'INT64', 5: 'STRING',
    6: 'BOOL', 7: 'INT16', 8: 'COMPLEX64', 9: 'INT8', 10: 'FLOAT64', 11: 'COMPLEX128',
    12: 'UINT64', 13: 'RESOURCE', 14: 'VARIANT', 15: 'UINT32', 16: 'UINT16',
    17: 'INT4', 18: 'BFLOAT16', 19: 'INT2', 20: 'UINT4', 21: 'FLOAT8_E4M3FN', 22: 'FLOAT8_E5M2'
};

/** Bits per element; variable-width and handle types are 0 (size unknown). */
const TYPE_BITS: Record<number, number> = {
    0: 32, 1: 16, 2: 32, 3: 8, 4: 64, 5: 0, 6: 8, 7: 16, 8: 64, 9: 8, 10: 64,
    11: 128, 12: 64, 13: 0, 14: 0, 15: 32, 16: 16, 17: 4, 18: 16, 19: 2, 20: 4, 21: 8, 22: 8
};

const BUILTIN_OPERATORS: Record<number, string> = {
    0: 'ADD', 1: 'AVERAGE_POOL_2D', 2: 'CONCATENATION', 3: 'CONV_2D', 4: 'DEPTHWISE_CONV_2D',
    5: 'DEPTH_TO_SPACE', 6: 'DEQUANTIZE', 7: 'EMBEDDING_LOOKUP', 8: 'FLOOR', 9: 'FULLY_CONNECTED',
    10: 'HASHTABLE_LOOKUP', 11: 'L2_NORMALIZATION', 12: 'L2_POOL_2D', 13: 'LOCAL_RESPONSE_NORMALIZATION',
    14: 'LOGISTIC', 15: 'LSH_PROJECTION', 16: 'LSTM', 17: 'MAX_POOL_2D', 18: 'MUL', 19: 'RELU',
    20: 'RELU_N1_TO_1', 21: 'RELU6', 22: 'RESHAPE', 23: 'RESIZE_BILINEAR', 24: 'RNN', 25: 'SOFTMAX',
    26: 'SPACE_TO_DEPTH', 27: 'SVDF', 28: 'TANH', 29: 'CONCAT_EMBEDDINGS', 30: 'SKIP_GRAM',
    31: 'CALL', 32: 'CUSTOM', 33: 'EMBEDDING_LOOKUP_SPARSE', 34: 'PAD',
    35: 'UNIDIRECTIONAL_SEQUENCE_RNN', 36: 'GATHER', 37: 'BATCH_TO_SPACE_ND', 38: 'SPACE_TO_BATCH_ND',
    39: 'TRANSPOSE', 40: 'MEAN', 41: 'SUB', 42: 'DIV', 43: 'SQUEEZE',
    44: 'UNIDIRECTIONAL_SEQUENCE_LSTM', 45: 'STRIDED_SLICE', 46: 'BIDIRECTIONAL_SEQUENCE_RNN',
    47: 'EXP', 48: 'TOPK_V2', 49: 'SPLIT', 50: 'LOG_SOFTMAX', 51: 'DELEGATE',
    52: 'BIDIRECTIONAL_SEQUENCE_LSTM', 53: 'CAST', 54: 'PRELU', 55: 'MAXIMUM', 56: 'ARG_MAX',
    57: 'MINIMUM', 58: 'LESS', 59: 'NEG', 60: 'PADV2', 61: 'GREATER', 62: 'GREATER_EQUAL',
    63: 'LESS_EQUAL', 64: 'SELECT', 65: 'SLICE', 66: 'SIN', 67: 'TRANSPOSE_CONV',
    68: 'SPARSE_TO_DENSE', 69: 'TILE', 70: 'EXPAND_DIMS', 71: 'EQUAL', 72: 'NOT_EQUAL', 73: 'LOG',
    74: 'SUM', 75: 'SQRT', 76: 'RSQRT', 77: 'SHAPE', 78: 'POW', 79: 'ARG_MIN', 80: 'FAKE_QUANT',
    81: 'REDUCE_PROD', 82: 'REDUCE_MAX', 83: 'PACK', 84: 'LOGICAL_OR', 85: 'ONE_HOT',
    86: 'LOGICAL_AND', 87: 'LOGICAL_NOT', 88: 'UNPACK', 89: 'REDUCE_MIN', 90: 'FLOOR_DIV',
    91: 'REDUCE_ANY', 92: 'SQUARE', 93: 'ZEROS_LIKE', 94: 'FILL', 95: 'FLOOR_MOD', 96: 'RANGE',
    97: 'RESIZE_NEAREST_NEIGHBOR', 98: 'LEAKY_RELU', 99: 'SQUARED_DIFFERENCE', 100: 'MIRROR_PAD',
    101: 'ABS', 102: 'SPLIT_V', 103: 'UNIQUE', 104: 'CEIL', 105: 'REVERSE_V2', 106: 'ADD_N',
    107: 'GATHER_ND', 108: 'COS', 109: 'WHERE', 110: 'RANK', 111: 'ELU', 112: 'REVERSE_SEQUENCE',
    113: 'MATRIX_DIAG', 114: 'QUANTIZE', 115: 'MATRIX_SET_DIAG', 116: 'ROUND', 117: 'HARD_SWISH',
    118: 'IF', 119: 'WHILE', 120: 'NON_MAX_SUPPRESSION_V4', 121: 'NON_MAX_SUPPRESSION_V5',
    122: 'SCATTER_ND', 123: 'SELECT_V2', 124: 'DENSIFY', 125: 'SEGMENT_SUM', 126: 'BATCH_MATMUL',
    127: 'PLACEHOLDER_FOR_GREATER_OP_CODES', 128: 'CUMSUM', 129: 'CALL_ONCE', 130: 'BROADCAST_TO',
    131: 'RFFT2D', 132: 'CONV_3D', 133: 'IMAG', 134: 'REAL', 135: 'COMPLEX_ABS', 136: 'HASHTABLE',
    137: 'HASHTABLE_FIND', 138: 'HASHTABLE_IMPORT', 139: 'HASHTABLE_SIZE', 140: 'REDUCE_ALL',
    141: 'CONV_3D_TRANSPOSE', 142: 'VAR_HANDLE', 143: 'READ_VARIABLE', 144: 'ASSIGN_VARIABLE',
    145: 'BROADCAST_ARGS', 146: 'RANDOM_STANDARD_NORMAL', 147: 'BUCKETIZE', 148: 'RANDOM_UNIFORM',
    149: 'MULTINOMIAL', 150: 'GELU', 151: 'DYNAMIC_UPDATE_SLICE', 152: 'RELU_0_TO_1',
    153: 'UNSORTED_SEGMENT_PROD', 154: 'UNSORTED_SEGMENT_MAX', 155: 'UNSORTED_SEGMENT_SUM',
    156: 'ATAN2', 157: 'UNSORTED_SEGMENT_MIN', 158: 'SIGN', 159: 'BITCAST', 160: 'BITWISE_XOR',
    161: 'RIGHT_SHIFT', 162: 'STABLEHLO_LOGISTIC', 163: 'STABLEHLO_ADD', 164: 'STABLEHLO_DIVIDE',
    165: 'STABLEHLO_MULTIPLY', 166: 'STABLEHLO_MAXIMUM', 167: 'STABLEHLO_RESHAPE',
    168: 'STABLEHLO_CLAMP', 169: 'STABLEHLO_CONCATENATE', 170: 'STABLEHLO_BROADCAST_IN_DIM',
    171: 'STABLEHLO_CONVOLUTION', 172: 'STABLEHLO_SLICE', 173: 'STABLEHLO_CUSTOM_CALL',
    174: 'STABLEHLO_REDUCE', 175: 'STABLEHLO_ABS', 176: 'STABLEHLO_AND', 177: 'STABLEHLO_COSINE',
    178: 'STABLEHLO_EXPONENTIAL', 179: 'STABLEHLO_FLOOR', 180: 'STABLEHLO_LOG',
    181: 'STABLEHLO_MINIMUM', 182: 'STABLEHLO_NEGATE', 183: 'STABLEHLO_OR', 184: 'STABLEHLO_POWER',
    185: 'STABLEHLO_REMAINDER', 186: 'STABLEHLO_RSQRT', 187: 'STABLEHLO_SELECT',
    188: 'STABLEHLO_SUBTRACT', 189: 'STABLEHLO_TANH', 190: 'STABLEHLO_SCATTER',
    191: 'STABLEHLO_COMPARE', 192: 'STABLEHLO_CONVERT', 193: 'STABLEHLO_DYNAMIC_SLICE',
    194: 'STABLEHLO_DYNAMIC_UPDATE_SLICE', 195: 'STABLEHLO_PAD', 196: 'STABLEHLO_IOTA',
    197: 'STABLEHLO_DOT_GENERAL', 198: 'STABLEHLO_REDUCE_WINDOW', 199: 'STABLEHLO_SORT',
    200: 'STABLEHLO_WHILE', 201: 'STABLEHLO_GATHER', 202: 'STABLEHLO_TRANSPOSE', 203: 'DILATE',
    204: 'STABLEHLO_RNG_BIT_GENERATOR', 205: 'REDUCE_WINDOW', 206: 'STABLEHLO_COMPOSITE',
    207: 'STABLEHLO_SHIFT_LEFT', 208: 'STABLEHLO_CBRT', 209: 'STABLEHLO_CASE'
};

const BUILTIN_OPTIONS: Record<number, string> = {
    1: 'Conv2DOptions', 2: 'DepthwiseConv2DOptions', 3: 'ConcatEmbeddingsOptions',
    4: 'LSHProjectionOptions', 5: 'Pool2DOptions', 6: 'SVDFOptions', 7: 'RNNOptions',
    8: 'FullyConnectedOptions', 9: 'SoftmaxOptions', 10: 'ConcatenationOptions', 11: 'AddOptions',
    12: 'L2NormOptions', 13: 'LocalResponseNormalizationOptions', 14: 'LSTMOptions',
    15: 'ResizeBilinearOptions', 16: 'CallOptions', 17: 'ReshapeOptions', 18: 'SkipGramOptions',
    19: 'SpaceToDepthOptions', 20: 'EmbeddingLookupSparseOptions', 21: 'MulOptions',
    22: 'PadOptions', 23: 'GatherOptions', 24: 'BatchToSpaceNDOptions', 25: 'SpaceToBatchNDOptions',
    26: 'TransposeOptions', 27: 'ReducerOptions', 28: 'SubOptions', 29: 'DivOptions',
    30: 'SqueezeOptions', 31: 'SequenceRNNOptions', 32: 'StridedSliceOptions', 33: 'ExpOptions',
    34: 'TopKV2Options', 35: 'SplitOptions', 36: 'LogSoftmaxOptions', 37: 'CastOptions',
    38: 'DequantizeOptions', 39: 'MaximumMinimumOptions', 40: 'ArgMaxOptions', 41: 'LessOptions',
    42: 'NegOptions', 43: 'PadV2Options', 44: 'GreaterOptions', 45: 'GreaterEqualOptions',
    46: 'LessEqualOptions', 47: 'SelectOptions', 48: 'SliceOptions', 49: 'TransposeConvOptions',
    50: 'SparseToDenseOptions', 51: 'TileOptions', 52: 'ExpandDimsOptions', 53: 'EqualOptions',
    54: 'NotEqualOptions', 55: 'ShapeOptions', 56: 'PowOptions', 57: 'ArgMinOptions',
    58: 'FakeQuantOptions', 59: 'PackOptions', 60: 'LogicalOrOptions', 61: 'OneHotOptions',
    62: 'LogicalAndOptions', 63: 'LogicalNotOptions', 64: 'UnpackOptions', 65: 'FloorDivOptions',
    66: 'SquareOptions', 67: 'ZerosLikeOptions', 68: 'FillOptions',
    69: 'BidirectionalSequenceLSTMOptions', 70: 'BidirectionalSequenceRNNOptions',
    71: 'UnidirectionalSequenceLSTMOptions', 72: 'FloorModOptions', 73: 'RangeOptions',
    74: 'ResizeNearestNeighborOptions', 75: 'LeakyReluOptions', 76: 'SquaredDifferenceOptions',
    77: 'MirrorPadOptions', 78: 'AbsOptions', 79: 'SplitVOptions', 80: 'UniqueOptions',
    81: 'ReverseV2Options', 82: 'AddNOptions', 83: 'GatherNdOptions', 84: 'CosOptions',
    85: 'WhereOptions', 86: 'RankOptions', 87: 'ReverseSequenceOptions', 88: 'MatrixDiagOptions',
    89: 'QuantizeOptions', 90: 'MatrixSetDiagOptions', 91: 'HardSwishOptions', 92: 'IfOptions',
    93: 'WhileOptions', 94: 'DepthToSpaceOptions', 95: 'NonMaxSuppressionV4Options',
    96: 'NonMaxSuppressionV5Options', 97: 'ScatterNdOptions', 98: 'SelectV2Options',
    99: 'DensifyOptions', 100: 'SegmentSumOptions', 101: 'BatchMatMulOptions', 102: 'CumsumOptions',
    103: 'CallOnceOptions', 104: 'BroadcastToOptions', 105: 'Rfft2dOptions', 106: 'Conv3DOptions',
    107: 'HashtableOptions', 108: 'HashtableFindOptions', 109: 'HashtableImportOptions',
    110: 'HashtableSizeOptions', 111: 'VarHandleOptions', 112: 'ReadVariableOptions',
    113: 'AssignVariableOptions', 114: 'RandomOptions', 115: 'BucketizeOptions', 116: 'GeluOptions',
    117: 'DynamicUpdateSliceOptions', 118: 'UnsortedSegmentProdOptions',
    119: 'UnsortedSegmentMaxOptions', 120: 'UnsortedSegmentMinOptions',
    121: 'UnsortedSegmentSumOptions', 122: 'ATan2Options', 123: 'SignOptions', 124: 'BitcastOptions',
    125: 'BitwiseXorOptions', 126: 'RightShiftOptions'
};

const BUILTIN_OPTIONS_2: Record<number, string> = {
    1: 'StablehloConcatenateOptions', 2: 'StablehloBroadcastInDimOptions', 3: 'StablehloSliceOptions',
    4: 'StablehloConvolutionOptions', 5: 'StablehloCustomCallOptions', 6: 'StablehloReduceOptions',
    7: 'StablehloScatterOptions', 8: 'StablehloCompareOptions', 9: 'StablehloDynamicSliceOptions',
    10: 'StablehloPadOptions', 11: 'StablehloIotaOptions', 12: 'StablehloDotGeneralOptions',
    13: 'StablehloReduceWindowOptions', 14: 'StablehloSortOptions', 15: 'StablehloWhileOptions',
    16: 'StablehloGatherOptions', 17: 'StablehloTransposeOptions', 18: 'DilateOptions',
    19: 'StablehloRngBitGeneratorOptions', 20: 'ReduceWindowOptions', 21: 'StableHLOCompositeOptions',
    22: 'StablehloShiftLeftOptions', 23: 'StablehloCaseOptions'
};

const QUANTIZATION_DETAILS: Record<number, string> = {
    0: 'NONE', 1: 'CustomQuantization', 2: 'BlockwiseQuantization', 3: 'MultiAxisQuantization'
};
const DIMENSION_TYPES: Record<number, string> = { 0: 'DENSE', 1: 'SPARSE_CSR' };
const PADDING: Record<number, string> = { 0: 'SAME', 1: 'VALID' };
const ACTIVATION: Record<number, string> = { 0: 'NONE', 1: 'RELU', 2: 'RELU_N1_TO_1', 3: 'RELU6', 4: 'TANH', 5: 'SIGN_BIT' };
const LSH_PROJECTION: Record<number, string> = { 0: 'UNKNOWN', 1: 'SPARSE', 2: 'DENSE' };
const WEIGHTS_FORMAT: Record<number, string> = { 0: 'DEFAULT', 1: 'SHUFFLED4x16INT8' };
const LSTM_KERNEL: Record<number, string> = { 0: 'FULL', 1: 'BASIC' };
const COMBINER: Record<number, string> = { 0: 'SUM', 1: 'MEAN', 2: 'SQRTN' };
const MIRROR_PAD: Record<number, string> = { 0: 'REFLECT', 1: 'SYMMETRIC' };
const CUSTOM_OPTIONS_FORMAT: Record<number, string> = { 0: 'FLEXBUFFERS' };

/** `enum` covers the byte-wide enums the schema uses for padding, activation,
 *  and tensor types; `int`/`long` are the 32- and 64-bit scalars. */
type OptionKind = 'bool' | 'enum' | 'int' | 'uint' | 'long' | 'float' | 'string' | 'ints' | 'longs' | 'floats';

interface OptionField {
    name: string;
    slot: number;
    kind: OptionKind;
    /** Labels for `enum` fields; unmapped values render as their raw number. */
    labels?: Record<number, string>;
    /** Value that means "unset" and is therefore not rendered. */
    absent?: number | boolean;
    /** Subgraph reference, surfaced separately for graph navigation. */
    subgraph?: true;
}

/**
 * Field layouts for the option tables a real model is likely to carry. Tables
 * that are absent here still render their union type name — FlatBuffers is not
 * self-describing, so unknown vtable slots cannot be named.
 */
const OPTION_FIELDS: Record<string, readonly OptionField[]> = {
    Conv2DOptions: [
        { name: 'padding', slot: 0, kind: 'enum', labels: PADDING },
        { name: 'stride_w', slot: 1, kind: 'int' }, { name: 'stride_h', slot: 2, kind: 'int' },
        { name: 'fused_activation_function', slot: 3, kind: 'enum', labels: ACTIVATION, absent: 0 },
        { name: 'dilation_w_factor', slot: 4, kind: 'int', absent: 1 },
        { name: 'dilation_h_factor', slot: 5, kind: 'int', absent: 1 },
        { name: 'quantized_bias_type', slot: 6, kind: 'enum', labels: TENSOR_TYPES, absent: 0 }
    ],
    DepthwiseConv2DOptions: [
        { name: 'padding', slot: 0, kind: 'enum', labels: PADDING },
        { name: 'stride_w', slot: 1, kind: 'int' }, { name: 'stride_h', slot: 2, kind: 'int' },
        { name: 'depth_multiplier', slot: 3, kind: 'int' },
        { name: 'fused_activation_function', slot: 4, kind: 'enum', labels: ACTIVATION, absent: 0 },
        { name: 'dilation_w_factor', slot: 5, kind: 'int', absent: 1 },
        { name: 'dilation_h_factor', slot: 6, kind: 'int', absent: 1 }
    ],
    ConcatEmbeddingsOptions: [
        { name: 'num_channels', slot: 0, kind: 'int' },
        { name: 'num_columns_per_channel', slot: 1, kind: 'ints' },
        { name: 'embedding_dim_per_channel', slot: 2, kind: 'ints' }
    ],
    LSHProjectionOptions: [{ name: 'type', slot: 0, kind: 'enum', labels: LSH_PROJECTION }],
    Pool2DOptions: [
        { name: 'padding', slot: 0, kind: 'enum', labels: PADDING },
        { name: 'stride_w', slot: 1, kind: 'int' }, { name: 'stride_h', slot: 2, kind: 'int' },
        { name: 'filter_width', slot: 3, kind: 'int' }, { name: 'filter_height', slot: 4, kind: 'int' },
        { name: 'fused_activation_function', slot: 5, kind: 'enum', labels: ACTIVATION, absent: 0 }
    ],
    SVDFOptions: [
        { name: 'rank', slot: 0, kind: 'int' },
        { name: 'fused_activation_function', slot: 1, kind: 'enum', labels: ACTIVATION, absent: 0 },
        { name: 'asymmetric_quantize_inputs', slot: 2, kind: 'bool', absent: false }
    ],
    RNNOptions: [
        { name: 'fused_activation_function', slot: 0, kind: 'enum', labels: ACTIVATION, absent: 0 },
        { name: 'asymmetric_quantize_inputs', slot: 1, kind: 'bool', absent: false }
    ],
    FullyConnectedOptions: [
        { name: 'fused_activation_function', slot: 0, kind: 'enum', labels: ACTIVATION, absent: 0 },
        { name: 'weights_format', slot: 1, kind: 'enum', labels: WEIGHTS_FORMAT, absent: 0 },
        { name: 'keep_num_dims', slot: 2, kind: 'bool', absent: false },
        { name: 'asymmetric_quantize_inputs', slot: 3, kind: 'bool', absent: false },
        { name: 'quantized_bias_type', slot: 4, kind: 'enum', labels: TENSOR_TYPES, absent: 0 }
    ],
    SoftmaxOptions: [{ name: 'beta', slot: 0, kind: 'float' }],
    ConcatenationOptions: [
        { name: 'axis', slot: 0, kind: 'int' },
        { name: 'fused_activation_function', slot: 1, kind: 'enum', labels: ACTIVATION, absent: 0 }
    ],
    AddOptions: [
        { name: 'fused_activation_function', slot: 0, kind: 'enum', labels: ACTIVATION, absent: 0 },
        { name: 'pot_scale_int16', slot: 1, kind: 'bool', absent: true }
    ],
    L2NormOptions: [{ name: 'fused_activation_function', slot: 0, kind: 'enum', labels: ACTIVATION, absent: 0 }],
    LocalResponseNormalizationOptions: [
        { name: 'radius', slot: 0, kind: 'int' }, { name: 'bias', slot: 1, kind: 'float' },
        { name: 'alpha', slot: 2, kind: 'float' }, { name: 'beta', slot: 3, kind: 'float' }
    ],
    LSTMOptions: [
        { name: 'fused_activation_function', slot: 0, kind: 'enum', labels: ACTIVATION, absent: 0 },
        { name: 'cell_clip', slot: 1, kind: 'float', absent: 0 },
        { name: 'proj_clip', slot: 2, kind: 'float', absent: 0 },
        { name: 'kernel_type', slot: 3, kind: 'enum', labels: LSTM_KERNEL },
        { name: 'asymmetric_quantize_inputs', slot: 4, kind: 'bool', absent: false }
    ],
    ResizeBilinearOptions: [
        { name: 'align_corners', slot: 2, kind: 'bool', absent: false },
        { name: 'half_pixel_centers', slot: 3, kind: 'bool', absent: false }
    ],
    CallOptions: [{ name: 'subgraph', slot: 0, kind: 'uint', subgraph: true }],
    ReshapeOptions: [{ name: 'new_shape', slot: 0, kind: 'ints' }],
    SkipGramOptions: [
        { name: 'ngram_size', slot: 0, kind: 'int' }, { name: 'max_skip_size', slot: 1, kind: 'int' },
        { name: 'include_all_ngrams', slot: 2, kind: 'bool', absent: false }
    ],
    SpaceToDepthOptions: [{ name: 'block_size', slot: 0, kind: 'int' }],
    DepthToSpaceOptions: [{ name: 'block_size', slot: 0, kind: 'int' }],
    EmbeddingLookupSparseOptions: [{ name: 'combiner', slot: 0, kind: 'enum', labels: COMBINER }],
    MulOptions: [{ name: 'fused_activation_function', slot: 0, kind: 'enum', labels: ACTIVATION, absent: 0 }],
    GatherOptions: [
        { name: 'axis', slot: 0, kind: 'int', absent: 0 }, { name: 'batch_dims', slot: 1, kind: 'int', absent: 0 }
    ],
    ReducerOptions: [{ name: 'keep_dims', slot: 0, kind: 'bool', absent: false }],
    SubOptions: [
        { name: 'fused_activation_function', slot: 0, kind: 'enum', labels: ACTIVATION, absent: 0 },
        { name: 'pot_scale_int16', slot: 1, kind: 'bool', absent: true }
    ],
    DivOptions: [{ name: 'fused_activation_function', slot: 0, kind: 'enum', labels: ACTIVATION, absent: 0 }],
    SqueezeOptions: [{ name: 'squeeze_dims', slot: 0, kind: 'ints' }],
    SequenceRNNOptions: [
        { name: 'time_major', slot: 0, kind: 'bool', absent: false },
        { name: 'fused_activation_function', slot: 1, kind: 'enum', labels: ACTIVATION, absent: 0 },
        { name: 'asymmetric_quantize_inputs', slot: 2, kind: 'bool', absent: false }
    ],
    StridedSliceOptions: [
        { name: 'begin_mask', slot: 0, kind: 'int', absent: 0 }, { name: 'end_mask', slot: 1, kind: 'int', absent: 0 },
        { name: 'ellipsis_mask', slot: 2, kind: 'int', absent: 0 }, { name: 'new_axis_mask', slot: 3, kind: 'int', absent: 0 },
        { name: 'shrink_axis_mask', slot: 4, kind: 'int', absent: 0 },
        { name: 'offset', slot: 5, kind: 'bool', absent: false }
    ],
    SplitOptions: [{ name: 'num_splits', slot: 0, kind: 'int' }],
    SplitVOptions: [{ name: 'num_splits', slot: 0, kind: 'int' }],
    CastOptions: [
        { name: 'in_data_type', slot: 0, kind: 'enum', labels: TENSOR_TYPES },
        { name: 'out_data_type', slot: 1, kind: 'enum', labels: TENSOR_TYPES }
    ],
    ArgMaxOptions: [{ name: 'output_type', slot: 0, kind: 'enum', labels: TENSOR_TYPES }],
    ArgMinOptions: [{ name: 'output_type', slot: 0, kind: 'enum', labels: TENSOR_TYPES }],
    TransposeConvOptions: [
        { name: 'padding', slot: 0, kind: 'enum', labels: PADDING },
        { name: 'stride_w', slot: 1, kind: 'int' }, { name: 'stride_h', slot: 2, kind: 'int' },
        { name: 'fused_activation_function', slot: 3, kind: 'enum', labels: ACTIVATION, absent: 0 },
        { name: 'quantized_bias_type', slot: 4, kind: 'enum', labels: TENSOR_TYPES, absent: 0 }
    ],
    SparseToDenseOptions: [{ name: 'validate_indices', slot: 0, kind: 'bool', absent: false }],
    ShapeOptions: [{ name: 'out_type', slot: 0, kind: 'enum', labels: TENSOR_TYPES }],
    FakeQuantOptions: [
        { name: 'min', slot: 0, kind: 'float' }, { name: 'max', slot: 1, kind: 'float' },
        { name: 'num_bits', slot: 2, kind: 'int' },
        { name: 'narrow_range', slot: 3, kind: 'bool', absent: false }
    ],
    PackOptions: [{ name: 'values_count', slot: 0, kind: 'int' }, { name: 'axis', slot: 1, kind: 'int' }],
    OneHotOptions: [{ name: 'axis', slot: 0, kind: 'int' }],
    UnpackOptions: [{ name: 'num', slot: 0, kind: 'int' }, { name: 'axis', slot: 1, kind: 'int' }],
    BidirectionalSequenceLSTMOptions: [
        { name: 'fused_activation_function', slot: 0, kind: 'enum', labels: ACTIVATION, absent: 0 },
        { name: 'cell_clip', slot: 1, kind: 'float', absent: 0 },
        { name: 'proj_clip', slot: 2, kind: 'float', absent: 0 },
        { name: 'merge_outputs', slot: 3, kind: 'bool', absent: false },
        { name: 'time_major', slot: 4, kind: 'bool' },
        { name: 'asymmetric_quantize_inputs', slot: 5, kind: 'bool', absent: false }
    ],
    BidirectionalSequenceRNNOptions: [
        { name: 'time_major', slot: 0, kind: 'bool', absent: false },
        { name: 'fused_activation_function', slot: 1, kind: 'enum', labels: ACTIVATION, absent: 0 },
        { name: 'merge_outputs', slot: 2, kind: 'bool', absent: false },
        { name: 'asymmetric_quantize_inputs', slot: 3, kind: 'bool', absent: false }
    ],
    UnidirectionalSequenceLSTMOptions: [
        { name: 'fused_activation_function', slot: 0, kind: 'enum', labels: ACTIVATION, absent: 0 },
        { name: 'cell_clip', slot: 1, kind: 'float', absent: 0 },
        { name: 'proj_clip', slot: 2, kind: 'float', absent: 0 },
        { name: 'time_major', slot: 3, kind: 'bool', absent: false },
        { name: 'asymmetric_quantize_inputs', slot: 4, kind: 'bool', absent: false },
        { name: 'diagonal_recurrent_tensors', slot: 5, kind: 'bool', absent: false }
    ],
    RangeOptions: [],
    ResizeNearestNeighborOptions: [
        { name: 'align_corners', slot: 0, kind: 'bool', absent: false },
        { name: 'half_pixel_centers', slot: 1, kind: 'bool', absent: false }
    ],
    LeakyReluOptions: [{ name: 'alpha', slot: 0, kind: 'float' }],
    MirrorPadOptions: [{ name: 'mode', slot: 0, kind: 'enum', labels: MIRROR_PAD }],
    UniqueOptions: [{ name: 'idx_out_type', slot: 0, kind: 'enum', labels: TENSOR_TYPES }],
    ReverseSequenceOptions: [
        { name: 'seq_dim', slot: 0, kind: 'int' }, { name: 'batch_dim', slot: 1, kind: 'int', absent: 0 }
    ],
    IfOptions: [
        { name: 'then_subgraph_index', slot: 0, kind: 'int', subgraph: true },
        { name: 'else_subgraph_index', slot: 1, kind: 'int', subgraph: true }
    ],
    WhileOptions: [
        { name: 'cond_subgraph_index', slot: 0, kind: 'int', subgraph: true },
        { name: 'body_subgraph_index', slot: 1, kind: 'int', subgraph: true }
    ],
    CallOnceOptions: [{ name: 'init_subgraph_index', slot: 0, kind: 'int', subgraph: true }],
    BatchMatMulOptions: [
        { name: 'adj_x', slot: 0, kind: 'bool', absent: false }, { name: 'adj_y', slot: 1, kind: 'bool', absent: false },
        { name: 'asymmetric_quantize_inputs', slot: 2, kind: 'bool', absent: false }
    ],
    CumsumOptions: [
        { name: 'exclusive', slot: 0, kind: 'bool', absent: false },
        { name: 'reverse', slot: 1, kind: 'bool', absent: false }
    ],
    Conv3DOptions: [
        { name: 'padding', slot: 0, kind: 'enum', labels: PADDING },
        { name: 'stride_d', slot: 1, kind: 'int' }, { name: 'stride_w', slot: 2, kind: 'int' },
        { name: 'stride_h', slot: 3, kind: 'int' },
        { name: 'fused_activation_function', slot: 4, kind: 'enum', labels: ACTIVATION, absent: 0 },
        { name: 'dilation_d_factor', slot: 5, kind: 'int', absent: 1 },
        { name: 'dilation_w_factor', slot: 6, kind: 'int', absent: 1 },
        { name: 'dilation_h_factor', slot: 7, kind: 'int', absent: 1 }
    ],
    HashtableOptions: [
        { name: 'table_id', slot: 0, kind: 'int' },
        { name: 'key_dtype', slot: 1, kind: 'enum', labels: TENSOR_TYPES },
        { name: 'value_dtype', slot: 2, kind: 'enum', labels: TENSOR_TYPES }
    ],
    VarHandleOptions: [
        { name: 'container', slot: 0, kind: 'string' }, { name: 'shared_name', slot: 1, kind: 'string' }
    ],
    RandomOptions: [{ name: 'seed', slot: 0, kind: 'long', absent: 0 }, { name: 'seed2', slot: 1, kind: 'long', absent: 0 }],
    BucketizeOptions: [{ name: 'boundaries', slot: 0, kind: 'floats' }],
    GeluOptions: [{ name: 'approximate', slot: 0, kind: 'bool', absent: false }],
    StableHLOCompositeOptions: [
        { name: 'name', slot: 0, kind: 'string' },
        { name: 'decomposition_subgraph_index', slot: 1, kind: 'int', subgraph: true },
        { name: 'version', slot: 4, kind: 'int', absent: 0 }
    ],
    StablehloConcatenateOptions: [{ name: 'dimension', slot: 0, kind: 'long' }],
    StablehloSliceOptions: [
        { name: 'start_indices', slot: 0, kind: 'longs' }, { name: 'limit_indices', slot: 1, kind: 'longs' },
        { name: 'strides', slot: 2, kind: 'longs' }
    ],
    StablehloIotaOptions: [{ name: 'iota_dimension', slot: 0, kind: 'long' }],
    StablehloTransposeOptions: [{ name: 'permutation', slot: 0, kind: 'longs' }],
    DilateOptions: []
};

interface ParseState { objects: number; textBytes: number; items: number }

interface BufferRecord {
    /** Absolute position of the inline payload, `0` when there is none. */
    dataStart: number;
    dataLength: number;
    size: bigint;
    offset: bigint;
}

class FlatBufferReader {
    private readonly view: DataView;

    constructor(readonly bytes: Uint8Array, readonly state: ParseState) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    require(offset: number, size: number): void {
        if (!Number.isSafeInteger(offset) || offset < 0 || size < 0 || offset + size > this.bytes.byteLength) {
            throw new TfliteParseError('TFLite FlatBuffer offset is out of range.');
        }
    }

    claimObject(): void {
        if (++this.state.objects > MAX_OBJECTS) throw new TfliteParseError('TFLite normalized-object limit exceeded.');
    }

    /**
     * Charge decoded vector elements against a whole-file budget. Per-vector
     * caps alone are not enough: FlatBuffers lets many tables share one vector
     * offset, so a small file can otherwise ask for tables × elements values.
     */
    claimItems(count: number): void {
        this.state.items += count;
        if (this.state.items > MAX_TOTAL_ITEMS) throw new TfliteParseError('TFLite decoded-element limit exceeded.');
    }

    i8(offset: number): number { this.require(offset, 1); return this.view.getInt8(offset); }
    u8(offset: number): number { this.require(offset, 1); return this.view.getUint8(offset); }
    u16(offset: number): number { this.require(offset, 2); return this.view.getUint16(offset, true); }
    i32(offset: number): number { this.require(offset, 4); return this.view.getInt32(offset, true); }
    u32(offset: number): number { this.require(offset, 4); return this.view.getUint32(offset, true); }
    i64(offset: number): bigint { this.require(offset, 8); return this.view.getBigInt64(offset, true); }
    u64(offset: number): bigint { this.require(offset, 8); return this.view.getBigUint64(offset, true); }
    f32(offset: number): number { this.require(offset, 4); return this.view.getFloat32(offset, true); }

    /** Follow a uoffset stored at `offset` to the object it points at. */
    indirect(offset: number): number {
        const target = offset + this.u32(offset);
        this.require(target, 0);
        return target;
    }

    text(start: number, length: number): string {
        if (length > MAX_TEXT_BYTES) throw new TfliteParseError('TFLite text field exceeds the per-field limit.');
        this.state.textBytes += length;
        if (this.state.textBytes > MAX_TOTAL_TEXT_BYTES) throw new TfliteParseError('TFLite cumulative text limit exceeded.');
        this.require(start, length);
        return decoder.decode(this.bytes.subarray(start, start + length));
    }
}

/** One FlatBuffers table: a vtable lookup plus bounds-checked field accessors. */
class Table {
    private readonly vtable: number;
    private readonly vtableBytes: number;

    constructor(readonly fb: FlatBufferReader, readonly pos: number, readonly depth: number) {
        if (depth > MAX_DEPTH) throw new TfliteParseError('TFLite FlatBuffer nesting is too deep.');
        fb.claimObject();
        const vtable = pos - fb.i32(pos);
        if (vtable < 0) throw new TfliteParseError('TFLite table points at an invalid vtable.');
        this.vtable = vtable;
        this.vtableBytes = fb.u16(vtable);
        if (this.vtableBytes < 4) throw new TfliteParseError('TFLite vtable is too short.');
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

    float(slot: number, fallback = 0): number {
        const at = this.field(slot);
        return at ? this.fb.f32(at) : fallback;
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
     * No item cap here: a weight `Buffer` is a byte vector whose length is the
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
        if (vector.length > limit) throw new TfliteParseError('TFLite vector item limit exceeded.');
        this.fb.claimItems(vector.length);
        const values: number[] = [];
        for (let index = 0; index < vector.length; index++) values.push(this.fb.i32(vector.start + index * 4));
        return values;
    }

    /** Display-only int vector, truncated at `limit` instead of rejected. */
    intVectorPreview(slot: number, limit: number): number[] {
        const vector = this.vector(slot, 4);
        if (!vector) return [];
        this.fb.claimItems(Math.min(vector.length, limit));
        const values: number[] = [];
        for (let index = 0; index < Math.min(vector.length, limit); index++) values.push(this.fb.i32(vector.start + index * 4));
        return values;
    }

    floatVector(slot: number, limit = MAX_ITEMS): { values: number[]; truncated: boolean } {
        const vector = this.vector(slot, 4);
        if (!vector) return { values: [], truncated: false };
        this.fb.claimItems(Math.min(vector.length, limit));
        const values: number[] = [];
        for (let index = 0; index < Math.min(vector.length, limit); index++) values.push(this.fb.f32(vector.start + index * 4));
        return { values, truncated: vector.length > limit };
    }

    longVector(slot: number, limit = MAX_ITEMS): { values: string[]; truncated: boolean } {
        const vector = this.vector(slot, 8);
        if (!vector) return { values: [], truncated: false };
        this.fb.claimItems(Math.min(vector.length, limit));
        const values: string[] = [];
        for (let index = 0; index < Math.min(vector.length, limit); index++) values.push(this.fb.i64(vector.start + index * 8).toString());
        return { values, truncated: vector.length > limit };
    }

    /** Byte-vector extent without copying the payload. */
    byteVector(slot: number): { start: number; length: number } | undefined {
        return this.vector(slot, 1);
    }

    tableVector(slot: number): Table[] {
        const vector = this.vector(slot, 4);
        if (!vector) return [];
        if (vector.length > MAX_ITEMS) throw new TfliteParseError('TFLite vector item limit exceeded.');
        this.fb.claimItems(vector.length);
        const tables: Table[] = [];
        for (let index = 0; index < vector.length; index++) {
            const at = vector.start + index * 4;
            tables.push(new Table(this.fb, this.fb.indirect(at), this.depth + 1));
        }
        return tables;
    }
}

/** Parse a TFLite / LiteRT model without decoding buffer payloads. */
export function parseTflite(data: Uint8Array): TfliteDocument {
    if (data.byteLength < 8) throw new TfliteParseError('The file is too small to be a TFLite model.');
    const fb = new FlatBufferReader(data, { objects: 0, textBytes: 0, items: 0 });
    const identifier = readIdentifier(data);
    const rootOffset = fb.u32(0);
    if (rootOffset < 4 || rootOffset >= data.byteLength) throw new TfliteParseError('The TFLite root table offset is out of range.');
    const model = new Table(fb, rootOffset, 0);

    const version = model.uint(0);
    const operatorCodes = model.tableVector(1).map(parseOperatorCode);
    const description = model.string(3);
    const bufferRecords = model.tableVector(4).map(parseBufferRecord);
    const buffers = bufferRecords.map((record, index) => toBuffer(record, index));
    const metadataBuffers = model.intVector(5);
    const subgraphs = model.tableVector(2).map((table, index) => parseSubgraph(table, index, operatorCodes, bufferRecords));
    const metadata = model.tableVector(6).map(table => parseMetadata(table, fb, bufferRecords));
    const signatures = model.tableVector(7).map(table => parseSignature(table, subgraphs));

    const primary = subgraphs[0];
    const operatorCount = subgraphs.reduce((total, subgraph) => total + subgraph.operators.length, 0);
    const tensorCount = subgraphs.reduce((total, subgraph) => total + subgraph.tensors.length, 0);
    const weightBytes = bufferRecords.reduce((total, record) => total + record.size, 0n);
    const customOperators = new Set<string>();
    const flexOperators = new Set<string>();
    for (const code of operatorCodes) {
        if (!code.custom) continue;
        if (code.customCode.startsWith('Flex')) flexOperators.add(code.name);
        else customOperators.add(code.name);
    }

    const warnings: TfliteWarning[] = [];
    if (identifier !== FILE_IDENTIFIER) warnings.push({ key: 'tflite.warning.identifier', args: { identifier: identifier || '—' } });
    if (version !== 3) warnings.push({ key: 'tflite.warning.version', args: { version } });
    if (subgraphs.length === 0) warnings.push({ key: 'tflite.warning.noSubgraphs' });
    else if (operatorCount === 0) warnings.push({ key: 'tflite.warning.emptyGraph' });
    if (customOperators.size > 0) warnings.push({ key: 'tflite.warning.customOps', args: { count: customOperators.size, names: preview([...customOperators], 8) } });
    if (flexOperators.size > 0) warnings.push({ key: 'tflite.warning.flexOps', args: { count: flexOperators.size } });
    const appended = bufferRecords.filter(record => record.offset > 1n).length;
    if (appended > 0) warnings.push({ key: 'tflite.warning.appendedBuffers', args: { count: appended } });

    return {
        format: 'tflite',
        title: primary?.name || description,
        fileSize: formatFileSize(data.byteLength),
        version: String(version),
        identifier,
        description,
        minRuntimeVersion: metadata.find(item => item.name === 'min_runtime_version')?.text ?? '',
        subgraphs,
        operatorCodes,
        buffers,
        metadata,
        metadataBuffers,
        signatures,
        weightBytes: weightBytes.toString(),
        summary: [
            { labelKey: 'tflite.summary.operators', value: operatorCount },
            { labelKey: 'tflite.summary.tensors', value: tensorCount },
            { labelKey: 'tflite.summary.subgraphs', value: subgraphs.length },
            { labelKey: 'tflite.summary.operatorCodes', value: operatorCodes.length },
            { labelKey: 'tflite.summary.weights', value: formatFileSize(weightBytes) },
            { labelKey: 'tflite.summary.version', value: version }
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

function parseOperatorCode(table: Table, index: number): TfliteOperatorCode {
    // Codes below the placeholder live in the legacy byte field; from the
    // placeholder up they are written to `builtin_code` instead, so the
    // effective code is the larger of the two (schema.fbs `GetBuiltinCode`).
    const deprecated = table.byte(0);
    const declared = table.int(3);
    const builtinCode = declared >= PLACEHOLDER_OPERATOR_CODE
        ? declared
        : Math.max(deprecated < 0 ? 0 : deprecated, declared);
    const customCode = table.string(1);
    const custom = builtinCode === CUSTOM_OPERATOR_CODE;
    const name = custom
        ? customCode || 'CUSTOM'
        : BUILTIN_OPERATORS[builtinCode] ?? `OP_${builtinCode}`;
    return { index, builtinCode, name, customCode, version: table.int(2, 1), custom };
}

function parseBufferRecord(table: Table): BufferRecord {
    const data = table.byteVector(0);
    const offset = table.ulong(1);
    const size = table.ulong(2);
    return {
        dataStart: data?.start ?? 0,
        dataLength: data?.length ?? 0,
        // An offset above 1 means the payload sits outside the FlatBuffer, and
        // then `size` — not the inline vector — carries its length.
        size: offset > 1n ? size : BigInt(data?.length ?? 0),
        offset
    };
}

function toBuffer(record: BufferRecord, index: number): TfliteBuffer {
    return { index, size: record.size.toString(), offset: record.offset.toString(), location: bufferLocation(record) };
}

function bufferLocation(record: BufferRecord | undefined): TfliteBufferLocation {
    if (!record) return 'empty';
    if (record.offset > 1n) return 'appended';
    return record.dataLength > 0 ? 'inline' : 'empty';
}

function parseSubgraph(
    table: Table,
    index: number,
    operatorCodes: TfliteOperatorCode[],
    buffers: BufferRecord[]
): TfliteSubgraph {
    const tensors = table.tableVector(0).map((tensor, tensorIndex) => parseTensor(tensor, tensorIndex, buffers));
    const operators = table.tableVector(3).map((operator, operatorIndex) => parseOperator(operator, operatorIndex, index, operatorCodes));
    return {
        index,
        name: table.string(4),
        tensors,
        operators,
        inputs: table.intVector(1),
        outputs: table.intVector(2)
    };
}

function parseTensor(table: Table, index: number, buffers: BufferRecord[]): TfliteTensor {
    const shape = table.intVector(0, MAX_TENSOR_RANK);
    const type = table.byte(1);
    const buffer = table.uint(2);
    const record = buffers[buffer];
    const elementCount = tensorElementCount(shape);
    const bits = TYPE_BITS[type] ?? 0;
    const quantization = table.table(4);
    const sparsity = table.table(6);
    return {
        index,
        name: table.string(3),
        type: TENSOR_TYPES[type] ?? `TYPE_${type}`,
        shape,
        shapeSignature: table.intVector(7, MAX_TENSOR_RANK),
        buffer,
        location: bufferLocation(record),
        dataBytes: (record?.size ?? 0n).toString(),
        expectedBytes: bits ? ((elementCount * BigInt(bits) + 7n) / 8n).toString() : '0',
        elementCount: elementCount.toString(),
        isVariable: table.bool(5),
        // `has_rank` postdates the format, so pre-2022 models leave it unset
        // while still carrying a real shape. Taking the schema's `false`
        // default literally would claim an unknown rank for every such model,
        // so a stored shape is treated as evidence of a known rank. Only a
        // shapeless tensor with the flag unset is reported as unranked.
        hasRank: table.bool(8, shape.length > 0),
        ...(quantization ? { quantization: parseQuantization(quantization) } : {}),
        ...(sparsity ? { sparsity: parseSparsity(sparsity) } : {})
    };
}

function parseQuantization(table: Table): TfliteQuantization {
    const min = table.floatVector(0, MAX_QUANTIZATION_ITEMS);
    const max = table.floatVector(1, MAX_QUANTIZATION_ITEMS);
    const scale = table.floatVector(2, MAX_QUANTIZATION_ITEMS);
    const zeroPoint = table.longVector(3, MAX_QUANTIZATION_ITEMS);
    const detailsType = QUANTIZATION_DETAILS[table.byte(4)] ?? `DETAILS_${table.byte(4)}`;
    const quantizedDimension = table.int(6);
    const truncated = min.truncated || max.truncated || scale.truncated || zeroPoint.truncated;
    return {
        scale: scale.values,
        zeroPoint: zeroPoint.values,
        min: min.values,
        max: max.values,
        quantizedDimension,
        detailsType,
        truncated,
        summary: quantizationSummary(scale.values, zeroPoint.values, min.values, max.values, quantizedDimension, truncated)
    };
}

function quantizationSummary(
    scale: number[],
    zeroPoint: string[],
    min: number[],
    max: number[],
    quantizedDimension: number,
    truncated: boolean
): string {
    if (scale.length > 1 || truncated) {
        return `per-axis[${quantizedDimension}] × ${truncated ? `${scale.length}+` : scale.length}`;
    }
    if (scale.length === 1) return `scale=${formatNumber(scale[0]!)} · zero=${zeroPoint[0] ?? '0'}`;
    if (min.length && max.length) return `range=[${formatNumber(min[0]!)}, ${formatNumber(max[0]!)}]`;
    return '';
}

function parseSparsity(table: Table): TfliteSparsity {
    const dimensionTables = table.tableVector(2);
    return {
        traversalOrder: table.intVectorPreview(0, MAX_SPARSITY_ITEMS),
        blockMap: table.intVectorPreview(1, MAX_SPARSITY_ITEMS),
        truncated: dimensionTables.length > MAX_SPARSITY_ITEMS,
        dimensions: dimensionTables.slice(0, MAX_SPARSITY_ITEMS).map(dimension => {
            const format = dimension.byte(0);
            const segments = readSparseVector(dimension.table(3), dimension.byte(2));
            const indices = readSparseVector(dimension.table(5), dimension.byte(4));
            return {
                format: DIMENSION_TYPES[format] ?? `FORMAT_${format}`,
                denseSize: dimension.int(1),
                arraySegments: segments.values,
                arrayIndices: indices.values,
                truncated: segments.truncated || indices.truncated
            };
        })
    };
}

/**
 * `array_segments` / `array_indices` are unions over Int32/Uint16/Uint8 vectors;
 * the union type selects which vector table to read. Index runs are long, so
 * these are previews and report whether anything was dropped.
 */
function readSparseVector(table: Table | undefined, unionType: number): { values: number[]; truncated: boolean } {
    if (!table) return { values: [], truncated: false };
    const size = unionType === 1 ? 4 : unionType === 2 ? 2 : 1;
    const vector = table.vector(0, size);
    if (!vector) return { values: [], truncated: false };
    const shown = Math.min(vector.length, MAX_SPARSITY_ITEMS);
    table.fb.claimItems(shown);
    const values: number[] = [];
    for (let index = 0; index < shown; index++) {
        values.push(size === 4 ? table.fb.i32(vector.start + index * 4)
            : size === 2 ? table.fb.u16(vector.start + index * 2)
                : table.fb.u8(vector.start + index));
    }
    return { values, truncated: vector.length > shown };
}

function parseOperator(table: Table, index: number, subgraphIndex: number, operatorCodes: TfliteOperatorCode[]): TfliteOperator {
    const opcodeIndex = table.uint(0);
    const code = operatorCodes[opcodeIndex];
    const optionsType = table.byte(3);
    const options2Type = table.byte(11);
    const optionsName = optionsType
        ? BUILTIN_OPTIONS[optionsType] ?? `Options_${optionsType}`
        : options2Type ? BUILTIN_OPTIONS_2[options2Type] ?? `Options2_${options2Type}` : '';
    const optionsTable = optionsType ? table.table(4) : options2Type ? table.table(12) : undefined;
    const decoded = optionsTable ? decodeOptions(optionsName, optionsTable) : { options: [], subgraphRefs: [] };
    const customOptions = table.byteVector(5);
    const largeCustomSize = table.ulong(10);
    return {
        id: `op-${subgraphIndex}-${index}`,
        index,
        opcodeIndex,
        operator: code?.name ?? `OPCODE_${opcodeIndex}`,
        custom: code?.custom ?? false,
        version: code?.version ?? 0,
        inputs: table.intVector(1),
        outputs: table.intVector(2),
        intermediates: table.intVector(8),
        optionsType: optionsName,
        options: decoded.options,
        customOptionsBytes: (largeCustomSize > 0n ? largeCustomSize : BigInt(customOptions?.length ?? 0)).toString(),
        customOptionsFormat: CUSTOM_OPTIONS_FORMAT[table.byte(6)] ?? `FORMAT_${table.byte(6)}`,
        subgraphRefs: decoded.subgraphRefs
    };
}

function decodeOptions(name: string, table: Table): { options: TfliteAttribute[]; subgraphRefs: number[] } {
    const fields = OPTION_FIELDS[name];
    if (!fields) return { options: [], subgraphRefs: [] };
    const options: TfliteAttribute[] = [];
    const subgraphRefs: number[] = [];
    for (const field of fields) {
        const at = table.field(field.slot);
        if (!at) continue;
        const raw = readOptionValue(table, field);
        if (raw === undefined) continue;
        if (field.subgraph && typeof raw === 'number' && raw >= 0) subgraphRefs.push(raw);
        if (raw === field.absent) continue;
        options.push({ name: field.name, value: formatOptionValue(raw, field) });
    }
    return { options, subgraphRefs };
}

type OptionValue = number | boolean | string | number[];

function readOptionValue(table: Table, field: OptionField): OptionValue | undefined {
    switch (field.kind) {
        case 'bool': return table.bool(field.slot);
        case 'enum': return table.byte(field.slot);
        case 'int': return table.int(field.slot);
        case 'uint': return table.uint(field.slot);
        case 'long': return Number(table.long(field.slot));
        case 'float': return table.float(field.slot);
        case 'string': return table.string(field.slot);
        case 'ints': return table.intVectorPreview(field.slot, MAX_OPTION_ITEMS);
        case 'longs': return `[${table.longVector(field.slot, MAX_OPTION_ITEMS).values.join(', ')}]`;
        case 'floats': return table.floatVector(field.slot, MAX_OPTION_ITEMS).values;
        default: return undefined;
    }
}

function formatOptionValue(value: OptionValue, field: OptionField): string {
    if (Array.isArray(value)) return `[${value.map(item => formatNumber(item)).join(', ')}]`;
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'string') return value;
    if (field.labels) return field.labels[value] ?? String(value);
    return formatNumber(value);
}

function parseMetadata(table: Table, fb: FlatBufferReader, buffers: BufferRecord[]): TfliteMetadataEntry {
    const buffer = table.uint(1);
    const record = buffers[buffer];
    return {
        name: table.string(0),
        buffer,
        size: (record?.size ?? 0n).toString(),
        text: decodeMetadataText(fb, record)
    };
}

/** Metadata buffers hold either short text (e.g. a runtime version) or a nested
 *  FlatBuffer; only the former is worth surfacing verbatim. */
function decodeMetadataText(fb: FlatBufferReader, record: BufferRecord | undefined): string {
    if (!record || record.dataLength === 0 || record.dataLength > MAX_METADATA_TEXT_BYTES) return '';
    const bytes = fb.bytes.subarray(record.dataStart, record.dataStart + record.dataLength);
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    for (let index = 0; index < end; index++) {
        const byte = bytes[index]!;
        if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return '';
        if (byte === 0x7f) return '';
    }
    return end === 0 ? '' : fb.text(record.dataStart, end);
}

function parseSignature(table: Table, subgraphs: TfliteSubgraph[]): TfliteSignature {
    const subgraphIndex = table.uint(4);
    const tensors = subgraphs[subgraphIndex]?.tensors ?? [];
    const map = (slot: number): TfliteTensorMap[] => table.tableVector(slot).map(entry => {
        const tensorIndex = entry.uint(1);
        return { name: entry.string(0), tensorIndex, tensorName: tensors[tensorIndex]?.name ?? '' };
    });
    return { key: table.string(2), subgraphIndex, inputs: map(0), outputs: map(1) };
}

/**
 * Element count, or 0 when the shape cannot yield one. A negative dimension is
 * invalid in `shape` (unknown dims belong in `shape_signature`) and an absurd
 * product means a corrupt table, but this count only feeds display columns, so
 * one odd tensor degrades to "unknown" rather than making the model unviewable.
 */
function tensorElementCount(shape: number[]): bigint {
    let count = 1n;
    for (const dimension of shape) {
        if (dimension <= 0) return 0n;
        count *= BigInt(dimension);
        if (count.toString(2).length > MAX_TENSOR_PRODUCT_BITS) return 0n;
    }
    return count;
}

function preview(items: string[], limit: number): string {
    return items.length > limit ? `${items.slice(0, limit).join(', ')}, …` : items.join(', ');
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
