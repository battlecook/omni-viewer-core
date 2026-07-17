// TeX math extraction for the markdown viewer. Math must be lifted out of the
// source BEFORE marked runs: `$a_i + b_i$` would otherwise be mangled by
// emphasis parsing. Segments are replaced with inert placeholder tokens that
// survive marked and DOMPurify unchanged, then swapped for rendered math in
// the sanitized preview DOM (same post-sanitize slot pattern as diagrams).

export interface MathSegment {
    source: string;
    display: boolean;
}

export interface MaskedMathSource {
    masked: string;
    segments: MathSegment[];
}

/** Deliberately free of `_`/`*`/`$` so markdown inline rules ignore it. */
export const MATH_TOKEN_PREFIX = 'omni-math-token-';
const TOKEN = (index: number): string => `%%${MATH_TOKEN_PREFIX}${index}%%`;
export const MATH_TOKEN_PATTERN = /%%omni-math-token-(\d+)%%/g;

/** Literal text a segment came from, for copy-HTML output and fallbacks. */
export function mathSegmentLiteral(segment: MathSegment): string {
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
export function maskMathSegments(source: string): MaskedMathSource {
    const segments: MathSegment[] = [];
    let out = '';
    let index = 0;
    let atLineStart = true;
    let fence: string | null = null;

    const lineEnd = (from: number): number => {
        const at = source.indexOf('\n', from);
        return at === -1 ? source.length : at;
    };

    while (index < source.length) {
        if (atLineStart) {
            const rest = source.slice(index, lineEnd(index));
            const marker = FENCE.exec(rest)?.[1];
            if (marker) {
                if (!fence) fence = marker[0]!.repeat(3);
                else if (marker.startsWith(fence)) fence = null;
            }
        }
        const char = source[index]!;
        atLineStart = char === '\n';
        if (fence) { out += char; index++; continue; }

        if (char === '\\' && source[index + 1] === '$') { out += '\\$'; index += 2; continue; }

        if (char === '`') {
            // Inline code span: copy verbatim through the matching backtick run.
            let run = 1;
            while (source[index + run] === '`') run++;
            const close = source.indexOf('`'.repeat(run), index + run);
            const end = close === -1 ? index + run : close + run;
            const span = source.slice(index, end);
            out += span;
            if (span.includes('\n')) atLineStart = span.endsWith('\n');
            index = end;
            continue;
        }

        if (char === '$') {
            if (source[index + 1] === '$') {
                const close = source.indexOf('$$', index + 2);
                const body = close === -1 ? '' : source.slice(index + 2, close);
                if (close !== -1 && body.trim() && !/\n[ \t]*\n/.test(body) && body.length <= MAX_DISPLAY_MATH_LENGTH) {
                    segments.push({ source: body.trim(), display: true });
                    out += TOKEN(segments.length - 1);
                    atLineStart = false;
                    index = close + 2;
                    continue;
                }
            } else {
                const end = lineEnd(index);
                const line = source.slice(index + 1, end);
                const match = /^([^\s$](?:[^$]*[^\s$])?)\$(?!\d)/.exec(line);
                if (match && match[1]!.length <= MAX_INLINE_MATH_LENGTH && !match[1]!.includes('`')) {
                    segments.push({ source: match[1]!, display: false });
                    out += TOKEN(segments.length - 1);
                    atLineStart = false;
                    index += 1 + match[0]!.length;
                    continue;
                }
            }
        }

        out += char;
        index++;
    }

    return { masked: out, segments };
}
