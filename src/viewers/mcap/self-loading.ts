import { loadMcapDeps } from '../../parsers/mcap/self-loading.js';
import { MountAbortedError, type ViewerHandle, type ViewerInput } from '../types.js';
import { mountMcapViewer, type McapMountOptions, type McapViewerContext } from './index.js';
export * from './index.js';

export async function mountSelfLoadingMcapViewer(input: ViewerInput, container: HTMLElement, ctx: McapViewerContext, options: McapMountOptions = {}): Promise<ViewerHandle> {
    const signals = [...new Set([options.signal, options.parse?.signal].filter((signal): signal is AbortSignal => !!signal))];
    if (signals.some(signal => signal.aborted)) throw new MountAbortedError();
    const deps = await new Promise<Awaited<ReturnType<typeof loadMcapDeps>>>((resolve, reject) => {
        const cleanup = () => signals.forEach(signal => signal.removeEventListener('abort', abort));
        const abort = () => { cleanup(); reject(new MountAbortedError()); };
        signals.forEach(signal => signal.addEventListener('abort', abort, { once: true }));
        loadMcapDeps().then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
    return mountMcapViewer(input, container, ctx, deps, options);
}
