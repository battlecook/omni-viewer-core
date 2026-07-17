import { describe, expect, it } from 'vitest';
import { parseToml } from './index.js';
describe('parseToml', () => {
    it('preserves tables, arrays, and datetime text', () => {
        const result = parseToml('[server]\nports = [80, 443]\nwhen = 1979-05-27T07:32:00Z').result;
        expect(result.status).toBe('ok');
        if (result.status === 'failed') return;
        const server = result.document.root.children?.[0];
        expect(server?.children).toHaveLength(2);
        expect(server?.children?.[1]?.kind).toBe('datetime');
    });
    it('gives array-of-table entries stable indexed paths', () => {
        const result = parseToml('[[products]]\nname="a"\n[[products]]\nname="b"').result;
        expect(result.status).toBe('ok'); if (result.status === 'failed') return;
        expect(result.document.root.children?.[0]?.children?.map(node => node.path)).toEqual(['products[0]', 'products[1]']);
    });
    it('reports node and array limits', () => {
        const result = parseToml('a=[1,2,3]', { limits: { maxArrayLength: 2 } }).result;
        expect(result.status).toBe('partial');
    });
    it('keeps multiline strings and multiline arrays as one declaration', () => {
        const result = parseToml('title = """first\nsecond"""\nraw = \'\'\'one\ntwo\'\'\'\nports = [\n  80,\n  443,\n]').result;
        expect(result.status).toBe('ok');
        if (result.status === 'failed') return;
        expect(result.document.root.children?.[0]?.value).toBe('first\nsecond');
        expect(result.document.root.children?.[1]?.value).toBe('one\ntwo');
        expect(result.document.root.children?.[2]?.children).toHaveLength(2);
    });
});
