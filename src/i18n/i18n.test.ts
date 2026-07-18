import { describe, expect, it } from 'vitest';
import { createCatalogI18n } from './index.js';

describe('localized core catalog', () => {
    it('provides Korean HWP UI and falls back to English for other keys', () => {
        const ko = createCatalogI18n('ko-KR');
        expect(ko.t('hwp.loadMorePages')).toBe('다음 페이지 불러오기');
        expect(ko.t('hwp.pages', { count: 3 })).toBe('3페이지');
        expect(ko.t('pdf.title')).toBe('PDF');
    });

    it.each([
        ['fr-FR', 'audio.play', 'Lecture'],
        ['de-DE', 'audio.play', 'Wiedergabe'],
        ['th-TH', 'audio.play', 'เล่น'],
        ['it-IT', 'audio.play', 'Riproduci']
    ])('translates core UI for %s', (locale, key, expected) => {
        const t = createCatalogI18n(locale);
        expect(t.t(key)).toBe(expected);
        // Substitution and English fallback still work per locale.
        expect(t.t('hwp.pages', { count: 3 })).toContain('3');
        expect(t.t('pdf.title')).toBe('PDF');
    });
});
