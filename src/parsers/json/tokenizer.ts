// Pure JSON tokenizer — flat token list for source syntax highlighting
// (docs/viewers/json.md J14 verbatim view). Ported from the chrome viewer
// (jsonTokenizer). DOM-free and never throws: malformed input falls through to
// `unknown` tokens so the caller can still render the prefix that scanned
// cleanly. The sum of token.text equals the input, so the source can be
// reconstructed by concatenating tokens in order.
//
// The document model (parse.ts) is a separate recursive-descent parser; this
// tokenizer only serves highlighting, mirroring the chrome split.

export type JsonTokenKind =
    | 'key'
    | 'string'
    | 'number'
    | 'bool'
    | 'null'
    | 'punct'
    | 'whitespace'
    | 'unknown';

export interface JsonToken {
    kind: JsonTokenKind;
    text: string;
}

export function tokenizeJson(input: string): JsonToken[] {
    const tokens: JsonToken[] = [];
    if (typeof input !== 'string' || input.length === 0) {
        return tokens;
    }

    const len = input.length;
    let i = 0;

    while (i < len) {
        const ch = input.charCodeAt(i);

        if (isWhitespace(ch)) {
            const start = i;
            i++;
            while (i < len && isWhitespace(input.charCodeAt(i))) i++;
            tokens.push({ kind: 'whitespace', text: input.slice(start, i) });
            continue;
        }

        if (
            ch === 0x7b /* { */ ||
            ch === 0x7d /* } */ ||
            ch === 0x5b /* [ */ ||
            ch === 0x5d /* ] */ ||
            ch === 0x2c /* , */ ||
            ch === 0x3a /* : */
        ) {
            tokens.push({ kind: 'punct', text: input[i]! });
            i++;
            continue;
        }

        if (ch === 0x22 /* " */) {
            const consumed = scanString(input, i);
            const text = input.slice(i, i + consumed.length);
            i += consumed.length;
            if (consumed.terminated) {
                let j = i;
                while (j < len && isWhitespace(input.charCodeAt(j))) j++;
                const isKey = j < len && input.charCodeAt(j) === 0x3a; /* : */
                tokens.push({ kind: isKey ? 'key' : 'string', text });
            } else {
                tokens.push({ kind: 'unknown', text });
            }
            continue;
        }

        if (ch === 0x74 /* t */ && input.startsWith('true', i)) {
            tokens.push({ kind: 'bool', text: 'true' });
            i += 4;
            continue;
        }
        if (ch === 0x66 /* f */ && input.startsWith('false', i)) {
            tokens.push({ kind: 'bool', text: 'false' });
            i += 5;
            continue;
        }
        if (ch === 0x6e /* n */ && input.startsWith('null', i)) {
            tokens.push({ kind: 'null', text: 'null' });
            i += 4;
            continue;
        }

        if (ch === 0x2d /* - */ || isDigit(ch)) {
            const consumed = scanNumber(input, i);
            if (consumed > 0) {
                tokens.push({ kind: 'number', text: input.slice(i, i + consumed) });
                i += consumed;
                continue;
            }
        }

        const start = i;
        i++;
        while (i < len && !canStartToken(input.charCodeAt(i))) i++;
        tokens.push({ kind: 'unknown', text: input.slice(start, i) });
    }

    return tokens;
}

interface StringScan {
    length: number;
    terminated: boolean;
}

/** Scan a string literal at `start` (points at the opening `"`). Honours `\`. */
export function scanString(input: string, start: number): StringScan {
    const len = input.length;
    let i = start + 1;
    while (i < len) {
        const c = input.charCodeAt(i);
        if (c === 0x5c /* \ */) {
            i += 2;
            continue;
        }
        if (c === 0x22 /* " */) {
            return { length: i - start + 1, terminated: true };
        }
        i++;
    }
    return { length: len - start, terminated: false };
}

/** Scan a JSON number at `start`; returns chars consumed, or 0 if not a number. */
export function scanNumber(input: string, start: number): number {
    const len = input.length;
    let i = start;

    if (i < len && input.charCodeAt(i) === 0x2d /* - */) i++;

    if (i >= len) return 0;
    const c = input.charCodeAt(i);
    if (c === 0x30 /* 0 */) {
        i++;
    } else if (c >= 0x31 /* 1 */ && c <= 0x39 /* 9 */) {
        i++;
        while (i < len && isDigit(input.charCodeAt(i))) i++;
    } else {
        return 0;
    }

    if (i < len && input.charCodeAt(i) === 0x2e /* . */) {
        i++;
        const fracStart = i;
        while (i < len && isDigit(input.charCodeAt(i))) i++;
        if (i === fracStart) return 0;
    }

    if (i < len) {
        const e = input.charCodeAt(i);
        if (e === 0x65 /* e */ || e === 0x45 /* E */) {
            i++;
            if (i < len) {
                const sign = input.charCodeAt(i);
                if (sign === 0x2b /* + */ || sign === 0x2d /* - */) i++;
            }
            const expStart = i;
            while (i < len && isDigit(input.charCodeAt(i))) i++;
            if (i === expStart) return 0;
        }
    }

    return i - start;
}

export function isWhitespace(ch: number): boolean {
    return (
        ch === 0x20 ||
        ch === 0x09 ||
        ch === 0x0a ||
        ch === 0x0d ||
        ch === 0x0b ||
        ch === 0x0c
    );
}

export function isDigit(ch: number): boolean {
    return ch >= 0x30 && ch <= 0x39;
}

function canStartToken(ch: number): boolean {
    if (isWhitespace(ch)) return true;
    if (isDigit(ch)) return true;
    return (
        ch === 0x7b || // {
        ch === 0x7d || // }
        ch === 0x5b || // [
        ch === 0x5d || // ]
        ch === 0x2c || // ,
        ch === 0x3a || // :
        ch === 0x22 || // "
        ch === 0x2d || // -
        ch === 0x74 || // t
        ch === 0x66 || // f
        ch === 0x6e //   n
    );
}
