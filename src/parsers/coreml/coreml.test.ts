import { describe, expect, it } from 'vitest';
import {
    ProtoBuilder,
    buildZip,
    coremlBigMetadataFixture,
    coremlBranchFixture,
    coremlDeepBlockFixture,
    coremlDualOutputFixture,
    coremlKnnFixture,
    coremlLabelGalleryFixture,
    coremlLargeImmediateFixture,
    coremlMultiFunctionFixture,
    coremlNestedPipelineFixture,
    coremlNeuralNetworkFixture,
    coremlPackageFixture,
    coremlPackedScalarFixture,
    coremlParametricActivationFixture,
    coremlPipelineClassifierFixture,
    coremlPipelineFixture,
    coremlProgramCustomOpFixture,
    coremlProgramFixture,
    coremlRecurrentFixture,
    coremlScopedBlockFixture,
    coremlUnorderedBlockFixture,
    coremlWideBlockFixture,
    coremlWideNetworkFixture,
    onnxLookalikeBytes
} from './__tests__/fixture.js';
import {
    CoremlParseError,
    looksLikeCoremlSpec,
    parseCoreml,
    parseCoremlSpec,
    type CoremlDocument,
    type CoremlNode
} from './index.js';

const node = (model: CoremlDocument, name: string): CoremlNode =>
    model.graphs.flatMap(graph => graph.nodes).find(item => item.name === name)!;

const attribute = (item: CoremlNode, key: string): string | undefined =>
    item.attributes.find(entry => entry.key === key)?.value;

const port = (item: CoremlNode, name: string): string[] =>
    (item.inputs.find(entry => entry.name === name)?.values ?? []).map(binding => binding.text);

describe('parseCoremlSpec — ML Program', () => {
    const model = parseCoremlSpec(coremlProgramFixture());

    it('reads the specification version, availability, and metadata', () => {
        expect(model.format).toBe('coreml');
        expect(model.modelType).toBe('mlProgram');
        expect(model.specificationVersion).toBe(8);
        expect(model.availability).toBe('iOS 17 · macOS 14 (Core ML 7)');
        // The version log spells specification 2 "Core ML 1.2", not "Core ML 1".
        expect(parseCoremlSpec(new ProtoBuilder().varint(1, 2).message(500, new ProtoBuilder()).build()).availability)
            .toBe('iOS 11.2 · macOS 10.13.2 (Core ML 1.2)');
        expect(model.author).toBe('Omni Viewer');
        expect(model.license).toBe('MIT');
        expect(model.versionString).toBe('2.1');
        expect(model.userDefined).toEqual([
            { key: 'com.omni.trained_on', value: 'fixtures' },
            { key: 'com.omni.source', value: 'unit-test' }
        ]);
        expect(model.packaged).toBe(false);
    });

    it('renders every feature type the description declares', () => {
        const main = model.functions[0]!;
        expect(main.isDefault).toBe(true);
        expect(main.inputs[0]).toMatchObject({
            name: 'image', typeKind: 'image', type: 'image 224 × 224 RGB'
        });
        expect(main.outputs.map(item => item.type)).toEqual([
            'multiArray FLOAT32[2]', 'dictionary<string, double>'
        ]);
        expect(main.predictedFeatureName).toBe('classLabel');
        expect(main.predictedProbabilitiesName).toBe('classLabelProbs');
    });

    it('records the function block as a graph and its nested block as a child', () => {
        const main = model.graphs.find(graph => graph.name === 'main')!;
        expect(main.kind).toBe('program');
        expect(main.opset).toBe('CoreML7');
        expect(main.inputs).toEqual([{ name: 'image', type: 'FLOAT32[1, 3, 224, 224]' }]);
        expect(main.outputs).toEqual(['probabilities']);
        expect(main.nodes.map(item => item.type)).toEqual([
            'const', 'const', 'conv', 'relu', 'cond', 'softmax'
        ]);

        const child = model.graphs.find(graph => graph.parentId === main.id)!;
        expect(child.kind).toBe('block');
        expect(child.depth).toBe(1);
        expect(node(model, 'branch_out').graphs).toEqual([child.id]);
        expect(child.nodes[0]!.type).toBe('reduce_mean');
    });

    it('names operands and decodes immediate values as literals', () => {
        const conv = node(model, 'conv_out');
        expect(conv.inputs.map(item => item.name)).toEqual(['x', 'weight', 'bias', 'strides', 'pad_type']);
        expect(port(conv, 'x')).toEqual(['image']);
        expect(port(conv, 'strides')).toEqual(['[2, 2]']);
        expect(port(conv, 'pad_type')).toEqual(['"same"']);
        // A single-element tensor renders as the scalar it represents.
        expect(port(node(model, 'probabilities'), 'axis')).toEqual(['1']);
    });

    it('resolves blob-backed constants to a file, an offset, and a byte count', () => {
        const weights = node(model, 'conv_weight');
        expect(weights.constant).toBe(true);
        expect(weights.weights).toHaveLength(1);
        expect(weights.weights[0]).toMatchObject({
            name: 'val', dataType: 'FLOAT16', shape: ['32', '3', '3', '3'],
            elementCount: '864', byteLength: '1728', storage: 'blob',
            file: '@model_path/weights/weight.bin', offset: '64'
        });
    });

    it('reads a const payload out of the attributes map, where coremltools puts it', () => {
        // `translate_const` emits no inputs at all: the tensor lives in
        // `attributes["val"]`, so reading only `Operation.inputs` would report
        // a model with zero parameters.
        const weights = node(model, 'conv_weight');
        expect(weights.inputs).toEqual([]);
        expect(weights.weights[0]!.storage).toBe('blob');
        // The sibling `name` attribute is an immediate value, not a weight.
        expect(attribute(weights, 'name')).toBe('"conv_weight"');
        expect(model.weightFiles).toEqual([{
            name: '@model_path/weights/weight.bin',
            referenceCount: 2,
            referencedBytes: '1792',
            byteLength: '',
            present: false
        }]);
    });

    it('keeps reading an inline value bound through an operand', () => {
        // `translate_generic_op` binds a literal parameter this way, so both
        // encodings have to work.
        expect(port(node(model, 'conv_out'), 'pad_type')).toEqual(['"same"']);
    });

    it('totals the weight blob and reports it as unavailable outside a package', () => {
        expect(model.weightFiles).toEqual([{
            name: '@model_path/weights/weight.bin',
            referenceCount: 2,
            referencedBytes: '1792',
            byteLength: '',
            present: false
        }]);
        expect(model.warnings.map(item => item.key)).toContain('coreml.warning.blobUnavailable');
    });

    it('summarizes the model for the viewer header', () => {
        expect(model.summary).toEqual([
            { labelKey: 'coreml.summary.operations', value: 7 },
            { labelKey: 'coreml.summary.graphs', value: 2 },
            { labelKey: 'coreml.summary.inputs', value: 1 },
            { labelKey: 'coreml.summary.outputs', value: 2 },
            { labelKey: 'coreml.summary.functions', value: 1 },
            { labelKey: 'coreml.summary.specVersion', value: 8 }
        ]);
    });
});

describe('parseCoremlSpec — neural network', () => {
    const model = parseCoremlSpec(coremlNeuralNetworkFixture());

    it('resolves the model type, updatability, and class labels', () => {
        expect(model.modelType).toBe('neuralNetworkClassifier');
        expect(model.isUpdatable).toBe(true);
        expect(model.classLabels).toEqual({ kind: 'string', values: ['cat', 'dog'], total: 2 });
        expect(model.functions[0]!.trainingInputs.map(item => item.name)).toEqual(['target']);
        expect(model.functions[0]!.trainingInputs[0]!.optional).toBe(true);
    });

    it('names every layer type, including one with no attribute schema', () => {
        const graph = model.graphs[0]!;
        expect(graph.kind).toBe('network');
        expect(graph.opset).toBe('EXACT_ARRAY_MAPPING · RANK4_IMAGE_MAPPING');
        expect(graph.description).toBe('image: scaler');
        expect(graph.nodes.map(item => item.type)).toEqual([
            'convolution', 'activation', 'pooling', 'reorganizeData', 'innerProduct', 'custom', 'softmax'
        ]);
    });

    it('derives the graph outputs from the layer operands', () => {
        // A NeuralNetwork names no outputs, so the sinks are the layer outputs
        // nothing consumes — here the classifier's probability tensor.
        expect(model.graphs[0]!.outputs).toEqual(['probabilities']);
    });

    it('keeps a declared output that a later layer also consumes', () => {
        // A feature extractor exposes its embedding beside its logits; a
        // sink-only rule drops the embedding because the head reads it.
        const extractor = parseCoremlSpec(coremlDualOutputFixture());
        expect(extractor.graphs[0]!.outputs).toEqual(['features', 'logits']);
    });

    it('decodes attributes for the layer types it has a schema for', () => {
        const conv = node(model, 'conv1');
        expect(attribute(conv, 'outputChannels')).toBe('32');
        expect(attribute(conv, 'kernelSize')).toBe('[3, 3]');
        expect(attribute(conv, 'stride')).toBe('[2, 2]');
        expect(attribute(conv, 'padding')).toBe('valid');
        expect(attribute(conv, 'hasBias')).toBe('true');
        expect(attribute(node(model, 'relu1'), 'nonlinearity')).toBe('ReLU');
        expect(attribute(node(model, 'pool1'), 'type')).toBe('AVERAGE');
        expect(attribute(node(model, 'pool1'), 'padding')).toBe('same');
        expect(attribute(node(model, 'custom1'), 'className')).toBe('OmniCustomLayer');
    });

    it('finds weight tensors by shape, named where the layer maps them', () => {
        const conv = node(model, 'conv1');
        expect(conv.weights.map(item => [item.name, item.dataType, item.byteLength])).toEqual([
            ['weights', 'FLOAT32', '3456'],
            ['bias', 'FLOAT32', '128']
        ]);
        const fc = node(model, 'fc');
        expect(fc.updatable).toBe(true);
        expect(fc.weights[0]).toMatchObject({
            name: 'weights', dataType: 'RAW', byteLength: '2048',
            quantization: 'linear 8-bit', updatable: true, storage: 'inline'
        });
        // A layer with no attribute schema still yields its weights.
        expect(node(model, 'custom1').weights.map(item => item.name)).toEqual(['weights']);
    });

    it('does not mistake a plain submessage for a weight tensor', () => {
        // `pooling.same` is an empty padding message and `reorganizeData`
        // carries only scalars.
        expect(node(model, 'pool1').weights).toEqual([]);
        expect(node(model, 'shuffle').weights).toEqual([]);
        expect(node(model, 'shuffle').inputs)
            .toEqual([{ name: '', values: [{ text: 'pool1_out', variable: true }] }]);
    });

    it('lets the layer schema settle a field a weight probe would also accept', () => {
        // conv1's `valid` padding serializes to a length the packed-float check
        // accepts, so probing it first would both invent a third weight tensor
        // and lose the padding attribute.
        const conv = node(model, 'conv1');
        expect(attribute(conv, 'padding')).toBe('valid');
        expect(conv.weights.map(item => item.name)).toEqual(['weights', 'bias']);
    });

    it('never probes a field the layer does not declare as a weight', () => {
        // custom1's `parameters` map entry has a four-byte key, which matches
        // the shape of a packed float tensor.
        expect(node(model, 'custom1').weights.map(item => item.name)).toEqual(['weights']);
    });

    it('warns about the custom layer the runtime has to register', () => {
        const warning = model.warnings.find(item => item.key === 'coreml.warning.customLayers')!;
        expect(warning.args).toEqual({ count: 1, names: 'OmniCustomLayer' });
    });
});

describe('parseCoremlSpec — control flow, pipelines, and functions', () => {
    it('opens a layer whose parameters are a packed scalar, not a submessage', () => {
        // The weight scan reads bytes whose shape it does not know. A packed
        // `axes` list is not a message, so failing to find a weight there must
        // end the scan of that field — not the parse of the model.
        const model = parseCoremlSpec(coremlPackedScalarFixture());
        expect(model.graphs[0]!.nodes.map(item => item.type))
            .toEqual(['reduceSum', 'tile', 'broadcastToStatic']);
        expect(model.graphs[0]!.nodes.every(item => item.weights.length === 0)).toBe(true);
        expect(model.graphs[0]!.outputs).toEqual(['y']);
    });

    it('finds the weights inside an activation arm the schema also names', () => {
        // PReLU and parametricSoftplus are the only schema-described oneof arms
        // that wrap `WeightParams`, so the schema-first rule has to look inside
        // them rather than treat them as bare presence markers.
        const model = parseCoremlSpec(coremlParametricActivationFixture());
        const [prelu, softplus] = model.graphs[0]!.nodes;
        expect(attribute(prelu!, 'nonlinearity')).toBe('PReLU');
        expect(prelu!.weights.map(item => [item.name, item.byteLength])).toEqual([['alpha', '16']]);
        expect(attribute(softplus!, 'nonlinearity')).toBe('parametricSoftplus');
        expect(softplus!.weights.map(item => item.name)).toEqual(['alpha', 'beta']);
    });

    it('finds recurrent gate weights nested below the layer, and nothing else', () => {
        const model = parseCoremlSpec(coremlRecurrentFixture());
        const lstm = model.graphs[0]!.nodes[0]!;
        expect(lstm.type).toBe('uniDirectionalLSTM');
        // The three gate tensors sit inside `weightParams`; the leaky-ReLU
        // alpha and the cell-clip threshold are lone floats and are not weights.
        expect(lstm.weights.map(item => [item.name, item.byteLength])).toEqual([
            ['field 1', '64'], ['field 20', '64'], ['field 40', '16']
        ]);
        expect(lstm.weights.every(item => item.dataType === 'FLOAT32')).toBe(true);
    });

    it('turns both arms of a branch layer into child graphs', () => {
        const model = parseCoremlSpec(coremlBranchFixture());
        const root = model.graphs[0]!;
        const gate = root.nodes[0]!;
        expect(gate.type).toBe('branch');
        expect(gate.graphs).toHaveLength(2);
        const arms = model.graphs.filter(graph => graph.parentId === root.id);
        expect(arms.map(graph => graph.name)).toEqual(['gate · ifBranch', 'gate · elseBranch']);
        expect(arms.every(graph => graph.depth === 1)).toBe(true);
        expect(arms[0]!.nodes[0]!.name).toBe('if_relu');
    });

    it('lists pipeline stages and reparents the graph each stage owns', () => {
        const model = parseCoremlSpec(coremlPipelineFixture());
        expect(model.modelType).toBe('pipelineRegressor');
        const pipeline = model.graphs.find(graph => graph.kind === 'pipeline')!;
        expect(pipeline.nodes.map(item => [item.name, item.type])).toEqual([
            ['scaler', 'scaler'],
            ['regressor', 'neuralNetworkRegressor']
        ]);
        // The scaler has no graph of its own; the regressor's is nested under
        // the pipeline so the picker shows the two together.
        expect(pipeline.nodes[0]!.graphs).toEqual([]);
        const inner = model.graphs.find(graph => graph.id === pipeline.nodes[1]!.graphs[0])!;
        expect(inner.parentId).toBe(pipeline.id);
        expect(inner.depth).toBe(1);
        expect(inner.name).toBe('regressor · neuralNetworkRegressor');
        expect(inner.nodes[0]!.weights).toHaveLength(1);
    });

    it('summarizes a class-label vector longer than it keeps', () => {
        // A kNN index carries one label per training sample, so this vector is
        // routinely past the retained cap; rejecting it closes the whole model.
        const model = parseCoremlSpec(coremlKnnFixture(100001));
        expect(model.modelType).toBe('kNearestNeighborsClassifier');
        expect(model.classLabels.kind).toBe('int64');
        expect(model.classLabels.total).toBe(100001);
        expect(model.classLabels.values).toHaveLength(4096);
    });

    it('recognizes a custom operation in both encodings', () => {
        // A neural network has a `custom` layer naming `className`; an ML
        // Program rewrites the type to `custom_layer` and names `class_name`.
        const program = parseCoremlSpec(coremlProgramCustomOpFixture());
        const op = program.graphs[0]!.nodes[0]!;
        expect(op.type).toBe('custom_layer');
        expect(op.custom).toBe(true);
        expect(program.warnings.find(item => item.key === 'coreml.warning.customLayers')?.args)
            .toEqual({ count: 1, names: 'OmniProgramOp' });

        const network = parseCoremlSpec(coremlNeuralNetworkFixture());
        expect(node(network, 'custom1').custom).toBe(true);
        expect(node(network, 'conv1').custom).toBe(false);
    });

    it('summarizes a large immediate tensor instead of failing on it', () => {
        // A bool const never moves to a weight blob, so a [1, 1, 512, 512]
        // attention mask arrives inline with 262 144 elements. Previewing it is
        // the whole point of the literal budget; the packed readers used to
        // throw past their own cap and take the entire model down with them.
        const model = parseCoremlSpec(coremlLargeImmediateFixture(262144));
        const mask = model.graphs[0]!.nodes[0]!;
        expect(mask.type).toBe('const');
        expect(attribute(mask, 'val')).toContain('… (+262128)');
    });

    it('reads a block that declares many arguments in linear time', () => {
        // The scope is rebuilt as inputs are read; materializing it per input
        // made this quadratic — 50 000 arguments took four seconds. The bound
        // is ~30x the fixed cost, so it flags a regression without flaking.
        const bytes = coremlWideBlockFixture(50000);
        const started = Date.now();
        const model = parseCoremlSpec(bytes);
        expect(Date.now() - started).toBeLessThan(1500);
        const inner = model.graphs.find(graph => graph.kind === 'block')!;
        // 50 000 declared arguments plus the `x` inherited from the function.
        expect(inner.inputs).toHaveLength(50001);
    });

    it('does not depend on the order a producer wrote a block\'s fields in', () => {
        // Operations before inputs, and the interface on `Block.inputs` rather
        // than `Function.inputs` — both legal, neither emitted by coremltools.
        const model = parseCoremlSpec(coremlUnorderedBlockFixture());
        const [main, inner] = model.graphs;
        expect(main!.inputs.map(item => item.name)).toEqual(['image']);
        expect(inner!.kind).toBe('block');
        expect(inner!.inputs.map(item => item.name)).toEqual(['image']);
    });

    it('carries the scope all the way down, and shadows rather than duplicates', () => {
        // Each block's scope has to be in place before its operations are read,
        // since an operation's own nested blocks inherit it as it stands then.
        const model = parseCoremlSpec(coremlDeepBlockFixture());
        const blocks = model.graphs.filter(graph => graph.kind === 'block');
        expect(blocks).toHaveLength(2);
        // The middle block re-declares `image`; the innermost inherits it.
        expect(blocks.map(graph => graph.inputs.map(item => item.name)))
            .toEqual([['image'], ['image']]);
        expect(blocks[1]!.depth).toBe(2);
    });

    it('gives a nested block the scope it sits in, even declaring nothing itself', () => {
        // A `cond` block declares no arguments, so without inheriting the
        // enclosing scope it would treat the function's own input as a
        // constant arriving from nowhere.
        const model = parseCoremlSpec(coremlScopedBlockFixture());
        const inner = model.graphs.find(graph => graph.kind === 'block')!;
        expect(inner.inputs).toEqual([{ name: 'image', type: 'FLOAT32[1, 4]' }]);
    });

    it('surfaces the class labels a pipeline\'s classifier stage owns', () => {
        // The wrapper declares none of its own; the labels belong to the stage
        // it ends with, and that stage's parse has already read them.
        const model = parseCoremlSpec(coremlPipelineClassifierFixture());
        expect(model.modelType).toBe('pipelineClassifier');
        expect(model.classLabels).toEqual({
            kind: 'string', values: ['circle', 'square', 'star'], total: 3
        });
        // A standalone classifier still reports its own, unchanged.
        expect(parseCoremlSpec(coremlNeuralNetworkFixture()).classLabels.values).toEqual(['cat', 'dog']);
    });

    it('gives a pipeline the outputs its description declares', () => {
        const model = parseCoremlSpec(coremlPipelineFixture());
        expect(model.graphs[0]!.kind).toBe('pipeline');
        expect(model.graphs[0]!.outputs).toEqual(['prediction']);
    });

    it('nests a stage graph and everything below it under the pipeline', () => {
        const model = parseCoremlSpec(coremlNestedPipelineFixture());
        const pipeline = model.graphs.find(graph => graph.kind === 'pipeline')!;
        expect(model.graphs.map(graph => [graph.name, graph.depth])).toEqual([
            ['pipeline', 0],
            ['net · neuralNetwork', 1],
            // The branch arm was parsed as if its stage were top level; moving
            // the stage has to move its descendants too.
            ['gate · ifBranch', 2]
        ]);
        expect(model.graphs[1]!.parentId).toBe(pipeline.id);
        expect(model.graphs[2]!.parentId).toBe(model.graphs[1]!.id);
    });

    it('gives a network and a pipeline the inputs their description declares', () => {
        // Layers reference feature names directly, so the declared inputs are
        // what tells a real graph input from a dangling operand.
        const network = parseCoremlSpec(coremlNeuralNetworkFixture());
        expect(network.graphs[0]!.inputs).toEqual([{ name: 'image', type: 'image 227 × 227 RGB' }]);

        const pipeline = parseCoremlSpec(coremlPipelineFixture());
        expect(pipeline.graphs[0]!.inputs).toEqual([{ name: 'raw', type: 'multiArray FLOAT32[4]' }]);

        // A branch body has no description of its own and inherits operands
        // from the enclosing scope, so it declares nothing.
        const branch = parseCoremlSpec(coremlBranchFixture());
        expect(branch.graphs[1]!.inputs).toEqual([]);
    });

    it('reads a multi-function description and its default function', () => {
        const model = parseCoremlSpec(coremlMultiFunctionFixture());
        expect(model.specificationVersion).toBe(9);
        expect(model.functions.map(item => item.name)).toEqual(['prompt', 'extend']);
        expect(model.defaultFunctionName).toBe('extend');
        expect(model.functions.find(item => item.isDefault)!.name).toBe('extend');
        expect(model.functions[0]!.inputs[0]!.type).toBe('multiArray INT32[1, 128]');
        expect(model.functions[0]!.state[0]!.name).toBe('kv_cache');
        // The summary reports the default function's interface, not the first.
        expect(model.summary.find(item => item.labelKey === 'coreml.summary.inputs')!.value).toBe(1);
    });

    it('renders a symbolic tensor dimension without inflating the element count', () => {
        const model = parseCoremlSpec(coremlMultiFunctionFixture());
        expect(model.graphs[0]!.nodes[0]!.outputs[0]!.type).toBe('FLOAT16[1, ?, 32000]');
    });
});

describe('parseCoreml — .mlpackage archives', () => {
    it('reads the manifest, the spec it points at, and the weight blob size', async () => {
        const model = await parseCoreml(coremlPackageFixture());
        expect(model.packaged).toBe(true);
        expect(model.modelType).toBe('mlProgram');
        expect(model.package?.formatVersion).toBe('1.0.0');
        expect(model.package?.modelPath).toBe('Classifier.mlpackage/Data/com.apple.CoreML/model.mlmodel');
        expect(model.package?.items.find(item => item.isRoot)).toMatchObject({
            name: 'model.mlmodel', path: 'com.apple.CoreML/model.mlmodel'
        });
        // The `weights` item is a directory, so its size sums the files below it.
        expect(model.package?.items.find(item => item.name === 'weights')?.byteLength).toBe('8192');
        expect(model.weightFiles[0]).toMatchObject({ present: true, byteLength: '8192', referenceCount: 2 });
        expect(model.warnings.map(item => item.key)).not.toContain('coreml.warning.blobMissing');
    });

    it('lists the archive members with the bundle folder stripped', async () => {
        const model = await parseCoreml(coremlPackageFixture());
        expect(model.package?.files.map(item => item.name)).toEqual([
            'Manifest.json', 'Data/com.apple.CoreML/model.mlmodel', 'Data/com.apple.CoreML/weights/weight.bin'
        ]);
        expect(model.package?.files.every(item => item.method === 'stored')).toBe(true);
    });

    it('finds the spec by convention when the manifest is missing', async () => {
        const model = await parseCoreml(coremlPackageFixture({ withoutManifest: true, prefix: '' }));
        expect(model.modelType).toBe('mlProgram');
        expect(model.package?.modelPath).toBe('Data/com.apple.CoreML/model.mlmodel');
        expect(model.warnings.map(item => item.key)).toContain('coreml.warning.manifestMissing');
    });

    it('warns when the manifest is present but cannot be extracted', async () => {
        // A bundle re-zipped with a compression this parser cannot undo still
        // opens, but its package contents go undescribed — and saying so is the
        // difference between an explained gap and an inexplicably empty tab.
        const model = await parseCoreml(coremlPackageFixture({ unreadableManifest: true }));
        expect(model.modelType).toBe('mlProgram');
        expect(model.package?.items).toEqual([]);
        expect(model.warnings.map(item => item.key)).toContain('coreml.warning.manifestUnreadable');
        expect(model.warnings.map(item => item.key)).not.toContain('coreml.warning.manifestMissing');
    });

    it('warns when a referenced weight blob is not in the package', async () => {
        const model = await parseCoreml(coremlPackageFixture({ withoutWeights: true }));
        const warning = model.warnings.find(item => item.key === 'coreml.warning.blobMissing')!;
        expect(warning.args).toMatchObject({ count: 1 });
        expect(model.weightFiles[0]!.present).toBe(false);
    });

    it('routes bare specification bytes through the same entry point', async () => {
        const model = await parseCoreml(coremlNeuralNetworkFixture());
        expect(model.packaged).toBe(false);
        expect(model.package).toBeUndefined();
    });

    it('rejects an archive that holds no model specification', async () => {
        const archive = buildZip([{ name: 'readme.txt', data: new Uint8Array([1, 2, 3]) }]);
        await expect(parseCoreml(archive)).rejects.toBeInstanceOf(CoremlParseError);
    });

    it('honours an abort signal', async () => {
        await expect(parseCoreml(coremlPackageFixture(), { signal: AbortSignal.abort() }))
            .rejects.toBeInstanceOf(CoremlParseError);
    });
});

describe('parseCoremlSpec — malformed and unusual input', () => {
    it('rejects empty, truncated, and non-Core ML bytes', () => {
        expect(() => parseCoremlSpec(new Uint8Array())).toThrow(CoremlParseError);
        const valid = coremlProgramFixture();
        expect(() => parseCoremlSpec(valid.subarray(0, valid.byteLength - 40))).toThrow(CoremlParseError);
        expect(() => parseCoremlSpec(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toThrow(CoremlParseError);
    });

    it('rejects a spec with no version and one with no type or description', () => {
        const typeOnly = new ProtoBuilder().message(500, new ProtoBuilder()).build();
        expect(() => parseCoremlSpec(typeOnly)).toThrow(/specification version/);
        const versionOnly = new ProtoBuilder().varint(1, 4).build();
        expect(() => parseCoremlSpec(versionOnly)).toThrow(/model type or description/);
    });

    it('warns rather than failing on a specification version it does not know', () => {
        const spec = new ProtoBuilder()
            .varint(1, 42)
            .message(2, new ProtoBuilder())
            .message(500, new ProtoBuilder())
            .build();
        const model = parseCoremlSpec(spec);
        expect(model.availability).toBe('');
        expect(model.warnings.map(item => item.key)).toEqual(
            expect.arrayContaining(['coreml.warning.specVersion', 'coreml.warning.emptyGraph'])
        );
    });

    it('warns about a model type that carries no readable graph', () => {
        const spec = new ProtoBuilder()
            .varint(1, 4)
            .message(2, new ProtoBuilder().message(1, new ProtoBuilder().string(1, 'x')))
            .message(3000, new ProtoBuilder().string(1, 'private'))
            .build();
        const model = parseCoremlSpec(spec);
        expect(model.modelType).toBe('serializedModel');
        expect(model.graphs).toEqual([]);
        expect(model.warnings.map(item => item.key)).toContain('coreml.warning.serializedModel');
    });

    it('cuts an oversized text field instead of refusing the model', () => {
        // Every string kept here is display-only. Throwing away a 200 KB model
        // over one long licence trades the whole model for a string nobody
        // reads in full.
        const model = parseCoremlSpec(coremlBigMetadataFixture());
        expect(model.modelType).toBe('neuralNetwork');
        expect(model.license.endsWith('…')).toBe(true);
        expect(model.license.length).toBeLessThan(200_000);
        expect(model.warnings.map(item => item.key)).toContain('coreml.warning.textTruncated');
        // A model whose text all fits is not flagged.
        expect(parseCoremlSpec(coremlNeuralNetworkFixture()).warnings.map(item => item.key))
            .not.toContain('coreml.warning.textTruncated');
    });

    it('does not charge the text budget for labels it discards', () => {
        // 20 000 labels of ~470 chars decode to about 9 MB — past the
        // cumulative budget — but only 4096 are ever kept.
        const model = parseCoremlSpec(coremlLabelGalleryFixture(20_000));
        expect(model.classLabels.total).toBe(20_000);
        expect(model.classLabels.values).toHaveLength(4096);
        expect(model.warnings.map(item => item.key)).not.toContain('coreml.warning.textTruncated');
    });

    it('keeps a large graph within the parser limits', () => {
        const model = parseCoremlSpec(coremlWideNetworkFixture(600));
        expect(model.graphs[0]!.nodes).toHaveLength(600);
        expect(model.summary[0]!.value).toBe(600);
    });
});

describe('looksLikeCoremlSpec', () => {
    it('accepts every fixture specification', () => {
        for (const bytes of [
            coremlProgramFixture(), coremlNeuralNetworkFixture(),
            coremlPipelineFixture(), coremlMultiFunctionFixture()
        ]) {
            expect(looksLikeCoremlSpec(bytes)).toBe(true);
        }
    });

    it('rejects another framework\'s protobuf that opens the same way', () => {
        // An ONNX ModelProto is `int64 ir_version = 1; string producer_name = 2`
        // — a small version number and a string, exactly like a Core ML spec.
        // This repo ships an ONNX viewer, so claiming those bytes would route
        // them to the wrong one.
        expect(looksLikeCoremlSpec(onnxLookalikeBytes())).toBe(false);
    });

    it('rejects bytes that are not a Core ML specification', () => {
        expect(looksLikeCoremlSpec(new Uint8Array())).toBe(false);
        expect(looksLikeCoremlSpec(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
        expect(looksLikeCoremlSpec(new TextEncoder().encode('{"a": 1}'))).toBe(false);
        // A protobuf with a plausible shape but an implausible version.
        expect(looksLikeCoremlSpec(new ProtoBuilder().varint(1, 9999).message(2, new ProtoBuilder()).build())).toBe(false);
        // A version with nothing to describe the model is not enough.
        expect(looksLikeCoremlSpec(new ProtoBuilder().varint(1, 4).build())).toBe(false);
    });
});
