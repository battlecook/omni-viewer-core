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
    it('reports document syntax errors and tree limits as partial', async () => {
        const deps = await loadYamlParserDeps();
        expect(parseYaml('a: [1', { deps }).result.status).toBe('partial');
        expect(parseYaml('a:\n  b:\n    c: 1', { deps, limits: { maxDepth: 1 } }).result.status).toBe('partial');
    });
});
