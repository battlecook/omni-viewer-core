import { MountAbortedError, type ViewerHandle, type ViewerInput } from '../types.js';
import { mountMeshViewer, type MeshMountOptions, type MeshViewerContext, type MeshViewerDeps } from './index.js';
import { abortable } from './async.js';
export * from './index.js';

/** Installed optional peer only. No CDN, global, or network fallback. */
export async function loadMeshViewerDeps(): Promise<MeshViewerDeps> {
    const [THREE, { GLTFLoader }, { STLLoader }, { OBJLoader }, { OrbitControls }] = await Promise.all([
        import('three'), import('three/addons/loaders/GLTFLoader.js'), import('three/addons/loaders/STLLoader.js'),
        import('three/addons/loaders/OBJLoader.js'), import('three/addons/controls/OrbitControls.js')
    ]);
    return { THREE, GLTFLoader, STLLoader, OBJLoader, OrbitControls };
}

export async function mountSelfLoadingMeshViewer(
    input: ViewerInput, container: HTMLElement, ctx: MeshViewerContext, options: MeshMountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    let deps: MeshViewerDeps;
    try { deps = await abortable(loadMeshViewerDeps(), options.signal); }
    catch (error) {
        if (error instanceof MountAbortedError || options.signal?.aborted) throw new MountAbortedError();
        throw new Error(ctx.i18n.t('mesh.missingDependency'));
    }
    if (options.signal?.aborted) throw new MountAbortedError();
    return mountMeshViewer(input, container, ctx, deps, options);
}
