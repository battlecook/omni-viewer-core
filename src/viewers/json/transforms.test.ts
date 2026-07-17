import { describe, expect, it } from 'vitest';
import { parseJson, type JsonNode } from '../../parsers/json/index.js';
import {
    base64Decode,
    base64Encode,
    escapeText,
    jsonToCsv,
    jsonToXml,
    jsonToYaml,
    serialize,
    toPlainValue,
    unescapeText
} from './transforms.js';

function rootOf(src: string): JsonNode {
    const { result } = parseJson(src);
    if (result.status === 'failed') throw new Error('parse failed');
    return result.document.root;
}

function plain(src: string): unknown {
    return toPlainValue(rootOf(src));
}

describe('serialize (fidelity model)', () => {
    it('pretty and minified match JSON.stringify shape for normal input', () => {
        const root = rootOf('{"a":1,"b":[2,3]}');
        expect(serialize(root, false)).toBe('{"a":1,"b":[2,3]}');
        expect(serialize(root, true)).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
    });

    it('preserves raw numbers that JSON.stringify would round', () => {
        const root = rootOf('{"n":12345678901234567890}');
        expect(serialize(root, false)).toBe('{"n":12345678901234567890}');
    });

    it('sorts keys by code unit when requested', () => {
        const root = rootOf('{"b":1,"a":2}');
        expect(serialize(root, false, true)).toBe('{"a":2,"b":1}');
    });

    it('handles empty containers', () => {
        expect(serialize(rootOf('{}'), true)).toBe('{}');
        expect(serialize(rootOf('[]'), true)).toBe('[]');
    });
});

describe('escape / unescape / base64 (부록 B-2)', () => {
    it('escape strips outer quotes (vscode)', () => {
        expect(escapeText('a"b')).toBe('a\\"b');
        expect(escapeText('c:\\path')).toBe('c:\\\\path');
        expect(escapeText('한글\n')).toBe('한글\\n');
    });

    it('unescape resolves escapes and unwraps quotes', () => {
        expect(unescapeText('"a\\tb"')).toEqual({ ok: true, output: 'a\tb' });
        expect(unescapeText('a\\z')).toEqual({ ok: true, output: 'az' });
    });

    it('unescape reports errors instead of throwing', () => {
        expect(unescapeText('a\\')).toEqual({ ok: false, error: 'trailing' });
        expect(unescapeText('a\\uZZ')).toEqual({ ok: false, error: 'invalid-unicode' });
    });

    it('base64 round-trips UTF-8', () => {
        expect(base64Encode('한')).toBe('7ZWc');
        expect(base64Decode('7ZWc')).toEqual({ ok: true, output: '한' });
    });

    it('base64 decode reports invalid input', () => {
        expect(base64Decode('@@@@')).toEqual({ ok: false, error: 'invalid-base64' });
    });
});

describe('jsonToCsv (부록 B-3)', () => {
    it('emits header + rows and quotes cells with separators', () => {
        expect(jsonToCsv(plain('[{"a":1,"b":"x,y"}]'))).toEqual({
            ok: true,
            output: 'a,b\n1,"x,y"'
        });
    });

    it('serializes nested objects and empties nulls', () => {
        expect(jsonToCsv(plain('{"n":null,"o":{"k":1}}'))).toEqual({
            ok: true,
            output: 'n,o\n,"{""k"":1}"'
        });
    });

    it('errors on non-object input (no silent empty result)', () => {
        expect(jsonToCsv(plain('[1,2]'))).toEqual({ ok: false, error: 'csv-requires-objects' });
    });
});

describe('jsonToXml (부록 B-4)', () => {
    it('sanitizes tag names and escapes text', () => {
        const { output } = jsonToXml(plain('{"a b":1}')) as { output: string };
        expect(output).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<root>\n  <a_b>1</a_b>\n</root>');
        const xml2 = jsonToXml(plain('{"2n":"<>"}')) as { output: string };
        expect(xml2.output).toContain('<node_2n>&lt;&gt;</node_2n>');
    });

    it('wraps array items in <item>', () => {
        const { output } = jsonToXml(plain('[1,2]')) as { output: string };
        expect(output).toContain('<item>1</item>\n  <item>2</item>');
    });
});

describe('jsonToYaml (부록 B-5)', () => {
    it('nests objects and arrays with 2-space indent', () => {
        expect(jsonToYaml(plain('{"a":1,"b":[1,2]}'))).toEqual({
            ok: true,
            output: 'a: 1\nb:\n  - 1\n  - 2'
        });
    });

    it('quotes scalars with special characters', () => {
        expect(jsonToYaml(plain('{"s":"x: y"}'))).toEqual({ ok: true, output: 's: "x: y"' });
        expect(jsonToYaml(plain('{"e":""}'))).toEqual({ ok: true, output: 'e: ""' });
    });

    it('renders empty containers', () => {
        expect(jsonToYaml(plain('[]'))).toEqual({ ok: true, output: '[]' });
    });
});
