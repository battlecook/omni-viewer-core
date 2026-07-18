import type { I18nService } from '../host/index.js';
import { CATALOG_EN } from './catalog.en.js';
import { CATALOG_JA } from './catalog.ja.js';
import { CATALOG_KO } from './catalog.ko.js';
import { CATALOG_FR } from './catalog.fr.js';
import { CATALOG_DE } from './catalog.de.js';
import { CATALOG_TH } from './catalog.th.js';
import { CATALOG_IT } from './catalog.it.js';
import { CATALOG_ZH_CN } from './catalog.zh-cn.js';
import { CATALOG_ZH_TW } from './catalog.zh-tw.js';

export { CATALOG_EN } from './catalog.en.js';
export { CATALOG_JA } from './catalog.ja.js';
export { CATALOG_KO } from './catalog.ko.js';
export { CATALOG_FR } from './catalog.fr.js';
export { CATALOG_DE } from './catalog.de.js';
export { CATALOG_TH } from './catalog.th.js';
export { CATALOG_IT } from './catalog.it.js';
export { CATALOG_ZH_CN } from './catalog.zh-cn.js';
export { CATALOG_ZH_TW } from './catalog.zh-tw.js';

/**
 * Language subtag → catalog for locales without region-specific variants.
 * Chinese is resolved separately below because it needs script/region
 * detection (Hant vs Hans). Each catalog falls back to CATALOG_EN per key.
 */
const SIMPLE_CATALOGS: Record<string, Record<string, string>> = {
    ko: CATALOG_KO,
    ja: CATALOG_JA,
    fr: CATALOG_FR,
    de: CATALOG_DE,
    th: CATALOG_TH,
    it: CATALOG_IT
};

/**
 * Render a catalog template with `{name}` substitutions. Unknown placeholders
 * are left verbatim so missing args are visible instead of silently dropped.
 */
export function formatMessage(
    template: string,
    args?: Record<string, string | number>
): string {
    if (!args) return template;
    return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (whole, name: string) => {
        const value = args[name];
        return value === undefined ? whole : String(value);
    });
}

/**
 * Resolve a message from the core catalog (English). Platform adapters wrap
 * this: try the platform translation first, fall back here. The key itself is
 * returned for unknown keys so broken lookups are visible in the UI and
 * caught by tests.
 */
export function resolveCatalogMessage(
    key: string,
    args?: Record<string, string | number>
): string {
    const template = CATALOG_EN[key];
    if (template === undefined) return key;
    return formatMessage(template, args);
}

export function resolveLocalizedCatalogMessage(locale: string, key: string, args?: Record<string, string | number>): string {
    const normalizedLocale = locale.trim().toLowerCase().replace(/_/g, '-');
    const language = normalizedLocale.split('-', 1)[0] ?? '';
    const catalog = language === 'zh'
        ? /(?:^|-)hant(?:-|$)/.test(normalizedLocale) || /^zh-(?:tw|hk|mo)(?:-|$)/.test(normalizedLocale)
            ? CATALOG_ZH_TW
            : CATALOG_ZH_CN
        : SIMPLE_CATALOGS[language] ?? CATALOG_EN;
    const template = catalog[key] ?? CATALOG_EN[key];
    if (template === undefined) return key;
    return formatMessage(template, args);
}

/** An I18nService backed directly by the core catalog (tests, defaults). */
export function createCatalogI18n(locale = 'en'): I18nService {
    return {
        t: (key, args) => resolveLocalizedCatalogMessage(locale, key, args)
    };
}
