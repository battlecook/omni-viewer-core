// @vitest-environment jsdom
import createDOMPurify from 'dompurify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPF_EPUB3, buildZip, epub3Fixture, epub3Members } from '../../parsers/epub/__tests__/fixture.js';
import { MountAbortedError } from '../types.js';
import { createEpubController, epubViewerCss, mountEpubViewer, prepareChapter, type EpubViewerHandle } from './index.js';
import { dropMarkupEntities, EPUB_MAX_CHAPTER_ELEMENTS, estimateHtmlElements } from './content.js';

const deps = { createDOMPurify: (window: Window) => createDOMPurify(window as never) };
const t = (key: string, args?: Record<string, string | number>): string =>
    args ? `${key} ${Object.entries(args).map(([name, value]) => `${name}=${value}`).join(' ')}` : key;
const navigation = { openExternalUrl: vi.fn(async () => undefined) };
const ctx = {
    assets: { resolveAssetUrl: async (path: string) => path },
    logger: { log: vi.fn() },
    i18n: { t },
    navigation
};

let created: string[] = [];
let blobs: Blob[] = [];
let revoked: string[] = [];
const originalCreate = Object.getOwnPropertyDescriptor(window.URL, 'createObjectURL');
const originalRevoke = Object.getOwnPropertyDescriptor(window.URL, 'revokeObjectURL');

beforeEach(() => {
    created = [];
    blobs = [];
    revoked = [];
    navigation.openExternalUrl.mockClear();
    Object.defineProperty(window.URL, 'createObjectURL', {
        configurable: true,
        value: (blob: Blob) => { const url = `blob:test/${created.length}`; created.push(url); blobs.push(blob); return url; }
    });
    Object.defineProperty(window.URL, 'revokeObjectURL', { configurable: true, value: (url: string) => { revoked.push(url); } });
});
afterEach(() => {
    if (originalCreate) Object.defineProperty(window.URL, 'createObjectURL', originalCreate); else Reflect.deleteProperty(window.URL, 'createObjectURL');
    if (originalRevoke) Object.defineProperty(window.URL, 'revokeObjectURL', originalRevoke); else Reflect.deleteProperty(window.URL, 'revokeObjectURL');
});

/** Lets pending archive reads and blob assignments settle. */
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

async function mount(data = epub3Fixture(), options: Record<string, unknown> = {}): Promise<{ container: HTMLElement; handle: EpubViewerHandle }> {
    const container = document.createElement('div');
    document.body.append(container);
    const handle = await mountEpubViewer({ fileName: 'alice.epub', data }, container, ctx as never, deps, { styleIsolation: 'scoped', ...options });
    await settle();
    return { container, handle };
}

const page = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>('.omni-epub__page')!;
const buttonByLabel = (container: HTMLElement, label: string): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

describe('mountEpubViewer', () => {
    it('renders the header, contents, and the first linear chapter inside a shadow root by default', async () => {
        const container = document.createElement('div');
        const handle = await mountEpubViewer({ fileName: 'alice.epub', data: epub3Fixture() }, container, ctx as never, deps);
        const root = container.shadowRoot!;
        expect(root.querySelector('style')?.textContent).toBe(epubViewerCss);
        expect(root.querySelector('h1')?.textContent).toBe("Alice's Adventures in Wonderland");
        expect(root.querySelector('.omni-epub__subtitle')?.textContent).toBe('Lewis Carroll · alice.epub');
        // The cover wrapper is linear="no", so reading starts at chapter I.
        expect(handle.currentIndex()).toBe(1);
        expect(root.querySelector('.omni-epub__page h2')?.textContent).toContain('Down the Rabbit-Hole');
        expect(root.querySelector('.omni-epub__position')?.textContent).toBe('epub.position position=1 total=2');
        handle.dispose();
        expect(root.querySelector('.omni-epub')).toBeNull();
        expect(root.querySelector('style')).toBeNull();
    });

    it('drops scripts, forms, publisher styles, and the viewer class names a book claims', async () => {
        const { container, handle } = await mount();
        const content = page(container);
        expect(content.querySelector('script, form, input, style, link')).toBeNull();
        expect(content.querySelector('[style]')).toBeNull();
        expect(content.querySelector('.chapter')?.classList.contains('omni-epub__page')).toBe(false);
        expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
        handle.dispose();
    });

    it('shows container images from blob URLs, blocks remote ones, and revokes on chapter change', async () => {
        const { container, handle } = await mount();
        const images = [...page(container).querySelectorAll('img')];
        // The remote pixel stays in the tree without a source, hidden by the stylesheet.
        expect(images.map(image => [image.alt, image.getAttribute('src'), image.hasAttribute('data-omni-epub-blocked')])).toEqual([
            ['Alice', expect.stringMatching(/^blob:test\//), false],
            ['pixel', null, true]
        ]);
        const chapterImage = images[0]!.getAttribute('src')!;
        expect(page(container).querySelector('.omni-epub__note')?.textContent).toBe('epub.blocked count=1');
        buttonByLabel(container, 'epub.next').click();
        await settle();
        expect(handle.currentIndex()).toBe(3);
        expect(revoked).toContain(chapterImage);
        // Chapter II carries a CDATA-wrapped script, which cannot be imported into an HTML document as-is.
        expect(page(container).querySelector('h2')?.textContent).toBe('CHAPTER II. The Pool of Tears');
        expect(page(container).querySelector('script, [role="alert"]')).toBeNull();
        handle.dispose();
    });

    it('resolves the SVG cover wrapper image when the non-linear cover is opened', async () => {
        const { container, handle } = await mount();
        handle.goTo(0);
        await settle();
        const image = page(container).querySelector('image');
        expect(image?.getAttribute('href')).toMatch(/^blob:test\//);
        handle.dispose();
    });

    it('routes internal, fragment, and external links, and disables unsafe ones', async () => {
        const { container, handle } = await mount();
        const links = [...page(container).querySelectorAll<HTMLElement>('a')];
        const byText = (text: string): HTMLElement => links.find(link => link.textContent === text)!;
        expect(links.every(link => !link.hasAttribute('href'))).toBe(true);
        // The sanitizer removes a javascript: href outright, leaving inert text.
        expect(byText('bad').getAttribute('role')).toBeNull();
        expect(byText('gone').getAttribute('aria-disabled')).toBe('true');

        byText('Gutenberg').click();
        expect(navigation.openExternalUrl).toHaveBeenCalledWith('https://www.gutenberg.org/');

        expect(byText('back to top').getAttribute('role')).toBe('link');

        // A noteref into a non-linear document opens it.
        byText('1').click();
        await settle();
        expect(handle.currentIndex()).toBe(2);
        expect(page(container).querySelector('aside')?.textContent).toBe('The first note.');
        // Previous from a non-linear document returns to the linear chapter before it.
        buttonByLabel(container, 'epub.previous').click();
        await settle();
        expect(handle.currentIndex()).toBe(1);

        [...page(container).querySelectorAll<HTMLElement>('a')].find(link => link.textContent === 'on to the pool')!.click();
        await settle();
        expect(handle.currentIndex()).toBe(3);
        expect(page(container).querySelector('h2')?.getAttribute('data-omni-epub-anchor') ?? '').toBe('pool');
        handle.dispose();
    });

    it('disables external links when the host offers no navigation service', async () => {
        const container = document.createElement('div');
        const { navigation: _, ...noNavigation } = ctx;
        const handle = await mountEpubViewer({ fileName: 'a.epub', data: epub3Fixture() }, container, noNavigation as never, deps, { styleIsolation: 'scoped' });
        const link = [...container.querySelectorAll<HTMLElement>('.omni-epub__page a')].find(node => node.textContent === 'Gutenberg')!;
        expect(link.getAttribute('aria-disabled')).toBe('true');
        handle.dispose();
    });

    it('builds the contents from the nav document and highlights the open chapter', async () => {
        const { container, handle } = await mount();
        const toc = container.querySelector('.omni-epub__toc')!;
        // `hidden` only affects the in-book flow, so the panel shows that sub-list; the span heading is text.
        expect([...toc.querySelectorAll('.omni-epub__toc-link, .omni-epub__toc-heading')].map(node => node.textContent)).toEqual([
            'CHAPTER I. Down the Rabbit-Hole', 'The Fall', 'Part Two', 'CHAPTER II. The Pool of Tears — Part'
        ]);
        // jsdom lays everything out at top 0; put the "The Fall" section below the fold as a browser would.
        page(container).querySelector<HTMLElement>('[data-omni-epub-anchor="fall"]')!.getBoundingClientRect = () => ({ top: 900 } as DOMRect);
        container.querySelector('.omni-epub__viewport')!.dispatchEvent(new Event('scroll'));
        expect(toc.querySelector('[aria-current="true"]')?.textContent).toBe('CHAPTER I. Down the Rabbit-Hole');
        toc.querySelectorAll<HTMLButtonElement>('.omni-epub__toc-link')[2]!.click();
        await settle();
        expect(handle.currentIndex()).toBe(3);
        expect(toc.querySelector('[aria-current="true"]')?.textContent).toContain('CHAPTER II');
        handle.dispose();
    });

    it('navigates with the chapter picker, the keyboard, and scales text', async () => {
        const { container, handle } = await mount();
        const select = container.querySelector<HTMLSelectElement>('.omni-epub__select')!;
        expect([...select.options].map(option => option.textContent)).toEqual([
            'epub.section number=1', 'CHAPTER I. Down the Rabbit-Hole', 'epub.section number=3', 'CHAPTER II. The Pool of Tears — Part'
        ]);
        select.value = '0';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(handle.currentIndex()).toBe(0);

        const shell = container.querySelector<HTMLElement>('.omni-epub')!;
        shell.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        await settle();
        expect(handle.currentIndex()).toBe(1);
        expect(buttonByLabel(container, 'epub.previous').disabled).toBe(true);

        buttonByLabel(container, 'epub.textLarger').click();
        buttonByLabel(container, 'epub.textLarger').click();
        expect(page(container).style.getPropertyValue('--epub-scale')).toBe('1.2');
        shell.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }));
        expect(container.querySelector('.omni-epub__scale')?.textContent).toBe('100%');
        handle.dispose();
    });

    it('toggles the contents and book info panels, listing metadata and the cover', async () => {
        const { container, handle } = await mount();
        const info = buttonByLabel(container, 'epub.info');
        info.click();
        expect(info.getAttribute('aria-pressed')).toBe('true');
        const panel = container.querySelector<HTMLElement>('.omni-epub__info')!;
        expect(panel.hidden).toBe(false);
        const rows = [...panel.querySelectorAll('dt')].map(dt => [dt.textContent, dt.nextElementSibling?.textContent]);
        expect(rows).toContainEqual(['epub.meta.contributors', 'John Tenniel (ill)']);
        expect(rows).toContainEqual(['epub.meta.series', 'Wonderland #1']);
        expect(rows).toContainEqual(['epub.meta.description', 'A girl falls down a rabbit hole.']);
        expect(panel.querySelector<HTMLImageElement>('.omni-epub__cover')?.hidden).toBe(false);
        info.click();
        expect(container.querySelector<HTMLElement>('.omni-epub__side')!.hidden).toBe(true);
        handle.dispose();
    });

    it('shows a failure instead of a blank screen', async () => {
        const { container, handle } = await mount(new TextEncoder().encode('not a book'));
        expect(container.querySelector('[role="alert"]')?.textContent).toBe('diag.epub.not-zip');
        handle.dispose();
        expect(container.querySelector('.omni-epub')).toBeNull();
    });

    it('explains a chapter that is missing from the container', async () => {
        const data = buildZip(epub3Members().filter(member => member.name !== 'OEBPS/text/ch01.xhtml'));
        const { container, handle } = await mount(data);
        expect(container.querySelector<HTMLElement>('.omni-epub__warnings')?.hidden).toBe(false);
        expect(page(container).querySelector('[role="alert"]')?.textContent).toBe('epub.chapter.missing path=OEBPS/text/ch01.xhtml');
        handle.dispose();
    });

    it('turns pages the other way for right-to-left books', async () => {
        const opf = OPF_EPUB3.replace('<spine toc="ncx2">', '<spine toc="ncx2" page-progression-direction="rtl">');
        const data = buildZip(epub3Members().map(member => (member.name === 'OEBPS/content.opf' ? { ...member, data: opf } : member)));
        const { container, handle } = await mount(data);
        container.querySelector('.omni-epub')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        await settle();
        expect(handle.currentIndex()).toBe(3);
        handle.dispose();
    });

    it('rejects with MountAbortedError when aborted and leaves nothing behind', async () => {
        const controller = new AbortController();
        controller.abort();
        const container = document.createElement('div');
        await expect(mountEpubViewer({ fileName: 'a.epub', data: epub3Fixture() }, container, ctx as never, deps, { signal: controller.signal }))
            .rejects.toBeInstanceOf(MountAbortedError);
        expect(container.childNodes.length).toBe(0);
    });

    it('releases every blob URL and listener on dispose', async () => {
        const { container, handle } = await mount();
        buttonByLabel(container, 'epub.info').click();
        handle.dispose();
        expect(new Set(revoked)).toEqual(new Set(created));
        expect(container.querySelector('.omni-epub')).toBeNull();
    });
});

describe('mountEpubViewer — review regressions', () => {
    const withChapter = (body: string): Uint8Array => buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
        ? { ...member, data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>` }
        : member));

    it('ignores viewer marker attributes planted by the book', async () => {
        const { container, handle } = await mount(withChapter(
            '<p><a data-omni-epub-src="OEBPS/notes.xhtml" data-omni-epub-href="https://evil.example/">click me</a><span data-omni-epub-blocked="">kept</span></p>'));
        const anchor = page(container).querySelector('a')!;
        expect(anchor.hasAttribute('href')).toBe(false);
        expect(anchor.getAttribute('role')).toBeNull();
        expect(page(container).querySelector('[data-omni-epub-src], [data-omni-epub-href], [data-omni-epub-blocked]')).toBeNull();
        anchor.click();
        expect(navigation.openExternalUrl).not.toHaveBeenCalled();
        handle.dispose();
    });

    it('strips remote url() references from SVG presentation attributes and counts them', async () => {
        const { container, handle } = await mount(withChapter(
            '<svg xmlns="http://www.w3.org/2000/svg"><defs><mask id="m"/></defs><rect width="5" height="5" fill="url(https://evil.example/p.svg#g)" stroke="url( \'//evil.example/s\' )" mask="url(#m)"/></svg>'));
        const rect = page(container).querySelector('rect')!;
        expect(rect.hasAttribute('fill')).toBe(false);
        expect(rect.hasAttribute('stroke')).toBe(false);
        // Same-chapter references follow the chapter's namespaced ids.
        const mask = page(container).querySelector('mask')!;
        expect(rect.getAttribute('mask')).toBe(`url(#${mask.id})`);
        expect(mask.id).toMatch(/^omni-epub-\d+-m$/);
        expect(page(container).querySelector('.omni-epub__note')?.textContent).toBe('epub.blocked count=2');
        handle.dispose();
    });

    it('still loads a chapter\'s images after a same-chapter fragment jump', async () => {
        const { inflateRawSync } = await import('node:zlib');
        const slowInflate = async (compressed: Uint8Array): Promise<Uint8Array> => {
            await new Promise(resolve => setTimeout(resolve, 30));
            return new Uint8Array(inflateRawSync(compressed));
        };
        const data = buildZip(epub3Members().map(member => member.name.endsWith('cover art.jpg') ? { ...member, method: 8 as const } : member));
        const container = document.createElement('div');
        const handle = await mountEpubViewer({ fileName: 'a.epub', data }, container, ctx as never, deps, { styleIsolation: 'scoped', inflate: slowInflate });
        handle.goTo(1, 'fall');
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(page(container).querySelector('img[alt="Alice"]')?.getAttribute('src')).toMatch(/^blob:test\//);
        handle.dispose();
    });
});

describe('mountEpubViewer — review round 2 regressions', () => {
    const withChapter = (body: string, extra: Array<{ name: string; data: string | Uint8Array }> = [], opf = OPF_EPUB3): Uint8Array =>
        buildZip([...epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>` }
            : member.name === 'OEBPS/content.opf' ? { ...member, data: opf } : member), ...extra]);

    it('blocks CSS-escaped and image-set() fetches and drops mglyph sources', async () => {
        const { container, handle } = await mount(withChapter(
            '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="\\75 rl(https://evil.example/f.svg)" mask="image-set(\'https://evil.example/m.png\' 1x)" clip-path="url(#c)"/></svg>'
            + '<math xmlns="http://www.w3.org/1998/Math/MathML"><mglyph src="https://evil.example/g.png"/><mi>x</mi></math>'
            + '<p><img src="../images/cover%20art.jpg" alt="a url(x) in alt text"/></p>'));
        const rect = page(container).querySelector('rect')!;
        // `#c` names nothing in the chapter, so it cannot be left to resolve against the host.
        expect([rect.hasAttribute('fill'), rect.hasAttribute('mask'), rect.getAttribute('clip-path')]).toEqual([false, false, 'none']);
        expect(page(container).querySelector('mglyph, [src*="evil"]')).toBeNull();
        expect(page(container).querySelector('img')?.alt).toBe('a url(x) in alt text');
        expect(page(container).querySelector('.omni-epub__note')?.textContent).toBe('epub.blocked count=2');
        handle.dispose();
    });

    it('keeps reading after the mount signal aborts post-mount, and cancels reads on dispose', async () => {
        const controller = new AbortController();
        const { container, handle } = await mount(epub3Fixture(), { signal: controller.signal });
        controller.abort();
        handle.goTo(3);
        await settle();
        expect(page(container).querySelector('h2')?.textContent).toBe('CHAPTER II. The Pool of Tears');
        expect(page(container).hasAttribute('aria-busy')).toBe(false);

        const signals: AbortSignal[] = [];
        const { inflateRawSync } = await import('node:zlib');
        const second = document.createElement('div');
        const viewer = await mountEpubViewer({ fileName: 'a.epub', data: epub3Fixture() }, second, ctx as never, deps, {
            styleIsolation: 'scoped',
            inflate: async (compressed, _max, signal) => { if (signal) signals.push(signal); return new Uint8Array(inflateRawSync(compressed)); }
        });
        expect(signals.length).toBeGreaterThan(0);
        expect(signals.every(signal => !signal.aborted)).toBe(true);
        viewer.dispose();
        expect(signals.every(signal => signal.aborted)).toBe(true);
        handle.dispose();
    });

    it('serves blob URLs only with allow-listed image types and sanitizes SVG', async () => {
        const opf = OPF_EPUB3.replace('</manifest>',
            '<item id="lie" href="images/x.png" media-type="text/html"/><item id="odd" href="images/x.weird" media-type="text/html"/><item id="vec" href="images/v.svg" media-type="image/svg+xml"/></manifest>');
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="2" onload="alert(2)"/></svg>';
        const { container, handle } = await mount(withChapter(
            '<p><img src="../images/x.png" alt="x"/><img src="../images/x.weird" alt="w"/><img src="../images/v.svg" alt="v"/></p>',
            [{ name: 'OEBPS/images/x.png', data: 'png-bytes' }, { name: 'OEBPS/images/x.weird', data: '<script>1</script>' }, { name: 'OEBPS/images/v.svg', data: svg }],
            opf));
        // The info-panel cover takes the first blob.
        // The info-panel cover takes one blob; chapter images may finish in any order.
        expect(blobs.map(blob => blob.type).sort()).toEqual(['application/octet-stream', 'image/jpeg', 'image/png', 'image/svg+xml']);
        const svgBlob = blobs.find(blob => blob.type === 'image/svg+xml')!;
        const svgText = await new Promise<string>(resolve => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.readAsText(svgBlob);
        });
        expect(svgText).toContain('<circle');
        expect(svgText).not.toMatch(/script|onload/);
        expect(page(container).querySelectorAll('img[src^="blob:"]')).toHaveLength(3);
        handle.dispose();
    });
});

describe('mountEpubViewer — review round 3 regressions', () => {
    const withChapter = (body: string, extra: Array<{ name: string; data: string | Uint8Array; method?: 0 | 8 }> = [], opf = OPF_EPUB3): Uint8Array =>
        buildZip([...epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>` }
            : member.name === 'OEBPS/content.opf' ? { ...member, data: opf } : member), ...extra]);

    it('cancels a left chapter\'s image reads and never runs more than four at once', async () => {
        const { inflateRawSync } = await import('node:zlib');
        let active = 0;
        let maxActive = 0;
        const signals: AbortSignal[] = [];
        const inflate = async (compressed: Uint8Array, _max: number, signal?: AbortSignal): Promise<Uint8Array> => {
            active++;
            maxActive = Math.max(maxActive, active);
            if (signal) signals.push(signal);
            await new Promise(resolve => setTimeout(resolve, 20));
            active--;
            return new Uint8Array(inflateRawSync(compressed));
        };
        const images = Array.from({ length: 12 }, (_, i) => ({ name: `OEBPS/images/p${i}.png`, data: new Uint8Array(64).fill(i), method: 8 as const }));
        // Everything but the images is stored, so the counter sees image reads only.
        const data = buildZip([
            ...epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
                ? { ...member, method: 0 as const, data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${images.map((_, i) => `<img src="../images/p${i}.png" alt="p${i}"/>`).join('')}</body></html>` }
                : { ...member, method: 0 as const }),
            ...images
        ]);
        const container = document.createElement('div');
        const handle = await mountEpubViewer({ fileName: 'a.epub', data }, container, ctx as never, deps, { styleIsolation: 'scoped', inflate });
        handle.goTo(3);
        await new Promise(resolve => setTimeout(resolve, 60));
        handle.goTo(1);
        await new Promise(resolve => setTimeout(resolve, 400));
        expect(maxActive).toBeLessThanOrEqual(4);
        // The first visit's reads were aborted when the chapter was left.
        expect(signals.some(signal => signal.aborted)).toBe(true);
        expect(page(container).querySelectorAll('img[src^="blob:"]')).toHaveLength(12);
        handle.dispose();
    });

    it('routes image-map areas instead of leaving live hrefs', async () => {
        const { container, handle } = await mount(withChapter(
            '<img usemap="#m" alt="map"/><map name="m"><area shape="rect" coords="0,0,1,1" href="#fall" alt="here"/><area shape="rect" coords="1,1,2,2" href="ch02.xhtml#pool" alt="next"/></map><p id="fall">x</p>'));
        const areas = [...page(container).querySelectorAll('area')];
        expect(areas.map(area => [area.hasAttribute('href'), area.getAttribute('role')])).toEqual([[false, 'link'], [false, 'link']]);
        areas[1]!.click();
        await settle();
        expect(handle.currentIndex()).toBe(3);
        handle.dispose();
    });

    it('keeps xml:lang as lang and falls back to the package language', async () => {
        const { container, handle } = await mount(withChapter('<p><span xml:lang="fr">bonjour</span></p>'));
        expect(page(container).querySelector('span')?.getAttribute('lang')).toBe('fr');
        expect(page(container).getAttribute('lang')).toBe('en');
        handle.dispose();
    });

    it('does not turn pages on arrow keys pressed on a control', async () => {
        const { container, handle } = await mount();
        buttonByLabel(container, 'epub.contents').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        await settle();
        expect(handle.currentIndex()).toBe(1);
        page(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        await settle();
        expect(handle.currentIndex()).toBe(3);
        handle.dispose();
    });
});

describe('mountEpubViewer — review round 4 regressions', () => {
    const withChapter = (body: string, extra: Array<{ name: string; data: string | Uint8Array }> = [], opf = OPF_EPUB3): Uint8Array =>
        buildZip([...epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>` }
            : member.name === 'OEBPS/content.opf' ? { ...member, data: opf } : member), ...extra]);
    const readBlob = (blob: Blob): Promise<string> => new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(blob);
    });

    it('keeps sanitized SVG images well-formed XML (non-breaking spaces, Illustrator entity DOCTYPEs)', async () => {
        const illustrator = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
\t<!ENTITY ns_svg "http://www.w3.org/2000/svg">
\t<!ENTITY ns_xlink "http://www.w3.org/1999/xlink">
]>
<svg version="1.1" xmlns="&ns_svg;" xmlns:xlink="&ns_xlink;" width="10" height="10"><text>Fig.&#160;1</text><script>alert(1)</script></svg>`;
        const { container, handle } = await mount(withChapter('<p><img src="../images/fig.svg" alt="fig"/></p>', [{ name: 'OEBPS/images/fig.svg', data: illustrator }]));
        const svg = blobs.find(blob => blob.type === 'image/svg+xml')!;
        const text = await readBlob(svg);
        const reparsed = new DOMParser().parseFromString(text, 'image/svg+xml');
        expect(reparsed.getElementsByTagName('parsererror')).toHaveLength(0);
        expect(reparsed.documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(reparsed.documentElement.textContent).toBe('Fig.\u00a01');
        expect(text).not.toContain('script');
        expect(page(container).querySelector('img')?.getAttribute('src')).toMatch(/^blob:/);
        handle.dispose();
    });

    it('does not mistake a file named like a CSS function for a fetch', async () => {
        const { container, handle } = await mount(withChapter('<p><img src="../images/image%20(1).jpg" alt="one"/></p>', [{ name: 'OEBPS/images/image (1).jpg', data: 'jpg' }]));
        expect(page(container).querySelector('img')?.getAttribute('src')).toMatch(/^blob:/);
        expect(page(container).querySelector('.omni-epub__note')).toBeNull();
        handle.dispose();
    });

    it('keeps focus in the reader when a focused link opens another chapter or a focused button is disabled', async () => {
        const { container, handle } = await mount();
        const link = [...page(container).querySelectorAll<HTMLElement>('a')].find(node => node.textContent === 'on to the pool')!;
        link.focus();
        link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settle();
        expect(handle.currentIndex()).toBe(3);
        const viewport = container.querySelector('.omni-epub__viewport');
        // The fragment target takes focus; with no fragment the viewport would.
        expect(viewport?.contains(document.activeElement)).toBe(true);

        handle.goTo(1);
        await settle();
        const next = buttonByLabel(container, 'epub.next');
        next.focus();
        next.click();
        await settle();
        expect(next.disabled).toBe(true);
        expect(document.activeElement).toBe(viewport);
        handle.dispose();
    });

    it('treats a non-finite index as the start of the book', async () => {
        const { handle } = await mount(epub3Fixture(), { initialIndex: Number.NaN });
        expect(handle.currentIndex()).toBe(1);
        handle.goTo(Number.NaN);
        expect(handle.currentIndex()).toBe(1);
        handle.dispose();
    });
});

describe('mountEpubViewer — review round 5 regressions', () => {
    const withChapter = (body: string, extra: Array<{ name: string; data: string | Uint8Array }> = []): Uint8Array =>
        buildZip([...epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>` }
            : member), ...extra]);
    const readBlob = (blob: Blob): Promise<string> => new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(blob);
    });

    it('keeps a fragment target in view as images above it load, until the reader scrolls', async () => {
        const { container, handle } = await mount();
        handle.goTo(1, 'fall');
        await settle();
        const viewport = container.querySelector<HTMLElement>('.omni-epub__viewport')!;
        let scrollTop = 0;
        Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
        const target = page(container).querySelector<HTMLElement>('[data-omni-epub-anchor="fall"]')!;
        target.getBoundingClientRect = () => ({ top: 300 } as DOMRect);
        const image = page(container).querySelector('img')!;
        image.dispatchEvent(new Event('load'));
        expect(scrollTop).toBe(300);
        viewport.dispatchEvent(new Event('wheel'));
        image.dispatchEvent(new Event('load'));
        expect(scrollTop).toBe(300 * 1);
        handle.dispose();
    });

    it('falls back to alt text when an SVG image cannot be sanitized in place', async () => {
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown): void => { rejections.push(reason); };
        process.on('unhandledRejection', onRejection);
        const prefixed = '<svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="1" height="1"><svg:rect width="1" height="1"/></svg:svg>';
        const { container, handle } = await mount(withChapter('<p><img src="../images/p.svg" alt="prefixed"/></p>', [{ name: 'OEBPS/images/p.svg', data: prefixed }]));
        await settle();
        process.off('unhandledRejection', onRejection);
        expect(page(container).querySelector('img')).toBeNull();
        expect(page(container).textContent).toContain('[prefixed]');
        expect(rejections).toEqual([]);
        handle.dispose();
    });

    it('strips remote references from the sanitized SVG blob itself', async () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><style>@import url(https://evil.example/s.css);</style>'
            + '<image xlink:href="https://evil.example/t.png" width="1" height="1"/><rect fill="url(https://evil.example/f)" stroke="url(#g)" width="1" height="1"/><image xlink:href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/></svg>';
        const { handle } = await mount(withChapter('<p><img src="../images/v.svg" alt="v"/></p>', [{ name: 'OEBPS/images/v.svg', data: svg }]));
        const text = await readBlob(blobs.find(blob => blob.type === 'image/svg+xml')!);
        expect(text).not.toContain('evil.example');
        expect(text).not.toContain('<style');
        expect(text).toContain('stroke="url(#g)"');
        expect(text).toContain('href="data:image/png;base64,iVBORw0KGgo="');
        handle.dispose();
    });
});

describe('mountEpubViewer — review round 7 regressions', () => {
    it('renders a namespace-less XHTML chapter without doubling line breaks or swallowing anchors', async () => {
        const data = buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: '<?xml version="1.0"?><html><head><title>x</title></head><body><p id="poem">a<br/>b<a id="m"/>c</p></body></html>' }
            : member));
        const { container, handle } = await mount(data);
        const poem = page(container).querySelector('[data-omni-epub-anchor="poem"]')!;
        expect(poem.querySelectorAll('br')).toHaveLength(1);
        expect(poem.querySelector('a')?.textContent).toBe('');
        expect(poem.textContent).toBe('abc');
        handle.dispose();
    });
});

describe('mountEpubViewer — review round 8 regressions', () => {
    it('keeps fragment-link and keyboard same-chapter jumps anchored while images load', async () => {
        const { container, handle } = await mount();
        const viewport = container.querySelector<HTMLElement>('.omni-epub__viewport')!;
        let scrollTop = 0;
        Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
        const top = page(container).querySelector<HTMLElement>('[data-omni-epub-anchor="chap01"]')!;
        top.getBoundingClientRect = () => ({ top: 300 } as DOMRect);
        const image = page(container).querySelector('img')!;
        const link = (text: string): HTMLElement => [...page(container).querySelectorAll<HTMLElement>('a')].find(node => node.textContent === text)!;

        // A '#fragment' footnote-style link, activated by pointer.
        link('back to top').dispatchEvent(new Event('pointerdown', { bubbles: true }));
        link('back to top').click();
        await settle();
        const afterJump = scrollTop;
        image.dispatchEvent(new Event('load'));
        expect(scrollTop).toBe(afterJump + 300);

        // The same link activated with Enter.
        scrollTop = 0;
        // Browser keydowns are cancelable; the link handler's preventDefault is what the anchor guard reads.
        link('back to top').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await settle();
        const afterKey = scrollTop;
        image.dispatchEvent(new Event('load'));
        expect(scrollTop).toBe(afterKey + 300);
        handle.dispose();
    });
});

describe('mountEpubViewer — review round 9 regressions', () => {
    const withChapter = (body: string): Uint8Array =>
        buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>` }
            : member));

    it('still turns pages after a jump focuses an inert book anchor', async () => {
        const { container, handle } = await mount(withChapter('<p><a id="filepos1234"></a>Section</p>'));
        handle.goTo(1, 'filepos1234');
        await settle();
        const anchor = page(container).querySelector<HTMLElement>('[data-omni-epub-anchor="filepos1234"]')!;
        expect(document.activeElement).toBe(anchor);
        anchor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        await settle();
        expect(handle.currentIndex()).toBe(3);
        handle.dispose();
    });

    it('still turns pages after a jump focuses a footnote back-link', async () => {
        const { container, handle } = await mount(withChapter('<p><a id="ref1" href="#fn1">[1]</a></p><aside><a id="fn1" href="#ref1">[1]</a> Note.</aside>'));
        page(container).querySelector<HTMLElement>('[data-omni-epub-anchor="ref1"]')!.click();
        await settle();
        const backLink = page(container).querySelector<HTMLElement>('[data-omni-epub-anchor="fn1"]')!;
        expect(document.activeElement).toBe(backLink);
        backLink.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        await settle();
        expect(handle.currentIndex()).toBe(3);
        handle.dispose();
    });

    it('leaves arrow keys to a horizontally scrollable code block', async () => {
        const { container, handle } = await mount(withChapter('<pre>a very long line of code</pre>'));
        const pre = page(container).querySelector<HTMLElement>('pre')!;
        pre.style.overflowX = 'auto';
        Object.defineProperty(pre, 'scrollWidth', { configurable: true, value: 845 });
        Object.defineProperty(pre, 'clientWidth', { configurable: true, value: 300 });
        const arrow = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
        pre.dispatchEvent(arrow);
        await settle();
        expect(arrow.defaultPrevented).toBe(false);
        expect(handle.currentIndex()).toBe(1);
        handle.dispose();
    });

    it('lets Space scrolling on a link cancel the re-anchor', async () => {
        const { container, handle } = await mount();
        handle.goTo(1, 'fall');
        await settle();
        const viewport = container.querySelector<HTMLElement>('.omni-epub__viewport')!;
        let scrollTop = 0;
        Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
        page(container).querySelector<HTMLElement>('[data-omni-epub-anchor="fall"]')!.getBoundingClientRect = () => ({ top: 300 } as DOMRect);
        const external = [...page(container).querySelectorAll<HTMLElement>('a')].find(node => node.textContent === 'Gutenberg')!;
        const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
        external.dispatchEvent(space);
        expect(space.defaultPrevented).toBe(false);
        page(container).querySelector('img')!.dispatchEvent(new Event('load'));
        expect(scrollTop).toBe(0);
        handle.dispose();
    });

    it('leaves prose attributes that merely read like CSS functions alone', async () => {
        const { container, handle } = await mount(withChapter(
            '<table summary="Cover image (front) and spine"><tr><td>x</td></tr></table><p data-caption="see image (left)">y</p>'));
        expect(page(container).querySelector('table')?.getAttribute('summary')).toBe('Cover image (front) and spine');
        expect(page(container).querySelector('p')?.getAttribute('data-caption')).toBe('see image (left)');
        expect(page(container).querySelector('.omni-epub__note')).toBeNull();
        handle.dispose();
    });
});

describe('mountEpubViewer — review round 12 regressions', () => {
    it('moves focus to the reader when a focused link opens another chapter at its top', async () => {
        const data = buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><p><a href="ch02.xhtml">next</a></p></body></html>' }
            : member));
        const { container, handle } = await mount(data);
        const link = page(container).querySelector<HTMLElement>('a')!;
        link.focus();
        link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await settle();
        expect(handle.currentIndex()).toBe(3);
        expect(document.activeElement).toBe(container.querySelector('.omni-epub__viewport'));
        handle.dispose();
    });
});

describe('mountEpubViewer — review round 13 regressions', () => {
    it('keeps ids that share a name with document properties, and links to them', async () => {
        const data = buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><h1 id="title">T</h1><section id="images">I</section><p data-omni-epub-id="planted">p</p><a href="#title">to title</a> <a href="#images">to images</a></body></html>' }
            : member));
        const { container, handle } = await mount(data);
        expect(page(container).querySelector('h1')?.getAttribute('data-omni-epub-anchor') ?? '').toBe('title');
        expect(page(container).querySelector('section')?.getAttribute('data-omni-epub-anchor') ?? '').toBe('images');
        // A marker written by the book is not turned into an id.
        expect(page(container).querySelector('p')?.hasAttribute('id')).toBe(false);
        expect(page(container).querySelector('[data-omni-epub-id]')).toBeNull();
        const links = [...page(container).querySelectorAll('a')];
        expect(links.map(link => link.getAttribute('role'))).toEqual(['link', 'link']);
        handle.dispose();
    });
});

describe('mountEpubViewer — review round 14 regressions', () => {
    it('cannot clobber host document members through img name + id in scoped mode', async () => {
        const data = buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><img name="foo" id="getElementById" alt="a"/><img name="bar" id="importNode" alt="b"/><img id="cover1" name="c" alt="c"/><p id="title">t</p></body></html>' }
            : member));
        const { container, handle } = await mount(data);
        expect(typeof document.getElementById).toBe('function');
        expect(typeof document.importNode).toBe('function');
        const images = [...page(container).querySelectorAll('img')];
        expect(images.every(image => !image.hasAttribute('name'))).toBe(true);
        // Ids survive as anchors; their DOM ids are namespaced, so none names a document member.
        expect(images.map(image => image.getAttribute('data-omni-epub-anchor') ?? '')).toEqual(['getElementById', 'importNode', 'cover1']);
        expect(images.every(image => /^omni-epub-\d+-/.test(image.id))).toBe(true);
        expect(page(container).querySelector('p')?.getAttribute('data-omni-epub-anchor') ?? '').toBe('title');
        // The viewer keeps working on the next chapter.
        handle.goTo(3);
        await settle();
        expect(page(container).querySelector('h2')?.textContent).toBe('CHAPTER II. The Pool of Tears');
        handle.dispose();
    });
});

describe('mountEpubViewer — review round 15 regressions', () => {
    it('cannot clobber a host form the scoped viewer is mounted inside', async () => {
        const data = buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><img id="submit" alt="a"/><fieldset id="elements"/><output id="method"/><p id="action">ordinary</p><img id="figure1" alt="b"/></body></html>' }
            : member));
        const form = document.createElement('form');
        const container = document.createElement('div');
        form.append(container);
        document.body.append(form);
        const handle = await mountEpubViewer({ fileName: 'a.epub', data }, container, ctx as never, deps, { styleIsolation: 'scoped' });
        await settle();
        const content = page(container);
        // Every id survives as an anchor; the namespaced DOM ids cannot name form members.
        const anchors = [content.querySelector('img'), content.querySelector('fieldset'), content.querySelector('output')]
            .map(element => element?.getAttribute('data-omni-epub-anchor'));
        expect(anchors).toEqual(['submit', 'elements', 'method']);
        expect(content.querySelector('img')!.id).toMatch(/^omni-epub-\d+-submit$/);
        expect(content.querySelector('p')?.getAttribute('data-omni-epub-anchor') ?? '').toBe('action');
        expect(content.querySelectorAll('img')[1]?.getAttribute('data-omni-epub-anchor') ?? '').toBe('figure1');
        expect(typeof form.submit).toBe('function');
        handle.dispose();
        form.remove();
    });
});

describe('mountEpubViewer — review round 16 regressions', () => {
    const withChapter = (body: string, prolog = '<?xml version="1.0"?>'): Uint8Array =>
        buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: `${prolog}<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>x</title></head><body>${body}</body></html>` }
            : member));

    it('resolves epub:switch to a renderable case or the default instead of dropping it', async () => {
        const { container, handle } = await mount(withChapter(
            '<p>before</p><epub:switch id="s1"><epub:case required-namespace="http://www.xml-cml.org/schema"><cml>x</cml></epub:case>'
            + '<epub:default><p id="fallback">H2O</p></epub:default></epub:switch>'
            + '<epub:switch><epub:case required-namespace="http://www.w3.org/1998/Math/MathML"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math></epub:case><epub:default><p>plain x</p></epub:default></epub:switch>'
            + '<epub:trigger action="show" ref="x"/><p>after</p>'));
        const content = page(container);
        expect(content.querySelector('[data-omni-epub-anchor="fallback"]')?.textContent).toBe('H2O');
        expect(content.querySelector('math mi')?.textContent).toBe('x');
        expect(content.textContent).not.toContain('plain x');
        expect(content.textContent).not.toMatch(/^\s*x\s*$/m);
        handle.dispose();
    });

    it('shows the warning band only for a partial book', async () => {
        const wrongMimetype = buildZip(epub3Members().map(member => member.name === 'mimetype' ? { ...member, data: 'application/zip' } : member));
        const { container, handle } = await mount(wrongMimetype);
        expect(container.querySelector<HTMLElement>('.omni-epub__warnings')?.hidden).toBe(true);
        handle.dispose();
    });

    it('exposes the current text size in the scale button\'s accessible name and announces changes', async () => {
        const { container, handle } = await mount();
        const scale = container.querySelector<HTMLButtonElement>('.omni-epub__scale')!;
        const status = container.querySelector('.omni-epub__sr-only')!;
        expect(scale.getAttribute('aria-label')).toBe('epub.textScale scale=100');
        expect(status.textContent).toBe('');
        buttonByLabel(container, 'epub.textLarger').click();
        expect(scale.getAttribute('aria-label')).toBe('epub.textScale scale=110');
        expect(status.textContent).toBe('epub.textScale scale=110');
        handle.dispose();
    });

    it('notes a chapter whose declared encoding the core cannot decode', async () => {
        const { container, handle } = await mount(withChapter('<p>text</p>', '<?xml version="1.0" encoding="Shift_JIS"?>'));
        expect(page(container).querySelector('.omni-epub__note')?.textContent).toBe('diag.epub.encoding encoding=Shift_JIS');
        handle.dispose();
    });
});

describe('mountEpubViewer — review round 18 regressions', () => {
    const withChapter = (chapter: string, mediaType?: string): Uint8Array =>
        buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml' ? { ...member, data: chapter }
            : member.name === 'OEBPS/content.opf' && mediaType
                ? { ...member, data: OPF_EPUB3.replace('href="text/ch01.xhtml" id="ch1" media-type="application/xhtml+xml"', `href="text/ch01.xhtml" id="ch1" media-type="${mediaType}"`) }
                : member));

    it('treats <a name> anchors as fragment targets', async () => {
        const { container, handle } = await mount(withChapter('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><p><a href="#n1">1</a></p><p><a name="n1"></a>Note</p></body></html>'));
        const link = [...page(container).querySelectorAll('a')].find(node => node.textContent === '1')!;
        expect(link.getAttribute('role')).toBe('link');
        expect(page(container).querySelector('[data-omni-epub-anchor="n1"]')).not.toBeNull();
        handle.dispose();
    });

    it('does not let a self-closed <script/> or <title/> swallow a recovered or OEB chapter', async () => {
        const recovered = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch</title><script type="text/javascript" src="../js/a.js"/></head><body><h1>Chapter&nbsp;1</h1><p>Body</p></body></html>';
        const first = await mount(withChapter(recovered));
        expect(page(first.container).querySelector('h1')?.textContent).toBe('Chapter\u00a01');
        first.handle.dispose();
        const oeb = await mount(withChapter('<html><head><title/></head><body><p>Text</p></body></html>', 'text/x-oeb1-document'));
        expect(page(oeb.container).querySelector('p')?.textContent).toBe('Text');
        oeb.handle.dispose();
    });

    it('reports a recovered chapter that yields nothing instead of showing a blank page', async () => {
        const { container, handle } = await mount(withChapter('<html><body></body></html>', 'text/html'));
        expect(page(container).querySelector('[role="alert"]')?.textContent).toBe('epub.chapter.renderFailed path=OEBPS/text/ch01.xhtml');
        handle.dispose();
    });
});

describe('mountEpubViewer — review round 19 regressions', () => {
    const withChapter = (chapter: string, opf?: string): Uint8Array =>
        buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml' ? { ...member, data: chapter }
            : member.name === 'OEBPS/content.opf' && opf ? { ...member, data: opf } : member));

    it('does not let any self-closed non-void element wrap or swallow the rest of a recovered chapter', async () => {
        const { container, handle } = await mount(withChapter(
            '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><p>a&nbsp;b</p><video src="v.mp4" controls="controls"/><b/><a id="anchor"/><p>REST</p></body></html>'));
        const rest = [...page(container).querySelectorAll('p')].find(node => node.textContent === 'REST');
        expect(rest).toBeDefined();
        expect(rest?.closest('b, a')).toBeNull();
        expect(page(container).querySelector('[data-omni-epub-anchor="anchor"]')).not.toBeNull();
        handle.dispose();
    });

    it('keeps an id on <body> as a link target', async () => {
        const { container, handle } = await mount(withChapter(
            '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body id="top"><p>text</p><a href="#top">Back to top</a></body></html>'));
        expect(page(container).querySelector('a')?.getAttribute('role')).toBe('link');
        expect(page(container).querySelector('[data-omni-epub-anchor="top"]')).not.toBeNull();
        handle.dispose();
    });

    it('synthesizes contents from every document when no spine item is linear and there is no TOC', async () => {
        const opf = OPF_EPUB3.replace(' properties="nav"', '').replace('<spine toc="ncx2">', '<spine>').replace(/<item href="toc.ncx"[^>]*\/>/, '')
            .replace('<itemref idref="ch1"/>', '<itemref idref="ch1" linear="no"/>').replace('<itemref idref="ch2"/>', '<itemref idref="ch2" linear="no"/>');
        const data = buildZip(epub3Members().filter(member => member.name !== 'OEBPS/toc.ncx').map(member => member.name === 'OEBPS/content.opf' ? { ...member, data: opf } : member));
        const { container, handle } = await mount(data);
        expect(container.querySelectorAll('.omni-epub__toc-link')).toHaveLength(4);
        handle.dispose();
    });
});

describe('prepareChapter — review round 20 regressions', () => {
    const purifier = createDOMPurify(window as never);

    it('expands self-closed tags in linear time on hostile input', () => {
        for (const hostile of ['<a'.repeat(20_000), `<a${' '.repeat(50_000)}`, '<a b'.repeat(10_000)]) {
            const started = performance.now();
            prepareChapter(`<html><body>${hostile}</body></html>`, 'html', 'OEBPS/x.html', purifier, document);
            expect(performance.now() - started).toBeLessThan(1500);
        }
    });

    it('keeps an uppercase <BR/> a single line break', () => {
        const prepared = prepareChapter('<html><body><p>a<BR/>b<Br />c</p></body></html>', 'html', 'OEBPS/x.html', purifier, document);
        const holder = document.createElement('div');
        holder.append(...prepared.nodes.map(node => document.importNode(node, true)));
        expect(holder.querySelectorAll('br')).toHaveLength(2);
    });

    it('treats a chapter whose only output is the body id marker as empty', () => {
        expect(prepareChapter('<html><body id="c1"><script>x</script></body></html>', 'html', 'OEBPS/x.html', purifier, document).empty).toBe(true);
        expect(prepareChapter('<html><body id="c1"><p>text</p></body></html>', 'html', 'OEBPS/x.html', purifier, document).empty).toBe(false);
    });
});

describe('review round 21 regressions — no quadratic main-thread work', () => {
    const purifier = createDOMPurify(window as never);
    const chapterOf = (body: string): string =>
        `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>x</title></head><body>${body}</body></html>`;

    it('resolves thousands of epub:switch blocks in one pass', () => {
        const one = '<epub:switch><epub:case required-namespace="http://www.w3.org/1998/Math/MathML"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math></epub:case><epub:default><p>x</p></epub:default></epub:switch>';
        const started = performance.now();
        const prepared = prepareChapter(chapterOf(one.repeat(3000)), 'xhtml', 'OEBPS/x.xhtml', purifier, document);
        expect(performance.now() - started).toBeLessThan(4000);
        expect(prepared.nodes.filter(node => (node as Element).localName === 'math')).toHaveLength(3000);
    });

    it('hardens thousands of broken fragment links without rescanning ids per link', async () => {
        const body = Array.from({ length: 4000 }, (_, i) => `<p id="s${i}"><a href="#m${i}">${i}</a></p>`).join('');
        const data = buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml' ? { ...member, data: chapterOf(body) } : member));
        const started = performance.now();
        const { container, handle } = await mount(data);
        expect(performance.now() - started).toBeLessThan(4000);
        expect(page(container).querySelectorAll('a[aria-disabled="true"]')).toHaveLength(4000);
        handle.dispose();
    });
});

describe('mountEpubViewer — review round 22 regressions', () => {
    it('keeps an image\'s id on its alt-text stand-in so links to it still work', async () => {
        const data = buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><a href="#fig">see figure</a><img id="fig" alt="Figure 1" src="missing.png"/></body></html>' }
            : member));
        const { container, handle } = await mount(data);
        const standIn = page(container).querySelector<HTMLElement>('[data-omni-epub-anchor="fig"]')!;
        expect(standIn.localName).toBe('span');
        expect(standIn.textContent).toBe('[Figure 1]');
        expect(page(container).querySelector('a')?.getAttribute('role')).toBe('link');
        page(container).querySelector<HTMLElement>('a')!.click();
        await settle();
        expect(document.activeElement).toBe(standIn);
        handle.dispose();
    });
});

describe('review round 23 regressions', () => {
    it('keeps a trailing slash in an unquoted attribute value instead of self-closing the tag', () => {
        const prepared = prepareChapter('<html><body><p><a href=http://www.gutenberg.org/>Project Gutenberg</a> <b />bold? <span id=x/>after</span></p></body></html>', 'html', 'OEBPS/x.html', createDOMPurify(window as never), document);
        const holder = document.createElement('div');
        holder.append(...prepared.nodes.map(node => document.importNode(node, true)));
        expect(holder.querySelector('a')?.textContent).toBe('Project Gutenberg');
        expect(holder.querySelector('a')?.getAttribute('data-omni-epub-href')).toBe('http://www.gutenberg.org/');
        expect(holder.querySelector('b')?.textContent).toBe('');
    });

    it('keeps focus on an image\'s stand-in when it fails after a jump focused it', async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const inflate = async (): Promise<Uint8Array> => { await gate; throw new Error('corrupt'); };
        const container = document.createElement('div');
        document.body.append(container);
        // Only the image is deflated; everything else is stored and needs no inflater.
        const stored = buildZip([...epub3Members().map(member => ({ ...member, method: 0 as const, ...(member.name === 'OEBPS/text/ch01.xhtml' ? { data: '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><img id="fig" alt="Figure" src="../images/bad.png"/></body></html>' } : {}) })), { name: 'OEBPS/images/bad.png', data: 'x', method: 8 }]);
        const handle = await mountEpubViewer({ fileName: 'a.epub', data: stored }, container, ctx as never, deps, { styleIsolation: 'scoped', inflate });
        handle.goTo(1, 'fig');
        expect(document.activeElement?.getAttribute('data-omni-epub-anchor')).toBe('fig');
        release();
        await settle();
        const standIn = page(container).querySelector<HTMLElement>('[data-omni-epub-anchor="fig"]')!;
        expect(standIn.localName).toBe('span');
        expect(document.activeElement).toBe(standIn);
        handle.dispose();
    });
});

describe('review round 24 regressions', () => {
    it('renders a chapter with a very large number of top-level nodes', async () => {
        const body = '<p>x</p>\n'.repeat(160_000);
        const data = buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>` }
            : member));
        // Raised element cap: this test is about argument-spread stack limits, not density.
        const { container, handle } = await mount(data, { maxChapterElements: 300_000 });
        expect(page(container).querySelector('.omni-epub__chapter')!.childElementCount).toBeGreaterThanOrEqual(160_000);
        expect(page(container).hasAttribute('aria-busy')).toBe(false);
        handle.dispose();
    }, 60_000);

    it('expands a self-closed tag that ends in a bare attribute name', () => {
        const purifier = createDOMPurify(window as never);
        const prepared = prepareChapter('<html><body><p>a</p><iframe src="https://x/" allowfullscreen/><p>REST</p><span hidden/><p>visible</p><a href=http://x/>link</a></body></html>', 'html', 'OEBPS/x.html', purifier, document);
        const holder = document.createElement('div');
        holder.append(...prepared.nodes.map(node => document.importNode(node, true)));
        expect([...holder.querySelectorAll('p')].map(p => p.textContent)).toEqual(['a', 'REST', 'visible']);
        expect(holder.querySelector('[hidden] p')).toBeNull();
        expect(holder.querySelector('a')?.textContent).toBe('link');
    });

    it('keeps an alt-less failed image as a focusable, linkable stand-in', async () => {
        const data = buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><a href="#fig">see</a><img id="fig" src="missing.png"/></body></html>' }
            : member));
        const { container, handle } = await mount(data);
        const standIn = page(container).querySelector<HTMLElement>('[data-omni-epub-anchor="fig"]')!;
        expect(standIn.localName).toBe('span');
        page(container).querySelector<HTMLElement>('a')!.click();
        await settle();
        expect(document.activeElement).toBe(standIn);
        handle.dispose();
    });
});

describe('review round 25 regressions', () => {
    const withChapter = (body: string): Uint8Array =>
        buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>` }
            : member));

    it('cannot drive host controls through <label for> in scoped mode', async () => {
        const hostButton = document.createElement('button');
        hostButton.id = 'host-delete';
        const clicked = vi.fn();
        hostButton.addEventListener('click', clicked);
        document.body.append(hostButton);
        const { container, handle } = await mount(withChapter('<label for="host-delete">Tap here to continue reading</label><fieldset form="hostform"/>'));
        const label = page(container).querySelector('label')!;
        expect(label.hasAttribute('for')).toBe(false);
        expect(page(container).querySelector('fieldset')?.hasAttribute('form')).toBe(false);
        label.click();
        expect(clicked).not.toHaveBeenCalled();
        handle.dispose();
        hostButton.remove();
    });

    it('keeps a link to a failed SVG image pointing at its drawing', async () => {
        const { container, handle } = await mount(withChapter('<a href="#fig2">see figure 2</a><svg xmlns="http://www.w3.org/2000/svg" id="drawing"><image id="fig2" href="../images/missing.png" width="1" height="1"/></svg>'));
        const viewport = container.querySelector<HTMLElement>('.omni-epub__viewport')!;
        let scrollTop = 500;
        Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
        page(container).querySelector('svg')!.getBoundingClientRect = () => ({ top: 120 } as DOMRect);
        page(container).querySelector<HTMLElement>('a')!.click();
        await settle();
        expect(scrollTop).toBe(620);
        handle.dispose();
    });
});

describe('review round 26 regressions — confining id references in scoped mode', () => {
    const withChapter = (body: string): Uint8Array =>
        buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>` }
            : member));

    it('binds usemap only to a map inside the chapter, under a unique name', async () => {
        const { container, handle } = await mount(withChapter(
            '<img usemap="#hostmap" alt="a"/><img usemap="#m" alt="b"/><map name="m"><area shape="rect" coords="0,0,1,1" href="#x" alt="x"/></map><p id="x">x</p>'));
        const images = [...page(container).querySelectorAll('img')];
        expect(images[0]!.hasAttribute('usemap')).toBe(false);
        const map = page(container).querySelector('map')!;
        expect(map.getAttribute('name')).not.toBe('m');
        expect(images[1]!.getAttribute('usemap')).toBe(`#${map.getAttribute('name')}`);
        handle.dispose();
    });

    it('drops SMIL animation, out-of-chapter ARIA references, details groups, and positive tabindex', async () => {
        const { container, handle } = await mount(withChapter(
            '<svg xmlns="http://www.w3.org/2000/svg"><animateMotion href="#hostRect" path="M0,0 L300,300"/><animateTransform href="#hostRect" attributeName="transform" type="scale" values="0;0"/></svg>'
            + '<div role="group" aria-owns="hostPanel own" aria-labelledby="hostPanel"><span id="own">mine</span></div>'
            + '<details name="settings"><summary>s</summary></details><p tabindex="1">t</p><p tabindex="-1">u</p>'));
        const content = page(container);
        expect(content.querySelector('animateMotion, animateTransform')).toBeNull();
        const group = content.querySelector('[role="group"]')!;
        expect(group.getAttribute('aria-owns')).toBe(content.querySelector('[data-omni-epub-anchor="own"]')!.id);
        expect(group.hasAttribute('aria-labelledby')).toBe(false);
        expect(content.querySelector('details')?.hasAttribute('name')).toBe(false);
        expect([...content.querySelectorAll('p[tabindex]')].map(p => p.getAttribute('tabindex'))).toEqual(['0', '-1']);
        handle.dispose();
    });
});

describe('review round 27 regressions', () => {
    const withChapter = (body: string): Uint8Array =>
        buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>` }
            : member));

    it('binds usemap to an id-only (XHTML 1.1) map and gives duplicate-named maps unique names', async () => {
        const { container, handle } = await mount(withChapter(
            '<img usemap="#m1" alt="a"/><map id="m1"><area shape="rect" coords="0,0,1,1" href="#p" alt="go"/></map><map name="m"/><map name="m"/><p id="p">p</p>'));
        const maps = [...page(container).querySelectorAll('map')];
        expect(page(container).querySelector('img')?.getAttribute('usemap')).toBe(`#${maps[0]!.getAttribute('name')}`);
        expect(new Set(maps.map(map => map.getAttribute('name'))).size).toBe(3);
        expect(maps.every(map => /^omni-epub-\d+-map-\d+$/.test(map.getAttribute('name')!))).toBe(true);
        expect(page(container).querySelector('area')?.getAttribute('role')).toBe('link');
        handle.dispose();
    });

    it('never lets a chapter ARIA reference resolve to a colliding host id, attached or attached later', async () => {
        const host = document.createElement('nav');
        host.id = 'sidebar';
        document.body.prepend(host);
        const chapter = '<div role="group" aria-owns="sidebar own" aria-describedby="sidebar"><span id="sidebar">mine</span><span id="own"></span></div>';
        // Attached before mount, and detached at mount then attached afterwards.
        for (const attachFirst of [true, false]) {
            const container = document.createElement('div');
            if (attachFirst) document.body.append(container);
            const handle = await mountEpubViewer({ fileName: 'a.epub', data: withChapter(chapter) }, container, ctx as never, deps, { styleIsolation: 'scoped' });
            await settle();
            if (!attachFirst) document.body.append(container);
            const group = page(container).querySelector('[role="group"]')!;
            for (const token of `${group.getAttribute('aria-owns')} ${group.getAttribute('aria-describedby')}`.split(' ')) {
                const target = document.getElementById(token);
                expect(target && page(container).contains(target)).toBe(true);
            }
            expect(group.getAttribute('aria-describedby')).toBe(page(container).querySelector('[data-omni-epub-anchor="sidebar"]')!.id);
            handle.dispose();
            container.remove();
        }
        host.remove();
    });
});

describe('review round 28 regressions', () => {
    it('confines a huge repeated ARIA token list without per-token ancestor walks', async () => {
        const nested = '<div>'.repeat(300) + '<span id="a">x</span>' + '</div>'.repeat(300);
        const body = `${nested}<p aria-describedby="${'a '.repeat(300_000)}">p</p>`;
        const data = buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>` }
            : member));
        const started = performance.now();
        const { container, handle } = await mount(data);
        expect(performance.now() - started).toBeLessThan(8000);
        expect(page(container).querySelector('p')?.getAttribute('aria-describedby')).toBe(page(container).querySelector('[data-omni-epub-anchor="a"]')!.id);
        handle.dispose();
    }, 30_000);
});

describe('review round 30 regressions', () => {
    const purifier = createDOMPurify(window as never);
    const render = (body: string): HTMLElement => {
        const prepared = prepareChapter(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>`, 'xhtml', 'OEBPS/x.xhtml', purifier, document);
        const holder = document.createElement('div');
        for (const node of prepared.nodes) holder.append(document.importNode(node, true));
        return holder;
    };

    it('rewrites url(#…) in linear time on a hostile attribute', () => {
        const started = performance.now();
        render(`<svg xmlns="http://www.w3.org/2000/svg"><rect fill="${'url(#'.repeat(16_000)}"/></svg>`);
        expect(performance.now() - started).toBeLessThan(1500);
    });

    it('confines escaped and quoted url() spellings to chapter ids', () => {
        const holder = render('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs>'
            + `<rect fill='url(" #hostA")' filter='url(\\23 hostC)' stroke='u\\72l(#g)' mask='url( "#g" )'/></svg>`);
        const rect = holder.querySelector('rect')!;
        const gradient = holder.querySelector('linearGradient')!.id;
        expect([rect.getAttribute('fill'), rect.getAttribute('filter'), rect.getAttribute('stroke'), rect.getAttribute('mask')])
            .toEqual(['none', 'none', `url(#${gradient})`, `url(#${gradient})`]);
    });
});

describe('review round 31 regressions', () => {
    it('never turns escaped CSS into a fetching function when rewriting url(#…)', () => {
        const prepared = prepareChapter(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>`
            + `<svg xmlns="http://www.w3.org/2000/svg"><mask id="m"/><rect mask="\\69 mage-set\\28 'https://evil.example/p.png' 1x\\29 , url\\28 #m\\29 "/>`
            + `<rect fill="\\69 mage-set\\28 'https://evil.example/q.png' 1x\\29"/></svg></body></html>`, 'xhtml', 'OEBPS/x.xhtml', createDOMPurify(window as never), document);
        const holder = document.createElement('div');
        for (const node of prepared.nodes) holder.append(document.importNode(node, true));
        for (const rect of holder.querySelectorAll('rect')) {
            for (const name of ['mask', 'fill']) expect(rect.getAttribute(name) ?? '').not.toMatch(/image-set|evil/i);
        }
    });

    it('drops a double-escaped url() that becomes a live fetch only after the rewrite', () => {
        // One unescape yields only `\75rl(`, so the raw-value scan lets it through;
        // the check on the rewritten value is what drops it.
        const prepared = prepareChapter(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>`
            + `<svg xmlns="http://www.w3.org/2000/svg"><mask id="m"/><rect mask="url(#m) \\5c 75rl(https://evil.example/d.png)" cursor="url(#m), \\5c 75rl(https://evil.example/x.cur), auto"/></svg></body></html>`,
            'xhtml', 'OEBPS/x.xhtml', createDOMPurify(window as never), document);
        const holder = document.createElement('div');
        for (const node of prepared.nodes) holder.append(document.importNode(node, true));
        const rect = holder.querySelector('rect')!;
        expect(rect.hasAttribute('mask')).toBe(false);
        expect(rect.getAttribute('cursor') ?? '').not.toMatch(/evil|75rl/);
    });

    it('keeps an inline raster on an SVG <image> in chapter markup', () => {
        const prepared = prepareChapter(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>`
            + `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image width="10" height="10" xlink:href="data:image/png;base64,iVBORw0KGgo="/></svg></body></html>`,
            'xhtml', 'OEBPS/x.xhtml', createDOMPurify(window as never), document);
        const holder = document.createElement('div');
        for (const node of prepared.nodes) holder.append(document.importNode(node, true));
        const image = holder.querySelector('image')!;
        expect(image.getAttribute('href') ?? image.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe('data:image/png;base64,iVBORw0KGgo=');
    });
});

describe('review round 33 regressions', () => {
    it('refuses a chapter with more elements than the cap instead of rendering it', () => {
        const prepared = prepareChapter(`<html><body>${'<p>x</p>'.repeat(1001)}</body></html>`, 'html', 'OEBPS/x.html', createDOMPurify(window as never), document, 1000);
        expect(prepared).toMatchObject({ tooLarge: true, nodes: [] });
        expect(prepareChapter('<html><body><p>x</p></body></html>', 'html', 'OEBPS/x.html', createDOMPurify(window as never), document, 1000).tooLarge).toBe(false);
    });

    it('shows a size message for an over-dense chapter in the viewer', async () => {
        const body = '<p>x</p>'.repeat(100_001);
        const data = buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>` }
            : member));
        const { container, handle } = await mount(data);
        expect(page(container).querySelector('[role="alert"]')?.textContent).toBe('epub.read.too-large path=OEBPS/text/ch01.xhtml');
        handle.dispose();
    }, 60_000);

    it('strips name from fieldset and output so they cannot join a host form', async () => {
        const form = document.createElement('form');
        const email = document.createElement('input');
        email.name = 'email';
        email.value = 'me@example.com';
        const container = document.createElement('div');
        form.append(email, container);
        document.body.append(form);
        const data = buildZip(epub3Members().map(member => member.name === 'OEBPS/text/ch01.xhtml'
            ? { ...member, data: '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><fieldset name="email"><p>f</p></fieldset><output name="email2">o</output></body></html>' }
            : member));
        const handle = await mountEpubViewer({ fileName: 'a.epub', data }, container, ctx as never, deps, { styleIsolation: 'scoped' });
        await settle();
        expect(page(container).querySelector('[name]')).toBeNull();
        expect(form.elements.namedItem('email')).toBe(email);
        expect(form.elements.namedItem('email2')).toBeNull();
        handle.dispose();
        form.remove();
    });
});

describe('review round 34 regressions', () => {
    it('refuses an over-dense chapter before parsing it', () => {
        const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
        const prepared = prepareChapter(`<html><body>${'<i/>'.repeat(2000)}</body></html>`, 'xhtml', 'OEBPS/x.xhtml', createDOMPurify(window as never), document, 1000);
        expect(prepared.tooLarge).toBe(true);
        expect(parse).not.toHaveBeenCalled();
        parse.mockRestore();
    });

    it('never parses an over-dense or oversized SVG cover', async () => {
        const dense = `<svg xmlns="http://www.w3.org/2000/svg">${'<g/>'.repeat(50_001)}</svg>`;
        const data = buildZip(epub3Members().map(member => member.name === 'OEBPS/content.opf'
            ? { ...member, data: OPF_EPUB3.replace('href="images/cover%20art.jpg" id="cover-img" media-type="image/jpeg"', 'href="images/c.svg" id="cover-img" media-type="image/svg+xml"') }
            : member).concat([{ name: 'OEBPS/images/c.svg', data: dense }]));
        const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
        const { container, handle } = await mount(data);
        const svgParses = parse.mock.calls.filter(call => call[1] === 'image/svg+xml');
        parse.mockRestore();
        expect(svgParses).toHaveLength(0);
        expect(container.querySelector<HTMLImageElement>('.omni-epub__cover')?.hidden).toBe(true);
        handle.dispose();
    });

    it('clamps an explicit maxChapterBytes to maxResourceBytes', async () => {
        const { container, handle } = await mount(epub3Fixture(), { maxResourceBytes: 100, maxChapterBytes: 1_000_000 });
        expect(page(container).querySelector('[role="alert"]')?.textContent).toBe('epub.read.too-large path=OEBPS/text/ch01.xhtml');
        handle.dispose();
    });
});

describe('review round 35 regressions — parse amplification and attribute floods', () => {
    const purifier = createDOMPurify(window as never);

    it('refuses an HTML chapter whose open formatting elements the parser would rebuild at every block, before parsing it', () => {
        const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
        const text = `<p>${'<b c="i">'.repeat(1000)}</p>${'<p>x</p>'.repeat(2000)}`;
        const prepared = prepareChapter(text, 'html', 'OEBPS/x.html', purifier, document);
        expect(prepared.tooLarge).toBe(true);
        expect(parse).not.toHaveBeenCalled();
        parse.mockRestore();
        // A properly closed wrapper is charged at most once per element it wraps
        // (the price of a bound that is sound by construction, see round 37).
        expect(estimateHtmlElements(`<div><i>${'<span>x</span>'.repeat(5000)}</i></div>`, 1e9)).toBeLessThan(12_000);
    });

    it('refuses a chapter with an attribute flood on one element before sanitizing it', () => {
        const attributes = Array.from({ length: 300 }, (_, i) => ` x${i}=""`).join('');
        const sanitize = vi.fn((html: string) => html);
        const prepared = prepareChapter(`<html><body><p${attributes}>x</p></body></html>`, 'html', 'OEBPS/x.html', { sanitize }, document);
        expect(prepared.tooLarge).toBe(true);
        expect(sanitize).not.toHaveBeenCalled();
    });

    it('drops DTD entities that expand to markup before the XML parse', () => {
        const text = `<?xml version="1.0"?><!DOCTYPE html [<!ENTITY e "${'<b/>'.repeat(1000)}"><!ENTITY name "fine">]>`
            + `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>${'&e;'.repeat(200)}</p><p>&name;</p></body></html>`;
        expect(dropMarkupEntities(text)).not.toContain('<b/>');
        expect(dropMarkupEntities(text)).toContain('<!ENTITY name "fine">');
        const prepared = prepareChapter(text, 'xhtml', 'OEBPS/x.xhtml', purifier, document);
        const holder = document.createElement('div');
        for (const node of prepared.nodes) holder.append(document.importNode(node, true));
        expect(holder.querySelectorAll('b')).toHaveLength(0);
    });
});

describe('review round 36 regressions', () => {
    const purifier = createDOMPurify(window as never);
    const tooLarge = (text: string, kind: 'html' | 'xhtml' = 'html'): boolean => prepareChapter(text, kind, 'OEBPS/x.html', purifier, document).tooLarge;

    it('estimates formatting reconstruction conservatively for every bypass pattern', () => {
        const head = `<p>${'<b c="i">'.repeat(1000)}</p>`;
        for (const tail of ['</i>'.repeat(1000) + '<p>x</p>'.repeat(200), '<p>x</p>'.repeat(200), '<main>x</main>'.repeat(200), '<table>' + 'x<col>'.repeat(200)]) {
            expect(estimateHtmlElements(head + tail, 1e12)).toBeGreaterThan(100_000);
        }
        expect(estimateHtmlElements(`<p>${'<b c=1/>'.repeat(1000)}</p>${'<p>x</p>'.repeat(200)}`, 1e12)).toBeGreaterThan(100_000);
        expect(estimateHtmlElements(`<p>${'<b c="/>">'.repeat(1000)}</p>${'<p>x</p>'.repeat(200)}`, 1e12)).toBeGreaterThan(100_000);
        // Nothing left open: close to the tag count (text inside formatting is charged once).
        expect(estimateHtmlElements('<p><b>x</b> y</p>'.repeat(5000), 1e12)).toBeLessThan(25_000);
    });

    it('refuses MathML nested deeper than the layout-safe depth', () => {
        const deep = `<math xmlns="http://www.w3.org/1998/Math/MathML">${'<mrow>'.repeat(40)}<mi>x</mi>${'</mrow>'.repeat(40)}</math>`;
        expect(tooLarge(`<html><body><p>${deep}</p></body></html>`)).toBe(true);
        const shallow = `<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mfrac><mi>a</mi><mi>b</mi></mfrac></mrow></math>`;
        expect(tooLarge(`<html><body><p>${shallow}</p></body></html>`)).toBe(false);
    });

    it('moves a wide MathML element instead of cloning it', () => {
        const wide = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p><math xmlns="http://www.w3.org/1998/Math/MathML">${'<mi>x</mi>'.repeat(20_000)}</math></p></body></html>`;
        const started = performance.now();
        const prepared = prepareChapter(wide, 'xhtml', 'OEBPS/x.xhtml', purifier, document);
        expect(performance.now() - started).toBeLessThan(5000);
        expect(prepared.tooLarge).toBe(false);
    });

    it('drops entity values with character references, survives an early ], and finds a late DOCTYPE', () => {
        const late = `<?xml version="1.0"?><!--${' '.repeat(5000)}--><!DOCTYPE html [<!ENTITY z "]"><!ENTITY e "&#60;b/>"><!ENTITY ok "fine">]><html/>`;
        const cleaned = dropMarkupEntities(late);
        expect(cleaned).not.toContain('&#60;b/>');
        expect(cleaned).toContain('<!ENTITY ok "fine">');
    });

    it('drops <template> content before counting and sanitizing', () => {
        const prepared = prepareChapter('<html><body><template><p>hidden</p></template><p>shown</p></body></html>', 'html', 'OEBPS/x.html', purifier, document);
        const holder = document.createElement('div');
        for (const node of prepared.nodes) holder.append(document.adoptNode(node));
        expect(holder.querySelector('template')).toBeNull();
        expect(holder.textContent).toBe('shown');
    });
});

describe('review round 37 regressions — the HTML estimate is an upper bound', () => {
    const parsedElements = (html: string): number => new DOMParser().parseFromString(html, 'text/html').getElementsByTagName('*').length;

    it('never estimates below what a spec HTML parser builds (seeded differential fuzz)', () => {
        let seed = 20261010;
        const random = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        const tags = ['p', 'div', 'b', 'i', 'em', 'a', 'nobr', 'table', 'tr', 'td', 'th', 'col', 'colgroup', 'caption', 'tbody', 'option',
            'optgroup', 'select', 'li', 'ul', 'dd', 'dl', 'dt', 'span', 'main', 'details', 'font', 'h1', 'form', 'button', 'pre', 'hr',
            'br', 'img', 'sub', 'code', 'strong', 'u', 's', 'tt', 'small', 'big', 'center', 'blockquote', 'fieldset', 'label', 'q',
            'applet', 'object', 'marquee', 'template', 'script', 'style', 'title', 'textarea', 'xmp', 'noscript', 'svg', 'math', 'plaintext'];
        for (let doc = 0; doc < 400; doc++) {
            let html = '';
            const length = 20 + Math.floor(random() * 200);
            for (let k = 0; k < length; k++) {
                const roll = random();
                const tag = tags[Math.floor(random() * tags.length)];
                html += roll < 0.4 ? `<${tag} c=${k}>` : roll < 0.75 ? `</${tag}>` : roll < 0.8 ? `<!--</${tag}>-->`
                    : roll < 0.83 ? `<span title="</${tag}>">` : roll < 0.86 ? `<?</${tag}>` : roll < 0.88 ? `<![CDATA[</${tag}>]]>`
                    : ['x', ' ', '\n', '\u00a0'][Math.floor(random() * 4)];
            }
            expect(estimateHtmlElements(html, 1e12), html).toBeGreaterThanOrEqual(parsedElements(html));
        }
    }, 60_000);

    it('keeps formatting counted when its end tag is hidden by a cell marker (round 38)', () => {
        const n = 40;
        const html = `<div>${Array.from({ length: n }, (_, j) => `<b c=${j}>`).join('')}<table><tr><td>${'</b>'.repeat(n)}</td></tr></table></div>${'<p>x</p>'.repeat(80)}`;
        const actual = parsedElements(html);
        expect(actual).toBeGreaterThan(3000);
        expect(estimateHtmlElements(html, 1e12)).toBeGreaterThanOrEqual(actual);
    });

    it('charges whitespace-only text and scope-ignored end tags (round 39)', () => {
        const wrap = (n: number): string => `<div>${Array.from({ length: n }, (_, j) => `<b c=${j}>`).join('')}`;
        const cases = [
            `${wrap(60)}</div>${'<div> </div>'.repeat(60)}`,
            `${wrap(60)}</div>${'<div>\u00a0</div>'.repeat(60)}`,
            `${wrap(60)}<table>${'</b>'.repeat(60)}</table></div>${'<p>x</p>'.repeat(60)}`,
            `${wrap(60)}<math><mi>${'</b>'.repeat(60)}</mi></math></div>${'<p>x</p>'.repeat(60)}`,
            `${wrap(60)}<svg><desc>${'</b>'.repeat(60)}</desc></svg></div>${'<p>x</p>'.repeat(60)}`,
            `${wrap(60)}<select>${'</b>'.repeat(60)}</select></div>${'<p>x</p>'.repeat(60)}`
        ];
        for (const html of cases) {
            const actual = parsedElements(html);
            expect(actual).toBeGreaterThan(3000);
            expect(estimateHtmlElements(html, 1e12), html.slice(0, 80)).toBeGreaterThanOrEqual(actual);
        }
    }, 60_000);

    it('ignores end tags hidden in comments, bogus comments, attribute values and raw text (round 40)', () => {
        const opens = Array.from({ length: 60 }, (_, j) => `<b c=${j}>`).join('');
        const closes = '</b>'.repeat(60);
        const tail = '<p>x</p>'.repeat(60);
        // A bogus comment ends at its first `>`, so it hides `</b` runs without one.
        for (const hidden of [`<!--${closes}-->`, `<?${'</b '.repeat(60)}>`, `<span title="${closes}">`, `<script>${closes}</script>`, `<textarea>${closes}</textarea>`]) {
            const html = `<div>${opens}${hidden}</div>${tail}`;
            const actual = parsedElements(html);
            expect(actual).toBeGreaterThan(3000);
            expect(estimateHtmlElements(html, 1e12), hidden.slice(0, 20)).toBeGreaterThanOrEqual(actual);
        }
        // End-of-input reconstruction is charged too.
        for (const html of ['<code><strong></code>x', '<a><em><em><a>']) expect(estimateHtmlElements(html, 1e12)).toBeGreaterThanOrEqual(parsedElements(html));
    }, 60_000);

    it('bounds the round-37 bypasses: reconstructed batches, nested tables, and option/dd soup', () => {
        const cases = [
            '<p>' + Array.from({ length: 80 }, (_, j) => `<i c=${j}>`).join('') + Array.from({ length: 80 }, (_, j) => `<b c=${j}>`).join('') + '</p>' + 'x</i>'.repeat(80) + 'x',
            Array.from({ length: 200 }, (_, j) => `<table><i c=${j}>`).join(''),
            Array.from({ length: 150 }, (_, j) => `<em c=${j}><option><dd>`).join('')
        ];
        for (const html of cases) {
            const actual = parsedElements(html);
            expect(actual).toBeGreaterThan(5000); // each really amplifies
            expect(estimateHtmlElements(html, 1e12)).toBeGreaterThanOrEqual(actual);
        }
    }, 60_000);
});

describe('review round 42 regressions', () => {
    const parsedElements = (html: string): number => new DOMParser().parseFromString(html, 'text/html').getElementsByTagName('*').length;
    const B = (n: number): string => Array.from({ length: n }, (_, j) => `<b c=${j}>`).join('');

    it('keeps the estimate above the parser for --!> comments, `=` name starts, escaped scripts and odd tag names', () => {
        const cases = [
            `<!----!><div>${B(60)}</div>${'<p>x</p>'.repeat(60)}`,
            `<i ="><div>${B(60)}</div>${'<p>x</p>'.repeat(60)}`,
            `<i c=="><div>${B(60)}</div>${'<p>x</p>'.repeat(60)}`,
            `<div>${B(60)}<script><!--<script></script>${'</b>'.repeat(60)}</script></div>${'<p>x</p>'.repeat(60)}`,
            `<div>${B(60)}</div>${'<div><div.></div>'.repeat(60)}`
        ];
        for (const html of cases) {
            const actual = parsedElements(html);
            expect(actual, html.slice(0, 40)).toBeGreaterThan(1000);
            expect(estimateHtmlElements(html, 1e12), html.slice(0, 40)).toBeGreaterThanOrEqual(actual);
        }
    }, 60_000);

    it('sanitizes an XHTML chapter in place, so nesting legal in XML is not multiplied by an HTML re-parse', () => {
        const n = 40;
        const m = 200;
        const xhtml = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>${Array.from({ length: n }, (_, j) => `<b class="c${j}">`).join('')}${'<p>x</p>'.repeat(m)}${'</b>'.repeat(n)}</p></body></html>`;
        const prepared = prepareChapter(xhtml, 'xhtml', 'OEBPS/x.xhtml', createDOMPurify(window as never), document);
        const page = document.createElement('div');
        page.replaceChildren(document.adoptNode(prepared.fragment));
        // XML tree: 1 p + n b + m p (+ wrapper); an HTML round trip would build ~n × m.
        expect(page.getElementsByTagName('*').length).toBeLessThan(n + m + 10);
    });
});

describe('review round 43 regressions', () => {
    const parsedElements = (html: string): number => new DOMParser().parseFromString(html, 'text/html').getElementsByTagName('*').length;
    const payload = (k: number, m: number): string => `<p>${Array.from({ length: k }, (_, j) => `<b a${j}>`).join('')}${'<p>x'.repeat(m)}`;

    it('stays above the parser when raw text, CDATA, noscript or foreign content make a token ambiguous', () => {
        const P = payload(60, 60);
        const cases = [
            `<svg><style><![CDATA[</style><!--]]>${P}-->`,
            `<style><x a="</style>${P}">`,
            `<noscript><? </noscript a=">${P}">`,
            `<noscript><!-- </noscript a="-->${P}">`,
            `<svg><title><!x </title a=">${P}">`,
            `<![CDATA[<x a='>${P}`,
            `<p>${Array.from({ length: 60 }, (_, j) => `<b a${j}>`).join('')}<svg><style><!--</style>${'</b>'.repeat(60)}--></style></svg>${'<p>x'.repeat(60)}`
        ];
        for (const html of cases) {
            const actual = parsedElements(html);
            expect(actual, html.slice(0, 30)).toBeGreaterThan(1000);
            expect(estimateHtmlElements(html, 1e12), html.slice(0, 30)).toBeGreaterThanOrEqual(actual);
        }
    }, 60_000);

    it('treats raw-text tags inside a template column group or frameset as ambiguous (round 44)', () => {
        const tail = `<p>${Array.from({ length: 40 }, (_, j) => `<b c=${j}>`).join('')}${'<p>x'.repeat(40)}`;
        for (const head of ['<template><col><textarea></template>', '<template><col><style></template>', '<template><col><plaintext></template>']) {
            const html = head + tail;
            const actual = parsedElements(html);
            expect(actual, head).toBeGreaterThan(1000);
            expect(estimateHtmlElements(html, 1e12), head).toBeGreaterThanOrEqual(actual);
        }
        const frameset = '<frameset><textarea><frame>';
        expect(estimateHtmlElements(frameset, 1e12)).toBeGreaterThanOrEqual(parsedElements(frameset));
    });

    it('rebuilds is= elements whose other attributes have colons but no namespace (round 44)', () => {
        for (const html of ['<html><body><section is="x" epub:type="chapter" xml:lang="en"><p>Hello</p></section></body></html>',
            '<html><body><div is="x" xmlns:epub="http://www.idpf.org/2007/ops"><p>Hi</p></div></body></html>']) {
            const prepared = prepareChapter(html, 'html', 'OEBPS/x.html', createDOMPurify(window as never), document);
            const page = document.createElement('div');
            page.replaceChildren(document.adoptNode(prepared.fragment));
            expect(page.querySelector('[is]')).toBeNull();
            expect(page.textContent).toMatch(/Hello|Hi/);
        }
    });

    it('scans pessimistic tag names in linear time (round 45)', () => {
        const html = `<html><body><svg></svg>${'<a'.repeat(4000)}${'x'.repeat(2_000_000)}`;
        const started = performance.now();
        estimateHtmlElements(html, EPUB_MAX_CHAPTER_ELEMENTS);
        expect(performance.now() - started).toBeLessThan(1000);
    });

    it('does not refuse ordinary chapters with inline math or svg (round 45)', () => {
        const paragraphs = '<p>A <i>term</i> and <em>stress</em> here.</p>'.repeat(600);
        for (const inline of ['<math><mi>x</mi></math>', '<svg width="1"></svg>']) {
            const html = `<html><body><h1>Chapter&nbsp;3</h1><p>Let ${inline} be given.</p>${paragraphs}</body></html>`;
            const actual = parsedElements(html);
            const estimate = estimateHtmlElements(html, 1e12);
            expect(estimate).toBeGreaterThanOrEqual(actual);
            expect(estimate, inline).toBeLessThan(actual * 10);
        }
    });

    it('bounds reconstruction by the Noah\'s Ark clause without undercounting (round 45)', () => {
        for (const html of [`<p>${'<b>'.repeat(60)}${'<p>x'.repeat(60)}`, `<svg></svg><p>${'<b><i>'.repeat(60)}${'<p>x'.repeat(60)}`,
            `<p>${'<b>'.repeat(30)}${'<b class=a>'.repeat(30)}${'<p>x'.repeat(60)}`]) {
            expect(estimateHtmlElements(html, 1e12), html.slice(0, 20)).toBeGreaterThanOrEqual(parsedElements(html));
        }
    });

    it('refuses chapters whose open-element stack makes the parse quadratic (round 46)', () => {
        const deep = [
            `${'<span>'.repeat(20000)}${'</x>'.repeat(80000)}`,
            `${'<i>'.repeat(60000)}${'</x>'.repeat(600000)}`,
            Array.from({ length: 40000 }, (_, i) => `<b c=${i}>`).join(''),
            `<html><body>${'<div>'.repeat(60000)}x${'</div>'.repeat(60000)}`,
            // End tags the parser ignores must not shrink the bound.
            `${'<span><div></span>'.repeat(20000)}${'</x>'.repeat(60000)}`,
            `<table><td>${'<span>'.repeat(20000)}${'</x>'.repeat(80000)}`,
            // Formatting clones the Noah's Ark clause drops from the list stay open (round 49).
            `${'<div><b></div>x'.repeat(1000)}${'</x>'.repeat(500000)}`,
            `${'<p><b></p>x'.repeat(1000)}${'</x>'.repeat(500000)}`,
            // The parser closes a colgroup or a head noscript on the next tag (round 48).
            `<table><colgroup>${'<span>'.repeat(9000)}</colgroup>${'</x>'.repeat(100000)}`,
            `<noscript>${'<span>'.repeat(9000)}</noscript>${'</x>'.repeat(100000)}`,
            // A tag that closes a <p> the bound could not see close (round 47).
            `${'<p><form><span><optgroup><div>'.repeat(20000)}${'</x>'.repeat(60000)}`,
            `${'<annotation-xml><address></annotation-xml>'.repeat(20000)}${'</x>'.repeat(60000)}`,
            // `</h1>` closes the nearest heading of any level (round 47).
            `${'<h1><span><h2></h1>'.repeat(30000)}${'</div>'.repeat(200000)}`,
            // Pessimistically, an end tag inside a comment, a quoted value or raw text is text.
            `<svg></svg>${'<b><!--</b>-->'.repeat(20000)}${'</x>'.repeat(60000)}`,
            `<svg></svg>${'<b title="</b>">'.repeat(20000)}${'</x>'.repeat(60000)}`,
            `<svg></svg>${'<span>'.repeat(10000)}<textarea>${'</span>'.repeat(10000)}</textarea>${'</x>'.repeat(60000)}`
        ];
        for (const html of deep) {
            const started = performance.now();
            expect(estimateHtmlElements(html, EPUB_MAX_CHAPTER_ELEMENTS), html.slice(0, 30)).toBeGreaterThan(EPUB_MAX_CHAPTER_ELEMENTS);
            expect(performance.now() - started).toBeLessThan(1000);
        }
        const prepared = prepareChapter(deep[0]!, 'html', 'OEBPS/x.html', createDOMPurify(window as never), document);
        expect(prepared.tooLarge).toBe(true);
    });

    it('keeps ordinary flat chapters well inside the parse-work budget (round 46)', () => {
        for (const html of [
            `<table>${'<tr><td>x</td><td>y'.repeat(10000)}</table>`,
            `<ul>${'<li>x<p>y'.repeat(30000)}</ul>`,
            `<dl>${'<dt>a<dd>b'.repeat(20000)}</dl>`,
            '<p>a <i>b</i>'.repeat(30000),
            `<p><i>a</p>${'<p>b <b>c</b> <em>d</em></p>'.repeat(10000)}`,
            `${'<div>'.repeat(200)}${'<p>x</p>'.repeat(20000)}${'</div>'.repeat(200)}`,
            `<p>Let <math><mi>x</mi></math>.</p>${'<p>A <i>t</i> <em>s</em>.</p>'.repeat(20000)}`,
            `<script><!-- var a = 1; --></script>${'<p>A <i>t</i></p>'.repeat(20000)}`,
            // Unclosed formatting across paragraphs: the parser's stack stays shallow (round 49).
            '<p><i>a</p><p>b</p>'.repeat(5000),
            '<div><p><b>x</div><p>y</p>'.repeat(5000),
            '<p><a href=x>a</p>'.repeat(2000)
        ]) {
            expect(estimateHtmlElements(html, EPUB_MAX_CHAPTER_ELEMENTS), html.slice(0, 30)).toBeLessThanOrEqual(EPUB_MAX_CHAPTER_ELEMENTS);
        }
    });

    it('treats raw-text tags after <select> as ambiguous (the tree builder ignores them there)', () => {
        const html = '<select k=13 /x=1><plaintext k=24 u=a"b><select k=41 u=a"b><math k=44 c=1><noscript k=160 /x=1>';
        expect(estimateHtmlElements(html, 1e12)).toBeGreaterThanOrEqual(parsedElements(html));
    });

    it('rebuilds elements parsed with is="…" so they cannot upgrade into host customized built-ins', () => {
        const prepared = prepareChapter('<html><body><div is="host-widget" data-x="1">book text</div><p is="host-p">p</p></body></html>', 'html', 'OEBPS/x.html', createDOMPurify(window as never), document);
        const page = document.createElement('div');
        page.replaceChildren(document.adoptNode(prepared.fragment));
        expect(page.querySelector('[is]')).toBeNull();
        expect(page.querySelector('div[data-x="1"]')?.textContent).toBe('book text');
        // A freshly created element has no "is value": its outerHTML never reports one.
        expect(page.querySelector('div[data-x="1"]')!.outerHTML).not.toContain('is=');
    });
});

describe('createEpubController', () => {
    const spine = [{ linear: false }, { linear: true }, { linear: false }, { linear: true }, { linear: true }];

    it('walks linear documents and reports progress among them', () => {
        const controller = createEpubController(spine);
        expect(controller.state.index).toBe(1);
        expect(controller.progress()).toEqual({ position: 1, total: 3 });
        expect(controller.dispatch({ type: 'previous' })).toBe(false);
        controller.dispatch({ type: 'next' });
        expect(controller.state.index).toBe(3);
        controller.dispatch({ type: 'go', index: 2, fragment: 'n1' });
        expect(controller.state).toMatchObject({ index: 2, fragment: 'n1' });
        expect(controller.progress()).toEqual({ position: 1, total: 3 });
        controller.dispatch({ type: 'next' });
        expect(controller.state).toMatchObject({ index: 3, fragment: '' });
        controller.dispatch({ type: 'next' });
        expect(controller.dispatch({ type: 'next' })).toBe(false);
    });

    it('clamps text scale and toggles panels', () => {
        const controller = createEpubController(spine, { fontScale: 500 });
        expect(controller.state.fontScale).toBe(200);
        controller.dispatch({ type: 'font', delta: -1000 });
        expect(controller.state.fontScale).toBe(70);
        controller.dispatch({ type: 'toggle-panel', panel: 'toc' });
        expect(controller.state.panel).toBe('none');
        controller.dispatch({ type: 'toggle-panel', panel: 'info' });
        expect(controller.state.panel).toBe('info');
    });

    it('reads an all-non-linear spine in order', () => {
        const controller = createEpubController([{ linear: false }, { linear: false }]);
        expect(controller.state.index).toBe(0);
        controller.dispatch({ type: 'next' });
        expect(controller.state.index).toBe(1);
    });
});
