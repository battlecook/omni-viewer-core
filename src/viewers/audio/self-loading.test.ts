// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostContext } from '../../host/index.js';
import { createCatalogI18n } from '../../i18n/index.js';

// The engine is created inside the entry point and never handed back, so the
// only way to observe its lifetime is to stand in for the factory.
const engineMock = vi.hoisted(() => ({
    dispose: vi.fn(),
    created: 0,
    /** Error the fake worker engine rejects every call with, if any. */
    failWith: undefined as Error | undefined,
    workerCalls: 0
}));

const assetEngineMock = vi.hoisted(() => ({
    created: 0,
    decode: vi.fn(),
    analyze: vi.fn()
}));

vi.mock('./worker-engine.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./worker-engine.js')>();
    return {
        ...actual,
        createWorkerAudioEngine: () => {
            engineMock.created++;
            const run = async (): Promise<never> => {
                engineMock.workerCalls++;
                throw engineMock.failWith ?? new Error('worker decode failed');
            };
            return { decode: run, analyze: run, dispose: engineMock.dispose };
        }
    };
});

vi.mock('./engine.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./engine.js')>();
    return {
        ...actual,
        createAssetAudioEngine: () => {
            assetEngineMock.created++;
            return { decode: assetEngineMock.decode, analyze: assetEngineMock.analyze };
        }
    };
});

const { mountSelfLoadingAudioViewer, withInProcessFallback } = await import('./self-loading.js');
// Re-exported through index.js, so the worker-engine mock above is in effect.
const { AudioWorkerUnavailableError, createWorkerAudioEngine } = await import('./index.js');

/** The wrapper as the entry point builds it, with the failing worker engine. */
const captureEngine = () => withInProcessFallback(stubCtx(), createWorkerAudioEngine(stubCtx()));

function stubCtx(): HostContext {
    return {
        assets: { resolveAssetUrl: async (p) => `https://host/${p}` },
        i18n: createCatalogI18n(),
        logger: { log: () => undefined }
    };
}

const input = () => ({ fileName: 'song.wav', data: Uint8Array.of(1, 2, 3, 4) });
const urlOptions = { createObjectUrl: () => 'blob:test', revokeObjectUrl: () => undefined };

afterEach(() => {
    engineMock.dispose.mockClear();
    engineMock.created = 0;
    engineMock.workerCalls = 0;
    engineMock.failWith = undefined;
    assetEngineMock.created = 0;
    assetEngineMock.decode.mockReset();
    assetEngineMock.analyze.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('self-loading audio entry point', () => {
    // Repeatedly opening and closing a file would otherwise leak one worker
    // (and its grown WASM heap) per mount.
    it('disposes the engine it created when the handle is disposed', async () => {
        vi.stubGlobal('Worker', class {} as unknown as typeof Worker);
        vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
        vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);

        const handle = await mountSelfLoadingAudioViewer(
            input(), document.createElement('div'), stubCtx(), urlOptions
        );
        expect(engineMock.created).toBe(1);
        expect(engineMock.dispose).not.toHaveBeenCalled();

        handle.dispose();
        expect(engineMock.dispose).toHaveBeenCalledOnce();
    });

    it('disposes the engine when the mount is aborted before returning a handle', async () => {
        vi.stubGlobal('Worker', class {} as unknown as typeof Worker);
        const controller = new AbortController();
        controller.abort();

        await expect(mountSelfLoadingAudioViewer(
            input(), document.createElement('div'), stubCtx(), { ...urlOptions, signal: controller.signal }
        )).rejects.toThrow();
        expect(engineMock.created).toBe(1);
        expect(engineMock.dispose).toHaveBeenCalledOnce();
    });

    // A host that cannot start the worker (asset key unregistered, CSP) must
    // not lose WASM decoding — it is the only recovery path for codecs the
    // browser cannot play, such as AMR and AC3.
    it('retries in-process when the worker cannot be started', async () => {
        vi.stubGlobal('Worker', class {} as unknown as typeof Worker);
        engineMock.failWith = new AudioWorkerUnavailableError(new Error('Unknown core asset'));
        assetEngineMock.decode.mockResolvedValue({
            sampleRate: 8000, channels: 1, frames: 1, pcm: new Float32Array([0.1])
        });

        const engine = captureEngine();
        await expect(engine.decode(Uint8Array.of(1, 2, 3, 4)))
            .resolves.toMatchObject({ sampleRate: 8000 });
        expect(assetEngineMock.created).toBe(1);
        expect(assetEngineMock.decode).toHaveBeenCalledOnce();
    });

    it('stays on the in-process engine after the first unavailable result', async () => {
        vi.stubGlobal('Worker', class {} as unknown as typeof Worker);
        engineMock.failWith = new AudioWorkerUnavailableError(new Error('CSP'));
        assetEngineMock.analyze.mockResolvedValue({
            sampleRate: 8000, channels: 1, duration: 1, peaks: [0.5]
        });

        const engine = captureEngine();
        await engine.analyze(Uint8Array.of(1, 2, 3, 4), 10);
        await engine.analyze(Uint8Array.of(1, 2, 3, 4), 10);
        expect(engineMock.workerCalls).toBe(1); // not retried per call
        expect(assetEngineMock.created).toBe(1); // engine built once and reused
        expect(assetEngineMock.analyze).toHaveBeenCalledTimes(2);
    });

    // A decode error describes the file, and a timeout is what the worker
    // exists to enforce. Re-running either on the main thread would bring back
    // the freeze.
    it('does not fall back for ordinary decode failures', async () => {
        vi.stubGlobal('Worker', class {} as unknown as typeof Worker);
        engineMock.failWith = new Error('audio engine: unsupported or corrupted stream');

        const engine = captureEngine();
        await expect(engine.decode(Uint8Array.of(1, 2, 3, 4))).rejects.toThrow(/unsupported/);
        expect(assetEngineMock.created).toBe(0);
    });

    it('falls back to the in-process engine where Worker is unavailable', async () => {
        vi.stubGlobal('Worker', undefined);
        vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
        vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);

        const handle = await mountSelfLoadingAudioViewer(
            input(), document.createElement('div'), stubCtx(), urlOptions
        );
        expect(engineMock.created).toBe(0);
        // The asset engine has no dispose; releasing it must stay a no-op
        // rather than throwing.
        expect(() => handle.dispose()).not.toThrow();
    });
});
