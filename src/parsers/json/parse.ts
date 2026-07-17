// Recursive-descent JSON parser producing the fidelity-preserving JsonNode
// tree (docs/parsers/json.md). Separate from the tokenizer (which serves
// highlighting): this builds the document model with source spans, raw number
// text, and ordered duplicate keys. Never throws — syntax errors record a
// diagnostic and stop, yielding whatever prefix parsed (partial recovery).

import type { Diagnostic } from '../types.js';
import { appendPath, decodeJsonString, type JsonNode } from './model.js';
import { isDigit, isWhitespace, scanNumber, scanString } from './tokenizer.js';

/** Reason a checkpoint asked the parser to stop. */
export type StopReason = 'abort' | 'limit';

export interface ParseTreeOptions {
    maxDepth?: number;
    /** Called once per node; return a stop reason to halt, or null to continue. */
    onNode?: () => StopReason | null;
}

export interface JsonParseTree {
    root: JsonNode | null;
    diagnostics: Diagnostic[];
    /** A checkpoint (abort/limit) halted parsing. */
    stopped: boolean;
    stopReason: StopReason | null;
    /** A syntax error prevented a complete parse. */
    errored: boolean;
    /** Non-whitespace content followed the top-level value. */
    trailing: boolean;
}

export const JSON_DEFAULT_MAX_DEPTH = 500;

export function parseJsonDocument(
    text: string,
    options: ParseTreeOptions = {}
): JsonParseTree {
    const maxDepth = options.maxDepth ?? JSON_DEFAULT_MAX_DEPTH;
    const onNode = options.onNode;
    const len = text.length;
    const diagnostics: Diagnostic[] = [];

    let pos = 0;
    let stopped = false;
    let stopReason: StopReason | null = null;
    let errored = false;
    let trailing = false;

    const skipWs = (): void => {
        while (pos < len && isWhitespace(text.charCodeAt(pos))) pos++;
    };

    const fail = (code: string, at: number): void => {
        if (errored) return; // first error only — the rest is unreliable
        errored = true;
        diagnostics.push({
            severity: 'error',
            code,
            messageKey: `diag.${code}`,
            location: `@${at}`
        });
    };

    /** Register a node with the checkpoint; returns false if parsing must stop. */
    const enter = (): boolean => {
        if (!onNode) return true;
        const reason = onNode();
        if (reason) {
            stopped = true;
            stopReason = reason;
            return false;
        }
        return true;
    };

    function parseValue(key: string, path: string, depth: number): JsonNode | null {
        if (stopped || errored) return null;
        if (!enter()) return null;
        if (depth > maxDepth) {
            diagnostics.push({
                severity: 'warning',
                code: 'json.max-depth',
                messageKey: 'diag.json.max-depth',
                location: path
            });
            stopped = true;
            stopReason = 'limit';
            return null;
        }
        skipWs();
        if (pos >= len) {
            fail('json.unexpected-eof', pos);
            return null;
        }
        const ch = text.charCodeAt(pos);
        if (ch === 0x7b /* { */) return parseObject(key, path, depth);
        if (ch === 0x5b /* [ */) return parseArray(key, path, depth);
        if (ch === 0x22 /* " */) return parseString(key, path, depth);
        if (ch === 0x2d /* - */ || isDigit(ch)) return parseNumber(key, path, depth);
        if (text.startsWith('true', pos)) return literal(key, path, depth, 'boolean', true, 4);
        if (text.startsWith('false', pos)) return literal(key, path, depth, 'boolean', false, 5);
        if (text.startsWith('null', pos)) return literal(key, path, depth, 'null', null, 4);
        fail('json.invalid-token', pos);
        return null;
    }

    function literal(
        key: string,
        path: string,
        depth: number,
        kind: 'boolean' | 'null',
        value: boolean | null,
        length: number
    ): JsonNode {
        const start = pos;
        pos += length;
        return { kind, key, path, depth, value, span: { start, end: pos } };
    }

    function parseString(key: string, path: string, depth: number): JsonNode {
        const start = pos;
        const scan = scanString(text, pos);
        const raw = text.slice(pos, pos + scan.length);
        pos += scan.length;
        if (!scan.terminated) {
            fail('json.unterminated-string', start);
        } else {
            const err = stringContentError(raw);
            if (err) fail(err, start);
        }
        return {
            kind: 'string',
            key,
            path,
            depth,
            value: decodeJsonString(raw),
            span: { start, end: pos }
        };
    }

    function parseNumber(key: string, path: string, depth: number): JsonNode | null {
        const start = pos;
        const n = scanNumber(text, pos);
        if (n === 0) {
            fail('json.invalid-token', start);
            return null;
        }
        pos += n;
        return {
            kind: 'number',
            key,
            path,
            depth,
            rawNumber: text.slice(start, pos),
            span: { start, end: pos }
        };
    }

    function parseObject(key: string, path: string, depth: number): JsonNode {
        const start = pos;
        pos++; // consume '{'
        const children: JsonNode[] = [];
        const seen = new Set<string>();
        skipWs();
        if (pos < len && text.charCodeAt(pos) === 0x7d /* } */) {
            pos++;
        } else {
            for (;;) {
                skipWs();
                if (pos >= len || text.charCodeAt(pos) !== 0x22 /* " */) {
                    fail('json.invalid-token', pos);
                    break;
                }
                const keyScan = scanString(text, pos);
                const keyRaw = text.slice(pos, pos + keyScan.length);
                const keyStr = decodeJsonString(keyRaw);
                if (!keyScan.terminated) {
                    fail('json.unterminated-string', pos);
                    break;
                }
                const keyErr = stringContentError(keyRaw);
                if (keyErr) {
                    fail(keyErr, pos);
                    break;
                }
                pos += keyScan.length;
                skipWs();
                if (pos >= len || text.charCodeAt(pos) !== 0x3a /* : */) {
                    fail('json.invalid-token', pos);
                    break;
                }
                pos++; // consume ':'
                const childPath = appendPath(path, keyStr, false);
                const child = parseValue(keyStr, childPath, depth + 1);
                if (!child) break;
                if (seen.has(keyStr)) {
                    diagnostics.push({
                        severity: 'warning',
                        code: 'json.duplicate-key',
                        messageKey: 'diag.json.duplicate-key',
                        args: { key: keyStr },
                        location: childPath
                    });
                } else {
                    seen.add(keyStr);
                }
                children.push(child);
                skipWs();
                if (pos < len && text.charCodeAt(pos) === 0x2c /* , */) {
                    pos++;
                    continue;
                }
                if (pos < len && text.charCodeAt(pos) === 0x7d /* } */) {
                    pos++;
                    break;
                }
                fail('json.invalid-token', pos);
                break;
            }
        }
        return { kind: 'object', key, path, depth, children, span: { start, end: pos } };
    }

    function parseArray(key: string, path: string, depth: number): JsonNode {
        const start = pos;
        pos++; // consume '['
        const children: JsonNode[] = [];
        skipWs();
        if (pos < len && text.charCodeAt(pos) === 0x5d /* ] */) {
            pos++;
        } else {
            let index = 0;
            for (;;) {
                const childPath = appendPath(path, String(index), true);
                const child = parseValue(String(index), childPath, depth + 1);
                if (!child) break;
                children.push(child);
                index++;
                skipWs();
                if (pos < len && text.charCodeAt(pos) === 0x2c /* , */) {
                    pos++;
                    continue;
                }
                if (pos < len && text.charCodeAt(pos) === 0x5d /* ] */) {
                    pos++;
                    break;
                }
                fail('json.invalid-token', pos);
                break;
            }
        }
        return { kind: 'array', key, path, depth, children, span: { start, end: pos } };
    }

    skipWs();
    const root = pos >= len ? (fail('json.unexpected-eof', pos), null) : parseValue('$', '$', 0);
    if (root && !stopped && !errored) {
        skipWs();
        if (pos < len) {
            trailing = true;
            diagnostics.push({
                severity: 'warning',
                code: 'json.trailing-content',
                messageKey: 'diag.json.trailing-content',
                location: `@${pos}`
            });
        }
    }

    return { root, diagnostics, stopped, stopReason, errored, trailing };
}

/**
 * Validate a terminated JSON string literal's content per RFC 8259: no
 * unescaped control characters (< U+0020), only the allowed escapes
 * (`" \ / b f n r t`), and `\u` followed by exactly four hex digits. Returns a
 * diagnostic code or null. This is what keeps invalid strings ("\q", "\u12G4",
 * a raw newline) from being reported as valid JSON (P1a).
 */
function stringContentError(raw: string): string | null {
    const end = raw.length - 1; // exclude the closing quote
    let i = 1; // skip the opening quote
    while (i < end) {
        const c = raw.charCodeAt(i);
        if (c === 0x5c /* \ */) {
            const next = raw[i + 1];
            if (next === undefined) return 'json.invalid-escape';
            if (
                next === '"' || next === '\\' || next === '/' || next === 'b' ||
                next === 'f' || next === 'n' || next === 'r' || next === 't'
            ) {
                i += 2;
                continue;
            }
            if (next === 'u') {
                const hex = raw.slice(i + 2, i + 6);
                if (!/^[0-9a-fA-F]{4}$/.test(hex)) return 'json.invalid-unicode-escape';
                i += 6;
                continue;
            }
            return 'json.invalid-escape';
        }
        if (c < 0x20) return 'json.control-char';
        i++;
    }
    return null;
}
