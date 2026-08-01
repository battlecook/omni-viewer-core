// Source-line mapping for the markdown viewer. The preview and the source
// editor are two views of one document, so scrolling either should move the
// other. Rendering is owned by the injected `marked` dependency, which reports
// no source positions, so the mapping is rebuilt here: the source is scanned
// for top-level blocks and paired, in document order, with the top-level
// elements the renderer produced.
//
// Pairings are verified by tag and resynchronise on mismatch — a block that
// cannot be matched confidently is skipped rather than guessed. The result is
// only used to interpolate scroll offsets, so a sparse map costs smoothness,
// never correctness.

/** `opaque` covers raw HTML blocks and link reference definitions: they keep
 *  their place in document order but their rendered shape is unpredictable
 *  (HTML passes through, and the sanitizer may drop it), so they never claim
 *  an element. */
export type SourceBlockKind = 'heading' | 'code' | 'quote' | 'list' | 'table' | 'rule' | 'paragraph' | 'opaque';

export interface SourceBlock {
    /** 1-based line of the block's first line in the rendered source. */
    line: number;
    kind: SourceBlockKind;
}

export const SOURCE_LINE_ATTRIBUTE = 'data-source-line';

/** A fenced block may have been swapped for a rendered diagram frame by the
 *  time lines are assigned, so `code` accepts that shape too. */
const DIAGRAM_CLASS = 'omni-markdown__diagram';
/** How far ahead a block may look for its element before giving up. Bounded so
 *  a block that rendered to nothing cannot steal a later block's anchor. */
const RESYNC_WINDOW = 4;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/;
const BLOCK_QUOTE = /^ {0,3}>/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const HTML_BLOCK = /^ {0,3}<[a-zA-Z!/?]/;
const LINK_DEFINITION = /^ {0,3}\[[^\]\n]+\]:/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const INDENTED_CODE = /^(?: {4}|\t)/;
/** Any indent at all continues an open list or quote, whose content column sits
 *  past the marker — the four spaces an indented code block needs are not the
 *  bar here. */
const INDENTED_CONTINUATION = /^[ \t]/;

function closesFence(line: string, marker: string): boolean {
    const trimmed = line.replace(/^ {0,3}/, '').trimEnd();
    return trimmed.length >= marker.length && !trimmed.split('').some(char => char !== marker[0]);
}

function startKind(line: string): SourceBlockKind {
    if (ATX_HEADING.test(line)) return 'heading';
    // Checked before lists: `- - -` and `***` open a rule, not a list item.
    if (THEMATIC_BREAK.test(line)) return 'rule';
    if (BLOCK_QUOTE.test(line)) return 'quote';
    if (LIST_ITEM.test(line)) return 'list';
    if (LINK_DEFINITION.test(line) || HTML_BLOCK.test(line)) return 'opaque';
    if (INDENTED_CODE.test(line)) return 'code';
    return 'paragraph';
}

/**
 * Whether a line of this kind opens a new block while `openKind` is still
 * absorbing lines — Markdown lets several constructs cut a paragraph short
 * without a blank line first.
 *
 * The two conservative cases carry the weight. A second `- item` or `> quote`
 * line continues the block it is already in, and splitting there would invent a
 * block with no element to claim, which the resync window could then satisfy
 * with a later element — a wrong anchor, worse than the missing one. Lazy
 * continuations (plain text, indented lines) and raw HTML never split for the
 * same reason: a link reference definition looks like an HTML block's opaque
 * sibling but is really just more paragraph text.
 */
function interrupts(kind: SourceBlockKind, openKind: SourceBlockKind): boolean {
    switch (kind) {
        case 'heading': case 'rule': return true;
        case 'quote': case 'list': return openKind !== kind;
        default: return false;
    }
}

/**
 * Top-level blocks of `text`, in document order. Nested structure is not
 * descended into: one list, quote, or table yields one block, matching the one
 * top-level element a markdown renderer emits for it.
 */
export function scanSourceBlocks(text: string): SourceBlock[] {
    const blocks: SourceBlock[] = [];
    let fence = '';
    // The block the previous line opened, while it can still absorb more lines.
    let open: SourceBlock | undefined;
    // The list or quote still in scope. A blank line closes `open` but not the
    // container: an indented line after it resumes the same list, and reading it
    // as a new top-level block would hand the next element the wrong line.
    let container: SourceBlockKind | undefined;

    for (const [index, line] of text.split('\n').entries()) {
        if (fence) {
            if (closesFence(line, fence)) fence = '';
            continue;
        }
        if (!line.trim()) { open = undefined; continue; }

        const opener = FENCE_OPEN.exec(line)?.[1];
        if (opener) {
            fence = opener;
            open = undefined;
            blocks.push({ line: index + 1, kind: 'code' });
            continue;
        }

        const kind = startKind(line);
        if (open) {
            // A setext underline wins over a thematic break after a paragraph.
            if (open.kind === 'paragraph' && SETEXT_UNDERLINE.test(line)) { open.kind = 'heading'; open = undefined; continue; }
            // `index` is 0-based and `open.line` 1-based, so this is the line
            // directly after the paragraph's first — where a table's delimiter
            // row has to be for the renderer to read a table at all.
            if (open.kind === 'paragraph' && index === open.line && line.includes('-') && TABLE_DELIMITER.test(line)) { open.kind = 'table'; continue; }
            if (!interrupts(kind, open.kind)) continue;
        } else if (container && INDENTED_CONTINUATION.test(line)) {
            continue;
        }

        const block: SourceBlock = { line: index + 1, kind };
        blocks.push(block);
        // Headings and rules are single-line: they cannot absorb the next line.
        open = kind === 'heading' || kind === 'rule' ? undefined : block;
        container = kind === 'list' || kind === 'quote' ? kind : undefined;
    }
    return blocks;
}

function matchesKind(element: Element, kind: SourceBlockKind): boolean {
    switch (kind) {
        case 'heading': return /^H[1-6]$/.test(element.tagName);
        case 'code': return element.tagName === 'PRE' || element.classList.contains(DIAGRAM_CLASS);
        case 'quote': return element.tagName === 'BLOCKQUOTE';
        case 'list': return element.tagName === 'UL' || element.tagName === 'OL';
        case 'table': return element.tagName === 'TABLE';
        case 'rule': return element.tagName === 'HR';
        case 'paragraph': return element.tagName === 'P';
        default: return false;
    }
}

/**
 * Tag `preview`'s top-level elements with the source line they came from, and
 * report how many were tagged. Elements left over between matches (raw HTML,
 * anything the sanitizer rewrote) simply stay untagged.
 */
export function assignSourceLines(preview: Element, blocks: readonly SourceBlock[]): number {
    const elements = [...preview.children];
    let at = 0;
    let assigned = 0;
    for (const block of blocks) {
        if (block.kind === 'opaque') {
            // Raw HTML normally does render to something, so step over one
            // element rather than leaving it for the next block to claim as its
            // own — that hands a real element the wrong line. When the sanitizer
            // did drop it, the next block's lookahead recovers, costing an
            // anchor instead of misplacing one.
            if (at < elements.length) at++;
            continue;
        }
        const limit = Math.min(elements.length, at + RESYNC_WINDOW);
        for (let probe = at; probe < limit; probe++) {
            const element = elements[probe]!;
            if (!matchesKind(element, block.kind)) continue;
            element.setAttribute(SOURCE_LINE_ATTRIBUTE, String(block.line));
            at = probe + 1;
            assigned++;
            break;
        }
    }
    return assigned;
}

/** One measured correspondence between the two panes' scroll offsets. */
export interface ScrollPair { from: number; to: number; }

/**
 * Collects pairs while enforcing the strictly-ascending `from` and
 * non-decreasing `to` that {@link projectScroll} interpolates over, so the
 * inverse mapping is obtained by swapping the two fields.
 */
export function createScrollPairs(): { readonly pairs: ScrollPair[]; push(from: number, to: number): void } {
    const pairs: ScrollPair[] = [];
    return {
        pairs,
        push(from, to) {
            const last = pairs[pairs.length - 1];
            if (last && (from <= last.from || to < last.to)) return;
            pairs.push({ from, to });
        }
    };
}

/** Linear interpolation between measured pairs, clamped at both ends. */
export function projectScroll(offset: number, pairs: readonly ScrollPair[]): number {
    if (!pairs.length) return offset;
    const first = pairs[0]!;
    if (offset <= first.from) return first.to;
    for (let index = 1; index < pairs.length; index++) {
        const previous = pairs[index - 1]!;
        const next = pairs[index]!;
        if (offset > next.from) continue;
        const span = next.from - previous.from;
        return previous.to + (next.to - previous.to) * (span > 0 ? (offset - previous.from) / span : 0);
    }
    return pairs[pairs.length - 1]!.to;
}

/** Rect of the character at `at`, or nothing where the environment cannot
 *  measure it — `getClientRects` is absent under some DOM implementations, and
 *  a hidden or unlaid-out panel reports empty rects. */
function firstRect(range: Range, node: Text, at: number): DOMRect | undefined {
    try {
        range.setStart(node, at);
        range.setEnd(node, Math.min(node.length, at + 1));
        const rect = (typeof range.getClientRects === 'function' ? range.getClientRects()[0] : undefined)
            ?? (typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : undefined);
        return rect && (rect.height > 0 || rect.width > 0) ? rect : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Content-box Y of each 1-based line of `text`, measured inside `overlay` —
 * the highlight layer that mirrors the textarea's metrics exactly. Real text
 * rects are used so soft-wrapped lines measure correctly; where the platform
 * reports no rects (jsdom, hidden panels) a uniform line box is assumed, which
 * keeps the mapping usable but approximate.
 */
export function measureLineTops(overlay: HTMLElement, text: string, lines: readonly number[]): number[] {
    const starts = [0];
    for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1);

    const document = overlay.ownerDocument;
    const walker = document.createTreeWalker(overlay, NodeFilter.SHOW_TEXT);
    const nodes: Array<{ node: Text; start: number }> = [];
    let cursor = 0;
    while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        nodes.push({ node, start: cursor });
        cursor += node.length;
    }

    const base = overlay.getBoundingClientRect().top - overlay.scrollTop;
    const parsedLineHeight = Number.parseFloat(document.defaultView?.getComputedStyle(overlay).lineHeight ?? '');
    const lineHeight = Number.isFinite(parsedLineHeight) && parsedLineHeight > 0 ? parsedLineHeight : 20;

    // Requested lines arrive in document order, so the node cursor only moves
    // forward — the walk stays linear in the number of text nodes.
    let holder = 0;
    return lines.map(line => {
        const offset = starts[line - 1];
        if (offset === undefined) return (line - 1) * lineHeight;
        while (holder + 1 < nodes.length && offset > nodes[holder]!.start + nodes[holder]!.node.length) holder++;
        const entry = nodes[holder];
        if (!entry || offset < entry.start || offset > entry.start + entry.node.length) return (line - 1) * lineHeight;
        const rect = firstRect(document.createRange(), entry.node, offset - entry.start);
        return rect ? rect.top - base : (line - 1) * lineHeight;
    });
}
