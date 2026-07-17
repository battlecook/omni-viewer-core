import type { I18nService } from '../host/index.js';
import { CATALOG_EN } from './catalog.en.js';
import { CATALOG_KO } from './catalog.ko.js';

export { CATALOG_EN } from './catalog.en.js';
export { CATALOG_KO } from './catalog.ko.js';

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
    const language = locale.toLowerCase().split(/[-_]/, 1)[0];
    const template = language === 'ko' ? CATALOG_KO[key] ?? CATALOG_EN[key] : CATALOG_EN[key];
    if (template === undefined) return key;
    return formatMessage(template, args);
}

/** An I18nService backed directly by the core catalog (tests, defaults). */
export function createCatalogI18n(locale = 'en'): I18nService {
    return {
        t: (key, args) => resolveLocalizedCatalogMessage(locale, key, args)
    };
}
