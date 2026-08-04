import { describe, expect, it, vi } from 'vitest';
import type { HostContext } from '../../host/index.js';
import {
    AUDIO_WORKER_ASSET_KEY,
    AudioEngineTimeoutError,
    createWorkerAudioEngine
} from './worker-engine.js';

interface FakeWorker extends Worker {
    posted: Array<Record<string, unknown>>;
    terminated: number;
    reply(message: unknown): void;
}

/** Lets `ensureWorker`'s async asset resolution settle. `vi.waitFor` is not
 *  usable here: under fake timers it advances them itself, which fires the
 *  very timeout these tests are trying to control. */
const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

function stubCtx(): HostContext & { logged: string[] } {
    const logged: string[] = [];
    return {
        logged,
        assets: { resolveAssetUrl: async (assetPath: string) => `https://host/${assetPath}` },
        i18n: { t: (key: string) => key },
        logger: { log: (level, message) => { logged.push(`${level}: ${message}`); } }
    };
}

function fakeWorkerFactory(): { urls: string[]; workers: FakeWorker[]; create(url: string): Worker } {
    const urls: string[] = [];
    const workers: FakeWorker[] = [];
    return {
        urls,
        workers,
        create(url: string): Worker {
            urls.push(url);
            const worker = {
                posted: [] as Array<Record<string, unknown>>,
                terminated: 0,
                onmessage: null as ((event: MessageEvent) => void) | null,
                onerror: null as ((event: ErrorEvent) => void) | null,
                postMessage(message: unknown) { worker.posted.push(message as Record<string, unknown>); },
                terminate() { worker.terminated++; },
                reply(message: unknown) { worker.onmessage?.({ data: message } as MessageEvent); }
            } as unknown as FakeWorker;
            workers.push(worker);
            return worker;
        }
    };
}

describe('worker creation contract', () => {
    // ADR 22: URL scheme, module/classic and CSP worker-src are the adapter's
    // to decide, so a host-provided factory must win over the built-in one.
    it('uses the host WorkerFactoryService when present', async () => {
        const factory = fakeWorkerFactory();
        const entries: string[] = [];
        const engine = createWorkerAudioEngine({
            ...stubCtx(),
            workerFactory: { createWorker: (entry: string) => { entries.push(entry); return factory.create(entry); } }
        });
        void engine.analyze(new Uint8Array([1, 2, 3, 4]), 10).catch(() => undefined);
        await vi.waitFor(() => expect(factory.workers.length).toBe(1));
        expect(entries).toEqual([`https://host/${AUDIO_WORKER_ASSET_KEY}`]);
        engine.dispose();
    });

    it('lets an explicit createWorker override the host factory', async () => {
        const explicit = fakeWorkerFactory();
        const hostFactory = vi.fn();
        const engine = createWorkerAudioEngine(
            { ...stubCtx(), workerFactory: { createWorker: hostFactory as never } },
            { createWorker: explicit.create }
        );
        void engine.analyze(new Uint8Array([1, 2, 3, 4]), 10).catch(() => undefined);
        await vi.waitFor(() => expect(explicit.workers.length).toBe(1));
        expect(hostFactory).not.toHaveBeenCalled();
        engine.dispose();
    });
});

describe('worker audio engine', () => {
    it('resolves the worker, module and wasm assets and forwards the request', async () => {
        const ctx = stubCtx();
        const factory = fakeWorkerFactory();
        const engine = createWorkerAudioEngine(ctx, { createWorker: factory.create });
        const promise = engine.analyze(new Uint8Array([1, 2, 3, 4]), 8000);
        await vi.waitFor(() => expect(factory.workers[0]?.posted.length).toBe(1));

        expect(factory.urls[0]).toBe(`https://host/${AUDIO_WORKER_ASSET_KEY}`);
        const sent = factory.workers[0]!.posted[0]!;
        expect(sent.op).toBe('analyze');
        expect(sent.width).toBe(8000);
        expect(sent.moduleUrl).toBe('https://host/audio-engine/audio_engine.mjs');
        expect(sent.wasmUrl).toBe('https://host/audio-engine/audio_engine.wasm');

        factory.workers[0]!.reply({ id: sent.id, ok: true, result: { sampleRate: 44100, channels: 2, duration: 60, peaks: [0.5] } });
        await expect(promise).resolves.toMatchObject({ sampleRate: 44100, channels: 2 });
        engine.dispose();
    });

    // Audio's inputOwnership is 'borrows': the caller keeps using its bytes
    // after mount, so the worker must never receive the original buffer.
    it('sends a copy of the input rather than transferring the caller buffer', async () => {
        const ctx = stubCtx();
        const factory = fakeWorkerFactory();
        const engine = createWorkerAudioEngine(ctx, { createWorker: factory.create });
        const data = new Uint8Array([9, 8, 7, 6]);
        void engine.analyze(data, 100).catch(() => undefined);
        await vi.waitFor(() => expect(factory.workers[0]?.posted.length).toBe(1));

        const sent = factory.workers[0]!.posted[0]!.bytes as Uint8Array;
        expect([...sent]).toEqual([9, 8, 7, 6]);
        expect(sent.buffer).not.toBe(data.buffer);
        expect(data.byteLength).toBe(4); // not detached
        engine.dispose();
    });

    // The decoder can spin forever on some inputs (measured on MPEG-1 stereo
    // MP3). A spinning WASM loop never reads messages, so terminate is the
    // only exit — this is the whole reason the engine runs in a worker.
    it('terminates the worker and rejects when a request never answers', async () => {
        vi.useFakeTimers();
        try {
            const ctx = stubCtx();
            const factory = fakeWorkerFactory();
            const engine = createWorkerAudioEngine(ctx, { createWorker: factory.create, timeoutMs: 1000 });
            // Settle handler attached up front: advancing the timer rejects
            // synchronously, and attaching afterwards trips the runner's
            // unhandled-rejection detector before the assertion runs.
            const settled = engine.analyze(new Uint8Array([1, 2, 3, 4]), 8000).then(() => null, (error: unknown) => error);
            await flush();
            expect(factory.workers[0]!.posted.length).toBe(1);

            await vi.advanceTimersByTimeAsync(1001);
            expect(await settled).toBeInstanceOf(AudioEngineTimeoutError);
            expect(factory.workers[0]!.terminated).toBe(1);
            expect(ctx.logged.some((line) => line.includes('terminating worker'))).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('builds a fresh worker after a timeout instead of staying dead', async () => {
        vi.useFakeTimers();
        try {
            const ctx = stubCtx();
            const factory = fakeWorkerFactory();
            const engine = createWorkerAudioEngine(ctx, { createWorker: factory.create, timeoutMs: 1000 });
            const first = engine.analyze(new Uint8Array([1, 2, 3, 4]), 8000).then(() => null, (error: unknown) => error);
            await flush();
            expect(factory.workers.length).toBe(1);
            await vi.advanceTimersByTimeAsync(1001);
            expect(await first).toBeInstanceOf(AudioEngineTimeoutError);

            const second = engine.analyze(new Uint8Array([5, 6, 7, 8]), 8000);
            await flush();
            expect(factory.workers.length).toBe(2);
            const sent = factory.workers[1]!.posted[0]!;
            factory.workers[1]!.reply({ id: sent.id, ok: true, result: { sampleRate: 8000, channels: 1, duration: 1, peaks: [1] } });
            await expect(second).resolves.toMatchObject({ sampleRate: 8000 });
            engine.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects with the worker-reported error message', async () => {
        const ctx = stubCtx();
        const factory = fakeWorkerFactory();
        const engine = createWorkerAudioEngine(ctx, { createWorker: factory.create });
        const promise = engine.decode(new Uint8Array([1, 2, 3, 4]));
        await vi.waitFor(() => expect(factory.workers[0]?.posted.length).toBe(1));
        const sent = factory.workers[0]!.posted[0]!;
        factory.workers[0]!.reply({ id: sent.id, ok: false, error: 'audio engine: unsupported or corrupted stream' });
        await expect(promise).rejects.toThrow(/unsupported or corrupted/);
        engine.dispose();
    });

    // Two requests racing startup must share one worker. Two workers would
    // mean the timeout terminates whichever was stored last, leaving the
    // actually-stuck one running unreferenced.
    it('creates a single worker for concurrent first requests', async () => {
        const factory = fakeWorkerFactory();
        const engine = createWorkerAudioEngine(stubCtx(), { createWorker: factory.create });
        const a = engine.analyze(new Uint8Array([1, 2, 3, 4]), 10).catch(() => undefined);
        const b = engine.analyze(new Uint8Array([5, 6, 7, 8]), 10).catch(() => undefined);
        await vi.waitFor(() => expect(factory.workers[0]?.posted.length).toBe(2));
        expect(factory.workers).toHaveLength(1);
        engine.dispose();
        await Promise.all([a, b]);
    });

    it('rejects new requests after dispose instead of spawning again', async () => {
        const factory = fakeWorkerFactory();
        const engine = createWorkerAudioEngine(stubCtx(), { createWorker: factory.create });
        engine.dispose();
        await expect(engine.analyze(new Uint8Array([1, 2, 3, 4]), 10)).rejects.toThrow(/disposed/);
        expect(factory.workers).toHaveLength(0);
    });

    it('terminates the worker on dispose', async () => {
        const ctx = stubCtx();
        const factory = fakeWorkerFactory();
        const engine = createWorkerAudioEngine(ctx, { createWorker: factory.create });
        void engine.analyze(new Uint8Array([1, 2, 3, 4]), 10).catch(() => undefined);
        await vi.waitFor(() => expect(factory.workers.length).toBe(1));
        engine.dispose();
        expect(factory.workers[0]!.terminated).toBe(1);
    });
});
