// Runs the spectrogram FFT in a Worker.
//
// The transform is the one piece of the windowed renderer that is pure CPU, and
// on the calling thread every batch of it is time the page cannot scroll or
// paint. A worker takes it off that thread entirely.
//
// The worker is an optimization, never a requirement: a host that does not
// serve the two assets, or whose CSP refuses the worker, gets the same picture
// computed in place. The view already slices that work, so the fallback is
// slower to finish but does not freeze either.

import type { HostContext, WorkerFactoryService } from '../../host/index.js';
import { computeSpectrogram, type Spectrogram, type SpectrogramOptions } from './spectrogram.js';
import type { SpectrogramCompute } from './spectrogram-view.js';

export type SpectrogramWorkerContext = HostContext & { workerFactory?: WorkerFactoryService };

/** Asset path of the worker shell, resolved through `AssetService`. */
export const SPECTROGRAM_WORKER_ASSET_KEY = 'audio-engine/spectrogram_worker.mjs';
/** Asset path of the transform itself: the compiled `spectrogram.ts`, which the
 *  shell imports so the worker and the fallback can never drift apart. */
export const SPECTROGRAM_KERNEL_ASSET_KEY = 'audio-engine/spectrogram_kernel.mjs';

/** A batch is a few milliseconds of work; anything near this is a dead worker. */
export const SPECTROGRAM_WORKER_DEFAULT_TIMEOUT_MS = 10_000;

export interface SpectrogramComputerOptions {
    timeoutMs?: number;
    /** Overrides both `ctx.workerFactory` and the built-in constructor.
     *  Receives the resolved asset URL. */
    createWorker?(url: string): Worker;
}

export interface SpectrogramComputer {
    compute: SpectrogramCompute;
    dispose(): void;
}

interface Job {
    samples: Float32Array;
    sampleRate: number;
    options: SpectrogramOptions;
    resolve(value: Spectrogram): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * Creates a {@link SpectrogramCompute} backed by a worker, falling back to the
 * calling thread for good the first time the worker proves unusable.
 */
export function createSpectrogramComputer(
    ctx: SpectrogramWorkerContext,
    options: SpectrogramComputerOptions = {}
): SpectrogramComputer {
    const timeoutMs = options.timeoutMs ?? SPECTROGRAM_WORKER_DEFAULT_TIMEOUT_MS;
    let worker: Worker | undefined;
    let kernelUrl = '';
    let starting: Promise<boolean> | undefined;
    /** Set once the worker has failed; nothing is sent to it again. */
    let unusable = typeof Worker === 'undefined' && !options.createWorker && !ctx.workerFactory;
    let disposed = false;
    let nextId = 1;
    const jobs = new Map<number, Job>();

    const inPlace = (job: Pick<Job, 'samples' | 'sampleRate' | 'options'>): Spectrogram =>
        computeSpectrogram(job.samples, job.sampleRate, job.options);

    /** Gives up on the worker and finishes whatever it still owed in place. */
    const abandon = (reason: string): void => {
        if (!unusable && !disposed) {
            ctx.logger.log('warn', `audio: spectrogram worker unavailable, computing in place (${reason})`);
        }
        unusable = true;
        worker?.terminate();
        worker = undefined;
        for (const [, job] of jobs) {
            clearTimeout(job.timer);
            try { job.resolve(inPlace(job)); } catch (error) { job.reject(error as Error); }
        }
        jobs.clear();
    };

    const start = async (): Promise<boolean> => {
        try {
            const [workerUrl, resolvedKernel] = await Promise.all([
                ctx.assets.resolveAssetUrl(SPECTROGRAM_WORKER_ASSET_KEY),
                ctx.assets.resolveAssetUrl(SPECTROGRAM_KERNEL_ASSET_KEY)
            ]);
            if (disposed) return false;
            kernelUrl = resolvedKernel;
            const spawn = options.createWorker
                ?? (ctx.workerFactory ? (url: string): Worker => ctx.workerFactory!.createWorker(url) : undefined)
                ?? ((url: string): Worker => new Worker(url, { type: 'module' }));
            const created = spawn(workerUrl);
            created.onmessage = (event: MessageEvent): void => {
                const { id, ok, result, error } = event.data as
                    { id: number; ok: boolean; result?: Spectrogram; error?: string };
                const job = jobs.get(id);
                if (!job) return;
                if (!ok || !result) {
                    // The job stays queued so `abandon` recomputes it in place.
                    abandon(error ?? 'worker failed');
                    return;
                }
                jobs.delete(id);
                clearTimeout(job.timer);
                job.resolve(result);
            };
            created.onerror = (event: ErrorEvent): void => abandon(event.message || 'worker error');
            worker = created;
            return true;
        } catch (error) {
            abandon(error instanceof Error ? error.message : String(error));
            return false;
        }
    };

    return {
        async compute(samples, sampleRate, analysis) {
            if (unusable || disposed) return computeSpectrogram(samples, sampleRate, analysis);
            starting ??= start();
            if (!(await starting) || !worker || unusable) return computeSpectrogram(samples, sampleRate, analysis);
            const id = nextId++;
            const active = worker;
            return new Promise<Spectrogram>((resolve, reject) => {
                const timer = setTimeout(() => abandon(`no reply within ${timeoutMs}ms`), timeoutMs);
                jobs.set(id, { samples, sampleRate, options: analysis, resolve, reject, timer });
                // Not transferred: if the worker dies, the fallback still needs
                // the samples to finish this job in place.
                active.postMessage({ id, kernelUrl, samples, sampleRate, options: analysis });
            });
        },
        dispose(): void {
            disposed = true;
            worker?.terminate();
            worker = undefined;
            for (const [, job] of jobs) {
                clearTimeout(job.timer);
                job.reject(new Error('spectrogram: disposed'));
            }
            jobs.clear();
        }
    };
}
