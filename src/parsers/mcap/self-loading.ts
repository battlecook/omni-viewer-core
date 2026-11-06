import { decodeLz4Frame } from '../arrow/lz4.js';
import { parseMcap, type McapParseDeps, type McapParseOptions, type McapDocument } from './index.js';
import type { ParseOutcome } from '../types.js';
import { decodeZstdFrames } from './zstd.js';
export * from './index.js';

/** Optional peers are resolved only through this explicit entry. */
export async function loadMcapDeps(): Promise<McapParseDeps> {
    const [lz4, zstd] = await Promise.all([
        Promise.all([import('lz4js'), import('lz4js/xxh32.js')]).catch(() => undefined),
        import('fzstd').catch(() => undefined)
    ]);
    return {
        ...(lz4 ? { decompressLz4: (data: Uint8Array, expectedBytes: number) => decodeLz4Frame(data, expectedBytes, lz4[0], lz4[1].hash) } : {}),
        ...(zstd ? { decompressZstd: (data: Uint8Array, expectedBytes: number, maxWindowBytes = 256 * 1024 * 1024) => decodeZstdFrames(data, expectedBytes, zstd, maxWindowBytes) } : {})
    };
}

export async function parseSelfLoadingMcap(input: Uint8Array, options: McapParseOptions = {}): Promise<ParseOutcome<McapDocument>> {
    if (options.signal?.aborted) return parseMcap(input, {}, options);
    const deps = await loadMcapDeps();
    return parseMcap(input, deps, options);
}
