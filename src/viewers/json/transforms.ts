// Pure JSON toolbox transforms (docs/viewers/json.md 부록 B, vscode 기준).
// DOM-free and deterministic. Serialization (pretty/minify/sort) runs on the
// fidelity model (rawNumber / duplicate keys preserved, J1); converters and
// escape/base64 follow the vscode rules (J15/J19). Input-caused failures
// return an { error } marker instead of throwing (ADR 11).

import { encodeJsonString, type JsonNode } from '../../parsers/json/index.js';

export type TransformResult =
    | { ok: true; output: string }
    | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Serialization from the fidelity model (pretty / minify / sort-keys).
// ---------------------------------------------------------------------------

/**
 * Serialize a JsonNode tree. `pretty` uses 2-space indentation (JSON.stringify
 * `null, 2` shape); `sortKeys` orders object keys by code unit — a deterministic
 * compare, not vscode's locale-dependent localeCompare (ADR 41).
 */
export function serialize(node: JsonNode, pretty: boolean, sortKeys = false): string {
    const nl = pretty ? '\n' : '';
    const sp = pretty ? ' ' : '';
    const pad = (d: number): string => (pretty ? '  '.repeat(d) : '');

    const walk = (n: JsonNode, depth: number): string => {
        switch (n.kind) {
            case 'string':
                return encodeJsonString(n.value as string);
            case 'number':
                return n.rawNumber ?? '0';
            case 'boolean':
                return n.value ? 'true' : 'false';
            case 'null':
                return 'null';
            case 'array': {
                const items = n.children ?? [];
                if (items.length === 0) return '[]';
                const inner = items
                    .map((c) => pad(depth + 1) + walk(c, depth + 1))
                    .join(',' + nl);
                return '[' + nl + inner + nl + pad(depth) + ']';
            }
            case 'object': {
                let entries = n.children ?? [];
                if (sortKeys) {
                    entries = [...entries].sort((a, b) =>
                        a.key < b.key ? -1 : a.key > b.key ? 1 : 0
                    );
                }
                if (entries.length === 0) return '{}';
                const inner = entries
                    .map(
                        (c) =>
                            pad(depth + 1) +
                            encodeJsonString(c.key) +
                            ':' +
                            sp +
                            walk(c, depth + 1)
                    )
                    .join(',' + nl);
                return '{' + nl + inner + nl + pad(depth) + '}';
            }
        }
    };

    return walk(node, 0);
}

/** Project the fidelity model to a plain JS value (converters use this for
 *  vscode parity — duplicate keys collapse last-wins, as JSON semantics). */
export function toPlainValue(node: JsonNode): unknown {
    switch (node.kind) {
        case 'object': {
            const obj: Record<string, unknown> = {};
            for (const child of node.children ?? []) obj[child.key] = toPlainValue(child);
            return obj;
        }
        case 'array':
            return (node.children ?? []).map(toPlainValue);
        case 'number':
            return Number(node.rawNumber);
        case 'string':
        case 'boolean':
        case 'null':
            return node.value ?? null;
    }
}

// ---------------------------------------------------------------------------
// escape / unescape / base64 (부록 B-2, vscode). Operate on raw text.
// ---------------------------------------------------------------------------

/** vscode escapeText: JSON-escape then strip the outer quotes. */
export function escapeText(text: string): string {
    return encodeJsonString(text).slice(1, -1);
}

/** vscode unescapeText: unwrap matching quotes, then resolve escapes. */
export function unescapeText(text: string): TransformResult {
    const trimmed = text.trim();
    let body = text;
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
    ) {
        body = trimmed.slice(1, -1);
    }
    let result = '';
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch !== '\\') {
            result += ch;
            continue;
        }
        const next = body[i + 1];
        if (next === undefined) return { ok: false, error: 'trailing' };
        if (next === 'n') result += '\n';
        else if (next === 'r') result += '\r';
        else if (next === 't') result += '\t';
        else if (next === 'b') result += '\b';
        else if (next === 'f') result += '\f';
        else if (next === '\\') result += '\\';
        else if (next === '"') result += '"';
        else if (next === "'") result += "'";
        else if (next === 'u') {
            const hex = body.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { ok: false, error: 'invalid-unicode' };
            result += String.fromCharCode(parseInt(hex, 16));
            i += 4;
        } else if (next === 'x') {
            const hex = body.slice(i + 2, i + 4);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) return { ok: false, error: 'invalid-hex' };
            result += String.fromCharCode(parseInt(hex, 16));
            i += 2;
        } else {
            result += next;
        }
        i += 1;
    }
    return { ok: true, output: result };
}

export function base64Encode(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
    });
    return btoa(binary);
}

export function base64Decode(text: string): TransformResult {
    try {
        const binary = atob(text.trim());
        const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
        return { ok: true, output: new TextDecoder().decode(bytes) };
    } catch {
        return { ok: false, error: 'invalid-base64' };
    }
}

// ---------------------------------------------------------------------------
// Converters (부록 B-3/4/5, vscode). Operate on the plain-value projection.
// ---------------------------------------------------------------------------

/** JSON→CSV. Requires an object or an array of objects (else error). */
export function jsonToCsv(value: unknown): TransformResult {
    const rows = Array.isArray(value) ? value : [value];
    if (!rows.every((r) => r != null && typeof r === 'object' && !Array.isArray(r))) {
        return { ok: false, error: 'csv-requires-objects' };
    }
    const headers = Array.from(
        new Set(rows.flatMap((r) => Object.keys(r as Record<string, unknown>)))
    );
    const cell = (v: unknown): string => {
        if (v === null || v === undefined) return '';
        const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    // B-3 fix: the header row is quoted like data cells (vscode leaves it raw).
    const lines = [
        headers.map(cell).join(','),
        ...rows.map((row) =>
            headers.map((h) => cell((row as Record<string, unknown>)[h])).join(',')
        )
    ];
    return { ok: true, output: lines.join('\n') };
}

export function jsonToXml(value: unknown): TransformResult {
    return {
        ok: true,
        output: `<?xml version="1.0" encoding="UTF-8"?>\n${toXmlNode('root', value, 0)}`
    };
}

function toXmlNode(key: string, value: unknown, depth: number): string {
    const indent = '  '.repeat(depth);
    const tag = sanitizeXmlTag(key);
    if (Array.isArray(value)) {
        const items = value.map((item) => toXmlNode('item', item, depth + 1)).join('\n');
        return `${indent}<${tag}>\n${items}\n${indent}</${tag}>`;
    }
    if (value && typeof value === 'object') {
        const children = Object.entries(value as Record<string, unknown>)
            .map(([k, v]) => toXmlNode(k, v, depth + 1))
            .join('\n');
        return `${indent}<${tag}>\n${children}\n${indent}</${tag}>`;
    }
    return `${indent}<${tag}>${escapeXml(String(value ?? ''))}</${tag}>`;
}

function sanitizeXmlTag(tag: string): string {
    const normalized = tag.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return /^[A-Za-z_]/.test(normalized) ? normalized : `node_${normalized}`;
}

function escapeXml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

export function jsonToYaml(value: unknown, depth = 0): TransformResult {
    return { ok: true, output: yamlNode(value, depth) };
}

function yamlNode(value: unknown, depth: number): string {
    const indent = '  '.repeat(depth);
    if (Array.isArray(value)) {
        if (value.length === 0) return `${indent}[]`;
        return value
            .map((item) =>
                item && typeof item === 'object'
                    ? `${indent}- ${yamlNode(item, depth + 1).trimStart()}`
                    : `${indent}- ${yamlScalar(item)}`
            )
            .join('\n');
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length === 0) return `${indent}{}`;
        return entries
            .map(([key, item]) =>
                item && typeof item === 'object'
                    ? `${indent}${key}:\n${yamlNode(item, depth + 1)}`
                    : `${indent}${key}: ${yamlScalar(item)}`
            )
            .join('\n');
    }
    return `${indent}${yamlScalar(value)}`;
}

function yamlScalar(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    const text = String(value);
    if (
        text === '' ||
        /[:{}[\],&*#?|\-<>=!%@`]/.test(text) ||
        /^\s|\s$/.test(text) ||
        text.includes('\n')
    ) {
        return encodeJsonString(text);
    }
    return text;
}
