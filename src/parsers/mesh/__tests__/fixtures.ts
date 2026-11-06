export const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
export const obj = '# triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
export const stl = 'solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle\n';
export const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
export function manifest(uri?: string) {
    return {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        buffers: [{ byteLength: positions.byteLength, ...(uri ? { uri } : {}) }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }]
    };
}
export function embeddedGltf(): Uint8Array {
    const encoded = btoa(String.fromCharCode(...new Uint8Array(positions.buffer)));
    return bytes(JSON.stringify(manifest(`data:application/octet-stream;base64,${encoded}`)));
}
export function binaryStl(): Uint8Array {
    const data = new Uint8Array(134), view = new DataView(data.buffer);
    data.set(bytes('solid binary STL')); view.setUint32(80, 1, true); view.setFloat32(92, 1, true);
    positions.forEach((n, i) => view.setFloat32(96 + i * 4, n, true));
    return data;
}
export function binaryGlb(json: unknown = manifest(), binary: Uint8Array = new Uint8Array(positions.buffer)): Uint8Array {
    const source = bytes(JSON.stringify(json));
    const padded = new Uint8Array(Math.ceil(source.length / 4) * 4); padded.fill(32); padded.set(source);
    const data = new Uint8Array(28 + padded.length + binary.length), view = new DataView(data.buffer);
    data.set([0x67, 0x6c, 0x54, 0x46]); view.setUint32(4, 2, true); view.setUint32(8, data.length, true);
    view.setUint32(12, padded.length, true); view.setUint32(16, 0x4e4f534a, true); data.set(padded, 20);
    view.setUint32(20 + padded.length, binary.length, true); view.setUint32(24 + padded.length, 0x004e4942, true); data.set(binary, 28 + padded.length);
    return data;
}
