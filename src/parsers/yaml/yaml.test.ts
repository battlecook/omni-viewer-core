import { describe, expect, it } from 'vitest';
import { parseYaml } from './index.js';
import { loadYamlParserDeps } from './self-loading.js';
describe('parseYaml', () => {
    it('preserves multiple documents, anchors, aliases and scalar source', async () => {
        const deps = await loadYamlParserDeps(); const result = parseYaml('a: &base 01\nb: *base\n---\nc: true', { deps }).result;
        expect(result.status).toBe('ok'); if (result.status === 'failed') return;
        expect(result.document.documents).toHaveLength(2);
        const first = result.document.documents[0]!; expect(first.children?.[0]?.anchorId).toBe('base'); expect(first.children?.[0]?.raw).toBe('01'); expect(first.children?.[1]?.kind).toBe('alias');
    });
    it('resolves scalar alias values against their anchors', async () => {
        const deps = await loadYamlParserDeps(); const result = parseYaml('a: &base 01\nb: *base\nc: &map\n  x: 1\nd: *map', { deps }).result;
        expect(result.status).toBe('ok'); if (result.status === 'failed') return;
        const children = result.document.documents[0]!.children!;
        expect(children[1]).toMatchObject({ kind: 'alias', aliasOf: 'base', value: 1, raw: '01' });
        expect(children[3]).toMatchObject({ kind: 'alias', aliasOf: 'map', raw: '*map' });
    });
    it('reports duplicate keys as warnings instead of parse errors', async () => {
        const deps = await loadYamlParserDeps(); const result = parseYaml('a: 1\na: 2\nb: 3', { deps }).result;
        expect(result.status).toBe('partial'); if (result.status === 'failed') return;
        expect(result.diagnostics).toEqual([{ severity: 'warning', code: 'yaml.duplicate-key', messageKey: 'diag.yaml.duplicate-key', args: { key: 'a' }, location: '$doc[0]' }]);
        expect(result.document.documents[0]!.children?.map(child => child.path)).toEqual(['$doc[0].a', '$doc[0].a#2', '$doc[0].b']);
        expect(result.document.documents[0]!.children?.map(child => child.key)).toEqual(['a', 'a', 'b']);
    });
    it('reports document syntax errors and tree limits as partial', async () => {
        const deps = await loadYamlParserDeps();
        expect(parseYaml('a: [1', { deps }).result.status).toBe('partial');
        expect(parseYaml('a:\n  b:\n    c: 1', { deps, limits: { maxDepth: 1 } }).result.status).toBe('partial');
    });
});
