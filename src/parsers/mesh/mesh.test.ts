import { describe, expect, it } from 'vitest';
import { isMeshRelativePath, parseMesh, type MeshParseOptions } from './index.js';
import { binaryGlb, binaryStl, bytes, embeddedGltf, manifest, obj, stl } from './__tests__/fixtures.js';

const parse = (data: Uint8Array, fileName: string, options: Partial<MeshParseOptions> = {}) => parseMesh(data, { fileName, ...options }).result;
describe('mesh preflight parser', () => {
    it.each([
        ['sample.obj', bytes(obj)], ['sample.stl', bytes(stl)], ['binary.stl', binaryStl()],
        ['sample.gltf', embeddedGltf()], ['sample.glb', binaryGlb()], ['extensionless', binaryGlb()]
    ])('reads %s without DOM or mutation', (name, data) => {
        const copy = data.slice(), result = parse(data, name);
        expect(result.status).toBe('ok');
        if (result.status === 'failed') return;
        expect(result.document.triangleCount).toBe(1); expect(result.document.vertexCount).toBe(3);
        expect(result.document.data).toBe(data); expect(data).toEqual(copy);
    });
    it('respects input subarray offsets', () => {
        const glb = binaryGlb(), buffer = new Uint8Array(glb.length + 19); buffer.set(glb, 11);
        expect(parse(buffer.subarray(11, 11 + glb.length), 'model.glb').status).toBe('ok');
    });
    it('counts OBJ polygon fans, negative indices, groups, UVs, and normals', () => {
        const result = parse(bytes('o square\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvn 0 0 1\nf -4/1/1 -3/1/1 -2/1/1 -1/1/1'), 'SQUARE.OBJ');
        expect(result.status).toBe('ok'); if (result.status !== 'failed') expect(result.document.triangleCount).toBe(2);
    });
    it.each(['f 0 2 3', 'f 1 2 7', 'f -9 -2 -1', 'f 1/a 2 3', 'f 1/1 2/1 3/1', 'f 1 2', 'f 1//4 2//4 3//4'])('rejects invalid OBJ indices: %s', face => {
        expect(parse(bytes(obj.replace('f 1 2 3', face)), 'bad.obj').status).toBe('failed');
    });
    it.each([stl.replace('vertex 1 0 0', 'vertex NaN 0 0'), stl.replace('normal 0 0 1', 'normal NaN 0 1'), stl.replace('vertex 1 0 0\n', ''), stl.replace('endfacet', '')])('rejects malformed ASCII STL', text => {
        expect(parse(bytes(text), 'bad.stl').status).toBe('failed');
    });
    it('rejects truncated binary STL and nonfinite positions', () => {
        expect(parse(binaryStl().subarray(0, 120), 'bad.stl').status).toBe('failed');
        const data = binaryStl(); new DataView(data.buffer).setFloat32(96, Infinity, true);
        expect(parse(data, 'bad.stl').status).toBe('failed');
    });
    it('rejects invalid GLB headers and chunk lengths without out-of-bounds reads', () => {
        for (const offset of [4, 8, 12, 16]) {
            const data = binaryGlb(); new DataView(data.buffer).setUint32(offset, 0xffffffff, true);
            expect(parse(data, 'bad.glb').status, String(offset)).toBe('failed');
        }
        for (const end of [0, 3, 12, 19, 32]) expect(parse(binaryGlb().subarray(0, end), 'bad.glb').status).toBe('failed');
    });
    it('retains relative external buffers and image URIs, deduplicated', () => {
        const json = { ...manifest('model.bin'), images: [{ uri: 'textures/diffuse%20map.png' }, { uri: 'textures/diffuse%20map.png' }] };
        const result = parse(bytes(JSON.stringify(json)), 'model.gltf');
        expect(result.status).toBe('ok'); if (result.status !== 'failed') expect(result.document.resources).toEqual([
            { uri: 'model.bin', kind: 'buffer' }, { uri: 'textures/diffuse%20map.png', kind: 'image' }
        ]);
    });
    it.each(['image/ktx2', 'image/avif'])('permits embedded %s images for supported host-configured loaders', mime => {
        const json = { ...manifest(), images: [{ uri: `data:${mime};base64,AA==` }] };
        expect(parse(binaryGlb(json), 'embedded.glb').status).toBe('ok');
        expect(parse(binaryGlb(json), 'limited.glb', { limits: { maxDecompressedBytes: 36 } }).status).toBe('failed');
    });
    it.each(['https://example.org/a', '//example.org/a', '/tmp/a', '../a.bin', 'textures/../../a', '%2e%2e/a', '%252e%252e/a', 'C:\\file', 'blob:abc', 'javascript:alert(1)', 'a\u0000.bin', 'data:text/html;base64,AA=='])('blocks unsafe URI %s', uri => {
        expect(parse(bytes(JSON.stringify(manifest(uri))), 'unsafe.gltf').status).toBe('failed');
        expect(isMeshRelativePath(uri)).toBe(false);
    });
    it('rejects glTF cycles, invalid node references, unsupported versions, and invalid transforms', () => {
        for (const patch of [{ nodes: [{ children: [0] }] }, { nodes: [{ children: [99] }] }, { asset: { version: '1.0' } }, { nodes: [{ mesh: 0, scale: [1, 2] }] }]) {
            expect(parse(binaryGlb({ ...manifest(), ...patch }), 'bad.glb').status).toBe('failed');
        }
    });
    it('warns about unsupported OBJ material libraries', () => {
        const result = parse(bytes('mtllib test.mtl\n' + obj), 'model.obj');
        expect(result.status).toBe('partial'); expect(result.diagnostics[0]?.messageKey).toBe('diag.mesh.objMaterials');
    });
    it('rejects deep reverse-ordered node chains and nodes with multiple parents', () => {
        const nodes = Array.from({ length: 70 }, (_, i) => i ? { children: [i - 1] } : { mesh: 0 });
        expect(parse(binaryGlb({ ...manifest(), nodes, scenes: [{ nodes: [69] }] }), 'deep.glb').status).toBe('failed');
        expect(parse(binaryGlb({ ...manifest(), nodes: [{ mesh: 0 }, { children: [0, 0] }] }), 'shared.glb').status).toBe('failed');
    });
    it('enforces input, vertex, triangle, buffer, and scene budgets before decoding', () => {
        for (const options of [{ limits: { maxInputBytes: 1 } }, { maxVertices: 2 }, { maxTriangles: 0 }]) {
            const result = parse(binaryStl(), 'limit.stl', options);
            expect(result.status).toBe('failed'); if (result.status === 'failed') expect(result.failure.code).toBe('limit-exceeded');
        }
        expect(parse(binaryGlb(), 'limit.glb', { limits: { maxDecompressedBytes: 10 } }).status).toBe('failed');
        expect(parse(binaryGlb(), 'limit.glb', { limits: { maxEntries: 1 } }).status).toBe('failed');
    });
    it('returns structured cancellation and unsupported-format failures', () => {
        const controller = new AbortController(); controller.abort();
        const result = parse(bytes(obj), 'model.obj', { signal: controller.signal });
        expect(result.status).toBe('failed'); if (result.status === 'failed') expect(result.failure.code).toBe('aborted');
        expect(parse(bytes('unrelated'), 'file.txt').status).toBe('failed');
    });
    it('charges embedded glTF buffers once and validates actual decoded lengths', () => {
        expect(parse(embeddedGltf(), 'embedded.gltf', { limits: { maxDecompressedBytes: 36 } }).status).toBe('ok');
        expect(parse(binaryGlb(), 'same.glb', { limits: { maxDecompressedBytes: 36 } }).status).toBe('ok');
        const json = JSON.parse(new TextDecoder().decode(embeddedGltf()));
        json.buffers[0].byteLength = 1;
        expect(parse(bytes(JSON.stringify(json)), 'lying.gltf').status).toBe('failed');
    });
    it('bounds bufferless and morph accessor allocations before decoding', () => {
        const json = { ...manifest(), buffers: [], bufferViews: [], accessors: [
            { componentType: 5126, type: 'VEC3', count: 3 },
            { componentType: 5126, type: 'VEC3', count: 300_000 }
        ], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 1 }] }] }] };
        expect(parse(bytes(JSON.stringify(json)), 'amplified.gltf', { maxVertices: 3, limits: { maxDecompressedBytes: 64 } }).status).toBe('failed');
        const shapeMismatch = { ...json, accessors: [json.accessors[0], { ...json.accessors[1], count: 4 }] };
        expect(parse(bytes(JSON.stringify(shapeMismatch)), 'shape.gltf').status).toBe('failed');
        const valid = { ...json, accessors: [json.accessors[0], { ...json.accessors[1], count: 3 }] };
        expect(parse(bytes(JSON.stringify(valid)), 'valid.gltf', { limits: { maxDecompressedBytes: 168 } }).status).toBe('ok');
        expect(parse(bytes(JSON.stringify(valid)), 'limited.gltf', { limits: { maxDecompressedBytes: 71 } }).status).toBe('failed');
    });
    it('bounds overlapping bufferView copies and repeated mesh instances', () => {
        const json = { ...manifest(), bufferViews: Array.from({ length: 4 }, () => manifest().bufferViews[0]) };
        expect(parse(binaryGlb(json), 'copies.glb', { limits: { maxDecompressedBytes: 100 } }).status).toBe('failed');
        const repeated = { ...manifest(), nodes: [{ mesh: 0 }, { mesh: 0 }], scenes: [{ nodes: [0, 1] }] };
        expect(parse(binaryGlb(repeated), 'instances.glb', { maxVertices: 3 }).status).toBe('failed');
    });
    it('omits OBJ line and point records before the decoder can allocate them', () => {
        const source = obj + '\ng lines\nl ' + Array.from({ length: 1000 }, (_, i) => i % 3 + 1).join(' ') + '\ng points\np 1 2 3';
        const result = parse(bytes(source), 'mixed.obj', { maxVertices: 3 });
        expect(result.status).toBe('partial'); if (result.status === 'failed') return;
        expect(result.document.text).not.toMatch(/^\s*[lp]\s/m);
        expect(result.diagnostics.some(d => d.code === 'mesh.obj-primitives')).toBe(true);
    });
    it('bounds skeleton matrices and validates skin references', () => {
        const json = { ...manifest(), nodes: [{ mesh: 0, skin: 0 }, ...Array.from({ length: 10 }, () => ({}))],
            skins: [{ joints: Array.from({ length: 10 }, (_, i) => i + 1) }] };
        expect(parse(binaryGlb(json), 'skin.glb', { maxVertices: 3, limits: { maxDecompressedBytes: 128 } }).status).toBe('failed');
        expect(parse(binaryGlb(json), 'skin.glb').status).toBe('ok');
        expect(parse(binaryGlb({ ...json, skins: [{ joints: [1, 100] }] }), 'missing-joint.glb').status).toBe('failed');
        expect(parse(binaryGlb({ ...json, skins: [{ joints: [1, 1] }] }), 'duplicate-joint.glb').status).toBe('failed');
    });
    it('bounds OBJ polygon expansion before decoding repeated indexed faces', () => {
        const source = obj.replace('f 1 2 3\n', 'f 1 2 3\n'.repeat(100));
        const result = parse(bytes(source), 'expanded.obj', { maxVertices: 3 });
        expect(result.status).toBe('failed'); if (result.status === 'failed') expect(result.failure.code).toBe('limit-exceeded');
    });
    it('bounds generated normalized animation arrays and validates animation references', () => {
        const json = { ...manifest(), accessors: [...manifest().accessors,
            { componentType: 5126, count: 2, type: 'SCALAR' },
            { componentType: 5122, count: 2, type: 'VEC4', normalized: true }],
            animations: Array.from({ length: 100 }, () => ({ samplers: [{ input: 1, output: 2 }], channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }] })) };
        const result = parse(binaryGlb(json), 'animated.glb', { limits: { maxDecompressedBytes: 64 } });
        expect(result.status).toBe('failed'); if (result.status === 'failed') expect(result.failure.code).toBe('limit-exceeded');
        expect(parse(binaryGlb({ ...json, animations: json.animations.slice(0, 1) }), 'valid.glb').status).toBe('ok');
        const invalid = { ...json, animations: [{ samplers: [{ input: 1, output: 2 }], channels: [{ sampler: 9, target: { node: 0, path: 'rotation' } }] }] };
        expect(parse(binaryGlb(invalid), 'bad.glb').status).toBe('failed');
    });
    it('bounds generated morph texture layers even when targets share an accessor', () => {
        const json = { ...manifest(), meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: Array.from({ length: 100 }, () => ({ POSITION: 0 })) }] }] };
        const result = parse(binaryGlb(json), 'morph.glb', { maxVertices: 3, limits: { maxDecompressedBytes: 64 } });
        expect(result.status).toBe('failed'); if (result.status === 'failed') expect(result.failure.code).toBe('limit-exceeded');
    });
    it('bounds OBJ object, group and material declarations including empty groups', () => {
        for (const kind of ['o', 'g', 'usemtl']) {
            const source = obj + Array.from({ length: 100 }, (_, i) => `${kind} group${i}\n`).join('');
            const result = parse(bytes(source), 'groups.obj', { limits: { maxEntries: 2 } });
            expect(result.status).toBe('failed'); if (result.status === 'failed') expect(result.failure.code).toBe('limit-exceeded');
        }
    });
});
