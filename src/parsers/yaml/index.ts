import type { ParseOutcome, ParseResult, Diagnostic } from '../types.js';
import { decodeUtf8, utf8ByteLength } from '../types.js';
import type { YamlDocument, YamlNode, YamlParserDeps } from './model.js';
export * from './model.js';
export const YAML_INPUT_OWNERSHIP = 'borrows' as const;
export interface YamlParseOptions { deps?: YamlParserDeps; limits?: { maxInputBytes?: number; maxEntries?: number; maxDocuments?: number; maxDepth?: number; maxAliases?: number }; signal?: AbortSignal; }
export function parseYaml(input: Uint8Array | string, options: YamlParseOptions = {}): ParseOutcome<YamlDocument> {
 const started = Date.now(); const bytes = typeof input === 'string' ? utf8ByteLength(input) : input.byteLength; const max = options.limits?.maxInputBytes ?? 10 * 1024 * 1024;
 const finish = (result: ParseResult<YamlDocument>): ParseOutcome<YamlDocument> => ({ result, execution: { workerUsed: false, hardLimitEnforced: false, elapsedMillis: Date.now() - started } });
 if (bytes > max) return finish({ status: 'failed', failure: { code: 'limit-exceeded', retryable: false, messageKey: 'diag.limit-exceeded.input', args: { maxBytes: max } }, diagnostics: [] });
 if (options.signal?.aborted) return finish({ status: 'failed', failure: { code: 'aborted', retryable: true, messageKey: 'diag.aborted' }, diagnostics: [] });
 if (!options.deps) return finish({ status: 'failed', failure: { code: 'missing-dependency', retryable: true, messageKey: 'diag.yaml.missing-dependency' }, diagnostics: [] });
 const text = typeof input === 'string' ? input : decodeUtf8(input); const diagnostics: Diagnostic[] = [];
 try { const ast = options.deps.parse(text); const maxDocs = options.limits?.maxDocuments ?? 100; const docs: YamlNode[] = []; const duplicates: Array<{ path: string; key: string }> = [];
   for (let i = 0; i < Math.min(ast.length, maxDocs); i++) {
     if (options.signal?.aborted) return finish(docs.length ? { status: 'partial', document: { text, documents: docs }, diagnostics: [...diagnostics, { severity: 'warning', code: 'yaml.aborted', messageKey: 'diag.aborted' }] } : { status: 'failed', failure: { code: 'aborted', retryable: true, messageKey: 'diag.aborted' }, diagnostics });
     const sourceDoc = ast[i]; const errors = (sourceDoc as { errors?: readonly { linePos?: readonly { line: number; col: number }[] }[] } | undefined)?.errors ?? [];
     for (const error of errors) { const pos = error.linePos?.[0]; diagnostics.push({ severity: 'error', code: 'yaml.invalid', messageKey: 'diag.yaml.invalid', location: pos ? `line:${pos.line}:${pos.col}` : `document:${i + 1}` }); }
     const node = options.deps.normalize ? options.deps.normalize(sourceDoc, i) : normalizeUnknown(sourceDoc, `$doc[${i}]`);
     const violation = validateTree(node, options.limits?.maxEntries ?? 100_000, options.limits?.maxDepth ?? 100, options.limits?.maxAliases ?? 10_000, duplicates);
     if (violation) diagnostics.push({ severity: 'warning', code: violation, messageKey: `diag.${violation}`, location: `document:${i + 1}` });
     docs.push(node);
   }
   for (const duplicate of duplicates) diagnostics.push({ severity: 'warning', code: 'yaml.duplicate-key', messageKey: 'diag.yaml.duplicate-key', args: { key: duplicate.key }, location: duplicate.path });
   if (ast.length > maxDocs) diagnostics.push({ severity: 'warning', code: 'yaml.document-limit', messageKey: 'diag.yaml.document-limit', args: { count: maxDocs } });
   return finish(diagnostics.length ? { status: 'partial', document: { text, documents: docs }, diagnostics } : { status: 'ok', document: { text, documents: docs }, diagnostics });
 } catch (error) { return finish({ status: 'failed', failure: { code: 'invalid-format', retryable: false, messageKey: 'diag.yaml.invalid' }, diagnostics: [{ severity: 'error', code: 'yaml.invalid', messageKey: 'diag.yaml.invalid', location: String(error) }] }); }
}
function normalizeUnknown(value: unknown, path: string, key = '$'): YamlNode { if (Array.isArray(value)) return { kind: 'seq', key, path, children: value.map((v, i) => normalizeUnknown(v, `${path}[${i}]`, String(i))) }; if (value !== null && typeof value === 'object') return { kind: 'map', key, path, children: Object.entries(value as Record<string, unknown>).map(([k, v]) => normalizeUnknown(v, `${path}.${k}`, k)) }; return { kind: 'scalar', key, path, value: value as string | boolean | number | null, raw: String(value) }; }
const MAX_DUPLICATE_KEY_DIAGNOSTICS = 20;
function validateTree(root: YamlNode, maxNodes: number, maxDepth: number, maxAliases: number, duplicates: Array<{ path: string; key: string }>): string | null { let nodes = 0, aliases = 0; const stack: Array<{ node: YamlNode; depth: number }> = [{ node: root, depth: 0 }]; while (stack.length) { const item = stack.pop()!; nodes++; if (nodes > maxNodes) return 'yaml.node-limit'; if (item.depth > maxDepth) return 'yaml.depth-limit'; if (item.node.kind === 'alias' && ++aliases > maxAliases) return 'yaml.alias-limit'; if (item.node.kind === 'map' && item.node.children) { const seen = new Set<string>(); for (const child of item.node.children) { if (seen.has(child.key) && duplicates.length < MAX_DUPLICATE_KEY_DIAGNOSTICS && !duplicates.some(d => d.path === item.node.path && d.key === child.key)) duplicates.push({ path: item.node.path, key: child.key }); seen.add(child.key); } } for (const child of item.node.children ?? []) stack.push({ node: child, depth: item.depth + 1 }); } return null; }
