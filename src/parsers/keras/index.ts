/**
 * Keras model reader for both saved formats.
 *
 *  - `.keras` (Keras 3): a ZIP holding `metadata.json`, `config.json`, and
 *    `model.weights.h5`. Keras writes the archive with stored (uncompressed)
 *    members, so the members are sliced straight out of the input and JSZip is
 *    only needed for the unusual deflated archive.
 *  - `.h5` / `.hdf5` (Keras 2 / `save_format='h5'`): an HDF5 file whose root
 *    attributes carry `model_config` and `training_config` as JSON, with the
 *    parameters under `/model_weights`.
 *
 * Weight payloads are never read: the HDF5 store is walked for dataset shapes
 * and datatypes only, which is what the layer table and parameter counts need.
 * Anything the file does not answer is reported as a warning instead of failing
 * the parse, so a model saved by an unknown Keras version still opens.
 */

import { formatFileSize, readHdf5Objects, type Hdf5Attribute, type Hdf5Object } from '../hdf5/index.js';

const ZIP_MAGIC = [0x50, 0x4b] as const;
const HDF5_SIGNATURE = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a] as const;

const MAX_ZIP_ENTRIES = 4096;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_INFLATED_BYTES = 512 * 1024 * 1024;
const MAX_LAYERS = 4096;
const MAX_WEIGHTS = 20_000;
const MAX_LAYER_CONFIG_ENTRIES = 128;
const MAX_CONFIG_VALUE_CHARS = 512;
const MAX_CONFIG_TEXT_CHARS = 1_000_000;
const MAX_CONFIG_DEPTH = 64;
const MAX_INBOUND = 32;
/** Chunks accepted for one split list attribute (`layer_names0`, `…1`, …). */
const MAX_ATTRIBUTE_CHUNKS = 1024;
/**
 * Reserved HDF5 group holding variables the model owns itself rather than
 * through a layer — the legacy counterpart of the Keras 3 store's root
 * `vars/…`. It sits beside the layer groups but is not one of them.
 */
const MODEL_OWNED_GROUP = 'top_level_model_weights';
/**
 * Root groups of a Keras 3 store that hold training state rather than model
 * parameters. `saving_lib` reserves these names, which is why a model attribute
 * called `optimizer` cannot be confused with one of a model's layers.
 */
const TRAINING_STATE_GROUPS: ReadonlySet<string> = new Set(['optimizer', 'metrics']);
/** Group a Keras 3 store nests a container's children under. */
const STORE_CONTAINER = 'layers';
/** Unmatched-weight rows named individually before the rest are counted. */
const MAX_UNMATCHED_WARNINGS = 8;

export type KerasFormat = 'Keras v3' | 'Keras HDF5';

export interface KerasSummaryItem {
    labelKey: string;
    value: string | number;
}

/** A localized warning: catalog key plus its placeholder arguments. */
export interface KerasWarning {
    key: string;
    args?: Record<string, string | number>;
}

/** A label/value pair carrying data from the file (labels are not localized). */
export interface KerasEntry {
    label: string;
    value: string;
}

export interface KerasWeight {
    /** Dataset path inside the HDF5 weight store. */
    path: string;
    /** Weight name as Keras records it (`dense/kernel:0`, `vars/0`, …). */
    name: string;
    /** Owning layer's display name. */
    layer: string;
    /** The layer name the Keras 3 store records for this weight's `vars` group,
     *  which is the layer's real name where the group names above it are
     *  attribute or class-derived names. Absent in the legacy layouts. */
    declaredLayerName?: string;
    /** Full chain of *store* group names owning this weight, outermost first.
     *  This is how a weight is matched to its layer; it is addressing, not
     *  display text — see `owner` for that. */
    layerPath: string[];
    /** Display path of the layer this weight was matched to: the same names the
     *  layer list shows, outermost first. Empty only before matching. */
    owner: string[];
    shape: number[];
    type: string;
    elementBytes: number;
    parameters: number;
    bytes: number;
}

export interface KerasLayer {
    index: number;
    /** Nesting level; sub-models saved inside a model are flattened with depth. */
    depth: number;
    name: string;
    /** Names from the outermost model down to this layer; ends with `name`. */
    path: string[];
    /** Where a Keras 3 weight store keeps this layer. Keras derives these from
     *  class names, not layer names, so they are what the weights are matched
     *  on for `.keras` files. */
    storePath: string[];
    className: string;
    module: string;
    registeredName: string;
    activation: string;
    /** Shape the layer was built with, when the file records one. */
    inputShape: string;
    dtype: string;
    trainable: boolean | undefined;
    parameters: number;
    weights: KerasWeight[];
    /** Flattened layer config, for the inspector. */
    config: KerasEntry[];
    /** Layers feeding this one, for functional models. */
    inbound: string[];
}

export interface KerasArchiveEntry {
    name: string;
    size: number;
    compressedSize: number;
    /** 'stored' or 'deflate'; other ZIP methods are reported by number. */
    method: string;
}

export interface KerasDocument {
    format: KerasFormat;
    title: string;
    fileSize: string;
    kerasVersion: string;
    backend: string;
    dateSaved: string;
    modelClass: string;
    modelName: string;
    layers: KerasLayer[];
    weights: KerasWeight[];
    /** Names of the model's input and output layers, when declared. */
    inputs: string[];
    outputs: string[];
    /** Compile / training configuration, flattened. */
    training: KerasEntry[];
    metadata: KerasEntry[];
    files: KerasArchiveEntry[];
    /** Pretty-printed model config, bounded (empty when unavailable). */
    configText: string;
    summary: KerasSummaryItem[];
    warnings: KerasWarning[];
}

export interface KerasParseOptions {
    signal?: AbortSignal;
}

/** Reads a `.keras` archive or a Keras HDF5 model. Never throws on bad input. */
export async function parseKeras(
    data: Uint8Array,
    fileName = 'model.keras',
    options: KerasParseOptions = {}
): Promise<KerasDocument> {
    throwIfAborted(options.signal);
    if (hasPrefix(data, ZIP_MAGIC)) return parseKerasArchive(data, options);
    if (findHdf5Signature(data) >= 0) return parseKerasHdf5(data, options);
    return emptyDocument(
        fileName.toLowerCase().endsWith('.keras') ? 'Keras v3' : 'Keras HDF5',
        data.byteLength,
        [{ key: 'keras.warning.notKeras' }]
    );
}

/** True when the bytes are an HDF5 file saved by Keras (legacy `.h5` model). */
export function looksLikeKerasHdf5(data: Uint8Array): boolean {
    if (findHdf5Signature(data) < 0) return false;
    const tree = readHdf5Objects(data);
    const root = tree.objects.find(object => object.path === '/');
    if (root && root.attributes.some(attribute => attribute.name === 'model_config' || attribute.name === 'keras_version')) {
        return true;
    }
    return tree.objects.some(object => object.path === '/model_weights' || object.path === '/layers');
}

// ── Keras 3 archive ────────────────────────────────────────────────────────

async function parseKerasArchive(data: Uint8Array, options: KerasParseOptions): Promise<KerasDocument> {
    const warnings: KerasWarning[] = [];
    const directory = readZipDirectory(data);
    if (!directory) {
        return emptyDocument('Keras v3', data.byteLength, [{ key: 'keras.warning.archiveUnreadable' }]);
    }
    if (directory.truncated) warnings.push({ key: 'keras.warning.archiveEntryLimit', args: { limit: MAX_ZIP_ENTRIES } });

    const files: KerasArchiveEntry[] = directory.entries.map(entry => ({
        name: entry.name,
        size: entry.uncompressedSize,
        compressedSize: entry.compressedSize,
        method: entry.method === 0 ? 'stored' : entry.method === 8 ? 'deflate' : String(entry.method)
    }));
    const member = (name: string): ZipEntry | undefined =>
        directory.entries.find(entry => entry.name === name);

    const members = await readMembers(data, [
        { entry: member('config.json'), name: 'config.json', inflateLimit: MAX_JSON_BYTES, sliceLimit: MAX_JSON_BYTES },
        { entry: member('metadata.json'), name: 'metadata.json', inflateLimit: MAX_JSON_BYTES, sliceLimit: MAX_JSON_BYTES },
        // The weight store is only walked for metadata, so a stored member of
        // any size costs nothing beyond the bytes already in memory.
        { entry: member('model.weights.h5'), name: 'model.weights.h5', inflateLimit: MAX_INFLATED_BYTES, sliceLimit: Number.POSITIVE_INFINITY }
    ], warnings, options);
    throwIfAborted(options.signal);

    const config = decodeJson(members.get('config.json'), 'config.json', warnings);
    const metadata = decodeJson(members.get('metadata.json'), 'metadata.json', warnings);
    if (!config) warnings.push({ key: 'keras.warning.configMissing' });

    const weightsEntry = member('model.weights.h5');
    const weightBytes = members.get('model.weights.h5');
    if (!weightsEntry) warnings.push({ key: 'keras.warning.weightsMissing' });
    const store = weightBytes ? readWeightStore(weightBytes, warnings) : { weights: [], other: 0 };

    const metadataEntries: KerasEntry[] = [];
    if (isRecord(metadata)) {
        for (const [key, value] of Object.entries(metadata)) {
            metadataEntries.push({ label: key, value: formatScalar(value) });
        }
    }
    if (store.other > 0) metadataEntries.push({ label: 'optimizer_variables', value: String(store.other) });

    return buildDocument({
        format: 'Keras v3',
        storeKind: 'derived',
        bytes: data.byteLength,
        config,
        kerasVersion: isRecord(metadata) ? asText(metadata['keras_version']) : '',
        backend: '',
        dateSaved: isRecord(metadata) ? asText(metadata['date_saved']) : '',
        training: isRecord(config) ? flatten(config['compile_config']) : [],
        metadata: metadataEntries,
        files,
        weights: store.weights,
        warnings
    });
}

interface MemberRequest {
    entry: ZipEntry | undefined;
    name: string;
    /** Cap on bytes to inflate, which allocates a copy. */
    inflateLimit: number;
    /** Cap on a stored member; Infinity where viewing it in place is free. */
    sliceLimit: number;
}

/**
 * Reads the requested archive members. Stored members are viewed in place, so
 * a multi-gigabyte weight store costs nothing to open; deflated members need an
 * inflater, and the optional JSZip dependency is loaded once for all of them.
 */
async function readMembers(
    data: Uint8Array,
    requests: readonly MemberRequest[],
    warnings: KerasWarning[],
    options: KerasParseOptions
): Promise<Map<string, Uint8Array>> {
    const bytes = new Map<string, Uint8Array>();
    const deflated: MemberRequest[] = [];
    const tooLarge = (name: string, limit: number): void => {
        warnings.push({ key: 'keras.warning.memberTooLarge', args: { name, limit: formatFileSize(limit) } });
    };
    for (const request of requests) {
        const { entry, name } = request;
        if (!entry) continue;
        if (entry.method === 8) {
            if (entry.uncompressedSize > request.inflateLimit) tooLarge(name, request.inflateLimit);
            else deflated.push(request);
            continue;
        }
        if (entry.method !== 0) {
            warnings.push({ key: 'keras.warning.memberMethod', args: { name, method: entry.method } });
            continue;
        }
        if (entry.uncompressedSize > request.sliceLimit) {
            tooLarge(name, request.sliceLimit);
            continue;
        }
        const stored = sliceStoredEntry(data, entry);
        if (stored) bytes.set(name, stored);
        else warnings.push({ key: 'keras.warning.memberUnreadable', args: { name } });
    }
    if (!deflated.length) return bytes;

    // Keras writes stored members, so this path serves archives that a tool or
    // a user re-zipped with compression.
    const module = await import('jszip').catch(() => undefined);
    throwIfAborted(options.signal);
    if (!module) {
        for (const { name } of deflated) warnings.push({ key: 'keras.warning.inflateUnavailable', args: { name } });
        return bytes;
    }
    try {
        // CRC verification would inflate every member of the archive, including
        // ones this viewer never reads, before any limit could apply.
        const archive = await module.default.loadAsync(data, { checkCRC32: false, createFolders: false });
        for (const { entry, name } of deflated) {
            throwIfAborted(options.signal);
            const file = entry ? archive.file(entry.name) : null;
            if (file) bytes.set(name, await file.async('uint8array'));
            else warnings.push({ key: 'keras.warning.memberUnreadable', args: { name } });
        }
    } catch (error) {
        if (options.signal?.aborted) throw error;
        for (const { name } of deflated) {
            if (!bytes.has(name)) warnings.push({ key: 'keras.warning.memberUnreadable', args: { name } });
        }
    }
    return bytes;
}

// ── Keras 2 HDF5 ───────────────────────────────────────────────────────────

function parseKerasHdf5(data: Uint8Array, options: KerasParseOptions): KerasDocument {
    throwIfAborted(options.signal);
    const warnings: KerasWarning[] = [];
    const tree = readHdf5Objects(data);
    if (tree.truncated) warnings.push({ key: 'keras.warning.structureTruncated' });

    const root = tree.objects.find(object => object.path === '/');
    const attribute = (name: string): Hdf5Attribute | undefined =>
        root?.attributes.find(entry => entry.name === name);
    const attributeText = (name: string): string => {
        const values = attribute(name)?.values ?? [];
        return values.length === 1 ? String(values[0]) : '';
    };

    const configText = attributeText('model_config');
    const config = configText ? parseJsonText(configText, 'model_config', warnings) : undefined;
    if (!configText) {
        warnings.push({
            key: attribute('model_config') ? 'keras.warning.configUnreadable' : 'keras.warning.configMissingHdf5'
        });
    }

    // Three layouts reach this parser: a saved *model* keeps its parameters
    // under `/model_weights`; `model.save_weights(...)` writes the same layer
    // groups at the root instead, listed by a root `layer_names`; and an
    // extracted Keras 3 `model.weights.h5` uses the `vars/…` store.
    //
    // The discriminator is `layer_names`, not the presence of a group of some
    // name: only the two legacy writers emit that attribute, and a layer may
    // legitimately be called `layers` or `model_weights`, which would otherwise
    // route the file to the wrong walker.
    const rootLayerNames = listAttribute(root?.attributes ?? [], 'layer_names');
    const modelWeights = tree.objects.find(object => object.path === '/model_weights');
    const modelWeightNames = listAttribute(modelWeights?.attributes ?? [], 'layer_names');
    const layout: 'model-weights' | 'root-groups' | 'layer-store' =
        modelWeightNames ? 'model-weights'
            : rootLayerNames ? 'root-groups'
                : modelWeights ? 'model-weights' : 'layer-store';
    const store = layout === 'model-weights'
        ? { weights: weightsFromModelWeights(tree.objects, warnings), other: 0 }
        : layout === 'root-groups'
            ? { weights: weightsFromRootGroups(tree.objects, rootLayerNames ?? [], warnings), other: 0 }
            : weightsFromLayerStore(tree.objects, warnings);
    if (!store.weights.length && layout !== 'model-weights') warnings.push({ key: 'keras.warning.weightsMissing' });

    const trainingText = attributeText('training_config');
    const training = trainingText ? flatten(parseJsonText(trainingText, 'training_config', warnings)) : [];

    const metadata: KerasEntry[] = [];
    for (const entry of root?.attributes ?? []) {
        if (entry.name === 'model_config' || entry.name === 'training_config') continue;
        metadata.push({ label: entry.name, value: entry.values.map(value => String(value)).join(', ') });
    }
    if (store.other > 0) metadata.push({ label: 'optimizer_variables', value: String(store.other) });
    // Layer order is authoritative in `layer_names`; the HDF5 group order is
    // alphabetical and would misrepresent the model.
    const layerOrder = modelWeightNames ?? rootLayerNames ?? [];

    return buildDocument({
        format: 'Keras HDF5',
        storeKind: layout === 'layer-store' ? 'derived' : 'names',
        bytes: data.byteLength,
        config,
        kerasVersion: attributeText('keras_version'),
        backend: attributeText('backend'),
        dateSaved: '',
        training,
        metadata,
        files: [],
        weights: store.weights,
        layerOrder,
        warnings
    });
}

/**
 * Collects weight datasets from a saved model's `/model_weights` hierarchy.
 * HDF5 lists group members alphabetically, so each layer's `weight_names`
 * attribute — the order Keras itself uses — is applied where it is present.
 */
function weightsFromModelWeights(objects: readonly Hdf5Object[], warnings: KerasWarning[]): KerasWeight[] {
    return weightsFromLayerGroups(objects, '/model_weights/', undefined, warnings);
}

/**
 * Collects weight datasets from the layer groups `model.save_weights(...)`
 * writes at the root of the file. Only the groups named by the root
 * `layer_names` attribute are claimed, so an ordinary HDF5 file that happens to
 * carry a `keras_version` attribute contributes nothing.
 */
function weightsFromRootGroups(
    objects: readonly Hdf5Object[],
    layerNames: readonly string[],
    warnings: KerasWarning[]
): KerasWeight[] {
    if (!layerNames.length) return [];
    return weightsFromLayerGroups(objects, '/', new Set(layerNames), warnings);
}

/**
 * Shared walk for both `<layer>/<variable>` layouts: datasets directly below
 * `prefix`, grouped by their first path segment, ordered by that group's
 * `weight_names`.
 */
function weightsFromLayerGroups(
    objects: readonly Hdf5Object[],
    prefix: string,
    allowed: ReadonlySet<string> | undefined,
    warnings: KerasWarning[]
): KerasWeight[] {
    const layerOf = (path: string): string | undefined => {
        if (!path.startsWith(prefix)) return undefined;
        const name = path.slice(prefix.length).split('/')[0] ?? '';
        return name && (name === MODEL_OWNED_GROUP || !allowed || allowed.has(name)) ? name : undefined;
    };
    // The reserved group holds variables the model owns itself, so it maps to
    // the empty owner chain rather than to a layer of that name.
    const chainOf = (name: string): string[] => name === MODEL_OWNED_GROUP ? [] : [name];
    const order = new Map<string, string[]>();
    for (const object of objects) {
        const layer = layerOf(object.path);
        const names = layer !== undefined && object.path === `${prefix}${layer}`
            ? listAttribute(object.attributes, 'weight_names')
            : undefined;
        if (layer !== undefined && names) order.set(layerKey(chainOf(layer)), names);
    }
    const weights: KerasWeight[] = [];
    for (const object of objects) {
        const layer = object.kind === 'Dataset' ? layerOf(object.path) : undefined;
        if (layer === undefined) continue;
        if (weights.length >= MAX_WEIGHTS) {
            warnings.push({ key: 'keras.warning.weightLimit', args: { limit: MAX_WEIGHTS } });
            break;
        }
        const name = object.path.slice(prefix.length + layer.length + 1);
        weights.push(weightFromDataset(object, chainOf(layer), name));
    }
    return sortWeights(weights, weight => order.get(layerKey(weight.layerPath))?.indexOf(weight.name) ?? -1);
}

/**
 * Orders weights within each layer: by group first (so one layer's sub-objects
 * stay contiguous), then by rank, with unranked weights (rank below zero) kept
 * in file order at the end. Layers keep their first-seen order.
 */
function sortWeights(
    weights: readonly KerasWeight[],
    rank: (weight: KerasWeight) => number | { group: string; index: number }
): KerasWeight[] {
    const groups = new Map<string, KerasWeight[]>();
    for (const weight of weights) {
        const key = layerKey(weight.layerPath);
        const group = groups.get(key);
        if (group) group.push(weight);
        else groups.set(key, [weight]);
    }
    const ordered: KerasWeight[] = [];
    for (const group of groups.values()) {
        const ranked = group.map((weight, index) => {
            const key = rank(weight);
            return typeof key === 'number'
                ? { weight, index, group: '', rank: key }
                : { weight, index, group: key.group, rank: key.index };
        });
        ranked.sort((a, b) =>
            (a.group < b.group ? -1 : a.group > b.group ? 1 : 0) ||
            ((a.rank < 0 ? 1 : 0) - (b.rank < 0 ? 1 : 0)) ||
            (a.rank < 0 ? 0 : a.rank - b.rank) ||
            a.index - b.index);
        ordered.push(...ranked.map(item => item.weight));
    }
    return ordered;
}

function readWeightStore(bytes: Uint8Array, warnings: KerasWarning[]): { weights: KerasWeight[]; other: number } {
    if (findHdf5Signature(bytes) < 0) {
        warnings.push({ key: 'keras.warning.weightsUnreadable' });
        return { weights: [], other: 0 };
    }
    const tree = readHdf5Objects(bytes);
    if (tree.truncated) warnings.push({ key: 'keras.warning.structureTruncated' });
    return weightsFromLayerStore(tree.objects, warnings);
}

/**
 * Collects weight datasets from a Keras 3 weight store.
 *
 * `saving_lib._save_state` walks a saveable's children and gives each one a
 * group: a Sequential/Functional model contributes a `layers` container, while
 * a subclassed model contributes one group per *attribute* holding saveables
 * (`hidden/vars/0`, `blocks/dense/vars/0`). Every layer's variables end up in a
 * `vars` group, so a dataset is a model parameter exactly when a `vars` segment
 * precedes it, and the segments before it name the owner — with the `layers`
 * container transparent, since it is a list rather than a layer. Variables the
 * model owns itself sit at the store root (`vars/<index>`) and so have an empty
 * owner chain. Optimizer and metric state lives outside any `vars` group and is
 * only counted.
 */
function weightsFromLayerStore(
    objects: readonly Hdf5Object[],
    warnings: KerasWarning[]
): { weights: KerasWeight[]; other: number } {
    // Each `vars` group records the real layer name, which the group names
    // above it do not carry (they are attribute or class-derived names).
    const declaredNames = new Map<string, string>();
    for (const object of objects) {
        if (!object.path.endsWith('/vars')) continue;
        const declared = object.attributes.find(attribute => attribute.name === 'name')?.values[0];
        if (typeof declared === 'string' && declared) declaredNames.set(object.path, declared);
    }
    const weights: KerasWeight[] = [];
    let other = 0;
    for (const object of objects) {
        if (object.kind !== 'Dataset') continue;
        const segments = object.path.split('/').filter(Boolean);
        const parsed = TRAINING_STATE_GROUPS.has(segments[0] ?? '')
            ? undefined
            : layerChainFromStorePath(segments);
        if (!parsed) {
            other++;
            continue;
        }
        if (weights.length >= MAX_WEIGHTS) {
            warnings.push({ key: 'keras.warning.weightLimit', args: { limit: MAX_WEIGHTS } });
            break;
        }
        const declared = declaredNames.get(`/${segments.slice(0, parsed.varsIndex + 1).join('/')}`);
        weights.push(weightFromDataset(
            object,
            parsed.chain,
            parsed.name || segments[segments.length - 1] || '',
            declared
        ));
    }
    // One layer can hold several sub-objects, each numbering its own variables
    // from zero (a Bidirectional wrapper has forward_layer/… and
    // backward_layer/…), so each sub-object's variables stay together and are
    // ordered numerically inside it rather than as text.
    const rank = (weight: KerasWeight): { group: string; index: number } => {
        const match = /^(.*?)(\d+)$/.exec(weight.name);
        return match ? { group: match[1]!, index: Number(match[2]) } : { group: weight.name, index: -1 };
    };
    return { weights: sortWeights(weights, rank), other };
}

/**
 * Splits a Keras 3 store path around its first `vars` group, which is what
 * marks a dataset as a layer variable:
 *
 *   `layers/encoder/layers/dense/vars/0` → `['layers','encoder','layers','dense']`
 *   `blocks/dense/vars/1`                → `['blocks', 'dense']`
 *   `vars/0`                             → `[]` (the model's own variable)
 *
 * The `layers` container segments stay in the chain. They look redundant, but a
 * subclassed model saves an attribute directly as `<attr>/vars/…`, so dropping
 * them would give `layers/dense/…` and a sibling attribute group `dense/…` the
 * same owner and merge two distinct layers into one row.
 *
 * A path with no `vars` group (optimizer or metric state) returns undefined.
 */
function layerChainFromStorePath(
    segments: readonly string[]
): { chain: string[]; name: string; varsIndex: number } | undefined {
    const varsIndex = segments.indexOf('vars');
    if (varsIndex < 0) return undefined;
    return {
        chain: segments.slice(0, varsIndex),
        name: segments.slice(varsIndex).join('/'),
        varsIndex
    };
}

function weightFromDataset(
    object: Hdf5Object,
    layerPath: string[],
    name: string,
    declaredLayerName?: string
): KerasWeight {
    const parameters = object.dimensions.reduce((product, dimension) => product * dimension, 1);
    return {
        path: object.path,
        name: name || object.path.split('/').filter(Boolean).pop() || object.path,
        layer: declaredLayerName ?? layerPath[layerPath.length - 1] ?? '',
        ...(declaredLayerName !== undefined ? { declaredLayerName } : {}),
        layerPath,
        owner: [],
        shape: object.dimensions,
        type: object.type,
        elementBytes: object.elementSize,
        parameters,
        bytes: parameters * object.elementSize
    };
}

// ── Shared document assembly ───────────────────────────────────────────────

/** How the weight store addresses its layers: by Keras 3's class-derived group
 *  names, or by the layer names the legacy HDF5 layouts use. */
type StoreKind = 'derived' | 'names';

interface DocumentInput {
    format: KerasFormat;
    storeKind: StoreKind;
    bytes: number;
    config: unknown;
    kerasVersion: string;
    backend: string;
    dateSaved: string;
    training: KerasEntry[];
    metadata: KerasEntry[];
    files: KerasArchiveEntry[];
    weights: KerasWeight[];
    layerOrder?: string[];
    warnings: KerasWarning[];
}

function buildDocument(input: DocumentInput): KerasDocument {
    const warnings = input.warnings;
    const root = isRecord(input.config) ? input.config : undefined;
    const rootConfig = root && isRecord(root['config']) ? root['config'] : undefined;
    // A subclassed model serializes no `layers` array, so its layer list comes
    // from the weight store, which records each layer's real name.
    const configLayers = root ? collectLayers(root, warnings) : [];
    const layers = configLayers.length ? configLayers : layersFromWeights(input.weights, input.layerOrder ?? []);
    if (root && !configLayers.length && !layers.length) warnings.push({ key: 'keras.warning.noLayers' });

    // Weights are matched on the full owner chain, because a nested sub-model
    // may repeat a layer name the outer model already used. An empty chain
    // means the model owns the variable itself rather than through a layer.
    const byPath = new Map<string, KerasWeight[]>();
    const modelOwned: KerasWeight[] = [];
    for (const weight of input.weights) {
        if (!weight.layerPath.length) {
            modelOwned.push(weight);
            continue;
        }
        const key = layerKey(weight.layerPath);
        const bucket = byPath.get(key);
        if (bucket) bucket.push(weight);
        else byPath.set(key, [weight]);
    }
    const assign = (layer: KerasLayer, weights: KerasWeight[]): void => {
        layer.weights = weights;
        layer.parameters = weights.reduce((sum, weight) => sum + weight.parameters, 0);
    };
    const ownerOf = (layer: KerasLayer): string =>
        layerKey(input.storeKind === 'derived' ? layer.storePath : layer.path);
    // A layer's own internals nest further than the config describes — a
    // Bidirectional wrapper stores `…/backward_layer/cell/vars/…` — so a chain
    // is claimed by the layer matching its longest declared prefix, and the
    // segments below that prefix stay in the weight's name.
    const claimants = new Map<string, KerasLayer>();
    for (const layer of layers) {
        const key = ownerOf(layer);
        if (!claimants.has(key)) claimants.set(key, layer);
    }
    const claimed = new Map<KerasLayer, KerasWeight[]>();
    for (const [key, bucket] of [...byPath]) {
        const chain = bucket[0]!.layerPath;
        for (let depth = chain.length; depth > 0; depth--) {
            const owner = claimants.get(layerKey(chain.slice(0, depth)));
            if (!owner) continue;
            const suffix = chain.slice(depth);
            const weights = suffix.length
                ? bucket.map(weight => ({ ...weight, name: [...suffix, weight.name].join('/') }))
                : bucket;
            // `owner` is filled in once every row is settled, below.
            claimed.set(owner, [...(claimed.get(owner) ?? []), ...weights]);
            byPath.delete(key);
            break;
        }
    }
    for (const [layer, weights] of claimed) {
        assign(layer, weights);
        // Keras omits `name` from the auto-generated config of some custom
        // layers; the store still records it on the layer's own `vars` group —
        // a deeper one belongs to a sub-object and names that instead.
        if (!layer.name) {
            const declared = weights.find(weight =>
                weight.declaredLayerName && weight.layerPath.length === layer.storePath.length
            )?.declaredLayerName;
            if (declared) {
                layer.name = declared;
                layer.path = [...layer.path.slice(0, -1), declared];
            }
        }
    }
    // A legacy store need not nest the way the config does — a Keras 2 container
    // layer holds its sub-layers' weights under its own name — so leftovers fall
    // back to a layer that is unique by name and still empty. A Keras 3 store
    // addresses layers by position, where a name-based guess would be wrong
    // rather than merely incomplete, so leftovers there stay unmatched.
    if (input.storeKind === 'names') {
        for (const [key, orphans] of [...byPath]) {
            const candidates = layers.filter(layer => layer.name === orphans[0]!.layer && !layer.weights.length);
            if (candidates.length !== 1) continue;
            assign(candidates[0]!, orphans);
            byPath.delete(key);
        }
    }
    // Whatever is still unclaimed belongs to the model all the same; surfacing
    // it keeps the parameter total honest.
    let unmatched = 0;
    for (const orphans of byPath.values()) {
        const store = orphans[0]!.layerPath;
        // Show these the way a matched row reads: container groups dropped, and
        // the leaf replaced by the name the store records for the layer.
        const display = store.filter(segment => segment !== STORE_CONTAINER);
        const declared = orphans[0]!.declaredLayerName;
        if (declared && display.length) display[display.length - 1] = declared;
        if (unmatched < MAX_UNMATCHED_WARNINGS) {
            warnings.push({ key: 'keras.warning.unmatchedWeights', args: { layer: display.join('/') || store.join('/') } });
        }
        unmatched++;
        const layer = makeLayer(layers.length, display.length ? display : [...store], '', orphans, store);
        assign(layer, orphans);
        layers.push(layer);
    }
    // One banner line per orphan would bury the document; past a handful the
    // rest are reported as a count.
    if (unmatched > MAX_UNMATCHED_WARNINGS) {
        warnings.push({
            key: 'keras.warning.unmatchedWeightsMore',
            args: { count: unmatched - MAX_UNMATCHED_WARNINGS }
        });
    }
    // Variables the model holds itself are a normal Keras feature rather than a
    // mismatch, so they get a row named after the model instead of a warning.
    if (modelOwned.length) {
        // A weights-only file names no model. A Keras 3 store records the name
        // on the `vars` group itself; the legacy writer instead prefixes each
        // variable with it (`rootlayers/owned`).
        const declared = modelOwned[0]!.declaredLayerName
            ?? (modelOwned[0]!.name.includes('/') ? modelOwned[0]!.name.split('/')[0]! : '');
        const name = (rootConfig ? asText(rootConfig['name']) : '')
            || (root ? asText(root['class_name']) : '')
            || declared;
        const layer = makeLayer(layers.length, [name], root ? asText(root['class_name']) : '', modelOwned);
        assign(layer, modelOwned);
        layers.push(layer);
    }

    // Every weight now belongs to a row, so the document's list is the layers'
    // own: it keeps the two tabs consistent and lets each weight name its owner
    // with the same text the layer list shows.
    const weights: KerasWeight[] = [];
    for (const layer of layers) {
        for (const weight of layer.weights) {
            weight.owner = layer.path;
            weights.push(weight);
        }
    }
    const parameters = weights.reduce((sum, weight) => sum + weight.parameters, 0);
    const bytes = weights.reduce((sum, weight) => sum + weight.bytes, 0);
    const kerasVersion = input.kerasVersion || (root ? asText(root['keras_version']) : '');
    const backend = input.backend || (root ? asText(root['backend']) : '');
    const configText = root ? stringifyConfig(root, warnings) : '';

    const summary: KerasSummaryItem[] = [
        { labelKey: 'keras.summary.layers', value: layers.length },
        { labelKey: 'keras.summary.parameters', value: formatCount(parameters) },
        { labelKey: 'keras.summary.weightBytes', value: formatFileSize(bytes) },
        { labelKey: 'keras.summary.kerasVersion', value: kerasVersion || '—' }
    ];

    return {
        format: input.format,
        title: rootConfig ? asText(rootConfig['name']) : '',
        fileSize: formatFileSize(input.bytes),
        kerasVersion,
        backend,
        dateSaved: input.dateSaved,
        modelClass: root ? asText(root['class_name']) : '',
        modelName: rootConfig ? asText(rootConfig['name']) : '',
        layers,
        weights,
        inputs: rootConfig ? endpointNames(rootConfig['input_layers']) : [],
        outputs: rootConfig ? endpointNames(rootConfig['output_layers']) : [],
        training: input.training,
        metadata: input.metadata,
        files: input.files,
        configText,
        summary,
        warnings
    };
}

function emptyDocument(format: KerasFormat, bytes: number, warnings: KerasWarning[]): KerasDocument {
    return {
        format,
        title: '',
        fileSize: formatFileSize(bytes),
        kerasVersion: '',
        backend: '',
        dateSaved: '',
        modelClass: '',
        modelName: '',
        layers: [],
        weights: [],
        inputs: [],
        outputs: [],
        training: [],
        metadata: [],
        files: [],
        configText: '',
        summary: [{ labelKey: 'keras.summary.status', value: 'invalid' }],
        warnings
    };
}

/** Walks the serialized model config, flattening nested sub-models by depth. */
function collectLayers(root: Record<string, unknown>, warnings: KerasWarning[]): KerasLayer[] {
    const layers: KerasLayer[] = [];
    const visit = (node: unknown, depth: number, parents: readonly string[], storeParents: readonly string[]): void => {
        if (!isRecord(node) || depth > MAX_CONFIG_DEPTH) return;
        const config = isRecord(node['config']) ? node['config'] : undefined;
        const nested = config && Array.isArray(config['layers']) ? config['layers'] : undefined;
        if (!nested) return;
        // Store names are assigned per container, so the counter restarts for
        // every sub-model exactly as it does in `_save_container_state`.
        const used = new Map<string, number>();
        for (const entry of nested) {
            if (layers.length >= MAX_LAYERS) {
                warnings.push({ key: 'keras.warning.layerLimit', args: { limit: MAX_LAYERS } });
                return;
            }
            if (!isRecord(entry)) continue;
            const layer = layerFromConfig(entry, layers.length, depth, parents, storeParents, used);
            layers.push(layer);
            visit(entry, depth + 1, layer.path, layer.storePath);
        }
    };
    visit(root, 0, [], []);
    return layers;
}

function layerFromConfig(
    entry: Record<string, unknown>,
    index: number,
    depth: number,
    parents: readonly string[],
    storeParents: readonly string[],
    used: Map<string, number>
): KerasLayer {
    const config = isRecord(entry['config']) ? entry['config'] : {};
    const buildConfig = isRecord(entry['build_config']) ? entry['build_config'] : undefined;
    const activation = config['activation'];
    const name = asText(config['name']) || asText(entry['name']);
    return {
        index,
        depth,
        name,
        path: [...parents, name],
        // The store nests each container under a `layers` group, and the chain
        // read back from a store path keeps those segments, so the predicted
        // path must carry them too.
        storePath: [...storeParents, STORE_CONTAINER, storeName(asText(entry['class_name']), used)],
        className: asText(entry['class_name']),
        module: asText(entry['module']),
        registeredName: asText(entry['registered_name']),
        activation: isRecord(activation) ? asText(activation['class_name']) : asText(activation),
        inputShape: formatShape(buildConfig?.['input_shape'] ?? config['batch_input_shape'] ?? config['batch_shape']),
        dtype: dtypeName(config['dtype']),
        trainable: typeof config['trainable'] === 'boolean' ? config['trainable'] : undefined,
        parameters: 0,
        weights: [],
        // A container layer's own `layers` array is dropped: those layers are
        // listed as rows of their own rather than as one serialized blob.
        config: flatten(config, '', 0, 'layers'),
        inbound: inboundNames(entry['inbound_nodes'])
    };
}

/**
 * Fallback layer list for models whose config could not be read: the declared
 * `layer_names` order first, then any further owner the weight store reveals.
 */
function layersFromWeights(weights: readonly KerasWeight[], order: readonly string[]): KerasLayer[] {
    const paths = new Map<string, { store: string[]; name?: string }>();
    for (const name of order) paths.set(layerKey([name]), { store: [name] });
    for (const weight of weights) {
        if (!weight.layerPath.length) continue;
        paths.set(layerKey(weight.layerPath), {
            store: weight.layerPath,
            // A Keras 3 store addresses layers by attribute or class-derived
            // name; the name it records for the group is the layer's own.
            ...(weight.declaredLayerName ? { name: weight.declaredLayerName } : {})
        });
    }
    return [...paths.values()].map((entry, index) => {
        // The store's `layers` groups are containers, not layers, so they are
        // dropped from the path the UI shows and from the nesting depth.
        const display = entry.store.filter(segment => segment !== STORE_CONTAINER);
        if (entry.name) display[display.length - 1] = entry.name;
        return makeLayer(index, display.length ? display : [...entry.store], '', [], entry.store);
    });
}

function makeLayer(
    index: number,
    path: string[],
    className: string,
    weights: KerasWeight[],
    storePath = path
): KerasLayer {
    return {
        index,
        depth: path.length - 1,
        name: path[path.length - 1] ?? '',
        path,
        storePath,
        className,
        module: '',
        registeredName: '',
        activation: '',
        inputShape: '',
        dtype: '',
        trainable: undefined,
        parameters: weights.reduce((sum, weight) => sum + weight.parameters, 0),
        weights,
        config: [],
        inbound: []
    };
}

/**
 * Layer names feeding a layer. Keras 2 records `[[name, node, tensor, {}]]`
 * while Keras 3 nests a `keras_history` entry inside serialized tensors, so
 * both shapes are searched.
 */
function inboundNames(nodes: unknown): string[] {
    const names: string[] = [];
    const visit = (node: unknown, depth: number): void => {
        if (names.length >= MAX_INBOUND || depth > MAX_CONFIG_DEPTH) return;
        if (Array.isArray(node)) {
            const [first] = node;
            if (typeof first === 'string' && node.length >= 3 && typeof node[1] === 'number') {
                if (!names.includes(first)) names.push(first);
                return;
            }
            for (const child of node) visit(child, depth + 1);
            return;
        }
        if (!isRecord(node)) return;
        const history = node['keras_history'];
        if (Array.isArray(history) && typeof history[0] === 'string') {
            if (!names.includes(history[0])) names.push(history[0]);
            return;
        }
        for (const value of Object.values(node)) visit(value, depth + 1);
    };
    visit(nodes, 0);
    return names;
}

function endpointNames(value: unknown): string[] {
    const names: string[] = [];
    if (!Array.isArray(value)) return names;
    for (const entry of value) {
        if (Array.isArray(entry) && typeof entry[0] === 'string') names.push(entry[0]);
        else if (typeof entry === 'string') names.push(entry);
    }
    return names;
}

/**
 * Flattens a config object to `label = value` rows, joining nested keys with
 * dots. Capped at {@link MAX_LAYER_CONFIG_ENTRIES} rows so a pathological
 * config cannot fill the inspector.
 */
function flatten(value: unknown, prefix = '', depth = 0, skip?: string): KerasEntry[] {
    if (depth > MAX_CONFIG_DEPTH || !isRecord(value)) return [];
    const entries: KerasEntry[] = [];
    for (const [key, child] of Object.entries(value)) {
        if (key === skip) continue;
        const label = prefix ? `${prefix}.${key}` : key;
        if (isRecord(child)) {
            const nested = flatten(child, label, depth + 1);
            if (nested.length) entries.push(...nested);
            else entries.push({ label, value: '{}' });
        } else {
            entries.push({ label, value: formatScalar(child) });
        }
        if (entries.length >= MAX_LAYER_CONFIG_ENTRIES) break;
    }
    return entries.slice(0, MAX_LAYER_CONFIG_ENTRIES);
}

function formatScalar(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return '';
    if (Array.isArray(value) || isRecord(value)) return truncate(safeStringify(value));
    return truncate(String(value));
}

function formatShape(value: unknown): string {
    if (!Array.isArray(value)) return '';
    return value.map(entry => entry === null ? '?' : typeof entry === 'number' ? String(entry) : '?').join(' × ');
}

function stringifyConfig(config: Record<string, unknown>, warnings: KerasWarning[]): string {
    const text = safeStringify(config, 2);
    if (text.length <= MAX_CONFIG_TEXT_CHARS) return text;
    warnings.push({ key: 'keras.warning.configTruncated', args: { limit: MAX_CONFIG_TEXT_CHARS } });
    return text.slice(0, MAX_CONFIG_TEXT_CHARS);
}

function safeStringify(value: unknown, space?: number): string {
    try {
        return JSON.stringify(value, undefined, space) ?? '';
    } catch {
        return '';
    }
}

function truncate(text: string): string {
    return text.length > MAX_CONFIG_VALUE_CHARS ? `${text.slice(0, MAX_CONFIG_VALUE_CHARS - 1)}…` : text;
}

function decodeJson(bytes: Uint8Array | undefined, name: string, warnings: KerasWarning[]): unknown {
    if (!bytes) return undefined;
    return parseJsonText(new TextDecoder('utf-8', { fatal: false }).decode(bytes), name, warnings);
}

function parseJsonText(text: string, name: string, warnings: KerasWarning[]): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        warnings.push({ key: 'keras.warning.jsonInvalid', args: { name } });
        return undefined;
    }
}

// ── ZIP central directory ──────────────────────────────────────────────────

interface ZipEntry {
    name: string;
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CDFH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/**
 * Reads the central directory. ZIP64 and multi-disk archives return null: a
 * Keras model that needs either is beyond what this viewer inspects.
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
            name: new TextDecoder('utf-8', { fatal: false }).decode(data.subarray(nameStart, nameStart + nameLength)),
            method: view.getUint16(position + 10, true),
            compressedSize: view.getUint32(position + 20, true),
            uncompressedSize: view.getUint32(position + 24, true),
            localHeaderOffset: view.getUint32(position + 42, true)
        });
        position = nameStart + nameLength + extraLength + commentLength;
    }
    return { entries, truncated: declared > count };
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

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * The group name Keras gives a layer inside a Keras 3 weight store.
 *
 * `saving_lib._save_container_state` names each child after its *class*, in
 * container order, deduplicated per container — its comment is explicit that
 * the saveable must not be addressed by `saveable.name`, because layer names
 * are autogenerated per process and would not survive a reload. A model whose
 * layers are renamed, or a second model built in the same session, therefore
 * has store names that do not match its layer names at all, and matching
 * weights by layer name would attach them to the wrong layer.
 */
function storeName(className: string, used: Map<string, number>): string {
    const base = toSnakeCase(className);
    const seen = used.get(base);
    if (seen === undefined) {
        used.set(base, 0);
        return base;
    }
    used.set(base, seen + 1);
    return `${base}_${seen + 1}`;
}

/**
 * Keras 3 serializes `dtype` as a DTypePolicy object whose useful value is the
 * policy's name (`float32`, `mixed_float16`); Keras 2 stores the string itself.
 */
function dtypeName(value: unknown): string {
    if (!isRecord(value)) return asText(value);
    const policy = isRecord(value['config']) ? asText(value['config']['name']) : '';
    return policy || asText(value['class_name']);
}

/**
 * `keras.src.utils.naming.to_snake_case`: `BatchNormalization` →
 * `batch_normalization`. Python's `\W` is Unicode-aware where JavaScript's is
 * ASCII-only, so the character class is spelled out; the case-splitting
 * patterns are ASCII in Keras too and are copied verbatim.
 */
function toSnakeCase(name: string): string {
    return name
        .replace(/[^\p{L}\p{N}_]+/gu, '')
        .replace(/(.)([A-Z][a-z]+)/g, '$1_$2')
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .toLowerCase();
}

/** Map key for a layer chain. NUL separates the levels because it cannot
 *  occur in an HDF5 link name, so no layer name can forge a different chain. */
function layerKey(path: readonly string[]): string {
    return path.join('\u0000');
}

/**
 * Reads a Keras list attribute (`layer_names`, `weight_names`).
 * `save_attributes_to_hdf5_group` splits a list that would overflow the 64 KB
 * object-header limit into `name0`, `name1`, … and then writes no unsuffixed
 * attribute at all, so both spellings are accepted.
 */
function listAttribute(attributes: readonly Hdf5Attribute[], name: string): string[] | undefined {
    const single = attributes.find(attribute => attribute.name === name);
    if (single) return single.values.map(value => String(value));
    const values: string[] = [];
    for (let chunk = 0; chunk < MAX_ATTRIBUTE_CHUNKS; chunk++) {
        const part = attributes.find(attribute => attribute.name === `${name}${chunk}`);
        if (!part) break;
        values.push(...part.values.map(value => String(value)));
    }
    return values.length ? values : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
    return typeof value === 'string' ? truncate(value) : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

function hasPrefix(data: Uint8Array, prefix: readonly number[]): boolean {
    return data.byteLength >= prefix.length && prefix.every((byte, index) => data[index] === byte);
}

/** HDF5 permits a user block before the signature at 0, 512, 1024, 2048, … */
function findHdf5Signature(data: Uint8Array): number {
    let offset = 0;
    while (offset + HDF5_SIGNATURE.length <= data.byteLength) {
        if (HDF5_SIGNATURE.every((byte, index) => data[offset + index] === byte)) return offset;
        offset = offset === 0 ? 512 : offset * 2;
    }
    return -1;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');
    }
}

export function formatCount(count: number): string {
    if (count < 1000) return String(count);
    for (const [threshold, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
        if (count >= threshold) {
            const value = count / threshold;
            return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2) + suffix;
        }
    }
    return String(count);
}
