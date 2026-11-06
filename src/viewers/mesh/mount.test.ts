// @vitest-environment jsdom
import * as THREE from 'three';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { binaryGlb, binaryStl, bytes, embeddedGltf, manifest, obj, positions, stl } from '../../parsers/mesh/__tests__/fixtures.js';
import { MountAbortedError, type ViewerHandle } from '../types.js';
import { disposeMeshObjects, mountMeshViewer, type MeshRenderer, type MeshViewerDeps, type MeshMountOptions, type MeshViewerContext } from './index.js';
import { loadMeshViewerDeps } from './self-loading.js';

const ctx: MeshViewerContext = { assets: { resolveAssetUrl: vi.fn() }, i18n: createCatalogI18n(), logger: { log: vi.fn() } };
let deps: MeshViewerDeps, renderer: MeshRenderer, scene: THREE.Scene, camera: THREE.Camera;
const handles: ViewerHandle[] = [];
beforeEach(async () => {
    deps = await loadMeshViewerDeps();
    renderer = { domElement: document.createElement('canvas'), setSize: vi.fn(), setPixelRatio: vi.fn(), dispose: vi.fn(), forceContextLoss: vi.fn(),
        render: vi.fn((s, c) => { scene = s; camera = c; }) };
    deps.createRenderer = () => renderer;
});
afterEach(() => { handles.splice(0).forEach(h => h.dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount(fileName = 'triangle.obj', data = bytes(obj), options: MeshMountOptions = {}, context = ctx) {
    const container = document.createElement('div'); document.body.append(container);
    const handle = await mountMeshViewer({ fileName, data }, container, context, deps, options); handles.push(handle);
    return { container, root: container.shadowRoot ?? container, handle };
}
function firstMesh(): THREE.Mesh {
    let mesh: THREE.Mesh | undefined; scene.traverse(n => { if ((n as THREE.Mesh).isMesh) mesh ??= n as THREE.Mesh; });
    return mesh!;
}
function embeddedImageGlb(): Uint8Array {
    const json = { ...manifest(), buffers: [{ byteLength: 40 }],
        bufferViews: [...manifest().bufferViews, { buffer: 0, byteOffset: 36, byteLength: 4 }],
        images: [{ bufferView: 1, mimeType: 'image/png' }], textures: [{ source: 0 }],
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }] };
    const bin = new Uint8Array(40); bin.set(new Uint8Array(positions.buffer)); bin.set([137, 80, 78, 71], 36);
    return binaryGlb(json, bin);
}
describe('mesh viewer with real Three.js loaders and controls', () => {
    it('decodes OBJ faces with inline comments using the same normalized source as preflight', async () => {
        const source = obj.replace('f 1 2 3', 'f 1 2 3 # face comment');
        await mount('comments.obj', bytes(source));
        const position = firstMesh().geometry.getAttribute('position');
        expect(position.count).toBe(3);
        for (let i = 0; i < position.count; i++) expect([position.getX(i), position.getY(i), position.getZ(i)].every(Number.isFinite)).toBe(true);
    });
    it('omits OBJ line/point primitives with a warning without allocating their geometry', async () => {
        const source = obj + '\ng lines\nl ' + Array.from({ length: 1000 }, (_, i) => i % 3 + 1).join(' ') + '\ng points\np 1 2 3';
        const { root } = await mount('mixed.obj', bytes(source), { maxVertices: 3 });
        let extra = 0; scene.traverse(n => { if ((n as THREE.Line).isLine || (n as THREE.Points).isPoints) extra++; });
        // The only retained lines are the viewer's grid and axes helpers.
        expect(extra).toBe(2); expect(firstMesh().geometry.getAttribute('position').count).toBe(3);
        expect(root.querySelector('.omni-mesh__warnings')?.textContent).toContain('omitted');
    });
    it('decodes required Meshopt with a URI-less fallback placeholder using host-provided decoder', async () => {
        await MeshoptEncoder.ready; await MeshoptDecoder.ready;
        const encoded = MeshoptEncoder.encodeGltfBuffer(new Uint8Array(positions.buffer), 3, 12, 'ATTRIBUTES');
        const json = { ...manifest(), extensionsUsed: ['EXT_meshopt_compression'], extensionsRequired: ['EXT_meshopt_compression'],
            buffers: [{ byteLength: encoded.length, uri: 'data:application/octet-stream;base64,' + btoa(String.fromCharCode(...encoded)) },
                { byteLength: 36, extensions: { EXT_meshopt_compression: { fallback: true } } }],
            bufferViews: [{ buffer: 1, byteLength: 36, extensions: { EXT_meshopt_compression: {
                buffer: 0, byteOffset: 0, byteLength: encoded.length, byteStride: 12, count: 3, mode: 'ATTRIBUTES'
            } } }] };
        deps.configureGltfLoader = loader => loader.setMeshoptDecoder(MeshoptDecoder);
        await mount('compressed.gltf', bytes(JSON.stringify(json)));
        const position = firstMesh().geometry.getAttribute('position'); expect(position.count).toBe(3); expect(position.getX(1)).toBe(1);
    });
    it.each([0, 1])('preserves selected scene %s when glTF scenes share root nodes', async selected => {
        const json = { ...manifest(), scene: selected, scenes: [{ nodes: [0] }, { nodes: [0] }] };
        await mount('shared-scenes.glb', binaryGlb(json));
        expect(firstMesh().geometry.getAttribute('position').count).toBe(3);
    });
    it('renders normal-only morphs using shared zero position displacements', async () => {
        const { WebGLMorphtargets } = await import('three/src/renderers/webgl/WebGLMorphtargets.js' as string);
        const json = { ...manifest(), accessors: [...manifest().accessors, { componentType: 5126, count: 3, type: 'VEC3' }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, targets: [{ NORMAL: 1 }] }] }] };
        await mount('normal-morph.glb', binaryGlb(json));
        const mesh = firstMesh(), zero = mesh.geometry.morphAttributes.position![0]!;
        expect([...zero.array]).toEqual(Array(9).fill(0));
        const morphs = new WebGLMorphtargets({} as WebGLRenderingContext, { maxTextureSize: 4096 } as never, {} as never);
        expect(() => morphs.update(mesh, mesh.geometry, { getUniforms: () => ({ setValue() {} }) } as never)).not.toThrow();
    });
    it.each([['triangle.obj', bytes(obj)], ['triangle.stl', bytes(stl)], ['binary.stl', binaryStl()],
        ['triangle.gltf', embeddedGltf()], ['triangle.glb', binaryGlb()]])('decodes %s into real geometry', async (name, data) => {
        const { root } = await mount(name, data);
        expect(root.querySelector('canvas')).not.toBeNull(); expect(root.querySelector('style')?.textContent).toContain('.omni-mesh');
        expect(root.querySelector('h2')?.textContent).toBe(name); expect(root.querySelector('.omni-mesh__summary')?.textContent).toContain('1 triangles');
        expect(firstMesh().geometry.getAttribute('position').count).toBe(3);
        expect(camera.position.length()).toBeGreaterThan(1); expect(renderer.render).toHaveBeenCalled();
    });
    it('toggles wireframe, grid, axes, zoom, fit, and keyboard orbit', async () => {
        const { root } = await mount(); const material = firstMesh().material as THREE.MeshPhongMaterial;
        const button = (name: string) => root.querySelector<HTMLButtonElement>(`.omni-mesh__${name}`)!;
        button('wireframe').click(); expect(material.wireframe).toBe(true); expect(button('wireframe').getAttribute('aria-pressed')).toBe('true');
        button('wireframe').click(); expect(material.wireframe).toBe(false);
        button('grid').click(); expect(button('grid').getAttribute('aria-pressed')).toBe('false');
        button('axes').click(); expect(button('axes').getAttribute('aria-pressed')).toBe('true');
        const initial = camera.position.clone(); button('zoomIn').click(); expect(camera.position.length()).toBeLessThan(initial.length());
        button('zoomOut').click(); expect(camera.position.length()).toBeCloseTo(initial.length());
        root.querySelector('canvas')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }));
        expect(camera.position.equals(initial)).toBe(false);
        root.querySelector('canvas')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' })); expect(camera.position.distanceTo(initial)).toBeLessThan(1e-8);
        button('zoomIn').click(); button('fit').click(); expect(camera.position.distanceTo(initial)).toBeLessThan(1e-8);
    });
    it('reads external glTF buffers only through the host and releases assets', async () => {
        const release = vi.fn(), resolve = vi.fn(async () => ({ url: 'data:application/octet-stream;base64,' + btoa(String.fromCharCode(...new Uint8Array(positions.buffer))), dispose: release }));
        const { handle } = await mount('external.gltf', bytes(JSON.stringify(manifest('triangle.bin'))), {}, { ...ctx, documentAssets: { resolve } });
        expect(resolve).toHaveBeenCalledWith('triangle.bin'); expect(firstMesh().geometry.getAttribute('position').count).toBe(3);
        handle.dispose(); handle.dispose(); expect(release).toHaveBeenCalledOnce();
    });
    it('shows safe filenames, warnings, scoped mode, and localized errors', async () => {
        const { root } = await mount('<img src=x>.obj', bytes('mtllib model.mtl\n' + obj), { styleIsolation: 'scoped' });
        expect(root.querySelector('h2')?.textContent).toBe('<img src=x>.obj'); expect(root.querySelector('img')).toBeNull();
        expect(root.querySelector('style')).toBeNull(); expect(root.querySelector('.omni-mesh__warnings')?.textContent).toContain('default materials');
        const container = document.createElement('div');
        await expect(mountMeshViewer({ fileName: 'external.gltf', data: bytes(JSON.stringify(manifest('missing.bin'))) }, container, ctx, deps)).rejects.toThrow('missing.bin');
        expect(container.innerHTML).toBe('');
    });
    it('disposes GPU resources, controls, resize events and DOM exactly once', async () => {
        const { root, handle } = await mount(); const mesh = firstMesh();
        const disposeGeometry = vi.spyOn(mesh.geometry, 'dispose'), disposeMaterial = vi.spyOn(mesh.material as THREE.Material, 'dispose');
        const disposeControls = vi.spyOn(deps.OrbitControls.prototype, 'dispose');
        handle.dispose(); handle.dispose();
        expect(disposeGeometry).toHaveBeenCalledOnce(); expect(disposeMaterial).toHaveBeenCalledOnce();
        expect(disposeControls).toHaveBeenCalledOnce(); expect(renderer.dispose).toHaveBeenCalledOnce(); expect(renderer.forceContextLoss).toHaveBeenCalledOnce(); expect(root.childNodes).toHaveLength(0);
        const calls = vi.mocked(renderer.render).mock.calls.length; window.dispatchEvent(new Event('resize'));
        expect(renderer.render).toHaveBeenCalledTimes(calls);
    });
    it('releases shared textures and bitmaps once across glTF scenes', () => {
        const close = vi.fn(), texture = new THREE.Texture({ close } as unknown as HTMLImageElement);
        const material = new THREE.MeshStandardMaterial({ map: texture }), geometry = new THREE.BoxGeometry();
        const a = new THREE.Group(), b = new THREE.Group(); a.add(new THREE.Mesh(geometry, material)); b.add(new THREE.Mesh(geometry, material));
        const textureDispose = vi.spyOn(texture, 'dispose'), geometryDispose = vi.spyOn(geometry, 'dispose'), materialDispose = vi.spyOn(material, 'dispose');
        disposeMeshObjects([a, b]); expect(close).toHaveBeenCalledOnce(); expect(textureDispose).toHaveBeenCalledOnce();
        expect(geometryDispose).toHaveBeenCalledOnce(); expect(materialDispose).toHaveBeenCalledOnce();
    });
    it('releases embedded image object URLs after a real texture decoder failure', async () => {
        const create = vi.fn(() => 'blob:omni-failed-image'), revoke = vi.fn();
        vi.stubGlobal('URL', class extends URL { static override createObjectURL = create; static override revokeObjectURL = revoke; });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]))));
        vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('invalid PNG'); }));
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { handle, root } = await mount('image.glb', embeddedImageGlb());
        expect(root.querySelector('.omni-mesh__warnings')?.textContent).toContain('textures could not be loaded');
        handle.dispose(); expect(create).toHaveBeenCalledOnce(); expect(revoke).toHaveBeenCalledWith('blob:omni-failed-image');
        error.mockRestore();
    });
    it('releases pending embedded image URLs immediately on cancellation and closes a late bitmap', async () => {
        const create = vi.fn(() => 'blob:omni-pending-image'), revoke = vi.fn(), close = vi.fn();
        let finish: (image: unknown) => void = () => undefined;
        vi.stubGlobal('URL', class extends URL { static override createObjectURL = create; static override revokeObjectURL = revoke; });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]))));
        const bitmap = vi.fn(() => new Promise(resolve => { finish = resolve; })); vi.stubGlobal('createImageBitmap', bitmap);
        const controller = new AbortController(), container = document.createElement('div');
        const pending = mountMeshViewer({ fileName: 'pending.glb', data: embeddedImageGlb() }, container, ctx, deps, { signal: controller.signal });
        await vi.waitFor(() => expect(bitmap).toHaveBeenCalledOnce());
        controller.abort(); await expect(pending).rejects.toBeInstanceOf(MountAbortedError);
        expect(revoke).toHaveBeenCalledWith('blob:omni-pending-image');
        finish({ width: 1, height: 1, close }); await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    });
    it.each([false, true])('closes decoded textures when geometry rejects (image completes late: %s)', async late => {
        const close = vi.fn(), image = { width: 1, height: 1, close }, releaseAsset = vi.fn();
        let failGeometry: (reason: Error) => void = () => undefined, finishImage: (value: unknown) => void = () => undefined;
        vi.stubGlobal('fetch', vi.fn((url: string) => url === 'blob:failed-geometry'
            ? new Promise<Response>((_, reject) => { failGeometry = reject; })
            : Promise.resolve(new Response(new Uint8Array([137, 80, 78, 71])))));
        const decode = vi.fn(() => late ? new Promise(resolve => { finishImage = resolve; }) : Promise.resolve(image));
        vi.stubGlobal('createImageBitmap', decode);
        const json = { ...manifest('geometry.bin'), images: [{ uri: 'data:image/png;base64,iVBORw==' }], textures: [{ source: 0 }],
            materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }] };
        const container = document.createElement('div');
        const pending = mountMeshViewer({ fileName: 'partial.gltf', data: bytes(JSON.stringify(json)) }, container,
            { ...ctx, documentAssets: { resolve: async () => ({ url: 'blob:failed-geometry', dispose: releaseAsset }) } }, deps);
        const rejected = expect(pending).rejects.toThrow('could not be decoded');
        await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
        failGeometry(new Error('geometry unavailable')); await rejected;
        if (late) { expect(close).not.toHaveBeenCalled(); finishImage(image); }
        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
        expect(releaseAsset).toHaveBeenCalledOnce(); expect(container.childNodes).toHaveLength(0);
    });
    it('responds to resize and disconnects its observer', async () => {
        let resize: () => void = () => undefined;
        const disconnect = vi.fn(), observe = vi.fn();
        vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe = observe; disconnect = disconnect; });
        const { root, handle } = await mount(); const stage = root.querySelector('.omni-mesh__stage')!;
        Object.defineProperty(stage, 'clientWidth', { value: 900 }); Object.defineProperty(stage, 'clientHeight', { value: 300 }); resize();
        expect((camera as THREE.PerspectiveCamera).aspect).toBe(3); expect(renderer.setSize).toHaveBeenLastCalledWith(900, 300, false);
        expect(observe).toHaveBeenCalledWith(stage); handle.dispose(); expect(disconnect).toHaveBeenCalledOnce();
    });
    it('fails cleanly if WebGL is unavailable after model loading', async () => {
        const disposeGeometry = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
        deps.createRenderer = () => { throw new Error('No WebGL'); };
        const container = document.createElement('div');
        await expect(mountMeshViewer({ fileName: 'x.obj', data: bytes(obj) }, container, ctx, deps)).rejects.toThrow('WebGL 2');
        expect(disposeGeometry).toHaveBeenCalled(); expect(container.innerHTML).toBe('');
    });
    it('rejects cancellation immediately while an asset is pending, and releases late assets', async () => {
        let finish: (asset: { url: string; dispose(): void }) => void = () => undefined;
        const release = vi.fn(), controller = new AbortController(), container = document.createElement('div');
        const promise = mountMeshViewer({ fileName: 'x.gltf', data: bytes(JSON.stringify(manifest('x.bin'))) }, container,
            { ...ctx, documentAssets: { resolve: () => new Promise(resolve => { finish = resolve; }) } }, deps, { signal: controller.signal });
        controller.abort(); await expect(promise).rejects.toBeInstanceOf(MountAbortedError);
        finish({ url: 'blob:late', dispose: release }); await Promise.resolve();
        expect(release).toHaveBeenCalledOnce(); expect(container.innerHTML).toBe('');
    });
    it('releases late glTF scenes after cancellation while decoding', async () => {
        let finish: (value: unknown) => void = () => undefined;
        vi.spyOn(deps.GLTFLoader.prototype, 'parseAsync').mockImplementation(() => new Promise(resolve => { finish = resolve as typeof finish; }));
        const controller = new AbortController(), container = document.createElement('div');
        const promise = mountMeshViewer({ fileName: 'x.glb', data: binaryGlb() }, container, ctx, deps, { signal: controller.signal });
        controller.abort(); await expect(promise).rejects.toBeInstanceOf(MountAbortedError);
        const geometry = new THREE.BoxGeometry(), release = vi.spyOn(geometry, 'dispose');
        const scene = new THREE.Group(); scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
        finish({ scene, scenes: [scene], animations: [] }); await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    });
    it('checks rendered instance budgets and glTF nonfinite coordinates', async () => {
        const loaderScene = new THREE.Group(); loaderScene.add(new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([NaN, 0, 0, 1, 0, 0, 0, 1, 0], 3)), new THREE.MeshStandardMaterial()));
        vi.spyOn(deps.GLTFLoader.prototype, 'parseAsync').mockResolvedValue({ scene: loaderScene, scenes: [loaderScene], animations: [] } as never);
        await expect(mount()).resolves.toBeDefined();
        await expect(mount('bad.glb', binaryGlb())).rejects.toThrow('invalid coordinates');
    });
    it('plays and pauses glTF animation without leaving an animation frame', async () => {
        const frames = new Map<number, FrameRequestCallback>(); let next = 0;
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(++next, callback); return next; }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id); }));
        const group = new THREE.Group(); group.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
        const clip = new THREE.AnimationClip('move', 1, [new THREE.VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 1, 0, 0])]);
        vi.spyOn(deps.GLTFLoader.prototype, 'parseAsync').mockResolvedValue({ scene: group, scenes: [group], animations: [clip] } as never);
        const { root, handle } = await mount('animated.glb', binaryGlb()); const play = root.querySelector<HTMLButtonElement>('.omni-mesh__play')!;
        play.click(); expect(play.textContent).toBe('Pause animation'); expect(frames.size).toBe(1);
        const run = (time: number) => { const [id, callback] = [...frames][0]!; frames.delete(id); callback(time); };
        run(1000); run(1050); expect(group.position.x).toBeGreaterThan(0);
        play.click(); expect(frames.size).toBe(0); play.click(); handle.dispose(); expect(frames.size).toBe(0);
    });
});
