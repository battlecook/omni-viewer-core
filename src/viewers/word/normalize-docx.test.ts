// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { normalizeDocxPreviewDom } from './normalize-docx.js';

describe('normalizeDocxPreviewDom', () => {
    it('replaces Wingdings/PUA bullet glyphs in direct text and first spans', () => {
        const root = document.createElement('div'); root.innerHTML = '<p>\uf0b7 Direct</p><li><span>\u25a1 Nested</span></li>';
        normalizeDocxPreviewDom(root);
        expect(root.querySelector('p')?.textContent).toBe('* Direct');
        expect(root.querySelector('span')?.textContent).toBe('* Nested');
    });
});
