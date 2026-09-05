/**
 * Dependency-free Core ML reader for `.mlmodel` specifications and `.mlpackage`
 * archives.
 *
 * A `.mlmodel` file is a serialized `CoreML.Specification.Model` protobuf, and
 * an `.mlpackage` is a bundle whose `Manifest.json` points at one such spec plus
 * the weight blobs its ML Program references. Field numbers follow the normative
 * schemas published with coremltools (`Model.proto`, `FeatureTypes.proto`,
 * `MIL.proto`, `NeuralNetwork.proto`).
 *
 * Weight payloads are never decoded. The viewer needs graph topology, feature
 * types, operator attributes, and storage metadata — so blob references are
 * resolved to a file, an offset, and a byte count, and inline weight tensors to
 * their size and quantization, without materializing a single parameter.
 *
 * Two model families carry a graph, and they answer questions very differently:
 *
 *  - An **ML Program** (`mlProgram`, Core ML 5 and newer) is self-describing, so
 *    operands and attributes are read exactly as the producer wrote them with no
 *    schema knowledge at all. An operation states its payload in two places and
 *    both matter: named operands under `Operation.inputs`, and an
 *    `Operation.attributes` map that a `const` uses for its *entire* value —
 *    which is where every weight an ML Program owns actually lives.
 *  - A **neural network** (the pre-Core ML 5 encoding) puts each layer's
 *    parameters in a distinct message per layer type. Layer *types* are resolved
 *    for all of them from the `oneof layer` field numbers, and attributes are
 *    decoded for the common types listed in `LAYER_SCHEMAS`. Weights need no
 *    such table: `WeightParams` has one shape everywhere it appears, so a
 *    structural scan finds them under any layer, known or not.
 */

export interface CoremlEntry { key: string; value: string }
export interface CoremlWarning { key: string; args?: Record<string, string | number> }
export interface CoremlSummaryItem { labelKey: string; value: string | number }

/** A named model input, output, state, or training input. */
export interface CoremlFeature {
    name: string;
    /** 'image' | 'multiArray' | 'dictionary' | 'sequence' | 'int64' | 'double' |
     *  'string' | 'state' | 'unknown' — the `FeatureType` oneof arm. */
    typeKind: string;
    /** Rendered type, e.g. `image 224 × 224 RGB` or `multiArray FLOAT32[1, 3, 224, 224]`. */
    type: string;
    /** Rendered size/shape flexibility, empty when the feature is fixed. */
    flexibility: string;
    optional: boolean;
    description: string;
    details: CoremlEntry[];
}

/** One prediction interface. Models before Core ML 8 declare exactly one. */
export interface CoremlFunction {
    name: string;
    isDefault: boolean;
    inputs: CoremlFeature[];
    outputs: CoremlFeature[];
    state: CoremlFeature[];
    trainingInputs: CoremlFeature[];
    predictedFeatureName: string;
    predictedProbabilitiesName: string;
}

/** A tensor a node reads from a weight blob or holds inline. */
export interface CoremlWeight {
    /** Parameter name (`weight`, `bias`) or `field {n}` for an unmapped one. */
    name: string;
    dataType: string;
    shape: string[];
    elementCount: string;
    byteLength: string;
    /** 'blob' lives in a weight file; 'inline' is embedded in the spec. */
    storage: 'blob' | 'inline';
    file: string;
    offset: string;
    quantization: string;
    updatable: boolean;
}

/** A named value: a graph input, a block argument, or an operation output. */
export interface CoremlValue { name: string; type: string }

/**
 * One thing an operand is bound to. Whether that is a reference to another
 * value or an inline constant is recorded here rather than inferred from the
 * text later: a neural network names its operands with unconstrained strings,
 * so a name like `123` — what an ONNX conversion produces — is indistinguishable
 * from a numeric literal once the two are flattened together.
 */
export interface CoremlBinding {
    /** A variable name, or a rendered literal value. */
    text: string;
    /** True when `text` names a value some node produces or the graph declares. */
    variable: boolean;
}

/** One operand slot. ML Program operands are named; layer operands are ordered. */
export interface CoremlPort {
    /** Parameter name (`x`, `weight`) — empty for a positional layer operand. */
    name: string;
    values: CoremlBinding[];
}

export interface CoremlNode {
    id: string;
    graphId: string;
    name: string;
    type: string;
    /** 'operation' (ML Program), 'layer' (neural network), 'stage' (pipeline). */
    kind: 'operation' | 'layer' | 'stage';
    /** True for an ML Program `const`, which is how a program holds a constant. */
    constant: boolean;
    /**
     * True when the operation needs a class registered with the runtime. The
     * two encodings spell this differently — a neural network has a `custom`
     * layer, while an ML Program rewrites the op type to `custom_layer` — so
     * the distinction is resolved here rather than by every consumer.
     */
    custom: boolean;
    inputs: CoremlPort[];
    outputs: CoremlValue[];
    attributes: CoremlEntry[];
    weights: CoremlWeight[];
    /** Graph ids this node transfers control into (blocks, branches, stages). */
    graphs: string[];
    updatable: boolean;
    description: string;
}

export type CoremlGraphKind = 'program' | 'block' | 'network' | 'pipeline';

export interface CoremlGraph {
    id: string;
    name: string;
    kind: CoremlGraphKind;
    /** MIL opset (`CoreML7`) or the neural network's shape-mapping mode. */
    opset: string;
    parentId: string;
    /** Nesting level, so a picker can indent a block under its function. */
    depth: number;
    inputs: CoremlValue[];
    outputs: string[];
    nodes: CoremlNode[];
    description: string;
}

/** One `Manifest.json` item of an `.mlpackage`. */
export interface CoremlPackageItem {
    identifier: string;
    name: string;
    path: string;
    author: string;
    description: string;
    /** Bytes the archive holds for this item; a directory sums its members. */
    byteLength: string;
    isRoot: boolean;
}

export interface CoremlPackage {
    formatVersion: string;
    rootIdentifier: string;
    /** Archive path of the spec that was parsed. */
    modelPath: string;
    items: CoremlPackageItem[];
    files: Array<{ name: string; byteLength: string; method: string }>;
}

/** A weight blob an ML Program reads its constants from. */
export interface CoremlWeightFile {
    /** Name as the program spells it, e.g. `@model_path/weights/weight.bin`. */
    name: string;
    referenceCount: number;
    /** Sum of the referenced tensors' byte lengths. */
    referencedBytes: string;
    /** Archive size when the package carries the file; empty when it does not. */
    byteLength: string;
    present: boolean;
}

export interface CoremlDocument {
    format: 'coreml';
    /** Model-level short description, or the model type when it has none. */
    title: string;
    fileSize: string;
    /** True when the spec was read out of an `.mlpackage` archive. */
    packaged: boolean;
    specificationVersion: number;
    /** `iOS 17 · macOS 14 (Core ML 7)`, or an empty string for a future version. */
    availability: string;
    /** The `oneof Type` arm, e.g. `mlProgram`. */
    modelType: string;
    isUpdatable: boolean;
    shortDescription: string;
    versionString: string;
    author: string;
    license: string;
    userDefined: CoremlEntry[];
    functions: CoremlFunction[];
    defaultFunctionName: string;
    graphs: CoremlGraph[];
    classLabels: { kind: 'string' | 'int64' | ''; values: string[]; total: number };
    weightFiles: CoremlWeightFile[];
    package?: CoremlPackage;
    summary: CoremlSummaryItem[];
    warnings: CoremlWarning[];
}

export class CoremlParseError extends Error {
    override readonly name = 'CoremlParseError';
}

export interface CoremlParseOptions {
    signal?: AbortSignal;
}

const MAX_DEPTH = 64;
const MAX_FIELDS = 4_000_000;
const MAX_ITEMS = 100_000;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_TOTAL_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_NORMALIZED_OBJECTS = 200_000;
const MAX_GRAPHS = 1024;
const MAX_TENSOR_RANK = 1024;
const MAX_TENSOR_PRODUCT_BITS = 4096;
const MAX_PROTO_FIELD_NUMBER = 0x1fffffff;
/** Literal elements rendered for one operand before the rest are summarized. */
const MAX_LITERAL_ITEMS = 16;
/** Class labels retained; the full count is reported alongside. */
const MAX_CLASS_LABELS = 4096;
/** Weight tensors collected under one layer by the structural scan. */
const MAX_LAYER_WEIGHTS = 64;
/** Depth the structural weight scan descends into a layer's parameters. */
const MAX_WEIGHT_SCAN_DEPTH = 3;
/** Pipeline nesting; a pipeline of pipelines is legal but rare. */
const MAX_PIPELINE_DEPTH = 8;
const MAX_ZIP_ENTRIES = 4096;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

const decoder = new TextDecoder('utf-8', { fatal: false });

/** `specificationVersion` → OS availability, per the Model.proto version log. */
const AVAILABILITY: Record<number, string> = {
    1: 'iOS 11 · macOS 10.13 (Core ML 1)',
    2: 'iOS 11.2 · macOS 10.13.2 (Core ML 1.2)',
    3: 'iOS 12 · macOS 10.14 (Core ML 2)',
    4: 'iOS 13 · macOS 10.15 (Core ML 3)',
    5: 'iOS 14 · macOS 11 (Core ML 4)',
    6: 'iOS 15 · macOS 12 (Core ML 5)',
    7: 'iOS 16 · macOS 13 (Core ML 6)',
    8: 'iOS 17 · macOS 14 (Core ML 7)',
    9: 'iOS 18 · macOS 15 (Core ML 8)',
    10: 'iOS 26 · macOS 26 (Core ML 9)'
};

/** `Model.oneof Type` field number → arm name. */
const MODEL_TYPES: Record<number, string> = {
    200: 'pipelineClassifier', 201: 'pipelineRegressor', 202: 'pipeline',
    300: 'glmRegressor', 301: 'supportVectorRegressor', 302: 'treeEnsembleRegressor',
    303: 'neuralNetworkRegressor', 304: 'bayesianProbitRegressor',
    400: 'glmClassifier', 401: 'supportVectorClassifier', 402: 'treeEnsembleClassifier',
    403: 'neuralNetworkClassifier', 404: 'kNearestNeighborsClassifier',
    500: 'neuralNetwork', 501: 'itemSimilarityRecommender', 502: 'mlProgram',
    555: 'customModel', 556: 'linkedModel', 560: 'classConfidenceThresholding',
    600: 'oneHotEncoder', 601: 'imputer', 602: 'featureVectorizer', 603: 'dictVectorizer',
    604: 'scaler', 606: 'categoricalMapping', 607: 'normalizer',
    609: 'arrayFeatureExtractor', 610: 'nonMaximumSuppression', 900: 'identity',
    2000: 'textClassifier', 2001: 'wordTagger', 2002: 'visionFeaturePrint',
    2003: 'soundAnalysisPreprocessing', 2004: 'gazetteer', 2005: 'wordEmbedding',
    2006: 'audioFeaturePrint', 3000: 'serializedModel'
};

const NEURAL_NETWORK_TYPES = new Set([500, 303, 403]);
const PIPELINE_TYPES = new Set([200, 201, 202]);
/** Classifiers that declare `oneof ClassLabels` at fields 100/101. */
const VECTOR_CLASSIFIER_TYPES = new Set([400, 401, 402, 404]);

/** `NeuralNetworkLayer.oneof layer` field number → layer type name. */
const LAYER_TYPES: Record<number, string> = {
    100: 'convolution', 120: 'pooling', 130: 'activation', 140: 'innerProduct',
    150: 'embedding', 160: 'batchnorm', 165: 'mvn', 170: 'l2normalize', 175: 'softmax',
    180: 'lrn', 190: 'crop', 200: 'padding', 210: 'upsample', 211: 'resizeBilinear',
    212: 'cropResize', 220: 'unary', 230: 'add', 231: 'multiply', 240: 'average',
    245: 'scale', 250: 'bias', 260: 'max', 261: 'min', 270: 'dot', 280: 'reduce',
    290: 'loadConstant', 300: 'reshape', 301: 'flatten', 310: 'permute', 320: 'concat',
    330: 'split', 340: 'sequenceRepeat', 345: 'reorganizeData', 350: 'slice',
    400: 'simpleRecurrent', 410: 'gru', 420: 'uniDirectionalLSTM', 430: 'biDirectionalLSTM',
    500: 'custom', 600: 'copy', 605: 'branch', 615: 'loop', 620: 'loopBreak',
    625: 'loopContinue', 635: 'rangeStatic', 640: 'rangeDynamic', 660: 'clip', 665: 'ceil',
    670: 'floor', 680: 'sign', 685: 'round', 700: 'exp2', 710: 'sin', 715: 'cos', 720: 'tan',
    730: 'asin', 735: 'acos', 740: 'atan', 750: 'sinh', 755: 'cosh', 760: 'tanh',
    770: 'asinh', 775: 'acosh', 780: 'atanh', 790: 'erf', 795: 'gelu', 815: 'equal',
    820: 'notEqual', 825: 'lessThan', 827: 'lessEqual', 830: 'greaterThan',
    832: 'greaterEqual', 840: 'logicalOr', 845: 'logicalXor', 850: 'logicalNot',
    855: 'logicalAnd', 865: 'modBroadcastable', 870: 'minBroadcastable',
    875: 'maxBroadcastable', 880: 'addBroadcastable', 885: 'powBroadcastable',
    890: 'divideBroadcastable', 895: 'floorDivBroadcastable', 900: 'multiplyBroadcastable',
    905: 'subtractBroadcastable', 920: 'tile', 925: 'stack', 930: 'gather', 935: 'scatter',
    940: 'gatherND', 945: 'scatterND', 950: 'softmaxND', 952: 'gatherAlongAxis',
    954: 'scatterAlongAxis', 960: 'reverse', 965: 'reverseSeq', 975: 'splitND',
    980: 'concatND', 985: 'transpose', 995: 'sliceStatic', 1000: 'sliceDynamic',
    1005: 'slidingWindows', 1015: 'topK', 1020: 'argMin', 1025: 'argMax',
    1040: 'embeddingND', 1045: 'batchedMatmul', 1065: 'getShape', 1070: 'loadConstantND',
    1080: 'fillLike', 1085: 'fillStatic', 1090: 'fillDynamic', 1100: 'broadcastToLike',
    1105: 'broadcastToStatic', 1110: 'broadcastToDynamic', 1120: 'squeeze',
    1125: 'expandDims', 1130: 'flattenTo2D', 1135: 'reshapeLike', 1140: 'reshapeStatic',
    1145: 'reshapeDynamic', 1150: 'rankPreservingReshape', 1155: 'constantPad',
    1170: 'randomNormalLike', 1175: 'randomNormalStatic', 1180: 'randomNormalDynamic',
    1190: 'randomUniformLike', 1195: 'randomUniformStatic', 1200: 'randomUniformDynamic',
    1210: 'randomBernoulliLike', 1215: 'randomBernoulliStatic',
    1220: 'randomBernoulliDynamic', 1230: 'categoricalDistribution', 1250: 'reduceL1',
    1255: 'reduceL2', 1260: 'reduceMax', 1265: 'reduceMin', 1270: 'reduceSum',
    1275: 'reduceProd', 1280: 'reduceMean', 1285: 'reduceLogSum', 1290: 'reduceSumSquare',
    1295: 'reduceLogSumExp', 1313: 'whereNonZero', 1315: 'matrixBandPart',
    1320: 'lowerTriangular', 1325: 'upperTriangular', 1330: 'whereBroadcastable',
    1350: 'layerNormalization', 1400: 'nonMaximumSuppression', 1450: 'oneHot',
    1455: 'cumSum', 1460: 'clampedReLU', 1461: 'argSort', 1465: 'pooling3d',
    1466: 'globalPooling3d', 1470: 'sliceBySize', 1471: 'convolution3d'
};

/** Layers whose parameters hold a nested network rather than weight tensors. */
const CONTROL_FLOW_LAYERS: Record<string, Record<number, string>> = {
    branch: { 1: 'ifBranch', 2: 'elseBranch' },
    loop: { 3: 'conditionNetwork', 4: 'bodyNetwork' }
};

type ScalarKind =
    | 'u' // uint64 / enum-free varint
    | 'i' // int64
    | 'b' // bool
    | 'f' // float (fixed32)
    | 'd' // double (fixed64)
    | 's' // string
    | 'e' // enum, rendered through `values`
    | 'c' // presence-only oneof arm, rendered as `label`
    | 'w'; // oneof arm rendered as `label` whose message also holds weights

interface FieldSpec {
    name: string;
    kind: ScalarKind;
    repeated?: boolean;
    values?: readonly string[];
    label?: string;
    /** For kind 'w': field number → weight name inside the arm's message. */
    weights?: Record<number, string>;
}

/**
 * Attribute schemas for the layer types a converter emits most often. A layer
 * missing from this table still shows its type, operands, and weights — only
 * its scalar parameters go unnamed, which is why the table can grow without
 * any of the surrounding code changing.
 */
const LAYER_SCHEMAS: Record<string, Record<number, FieldSpec>> = {
    convolution: {
        1: { name: 'outputChannels', kind: 'u' }, 2: { name: 'kernelChannels', kind: 'u' },
        10: { name: 'nGroups', kind: 'u' }, 20: { name: 'kernelSize', kind: 'u', repeated: true },
        30: { name: 'stride', kind: 'u', repeated: true },
        40: { name: 'dilationFactor', kind: 'u', repeated: true },
        50: { name: 'padding', kind: 'c', label: 'valid' },
        51: { name: 'padding', kind: 'c', label: 'same' },
        60: { name: 'isDeconvolution', kind: 'b' }, 70: { name: 'hasBias', kind: 'b' },
        100: { name: 'outputShape', kind: 'u', repeated: true }
    },
    pooling: {
        1: { name: 'type', kind: 'e', values: ['MAX', 'AVERAGE', 'L2'] },
        10: { name: 'kernelSize', kind: 'u', repeated: true },
        20: { name: 'stride', kind: 'u', repeated: true },
        30: { name: 'padding', kind: 'c', label: 'valid' },
        31: { name: 'padding', kind: 'c', label: 'same' },
        32: { name: 'padding', kind: 'c', label: 'includeLastPixel' },
        50: { name: 'avgPoolExcludePadding', kind: 'b' }, 60: { name: 'globalPooling', kind: 'b' }
    },
    activation: {
        5: { name: 'nonlinearity', kind: 'c', label: 'linear' },
        10: { name: 'nonlinearity', kind: 'c', label: 'ReLU' },
        15: { name: 'nonlinearity', kind: 'c', label: 'leakyReLU' },
        20: { name: 'nonlinearity', kind: 'c', label: 'thresholdedReLU' },
        25: { name: 'nonlinearity', kind: 'w', label: 'PReLU', weights: { 1: 'alpha' } },
        30: { name: 'nonlinearity', kind: 'c', label: 'tanh' },
        31: { name: 'nonlinearity', kind: 'c', label: 'scaledTanh' },
        40: { name: 'nonlinearity', kind: 'c', label: 'sigmoid' },
        41: { name: 'nonlinearity', kind: 'c', label: 'sigmoidHard' },
        50: { name: 'nonlinearity', kind: 'c', label: 'ELU' },
        60: { name: 'nonlinearity', kind: 'c', label: 'softsign' },
        70: { name: 'nonlinearity', kind: 'c', label: 'softplus' },
        71: { name: 'nonlinearity', kind: 'w', label: 'parametricSoftplus', weights: { 1: 'alpha', 2: 'beta' } }
    },
    innerProduct: {
        1: { name: 'inputChannels', kind: 'u' }, 2: { name: 'outputChannels', kind: 'u' },
        10: { name: 'hasBias', kind: 'b' }, 22: { name: 'int8DynamicQuantize', kind: 'b' }
    },
    embedding: {
        1: { name: 'inputDim', kind: 'u' }, 2: { name: 'outputChannels', kind: 'u' },
        10: { name: 'hasBias', kind: 'b' }
    },
    embeddingND: {
        1: { name: 'vocabSize', kind: 'u' }, 2: { name: 'embeddingSize', kind: 'u' },
        3: { name: 'hasBias', kind: 'b' }
    },
    batchnorm: {
        1: { name: 'channels', kind: 'u' }, 5: { name: 'computeMeanVar', kind: 'b' },
        6: { name: 'instanceNormalization', kind: 'b' }, 10: { name: 'epsilon', kind: 'f' }
    },
    softmaxND: { 1: { name: 'axis', kind: 'i' } },
    lrn: {
        1: { name: 'alpha', kind: 'f' }, 2: { name: 'beta', kind: 'f' },
        3: { name: 'localSize', kind: 'u' }, 4: { name: 'k', kind: 'f' }
    },
    concat: { 100: { name: 'sequenceConcat', kind: 'b' } },
    concatND: { 1: { name: 'axis', kind: 'i' }, 2: { name: 'interleave', kind: 'b' } },
    reshape: {
        1: { name: 'targetShape', kind: 'i', repeated: true },
        2: { name: 'mode', kind: 'e', values: ['CHANNEL_FIRST', 'CHANNEL_LAST'] }
    },
    reshapeStatic: { 1: { name: 'targetShape', kind: 'i', repeated: true } },
    flatten: { 1: { name: 'mode', kind: 'e', values: ['CHANNEL_FIRST', 'CHANNEL_LAST'] } },
    permute: { 1: { name: 'axis', kind: 'u', repeated: true } },
    transpose: { 1: { name: 'axes', kind: 'u', repeated: true } },
    split: { 1: { name: 'nOutputs', kind: 'u' } },
    splitND: {
        1: { name: 'axis', kind: 'i' }, 2: { name: 'numSplits', kind: 'u' },
        3: { name: 'splitSizes', kind: 'u', repeated: true }
    },
    slice: {
        1: { name: 'startIndex', kind: 'i' }, 2: { name: 'endIndex', kind: 'i' },
        3: { name: 'stride', kind: 'u' },
        4: { name: 'axis', kind: 'e', values: ['CHANNEL_AXIS', 'HEIGHT_AXIS', 'WIDTH_AXIS'] }
    },
    sliceStatic: {
        1: { name: 'beginIds', kind: 'i', repeated: true },
        2: { name: 'beginMasks', kind: 'b', repeated: true },
        3: { name: 'endIds', kind: 'i', repeated: true },
        4: { name: 'endMasks', kind: 'b', repeated: true },
        5: { name: 'strides', kind: 'i', repeated: true },
        6: { name: 'squeezeMasks', kind: 'b', repeated: true }
    },
    unary: {
        1: { name: 'type', kind: 'e', values: ['SQRT', 'RSQRT', 'INVERSE', 'POWER', 'EXP', 'LOG', 'ABS', 'THRESHOLD'] },
        2: { name: 'alpha', kind: 'f' }, 3: { name: 'epsilon', kind: 'f' },
        4: { name: 'shift', kind: 'f' }, 5: { name: 'scale', kind: 'f' }
    },
    reduce: {
        1: { name: 'mode', kind: 'e', values: ['SUM', 'AVG', 'PROD', 'LOGSUM', 'SUMSQUARE', 'L1', 'L2', 'MAX', 'MIN', 'ARGMAX'] },
        2: { name: 'epsilon', kind: 'f' },
        3: { name: 'axis', kind: 'e', values: ['CHW', 'HW', 'C', 'H', 'W'] }
    },
    upsample: {
        1: { name: 'scalingFactor', kind: 'u', repeated: true },
        5: { name: 'mode', kind: 'e', values: ['NN', 'BILINEAR'] },
        6: { name: 'linearUpsampleMode', kind: 'e', values: ['DEFAULT', 'ALIGN_CORNERS_TRUE', 'ALIGN_CORNERS_FALSE'] },
        7: { name: 'fractionalScalingFactor', kind: 'f', repeated: true }
    },
    custom: { 10: { name: 'className', kind: 's' }, 40: { name: 'description', kind: 's' } },
    loadConstant: { 1: { name: 'shape', kind: 'u', repeated: true } },
    loadConstantND: { 1: { name: 'shape', kind: 'u', repeated: true } },
    squeeze: { 1: { name: 'axes', kind: 'i', repeated: true }, 2: { name: 'squeezeAll', kind: 'b' } },
    expandDims: { 1: { name: 'axes', kind: 'i', repeated: true } },
    clip: { 1: { name: 'minVal', kind: 'f' }, 2: { name: 'maxVal', kind: 'f' } },
    gelu: { 1: { name: 'mode', kind: 'e', values: ['EXACT', 'TANH_APPROXIMATION', 'SIGMOID_APPROXIMATION'] } },
    layerNormalization: {
        1: { name: 'normalizedShape', kind: 'i', repeated: true }, 2: { name: 'eps', kind: 'f' }
    },
    batchedMatmul: {
        1: { name: 'transposeA', kind: 'b' }, 2: { name: 'transposeB', kind: 'b' },
        5: { name: 'weightMatrixFirstDimension', kind: 'u' },
        6: { name: 'weightMatrixSecondDimension', kind: 'u' },
        7: { name: 'hasBias', kind: 'b' }, 10: { name: 'int8DynamicQuantize', kind: 'b' }
    },
    argMax: { 1: { name: 'axis', kind: 'i' }, 2: { name: 'removeDim', kind: 'b' } },
    argMin: { 1: { name: 'axis', kind: 'i' }, 2: { name: 'removeDim', kind: 'b' } },
    scale: {
        1: { name: 'shapeScale', kind: 'u', repeated: true }, 3: { name: 'hasBias', kind: 'b' },
        4: { name: 'shapeBias', kind: 'u', repeated: true }
    },
    bias: { 1: { name: 'shape', kind: 'u', repeated: true } },
    loop: { 1: { name: 'maxLoopIterations', kind: 'u' }, 2: { name: 'conditionVar', kind: 's' } }
};

/** `WeightParams` field numbers that carry a name worth showing. */
const LAYER_WEIGHT_NAMES: Record<string, Record<number, string>> = {
    convolution: { 90: 'weights', 91: 'bias' },
    convolution3d: { 60: 'weights', 61: 'bias' },
    innerProduct: { 20: 'weights', 21: 'bias' },
    embedding: { 20: 'weights', 21: 'bias' },
    embeddingND: { 20: 'weights', 21: 'bias' },
    batchnorm: { 15: 'gamma', 16: 'beta', 17: 'mean', 18: 'variance' },
    scale: { 2: 'scale', 5: 'bias' },
    bias: { 2: 'bias' },
    loadConstant: { 2: 'data' },
    loadConstantND: { 2: 'data' },
    layerNormalization: { 3: 'gamma', 4: 'beta' },
    batchedMatmul: { 8: 'weights', 9: 'bias' },
    custom: { 20: 'weights' }
};

/** `MILSpec.DataType` → display name. */
const MIL_DATA_TYPES: Record<number, string> = {
    0: 'UNUSED_TYPE', 1: 'BOOL', 2: 'STRING', 10: 'FLOAT16', 11: 'FLOAT32', 12: 'FLOAT64',
    13: 'BFLOAT16', 21: 'INT8', 22: 'INT16', 23: 'INT32', 24: 'INT64', 25: 'INT4',
    31: 'UINT8', 32: 'UINT16', 33: 'UINT32', 34: 'UINT64',
    35: 'UINT4', 36: 'UINT2', 37: 'UINT1', 38: 'UINT6', 39: 'UINT3',
    40: 'FLOAT8E4M3FN', 41: 'FLOAT8E5M2'
};

/** Bit width per element, for sizing a blob a program never inlines. */
const MIL_TYPE_BITS: Record<number, number> = {
    1: 8, 10: 16, 11: 32, 12: 64, 13: 16, 21: 8, 22: 16, 23: 32, 24: 64, 25: 4,
    31: 8, 32: 16, 33: 32, 34: 64, 35: 4, 36: 2, 37: 1, 38: 6, 39: 3,
    40: 8, 41: 8
};

/** `ArrayFeatureType.ArrayDataType` → display name. */
const ARRAY_DATA_TYPES: Record<number, string> = {
    0: 'INVALID', 65552: 'FLOAT16', 65568: 'FLOAT32', 65600: 'DOUBLE',
    131080: 'INT8', 131104: 'INT32'
};

const COLOR_SPACES: Record<number, string> = {
    0: 'INVALID', 10: 'GRAYSCALE', 20: 'RGB', 30: 'BGR', 40: 'GRAYSCALE_FLOAT16'
};

interface ParseState { fields: number; objects: number; textBytes: number; textTruncated: boolean }
interface Tag { field: number; wire: number }

class WireReader {
    private offset: number;

    constructor(
        private readonly data: Uint8Array,
        private readonly start = 0,
        readonly end = data.byteLength,
        private readonly depth = 0,
        private readonly state: ParseState = { fields: 0, objects: 0, textBytes: 0, textTruncated: false }
    ) {
        this.offset = start;
        if (depth > MAX_DEPTH) throw new CoremlParseError('Core ML protobuf nesting is too deep.');
    }

    get done(): boolean { return this.offset >= this.end; }
    get remaining(): number { return this.end - this.offset; }

    claimObject(): void {
        if (++this.state.objects > MAX_NORMALIZED_OBJECTS) {
            throw new CoremlParseError('Core ML normalized-object limit exceeded.');
        }
    }

    tag(): Tag {
        if (++this.state.fields > MAX_FIELDS) throw new CoremlParseError('Core ML protobuf field limit exceeded.');
        const key = this.uint64();
        const field = Number(key >> 3n);
        const wire = Number(key & 7n);
        if (field <= 0 || field > MAX_PROTO_FIELD_NUMBER || wire > 5) {
            throw new CoremlParseError('Invalid Core ML protobuf field tag.');
        }
        return { field, wire };
    }

    uint64(): bigint {
        let value = 0n;
        for (let index = 0; index < 10; index++) {
            if (this.offset >= this.end) throw new CoremlParseError('Unexpected end of Core ML protobuf varint.');
            const byte = this.data[this.offset++]!;
            if (index === 9 && (byte & 0xfe) !== 0) throw new CoremlParseError('Core ML protobuf varint exceeds uint64.');
            value |= BigInt(byte & 0x7f) << BigInt(index * 7);
            if ((byte & 0x80) === 0) return value;
        }
        throw new CoremlParseError('Invalid Core ML protobuf varint.');
    }

    int64(): bigint { return BigInt.asIntN(64, this.uint64()); }
    int32(): number { return Number(BigInt.asIntN(32, this.uint64())); }
    bool(): boolean { return this.uint64() !== 0n; }

    float(): number {
        this.require(4);
        const value = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 4).getFloat32(0, true);
        this.offset += 4;
        return value;
    }

    double(): number {
        this.require(8);
        const value = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 8).getFloat64(0, true);
        this.offset += 8;
        return value;
    }

    bytes(): Uint8Array {
        const length = this.length();
        const value = this.data.subarray(this.offset, this.offset + length);
        this.offset += length;
        return value;
    }

    string(): string { return this.decodeText(this.bytes()); }

    sub(): WireReader {
        const length = this.length();
        const child = new WireReader(this.data, this.offset, this.offset + length, this.depth + 1, this.state);
        this.offset += length;
        return child;
    }

    /** Reads a submessage without consuming it, for a shape probe. */
    peek(): WireReader {
        const save = this.offset;
        const child = this.sub();
        this.offset = save;
        return child;
    }

    packedVarint(limit = MAX_ITEMS): bigint[] {
        const child = this.sub();
        const values: bigint[] = [];
        while (!child.done) {
            if (values.length >= limit) throw new CoremlParseError('Core ML packed integer item limit exceeded.');
            values.push(child.uint64());
        }
        return values;
    }

    packedFloat(limit = MAX_ITEMS): number[] {
        const child = this.sub();
        if (child.remaining % 4 !== 0) throw new CoremlParseError('Packed Core ML float field has an invalid length.');
        const values: number[] = [];
        while (!child.done) {
            if (values.length >= limit) throw new CoremlParseError('Core ML packed float item limit exceeded.');
            values.push(child.float());
        }
        return values;
    }

    packedDouble(limit = MAX_ITEMS): number[] {
        const child = this.sub();
        if (child.remaining % 8 !== 0) throw new CoremlParseError('Packed Core ML double field has an invalid length.');
        const values: number[] = [];
        while (!child.done) {
            if (values.length >= limit) throw new CoremlParseError('Core ML packed double item limit exceeded.');
            values.push(child.double());
        }
        return values;
    }

    /**
     * Reads a packed vector for display: keeps the first `keep` values and
     * counts the rest.
     *
     * This is not the same job as `packed*` above, which caps a vector the
     * document will hold in full and throws past the cap. An immediate MIL
     * tensor is only ever previewed, and it is routinely enormous — a bool
     * causal-attention mask never moves to a weight blob, so a `[1, 1, 512,
     * 512]` const arrives here with 262 144 elements and has to summarize, not
     * fail.
     */
    packedVarintPreview(keep: number): { values: bigint[]; total: number } {
        const child = this.sub();
        const values: bigint[] = [];
        let total = 0;
        while (!child.done) {
            const value = child.uint64();
            total++;
            if (values.length < keep) values.push(value);
        }
        return { values, total };
    }

    packedFloatPreview(keep: number): { values: number[]; total: number } {
        const child = this.sub();
        if (child.remaining % 4 !== 0) throw new CoremlParseError('Packed Core ML float field has an invalid length.');
        const total = child.remaining / 4;
        const values: number[] = [];
        while (!child.done && values.length < keep) values.push(child.float());
        return { values, total };
    }

    packedDoublePreview(keep: number): { values: number[]; total: number } {
        const child = this.sub();
        if (child.remaining % 8 !== 0) throw new CoremlParseError('Packed Core ML double field has an invalid length.');
        const total = child.remaining / 8;
        const values: number[] = [];
        while (!child.done && values.length < keep) values.push(child.double());
        return { values, total };
    }

    skip(wire: number): void {
        switch (wire) {
            case 0: this.uint64(); return;
            case 1: this.require(8); this.offset += 8; return;
            // `length()` advances past the size varint, so it has to be read
            // before `offset` is captured for the addition.
            case 2: { const length = this.length(); this.offset += length; return; }
            case 5: this.require(4); this.offset += 4; return;
            default: throw new CoremlParseError(`Unsupported Core ML protobuf wire type ${wire}.`);
        }
    }

    private length(): number {
        const raw = this.uint64();
        if (raw > BigInt(Number.MAX_SAFE_INTEGER)) throw new CoremlParseError('Core ML protobuf field is too large.');
        const length = Number(raw);
        this.require(length);
        return length;
    }

    private require(length: number): void {
        if (length < 0 || this.offset + length > this.end) throw new CoremlParseError('Truncated Core ML protobuf field.');
    }

    /** True when any text field was cut to the per-field limit. */
    get textTruncated(): boolean { return this.state.textTruncated; }

    private decodeText(bytes: Uint8Array): string {
        // Every string this parser keeps is display-only — a description, a
        // licence, a user-defined metadata value. Refusing to open a 190 KB
        // model because one of them runs past the per-field budget trades a
        // whole model for a string nobody reads in full, so it is cut instead.
        // The cumulative budget stays a hard stop: it bounds memory, and with
        // per-field cutting it is no longer reachable by ordinary metadata.
        let kept = bytes;
        if (bytes.byteLength > MAX_TEXT_BYTES) {
            kept = bytes.subarray(0, MAX_TEXT_BYTES);
            this.state.textTruncated = true;
        }
        this.state.textBytes += kept.byteLength;
        if (this.state.textBytes > MAX_TOTAL_TEXT_BYTES) throw new CoremlParseError('Core ML cumulative text limit exceeded.');
        return kept === bytes ? decoder.decode(kept) : `${decoder.decode(kept)}…`;
    }
}

/**
 * Reads a Core ML model from either encoding. `.mlpackage` bytes are recognized
 * by their ZIP header, so a caller never has to say which one it holds.
 */
export async function parseCoreml(
    data: Uint8Array,
    options: CoremlParseOptions = {}
): Promise<CoremlDocument> {
    throwIfAborted(options.signal);
    if (isZip(data)) return parseCoremlPackage(data, options);
    return parseCoremlSpec(data);
}

/** Reads a bare `.mlmodel` specification. */
export function parseCoremlSpec(data: Uint8Array): CoremlDocument {
    if (data.byteLength === 0) throw new CoremlParseError('The Core ML file is empty.');
    const context = newContext();
    const reader = new WireReader(data);
    const model = parseModel(reader, context, 0);
    if (reader.textTruncated) context.warnings.push({ key: 'coreml.warning.textTruncated' });
    if (model.specificationVersion <= 0) {
        throw new CoremlParseError('The file does not declare a Core ML specification version.');
    }
    if (model.typeField === 0 && model.functions.length === 0) {
        throw new CoremlParseError('The file does not contain a Core ML model type or description.');
    }
    return buildDocument(model, context, data.byteLength, false, undefined);
}

/**
 * True when the bytes open with a Core ML specification. Used for content
 * routing where the extension is absent, so it stays deliberately strict: a
 * `specificationVersion` in the published range plus a description or a model
 * type, read without trusting anything past the fields it checks.
 */
export function looksLikeCoremlSpec(data: Uint8Array): boolean {
    if (data.byteLength < 2) return false;
    try {
        const reader = new WireReader(data);
        let version = 0;
        let typed = false;
        while (!reader.done) {
            const tag = reader.tag();
            if (tag.field === 1 && tag.wire === 0) version = reader.int32();
            else if (MODEL_TYPES[tag.field] && tag.wire === 2) { reader.skip(tag.wire); typed = true; }
            else if (tag.wire === 3 || tag.wire === 4) return false;
            else reader.skip(tag.wire);
        }
        // A `oneof Type` arm is what makes these bytes a Core ML model rather
        // than any other protobuf that opens with a small version number and a
        // string — an ONNX `ModelProto` is exactly that, and this repo ships a
        // viewer for those too. Every arm is numbered 200 or above, which no
        // other model format this registry routes puts a field at.
        return version >= 1 && version <= 64 && typed;
    } catch {
        return false;
    }
}

// ── Model specification ────────────────────────────────────────────────────

interface Context {
    graphs: CoremlGraph[];
    warnings: CoremlWarning[];
    /** Blob file name → running reference count and byte total. */
    blobs: Map<string, { references: number; bytes: bigint }>;
    nextId: number;
}

interface ParsedModel {
    specificationVersion: number;
    isUpdatable: boolean;
    shortDescription: string;
    versionString: string;
    author: string;
    license: string;
    userDefined: CoremlEntry[];
    functions: CoremlFunction[];
    defaultFunctionName: string;
    typeField: number;
    /** Graph id the model's own body was recorded under, when it has one. */
    rootGraphId: string;
    classLabels: CoremlDocument['classLabels'];
}

function newContext(): Context {
    return { graphs: [], warnings: [], blobs: new Map(), nextId: 0 };
}

function parseModel(reader: WireReader, context: Context, depth: number): ParsedModel {
    reader.claimObject();
    const model: ParsedModel = {
        specificationVersion: 0, isUpdatable: false, shortDescription: '', versionString: '',
        author: '', license: '', userDefined: [], functions: [], defaultFunctionName: '',
        typeField: 0, rootGraphId: '', classLabels: { kind: '', values: [], total: 0 }
    };
    let body: { field: number; reader: WireReader } | undefined;
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) model.specificationVersion = reader.int32();
        else if (tag.field === 2 && tag.wire === 2) applyDescription(reader.sub(), model);
        else if (tag.field === 10 && tag.wire === 0) model.isUpdatable = reader.bool();
        else if (MODEL_TYPES[tag.field] && tag.wire === 2) {
            // A well-formed spec sets exactly one oneof arm; a later arm wins,
            // matching how a protobuf runtime resolves a repeated oneof.
            model.typeField = tag.field;
            body = { field: tag.field, reader: reader.sub() };
        }
        else if (tag.wire === 3 || tag.wire === 4) {
            throw new CoremlParseError(`Unexpected Core ML field ${tag.field} with wire type ${tag.wire}.`);
        }
        else reader.skip(tag.wire);
    }
    if (body) model.rootGraphId = parseModelBody(body.field, body.reader, model, context, depth);
    return model;
}

/** Reads whichever `oneof Type` arm the model set, returning its graph id. */
function parseModelBody(
    field: number,
    reader: WireReader,
    model: ParsedModel,
    context: Context,
    depth: number
): string {
    const type = MODEL_TYPES[field] ?? `type${field}`;
    if (field === 502) return parseProgram(reader, context);
    if (NEURAL_NETWORK_TYPES.has(field)) return parseNeuralNetwork(reader, context, type, '', 0, model);
    if (PIPELINE_TYPES.has(field)) return parsePipeline(reader, field, model, context, depth);
    if (field === 555) applyCustomModel(reader, model);
    else if (VECTOR_CLASSIFIER_TYPES.has(field)) applyVectorClassLabels(reader, model);
    // Every other arm is a parameter block the model description already
    // summarizes; the sub-reader is simply dropped without being walked.
    return '';
}

function applyDescription(reader: WireReader, model: ParsedModel): void {
    reader.claimObject();
    const modelLevel: CoremlFunction = emptyFunction('main');
    const functions: CoremlFunction[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) limitedPush(modelLevel.inputs, parseFeature(reader.sub()));
        else if (tag.field === 10 && tag.wire === 2) limitedPush(modelLevel.outputs, parseFeature(reader.sub()));
        else if (tag.field === 13 && tag.wire === 2) limitedPush(modelLevel.state, parseFeature(reader.sub()));
        else if (tag.field === 11 && tag.wire === 2) modelLevel.predictedFeatureName = reader.string();
        else if (tag.field === 12 && tag.wire === 2) modelLevel.predictedProbabilitiesName = reader.string();
        else if (tag.field === 50 && tag.wire === 2) limitedPush(modelLevel.trainingInputs, parseFeature(reader.sub()));
        else if (tag.field === 20 && tag.wire === 2) limitedPush(functions, parseFunctionDescription(reader.sub()));
        else if (tag.field === 21 && tag.wire === 2) model.defaultFunctionName = reader.string();
        else if (tag.field === 100 && tag.wire === 2) applyMetadata(reader.sub(), model);
        else reader.skip(tag.wire);
    }
    // Model-level features and `functions` are mutually exclusive per the
    // schema: a multi-function model declares everything per function.
    if (functions.length > 0) {
        const fallback = model.defaultFunctionName || functions[0]!.name;
        for (const item of functions) item.isDefault = item.name === fallback;
        model.functions = functions;
    } else {
        modelLevel.isDefault = true;
        model.functions = [modelLevel];
    }
}

function emptyFunction(name: string): CoremlFunction {
    return {
        name, isDefault: false, inputs: [], outputs: [], state: [], trainingInputs: [],
        predictedFeatureName: '', predictedProbabilitiesName: ''
    };
}

function parseFunctionDescription(reader: WireReader): CoremlFunction {
    reader.claimObject();
    const item = emptyFunction('');
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) item.name = reader.string();
        else if (tag.field === 2 && tag.wire === 2) limitedPush(item.inputs, parseFeature(reader.sub()));
        else if (tag.field === 3 && tag.wire === 2) limitedPush(item.outputs, parseFeature(reader.sub()));
        else if (tag.field === 6 && tag.wire === 2) limitedPush(item.state, parseFeature(reader.sub()));
        else if (tag.field === 4 && tag.wire === 2) item.predictedFeatureName = reader.string();
        else if (tag.field === 5 && tag.wire === 2) item.predictedProbabilitiesName = reader.string();
        else reader.skip(tag.wire);
    }
    return item;
}

function applyMetadata(reader: WireReader, model: ParsedModel): void {
    reader.claimObject();
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) model.shortDescription = reader.string();
        else if (tag.field === 2 && tag.wire === 2) model.versionString = reader.string();
        else if (tag.field === 3 && tag.wire === 2) model.author = reader.string();
        else if (tag.field === 4 && tag.wire === 2) model.license = reader.string();
        else if (tag.field === 100 && tag.wire === 2) limitedPush(model.userDefined, parseStringMapEntry(reader.sub()));
        else reader.skip(tag.wire);
    }
}

function parseStringMapEntry(reader: WireReader): CoremlEntry {
    reader.claimObject();
    let key = '';
    let value = '';
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) key = reader.string();
        else if (tag.field === 2 && tag.wire === 2) value = reader.string();
        else reader.skip(tag.wire);
    }
    return { key, value };
}

// ── Feature types ──────────────────────────────────────────────────────────

function parseFeature(reader: WireReader): CoremlFeature {
    reader.claimObject();
    let name = '';
    let description = '';
    let type: FeatureTypeInfo = { kind: 'unknown', display: 'unknown', flexibility: '', details: [], optional: false };
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) name = reader.string();
        else if (tag.field === 2 && tag.wire === 2) description = reader.string();
        else if (tag.field === 3 && tag.wire === 2) type = parseFeatureType(reader.sub());
        else reader.skip(tag.wire);
    }
    return {
        name, typeKind: type.kind, type: type.display, flexibility: type.flexibility,
        optional: type.optional, description, details: type.details
    };
}

interface FeatureTypeInfo {
    kind: string;
    display: string;
    flexibility: string;
    details: CoremlEntry[];
    optional: boolean;
}

function parseFeatureType(reader: WireReader): FeatureTypeInfo {
    reader.claimObject();
    let info: FeatureTypeInfo = { kind: 'unknown', display: 'unknown', flexibility: '', details: [], optional: false };
    let optional = false;
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) { reader.skip(tag.wire); info = simpleType('int64'); }
        else if (tag.field === 2 && tag.wire === 2) { reader.skip(tag.wire); info = simpleType('double'); }
        else if (tag.field === 3 && tag.wire === 2) { reader.skip(tag.wire); info = simpleType('string'); }
        else if (tag.field === 4 && tag.wire === 2) info = parseImageType(reader.sub());
        else if (tag.field === 5 && tag.wire === 2) info = parseArrayType(reader.sub());
        else if (tag.field === 6 && tag.wire === 2) info = parseDictionaryType(reader.sub());
        else if (tag.field === 7 && tag.wire === 2) info = parseSequenceType(reader.sub());
        else if (tag.field === 8 && tag.wire === 2) info = parseStateType(reader.sub());
        else if (tag.field === 1000 && tag.wire === 0) optional = reader.bool();
        else reader.skip(tag.wire);
    }
    return { ...info, optional };
}

function simpleType(kind: string): FeatureTypeInfo {
    return { kind, display: kind, flexibility: '', details: [], optional: false };
}

function parseImageType(reader: WireReader): FeatureTypeInfo {
    reader.claimObject();
    let width = 0n;
    let height = 0n;
    let colorSpace = 0;
    let flexibility = '';
    const details: CoremlEntry[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) width = reader.int64();
        else if (tag.field === 2 && tag.wire === 0) height = reader.int64();
        else if (tag.field === 3 && tag.wire === 0) colorSpace = reader.int32();
        else if (tag.field === 21 && tag.wire === 2) {
            const sizes = parseEnumeratedImageSizes(reader.sub());
            flexibility = listPreview(sizes, MAX_LITERAL_ITEMS);
            details.push({ key: 'enumeratedSizes', value: String(sizes.length) });
        }
        else if (tag.field === 31 && tag.wire === 2) flexibility = parseImageSizeRange(reader.sub());
        else reader.skip(tag.wire);
    }
    const space = COLOR_SPACES[colorSpace] ?? `COLOR_SPACE_${colorSpace}`;
    details.push({ key: 'colorSpace', value: space });
    return {
        kind: 'image', display: `image ${width} × ${height} ${space}`, flexibility, details, optional: false
    };
}

function parseEnumeratedImageSizes(reader: WireReader): string[] {
    const sizes: string[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) limitedPush(sizes, parseImageSize(reader.sub()));
        else reader.skip(tag.wire);
    }
    return sizes;
}

function parseImageSize(reader: WireReader): string {
    reader.claimObject();
    let width = 0n;
    let height = 0n;
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) width = reader.uint64();
        else if (tag.field === 2 && tag.wire === 0) height = reader.uint64();
        else reader.skip(tag.wire);
    }
    return `${width} × ${height}`;
}

function parseImageSizeRange(reader: WireReader): string {
    reader.claimObject();
    let widthRange = '';
    let heightRange = '';
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) widthRange = parseSizeRange(reader.sub());
        else if (tag.field === 2 && tag.wire === 2) heightRange = parseSizeRange(reader.sub());
        else reader.skip(tag.wire);
    }
    return `${widthRange || '?'} × ${heightRange || '?'}`;
}

/** `upperBound` is signed and negative means unbounded (FeatureTypes.proto). */
function parseSizeRange(reader: WireReader): string {
    reader.claimObject();
    let lower = 0n;
    let upper = 0n;
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) lower = reader.uint64();
        else if (tag.field === 2 && tag.wire === 0) upper = reader.int64();
        else reader.skip(tag.wire);
    }
    return `${lower}…${upper < 0n ? '∞' : upper}`;
}

function parseArrayType(reader: WireReader): FeatureTypeInfo {
    reader.claimObject();
    const shape: bigint[] = [];
    let dataType = 0;
    let flexibility = '';
    const details: CoremlEntry[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) pushDimension(shape, reader.int64());
        else if (tag.field === 1 && tag.wire === 2) for (const dim of reader.packedVarint(MAX_TENSOR_RANK)) pushDimension(shape, BigInt.asIntN(64, dim));
        else if (tag.field === 2 && tag.wire === 0) dataType = reader.int32();
        else if (tag.field === 21 && tag.wire === 2) {
            const shapes = parseEnumeratedShapes(reader.sub());
            flexibility = listPreview(shapes, MAX_LITERAL_ITEMS);
            details.push({ key: 'enumeratedShapes', value: String(shapes.length) });
        }
        else if (tag.field === 31 && tag.wire === 2) flexibility = parseShapeRange(reader.sub());
        else if (tag.field === 41 && tag.wire === 0) details.push({ key: 'intDefaultValue', value: String(reader.int32()) });
        else if (tag.field === 51 && tag.wire === 5) details.push({ key: 'floatDefaultValue', value: formatNumber(reader.float()) });
        else if (tag.field === 61 && tag.wire === 1) details.push({ key: 'doubleDefaultValue', value: formatNumber(reader.double()) });
        else reader.skip(tag.wire);
    }
    const type = ARRAY_DATA_TYPES[dataType] ?? `TYPE_${dataType}`;
    return {
        kind: 'multiArray',
        display: `multiArray ${type}[${shape.join(', ')}]`,
        flexibility, details, optional: false
    };
}

function parseEnumeratedShapes(reader: WireReader): string[] {
    const shapes: string[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) limitedPush(shapes, `[${parseShape(reader.sub()).join(', ')}]`);
        else reader.skip(tag.wire);
    }
    return shapes;
}

function parseShape(reader: WireReader): bigint[] {
    reader.claimObject();
    const shape: bigint[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) pushDimension(shape, reader.int64());
        else if (tag.field === 1 && tag.wire === 2) for (const dim of reader.packedVarint(MAX_TENSOR_RANK)) pushDimension(shape, BigInt.asIntN(64, dim));
        else reader.skip(tag.wire);
    }
    return shape;
}

function parseShapeRange(reader: WireReader): string {
    reader.claimObject();
    const ranges: string[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) limitedPush(ranges, parseSizeRange(reader.sub()));
        else reader.skip(tag.wire);
    }
    return `[${ranges.join(', ')}]`;
}

function parseDictionaryType(reader: WireReader): FeatureTypeInfo {
    reader.claimObject();
    let key = 'unknown';
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) { reader.skip(tag.wire); key = 'int64'; }
        else if (tag.field === 2 && tag.wire === 2) { reader.skip(tag.wire); key = 'string'; }
        else reader.skip(tag.wire);
    }
    // Core ML dictionaries always map to a double confidence value.
    return { kind: 'dictionary', display: `dictionary<${key}, double>`, flexibility: '', details: [], optional: false };
}

function parseSequenceType(reader: WireReader): FeatureTypeInfo {
    reader.claimObject();
    let element = 'unknown';
    let range = '';
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) { reader.skip(tag.wire); element = 'int64'; }
        else if (tag.field === 3 && tag.wire === 2) { reader.skip(tag.wire); element = 'string'; }
        else if (tag.field === 101 && tag.wire === 2) range = parseSizeRange(reader.sub());
        else reader.skip(tag.wire);
    }
    return { kind: 'sequence', display: `sequence<${element}>`, flexibility: range, details: [], optional: false };
}

function parseStateType(reader: WireReader): FeatureTypeInfo {
    reader.claimObject();
    let inner: FeatureTypeInfo | undefined;
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) inner = parseArrayType(reader.sub());
        else reader.skip(tag.wire);
    }
    return {
        kind: 'state',
        display: `state<${inner?.display ?? 'unknown'}>`,
        flexibility: inner?.flexibility ?? '',
        details: inner?.details ?? [],
        optional: false
    };
}

function pushDimension(shape: bigint[], value: bigint): void {
    if (shape.length >= MAX_TENSOR_RANK) throw new CoremlParseError(`Core ML shape rank exceeds ${MAX_TENSOR_RANK}.`);
    shape.push(value);
}

// ── ML Program (MILSpec) ───────────────────────────────────────────────────

function parseProgram(reader: WireReader, context: Context): string {
    reader.claimObject();
    let version = 0n;
    let docString = '';
    const functions: Array<{ name: string; reader: WireReader }> = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) version = reader.int64();
        else if (tag.field === 2 && tag.wire === 2) {
            const entry = readMapEntry(reader.sub());
            if (entry.value) functions.push({ name: entry.key, reader: entry.value });
        }
        else if (tag.field === 3 && tag.wire === 2) docString = reader.string();
        else reader.skip(tag.wire);
    }
    if (version > 1n) context.warnings.push({ key: 'coreml.warning.programVersion', args: { version: version.toString() } });
    let rootId = '';
    for (const item of functions) {
        const id = parseMilFunction(item.name, item.reader, context, docString);
        if (!rootId || item.name === 'main') rootId = id;
    }
    if (functions.length === 0) context.warnings.push({ key: 'coreml.warning.emptyProgram' });
    return rootId;
}

function parseMilFunction(name: string, reader: WireReader, context: Context, docString: string): string {
    reader.claimObject();
    let opset = '';
    const inputs: CoremlValue[] = [];
    const blocks: Array<{ name: string; reader: WireReader }> = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) limitedPush(inputs, parseNamedValueType(reader.sub()));
        else if (tag.field === 2 && tag.wire === 2) opset = reader.string();
        else if (tag.field === 3 && tag.wire === 2) {
            const entry = readMapEntry(reader.sub());
            if (entry.value) blocks.push({ name: entry.key, reader: entry.value });
        }
        else reader.skip(tag.wire);
    }
    // A function's body is stored per opset specialization. The one matching
    // the function's declared opset is the one Core ML runs; the rest are
    // recorded beside it so nothing in the file goes unseen.
    const primary = blocks.find(item => item.name === opset) ?? blocks[0];
    let rootId = '';
    for (const block of blocks) {
        const isPrimary = block === primary;
        const graph = addGraph(context, {
            name: isPrimary ? name : `${name} [${block.name}]`,
            kind: 'program', opset: block.name || opset, parentId: '', depth: 0,
            inputs, outputs: [], nodes: [], description: isPrimary ? docString : ''
        });
        fillBlock(block.reader, graph, context, inputs);
        if (isPrimary) rootId = graph.id;
    }
    return rootId;
}

/** Reads a `Block` into `graph`, recording nested blocks as their own graphs. */
function fillBlock(reader: WireReader, graph: CoremlGraph, context: Context, inherited: CoremlValue[]): void {
    reader.claimObject();
    // A block's scope is what it inherits plus what it declares, keyed by name
    // so an inner declaration shadows the outer one it hides rather than
    // appearing twice. It is built up as the fields are read, because an
    // operation's own nested blocks inherit `graph.inputs` as it stands at that
    // moment — assigning it only at the end left every block two or more levels
    // down with an empty scope.
    //
    // `inherited` is the enclosing scope for a nested block and the function's
    // own inputs for a function block, and the same rule serves both: a block
    // that re-declares those names updates them in place, and one that declares
    // nothing keeps them. The position index makes each update O(1), so a block
    // declaring many arguments stays linear.
    const position = new Map<string, number>();
    graph.inputs = [];
    const extendScope = (value: CoremlValue): void => {
        const at = position.get(value.name);
        if (at === undefined) {
            position.set(value.name, graph.inputs.length);
            limitedPush(graph.inputs, value);
        } else {
            graph.inputs[at] = value;
        }
    };
    for (const value of inherited) extendScope(value);
    // Operations are held back until the whole block has been read, so the
    // scope they hand to their own nested blocks is complete no matter what
    // order the producer wrote the fields in. protoc emits them in field-number
    // order, which would already put inputs first, but nothing in the wire
    // format requires that.
    const operations: WireReader[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) extendScope(parseNamedValueType(reader.sub()));
        else if (tag.field === 2 && tag.wire === 2) limitedPush(graph.outputs, reader.string());
        else if (tag.field === 3 && tag.wire === 2) limitedPush(operations, reader.sub());
        else reader.skip(tag.wire);
    }
    for (const operation of operations) graph.nodes.push(parseOperation(operation, graph, context));
}

function parseOperation(reader: WireReader, graph: CoremlGraph, context: Context): CoremlNode {
    reader.claimObject();
    const node: CoremlNode = {
        id: `${graph.id}-op${graph.nodes.length}`, graphId: graph.id, name: '', type: '',
        kind: 'operation', constant: false, custom: false, inputs: [], outputs: [],
        attributes: [], weights: [], graphs: [], updatable: false, description: ''
    };
    const nested: WireReader[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) node.type = reader.string();
        else if (tag.field === 2 && tag.wire === 2) applyOperationInput(reader.sub(), node, context);
        else if (tag.field === 3 && tag.wire === 2) limitedPush(node.outputs, parseNamedValueType(reader.sub()));
        else if (tag.field === 4 && tag.wire === 2) nested.push(reader.sub());
        else if (tag.field === 5 && tag.wire === 2) applyOperationAttribute(reader.sub(), node, context);
        else reader.skip(tag.wire);
    }
    node.constant = node.type === 'const' || node.type.startsWith('constexpr_');
    node.custom = node.type === 'custom_layer';
    // MIL names values, not operations; the first output is what every other
    // operation refers to, so it is the only stable name a node has.
    node.name = node.outputs[0]?.name ?? node.id;
    for (const block of nested) {
        const child = addGraph(context, {
            name: `${node.name} · block ${node.graphs.length}`, kind: 'block',
            opset: graph.opset, parentId: graph.id, depth: graph.depth + 1,
            inputs: [], outputs: [], nodes: [], description: ''
        });
        fillBlock(block, child, context, graph.inputs);
        node.graphs.push(child.id);
    }
    return node;
}

/**
 * One entry of `Operation.attributes`, a `map<string, Value>`.
 *
 * This is not a side channel: a `const` carries its whole payload here, and
 * that is how every weight an ML Program owns is stored — `translate_const`
 * emits no inputs at all. A `constexpr_*` op at opset iOS 17 or older puts its
 * parameters here too. So a blob-backed attribute is a weight, and any other
 * attribute is an ordinary named value.
 */
function applyOperationAttribute(reader: WireReader, node: CoremlNode, context: Context): void {
    reader.claimObject();
    let key = '';
    let value: WireReader | undefined;
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) key = reader.string();
        else if (tag.field === 2 && tag.wire === 2) value = reader.sub();
        else reader.skip(tag.wire);
    }
    if (!value) return;
    const parsed = parseMilValue(value, context);
    if (parsed.weight) limitedPush(node.weights, { ...parsed.weight, name: key });
    else limitedPush(node.attributes, { key, value: parsed.display });
}

/** One entry of `Operation.inputs`: a parameter name bound to names or values. */
function applyOperationInput(reader: WireReader, node: CoremlNode, context: Context): void {
    reader.claimObject();
    let name = '';
    let argument: WireReader | undefined;
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) name = reader.string();
        else if (tag.field === 2 && tag.wire === 2) argument = reader.sub();
        else reader.skip(tag.wire);
    }
    const port: CoremlPort = { name, values: [] };
    if (argument) {
        while (!argument.done) {
            const tag = argument.tag();
            if (tag.field === 1 && tag.wire === 2) applyBinding(argument.sub(), name, port, node, context);
            else argument.skip(tag.wire);
        }
    }
    limitedPush(node.inputs, port);
}

function applyBinding(
    reader: WireReader,
    parameter: string,
    port: CoremlPort,
    node: CoremlNode,
    context: Context
): void {
    reader.claimObject();
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) limitedPush(port.values, { text: reader.string(), variable: true });
        else if (tag.field === 2 && tag.wire === 2) {
            const value = parseMilValue(reader.sub(), context);
            limitedPush(port.values, { text: value.display, variable: false });
            if (value.weight) limitedPush(node.weights, { ...value.weight, name: parameter });
        }
        else reader.skip(tag.wire);
    }
}

interface MilValue {
    display: string;
    weight?: CoremlWeight;
}

function parseMilValue(reader: WireReader, context: Context): MilValue {
    reader.claimObject();
    let type: MilType | undefined;
    let immediate = '';
    let blob: { file: string; offset: bigint } | undefined;
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) reader.skip(tag.wire);
        else if (tag.field === 2 && tag.wire === 2) type = parseValueType(reader.sub());
        else if (tag.field === 3 && tag.wire === 2) immediate = parseImmediateValue(reader.sub());
        else if (tag.field === 5 && tag.wire === 2) blob = parseBlobFileValue(reader.sub());
        else reader.skip(tag.wire);
    }
    if (blob) {
        const bytes = tensorByteLength(type);
        const record = context.blobs.get(blob.file) ?? { references: 0, bytes: 0n };
        record.references++;
        record.bytes += bytes;
        context.blobs.set(blob.file, record);
        return {
            display: `<${type?.display ?? 'tensor'} @ ${shortBlobName(blob.file)}+${blob.offset}>`,
            weight: {
                name: '', dataType: type?.dataType ?? 'unknown', shape: type?.shape ?? [],
                elementCount: (type?.elementCount ?? 0n).toString(), byteLength: bytes.toString(),
                storage: 'blob', file: blob.file, offset: blob.offset.toString(),
                quantization: '', updatable: false
            }
        };
    }
    if (immediate) return { display: immediate };
    return { display: type ? `<${type.display}>` : '<value>' };
}

function parseBlobFileValue(reader: WireReader): { file: string; offset: bigint } {
    reader.claimObject();
    let file = '';
    let offset = 0n;
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) file = reader.string();
        else if (tag.field === 2 && tag.wire === 0) offset = reader.uint64();
        else reader.skip(tag.wire);
    }
    return { file, offset };
}

function parseImmediateValue(reader: WireReader): string {
    reader.claimObject();
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) return parseTensorValue(reader.sub());
        if (tag.field === 2 && tag.wire === 2) { reader.skip(tag.wire); return '<tuple>'; }
        if (tag.field === 3 && tag.wire === 2) { reader.skip(tag.wire); return '<list>'; }
        if (tag.field === 4 && tag.wire === 2) { reader.skip(tag.wire); return '<dictionary>'; }
        reader.skip(tag.wire);
    }
    return '';
}

function parseTensorValue(reader: WireReader): string {
    reader.claimObject();
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) return renderScalars(readRepeated(reader.sub(), 'f'));
        if (tag.field === 2 && tag.wire === 2) return renderScalars(readRepeated(reader.sub(), 'i'));
        if (tag.field === 3 && tag.wire === 2) return renderScalars(readRepeated(reader.sub(), 'b'));
        if (tag.field === 4 && tag.wire === 2) return renderScalars(readRepeated(reader.sub(), 's'));
        if (tag.field === 5 && tag.wire === 2) return renderScalars(readRepeated(reader.sub(), 'i'));
        if (tag.field === 6 && tag.wire === 2) return renderScalars(readRepeated(reader.sub(), 'd'));
        if (tag.field === 7 && tag.wire === 2) {
            const bytes = readRawBytes(reader.sub());
            return `<${bytes} bytes>`;
        }
        reader.skip(tag.wire);
    }
    return '';
}

/** Reads one `Repeated*` wrapper, keeping only enough elements to render. */
function readRepeated(reader: WireReader, kind: 'f' | 'i' | 'b' | 's' | 'd'): { values: string[]; total: number } {
    const values: string[] = [];
    let total = 0;
    const push = (text: string): void => {
        total++;
        if (values.length < MAX_LITERAL_ITEMS) values.push(text);
    };
    /** Absorbs a previewed vector: its kept values plus the count of the rest. */
    const absorb = (read: { values: unknown[]; total: number }, format: (item: never) => string): void => {
        for (const item of read.values) push(format(item as never));
        total += read.total - read.values.length;
    };
    const remaining = (): number => Math.max(0, MAX_LITERAL_ITEMS - values.length);
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field !== 1) { reader.skip(tag.wire); continue; }
        // A string past the preview budget is counted without being decoded,
        // so a const holding thousands of them cannot exhaust the text budget.
        if (kind === 's' && tag.wire === 2) {
            if (values.length < MAX_LITERAL_ITEMS) push(JSON.stringify(reader.string()));
            else { reader.skip(tag.wire); total++; }
        }
        else if (kind === 'f' && tag.wire === 2) absorb(reader.packedFloatPreview(remaining()), formatNumber);
        else if (kind === 'f' && tag.wire === 5) push(formatNumber(reader.float()));
        else if (kind === 'd' && tag.wire === 2) absorb(reader.packedDoublePreview(remaining()), formatNumber);
        else if (kind === 'd' && tag.wire === 1) push(formatNumber(reader.double()));
        else if (kind === 'b' && tag.wire === 2) absorb(reader.packedVarintPreview(remaining()), (item: bigint) => item === 0n ? 'false' : 'true');
        else if (kind === 'b' && tag.wire === 0) push(reader.bool() ? 'true' : 'false');
        else if (tag.wire === 2) absorb(reader.packedVarintPreview(remaining()), (item: bigint) => BigInt.asIntN(64, item).toString());
        else if (tag.wire === 0) push(reader.int64().toString());
        else reader.skip(tag.wire);
    }
    return { values, total };
}

function readRawBytes(reader: WireReader): number {
    let total = 0;
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) total += reader.bytes().byteLength;
        else reader.skip(tag.wire);
    }
    return total;
}

function renderScalars(read: { values: string[]; total: number }): string {
    if (read.total === 1) return read.values[0] ?? '';
    return listPreview(read.values, MAX_LITERAL_ITEMS, read.total);
}

interface MilType {
    display: string;
    dataType: string;
    shape: string[];
    elementCount: bigint;
    bits: number;
}

function parseValueType(reader: WireReader): MilType {
    reader.claimObject();
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) return parseTensorType(reader.sub());
        if (tag.field === 2 && tag.wire === 2) { const inner = parseListType(reader.sub()); return wrapType('list', inner); }
        if (tag.field === 3 && tag.wire === 2) { reader.skip(tag.wire); return unknownType('tuple'); }
        if (tag.field === 4 && tag.wire === 2) { reader.skip(tag.wire); return unknownType('dictionary'); }
        if (tag.field === 5 && tag.wire === 2) { const inner = parseStateWrappedType(reader.sub()); return wrapType('state', inner); }
        reader.skip(tag.wire);
    }
    return unknownType('unknown');
}

function parseListType(reader: WireReader): MilType {
    reader.claimObject();
    let inner = unknownType('unknown');
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) inner = parseValueType(reader.sub());
        else reader.skip(tag.wire);
    }
    return inner;
}

function parseStateWrappedType(reader: WireReader): MilType {
    reader.claimObject();
    let inner = unknownType('unknown');
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) inner = parseValueType(reader.sub());
        else reader.skip(tag.wire);
    }
    return inner;
}

function wrapType(prefix: string, inner: MilType): MilType {
    return { ...inner, display: `${prefix}<${inner.display}>` };
}

function unknownType(display: string): MilType {
    return { display, dataType: display, shape: [], elementCount: 0n, bits: 0 };
}

function parseTensorType(reader: WireReader): MilType {
    reader.claimObject();
    let dataType = 0;
    let rank = 0n;
    const dimensions: string[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) dataType = reader.int32();
        else if (tag.field === 2 && tag.wire === 0) rank = reader.int64();
        else if (tag.field === 3 && tag.wire === 2) limitedPush(dimensions, parseDimension(reader.sub()));
        else reader.skip(tag.wire);
    }
    if (rank > BigInt(MAX_TENSOR_RANK)) throw new CoremlParseError(`Core ML tensor rank exceeds ${MAX_TENSOR_RANK}.`);
    const name = MIL_DATA_TYPES[dataType] ?? `TYPE_${dataType}`;
    return {
        display: `${name}[${dimensions.join(', ')}]`,
        dataType: name,
        shape: dimensions,
        elementCount: elementCount(dimensions),
        bits: MIL_TYPE_BITS[dataType] ?? 0
    };
}

function parseDimension(reader: WireReader): string {
    reader.claimObject();
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) return parseConstantDimension(reader.sub());
        if (tag.field === 2 && tag.wire === 2) return parseUnknownDimension(reader.sub());
        reader.skip(tag.wire);
    }
    return '?';
}

function parseConstantDimension(reader: WireReader): string {
    reader.claimObject();
    let size = 0n;
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) size = reader.uint64();
        else reader.skip(tag.wire);
    }
    return size.toString();
}

function parseUnknownDimension(reader: WireReader): string {
    reader.claimObject();
    let variadic = false;
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) variadic = reader.bool();
        else reader.skip(tag.wire);
    }
    return variadic ? '*' : '?';
}

function parseNamedValueType(reader: WireReader): CoremlValue {
    reader.claimObject();
    let name = '';
    let type = '';
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) name = reader.string();
        else if (tag.field === 2 && tag.wire === 2) type = parseValueType(reader.sub()).display;
        else reader.skip(tag.wire);
    }
    return { name, type };
}

/** Product of the constant dimensions; a symbolic dimension contributes 1. */
function elementCount(dimensions: string[]): bigint {
    let count = 1n;
    for (const dimension of dimensions) {
        if (!/^\d+$/.test(dimension)) continue;
        const size = BigInt(dimension);
        if (size === 0n) return 0n;
        if (bitLength(count) + bitLength(size) > MAX_TENSOR_PRODUCT_BITS + 1) {
            throw new CoremlParseError('Core ML tensor element count is too large to display safely.');
        }
        count *= size;
        if (bitLength(count) > MAX_TENSOR_PRODUCT_BITS) {
            throw new CoremlParseError('Core ML tensor element count is too large to display safely.');
        }
    }
    return count;
}

function tensorByteLength(type: MilType | undefined): bigint {
    if (!type || type.bits === 0) return 0n;
    return (type.elementCount * BigInt(type.bits) + 7n) / 8n;
}

/** `@model_path/weights/weight.bin` → `weight.bin`, for a compact literal. */
function shortBlobName(file: string): string {
    const slash = file.lastIndexOf('/');
    return slash >= 0 ? file.slice(slash + 1) : file;
}

/** Reads a protobuf map entry: key at field 1, value at field 2. */
function readMapEntry(reader: WireReader): { key: string; value: WireReader | undefined } {
    reader.claimObject();
    let key = '';
    let value: WireReader | undefined;
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) key = reader.string();
        else if (tag.field === 2 && tag.wire === 2) value = reader.sub();
        else reader.skip(tag.wire);
    }
    return { key, value };
}

// ── Neural network ─────────────────────────────────────────────────────────

function parseNeuralNetwork(
    reader: WireReader,
    context: Context,
    name: string,
    parentId: string,
    depth: number,
    model?: ParsedModel
): string {
    reader.claimObject();
    const graph = addGraph(context, {
        name, kind: 'network', opset: '', parentId, depth,
        inputs: [], outputs: [], nodes: [], description: ''
    });
    const preprocessing: CoremlEntry[] = [];
    let arrayMapping = -1;
    let imageMapping = -1;
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) limitedPush(graph.nodes, parseLayer(reader.sub(), graph, context));
        else if (tag.field === 2 && tag.wire === 2) limitedPush(preprocessing, parsePreprocessing(reader.sub()));
        else if (tag.field === 5 && tag.wire === 0) arrayMapping = reader.int32();
        else if (tag.field === 6 && tag.wire === 0) imageMapping = reader.int32();
        // Only NeuralNetworkClassifier declares these; the plain network and
        // the regressor never emit them, and a nested branch has no `model`.
        else if (tag.field === 100 && tag.wire === 2 && model) applyClassLabels(reader.sub(), model, 'string');
        else if (tag.field === 101 && tag.wire === 2 && model) applyClassLabels(reader.sub(), model, 'int64');
        else reader.skip(tag.wire);
    }
    // A NeuralNetwork names no inputs of its own: the model description does,
    // and the layers reference those feature names directly. A nested branch or
    // loop body has no description and inherits its operands from the enclosing
    // scope, which is why this only applies at the top level.
    if (model) graph.inputs = declaredInputs(model);
    const modes: string[] = [];
    if (arrayMapping >= 0) modes.push(arrayMapping === 1 ? 'EXACT_ARRAY_MAPPING' : 'RANK5_ARRAY_MAPPING');
    if (imageMapping >= 0) modes.push(imageMapping === 1 ? 'RANK4_IMAGE_MAPPING' : 'RANK5_IMAGE_MAPPING');
    graph.opset = modes.join(' · ');
    graph.description = preprocessing.map(item => `${item.key}: ${item.value}`).join(' · ');
    // A `NeuralNetwork` names no graph outputs of its own — the model
    // description names the features, and the network is wired by operand
    // name. The sinks are therefore the layer outputs nothing else consumes,
    // which is what the description's output features resolve to.
    const consumed = new Set<string>();
    for (const item of graph.nodes) for (const port of item.inputs) for (const value of port.values) consumed.add(value.text);
    // A declared output feature is an output even when a later layer consumes
    // it too — a feature extractor that exposes an embedding beside its logits
    // is exactly that — so the description is consulted alongside the sinks.
    const declared = new Set(model ? declaredOutputs(model).map(item => item.name) : []);
    const seen = new Set<string>();
    for (const item of graph.nodes) {
        for (const output of item.outputs) {
            if (seen.has(output.name)) continue;
            if (!consumed.has(output.name) || declared.has(output.name)) {
                seen.add(output.name);
                limitedPush(graph.outputs, output.name);
            }
        }
    }
    return graph.id;
}

/** The model's declared input features, as graph values. */
function declaredInputs(model: ParsedModel): CoremlValue[] {
    return primaryFeatures(model, 'inputs');
}

/** The model's declared output features, as graph values. */
function declaredOutputs(model: ParsedModel): CoremlValue[] {
    return primaryFeatures(model, 'outputs');
}

function primaryFeatures(model: ParsedModel, side: 'inputs' | 'outputs'): CoremlValue[] {
    const primary = model.functions.find(item => item.isDefault) ?? model.functions[0];
    return (primary?.[side] ?? []).map(feature => ({ name: feature.name, type: feature.type }));
}

function parsePreprocessing(reader: WireReader): CoremlEntry {
    reader.claimObject();
    let feature = '';
    let kind = '';
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) feature = reader.string();
        else if (tag.field === 10 && tag.wire === 2) { reader.skip(tag.wire); kind = 'scaler'; }
        else if (tag.field === 11 && tag.wire === 2) { reader.skip(tag.wire); kind = 'meanImage'; }
        else reader.skip(tag.wire);
    }
    return { key: feature, value: kind };
}

function parseLayer(reader: WireReader, graph: CoremlGraph, context: Context): CoremlNode {
    reader.claimObject();
    const node: CoremlNode = {
        id: `${graph.id}-layer${graph.nodes.length}`, graphId: graph.id, name: '', type: '',
        kind: 'layer', constant: false, custom: false, inputs: [], outputs: [],
        attributes: [], weights: [], graphs: [], updatable: false, description: ''
    };
    const operands: string[] = [];
    const outputs: string[] = [];
    let params: { field: number; reader: WireReader } | undefined;
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) node.name = reader.string();
        else if (tag.field === 2 && tag.wire === 2) limitedPush(operands, reader.string());
        else if (tag.field === 3 && tag.wire === 2) limitedPush(outputs, reader.string());
        else if (tag.field === 10 && tag.wire === 0) node.updatable = reader.bool();
        else if (LAYER_TYPES[tag.field] && tag.wire === 2) params = { field: tag.field, reader: reader.sub() };
        else reader.skip(tag.wire);
    }
    node.inputs = operands.map(value => ({ name: '', values: [{ text: value, variable: true }] }));
    node.outputs = outputs.map(name => ({ name, type: '' }));
    if (!node.name) node.name = outputs[0] ?? node.id;
    if (params) {
        node.type = LAYER_TYPES[params.field]!;
        applyLayerParams(node.type, params.reader, node, graph, context);
    } else {
        node.type = 'unknown';
        context.warnings.push({ key: 'coreml.warning.unknownLayer', args: { name: node.name } });
    }
    node.constant = node.type === 'loadConstant' || node.type === 'loadConstantND';
    node.custom = node.type === 'custom';
    return node;
}

function applyLayerParams(
    type: string,
    reader: WireReader,
    node: CoremlNode,
    graph: CoremlGraph,
    context: Context
): void {
    const nested = CONTROL_FLOW_LAYERS[type];
    if (nested) {
        // A branch or loop nests whole networks; they become child graphs
        // rather than being scanned for weights alongside plain parameters.
        const attributes = LAYER_SCHEMAS[type];
        while (!reader.done) {
            const tag = reader.tag();
            const branch = nested[tag.field];
            if (branch && tag.wire === 2) {
                const id = parseNeuralNetwork(
                    reader.sub(), context, `${node.name} · ${branch}`, graph.id, graph.depth + 1
                );
                node.graphs.push(id);
                node.attributes.push({ key: branch, value: branch });
            }
            else if (attributes) readSpecField(tag, reader, attributes, node.attributes);
            else reader.skip(tag.wire);
        }
        return;
    }
    const schema = LAYER_SCHEMAS[type];
    const names = LAYER_WEIGHT_NAMES[type];
    while (!reader.done) {
        const tag = reader.tag();
        // The schema is authoritative where it covers a field: a padding
        // submessage and a packed shape are both length-delimited, and probing
        // them for weights first would lose the attribute and invent a tensor.
        const spec = schema?.[tag.field];
        if (spec?.kind === 'w' && tag.wire === 2) {
            limitedPush(node.attributes, { key: spec.name, value: spec.label ?? spec.name });
            scanNestedWeights(reader.sub(), node, 1, spec.weights);
            continue;
        }
        if (spec) { readSpecField(tag, reader, schema!, node.attributes); continue; }
        if (tag.wire !== 2) { reader.skip(tag.wire); continue; }
        if (names) {
            // A mapped layer lists every `WeightParams` field it declares, so
            // anything outside the map — a parameter map, a nested option — is
            // not a weight and is never probed as one.
            const name = names[tag.field];
            if (name) {
                const weight = readWeightParams(reader.peek(), name);
                if (weight) limitedWeightPush(node.weights, weight);
            }
            reader.skip(tag.wire);
            continue;
        }
        const weight = readWeightParams(reader.peek(), `field ${tag.field}`);
        if (weight) {
            limitedWeightPush(node.weights, weight);
            reader.skip(tag.wire);
            continue;
        }
        scanNestedWeights(reader.sub(), node, 1);
    }
}

/**
 * Finds `WeightParams` nested deeper than a layer's own fields — recurrent
 * layers group their gate weights in an intermediate message, so a one-level
 * scan would miss every one of them.
 */
function scanNestedWeights(
    reader: WireReader,
    node: CoremlNode,
    depth: number,
    names?: Record<number, string>
): void {
    if (depth > MAX_WEIGHT_SCAN_DEPTH || node.weights.length >= MAX_LAYER_WEIGHTS) {
        return;
    }
    // Like `readWeightParams`, this walks bytes whose shape is unknown: a
    // length-delimited layer field is just as likely to be a packed repeated
    // scalar — `reduceSum.axes`, `tile.reps` — as a submessage, and reading
    // those as a message yields a nonsense tag. Failing to find a weight is the
    // ordinary outcome here, so it ends the scan of this subtree rather than
    // the parse of the model.
    try {
        while (!reader.done) {
            const tag = reader.tag();
            if (tag.wire !== 2) { reader.skip(tag.wire); continue; }
            const weight = readWeightParams(reader.peek(), names?.[tag.field] ?? `field ${tag.field}`);
            if (weight) {
                limitedWeightPush(node.weights, weight);
                reader.skip(tag.wire);
                continue;
            }
            scanNestedWeights(reader.sub(), node, depth + 1);
        }
    } catch (error) {
        if (!(error instanceof CoremlParseError)) throw error;
    }
}

/**
 * Reads a message as `WeightParams`, or returns undefined when it is not one.
 *
 * `WeightParams` uses a fixed, narrow field set, so requiring every field to fit
 * that set *and* at least one payload field to be present identifies it without
 * a per-layer schema. A message that carries anything else is rejected outright,
 * which is what keeps an unrelated submessage from being counted as a weight.
 */
function readWeightParams(reader: WireReader, name: string): CoremlWeight | undefined {
    let floats = 0;
    let bytes = 0n;
    let dataType = '';
    let quantization = '';
    let updatable = false;
    let payload = false;
    try {
        while (!reader.done) {
            const tag = reader.tag();
            if (tag.field === 1 && tag.wire === 2) {
                const packed = reader.bytes();
                if (packed.byteLength % 4 !== 0) return undefined;
                floats += packed.byteLength / 4;
                bytes += BigInt(packed.byteLength);
                dataType = 'FLOAT32';
                payload = payload || packed.byteLength > 0;
            }
            // `floatValue` is a proto3 `repeated float`, which protoc always
            // encodes packed. Accepting the unpacked wire-5 form as well would
            // make every message whose first field is a float — a leaky-ReLU
            // alpha, an epsilon — look like a one-element weight tensor.
            else if (tag.field === 2 && tag.wire === 2) {
                const raw = reader.bytes();
                bytes += BigInt(raw.byteLength);
                dataType = 'FLOAT16';
                payload = payload || raw.byteLength > 0;
            }
            else if (tag.field === 30 && tag.wire === 2) {
                const raw = reader.bytes();
                bytes += BigInt(raw.byteLength);
                dataType = dataType || 'RAW';
                payload = payload || raw.byteLength > 0;
            }
            else if (tag.field === 31 && tag.wire === 2) {
                const raw = reader.bytes();
                bytes += BigInt(raw.byteLength);
                dataType = 'INT8';
                payload = payload || raw.byteLength > 0;
            }
            else if (tag.field === 40 && tag.wire === 2) quantization = parseQuantization(reader.sub());
            else if (tag.field === 50 && tag.wire === 0) updatable = reader.bool();
            else return undefined;
        }
    } catch (error) {
        if (error instanceof CoremlParseError) return undefined;
        throw error;
    }
    if (!payload) return undefined;
    return {
        name,
        dataType: dataType || 'unknown',
        shape: [],
        elementCount: (dataType === 'FLOAT32' ? BigInt(floats) : 0n).toString(),
        byteLength: bytes.toString(),
        storage: 'inline',
        file: '',
        offset: '',
        quantization,
        updatable
    };
}

function parseQuantization(reader: WireReader): string {
    reader.claimObject();
    let bits = 0n;
    let kind = '';
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) bits = reader.uint64();
        else if (tag.field === 101 && tag.wire === 2) { reader.skip(tag.wire); kind = 'linear'; }
        else if (tag.field === 102 && tag.wire === 2) { reader.skip(tag.wire); kind = 'lookupTable'; }
        else reader.skip(tag.wire);
    }
    return kind ? `${kind} ${bits}-bit` : `${bits}-bit`;
}

/** Applies one schema-described field, or skips it when the shape disagrees. */
function readSpecField(
    tag: Tag,
    reader: WireReader,
    schema: Record<number, FieldSpec>,
    into: CoremlEntry[]
): void {
    const spec = schema[tag.field];
    if (!spec) { reader.skip(tag.wire); return; }
    const push = (value: string): void => { limitedPush(into, { key: spec.name, value }); };
    if (spec.kind === 'c') { reader.skip(tag.wire); push(spec.label ?? spec.name); return; }
    // These use the capped readers, which throw, rather than the `*Preview`
    // ones. Every repeated field in `LAYER_SCHEMAS` is rank-sized — a kernel
    // size, a stride, a target shape, an axis list — so a vector of 100 000
    // elements here is corruption, not a large model. The preview readers exist
    // for the places a real producer genuinely emits an enormous vector: an
    // immediate MIL tensor and a k-nearest-neighbour label list.
    if (spec.repeated && tag.wire === 2 && spec.kind !== 's') {
        const values = spec.kind === 'f'
            ? reader.packedFloat(MAX_ITEMS).map(formatNumber)
            : spec.kind === 'd'
                ? reader.packedDouble(MAX_ITEMS).map(formatNumber)
                : reader.packedVarint(MAX_ITEMS).map(item => formatVarint(item, spec.kind));
        push(`[${values.join(', ')}]`);
        return;
    }
    switch (spec.kind) {
        case 's': if (tag.wire === 2) push(reader.string()); else reader.skip(tag.wire); return;
        case 'f': if (tag.wire === 5) push(formatNumber(reader.float())); else reader.skip(tag.wire); return;
        case 'd': if (tag.wire === 1) push(formatNumber(reader.double())); else reader.skip(tag.wire); return;
        case 'e': {
            if (tag.wire !== 0) { reader.skip(tag.wire); return; }
            const index = reader.int32();
            push(spec.values?.[index] ?? String(index));
            return;
        }
        default:
            if (tag.wire !== 0) { reader.skip(tag.wire); return; }
            push(formatVarint(reader.uint64(), spec.kind));
    }
}

function formatVarint(value: bigint, kind: ScalarKind): string {
    if (kind === 'b') return value === 0n ? 'false' : 'true';
    if (kind === 'i') return BigInt.asIntN(64, value).toString();
    return value.toString();
}

function applyClassLabels(reader: WireReader, model: ParsedModel, kind: 'string' | 'int64'): void {
    reader.claimObject();
    const values: string[] = [];
    let total = 0;
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && kind === 'string' && tag.wire === 2) {
            // Past the retained budget the bytes are skipped rather than
            // decoded: a 200 000-entry gallery would otherwise charge the text
            // budget for 196 000 labels it immediately throws away.
            if (values.length < MAX_CLASS_LABELS) values.push(reader.string());
            else reader.skip(tag.wire);
            total++;
        }
        else if (tag.field === 1 && kind === 'int64' && tag.wire === 0) {
            const label = reader.int64().toString();
            total++;
            if (values.length < MAX_CLASS_LABELS) values.push(label);
        }
        else if (tag.field === 1 && kind === 'int64' && tag.wire === 2) {
            // A k-nearest-neighbour classifier carries one label per indexed
            // training sample, so this vector is routinely longer than the cap
            // a document would hold in full. It is summarized, not rejected.
            const read = reader.packedVarintPreview(Math.max(0, MAX_CLASS_LABELS - values.length));
            for (const item of read.values) values.push(BigInt.asIntN(64, item).toString());
            total += read.total;
        }
        else reader.skip(tag.wire);
    }
    model.classLabels = { kind, values, total };
}

/**
 * Class labels of the non-neural classifiers. GLM, support vector, tree
 * ensemble, and k-nearest-neighbour classifiers all declare the same
 * `oneof ClassLabels` at fields 100/101, so one reader serves them all.
 */
function applyVectorClassLabels(reader: WireReader, model: ParsedModel): void {
    reader.claimObject();
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 100 && tag.wire === 2) applyClassLabels(reader.sub(), model, 'string');
        else if (tag.field === 101 && tag.wire === 2) applyClassLabels(reader.sub(), model, 'int64');
        else reader.skip(tag.wire);
    }
}

function applyCustomModel(reader: WireReader, model: ParsedModel): void {
    reader.claimObject();
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 10 && tag.wire === 2) model.userDefined.push({ key: 'className', value: reader.string() });
        else if (tag.field === 40 && tag.wire === 2) model.userDefined.push({ key: 'customDescription', value: reader.string() });
        else reader.skip(tag.wire);
    }
}

// ── Pipelines ──────────────────────────────────────────────────────────────

function parsePipeline(
    reader: WireReader,
    field: number,
    model: ParsedModel,
    context: Context,
    depth: number
): string {
    reader.claimObject();
    // PipelineClassifier and PipelineRegressor wrap the Pipeline at field 1.
    let inner = reader;
    if (field !== 202) {
        let wrapped: WireReader | undefined;
        while (!reader.done) {
            const tag = reader.tag();
            if (tag.field === 1 && tag.wire === 2) wrapped = reader.sub();
            else reader.skip(tag.wire);
        }
        if (!wrapped) return '';
        inner = wrapped;
        inner.claimObject();
    }
    if (depth >= MAX_PIPELINE_DEPTH) {
        context.warnings.push({ key: 'coreml.warning.pipelineDepth', args: { limit: MAX_PIPELINE_DEPTH } });
        return '';
    }
    const graph = addGraph(context, {
        name: MODEL_TYPES[field] ?? 'pipeline', kind: 'pipeline', opset: '', parentId: '',
        depth: 0, inputs: declaredInputs(model),
        outputs: declaredOutputs(model).map(item => item.name),
        nodes: [], description: ''
    });
    const stages: ParsedModel[] = [];
    /** Range of `context.graphs` each stage created, for the depth shift below. */
    const stageGraphs: Array<{ start: number; end: number }> = [];
    const names: string[] = [];
    while (!inner.done) {
        const tag = inner.tag();
        if (tag.field === 1 && tag.wire === 2) {
            const start = context.graphs.length;
            limitedPush(stages, parseModel(inner.sub(), context, depth + 1));
            stageGraphs.push({ start, end: context.graphs.length });
        }
        else if (tag.field === 2 && tag.wire === 2) limitedPush(names, inner.string());
        else inner.skip(tag.wire);
    }
    stages.forEach((stage, index) => {
        const stageName = names[index] ?? `stage ${index}`;
        const primary = stage.functions.find(item => item.isDefault) ?? stage.functions[0];
        const node: CoremlNode = {
            id: `${graph.id}-stage${index}`, graphId: graph.id, name: stageName,
            type: MODEL_TYPES[stage.typeField] ?? 'unknown', kind: 'stage',
            constant: false, custom: false,
            inputs: (primary?.inputs ?? []).map(item => ({ name: item.name, values: [{ text: item.name, variable: true }] })),
            outputs: (primary?.outputs ?? []).map(item => ({ name: item.name, type: item.type })),
            attributes: [{ key: 'specificationVersion', value: String(stage.specificationVersion) }],
            weights: [], graphs: stage.rootGraphId ? [stage.rootGraphId] : [],
            updatable: stage.isUpdatable, description: stage.shortDescription
        };
        // A stage's own body already recorded graphs, all of them numbered as
        // if the stage were the top-level model. Reparent the stage's root
        // under the pipeline and shift the whole range it created, so a branch
        // arm nested inside a stage still reads as nested in the picker.
        const range = stageGraphs[index];
        if (range) {
            for (let position = range.start; position < range.end; position++) {
                context.graphs[position]!.depth += 1;
            }
        }
        const body = context.graphs.find(item => item.id === stage.rootGraphId);
        if (body) { body.parentId = graph.id; body.name = `${stageName} · ${body.name}`; }
        graph.nodes.push(node);
    });
    // A pipeline classifier declares no labels of its own — they belong to the
    // classifier it ends with, and that stage's own parse already read them.
    // Without this the class list is silently empty for exactly the models that
    // have one, Apple's own UpdatableDrawingClassifier among them.
    if (model.classLabels.kind === '') {
        const labelled = [...stages].reverse().find(stage => stage.classLabels.kind !== '');
        if (labelled) model.classLabels = labelled.classLabels;
    }
    if (stages.length === 0) context.warnings.push({ key: 'coreml.warning.emptyPipeline' });
    return graph.id;
}

// ── .mlpackage ─────────────────────────────────────────────────────────────

interface ZipEntry {
    name: string;
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
}

function isZip(data: Uint8Array): boolean {
    return data.byteLength >= 4 && data[0] === 0x50 && data[1] === 0x4b &&
        (data[2] === 0x03 || data[2] === 0x05) && (data[3] === 0x04 || data[3] === 0x06);
}

async function parseCoremlPackage(data: Uint8Array, options: CoremlParseOptions): Promise<CoremlDocument> {
    const directory = readZipDirectory(data);
    if (!directory) throw new CoremlParseError('The Core ML package archive could not be read.');
    throwIfAborted(options.signal);

    const warnings: CoremlWarning[] = [];
    if (directory.truncated) warnings.push({ key: 'coreml.warning.archiveEntryLimit', args: { limit: MAX_ZIP_ENTRIES } });

    // A bundle zipped from the Finder keeps its `Model.mlpackage/` folder, so
    // the manifest fixes the prefix every other member is resolved against.
    const manifestEntry = directory.entries
        .filter(entry => entry.name.endsWith('Manifest.json'))
        .sort((a, b) => a.name.length - b.name.length)[0];
    const prefix = manifestEntry ? manifestEntry.name.slice(0, manifestEntry.name.length - 'Manifest.json'.length) : '';

    let manifest: ManifestInfo | undefined;
    if (manifestEntry) {
        const bytes = await readMember(data, manifestEntry, MAX_MANIFEST_BYTES, options);
        // The member exists but could not be produced — deflated with no
        // inflater available, or larger than the manifest budget. Saying
        // nothing would leave the package view silently empty.
        if (!bytes) warnings.push({ key: 'coreml.warning.manifestUnreadable' });
        else manifest = decodeManifest(bytes, warnings);
    } else {
        warnings.push({ key: 'coreml.warning.manifestMissing' });
    }
    throwIfAborted(options.signal);

    const items = manifest ? manifest.items : [];
    const rootItem = items.find(item => item.isRoot) ?? items.find(item => item.path.endsWith('.mlmodel'));
    const modelPath = rootItem ? `${prefix}Data/${rootItem.path}` : findSpecEntry(directory.entries, prefix);
    const modelEntry = directory.entries.find(entry => entry.name === modelPath);
    if (!modelEntry) throw new CoremlParseError('The Core ML package does not contain a model specification.');

    const specBytes = await readMember(data, modelEntry, Number.POSITIVE_INFINITY, options);
    throwIfAborted(options.signal);
    if (!specBytes) throw new CoremlParseError('The Core ML package model specification could not be read.');

    const context = newContext();
    const specReader = new WireReader(specBytes);
    const model = parseModel(specReader, context, 0);
    if (specReader.textTruncated) context.warnings.push({ key: 'coreml.warning.textTruncated' });
    context.warnings.unshift(...warnings);

    // Byte totals per manifest item: a directory item sums the members below it.
    for (const item of items) {
        const base = `${prefix}Data/${item.path}`;
        let total = 0n;
        for (const entry of directory.entries) {
            if (entry.name === base || entry.name.startsWith(`${base}/`)) total += BigInt(entry.uncompressedSize);
        }
        item.byteLength = total.toString();
    }

    const pkg: CoremlPackage = {
        formatVersion: manifest?.formatVersion ?? '',
        rootIdentifier: manifest?.rootIdentifier ?? '',
        modelPath,
        items,
        files: directory.entries.map(entry => ({
            name: prefix && entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : entry.name,
            byteLength: String(entry.uncompressedSize),
            method: entry.method === 0 ? 'stored' : entry.method === 8 ? 'deflate' : String(entry.method)
        }))
    };
    return buildDocument(model, context, data.byteLength, true, pkg, name => {
        // `@model_path/weights/weight.bin` resolves against the package root.
        const relative = name.replace(/^@model_path\//, '');
        const entry = directory.entries.find(item => item.name === `${prefix}Data/com.apple.CoreML/${relative}`) ??
            directory.entries.find(item => item.name.endsWith(`/${relative}`) || item.name === relative);
        return entry ? String(entry.uncompressedSize) : '';
    });
}

function findSpecEntry(entries: ZipEntry[], prefix: string): string {
    const preferred = entries.find(entry => entry.name === `${prefix}Data/com.apple.CoreML/model.mlmodel`);
    if (preferred) return preferred.name;
    return entries.find(entry => entry.name.endsWith('.mlmodel'))?.name ?? '';
}

interface ManifestInfo {
    formatVersion: string;
    rootIdentifier: string;
    items: CoremlPackageItem[];
}

function decodeManifest(bytes: Uint8Array, warnings: CoremlWarning[]): ManifestInfo | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(decoder.decode(bytes)) as unknown;
    } catch {
        warnings.push({ key: 'coreml.warning.manifestInvalid' });
        return undefined;
    }
    if (!isRecord(parsed)) {
        warnings.push({ key: 'coreml.warning.manifestInvalid' });
        return undefined;
    }
    const rootIdentifier = asText(parsed['rootModelIdentifier']);
    const entries = parsed['itemInfoEntries'];
    const items: CoremlPackageItem[] = [];
    if (isRecord(entries)) {
        for (const [identifier, value] of Object.entries(entries)) {
            if (!isRecord(value)) continue;
            items.push({
                identifier,
                name: asText(value['name']),
                path: asText(value['path']),
                author: asText(value['author']),
                description: asText(value['description']),
                byteLength: '0',
                isRoot: identifier === rootIdentifier
            });
        }
    }
    return { formatVersion: asText(parsed['fileFormatVersion']), rootIdentifier, items };
}

/**
 * Reads one archive member. A stored member is viewed in place, so a
 * multi-gigabyte weight blob costs nothing; a deflated one needs the optional
 * JSZip dependency, which a package written by coremltools never requires.
 */
async function readMember(
    data: Uint8Array,
    entry: ZipEntry,
    limit: number,
    options: CoremlParseOptions
): Promise<Uint8Array | undefined> {
    if (entry.uncompressedSize > limit) return undefined;
    if (entry.method === 0) return sliceStoredEntry(data, entry);
    if (entry.method !== 8) return undefined;
    const module = await import('jszip').catch(() => undefined);
    throwIfAborted(options.signal);
    if (!module) return undefined;
    try {
        const archive = await module.default.loadAsync(data, { checkCRC32: false, createFolders: false });
        const file = archive.file(entry.name);
        return file ? await file.async('uint8array') : undefined;
    } catch (error) {
        if (options.signal?.aborted) throw error;
        return undefined;
    }
}

const EOCD_SIG = 0x06054b50;
const CDFH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/** Reads the central directory. ZIP64 and multi-disk archives return null. */
function readZipDirectory(data: Uint8Array): { entries: ZipEntry[]; truncated: boolean } | null {
    if (data.byteLength < 22) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let eocd = -1;
    for (let position = data.byteLength - 22; position >= Math.max(0, data.byteLength - (22 + 0xffff)); position--) {
        if (view.getUint32(position, true) !== EOCD_SIG) continue;
        if (position + 22 + view.getUint16(position + 20, true) !== data.byteLength) continue;
        eocd = position;
        break;
    }
    if (eocd < 0) return null;
    const declared = view.getUint16(eocd + 10, true);
    let position = view.getUint32(eocd + 16, true);
    if (declared === 0xffff || position === 0xffffffff) return null;

    const entries: ZipEntry[] = [];
    const count = Math.min(declared, MAX_ZIP_ENTRIES);
    for (let index = 0; index < count; index++) {
        if (position + 46 > data.byteLength || view.getUint32(position, true) !== CDFH_SIG) break;
        const nameLength = view.getUint16(position + 28, true);
        const extraLength = view.getUint16(position + 30, true);
        const commentLength = view.getUint16(position + 32, true);
        const nameStart = position + 46;
        if (nameStart + nameLength > data.byteLength) break;
        entries.push({
            name: decoder.decode(data.subarray(nameStart, nameStart + nameLength)),
            method: view.getUint16(position + 10, true),
            compressedSize: view.getUint32(position + 20, true),
            uncompressedSize: view.getUint32(position + 24, true),
            localHeaderOffset: view.getUint32(position + 42, true)
        });
        position = nameStart + nameLength + extraLength + commentLength;
    }
    return { entries, truncated: declared > count };
}

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

// ── Assembly ───────────────────────────────────────────────────────────────

function buildDocument(
    model: ParsedModel,
    context: Context,
    byteLength: number,
    packaged: boolean,
    pkg: CoremlPackage | undefined,
    blobSize?: (name: string) => string
): CoremlDocument {
    const modelType = MODEL_TYPES[model.typeField] ?? (model.typeField ? `type${model.typeField}` : 'unknown');
    const warnings = context.warnings;
    if (!AVAILABILITY[model.specificationVersion]) {
        warnings.push({ key: 'coreml.warning.specVersion', args: { version: model.specificationVersion } });
    }
    if (model.typeField === 0) warnings.push({ key: 'coreml.warning.noModelType' });
    const nodeCount = context.graphs.reduce((total, graph) => total + graph.nodes.length, 0);
    if (context.graphs.length > 0 && nodeCount === 0) warnings.push({ key: 'coreml.warning.emptyGraph' });

    const weightFiles: CoremlWeightFile[] = [...context.blobs.entries()].map(([name, record]) => {
        const size = blobSize?.(name) ?? '';
        return {
            name,
            referenceCount: record.references,
            referencedBytes: record.bytes.toString(),
            byteLength: size,
            present: size !== ''
        };
    });
    const missing = weightFiles.filter(file => !file.present);
    if (missing.length > 0) {
        warnings.push({
            key: packaged ? 'coreml.warning.blobMissing' : 'coreml.warning.blobUnavailable',
            args: { count: missing.length, names: missing.slice(0, 4).map(file => file.name).join(', ') }
        });
    }
    const customLayers = context.graphs.flatMap(graph => graph.nodes.filter(node => node.custom));
    if (customLayers.length > 0) {
        warnings.push({
            key: 'coreml.warning.customLayers',
            args: {
                count: customLayers.length,
                // `className` is the neural network's spelling, `class_name`
                // the ML Program's; a quoted immediate string keeps its quotes.
                names: customLayers.slice(0, 4).map(node => {
                    const declared = node.attributes.find(item => item.key === 'className' || item.key === 'class_name');
                    return declared ? declared.value.replace(/^"|"$/g, '') : node.name;
                }).join(', ')
            }
        });
    }
    if (modelType === 'serializedModel') warnings.push({ key: 'coreml.warning.serializedModel' });
    if (modelType === 'linkedModel') warnings.push({ key: 'coreml.warning.linkedModel' });

    const primary = model.functions.find(item => item.isDefault) ?? model.functions[0];
    return {
        format: 'coreml',
        title: model.shortDescription || modelType,
        fileSize: formatFileSize(byteLength),
        packaged,
        specificationVersion: model.specificationVersion,
        availability: AVAILABILITY[model.specificationVersion] ?? '',
        modelType,
        isUpdatable: model.isUpdatable,
        shortDescription: model.shortDescription,
        versionString: model.versionString,
        author: model.author,
        license: model.license,
        userDefined: model.userDefined,
        functions: model.functions,
        defaultFunctionName: model.defaultFunctionName || primary?.name || '',
        graphs: context.graphs,
        classLabels: model.classLabels,
        weightFiles,
        ...(pkg ? { package: pkg } : {}),
        summary: [
            { labelKey: 'coreml.summary.operations', value: nodeCount },
            { labelKey: 'coreml.summary.graphs', value: context.graphs.length },
            { labelKey: 'coreml.summary.inputs', value: primary?.inputs.length ?? 0 },
            { labelKey: 'coreml.summary.outputs', value: primary?.outputs.length ?? 0 },
            { labelKey: 'coreml.summary.functions', value: model.functions.length },
            { labelKey: 'coreml.summary.specVersion', value: model.specificationVersion }
        ],
        warnings
    };
}

function addGraph(context: Context, graph: Omit<CoremlGraph, 'id'>): CoremlGraph {
    if (context.graphs.length >= MAX_GRAPHS) throw new CoremlParseError('Core ML graph limit exceeded.');
    const created: CoremlGraph = { ...graph, id: `g${context.nextId++}` };
    context.graphs.push(created);
    return created;
}

function limitedPush<T>(items: T[], item: T): void {
    if (items.length >= MAX_ITEMS) throw new CoremlParseError('Core ML repeated-field item limit exceeded.');
    items.push(item);
}

function limitedWeightPush(items: CoremlWeight[], item: CoremlWeight): void {
    if (items.length < MAX_LAYER_WEIGHTS) items.push(item);
}

function listPreview(items: string[], limit: number, total = items.length): string {
    const visible = items.slice(0, limit);
    return total > limit ? `[${visible.join(', ')}, … (+${total - limit})]` : `[${visible.join(', ')}]`;
}

function bitLength(value: bigint): number {
    return value === 0n ? 0 : value.toString(2).length;
}

function formatNumber(value: number): string {
    return Number.isFinite(value) ? String(Number(value.toPrecision(7))) : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
    return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new CoremlParseError('Core ML parsing was aborted.');
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
