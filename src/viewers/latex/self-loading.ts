import type { DomPurify, LatexViewerDeps, MathRenderer } from './index.js';

/**
 * Convenience loader for web adapters. Everything here is optional: without
 * KaTeX or DOMPurify the viewer still shows structure, outline and source, and
 * formulas stay as TeX (docs/viewers/latex.md §2).
 *
 * Both packages are needed together — a math renderer whose output cannot be
 * sanitized is not used (L3), so the deps returned here omit `math` unless
 * DOMPurify loaded too.
 */
export async function loadLatexViewerDeps(): Promise<LatexViewerDeps> {
    const [katexResult, purifierResult] = await Promise.allSettled([
        import('katex' as string),
        import('dompurify' as string)
    ]);
    if (katexResult.status !== 'fulfilled' || purifierResult.status !== 'fulfilled') return {};

    type Katex = { renderToString(source: string, options: Record<string, unknown>): string };
    const katexModule = katexResult.value as { default?: Katex } & Partial<Katex>;
    const katex = katexModule.default ?? (katexModule.renderToString ? (katexModule as Katex) : undefined);
    if (!katex) return {};

    const createDOMPurify = (purifierResult.value as { default(window: Window): DomPurify }).default;
    // KaTeX layout also needs katex.css (+fonts) — the adapter loads those into
    // the page/shadow root alongside the core stylesheet (§5).
    const math: MathRenderer = {
        renderToHtml: (source, displayMode, options) => katex.renderToString(source, {
            displayMode,
            // Not `true`: a formula with one construct KaTeX lacks (amsmath's
            // `multline`, `\hdotsfor`, `\sideset`) still renders everything
            // else correctly this way, and only the unsupported part is marked.
            // Throwing would drop the whole formula back to source.
            throwOnError: false,
            // KaTeX marks those parts in its own alarming red. This viewer already
            // has a vocabulary for "we could not do this" — the amber of the
            // unsupported badges — and reusing it stops an engine limitation from
            // reading as a broken document.
            errorColor: 'var(--omni-warning, #cca700)',
            output: 'htmlAndMathml',
            ...(options?.macros ? { macros: options.macros } : {})
        })
    };
    return { math, createDOMPurify };
}
