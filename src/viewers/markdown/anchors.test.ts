// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { CATALOG_EN } from '../../i18n/catalog.en.js';
import { mountMarkdownViewer, type MarkdownViewerContext, type MarkdownViewerDeps } from './index.js';

/** Stands in for a renderer that emits heading ids, as GFM-style slugging does. */
const deps = (html: string): MarkdownViewerDeps => ({
    render: { parse: () => html },
    createDOMPurify: () => ({ sanitize: (value: string) => value })
});

function ctx(openExternalUrl?: () => Promise<void>): MarkdownViewerContext {
    return {
        assets: { resolveAssetUrl: async path => path }, logger: { log: vi.fn() },
        i18n: { t: (key, args) => (CATALOG_EN[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(args?.[name] ?? '')) },
        ...(openExternalUrl ? { navigation: { openExternalUrl } } : {})
    };
}

async function mount(html: string, openExternalUrl?: () => Promise<void>) {
    const container = document.createElement('div');
    document.body.append(container);
    const handle = await mountMarkdownViewer(
        { fileName: 'readme.md', data: new TextEncoder().encode('# Hello') },
        container, ctx(openExternalUrl), deps(html)
    );
    const root = container.shadowRoot!;
    const preview = root.querySelector('.omni-markdown__preview') as HTMLElement;
    return { handle, preview, anchors: [...preview.querySelectorAll('a')] };
}

describe('markdown viewer in-document anchors', () => {
    it('scrolls to a heading anchor inside the shadow root instead of restoring href', async () => {
        const { preview, anchors } = await mount('<a href="#intro">Intro</a><h2 id="intro">Intro</h2>');
        const [anchor] = anchors;
        expect(anchor!.hasAttribute('href')).toBe(false);
        expect(anchor!.hasAttribute('aria-disabled')).toBe(false);
        expect(anchor!.getAttribute('role')).toBe('link');

        const target = preview.querySelector('h2')!;
        preview.getBoundingClientRect = (() => ({ top: 0 })) as never;
        target.getBoundingClientRect = (() => ({ top: 120 })) as never;
        anchor!.click();

        expect(preview.scrollTop).toBe(120);
        expect((preview.getRootNode() as ShadowRoot).activeElement).toBe(target);
    });

    it('keeps the fallback id off a slug that already reads as one', async () => {
        const { preview, anchors } = await mount(
            '<a href="#heading-1">Slugged</a><h2 id="heading-1">Heading 1</h2><h2>Plain</h2>'
        );
        const [slugged, plain] = [...preview.querySelectorAll('h2')];
        expect(slugged!.id).toBe('heading-1');
        expect(plain!.id).toBe('heading-1-1');

        preview.getBoundingClientRect = (() => ({ top: 0 })) as never;
        slugged!.getBoundingClientRect = (() => ({ top: 60 })) as never;
        anchors[0]!.click();

        expect((preview.getRootNode() as ShadowRoot).activeElement).toBe(slugged);
    });

    it('disables anchors whose heading id was never emitted', async () => {
        const { anchors } = await mount('<a href="#nowhere">Missing</a>');
        expect(anchors[0]!.getAttribute('aria-disabled')).toBe('true');
        expect(anchors[0]!.hasAttribute('href')).toBe(false);
    });

    it('leaves the external link path untouched', async () => {
        const openExternalUrl = vi.fn(async () => undefined);
        const { anchors } = await mount(
            '<a href="https://example.com/a#top">Ext</a><a href="javascript:alert(1)">Bad</a>',
            openExternalUrl
        );
        anchors[0]!.click();
        anchors[1]!.click();
        expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://example.com/a#top');
        expect(anchors[1]!.getAttribute('aria-disabled')).toBe('true');
    });
});
