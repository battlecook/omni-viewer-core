import type { ParseOutcome, ParseOptions, ResourceLimits } from '../types.js';
import type { ArchiveDecoder, ArchiveDocument, ArchiveStreamDecoder, OpenArchiveHandle } from './model.js';
export * from './model.js';
export const ARCHIVE_DEFAULT_LIMITS = { maxInputBytes: 256 * 1024 * 1024, maxEntries: 100_000, maxDecompressedBytes: 1024 * 1024 * 1024, maxPreviewBytes: 8 * 1024 * 1024, maxHexBytes: 4096 } as const;
export class ArchiveError extends Error { constructor(readonly code: 'invalid-format'|'corrupted'|'password-required'|'limit-exceeded'|'aborted'|'missing-dependency', readonly messageKey: string) { super(messageKey); } }
export interface ArchiveParseOptions extends ParseOptions { fileName?: string; }
export interface ArchiveStreamOptions { fileName?: string; totalSize?: number; signal?: AbortSignal; limits?: ResourceLimits; }
export async function parseArchive(data: Uint8Array, decoder: ArchiveDecoder, options: ArchiveParseOptions = {}): Promise<{ outcome: ParseOutcome<ArchiveDocument>; handle?: OpenArchiveHandle }> {
    const started=Date.now(); const max=options.limits?.maxInputBytes ?? ARCHIVE_DEFAULT_LIMITS.maxInputBytes;
    if (data.byteLength > max) return failed('limit-exceeded','diag.archive.limit-exceeded',started,false,true);
    if (options.signal?.aborted) return failed('aborted','diag.aborted',started,true,true);
    if (options.fileName?.toLowerCase().endsWith('.dmg') && !hasDmgTrailer(data)) return failed('invalid-format', 'diag.archive.invalid-format', started);
    try { const raw=await decoder.openArchive(data,openOptionsFrom(options.limits,options.signal)); return finalizeOpen(raw, options.limits, started); } catch (error) { return openError(error, started); }
}
/** Streaming counterpart of {@link parseArchive}: the adapter's path-based
 *  decoder opens the archive without core ever holding the full bytes. The
 *  returned handle is still wrapped with the decompressed-bytes budget, so the
 *  zip-bomb guard and per-entry limits stay in force on the streaming path. */
export async function openArchiveStream(source: ArchiveStreamDecoder, options: ArchiveStreamOptions = {}): Promise<{ outcome: ParseOutcome<ArchiveDocument>; handle?: OpenArchiveHandle }> {
    const started=Date.now();
    // maxInputBytes is a *buffering* guard: the streaming path never holds the
    // whole file, so it is only enforced when the caller sets it explicitly
    // (no default). Otherwise a multi-GB archive — exactly what streaming is
    // for — would be rejected. Per-entry memory stays bounded by limitHandle
    // (maxDecompressedBytes) and the viewer's preview caps.
    const declaredMax = options.limits?.maxInputBytes;
    if (declaredMax !== undefined && options.totalSize !== undefined && options.totalSize > declaredMax) return failed('limit-exceeded','diag.archive.limit-exceeded',started,false,true);
    if (options.signal?.aborted) return failed('aborted','diag.aborted',started,true,true);
    try { const raw=await source.openArchive(openOptionsFrom(options.limits,options.signal)); return finalizeOpen(raw, options.limits, started); } catch (error) { return openError(error, started); }
}
function openOptionsFrom(limits: ResourceLimits | undefined, signal: AbortSignal | undefined): { maxEntries: number; maxDecompressedBytes: number; signal?: AbortSignal } { return { maxEntries: limits?.maxEntries ?? ARCHIVE_DEFAULT_LIMITS.maxEntries, maxDecompressedBytes: limits?.maxDecompressedBytes ?? ARCHIVE_DEFAULT_LIMITS.maxDecompressedBytes, ...(signal ? { signal } : {}) }; }
function finalizeOpen(raw: OpenArchiveHandle, limits: ResourceLimits | undefined, started: number): { outcome: ParseOutcome<ArchiveDocument>; handle: OpenArchiveHandle } {
    const maxEntries = limits?.maxEntries ?? ARCHIVE_DEFAULT_LIMITS.maxEntries;
    const entries = raw.entries.slice(0, maxEntries); const partial = entries.length !== raw.entries.length;
    const handle = limitHandle(raw, limits?.maxDecompressedBytes ?? ARCHIVE_DEFAULT_LIMITS.maxDecompressedBytes);
    return { handle, outcome:{result: partial ? {status:'partial',document:{entries},diagnostics:[{severity:'warning',code:'archive.limit-exceeded',messageKey:'diag.archive.limit-exceeded'}]} : {status:'ok',document:{entries},diagnostics:[]},execution:{workerUsed:false,hardLimitEnforced:false,elapsedMillis:Date.now()-started}} };
}
function openError(error: unknown, started: number): { outcome: ParseOutcome<ArchiveDocument> } { const known=error instanceof ArchiveError ? error : new ArchiveError('invalid-format','diag.archive.invalid-format'); return { outcome:{result:{status:'failed',failure:{code:known.code,retryable:known.code==='aborted'||known.code==='password-required',messageKey:known.messageKey},diagnostics:[]},execution:{workerUsed:false,hardLimitEnforced:false,elapsedMillis:Date.now()-started}} }; }
function failed(code: ArchiveError['code'], messageKey: string, started: number, retryable = false, hardLimitEnforced = true): { outcome: ParseOutcome<ArchiveDocument> } { return { outcome: { result: { status: 'failed', failure: { code, retryable, messageKey }, diagnostics: [] }, execution: { workerUsed: false, hardLimitEnforced, elapsedMillis: Date.now() - started } } }; }
function hasDmgTrailer(data: Uint8Array): boolean { return data.byteLength >= 512 && [0x6b,0x6f,0x6c,0x79].every((x,i) => data[data.byteLength - 512 + i] === x); }
function limitHandle(raw: OpenArchiveHandle, maxTotal: number): OpenArchiveHandle { let used = 0; let reserved = 0; return { entries: raw.entries, async extract(id, opts) { const allowance=Math.min(opts.maxBytes,maxTotal-used-reserved); if (allowance <= 0) throw new ArchiveError('limit-exceeded','diag.archive.limit-exceeded'); reserved += allowance; try { const bytes=await raw.extract(id,{...opts,maxBytes:allowance}); used += bytes.byteLength; if (bytes.byteLength > allowance || used > maxTotal) throw new ArchiveError('limit-exceeded','diag.archive.limit-exceeded'); return bytes; } finally { reserved -= allowance; } }, close: () => raw.close() }; }
