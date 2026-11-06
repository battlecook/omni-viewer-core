import { parseJson, decodeJsonString } from '../json/index.js';
import { readOpenApiRoot, OPENAPI_MAX_INPUT_BYTES, type OpenApiParseOptions } from './index.js';
import { openApiVersion } from './nodes.js';
import type { OpenApiNode } from './model.js';

export type OpenApiSniffOptions = Pick<OpenApiParseOptions, 'yamlDeps' | 'format'>;

/** Full parsing when dependencies are supplied. Without a YAML peer, only a
 * conservative, single-document block-mapping signature is recognized; the
 * mounted parser always validates the entire document before showing APIs. */
export function looksLikeOpenApi(text: string, options: OpenApiSniffOptions = {}): boolean {
    if (text.length > OPENAPI_MAX_INPUT_BYTES || (!/(?:openapi|swagger)/.test(text) && !text.includes('\\'))) return false;
    const trimmed = text.replace(/^\uFEFF/, '').trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || options.yamlDeps || options.format) {
        const parsed = readOpenApiRoot(text, options).result;
        return parsed.status === 'ok' && openApiVersion(parsed.document.root) !== null;
    }
    return looksLikeBlockYaml(trimmed);
}

interface Pair { key: string; value: string; body: string[]; }

function blockPairs(lines: readonly string[]): Pair[] | null {
    const significant = lines.filter(line => line.trim() && !/^\s*#/.test(line));
    if (!significant.length || significant.some(line => /^\s*\t/.test(line))) return null;
    const indent = significant[0]!.match(/^ */)![0].length;
    const pairs: Pair[] = [];
    const seen = new Set<string>();
    for (const line of lines) {
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const depth = line.match(/^ */)![0].length;
        if (depth < indent) return null;
        if (depth > indent) { if (!pairs.length) return null; pairs[pairs.length - 1]!.body.push(line); continue; }
        const pair = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line.slice(indent));
        if (!pair) return null;
        const key = scalar(pair[1]!, false);
        if (key === null || seen.has(key)) return null;
        seen.add(key);
        pairs.push({ key, value: stripComment(pair[2]!), body: [] });
    }
    return pairs;
}

function stripComment(value: string): string {
    let quote = '';
    for (let i = 0; i < value.length; i++) {
        const ch = value[i]!;
        if (quote === '"' && ch === '\\') { i++; continue; }
        if (quote === "'" && ch === "'" && value[i + 1] === "'") { i++; continue; }
        if (quote) { if (ch === quote) quote = ''; }
        else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '#' && (i === 0 || /\s/.test(value[i - 1]!))) return value.slice(0, i).trim();
    }
    return value.trim();
}

function scalar(value: string, typed = true): string | null {
    if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
        const parsed = parseJson(value).result;
        return parsed.status === 'ok' ? decodeJsonString(value) : null;
    }
    if (/^'(?:[^']|'')*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
    if (!value || /^[\[\]{}!&*|>@`"']/.test(value) || /:\s/.test(value)) return null;
    if (typed && /^(?:null|true|false|~|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|[-+]?\.(?:inf|nan))$/i.test(value)) return null;
    return value;
}

function looksLikeBlockYaml(text: string): boolean {
    const lines = text.split(/\r\n|\n|\r/);
    let first = 0;
    while (first < lines.length && (!lines[first]!.trim() || /^\s*#/.test(lines[first]!) || /^%YAML 1\.2\s*(?:#.*)?$/.test(lines[first]!))) first++;
    if (/^---\s*(?:#.*)?$/.test(lines[first] ?? '')) first++;
    const documentLines = lines.slice(first);
    // More than one YAML document, explicit tags, and flow/complex root keys
    // require the injected parser. Never infer them from nested marker words.
    if (documentLines.some(line => /^(?:---|\.\.\.|%)(?:\s|$)/.test(line))) return false;
    const pairs = blockPairs(documentLines);
    if (!pairs) return false;
    const children: OpenApiNode[] = [];
    for (const pair of pairs) {
        if (pair.key === 'openapi' || pair.key === 'swagger') {
            const value = scalar(pair.value);
            if (value === null || pair.body.length) return false;
            children.push({ kind: 'string', key: pair.key, value });
        } else if (pair.key === 'info') {
            if (pair.value.startsWith('{')) {
                const parsed = parseJson(pair.value).result;
                if (parsed.status !== 'ok' || parsed.document.root.kind !== 'object') return false;
                children.push({ ...parsed.document.root, key: 'info' });
            } else {
                if (pair.value) return false;
                const info = blockPairs(pair.body);
                if (!info) return false;
                const fields: OpenApiNode[] = [];
                for (const child of info) if (child.key === 'title' || child.key === 'version') {
                    const value = scalar(child.value);
                    if (value === null || child.body.length) return false;
                    fields.push({ kind: 'string', key: child.key, value });
                }
                children.push({ kind: 'object', key: 'info', children: fields });
            }
        } else if (['paths', 'components', 'webhooks'].includes(pair.key)) {
            if (pair.value === '{}' || (!pair.value && pair.body.some(line => /^\s+[^#\s][^\n]*:(?:\s|$)/.test(line)))) children.push({ kind: 'object', key: pair.key, children: [] });
        }
    }
    return openApiVersion({ kind: 'object', key: '$', children }) !== null;
}
