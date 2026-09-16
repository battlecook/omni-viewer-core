/**
 * Hand-written PT2 packages for the parser and viewer tests.
 *
 * The archives follow what `torch.export.save` (torch 2.14, schema 8.20)
 * writes: every member under a folder named after the file, stored members
 * only, and tensor payloads padded to a 64-byte alignment through the local
 * header's extra field. The serialized programs are trimmed copies of real
 * exports — a two-layer MLP with a dynamic batch, and a model that exercises
 * control flow, symbolic sizes, constants, and every argument kind.
 */

const encoder = new TextEncoder();

export const encode = (text: string): Uint8Array => encoder.encode(text);

// ── ZIP writer ─────────────────────────────────────────────────────────────

export interface ZipMember {
    name: string;
    data: Uint8Array | string;
    /** 8 = deflate. The bytes are written as given; tests use it to exercise the inflate path. */
    method?: number;
}

export interface ZipWriteOptions {
    /** Emit ZIP64 end records and saturate the classic EOCD counts. */
    zip64?: boolean;
    /** Pad each member's data to this alignment through the local extra field (PyTorchFileWriter uses 64). */
    align?: number;
}

/** A minimal stored-member ZIP writer that mirrors the PyTorchFileWriter layout. */
export function buildZip(members: ZipMember[], options: ZipWriteOptions = {}): Uint8Array {
    const align = options.align ?? 64;
    const chunks: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const member of members) {
        const name = encode(member.name);
        const data = typeof member.data === 'string' ? encode(member.data) : member.data;
        const method = member.method ?? 0;
        const dataStart = offset + 30 + name.length;
        const padding = align > 0 ? (align - (dataStart % align)) % align : 0;
        // PyTorchFileWriter fills the padding with an extra field of id 0xFB3D ("PyTorch");
        // any id works for readers, which only skip it.
        const extra = new Uint8Array(padding);
        if (padding >= 4) {
            const extraView = new DataView(extra.buffer);
            extraView.setUint16(0, 0xfb3d, true);
            extraView.setUint16(2, padding - 4, true);
        }
        const local = new Uint8Array(30 + name.length + extra.length + data.length);
        const view = new DataView(local.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 45, true);
        view.setUint16(8, method, true);
        view.setUint32(14, crc32(data), true);
        view.setUint32(18, data.length, true);
        view.setUint32(22, data.length, true);
        view.setUint16(26, name.length, true);
        view.setUint16(28, extra.length, true);
        local.set(name, 30);
        local.set(extra, 30 + name.length);
        local.set(data, 30 + name.length + extra.length);
        chunks.push(local);

        const zip64Extra = options.zip64 ? new Uint8Array(4 + 8 * 3) : new Uint8Array(0);
        if (options.zip64) {
            const z = new DataView(zip64Extra.buffer);
            z.setUint16(0, 0x0001, true);
            z.setUint16(2, 24, true);
            z.setBigUint64(4, BigInt(data.length), true);
            z.setBigUint64(12, BigInt(data.length), true);
            z.setBigUint64(20, BigInt(offset), true);
        }
        const header = new Uint8Array(46 + name.length + zip64Extra.length);
        const headerView = new DataView(header.buffer);
        headerView.setUint32(0, 0x02014b50, true);
        headerView.setUint16(4, 45, true);
        headerView.setUint16(6, 45, true);
        headerView.setUint16(10, method, true);
        headerView.setUint32(16, crc32(data), true);
        headerView.setUint32(20, options.zip64 ? 0xffffffff : data.length, true);
        headerView.setUint32(24, options.zip64 ? 0xffffffff : data.length, true);
        headerView.setUint16(28, name.length, true);
        headerView.setUint16(30, zip64Extra.length, true);
        headerView.setUint32(42, options.zip64 ? 0xffffffff : offset, true);
        header.set(name, 46);
        header.set(zip64Extra, 46 + name.length);
        central.push(header);
        offset += local.length;
    }
    const centralStart = offset;
    const centralSize = central.reduce((total, chunk) => total + chunk.length, 0);
    chunks.push(...central);
    offset += centralSize;
    if (options.zip64) {
        const eocd64 = new Uint8Array(56);
        const view = new DataView(eocd64.buffer);
        view.setUint32(0, 0x06064b50, true);
        view.setBigUint64(4, BigInt(44), true);
        view.setUint16(12, 45, true);
        view.setUint16(14, 45, true);
        view.setBigUint64(24, BigInt(members.length), true);
        view.setBigUint64(32, BigInt(members.length), true);
        view.setBigUint64(40, BigInt(centralSize), true);
        view.setBigUint64(48, BigInt(centralStart), true);
        const locator = new Uint8Array(20);
        const locatorView = new DataView(locator.buffer);
        locatorView.setUint32(0, 0x07064b50, true);
        locatorView.setBigUint64(8, BigInt(offset), true);
        locatorView.setUint32(16, 1, true);
        chunks.push(eocd64, locator);
    }
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(8, options.zip64 ? 0xffff : members.length, true);
    eocdView.setUint16(10, options.zip64 ? 0xffff : members.length, true);
    eocdView.setUint32(12, centralSize, true);
    eocdView.setUint32(16, options.zip64 ? 0xffffffff : centralStart, true);
    chunks.push(eocd);
    const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
    return out;
}

function crc32(data: Uint8Array): number {
    let crc = -1;
    for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ -1) >>> 0;
}

// ── Serialized-program builders ────────────────────────────────────────────

type Json = Record<string, unknown>;

export const tensor = (name: string): Json => ({ as_tensor: { name } });
const symInt = (name: string): Json => ({ as_sym_int: { as_name: name } });
const dim = (size: number | string, hint?: number): Json =>
    typeof size === 'number' ? { as_int: size } : { as_expr: { expr_str: size, ...(hint === undefined ? {} : { hint: { as_int: hint } }) } };

export function tensorMeta(dtype: number, sizes: Array<number | string>, hint = 2): Json {
    const strides: Array<number | string> = [];
    let stride: number | string = 1;
    for (let axis = sizes.length - 1; axis >= 0; axis--) {
        strides.unshift(stride);
        const size = sizes[axis]!;
        stride = typeof size === 'number' && typeof stride === 'number' ? stride * size : `Mul(Integer(${stride}), ${size})`;
    }
    return {
        dtype,
        sizes: sizes.map(size => dim(size, hint)),
        requires_grad: false,
        device: { type: 'cpu', index: null },
        strides: strides.map(size => dim(size, hint)),
        storage_offset: { as_int: 0 },
        layout: 7
    };
}

const S_BATCH = "Symbol('s17', positive=True, integer=True)";

function node(name: string, target: string, inputs: Array<[string, Json, number?]>, outputs: Json[], metadata: Record<string, string> = {}): Json {
    return {
        target,
        inputs: inputs.map(([argName, arg, kind]) => ({ name: argName, arg, kind: kind ?? 1 })),
        outputs,
        metadata,
        is_hop_single_tensor_return: null,
        name
    };
}

/** Linear → ReLU → mul(buffer) → add(y), sum: two params, one buffer, dynamic batch. */
export const TINY_PROGRAM: Json = {
    graph_module: {
        graph: {
            inputs: [tensor('p_fc_weight'), tensor('p_fc_bias'), tensor('b_scale'), tensor('x'), tensor('y')],
            outputs: [tensor('add'), tensor('sum_1')],
            nodes: [
                node('linear', 'torch.ops.aten.linear.default', [['input', tensor('x')], ['weight', tensor('p_fc_weight')], ['bias', tensor('p_fc_bias')]], [tensor('linear')], {
                    stack_trace: 'File "model.py", line 10, in forward\n    h = self.act(self.fc(x)) * self.scale',
                    nn_module_stack: 'L__self__,,__main__.M;L__self__fc,fc,torch.nn.modules.linear.Linear',
                    torch_fn: 'linear_1;builtin_function_or_method.linear'
                }),
                node('relu', 'torch.ops.aten.relu.default', [['self', tensor('linear')]], [tensor('relu')], {
                    nn_module_stack: 'L__self__,,__main__.M;L__self__act,act,torch.nn.modules.activation.ReLU',
                    torch_fn: 'relu_1;function.relu'
                }),
                node('mul', 'torch.ops.aten.mul.Tensor', [['self', tensor('relu')], ['other', tensor('b_scale')]], [tensor('mul')], { nn_module_stack: 'L__self__,,__main__.M' }),
                node('add', 'torch.ops.aten.add.Tensor', [['self', tensor('mul')], ['other', tensor('y')]], [tensor('add')], { nn_module_stack: 'L__self__,,__main__.M' }),
                node('sum_1', 'torch.ops.aten.sum.default', [['self', tensor('mul')]], [tensor('sum_1')], { nn_module_stack: 'L__self__,,__main__.M' })
            ],
            tensor_values: {
                p_fc_weight: tensorMeta(7, [3, 4]),
                p_fc_bias: tensorMeta(7, [3]),
                b_scale: tensorMeta(7, [1]),
                x: tensorMeta(7, [S_BATCH, 4]),
                y: tensorMeta(7, [S_BATCH, 3]),
                linear: tensorMeta(7, [S_BATCH, 3]),
                relu: tensorMeta(7, [S_BATCH, 3]),
                mul: tensorMeta(7, [S_BATCH, 3]),
                add: tensorMeta(7, [S_BATCH, 3]),
                sum_1: tensorMeta(7, [])
            },
            sym_int_values: {},
            sym_bool_values: {},
            is_single_tensor_return: false,
            custom_obj_values: {},
            sym_float_values: {}
        },
        signature: {
            input_specs: [
                { parameter: { arg: { name: 'p_fc_weight' }, parameter_name: 'fc.weight' } },
                { parameter: { arg: { name: 'p_fc_bias' }, parameter_name: 'fc.bias' } },
                { buffer: { arg: { name: 'b_scale' }, buffer_name: 'scale', persistent: true } },
                { user_input: { arg: tensor('x') } },
                { user_input: { arg: tensor('y') } }
            ],
            output_specs: [{ user_output: { arg: tensor('add') } }, { user_output: { arg: tensor('sum_1') } }]
        },
        module_call_graph: [
            { fqn: '', signature: { inputs: [], outputs: [], in_spec: '[1, {"type": "builtins.tuple"}]', out_spec: '[1, {"type": "builtins.tuple"}]', forward_arg_names: ['x', 'y'] } },
            { fqn: 'fc', signature: null },
            { fqn: 'act', signature: null }
        ],
        metadata: {},
        treespec_namedtuple_fields: {}
    },
    opset_version: { aten: 10 },
    range_constraints: { s17: { min_val: 1, max_val: 64 } },
    schema_version: { major: 8, minor: 20 },
    verifiers: ['TRAINING'],
    torch_version: '2.14.0',
    guards_code: ["L['x'].size()[0] == L['y'].size()[0]"]
};

const S77 = "Symbol('s77', positive=True, integer=True)";

/**
 * Conv → BatchNorm(eval) → view(sym) → layer_norm(None weights) → linear + constant
 * → to(bf16) → cond(true/false sub-graphs) → pad; a buffer mutated in place, a
 * constant int input, a symbolic-int output, and an f16 constant.
 */
export const RICH_PROGRAM: Json = {
    graph_module: {
        graph: {
            inputs: [
                tensor('p_conv_weight'), tensor('p_conv_bias'), tensor('b_counter'), tensor('b_running_mean'),
                tensor('c_const'), tensor('c_half'), tensor('x'), { as_int: 3 }
            ],
            outputs: [tensor('pad'), tensor('add_'), symInt('mul'), tensor('sum_2')],
            nodes: [
                node('sym_size_int_1', 'torch.ops.aten.sym_size.int', [['self', tensor('x')], ['dim', { as_int: 0 }]], [symInt('sym_size_int_1')], {
                    nn_module_stack: '_empty_nn_module_stack_from_metadata_hook,_empty_nn_module_stack_from_metadata_hook,_empty_nn_module_stack_from_metadata_hook'
                }),
                node('add_', 'torch.ops.aten.add_.Tensor', [['self', tensor('b_counter')], ['other', { as_int: 1 }]], [tensor('add_')], { nn_module_stack: 'L__self__,,__main__.Rich' }),
                node('conv2d', 'torch.ops.aten.conv2d.default', [
                    ['input', tensor('x')], ['weight', tensor('p_conv_weight')], ['bias', tensor('p_conv_bias')],
                    ['stride', { as_ints: [1, 1] }], ['padding', { as_ints: [1, 1] }]
                ], [tensor('conv2d')], { nn_module_stack: 'L__self__,,__main__.Rich;L__self__sub,sub,__main__.Sub;L__self__sub.conv,sub.conv,torch.nn.modules.conv.Conv2d', source_fn_stack: 'conv2d,torch.nn.modules.conv.Conv2d' }),
                node('batch_norm', 'torch.ops.aten.batch_norm.default', [
                    ['input', tensor('conv2d')], ['weight', { as_none: true }], ['bias', { as_none: true }],
                    ['running_mean', tensor('b_running_mean')], ['running_var', { as_none: true }],
                    ['training', { as_bool: false }], ['momentum', { as_float: 0.1 }], ['eps', { as_float: 1e-5 }], ['cudnn_enabled', { as_bool: false }]
                ], [tensor('batch_norm')], { nn_module_stack: 'L__self__,,__main__.Rich;L__self__sub,sub,__main__.Sub;L__self__sub.bn,sub.bn,torch.nn.modules.batchnorm.BatchNorm2d' }),
                node('view', 'torch.ops.aten.view.default', [['self', tensor('batch_norm')], ['size', { as_sym_ints: [{ as_name: 'sym_size_int_1' }, { as_int: -1 }] }]], [tensor('view')], { nn_module_stack: 'L__self__,,__main__.Rich' }),
                node('linear', 'torch.ops.aten.linear.default', [['input', tensor('view')], ['weight', tensor('p_conv_weight')]], [tensor('linear')], { nn_module_stack: 'L__self__,,__main__.Rich;L__self__fc,fc,torch.nn.modules.linear.Linear' }),
                node('add', 'torch.ops.aten.add.Tensor', [['self', tensor('linear')], ['other', tensor('c_const')]], [tensor('add')], { nn_module_stack: 'L__self__,,__main__.Rich' }),
                node('_assert_tensor_metadata_default', 'torch.ops.aten._assert_tensor_metadata.default', [
                    ['a', tensor('add')], ['dtype', { as_scalar_type: 7 }, 2], ['device', { as_device: { type: 'cpu', index: null } }, 2], ['layout', { as_layout: 7 }, 2]
                ], [], { nn_module_stack: 'L__self__,,__main__.Rich' }),
                node('to', 'torch.ops.aten.to.dtype', [['self', tensor('add')], ['dtype', { as_scalar_type: 13 }]], [tensor('to')], { nn_module_stack: 'L__self__,,__main__.Rich' }),
                node('gt', 'torch.ops.aten.gt.Scalar', [['self', tensor('to')], ['other', { as_int: 0 }]], [tensor('gt')], { nn_module_stack: 'L__self__,,__main__.Rich' }),
                node('cond', 'torch.ops.higher_order.cond', [
                    ['', tensor('gt')],
                    ['', { as_graph: { name: 'true_graph_0', graph: subgraph('mul', 'torch.ops.aten.mul.Tensor', { as_float: 2 }) } }],
                    ['', { as_graph: { name: 'false_graph_0', graph: subgraph('add', 'torch.ops.aten.add.Tensor', { as_int: 3 }) } }],
                    ['', { as_tensors: [{ name: 'to' }] }]
                ], [tensor('getitem_2')], { nn_module_stack: 'L__self__,,__main__.Rich', torch_fn: 'cond_1;CondOp.cond', custom: '{"tag":"cf"}' }),
                node('pad', 'torch.ops.aten.pad.default', [
                    ['self', tensor('getitem_2')], ['pad', { as_ints: [1, 0] }], ['mode', { as_string: 'constant' }], ['value', { as_float: 0 }]
                ], [tensor('pad')], { nn_module_stack: 'L__self__,,__main__.Rich' }),
                node('mul', '_operator.mul', [['a', symInt('sym_size_int_1')], ['b', { as_int: 2 }]], [symInt('mul')], { nn_module_stack: 'L__self__,,__main__.Rich' }),
                node('sum_2', 'torch.ops.aten.sum.default', [['self', tensor('c_half')]], [tensor('sum_2')], { nn_module_stack: 'L__self__,,__main__.Rich' })
            ],
            tensor_values: {
                p_conv_weight: tensorMeta(7, [4, 3, 3, 3]),
                p_conv_bias: tensorMeta(7, [4]),
                b_counter: tensorMeta(5, [1]),
                b_running_mean: tensorMeta(7, [4]),
                c_const: tensorMeta(7, [5]),
                c_half: tensorMeta(6, [2]),
                x: tensorMeta(7, [S77, 3, 8, 8]),
                add_: tensorMeta(5, [1]),
                conv2d: tensorMeta(7, [S77, 4, 8, 8]),
                batch_norm: tensorMeta(7, [S77, 4, 8, 8]),
                view: tensorMeta(7, [S77, 256]),
                linear: tensorMeta(7, [S77, 5]),
                add: tensorMeta(7, [S77, 5]),
                to: tensorMeta(13, [S77, 5]),
                gt: tensorMeta(12, [S77, 5]),
                getitem_2: tensorMeta(13, [S77, 5]),
                pad: tensorMeta(13, [S77, 6]),
                sum_2: tensorMeta(6, [])
            },
            sym_int_values: {
                sym_size_int_1: { as_expr: { expr_str: S77, hint: { as_int: 2 } } },
                mul: { as_expr: { expr_str: `Mul(Integer(2), ${S77})`, hint: { as_int: 4 } } }
            },
            sym_bool_values: {},
            is_single_tensor_return: false,
            custom_obj_values: {},
            sym_float_values: {}
        },
        signature: {
            input_specs: [
                { parameter: { arg: { name: 'p_conv_weight' }, parameter_name: 'sub.conv.weight' } },
                { parameter: { arg: { name: 'p_conv_bias' }, parameter_name: 'sub.conv.bias' } },
                { buffer: { arg: { name: 'b_counter' }, buffer_name: 'counter', persistent: true } },
                { buffer: { arg: { name: 'b_running_mean' }, buffer_name: 'sub.bn.running_mean', persistent: false } },
                { tensor_constant: { arg: { name: 'c_const' }, tensor_constant_name: 'const' } },
                { tensor_constant: { arg: { name: 'c_half' }, tensor_constant_name: 'half' } },
                { user_input: { arg: tensor('x') } },
                { constant_input: { name: 'n', value: { as_int: 3 } } }
            ],
            output_specs: [
                { user_output: { arg: tensor('pad') } },
                { buffer_mutation: { arg: { name: 'add_' }, buffer_name: 'counter' } },
                { user_output: { arg: symInt('mul') } },
                { user_output: { arg: tensor('sum_2') } }
            ]
        },
        module_call_graph: [
            { fqn: '', signature: { inputs: [], outputs: [], in_spec: '', out_spec: '', forward_arg_names: ['x', 'n'] } },
            { fqn: 'sub', signature: { inputs: [tensor('x')], outputs: [tensor('batch_norm')], in_spec: '', out_spec: '', forward_arg_names: null } },
            { fqn: 'sub.conv', signature: null },
            { fqn: 'sub.bn', signature: null },
            { fqn: 'fc', signature: null }
        ],
        metadata: { exported_by: 'fixture' },
        treespec_namedtuple_fields: { Result: { field_names: ['out', 'count'] } }
    },
    opset_version: { aten: 10 },
    range_constraints: { s77: { min_val: 1, max_val: 32 } },
    schema_version: { major: 8, minor: 20 },
    verifiers: ['TRAINING'],
    torch_version: '2.14.0',
    guards_code: []
};

function subgraph(name: string, target: string, scalar: Json): Json {
    return {
        inputs: [tensor('to')],
        outputs: [tensor(name)],
        nodes: [node(name, target, [['self', tensor('to')], ['other', scalar]], [tensor(name)], {})],
        tensor_values: { to: tensorMeta(13, [S77, 5]), [name]: tensorMeta(13, [S77, 5]) },
        sym_int_values: {}, sym_bool_values: {}, is_single_tensor_return: false, custom_obj_values: {}, sym_float_values: {}
    };
}

// ── Payloads ───────────────────────────────────────────────────────────────

export function floats(values: number[]): Uint8Array {
    const out = new Uint8Array(values.length * 4);
    const view = new DataView(out.buffer);
    values.forEach((value, index) => view.setFloat32(index * 4, value, true));
    return out;
}

function halves(values: number[]): Uint8Array {
    const out = new Uint8Array(values.length * 2);
    const view = new DataView(out.buffer);
    values.forEach((value, index) => {
        // Exact for the small integers the fixture uses.
        const exponent = value === 0 ? 0 : Math.floor(Math.log2(Math.abs(value)));
        const mantissa = value === 0 ? 0 : Math.round((Math.abs(value) / 2 ** exponent - 1) * 1024);
        view.setUint16(index * 2, (value < 0 ? 0x8000 : 0) | ((exponent + 15) << 10) | mantissa, true);
    });
    return out;
}

function int64(values: number[]): Uint8Array {
    const out = new Uint8Array(values.length * 8);
    const view = new DataView(out.buffer);
    values.forEach((value, index) => view.setBigInt64(index * 8, BigInt(value), true));
    return out;
}

function payload(pathName: string, isParam: boolean, meta: Json, usePickle = false): Json {
    return { path_name: pathName, is_param: isParam, use_pickle: usePickle, tensor_meta: meta };
}

export const TINY_WEIGHTS_CONFIG: Json = {
    config: {
        'fc.weight': payload('weight_0', true, tensorMeta(7, [3, 4])),
        'fc.bias': payload('weight_1', true, tensorMeta(7, [3])),
        scale: payload('weight_2', false, tensorMeta(7, [1]))
    }
};

export const TINY_WEIGHT_VALUES = [0.5, -1.25, 2, 0, 1, 2, 3, 4, 5, 6, 7, 8];

interface ArchiveOptions {
    prefix?: string;
    /** Serialized programs by model name. */
    models?: Record<string, Json>;
    /** Extra members appended verbatim (already prefixed by the helper). */
    members?: ZipMember[];
    /** Omit the archive_format marker to simulate an unknown layout. */
    omitMarkers?: boolean;
    zip64?: boolean;
    byteorder?: string;
}

/** Composes a package the way PyTorchFileWriter lays it out. */
export function pt2Archive(options: ArchiveOptions = {}): Uint8Array {
    const prefix = options.prefix ?? 'model';
    const at = (name: string): string => prefix ? `${prefix}/${name}` : name;
    const members: ZipMember[] = [];
    for (const [name, program] of Object.entries(options.models ?? {})) {
        members.push({ name: at(`models/${name}.json`), data: JSON.stringify(program) });
    }
    for (const member of options.members ?? []) members.push({ name: at(member.name), data: member.data, ...(member.method === undefined ? {} : { method: member.method }) });
    if (!options.omitMarkers) {
        members.push(
            { name: at('archive_format'), data: 'pt2' },
            { name: at('archive_version'), data: '0' },
            { name: at('.data/version'), data: '6\n' },
            { name: at('byteorder'), data: options.byteorder ?? 'little' },
            { name: at('.data/serialization_id'), data: '0613905680677350108814215759929456013960' }
        );
    }
    return buildZip(members, { ...(options.zip64 ? { zip64: true } : {}) });
}

/** The tiny MLP as `torch.export.save` writes it. */
export function tinyArchive(extra: Partial<ArchiveOptions> = {}): Uint8Array {
    return pt2Archive({
        prefix: 'tiny',
        models: { model: TINY_PROGRAM },
        members: [
            { name: 'data/weights/weight_0', data: floats(TINY_WEIGHT_VALUES) },
            { name: 'data/weights/weight_1', data: floats([0.25, 0.5, 0.75]) },
            { name: 'data/weights/weight_2', data: floats([2]) },
            { name: 'data/weights/model_weights_config.json', data: JSON.stringify(TINY_WEIGHTS_CONFIG) },
            { name: 'data/constants/model_constants_config.json', data: '{"config": {}}' },
            { name: 'data/sample_inputs/model.pt', data: new Uint8Array(64) }
        ],
        ...extra
    });
}

export const RICH_WEIGHTS_CONFIG: Json = {
    config: {
        'sub.conv.weight': payload('weight_0', true, tensorMeta(7, [4, 3, 3, 3])),
        'sub.conv.bias': payload('weight_1', true, tensorMeta(7, [4])),
        counter: payload('weight_2', false, tensorMeta(5, [1])),
        // Deliberately shorter than the tensor it declares.
        'sub.bn.running_mean': payload('weight_3', false, tensorMeta(7, [4]))
    }
};

export const RICH_CONSTANTS_CONFIG: Json = {
    config: {
        const: payload('tensor_0', false, tensorMeta(7, [5])),
        half: payload('tensor_1', false, tensorMeta(6, [2])),
        // Referenced by the config but absent from the archive.
        ghost: payload('tensor_9', false, tensorMeta(7, [1])),
        // A pickled script object.
        tokenizer: { path_name: 'custom_obj_0', is_param: false, use_pickle: true, tensor_meta: null }
    }
};

/** The control-flow model with a truncated buffer, a missing constant, and a custom object. */
export function richArchive(): Uint8Array {
    return pt2Archive({
        prefix: 'rich',
        models: { model: RICH_PROGRAM },
        members: [
            { name: 'data/weights/weight_0', data: floats(Array.from({ length: 108 }, (_, index) => index / 100)) },
            { name: 'data/weights/weight_1', data: floats([1, 2, 3, 4]) },
            { name: 'data/weights/weight_2', data: int64([7]) },
            { name: 'data/weights/weight_3', data: floats([0.1, 0.2]) },
            { name: 'data/weights/model_weights_config.json', data: JSON.stringify(RICH_WEIGHTS_CONFIG) },
            { name: 'data/constants/tensor_0', data: floats([0.5, -0.5, 1, 2, 3]) },
            { name: 'data/constants/tensor_1', data: halves([1, 2]) },
            { name: 'data/constants/custom_obj_0', data: new Uint8Array([0x80, 0x02, 0x63]) },
            { name: 'data/constants/model_constants_config.json', data: JSON.stringify(RICH_CONSTANTS_CONFIG) },
            { name: 'data/sample_inputs/model.pt', data: new Uint8Array(32) }
        ]
    });
}

/** Two programs packaged together with user extra files. */
export function multiArchive(): Uint8Array {
    return pt2Archive({
        prefix: 'multi',
        models: { encoder: TINY_PROGRAM, decoder: RICH_PROGRAM },
        members: [
            { name: 'data/weights/weight_0', data: floats(TINY_WEIGHT_VALUES) },
            { name: 'data/weights/encoder_weights_config.json', data: JSON.stringify({ config: { 'fc.weight': payload('weight_0', true, tensorMeta(7, [3, 4])) } }) },
            { name: 'data/weights/decoder_weights_config.json', data: '{"config": {}}' },
            { name: 'extra/note.txt', data: 'hello' },
            { name: 'extra/meta.json', data: '{"k": 1}' }
        ]
    });
}

/** AOTInductor-only package: compiled artifacts, no Export IR. */
export function aotiArchive(): Uint8Array {
    const metadata = JSON.stringify({ AOTI_DEVICE_KEY: 'cpu', AOTI_PLATFORM: 'darwin', AOTI_MACHINE: 'arm64' });
    return pt2Archive({
        prefix: 'aoti',
        members: [
            { name: 'data/aotinductor/model/abc.wrapper.cpp', data: '// wrapper' },
            { name: 'data/aotinductor/model/abc.wrapper_metadata.json', data: metadata },
            { name: 'data/aotinductor/model/def.kernel_metadata.json', data: metadata },
            { name: 'data/aotinductor/model/abc.wrapper.so', data: new Uint8Array(256) }
        ]
    });
}

/** The pre-PT2 `torch.export.save` layout: flat members with pickled weights. */
export function legacyArchive(): Uint8Array {
    return buildZip([
        { name: 'serialized_exported_program.json', data: JSON.stringify(TINY_PROGRAM) },
        { name: 'serialized_state_dict.pt', data: new Uint8Array(128) },
        { name: 'serialized_constants.pt', data: new Uint8Array(16) },
        { name: 'serialized_example_inputs.pt', data: new Uint8Array(16) },
        { name: 'version', data: '1\n' }
    ], { align: 0 });
}
