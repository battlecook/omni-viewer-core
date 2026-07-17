// Content sniffing for signature-less text formats (J17, docs/viewers/json.md
// 부록 B-6). JSON has no magic bytes, so extensionless JSON is detected by
// parsing a content sample. Deterministic: uses the core JSON parser (never
// JSON.parse, ADR 41), so the boolean is identical across engines. The
// legacy platforms (vscode/obsidian/chrome) sniff the same way — dropping this
// would regress them for extensionless files.

import { parseJson } from '../parsers/json/index.js';

/** True if `text` parses cleanly as a single JSON object or array. */
export function looksLikeJsonDocument(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
    const { result } = parseJson(trimmed);
    if (result.status !== 'ok') return false;
    const kind = result.document.root.kind;
    return kind === 'object' || kind === 'array';
}

/**
 * True if `text` looks like line-delimited JSON: at least two non-blank lines
 * where each of the first ten parses to a JSON object or array. Blank lines are
 * ignored so a trailing newline does not disqualify the file.
 */
export function looksLikeJsonl(text: string): boolean {
    const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
    if (lines.length < 2) return false;
    return lines.slice(0, 10).every((line) => {
        const { result } = parseJson(line);
        if (result.status !== 'ok') return false;
        const kind = result.document.root.kind;
        return kind === 'object' || kind === 'array';
    });
}

/** Conservative Protocol Buffer schema detection for extensionless text. */
export function looksLikeProto(text: string): boolean {
    const sample = text.slice(0, 64 * 1024).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/^\s*syntax\s*=\s*["']proto[23]["']\s*;/m.test(sample)) return true;
    return /^\s*(?:package\s+[\w.]+\s*;\s*)?(?:import\s+(?:(?:public|weak)\s+)?["'][^"']+["']\s*;\s*)*(?:message|enum|service)\s+[A-Za-z_]\w*\s*\{/m.test(sample);
}

/**
 * Classify a text sample to a viewer id by content (JSONL is checked before
 * JSON — 부록 B-6). Returns null when nothing matches. JSONL wins over JSON for
 * multi-line object streams so a `{…}\n{…}` file is never mis-claimed as JSON;
 * if no jsonl viewer is registered the caller falls through to fallback.
 */
export function sniffTextViewer(text: string): 'jsonl' | 'json' | 'proto' | null {
    if (looksLikeJsonl(text)) return 'jsonl';
    if (looksLikeJsonDocument(text)) return 'json';
    if (looksLikeProto(text)) return 'proto';
    return null;
}
