// JSON document model (docs/parsers/json.md, J1 = 원문 보존 토크나이저).
//
// Preserves the fidelity JSON.parse loses: raw number text (no float64
// rounding), duplicate object keys (kept in order), and source char spans so
// the verbatim source view and error loci can slice the original text.

export type JsonValueKind =
    | 'object'
    | 'array'
    | 'string'
    | 'number'
    | 'boolean'
    | 'null';

export interface JsonNode {
    kind: JsonValueKind;
    /** Key within the parent object, array index as a string, or '$' for root. */
    key: string;
    /** JSONPath from the root, e.g. '$.a.b[0]' or '$["odd key"]'. */
    path: string;
    depth: number;
    /** object/array only — ordered children; duplicate object keys are kept. */
    children?: JsonNode[];
    /** primitive value: decoded string, boolean, or null. Numbers use rawNumber. */
    value?: string | boolean | null;
    /** number only — the verbatim token (e.g. "1e400", big ints), no rounding. */
    rawNumber?: string;
    /** [start, end) char range in the source text (verbatim slice / error locus). */
    span: { start: number; end: number };
}

export interface JsonDocument {
    root: JsonNode;
    /** Decoded source text; also lets a failed parse still show the source (J20). */
    text: string;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Build a child JSONPath (parity with web JsonViewer.appendPath): identifier
 * keys use dot notation, everything else uses bracket-quoted notation.
 */
export function appendPath(
    parent: string,
    key: string,
    isArrayItem: boolean
): string {
    if (isArrayItem) return `${parent}[${key}]`;
    return IDENTIFIER.test(key)
        ? `${parent}.${key}`
        : `${parent}[${encodeJsonString(key)}]`;
}

/**
 * Encode a string as a JSON string literal (with surrounding quotes),
 * deterministically and without JSON.stringify (ADR 41). Used for bracket
 * path keys and, later, re-serialization.
 */
export function encodeJsonString(value: string): string {
    let out = '"';
    for (let i = 0; i < value.length; i++) {
        const ch = value.charCodeAt(i);
        switch (ch) {
            case 0x22: out += '\\"'; break;
            case 0x5c: out += '\\\\'; break;
            case 0x08: out += '\\b'; break;
            case 0x0c: out += '\\f'; break;
            case 0x0a: out += '\\n'; break;
            case 0x0d: out += '\\r'; break;
            case 0x09: out += '\\t'; break;
            default:
                if (ch < 0x20) {
                    out += '\\u' + ch.toString(16).padStart(4, '0');
                } else {
                    out += value[i];
                }
        }
    }
    return out + '"';
}

/**
 * Decode a JSON string literal (including its surrounding quotes) to its text
 * value. Deterministic, never throws — malformed escapes fall back to the
 * literal characters so a recovered/partial parse still yields a usable value.
 */
export function decodeJsonString(raw: string): string {
    // Strip surrounding quotes if present (the scanner may hand us an
    // unterminated literal on recovery).
    let start = 0;
    let end = raw.length;
    if (raw.charCodeAt(0) === 0x22) start = 1;
    if (end > start && raw.charCodeAt(end - 1) === 0x22) end -= 1;

    let out = '';
    let i = start;
    while (i < end) {
        const ch = raw.charCodeAt(i);
        if (ch !== 0x5c /* \ */) {
            out += raw[i];
            i++;
            continue;
        }
        const next = raw[i + 1];
        if (next === undefined) {
            out += '\\';
            break;
        }
        switch (next) {
            case '"': out += '"'; i += 2; break;
            case '\\': out += '\\'; i += 2; break;
            case '/': out += '/'; i += 2; break;
            case 'b': out += '\b'; i += 2; break;
            case 'f': out += '\f'; i += 2; break;
            case 'n': out += '\n'; i += 2; break;
            case 'r': out += '\r'; i += 2; break;
            case 't': out += '\t'; i += 2; break;
            case 'u': {
                const hex = raw.slice(i + 2, i + 6);
                if (/^[0-9a-fA-F]{4}$/.test(hex)) {
                    out += String.fromCharCode(parseInt(hex, 16));
                    i += 6;
                } else {
                    out += '\\u';
                    i += 2;
                }
                break;
            }
            default:
                // Unknown escape — keep it literal (lossless for recovery).
                out += next;
                i += 2;
        }
    }
    return out;
}
