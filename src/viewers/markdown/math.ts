// TeX math extraction for the markdown viewer. Math must be lifted out of the
// source BEFORE marked runs: `$a_i + b_i$` would otherwise be mangled by
// emphasis parsing. Segments are replaced with inert placeholder tokens that
// survive marked and DOMPurify unchanged, then swapped for rendered math in
// the sanitized preview DOM (same post-sanitize slot pattern as diagrams).

export interface MathSegment {
    source: string;
    display: boolean;
    /** Exact original spelling when tokens may need to be restored as code. */
    literal?: string;
}

export interface MaskedMathSource {
    masked: string;
    segments: MathSegment[];
}

export interface MathMaskOptions {
    tokenPrefix?: string;
    /** Leave raw HTML tags, attributes, and code bodies unchanged. */
    preserveHtml?: boolean;
    /** Protect Markdown code blocks and link metadata before tokenization. */
    preserveMarkdown?: boolean;
    retainLiteral?: boolean;
}

/** Deliberately free of `_`/`*`/`$` so markdown inline rules ignore it. */
export const MATH_TOKEN_PREFIX = 'omni-math-token-';
export const MATH_TOKEN_PATTERN = /%%omni-math-token-(\d+)%%/g;

/** Literal text a segment came from, for copy-HTML output and fallbacks. */
export function mathSegmentLiteral(segment: MathSegment): string {
    if (segment.literal !== undefined) return segment.literal;
    return segment.display ? `$$${segment.source}$$` : `$${segment.source}$`;
}

const FENCE = /^(`{3,}|~{3,})/;
const MAX_DISPLAY_MATH_LENGTH = 5000;
const MAX_INLINE_MATH_LENGTH = 1000;

/**
 * Replace `$...$` (inline) and `$$...$$` (display) TeX spans with placeholder
 * tokens. Fenced code blocks and inline code spans are left untouched.
 * Inline rules follow KaTeX auto-render: content must not start or end with
 * whitespace and the closing `$` must not be followed by a digit. Display
 * math may span lines but not blank lines.
 */
export function maskMathSegments(source: string, options: MathMaskOptions = {}): MaskedMathSource {
    const segments: MathSegment[] = [];
    const token = (index: number): string => `%%${options.tokenPrefix ?? MATH_TOKEN_PREFIX}${index}%%`;
    let out = '';
    let index = 0;
    let atLineStart = true;
    let fence: string | null = null;
    let paragraphOpen = false;
    let indentedCodeOpen = false;
    let quoteDepth = 0;
    const listIndents: number[] = [];
    let fenceListIndent = 0;
    let fenceQuoteDepth = 0;
    let backtickRuns: Map<number, { positions: number[]; cursor: number }> | undefined;
    let inlineBreaks: number[] | undefined;
    let inlineBreakCursor = 0;
    // Malformed tags must not repeatedly scan the same remaining source.
    // Callers can restore code/attribute tokens after their Markdown parser.
    let htmlScanBudget = source.length;
    let metadataScanBudget = source.length;
    let mathHtmlScanBudget = source.length;
    const lastTagClose = options.preserveHtml ? source.lastIndexOf('>') : -1;
    const closedHtmlTag = (from: number): boolean => {
        if (lastTagClose <= from) return false;
        let quote = '';
        for (let cursor = from + 1; cursor <= lastTagClose; cursor++) {
            // Preserve suspected markup conservatively if malformed input has
            // spent the scan budget. Ordinary tags consume each range once.
            if (mathHtmlScanBudget-- <= 0) return true;
            const next = source[cursor]!;
            if (quote) { if (next === quote) quote = ''; }
            else if (next === '"' || next === "'") quote = next;
            else if (next === '<') return false;
            else if (next === '>') return true;
        }
        return false;
    };

    let cachedLineEnd = -1;
    const lineEnd = (from: number): number => {
        if (from > cachedLineEnd) {
            const at = source.indexOf('\n', from);
            cachedLineEnd = at === -1 ? source.length : at;
        }
        return cachedLineEnd;
    };
    const mathClose = (from: number, limit: number, display: boolean): number => {
        let braces = 0;
        for (let cursor = from; cursor < limit; cursor++) {
            if (source[cursor] === '\\') { cursor++; continue; }
            if (source[cursor] === '{') braces++;
            else if (source[cursor] === '}') braces = Math.max(0, braces - 1);
            if (options.preserveHtml && !braces && source[cursor] === '<') {
                const remaining = source.slice(cursor, limit);
                // A delimiter inside protected code or an HTML attribute
                // cannot close math that began in preceding prose. TeX macro
                // arguments can still contain literal angle-bracket text.
                if ((/^<\/?(?:pre|code|kbd|samp)(?=[\s/>])/i.test(remaining) ||
                    /^<\/?[A-Za-z][\w:-]*\s+[^\s"'<>/=]+(?=[\s=/>])/.test(remaining)) && closedHtmlTag(cursor)) return -1;
            }
            if (source[cursor] === '$' && (!display || source[cursor + 1] === '$')) return cursor;
        }
        return -1;
    };
    const displayBody = (body: string): string => {
        if (!options.preserveMarkdown) return body;
        const containerIndent = listIndents[listIndents.length - 1] ?? 0;
        const prefix = quoteDepth ? new RegExp(`^(?: {0,3}>[ \\t]?){${quoteDepth}}`) : null;
        return body.split('\n').map((line, index) => {
            if (!index) return line;
            let content = prefix ? line.replace(prefix, '') : line;
            let remaining = containerIndent, cursor = 0;
            while (remaining > 0 && (content[cursor] === ' ' || content[cursor] === '\t')) {
                remaining -= content[cursor] === '\t' ? 4 : 1; cursor++;
            }
            content = `${remaining < 0 ? ' '.repeat(-remaining) : ''}${content.slice(cursor)}`;
            return content;
        }).join('\n');
    };

    while (index < source.length) {
        if (atLineStart) {
            const rest = source.slice(index, lineEnd(index));
            // Match the renderer's four-space tab expansion for block syntax;
            // the original source is still copied verbatim into masked output.
            const blockSource = options.preserveMarkdown ? rest.replace(/\t/g, '    ') : rest;
            // Blockquote prefixes are Markdown structure, not code contents.
            let quotePrefix = options.preserveMarkdown ? /^(?: {0,3}>[ \t]?)+/.exec(blockSource)?.[0] ?? '' : '';
            if (options.preserveMarkdown && fence) {
                quotePrefix = fenceQuoteDepth ? new RegExp(`^(?: {0,3}>[ \\t]?){${fenceQuoteDepth}}`).exec(blockSource)?.[0] ?? '' : '';
            }
            const blockLine = blockSource.slice(quotePrefix.length);
            const depth = quotePrefix.replace(/[^>]/g, '').length;
            if (options.preserveMarkdown && depth !== quoteDepth) {
                paragraphOpen = false; indentedCodeOpen = false; listIndents.length = 0;
                if (fence && depth < fenceQuoteDepth) fence = null;
            }
            quoteDepth = depth;
            let codeLine = blockLine;
            if (options.preserveMarkdown) {
                const indentation = /^ */.exec(blockLine)![0].length;
                const startsItem = /^ {0,3}(?:[-+*]|\d{1,9}[.)]) +/.test(blockLine);
                if (blockLine.trim()) {
                    while (listIndents.length && indentation < listIndents[listIndents.length - 1]! &&
                        (!paragraphOpen || startsItem || !!fence)) listIndents.pop();
                }
                let containerIndent = listIndents[listIndents.length - 1] ?? 0;
                if (indentation >= containerIndent) codeLine = blockLine.slice(containerIndent);
                if (fence && containerIndent < fenceListIndent) fence = null;
                // Five or more spaces after a list marker use one space as
                // list padding; the remaining four start an indented code block.
                let marker: RegExpExecArray | null;
                while (!fence && (marker = /^ {0,3}(?:[-+*]|\d{1,9}[.)])( +)/.exec(codeLine))) {
                    const spaces = marker[1]!.length;
                    const prefixLength = marker[0].length - spaces + (spaces > 4 ? 1 : spaces);
                    codeLine = codeLine.slice(prefixLength); containerIndent += prefixLength;
                    listIndents.push(containerIndent);
                    paragraphOpen = false; indentedCodeOpen = false;
                }
            }
            const indented = /^(?: {4}|\t)/.test(codeLine);
            const definition = /^ {0,3}\[[^\]]+\]:/.test(codeLine);
            if (options.preserveMarkdown && !fence && ((indented && (!paragraphOpen || indentedCodeOpen)) || definition)) {
                paragraphOpen = false; indentedCodeOpen = indented && !definition;
                out += rest; index += rest.length; atLineStart = false; continue;
            }
            const fenceLine = options.preserveMarkdown ? codeLine : blockLine;
            const markerMatch = (options.preserveMarkdown ? /^ {0,3}(`{3,}|~{3,})/ : FENCE).exec(fenceLine);
            let marker = markerMatch?.[1];
            if (options.preserveMarkdown && !fence && marker?.startsWith('`') && fenceLine.slice(markerMatch![0].length).includes('`')) marker = undefined;
            if (marker) {
                if (!fence) {
                    fence = options.preserveMarkdown ? marker : marker[0]!.repeat(3);
                    fenceListIndent = listIndents[listIndents.length - 1] ?? 0; fenceQuoteDepth = depth;
                } else if (marker.startsWith(fence) && (!options.preserveMarkdown || /^ {0,3}(?:`+|~+)[ \t]*$/.test(fenceLine))) fence = null;
                if (options.preserveMarkdown) {
                    paragraphOpen = false; indentedCodeOpen = false;
                    out += rest; index += rest.length; atLineStart = false; continue;
                }
            }
            if (options.preserveMarkdown && !fence) {
                indentedCodeOpen = false;
                // Indented code cannot interrupt a paragraph or a list item's
                // paragraph. Blank lines and block boundaries close that state.
                paragraphOpen = !!codeLine.trim() && !/^ {0,3}(?:#{1,6}(?:\s|$)|(?:[-*_][ \t]*){3,}$|=+[ \t]*$|-+[ \t]*$)/.test(codeLine);
            }
        }
        const char = source[index]!;
        atLineStart = char === '\n';
        if (fence) { out += char; index++; continue; }

        if (options.preserveMarkdown && char === '\\') {
            const next = source.charCodeAt(index + 1);
            // CommonMark escapes ASCII punctuation, including delimiters and
            // backslash itself. Consume the pair before HTML/code recognition.
            if (next >= 33 && next <= 47 || next >= 58 && next <= 64 || next >= 91 && next <= 96 || next >= 123 && next <= 126) {
                out += source.slice(index, index + 2); index += 2; continue;
            }
        }
        if (char === '\\' && source[index + 1] === '$') { out += '\\$'; index += 2; continue; }

        if (options.preserveMarkdown && metadataScanBudget > 0 && char === ']' && (source[index + 1] === '(' || source[index + 1] === '[')) {
            const opening = source[index + 1]!;
            const closing = opening === '(' ? ')' : ']';
            let depth = 1, quote = '', end = index;
            for (let cursor = index + 2; cursor < source.length && metadataScanBudget-- > 0; cursor++) {
                const next = source[cursor]!;
                if (next === '\\') { cursor++; continue; }
                if (quote) { if (next === quote) quote = ''; continue; }
                if (opening === '(' && (next === '"' || next === "'" || next === '<') &&
                    (cursor === index + 2 || /\s/.test(source[cursor - 1]!))) { quote = next === '<' ? '>' : next; continue; }
                if (next === opening) depth++;
                else if (next === closing && --depth === 0) { end = cursor + 1; break; }
            }
            if (end > index) {
                const span = source.slice(index, end);
                out += span; atLineStart = span.endsWith('\n'); index = end; continue;
            }
        }

        if (options.preserveHtml && htmlScanBudget > 0 && char === '<') {
            // Recognize HTML without parsing it into a live DOM. Quoted '>'
            // characters belong to attributes, and raw code bodies are literal.
            const tag = /^<\/?([A-Za-z][\w:-]*)(?=[\s/>])/.exec(source.slice(index));
            let end = index;
            if (source.startsWith('<!--', index)) {
                const close = source.indexOf('-->', index + 4);
                end = close < 0 ? source.length : close + 3;
            } else if (tag) {
                let quote = '';
                for (let cursor = index + tag[0].length; cursor < source.length; cursor++) {
                    if (htmlScanBudget-- <= 0) break;
                    const next = source[cursor]!;
                    if (quote) { if (next === quote) quote = ''; }
                    else if (next === '"' || next === "'") quote = next;
                    else if (next === '>') { end = cursor + 1; break; }
                }
                if (end > index && !source.startsWith('</', index) && /^(?:pre|code|script|style|textarea|kbd|samp)$/i.test(tag[1]!)) {
                    const closing = new RegExp(`</${tag[1]}\\s*>`, 'ig');
                    closing.lastIndex = end;
                    const match = closing.exec(source);
                    end = match ? closing.lastIndex : source.length;
                }
            } else {
                const autolink = /^<(?:[A-Za-z][\w+.-]*:[^<>\s]*|[^<>\s]+@[^<>\s]+)>/.exec(source.slice(index));
                if (autolink) end = index + autolink[0].length;
            }
            if (end > index) {
                const span = source.slice(index, end);
                out += span; atLineStart = span.endsWith('\n'); index = end; continue;
            }
        }

        if (char === '`') {
            // Inline code span: copy verbatim through the matching backtick run.
            let run = 1;
            while (source[index + run] === '`') run++;
            let close: number;
            if (options.preserveMarkdown) {
                // Index complete runs once. A shorter run cannot close inside
                // a longer one, and unmatched delimiters must not rescan tails.
                if (!backtickRuns) {
                    backtickRuns = new Map();
                    for (const match of source.matchAll(/`+/g)) {
                        const length = match[0].length;
                        const group = backtickRuns.get(length) ?? { positions: [], cursor: 0 };
                        group.positions.push(match.index); backtickRuns.set(length, group);
                    }
                }
                const group = backtickRuns.get(run)!;
                while (group.cursor < group.positions.length && group.positions[group.cursor]! <= index) group.cursor++;
                close = group.positions[group.cursor] ?? -1;
                if (!inlineBreaks) {
                    inlineBreaks = [];
                    let offset = 0, previousHeading = false, previousQuoteDepth = 0;
                    for (const line of source.split('\n')) {
                        const prefix = /^(?: {0,3}>[ \t]?)+/.exec(line)?.[0] ?? '';
                        const content = line.slice(prefix.length);
                        const depth = prefix.replace(/[^>]/g, '').length;
                        const heading = /^ {0,3}#{1,6}(?:\s|$)/.test(content);
                        const newBlock = heading || /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/.test(content) ||
                            /^ {0,3}(?:`{3,}|~{3,}|=+[ \t]*$|(?:[-*_][ \t]*){3,}$)/.test(content);
                        if (offset && (!content.trim() || newBlock || previousHeading || depth !== previousQuoteDepth)) inlineBreaks.push(offset - 1);
                        previousHeading = heading; previousQuoteDepth = depth; offset += line.length + 1;
                    }
                }
                while (inlineBreakCursor < inlineBreaks.length && inlineBreaks[inlineBreakCursor]! <= index) inlineBreakCursor++;
                if (close >= (inlineBreaks[inlineBreakCursor] ?? Infinity)) close = -1;
            } else close = source.indexOf('`'.repeat(run), index + run);
            const end = close === -1 ? index + run : close + run;
            const span = source.slice(index, end);
            out += span;
            if (span.includes('\n')) atLineStart = span.endsWith('\n');
            index = end;
            continue;
        }

        if (char === '$') {
            if (source[index + 1] === '$') {
                const close = mathClose(index + 2, Math.min(source.length, index + 2 + MAX_DISPLAY_MATH_LENGTH + 1), true);
                const body = close === -1 ? '' : displayBody(source.slice(index + 2, close));
                if (close !== -1 && body.trim() && !/\n[ \t]*\n/.test(body) && body.length <= MAX_DISPLAY_MATH_LENGTH) {
                    segments.push({ source: body.trim(), display: true,
                        ...(options.retainLiteral ? { literal: source.slice(index, close + 2) } : {}) });
                    out += token(segments.length - 1);
                    atLineStart = false;
                    index = close + 2;
                    continue;
                }
            } else {
                const end = lineEnd(index);
                const close = mathClose(index + 1, Math.min(end, index + 1 + MAX_INLINE_MATH_LENGTH + 1), false);
                const body = close === -1 ? '' : source.slice(index + 1, close);
                if (close !== -1 && body && !/^\s|\s$/.test(body) && !/\d/.test(source[close + 1] ?? '') && !body.includes('`')) {
                    segments.push({ source: body, display: false,
                        ...(options.retainLiteral ? { literal: source.slice(index, close + 1) } : {}) });
                    out += token(segments.length - 1);
                    atLineStart = false;
                    index = close + 1;
                    continue;
                }
            }
        }

        out += char;
        index++;
    }

    return { masked: out, segments };
}
