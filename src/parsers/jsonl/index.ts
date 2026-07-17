import type { ParseOutcome, ParseResult } from '../types.js';
import { decodeUtf8, utf8ByteLength } from '../types.js';
import { parseJsonlText } from './parse.js';
import type { JsonlDocument } from './model.js';
export * from './model.js'; export { parseJsonlText } from './parse.js';
export const JSONL_INPUT_OWNERSHIP = 'borrows' as const;
export interface JsonlParseOptions { limits?: { maxInputBytes?: number; maxEntries?: number; maxLineBytes?: number }; signal?: AbortSignal; }
export function parseJsonl(input: Uint8Array | string, options: JsonlParseOptions = {}): ParseOutcome<JsonlDocument> {
 const started = Date.now(), max = options.limits?.maxInputBytes ?? 256 * 1024 * 1024, bytes = typeof input === 'string' ? utf8ByteLength(input) : input.byteLength;
 const finish = (result: ParseResult<JsonlDocument>): ParseOutcome<JsonlDocument> => ({ result, execution: { workerUsed: false, hardLimitEnforced: false, elapsedMillis: Date.now() - started } });
 if (bytes > max) return finish({ status: 'failed', failure: { code: 'limit-exceeded', retryable: false, messageKey: 'diag.limit-exceeded.input', args: { maxBytes: max } }, diagnostics: [] });
 if (options.signal?.aborted) return finish({ status: 'failed', failure: { code: 'aborted', retryable: true, messageKey: 'diag.aborted' }, diagnostics: [] });
 const parsed = parseJsonlText(typeof input === 'string' ? input : decodeUtf8(input), options.limits?.maxEntries ?? 1_000_000);
 const long = parsed.document.entries.find(e => utf8ByteLength(e.raw) > (options.limits?.maxLineBytes ?? 1024 * 1024));
 if (long) parsed.diagnostics.push({ severity: 'warning', code: 'jsonl.line-limit', messageKey: 'diag.jsonl.line-limit', args: { line: long.line }, location: `line:${long.line}` });
 return finish(parsed.limited || parsed.diagnostics.length ? { status: 'partial', document: parsed.document, diagnostics: parsed.diagnostics } : { status: 'ok', document: parsed.document, diagnostics: [] });
}
