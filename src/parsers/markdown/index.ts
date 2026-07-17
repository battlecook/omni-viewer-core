import { decodeUtf8, type Diagnostic, type ParseOutcome, type ParseOptions } from '../types.js';

export interface MarkdownHeading { level: number; text: string; id: string; start: number; end: number; }
export interface MarkdownBlock { start: number; end: number; }
export interface MarkdownDocument {
    /** Complete decoded source, retained for source view/edit/writeback. */
    text: string;
    /** Prefix that passed all structural limits and is safe to hand to a renderer. */
    renderText: string;
    headings: MarkdownHeading[];
    blocks: MarkdownBlock[];
}
export const MARKDOWN_DEFAULT_LIMITS = { maxInputBytes: 10 * 1024 * 1024, maxBlocks: 200_000, maxHeadings: 10_000, maxDepth: 64 } as const;
export interface MarkdownStructuralLimits { maxBlocks: number; maxHeadings: number; maxDepth: number; }
export interface MarkdownParseOptions extends ParseOptions { markdownLimits?: Partial<MarkdownStructuralLimits>; }

/** A deliberately lightweight source index. Rendering is owned by the viewer's
 * marked dependency; this parser gives TOC/search deterministic source spans. */
export function parseMarkdown(data: Uint8Array, options: MarkdownParseOptions = {}): ParseOutcome<MarkdownDocument> {
    const started = Date.now();
    if (data.byteLength > (options.limits?.maxInputBytes ?? MARKDOWN_DEFAULT_LIMITS.maxInputBytes)) {
        return { result: { status: 'failed', failure: { code: 'limit-exceeded', retryable: false, messageKey: 'diag.markdown.limit-exceeded' }, diagnostics: [] }, execution: { workerUsed: false, hardLimitEnforced: true, elapsedMillis: Date.now() - started } };
    }
    const maxBlocks=options.markdownLimits?.maxBlocks??MARKDOWN_DEFAULT_LIMITS.maxBlocks;const maxHeadings=options.markdownLimits?.maxHeadings??MARKDOWN_DEFAULT_LIMITS.maxHeadings;const maxDepth=options.markdownLimits?.maxDepth??MARKDOWN_DEFAULT_LIMITS.maxDepth;
    const text = decodeUtf8(data); const headings: MarkdownHeading[] = []; const blocks: MarkdownBlock[] = [];
    let offset = 0; let ordinal = 0;
    for (const line of text.split(/(?<=\n)/)) {
        if (options.signal?.aborted) return { result: { status: 'failed', failure: { code: 'aborted', retryable: true, messageKey: 'diag.aborted' }, diagnostics: [] }, execution: { workerUsed: false, hardLimitEnforced: true, elapsedMillis: Date.now() - started } };
        if (blocks.length >= maxBlocks) break; blocks.push({ start: offset, end: offset + line.length });
        const hit = /^(#{1,6})\s+(.+?)\s*#*\s*(?:\n|$)/.exec(line) ?? /^\s*<h([1-6])[^>]*>(.*?)<\/h\1>\s*$/i.exec(line);
        const depth = markdownDepth(line); const headingLevel = hit ? (/^\s*</.test(line) ? Number(hit[1]) : hit[1]!.length) : 0;
        if ((hit && headingLevel>maxDepth)||depth>maxDepth) break;
        if (hit) { if (headings.length >= maxHeadings) break; headings.push({ level: headingLevel, text: hit[2]!, id: `heading-${ordinal++}`, start: offset, end: offset + line.length }); }
        offset += line.length;
    }
    const diagnostics: Diagnostic[] = [];
    const partial = offset < text.length;
    if (partial) diagnostics.push({ severity: 'warning', code: 'markdown.limit-exceeded', messageKey: 'diag.markdown.limit-exceeded' });
    // `text` must remain complete so a partial preview can never truncate the
    // source on save. Renderers, however, must consume only this bounded prefix.
    const document = { text, renderText: text.slice(0, offset), headings, blocks };
    return { result: partial ? { status: 'partial', document, diagnostics } : { status: 'ok', document, diagnostics }, execution: { workerUsed: false, hardLimitEnforced: true, elapsedMillis: Date.now() - started } };
}
function markdownDepth(line: string): number { let i=0, depth=0; while(i<line.length){const quote=/^\s*>\s?/.exec(line.slice(i));if(quote){depth++;i+=quote[0].length;continue;}const list=/^\s*(?:[-+*]|\d+[.)])\s+/.exec(line.slice(i));if(list){depth++;i+=list[0].length;continue;}break;}return depth;}
