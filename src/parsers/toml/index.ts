import type { ParseOutcome, ParseResult } from '../types.js';
import { DEFAULT_LIMITS, decodeUtf8, utf8ByteLength } from '../types.js';
import { parseTomlText } from './parse.js';
import type { TomlDocument } from './model.js';
export * from './model.js';
export { parseTomlText } from './parse.js';
export const TOML_INPUT_OWNERSHIP = 'borrows' as const;
export function parseToml(input: Uint8Array | string, options: { limits?: { maxInputBytes?: number; maxEntries?: number; maxTables?: number; maxArrayLength?: number }; signal?: AbortSignal; maxDepth?: number } = {}): ParseOutcome<TomlDocument> {
 const started = Date.now(); const bytes = typeof input === 'string' ? utf8ByteLength(input) : input.byteLength; const max = options.limits?.maxInputBytes ?? 10 * 1024 * 1024;
 const finish = (result: ParseResult<TomlDocument>): ParseOutcome<TomlDocument> => ({ result, execution: { workerUsed: false, hardLimitEnforced: false, elapsedMillis: Date.now() - started } });
 if (bytes > max) return finish({ status: 'failed', failure: { code: 'limit-exceeded', retryable: false, messageKey: 'diag.limit-exceeded.input', args: { maxBytes: max } }, diagnostics: [] });
 if (options.signal?.aborted) return finish({ status: 'failed', failure: { code: 'aborted', retryable: true, messageKey: 'diag.aborted' }, diagnostics: [] });
 const treeLimits = { ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }), ...(options.limits?.maxEntries === undefined ? {} : { maxNodes: options.limits.maxEntries }), ...(options.limits?.maxTables === undefined ? {} : { maxTables: options.limits.maxTables }), ...(options.limits?.maxArrayLength === undefined ? {} : { maxArrayLength: options.limits.maxArrayLength }), ...(options.signal ? { signal: options.signal } : {}) };
 const tree = parseTomlText(typeof input === 'string' ? input : decodeUtf8(input), treeLimits);
 return finish(tree.diagnostics.some(d => d.severity === 'error') ? { status: 'partial', document: tree.document, diagnostics: tree.diagnostics } : { status: 'ok', document: tree.document, diagnostics: tree.diagnostics });
}
