import { parseSelfLoadingArrow } from '../../parsers/arrow/self-loading.js';
import { MountAbortedError, type ViewerHandle, type ViewerInput } from '../types.js';
import { mountArrowOutcome, type ArrowMountOptions, type ArrowViewerContext } from './index.js';

export * from './index.js';

export async function mountSelfLoadingArrowViewer(input: ViewerInput, container: HTMLElement, ctx: ArrowViewerContext, options: ArrowMountOptions = {}): Promise<ViewerHandle> {
    if (options.signal?.aborted || options.parse?.signal?.aborted) throw new MountAbortedError();
    const outcome = await abortable(signal => parseSelfLoadingArrow(input.data, { ...options.parse, signal }), [options.signal, options.parse?.signal]);
    return mountArrowOutcome(outcome, input.fileName, container, ctx, options);
}

function abortable<T>(run: (signal: AbortSignal) => Promise<T>, signals: Array<AbortSignal | undefined>): Promise<T> {
    const active = [...new Set(signals.filter((signal): signal is AbortSignal => !!signal))];
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const cleanup = () => active.forEach(signal => signal.removeEventListener('abort', abort));
        const abort = () => { controller.abort(); cleanup(); reject(new MountAbortedError()); };
        for (const signal of active) signal.addEventListener('abort', abort, { once: true });
        if (active.some(signal => signal.aborted)) { abort(); return; }
        try { run(controller.signal).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); }); }
        catch (error) { cleanup(); reject(error); }
    });
}
