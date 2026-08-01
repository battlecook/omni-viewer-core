// Multi-file LaTeX documents (docs/viewers/latex.md L4/L15).
//
// The core never reads files. An adapter may inject a resolver, and this module
// decides *what may be asked for* — path containment is a core contract, exactly
// as it is for the markdown viewer's document assets (markdown M4). The adapter
// still enforces the filesystem boundary (symlink escapes and the like) on top.
//
// Resolution happens on the block tree rather than by splicing source text:
// splicing would move every offset after the include, and the editor, the
// outline and writeback all address the *main* file by span. An included file
// therefore becomes a child sub-document whose own spans stay valid.

import { parseLatex, plainText, type LatexBlock, type LatexDocument, type LatexHeading, type LatexParseOptions } from '../../parsers/latex/index.js';
import type { Diagnostic } from '../../parsers/types.js';

/** Returns the file's text, or null when it cannot be provided. */
export type LatexIncludeResolver = (path: string) => Promise<string | null>;

export interface IncludeLimits {
    /** How deep `\input` chains may nest. */
    maxDepth: number;
    /** Total number of files pulled in, across the whole tree. */
    maxFiles: number;
    /** Combined UTF-16 length of all included sources. */
    maxTotalLength: number;
}

/** Enough to unwrap layered escapes; a path needing more is hostile, not typed. */
const MAX_DECODE_PASSES = 4;

export const INCLUDE_DEFAULT_LIMITS: IncludeLimits = {
    maxDepth: 8,
    maxFiles: 64,
    maxTotalLength: 8 * 1024 * 1024
};

export interface ResolveIncludesResult {
    body: LatexBlock[];
    outline: LatexHeading[];
    diagnostics: Diagnostic[];
    /**
     * The document's macros with those from preamble `\input` files merged in
     * underneath, so a document that keeps `\newcommand`s in a separate file
     * still renders its formulas.
     */
    macros: Record<string, string>;
    theorems: Record<string, string>;
}

/**
 * Normalizes an `\input` target and refuses anything that leaves the document
 * root. Returns null when the path must not be requested at all.
 *
 * Rejected: absolute paths, UNC and drive-letter paths, `scheme:` URLs, and any
 * `..` that pops above the root after normalization. LaTeX omits the extension
 * by convention, so a segment without one gets `.tex`.
 */
export function normalizeIncludePath(rawPath: string): string | null {
    let path = rawPath.trim();
    if (!path) return null;
    // A percent-encoded `..` must be caught by the same rule as a literal one —
    // and `%252e%252e` decodes to `%2e%2e`, which a URL-building resolver would
    // decode a second time. Decode to a fixed point, then refuse anything still
    // holding an escape rather than handing the resolver a live traversal.
    try {
        for (let pass = 0; pass < MAX_DECODE_PASSES && /%[0-9a-fA-F]{2}/.test(path); pass++) {
            const decoded = decodeURIComponent(path);
            if (decoded === path) break;
            path = decoded;
        }
    } catch {
        return null;
    }
    if (/%[0-9a-fA-F]{2}/.test(path)) return null;
    if (path.includes('\0')) return null;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return null;   // scheme:
    if (/^[/\\]/.test(path)) return null;                       // absolute or UNC
    if (/^[a-zA-Z]:[/\\]/.test(path)) return null;              // drive letter

    const parts: string[] = [];
    for (const segment of path.split(/[/\\]+/)) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (!parts.length) return null;
            parts.pop();
            continue;
        }
        parts.push(segment);
    }
    if (!parts.length) return null;
    const last = parts[parts.length - 1]!;
    if (!last.includes('.')) parts[parts.length - 1] = `${last}.tex`;
    return parts.join('/');
}

/**
 * Replaces `unresolved` blocks with `include` sub-documents, recursively.
 * Anything that cannot be resolved is left exactly as it was, so a failure is
 * still visible rather than silently blank (L6).
 */
export async function resolveIncludes(
    document: LatexDocument,
    resolve: LatexIncludeResolver,
    options: { parse?: LatexParseOptions; limits?: Partial<IncludeLimits>; signal?: AbortSignal } = {}
): Promise<ResolveIncludesResult> {
    const limits: IncludeLimits = { ...INCLUDE_DEFAULT_LIMITS, ...options.limits };
    const diagnostics: Diagnostic[] = [];
    const seenCodes = new Set<string>();
    let files = 0;
    let totalLength = 0;

    const report = (
        severity: Diagnostic['severity'], code: string, messageKey: string,
        args?: Record<string, string | number>, location?: string
    ): void => {
        // The location is part of the key: the same limit hit in two different
        // included files is two things the reader needs to know about.
        const key = `${code}|${JSON.stringify(args ?? {})}|${location ?? ''}`;
        if (seenCodes.has(key)) return;
        seenCodes.add(key);
        diagnostics.push({ severity, code, messageKey, ...(args ? { args } : {}), ...(location ? { location } : {}) });
    };

    const walk = async (
        blocks: readonly LatexBlock[],
        depth: number,
        // Files on the path from the root to here. A cycle is a file including
        // one of its own ancestors; the *same* file pulled in twice by siblings
        // (a shared macro chapter) is ordinary and must still resolve. The
        // file-count and total-length budgets bound the fan-out instead.
        ancestors: ReadonlySet<string>
    ): Promise<LatexBlock[]> => {
        const out: LatexBlock[] = [];
        for (const block of blocks) {
            if (options.signal?.aborted) { out.push(block); continue; }

            // Containers whose children may themselves contain includes.
            if (block.kind === 'theorem') { out.push({ ...block, body: await walk(block.body, depth, ancestors) }); continue; }
            if (block.kind === 'list') {
                const items: LatexBlock[][] = [];
                for (const item of block.items) items.push(await walk(item, depth, ancestors));
                out.push({ ...block, items });
                continue;
            }
            if (block.kind !== 'unresolved' || (block.command !== 'input' && block.command !== 'include' && block.command !== 'subfile')) {
                out.push(block);
                continue;
            }

            if (depth >= limits.maxDepth) { report('warning', 'latex.include-depth-exceeded', 'diag.latex.include-depth-exceeded'); out.push(block); continue; }
            if (files >= limits.maxFiles) { report('warning', 'latex.include-limit-exceeded', 'diag.latex.include-limit-exceeded'); out.push(block); continue; }

            const path = normalizeIncludePath(block.path);
            if (!path) { report('error', 'latex.include-blocked', 'diag.latex.include-blocked', { path: block.path }); out.push(block); continue; }
            if (ancestors.has(path)) { report('warning', 'latex.include-cycle', 'diag.latex.include-cycle', { path }); out.push(block); continue; }

            let text: string | null = null;
            try {
                text = await resolve(path);
            } catch {
                text = null;
            }
            if (text === null) { report('warning', 'latex.include-missing', 'diag.latex.include-missing', { path }); out.push(block); continue; }

            // The budget is only charged for files that are actually used. Adding
            // the rejected file's length first meant one oversized chapter
            // permanently poisoned the total, refusing every small include after
            // it even though nothing had been spent on them.
            if (totalLength + text.length > limits.maxTotalLength) {
                report('warning', 'latex.include-limit-exceeded', 'diag.latex.include-limit-exceeded');
                out.push(block);
                continue;
            }
            totalLength += text.length;
            files++;

            // An included chapter has no \documentclass of its own, so it is
            // parsed as a fragment — spans then stay relative to that file.
            const parsed = parseLatex(new TextEncoder().encode(text), { ...options.parse, fragment: true });
            if (parsed.result.status === 'failed') {
                report('warning', 'latex.include-unreadable', 'diag.latex.include-unreadable', { path });
                out.push(block);
                continue;
            }
            const child = parsed.result.document;
            // The child's own diagnostics travel with it. Dropping them meant an
            // included chapter could be truncated by a limit and say nothing.
            for (const diagnostic of parsed.result.diagnostics) {
                report(diagnostic.severity, diagnostic.code, diagnostic.messageKey, diagnostic.args, path);
            }
            // Every file's headings are numbered from `heading-0`, so ids from
            // different files collide the moment they share one preview. The
            // prefix is per include, not per path, so it stays stable and unique
            // even if the same file were reachable twice.
            const prefix = `inc${files}-`;
            const childBody = prefixHeadingIds(child.body, prefix);
            const nested = await walk(childBody, depth + 1, new Set([...ancestors, path]));
            out.push({ kind: 'include', command: block.command, path, blocks: nested, span: block.span });
        }
        return out;
    };

    // Preamble `\input`s carry the macro definitions the body's formulas rely on.
    // They produce no blocks, so they are resolved separately and merged
    // underneath the document's own definitions, which stay authoritative.
    const inherited: { macros: Record<string, string>; theorems: Record<string, string> } = { macros: {}, theorems: {} };
    for (const raw of document.preamble.inputs) {
        if (files >= limits.maxFiles) break;
        const path = normalizeIncludePath(raw);
        if (!path) { report('error', 'latex.include-blocked', 'diag.latex.include-blocked', { path: raw }); continue; }
        let text: string | null = null;
        try { text = await resolve(path); } catch { text = null; }
        if (text === null) { report('warning', 'latex.include-missing', 'diag.latex.include-missing', { path }); continue; }
        if (totalLength + text.length > limits.maxTotalLength) {
            report('warning', 'latex.include-limit-exceeded', 'diag.latex.include-limit-exceeded');
            continue;
        }
        totalLength += text.length;
        files++;
        const parsed = parseLatex(new TextEncoder().encode(text), { ...options.parse, fragment: true });
        if (parsed.result.status === 'failed') {
            report('warning', 'latex.include-unreadable', 'diag.latex.include-unreadable', { path });
            continue;
        }
        Object.assign(inherited.macros, parsed.result.document.preamble.macros);
        Object.assign(inherited.theorems, parsed.result.document.preamble.theorems);
    }

    const body = await walk(document.body, 0, new Set());
    // The outline is rebuilt from the resolved tree rather than appended to, so
    // an included file's headings sit where the \input sits — appending put a
    // chapter's headings after everything that follows it in the main file.
    return {
        body,
        outline: collectOutline(body),
        diagnostics,
        macros: { ...inherited.macros, ...document.preamble.macros },
        theorems: { ...inherited.theorems, ...document.preamble.theorems }
    };
}

/**
 * Rebuilds the outline by walking the resolved tree, so entries appear in the
 * order a reader meets them. `source` is attached as the walk descends into an
 * include, which is also how a heading's span is known to address that file
 * rather than the editor's.
 */
function collectOutline(blocks: readonly LatexBlock[], source?: string): LatexHeading[] {
    const headings: LatexHeading[] = [];
    for (const block of blocks) {
        if (block.kind === 'heading') {
            headings.push({
                level: block.level, text: plainText(block.title), id: block.id, span: block.span,
                ...(source ? { source } : {})
            });
        } else if (block.kind === 'include') {
            headings.push(...collectOutline(block.blocks, block.path));
        } else if (block.kind === 'theorem') {
            headings.push(...collectOutline(block.body, source));
        } else if (block.kind === 'list') {
            for (const item of block.items) headings.push(...collectOutline(item, source));
        }
    }
    return headings;
}

/** Rewrites heading ids in a freshly parsed sub-document so they cannot clash
 *  with the main file's, keeping outline entries and DOM ids in step. */
function prefixHeadingIds(blocks: readonly LatexBlock[], prefix: string): LatexBlock[] {
    return blocks.map(block => {
        if (block.kind === 'heading') return { ...block, id: prefix + block.id };
        if (block.kind === 'theorem') return { ...block, body: prefixHeadingIds(block.body, prefix) };
        if (block.kind === 'list') return { ...block, items: block.items.map(item => prefixHeadingIds(item, prefix)) };
        if (block.kind === 'include') return { ...block, blocks: prefixHeadingIds(block.blocks, prefix) };
        return block;
    });
}
