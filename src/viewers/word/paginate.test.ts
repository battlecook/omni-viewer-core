// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { paginateLegacyDocument } from './paginate.js';

describe('legacy DOC pagination', () => {
    it('converts parser sections and blocks into page/column DOM', () => {
        const root = document.createElement('div'); root.className = 'word-content legacy-mode';
        root.innerHTML = `<div class="ov-doc-legacy"><section class="ov-doc-legacy-section" data-ov-columns="2" data-ov-custom-columns="false" style="--ov-page-width-mm:210mm;--ov-page-height-mm:297mm;--ov-column-gap-mm:8mm"><script type="application/json" class="ov-doc-legacy-section-meta">{"oddHeaderText":"Header","oddFooterText":"PAGE / NUMPAGES"}</script><div class="ov-doc-legacy-block ov-doc-legacy-block-content"><p>First paragraph</p></div><div class="ov-doc-legacy-block ov-doc-legacy-block-table"><table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table></div></section></div>`;
        paginateLegacyDocument(root);
        expect(root.querySelector('.ov-doc-legacy-page')).not.toBeNull();
        expect(root.querySelectorAll('.ov-doc-legacy-page-column')).toHaveLength(2);
        expect(root.querySelector('.ov-doc-legacy-page-header')?.textContent).toContain('Header');
        expect(root.querySelector('table')).not.toBeNull();
    });
});
