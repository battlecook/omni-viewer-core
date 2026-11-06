import { MountAbortedError } from '../types.js';

/** Reject immediately on cancellation and release acquisitions completing later. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, late: (value: T) => void = () => undefined): Promise<T> {
    return new Promise((resolve, reject) => {
        let cancelled = false;
        const abort = () => { cancelled = true; signal?.removeEventListener('abort', abort); reject(new MountAbortedError()); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        promise.then(value => {
            signal?.removeEventListener('abort', abort);
            if (cancelled) late(value); else resolve(value);
        }, error => { signal?.removeEventListener('abort', abort); if (!cancelled) reject(error); });
    });
}
