import { describe, expect, it } from 'vitest';
import {
    bareWeightStoreHdf5,
    chunkedLayerNamesHdf5,
    cnnKerasArchive,
    collidingStoreNamesArchive,
    kerasSavedWeightsHdf5,
    kerasWeightStore,
    legacyKerasHdf5,
    modelOwnedWeightArchive,
    modelOwnedWeightHdf5,
    nestedKerasArchive,
    plainHdf5,
    rnnKerasArchive,
    rootLayersNamedHdf5,
    subclassedKerasArchive,
    swapKerasArchive,
    unicodeClassArchive,
    unnamedLayerArchive
} from './__tests__/fixture.js';
import { looksLikeKerasHdf5, parseKeras, type KerasDocument } from './index.js';

const warningKeys = (model: KerasDocument): string[] => model.warnings.map(warning => warning.key);
const layer = (model: KerasDocument, name: string): KerasDocument['layers'][number] => {
    const found = model.layers.find(entry => entry.name === name);
    if (!found) throw new Error(`missing layer: ${name}`);
    return found;
};

describe('parseKeras — Keras 3 archive', () => {
    it('matches weights on the store names Keras derives from class names', async () => {
        // The model names its layers dense_1 then dense, while the store names
        // them dense then dense_1: matching by layer name would swap the two.
        const model = await parseKeras(swapKerasArchive(), 'swap.keras');

        expect(model.format).toBe('Keras v3');
        expect(model.kerasVersion).toBe('3.15.1');
        expect(model.modelClass).toBe('Functional');
        expect(warningKeys(model)).toEqual([]);
        expect(model.layers.map(entry => [entry.name, entry.storePath.join('/'), entry.parameters])).toEqual([
            ['in', 'layers/input_layer', 0],
            ['dense_1', 'layers/dense', 32],
            ['dense', 'layers/dense_1', 18]
        ]);
        expect(layer(model, 'dense_1').weights.map(weight => weight.shape)).toEqual([[3, 8], [8]]);
        expect(layer(model, 'dense').weights.map(weight => weight.shape)).toEqual([[8, 2], [2]]);
        expect(model.inputs).toEqual(['in']);
        expect(model.outputs).toEqual(['dense']);
        expect(layer(model, 'dense').inbound).toEqual(['dense_1']);
    });

    it('reads a renamed layer, its dtype policy, and keeps optimizer state out of the totals', async () => {
        const model = await parseKeras(cnnKerasArchive(), 'cnn.keras');

        expect(warningKeys(model)).toEqual([]);
        expect(model.layers.map(entry => [entry.name, entry.className, entry.parameters])).toEqual([
            ['input_layer', 'InputLayer', 0],
            ['conv2d', 'Conv2D', 112],
            ['batch_normalization', 'BatchNormalization', 16],
            ['flatten', 'Flatten', 0],
            ['head', 'Dense', 325]
        ]);
        // `head` is stored as `dense`, the model's first Dense-derived name.
        expect(layer(model, 'head').storePath).toEqual(['layers', 'dense']);
        // Keras 3 serializes dtype as a DTypePolicy object, not a bare string.
        expect(layer(model, 'head').dtype).toBe('float32');
        expect(model.summary).toContainEqual({ labelKey: 'keras.summary.parameters', value: '453' });
        expect(model.metadata).toContainEqual({ label: 'optimizer_variables', value: '2' });
        expect(model.weights.every(weight => weight.path.startsWith('/layers/'))).toBe(true);
    });

    it('flattens a nested sub-model and keeps its store nesting', async () => {
        const model = await parseKeras(nestedKerasArchive(), 'nested.keras');

        expect(model.files.every(file => file.method === 'stored')).toBe(true);
        expect(model.layers.map(entry => [entry.name, entry.depth, entry.storePath.join('/')])).toEqual([
            ['features', 0, 'layers/input_layer'],
            ['encoder', 0, 'layers/sequential'],
            ['input_layer_1', 1, 'layers/sequential/layers/input_layer'],
            ['encoded', 1, 'layers/sequential/layers/dense'],
            ['logits', 0, 'layers/dense']
        ]);
        expect(layer(model, 'encoded').parameters).toBe(16);
        expect(layer(model, 'logits').parameters).toBe(10);
        expect(layer(model, 'encoder').inbound).toEqual(['features']);
        expect(layer(model, 'logits').inbound).toEqual(['encoder']);
        // A container layer's own `layers` array is not repeated as a config row.
        expect(layer(model, 'encoder').config.map(entry => entry.label)).not.toContain('layers');
        expect(model.training).toContainEqual({ label: 'loss', value: 'mse' });
    });

    it('counts variables the model owns itself, which sit outside the layer subtree', async () => {
        // `Model.add_weight` stores its variable at the root of the weight
        // store as `vars/0`, not under `layers/`.
        const model = await parseKeras(modelOwnedWeightArchive(), 'owner.keras');

        expect(warningKeys(model)).toEqual([]);
        expect(model.summary).toContainEqual({ labelKey: 'keras.summary.parameters', value: '20' });
        expect(model.layers.map(entry => [entry.name, entry.className, entry.parameters])).toEqual([
            ['features', 'InputLayer', 0],
            ['head', 'Dense', 15],
            ['owner', 'Functional', 5]
        ]);
        expect(layer(model, 'owner').weights.map(weight => weight.path)).toEqual(['/vars/0']);
        // The model's own variable is not optimizer state.
        expect(model.metadata.map(entry => entry.label)).not.toContain('optimizer_variables');
    });

    it('keeps each sub-object of a wrapper layer contiguous and numerically ordered', async () => {
        const model = await parseKeras(rnnKerasArchive(), 'rnn.keras');

        expect(layer(model, 'bi').weights.map(weight => weight.name)).toEqual([
            'backward_layer/cell/vars/0',
            'backward_layer/cell/vars/1',
            'backward_layer/cell/vars/2',
            'forward_layer/cell/vars/0',
            'forward_layer/cell/vars/1',
            'forward_layer/cell/vars/2'
        ]);
        expect(layer(model, 'bi').parameters).toBe(96);
        expect(layer(model, 'out').parameters).toBe(5);
    });
});

describe('parseKeras — legacy HDF5', () => {
    it('reads the model config, layers, and weights from the root attributes', async () => {
        const model = await parseKeras(legacyKerasHdf5(), 'sequential.h5');

        expect(model.format).toBe('Keras HDF5');
        expect(model.kerasVersion).toBe('3.15.1');
        expect(model.backend).toBe('numpy');
        expect(model.modelClass).toBe('Sequential');
        expect(model.modelName).toBe('sequential');
        expect(warningKeys(model)).toEqual([]);

        expect(model.layers.map(entry => [entry.name, entry.className, entry.parameters])).toEqual([
            ['input_layer_3', 'InputLayer', 0],
            ['dense', 'Dense', 16],
            ['dropout', 'Dropout', 0],
            ['dense_1', 'Dense', 10]
        ]);
        expect(layer(model, 'dense')).toMatchObject({ activation: 'relu', dtype: 'float32', trainable: true });
        expect(layer(model, 'dropout').config).toContainEqual({ label: 'rate', value: '0.25' });
        expect(model.summary).toContainEqual({ labelKey: 'keras.summary.parameters', value: '26' });
    });

    it('orders each layer\'s weights by the weight_names attribute, not HDF5 group order', async () => {
        const model = await parseKeras(legacyKerasHdf5(), 'sequential.h5');

        expect(layer(model, 'dense').weights.map(weight => [weight.name, weight.shape])).toEqual([
            ['sequential/dense/kernel', [3, 4]],
            ['sequential/dense/bias', [4]]
        ]);
        expect(layer(model, 'dense').weights[0]).toMatchObject({
            path: '/model_weights/dense/sequential/dense/kernel',
            layer: 'dense',
            layerPath: ['dense'],
            type: 'Float32',
            elementBytes: 4,
            parameters: 12,
            bytes: 48
        });
    });

    it('reads model-owned variables out of the reserved top-level group', async () => {
        // Saving the same model as `.keras` and as `.h5` must report the same
        // parameters: the legacy writer puts the model's own variable in
        // `/model_weights/top_level_model_weights` rather than at the root.
        const model = await parseKeras(modelOwnedWeightHdf5(), 'owner.h5');

        expect(warningKeys(model)).toEqual([]);
        expect(model.layers.map(entry => [entry.name, entry.parameters])).toEqual([
            ['features', 0],
            ['head', 15],
            ['owner', 5]
        ]);
        expect(layer(model, 'owner').weights.map(weight => weight.name)).toEqual(['owner/bias_correction']);
        expect(model.weights.reduce((sum, weight) => sum + weight.parameters, 0)).toBe(20);
    });

    it('keeps optimizer state out of the model parameter count', async () => {
        const model = await parseKeras(legacyKerasHdf5(), 'sequential.h5');

        expect(model.weights.every(weight => weight.path.startsWith('/model_weights/'))).toBe(true);
        expect(model.weights.reduce((sum, weight) => sum + weight.parameters, 0)).toBe(26);
    });

    it('exposes the training configuration and file metadata', async () => {
        const model = await parseKeras(legacyKerasHdf5(), 'sequential.h5');

        expect(model.training).toContainEqual({ label: 'loss', value: 'categorical_crossentropy' });
        expect(model.training.some(entry => entry.label.startsWith('optimizer_config'))).toBe(true);
        expect(model.metadata).toContainEqual({ label: 'backend', value: 'numpy' });
        expect(model.metadata.map(entry => entry.label)).not.toContain('model_config');
        expect(model.configText).toContain('"class_name": "Sequential"');
    });
});

describe('parseKeras — other store layouts', () => {
    it('reads the root layer groups that model.save_weights writes', async () => {
        const model = await parseKeras(kerasSavedWeightsHdf5(), 'checkpoint.h5');

        // A weights-only checkpoint has no config; the layers come from
        // `layer_names`, in the order the model declared them.
        expect(warningKeys(model)).toEqual(['keras.warning.configMissingHdf5']);
        expect(model.layers.map(entry => entry.name)).toEqual(['dense_input', 'dense', 'dense_1']);
        expect(model.weights.reduce((sum, weight) => sum + weight.parameters, 0)).toBe(26);
        // Keras names each dataset after the variable, so HDF5 nests a group of
        // that name inside the layer group.
        expect(layer(model, 'dense').weights.map(weight => [weight.name, weight.path])).toEqual([
            ['dense/kernel:0', '/dense/dense/kernel:0'],
            ['dense/bias:0', '/dense/dense/bias:0']
        ]);
        // The tensors are the model's parameters, not optimizer state.
        expect(model.metadata.map(entry => entry.label)).not.toContain('optimizer_variables');
    });

    it('reads a subclassed model, whose store names children after attributes', async () => {
        // `_save_state` only emits a `layers` container for Sequential and
        // Functional models; a subclassed model gets one group per attribute,
        // and each `vars` group records the layer's real name.
        const model = await parseKeras(subclassedKerasArchive(), 'block.keras');

        expect(warningKeys(model)).toEqual([]);
        expect(model.layers.map(entry => [entry.name, entry.parameters])).toEqual([
            ['b0', 15],
            ['b1', 8],
            ['hidden', 16],
            ['Block', 5]
        ]);
        expect(model.weights.reduce((sum, weight) => sum + weight.parameters, 0)).toBe(44);
        // The store's own group names are attribute names, not layer names.
        expect(model.weights.map(weight => weight.path)).toContain('/blocks/dense/vars/0');
    });

    it('derives store names with a Unicode-aware snake_case', async () => {
        // Keras snake-cases the class name with Python's Unicode `\W`; an
        // ASCII-only equivalent would predict `dens` and lose the weights.
        const model = await parseKeras(unicodeClassArchive(), 'uni.keras');

        expect(warningKeys(model)).toEqual([]);
        expect(layer(model, 'accented')).toMatchObject({ storePath: ['layers', 'densé'], parameters: 16 });
        expect(model.weights.reduce((sum, weight) => sum + weight.parameters, 0)).toBe(16);
    });

    it('names a layer from the store when its config omits the name', async () => {
        const model = await parseKeras(unnamedLayerArchive(), 'direct.keras');

        expect(warningKeys(model)).toEqual([]);
        expect(model.layers.map(entry => [entry.name, entry.parameters])).toEqual([
            ['input_layer', 0],
            ['blk', 25]
        ]);
        // The weights table names the same owner the layer list shows.
        expect(model.weights.map(weight => weight.owner)).toEqual([['blk'], ['blk']]);
    });

    it('separates an attribute group from a layers-container child of the same name', async () => {
        // A subclassed model saves `self.dense` as `/dense/…` while the layer
        // reached through its `layers` container is `/layers/dense/…`; keeping
        // the container segment in the owner chain keeps the two apart.
        const model = await parseKeras(collidingStoreNamesArchive(), 'collide.keras');

        expect(warningKeys(model)).toEqual([]);
        expect(model.layers.map(entry => [entry.name, entry.storePath.join('/'), entry.parameters])).toEqual([
            ['attr_dense', 'dense', 12],
            ['out_layer', 'layers/dense', 8]
        ]);
        expect(model.weights.reduce((sum, weight) => sum + weight.parameters, 0)).toBe(20);
    });

    it('names a bare weight store\'s model row from the name the store records', async () => {
        const model = await parseKeras(bareWeightStoreHdf5(), 'model.weights.h5');

        expect(warningKeys(model)).toEqual(['keras.warning.configMissingHdf5']);
        expect(model.layers.map(entry => [entry.name, entry.parameters])).toEqual([
            ['dd', 8],
            ['ownermodel', 7]
        ]);
        expect(model.weights.reduce((sum, weight) => sum + weight.parameters, 0)).toBe(15);
    });

    it('chooses the store layout by layer_names, not by a group\'s name', async () => {
        // This checkpoint has a layer literally named `layers`, which must not
        // route the file to the Keras 3 store walker.
        const model = await parseKeras(rootLayersNamedHdf5(), 'ckpt.h5');

        expect(warningKeys(model)).toEqual(['keras.warning.configMissingHdf5']);
        expect(model.layers.map(entry => [entry.name, entry.parameters])).toEqual([
            ['in7', 0],
            ['layers', 16],
            ['tail', 10],
            ['rootlayers', 1]
        ]);
        expect(model.weights.reduce((sum, weight) => sum + weight.parameters, 0)).toBe(27);
        // `weight_names` ordering survives: kernel before bias.
        expect(layer(model, 'tail').weights.map(weight => weight.name)).toEqual(['tail/kernel', 'tail/bias']);
        expect(model.metadata.map(entry => entry.label)).not.toContain('optimizer_variables');
    });

    it('reads a layer_names list that Keras split across chunk attributes', async () => {
        const model = await parseKeras(chunkedLayerNamesHdf5(), 'wide.h5');

        // `save_attributes_to_hdf5_group` writes layer_names0/1 and no
        // unsuffixed attribute once the list passes the object-header limit.
        expect(model.layers).toHaveLength(450);
        expect(model.layers.map(entry => entry.name.slice(-3)).slice(0, 3)).toEqual(['000', '001', '002']);
        expect(model.layers[449]!.name).toMatch(/449$/);
        // Both chunks are read, so the weights still land on their own layer.
        expect(layer(model, model.layers[449]!.name).weights.map(weight => weight.parameters)).toEqual([2]);
    });

    it('reads a Keras 3 weight store handed over without its archive', async () => {
        const model = await parseKeras(kerasWeightStore(), 'model.weights.h5');

        expect(warningKeys(model)).toEqual(['keras.warning.configMissingHdf5']);
        // Without a config the layers come from the store, which addresses both
        // by the class-derived name `dense`; the owner chain keeps them apart
        // and each `vars` group's `name` attribute supplies the real name.
        expect(model.layers.map(entry => [entry.name, entry.path, entry.parameters])).toEqual([
            ['logits', ['logits'], 10],
            ['encoded', ['sequential', 'encoded'], 16]
        ]);
        expect(model.weights.reduce((sum, weight) => sum + weight.parameters, 0)).toBe(26);
    });
});

describe('parseKeras — degradation', () => {
    it('reports a plain HDF5 file as carrying no model', async () => {
        const model = await parseKeras(plainHdf5(), 'sensors.h5');

        expect(model.format).toBe('Keras HDF5');
        expect(model.layers).toEqual([]);
        expect(warningKeys(model)).toEqual(['keras.warning.configMissingHdf5', 'keras.warning.weightsMissing']);
        expect(model.summary).toContainEqual({ labelKey: 'keras.summary.layers', value: 0 });
    });

    it('falls back to the weight store when the config cannot be parsed', async () => {
        const bytes = legacyKerasHdf5();
        // Blank the model_config JSON in place; the attribute survives, its
        // payload no longer parses.
        const marker = new TextEncoder().encode('{"module": "keras"');
        const start = indexOfBytes(bytes, marker);
        expect(start).toBeGreaterThan(0);
        bytes.fill(0x20, start, start + marker.length);

        const model = await parseKeras(bytes, 'sequential.h5');
        expect(warningKeys(model)).toContain('keras.warning.jsonInvalid');
        // Layer order still comes from the `layer_names` attribute, which lists
        // the weight-bearing layers Keras saved rather than the config's layers.
        expect(model.layers.map(entry => entry.name)).toEqual(['dense', 'dropout', 'dense_1']);
        expect(model.layers.every(entry => entry.className === '')).toBe(true);
        expect(layer(model, 'dense').parameters).toBe(16);
    });

    it('skips an oversized member and an unsupported compression method', async () => {
        const model = await parseKeras(makeArchive([
            // A crafted directory can declare any size; the limit is applied
            // before anything is inflated.
            { name: 'config.json', method: 8, uncompressedSize: 64 * 1024 * 1024 },
            { name: 'model.weights.h5', method: 12, uncompressedSize: 1024 }
        ]), 'crafted.keras');

        expect(model.warnings).toContainEqual({
            key: 'keras.warning.memberTooLarge', args: { name: 'config.json', limit: '32.0 MB' }
        });
        expect(model.warnings).toContainEqual({
            key: 'keras.warning.memberMethod', args: { name: 'model.weights.h5', method: 12 }
        });
        expect(warningKeys(model)).toContain('keras.warning.configMissing');
        expect(model.layers).toEqual([]);
    });

    it('rejects bytes that are neither an archive nor HDF5', async () => {
        const model = await parseKeras(new TextEncoder().encode('not a model'), 'model.keras');

        expect(model.format).toBe('Keras v3');
        expect(warningKeys(model)).toEqual(['keras.warning.notKeras']);
        expect(model.summary).toEqual([{ labelKey: 'keras.summary.status', value: 'invalid' }]);
    });

    it('reports an archive whose central directory is unreadable', async () => {
        const model = await parseKeras(swapKerasArchive().subarray(0, 64), 'swap.keras');

        expect(warningKeys(model)).toEqual(['keras.warning.archiveUnreadable']);
    });

    it('honours an abort signal', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(parseKeras(legacyKerasHdf5(), 'sequential.h5', { signal: controller.signal }))
            .rejects.toThrow();
    });
});

describe('looksLikeKerasHdf5', () => {
    it('separates Keras HDF5 models from other HDF5 files', () => {
        expect(looksLikeKerasHdf5(legacyKerasHdf5())).toBe(true);
        expect(looksLikeKerasHdf5(kerasSavedWeightsHdf5())).toBe(true);
        expect(looksLikeKerasHdf5(plainHdf5())).toBe(false);
        expect(looksLikeKerasHdf5(swapKerasArchive())).toBe(false);
        expect(looksLikeKerasHdf5(new Uint8Array(16))).toBe(false);
    });
});

/**
 * A ZIP holding only a central directory and its EOCD — enough for the member
 * scan, which reads names, methods, and sizes from the directory alone.
 */
function makeArchive(entries: ReadonlyArray<{ name: string; method: number; uncompressedSize: number }>): Uint8Array {
    const encoder = new TextEncoder();
    const headers = entries.map(entry => {
        const name = encoder.encode(entry.name);
        const buffer = new Uint8Array(46 + name.length);
        const view = new DataView(buffer.buffer);
        view.setUint32(0, 0x02014b50, true);
        view.setUint16(10, entry.method, true);
        view.setUint32(24, entry.uncompressedSize, true);
        view.setUint16(28, name.length, true);
        buffer.set(name, 46);
        return buffer;
    });
    const directorySize = headers.reduce((total, header) => total + header.length, 0);
    const eocd = new Uint8Array(22);
    const view = new DataView(eocd.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, entries.length, true);
    view.setUint16(10, entries.length, true);
    view.setUint32(12, directorySize, true);
    view.setUint32(16, 0, true);

    const out = new Uint8Array(directorySize + eocd.length);
    let position = 0;
    for (const header of headers) {
        out.set(header, position);
        position += header.length;
    }
    out.set(eocd, position);
    return out;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
    outer: for (let start = 0; start + needle.length <= haystack.length; start++) {
        for (let index = 0; index < needle.length; index++) {
            if (haystack[start + index] !== needle[index]) continue outer;
        }
        return start;
    }
    return -1;
}
