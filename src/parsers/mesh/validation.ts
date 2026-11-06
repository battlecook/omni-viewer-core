import type { MeshParseOptions } from './index.js';

export class InvalidMesh extends Error {}
export class MeshLimit extends Error {}
type Value = Record<string, unknown>;
const object = (value: unknown): Value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidMesh();
    return value as Value;
};
const array = (value: unknown): unknown[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new InvalidMesh();
    return value;
};
const uint = (value: unknown): number => {
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw new InvalidMesh();
    return Number(value);
};
const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const widths: Record<string, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/** Budget decoder output independently of source buffers: a buffer and its
 * first view represent the same decoded data, while overlapping views,
 * bufferless/sparse accessors and extension outputs can amplify allocations. */
export function validateGltfAllocations(manifest: Value, options: MeshParseOptions): void {
    const maxBytes = options.limits?.maxDecompressedBytes ?? 256 * 1024 * 1024;
    const maxVertices = options.maxVertices ?? 2_000_000, maxTriangles = options.maxTriangles ?? 2_000_000;
    let allocatedBytes = 0;
    const charge = (bytes: number): void => {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new InvalidMesh();
        allocatedBytes += bytes;
        if (allocatedBytes > maxBytes) throw new MeshLimit();
    };
    const buffers = array(manifest.buffers).map(object), views = array(manifest.bufferViews).map(object);
    const accessors = array(manifest.accessors).map(object), meshes = array(manifest.meshes).map(object);
    const nodes = array(manifest.nodes).map(object), skins = array(manifest.skins).map(object);
    const counts = accessors.map(accessor => uint(accessor.count));
    const sizes = accessors.map((accessor, index) => {
        const size = components[String(accessor.type)], width = widths[String(accessor.componentType)];
        if (!size || !width) throw new InvalidMesh();
        const bytes = counts[index]! * size * width;
        if (!Number.isSafeInteger(bytes)) throw new InvalidMesh();
        return bytes;
    });
    const accessor = (index: unknown): number => {
        const i = uint(index); if (i >= accessors.length) throw new InvalidMesh(); return i;
    };
    views.forEach(view => {
        const buffer = buffers[uint(view.buffer)], offset = uint(view.byteOffset ?? 0), length = uint(view.byteLength);
        if (!buffer || offset + length > uint(buffer.byteLength)) throw new InvalidMesh();
        charge(length); // GLTFLoader copies each bufferView, including overlapping views.
        const meshopt = view.extensions && object(view.extensions).EXT_meshopt_compression;
        if (meshopt !== undefined) {
            const extension = object(meshopt), count = uint(extension.count), stride = uint(extension.byteStride);
            if (!count || !stride || count * stride !== length) throw new InvalidMesh();
            const source = buffers[uint(extension.buffer)];
            if (!source || uint(extension.byteOffset ?? 0) + uint(extension.byteLength) > uint(source.byteLength)) throw new InvalidMesh();
        }
    });
    accessors.forEach((a, i) => {
        if (a.bufferView === undefined) charge(sizes[i]!);
        else if (uint(a.bufferView) >= views.length) throw new InvalidMesh();
        if (a.sparse !== undefined) {
            const sparse = object(a.sparse);
            if (uint(sparse.count) > counts[i]!) throw new InvalidMesh();
            for (const key of ['indices', 'values']) if (uint(object(sparse[key]).bufferView) >= views.length) throw new InvalidMesh();
            if (a.bufferView !== undefined) charge(sizes[i]!); // Sparse decoding clones the base accessor.
        }
    });
    const meshCounts = meshes.map(mesh => {
        let vertices = 0, triangles = 0;
        array(mesh.primitives).forEach(value => {
            const primitive = object(value), attrs = object(primitive.attributes);
            if (attrs.POSITION === undefined) return;
            const position = accessor(attrs.POSITION), count = counts[position]!;
            if (accessors[position]!.type !== 'VEC3') throw new InvalidMesh();
            Object.values(attrs).forEach(value => { if (counts[accessor(value)] !== count) throw new InvalidMesh(); });
            const targets = array(primitive.targets).map(object);
            targets.forEach(value => Object.entries(value).forEach(([semantic, value]) => {
                const index = accessor(value);
                if (!['POSITION', 'NORMAL', 'TANGENT'].includes(semantic) || accessors[index]!.type !== 'VEC3' || counts[index] !== count) throw new InvalidMesh();
            }));
            const morphSlots = targets.some(t => t.NORMAL !== undefined) ? 2 : targets.some(t => t.POSITION !== undefined) ? 1 : 0;
            if (morphSlots === 2 && !targets.some(t => t.POSITION !== undefined)) charge(count * 12);
            // WebGL packs repeated morph references into separate RGBA layers.
            // Reserving twice the logical size bounds row padding independently
            // of the host GPU's maximum texture width.
            charge(count * morphSlots * targets.length * 16 * 2);
            const indices = primitive.indices === undefined ? undefined : accessor(primitive.indices);
            if (indices !== undefined && (accessors[indices]!.type !== 'SCALAR' || ![5121, 5123, 5125].includes(Number(accessors[indices]!.componentType)))) throw new InvalidMesh();
            const elements = indices === undefined ? count : counts[indices]!, mode = primitive.mode ?? 4;
            vertices += count;
            triangles += mode === 4 ? Math.floor(elements / 3) : mode === 5 || mode === 6 ? Math.max(0, elements - 2) : 0;
        });
        return { vertices, triangles };
    });
    const nodeIndex = (value: unknown): number => {
        const index = uint(value); if (index >= nodes.length) throw new InvalidMesh(); return index;
    };
    skins.forEach(skin => {
        const joints = array(skin.joints);
        if (!joints.length || new Set(joints.map(nodeIndex)).size !== joints.length) throw new InvalidMesh();
        if (skin.skeleton !== undefined) nodeIndex(skin.skeleton);
        if (skin.inverseBindMatrices !== undefined) {
            const index = accessor(skin.inverseBindMatrices), bind = accessors[index]!;
            if (bind.type !== 'MAT4' || bind.componentType !== 5126 || counts[index]! < joints.length) throw new InvalidMesh();
        }
        // Skeleton stores boneMatrices and inverse matrices; WebGL additionally
        // pads boneMatrices to an RGBA texture whose side is a multiple of four.
        const side = Math.max(4, Math.ceil(Math.sqrt(joints.length * 4) / 4) * 4);
        charge(joints.length * 64 + side * side * 16);
    });
    let vertices = 0, triangles = 0;
    nodes.forEach(node => {
        if (node.skin !== undefined && uint(node.skin) >= skins.length) throw new InvalidMesh();
        if (node.mesh === undefined) return;
        const meshIndex = uint(node.mesh), mesh = meshCounts[meshIndex]; if (!mesh) throw new InvalidMesh();
        let instances = 1;
        const instancing = node.extensions && object(node.extensions).EXT_mesh_gpu_instancing;
        if (instancing !== undefined) {
            const attrs = Object.entries(object(object(instancing).attributes));
            if (!attrs.length) throw new InvalidMesh();
            instances = counts[accessor(attrs[0]![1])]!;
            attrs.forEach(([semantic, value]) => {
                const index = accessor(value), type = semantic === 'ROTATION' ? 'VEC4' : 'VEC3';
                if (counts[index] !== instances || (['TRANSLATION', 'ROTATION', 'SCALE'].includes(semantic) && accessors[index]!.type !== type)) throw new InvalidMesh();
            });
            charge(instances * 64 * array(meshes[meshIndex]!.primitives).length);
        }
        vertices += mesh.vertices * instances; triangles += mesh.triangles * instances;
        if (vertices > maxVertices || triangles > maxTriangles) throw new MeshLimit();
    });
    array(manifest.animations).forEach(value => {
        const animation = object(value), samplers = array(animation.samplers).map(object);
        array(animation.channels).forEach(value => {
            const channel = object(value), sampler = samplers[uint(channel.sampler)], target = object(channel.target);
            if (!sampler) throw new InvalidMesh();
            if (target.node === undefined) return; // Extension-only targets are not decoded by the standard loader.
            const node = nodes[nodeIndex(target.node)]!, input = accessor(sampler.input), output = accessor(sampler.output);
            const inputDef = accessors[input]!, outputDef = accessors[output]!;
            if (inputDef.type !== 'SCALAR' || inputDef.componentType !== 5126 || inputDef.normalized) throw new InvalidMesh();
            const interpolation = sampler.interpolation ?? 'LINEAR';
            if (!['LINEAR', 'STEP', 'CUBICSPLINE'].includes(String(interpolation))) throw new InvalidMesh();
            const factor = interpolation === 'CUBICSPLINE' ? 3 : 1;
            let tracks = 1, weights = 1;
            if (target.path === 'weights') {
                if (node.mesh === undefined) throw new InvalidMesh();
                const primitives = array(meshes[uint(node.mesh)]!.primitives).map(object);
                weights = array(primitives[0]?.targets).length;
                if (!weights || primitives.some(p => array(p.targets).length !== weights)) throw new InvalidMesh();
                tracks = primitives.length;
            }
            const type = target.path === 'rotation' ? 'VEC4' : target.path === 'translation' || target.path === 'scale' ? 'VEC3' : target.path === 'weights' ? 'SCALAR' : undefined;
            if (!type || outputDef.type !== type || counts[output] !== counts[input]! * factor * weights) throw new InvalidMesh();
            // Animations must be tightly packed. Interleaved attributes expose
            // a larger backing array than their logical accessor count.
            for (const index of [input, output]) {
                const a = accessors[index]!;
                const view = a.bufferView === undefined ? undefined : views[uint(a.bufferView)];
                if (view?.byteStride !== undefined && uint(view.byteStride) !== components[String(a.type)]! * widths[String(a.componentType)]!) throw new InvalidMesh();
            }
            // Normalized outputs become Float32 per channel. Other integer
            // outputs are converted per generated KeyframeTrack instead.
            if (outputDef.normalized || outputDef.componentType !== 5126) {
                charge(counts[output]! * components[String(outputDef.type)]! * 4 * (outputDef.normalized ? 1 : tracks));
            }
        });
    });
}
