/**
 * Dependency-free OpenVINO IR reader.
 *
 * An IR is two files. The `.xml` is ordinary XML whose root is
 * `<net name version>` holding `<layers>` and `<edges>`; the `.bin` has no
 * header, magic, or index of its own — it is a raw concatenation of constant
 * payloads that `Const` layers address by `offset` and `size`. The topology is
 * read in full here; the weights, when the host supplies the neighbouring
 * `.bin`, are only range-checked and sampled for a short value preview, so a
 * multi-gigabyte model costs nothing beyond its XML.
 *
 * IR v10 and v11 (OpenVINO 2020.1 and newer) are the target; the legacy v7-
 * and-earlier layout (`<layer precision>` with `<blobs>`) is read on a
 * best-effort basis and flagged.
 */

export interface OpenVinoSummaryItem { labelKey: string; value: string | number }
export interface OpenVinoMetadata { key: string; value: string }
export interface OpenVinoWarning { key: string; args?: Record<string, string | number> }

export interface OpenVinoPort {
    id: string;
    precision: string;
    /** Tensor names an output port carries (`names` attribute, comma separated). */
    names: string[];
    dims: string[];
    rtInfo: OpenVinoMetadata[];
}

export type OpenVinoConstantStatus = 'unchecked' | 'available' | 'out-of-range' | 'invalid';

export interface OpenVinoConstant {
    layerId: string;
    layerName: string;
    /** 'data' for a Const layer; a legacy blob's tag name otherwise (weights, biases, …). */
    kind: string;
    elementType: string;
    shape: string[];
    elementCount: number;
    offset: number;
    size: number;
    /** 'unchecked' until a .bin is supplied; then whether [offset, offset+size) fits. */
    status: OpenVinoConstantStatus;
    /** Leading decoded values when the .bin is present and the type is readable. */
    preview: string[];
}

export interface OpenVinoLayer {
    id: string;
    name: string;
    type: string;
    /** Opset the layer's semantics come from (`version` attribute). */
    version: string;
    /** `<data>` attributes, in document order. */
    attributes: OpenVinoMetadata[];
    inputs: OpenVinoPort[];
    outputs: OpenVinoPort[];
    rtInfo: OpenVinoMetadata[];
    /** Names assigned to the model output a Result layer represents
     *  (`output_names` attribute, IR v11); empty on every other layer. */
    outputNames: string[];
    constants: OpenVinoConstant[];
    /** Nested sub-graphs of a control-flow layer (Loop / TensorIterator
     *  `<body>`, If `<then_body>` / `<else_body>`). */
    bodies: OpenVinoBody[];
}

export interface OpenVinoBody {
    /** Element name: body, then_body, else_body. */
    kind: string;
    layers: OpenVinoLayer[];
    edges: OpenVinoEdge[];
}

export interface OpenVinoEdge { fromLayer: string; fromPort: string; toLayer: string; toPort: string }
export interface OpenVinoOperatorCount { type: string; version: string; count: number }

export interface OpenVinoDocument {
    format: 'openvino';
    name: string;
    irVersion: string;
    fileSize: string;
    /** Size of the supplied .bin, or null when the host passed none. */
    weightsSize: string | null;
    weightsBytes: number | null;
    /** Distinct bytes the Const layers address in the .bin (shared ranges
     *  counted once — the serializer deduplicates identical blobs). */
    referencedBytes: number;
    /** Top-level layers; control-flow bodies hang off their owning layer. */
    layers: OpenVinoLayer[];
    edges: OpenVinoEdge[];
    /** Every constant, including those inside control-flow bodies. */
    constants: OpenVinoConstant[];
    inputs: OpenVinoLayer[];
    outputs: OpenVinoLayer[];
    operators: OpenVinoOperatorCount[];
    opsets: string[];
    /** Flattened `<rt_info>` / `<meta_data>` entries (`a.b.c` = value). */
    metadata: OpenVinoMetadata[];
    summary: OpenVinoSummaryItem[];
    warnings: OpenVinoWarning[];
}

export interface OpenVinoParseOptions {
    /** Bytes of the neighbouring .bin. Optional: topology never needs it. */
    weights?: Uint8Array;
    signal?: AbortSignal;
    maxXmlBytes?: number;
    maxLayers?: number;
    maxEdges?: number;
    maxMetadata?: number;
    /** Values decoded per constant for the preview. */
    previewValues?: number;
}

export class OpenVinoParseError extends Error {
    override readonly name = 'OpenVinoParseError';
}

const DEFAULT_MAX_XML_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_LAYERS = 200_000;
const DEFAULT_MAX_EDGES = 400_000;
const DEFAULT_MAX_METADATA = 2_000;
const DEFAULT_PREVIEW_VALUES = 8;
const MAX_ELEMENTS = 8_000_000;
const MAX_DEPTH = 32;
const MAX_ATTRIBUTES = 256;
const MAX_PORTS = 256;
const MAX_DIMS = 64;
const MAX_NAMES = 64;
const MAX_TEXT = 4096;
const MAX_LAYER_RT_INFO = 128;
const MAX_LAYER_CONSTANTS = 32;
const MAX_BODY_DEPTH = 8;
/** An If carries two bodies, Loop / TensorIterator one. */
const MAX_LAYER_BODIES = 4;

/** Byte width per IR element type; 0 for sub-byte, string, or unknown types. */
const ELEMENT_BYTES: Record<string, number> = {
    f64: 8, f32: 4, f16: 2, bf16: 2, f8e4m3: 1, f8e5m2: 1, f8e8m0: 1,
    i64: 8, i32: 4, i16: 2, i8: 1, u64: 8, u32: 4, u16: 2, u8: 1, boolean: 1,
    // Legacy IR precisions.
    fp32: 4, fp16: 2, fp64: 8, i1: 1
};

/**
 * True when `text` opens with an OpenVINO IR root: `<net` carrying a
 * `version` attribute, followed by `<layers>`. Both are required so an
 * unrelated document whose root happens to be `<net>` is not claimed.
 */
export function looksLikeOpenVinoIr(text: string): boolean {
    const sample = skipPrologue(text.slice(0, 64 * 1024));
    // XML names are case-sensitive and OpenVINO always writes lowercase; the
    // parser rejects any other casing, so the sniff must not claim it.
    const root = /^\s*(?:<!DOCTYPE(?:[^[>]|\[[^\]]*\])*>\s*)?<net(?:\s[^>]*)?>/.exec(sample);
    if (!root) return false;
    const tag = root[0];
    return /\sversion\s*=\s*["']\d+["']/.test(tag) && /<layers[\s/>]/.test(sample.slice(root.index + tag.length));
}

/** Drops a BOM and any leading declaration / processing instructions /
 *  comments, scanning forward once so hostile repetition stays linear. */
function skipPrologue(text: string): string {
    let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    for (;;) {
        while (index < text.length && isSpace(text.charCodeAt(index))) index++;
        let closer: string;
        let skip: number;
        if (text.startsWith('<?', index)) { closer = '?>'; skip = 2; }
        else if (text.startsWith('<!--', index)) { closer = '-->'; skip = 4; }
        else return text.slice(index);
        const end = text.indexOf(closer, index + skip);
        if (end === -1) return '';
        index = end + closer.length;
    }
}

export function parseOpenVino(data: Uint8Array, options: OpenVinoParseOptions = {}): OpenVinoDocument {
    if (data.byteLength === 0) throw new OpenVinoParseError('The OpenVINO IR file is empty.');
    const maxXmlBytes = options.maxXmlBytes ?? DEFAULT_MAX_XML_BYTES;
    if (data.byteLength > maxXmlBytes) throw new OpenVinoParseError(`The OpenVINO IR XML exceeds ${maxXmlBytes} bytes.`);
    const maxLayers = options.maxLayers ?? DEFAULT_MAX_LAYERS;
    const maxEdges = options.maxEdges ?? DEFAULT_MAX_EDGES;
    const maxMetadata = options.maxMetadata ?? DEFAULT_MAX_METADATA;
    const previewValues = options.previewValues ?? DEFAULT_PREVIEW_VALUES;
    const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
    const builder = new IrBuilder(maxLayers, maxEdges, maxMetadata, options.signal);
    scanXml(text, builder);
    if (!builder.rootSeen) throw new OpenVinoParseError('The file is not an OpenVINO IR: no <net> root element.');
    builder.finish();

    const warnings: OpenVinoWarning[] = [];
    const irVersion = builder.version;
    const versionNumber = /^\d+$/.test(irVersion) ? Number(irVersion) : Number.NaN;
    if (!irVersion) warnings.push({ key: 'openvino.warning.noVersion' });
    else if (!Number.isFinite(versionNumber) || versionNumber < 10) warnings.push({ key: 'openvino.warning.legacyVersion', args: { version: irVersion } });
    if (builder.layers.length === 0 && builder.omittedLayers === 0) warnings.push({ key: 'openvino.warning.noLayers' });
    if (builder.omittedLayers > 0) warnings.push({ key: 'openvino.warning.layersLimited', args: { shown: builder.layers.length, total: builder.layers.length + builder.omittedLayers } });
    if (builder.omittedEdges > 0) warnings.push({ key: 'openvino.warning.edgesLimited', args: { shown: builder.edges.length, total: builder.edges.length + builder.omittedEdges } });
    if (builder.omittedMetadata > 0) warnings.push({ key: 'openvino.warning.metadataLimited', args: { count: builder.omittedMetadata } });
    if (builder.omittedBodyLayers > 0) warnings.push({ key: 'openvino.warning.bodyLayersLimited', args: { count: builder.omittedBodyLayers } });
    if (builder.omittedBodyEdges > 0) warnings.push({ key: 'openvino.warning.bodyEdgesLimited', args: { count: builder.omittedBodyEdges } });
    if (builder.omittedBodies > 0) warnings.push({ key: 'openvino.warning.bodiesLimited', args: { count: builder.omittedBodies } });
    if (builder.truncated) warnings.push({ key: 'openvino.warning.truncated' });

    // Constants that were never read cannot be told apart from unreferenced
    // bytes, so the mismatched-pair signal is only trusted for a complete read.
    let incomplete = builder.truncated || builder.omittedLayers > 0 || builder.omittedBodyLayers > 0 || builder.omittedBodies > 0;

    const layerIds = new Set(builder.layers.map(layer => layer.id));
    let danglingEdges = 0;
    for (const edge of builder.edges) if (!layerIds.has(edge.fromLayer) || !layerIds.has(edge.toLayer)) danglingEdges++;
    if (danglingEdges > 0 && builder.omittedLayers === 0) warnings.push({ key: 'openvino.warning.danglingEdges', args: { count: danglingEdges } });

    const constants: OpenVinoConstant[] = [];
    const ranges: Array<[number, number]> = [];
    let outOfRange = 0;
    let invalid = 0;
    const weights = options.weights;
    const visit = (layers: OpenVinoLayer[]): void => {
        for (const layer of layers) {
            for (const constant of layer.constants) {
                constants.push(constant);
                if (constant.status === 'invalid') { invalid++; continue; }
                ranges.push([constant.offset, constant.offset + constant.size]);
                if (!weights) continue;
                if (constant.offset + constant.size > weights.byteLength) { constant.status = 'out-of-range'; outOfRange++; }
                else { constant.status = 'available'; constant.preview = previewConstant(weights, constant, previewValues); }
            }
            for (const body of layer.bodies) visit(body.layers);
        }
    };
    visit(builder.layers);
    const referencedBytes = mergedLength(ranges);
    // An unreadable range may cover any part of the .bin, so it also disqualifies the mismatch signal.
    if (invalid > 0) { incomplete = true; warnings.push({ key: 'openvino.warning.invalidConstants', args: { count: invalid } }); }
    if (!weights) warnings.push({ key: 'openvino.warning.noWeights' });
    else if (outOfRange > 0) warnings.push({ key: 'openvino.warning.weightsOutOfRange', args: { count: outOfRange, size: formatFileSize(weights.byteLength) } });
    else if (constants.length > 0 && referencedBytes < weights.byteLength && !incomplete) warnings.push({ key: 'openvino.warning.weightsUnreferenced', args: { bytes: formatFileSize(weights.byteLength - referencedBytes) } });

    const operatorMap = new Map<string, OpenVinoOperatorCount>();
    const opsetSet = new Set<string>();
    for (const layer of builder.layers) {
        const key = `${layer.type}\u0000${layer.version}`;
        const entry = operatorMap.get(key);
        if (entry) entry.count++;
        else operatorMap.set(key, { type: layer.type, version: layer.version, count: 1 });
        if (layer.version) opsetSet.add(layer.version);
    }
    const operators = [...operatorMap.values()].sort((a, b) => b.count - a.count || compareText(a.type, b.type) || compareText(a.version, b.version));
    const opsets = [...opsetSet].sort(compareOpset);
    const inputs = builder.layers.filter(layer => layer.type === 'Parameter' || (versionNumber < 10 && layer.type === 'Input'));
    const outputs = builder.layers.filter(layer => layer.type === 'Result');

    const summary: OpenVinoSummaryItem[] = [
        { labelKey: 'openvino.summary.layers', value: builder.layers.length + builder.omittedLayers },
        { labelKey: 'openvino.summary.edges', value: builder.edges.length + builder.omittedEdges },
        { labelKey: 'openvino.summary.operators', value: operators.length },
        { labelKey: 'openvino.summary.constants', value: constants.length },
        { labelKey: 'openvino.summary.weights', value: weights ? formatFileSize(weights.byteLength) : formatFileSize(referencedBytes) },
        { labelKey: 'openvino.summary.io', value: `${inputs.length} / ${outputs.length}` }
    ];

    return {
        format: 'openvino',
        name: builder.name,
        irVersion,
        fileSize: formatFileSize(data.byteLength),
        weightsSize: weights ? formatFileSize(weights.byteLength) : null,
        weightsBytes: weights ? weights.byteLength : null,
        referencedBytes,
        layers: builder.layers,
        edges: builder.edges,
        constants,
        inputs,
        outputs,
        operators,
        opsets,
        metadata: builder.metadata,
        summary,
        warnings
    };
}

/** Total length of the union of [start, end) ranges. */
function mergedLength(ranges: Array<[number, number]>): number {
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let total = 0;
    let start = -1;
    let end = -1;
    for (const [from, to] of ranges) {
        if (from > end) { if (end > start) total += end - start; start = from; end = to; }
        else if (to > end) end = to;
    }
    if (end > start) total += end - start;
    return total;
}

/** Locale-independent ordering so the document is identical on every engine. */
function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function compareOpset(a: string, b: string): number {
    const na = /^opset(\d+)$/.exec(a);
    const nb = /^opset(\d+)$/.exec(b);
    if (na && nb) return Number(na[1]) - Number(nb[1]);
    if (na) return -1;
    if (nb) return 1;
    return compareText(a, b);
}

/** Decode the first `count` values of a constant for display. */
export function previewConstant(weights: Uint8Array, constant: OpenVinoConstant, count = DEFAULT_PREVIEW_VALUES): string[] {
    const type = constant.elementType.toLowerCase();
    const width = ELEMENT_BYTES[type] ?? 0;
    if (width === 0 || count <= 0 || constant.size < width) return [];
    if (constant.offset < 0 || constant.offset + constant.size > weights.byteLength) return [];
    const available = Math.min(count, Math.floor(constant.size / width));
    const view = new DataView(weights.buffer, weights.byteOffset + constant.offset, available * width);
    const out: string[] = [];
    for (let index = 0; index < available; index++) {
        const at = index * width;
        switch (type) {
            case 'f32': case 'fp32': out.push(formatNumber(view.getFloat32(at, true))); break;
            case 'f64': case 'fp64': out.push(formatNumber(view.getFloat64(at, true))); break;
            case 'f16': case 'fp16': out.push(formatNumber(float16(view.getUint16(at, true)))); break;
            case 'bf16': out.push(formatNumber(bfloat16(view.getUint16(at, true)))); break;
            case 'i8': out.push(String(view.getInt8(at))); break;
            case 'u8': case 'boolean': case 'i1': out.push(String(view.getUint8(at))); break;
            case 'i16': out.push(String(view.getInt16(at, true))); break;
            case 'u16': out.push(String(view.getUint16(at, true))); break;
            case 'i32': out.push(String(view.getInt32(at, true))); break;
            case 'u32': out.push(String(view.getUint32(at, true))); break;
            case 'i64': out.push(String(view.getBigInt64(at, true))); break;
            case 'u64': out.push(String(view.getBigUint64(at, true))); break;
            case 'f8e4m3': out.push(formatNumber(float8(view.getUint8(at), 4, 3, 7))); break;
            case 'f8e5m2': out.push(formatNumber(float8(view.getUint8(at), 5, 2, 15))); break;
            case 'f8e8m0': { const raw = view.getUint8(at); out.push(raw === 0xff ? 'NaN' : formatNumber(2 ** (raw - 127))); break; }
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

function float8(bits: number, exponentBits: number, mantissaBits: number, bias: number): number {
    const sign = bits & 0x80 ? -1 : 1;
    const exponent = (bits >> mantissaBits) & ((1 << exponentBits) - 1);
    const mantissa = bits & ((1 << mantissaBits) - 1);
    const maxExponent = (1 << exponentBits) - 1;
    if (exponentBits === 4) {
        // e4m3 has no infinities; only the all-ones mantissa at max exponent is NaN.
        if (exponent === maxExponent && mantissa === (1 << mantissaBits) - 1) return Number.NaN;
    } else if (exponent === maxExponent) return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY;
    if (exponent === 0) return sign * mantissa * 2 ** (1 - bias - mantissaBits);
    return sign * (1 + mantissa / (1 << mantissaBits)) * 2 ** (exponent - bias);
}

function formatNumber(value: number): string {
    return Number.isFinite(value) ? String(Number(value.toPrecision(6))) : String(value);
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

// ---------------------------------------------------------------------------
// IR builder: consumes the SAX-style events and keeps only what the viewer
// needs, so a 100k-layer topology never becomes a full DOM.

type Attributes = Array<[string, string]>;

interface XmlSink {
    open(name: string, attributes: Attributes, selfClosing: boolean): void;
    close(name: string): void;
    text(value: string): void;
    truncated: boolean;
}

/** One graph scope: the top-level `<net>` or a control-flow body. The
 *  element depths the IR layout fixes (`layers` → `layer` → children …) are
 *  relative to the scope's base, so a body nested inside a layer parses with
 *  the same code as the root. */
interface Scope {
    base: number;
    layers: OpenVinoLayer[];
    edges: OpenVinoEdge[];
    /** The scope belongs to nothing the document keeps (a body past the
     *  per-layer cap, or the body of a layer dropped past the layer cap): its
     *  layers and edges are counted as omitted and consume no budget. */
    detached: boolean;
    layer: OpenVinoLayer | undefined;
    /** A layer dropped past the cap is open; its bodies are scanned detached. */
    skippingLayer: boolean;
    /** Open `<rt_info>` of the layer or of a port; entries are pushed here. */
    rtInfoTarget: OpenVinoMetadata[] | undefined;
    /** Nested `<user_data>` names inside that rt_info, joined into the key. */
    rtInfoPath: string[];
    layerPrecision: string;
    port: OpenVinoPort | undefined;
    portSide: 'inputs' | 'outputs' | undefined;
    dimText: string | undefined;
}

function newScope(base: number, layers: OpenVinoLayer[], edges: OpenVinoEdge[], detached = false): Scope {
    return { base, layers, edges, detached, layer: undefined, skippingLayer: false, rtInfoTarget: undefined, rtInfoPath: [], layerPrecision: '', port: undefined, portSide: undefined, dimText: undefined };
}

function isBodyElement(local: string): boolean {
    return local === 'body' || local === 'then_body' || local === 'else_body';
}

class IrBuilder implements XmlSink {
    rootSeen = false;
    name = '';
    version = '';
    layers: OpenVinoLayer[] = [];
    edges: OpenVinoEdge[] = [];
    metadata: OpenVinoMetadata[] = [];
    omittedLayers = 0;
    omittedEdges = 0;
    omittedMetadata = 0;
    omittedBodies = 0;
    omittedBodyLayers = 0;
    omittedBodyEdges = 0;
    truncated = false;
    /** Set once a second root opens; everything after it is ignored. */
    private stopped = false;

    /** Local names of the open elements, root first. */
    private readonly path: string[] = [];
    private readonly scopes: Scope[] = [newScope(0, this.layers, this.edges)];
    private inMetadata = false;
    private readonly metadataPath: string[] = [];
    private elements = 0;
    private layerCount = 0;
    private edgeCount = 0;

    constructor(
        private readonly maxLayers: number,
        private readonly maxEdges: number,
        private readonly maxMetadata: number,
        private readonly signal: AbortSignal | undefined
    ) {}

    open(name: string, attributes: Attributes, selfClosing: boolean): void {
        if (++this.elements > MAX_ELEMENTS) throw new OpenVinoParseError(`The OpenVINO IR XML has more than ${MAX_ELEMENTS} elements.`);
        if ((this.elements & 0x3fff) === 0 && this.signal?.aborted) throw new OpenVinoParseError('aborted');
        if (this.stopped) return;
        const depth = this.path.length;
        if (depth >= MAX_DEPTH) throw new OpenVinoParseError(`The OpenVINO IR XML nests deeper than ${MAX_DEPTH} levels.`);
        const parent = this.path[depth - 1];
        const local = localName(name);
        const scope = this.scopes[this.scopes.length - 1]!;
        const relative = depth - scope.base;
        if (depth === 0) {
            if (this.rootSeen) {
                // Content after </net> (or stray close tags that unwound to the
                // root): the IR is what was read so far; flag it and stop.
                this.truncated = true;
                this.stopped = true;
                return;
            }
            if (local !== 'net') throw new OpenVinoParseError(`The file is not an OpenVINO IR: root element is <${name}>.`);
            this.rootSeen = true;
            this.name = clip(attr(attributes, 'name') ?? '');
            this.version = clip(attr(attributes, 'version') ?? '', 64);
        } else if (depth === 1 && (local === 'rt_info' || local === 'meta_data')) {
            this.inMetadata = true;
            this.metadataPath.length = 0;
        } else if (this.inMetadata) {
            this.openMetadata(local, attributes);
        } else if (relative === 2 && parent === 'layers' && local === 'layer') {
            this.openLayer(scope, attributes);
        } else if (relative === 2 && parent === 'edges' && local === 'edge') {
            this.openEdge(scope, attributes);
        } else if (scope.layer) {
            this.openLayerChild(scope, local, attributes, relative, parent);
        } else if (scope.skippingLayer && relative === 3 && isBodyElement(local)) {
            // A layer dropped past the cap still has its bodies scanned into a
            // detached scope, so the layers inside are counted as omitted.
            this.scopes.push(newScope(scope.base + 3, [], [], true));
        }
        this.path.push(local);
        if (selfClosing) this.close(name);
    }

    close(_name: string): void {
        if (this.stopped) return;
        if (this.path.length === 0) { this.truncated = true; return; } // stray close below the root
        const local = this.path.pop();
        const depth = this.path.length;
        if (this.inMetadata) {
            if (depth === 1) this.inMetadata = false;
            else this.metadataPath.pop();
            return;
        }
        const scope = this.scopes[this.scopes.length - 1]!;
        const relative = depth - scope.base;
        if (this.scopes.length > 1 && relative === 0) {
            // A body closed: its layers were collected into the owning layer.
            this.scopes.pop();
            return;
        }
        if (!scope.layer) {
            if (relative === 2 && local === 'layer') scope.skippingLayer = false;
            return;
        }
        if (scope.rtInfoTarget) {
            if (scope.rtInfoPath.length > 0) scope.rtInfoPath.pop();
            else scope.rtInfoTarget = undefined; // the <rt_info> itself closed
            return;
        }
        if (relative === 2) {
            if (local === 'layer') {
                if (scope.layer.id !== '' || scope.layer.type !== '' || scope.layer.name !== '') scope.layers.push(scope.layer);
                scope.layer = undefined;
            }
        } else if (relative === 3) {
            if (local === 'input' || local === 'output') scope.portSide = undefined;
        } else if (relative === 4) {
            if (local === 'port' && scope.port && scope.portSide) {
                const side = scope.layer[scope.portSide];
                if (side.length < MAX_PORTS) side.push(scope.port);
                scope.port = undefined;
            }
        } else if (relative === 5) {
            if (local === 'dim' && scope.port && scope.dimText !== undefined) {
                if (scope.port.dims.length < MAX_DIMS) scope.port.dims.push(clip(scope.dimText.trim(), 64));
                scope.dimText = undefined;
            }
        }
    }

    /** Called when the scan ends. A writer flushes on line boundaries, so a
     *  partial file usually stops between tags; the scanner cannot see that,
     *  but an element still open here means the root never closed. A layer
     *  left open is kept so the partial topology is shown rather than lost. */
    finish(): void {
        if (this.path.length === 0) return;
        this.truncated = true;
        while (this.scopes.length > 0) {
            const scope = this.scopes[this.scopes.length - 1]!;
            if (scope.layer && scope.port && scope.portSide) {
                const side = scope.layer[scope.portSide];
                if (side.length < MAX_PORTS) side.push(scope.port);
            }
            if (scope.layer && (scope.layer.id !== '' || scope.layer.type !== '' || scope.layer.name !== '')) scope.layers.push(scope.layer);
            if (this.scopes.length === 1) break;
            this.scopes.pop();
        }
    }

    text(value: string): void {
        if (this.stopped) return;
        const scope = this.scopes[this.scopes.length - 1]!;
        if (scope.dimText !== undefined) {
            if (scope.dimText.length < MAX_TEXT) scope.dimText += value;
            return;
        }
        if (this.inMetadata && this.metadataPath.length > 0) {
            if (this.metadata.length >= this.maxMetadata) { if (value.trim()) this.omittedMetadata++; return; }
            const trimmed = value.trim();
            if (trimmed) this.pushMetadata(this.metadataPath.join('.'), trimmed);
        }
    }

    private openLayer(scope: Scope, attributes: Attributes): void {
        // The cap bounds every layer, but the counts the document reports are
        // top-level: body layers dropped past the cap are reported separately.
        if (scope.detached || this.layerCount >= this.maxLayers) {
            if (this.scopes.length === 1) this.omittedLayers++; else this.omittedBodyLayers++;
            scope.skippingLayer = true;
            return;
        }
        this.layerCount++;
        scope.layerPrecision = attr(attributes, 'precision') ?? '';
        scope.layer = {
            id: clip(attr(attributes, 'id') ?? '', 64),
            name: clip(attr(attributes, 'name') ?? ''),
            type: clip(attr(attributes, 'type') ?? '', 256),
            version: clip(attr(attributes, 'version') ?? '', 64),
            attributes: [], inputs: [], outputs: [], rtInfo: [],
            outputNames: splitTensorNames(attr(attributes, 'output_names') ?? ''),
            constants: [], bodies: []
        };
    }

    private openEdge(scope: Scope, attributes: Attributes): void {
        if (scope.detached || this.edgeCount >= this.maxEdges) {
            if (this.scopes.length === 1) this.omittedEdges++; else this.omittedBodyEdges++;
            return;
        }
        this.edgeCount++;
        scope.edges.push({
            fromLayer: clip(attr(attributes, 'from-layer') ?? '', 64), fromPort: clip(attr(attributes, 'from-port') ?? '', 64),
            toLayer: clip(attr(attributes, 'to-layer') ?? '', 64), toPort: clip(attr(attributes, 'to-port') ?? '', 64)
        });
    }

    /** Flattens `<rt_info>` / `<meta_data>` descendants into dotted keys. A key
     *  that is not a valid tag name is written as `<info name="…">`, and an
     *  attribute-typed value as `<attribute name="…">`; both use the name. */
    private openMetadata(local: string, attributes: Attributes): void {
        if (this.metadata.length >= this.maxMetadata) {
            // Past the cap only the depth bookkeeping matters; count what would
            // have been pushed (one entry per payload attribute) and skip the key work.
            this.metadataPath.push('');
            for (const [name] of attributes) if (name !== 'name' && name !== 'version') this.omittedMetadata++;
            return;
        }
        const segment = local === 'attribute' || local === 'info' ? attr(attributes, 'name') ?? local : local;
        this.metadataPath.push(clip(segment, 256));
        const key = this.metadataPath.join('.');
        const value = attr(attributes, 'value');
        if (value !== undefined) this.pushMetadata(key, value);
        for (const [attributeName, attributeValue] of attributes) {
            if (attributeName === 'value' || attributeName === 'name' || attributeName === 'version') continue;
            this.pushMetadata(`${key}@${clip(attributeName, 128)}`, attributeValue);
        }
    }

    private pushMetadata(key: string, value: string): void {
        if (this.metadata.length >= this.maxMetadata) { this.omittedMetadata++; return; }
        this.metadata.push({ key: clip(key, 512), value: clip(value) });
    }

    private openLayerChild(scope: Scope, local: string, attributes: Attributes, relative: number, parent: string | undefined): void {
        const layer = scope.layer!;
        if (scope.rtInfoTarget) {
            // Inside a layer's or port's <rt_info>: <attribute name value/> for
            // runtime attributes, <user_data name value/> (nestable) for the
            // custom entries the serializer writes for plain rt_info keys.
            if (local === 'attribute' || local === 'user_data') {
                const segment = clip(attr(attributes, 'name') ?? local, 256);
                scope.rtInfoPath.push(segment);
                pushRtInfo(scope.rtInfoTarget, scope.rtInfoPath.join('.'), attributes, local === 'user_data');
            } else {
                scope.rtInfoPath.push('');
            }
            return;
        }
        if (relative === 3) {
            if (local === 'data') {
                for (const [key, value] of attributes) {
                    if (layer.attributes.length >= MAX_ATTRIBUTES) break;
                    layer.attributes.push({ key: clip(key, 256), value: clip(value) });
                }
                if (layer.type === 'Const') this.pushConstant(layer, 'data', attributes, attr(attributes, 'element_type') ?? scope.layerPrecision, attr(attributes, 'shape'));
            } else if (local === 'input' || local === 'output') {
                scope.portSide = local === 'input' ? 'inputs' : 'outputs';
            } else if (local === 'rt_info') {
                scope.rtInfoTarget = layer.rtInfo;
                scope.rtInfoPath.length = 0;
            } else if (isBodyElement(local)) {
                // Loop / TensorIterator / If carry a whole sub-graph here.
                if (this.scopes.length > MAX_BODY_DEPTH) throw new OpenVinoParseError(`Control-flow bodies nest deeper than ${MAX_BODY_DEPTH} levels.`);
                // Past the cap the body is still scanned (depth bookkeeping
                // must stay balanced) but into a detached object.
                const body: OpenVinoBody = { kind: local, layers: [], edges: [] };
                const kept = layer.bodies.length < MAX_LAYER_BODIES;
                if (kept) layer.bodies.push(body);
                else this.omittedBodies++;
                this.scopes.push(newScope(scope.base + 3, body.layers, body.edges, !kept));
            }
        } else if (relative === 4) {
            if (local === 'port' && scope.portSide) {
                scope.port = {
                    id: clip(attr(attributes, 'id') ?? '', 64),
                    precision: clip(attr(attributes, 'precision') ?? scope.layerPrecision, 64),
                    names: splitTensorNames(attr(attributes, 'names') ?? ''),
                    dims: [], rtInfo: []
                };
            } else if (parent === 'blobs') {
                // Legacy IR (v7 and earlier): <blobs><weights offset size/><biases …/></blobs>.
                this.pushConstant(layer, local, attributes, attr(attributes, 'precision') ?? scope.layerPrecision, undefined);
            }
        } else if (relative === 5) {
            if (local === 'dim' && scope.port) scope.dimText = '';
            else if (local === 'rt_info' && scope.port) { scope.rtInfoTarget = scope.port.rtInfo; scope.rtInfoPath.length = 0; }
        }
    }

    private pushConstant(layer: OpenVinoLayer, kind: string, attributes: Attributes, elementType: string, shape: string | undefined): void {
        if (layer.constants.length >= MAX_LAYER_CONSTANTS) return;
        const offset = parseCount(attr(attributes, 'offset'));
        const size = parseCount(attr(attributes, 'size'));
        const dims = shape === undefined ? [] : splitBounded(shape, MAX_DIMS, 64, false);
        const width = ELEMENT_BYTES[elementType.toLowerCase()] ?? 0;
        let elementCount: number;
        if (dims.length) elementCount = dims.reduce((total, dim) => total * (parseCount(dim) ?? Number.NaN), 1);
        else if (shape !== undefined) elementCount = 1; // shape="" is a scalar
        else elementCount = size !== undefined && width > 0 ? Math.floor(size / width) : Number.NaN;
        layer.constants.push({
            layerId: layer.id, layerName: layer.name, kind: clip(kind, 64),
            elementType: clip(elementType, 64), shape: dims,
            elementCount: Number.isFinite(elementCount) ? elementCount : 0,
            offset: offset ?? 0, size: size ?? 0,
            status: offset === undefined || size === undefined ? 'invalid' : 'unchecked',
            preview: []
        });
    }
}

/** The serializer escapes a comma inside a tensor name as `\,`. Scanning
 *  stops once the cap is exceeded, so a comma-heavy attribute never
 *  materializes more than MAX_NAMES + 1 entries. */
export function splitTensorNames(value: string): string[] {
    return splitBounded(value, MAX_NAMES, 512, true);
}

function splitBounded(value: string, limit: number, itemLimit: number, escaped: boolean): string[] {
    const items: string[] = [];
    let current = '';
    let start = 0;
    const flush = (end: number): void => {
        const item = (current + value.slice(start, end)).trim();
        current = '';
        if (item) items.push(clip(item, itemLimit));
    };
    for (;;) {
        const comma = value.indexOf(',', start);
        if (comma === -1) { flush(value.length); break; }
        if (escaped && comma > 0 && value[comma - 1] === '\\') {
            // Keep the text up to the escaped comma (bounded) and continue the same item.
            if (current.length <= itemLimit) current = clip(current + value.slice(start, comma - 1) + ',', itemLimit + 1);
            start = comma + 1;
            continue;
        }
        flush(comma);
        start = comma + 1;
        if (items.length > limit) break;
    }
    return items.slice(0, limit);
}

/** A layer/port rt_info attribute stores its payload under `value`, or —
 *  for attribute types with their own serializer, such as layout — under
 *  attributes named after the payload (`layout="[N,C,H,W]"`). */
function pushRtInfo(target: OpenVinoMetadata[], key: string, attributes: Attributes, container: boolean): void {
    if (target.length >= MAX_LAYER_RT_INFO) return;
    const value = attr(attributes, 'value');
    const payload = value !== undefined ? value : attributes
        .filter(([name]) => name !== 'name' && name !== 'version')
        .map(([name, item]) => `${name}=${item}`).join(' ');
    // A nesting-only <user_data name> has no payload of its own; a bare
    // <attribute name/> is a marker (decompression, disable_fp16_compression…)
    // and is kept with an empty value.
    if (container && value === undefined && payload === '') return;
    target.push({ key: clip(key, 512), value: clip(payload) });
}

function parseCount(value: string | undefined): number | undefined {
    if (value === undefined || !/^\d{1,16}$/.test(value.trim())) return undefined;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : undefined;
}

function attr(attributes: Attributes, name: string): string | undefined {
    for (const [key, value] of attributes) if (key === name) return value;
    return undefined;
}

function clip(value: string, limit = MAX_TEXT): string {
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function localName(name: string): string {
    const colon = name.indexOf(':');
    return colon === -1 ? name : name.slice(colon + 1);
}

// ---------------------------------------------------------------------------
// Minimal, non-validating XML scanner. Handles declarations, comments,
// processing instructions, CDATA, DOCTYPE (skipped — no entity expansion beyond
// the five predefined and numeric references), and attribute quoting. Errors
// are reported as truncation rather than thrown, so a partially written IR
// still shows what it has.

function scanXml(text: string, sink: XmlSink): void {
    const length = text.length;
    let index = 0;
    let textStart = 0;
    const flushText = (end: number): void => { if (end > textStart) sink.text(decodeEntities(text.slice(textStart, end))); };
    while (index < length) {
        const lt = text.indexOf('<', index);
        if (lt === -1) { flushText(length); return; }
        flushText(lt);
        if (text.startsWith('<!--', lt)) {
            const end = text.indexOf('-->', lt + 4);
            if (end === -1) { sink.truncated = true; return; }
            index = textStart = end + 3;
        } else if (text.startsWith('<![CDATA[', lt)) {
            const end = text.indexOf(']]>', lt + 9);
            if (end === -1) { sink.truncated = true; return; }
            sink.text(text.slice(lt + 9, end));
            index = textStart = end + 3;
        } else if (text.startsWith('<?', lt)) {
            const end = text.indexOf('?>', lt + 2);
            if (end === -1) { sink.truncated = true; return; }
            index = textStart = end + 2;
        } else if (text.startsWith('<!', lt)) {
            // DOCTYPE: skip to the matching '>' (an internal subset is bracketed).
            let depth = 0;
            let cursor = lt + 2;
            for (; cursor < length; cursor++) {
                const char = text.charCodeAt(cursor);
                if (char === 0x5b) depth++;
                else if (char === 0x5d) depth--;
                else if (char === 0x3e && depth <= 0) break;
            }
            if (cursor >= length) { sink.truncated = true; return; }
            index = textStart = cursor + 1;
        } else if (text.charCodeAt(lt + 1) === 0x2f) {
            const end = text.indexOf('>', lt + 2);
            if (end === -1) { sink.truncated = true; return; }
            sink.close(text.slice(lt + 2, end).trim());
            index = textStart = end + 1;
        } else {
            const parsed = parseStartTag(text, lt);
            if (!parsed) { sink.truncated = true; return; }
            sink.open(parsed.name, parsed.attributes, parsed.selfClosing);
            index = textStart = parsed.end;
        }
    }
}

function parseStartTag(text: string, start: number): { name: string; attributes: Attributes; selfClosing: boolean; end: number } | null {
    const length = text.length;
    let cursor = start + 1;
    const nameStart = cursor;
    while (cursor < length && !isSpace(text.charCodeAt(cursor)) && text[cursor] !== '>' && text[cursor] !== '/') cursor++;
    const name = text.slice(nameStart, cursor);
    if (!name) return null;
    const attributes: Attributes = [];
    for (;;) {
        while (cursor < length && isSpace(text.charCodeAt(cursor))) cursor++;
        if (cursor >= length) return null;
        const char = text[cursor];
        if (char === '>') return { name, attributes, selfClosing: false, end: cursor + 1 };
        if (char === '/') return text[cursor + 1] === '>' ? { name, attributes, selfClosing: true, end: cursor + 2 } : null;
        const keyStart = cursor;
        while (cursor < length && !isSpace(text.charCodeAt(cursor)) && text[cursor] !== '=' && text[cursor] !== '>' && text[cursor] !== '/') cursor++;
        const key = text.slice(keyStart, cursor);
        if (!key) return null;
        while (cursor < length && isSpace(text.charCodeAt(cursor))) cursor++;
        if (text[cursor] !== '=') {
            // A bare attribute is not well-formed XML; keep it and carry on.
            if (attributes.length < MAX_ATTRIBUTES) attributes.push([key, '']);
            continue;
        }
        cursor++;
        while (cursor < length && isSpace(text.charCodeAt(cursor))) cursor++;
        const quote = text[cursor];
        if (quote !== '"' && quote !== "'") return null;
        const valueEnd = text.indexOf(quote, cursor + 1);
        if (valueEnd === -1) return null;
        if (attributes.length < MAX_ATTRIBUTES) attributes.push([key, decodeEntities(text.slice(cursor + 1, valueEnd))]);
        cursor = valueEnd + 1;
    }
}

function isSpace(code: number): boolean {
    return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
}

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(value: string): string {
    if (value.indexOf('&') === -1) return value;
    return value.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]+);/g, (whole, body: string) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body]! : whole;
    });
}
