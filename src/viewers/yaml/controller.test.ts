import { describe, expect, it } from 'vitest';
import { loadYamlParserDeps } from '../../parsers/yaml/self-loading.js';
import { createYamlController } from './controller.js';
describe('YamlController', () => {
    it('selects exactly one document and uses ASCII search normalization', () => {
        const c = createYamlController('ignored', { parse: () => [{ one: 'A' }, { two: 'B' }] });
        c.dispatch({ type: 'select-document', index: 1 });
        expect(c.state.selectedDocument).toBe(1);
        c.dispatch({ type: 'set-search', search: 'B' });
        expect(c.state.search).toBe('B');
    });
    it('serializes the selected document as JSON and accepts flat/json modes', () => {
        const c = createYamlController('ignored', { parse: () => [{ one: 'A' }, { two: 'B' }] });
        c.dispatch({ type: 'select-document', index: 1 });
        expect(JSON.parse(c.documentJson())).toEqual({ two: 'B' });
        c.dispatch({ type: 'set-mode', mode: 'flat' });
        expect(c.state.mode).toBe('flat');
        c.dispatch({ type: 'set-mode', mode: 'json' });
        expect(c.state.mode).toBe('json');
    });
    it('resolves aliases and merge keys in JSON output', async () => {
        const deps = await loadYamlParserDeps();
        const c = createYamlController('base: &b\n  x: 1\n  y: 2\nchild:\n  <<: *b\n  y: 3\nref: *b', deps);
        expect(JSON.parse(c.nodeJson('$doc[0].child'))).toEqual({ x: 1, y: 3 });
        expect(JSON.parse(c.documentJson())).toEqual({ base: { x: 1, y: 2 }, child: { x: 1, y: 3 }, ref: { x: 1, y: 2 } });
    });
    it('breaks self-referencing alias cycles instead of overflowing the stack', async () => {
        const deps = await loadYamlParserDeps();
        const c = createYamlController('a: &x\n  b: *x', deps);
        expect(JSON.parse(c.documentJson())).toEqual({ a: { b: { b: null } } });
    });
    it('resolves redefined anchors in document order', async () => {
        const deps = await loadYamlParserDeps();
        const scalar = createYamlController('a: &x 1\nb: *x\nc: &x 2\nd: *x', deps);
        expect(JSON.parse(scalar.documentJson())).toEqual({ a: 1, b: 1, c: 2, d: 2 });
        const collection = createYamlController('a: &x\n  v: 1\nb: *x\nc: &x\n  v: 2\nd: *x', deps);
        expect(JSON.parse(collection.documentJson())).toEqual({ a: { v: 1 }, b: { v: 1 }, c: { v: 2 }, d: { v: 2 } });
    });
});
