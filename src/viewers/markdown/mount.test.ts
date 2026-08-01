// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { CATALOG_EN } from '../../i18n/catalog.en.js';
import { mountMarkdownViewer, type MarkdownViewerContext, type MarkdownViewerDeps } from './index.js';

const deps: MarkdownViewerDeps = {
    render: { parse: source => `<h1>${source.replace(/^#\s*/, '')}</h1><pre><code class="language-js">const n = 1;</code></pre>` },
    createDOMPurify: () => ({ sanitize: html => html }),
    highlighter: {
        getLanguage: () => true,
        highlight: source => ({ value: `<span class="hljs-keyword">${source}</span>`, language: 'js' }),
        highlightAuto: source => ({ value: source })
    }
};

function ctx(write = vi.fn(async () => undefined), copy = vi.fn(async () => undefined)): MarkdownViewerContext {
    return {
        assets: { resolveAssetUrl: async path => path }, logger: { log: vi.fn() },
        i18n: { t: (key, args) => (CATALOG_EN[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(args?.[name] ?? '')) },
        writeback: { write }, clipboard: { writeText: copy }
    };
}

function readonlyCtx(): MarkdownViewerContext {
    const { writeback: _writeback, ...context } = ctx();
    return context;
}

function button(root: ShadowRoot, label: string): HTMLButtonElement {
    const found = [...root.querySelectorAll('button')].find(node => node.textContent === label);
    if (!found) throw new Error(`button not found: ${label}`);
    return found;
}

// Emits one element per blank-line-separated block, so the rendered document
// lines up with what the source scanner sees.
const blockDeps: MarkdownViewerDeps = {
    render: {
        parse: source => source.split(/\n{2,}/).filter(Boolean)
            .map(block => (block.startsWith('# ') ? `<h1>${block.slice(2)}</h1>` : `<p>${block}</p>`)).join('')
    },
    createDOMPurify: () => ({ sanitize: html => html })
};
const BLOCKS = '# Title\n\nalpha\n\nbravo\n\ncharlie\n';

/** jsdom has no layout: give a node the extents the sync arithmetic reads. */
function scrollable(node: HTMLElement, scrollHeight: number, clientHeight: number): void {
    Object.defineProperty(node, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(node, 'clientHeight', { value: clientHeight, configurable: true });
}

async function splitView(scrollSync?: boolean): Promise<{ root: ShadowRoot; source: HTMLTextAreaElement; preview: HTMLElement }> {
    const container = document.createElement('div');
    await mountMarkdownViewer(
        { fileName: 'readme.md', data: new TextEncoder().encode(BLOCKS) },
        container, ctx(), blockDeps, scrollSync === undefined ? {} : { scrollSync }
    );
    const root = container.shadowRoot!;
    button(root, 'Split').click();
    const source = root.querySelector('textarea') as HTMLTextAreaElement;
    const preview = root.querySelector('.omni-markdown__preview') as HTMLElement;
    scrollable(source, 400, 200);
    scrollable(preview, 600, 200);
    return { root, source, preview };
}

describe('markdown preview scroll sync', () => {
    it('anchors each rendered block to the source line it came from', async () => {
        const container = document.createElement('div');
        await mountMarkdownViewer({ fileName: 'readme.md', data: new TextEncoder().encode(BLOCKS) }, container, ctx(), blockDeps);
        const anchored = [...container.shadowRoot!.querySelectorAll('[data-source-line]')]
            .map(node => `${node.tagName}:${node.getAttribute('data-source-line')}`);
        expect(anchored).toEqual(['H1:1', 'P:3', 'P:5', 'P:7']);
    });

    it('moves the preview when the source scrolls', async () => {
        const { source, preview } = await splitView();
        source.scrollTop = 400;
        source.dispatchEvent(new Event('scroll'));
        expect(preview.scrollTop).toBeGreaterThan(0);
    });

    it('swallows the echo of its own scroll instead of chasing it back', async () => {
        const { source, preview } = await splitView();
        source.scrollTop = 400;
        source.dispatchEvent(new Event('scroll'));
        // The write above is what a browser would report back on the preview;
        // acting on it would drag the source away from where the user put it.
        preview.dispatchEvent(new Event('scroll'));
        expect(source.scrollTop).toBe(400);
        // A genuine preview scroll after the echo still drives the source.
        preview.dispatchEvent(new Event('scroll'));
        expect(source.scrollTop).not.toBe(400);
    });

    it('carries the preview all the way down when the source hits its end', async () => {
        const { source, preview } = await splitView();
        // A short scrollport puts several anchors past the source's last
        // scrollable pixel — the case where clamping used to strand the
        // document's final screen out of reach.
        Object.defineProperty(source, 'scrollHeight', { value: 250, configurable: true });
        source.scrollTop = 50;
        source.dispatchEvent(new Event('scroll'));
        expect(preview.scrollTop).toBe(400); // preview 600 - 200 = its own end
    });

    it('stays put when the host opts out of scroll sync', async () => {
        const { source, preview } = await splitView(false);
        source.scrollTop = 400;
        source.dispatchEvent(new Event('scroll'));
        expect(preview.scrollTop).toBe(0);
    });

    it('does not sync outside split view, where there is no second pane', async () => {
        const { root, source, preview } = await splitView();
        button(root, 'Preview').click();
        source.scrollTop = 400;
        source.dispatchEvent(new Event('scroll'));
        expect(preview.scrollTop).toBe(0);
    });
});

describe('markdown outline', () => {
    const headingDeps: MarkdownViewerDeps = {
        render: {
            parse: source => source.split(/\n{2,}/).filter(Boolean).map(block => {
                const level = /^(#{1,6})\s/.exec(block)?.[1]?.length;
                return level ? `<h${level}>${block.replace(/^#+\s*/, '')}</h${level}>` : `<p>${block}</p>`;
            }).join('')
        },
        createDOMPurify: () => ({ sanitize: html => html })
    };
    const DOC = '# Top\n\nlead\n\n## First\n\nbody\n\n### Nested\n\nmore\n\n## Second\n\ntail\n';

    async function outline(): Promise<ShadowRoot> {
        const container = document.createElement('div');
        await mountMarkdownViewer({ fileName: 'readme.md', data: new TextEncoder().encode(DOC) }, container, ctx(), headingDeps);
        return container.shadowRoot!;
    }
    const entries = (root: ShadowRoot): string[] =>
        [...root.querySelectorAll('.omni-markdown__toc-link')].map(node => `${(node as HTMLElement).dataset.level}:${node.textContent}`);

    it('lists every rendered heading with its level', async () => {
        expect(entries(await outline())).toEqual(['1:Top', '2:First', '3:Nested', '2:Second']);
    });

    it('is built from the rendered headings, not the source line scan', async () => {
        const container = document.createElement('div');
        // The parser's line index counts this `#` and misses the setext heading;
        // the outline follows what was actually rendered instead.
        const source = '```\n# not a heading\n```\n\n# Real\n';
        await mountMarkdownViewer({ fileName: 'readme.md', data: new TextEncoder().encode(source) }, container, ctx(), headingDeps);
        expect(entries(container.shadowRoot!)).toEqual(['1:Real']);
    });

    it('scrolls the preview to a heading and marks it current', async () => {
        const root = await outline();
        const preview = root.querySelector('.omni-markdown__preview') as HTMLElement;
        // jsdom has no layout, so place the heading explicitly for the arithmetic.
        preview.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
        const heading = [...root.querySelectorAll('h3')].find(node => node.textContent === 'Nested')!;
        heading.getBoundingClientRect = () => ({ top: 400 }) as DOMRect;

        const target = [...root.querySelectorAll('.omni-markdown__toc-link')]
            .find(node => node.textContent === 'Nested') as HTMLElement;
        target.click();
        expect(preview.scrollTop).toBe(388);
        expect(target.classList.contains('is-active')).toBe(true);
        expect(root.querySelectorAll('.omni-markdown__toc-link.is-active')).toHaveLength(1);
    });

    it('labels a heading containing rendered math only once', async () => {
        const container = document.createElement('div');
        // Mimics KaTeX's htmlAndMathml output: a MathML twin plus an
        // aria-hidden visual copy of the same formula.
        const mathDeps: MarkdownViewerDeps = {
            ...headingDeps,
            render: {
                parse: () => '<h1>Energy <span class="katex">'
                    + '<span class="katex-mathml">E=mc^2</span>'
                    + '<span class="katex-html" aria-hidden="true">E=mc^2</span></span></h1>'
            }
        };
        await mountMarkdownViewer({ fileName: 'math.md', data: new TextEncoder().encode('# x\n') }, container, ctx(), mathDeps);
        expect(entries(container.shadowRoot!)).toEqual(['1:Energy E=mc^2']);
    });

    it('marks the closing section current once the preview bottoms out', async () => {
        const root = await outline();
        const preview = root.querySelector('.omni-markdown__preview') as HTMLElement;
        preview.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
        // Place the last heading inside the final screenful, where it can never
        // scroll up to the viewport's top edge.
        const tops = new Map([['Top', 0], ['First', 100], ['Nested', 200], ['Second', 900]]);
        for (const heading of root.querySelectorAll('h1,h2,h3')) {
            const contentTop = tops.get(heading.textContent ?? '')!;
            // A real rect is viewport-relative, so it rides the scroll position.
            (heading as HTMLElement).getBoundingClientRect = () => ({ top: contentTop - preview.scrollTop }) as DOMRect;
        }
        Object.defineProperty(preview, 'scrollHeight', { value: 1300, configurable: true });
        Object.defineProperty(preview, 'clientHeight', { value: 700, configurable: true });
        // Mode changes drop the cached offsets without re-rendering the headings.
        button(root, 'Split').click(); button(root, 'Preview').click();

        preview.scrollTop = 300;
        preview.dispatchEvent(new Event('scroll'));
        expect(root.querySelector('.omni-markdown__toc-link.is-active')?.textContent).toBe('Nested');

        preview.scrollTop = 600; // scrollHeight - clientHeight: the very bottom
        preview.dispatchEvent(new Event('scroll'));
        expect(root.querySelector('.omni-markdown__toc-link.is-active')?.textContent).toBe('Second');
    });

    it('reports the toggle state and the current entry to assistive tech', async () => {
        const root = await outline();
        expect(button(root, 'Outline').getAttribute('aria-pressed')).toBe('true');
        button(root, 'Outline').click();
        expect(button(root, 'Outline').getAttribute('aria-pressed')).toBe('false');

        const target = [...root.querySelectorAll('.omni-markdown__toc-link')]
            .find(node => node.textContent === 'Nested') as HTMLElement;
        target.click();
        expect(target.getAttribute('aria-current')).toBe('true');
        expect(root.querySelectorAll('[aria-current]')).toHaveLength(1);
    });

    it('reuses entries when a re-render leaves the headings alone', async () => {
        // The live preview fires every 250ms while typing. Rebuilding identical
        // entries would reset the outline's scroll and drop focus out of it.
        const root = await outline();
        const before = [...root.querySelectorAll('.omni-markdown__toc-link')];
        const source = root.querySelector('textarea')!;
        source.value = DOC.replace('lead', 'lead rewritten');
        source.dispatchEvent(new Event('input'));
        await new Promise(resolve => setTimeout(resolve, 320));
        const after = [...root.querySelectorAll('.omni-markdown__toc-link')];
        expect(after).toEqual(before);
        // Still wired to the freshly rendered headings, not the discarded ones.
        expect(root.querySelector('.omni-markdown__preview')?.textContent).toContain('lead rewritten');
    });

    it('rebuilds the outline when the source changes', async () => {
        const root = await outline();
        const source = root.querySelector('textarea')!;
        source.value = '# Only one\n'; source.dispatchEvent(new Event('input'));
        await new Promise(resolve => setTimeout(resolve, 320));
        expect(entries(root)).toEqual(['1:Only one']);
    });

    it('steps aside in split view, where width is already divided', async () => {
        const root = await outline();
        const toc = root.querySelector('.omni-markdown__toc') as HTMLElement;
        expect(toc.hidden).toBe(false);
        button(root, 'Split').click();
        expect(toc.hidden).toBe(true);
        button(root, 'Preview').click();
        expect(toc.hidden).toBe(false);
    });

    it('keeps the outline in split view once it has been asked for', async () => {
        const root = await outline();
        const toc = root.querySelector('.omni-markdown__toc') as HTMLElement;
        button(root, 'Split').click();
        button(root, 'Outline').click();
        expect(toc.hidden).toBe(false);
        // An explicit choice outlives the mode it was made in.
        button(root, 'Preview').click();
        expect(toc.hidden).toBe(false);
        button(root, 'Split').click();
        expect(toc.hidden).toBe(false);
    });

    it('hides the outline on toggle and when the document has no headings', async () => {
        const root = await outline();
        const toc = root.querySelector('.omni-markdown__toc') as HTMLElement;
        expect(toc.hidden).toBe(false);
        button(root, 'Outline').click();
        expect(toc.hidden).toBe(true);
        button(root, 'Outline').click();
        expect(toc.hidden).toBe(false);

        const plain = document.createElement('div');
        await mountMarkdownViewer({ fileName: 'plain.md', data: new TextEncoder().encode('just prose\n') }, plain, ctx(), headingDeps);
        expect((plain.shadowRoot!.querySelector('.omni-markdown__toc') as HTMLElement).hidden).toBe(true);
        expect(button(plain.shadowRoot!, 'Outline').disabled).toBe(true);
    });

    it('keeps responding to clicks after the live preview has rebuilt it', async () => {
        // Entries are replaced wholesale on every re-render, so the click
        // handling must not live on the entries themselves.
        const root = await outline();
        const source = root.querySelector('textarea')!;
        for (const text of ['# A\n', '# B\n', '# Final\n\n## Sub\n']) {
            source.value = text; source.dispatchEvent(new Event('input'));
            await new Promise(resolve => setTimeout(resolve, 320));
        }
        expect(entries(root)).toEqual(['1:Final', '2:Sub']);
        const target = [...root.querySelectorAll('.omni-markdown__toc-link')]
            .find(node => node.textContent === 'Sub') as HTMLElement;
        target.click();
        expect(target.classList.contains('is-active')).toBe(true);
    });
});

describe('mountMarkdownViewer', () => {
    it('offers preview, split, and editable source views', async () => {
        const container = document.createElement('div');
        const handle = await mountMarkdownViewer({ fileName: 'readme.md', data: new TextEncoder().encode('# Hello') }, container, ctx(), deps);
        const root = container.shadowRoot!;
        button(root, 'Split').click();
        expect(root.querySelector('.omni-markdown__workspace')?.classList.contains('is-split')).toBe(true);
        const source = root.querySelector('textarea')!;
        source.value = '# Changed'; source.dispatchEvent(new Event('input'));
        expect(button(root, 'Render').classList.contains('is-dirty')).toBe(true);
        handle.dispose();
        expect(root.querySelector('.omni-markdown')).toBeNull();
    });

    it('pins the highlight overlay to the textarea width the scrollbar leaves', async () => {
        const container = document.createElement('div');
        await mountMarkdownViewer({ fileName: 'readme.md', data: new TextEncoder().encode('# Hello') }, container, ctx(), deps);
        const root = container.shadowRoot!;
        const source = root.querySelector('textarea')!;
        const overlay = root.querySelector('.omni-markdown__source-highlight') as HTMLElement;
        // A scrollbar takes width from the textarea's content box but not from
        // the overlay's; left unmatched, the two wrap in different columns and
        // the caret no longer lands where the glyphs are.
        Object.defineProperty(source, 'clientWidth', { value: 385, configurable: true });
        source.dispatchEvent(new Event('input'));
        expect(overlay.style.width).toBe('385px');
    });

    it('highlights the source into a spans-only overlay as it is edited', async () => {
        const container = document.createElement('div');
        await mountMarkdownViewer({ fileName: 'readme.md', data: new TextEncoder().encode('# Hello') }, container, ctx(), deps);
        const root = container.shadowRoot!;
        const overlay = root.querySelector('.omni-markdown__source-highlight code') as HTMLElement;
        expect(overlay.querySelector('.hljs-keyword')?.textContent).toBe('# Hello');
        const source = root.querySelector('textarea')!;
        source.value = '# Changed'; source.dispatchEvent(new Event('input'));
        expect(overlay.querySelector('.hljs-keyword')?.textContent).toBe('# Changed');
    });

    it('re-renders the preview live while editing, without saving', async () => {
        const write = vi.fn(async () => undefined);
        const container = document.createElement('div');
        await mountMarkdownViewer({ fileName: 'readme.md', data: new TextEncoder().encode('# Hello') }, container, ctx(write), deps);
        const root = container.shadowRoot!; const source = root.querySelector('textarea')!;
        source.value = '# Live edit'; source.dispatchEvent(new Event('input'));
        await new Promise(resolve => setTimeout(resolve, 320));
        expect(root.querySelector('.omni-markdown__preview')?.textContent).toContain('Live edit');
        expect(write).not.toHaveBeenCalled();
    });

    it('renders, writes back, highlights code, and copies source', async () => {
        const write = vi.fn(async () => undefined); const copy = vi.fn(async () => undefined);
        const container = document.createElement('div');
        await mountMarkdownViewer({ fileName: 'readme.md', data: new TextEncoder().encode('# Hello') }, container, ctx(write, copy), deps);
        const root = container.shadowRoot!; const source = root.querySelector('textarea')!;
        source.value = '# Changed'; source.dispatchEvent(new Event('input')); button(root, 'Render').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(write).toHaveBeenCalledWith(new TextEncoder().encode('# Changed'));
        expect(root.querySelector('.hljs-keyword')).not.toBeNull();
        button(root, 'Copy Source').click(); await Promise.resolve();
        expect(copy).toHaveBeenCalledWith('# Changed');
    });

    it('renders successfully without attempting unavailable writeback', async () => {
        const container = document.createElement('div');
        await mountMarkdownViewer(
            { fileName: 'readme.md', data: new TextEncoder().encode('# Hello') },
            container, readonlyCtx(), deps
        );
        const root = container.shadowRoot!;
        const source = root.querySelector('textarea')!;
        source.value = '# Read only'; source.dispatchEvent(new Event('input'));
        button(root, 'Render').click();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(root.querySelector('.omni-markdown__status')?.textContent).toBe('Rendered');
        expect((root.querySelector('.omni-markdown__message') as HTMLElement).hidden).toBe(true);
        expect(root.querySelector('.omni-markdown__preview')?.textContent).toContain('Read only');
    });

    it('falls back to the save service download when writeback is unavailable', async () => {
        const saveFile = vi.fn(async () => undefined);
        const context: MarkdownViewerContext = { ...readonlyCtx(), save: { saveFile } };
        const container = document.createElement('div');
        await mountMarkdownViewer({ fileName: 'readme.md', data: new TextEncoder().encode('# Hello') }, container, context, deps);
        const root = container.shadowRoot!; const source = root.querySelector('textarea')!;
        source.value = '# Changed'; source.dispatchEvent(new Event('input'));
        source.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(saveFile).toHaveBeenCalledWith('readme.md', new TextEncoder().encode('# Changed'), 'text/markdown');
        expect(root.querySelector('.omni-markdown__status')?.textContent).toBe('Saved');
    });

    it('saves via Ctrl+S even when focus is outside the textarea', async () => {
        const saveFile = vi.fn(async () => undefined);
        const context: MarkdownViewerContext = { ...readonlyCtx(), save: { saveFile } };
        const container = document.createElement('div');
        await mountMarkdownViewer({ fileName: 'readme.md', data: new TextEncoder().encode('# Hello') }, container, context, deps);
        const root = container.shadowRoot!;
        const source = root.querySelector('textarea')!;
        source.value = '# Elsewhere'; source.dispatchEvent(new Event('input'));
        // Fire the shortcut from a non-editor element (the preview) — it must
        // still be caught by the viewer-wide save handler on the shell.
        root.querySelector('.omni-markdown__preview')!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(saveFile).toHaveBeenCalledWith('readme.md', new TextEncoder().encode('# Elsewhere'), 'text/markdown');
    });

    it('reports the missing-writeback message when neither save service exists', async () => {
        const container = document.createElement('div');
        await mountMarkdownViewer({ fileName: 'readme.md', data: new TextEncoder().encode('# Hello') }, container, readonlyCtx(), deps);
        const root = container.shadowRoot!; const source = root.querySelector('textarea')!;
        source.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(root.querySelector('.omni-markdown__status')?.textContent).toBe('Save failed');
        expect(root.querySelector('.omni-markdown__message')?.textContent).toContain('unavailable');
    });

    it('never sends content beyond parser limits to the Markdown renderer', async () => {
        const parse = vi.fn((source: string) => `<p>${source}</p>`);
        const limitedDeps: MarkdownViewerDeps = { ...deps, render: { parse } };
        const container = document.createElement('div');
        await mountMarkdownViewer(
            { fileName: 'large.md', data: new TextEncoder().encode('first\nsecond\nthird\n') },
            container, ctx(), limitedDeps, { markdownLimits: { maxBlocks: 2 } }
        );
        expect(parse).toHaveBeenLastCalledWith('first\nsecond\n');
        expect(container.shadowRoot!.querySelector('textarea')?.value).toBe('first\nsecond\nthird\n');

        const source = container.shadowRoot!.querySelector('textarea')!;
        source.value = 'one\ntwo\nthree\nfour\n';
        source.dispatchEvent(new Event('input'));
        button(container.shadowRoot!, 'Render').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(parse).toHaveBeenLastCalledWith('one\ntwo\n');
    });
});
