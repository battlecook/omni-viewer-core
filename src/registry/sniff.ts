// Content sniffing for signature-less text formats (J17, docs/viewers/json.md
// 부록 B-6). JSON has no magic bytes, so extensionless JSON is detected by
// parsing a content sample. Deterministic: uses the core JSON parser (never
// JSON.parse, ADR 41), so the boolean is identical across engines. The
// legacy platforms (vscode/obsidian/chrome) sniff the same way — dropping this
// would regress them for extensionless files.

import { parseJson } from '../parsers/json/index.js';
import { looksLikeOpenVinoIr } from '../parsers/openvino/index.js';

export { looksLikeOpenVinoIr } from '../parsers/openvino/index.js';

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

/**
 * True if `text` is the start of a HAR archive: a JSON object whose `log` holds
 * an `entries` array. The sample is only the head of the file, so a partial
 * parse counts — a 20 MB archive never fits in a sniff sample, and its `log`
 * object plus the opening of `entries` are inside the first few hundred bytes.
 * HAR is checked before plain JSON so an extensionless archive reaches the HAR
 * viewer rather than the generic tree.
 */
export function looksLikeHar(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('"log"')) return false;
    const { result } = parseJson(trimmed);
    if (result.status === 'failed') return false;
    const log = result.document.root.children?.find((child) => child.key === 'log');
    if (log?.kind !== 'object') return false;
    return (log.children ?? []).some(
        (child) => child.key === 'entries' && child.kind === 'array'
    );
}

/** Notebook-specific structure must win over generic JSON. A sniff sample
 * may end partway through cells, so accept a recovered prefix with both keys. */
export function looksLikeNotebook(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('"nbformat"') || !trimmed.includes('"cells"')) return false;
    const { result } = parseJson(trimmed);
    if (result.status === 'failed' || result.document.root.kind !== 'object') return false;
    const children = result.document.root.children ?? [];
    return children.some(child => child.key === 'nbformat' && child.kind === 'number' && Number(child.rawNumber) === 4) &&
        children.some(child => child.key === 'cells' && child.kind === 'array');
}

/** Conservative Protocol Buffer schema detection for extensionless text. */
export function looksLikeProto(text: string): boolean {
    const sample = text.slice(0, 64 * 1024).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/^\s*syntax\s*=\s*["']proto[23]["']\s*;/m.test(sample)) return true;
    return /^\s*(?:package\s+[\w.]+\s*;\s*)?(?:import\s+(?:(?:public|weak)\s+)?["'][^"']+["']\s*;\s*)*(?:message|enum|service)\s+[A-Za-z_]\w*\s*\{/m.test(sample);
}

/**
 * Conservative LaTeX detection for extensionless text. `\documentclass` is the
 * one construct every LaTeX document has and neither plain TeX nor ConTeXt uses,
 * so it is the whole test — matching on `\begin`/`\section` alone would claim
 * plain TeX files the viewer cannot read structurally (docs/viewers/latex.md §1).
 */
export function looksLikeLatex(text: string): boolean {
    const sample = text.slice(0, 64 * 1024).replace(/(^|[^\\])%.*$/gm, '$1');
    return /(^|[^\\])\\documentclass\s*(\[[^\]]*\])?\s*\{[^}]+\}/.test(sample);
}

/**
 * Classify a text sample to a viewer id by content (JSONL, then HAR, then
 * JSON — 부록 B-6). Returns null when nothing matches. JSONL wins over JSON for
 * multi-line object streams so a `{…}\n{…}` file is never mis-claimed as JSON;
 * if no jsonl viewer is registered the caller falls through to fallback.
 */
export function sniffTextViewer(text: string): 'jsonl' | 'har' | 'notebook' | 'json' | 'openvino' | 'proto' | 'latex' | null {
    if (looksLikeJsonl(text)) return 'jsonl';
    // A HAR is a JSON object, so it has to be claimed before the generic JSON
    // tree would take it.
    if (looksLikeHar(text)) return 'har';
    if (looksLikeNotebook(text)) return 'notebook';
    if (looksLikeJsonDocument(text)) return 'json';
    // An OpenVINO IR is `.xml`, an extension no viewer claims, so its `<net
    // version><layers>` root is the only route to the viewer.
    if (looksLikeOpenVinoIr(text)) return 'openvino';
    if (looksLikeProto(text)) return 'proto';
    if (looksLikeLatex(text)) return 'latex';
    return null;
}
