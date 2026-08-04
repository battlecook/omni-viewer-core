// Worker-backed AudioDecodeEngine.
//
// The engine's decode is a synchronous WASM call. On the main thread that
// makes every decode a UI stall proportional to file size — and an
// unrecoverable freeze when the decoder does not terminate at all (measured:
// the committed artifact infinite-loops on MPEG-1 Layer III stereo MP3, i.e.
// ordinary 44.1 kHz stereo, so any MP3 over `engineAnalyzeBytes` hangs the
// tab). Off the main thread both problems become survivable: the UI stays
// live, and a request that overruns `timeoutMs` is ended by terminating the
// worker, which is the only way to stop a spinning WASM loop.

import type { HostContext, WorkerFactoryService } from '../../host/index.js';
import type { AudioAnalysis, AudioDecodeEngine, DecodedAudio } from './engine.js';

/** Worker creation is the adapter's job (ADR 22): URL scheme, module/classic
 *  and CSP `worker-src` differ per platform and the core cannot absorb them. */
export type WorkerAudioEngineContext = HostContext & { workerFactory?: WorkerFactoryService };

/** Asset path of the worker shell, resolved through `AssetService`.
 *  Mirrors `PDF_WORKER_ASSET_KEY`. */
export const AUDIO_WORKER_ASSET_KEY = 'audio-engine/audio_engine_worker.mjs';
const MODULE_ASSET_KEY = 'audio-engine/audio_engine.mjs';
const WASM_ASSET_KEY = 'audio-engine/audio_engine.wasm';

/** Generous enough that a legitimate multi-minute decode is not cut short,
 *  short enough that a non-terminating one does not look like a dead viewer. */
export const AUDIO_WORKER_DEFAULT_TIMEOUT_MS = 30_000;

export class AudioEngineTimeoutError extends Error {
    override readonly name = 'AudioEngineTimeoutError';
    constructor(ms: number) {
        super(`audio engine: worker exceeded ${ms}ms and was terminated`);
    }
}

/**
 * The worker could not be started at all — the asset key is not registered, the
 * URL will not resolve, or construction is blocked (CSP). Distinct from a
 * decode failure or a timeout because it says nothing about the file: callers
 * can retry the same work in-process instead of losing the capability.
 */
export class AudioWorkerUnavailableError extends Error {
    override readonly name = 'AudioWorkerUnavailableError';
    constructor(cause: unknown) {
        super(`audio engine: worker unavailable (${cause instanceof Error ? cause.message : String(cause)})`);
    }
}

export interface WorkerAudioEngineOptions {
    /** Requests running longer than this terminate the worker. */
    timeoutMs?: number;
    /** Overrides both `ctx.workerFactory` and the built-in constructor.
     *  Receives the resolved asset URL. */
    createWorker?(url: string): Worker;
}

interface Pending {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * Creates an {@link AudioDecodeEngine} that runs the WASM engine in a Worker.
 * A terminated worker is not reused — the next call builds a fresh one, so one
 * bad file does not disable the engine for the rest of the session.
 */
/** One worker plus everything that belongs to it. Keeping requests with their
 *  own session is what makes termination precise: a timeout must kill the
 *  worker that owns the stuck request, not whichever one happens to be current. */
interface Session {
    worker: Worker;
    moduleUrl: string;
    wasmUrl: string;
    pending: Map<number, Pending>;
    terminated: boolean;
}

export function createWorkerAudioEngine(
    ctx: WorkerAudioEngineContext,
    options: WorkerAudioEngineOptions = {}
): AudioDecodeEngine & { dispose(): void } {
    const timeoutMs = options.timeoutMs ?? AUDIO_WORKER_DEFAULT_TIMEOUT_MS;
    const spawn = options.createWorker
        ?? (ctx.workerFactory ? (url: string): Worker => ctx.workerFactory!.createWorker(url) : undefined)
        // Last resort. Hosts whose CSP or URL scheme rules this out should
        // supply `workerFactory`; the caller falls back to the in-process
        // engine if construction throws here.
        ?? ((url: string): Worker => new Worker(url, { type: 'module' }));

    let session: Session | undefined;
    /** Shared across concurrent callers so one startup produces one worker. */
    let starting: Promise<Session> | undefined;
    let nextId = 1;
    let disposed = false;

    const endSession = (target: Session, error: Error): void => {
        if (target.terminated) return;
        target.terminated = true;
        target.worker.terminate();
        if (session === target) session = undefined;
        if (starting) starting = undefined;
        for (const [, entry] of target.pending) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        target.pending.clear();
    };

    async function start(): Promise<Session> {
        let workerUrl: string;
        let moduleUrl: string;
        let wasmUrl: string;
        let worker: Worker;
        try {
            [workerUrl, moduleUrl, wasmUrl] = await Promise.all([
                ctx.assets.resolveAssetUrl(AUDIO_WORKER_ASSET_KEY),
                ctx.assets.resolveAssetUrl(MODULE_ASSET_KEY),
                ctx.assets.resolveAssetUrl(WASM_ASSET_KEY)
            ]);
            worker = spawn(workerUrl);
        } catch (error) {
            // Not the file's fault — surface it as a capability problem so the
            // caller can fall back to the in-process engine.
            throw new AudioWorkerUnavailableError(error);
        }
        const created: Session = {
            worker,
            moduleUrl,
            wasmUrl,
            pending: new Map<number, Pending>(),
            terminated: false
        };
        created.worker.onmessage = (event: MessageEvent): void => {
            const { id, ok, result, error } = event.data as
                { id: number; ok: boolean; result?: unknown; error?: string };
            const entry = created.pending.get(id);
            if (!entry) return;
            created.pending.delete(id);
            clearTimeout(entry.timer);
            if (ok) entry.resolve(result);
            else entry.reject(new Error(error ?? 'audio engine: worker failed'));
        };
        created.worker.onerror = (event: ErrorEvent): void => {
            ctx.logger.log('error', `audio engine worker: ${event.message}`);
            endSession(created, new Error(`audio engine: worker failed (${event.message})`));
        };
        if (disposed) {
            // Disposed while the assets were resolving.
            endSession(created, new Error('audio engine: disposed'));
            throw new Error('audio engine: disposed');
        }
        session = created;
        return created;
    }

    function ensureSession(): Promise<Session> {
        if (session && !session.terminated) return Promise.resolve(session);
        starting ??= start().finally(() => { starting = undefined; });
        return starting;
    }

    async function request<T>(op: 'analyze' | 'decode', data: Uint8Array, width?: number): Promise<T> {
        if (disposed) throw new Error('audio engine: disposed');
        const active = await ensureSession();
        const id = nextId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                active.pending.delete(id);
                // A spinning WASM loop ignores messages, so termination is the
                // only exit. Everything queued on that worker dies with it.
                ctx.logger.log('error', `audio engine: ${op} exceeded ${timeoutMs}ms, terminating worker`);
                const error = new AudioEngineTimeoutError(timeoutMs);
                endSession(active, error);
                reject(error);
            }, timeoutMs);
            active.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
            // `inputOwnership` for audio is 'borrows', so the caller's buffer
            // must survive this call — send a copy rather than transferring.
            active.worker.postMessage(
                { id, op, moduleUrl: active.moduleUrl, wasmUrl: active.wasmUrl, bytes: data.slice(), width },
                []
            );
        });
    }

    return {
        decode: (data) => request<DecodedAudio>('decode', data),
        analyze: (data, width) => request<AudioAnalysis>('analyze', data, width),
        dispose(): void {
            disposed = true;
            if (session) endSession(session, new Error('audio engine: disposed'));
        }
    };
}
