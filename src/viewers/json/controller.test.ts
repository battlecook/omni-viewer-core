import { describe, expect, it } from 'vitest';
import { createJsonController } from './controller.js';

const SAMPLE = '{"a":1,"b":{"c":[2,3]},"d":"hello"}';

describe('createJsonController — initial state', () => {
    it('defaults to tree preview with pretty form', () => {
        const c = createJsonController(SAMPLE);
        expect(c.state.viewMode).toBe('tree');
        expect(c.state.sourceForm).toBe('pretty');
        expect(c.state.status).toBe('ok');
    });

    it('expands containers at depth 0 and 1 (J9)', () => {
        const c = createJsonController(SAMPLE);
        expect(c.state.expanded.has('$')).toBe(true); // depth 0
        expect(c.state.expanded.has('$.b')).toBe(true); // depth 1
        expect(c.state.expanded.has('$.b.c')).toBe(false); // depth 2
    });

    it('computes statistics (J10)', () => {
        const c = createJsonController(SAMPLE);
        expect(c.state.statistics).toEqual({
            total: 7, // root, a, b, c(array), 2, 3, d
            maxDepth: 3,
            counts: { object: 2, array: 1, string: 1, number: 3, boolean: 0, null: 0 }
        });
    });
});

describe('createJsonController — tree interaction', () => {
    it('toggles a container node', () => {
        const c = createJsonController(SAMPLE);
        c.dispatch({ type: 'toggle-node', id: '$.b.c' });
        expect(c.state.expanded.has('$.b.c')).toBe(true);
        c.dispatch({ type: 'toggle-node', id: '$.b.c' });
        expect(c.state.expanded.has('$.b.c')).toBe(false);
    });

    it('expand-all and collapse-all', () => {
        const c = createJsonController(SAMPLE);
        c.dispatch({ type: 'expand-all' });
        expect(c.state.expanded.has('$.b.c')).toBe(true);
        c.dispatch({ type: 'collapse-all' });
        expect([...c.state.expanded]).toEqual(['$']);
    });
});

describe('createJsonController — duplicate keys are addressable (P1b)', () => {
    it('gives duplicate-key nodes distinct ids and copies the right value', () => {
        const c = createJsonController('{"a":1,"a":2}');
        c.dispatch({ type: 'set-search', search: '$.a' });
        // Two matches, distinct ids, mapping to the same JSONPath.
        expect(c.matches.length).toBe(2);
        expect(c.matches[0]).not.toBe(c.matches[1]);
        expect(c.nodePath(c.matches[0]!)).toBe('$.a');
        expect(c.nodePath(c.matches[1]!)).toBe('$.a');
        // Each id copies its own value — not both collapsing to the last.
        expect(c.nodeValue(c.matches[0]!)).toBe('1');
        expect(c.nodeValue(c.matches[1]!)).toBe('2');
    });
});

describe('createJsonController — expand resets on reparse (P2a)', () => {
    it('applies the initial expand rule to newly added depth-1 containers', () => {
        const c = createJsonController('{"a":1}');
        c.dispatch({ type: 'edit-scratchpad', text: '{"a":1,"b":{"c":2}}' });
        // The new depth-1 container $.b starts expanded (depth < 2), not carried
        // over as collapsed from the previous document.
        expect(c.state.expanded.has('$.b')).toBe(true);
        expect(c.state.expanded.has('$.b.c')).toBe(false); // depth 2 stays collapsed
    });
});

describe('createJsonController — search (J16)', () => {
    it('matches on value and auto-expands ancestors', () => {
        const c = createJsonController(SAMPLE);
        c.dispatch({ type: 'set-search', search: 'hello' });
        expect(c.state.matchCount).toBe(1);
        expect(c.matches).toEqual(['$.d']);
    });

    it('matches on key, path, and type as well as value', () => {
        const c = createJsonController(SAMPLE);
        c.dispatch({ type: 'set-search', search: 'array' }); // type
        expect(c.matches).toContain('$.b.c');
        c.dispatch({ type: 'set-search', search: 'b.c' }); // path
        expect(c.matches).toContain('$.b.c');
    });

    it('cycles matches with next/prev', () => {
        const c = createJsonController('{"x":1,"y":1,"z":1}');
        c.dispatch({ type: 'set-search', search: '1' });
        expect(c.state.matchCount).toBe(3);
        expect(c.state.currentMatch).toBe(0);
        c.dispatch({ type: 'next-match' });
        expect(c.state.currentMatch).toBe(1);
        c.dispatch({ type: 'prev-match' });
        c.dispatch({ type: 'prev-match' });
        expect(c.state.currentMatch).toBe(2); // wrapped
    });
});

describe('createJsonController — toolbox routing (J11/부록 B-1)', () => {
    it('pretty/minify replace the scratchpad immediately', () => {
        const c = createJsonController('{"a":1}');
        c.dispatch({ type: 'run-tool', action: 'minify' });
        expect(c.state.scratchpad).toBe('{"a":1}');
        c.dispatch({ type: 'run-tool', action: 'pretty' });
        expect(c.state.scratchpad).toBe('{\n  "a": 1\n}');
        expect(c.state.toolResult).toBeNull(); // transforms don't open a panel
        expect(c.state.statusMessage?.key).toBe('json.tool.formatted');
    });

    it('sort-keys reorders and replaces the scratchpad', () => {
        const c = createJsonController('{"b":1,"a":2}');
        c.dispatch({ type: 'run-tool', action: 'sort-keys' });
        expect(c.state.scratchpad).toBe('{\n  "a": 2,\n  "b": 1\n}');
    });

    it('validate reports status without a panel', () => {
        const c = createJsonController('[1,2,3]');
        c.dispatch({ type: 'run-tool', action: 'validate' });
        expect(c.state.statusMessage).toEqual({
            key: 'json.tool.valid',
            args: { summary: 'Array(3)' }
        });
        expect(c.state.toolResult).toBeNull();
    });

    it('converters open the result panel', () => {
        const c = createJsonController('[{"a":1}]');
        c.dispatch({ type: 'run-tool', action: 'to-csv' });
        expect(c.state.toolResult?.action).toBe('to-csv');
        expect(c.state.toolResult?.output).toBe('a\n1');
        expect(c.state.scratchpad).toBe('[{"a":1}]'); // unchanged
    });

    it('converter errors surface in the panel (not thrown)', () => {
        const c = createJsonController('[1,2]');
        c.dispatch({ type: 'run-tool', action: 'to-csv' });
        expect(c.state.toolResult?.error?.key).toBe('json.tool.csvRequiresObjects');
    });

    it('escape/unescape replace the scratchpad immediately', () => {
        const c = createJsonController('"a\\tb"');
        c.dispatch({ type: 'run-tool', action: 'unescape' });
        expect(c.state.scratchpad).toBe('a\tb');
        expect(c.state.toolResult).toBeNull(); // no panel — editor is replaced
        expect(c.state.statusMessage?.key).toBe('json.tool.unescaped');
        c.dispatch({ type: 'run-tool', action: 'escape' });
        expect(c.state.scratchpad).toBe('a\\tb');
        expect(c.state.statusMessage?.key).toBe('json.tool.escaped');
    });

    it('chains Base64 encode/decode through the scratchpad', () => {
        const c = createJsonController('{"a":1}');
        c.dispatch({ type: 'run-tool', action: 'base64-encode' });
        const once = c.state.scratchpad;
        expect(c.state.statusMessage?.key).toBe('json.tool.base64Encoded');
        c.dispatch({ type: 'run-tool', action: 'base64-encode' });
        expect(c.state.scratchpad).not.toBe(once);
        c.dispatch({ type: 'run-tool', action: 'base64-decode' });
        expect(c.state.scratchpad).toBe(once);
        c.dispatch({ type: 'run-tool', action: 'base64-decode' });
        expect(c.state.scratchpad).toBe('{"a":1}');
        expect(c.state.status).toBe('ok'); // decode → pretty chaining works
    });

    it('unescape failure reports status and keeps scratchpad', () => {
        const c = createJsonController('a\\');
        const before = c.state.scratchpad;
        c.dispatch({ type: 'run-tool', action: 'unescape' });
        expect(c.state.scratchpad).toBe(before);
        expect(c.state.toolResult).toBeNull();
        expect(c.state.statusMessage?.key).toBe('json.tool.unescapeFailed');
    });

    it('transforms on invalid JSON report invalid instead of throwing', () => {
        const c = createJsonController('{bad');
        c.dispatch({ type: 'run-tool', action: 'pretty' });
        expect(c.state.statusMessage?.key).toBe('json.tool.invalid');
    });
});

describe('createJsonController — scratchpad + result panel', () => {
    it('apply-result-to-editor replaces the scratchpad and reparses', () => {
        const c = createJsonController('{"a":1}');
        c.dispatch({ type: 'run-tool', action: 'to-yaml' });
        c.dispatch({ type: 'apply-result-to-editor' });
        expect(c.state.scratchpad).toBe('a: 1');
        expect(c.state.status).toBe('failed'); // 'a: 1' isn't valid JSON
        expect(c.state.toolResult).toBeNull();
    });

    it('edit-scratchpad reparses and updates the tree', () => {
        const c = createJsonController('{"a":1}');
        c.dispatch({ type: 'edit-scratchpad', text: '{"a":1,"b":2}' });
        expect(c.state.statistics?.counts.number).toBe(2);
        expect(c.state.status).toBe('ok');
    });
});

describe('createJsonController — source forms and copy (J14/J16)', () => {
    it('renders verbatim / pretty / minified source', () => {
        const c = createJsonController('{ "a" : 1 }');
        c.dispatch({ type: 'set-source-form', form: 'verbatim' });
        expect(c.sourceText()).toBe('{ "a" : 1 }');
        c.dispatch({ type: 'set-source-form', form: 'minified' });
        expect(c.sourceText()).toBe('{"a":1}');
        c.dispatch({ type: 'set-source-form', form: 'pretty' });
        expect(c.sourceText()).toBe('{\n  "a": 1\n}');
    });

    it('copies node path and value', () => {
        const c = createJsonController('{"a":{"b":42}}');
        expect(c.nodePath('$.a.b')).toBe('$.a.b');
        expect(c.nodeValue('$.a.b')).toBe('42');
        expect(c.nodeValue('$.a')).toBe('{\n  "b": 42\n}');
    });
});

describe('createJsonController — broken JSON keeps source (J20)', () => {
    it('exposes verbatim text and failed status without throwing', () => {
        const c = createJsonController('not json');
        expect(c.state.status).toBe('failed');
        expect(c.verbatimText()).toBe('not json');
        expect(c.state.failure?.code).toBe('invalid-format');
    });
});
