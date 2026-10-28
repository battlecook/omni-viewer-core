// Content sniffing for signature-less text formats (J17, docs/viewers/json.md
// 부록 B-6). JSON has no magic bytes, so extensionless JSON is detected by
// parsing a content sample. Deterministic: uses the core JSON parser (never
// JSON.parse, ADR 41), so the boolean is identical across engines. The
// legacy platforms (vscode/obsidian/chrome) sniff the same way — dropping this
// would regress them for extensionless files.

import { parseJson } from '../parsers/json/index.js';
import { asciiLower } from '../parsers/csv/index.js';
import { looksLikeOpenVinoIr } from '../parsers/openvino/index.js';
import { GEOJSON_GEOMETRY_TYPES } from '../parsers/geojson/index.js';

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

/** Inspect only top-level structure; a truncated coordinate array may count. */
export function looksLikeGeoJson(text: string): boolean {
    const sample = text.slice(0, 64 * 1024).replace(/^\uFEFF/, '').trim();
    if (!sample.startsWith('{')) return false;
    const { result } = parseJson(sample, { maxDepth: 64, limits: { maxEntries: 20_000 } });
    if (result.status === 'failed' || result.document.root.kind !== 'object') return false;
    const fields = result.document.root.children ?? [];
    const type = fields.find(child => child.key === 'type');
    if (type?.kind !== 'string') return false;
    const field = (name: string) => fields.find(child => child.key === name);
    if (type.value === 'FeatureCollection') return field('features')?.kind === 'array';
    if (type.value === 'Feature') {
        const shape = field('geometry'), properties = field('properties');
        return !!shape && ['object', 'null'].includes(shape.kind) && !!properties && ['object', 'null'].includes(properties.kind);
    }
    if (type.value === 'GeometryCollection') return field('geometries')?.kind === 'array';
    return GEOJSON_GEOMETRY_TYPES.includes(String(type.value)) && field('coordinates')?.kind === 'array';
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

/** Claim only recognizable HTML documents; fragments need a file extension. */
export function looksLikeHtml(text: string): boolean {
    const sample = text.slice(0, 64 * 1024).replace(/^\uFEFF?\s*/, '');
    const start = sample.replace(/^(?:<!--[\s\S]*?-->\s*)*/, '');
    return /^<!doctype\s+html(?:\s|>|\[)/i.test(start) || /^<html(?:\s|>)/i.test(start);
}

/**
 * True if `text` starts like an XML document: after a BOM, whitespace, the
 * declaration, comments, processing instructions and a DOCTYPE comes a start
 * tag — or the text opens with an `<?xml` declaration and the sample ends
 * before the root. HTML (an `html` root or `<!DOCTYPE html>`) is not
 * claimed — it is rarely well-formed and the generic tree is the wrong view
 * for it.
 */
export function looksLikeXml(text: string): boolean {
    const sample = text.slice(0, 64 * 1024);
    let index = sample.charCodeAt(0) === 0xfeff ? 1 : 0;
    while (index < sample.length && /\s/.test(sample[index]!)) index++;
    // An XML declaration claims the file on its own when the sample ends
    // before the root (a long licence comment, a short sample); a root that
    // turns out to be `html` still declines it.
    const declared = /^<\?xml[\s?]/.test(sample.slice(index, index + 6));
    // Scan forward once over the declaration, comments, PIs and the DOCTYPE.
    for (;;) {
        while (index < sample.length && /\s/.test(sample[index]!)) index++;
        if (sample.startsWith('<!--', index)) {
            const end = sample.indexOf('-->', index + 4);
            if (end < 0) return declared;
            index = end + 3;
        } else if (sample.startsWith('<?', index)) {
            const end = sample.indexOf('?>', index + 2);
            if (end < 0) return declared;
            index = end + 2;
        } else if (sample.startsWith('<!DOCTYPE', index)) {
            if (/^<!DOCTYPE\s+html[\s>]/i.test(sample.slice(index, index + 20))) return false;
            // An internal subset `[...]` holds '>'s of its own; it ends at `]>`.
            const gt = sample.indexOf('>', index);
            const bracket = sample.indexOf('[', index);
            const subsetEnd = bracket >= 0 && bracket < gt ? /\]\s*>/.exec(sample.slice(bracket)) : null;
            const end = subsetEnd ? bracket + subsetEnd.index + subsetEnd[0].length : gt + 1;
            if (gt < 0 || (bracket >= 0 && bracket < gt && !subsetEnd)) return declared;
            index = end;
        } else break;
    }
    const root = /^<([A-Za-z_:\u00C0-\uFFFF][\w.:\-\u00B7\u00C0-\uFFFF]*)[\s/>]/.exec(sample.slice(index, index + 256));
    // No root yet: with a declaration, a sample that ran out (possibly inside
    // the root's name) still counts.
    if (!root) return declared && /^(<[^\s/<>]*)?$/.test(sample.slice(index));
    return asciiLower(root[1]!) !== 'html';
}

/**
 * Classify a text sample to a viewer id by content (JSONL, then HAR, then
 * JSON — 부록 B-6). Returns null when nothing matches. JSONL wins over JSON for
 * multi-line object streams so a `{…}\n{…}` file is never mis-claimed as JSON;
 * if no jsonl viewer is registered the caller falls through to fallback.
 */
export function sniffTextViewer(text: string): 'jsonl' | 'har' | 'notebook' | 'geojson' | 'json' | 'html' | 'openvino' | 'xml' | 'proto' | 'latex' | null {
    if (looksLikeJsonl(text)) return 'jsonl';
    // A HAR is a JSON object, so it has to be claimed before the generic JSON
    // tree would take it.
    if (looksLikeHar(text)) return 'har';
    if (looksLikeNotebook(text)) return 'notebook';
    if (looksLikeGeoJson(text)) return 'geojson';
    if (looksLikeJsonDocument(text)) return 'json';
    if (looksLikeHtml(text)) return 'html';
    // An OpenVINO IR is `.xml`, an extension no viewer claims, so its `<net
    // version><layers>` root is the only route to the viewer.
    if (looksLikeOpenVinoIr(text)) return 'openvino';
    if (looksLikeXml(text)) return 'xml';
    if (looksLikeProto(text)) return 'proto';
    if (looksLikeLatex(text)) return 'latex';
    return null;
}
