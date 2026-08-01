// Shared TeX math injection contract for the markdown and LaTeX viewers.
//
// Both viewers take the same renderer from the same adapter, so the type and
// the sanitize profile live in one place: two copies of a security-relevant
// allow-list drift, and DESIGN.md §6 forbids adding sanitize routes rather
// than reusing the closest existing one. This *is* markdown's existing route,
// lifted out of `markdown/index.ts` unchanged.

export interface DomPurify {
    sanitize(html: string, options: Record<string, unknown>): string;
}

/**
 * TeX → HTML (KaTeX `renderToString` shape). Output is sanitized before
 * insertion, so the renderer is never trusted with the DOM.
 *
 * `options` is optional so a two-argument renderer written for the markdown
 * viewer remains assignable here; the LaTeX viewer passes the document's
 * preamble macros through it.
 */
export interface MathRenderer {
    renderToHtml(
        source: string,
        displayMode: boolean,
        options?: { macros?: Record<string, string> }
    ): string;
}

/**
 * KaTeX `htmlAndMathml` output: spans positioned via inline style, a MathML
 * twin for accessibility, and SVG for stretchy delimiters. `style` is allowed
 * only inside these fragments — the surrounding document keeps
 * `FORBID_ATTR: ['style']`.
 */
/** Frozen, arrays included: this is an allow-list shared by two viewers and
 *  re-exported further, so a caller must not be able to `push` onto `ADD_ATTR`
 *  and widen what every math fragment in the process is allowed to carry. */
export const MATH_SANITIZE_PROFILE = Object.freeze({
    USE_PROFILES: Object.freeze({ html: true, mathMl: true, svg: true }),
    ADD_ATTR: Object.freeze(['style', 'aria-hidden', 'encoding', 'definitionurl']),
    FORBID_TAGS: Object.freeze(['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'a', 'img'])
});
