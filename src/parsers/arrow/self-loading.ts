import type { ArrowDocument, ArrowParseDeps, ArrowParseOptions } from './index.js';
import { parseArrow } from './index.js';
import type { ParseOutcome } from '../types.js';
import { decodeLz4Frame } from './lz4.js';

export * from './index.js';

/** Optional peers are only resolved by this explicit opt-in entry. */
export async function loadArrowDeps(): Promise<ArrowParseDeps> {
    const arrow = await import('apache-arrow');
    const [lz4, zstd] = await Promise.all([
        Promise.all([import('lz4js'), import('lz4js/xxh32.js')]).catch(() => undefined),
        import('fzstd').catch(() => undefined)
    ]);
    return {
        arrow,
        ...(lz4 ? { decompressLz4: (data: Uint8Array, expectedBytes: number) => decodeLz4Frame(data, expectedBytes, lz4[0], lz4[1].hash) } : {}),
        ...(zstd ? { decompressZstd: (data: Uint8Array, expectedBytes: number) => {
            const output = new Uint8Array(expectedBytes);
            let written = 0;
            const decoder = new zstd.Decompress(chunk => {
                if (chunk.length > expectedBytes - written) throw new Error('Invalid ZSTD output length');
                output.set(chunk, written);
                written += chunk.length;
            });
            decoder.push(data, true);
            if (written !== expectedBytes) throw new Error('Invalid ZSTD output length');
            return output;
        } } : {})
    };
}

export async function parseSelfLoadingArrow(input: Uint8Array, options: ArrowParseOptions = {}): Promise<ParseOutcome<ArrowDocument>> {
    if (options.signal?.aborted) return {
        result: { status: 'failed', failure: { code: 'aborted', retryable: true, messageKey: 'diag.aborted' }, diagnostics: [] },
        execution: { workerUsed: false, hardLimitEnforced: false, elapsedMillis: 0 }
    };
    let deps: ArrowParseDeps;
    try { deps = await loadArrowDeps(); }
    catch { return {
        result: { status: 'failed', failure: { code: 'missing-dependency', retryable: true, messageKey: 'diag.arrow.dependency' }, diagnostics: [] },
        execution: { workerUsed: false, hardLimitEnforced: false, elapsedMillis: 0 }
    }; }
    return parseArrow(input, deps, options);
}
