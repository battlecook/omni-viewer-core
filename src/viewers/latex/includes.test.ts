import { describe, expect, it, vi } from 'vitest';
import { parseLatex, type LatexBlock, type LatexDocument } from '../../parsers/latex/index.js';
import { normalizeIncludePath, resolveIncludes } from './includes.js';

const doc = (body: string, preamble = '\\documentclass{article}\n'): LatexDocument => {
    const { result } = parseLatex(new TextEncoder().encode(`${preamble}\\begin{document}\n${body}\n\\end{document}\n`));
    if (result.status === 'failed') throw new Error('unexpected failure');
    return result.document;
};

const kinds = (blocks: readonly LatexBlock[]): string[] => blocks.map(b => b.kind);

describe('normalizeIncludePath', () => {
    it('adds the conventional .tex extension', () => {
        expect(normalizeIncludePath('chapters/intro')).toBe('chapters/intro.tex');
        expect(normalizeIncludePath('chapters/intro.tex')).toBe('chapters/intro.tex');
    });

    it('normalizes separators and same-directory segments', () => {
        expect(normalizeIncludePath('./chapters//intro')).toBe('chapters/intro.tex');
        expect(normalizeIncludePath('chapters\\intro')).toBe('chapters/intro.tex');
        expect(normalizeIncludePath('a/b/../intro')).toBe('a/intro.tex');
    });

    it('refuses anything that leaves the document folder', () => {
        for (const path of [
            '../secrets', 'a/../../secrets', '/etc/passwd', '\\\\host\\share\\x',
            'C:/Windows/system.ini', 'file:///etc/passwd', 'https://evil.test/x.tex',
            '%2e%2e/secrets', '..', '', '   '
        ]) {
            expect(normalizeIncludePath(path), path).toBeNull();
        }
    });

    it('rejects a NUL byte in the path', () => {
        expect(normalizeIncludePath('chapters/intro\0.tex')).toBeNull();
    });

    it('refuses double-encoded traversal instead of passing an escape through', () => {
        // `%252e%252e` decodes once to `%2e%2e`; a URL-building resolver would
        // decode that a second time and land outside the document folder.
        expect(normalizeIncludePath('%252e%252e/secret')).toBeNull();
        expect(normalizeIncludePath('%25252e%25252e/secret')).toBeNull();
        expect(normalizeIncludePath('a/%252e%252e/%252e%252e/secret')).toBeNull();
        // Layered escapes that decode to something harmless are fine — what is
        // refused is an escape *surviving* the decode loop, which is what a
        // second decode downstream would act on.
        expect(normalizeIncludePath('chapters/%2541.tex')).toBe('chapters/A.tex');
        expect(normalizeIncludePath('%2e%2e%2f%2e%2e/x')).toBeNull();
    });
});

describe('resolveIncludes', () => {
    it('replaces an unresolved reference with the included document', async () => {
        const resolve = vi.fn(async () => '\\section{From the chapter}\nChapter text.\n');
        const result = await resolveIncludes(doc('\\input{chapters/one}\n'), resolve);
        expect(resolve).toHaveBeenCalledWith('chapters/one.tex');
        expect(kinds(result.body)).toEqual(['include']);
        const include = result.body[0];
        if (include?.kind !== 'include') throw new Error('expected an include');
        expect(kinds(include.blocks)).toEqual(['heading', 'paragraph']);
        expect(result.outline.map(h => [h.text, h.source])).toEqual([['From the chapter', 'chapters/one.tex']]);
    });

    it('keeps included spans relative to the included file', async () => {
        const child = '\\section{Child}\nBody.\n';
        const result = await resolveIncludes(doc('\\input{one}\n'), async () => child);
        const include = result.body[0];
        if (include?.kind !== 'include') throw new Error('expected an include');
        const heading = include.blocks[0]!;
        expect(child.slice(heading.span.start, heading.span.end)).toBe('\\section{Child}');
    });

    it('namespaces included heading ids so they cannot collide with the main file', async () => {
        const files: Record<string, string> = {
            'one.tex': '\\section{From one}\n',
            'two.tex': '\\section{From two}\n'
        };
        const result = await resolveIncludes(
            doc('\\section{Main}\n\n\\input{one}\n\n\\input{two}\n'),
            async path => files[path] ?? null
        );
        const ids = result.outline.map(h => h.id);
        expect(new Set(ids).size).toBe(ids.length);
        // The DOM ids the viewer renders must match the outline entries.
        const rendered: string[] = [];
        const walk = (blocks: readonly LatexBlock[]): void => {
            for (const block of blocks) {
                if (block.kind === 'heading') rendered.push(block.id);
                if (block.kind === 'include') walk(block.blocks);
            }
        };
        walk(result.body);
        expect(rendered.sort()).toEqual(ids.sort());
    });

    it('resolves nested includes', async () => {
        const files: Record<string, string> = {
            'one.tex': 'First.\n\\input{two}\n',
            'two.tex': 'Second.\n'
        };
        const result = await resolveIncludes(doc('\\input{one}\n'), async path => files[path] ?? null);
        const outer = result.body[0];
        if (outer?.kind !== 'include') throw new Error('expected an include');
        const inner = outer.blocks.find(b => b.kind === 'include');
        expect(inner?.kind === 'include' && inner.path).toBe('two.tex');
    });

    it('never asks the resolver for a path outside the document folder', async () => {
        const resolve = vi.fn(async () => 'nope');
        const result = await resolveIncludes(doc('\\input{../../etc/passwd}\n'), resolve);
        expect(resolve).not.toHaveBeenCalled();
        expect(kinds(result.body)).toEqual(['unresolved']);
        expect(result.diagnostics.map(d => d.code)).toContain('latex.include-blocked');
    });

    it('places included headings where the \\input sits, not after everything', async () => {
        const result = await resolveIncludes(
            doc('\\section{Before}\n\n\\input{one}\n\n\\section{After}\n'),
            async () => '\\section{Child}\n'
        );
        expect(result.outline.map(h => h.text)).toEqual(['Before', 'Child', 'After']);
        expect(result.outline.map(h => h.source)).toEqual([undefined, 'one.tex', undefined]);
    });

    it('breaks include cycles', async () => {
        const files: Record<string, string> = {
            'a.tex': '\\input{b}\n',
            'b.tex': '\\input{a}\n'
        };
        const result = await resolveIncludes(doc('\\input{a}\n'), async path => files[path] ?? null);
        expect(result.diagnostics.map(d => d.code)).toContain('latex.include-cycle');
    });

    it('resolves the same file twice when it is not a cycle', async () => {
        // A shared macro or preamble chapter is commonly \input more than once;
        // only a file including one of its own ancestors is a cycle.
        const result = await resolveIncludes(
            doc('\\input{shared}\n\n\\input{shared}\n'),
            async () => 'Shared text.\n'
        );
        expect(kinds(result.body)).toEqual(['include', 'include']);
        expect(result.diagnostics).toEqual([]);
    });

    it('still reports a cycle when a file reaches its own ancestor indirectly', async () => {
        const files: Record<string, string> = {
            'a.tex': '\\input{b}\n',
            'b.tex': '\\input{c}\n',
            'c.tex': '\\input{a}\n'
        };
        const result = await resolveIncludes(doc('\\input{a}\n'), async path => files[path] ?? null);
        expect(result.diagnostics.map(d => d.code)).toContain('latex.include-cycle');
    });

    it('stops at the depth limit and leaves the reference visible', async () => {
        const result = await resolveIncludes(
            doc('\\input{one}\n'),
            async () => '\\input{deeper}\n',
            { limits: { maxDepth: 2 } }
        );
        expect(result.diagnostics.map(d => d.code)).toContain('latex.include-depth-exceeded');
    });

    it('stops at the file-count limit', async () => {
        const result = await resolveIncludes(
            doc('\\input{a}\n\n\\input{b}\n\n\\input{c}\n'),
            async () => 'text\n',
            { limits: { maxFiles: 2 } }
        );
        expect(result.diagnostics.map(d => d.code)).toContain('latex.include-limit-exceeded');
        expect(result.body.filter(b => b.kind === 'include')).toHaveLength(2);
    });

    it('stops when the included sources exceed the total size limit', async () => {
        const result = await resolveIncludes(
            doc('\\input{a}\n\n\\input{b}\n'),
            async () => 'x'.repeat(100),
            { limits: { maxTotalLength: 150 } }
        );
        expect(result.diagnostics.map(d => d.code)).toContain('latex.include-limit-exceeded');
    });

    it('does not let one oversized include exhaust the budget for the rest', async () => {
        const files: Record<string, string> = { 'big.tex': 'x'.repeat(200), 'small.tex': 'Small text.\n' };
        const result = await resolveIncludes(
            doc('\\input{big}\n\n\\input{small}\n'),
            async path => files[path] ?? null,
            { limits: { maxTotalLength: 150 } }
        );
        // The rejected file must not be charged to the total, or everything
        // after it is refused on a budget nothing was actually spent from.
        expect(kinds(result.body)).toEqual(['unresolved', 'include']);
    });

    it('surfaces an included file’s own diagnostics, tagged with its path', async () => {
        // A chapter truncated by a limit used to say nothing: its diagnostics
        // were dropped on the way out of the child parse.
        const child = Array.from({ length: 40 }, (_, i) => `Para ${i}.`).join('\n\n');
        const result = await resolveIncludes(
            doc('\\input{big}\n'),
            async () => child,
            { parse: { latexLimits: { maxBlocks: 3 } } }
        );
        const limit = result.diagnostics.find(d => d.code === 'latex.limit-exceeded');
        expect(limit).toBeDefined();
        expect(limit?.location).toBe('big.tex');
    });

    it('resolves preamble \\input so its macros reach the renderer', async () => {
        const { result } = parseLatex(new TextEncoder().encode(
            '\\documentclass{article}\n\\input{macros}\n\\begin{document}\nText $\\R$.\n\\end{document}\n'
        ));
        if (result.status === 'failed') throw new Error('unexpected failure');
        const resolved = await resolveIncludes(
            result.document,
            async path => path === 'macros.tex' ? '\\newcommand{\\R}{\\mathbb{R}}\n' : null
        );
        expect(resolved.macros).toEqual({ R: '\\mathbb{R}' });
    });

    it('lets the document’s own definitions win over an inherited one', async () => {
        const { result } = parseLatex(new TextEncoder().encode(
            '\\documentclass{article}\n\\input{macros}\n\\newcommand{\\R}{\\mathbf{R}}\n\\begin{document}\nText.\n\\end{document}\n'
        ));
        if (result.status === 'failed') throw new Error('unexpected failure');
        const resolved = await resolveIncludes(result.document, async () => '\\newcommand{\\R}{\\mathbb{R}}\n\\newcommand{\\Z}{\\mathbb{Z}}\n');
        expect(resolved.macros).toEqual({ R: '\\mathbf{R}', Z: '\\mathbb{Z}' });
    });

    it('reports a missing file without dropping the reference', async () => {
        const result = await resolveIncludes(doc('\\input{gone}\n'), async () => null);
        expect(kinds(result.body)).toEqual(['unresolved']);
        expect(result.diagnostics.map(d => d.code)).toContain('latex.include-missing');
    });

    it('survives a resolver that throws', async () => {
        const result = await resolveIncludes(doc('\\input{boom}\n'), async () => { throw new Error('io'); });
        expect(kinds(result.body)).toEqual(['unresolved']);
        expect(result.diagnostics.map(d => d.code)).toContain('latex.include-missing');
    });

    it('resolves includes nested inside lists and theorems', async () => {
        const source = doc('\\begin{itemize}\n\\item \\input{one}\n\\end{itemize}\n\n\\begin{proof}\n\\input{two}\n\\end{proof}\n');
        const result = await resolveIncludes(source, async () => 'text\n');
        const list = result.body.find(b => b.kind === 'list');
        expect(list?.kind === 'list' && kinds(list.items[0]!)).toContain('include');
        const proof = result.body.find(b => b.kind === 'theorem');
        expect(proof?.kind === 'theorem' && kinds(proof.body)).toContain('include');
    });

    it('leaves \\includegraphics alone — it is not a text include', async () => {
        const resolve = vi.fn(async () => 'text');
        const result = await resolveIncludes(doc('\\includegraphics{plot.png}\n'), resolve);
        expect(resolve).not.toHaveBeenCalled();
        expect(kinds(result.body)).toEqual(['unresolved']);
    });
});
