import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './index.js';

describe('parseMarkdown', () => {
    it('indexes heading source spans without rendering HTML', () => {
        const result = parseMarkdown(new TextEncoder().encode('# One\ntext\n## Two\n'));
        expect(result.result.status).toBe('ok');
        if (result.result.status === 'failed') throw new Error('unexpected failure');
        expect(result.result.document.headings.map(x => [x.level, x.text, x.start])).toEqual([[1, 'One', 0], [2, 'Two', 11]]);
    });

    it('keeps full source but bounds render text when a structural limit is reached', () => {
        const result = parseMarkdown(new TextEncoder().encode('first\nsecond\nthird\n'), {
            markdownLimits: { maxBlocks: 2 }
        });
        expect(result.result.status).toBe('partial');
        if (result.result.status === 'failed') throw new Error('unexpected failure');
        expect(result.result.document.text).toBe('first\nsecond\nthird\n');
        expect(result.result.document.renderText).toBe('first\nsecond\n');
    });
});
