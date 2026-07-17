import { describe, expect, it } from 'vitest';
import { createCatalogI18n } from './index.js';

describe('localized core catalog', () => {
    it('provides Korean HWP UI and falls back to English for other keys', () => {
        const ko = createCatalogI18n('ko-KR');
        expect(ko.t('hwp.loadMorePages')).toBe('다음 페이지 불러오기');
        expect(ko.t('hwp.pages', { count: 3 })).toBe('3페이지');
        expect(ko.t('pdf.title')).toBe('PDF');
    });
});
