import type { Diagnostic } from '../types.js';
import { tomlPath, type TomlDocument, type TomlNode, type TomlRange, type TomlValueKind } from './model.js';

export interface TomlParseTree { document: TomlDocument; diagnostics: Diagnostic[]; }

/** A deliberately small, lossless TOML 1.0 reader. Values retain `raw` so
 * datetime and unsafe integers never pass through JavaScript Number. */
export interface TomlTreeLimits { maxDepth?: number; maxNodes?: number; maxTables?: number; maxArrayLength?: number; signal?: AbortSignal; }
export function parseTomlText(text: string, limits: TomlTreeLimits | number = {}): TomlParseTree {
    const settings: TomlTreeLimits = typeof limits === 'number' ? { maxDepth: limits } : limits;
    const maxDepth = settings.maxDepth ?? 100, maxNodes = settings.maxNodes ?? 100_000, maxTables = settings.maxTables ?? 50_000, maxArrayLength = settings.maxArrayLength ?? 100_000;
    const root: TomlNode = { kind: 'table', key: '$', path: '', raw: '', line: 1, range: { start: 0, end: text.length }, children: [] };
    const diagnostics: Diagnostic[] = [];
    let current = root, nodeCount = 1, tableCount = 1, stopped = false;
    const tables = new Map<string, TomlNode>([['', root]]);
    // Offsets stay relative to the untouched `text` so ranges address the same
    // string a host renders. A leading BOM is dropped by `trim()` instead.
    const lines = logicalTomlLines(text);
    const lineAt = lineIndexer(text);
    const error = (code: string, line: number) => diagnostics.push({ severity: 'error', code, messageKey: `diag.${code}`, location: `line:${line}` });
    const unquote = (value: string): string => {
        if (value.startsWith('"""') && value.endsWith('"""')) {
            // TOML multiline basic strings allow literal newlines. Reuse the
            // JSON escape decoder after making those newlines explicit.
            const body = value.slice(3, -3).replace(/^\r?\n/, '');
            try { return JSON.parse(`"${body.replace(/\r?\n/g, '\\n')}"`); } catch { return body; }
        }
        if (value.startsWith("'''") && value.endsWith("'''")) return value.slice(3, -3).replace(/^\r?\n/, '');
        if (value.startsWith('"') && value.endsWith('"')) {
            try { return JSON.parse(value); } catch { return value.slice(1, -1); }
        }
        if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
        return value;
    };
    /** Split on top-level commas, reporting where each trimmed part starts so
     * inline-table and array members can carry their own range. */
    const split = (value: string, base: number): Array<{ text: string; at: number }> => {
        const out: Array<{ text: string; at: number }> = []; let start = 0; let quote = ''; let depth = 0;
        const push = (from: number, to: number) => { const part = value.slice(from, to); const lead = part.length - part.trimStart().length; const trimmed = part.trim(); if (trimmed) out.push({ text: trimmed, at: base + from + lead }); };
        for (let i = 0; i < value.length; i++) { const c = value[i]; if (quote) { if (c === quote && value[i - 1] !== '\\') quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '[' || c === '{') depth++; else if (c === ']' || c === '}') depth--; else if (c === ',' && depth === 0) { push(start, i); start = i + 1; } }
        push(start, value.length); return out;
    };
    const keyParts = (key: string): string[] => splitKey(key).map(unquote);
    const makeValue = (key: string, path: string, rawValue: string, line: number, depth: number, start: number): TomlNode => {
        const raw = rawValue.trim();
        const from = start + (rawValue.length - rawValue.trimStart().length);
        const range: TomlRange = { start: from, end: from + raw.length };
        let kind: TomlValueKind = 'string'; let value: string | boolean = unquote(raw);
        if (/^(true|false)$/.test(raw)) { kind = 'boolean'; value = raw === 'true'; }
        else if (/^[+-]?(?:0x[\da-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*)$/.test(raw)) kind = 'integer';
        else if (/^[+-]?(?:\d[\d_]*\.\d[\d_]*|\d[\d_]*(?:\.\d[\d_]*)?[eE][+-]?\d[\d_]*|nan|inf)$/i.test(raw)) kind = 'float';
        else if (/^\d{4}-\d\d-\d\d(?:[Tt ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:[Zz]|[+-]\d\d:\d\d)?)?$|^\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(raw)) kind = 'datetime';
        else if (raw.startsWith('[') && raw.endsWith(']')) { kind = 'array'; const values = split(raw.slice(1, -1), from + 1); if (values.length > maxArrayLength) { error('toml.array-limit', line); values.length = maxArrayLength; } const children = values.map((entry, i) => makeValue(String(i), `${path}[${i}]`, entry.text, lineAt(entry.at), depth + 1, entry.at)); nodeCount += children.length; return { kind, key, path, raw, line, range, children }; }
        else if (raw.startsWith('{') && raw.endsWith('}')) { kind = 'table'; const children: TomlNode[] = []; for (const pair of split(raw.slice(1, -1), from + 1)) { const eq = indexOfEquals(pair.text); if (eq < 0) { error('toml.invalid-inline-table', lineAt(pair.at)); continue; } const childKey = unquote(pair.text.slice(0, eq).trim()); const child = makeValue(childKey, tomlPath(path, childKey), pair.text.slice(eq + 1), lineAt(pair.at), depth + 1, pair.at + eq + 1); child.range = { start: pair.at, end: pair.at + pair.text.length }; children.push(child); } return { kind, key, path, raw, line, range, children }; }
        if (depth > maxDepth) error('toml.max-depth', line); nodeCount++;
        return { kind, key, path, value, raw, line, range };
    };
    let pending: string[] = [];
    for (const logical of lines) {
        if (settings.signal?.aborted) { error('aborted', logical.line); stopped = true; break; }
        if (nodeCount > maxNodes || tableCount > maxTables) { error(nodeCount > maxNodes ? 'toml.node-limit' : 'toml.table-limit', logical.line); stopped = true; break; }
        const i = logical.line - 1;
        const uncommented = stripComment(logical.text);
        const trailing = commentBody(logical.text.slice(uncommented.length));
        const source = uncommented.trim();
        // Comment runs stay attached to the next declaration; a blank line ends
        // the run so a file-header comment never leaks onto unrelated keys.
        if (!source) { if (trailing === undefined) pending = []; else pending.push(trailing); continue; }
        const comment = [...pending, ...(trailing === undefined ? [] : [trailing])].join('\n') || undefined;
        pending = [];
        const base = logical.offset + (logical.text.length - logical.text.trimStart().length);
        const declaration: TomlRange = { start: base, end: base + source.length };
        const arrayTable = source.match(/^\[\[(.+)\]\]$/); const table = source.match(/^\[(.+)\]$/);
        if (arrayTable || table) {
            const matched = arrayTable ?? table;
            const parts = keyParts((matched?.[1] ?? '').trim()); if (!parts.length) { error('toml.invalid-table', i + 1); continue; }
            const path = parts.join('.');
            if (arrayTable) { const parentPath = parts.slice(0, -1).join('.'); const parent = tables.get(parentPath) ?? root; let collection = parent.children!.find(node => node.key === parts.at(-1) && node.kind === 'array'); if (!collection) { collection = { kind: 'array', key: parts.at(-1)!, path, raw: '', line: i + 1, range: declaration, children: [] }; parent.children!.push(collection); nodeCount++; } const index = collection.children!.length; const node: TomlNode = { kind: 'table', key: String(index), path: `${path}[${index}]`, raw: '', line: i + 1, range: declaration, ...(comment ? { comment } : {}), children: [] }; collection.children!.push(node); tables.set(path, node); current = node; nodeCount++; tableCount++; }
            else { let node = tables.get(path); if (!node) { node = { kind: 'table', key: parts.at(-1)!, path, raw: '', line: i + 1, range: declaration, ...(comment ? { comment } : {}), children: [] }; (tables.get(parts.slice(0, -1).join('.')) ?? root).children!.push(node); tables.set(path, node); nodeCount++; tableCount++; } else if (node !== current && node.line !== i + 1 && node.children?.length) error('toml.duplicate-table', i + 1); current = node; }
            continue;
        }
        const eq = indexOfEquals(source); if (eq < 0) { error('toml.invalid-assignment', i + 1); continue; }
        const parts = keyParts(source.slice(0, eq).trim()); if (!parts.length) { error('toml.invalid-key', i + 1); continue; }
        let parent = current; for (const part of parts.slice(0, -1)) { let nested = parent.children!.find(n => n.key === part && n.kind === 'table'); if (!nested) { nested = { kind: 'table', key: part, path: tomlPath(parent.path, part), raw: '', line: i + 1, range: declaration, children: [] }; parent.children!.push(nested); } parent = nested; }
        const key = parts.at(-1)!;
        if (parent.children!.some(n => n.key === key)) error('toml.duplicate-key', i + 1);
        else {
            const node = makeValue(key, tomlPath(parent.path, key), source.slice(eq + 1), i + 1, 0, base + eq + 1);
            // The declaration reads better than the bare value when a host turns
            // the range into a selection, so widen it to cover `key = value`.
            node.range = declaration; if (comment) node.comment = comment;
            parent.children!.push(node);
        }
    }
    return { document: { text, root }, diagnostics };
}
/** Group physical lines while a multiline string or a composite array/table
 * remains open. This preserves the declaration line for diagnostics. */
function logicalTomlLines(text: string): Array<{ line: number; text: string; offset: number }> {
    const physical: Array<{ text: string; offset: number }> = [];
    { const separator = /\r\n|\n|\r/g; let last = 0; let match: RegExpExecArray | null; while ((match = separator.exec(text))) { physical.push({ text: text.slice(last, match.index), offset: last }); last = match.index + match[0].length; } physical.push({ text: text.slice(last), offset: last }); }
    const out: Array<{ line: number; text: string; offset: number }> = [];
    let open = false; let start = 1; let offset = 0; let triple = ''; let depth = 0;
    for (let i = 0; i < physical.length; i++) {
        const { text: line, offset: at } = physical[i]!; if (!open) { open = true; start = i + 1; offset = at; }
        for (let p = 0; p < line.length; p++) {
            if (line.startsWith('"""', p) || line.startsWith("'''", p)) { const token = line.slice(p, p + 3); triple = triple === token ? '' : (triple || token); p += 2; continue; }
            if (triple) continue;
            const c = line[p]; if (c === '#') break; if (c === '[' || c === '{') depth++; else if (c === ']' || c === '}') depth--;
        }
        // Slicing the original text (rather than re-joining) keeps every offset
        // inside a logical line usable as an index into `text`.
        if (!triple && depth <= 0) { out.push({ line: start, text: text.slice(offset, at + line.length), offset }); open = false; depth = 0; }
    }
    if (open) out.push({ line: start, text: text.slice(offset), offset }); return out;
}
/** 1-based line lookup for offsets, used by inline members that may sit on a
 * different physical line than their declaration. */
function lineIndexer(text: string): (offset: number) => number {
    const starts = [0];
    for (let i = 0; i < text.length; i++) { const c = text[i]; if (c === '\n') starts.push(i + 1); else if (c === '\r') { if (text[i + 1] === '\n') i++; starts.push(i + 1); } }
    return offset => { let low = 0, high = starts.length - 1; while (low < high) { const mid = (low + high + 1) >> 1; if (starts[mid]! <= offset) low = mid; else high = mid - 1; } return low + 1; };
}
function commentBody(rest: string): string | undefined { const text = rest.trimStart(); return text.startsWith('#') ? text.slice(1).trim() : undefined; }
function stripComment(line: string): string { let q = ''; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === q && line[i - 1] !== '\\') q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '#') return line.slice(0, i); } return line; }
function indexOfEquals(line: string): number { let q = ''; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === q && line[i - 1] !== '\\') q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '=') return i; } return -1; }
function splitKey(value: string): string[] { const out: string[] = []; let q = ''; let start = 0; for (let i = 0; i < value.length; i++) { const c = value[i]; if (q) { if (c === q && value[i - 1] !== '\\') q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '.') { out.push(value.slice(start, i).trim()); start = i + 1; } } out.push(value.slice(start).trim()); return out.filter(Boolean); }
