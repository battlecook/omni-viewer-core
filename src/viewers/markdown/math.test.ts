// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { CATALOG_EN } from '../../i18n/catalog.en.js';
import { mountMarkdownViewer, type MarkdownViewerContext, type MarkdownViewerDeps } from './index.js';
import { maskMathSegments, mathSegmentLiteral } from './math.js';

describe('maskMathSegments', () => {
    it('extracts inline and display math with placeholder tokens', () => {
        const { masked, segments } = maskMathSegments('Euler: $e^{i\\pi}+1=0$ and\n\n$$\\int_0^1 x\\,dx$$');
        expect(segments).toEqual([
            { source: 'e^{i\\pi}+1=0', display: false },
            { source: '\\int_0^1 x\\,dx', display: true }
        ]);
        expect(masked).toBe('Euler: %%omni-math-token-0%% and\n\n%%omni-math-token-1%%');
    });

    it('protects TeX subscripts from markdown emphasis by masking before marked', () => {
        const { masked, segments } = maskMathSegments('$a_i + b_i$');
        expect(segments[0]?.source).toBe('a_i + b_i');
        expect(masked).not.toContain('_');
    });

    it('leaves fenced code blocks and inline code untouched', () => {
        const source = '```\n$x$\n```\nand `$y$` end';
        const { masked, segments } = maskMathSegments(source);
        expect(segments).toEqual([]);
        expect(masked).toBe(source);
    });

    it('rejects unbalanced, empty, whitespace-delimited, and price-like spans', () => {
        expect(maskMathSegments('$ 5 + $6').segments).toEqual([]);
        expect(maskMathSegments('cost: $5 and $6 total').segments).toEqual([]);
        expect(maskMathSegments('$$$$').segments).toEqual([]);
        expect(maskMathSegments('open $x').segments).toEqual([]);
    });

    it('keeps escaped dollars literal', () => {
        const { masked, segments } = maskMathSegments('\\$5 is not math');
        expect(segments).toEqual([]);
        expect(masked).toBe('\\$5 is not math');
    });

    it('display math may span lines but not blank lines', () => {
        expect(maskMathSegments('$$\na+b\n$$').segments).toEqual([{ source: 'a+b', display: true }]);
        expect(maskMathSegments('$$\na\n\nb\n$$').segments).toEqual([]);
    });

    it('formats literals for copy output', () => {
        expect(mathSegmentLiteral({ source: 'x', display: false })).toBe('$x$');
        expect(mathSegmentLiteral({ source: 'x', display: true })).toBe('$$x$$');
    });
});

const mathDeps: MarkdownViewerDeps = {
    render: { parse: source => `<p>${source}</p>` },
    createDOMPurify: () => ({ sanitize: html => html }),
    math: { renderToHtml: (source, display) => `<span class="katex" data-display="${display}">${source}</span>` }
};

function ctx(): MarkdownViewerContext {
    return {
        assets: { resolveAssetUrl: async path => path },
        logger: { log: () => undefined },
        i18n: { t: (key, args) => (CATALOG_EN[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(args?.[name] ?? '')) }
    };
}

describe('markdown math rendering', () => {
    it('replaces math tokens in the preview with rendered output', async () => {
        const container = document.createElement('div');
        const handle = await mountMarkdownViewer(
            { fileName: 'math.md', data: new TextEncoder().encode('value $a_i$ end') },
            container, ctx(), mathDeps
        );
        const preview = container.shadowRoot!.querySelector('.omni-markdown__preview')!;
        const math = preview.querySelector('.omni-markdown__math .katex')!;
        expect(math.textContent).toBe('a_i');
        expect(preview.textContent).toContain('value');
        expect(preview.textContent).not.toContain('omni-math-token');
        handle.dispose();
    });

    it('marks display math and keeps inline math inline', async () => {
        const container = document.createElement('div');
        const handle = await mountMarkdownViewer(
            { fileName: 'math.md', data: new TextEncoder().encode('$$x$$ then $y$') },
            container, ctx(), mathDeps
        );
        const nodes = [...container.shadowRoot!.querySelectorAll('.omni-markdown__math')];
        expect(nodes).toHaveLength(2);
        expect(nodes[0]!.classList.contains('omni-markdown__math--display')).toBe(true);
        expect(nodes[1]!.classList.contains('omni-markdown__math--display')).toBe(false);
        handle.dispose();
    });

    it('renders literal dollars untouched when no math renderer is provided', async () => {
        const container = document.createElement('div');
        const { math: _math, ...withoutMath } = mathDeps;
        const handle = await mountMarkdownViewer(
            { fileName: 'math.md', data: new TextEncoder().encode('value $a+b$ end') },
            container, ctx(), withoutMath
        );
        const preview = container.shadowRoot!.querySelector('.omni-markdown__preview')!;
        expect(preview.textContent).toContain('$a+b$');
        expect(preview.querySelector('.omni-markdown__math')).toBeNull();
        handle.dispose();
    });

    it('falls back to the literal source when the renderer throws', async () => {
        const container = document.createElement('div');
        const throwing: MarkdownViewerDeps = { ...mathDeps, math: { renderToHtml: () => { throw new Error('bad tex'); } } };
        const handle = await mountMarkdownViewer(
            { fileName: 'math.md', data: new TextEncoder().encode('broken $\\frac$ here') },
            container, ctx(), throwing
        );
        const math = container.shadowRoot!.querySelector('.omni-markdown__math')!;
        expect(math.classList.contains('is-invalid')).toBe(true);
        expect(math.textContent).toBe('$\\frac$');
        handle.dispose();
    });

    it('never routes math through code blocks and keeps copy HTML literal', async () => {
        const container = document.createElement('div');
        const seen: string[] = [];
        const recording: MarkdownViewerDeps = {
            ...mathDeps,
            render: { parse: source => { seen.push(source); return `<p>${source}</p><pre><code>$code$</code></pre>`; } }
        };
        const handle = await mountMarkdownViewer(
            { fileName: 'math.md', data: new TextEncoder().encode('inline $x$') },
            container, ctx(), recording
        );
        expect(seen[0]).not.toContain('$x$');
        expect(seen[0]).toContain('omni-math-token-0');
        const code = container.shadowRoot!.querySelector('pre code')!;
        expect(code.textContent).toBe('$code$');
        handle.dispose();
    });
});
