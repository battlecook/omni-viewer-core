import { parseJson } from '../json/index.js';
import { decodeUtf8, LimitTracker, type Diagnostic, type ParseOptions, type ParseOutcome, type ParseResult } from '../types.js';
import { InvalidMesh, MeshLimit, validateGltfAllocations } from './validation.js';

export type MeshFormat = 'glb' | 'gltf' | 'stl' | 'obj';
export interface MeshResource { uri: string; kind: 'buffer' | 'image' }
export interface MeshDocument {
    format: MeshFormat;
    /** Borrowed bytes; callers must retain them until scene loading finishes. */
    data: Uint8Array;
    /** UTF-8 source for text formats, JSON chunk for GLB. */
    text: string;
    resources: MeshResource[];
    vertexCount: number;
    triangleCount: number;
    /** Selected glTF scene roots, retained to repair shared-root reparenting in Three.js. */
    sceneRoots?: number[];
}
export interface MeshParseOptions extends ParseOptions {
    fileName: string;
    maxVertices?: number;
    maxTriangles?: number;
}
export const MESH_INPUT_OWNERSHIP = 'borrows' as const;

/** Only document-relative resources; decoding is checked to prevent encoded traversal. */
export function isMeshRelativePath(path: string): boolean {
    try {
        const decoded = decodeURIComponent(path);
        return !!decoded && decoded === decoded.trim() && !/[\\\u0000-\u001f\u007f:?#%]/.test(decoded)
            && !decoded.startsWith('/') && !decoded.split('/').some(part => part === '..');
    } catch { return false; }
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidMesh();
    return value as RecordValue;
};
const list = (value: unknown): unknown[] => { if (value === undefined) return []; if (!Array.isArray(value)) throw new InvalidMesh(); return value; };
const integer = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new InvalidMesh(); return Number(value); };
const finite = (value: string): number => { const n = Number(value); if (!value || !Number.isFinite(n) || Math.abs(n) > 3.4e38) throw new InvalidMesh(); return n; };

/** DOM-free preflight. Scene decoding belongs to the viewer's injected loader. */
export function parseMesh(data: Uint8Array, options: MeshParseOptions): ParseOutcome<MeshDocument> {
    const started = Date.now(), diagnostics: Diagnostic[] = [];
    const finish = (result: ParseResult<MeshDocument>): ParseOutcome<MeshDocument> => ({ result,
        execution: { workerUsed: false, hardLimitEnforced: false, elapsedMillis: Date.now() - started } });
    const fail = (code: 'invalid-format' | 'corrupted' | 'limit-exceeded' | 'aborted', messageKey: string) =>
        finish({ status: 'failed', failure: { code, retryable: false, messageKey }, diagnostics });
    if (options.signal?.aborted) return fail('aborted', 'diag.aborted');
    const limits = { maxInputBytes: 128 * 1024 * 1024, maxEntries: 100_000, maxParseMillis: 30_000,
        maxDecompressedBytes: 256 * 1024 * 1024, ...options.limits };
    if (data.byteLength > limits.maxInputBytes) return fail('limit-exceeded', 'diag.mesh.limit');
    const tracker = new LimitTracker(limits, options.signal);
    const checkpoint = (): void => { const violation = tracker.checkpoint(); if (violation) throw new MeshLimit(); };
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const glb = data.length >= 4 && view.getUint32(0, true) === 0x46546c67;
    const ext = options.fileName.split('.').pop()?.toLowerCase();
    const format = glb ? 'glb' : ext;
    if (!['glb', 'gltf', 'stl', 'obj'].includes(format ?? '')) return fail('invalid-format', 'diag.mesh.invalid');
    const model: MeshDocument = { format: format as MeshFormat, data, text: '', resources: [], vertexCount: 0, triangleCount: 0 };
    const budget = (): void => {
        if (model.vertexCount > (options.maxVertices ?? 2_000_000) || model.triangleCount > (options.maxTriangles ?? 2_000_000)) throw new MeshLimit();
        checkpoint();
    };
    try {
        if (format === 'glb' || format === 'gltf') {
            let binBytes = 0;
            if (format === 'glb') {
                if (!glb || data.length < 20 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== data.length) throw new InvalidMesh();
                let offset = 12, chunk = 0, seenBin = false;
                while (offset < data.length) {
                    checkpoint();
                    if (offset + 8 > data.length) throw new InvalidMesh();
                    const size = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
                    offset += 8;
                    if (size % 4 || offset + size > data.length || (!chunk && type !== 0x4e4f534a)) throw new InvalidMesh();
                    if (type === 0x4e4f534a) {
                        if (chunk) throw new InvalidMesh();
                        model.text = decodeUtf8(data.subarray(offset, offset + size)).trimEnd();
                    } else if (type === 0x004e4942) {
                        if (seenBin || chunk !== 1) throw new InvalidMesh();
                        seenBin = true; binBytes = size;
                    }
                    chunk++; offset += size;
                }
            } else model.text = decodeUtf8(data);
            const json = parseJson(model.text, { ...options, maxDepth: 64,
                limits: { ...limits, maxEntries: limits.maxEntries * 16 } }).result;
            if (json.status !== 'ok') {
                if (json.status === 'failed' && json.failure.code === 'aborted') return fail('aborted', 'diag.aborted');
                if (json.diagnostics.some(d => d.code.includes('limit') || d.code.includes('max-depth'))) throw new MeshLimit();
                throw new InvalidMesh();
            }
            const manifest = record(JSON.parse(model.text.replace(/^\uFEFF/, '')));
            if (record(manifest.asset).version !== '2.0') throw new InvalidMesh();
            const buffers = list(manifest.buffers), images = list(manifest.images), accessors = list(manifest.accessors);
            const meshes = list(manifest.meshes), nodes = list(manifest.nodes), scenes = list(manifest.scenes);
            tracker.addEntries(buffers.length + images.length + accessors.length + meshes.length + nodes.length + scenes.length);
            tracker.addEntries(list(manifest.bufferViews).length);
            list(manifest.skins).forEach(value => tracker.addEntries(1 + list(record(value).joints).length));
            list(manifest.animations).forEach(value => {
                const animation = record(value); tracker.addEntries(1 + list(animation.samplers).length + list(animation.channels).length);
            });
            checkpoint();
            const resource = (value: unknown, kind: MeshResource['kind']): number | undefined => {
                if (typeof value !== 'string') throw new InvalidMesh();
                if (value.startsWith('data:')) {
                    if (!/^data:(?:application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg|webp|ktx2|avif));base64,[a-zA-Z0-9+/]*={0,2}$/.test(value)) throw new InvalidMesh();
                    const encoded = value.slice(value.indexOf(',') + 1);
                    if (encoded.length % 4) throw new InvalidMesh();
                    return encoded.length * 3 / 4 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
                } else {
                    if (!isMeshRelativePath(value)) throw new InvalidMesh();
                    if (!model.resources.some(r => r.uri === value)) model.resources.push({ uri: value, kind });
                }
            };
            buffers.forEach((value, i) => {
                const buffer = record(value), bytes = integer(buffer.byteLength);
                if (buffer.uri !== undefined) {
                    const actual = resource(buffer.uri, 'buffer');
                    if (actual !== undefined && actual !== bytes) throw new InvalidMesh();
                }
                else if (format !== 'glb' || i !== 0 || bytes > binBytes || binBytes - bytes > 3) {
                    // Required Meshopt may point uncompressed views at a URI-less
                    // placeholder. It must never be used as an actual data source.
                    if (!list(manifest.extensionsRequired).includes('EXT_meshopt_compression') || (format === 'glb' && i === 0)) throw new InvalidMesh();
                    for (const value of list(manifest.bufferViews)) {
                        const view = record(value), extension = view.extensions && record(view.extensions).EXT_meshopt_compression;
                        if (view.buffer === i && !extension) throw new InvalidMesh();
                        if (extension && record(extension).buffer === i) throw new InvalidMesh();
                    }
                }
                tracker.addDecompressedBytes(bytes); checkpoint();
            });
            images.forEach(value => {
                const image = record(value);
                if (image.uri !== undefined) tracker.addDecompressedBytes(resource(image.uri, 'image') ?? 0);
                checkpoint();
            });
            const accessorCount = (index: unknown): number => {
                const accessor = record(accessors[integer(index)]);
                const count = integer(accessor.count);
                if (count > Math.max(options.maxVertices ?? 2_000_000, (options.maxTriangles ?? 2_000_000) * 3)) throw new MeshLimit();
                return count;
            };
            accessors.forEach((_, i) => { accessorCount(i); });
            validateGltfAllocations(manifest, options);
            meshes.forEach(value => list(record(value).primitives).forEach(value => {
                const primitive = record(value), position = record(primitive.attributes).POSITION;
                tracker.addEntries(1);
                if (position === undefined) return;
                const vertices = accessorCount(position), count = primitive.indices === undefined ? vertices : accessorCount(primitive.indices);
                const mode = primitive.mode ?? 4;
                model.vertexCount += vertices;
                model.triangleCount += mode === 4 ? Math.floor(count / 3) : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0;
                budget();
            }));
            // Reject cycles/deep graphs before GLTFLoader recursively builds the scene.
            const state = new Uint8Array(nodes.length), heights = new Uint8Array(nodes.length), parents = new Uint32Array(nodes.length);
            nodes.forEach(value => list(record(value).children).forEach(child => {
                const index = integer(child);
                if (index >= nodes.length || ++parents[index]! > 1) throw new InvalidMesh();
                tracker.addEntries(1); checkpoint();
            }));
            const visit = (index: unknown, depth: number): void => {
                const i = integer(index);
                if (i >= nodes.length || depth > 64 || state[i] === 1) throw new InvalidMesh();
                if (state[i] === 2) return;
                state[i] = 1;
                const node = record(nodes[i]);
                if (node.mesh !== undefined && integer(node.mesh) >= meshes.length) throw new InvalidMesh();
                for (const [key, size] of [['matrix', 16], ['translation', 3], ['rotation', 4], ['scale', 3]] as const) {
                    if (node[key] !== undefined && (!Array.isArray(node[key]) || node[key].length !== size || node[key].some(v => typeof v !== 'number' || !Number.isFinite(v)))) throw new InvalidMesh();
                }
                let height = 0;
                list(node.children).forEach(child => { visit(child, depth + 1); height = Math.max(height, heights[Number(child)]! + 1); });
                if (height > 64) throw new InvalidMesh();
                heights[i] = height; state[i] = 2;
            };
            nodes.forEach((_, i) => visit(i, 0));
            scenes.forEach(scene => list(record(scene).nodes).forEach(index => { if (integer(index) >= nodes.length) throw new InvalidMesh(); }));
            if (manifest.scene !== undefined && integer(manifest.scene) >= scenes.length) throw new InvalidMesh();
            if (scenes.length) model.sceneRoots = list(record(scenes[integer(manifest.scene ?? 0)]).nodes).map(integer);
        } else if (format === 'stl') {
            const count = data.length >= 84 ? view.getUint32(80, true) : 0;
            const binary = data.length >= 84 && (84 + count * 50 === data.length || data.subarray(0, 84).includes(0));
            if (binary) {
                if (!count || 84 + count * 50 !== data.length) throw new InvalidMesh();
                model.triangleCount = count; model.vertexCount = count * 3; budget();
                for (let i = 0; i < count; i++) {
                    if (i % 1024 === 0) checkpoint();
                    for (let f = 0; f < 12; f++) if (!Number.isFinite(view.getFloat32(84 + i * 50 + f * 4, true))) throw new InvalidMesh();
                }
            } else {
                model.text = decodeUtf8(data);
                let inFacet = false, vertices = 0;
                for (const line of model.text.split(/\r?\n/)) {
                    checkpoint();
                    const words = line.trim().split(/\s+/);
                    if (words[0] === 'facet') {
                        if (inFacet || words[1] !== 'normal' || words.length !== 5) throw new InvalidMesh();
                        words.slice(2).forEach(finite); inFacet = true; vertices = 0;
                    }
                    if (words[0] === 'vertex') {
                        if (!inFacet || words.length !== 4) throw new InvalidMesh();
                        words.slice(1).forEach(finite); vertices++; model.vertexCount++; budget();
                    }
                    if (words[0] === 'endfacet') {
                        if (!inFacet || vertices !== 3) throw new InvalidMesh();
                        inFacet = false; model.triangleCount++; budget();
                    }
                }
                if (inFacet || !model.triangleCount || !/^\s*solid\b/.test(model.text) || !/\bendsolid\b/.test(model.text)) throw new InvalidMesh();
            }
        } else {
            model.text = decodeUtf8(data).replace(/\\\r?\n/g, '').replace(/#[^\r\n]*/g, '');
            let omittedPrimitives = false;
            model.text = model.text.split(/\r?\n/).filter(line => {
                if (/^\s*[lp](?:\s|$)/.test(line)) { omittedPrimitives = true; return false; }
                return true;
            }).join('\n');
            let texcoords = 0, normals = 0, maxPosition = 0, maxUv = 0, maxNormal = 0, hasMtl = false;
            for (const line of model.text.split(/\r?\n/)) {
                checkpoint();
                const words = line.replace(/#.*/, '').trim().split(/\s+/), kind = words.shift();
                if (kind === 'v' || kind === 'vn' || kind === 'vt') {
                    if (words.length < (kind === 'vt' ? 1 : 3)) throw new InvalidMesh();
                    words.forEach(finite);
                    if (kind === 'v') model.vertexCount++; else if (kind === 'vt') texcoords++; else normals++;
                    if (texcoords + normals > (options.maxVertices ?? 2_000_000) * 2) throw new MeshLimit();
                    budget();
                } else if (kind === 'f') {
                    if (words.length < 3) throw new InvalidMesh();
                    for (const token of words) {
                        const indices = token.split('/');
                        if (indices.length > 3 || !indices[0]) throw new InvalidMesh();
                        indices.forEach((part, axis) => {
                            if (!part && axis > 0) return;
                            if (!/^-?\d+$/.test(part)) throw new InvalidMesh();
                            const index = Number(part), count = [model.vertexCount, texcoords, normals][axis]!;
                            if (!Number.isSafeInteger(index) || index === 0 || Math.abs(index) > count) throw new InvalidMesh();
                            if (axis === 0) maxPosition = Math.max(maxPosition, index);
                            else if (axis === 1) maxUv = Math.max(maxUv, index); else maxNormal = Math.max(maxNormal, index);
                        });
                    }
                    model.triangleCount += words.length - 2;
                    // OBJLoader expands indexed polygons into non-indexed triangles.
                    if (model.triangleCount * 3 > (options.maxVertices ?? 2_000_000)) throw new MeshLimit();
                    budget();
                } else if (kind === 'o' || kind === 'g' || kind === 'usemtl') {
                    tracker.addEntries(1); checkpoint();
                    if (kind === 'usemtl') hasMtl = true;
                } else if (kind === 'mtllib') hasMtl = true;
            }
            if (!model.triangleCount || maxPosition > model.vertexCount || maxUv > texcoords || maxNormal > normals) throw new InvalidMesh();
            if (hasMtl) diagnostics.push({ severity: 'warning', code: 'mesh.obj-materials', messageKey: 'diag.mesh.objMaterials' });
            if (omittedPrimitives) diagnostics.push({ severity: 'warning', code: 'mesh.obj-primitives', messageKey: 'diag.mesh.objPrimitives' });
        }
        budget();
        if (!model.vertexCount) throw new InvalidMesh();
        return finish({ status: diagnostics.length ? 'partial' : 'ok', document: model, diagnostics });
    } catch (error) {
        if (options.signal?.aborted) return fail('aborted', 'diag.aborted');
        if (error instanceof MeshLimit) return fail('limit-exceeded', 'diag.mesh.limit');
        if (error instanceof InvalidMesh || error instanceof SyntaxError || error instanceof RangeError) return fail('corrupted', 'diag.mesh.corrupted');
        throw error;
    }
}
