// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
    assignSourceLines, createScrollPairs, measureLineTops, projectScroll,
    scanSourceBlocks, SOURCE_LINE_ATTRIBUTE
} from './source-map.js';

const kinds = (text: string): string[] => scanSourceBlocks(text).map(block => `${block.kind}@${block.line}`);

function preview(html: string): HTMLElement {
    const node = document.createElement('article');
    node.innerHTML = html;
    return node;
}

const anchors = (node: HTMLElement): string[] =>
    [...node.querySelectorAll(`[${SOURCE_LINE_ATTRIBUTE}]`)]
        .map(element => `${element.tagName}:${element.getAttribute(SOURCE_LINE_ATTRIBUTE)}`);

describe('scanSourceBlocks', () => {
    it('reports one block per top-level construct with its first line', () => {
        expect(kinds('# Title\n\nA paragraph\nwrapped over lines.\n\n- one\n- two\n'))
            .toEqual(['heading@1', 'paragraph@3', 'list@6']);
    });

    it('keeps fenced code as a single block and ignores markup inside it', () => {
        expect(kinds('```js\n# not a heading\n\n- not a list\n```\n\nafter\n'))
            .toEqual(['code@1', 'paragraph@7']);
    });

    it('closes a fence only on a matching marker run', () => {
        expect(kinds('~~~\n```\nstill code\n~~~\n\ntext\n')).toEqual(['code@1', 'paragraph@6']);
    });

    it('reads a thematic break as a rule rather than a list', () => {
        expect(kinds('a\n\n- - -\n\nb\n')).toEqual(['paragraph@1', 'rule@3', 'paragraph@5']);
    });

    it('retypes a paragraph that turns out to be a setext heading or a table', () => {
        expect(kinds('Title\n=====\n\nbody\n')).toEqual(['heading@1', 'paragraph@4']);
        expect(kinds('| a | b |\n| - | - |\n| 1 | 2 |\n')).toEqual(['table@1']);
        // A delimiter-shaped line further down is an ordinary paragraph line.
        expect(kinds('lead\ntext\n| - | - |\n')).toEqual(['paragraph@1']);
    });

    it('sees blocks that cut a paragraph short without a blank line', () => {
        expect(kinds('Intro text.\n## Heading\n')).toEqual(['paragraph@1', 'heading@2']);
        expect(kinds('Steps:\n- one\n- two\n')).toEqual(['paragraph@1', 'list@2']);
        expect(kinds('Note:\n> quoted\n')).toEqual(['paragraph@1', 'quote@2']);
        expect(kinds('Before.\n***\nAfter.\n')).toEqual(['paragraph@1', 'rule@2', 'paragraph@3']);
        expect(kinds('Text.\n```js\ncode\n```\n')).toEqual(['paragraph@1', 'code@2']);
    });

    it('interrupts a list or quote only with a different construct', () => {
        // Consecutive items are one <ul>; splitting would invent a block with no
        // element, which the resync window could then satisfy with a later one.
        expect(kinds('- one\n- two\n- three\n')).toEqual(['list@1']);
        expect(kinds('> a\n> b\n')).toEqual(['quote@1']);
        expect(kinds('- item\n# Heading\n')).toEqual(['list@1', 'heading@2']);
        expect(kinds('> quote\n---\n')).toEqual(['quote@1', 'rule@2']);
    });

    it('keeps an indented line after a blank inside the list it belongs to', () => {
        // A loose list: `  continued` resumes the item, so `tail` is the only
        // block after the list. Reading the indented line as a block of its own
        // would give the trailing paragraph's element line 3 instead of line 5.
        expect(kinds('- item\n\n  continued\n\ntail\n')).toEqual(['list@1', 'paragraph@5']);
        expect(kinds('> quote\n\n  more\n\nafter\n')).toEqual(['quote@1', 'paragraph@5']);
        // Outside a container an indented block is still indented code.
        expect(kinds('para\n\n    code\n')).toEqual(['paragraph@1', 'code@3']);
    });

    it('treats lazy continuations as part of the block they trail', () => {
        expect(kinds('- item\nlazy continuation\n')).toEqual(['list@1']);
        expect(kinds('Paragraph.\n    indented but still prose\n')).toEqual(['paragraph@1']);
        // A link definition mid-paragraph is ordinary text, not a new block.
        expect(kinds('Text.\n[ref]: https://example.com\nmore text\n')).toEqual(['paragraph@1']);
        expect(kinds('Text.\n<span>inline html</span>\n')).toEqual(['paragraph@1']);
    });

    it('marks raw HTML and link definitions as opaque', () => {
        expect(kinds('<div>x</div>\n\n[ref]: https://example.com\n\ntext\n'))
            .toEqual(['opaque@1', 'opaque@3', 'paragraph@5']);
    });
});

describe('assignSourceLines', () => {
    it('tags top-level elements with the line their block started on', () => {
        const root = preview('<h1>Title</h1><p>Body</p><ul><li>one</li></ul>');
        expect(assignSourceLines(root, scanSourceBlocks('# Title\n\nBody\n\n- one\n'))).toBe(3);
        expect(anchors(root)).toEqual(['H1:1', 'P:3', 'UL:5']);
    });

    it('skips over elements that no block claims instead of drifting', () => {
        // The raw HTML block renders to <div>, which stays unanchored while the
        // paragraph after it still resolves to the right line.
        const root = preview('<h1>T</h1><div>raw</div><p>Body</p>');
        assignSourceLines(root, scanSourceBlocks('# T\n\n<div>raw</div>\n\nBody\n'));
        expect(anchors(root)).toEqual(['H1:1', 'P:5']);
    });

    it('does not let raw HTML hand its element to the next block', () => {
        // Both blocks render to a <p>; without stepping over the first, the
        // paragraph would claim the raw HTML's element and report line 3 for it.
        const root = preview('<p>raw</p><p>para</p>');
        assignSourceLines(root, scanSourceBlocks('<p>raw</p>\n\npara\n'));
        expect(anchors(root)).toEqual(['P:3']);
        expect(root.children[0]!.hasAttribute(SOURCE_LINE_ATTRIBUTE)).toBe(false);
        expect(root.children[1]!.getAttribute(SOURCE_LINE_ATTRIBUTE)).toBe('3');
    });

    it('skips a block whose element is missing rather than stealing a later one', () => {
        // The sanitizer dropped the paragraph's element; the list must keep its line.
        const root = preview('<h1>T</h1><ul><li>one</li></ul>');
        assignSourceLines(root, scanSourceBlocks('# T\n\nBody\n\n- one\n'));
        expect(anchors(root)).toEqual(['H1:1', 'UL:5']);
    });

    it('accepts a diagram frame in place of the fenced block it replaced', () => {
        const root = preview('<p>Lead</p><div class="omni-markdown__diagram"><svg></svg></div>');
        assignSourceLines(root, scanSourceBlocks('Lead\n\n```mermaid\ngraph TD;\n```\n'));
        expect(anchors(root)).toEqual(['P:1', 'DIV:3']);
    });

    it('never assigns a line twice or out of order', () => {
        const root = preview('<p>a</p><p>b</p><p>c</p>');
        assignSourceLines(root, scanSourceBlocks('a\n\nb\n\nc\n'));
        const assigned = [...root.children].map(node => Number(node.getAttribute(SOURCE_LINE_ATTRIBUTE)));
        expect(assigned).toEqual([1, 3, 5]);
    });
});

describe('createScrollPairs', () => {
    it('drops pairs that would break the ascending order interpolation needs', () => {
        const collector = createScrollPairs();
        collector.push(0, 0);
        collector.push(50, 40);
        collector.push(50, 90); // duplicate origin
        collector.push(30, 120); // out of order
        collector.push(80, 20); // preview offset moving backwards
        collector.push(90, 70);
        expect(collector.pairs).toEqual([{ from: 0, to: 0 }, { from: 50, to: 40 }, { from: 90, to: 70 }]);
    });
});

describe('createScrollPairs + projectScroll', () => {
    it('reaches the far end when several anchors share the last screenful', () => {
        // Anchors past an extent must not be clamped into it: the clamped pair
        // would take the terminal pair's `from`, the terminal pair would be
        // dropped for not ascending, and the last screen would be unreachable.
        const maxSource = 200;
        const maxPreview = 900;
        const collector = createScrollPairs();
        collector.push(0, 0);
        for (const [top, previewTop] of [[100, 400], [220, 700], [260, 850]] as const) {
            if (top >= maxSource || previewTop >= maxPreview) continue;
            collector.push(top, previewTop);
        }
        collector.push(maxSource, maxPreview);
        expect(collector.pairs).toEqual([{ from: 0, to: 0 }, { from: 100, to: 400 }, { from: 200, to: 900 }]);
        expect(projectScroll(maxSource, collector.pairs)).toBe(maxPreview);
    });
});

describe('projectScroll', () => {
    const pairs = [{ from: 0, to: 0 }, { from: 100, to: 300 }, { from: 200, to: 400 }];

    it('interpolates between the surrounding pairs', () => {
        expect(projectScroll(50, pairs)).toBe(150);
        expect(projectScroll(150, pairs)).toBe(350);
    });

    it('clamps outside the measured range and passes through an empty map', () => {
        expect(projectScroll(-10, pairs)).toBe(0);
        expect(projectScroll(9999, pairs)).toBe(400);
        expect(projectScroll(42, [])).toBe(42);
    });

    it('does not divide by a zero-width span', () => {
        expect(projectScroll(10, [{ from: 10, to: 5 }, { from: 10, to: 80 }])).toBe(5);
    });
});

describe('measureLineTops', () => {
    it('falls back to a uniform line box when the platform reports no rects', () => {
        const overlay = document.createElement('pre');
        overlay.textContent = 'one\ntwo\nthree\n';
        document.body.append(overlay);
        // jsdom has no layout, so this exercises the fallback path.
        expect(measureLineTops(overlay, 'one\ntwo\nthree\n', [1, 2, 3])).toEqual([0, 20, 40]);
        overlay.remove();
    });

    it('measures across the highlight spans that wrap the mirrored text', () => {
        const overlay = document.createElement('pre');
        overlay.innerHTML = '<span>one</span>\n<span>two</span>\n';
        document.body.append(overlay);
        expect(measureLineTops(overlay, 'one\ntwo\n', [1, 2])).toEqual([0, 20]);
        overlay.remove();
    });
});
