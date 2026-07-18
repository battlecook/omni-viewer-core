import { describe, expect, it } from 'vitest';
import {
    CATALOG_EN,
    CATALOG_JA,
    CATALOG_ZH_CN,
    CATALOG_ZH_TW,
    createCatalogI18n
} from './index.js';

const placeholders = (message: string): string[] =>
    [...message.matchAll(/\{([a-zA-Z0-9_.-]+)\}/g)].map((match) => match[1]!).sort();

describe('Japanese and Chinese core catalogs', () => {
    const completeCatalogs = [CATALOG_JA, CATALOG_ZH_CN, CATALOG_ZH_TW];

    it('keeps every localized catalog aligned with the English key set', () => {
        const englishKeys = Object.keys(CATALOG_EN).sort();
        for (const catalog of completeCatalogs) {
            expect(Object.keys(catalog).sort()).toEqual(englishKeys);
        }
    });

    it('preserves named placeholders in every translation', () => {
        for (const catalog of completeCatalogs) {
            for (const [key, english] of Object.entries(CATALOG_EN)) {
                expect(placeholders(catalog[key]!), key).toEqual(placeholders(english));
            }
        }
    });

    it('selects Japanese, Simplified Chinese, and Traditional Chinese locale variants', () => {
        expect(createCatalogI18n('ja-JP').t('common.saved', { name: 'report.csv' }))
            .toBe('report.csvを保存しました');
        expect(createCatalogI18n('zh-CN').t('common.page', { page: 2, pages: 8 }))
            .toBe('第 2 / 8 页');
        expect(createCatalogI18n('zh-Hans').t('common.savedToOriginal')).toBe('已保存');
        expect(createCatalogI18n('zh_TW').t('common.page', { page: 2, pages: 8 }))
            .toBe('第 2 / 8 頁');
        expect(createCatalogI18n('zh-Hant').t('common.noFileSave')).toContain('檔案');
        expect(createCatalogI18n('zh-HK').t('common.savedToOriginal')).toBe('已儲存');
    });

    it('continues to use English for unsupported locales and unknown keys for missing source messages', () => {
        expect(createCatalogI18n('xx-ZZ').t('common.savedToOriginal')).toBe('Saved');
        expect(createCatalogI18n('ja-JP').t('missing.key')).toBe('missing.key');
    });
});
