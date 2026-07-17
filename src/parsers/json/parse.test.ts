import { describe, expect, it } from 'vitest';
import { parseJson } from './index.js';
import type { JsonNode } from './model.js';

/** Walk to a node by JSONPath for concise assertions. */
function at(root: JsonNode, path: string): JsonNode | undefined {
    if (root.path === path) return root;
    for (const child of root.children ?? []) {
        const found = at(child, path);
        if (found) return found;
    }
    return undefined;
}

function okDoc(input: string) {
    const { result } = parseJson(input);
    if (result.status === 'failed') {
        throw new Error(`expected non-failed, got failed: ${result.failure.code}`);
    }
    return result;
}

describe('parseJson — value kinds', () => {
    it('parses all primitive kinds with paths', () => {
        const { document, status } = okDoc(
            '{"s":"hi","n":42,"b":true,"z":null}'
        ) as { document: { root: JsonNode }; status: string };
        expect(status).toBe('ok');
        const root = document.root;
        expect(root.kind).toBe('object');
        expect(at(root, '$.s')?.value).toBe('hi');
        expect(at(root, '$.n')?.kind).toBe('number');
        expect(at(root, '$.b')?.value).toBe(true);
        expect(at(root, '$.z')?.value).toBe(null);
    });

    it('accepts any top-level value (not just objects/arrays)', () => {
        expect(okDoc('42').status).toBe('ok');
        expect(okDoc('"bare"').status).toBe('ok');
        expect(okDoc('true').status).toBe('ok');
    });

    it('builds bracket paths for non-identifier keys and array indices', () => {
        const { document } = okDoc('{"a":[10,20],"odd key":1}') as {
            document: { root: JsonNode };
        };
        const root = document.root;
        expect(at(root, '$.a[0]')?.rawNumber).toBe('10');
        expect(at(root, '$.a[1]')?.rawNumber).toBe('20');
        expect(at(root, '$["odd key"]')?.rawNumber).toBe('1');
    });
});

describe('parseJson — fidelity (J1)', () => {
    it('preserves raw number text (no float64 rounding)', () => {
        const big = '12345678901234567890';
        const { document } = okDoc(`{"n":${big},"e":1e400}`) as {
            document: { root: JsonNode };
        };
        expect(at(document.root, '$.n')?.rawNumber).toBe(big);
        expect(at(document.root, '$.e')?.rawNumber).toBe('1e400');
    });

    it('keeps duplicate keys in order and diagnoses them', () => {
        const { result } = parseJson('{"a":1,"a":2}');
        if (result.status === 'failed') throw new Error('unexpected failed');
        const children = result.document.root.children ?? [];
        expect(children.map((c) => c.rawNumber)).toEqual(['1', '2']);
        expect(result.diagnostics.some((d) => d.code === 'json.duplicate-key')).toBe(true);
    });

    it('decodes string escapes in values but keeps source text verbatim', () => {
        const { document } = okDoc('{"k":"a\\tb\\u00e9"}') as {
            document: { root: JsonNode; text?: string };
        };
        expect(at(document.root, '$.k')?.value).toBe('a\tbé');
    });

    it('exposes the decoded source text on the document', () => {
        const src = '{ "x" : 1 }';
        const { result } = parseJson(src);
        if (result.status !== 'ok') throw new Error('expected ok');
        expect(result.document.text).toBe(src);
    });
});

describe('parseJson — strict string validation (P1a)', () => {
    it('rejects invalid escapes, bad \\u, and raw control chars', () => {
        for (const bad of ['{"k":"\\q"}', '{"k":"\\u12G4"}', '{"k":"a\nb"}']) {
            const { result } = parseJson(bad);
            expect(result.status, bad).not.toBe('ok');
        }
    });

    it('rejects invalid escapes inside keys', () => {
        expect(parseJson('{"\\q":1}').result.status).not.toBe('ok');
    });

    it('still accepts all valid escapes', () => {
        const { result } = parseJson('{"k":"a\\"b\\\\c\\/d\\b\\f\\n\\r\\t\\u00e9"}');
        expect(result.status).toBe('ok');
    });
});

describe('parseJson — failure and partial (J20)', () => {
    it('returns failed with invalid-format when nothing parses', () => {
        const { result } = parseJson('not json at all');
        expect(result.status).toBe('failed');
        if (result.status === 'failed') {
            expect(result.failure.code).toBe('invalid-format');
        }
    });

    it('recovers a prefix as partial on a mid-tree syntax error', () => {
        const { result } = parseJson('{"a":1, "b": }');
        expect(result.status).toBe('partial');
        if (result.status === 'partial') {
            expect(at(result.document.root, '$.a')?.rawNumber).toBe('1');
            expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(true);
        }
    });

    it('flags trailing content as partial', () => {
        const { result } = parseJson('{"a":1} garbage');
        expect(result.status).toBe('partial');
        expect(
            result.status !== 'failed' &&
                result.diagnostics.some((d) => d.code === 'json.trailing-content')
        ).toBe(true);
    });
});

describe('parseJson — limits and cancellation', () => {
    it('fails with aborted when the signal is already aborted', () => {
        const controller = new AbortController();
        controller.abort();
        const { result } = parseJson('{"a":1}', { signal: controller.signal });
        expect(result.status).toBe('failed');
        if (result.status === 'failed') expect(result.failure.code).toBe('aborted');
    });

    it('fails when input exceeds maxInputBytes', () => {
        const { result } = parseJson('{"a":1}', { limits: { maxInputBytes: 3 } });
        expect(result.status).toBe('failed');
        if (result.status === 'failed') expect(result.failure.code).toBe('limit-exceeded');
    });

    it('stops with partial + limit diagnostic past maxEntries', () => {
        const arr = '[' + Array.from({ length: 50 }, (_, i) => i).join(',') + ']';
        const { result } = parseJson(arr, { limits: { maxEntries: 10 } });
        expect(result.status).toBe('partial');
        expect(
            result.status !== 'failed' &&
                result.diagnostics.some((d) => d.code === 'limit-exceeded')
        ).toBe(true);
    });

    it('stops on deep nesting past maxDepth', () => {
        const deep = '['.repeat(30) + ']'.repeat(30);
        const { result } = parseJson(deep, { maxDepth: 5 });
        expect(result.status).toBe('partial');
        expect(
            result.status !== 'failed' &&
                result.diagnostics.some((d) => d.code === 'json.max-depth')
        ).toBe(true);
    });
});

describe('parseJson — determinism', () => {
    it('produces identical results for the same bytes', () => {
        const src = '{"a":[1,2,{"b":"x"}],"c":null}';
        const a = parseJson(src).result;
        const b = parseJson(new TextEncoder().encode(src)).result;
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
});
