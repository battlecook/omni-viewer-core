import { describe, expect, it } from 'vitest';
import { tokenizeJson } from './tokenizer.js';

/** The tokenizer must be lossless: concatenating token text rebuilds the input. */
function roundtrips(input: string): boolean {
    return tokenizeJson(input).map((t) => t.text).join('') === input;
}

describe('tokenizeJson', () => {
    it('classifies keys vs strings via the colon lookahead', () => {
        const kinds = tokenizeJson('{"k":"v"}')
            .filter((t) => t.kind !== 'whitespace' && t.kind !== 'punct')
            .map((t) => `${t.kind}:${t.text}`);
        expect(kinds).toEqual(['key:"k"', 'string:"v"']);
    });

    it('preserves whitespace and is lossless', () => {
        expect(roundtrips('{\n  "a": 1,\n  "b": [true, null]\n}')).toBe(true);
    });

    it('emits numbers, booleans, and null as their own kinds', () => {
        const kinds = tokenizeJson('[1, -2.5e3, true, false, null]')
            .filter((t) => t.kind !== 'whitespace' && t.kind !== 'punct')
            .map((t) => t.kind);
        expect(kinds).toEqual(['number', 'number', 'bool', 'bool', 'null']);
    });

    it('never throws and stays lossless on malformed input', () => {
        expect(roundtrips('{"a": "unterminated')).toBe(true);
        expect(roundtrips('@@@ garbage @@@')).toBe(true);
        expect(tokenizeJson('')).toEqual([]);
    });
});
