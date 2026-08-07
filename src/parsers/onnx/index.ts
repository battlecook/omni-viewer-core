/**
 * Dependency-free ONNX protobuf metadata reader.
 *
 * Tensor payloads are deliberately skipped: the viewer needs graph topology,
 * types, shapes, attributes, and storage metadata, not model weights in memory.
 * Field numbers follow the normative `onnx.proto` schema.
 */

export interface OnnxSummaryItem { labelKey: string; value: string | number }
export interface OnnxOpset { domain: string; version: string }
export interface OnnxMetadata { key: string; value: string }
export interface OnnxWarning { key: string; args?: Record<string, string | number> }

export interface OnnxValueInfo {
    name: string;
    type: string;
    typeInfo?: OnnxTypeInfo;
    description: string;
    metadata: OnnxMetadata[];
}

export interface OnnxDimensionInfo { value: string; denotation: string }
export interface OnnxTypeInfo {
    display: string;
    denotation: string;
    dimensions: OnnxDimensionInfo[];
    children: OnnxTypeInfo[];
}

export interface OnnxTensorSegment { begin: string; end: string }

export interface OnnxTensor {
    name: string;
    dataType: string;
    shape: string[];
    elementCount: string;
    dataBytes: string;
    location: 'embedded' | 'external';
    storage: 'dense' | 'sparse';
    segment?: OnnxTensorSegment;
    externalData: OnnxMetadata[];
    sparse?: {
        nonZeroCount: string;
        valuesShape: string[];
        indicesType: string;
        indicesShape: string[];
        indicesDataBytes: string;
        values: OnnxTensor;
        indices: OnnxTensor;
    };
    description: string;
    metadata: OnnxMetadata[];
}

export interface OnnxAttribute {
    name: string;
    type: string;
    value: string;
    reference: string;
    description: string;
    externalTensorCount: number;
    graphs?: OnnxGraph[];
    tensors?: OnnxTensor[];
    sparseTensors?: OnnxTensor[];
    typeProtos?: OnnxTypeInfo[];
    omitted?: { graphs: number; tensors: number; sparseTensors: number; typeProtos: number };
}

export interface OnnxTrainingInfo {
    initialization?: OnnxGraph;
    algorithm?: OnnxGraph;
    initializationBindings: OnnxMetadata[];
    updateBindings: OnnxMetadata[];
}

export interface OnnxDeviceConfiguration { name: string; numDevices: number; devices: string[] }
export interface OnnxDeviceGroup { index: string; devices: string[] }
export interface OnnxShardingSpec { tensorName: string; devices: string[]; deviceGroups: OnnxDeviceGroup[]; axes: string[] }
export interface OnnxNodeDeviceConfiguration { configurationId: string; pipelineStage: number; sharding: OnnxShardingSpec[] }
export interface OnnxQuantizationAnnotation { tensorName: string; parameters: OnnxMetadata[] }

export interface OnnxNode {
    id: string;
    name: string;
    operator: string;
    domain: string;
    overload: string;
    inputs: string[];
    outputs: string[];
    attributes: OnnxAttribute[];
    description: string;
    metadata: OnnxMetadata[];
    deviceConfigurations: OnnxNodeDeviceConfiguration[];
}

export interface OnnxFunction {
    name: string;
    domain: string;
    overload: string;
    inputs: string[];
    outputs: string[];
    attributes: string[];
    attributeDefaults: OnnxAttribute[];
    nodes: OnnxNode[];
    values: OnnxValueInfo[];
    opsets: OnnxOpset[];
    description: string;
    metadata: OnnxMetadata[];
}

export interface OnnxGraph {
    name: string;
    description: string;
    nodes: OnnxNode[];
    initializers: OnnxTensor[];
    inputs: OnnxValueInfo[];
    outputs: OnnxValueInfo[];
    values: OnnxValueInfo[];
    metadata: OnnxMetadata[];
    quantization: OnnxQuantizationAnnotation[];
}

export interface OnnxDocument {
    format: 'onnx';
    title: string;
    fileSize: string;
    irVersion: string;
    modelVersion: string;
    producer: string;
    domain: string;
    description: string;
    opsets: OnnxOpset[];
    functions: OnnxFunction[];
    trainingInfo: OnnxTrainingInfo[];
    configurations: OnnxDeviceConfiguration[];
    metadata: OnnxMetadata[];
    graph: OnnxGraph;
    summary: OnnxSummaryItem[];
    warnings: OnnxWarning[];
}

export class OnnxParseError extends Error {
    override readonly name = 'OnnxParseError';
}

const MAX_DEPTH = 64;
const MAX_FIELDS = 2_000_000;
const MAX_ITEMS = 100_000;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_TOTAL_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_ATTRIBUTE_ITEMS = 64;
const MAX_STRUCTURED_ATTRIBUTE_ITEMS = 1024;
const MAX_TENSOR_RANK = 1024;
const MAX_TENSOR_PRODUCT_BITS = 4096;
const MAX_PROTO_FIELD_NUMBER = 0x1fffffff;
const MAX_NORMALIZED_OBJECTS = 25_000;
const decoder = new TextDecoder('utf-8');

const DATA_TYPES: Record<number, string> = {
    0: 'UNDEFINED', 1: 'FLOAT', 2: 'UINT8', 3: 'INT8', 4: 'UINT16', 5: 'INT16',
    6: 'INT32', 7: 'INT64', 8: 'STRING', 9: 'BOOL', 10: 'FLOAT16', 11: 'DOUBLE',
    12: 'UINT32', 13: 'UINT64', 14: 'COMPLEX64', 15: 'COMPLEX128', 16: 'BFLOAT16',
    17: 'FLOAT8E4M3FN', 18: 'FLOAT8E4M3FNUZ', 19: 'FLOAT8E5M2', 20: 'FLOAT8E5M2FNUZ',
    21: 'UINT4', 22: 'INT4', 23: 'FLOAT4E2M1', 24: 'FLOAT8E8M0', 25: 'UINT2', 26: 'INT2'
};

const TYPE_BITS: Record<number, number> = {
    1: 32, 2: 8, 3: 8, 4: 16, 5: 16, 6: 32, 7: 64, 9: 8, 10: 16, 11: 64,
    12: 32, 13: 64, 14: 64, 15: 128, 16: 16, 17: 8, 18: 8, 19: 8, 20: 8,
    21: 4, 22: 4, 23: 4, 24: 8, 25: 2, 26: 2
};

const ATTRIBUTE_TYPES: Record<number, string> = {
    0: 'UNDEFINED', 1: 'FLOAT', 2: 'INT', 3: 'STRING', 4: 'TENSOR', 5: 'GRAPH',
    6: 'FLOATS', 7: 'INTS', 8: 'STRINGS', 9: 'TENSORS', 10: 'GRAPHS',
    11: 'SPARSE_TENSOR', 12: 'SPARSE_TENSORS', 13: 'TYPE_PROTO', 14: 'TYPE_PROTOS'
};

interface ParseState { fields: number; objects: number; textBytes: number }
interface Tag { field: number; wire: number }

class WireReader {
    private offset: number;

    constructor(
        private readonly data: Uint8Array,
        private readonly start = 0,
        readonly end = data.byteLength,
        private readonly depth = 0,
        private readonly state: ParseState = { fields: 0, objects: 0, textBytes: 0 }
    ) {
        this.offset = start;
        if (depth > MAX_DEPTH) throw new OnnxParseError('ONNX protobuf nesting is too deep.');
    }

    get done(): boolean { return this.offset >= this.end; }
    get remaining(): number { return this.end - this.offset; }

    claimObject(): void {
        if (++this.state.objects > MAX_NORMALIZED_OBJECTS) {
            throw new OnnxParseError('ONNX normalized-object limit exceeded.');
        }
    }

    tag(): Tag {
        if (++this.state.fields > MAX_FIELDS) throw new OnnxParseError('ONNX protobuf field limit exceeded.');
        const key = this.uint64();
        const field = Number(key >> 3n);
        const wire = Number(key & 7n);
        if (field <= 0 || field > MAX_PROTO_FIELD_NUMBER || wire > 5) throw new OnnxParseError('Invalid ONNX protobuf field tag.');
        return { field, wire };
    }

    uint64(): bigint {
        let value = 0n;
        for (let index = 0; index < 10; index++) {
            if (this.offset >= this.end) throw new OnnxParseError('Unexpected end of ONNX protobuf varint.');
            const byte = this.data[this.offset++]!;
            if (index === 9 && (byte & 0xfe) !== 0) throw new OnnxParseError('ONNX protobuf varint exceeds uint64.');
            value |= BigInt(byte & 0x7f) << BigInt(index * 7);
            if ((byte & 0x80) === 0) return value;
        }
        throw new OnnxParseError('Invalid ONNX protobuf varint.');
    }

    int64(): bigint { return BigInt.asIntN(64, this.uint64()); }
    int32(): number { return Number(BigInt.asIntN(32, this.uint64())); }

    fixed32(): number {
        this.require(4);
        const value = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 4).getFloat32(0, true);
        this.offset += 4;
        return value;
    }

    fixed64(): number {
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

    string(): string {
        return this.decodeText(this.bytes());
    }

    text(): string { return this.decodeText(this.bytes()); }

    sub(): WireReader {
        const length = this.length();
        const child = new WireReader(this.data, this.offset, this.offset + length, this.depth + 1, this.state);
        this.offset += length;
        return child;
    }

    packedInt64(limit = MAX_ITEMS): bigint[] {
        const child = this.sub();
        const values: bigint[] = [];
        while (!child.done) {
            if (values.length >= limit) throw new OnnxParseError('ONNX packed integer item limit exceeded.');
            values.push(child.int64());
        }
        return values;
    }

    packedFloat32(): number[] {
        const child = this.sub();
        const values: number[] = [];
        while (!child.done) limitedPush(values, child.fixed32());
        return values;
    }

    packedInt64Preview(limit: number): { values: bigint[]; truncated: boolean } {
        const child = this.sub();
        const values: bigint[] = [];
        while (!child.done && values.length < limit) values.push(child.int64());
        const truncated = !child.done;
        while (!child.done) child.uint64();
        return { values, truncated };
    }

    packedFloat32Preview(limit: number): { values: number[]; truncated: boolean } {
        const child = this.sub();
        const values: number[] = [];
        while (!child.done && values.length < limit) values.push(child.fixed32());
        const truncated = !child.done;
        if (child.remaining % 4 !== 0) throw new OnnxParseError('Packed ONNX float field has an invalid length.');
        return { values, truncated };
    }

    skip(wire: number): void {
        switch (wire) {
            case 0: this.uint64(); return;
            case 1: this.require(8); this.offset += 8; return;
            case 2: {
                const length = this.length();
                this.offset += length;
                return;
            }
            case 5: this.require(4); this.offset += 4; return;
            default: throw new OnnxParseError(`Unsupported ONNX protobuf wire type ${wire}.`);
        }
    }

    private length(): number {
        const raw = this.uint64();
        if (raw > BigInt(Number.MAX_SAFE_INTEGER)) throw new OnnxParseError('ONNX protobuf field is too large.');
        const length = Number(raw);
        this.require(length);
        return length;
    }

    private require(length: number): void {
        if (length < 0 || this.offset + length > this.end) throw new OnnxParseError('Truncated ONNX protobuf field.');
    }

    private decodeText(bytes: Uint8Array): string {
        if (bytes.byteLength > MAX_TEXT_BYTES) throw new OnnxParseError('ONNX text field exceeds the per-field limit.');
        this.state.textBytes += bytes.byteLength;
        if (this.state.textBytes > MAX_TOTAL_TEXT_BYTES) throw new OnnxParseError('ONNX cumulative text limit exceeded.');
        return decoder.decode(bytes);
    }
}

/** Parse an ONNX ModelProto without decoding tensor payload values. */
export function parseOnnx(data: Uint8Array): OnnxDocument {
    if (data.byteLength === 0) throw new OnnxParseError('The ONNX file is empty.');
    const reader = new WireReader(data);
    reader.claimObject();
    let irVersion = 0n;
    let modelVersion = 0n;
    let producerName = '';
    let producerVersion = '';
    let domain = '';
    let description = '';
    let graph: OnnxGraph | undefined;
    const opsets: OnnxOpset[] = [];
    const functions: OnnxFunction[] = [];
    const trainingInfo: OnnxTrainingInfo[] = [];
    const configurations: OnnxDeviceConfiguration[] = [];
    const metadata: OnnxMetadata[] = [];

    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) irVersion = reader.int64();
        else if (tag.field === 2 && tag.wire === 2) producerName = reader.string();
        else if (tag.field === 3 && tag.wire === 2) producerVersion = reader.string();
        else if (tag.field === 4 && tag.wire === 2) domain = reader.string();
        else if (tag.field === 5 && tag.wire === 0) modelVersion = reader.int64();
        else if (tag.field === 6 && tag.wire === 2) description = reader.string();
        else if (tag.field === 7 && tag.wire === 2) graph = parseGraph(reader.sub());
        else if (tag.field === 8 && tag.wire === 2) limitedPush(opsets, parseOpset(reader.sub()));
        else if (tag.field === 14 && tag.wire === 2) limitedPush(metadata, parseMetadata(reader.sub()));
        else if (tag.field === 20 && tag.wire === 2) limitedPush(trainingInfo, parseTrainingInfo(reader.sub()));
        else if (tag.field === 25 && tag.wire === 2) limitedPush(functions, parseFunction(reader.sub()));
        else if (tag.field === 26 && tag.wire === 2) limitedPush(configurations, parseDeviceConfiguration(reader.sub()));
        else if (tag.wire === 3 || tag.wire === 4) throw new OnnxParseError(`Unexpected top-level ONNX field ${tag.field} with wire type ${tag.wire}.`);
        else reader.skip(tag.wire);
    }

    if (irVersion <= 0n) throw new OnnxParseError('The file does not contain a valid ONNX IR version.');
    if (!graph) throw new OnnxParseError('The file does not contain an ONNX graph.');
    const warnings: OnnxWarning[] = [];
    if (opsets.length === 0) warnings.push({ key: 'onnx.warning.noOpset' });
    if (graph.nodes.length === 0) warnings.push({ key: 'onnx.warning.emptyGraph' });
    const externalCount = countExternalTensors(graph) + functions.reduce((total, fn) =>
        total + countExternalAttributes(fn.attributeDefaults) + fn.nodes.reduce((sum, node) => sum + countExternalAttributes(node.attributes), 0), 0) +
        trainingInfo.reduce((total, info) => total + (info.initialization ? countExternalTensors(info.initialization) : 0) + (info.algorithm ? countExternalTensors(info.algorithm) : 0), 0);
    if (externalCount > 0) warnings.push({ key: 'onnx.warning.externalData', args: { count: externalCount } });
    const producer = [producerName, producerVersion].filter(Boolean).join(' ');
    return {
        format: 'onnx',
        title: graph.name,
        fileSize: formatFileSize(data.byteLength),
        irVersion: irVersion.toString(),
        modelVersion: modelVersion.toString(),
        producer,
        domain,
        description,
        opsets,
        functions,
        trainingInfo,
        configurations,
        metadata,
        graph,
        summary: [
            { labelKey: 'onnx.summary.nodes', value: graph.nodes.length },
            { labelKey: 'onnx.summary.initializers', value: graph.initializers.length },
            { labelKey: 'onnx.summary.inputs', value: graph.inputs.length },
            { labelKey: 'onnx.summary.outputs', value: graph.outputs.length },
            { labelKey: 'onnx.summary.functions', value: functions.length },
            { labelKey: 'onnx.summary.irVersion', value: irVersion.toString() }
        ],
        warnings
    };
}

function parseGraph(reader: WireReader): OnnxGraph {
    reader.claimObject();
    let name = '';
    let description = '';
    const nodes: OnnxNode[] = [];
    const initializers: OnnxTensor[] = [];
    const inputs: OnnxValueInfo[] = [];
    const outputs: OnnxValueInfo[] = [];
    const values: OnnxValueInfo[] = [];
    const metadata: OnnxMetadata[] = [];
    const quantization: OnnxQuantizationAnnotation[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) limitedPush(nodes, parseNode(reader.sub(), nodes.length));
        else if (tag.field === 2 && tag.wire === 2) name = reader.string();
        else if (tag.field === 5 && tag.wire === 2) limitedPush(initializers, parseTensor(reader.sub()));
        else if (tag.field === 10 && tag.wire === 2) description = reader.string();
        else if (tag.field === 11 && tag.wire === 2) limitedPush(inputs, parseValueInfo(reader.sub()));
        else if (tag.field === 12 && tag.wire === 2) limitedPush(outputs, parseValueInfo(reader.sub()));
        else if (tag.field === 13 && tag.wire === 2) limitedPush(values, parseValueInfo(reader.sub()));
        else if (tag.field === 14 && tag.wire === 2) limitedPush(quantization, parseQuantizationAnnotation(reader.sub()));
        else if (tag.field === 15 && tag.wire === 2) limitedPush(initializers, parseSparseTensor(reader.sub()));
        else if (tag.field === 16 && tag.wire === 2) limitedPush(metadata, parseMetadata(reader.sub()));
        else reader.skip(tag.wire);
    }
    return { name, description, nodes, initializers, inputs, outputs, values, metadata, quantization };
}

function parseNode(reader: WireReader, index: number): OnnxNode {
    reader.claimObject();
    const inputs: string[] = [];
    const outputs: string[] = [];
    const attributes: OnnxAttribute[] = [];
    const metadata: OnnxMetadata[] = [];
    const deviceConfigurations: OnnxNodeDeviceConfiguration[] = [];
    let name = '';
    let operator = '';
    let domain = '';
    let overload = '';
    let description = '';
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) limitedPush(inputs, reader.string());
        else if (tag.field === 2 && tag.wire === 2) limitedPush(outputs, reader.string());
        else if (tag.field === 3 && tag.wire === 2) name = reader.string();
        else if (tag.field === 4 && tag.wire === 2) operator = reader.string();
        else if (tag.field === 5 && tag.wire === 2) limitedPush(attributes, parseAttribute(reader.sub()));
        else if (tag.field === 6 && tag.wire === 2) description = reader.string();
        else if (tag.field === 7 && tag.wire === 2) domain = reader.string();
        else if (tag.field === 8 && tag.wire === 2) overload = reader.string();
        else if (tag.field === 9 && tag.wire === 2) limitedPush(metadata, parseMetadata(reader.sub()));
        else if (tag.field === 10 && tag.wire === 2) limitedPush(deviceConfigurations, parseNodeDeviceConfiguration(reader.sub()));
        else reader.skip(tag.wire);
    }
    return { id: `node-${index}`, name, operator, domain, overload, inputs, outputs, attributes, description, metadata, deviceConfigurations };
}

function parseAttribute(reader: WireReader): OnnxAttribute {
    reader.claimObject();
    let name = '';
    let reference = '';
    let description = '';
    let declaredType = 0;
    let inferredType = '';
    let value = '';
    let externalTensorCount = 0;
    const floats: number[] = [];
    const ints: bigint[] = [];
    const strings: string[] = [];
    const tensorValues: OnnxTensor[] = [];
    const graphValues: OnnxGraph[] = [];
    const sparseTensorValues: OnnxTensor[] = [];
    const typeProtos: OnnxTypeInfo[] = [];
    const omitted = { graphs: 0, tensors: 0, sparseTensors: 0, typeProtos: 0 };
    const truncated = new Set<string>();
    const preview = <T>(key: string, items: T[], item: T): void => {
        if (limitedPreviewPush(items, item)) truncated.add(key);
    };
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) name = reader.string();
        else if (tag.field === 2 && tag.wire === 5) { value = formatNumber(reader.fixed32()); inferredType = 'FLOAT'; }
        else if (tag.field === 3 && tag.wire === 0) { value = reader.int64().toString(); inferredType = 'INT'; }
        else if (tag.field === 4 && tag.wire === 2) { value = reader.text(); inferredType = 'STRING'; }
        else if (tag.field === 5 && tag.wire === 2) {
            const tensor = parseTensor(reader.sub());
            if (tensor.location === 'external') externalTensorCount++;
            if (tensorValues.length < MAX_STRUCTURED_ATTRIBUTE_ITEMS) tensorValues.push(tensor); else omitted.tensors++;
            inferredType = 'TENSOR';
        }
        else if (tag.field === 6 && tag.wire === 2) {
            const graph = parseGraph(reader.sub());
            externalTensorCount += countExternalTensors(graph);
            if (graphValues.length < MAX_STRUCTURED_ATTRIBUTE_ITEMS) graphValues.push(graph); else omitted.graphs++;
            inferredType = 'GRAPH';
        }
        else if (tag.field === 7 && tag.wire === 5) { preview('floats', floats, reader.fixed32()); inferredType = 'FLOATS'; }
        else if (tag.field === 7 && tag.wire === 2) {
            const packed = reader.packedFloat32Preview(MAX_ATTRIBUTE_ITEMS + 1);
            for (const item of packed.values) preview('floats', floats, item);
            if (packed.truncated) truncated.add('floats');
            inferredType = 'FLOATS';
        }
        else if (tag.field === 8 && tag.wire === 0) { preview('ints', ints, reader.int64()); inferredType = 'INTS'; }
        else if (tag.field === 8 && tag.wire === 2) {
            const packed = reader.packedInt64Preview(MAX_ATTRIBUTE_ITEMS + 1);
            for (const item of packed.values) preview('ints', ints, item);
            if (packed.truncated) truncated.add('ints');
            inferredType = 'INTS';
        }
        else if (tag.field === 9 && tag.wire === 2) { preview('strings', strings, reader.text()); inferredType = 'STRINGS'; }
        else if (tag.field === 10 && tag.wire === 2) {
            const tensor = parseTensor(reader.sub());
            if (tensor.location === 'external') externalTensorCount++;
            if (tensorValues.length < MAX_STRUCTURED_ATTRIBUTE_ITEMS) tensorValues.push(tensor); else omitted.tensors++;
            inferredType = 'TENSORS';
        }
        else if (tag.field === 11 && tag.wire === 2) {
            const graph = parseGraph(reader.sub());
            externalTensorCount += countExternalTensors(graph);
            if (graphValues.length < MAX_STRUCTURED_ATTRIBUTE_ITEMS) graphValues.push(graph); else omitted.graphs++;
            inferredType = 'GRAPHS';
        }
        else if (tag.field === 13 && tag.wire === 2) description = reader.string();
        else if (tag.field === 14 && tag.wire === 2) {
            const type = parseType(reader.sub());
            value = type.display;
            if (typeProtos.length < MAX_STRUCTURED_ATTRIBUTE_ITEMS) typeProtos.push(type); else omitted.typeProtos++;
            inferredType = 'TYPE_PROTO';
        }
        else if (tag.field === 15 && tag.wire === 2) {
            const type = parseType(reader.sub());
            if (typeProtos.length < MAX_STRUCTURED_ATTRIBUTE_ITEMS) typeProtos.push(type); else omitted.typeProtos++;
            inferredType = 'TYPE_PROTOS';
        }
        else if (tag.field === 20 && tag.wire === 0) declaredType = reader.int32();
        else if (tag.field === 21 && tag.wire === 2) reference = reader.string();
        else if (tag.field === 22 && tag.wire === 2) {
            const tensor = parseSparseTensor(reader.sub());
            if (tensor.location === 'external') externalTensorCount++;
            if (sparseTensorValues.length < MAX_STRUCTURED_ATTRIBUTE_ITEMS) sparseTensorValues.push(tensor); else omitted.sparseTensors++;
            inferredType = 'SPARSE_TENSOR';
        }
        else if (tag.field === 23 && tag.wire === 2) {
            const tensor = parseSparseTensor(reader.sub());
            if (tensor.location === 'external') externalTensorCount++;
            if (sparseTensorValues.length < MAX_STRUCTURED_ATTRIBUTE_ITEMS) sparseTensorValues.push(tensor); else omitted.sparseTensors++;
            inferredType = 'SPARSE_TENSORS';
        }
        else reader.skip(tag.wire);
    }
    if (floats.length) value = listPreview(floats.map(formatNumber), truncated.has('floats'));
    else if (ints.length) value = listPreview(ints.map(item => item.toString()), truncated.has('ints'));
    else if (strings.length) value = listPreview(strings, truncated.has('strings'));
    else if (tensorValues.length) value = listPreview(tensorValues.slice(0, MAX_ATTRIBUTE_ITEMS).map(tensorSummary), tensorValues.length > MAX_ATTRIBUTE_ITEMS || omitted.tensors > 0);
    else if (graphValues.length) value = listPreview(graphValues.slice(0, MAX_ATTRIBUTE_ITEMS).map(graphSummary), graphValues.length > MAX_ATTRIBUTE_ITEMS || omitted.graphs > 0);
    else if (sparseTensorValues.length) value = listPreview(sparseTensorValues.slice(0, MAX_ATTRIBUTE_ITEMS).map(sparseTensorSummary), sparseTensorValues.length > MAX_ATTRIBUTE_ITEMS || omitted.sparseTensors > 0);
    else if (typeProtos.length && inferredType === 'TYPE_PROTOS') value = listPreview(typeProtos.slice(0, MAX_ATTRIBUTE_ITEMS).map(type => type.display), typeProtos.length > MAX_ATTRIBUTE_ITEMS || omitted.typeProtos > 0);
    else if (reference) value = `$ref(${reference})`;
    return {
        name, type: ATTRIBUTE_TYPES[declaredType] ?? (inferredType || 'UNDEFINED'), value,
        reference, description, externalTensorCount,
        ...(graphValues.length ? { graphs: graphValues } : {}),
        ...(tensorValues.length ? { tensors: tensorValues } : {}),
        ...(sparseTensorValues.length ? { sparseTensors: sparseTensorValues } : {}),
        ...(typeProtos.length ? { typeProtos } : {}),
        ...(omitted.graphs || omitted.tensors || omitted.sparseTensors || omitted.typeProtos ? { omitted } : {})
    };
}

function parseTensor(reader: WireReader): OnnxTensor {
    reader.claimObject();
    const dims: bigint[] = [];
    const externalData: OnnxMetadata[] = [];
    const metadata: OnnxMetadata[] = [];
    let dataType = 0;
    let name = '';
    let description = '';
    let rawBytes = 0;
    let stringDataBytes = 0n;
    let location: 'embedded' | 'external' = 'embedded';
    let segment: OnnxTensorSegment | undefined;
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) pushTensorDim(dims, reader.int64());
        else if (tag.field === 1 && tag.wire === 2) for (const dim of reader.packedInt64(MAX_TENSOR_RANK)) pushTensorDim(dims, dim);
        else if (tag.field === 2 && tag.wire === 0) dataType = reader.int32();
        else if (tag.field === 3 && tag.wire === 2) segment = parseTensorSegment(reader.sub());
        else if (tag.field === 6 && tag.wire === 2) stringDataBytes += BigInt(reader.bytes().byteLength);
        else if (tag.field === 8 && tag.wire === 2) name = reader.string();
        else if (tag.field === 9 && tag.wire === 2) rawBytes = reader.bytes().byteLength;
        else if (tag.field === 12 && tag.wire === 2) description = reader.string();
        else if (tag.field === 13 && tag.wire === 2) limitedPush(externalData, parseMetadata(reader.sub()));
        else if (tag.field === 14 && tag.wire === 0) location = Number(reader.uint64()) === 1 ? 'external' : 'embedded';
        else if (tag.field === 16 && tag.wire === 2) limitedPush(metadata, parseMetadata(reader.sub()));
        else reader.skip(tag.wire);
    }
    const elementCount = tensorElementCount(dims);
    const externalLength = externalData.find(item => item.key === 'length')?.value;
    const inferredBytes = TYPE_BITS[dataType] ? (elementCount * BigInt(TYPE_BITS[dataType]!) + 7n) / 8n : 0n;
    const dataBytes = externalLength && /^\d+$/.test(externalLength)
        ? externalLength
        : rawBytes > 0 ? String(rawBytes) : dataType === 8 ? stringDataBytes.toString() : inferredBytes.toString();
    return {
        name,
        dataType: DATA_TYPES[dataType] ?? `TYPE_${dataType}`,
        shape: dims.map(dim => dim.toString()),
        elementCount: elementCount.toString(),
        dataBytes,
        location,
        storage: 'dense',
        ...(segment ? { segment } : {}),
        externalData,
        description,
        metadata
    };
}

function parseTensorSegment(reader: WireReader): OnnxTensorSegment {
    reader.claimObject();
    let begin = '0';
    let end = '0';
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) begin = reader.int64().toString();
        else if (tag.field === 2 && tag.wire === 0) end = reader.int64().toString();
        else reader.skip(tag.wire);
    }
    return { begin, end };
}

function parseSparseTensor(reader: WireReader): OnnxTensor {
    reader.claimObject();
    let values: OnnxTensor | undefined;
    let indices: OnnxTensor | undefined;
    const dims: bigint[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) values = parseTensor(reader.sub());
        else if (tag.field === 2 && tag.wire === 2) indices = parseTensor(reader.sub());
        else if (tag.field === 3 && tag.wire === 0) pushTensorDim(dims, reader.int64());
        else if (tag.field === 3 && tag.wire === 2) for (const dim of reader.packedInt64(MAX_TENSOR_RANK)) pushTensorDim(dims, dim);
        else reader.skip(tag.wire);
    }
    const denseElements = tensorElementCount(dims);
    const value = values ?? emptyTensor();
    const index = indices ?? emptyTensor();
    const externalData = [
        ...value.externalData.map(item => ({ key: `values.${item.key}`, value: item.value })),
        ...index.externalData.map(item => ({ key: `indices.${item.key}`, value: item.value }))
    ];
    return {
        name: value.name,
        dataType: value.dataType,
        shape: dims.map(dim => dim.toString()),
        elementCount: denseElements.toString(),
        dataBytes: addDecimalStrings(value.dataBytes, index.dataBytes),
        location: value.location === 'external' || index.location === 'external' ? 'external' : 'embedded',
        storage: 'sparse',
        externalData,
        sparse: {
            nonZeroCount: value.elementCount,
            valuesShape: value.shape,
            indicesType: index.dataType,
            indicesShape: index.shape,
            indicesDataBytes: index.dataBytes,
            values: value,
            indices: index
        },
        description: value.description,
        metadata: value.metadata
    };
}

function emptyTensor(): OnnxTensor {
    return {
        name: '', dataType: 'UNDEFINED', shape: [], elementCount: '0', dataBytes: '0',
        location: 'embedded', storage: 'dense', externalData: [], description: '', metadata: []
    };
}

function addDecimalStrings(left: string, right: string): string {
    return /^\d+$/.test(left) && /^\d+$/.test(right) ? (BigInt(left) + BigInt(right)).toString() : '0';
}

function pushTensorDim(dims: bigint[], dim: bigint): void {
    if (dim < 0n) throw new OnnxParseError('ONNX tensor dimensions must not be negative.');
    if (dims.length >= MAX_TENSOR_RANK) throw new OnnxParseError(`ONNX tensor rank exceeds ${MAX_TENSOR_RANK}.`);
    dims.push(dim);
}

function tensorElementCount(dims: bigint[]): bigint {
    let count = 1n;
    for (const dim of dims) {
        if (dim === 0n) return 0n;
        if (bitLength(count) + bitLength(dim) > MAX_TENSOR_PRODUCT_BITS + 1) {
            throw new OnnxParseError('ONNX tensor element count is too large to display safely.');
        }
        count *= dim;
        if (bitLength(count) > MAX_TENSOR_PRODUCT_BITS) throw new OnnxParseError('ONNX tensor element count is too large to display safely.');
    }
    return count;
}

function bitLength(value: bigint): number {
    return value === 0n ? 0 : value.toString(2).length;
}

function parseValueInfo(reader: WireReader): OnnxValueInfo {
    reader.claimObject();
    let name = '';
    let typeInfo: OnnxTypeInfo = unknownTypeInfo();
    let description = '';
    const metadata: OnnxMetadata[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) name = reader.string();
        else if (tag.field === 2 && tag.wire === 2) typeInfo = parseType(reader.sub());
        else if (tag.field === 3 && tag.wire === 2) description = reader.string();
        else if (tag.field === 4 && tag.wire === 2) limitedPush(metadata, parseMetadata(reader.sub()));
        else reader.skip(tag.wire);
    }
    return { name, type: typeInfo.display, typeInfo, description, metadata };
}

function parseType(reader: WireReader): OnnxTypeInfo {
    reader.claimObject();
    let type = unknownTypeInfo();
    let denotation = '';
    while (!reader.done) {
        const tag = reader.tag();
        if ((tag.field === 1 || tag.field === 8) && tag.wire === 2) type = parseTensorType(reader.sub(), tag.field === 8);
        else if ((tag.field === 4 || tag.field === 9) && tag.wire === 2) {
            const child = parseNestedType(reader.sub());
            type = { display: `${tag.field === 4 ? 'sequence' : 'optional'}<${child.display}>`, denotation: '', dimensions: [], children: [child] };
        }
        else if (tag.field === 5 && tag.wire === 2) type = parseMapType(reader.sub());
        else if (tag.field === 6 && tag.wire === 2) denotation = reader.string();
        else reader.skip(tag.wire);
    }
    return { ...type, denotation };
}

function parseTensorType(reader: WireReader, sparse: boolean): OnnxTypeInfo {
    let elementType = 0;
    let shape: OnnxDimensionInfo[] | undefined;
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) elementType = reader.int32();
        else if (tag.field === 2 && tag.wire === 2) shape = parseShape(reader.sub());
        else reader.skip(tag.wire);
    }
    const prefix = sparse ? 'sparse_tensor' : 'tensor';
    return {
        display: `${prefix}<${DATA_TYPES[elementType] ?? `TYPE_${elementType}`}${shape ? `[${shape.map(item => item.value).join(', ')}]` : ''}>`,
        denotation: '', dimensions: shape ?? [], children: []
    };
}

function parseNestedType(reader: WireReader): OnnxTypeInfo {
    let type = unknownTypeInfo();
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) type = parseType(reader.sub());
        else reader.skip(tag.wire);
    }
    return type;
}

function parseMapType(reader: WireReader): OnnxTypeInfo {
    let keyType = 0;
    let valueType = unknownTypeInfo();
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) keyType = reader.int32();
        else if (tag.field === 2 && tag.wire === 2) valueType = parseType(reader.sub());
        else reader.skip(tag.wire);
    }
    return {
        display: `map<${DATA_TYPES[keyType] ?? `TYPE_${keyType}`}, ${valueType.display}>`,
        denotation: '', dimensions: [], children: [valueType]
    };
}

function unknownTypeInfo(): OnnxTypeInfo {
    return { display: 'unknown', denotation: '', dimensions: [], children: [] };
}

function parseShape(reader: WireReader): OnnxDimensionInfo[] {
    const shape: OnnxDimensionInfo[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) limitedPush(shape, parseDimension(reader.sub()));
        else reader.skip(tag.wire);
    }
    return shape;
}

function parseDimension(reader: WireReader): OnnxDimensionInfo {
    reader.claimObject();
    let value = '?';
    let denotation = '';
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) value = reader.int64().toString();
        else if (tag.field === 2 && tag.wire === 2) value = reader.string() || '?';
        else if (tag.field === 3 && tag.wire === 2) denotation = reader.string();
        else reader.skip(tag.wire);
    }
    return { value, denotation };
}

function parseTrainingInfo(reader: WireReader): OnnxTrainingInfo {
    reader.claimObject();
    let initialization: OnnxGraph | undefined;
    let algorithm: OnnxGraph | undefined;
    const initializationBindings: OnnxMetadata[] = [];
    const updateBindings: OnnxMetadata[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) initialization = parseGraph(reader.sub());
        else if (tag.field === 2 && tag.wire === 2) algorithm = parseGraph(reader.sub());
        else if (tag.field === 3 && tag.wire === 2) limitedPush(initializationBindings, parseMetadata(reader.sub()));
        else if (tag.field === 4 && tag.wire === 2) limitedPush(updateBindings, parseMetadata(reader.sub()));
        else reader.skip(tag.wire);
    }
    return { ...(initialization ? { initialization } : {}), ...(algorithm ? { algorithm } : {}), initializationBindings, updateBindings };
}

function parseDeviceConfiguration(reader: WireReader): OnnxDeviceConfiguration {
    reader.claimObject();
    let name = '';
    let numDevices = 0;
    const devices: string[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) name = reader.string();
        else if (tag.field === 2 && tag.wire === 0) numDevices = reader.int32();
        else if (tag.field === 3 && tag.wire === 2) limitedPush(devices, reader.string());
        else reader.skip(tag.wire);
    }
    return { name, numDevices, devices };
}

function parseQuantizationAnnotation(reader: WireReader): OnnxQuantizationAnnotation {
    reader.claimObject();
    let tensorName = '';
    const parameters: OnnxMetadata[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) tensorName = reader.string();
        else if (tag.field === 2 && tag.wire === 2) limitedPush(parameters, parseMetadata(reader.sub()));
        else reader.skip(tag.wire);
    }
    return { tensorName, parameters };
}

function parseNodeDeviceConfiguration(reader: WireReader): OnnxNodeDeviceConfiguration {
    reader.claimObject();
    let configurationId = '';
    let pipelineStage = 0;
    const sharding: OnnxShardingSpec[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) configurationId = reader.string();
        else if (tag.field === 2 && tag.wire === 2) limitedPush(sharding, parseShardingSpec(reader.sub()));
        else if (tag.field === 3 && tag.wire === 0) pipelineStage = reader.int32();
        else reader.skip(tag.wire);
    }
    return { configurationId, pipelineStage, sharding };
}

function parseShardingSpec(reader: WireReader): OnnxShardingSpec {
    reader.claimObject();
    let tensorName = '';
    const devices: string[] = [];
    const deviceGroups: OnnxDeviceGroup[] = [];
    const axes: string[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) tensorName = reader.string();
        else if (tag.field === 2 && tag.wire === 0) limitedPush(devices, reader.int64().toString());
        else if (tag.field === 2 && tag.wire === 2) for (const device of reader.packedInt64()) limitedPush(devices, device.toString());
        else if (tag.field === 3 && tag.wire === 2) limitedPush(deviceGroups, parseDeviceGroup(reader.sub()));
        else if (tag.field === 4 && tag.wire === 2) limitedPush(axes, parseShardedAxis(reader.sub()));
        else reader.skip(tag.wire);
    }
    return { tensorName, devices, deviceGroups, axes };
}

function parseDeviceGroup(reader: WireReader): OnnxDeviceGroup {
    reader.claimObject();
    let index = '0';
    const devices: string[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) index = reader.int64().toString();
        else if (tag.field === 2 && tag.wire === 0) limitedPush(devices, reader.int64().toString());
        else if (tag.field === 2 && tag.wire === 2) for (const device of reader.packedInt64()) limitedPush(devices, device.toString());
        else reader.skip(tag.wire);
    }
    return { index, devices };
}

function parseShardedAxis(reader: WireReader): string {
    let axis = '0';
    const parts: string[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) axis = reader.int64().toString();
        else if (tag.field === 2 && tag.wire === 2) limitedPush(parts, parseSimpleSharding(reader.sub()));
        else reader.skip(tag.wire);
    }
    return `${axis}:${parts.join('+')}`;
}

function parseSimpleSharding(reader: WireReader): string {
    let dimension = '?';
    let shards = '0';
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 0) dimension = reader.int64().toString();
        else if (tag.field === 2 && tag.wire === 2) dimension = reader.string();
        else if (tag.field === 3 && tag.wire === 0) shards = reader.int64().toString();
        else reader.skip(tag.wire);
    }
    return `${dimension}/${shards}`;
}

function parseFunction(reader: WireReader): OnnxFunction {
    reader.claimObject();
    let name = '';
    let domain = '';
    let overload = '';
    let description = '';
    const inputs: string[] = [];
    const outputs: string[] = [];
    const attributes: string[] = [];
    const attributeDefaults: OnnxAttribute[] = [];
    const nodes: OnnxNode[] = [];
    const values: OnnxValueInfo[] = [];
    const opsets: OnnxOpset[] = [];
    const metadata: OnnxMetadata[] = [];
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) name = reader.string();
        else if (tag.field === 4 && tag.wire === 2) limitedPush(inputs, reader.string());
        else if (tag.field === 5 && tag.wire === 2) limitedPush(outputs, reader.string());
        else if (tag.field === 6 && tag.wire === 2) limitedPush(attributes, reader.string());
        else if (tag.field === 7 && tag.wire === 2) limitedPush(nodes, parseNode(reader.sub(), nodes.length));
        else if (tag.field === 8 && tag.wire === 2) description = reader.string();
        else if (tag.field === 9 && tag.wire === 2) limitedPush(opsets, parseOpset(reader.sub()));
        else if (tag.field === 10 && tag.wire === 2) domain = reader.string();
        else if (tag.field === 11 && tag.wire === 2) limitedPush(attributeDefaults, parseAttribute(reader.sub()));
        else if (tag.field === 12 && tag.wire === 2) limitedPush(values, parseValueInfo(reader.sub()));
        else if (tag.field === 13 && tag.wire === 2) overload = reader.string();
        else if (tag.field === 14 && tag.wire === 2) limitedPush(metadata, parseMetadata(reader.sub()));
        else reader.skip(tag.wire);
    }
    return { name, domain, overload, inputs, outputs, attributes, attributeDefaults, nodes, values, opsets, description, metadata };
}

function parseOpset(reader: WireReader): OnnxOpset {
    reader.claimObject();
    let domain = '';
    let version = '0';
    while (!reader.done) {
        const tag = reader.tag();
        if (tag.field === 1 && tag.wire === 2) domain = reader.string();
        else if (tag.field === 2 && tag.wire === 0) version = reader.int64().toString();
        else reader.skip(tag.wire);
    }
    return { domain: domain || 'ai.onnx', version };
}

function parseMetadata(reader: WireReader): OnnxMetadata {
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

function limitedPush<T>(items: T[], item: T): void {
    if (items.length >= MAX_ITEMS) throw new OnnxParseError('ONNX repeated-field item limit exceeded.');
    items.push(item);
}

function limitedPreviewPush<T>(items: T[], item: T): boolean {
    if (items.length < MAX_ATTRIBUTE_ITEMS) { items.push(item); return false; }
    return true;
}

function listPreview(items: string[], truncated = false): string {
    return `[${items.join(', ')}${truncated ? ', …' : ''}]`;
}

function tensorSummary(tensor: OnnxTensor): string {
    return `${tensor.dataType}[${tensor.shape.join(' × ')}]`;
}

function sparseTensorSummary(tensor: OnnxTensor): string {
    return `${tensorSummary(tensor)} · nnz=${tensor.sparse?.nonZeroCount ?? '0'}`;
}

function graphSummary(graph: OnnxGraph): string {
    return `${graph.name} · nodes=${graph.nodes.length}`;
}

function countExternalTensors(graph: OnnxGraph): number {
    return graph.initializers.filter(tensor => tensor.location === 'external').length +
        graph.nodes.reduce((total, node) => total + countExternalAttributes(node.attributes), 0);
}

function countExternalAttributes(attributes: OnnxAttribute[]): number {
    return attributes.reduce((total, attribute) => total + attribute.externalTensorCount, 0);
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
