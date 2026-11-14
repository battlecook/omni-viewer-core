import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostContext } from '../../host/index.js';
import { computeSpectrogram } from './spectrogram.js';
import {
    SPECTROGRAM_KERNEL_ASSET_KEY,
    SPECTROGRAM_WORKER_ASSET_KEY,
    createSpectrogramComputer
} from './spectrogram-worker.js';

const RATE = 44100;
const OPTIONS = { fftSize: 256, hopSize: 256, bins: 16 };

function tone(windows: number): Float32Array {
    const samples = new Float32Array(windows * 256);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 5) * 0.6;
    return samples;
}

function ctx(logs: string[] = [], resolve = async (key: string) => `asset:${key}`): HostContext {
    return {
        assets: { resolveAssetUrl: resolve },
        i18n: { t: (key: string) => key } as HostContext['i18n'],
        logger: { log: (_level, message) => { logs.push(message); } }
    };
}

/** Worker double. `reply` decides what, if anything, comes back per message. */
class FakeWorker {
    static built: FakeWorker[] = [];
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    posted: Array<Record<string, unknown>> = [];
    terminated = false;
    constructor(public url: string, private reply: (worker: FakeWorker, message: Record<string, unknown>) => void) {
        FakeWorker.built.push(this);
    }
    postMessage(message: Record<string, unknown>): void {
        this.posted.push(message);
        queueMicrotask(() => this.reply(this, message));
    }
    terminate(): void { this.terminated = true; }
    answer(message: Record<string, unknown>): void {
        const result = computeSpectrogram(message.samples as Float32Array, message.sampleRate as number, message.options as typeof OPTIONS);
        this.onmessage?.({ data: { id: message.id, ok: true, result } } as MessageEvent);
    }
}

const spawn = (reply: (worker: FakeWorker, message: Record<string, unknown>) => void) =>
    (url: string): Worker => new FakeWorker(url, reply) as unknown as Worker;

afterEach(() => {
    FakeWorker.built = [];
    vi.useRealTimers();
});

describe('spectrogram computer', () => {
    it('computes in the worker and hands it the kernel to import', async () => {
        const computer = createSpectrogramComputer(ctx(), { createWorker: spawn((worker, message) => worker.answer(message)) });
        const samples = tone(4);
        const result = await computer.compute(samples, RATE, OPTIONS);

        expect(result).toEqual(computeSpectrogram(samples, RATE, OPTIONS));
        expect(FakeWorker.built).toHaveLength(1);
        expect(FakeWorker.built[0]!.url).toBe(`asset:${SPECTROGRAM_WORKER_ASSET_KEY}`);
        expect(FakeWorker.built[0]!.posted[0]!.kernelUrl).toBe(`asset:${SPECTROGRAM_KERNEL_ASSET_KEY}`);
        computer.dispose();
    });

    it('starts one worker for many batches', async () => {
        const computer = createSpectrogramComputer(ctx(), { createWorker: spawn((worker, message) => worker.answer(message)) });
        await Promise.all([1, 2, 3].map((windows) => computer.compute(tone(windows), RATE, OPTIONS)));
        expect(FakeWorker.built).toHaveLength(1);
        computer.dispose();
    });

    // The worker is an optimization. A host that does not serve its assets
    // must still get a spectrogram.
    it('computes in place when the assets cannot be resolved', async () => {
        const logs: string[] = [];
        const computer = createSpectrogramComputer(
            ctx(logs, async () => { throw new Error('not served'); }),
            { createWorker: spawn(() => undefined) }
        );
        const samples = tone(3);
        expect(await computer.compute(samples, RATE, OPTIONS)).toEqual(computeSpectrogram(samples, RATE, OPTIONS));
        expect(FakeWorker.built).toHaveLength(0);
        expect(logs.join('\n')).toMatch(/computing in place \(not served\)/);
        computer.dispose();
    });

    it('computes in place when the worker cannot be constructed', async () => {
        const computer = createSpectrogramComputer(ctx(), {
            createWorker: () => { throw new Error('blocked by CSP'); }
        });
        const samples = tone(2);
        expect(await computer.compute(samples, RATE, OPTIONS)).toEqual(computeSpectrogram(samples, RATE, OPTIONS));
        computer.dispose();
    });

    // A module worker whose script fails to load reports it only after the
    // first batch was already posted.
    it('finishes the batch in place when the worker fails after accepting it', async () => {
        const logs: string[] = [];
        const computer = createSpectrogramComputer(ctx(logs), {
            createWorker: spawn((worker) => worker.onerror?.({ message: 'script failed to load' } as ErrorEvent))
        });
        const samples = tone(3);
        expect(await computer.compute(samples, RATE, OPTIONS)).toEqual(computeSpectrogram(samples, RATE, OPTIONS));
        expect(FakeWorker.built[0]!.terminated).toBe(true);

        // And never goes back to it.
        await computer.compute(tone(1), RATE, OPTIONS);
        expect(FakeWorker.built).toHaveLength(1);
        expect(FakeWorker.built[0]!.posted).toHaveLength(1);
        expect(logs.filter((line) => line.includes('computing in place'))).toHaveLength(1);
        computer.dispose();
    });

    it('finishes the batch in place when the worker reports a failure', async () => {
        const computer = createSpectrogramComputer(ctx(), {
            createWorker: spawn((worker, message) =>
                worker.onmessage?.({ data: { id: message.id, ok: false, error: 'import failed' } } as MessageEvent))
        });
        const samples = tone(2);
        expect(await computer.compute(samples, RATE, OPTIONS)).toEqual(computeSpectrogram(samples, RATE, OPTIONS));
        computer.dispose();
    });

    it('gives up on a worker that never answers', async () => {
        vi.useFakeTimers();
        const computer = createSpectrogramComputer(ctx(), { createWorker: spawn(() => undefined), timeoutMs: 500 });
        const samples = tone(2);
        const pending = computer.compute(samples, RATE, OPTIONS);
        await vi.advanceTimersByTimeAsync(600);
        expect(await pending).toEqual(computeSpectrogram(samples, RATE, OPTIONS));
        expect(FakeWorker.built[0]!.terminated).toBe(true);
        computer.dispose();
    });

    it('terminates the worker on dispose', async () => {
        const computer = createSpectrogramComputer(ctx(), { createWorker: spawn((worker, message) => worker.answer(message)) });
        await computer.compute(tone(1), RATE, OPTIONS);
        computer.dispose();
        expect(FakeWorker.built[0]!.terminated).toBe(true);
    });
});
