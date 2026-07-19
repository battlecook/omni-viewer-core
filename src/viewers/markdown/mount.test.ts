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
        source.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(saveFile).toHaveBeenCalledWith('readme.md', new TextEncoder().encode('# Changed'), 'text/markdown');
        expect(root.querySelector('.omni-markdown__status')?.textContent).toBe('Saved');
    });

    it('reports the missing-writeback message when neither save service exists', async () => {
        const container = document.createElement('div');
        await mountMarkdownViewer({ fileName: 'readme.md', data: new TextEncoder().encode('# Hello') }, container, readonlyCtx(), deps);
        const root = container.shadowRoot!; const source = root.querySelector('textarea')!;
        source.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
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
