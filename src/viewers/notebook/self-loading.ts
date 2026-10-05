import type { NotebookViewerDeps } from './index.js';
import type { MarkdownHighlighter } from '../markdown/index.js';

/** Same optional peers as Markdown, without loading diagram engines. */
export async function loadNotebookViewerDeps(): Promise<NotebookViewerDeps> {
    const [markedModule, purifierModule] = await Promise.all([import('marked' as string), import('dompurify' as string)]);
    const marked = markedModule as { marked: { parse(text: string): string } };
    const create = (purifierModule as { default: NotebookViewerDeps['createDOMPurify'] }).default;
    const deps: NotebookViewerDeps = { render: { parse: text => marked.marked.parse(text) }, createDOMPurify: create };
    const [highlight, math] = await Promise.allSettled([import('highlight.js' as string), import('katex' as string)]);
    if (highlight.status === 'fulfilled') {
        const module = highlight.value as { default?: MarkdownHighlighter } & MarkdownHighlighter;
        deps.highlighter = module.default ?? module;
    }
    if (math.status === 'fulfilled') {
        type Katex = { renderToString(source: string, options: Record<string, unknown>): string };
        const module = math.value as { default?: Katex } & Katex;
        const katex = module.default ?? module;
        deps.math = { renderToHtml: (source, displayMode) => katex.renderToString(source,
            { displayMode, throwOnError: false, output: 'htmlAndMathml', trust: false }) };
    }
    return deps;
}
