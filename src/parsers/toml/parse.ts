import type { Diagnostic } from '../types.js';
import { tomlPath, type TomlDocument, type TomlNode, type TomlValueKind } from './model.js';

export interface TomlParseTree { document: TomlDocument; diagnostics: Diagnostic[]; }

/** A deliberately small, lossless TOML 1.0 reader. Values retain `raw` so
 * datetime and unsafe integers never pass through JavaScript Number. */
export interface TomlTreeLimits { maxDepth?: number; maxNodes?: number; maxTables?: number; maxArrayLength?: number; signal?: AbortSignal; }
export function parseTomlText(text: string, limits: TomlTreeLimits | number = {}): TomlParseTree {
    const settings: TomlTreeLimits = typeof limits === 'number' ? { maxDepth: limits } : limits;
    const maxDepth = settings.maxDepth ?? 100, maxNodes = settings.maxNodes ?? 100_000, maxTables = settings.maxTables ?? 50_000, maxArrayLength = settings.maxArrayLength ?? 100_000;
    const root: TomlNode = { kind: 'table', key: '$', path: '', raw: '', line: 1, children: [] };
    const diagnostics: Diagnostic[] = [];
    let current = root, nodeCount = 1, tableCount = 1, stopped = false;
    const tables = new Map<string, TomlNode>([['', root]]);
    const lines = logicalTomlLines(text.replace(/^\uFEFF/, ''));
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
    const split = (value: string): string[] => {
        const out: string[] = []; let start = 0; let quote = ''; let depth = 0;
        for (let i = 0; i < value.length; i++) { const c = value[i]; if (quote) { if (c === quote && value[i - 1] !== '\\') quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '[' || c === '{') depth++; else if (c === ']' || c === '}') depth--; else if (c === ',' && depth === 0) { out.push(value.slice(start, i).trim()); start = i + 1; } }
        out.push(value.slice(start).trim()); return out.filter(Boolean);
    };
    const keyParts = (key: string): string[] => splitKey(key).map(unquote);
    const makeValue = (key: string, path: string, rawValue: string, line: number, depth: number): TomlNode => {
        const raw = rawValue.trim();
        let kind: TomlValueKind = 'string'; let value: string | boolean = unquote(raw);
        if (/^(true|false)$/.test(raw)) { kind = 'boolean'; value = raw === 'true'; }
        else if (/^[+-]?(?:0x[\da-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*)$/.test(raw)) kind = 'integer';
        else if (/^[+-]?(?:\d[\d_]*\.\d[\d_]*|\d[\d_]*(?:\.\d[\d_]*)?[eE][+-]?\d[\d_]*|nan|inf)$/i.test(raw)) kind = 'float';
        else if (/^\d{4}-\d\d-\d\d(?:[Tt ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:[Zz]|[+-]\d\d:\d\d)?)?$|^\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(raw)) kind = 'datetime';
        else if (raw.startsWith('[') && raw.endsWith(']')) { kind = 'array'; const values = split(raw.slice(1, -1)); if (values.length > maxArrayLength) { error('toml.array-limit', line); values.length = maxArrayLength; } const children = values.map((v, i) => makeValue(String(i), `${path}[${i}]`, v, line, depth + 1)); nodeCount += children.length; return { kind, key, path, raw, line, children }; }
        else if (raw.startsWith('{') && raw.endsWith('}')) { kind = 'table'; const children: TomlNode[] = []; for (const pair of split(raw.slice(1, -1))) { const eq = indexOfEquals(pair); if (eq < 0) { error('toml.invalid-inline-table', line); continue; } const childKey = unquote(pair.slice(0, eq).trim()); children.push(makeValue(childKey, tomlPath(path, childKey), pair.slice(eq + 1), line, depth + 1)); } return { kind, key, path, raw, line, children }; }
        if (depth > maxDepth) error('toml.max-depth', line); nodeCount++;
        return { kind, key, path, value, raw, line };
    };
    for (const logical of lines) {
        if (settings.signal?.aborted) { error('aborted', logical.line); stopped = true; break; }
        if (nodeCount > maxNodes || tableCount > maxTables) { error(nodeCount > maxNodes ? 'toml.node-limit' : 'toml.table-limit', logical.line); stopped = true; break; }
        const i = logical.line - 1;
        const source = stripComment(logical.text).trim(); if (!source) continue;
        const arrayTable = source.match(/^\[\[(.+)\]\]$/); const table = source.match(/^\[(.+)\]$/);
        if (arrayTable || table) {
            const matched = arrayTable ?? table;
            const parts = keyParts((matched?.[1] ?? '').trim()); if (!parts.length) { error('toml.invalid-table', i + 1); continue; }
            const path = parts.join('.');
            if (arrayTable) { const parentPath = parts.slice(0, -1).join('.'); const parent = tables.get(parentPath) ?? root; let collection = parent.children!.find(node => node.key === parts.at(-1) && node.kind === 'array'); if (!collection) { collection = { kind: 'array', key: parts.at(-1)!, path, raw: '', line: i + 1, children: [] }; parent.children!.push(collection); nodeCount++; } const index = collection.children!.length; const node: TomlNode = { kind: 'table', key: String(index), path: `${path}[${index}]`, raw: '', line: i + 1, children: [] }; collection.children!.push(node); tables.set(path, node); current = node; nodeCount++; tableCount++; }
            else { let node = tables.get(path); if (!node) { node = { kind: 'table', key: parts.at(-1)!, path, raw: '', line: i + 1, children: [] }; (tables.get(parts.slice(0, -1).join('.')) ?? root).children!.push(node); tables.set(path, node); nodeCount++; tableCount++; } else if (node !== current && node.line !== i + 1 && node.children?.length) error('toml.duplicate-table', i + 1); current = node; }
            continue;
        }
        const eq = indexOfEquals(source); if (eq < 0) { error('toml.invalid-assignment', i + 1); continue; }
        const parts = keyParts(source.slice(0, eq).trim()); if (!parts.length) { error('toml.invalid-key', i + 1); continue; }
        let parent = current; for (const part of parts.slice(0, -1)) { let nested = parent.children!.find(n => n.key === part && n.kind === 'table'); if (!nested) { nested = { kind: 'table', key: part, path: tomlPath(parent.path, part), raw: '', line: i + 1, children: [] }; parent.children!.push(nested); } parent = nested; }
        const key = parts.at(-1)!; if (parent.children!.some(n => n.key === key)) error('toml.duplicate-key', i + 1); else parent.children!.push(makeValue(key, tomlPath(parent.path, key), source.slice(eq + 1), i + 1, 0));
    }
    return { document: { text, root }, diagnostics };
}
/** Group physical lines while a multiline string or a composite array/table
 * remains open. This preserves the declaration line for diagnostics. */
function logicalTomlLines(text: string): Array<{ line: number; text: string }> {
    const physical = text.split(/\r\n|\n|\r/); const out: Array<{ line: number; text: string }> = [];
    let buffer = ''; let start = 1; let triple = ''; let depth = 0;
    for (let i = 0; i < physical.length; i++) {
        const line = physical[i] ?? ''; if (!buffer) start = i + 1; buffer += (buffer ? '\n' : '') + line;
        for (let p = 0; p < line.length; p++) {
            if (line.startsWith('"""', p) || line.startsWith("'''", p)) { const token = line.slice(p, p + 3); triple = triple === token ? '' : (triple || token); p += 2; continue; }
            if (triple) continue;
            const c = line[p]; if (c === '#') break; if (c === '[' || c === '{') depth++; else if (c === ']' || c === '}') depth--;
        }
        if (!triple && depth <= 0) { out.push({ line: start, text: buffer }); buffer = ''; depth = 0; }
    }
    if (buffer) out.push({ line: start, text: buffer }); return out;
}
function stripComment(line: string): string { let q = ''; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === q && line[i - 1] !== '\\') q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '#') return line.slice(0, i); } return line; }
function indexOfEquals(line: string): number { let q = ''; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === q && line[i - 1] !== '\\') q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '=') return i; } return -1; }
function splitKey(value: string): string[] { const out: string[] = []; let q = ''; let start = 0; for (let i = 0; i < value.length; i++) { const c = value[i]; if (q) { if (c === q && value[i - 1] !== '\\') q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '.') { out.push(value.slice(start, i).trim()); start = i + 1; } } out.push(value.slice(start).trim()); return out.filter(Boolean); }
