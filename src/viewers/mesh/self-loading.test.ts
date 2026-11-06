import { describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { MountAbortedError } from '../types.js';
import { mountSelfLoadingMeshViewer, loadMeshViewerDeps } from './self-loading.js';

const chunk = vi.hoisted(() => {
    let release: () => void = () => undefined;
    const ready = new Promise<void>(resolve => { release = resolve; });
    return { ready, release };
});
vi.mock('three', async () => {
    await chunk.ready;
    return vi.importActual('three');
});

describe('self-loading mesh cancellation', () => {
    it('rejects immediately while an actual dependency import is still pending', async () => {
        const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
        const ctx = { assets: { resolveAssetUrl: async (path: string) => path }, i18n: createCatalogI18n(), logger: { log() {} } };
        const pending = mountSelfLoadingMeshViewer({ fileName: 'pending.obj', data: new Uint8Array() }, {} as HTMLElement, ctx, { signal: controller.signal });
        const outcome = pending.then(() => 'unexpected success', (error: unknown) => error);
        controller.abort();
        try {
            const result = await Promise.race([outcome, new Promise<string>(resolve => setTimeout(() => resolve('still pending'), 50))]);
            expect(result).toBeInstanceOf(MountAbortedError);
            expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        } finally { chunk.release(); await loadMeshViewerDeps(); }
    });
});
