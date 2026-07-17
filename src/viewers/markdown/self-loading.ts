import type { MarkdownHighlighter, MarkdownViewerDeps } from './index.js';

/** Convenience loader for web adapters. Markdown parsing and sanitizing are
 * required; syntax highlighting and diagram engines enhance the viewer when
 * their optional peer packages are installed. */
export async function loadMarkdownViewerDeps(): Promise<MarkdownViewerDeps> {
    const [markedModule, purifierModule] = await Promise.all([
        import('marked' as string), import('dompurify' as string)
    ]);
    const marked = markedModule as { marked: { parse(text: string): string } };
    const create = (purifierModule as { default(window: Window): ReturnType<MarkdownViewerDeps['createDOMPurify']> }).default;
    const deps: MarkdownViewerDeps = {
        render: { parse: text => marked.marked.parse(text) },
        createDOMPurify: window => create(window)
    };
    const [highlightResult, mermaidResult, plantUmlResult, katexResult] = await Promise.allSettled([
        import('highlight.js' as string), import('mermaid' as string), import('puml-canvas-js' as string),
        import('katex' as string)
    ]);
    if (highlightResult.status === 'fulfilled') {
        const module = highlightResult.value as { default?: MarkdownHighlighter } & MarkdownHighlighter;
        deps.highlighter = module.default ?? module;
    }
    const mermaid = mermaidResult.status === 'fulfilled'
        ? (mermaidResult.value as { default?: { initialize(options: Record<string, unknown>): void; render(id: string, source: string): Promise<{ svg: string }> } }).default
        : undefined;
    const plantUml = plantUmlResult.status === 'fulfilled'
        ? (plantUmlResult.value as { render?: (source: string, options: { document: Document }) => SVGElement }).render
        : undefined;
    if (mermaid || plantUml) {
        if (mermaid) mermaid.initialize({ startOnLoad: false, theme: 'base', securityLevel: 'strict', maxTextSize: 200000 });
        deps.diagrams = {
            ...(mermaid ? { renderMermaid: async (id: string, source: string) => (await mermaid.render(id, source)).svg } : {}),
            ...(plantUml ? { renderPlantUml: (source: string, document: Document) => plantUml(source, { document }) } : {})
        };
    }
    if (katexResult.status === 'fulfilled') {
        type Katex = { renderToString(source: string, options: Record<string, unknown>): string };
        const module = katexResult.value as { default?: Katex } & Partial<Katex>;
        const katex = module.default ?? (module.renderToString ? (module as Katex) : undefined);
        if (katex) {
            // KaTeX layout also needs katex.css (+fonts) — the adapter loads
            // those into the page/shadow root alongside the core stylesheet.
            deps.math = {
                renderToHtml: (source, displayMode) =>
                    katex.renderToString(source, { displayMode, throwOnError: false, output: 'htmlAndMathml' })
            };
        }
    }
    return deps;
}
