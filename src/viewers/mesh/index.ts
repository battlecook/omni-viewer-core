import type * as Three from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import type { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { DocumentAssetsService, HostContext, ResolvedDocumentAsset } from '../../host/index.js';
import { parseMesh, type MeshParseOptions } from '../../parsers/mesh/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { meshViewerCss } from './styles.js';
import { abortable } from './async.js';

export * from '../../parsers/mesh/index.js';
export { meshViewerCss } from './styles.js';
export interface MeshViewerDeps {
    THREE: typeof Three;
    GLTFLoader: typeof GLTFLoader;
    OBJLoader: typeof OBJLoader;
    STLLoader: typeof STLLoader;
    OrbitControls: typeof OrbitControls;
    /** Host-owned optional Draco/KTX2/Meshopt configuration. Never downloads codecs automatically. */
    configureGltfLoader?(loader: GLTFLoader): void;
    /** Renderer seam for host integration and headless contract tests. */
    createRenderer?(parameters: Three.WebGLRendererParameters): MeshRenderer;
}
export type MeshRenderer = Pick<Three.WebGLRenderer, 'domElement' | 'setSize' | 'setPixelRatio' | 'render' | 'dispose'>
    & Partial<Pick<Three.WebGLRenderer, 'toneMapping' | 'toneMappingExposure' | 'forceContextLoss'>>;
export type MeshViewerContext = HostContext & { documentAssets?: DocumentAssetsService };
export interface MeshMountOptions extends MountOptions, Omit<MeshParseOptions, 'fileName'> {}
export const MESH_VIEWER_META = {
    id: 'mesh', displayNameKey: 'mesh.title', extensions: ['glb', 'gltf', 'stl', 'obj'], priority: 20,
    requiredServices: [] as const, optionalServices: ['documentAssets'] as const, inputOwnership: 'borrows' as const
};

/** Release shared GPU resources once, including textures from all glTF scenes. */
export function disposeMeshObjects(roots: readonly Three.Object3D[]): void {
    createMeshDisposer()(roots);
}

/** One ownership ledger survives late asynchronous decoder completions. */
function createMeshDisposer(): (roots: readonly Three.Object3D[], extraTextures?: Iterable<Three.Texture>) => void {
    const freedGeometry = new WeakSet<Three.BufferGeometry>(), freedMaterials = new WeakSet<Three.Material>();
    const freedTextures = new WeakSet<Three.Texture>(), closedImages = new WeakSet<{ close(): void }>();
    return (roots, extraTextures = []) => {
        const geometries = new Set<Three.BufferGeometry>(), materials = new Set<Three.Material>();
        const textures = new Set<Three.Texture>(extraTextures), bitmaps = new Set<{ close(): void }>();
        const texture = (value: unknown): void => {
            if (value && typeof value === 'object' && (value as Three.Texture).isTexture) textures.add(value as Three.Texture);
        };
        roots.forEach(root => root.traverse(node => {
            const mesh = node as Three.Mesh;
            if (mesh.geometry) geometries.add(mesh.geometry);
            if (mesh.material) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(m => materials.add(m));
            const skeleton = (node as Three.SkinnedMesh).skeleton;
            if (skeleton?.boneTexture) textures.add(skeleton.boneTexture);
        }));
        materials.forEach(material => {
            Object.values(material).forEach(texture);
            const uniforms = (material as Three.ShaderMaterial).uniforms;
            if (uniforms) Object.values(uniforms).forEach(uniform => texture(uniform.value));
        });
        textures.forEach(t => {
            const images: unknown[] = Array.isArray(t.source?.data) ? t.source.data : [t.source?.data];
            images.forEach(image => { if (image && typeof (image as { close?: unknown }).close === 'function') bitmaps.add(image as { close(): void }); });
            if (!freedTextures.has(t)) { freedTextures.add(t); t.dispose(); }
        });
        bitmaps.forEach(image => { if (!closedImages.has(image)) { closedImages.add(image); image.close(); } });
        geometries.forEach(g => { if (!freedGeometry.has(g)) { freedGeometry.add(g); g.dispose(); } });
        materials.forEach(m => { if (!freedMaterials.has(m)) { freedMaterials.add(m); m.dispose(); } });
    };
}

export async function mountMeshViewer(
    input: ViewerInput, container: HTMLElement, ctx: MeshViewerContext, deps: MeshViewerDeps, options: MeshMountOptions = {}
): Promise<ViewerHandle> {
    const signal = options.signal, t = ctx.i18n.t.bind(ctx.i18n);
    const check = (): void => { if (signal?.aborted) throw new MountAbortedError(); };
    check();
    const { result } = parseMesh(input.data, { ...options, fileName: input.fileName });
    if (result.status === 'failed') {
        if (result.failure.code === 'aborted') throw new MountAbortedError();
        throw new Error(t(result.failure.messageKey, result.failure.args));
    }
    const model = result.document, T = deps.THREE, doc = container.ownerDocument, win = doc.defaultView;
    const assets: ResolvedDocumentAsset[] = [], roots: Three.Object3D[] = [], listeners: Array<() => void> = [];
    const internalImageUrls = new Set<string>(), urlApi = win?.URL ?? URL;
    const pendingTextures = new Set<Three.Texture>(), releaseObjects = createMeshDisposer();
    let renderer: MeshRenderer | undefined, controls: OrbitControls | undefined, observer: ResizeObserver | undefined;
    let mixer: Three.AnimationMixer | undefined, frame: number | undefined, disposed = false;
    let scene: Three.Scene | undefined;
    const shell = doc.createElement('section'); shell.className = `${VIEWER_ROOT_CLASS} omni-viewer--mesh omni-mesh`;
    const style = doc.createElement('style'); style.textContent = meshViewerCss;
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        if (frame !== undefined) win?.cancelAnimationFrame(frame);
        observer?.disconnect(); listeners.splice(0).forEach(off => off()); controls?.dispose();
        if (mixer) { mixer.stopAllAction(); roots.forEach(root => mixer!.uncacheRoot(root)); }
        releaseObjects(scene ? [scene, ...roots] : roots, pendingTextures); pendingTextures.clear(); scene?.clear(); roots.length = 0;
        renderer?.dispose(); renderer?.forceContextLoss?.();
        internalImageUrls.forEach(url => urlApi.revokeObjectURL(url)); internalImageUrls.clear();
        assets.splice(0).forEach(asset => asset.dispose()); shell.remove(); style.remove();
    };
    const on = (target: EventTarget, event: string, handler: EventListener): void => {
        target.addEventListener(event, handler); listeners.push(() => target.removeEventListener(event, handler));
    };
    try {
        const urls = new Map<string, string>();
        for (const resource of model.resources) {
            check();
            if (!ctx.documentAssets) throw new Error(t('mesh.missingAsset', { path: resource.uri }));
            const asset = await abortable(ctx.documentAssets.resolve(resource.uri), signal, value => value?.dispose());
            if (!asset) throw new Error(t('mesh.missingAsset', { path: resource.uri }));
            assets.push(asset); urls.set(resource.uri, asset.url);
        }
        check();
        const manager = new T.LoadingManager(), textureFailures = new Set<string>();
        manager.onError = url => {
            textureFailures.add(url);
            if (internalImageUrls.delete(url)) urlApi.revokeObjectURL(url);
        };
        // URI validation happens before any loader runs. blob URLs here are generated by GLTFLoader for embedded images.
        manager.setURLModifier(url => {
            const resolved = urls.get(url);
            if (resolved) return resolved;
            if (url.startsWith('blob:')) {
                if (disposed || signal?.aborted) { urlApi.revokeObjectURL(url); throw new MountAbortedError(); }
                internalImageUrls.add(url); return url;
            }
            if (url.startsWith('data:')) return url;
            throw new Error(t('mesh.missingAsset', { path: url }));
        });
        let object: Three.Object3D, animations: Three.AnimationClip[] = [];
        try {
            if (model.format === 'glb' || model.format === 'gltf') {
                const loader = new deps.GLTFLoader(manager); deps.configureGltfLoader?.(loader);
                loader.register(parser => {
                    // Scene decoding can reject while other textures are still
                    // completing. Acquire ownership before a scene is returned.
                    const loadImageSource = parser.loadImageSource.bind(parser);
                    parser.loadImageSource = (index, imageLoader) => loadImageSource(index, imageLoader).then(texture => {
                        if (disposed) releaseObjects([], [texture]); else pendingTextures.add(texture);
                        return texture;
                    });
                    return { name: 'OMNI_texture_ownership' };
                });
                const source = model.format === 'glb' ? new Uint8Array(model.data).buffer : model.text.replace(/^\uFEFF/, '');
                const loading = loader.parseAsync(source, '').then(async value => {
                    // Successful embedded image loads have already been revoked
                    // by Three.js; failed ones were released by manager.onError.
                    internalImageUrls.clear();
                    // GLTFLoader caches nodes across scenes. Later scenes can
                    // reparent a shared root away from the selected scene.
                    // Reattach the original cached roots to preserve skeletons,
                    // animation bindings and hierarchy without shallow clones.
                    if (value.scenes.length > 1 && model.sceneRoots?.length) {
                        const selectedRoots = await Promise.all(model.sceneRoots.map(index => value.parser.getDependency('node', index) as Promise<Three.Object3D>));
                        selectedRoots.forEach(root => value.scene.add(root));
                    }
                    return value;
                });
                const gltf = await abortable(loading, signal, value => releaseObjects(value.scenes));
                roots.push(...gltf.scenes); object = gltf.scene; animations = gltf.animations;
            } else if (model.format === 'stl') {
                const geometry = new deps.STLLoader(manager).parse(new Uint8Array(model.data).buffer);
                const colored = geometry.hasAttribute('color');
                const material = new T.MeshStandardMaterial({ color: colored ? 0xffffff : 0x90b6e8, metalness: 0.05, roughness: 0.65,
                    side: T.DoubleSide, vertexColors: colored });
                object = new T.Mesh(geometry, material); roots.push(object);
            } else {
                object = new deps.OBJLoader(manager).parse(model.text); roots.push(object);
                object.traverse(node => {
                    const mesh = node as Three.Mesh;
                    if (mesh.isMesh) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => { material.side = T.DoubleSide; });
                });
            }
        } catch (error) {
            check(); ctx.logger.log('warn', `Mesh decoding failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(t('mesh.decodeFailed'));
        }
        check();
        let meshes = 0, objects = 0, vertices = 0, triangles = 0;
        object.traverse(node => {
            const mesh = node as Three.Mesh & { isLine?: boolean; isPoints?: boolean };
            if (!mesh.isMesh && !mesh.isLine && !mesh.isPoints) return;
            objects++; if (mesh.isMesh) meshes++;
            const position = mesh.geometry.getAttribute('position');
            if (!position) throw new Error(t('diag.mesh.corrupted'));
            const instances = (mesh as Three.InstancedMesh).isInstancedMesh ? (mesh as Three.InstancedMesh).count : 1;
            vertices += position.count * instances;
            if (mesh.isMesh) triangles += Math.floor((mesh.geometry.index?.count ?? position.count) / 3) * instances;
            if (objects > (options.limits?.maxEntries ?? 100_000) || vertices > (options.maxVertices ?? 2_000_000) || triangles > (options.maxTriangles ?? 2_000_000)) throw new Error(t('diag.mesh.limit'));
            for (let i = 0; i < position.count; i++) {
                if (![position.getX(i), position.getY(i), position.getZ(i)].every(Number.isFinite)) throw new Error(t('diag.mesh.corrupted'));
            }
            if (mesh.geometry.morphAttributes.normal?.length && !mesh.geometry.morphAttributes.position?.length) {
                // Three r180's morph texture builder assumes position targets.
                // A shared zero displacement attribute preserves normal-only morphs.
                const zero = new T.BufferAttribute(new Float32Array(position.count * 3), 3);
                mesh.geometry.morphAttributes.position = mesh.geometry.morphAttributes.normal.map(() => zero);
            }
        });
        if (!meshes) throw new Error(t('mesh.empty'));
        object.updateMatrixWorld(true);
        const box = new T.Box3().setFromObject(object), sphere = box.getBoundingSphere(new T.Sphere());
        if (box.isEmpty() || !Number.isFinite(sphere.radius) || sphere.radius <= 0 || !sphere.center.toArray().every(Number.isFinite)) throw new Error(t('mesh.empty'));
        const wrapper = new T.Group(); wrapper.add(object);
        wrapper.scale.setScalar(1 / sphere.radius); wrapper.position.copy(sphere.center).multiplyScalar(-1 / sphere.radius);
        scene = new T.Scene(); scene.add(wrapper);
        scene.add(new T.HemisphereLight(0xffffff, 0x555b71, 2.5));
        const keyLight = new T.DirectionalLight(0xffffff, 3); keyLight.position.set(3, 5, 4); scene.add(keyLight);
        const fillLight = new T.DirectionalLight(0xb3ccff, 1.5); fillLight.position.set(-4, 1, -3); scene.add(fillLight);
        const grid = new T.GridHelper(4, 20, 0x65728a, 0x354052); grid.position.y = (box.min.y - sphere.center.y) / sphere.radius - 0.01;
        const axes = new T.AxesHelper(1.4); scene.add(grid, axes); axes.visible = false;
        const camera = new T.PerspectiveCamera(45, 1, 0.01, 1000);
        const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
            const node = doc.createElement(tag); node.className = `omni-mesh__${cls}`; if (text !== undefined) node.textContent = text; return node;
        };
        shell.append(el('h2', 'title', input.fileName), el('p', 'summary', t('mesh.summary', { format: model.format.toUpperCase(), meshes, vertices, triangles })));
        const toolbar = el('div', 'toolbar'); toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', t('mesh.controls'));
        const button = (name: string): HTMLButtonElement => {
            const node = el('button', name, t(`mesh.${name}`)); node.type = 'button'; toolbar.append(node); return node;
        };
        const fit = button('fit'), zoomIn = button('zoomIn'), zoomOut = button('zoomOut'), wire = button('wireframe'), gridButton = button('grid'), axesButton = button('axes');
        wire.setAttribute('aria-pressed', 'false'); gridButton.setAttribute('aria-pressed', 'true'); axesButton.setAttribute('aria-pressed', 'false');
        const animate = animations.length ? button('play') : undefined;
        animate?.setAttribute('aria-pressed', 'false');
        const stage = el('div', 'stage');
        try {
            renderer = deps.createRenderer ? deps.createRenderer({ antialias: true, alpha: true }) : new T.WebGLRenderer({ antialias: true, alpha: true });
        } catch { throw new Error(t('mesh.webglUnavailable')); }
        renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1;
        const canvas = renderer.domElement; canvas.className = 'omni-mesh__canvas'; canvas.tabIndex = 0;
        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', t('mesh.viewport'));
        const hint = el('p', 'hint', t('mesh.hint')); hint.id = `omni-mesh-hint-${canvasId++}`; canvas.setAttribute('aria-describedby', hint.id);
        stage.append(canvas);
        const warnings = el('div', 'warnings'); warnings.setAttribute('role', 'status');
        result.diagnostics.forEach(d => warnings.append(el('p', 'warning', t(d.messageKey, d.args))));
        if (textureFailures.size) warnings.append(el('p', 'warning', t('mesh.textureFailed')));
        warnings.hidden = !warnings.childNodes.length;
        shell.append(toolbar, stage, hint, warnings);
        const root = options.styleIsolation === 'scoped' ? container : container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        if (root !== container) root.append(style);
        root.append(shell);
        const orbit = controls = new deps.OrbitControls(camera, canvas);
        orbit.enableDamping = false; orbit.minDistance = 1.05; orbit.maxDistance = 100; orbit.target.set(0, 0, 0);
        const render = (): void => { if (!disposed && scene) renderer!.render(scene, camera); };
        orbit.addEventListener('change', render); listeners.push(() => orbit.removeEventListener('change', render));
        const reset = (): void => {
            const halfFov = Math.min(camera.fov * Math.PI / 360, Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect));
            camera.position.set(1, 0.7, 1).normalize().multiplyScalar(1.2 / Math.sin(halfFov)); orbit.target.set(0, 0, 0); orbit.update(); render();
        };
        let lastAspect = 0;
        const resize = (): void => {
            if (disposed) return;
            const width = Math.max(1, stage.clientWidth || container.clientWidth || 640), height = Math.max(1, stage.clientHeight || 480);
            renderer!.setPixelRatio(Math.min(win?.devicePixelRatio || 1, 2)); renderer!.setSize(width, height, false);
            camera.aspect = width / height; camera.updateProjectionMatrix();
            if (!lastAspect) reset(); else render(); lastAspect = camera.aspect;
        };
        const Observer = win?.ResizeObserver;
        if (Observer) { observer = new Observer(resize); observer.observe(stage); }
        if (win) on(win, 'resize', resize);
        const zoom = (factor: number): void => {
            const offset = camera.position.clone().sub(orbit.target), distance = Math.max(orbit.minDistance, Math.min(orbit.maxDistance, offset.length() * factor));
            camera.position.copy(orbit.target).add(offset.setLength(distance)); orbit.update(); render();
        };
        on(fit, 'click', reset); on(zoomIn, 'click', () => zoom(0.8)); on(zoomOut, 'click', () => zoom(1.25));
        let wireframe = false;
        on(wire, 'click', () => {
            wireframe = !wireframe; wire.setAttribute('aria-pressed', String(wireframe));
            object.traverse(node => {
                const material = (node as Three.Mesh).material;
                if (material) (Array.isArray(material) ? material : [material]).forEach(m => {
                    if ('wireframe' in m) (m as Three.MeshStandardMaterial).wireframe = wireframe;
                });
            }); render();
        });
        for (const [button, helper] of [[gridButton, grid], [axesButton, axes]] as const) on(button, 'click', () => {
            helper.visible = !helper.visible; button.setAttribute('aria-pressed', String(helper.visible)); render();
        });
        on(canvas, 'keydown', ((event: KeyboardEvent) => {
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            const spherical = new T.Spherical().setFromVector3(camera.position.clone().sub(orbit.target));
            switch (event.key) {
                case '+': case '=': zoom(0.8); break;
                case '-': zoom(1.25); break;
                case '0': case 'Home': reset(); break;
                case 'ArrowLeft': spherical.theta -= 0.15; break;
                case 'ArrowRight': spherical.theta += 0.15; break;
                case 'ArrowUp': spherical.phi -= 0.15; break;
                case 'ArrowDown': spherical.phi += 0.15; break;
                default: return;
            }
            if (event.key.startsWith('Arrow')) { spherical.makeSafe(); camera.position.setFromSpherical(spherical).add(orbit.target); orbit.update(); render(); }
            event.preventDefault();
        }) as EventListener);
        let playing = false, previous = 0;
        if (animations.length) {
            mixer = new T.AnimationMixer(object); animations.forEach(clip => mixer!.clipAction(clip).play());
            const tick = (now: number): void => {
                frame = undefined;
                if (disposed || !playing) return;
                mixer!.update(previous ? Math.min((now - previous) / 1000, 0.1) : 0); previous = now; render(); frame = win?.requestAnimationFrame(tick);
            };
            on(animate!, 'click', () => {
                playing = !playing; animate!.textContent = t(playing ? 'mesh.pause' : 'mesh.play'); animate!.setAttribute('aria-pressed', String(playing));
                if (playing) { previous = 0; frame = win?.requestAnimationFrame(tick); }
                else if (frame !== undefined) { win?.cancelAnimationFrame(frame); frame = undefined; }
            });
        }
        on(canvas, 'webglcontextlost', event => { event.preventDefault(); warnings.hidden = false; warnings.textContent = t('mesh.contextLost'); });
        on(canvas, 'webglcontextrestored', () => { warnings.textContent = ''; warnings.hidden = true; render(); });
        resize(); check();
        return { dispose };
    } catch (error) { dispose(); throw error; }
}
let canvasId = 0;
