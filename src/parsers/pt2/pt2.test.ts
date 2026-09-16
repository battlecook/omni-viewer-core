import { describe, expect, it } from 'vitest';
import {
    RICH_PROGRAM, TINY_PROGRAM, aotiArchive, buildZip, encode, floats, legacyArchive, multiArchive, pt2Archive, richArchive, tinyArchive
} from './__tests__/fixture.js';
import { looksLikePt2Archive, parsePt2, prettySymExpr } from './index.js';

describe('parsePt2', () => {
    it('reads the archive markers, the program, and the raw weights of a torch.export.save package', async () => {
        const document = await parsePt2(tinyArchive());
        expect(document.warnings).toEqual([]);
        expect(document.layout).toBe('pt2');
        expect(document.prefix).toBe('tiny');
        expect(document.archiveFormat).toBe('pt2');
        expect(document.archiveVersion).toBe('0');
        expect(document.byteorder).toBe('little');
        expect(document.dataVersion).toBe('6');
        expect(document.serializationId).toBe('0613905680677350108814215759929456013960');
        expect(document.files.map(file => file.name)).toContain('models/model.json');
        expect(document.files.find(file => file.name === 'data/weights/weight_0')?.category).toBe('weights');
        expect(document.files.find(file => file.name === 'archive_format')?.category).toBe('archive');

        expect(document.models).toHaveLength(1);
        const model = document.models[0]!;
        expect(model.name).toBe('model');
        expect(model.torchVersion).toBe('2.14.0');
        expect(model.schemaVersion).toBe('8.20');
        expect(model.opsets).toEqual([{ label: 'aten', value: '10' }]);
        expect(model.verifiers).toEqual(['TRAINING']);
        expect(model.guards).toEqual(["L['x'].size()[0] == L['y'].size()[0]"]);
        expect(model.rangeConstraints).toEqual([{ symbol: 's17', min: '1', max: '64' }]);
        expect(model.nodeCount).toBe(5);
        expect(model.operators.map(item => `${item.op}=${item.count}`)).toEqual([
            'aten.add.Tensor=1', 'aten.linear.default=1', 'aten.mul.Tensor=1', 'aten.relu.default=1', 'aten.sum.default=1'
        ]);
        expect(model.parameterCount).toBe(15);
        expect(model.weightBytes).toBe(64);
        expect(model.sampleInputs?.name).toBe('data/sample_inputs/model.pt');

        const graph = model.graph;
        expect(graph.inputs.map(input => input.text)).toEqual(['p_fc_weight', 'p_fc_bias', 'b_scale', 'x', 'y']);
        expect(graph.outputs.map(output => output.text)).toEqual(['add', 'sum_1']);
        const linear = graph.nodes[0]!;
        expect(linear.name).toBe('linear');
        expect(linear.target).toBe('torch.ops.aten.linear.default');
        expect(linear.op).toBe('aten.linear.default');
        expect(linear.namespace).toBe('aten');
        expect(linear.inputs.map(input => `${input.name}=${input.text}`)).toEqual(['input=x', 'weight=p_fc_weight', 'bias=p_fc_bias']);
        expect(linear.inputs.every(input => input.kind === 'positional')).toBe(true);
        expect(linear.inputs.flatMap(input => input.refs)).toEqual(['x', 'p_fc_weight', 'p_fc_bias']);
        expect(linear.outputs.map(output => output.text)).toEqual(['linear']);
        expect(linear.module).toBe('fc');
        expect(linear.moduleStack).toEqual([{ fqn: '', className: '__main__.M' }, { fqn: 'fc', className: 'torch.nn.modules.linear.Linear' }]);
        expect(linear.stackTrace).toContain('model.py');
        expect(linear.metadata).toEqual([{ label: 'torch_fn', value: 'linear_1;builtin_function_or_method.linear' }]);

        const x = graph.values.find(value => value.name === 'x')!;
        expect(x.kind).toBe('tensor');
        expect(x.dtype).toBe('f32');
        expect(x.shape).toEqual(['s17 (hint 2)', '4']);
        expect(x.elementCount).toBeNull();
        expect(x.device).toBe('cpu');
        expect(x.layout).toBe('torch.strided');
        const weight = graph.values.find(value => value.name === 'p_fc_weight')!;
        expect(weight.shape).toEqual(['3', '4']);
        expect(weight.strides).toEqual(['4', '1']);
        expect(weight.elementCount).toBe(12);
        expect(graph.values.find(value => value.name === 'sum_1')!.elementCount).toBe(1);

        expect(model.inputSpecs.map(spec => `${spec.kind}:${spec.arg}:${spec.target}`)).toEqual([
            'parameter:p_fc_weight:fc.weight', 'parameter:p_fc_bias:fc.bias', 'buffer:b_scale:scale', 'user_input:x:', 'user_input:y:'
        ]);
        expect(model.inputSpecs[2]!.persistent).toBe(true);
        expect(model.outputSpecs.map(spec => `${spec.kind}:${spec.arg}`)).toEqual(['user_output:add', 'user_output:sum_1']);

        expect(model.modules.map(module => `${module.fqn}|${module.className}|${module.nodeCount}|${module.totalNodeCount}`)).toEqual([
            '|__main__.M|3|5', 'act|torch.nn.modules.activation.ReLU|1|1', 'fc|torch.nn.modules.linear.Linear|1|1'
        ]);
        expect(model.modules[0]!.hasSignature).toBe(true);
        expect(model.modules[0]!.forwardArgNames).toEqual(['x', 'y']);

        expect(model.weights.map(item => `${item.kind}:${item.name}:${item.placeholder}:${item.status}`)).toEqual([
            'parameter:fc.weight:p_fc_weight:raw', 'parameter:fc.bias:p_fc_bias:raw', 'buffer:scale:b_scale:raw'
        ]);
        const fcWeight = model.weights[0]!;
        expect(fcWeight.path).toBe('data/weights/weight_0');
        expect(fcWeight.dtype).toBe('f32');
        expect(fcWeight.shape).toEqual(['3', '4']);
        expect(fcWeight.elementCount).toBe(12);
        expect(fcWeight.bytes).toBe(48);
        expect(fcWeight.fileSize).toBe(48);
        expect(fcWeight.isParam).toBe(true);
        expect(fcWeight.preview).toEqual(['0.5', '-1.25', '2', '0', '1', '2', '3', '4']);
        expect(model.weights[2]!.preview).toEqual(['2']);
        expect(model.constants).toEqual([]);

        expect(document.summary.map(item => `${item.labelKey}=${item.value}`)).toEqual([
            'pt2.summary.nodes=5', 'pt2.summary.operators=5', 'pt2.summary.parameters=15', 'pt2.summary.weights=64 B',
            'pt2.summary.constants=0', 'pt2.summary.io=2 / 2'
        ]);
    });

    it('formats every argument kind, follows control-flow sub-graphs, and joins constants with the signature', async () => {
        const document = await parsePt2(richArchive());
        const model = document.models[0]!;
        const graph = model.graph;
        expect(graph.inputs.map(input => input.text)).toContain('3');
        expect(graph.outputs.map(output => output.text)).toEqual(['pad', 'add_', 'mul', 'sum_2']);
        const byName = (name: string) => graph.nodes.find(node => node.name === name)!;

        // The empty-stack hook frame torch inserts is not a module.
        expect(byName('sym_size_int_1').moduleStack).toEqual([]);
        expect(byName('sym_size_int_1').outputs[0]!.refs).toEqual(['sym_size_int_1']);
        expect(byName('conv2d').inputs.map(input => input.text)).toEqual(['x', 'p_conv_weight', 'p_conv_bias', '[1, 1]', '[1, 1]']);
        expect(byName('conv2d').module).toBe('sub.conv');
        expect(byName('conv2d').metadata).toEqual([{ label: 'source_fn_stack', value: 'conv2d,torch.nn.modules.conv.Conv2d' }]);
        expect(byName('batch_norm').inputs.map(input => `${input.name}=${input.text}`)).toEqual([
            'input=conv2d', 'weight=None', 'bias=None', 'running_mean=b_running_mean', 'running_var=None',
            'training=False', 'momentum=0.1', 'eps=0.00001', 'cudnn_enabled=False'
        ]);
        expect(byName('view').inputs[1]!.text).toBe('[sym_size_int_1, -1]');
        expect(byName('view').inputs[1]!.refs).toEqual(['sym_size_int_1']);
        const assert = byName('_assert_tensor_metadata_default');
        expect(assert.inputs.map(input => `${input.name}${input.kind === 'keyword' ? '*' : ''}=${input.text}`)).toEqual([
            'a=add', 'dtype*=torch.float32', 'device*=cpu', 'layout*=torch.strided'
        ]);
        expect(assert.outputs).toEqual([]);
        expect(byName('to').inputs[1]!.text).toBe('torch.bfloat16');
        expect(byName('pad').inputs.map(input => input.text)).toEqual(['getitem_2', '[1, 0]', "'constant'", '0']);
        expect(byName('mul').target).toBe('_operator.mul');
        expect(byName('mul').namespace).toBe('_operator');

        const cond = byName('cond');
        expect(cond.op).toBe('higher_order.cond');
        expect(cond.namespace).toBe('higher_order');
        expect(cond.inputs.map(input => input.text)).toEqual(['gt', 'true_graph_0', 'false_graph_0', '[to]']);
        expect(cond.inputs[3]!.refs).toEqual(['to']);
        expect(cond.subgraphs.map(item => item.name)).toEqual(['true_graph_0', 'false_graph_0']);
        const trueGraph = cond.subgraphs[0]!.graph;
        expect(trueGraph.inputs.map(input => input.text)).toEqual(['to']);
        expect(trueGraph.nodes.map(node => `${node.op}(${node.inputs.map(input => input.text).join(', ')})`)).toEqual(['aten.mul.Tensor(to, 2)']);
        expect(trueGraph.values.map(value => value.name)).toEqual(['to', 'mul']);
        expect(cond.metadata.map(item => item.label)).toEqual(['torch_fn', 'custom']);
        expect(model.nodeCount).toBe(graph.nodes.length + 2);
        expect(model.operators.find(item => item.op === 'aten.add.Tensor')?.count).toBe(2); // top level + false branch

        expect(graph.values.find(value => value.name === 'mul')).toMatchObject({ kind: 'sym_int', detail: '2*s77 (hint 4)', dtype: '' });
        expect(graph.values.find(value => value.name === 'to')).toMatchObject({ dtype: 'bf16', shape: ['s77 (hint 2)', '5'] });
        expect(graph.values.find(value => value.name === 'gt')?.dtype).toBe('b8');

        expect(model.inputSpecs.map(spec => `${spec.kind}:${spec.arg}:${spec.target}${spec.value ? `=${spec.value}` : ''}`)).toEqual([
            'parameter:p_conv_weight:sub.conv.weight', 'parameter:p_conv_bias:sub.conv.bias', 'buffer:b_counter:counter',
            'buffer:b_running_mean:sub.bn.running_mean', 'tensor_constant:c_const:const', 'tensor_constant:c_half:half',
            'user_input:x:', 'constant_input:n:n=3'
        ]);
        expect(model.inputSpecs[3]!.persistent).toBe(false);
        expect(model.outputSpecs.map(spec => `${spec.kind}:${spec.arg}:${spec.target}`)).toEqual([
            'user_output:pad:', 'buffer_mutation:add_:counter', 'user_output:mul:', 'user_output:sum_2:'
        ]);

        expect(model.modules.map(module => `${module.fqn}:${module.depth}:${module.hasSignature}`)).toEqual([
            ':0:true', 'fc:1:false', 'sub:1:true', 'sub.bn:2:false', 'sub.conv:2:false'
        ]);
        const sub = model.modules.find(module => module.fqn === 'sub')!;
        expect(sub.className).toBe('__main__.Sub');
        expect(sub.inputs).toEqual(['x']);
        expect(sub.outputs).toEqual(['batch_norm']);
        expect(sub.totalNodeCount).toBe(2);
        expect(model.metadata).toEqual([{ label: 'exported_by', value: 'fixture' }, { label: 'namedtuple Result', value: 'out, count' }]);

        expect(model.weights.map(item => `${item.kind}:${item.name}:${item.status}`)).toEqual([
            'parameter:sub.conv.weight:raw', 'parameter:sub.conv.bias:raw', 'buffer:counter:raw', 'buffer:sub.bn.running_mean:truncated'
        ]);
        expect(model.weights[2]!.dtype).toBe('i64');
        expect(model.weights[2]!.preview).toEqual(['7']);
        expect(model.weights[3]!.bytes).toBe(16);
        expect(model.weights[3]!.fileSize).toBe(8);
        expect(model.weights[3]!.preview).toEqual([]);
        expect(model.constants.map(item => `${item.kind}:${item.name}:${item.status}`)).toEqual([
            'tensor_constant:const:raw', 'tensor_constant:half:raw', 'tensor_constant:ghost:missing', 'custom_obj:tokenizer:pickled'
        ]);
        expect(model.constants[0]!.preview).toEqual(['0.5', '-0.5', '1', '2', '3']);
        expect(model.constants[1]!.dtype).toBe('f16');
        expect(model.constants[1]!.preview).toEqual(['1', '2']);
        expect(model.constants[2]!.fileSize).toBeNull();
        expect(model.constants[3]!.path).toBe('data/constants/custom_obj_0');
        expect(model.parameterCount).toBe(112);

        expect(document.warnings).toEqual([
            { key: 'pt2.warning.pickledPayloads', args: { name: 'model', count: 1 } },
            { key: 'pt2.warning.payloadMissing', args: { name: 'model', count: 1 } },
            { key: 'pt2.warning.payloadTruncated', args: { name: 'model', count: 1 } }
        ]);
        expect(document.summary.find(item => item.labelKey === 'pt2.summary.io')?.value).toBe('2 / 3');
    });

    it('reads every program of a multi-model package and the user extra files', async () => {
        const document = await parsePt2(multiArchive());
        expect(document.models.map(model => model.name)).toEqual(['decoder', 'encoder']);
        expect(document.models[1]!.weights.map(item => `${item.name}:${item.status}`)).toEqual(['fc.weight:raw', 'fc.bias:unlisted', 'scale:unlisted']);
        expect(document.extras).toEqual([
            { name: 'meta.json', size: 8, text: '{"k": 1}' },
            { name: 'note.txt', size: 5, text: 'hello' }
        ]);
        expect(document.summary[0]).toEqual({ labelKey: 'pt2.summary.models', value: 2 });
        expect(document.warnings).toEqual([]);
    });

    it('opens an AOTInductor-only package as an archive listing with its compile metadata', async () => {
        const document = await parsePt2(aotiArchive());
        expect(document.models).toEqual([]);
        expect(document.aotInductor).toHaveLength(1);
        const model = document.aotInductor[0]!;
        expect(model.name).toBe('model');
        expect(model.files.map(file => file.name.split('/').pop())).toEqual(['abc.wrapper.cpp', 'abc.wrapper_metadata.json', 'def.kernel_metadata.json', 'abc.wrapper.so']);
        // Wrapper and kernel metadata repeat the same platform keys; they are listed once.
        expect(model.metadata).toEqual([
            { label: 'AOTI_DEVICE_KEY', value: 'cpu' }, { label: 'AOTI_PLATFORM', value: 'darwin' }, { label: 'AOTI_MACHINE', value: 'arm64' }
        ]);
        expect(document.warnings).toEqual([{ key: 'pt2.warning.aotiOnly' }]);
        expect(document.summary.map(item => `${item.labelKey}=${item.value}`)).toEqual(['pt2.summary.models=0', 'pt2.summary.aotInductor=1', 'pt2.summary.files=9', `pt2.summary.fileSize=${document.fileSize}`]);
    });

    it('reads the legacy torch.export.save layout, listing weights from the signature', async () => {
        const document = await parsePt2(legacyArchive());
        expect(document.layout).toBe('legacy');
        expect(document.prefix).toBe('');
        expect(document.archiveFormat).toBe('');
        expect(document.models).toHaveLength(1);
        const model = document.models[0]!;
        expect(model.name).toBe('model');
        expect(model.graph.nodes).toHaveLength(5);
        expect(model.weights.map(item => `${item.kind}:${item.name}:${item.status}:${item.path}`)).toEqual([
            'parameter:fc.weight:pickled:serialized_state_dict.pt', 'parameter:fc.bias:pickled:serialized_state_dict.pt', 'buffer:scale:pickled:serialized_state_dict.pt'
        ]);
        // Shapes come from the graph's tensor metadata when no payload config exists.
        expect(model.weights[0]!.shape).toEqual(['3', '4']);
        expect(model.weights[0]!.bytes).toBe(48);
        expect(model.sampleInputs?.name).toBe('serialized_example_inputs.pt');
        expect(document.files.find(file => file.name === 'serialized_state_dict.pt')?.category).toBe('weights');
        expect(document.warnings).toEqual([
            { key: 'pt2.warning.legacyLayout' },
            { key: 'pt2.warning.pickledPayloads', args: { name: 'model', count: 3 } }
        ]);
    });

    it('accepts enum member names, the tuple spelling of as_none, and a big-endian byte order', async () => {
        const program = JSON.parse(JSON.stringify(TINY_PROGRAM));
        const graph = program.graph_module.graph;
        for (const meta of Object.values(graph.tensor_values) as Array<Record<string, unknown>>) { meta['dtype'] = 'FLOAT'; meta['layout'] = 'Strided'; }
        graph.nodes[0].inputs[2] = { name: 'bias', arg: { as_none: [] }, kind: 'POSITIONAL' };
        graph.nodes[1].inputs.push({ name: 'dtype', arg: { as_scalar_type: 'BFLOAT16' }, kind: 'KEYWORD' });
        const big = new Uint8Array(12 * 4);
        const view = new DataView(big.buffer);
        [0.5, -1.25, 2].forEach((value, index) => view.setFloat32(index * 4, value, false));
        const document = await parsePt2(pt2Archive({
            prefix: 'be',
            byteorder: 'big',
            models: { model: program },
            members: [
                { name: 'data/weights/weight_0', data: big },
                { name: 'data/weights/model_weights_config.json', data: JSON.stringify({ config: { 'fc.weight': { path_name: 'weight_0', is_param: true, use_pickle: false, tensor_meta: { dtype: 'FLOAT', sizes: [{ as_int: 3 }, { as_int: 4 }], requires_grad: true, device: { type: 'cuda', index: 1 }, strides: [{ as_int: 4 }, { as_int: 1 }], storage_offset: { as_int: 0 }, layout: 'Strided' } } } }) }
            ]
        }));
        const model = document.models[0]!;
        expect(model.graph.values[0]!.dtype).toBe('f32');
        expect(model.graph.nodes[0]!.inputs[2]!.text).toBe('None');
        expect(model.graph.nodes[1]!.inputs[1]!).toMatchObject({ name: 'dtype', text: 'torch.bfloat16', kind: 'keyword' });
        expect(model.weights[0]!.preview.slice(0, 3)).toEqual(['0.5', '-1.25', '2']);
        expect(model.weights[0]!.device).toBe('cuda:1');
        expect(model.weights[0]!.requiresGrad).toBe(true);
    });

    it('reads a ZIP64 directory and a flat archive without a package folder', async () => {
        const zip64 = await parsePt2(tinyArchive({ zip64: true }));
        expect(zip64.warnings).toEqual([]);
        expect(zip64.models[0]!.weights[0]!.preview[0]).toBe('0.5');
        const flat = await parsePt2(tinyArchive({ prefix: '' }));
        expect(flat.prefix).toBe('');
        expect(flat.models[0]!.graph.nodes).toHaveLength(5);
    });

    it('inflates deflated members through JSZip when an archive was re-zipped', async () => {
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();
        zip.file('m/archive_format', 'pt2');
        zip.file('m/models/model.json', JSON.stringify(TINY_PROGRAM));
        zip.file('m/data/weights/model_weights_config.json', JSON.stringify({ config: { 'fc.weight': { path_name: 'weight_0', is_param: true, use_pickle: false, tensor_meta: { dtype: 7, sizes: [{ as_int: 3 }, { as_int: 4 }], requires_grad: true, device: { type: 'cpu', index: null }, strides: [{ as_int: 4 }, { as_int: 1 }], storage_offset: { as_int: 0 }, layout: 7 } } } }));
        zip.file('m/data/weights/weight_0', floats([0.5, -1.25, 2, 0, 1, 2, 3, 4, 5, 6, 7, 8]));
        const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
        const document = await parsePt2(bytes);
        expect(document.warnings).toEqual([]);
        expect(document.models[0]!.graph.nodes).toHaveLength(5);
        // Deflated payloads are listed but not previewed: only stored members are viewed in place.
        expect(document.models[0]!.weights[0]!.status).toBe('raw');
        expect(document.models[0]!.weights[0]!.preview).toEqual([]);
    });

    it('reports unreadable input without throwing', async () => {
        expect((await parsePt2(encode('not a zip'))).warnings).toEqual([{ key: 'pt2.warning.notZip' }]);
        expect((await parsePt2(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]))).warnings).toEqual([{ key: 'pt2.warning.archiveUnreadable' }]);
        const unknown = await parsePt2(buildZip([{ name: 'x/readme.txt', data: 'hi' }]));
        expect(unknown.layout).toBe('legacy');
        expect(unknown.warnings).toEqual([{ key: 'pt2.warning.noArchiveFormat' }, { key: 'pt2.warning.noModels' }]);
        const broken = await parsePt2(pt2Archive({ models: { model: {} }, members: [{ name: 'models/bad.json', data: '{not json' }] }));
        expect(broken.warnings).toEqual([{ key: 'pt2.warning.jsonUnreadable', args: { name: 'models/bad.json' } }, { key: 'pt2.warning.modelUnreadable', args: { name: 'bad' } }]);
        expect(broken.models).toHaveLength(1);
        expect(broken.models[0]!.graph.nodes).toEqual([]);
        const future = await parsePt2(pt2Archive({ models: { model: { ...TINY_PROGRAM, schema_version: { major: 9, minor: 0 } } } }));
        expect(future.warnings).toEqual([{ key: 'pt2.warning.schemaVersion', args: { name: 'model', version: '9.0', supported: 8 } }]);
    });

    it('bounds nodes, values, and payloads and counts dangling references', async () => {
        const program = JSON.parse(JSON.stringify(RICH_PROGRAM));
        program.graph_module.graph.nodes.push({ target: 'torch.ops.aten.relu.default', inputs: [{ name: 'self', arg: { as_tensor: { name: 'nowhere' } }, kind: 1 }], outputs: [{ as_tensor: { name: 'orphan' } }], metadata: {} });
        const document = await parsePt2(pt2Archive({ models: { model: program } }), { maxNodes: 10, maxValues: 12, maxPayloads: 3 });
        expect(document.models[0]!.graph.nodes).toHaveLength(10);
        expect(document.models[0]!.graph.values).toHaveLength(12);
        expect(document.models[0]!.weights).toHaveLength(3);
        expect(document.warnings).toEqual(expect.arrayContaining([
            { key: 'pt2.warning.nodesLimited', args: { count: 5 } },
            { key: 'pt2.warning.valuesLimited', args: { count: 8 } },
            { key: 'pt2.warning.payloadsLimited', args: { count: 3 } }
        ]));
        const orphan = await parsePt2(pt2Archive({ models: { model: program } }));
        expect(orphan.warnings).toContainEqual({ key: 'pt2.warning.danglingRefs', args: { count: 1 } });
    });

    it('honours an abort signal', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(parsePt2(tinyArchive(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    });
});

describe('looksLikePt2Archive', () => {
    it('recognizes both layouts by their marker members and rejects other ZIPs', () => {
        expect(looksLikePt2Archive(tinyArchive())).toBe(true);
        expect(looksLikePt2Archive(legacyArchive())).toBe(true);
        expect(looksLikePt2Archive(aotiArchive())).toBe(true);
        expect(looksLikePt2Archive(buildZip([{ name: 'config.json', data: '{}' }, { name: 'model.weights.h5', data: '' }]))).toBe(false);
        expect(looksLikePt2Archive(encode('GGUF'))).toBe(false);
    });
});

describe('prettySymExpr', () => {
    it('prints sympy srepr as a readable expression and leaves other strings alone', () => {
        const s0 = "Symbol('s0', positive=True, integer=True)";
        expect(prettySymExpr(s0)).toBe('s0');
        expect(prettySymExpr(`Mul(Integer(2), ${s0})`)).toBe('2*s0');
        expect(prettySymExpr(`Add(${s0}, Integer(-1))`)).toBe('s0 + -1');
        expect(prettySymExpr(`Mul(Add(${s0}, Integer(1)), Integer(4))`)).toBe('(s0 + 1)*4');
        expect(prettySymExpr(`Mul(Integer(-1), ${s0})`)).toBe('-s0');
        expect(prettySymExpr(`FloorDiv(${s0}, Integer(2))`)).toBe('s0//2');
        expect(prettySymExpr(`Mod(${s0}, Integer(3))`)).toBe('s0 % 3');
        expect(prettySymExpr(`Pow(${s0}, Integer(2))`)).toBe('s0**2');
        expect(prettySymExpr(`Max(Integer(1), ${s0})`)).toBe('Max(1, s0)');
        expect(prettySymExpr(`Eq(${s0}, Integer(1))`)).toBe('s0 == 1');
        expect(prettySymExpr(`And(Gt(${s0}, Integer(1)), true)`)).toBe('s0 > 1 and True');
        expect(prettySymExpr("Rational(1, 2)")).toBe('1/2');
        expect(prettySymExpr("Float('1.5', precision=53)")).toBe('1.5');
        expect(prettySymExpr(`ToFloat(${s0})`)).toBe('float(s0)');
        expect(prettySymExpr('2*s0')).toBe('2*s0');
        expect(prettySymExpr('s0')).toBe('s0');
        expect(prettySymExpr('Mul(Integer(2), Symbol(')).toBe('Mul(Integer(2), Symbol(');
    });
});
