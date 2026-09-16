import { describe, expect, it } from 'vitest';
import { IR_LOOP_XML, IR_V11_XML, IR_V7_XML, encode, irV11Weights } from './__tests__/fixture.js';
import { decodeEntities, looksLikeOpenVinoIr, parseOpenVino, previewConstant, splitTensorNames } from './index.js';

describe('parseOpenVino', () => {
    it('reads topology, ports, attributes, and rt_info from an IR v11 xml', () => {
        const model = parseOpenVino(encode(IR_V11_XML));
        expect(model.name).toBe('tiny_mlp');
        expect(model.irVersion).toBe('11');
        expect(model.layers).toHaveLength(7);
        expect(model.edges).toHaveLength(6);
        expect(model.inputs.map(layer => layer.name)).toEqual(['input']);
        expect(model.outputs.map(layer => layer.name)).toEqual(['output']);
        expect(model.opsets).toEqual(['opset1']);
        expect(model.operators[0]).toEqual({ type: 'Const', version: 'opset1', count: 2 });

        const matmul = model.layers[2]!;
        expect(matmul.type).toBe('MatMul');
        expect(matmul.attributes).toEqual([{ key: 'transpose_a', value: 'false' }, { key: 'transpose_b', value: 'false' }]);
        expect(matmul.inputs.map(port => port.dims)).toEqual([['1', '4'], ['4', '2']]);
        expect(matmul.outputs[0]).toMatchObject({ id: '2', precision: 'FP32', names: ['fc'], dims: ['1', '2'] });
        expect(matmul.outputs[0]!.rtInfo).toEqual([{ key: 'layout', value: 'layout=[N,C]' }]);

        const input = model.layers[0]!;
        expect(input.outputs[0]!.names).toEqual(['input', 'x']);
        expect(input.outputNames).toEqual([]);
        expect(model.layers[6]!.outputNames).toEqual(['logits', 'relu']);
        expect(input.rtInfo).toEqual([{ key: 'fused_names', value: 'input' }]);
        // A marker attribute with no payload is kept (weight-compressed models rely on it).
        expect(model.layers[3]!.rtInfo).toEqual([{ key: 'decompression', value: '' }]);

        expect(model.metadata).toEqual([
            { key: 'MO_version', value: '2024.6.0-17404-4c0f47d2335-releases/2024/6' },
            { key: 'Runtime_version', value: '2024.6.0-17404-4c0f47d2335-releases/2024/6' },
            { key: 'conversion_parameters.framework', value: 'pytorch' },
            { key: 'conversion_parameters.is_python_object', value: 'True' },
            { key: 'optimization.description', value: 'quantized & pruned' }
        ]);
        expect(model.warnings).toEqual([{ key: 'openvino.warning.noWeights' }]);
        expect(model.summary.map(item => item.value)).toEqual([7, 6, 6, 2, '36 B', '1 / 1']);
    });

    it('indexes constants into the .bin and previews their leading values', () => {
        const model = parseOpenVino(encode(IR_V11_XML), { weights: irV11Weights() });
        expect(model.weightsBytes).toBe(36);
        expect(model.referencedBytes).toBe(36);
        expect(model.warnings).toEqual([]);
        expect(model.constants).toHaveLength(2);
        const [weights, bias] = model.constants;
        expect(weights).toMatchObject({ layerName: 'fc/weights', kind: 'data', elementType: 'f32', shape: ['4', '2'], elementCount: 8, offset: 0, size: 32, status: 'available' });
        expect(weights!.preview).toEqual(['0.5', '-1.25', '2', '0', '3.5', '-0.75', '1', '8']);
        expect(bias).toMatchObject({ elementType: 'f16', elementCount: 2, offset: 32, size: 4, status: 'available', preview: ['1', '-2'] });
    });

    it('flags constants that fall outside the supplied .bin and bytes nothing references', () => {
        const short = parseOpenVino(encode(IR_V11_XML), { weights: irV11Weights().subarray(0, 20) });
        expect(short.constants.map(constant => constant.status)).toEqual(['out-of-range', 'out-of-range']);
        expect(short.warnings).toEqual([{ key: 'openvino.warning.weightsOutOfRange', args: { count: 2, size: '20 B' } }]);

        const long = parseOpenVino(encode(IR_V11_XML), { weights: new Uint8Array(100) });
        expect(long.warnings).toEqual([{ key: 'openvino.warning.weightsUnreferenced', args: { bytes: '64 B' } }]);
    });

    it('reads legacy v7 blobs and meta_data, and flags the version', () => {
        const model = parseOpenVino(encode(IR_V7_XML), { weights: new Uint8Array(32) });
        expect(model.irVersion).toBe('7');
        expect(model.inputs.map(layer => layer.name)).toEqual(['data']);
        expect(model.layers[0]!.outputs[0]!.precision).toBe('FP32');
        expect(model.constants.map(constant => [constant.kind, constant.elementType, constant.offset, constant.size, constant.elementCount]))
            .toEqual([['weights', 'FP32', 0, 24, 6], ['biases', 'FP32', 24, 8, 2]]);
        expect(model.metadata).toEqual([{ key: 'MO_version', value: '2019.3.0' }, { key: 'cli_parameters.input_model', value: 'model.caffemodel' }]);
        expect(model.warnings).toEqual([{ key: 'openvino.warning.legacyVersion', args: { version: '7' } }]);
    });

    it('bounds layers, edges, and metadata and reports what it dropped', () => {
        const model = parseOpenVino(encode(IR_V11_XML), { maxLayers: 3, maxEdges: 2, maxMetadata: 1 });
        expect(model.layers).toHaveLength(3);
        expect(model.edges).toHaveLength(2);
        expect(model.metadata).toHaveLength(1);
        expect(model.warnings).toContainEqual({ key: 'openvino.warning.metadataLimited', args: { count: 4 } });
        // Containers and text-valued elements count as the entries they would have produced.
        expect(parseOpenVino(encode(IR_V11_XML), { maxMetadata: 4 }).warnings).toContainEqual({ key: 'openvino.warning.metadataLimited', args: { count: 1 } });
        expect(model.warnings.map(warning => warning.key)).toEqual([
            'openvino.warning.layersLimited', 'openvino.warning.edgesLimited', 'openvino.warning.metadataLimited', 'openvino.warning.noWeights'
        ]);
        expect(model.summary[0]!.value).toBe(7);
    });

    it('reports truncated documents, dangling edges, and unparseable offsets instead of throwing', () => {
        const truncated = parseOpenVino(encode(IR_V11_XML.slice(0, 900)));
        expect(truncated.warnings.map(warning => warning.key)).toContain('openvino.warning.truncated');
        expect(truncated.layers.length).toBeGreaterThan(0);
        // Writers flush on line boundaries, so a partial file usually stops
        // between tags: the open layer is kept and the document is flagged.
        const onBoundary = parseOpenVino(encode(IR_V11_XML.slice(0, IR_V11_XML.indexOf('<input>', IR_V11_XML.indexOf('name="output"')))));
        expect(onBoundary.warnings.map(warning => warning.key)).toContain('openvino.warning.truncated');
        expect(onBoundary.layers).toHaveLength(7);
        expect(onBoundary.edges).toHaveLength(0);
        const midPort = parseOpenVino(encode(IR_V11_XML.slice(0, IR_V11_XML.indexOf('<dim>4</dim>'))));
        expect(midPort.warnings.map(warning => warning.key)).toContain('openvino.warning.truncated');
        expect(midPort.layers[0]!.outputs[0]!.dims).toEqual(['1']);

        const dangling = parseOpenVino(encode(IR_V11_XML.replace('to-layer="6"', 'to-layer="99"')));
        expect(dangling.warnings).toContainEqual({ key: 'openvino.warning.danglingEdges', args: { count: 1 } });

        const invalid = parseOpenVino(encode(IR_V11_XML.replace('offset="32"', 'offset="x"')), { weights: irV11Weights() });
        expect(invalid.constants[1]!.status).toBe('invalid');
        // An unreadable range disqualifies the mismatched-pair signal too.
        expect(invalid.warnings).toEqual([{ key: 'openvino.warning.invalidConstants', args: { count: 1 } }]);
    });


    it('reads control-flow bodies as nested scopes and counts their constants against the .bin', () => {
        const bin = new Uint8Array(8);
        new DataView(bin.buffer).setFloat32(4, 2.5, true);
        const model = parseOpenVino(encode(IR_LOOP_XML), { weights: bin });
        expect(model.warnings).toEqual([]);
        expect(model.layers.map(layer => layer.type)).toEqual(['Parameter', 'Const', 'Loop', 'Result']);
        expect(model.edges).toHaveLength(2);
        const loop = model.layers[2]!;
        expect(loop.inputs).toHaveLength(3);
        expect(loop.outputs[0]!.names).toEqual(['y']);
        expect(loop.rtInfo).toEqual([{ key: 'layout', value: 'layout=[N]' }]);
        expect(loop.bodies).toHaveLength(1);
        const body = loop.bodies[0]!;
        expect(body.kind).toBe('body');
        expect(body.layers.map(layer => layer.name)).toEqual(['body_in', 'body_k', 'body_add', 'body_res']);
        expect(body.edges).toHaveLength(3);
        expect(body.layers[2]!.inputs).toHaveLength(2);
        expect(body.layers[2]!.outputs[0]!.names).toEqual(['body_out']);
        expect(model.constants.map(constant => [constant.layerName, constant.offset, constant.status])).toEqual([['k', 0, 'available'], ['body_k', 4, 'available']]);
        expect(model.constants[1]!.preview).toEqual(['2.5']);
        expect(model.referencedBytes).toBe(8);
        expect(model.summary[0]!.value).toBe(4); // top-level layers only
    });

    it('unescapes \\, in tensor names, reads <info name> and CDATA metadata, and skips DOCTYPE and comments', () => {
        const model = parseOpenVino(encode(IR_LOOP_XML));
        expect(model.layers[0]!.outputs[0]!.names).toEqual(['x,0', 'alias']);
        expect(model.metadata).toEqual([{ key: 'my key', value: 'my value' }, { key: 'notes', value: 'a <b> & c' }]);
        expect(splitTensorNames('a\\,b, c ,,d\\\\')).toEqual(['a,b', 'c', 'd\\\\']);
        expect(splitTensorNames('')).toEqual([]);
    });

    it('counts a .bin range shared by several constants once', () => {
        const shared = IR_V11_XML.replace('offset="32" size="4"', 'offset="0" size="32"').replace('element_type="f16" shape="1,2"', 'element_type="f32" shape="4,2"');
        const model = parseOpenVino(encode(shared), { weights: irV11Weights().subarray(0, 32) });
        expect(model.constants.map(constant => constant.offset)).toEqual([0, 0]);
        expect(model.referencedBytes).toBe(32);
        expect(model.warnings).toEqual([]);
    });

    it('previews from a .bin view with a non-zero byteOffset', () => {
        const padded = new Uint8Array(4 + 36);
        padded.set(irV11Weights(), 4);
        const model = parseOpenVino(encode(IR_V11_XML), { weights: padded.subarray(4) });
        expect(model.constants[0]!.preview.slice(0, 2)).toEqual(['0.5', '-1.25']);
        expect(model.constants[1]!.preview).toEqual(['1', '-2']);
    });

    it('rejects empty input and documents whose root is not <net>', () => {
        expect(() => parseOpenVino(new Uint8Array())).toThrow(/empty/);
        expect(() => parseOpenVino(encode('<?xml version="1.0"?><AUTOSAR><AR-PACKAGES/></AUTOSAR>'))).toThrow(/root element is <AUTOSAR>/);
        expect(() => parseOpenVino(encode('just text'))).toThrow(/no <net> root/);
        expect(() => parseOpenVino(encode(IR_V11_XML), { maxXmlBytes: 10 })).toThrow(/exceeds/);
    });

    it('caps control-flow bodies per layer while keeping depth bookkeeping balanced', () => {
        const xml = `<net name="n" version="11"><layers><layer id="0" name="a" type="If" version="opset8">${'<body><layers><layer id="0" name="b" type="Const" version="opset1"><data element_type="f32" shape="1" offset="0" size="4"/></layer></layers></body>'.repeat(10)}</layer><layer id="1" name="c" type="Relu" version="opset1"/></layers></net>`;
        const model = parseOpenVino(encode(xml), { weights: new Uint8Array(4) });
        expect(model.layers).toHaveLength(2);
        expect(model.layers[0]!.bodies).toHaveLength(4);
        expect(model.constants).toHaveLength(4);
        // The six bodies past the cap are scanned detached: their layers are reported as omitted.
        expect(model.warnings).toEqual([
            { key: 'openvino.warning.bodyLayersLimited', args: { count: 6 } },
            { key: 'openvino.warning.bodiesLimited', args: { count: 6 } }
        ]);
    });

    it('reports the layer cap in top-level terms and body drops separately', () => {
        const model = parseOpenVino(encode(IR_LOOP_XML), { maxLayers: 5 });
        // Layers 0-2 top-level, then body_in and body_k fill the cap; two body
        // layers and the top-level Result are dropped.
        expect(model.layers.map(layer => layer.name)).toEqual(['x', 'k', 'loop']);
        expect(model.layers[2]!.bodies[0]!.layers.map(layer => layer.name)).toEqual(['body_in', 'body_k']);
        expect(model.summary[0]!.value).toBe(4);
        expect(model.warnings).toEqual([
            { key: 'openvino.warning.layersLimited', args: { shown: 3, total: 4 } },
            { key: 'openvino.warning.bodyLayersLimited', args: { count: 2 } },
            { key: 'openvino.warning.noWeights' }
        ]);
    });

    it('reports the edge cap in top-level terms and counts layers inside a dropped layer\'s body', () => {
        // Body edges precede the top-level <edges> in document order, so a cap
        // of 1 keeps one body edge and drops both top-level ones.
        const edges = parseOpenVino(encode(IR_LOOP_XML), { maxEdges: 1 });
        expect(edges.edges).toHaveLength(0);
        expect(edges.layers[2]!.bodies[0]!.edges).toHaveLength(1);
        expect(edges.summary[1]!.value).toBe(2);
        expect(edges.warnings).toEqual([
            { key: 'openvino.warning.edgesLimited', args: { shown: 0, total: 2 } },
            { key: 'openvino.warning.bodyEdgesLimited', args: { count: 2 } },
            { key: 'openvino.warning.noWeights' }
        ]);
        // The Loop itself is dropped: its four body layers are still counted.
        const layers = parseOpenVino(encode(IR_LOOP_XML), { maxLayers: 2 });
        expect(layers.layers.map(layer => layer.name)).toEqual(['x', 'k']);
        expect(layers.warnings).toEqual([
            { key: 'openvino.warning.layersLimited', args: { shown: 2, total: 4 } },
            { key: 'openvino.warning.bodyLayersLimited', args: { count: 4 } },
            { key: 'openvino.warning.bodyEdgesLimited', args: { count: 3 } },
            { key: 'openvino.warning.noWeights' }
        ]);
        expect(layers.edges).toHaveLength(2); // top-level edges after the dropped layer still read
    });

    it('does not call a paired .bin unreferenced when constants were dropped or the file is cut', () => {
        expect(parseOpenVino(encode(IR_V11_XML), { weights: irV11Weights(), maxLayers: 2 }).warnings.map(warning => warning.key))
            .toEqual(['openvino.warning.layersLimited']);
        const cut = IR_V11_XML.slice(0, IR_V11_XML.indexOf('<layer id="3"'));
        expect(parseOpenVino(encode(cut), { weights: irV11Weights() }).warnings.map(warning => warning.key))
            .toEqual(['openvino.warning.truncated']);
        expect(parseOpenVino(encode(IR_LOOP_XML), { weights: new Uint8Array(8), maxLayers: 4 }).warnings.map(warning => warning.key))
            .toEqual(['openvino.warning.layersLimited', 'openvino.warning.bodyLayersLimited']);
    });

    it('scans detached bodies without consuming the layer or edge budget', () => {
        const inner = '<layer id="1" name="inner" type="Loop" version="opset5"><body><layers><layer id="0" name="deep_a" type="Relu" version="opset1"/><layer id="1" name="deep_b" type="Relu" version="opset1"/></layers><edges><edge from-layer="0" from-port="0" to-layer="1" to-port="0"/></edges></body></layer>';
        const xml = `<net name="n" version="11"><layers><layer id="0" name="a" type="Relu" version="opset1"/><layer id="1" name="outer" type="Loop" version="opset5"><body><layers><layer id="0" name="body_a" type="Relu" version="opset1"/>${inner}</layers><edges><edge from-layer="0" from-port="0" to-layer="1" to-port="0"/></edges></body></layer><layer id="2" name="b" type="Relu" version="opset1"/></layers><edges><edge from-layer="0" from-port="0" to-layer="2" to-port="0"/></edges></net>`;
        // Cap of 3: a, outer, body_a are kept; inner is dropped and its body
        // (deep_a, deep_b + one edge) is scanned detached, so the top-level b
        // and the top-level edge are still read and counted.
        const model = parseOpenVino(encode(xml), { maxLayers: 3, maxEdges: 1 });
        expect(model.layers.map(layer => layer.name)).toEqual(['a', 'outer']);
        expect(model.layers[1]!.bodies[0]!.layers.map(layer => layer.name)).toEqual(['body_a']);
        expect(model.layers[1]!.bodies[0]!.edges).toHaveLength(1);
        expect(model.edges).toHaveLength(0);
        expect(model.warnings).toEqual([
            { key: 'openvino.warning.layersLimited', args: { shown: 2, total: 3 } },
            { key: 'openvino.warning.edgesLimited', args: { shown: 0, total: 1 } },
            { key: 'openvino.warning.bodyLayersLimited', args: { count: 3 } },
            { key: 'openvino.warning.bodyEdgesLimited', args: { count: 1 } },
            { key: 'openvino.warning.noWeights' }
        ]);
        // Bodies past the per-layer cap are detached too: their layers count as omitted and consume nothing.
        const overflow = `<net name="n" version="11"><layers><layer id="0" name="if" type="If" version="opset8">${'<body><layers><layer id="0" name="x" type="Relu" version="opset1"/></layers></body>'.repeat(6)}</layer><layer id="1" name="b" type="Relu" version="opset1"/></layers></net>`;
        const capped = parseOpenVino(encode(overflow), { maxLayers: 6 });
        expect(capped.layers.map(layer => layer.name)).toEqual(['if', 'b']);
        expect(capped.warnings).toEqual([
            { key: 'openvino.warning.bodyLayersLimited', args: { count: 2 } },
            { key: 'openvino.warning.bodiesLimited', args: { count: 2 } },
            { key: 'openvino.warning.noWeights' }
        ]);
    });

    it('reads If then/else bodies and range-checks the constants in both', () => {
        const body = (kind: string, offset: number) => `<${kind}><layers><layer id="0" name="${kind}_k" type="Const" version="opset1"><data element_type="f32" shape="1" offset="${offset}" size="4"/><output><port id="0" precision="FP32"><dim>1</dim></port></output></layer></layers><edges/></${kind}>`;
        const xml = `<net name="n" version="11"><layers><layer id="0" name="cond" type="If" version="opset8"><then_port_map/><else_port_map/>${body('then_body', 0)}${body('else_body', 4)}</layer></layers><edges/></net>`;
        const model = parseOpenVino(encode(xml), { weights: new Uint8Array(6) });
        const layer = model.layers[0]!;
        expect(layer.bodies.map(item => item.kind)).toEqual(['then_body', 'else_body']);
        expect(model.constants.map(constant => [constant.layerName, constant.status])).toEqual([['then_body_k', 'available'], ['else_body_k', 'out-of-range']]);
        expect(model.warnings).toEqual([{ key: 'openvino.warning.weightsOutOfRange', args: { count: 1, size: '6 B' } }]);
    });

    it('flushes every open scope when the document ends inside a body', () => {
        const cut = IR_LOOP_XML.slice(0, IR_LOOP_XML.indexOf('<output><port id="2" precision="FP32" names="body_out"'));
        const model = parseOpenVino(encode(cut));
        expect(model.warnings.map(warning => warning.key)).toEqual(['openvino.warning.truncated', 'openvino.warning.noWeights']);
        expect(model.layers.map(layer => layer.name)).toEqual(['x', 'k', 'loop']);
        const loop = model.layers[2]!;
        expect(loop.bodies[0]!.layers.map(layer => layer.name)).toEqual(['body_in', 'body_k', 'body_add']);
        expect(loop.bodies[0]!.layers[2]!.inputs).toHaveLength(2);
        expect(loop.inputs).toHaveLength(3);
    });

    it('stays balanced on stray close tags and content after the root instead of throwing', () => {
        const unwound = '<net version="11"><layers><layer id="1" name="l" type="Loop" version="opset5"><body></body></body></body></body><layer id="3" name="r" type="Relu" version="opset1"/></layers></net>';
        const model = parseOpenVino(encode(unwound));
        expect(model.layers.map(layer => layer.name)).toContain('l');
        expect(model.warnings.map(warning => warning.key)).toContain('openvino.warning.truncated');

        const metadata = '<net version="11"><rt_info></rt_info></rt_info></rt_info><layers><layer id="0" name="a" type="Relu" version="opset1"/></layers></net>';
        expect(parseOpenVino(encode(metadata)).warnings.map(warning => warning.key)).toContain('openvino.warning.truncated');

        const trailing = parseOpenVino(encode(`${IR_V11_XML}<net version="11"><layers><layer id="9" name="ghost" type="Relu" version="opset1"/></layers></net>`));
        expect(trailing.layers).toHaveLength(7);
        expect(trailing.warnings.map(warning => warning.key)).toContain('openvino.warning.truncated');

        expect(() => parseOpenVino(encode('</net><net version="11"><layers/></net>'))).not.toThrow();
    });

    it('reads <user_data> rt_info entries on layers and ports, nested keys joined', () => {
        const xml = `<net name="n" version="11"><layers><layer id="0" name="a" type="Relu" version="opset1">
            <rt_info>
                <attribute name="fused_names" version="0" value="a"/>
                <user_data name="owner" value="me" version=""/>
                <user_data name="outer"><user_data name="k" value="v" version=""/><user_data name="deep"><user_data name="x" value="1" version=""/></user_data></user_data>
            </rt_info>
            <output><port id="0" precision="FP32"><dim>1</dim><rt_info><user_data name="tag" value="t" version=""/><attribute name="layout" version="0" layout="[N]"/></rt_info></port></output>
        </layer></layers></net>`;
        const model = parseOpenVino(encode(xml));
        const layer = model.layers[0]!;
        expect(layer.rtInfo).toEqual([
            { key: 'fused_names', value: 'a' }, { key: 'owner', value: 'me' },
            { key: 'outer.k', value: 'v' }, { key: 'outer.deep.x', value: '1' }
        ]);
        expect(layer.outputs[0]!.rtInfo).toEqual([{ key: 'tag', value: 't' }, { key: 'layout', value: 'layout=[N]' }]);
        expect(layer.outputs[0]!.dims).toEqual(['1']);
        expect(model.metadata).toEqual([]);
    });

    it('keeps comma-heavy attributes and capped metadata bounded', () => {
        const commas = ','.repeat(2_000_000);
        const xml = `<net name="n" version="11"><layers><layer id="0" name="a" type="Const" version="opset1"><data element_type="f32" shape="1${commas}2" offset="0" size="4"/><output><port id="0" precision="FP32" names="x${commas}y"><dim>1</dim></port></output></layer></layers><rt_info>${'<a><b><c>'.repeat(8)}${'<x value="1"/>'.repeat(50_000)}${'</c></b></a>'.repeat(8)}</rt_info></net>`;
        const started = Date.now();
        const model = parseOpenVino(encode(xml), { maxMetadata: 10 });
        expect(Date.now() - started).toBeLessThan(2000);
        expect(model.layers[0]!.outputs[0]!.names).toEqual(['x', 'y']);
        expect(model.constants[0]!.shape).toEqual(['1', '2']);
        expect(model.metadata).toHaveLength(10);
        expect(model.warnings).toContainEqual({ key: 'openvino.warning.metadataLimited', args: { count: 49_990 } });
        expect(splitTensorNames(`${'a'.repeat(5000)}\\,${'b'.repeat(5000)},c`).map(item => item.length)).toEqual([513, 1]);
    });

    it('honours an abort signal at element checkpoints', () => {
        const controller = new AbortController();
        controller.abort();
        const big = `<net name="n" version="11"><layers>${'<layer id="1" type="Const"/>'.repeat(20_000)}</layers></net>`;
        expect(() => parseOpenVino(encode(big), { signal: controller.signal })).toThrow(/aborted/);
    });

    it('decodes predefined and numeric entities in attribute values', () => {
        expect(decodeEntities('a &lt; b &amp;&#65;&#x42; &unknown; &constructor;')).toBe('a < b &AB &unknown; &constructor;');
        const model = parseOpenVino(encode(IR_V11_XML.replace('name="tiny_mlp"', 'name="a&quot;b&apos;c"')));
        expect(model.name).toBe(`a"b'c`);
    });

    it('previews every fixed-width element type little-endian', () => {
        const bytes = new Uint8Array(16);
        const view = new DataView(bytes.buffer);
        view.setBigInt64(0, -5n, true);
        view.setUint16(8, 0x3f80, true); // bf16 1.0
        view.setInt8(10, -3);
        view.setUint8(11, 0x38); // f8e4m3 1.0
        view.setUint8(12, 0x3c); // f8e5m2 1.0
        const at = (elementType: string, offset: number, size: number) =>
            previewConstant(bytes, { layerId: '', layerName: '', kind: 'data', elementType, shape: [], elementCount: 0, offset, size, status: 'unchecked', preview: [] }, 4);
        expect(at('i64', 0, 8)).toEqual(['-5']);
        expect(at('u64', 0, 8)).toEqual(['18446744073709551611']);
        expect(at('i32', 0, 8)).toEqual(['-5', '-1']);
        expect(at('u32', 0, 8)).toEqual(['4294967291', '4294967295']);
        expect(at('i16', 0, 4)).toEqual(['-5', '-1']);
        expect(at('u16', 0, 4)).toEqual(['65531', '65535']);
        expect(at('u8', 0, 2)).toEqual(['251', '255']);
        expect(at('f8e8m0', 11, 1)).toEqual(['4.23516e-22']); // 0x38 = 56 → 2^(56-127)
        expect(at('f8e8m0', 1, 1)).toEqual(['NaN']); // byte 1 of -5n is 0xff
        view.setUint8(13, 0x7f);
        expect(at('f8e8m0', 13, 1)).toEqual(['1']);
        view.setFloat64(0, -2.5, true);
        expect(at('f64', 0, 8)).toEqual(['-2.5']);
        expect(at('bf16', 8, 2)).toEqual(['1']);
        expect(at('i8', 10, 1)).toEqual(['-3']);
        expect(at('f8e4m3', 11, 1)).toEqual(['1']);
        expect(at('f8e5m2', 12, 1)).toEqual(['1']);
        expect(at('u4', 0, 8)).toEqual([]);
        expect(at('string', 0, 8)).toEqual([]);
        expect(at('f32', 12, 8)).toEqual([]); // range overflow
    });
});

describe('looksLikeOpenVinoIr', () => {
    it('recognises an IR root with a version and layers, and nothing else', () => {
        expect(looksLikeOpenVinoIr(IR_V11_XML)).toBe(true);
        expect(looksLikeOpenVinoIr(IR_V7_XML)).toBe(true);
        expect(looksLikeOpenVinoIr(`\uFEFF<!-- c --><net version="11"><layers/></net>`)).toBe(true);
        expect(looksLikeOpenVinoIr(IR_LOOP_XML)).toBe(true);
        expect(looksLikeOpenVinoIr('<network version="11"><layers/></network>')).toBe(false);
        // Case-sensitive like the parser, so a claimed file never bounces off it.
        expect(looksLikeOpenVinoIr('<NET version="11"><LAYERS/></NET>')).toBe(false);
        expect(() => parseOpenVino(encode('<NET version="11"><LAYERS/></NET>'))).toThrow(/root element/);
        expect(looksLikeOpenVinoIr('<net name="x"><layers/></net>')).toBe(false);
        expect(looksLikeOpenVinoIr('<net version="11"><nodes/></net>')).toBe(false);
        expect(looksLikeOpenVinoIr('<?xml version="1.0"?><AUTOSAR/>')).toBe(false);
        expect(looksLikeOpenVinoIr('{"net":1}')).toBe(false);
        expect(looksLikeOpenVinoIr('<?xml version="1.0"?>\n<!-- a -->\n<!-- b --><?pi x?>\n<net version="10"><layers/></net>')).toBe(true);
        expect(looksLikeOpenVinoIr('<net version="11"><!-- c --><layers/></net>')).toBe(true);
        // Unterminated prologue and hostile repetition stay linear and unclaimed.
        expect(looksLikeOpenVinoIr('<?xml version="1.0"')).toBe(false);
        const started = Date.now();
        expect(looksLikeOpenVinoIr('<?'.repeat(32 * 1024))).toBe(false);
        expect(looksLikeOpenVinoIr('<!--'.repeat(16 * 1024))).toBe(false);
        expect(Date.now() - started).toBeLessThan(200);
    });
});
