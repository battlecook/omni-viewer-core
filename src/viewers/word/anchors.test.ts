// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrintService } from '../../host/index.js';
import { createCatalogI18n } from '../../i18n/index.js';
import { mountWordViewer, type WordViewerContext } from './index.js';
import type { ZipModule } from './docx-preprocess.js';

const ctx = (print?: PrintService): WordViewerContext => ({
    assets: { resolveAssetUrl: async (path) => path }, i18n: createCatalogI18n(), logger: { log: () => undefined }, ...(print ? { print } : {})
});
const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const zip = { loadAsync: async () => ({ file: (() => null) as never, forEach: () => undefined, generateAsync: async () => docx }) } as ZipModule;
const deps = (renderAsync: (...args: any[]) => Promise<unknown>) => ({ loadDocxPreview: async () => ({ renderAsync }), loadZip: async () => zip });

/** Mirrors docx-preview: bookmarks become `<span id>`, anchors become `href="#name"`. */
const renderBookmarked = (links: Array<[href: string, bookmark?: string]>) =>
    async (_data: unknown, body: HTMLElement): Promise<void> => {
        for (const [href, bookmark] of links) {
            const anchor = document.createElement('a');
            anchor.setAttribute('href', href);
            anchor.textContent = href;
            body.append(anchor);
            if (bookmark !== undefined) {
                const marker = document.createElement('span');
                marker.id = bookmark;
                body.append(marker);
            }
        }
    };

/** jsdom does no layout, so the scrollport maths needs stubbed geometry. */
function stubGeometry(viewport: HTMLElement, target: HTMLElement, offset: number): void {
    viewport.getBoundingClientRect = (() => ({ top: 100 })) as never;
    target.getBoundingClientRect = (() => ({ top: 100 + offset })) as never;
}

async function mount(
    links: Array<[href: string, bookmark?: string]>,
    options: { isolation?: 'shadow' | 'scoped'; openExternalUrl?: () => Promise<void> } = {}
) {
    const container = document.createElement('div');
    document.body.append(container);
    const handle = await mountWordViewer(
        { fileName: 'sample.docx', data: docx },
        container,
        options.openExternalUrl ? { ...ctx(), navigation: { openExternalUrl: options.openExternalUrl } } : ctx(),
        deps(renderBookmarked(links)),
        { styleIsolation: options.isolation ?? 'shadow' }
    );
    const root: ParentNode = options.isolation === 'scoped' ? container : container.shadowRoot!;
    return { container, handle, root, anchors: [...root.querySelectorAll('a')] };
}

// Scoped isolation resolves against the real document, so leftover ids would leak
// between cases.
afterEach(() => document.body.replaceChildren());

describe('word viewer in-document anchors', () => {
    for (const isolation of ['shadow', 'scoped'] as const) {
        it(`scrolls and focuses the bookmark target under ${isolation} isolation`, async () => {
            const { handle, anchors } = await mount([['#bm', 'bm']], { isolation });
            const [anchor] = anchors;
            expect(anchor!.hasAttribute('href')).toBe(false);
            expect(anchor!.hasAttribute('aria-disabled')).toBe(false);
            expect(anchor!.getAttribute('role')).toBe('link');
            expect(anchor!.tabIndex).toBe(0);

            const target = handle.contentElement.querySelector('span')!;
            stubGeometry(handle.viewportElement, target, 250);
            anchor!.click();

            expect(handle.viewportElement.scrollTop).toBe(250);
            expect(target.getAttribute('tabindex')).toBe('-1');
            expect((target.getRootNode() as Document | ShadowRoot).activeElement).toBe(target);
        });
    }

    it('activates on Enter and Space as well as click', async () => {
        const { handle, anchors } = await mount([['#bm', 'bm']]);
        const target = handle.contentElement.querySelector('span')!;
        for (const [key, expected] of [['Enter', 40], [' ', 80]] as const) {
            stubGeometry(handle.viewportElement, target, 40);
            anchors[0]!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
            expect(handle.viewportElement.scrollTop).toBe(expected);
        }
    });

    it('resolves bookmark names that are not valid CSS identifiers', async () => {
        const names = ['1가나', '_Toc123456', '표 1: 요약'];
        const { handle, anchors } = await mount(names.map((name) => [`#${name}`, name] as [string, string]));
        expect(anchors.map((anchor) => anchor.hasAttribute('aria-disabled'))).toEqual([false, false, false]);
        for (const [index, name] of names.entries()) {
            const target = handle.contentElement.querySelector(`span:nth-of-type(${index + 1})`)!;
            expect(target.id).toBe(name);
            stubGeometry(handle.viewportElement, target as HTMLElement, 10 * (index + 1));
            handle.viewportElement.scrollTop = 0;
            anchors[index]!.click();
            expect(handle.viewportElement.scrollTop).toBe(10 * (index + 1));
        }
    });

    it('matches a percent-encoded fragment against the raw bookmark id', async () => {
        const { handle, anchors } = await mount([['#%ED%91%9C%201', '표 1']]);
        expect(anchors[0]!.hasAttribute('aria-disabled')).toBe(false);
        const target = handle.contentElement.querySelector('span')!;
        stubGeometry(handle.viewportElement, target, 60);
        anchors[0]!.click();
        expect(handle.viewportElement.scrollTop).toBe(60);
    });

    it('disables broken cross-references without emitting a diagnostic', async () => {
        const { handle, anchors } = await mount([['#missing']]);
        expect(anchors[0]!.getAttribute('aria-disabled')).toBe('true');
        expect(anchors[0]!.hasAttribute('href')).toBe(false);
        expect(anchors[0]!.hasAttribute('role')).toBe(false);
        expect(handle.status).toMatchObject({ state: 'ready', diagnostics: [] });
    });

    it('disables empty and non-fragment relative hrefs', async () => {
        const { anchors } = await mount([['#'], [''], ['other.docx']]);
        for (const anchor of anchors) {
            expect(anchor.getAttribute('aria-disabled')).toBe('true');
            expect(anchor.hasAttribute('href')).toBe(false);
        }
    });

    it('still blocks dangerous schemes', async () => {
        const openExternalUrl = vi.fn(async () => undefined);
        const { anchors } = await mount(
            [['javascript:alert(1)'], ['data:text/html,<script>'], ['vbscript:msgbox']],
            { openExternalUrl }
        );
        for (const anchor of anchors) {
            expect(anchor.getAttribute('aria-disabled')).toBe('true');
            expect(anchor.hasAttribute('href')).toBe(false);
            anchor.click();
        }
        expect(openExternalUrl).not.toHaveBeenCalled();
    });

    it('keeps routing external links through navigation, fragment or not', async () => {
        const openExternalUrl = vi.fn(async () => undefined);
        const { anchors } = await mount([['https://example.com/x#frag'], ['https://example.com/y']], { openExternalUrl });
        for (const anchor of anchors) {
            expect(anchor.hasAttribute('aria-disabled')).toBe(false);
            anchor.click();
        }
        expect(openExternalUrl).toHaveBeenNthCalledWith(1, 'https://example.com/x#frag');
        expect(openExternalUrl).toHaveBeenNthCalledWith(2, 'https://example.com/y');
    });

    it('never targets an id outside the viewer under scoped isolation', async () => {
        const outsider = document.createElement('div');
        outsider.id = 'bm';
        document.body.prepend(outsider);
        try {
            const { anchors } = await mount([['#bm']], { isolation: 'scoped' });
            expect(anchors[0]!.getAttribute('aria-disabled')).toBe('true');
        } finally {
            outsider.remove();
        }
    });

    it('drops the listeners on dispose', async () => {
        const { handle, anchors } = await mount([['#bm', 'bm']]);
        const target = handle.contentElement.querySelector('span')!;
        stubGeometry(handle.viewportElement, target, 300);
        handle.dispose();
        anchors[0]!.click();
        anchors[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(handle.viewportElement.scrollTop).toBe(0);
    });
});
