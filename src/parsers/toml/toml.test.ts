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
    it('ranges every node onto the source text', () => {
        const text = '[server]\nhost = "example.com"\nports = [80, 443]';
        const result = parseToml(text).result;
        expect(result.status).toBe('ok'); if (result.status === 'failed') return;
        const server = result.document.root.children?.[0]!;
        const slice = (node: { range?: { start: number; end: number } }) => text.slice(node.range!.start, node.range!.end);
        expect(slice(server)).toBe('[server]');
        expect(slice(server.children![0]!)).toBe('host = "example.com"');
        expect(slice(server.children![1]!)).toBe('ports = [80, 443]');
        expect(server.children![1]!.children!.map(slice)).toEqual(['80', '443']);
    });
    it('ranges inline table members and dates array items across lines', () => {
        const text = 'owner = { name = "ada", born = 1815-12-10 }\nports = [\n  80,\n  443,\n]';
        const result = parseToml(text).result;
        expect(result.status).toBe('ok'); if (result.status === 'failed') return;
        const [owner, ports] = result.document.root.children!;
        expect(owner!.children!.map(node => text.slice(node.range!.start, node.range!.end))).toEqual(['name = "ada"', 'born = 1815-12-10']);
        expect(ports!.children!.map(node => node.line)).toEqual([3, 4]);
    });
    it('attaches leading and trailing comments to the declaration below them', () => {
        const text = '# the http listener\n# second line\nport = 8080 # inline note\n\nhost = "x"';
        const result = parseToml(text).result;
        expect(result.status).toBe('ok'); if (result.status === 'failed') return;
        const [port, host] = result.document.root.children!;
        expect(port!.comment).toBe('the http listener\nsecond line\ninline note');
        expect(host!.comment).toBeUndefined();
    });
    it('keeps ranges accurate for CRLF sources and a leading BOM', () => {
        const text = '﻿[a]\r\nb = 1\r\n';
        const result = parseToml(text).result;
        expect(result.status).toBe('ok'); if (result.status === 'failed') return;
        const table = result.document.root.children?.[0]!;
        expect(text.slice(table.range!.start, table.range!.end)).toBe('[a]');
        expect(text.slice(table.children![0]!.range!.start, table.children![0]!.range!.end)).toBe('b = 1');
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
