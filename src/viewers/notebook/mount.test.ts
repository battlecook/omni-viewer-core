// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import createDOMPurify from 'dompurify';
import { marked } from 'marked';
import { createCatalogI18n } from '../../i18n/index.js';
import { MountAbortedError, type ViewerHandle } from '../types.js';
import { mountNotebookViewer, type NotebookViewerContext, type NotebookViewerDeps } from './index.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP3sAAAAASUVORK5CYII=';
const context = (): NotebookViewerContext => ({ assets: { resolveAssetUrl: async path => path },
    logger: { log: vi.fn() }, i18n: createCatalogI18n('en') });
const deps = (): NotebookViewerDeps => ({ render: { parse: source => marked.parse(source, { async: false }) },
    createDOMPurify: window => createDOMPurify(window as never) });
const code = (source = 'print(1)', outputs: unknown[] = [], extra = {}) => ({
    cell_type: 'code', source, outputs, execution_count: 7, metadata: {}, ...extra
});
const markdown = (source: string, extra = {}) => ({ cell_type: 'markdown', source, metadata: {}, ...extra });
const data = (cells: unknown[]) => new TextEncoder().encode(JSON.stringify({
    nbformat: 4, nbformat_minor: 5, metadata: { language_info: { name: 'python' } }, cells
}));
const display = (bundle: Record<string, unknown>, extra = {}) => ({ output_type: 'display_data', data: bundle, metadata: {}, ...extra });
const handles: ViewerHandle[] = [];
const originalCreateUrl = Object.getOwnPropertyDescriptor(window.URL, 'createObjectURL');
const originalRevokeUrl = Object.getOwnPropertyDescriptor(window.URL, 'revokeObjectURL');
beforeEach(() => {
    // Exercise data-URL fallback deterministically; a separate test below
    // enables blob URLs and verifies shared allocation and disposal.
    Object.defineProperty(window.URL, 'createObjectURL', { configurable: true, value: undefined });
    Object.defineProperty(window.URL, 'revokeObjectURL', { configurable: true, value: undefined });
});
afterEach(() => {
    handles.splice(0).forEach(handle => handle.dispose()); document.body.replaceChildren(); vi.restoreAllMocks();
    if (originalCreateUrl) Object.defineProperty(window.URL, 'createObjectURL', originalCreateUrl); else Reflect.deleteProperty(window.URL, 'createObjectURL');
    if (originalRevokeUrl) Object.defineProperty(window.URL, 'revokeObjectURL', originalRevokeUrl); else Reflect.deleteProperty(window.URL, 'revokeObjectURL');
});
async function mount(cells: unknown[], options: Parameters<typeof mountNotebookViewer>[4] = {}, ctx = context(), dependencies = deps()) {
    const container = document.createElement('div'); document.body.append(container);
    const handle = await mountNotebookViewer({ fileName: 'analysis.ipynb', data: data(cells) }, container, ctx, dependencies, options);
    handles.push(handle);
    const root = container.shadowRoot ?? container;
    return { container, root, handle };
}

describe('mountNotebookViewer', () => {
    it('unwraps saved LaTeX delimiters while preserving escaped internal dollars', async () => {
        const dependencies = deps(); const render = vi.fn((_source: string) => '<span class="katex">Math</span>');
        dependencies.math = { renderToHtml: render };
        const expression = '\\text{Price: \\$5}';
        await mount([code('', [display({ 'text/latex': `$${expression}$` }), display({ 'text/latex': `$$${expression}$$` }),
            display({ 'text/latex': `\\[${expression}\\]` }), display({ 'text/latex': `\\(${expression}\\)` }),
            display({ 'text/latex': '$x\\$$' }), display({ 'text/latex': '$x\\$' }), display({ 'text/latex': '$$x\\$$' })])], {}, context(), dependencies);
        expect(render.mock.calls.map(call => call[0])).toEqual([expression, expression, expression, expression, 'x\\$', '$x\\$', '$$x\\$$']);
    });

    it('removes quote and list prefixes from display math and from its literal fallback', async () => {
        const dependencies = deps(); const render = vi.fn((source: string) => `<span class="katex">${source}</span>`);
        dependencies.math = { renderToHtml: render };
        const sources = ['> $$\n> x^2\n> $$', '> > $$\n> > x^2\n> > $$', '- $$\n  x^2\n  $$'];
        await mount(sources.map(source => markdown(source)), {}, context(), dependencies);
        expect(render.mock.calls.map(call => call[0])).toEqual(['x^2', 'x^2', 'x^2']);
        const fallback = await mount(sources.map(source => markdown(source)));
        expect([...fallback.root.querySelectorAll('.omni-markdown__math')].map(node => node.textContent)).toEqual(['$$x^2$$', '$$x^2$$', '$$x^2$$']);
    });

    it('keeps prose math from consuming dollars inside HTML code and attributes', async () => {
        const dependencies = deps(); const render = vi.fn((source: string) => `<span class="katex">${source}</span>`);
        dependencies.math = { renderToHtml: render };
        const { root } = await mount([markdown('Cost $5, code <code>x=$y$</code> and $z$'),
            markdown('Text $5 <span title="$label$"> hello </span> and $x$'), markdown('$x<y>z$'),
            markdown('Cost $5 <span hidden title="$label$">hello</span> and $x$'),
            markdown('Cost $$5 <span\nhidden title="$$label$$">hello</span> and $$x$$'),
            markdown('$x<y z$ after and $a<b c$ after')], {}, context(), dependencies);
        expect(root.querySelector('code')?.textContent).toBe('x=$y$');
        expect(root.querySelector('[title]')?.getAttribute('title')).toBe('$label$');
        expect(render.mock.calls.map(call => call[0])).toEqual(['z', 'x', 'x<y>z', 'x', 'x', 'x<y z', 'a<b c']);
        expect([...root.querySelectorAll('[title]')].map(node => node.getAttribute('title'))).toEqual(['$label$', '$label$', '$$label$$']);
        expect(root.textContent).not.toContain('%%omni-notebook-math-');
        const literal = '\\text{<code>}';
        await mount([markdown(`$${literal}$`)], {}, context(), dependencies);
        expect(render).toHaveBeenLastCalledWith(literal, false);
    });

    it('rejects backticks in backtick-fence info while preserving valid tilde fences', async () => {
        const dependencies = deps(); dependencies.math = { renderToHtml: source => `<span class="katex">${source}</span>` };
        const { root } = await mount([markdown('```info`invalid\nFormula $x_i$'),
            markdown('```info\\`invalid\nFormula $y_i$'), markdown('~~~info`valid\nFormula $z_i$\n~~~')], {}, context(), dependencies);
        expect([...root.querySelectorAll('.katex')].map(node => node.textContent)).toEqual(['x_i', 'y_i']);
        expect(root.querySelectorAll('pre code')).toHaveLength(1);
        expect(root.querySelector('pre code')?.textContent).toBe('Formula $z_i$\n');
    });

    it('preserves escaped dollar signs inside complete TeX expressions', async () => {
        const dependencies = deps(); const render = vi.fn((source: string) => `<span class="katex">${source}</span>`);
        dependencies.math = { renderToHtml: render };
        const expression = '\\text{cost: \\$} + x';
        const { root } = await mount([markdown(`$${expression}$`), code('', [display({ 'text/html': `<p>$${expression}$</p>` })])], {}, context(), dependencies);
        expect(render).toHaveBeenCalledTimes(2);
        expect(render).toHaveBeenNthCalledWith(1, expression, false);
        expect(render).toHaveBeenNthCalledWith(2, expression, false);
        expect([...root.querySelectorAll('.katex')].map(node => node.textContent)).toEqual([expression, expression]);
    });

    it('keeps escaped code delimiters literal and preserves unescaped delimiters after paired backslashes', async () => {
        const dependencies = deps(); dependencies.math = { renderToHtml: source => `<span class="katex">${source}</span>` };
        const { root } = await mount([markdown('\\` literal $x$ ` end'), markdown('\\<code>Formula $x$'),
            markdown('\\\\`literal $x$` and $y$')], {}, context(), dependencies);
        const cells = root.querySelectorAll('.omni-notebook__cell');
        expect(cells[0]?.querySelector('code')).toBeNull(); expect(cells[1]?.querySelector('code')).toBeNull();
        expect([...root.querySelectorAll('.katex')].map(node => node.textContent)).toEqual(['x', 'x', 'y']);
        expect(cells[1]?.textContent).toContain('<code>Formula x');
        expect(cells[2]?.querySelector('code')?.textContent).toBe('literal $x$');
    });

    it('keeps unmatched backticks from closing across paragraph boundaries', async () => {
        const dependencies = deps(); dependencies.math = { renderToHtml: source => `<span class="katex">${source}</span>` };
        const { root } = await mount([markdown('` unmatched $x$\n\n` literal $y$'),
            markdown('> ` unmatched $x$\n>\n> ` literal $y$'), markdown('`matched\n$x$` and $y$'),
            markdown('` unmatched $x$\n# ` literal $y$'), markdown('# ` unmatched $x$\n` literal $y$'),
            markdown('- ` unmatched $x$\n- ` literal $y$')], {}, context(), dependencies);
        const cells = root.querySelectorAll('.omni-notebook__cell');
        for (const cell of [...cells].slice(0, 2)) {
            expect(cell.querySelector('code')).toBeNull();
            expect([...cell.querySelectorAll('.katex')].map(node => node.textContent)).toEqual(['x', 'y']);
        }
        expect(cells[2]?.querySelector('code')?.textContent).toBe('matched $x$');
        expect([...cells[2]!.querySelectorAll('.katex')].map(node => node.textContent)).toEqual(['y']);
        for (const cell of [...cells].slice(3)) {
            expect(cell.querySelector('code')).toBeNull();
            expect([...cell.querySelectorAll('.katex')].map(node => node.textContent)).toEqual(['x', 'y']);
        }
    });

    it('uses complete equal-length backtick runs for inline code boundaries', async () => {
        const dependencies = deps(); dependencies.math = { renderToHtml: source => `<span class="katex">${source}</span>` };
        const { root } = await mount([markdown('``a``` $x$ b` end'), markdown('``a``` $x$ b`` end')], {}, context(), dependencies);
        const cells = root.querySelectorAll('.omni-notebook__cell');
        expect(cells[0]?.querySelector('code')).toBeNull();
        expect(cells[0]?.querySelector('.katex')?.textContent).toBe('x');
        expect(cells[1]?.querySelector('code')?.textContent).toBe('a``` $x$ b');
        expect(cells[1]?.querySelector('.katex')).toBeNull();
    });

    it('distinguishes tab-indented list paragraphs from tab-indented list code', async () => {
        const dependencies = deps(); dependencies.math = { renderToHtml: source => `<span class="katex">${source}</span>` };
        const sources = ['- text\n\n\t$x$', '- text\n\n \t$x$', '- text\n\n  \t$x$', '- text\n\n   \t$x$'];
        const { root } = await mount(sources.map(source => markdown(source)), {}, context(), dependencies);
        expect(root.querySelectorAll('.katex')).toHaveLength(2);
        expect([...root.querySelectorAll('pre code')].map(node => node.textContent)).toEqual(['$x$\n', ' $x$\n']);
    });

    it('renders math in indented paragraph and list continuation lines while preserving actual code blocks', async () => {
        const dependencies = deps(); dependencies.math = { renderToHtml: source => `<span class="katex">${source}</span>` };
        const { root } = await mount([markdown('Paragraph\n    Formula $x_i + y_i$'),
            markdown('- Text\n    Formula $x_i$'), markdown('> Quote\n>     Formula $x_i$'),
            markdown('- Text\n\n    Formula $x_i$'), markdown('1. Text\n\n    Formula $x_i$'),
            markdown('- Outer\n  - Inner\n\n      Formula $x_i$\n\n  Formula $y_i$'),
            markdown('Paragraph\n\n    print("$$ x $$")'), markdown('- Text\n\n      print("$$ x $$")')], {}, context(), dependencies);
        expect([...root.querySelectorAll('.katex')].map(node => node.textContent)).toEqual(['x_i + y_i', 'x_i', 'x_i', 'x_i', 'x_i', 'x_i', 'y_i']);
        expect([...root.querySelectorAll('pre code')].map(node => node.textContent)).toEqual(['print("$$ x $$")\n', 'print("$$ x $$")\n']);
    });

    it('hardens image-map links and routes activation through host navigation', async () => {
        const source = '<map name="links"><area href="https://external.test" target="_blank" shape="rect" coords="0,0,1,1"></map>' +
            `<img usemap="#links" src="data:image/png;base64,${PNG}">`;
        const ctx = context(); ctx.navigation = { openExternalUrl: vi.fn(async () => {}) };
        const { root, handle } = await mount([code('', [display({ 'text/html': source })])], {}, ctx);
        const area = root.querySelector('area')!;
        expect(area.hasAttribute('href')).toBe(false); expect(area.hasAttribute('target')).toBe(false);
        const click = new MouseEvent('click', { bubbles: true, cancelable: true });
        area.dispatchEvent(click); expect(click.defaultPrevented).toBe(true);
        expect(ctx.navigation.openExternalUrl).toHaveBeenCalledWith('https://external.test');
        handle.dispose(); area.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(ctx.navigation.openExternalUrl).toHaveBeenCalledTimes(1);
        const blocked = await mount([markdown(source)]);
        expect(blocked.root.querySelector('area')?.hasAttribute('href')).toBe(false);
        expect(blocked.root.querySelector('area')?.getAttribute('aria-disabled')).toBe('true');
    });

    it('keeps unmatched dollars in Markdown destinations and titles separate from following prose math', async () => {
        const ctx = context(); ctx.navigation = { openExternalUrl: vi.fn(async () => {}) };
        ctx.documentAssets = { resolve: vi.fn(async () => ({ url: 'blob:plot', dispose() {} })) };
        const dependencies = deps(); dependencies.math = { renderToHtml: source => `<span class="katex">${source}</span>` };
        const { root } = await mount([markdown('[Open](https://example.com/$HOME)과$x$'),
            markdown('![Plot](plot$HOME.png)와$x$'), markdown('[Price](https://example.com/a "Price $5")$x$')], {}, ctx, dependencies);
        const anchors = root.querySelectorAll<HTMLAnchorElement>('a');
        expect(anchors).toHaveLength(2);
        anchors[0]!.click(); expect(ctx.navigation.openExternalUrl).toHaveBeenCalledWith('https://example.com/$HOME');
        expect(ctx.documentAssets.resolve).toHaveBeenCalledWith('plot$HOME.png');
        expect(anchors[1]?.title).toBe('Price $5');
        expect(root.querySelectorAll('.katex')).toHaveLength(3);
        expect([...root.querySelectorAll('.katex')].map(node => node.textContent)).toEqual(['x', 'x', 'x']);
    });

    it('preserves Markdown-normalized multiline code containing display-math delimiters', async () => {
        const sources = ['    print("""$$\n    x\n    $$""")', '>     print("""$$\n>     x\n>     $$""")',
            '  ~~~python\nprint("""$$\nx\n$$""")\n  ~~~', '~~~~python\n~~~\nprint("""$$\nx\n$$""")\n~~~~',
            '-     print("""$$\n      x\n      $$""")', '1.     print("""$$\n       x\n       $$""")',
            '> -     print("""$$\n>       x\n>       $$""")', '- -     print("""$$\n        x\n        $$""")',
            '- ~~~python\n  print("""$$\n  x\n  $$""")\n  ~~~', '~~~python\n> ~~~\n- ~~~\nprint("""$$\nx\n$$""")\n~~~'];
        const { root } = await mount(sources.map(source => markdown(source)));
        const actual = [...root.querySelectorAll('pre code')].map(node => node.textContent);
        const expected = sources.map(source => {
            const template = document.createElement('template'); template.innerHTML = marked.parse(source, { async: false });
            return template.content.querySelector('pre code')?.textContent;
        });
        expect(actual).toEqual(expected);
        expect(root.textContent).not.toContain('%%omni-notebook-math-');
    });

    it('restores exact math-like code in indented, nested, and longer fenced Markdown blocks', async () => {
        const dependencies = deps(); dependencies.math = { renderToHtml: source => `<span class="katex">${source}</span>` };
        const sources = ['    print("$x$", "$$ y $$")', '  ~~~python\nprint("$x$")\n  ~~~',
            '~~~~python\n~~~\nprint("$x$")\n~~~~', '>     print("$x$")'];
        const { root } = await mount(sources.map(source => markdown(source)), {}, context(), dependencies);
        const codeBlocks = root.querySelectorAll('pre code');
        expect(codeBlocks).toHaveLength(4);
        expect(codeBlocks[0]?.textContent).toBe('print("$x$", "$$ y $$")\n');
        expect(codeBlocks[1]?.textContent).toBe('print("$x$")\n');
        expect(codeBlocks[2]?.textContent).toBe('~~~\nprint("$x$")\n');
        expect(codeBlocks[3]?.textContent).toBe('print("$x$")\n');
        expect(root.querySelectorAll('.katex')).toHaveLength(0);
        expect(root.textContent).not.toContain('%%omni-notebook-math-');
    });

    it('restores Markdown URLs and titles before sanitization and host routing', async () => {
        const ctx = context(); ctx.navigation = { openExternalUrl: vi.fn(async () => {}) };
        ctx.documentAssets = { resolve: vi.fn(async () => ({ url: 'blob:plot', dispose() {} })) };
        const dependencies = deps(); dependencies.math = { renderToHtml: source => `<span class="katex">${source}</span>` };
        const { root } = await mount([markdown('[Open](https://example.com/$x$ "Title $y$")\n\n![Plot](plot$x$.png "Plot $z$")\n\nFormula $a_i$')], {}, ctx, dependencies);
        root.querySelector<HTMLAnchorElement>('a')!.click();
        expect(ctx.navigation.openExternalUrl).toHaveBeenCalledWith('https://example.com/$x$');
        expect(ctx.documentAssets.resolve).toHaveBeenCalledWith('plot$x$.png');
        expect(root.querySelector('a')?.title).toBe('Title $y$');
        expect(root.querySelector('img')?.title).toBe('Plot $z$');
        expect(root.querySelectorAll('.katex')).toHaveLength(1);
        expect(root.querySelector('.katex')?.textContent).toBe('a_i');
    });

    it('keeps host image paths separate from internal attachment references', async () => {
        const ctx = context(); ctx.documentAssets = { resolve: vi.fn(async () => ({ url: 'blob:host', dispose() {} })) };
        const { root } = await mount([markdown('![Host](omni-notebook-attachment/0)\n\n![Attach](attachment:plot.png)',
            { attachments: { 'plot.png': { 'image/png': PNG } } })], {}, ctx);
        await Promise.resolve();
        expect(ctx.documentAssets.resolve).toHaveBeenCalledWith('omni-notebook-attachment/0');
        const images = root.querySelectorAll<HTMLImageElement>('img');
        expect(images[0]?.src).toBe('blob:host');
        expect(images[1]?.src).toBe(`data:image/png;base64,${PNG}`);
    });

    it('preserves raw HTML code and attributes in Markdown while rendering prose math', async () => {
        const dependencies = deps(); dependencies.math = { renderToHtml: source => `<span class="katex">${source}</span>` };
        const { root } = await mount([markdown('<pre><code>print("$x$")</code></pre>\n<p title="$label$">Formula $y_i$</p>')], {}, context(), dependencies);
        expect(root.querySelector('pre code')?.textContent).toBe('print("$x$")');
        expect(root.querySelector('[title]')?.getAttribute('title')).toBe('$label$');
        expect(root.querySelectorAll('.katex')).toHaveLength(1);
        expect(root.querySelector('.katex')?.textContent).toBe('y_i');
        expect(root.textContent).not.toContain('%%omni-notebook-math-');
    });

    it('keeps literal math token lookalikes unchanged in Markdown and saved HTML', async () => {
        const dependencies = deps(); dependencies.math = { renderToHtml: source => `<span class="katex">${source}</span>` };
        const literal = 'Literal %%omni-math-token-0%% and formula $x$';
        const { root } = await mount([markdown(literal), code('', [display({ 'text/html': `<p>${literal}</p>` })])], {}, context(), dependencies);
        const previews = root.querySelectorAll('.omni-markdown__preview');
        for (const preview of previews) {
            expect(preview.textContent).toContain('Literal %%omni-math-token-0%% and formula x');
            expect(preview.querySelectorAll('.katex')).toHaveLength(1);
        }
    });

    it('preserves terminal and keyboard notation in saved HTML and Markdown', async () => {
        const dependencies = deps(); const render = vi.fn((source: string) => `<span class="katex">${source}</span>`);
        dependencies.math = { renderToHtml: render };
        const source = '<samp>echo <span>$HOME$</span></samp><kbd>$PATH$</kbd><p>Formula $x$</p>';
        const { root } = await mount([markdown(source), code('', [display({ 'text/html': source })])], {}, context(), dependencies);
        expect([...root.querySelectorAll('samp')].map(node => node.textContent)).toEqual(['echo $HOME$', 'echo $HOME$']);
        expect([...root.querySelectorAll('kbd')].map(node => node.textContent)).toEqual(['$PATH$', '$PATH$']);
        expect(render.mock.calls.map(call => call[0])).toEqual(['x', 'x']);
    });

    it('resolves quoted and entity-encoded attachment filenames through inert HTML attributes', async () => {
        const { root } = await mount([markdown("![Quoted](attachment:plot's.png)\n\n<img src='attachment:plot&#x2e;png' alt='Entity'>",
            { attachments: { "plot's.png": { 'image/png': PNG }, 'plot.png': { 'image/png': PNG } } })]);
        const images = root.querySelectorAll<HTMLImageElement>('img');
        expect(images).toHaveLength(2);
        expect([...images].map(image => image.src)).toEqual([`data:image/png;base64,${PNG}`, `data:image/png;base64,${PNG}`]);
    });

    it('preserves HTML code and attribute values while rendering math in prose text nodes', async () => {
        const ctx = context(); ctx.documentAssets = { resolve: vi.fn(async () => ({ url: 'blob:plot', dispose() {} })) };
        const dependencies = deps();
        dependencies.math = { renderToHtml: source => `<span class="katex">${source}</span>` };
        const { root } = await mount([code('', [display({ 'text/html':
            '<pre><code>print("$x$")</code></pre><p>Formula $y_i$</p><span title="$label$">Hint</span><img src="plot$x$.png" alt="plot">' })])], {}, ctx, dependencies);
        await Promise.resolve();
        expect(root.querySelector('.omni-notebook__output code')?.textContent).toBe('print("$x$")');
        expect(root.querySelector('[title]')?.getAttribute('title')).toBe('$label$');
        expect(ctx.documentAssets.resolve).toHaveBeenCalledWith('plot$x$.png');
        expect(root.querySelectorAll('.katex')).toHaveLength(1);
        expect(root.querySelector('.katex')?.textContent).toBe('y_i');
        expect(root.textContent).not.toContain('%%omni-math-token-');
    });

    it('keeps sanitizer input bounded for repeated large attachments and releases a shared blob URL once', async () => {
        const dependencies = deps();
        const sanitizeSizes: number[] = [];
        const create = dependencies.createDOMPurify;
        dependencies.createDOMPurify = window => {
            const purifier = create(window);
            return { sanitize: (html, options) => { sanitizeSizes.push(html.length); return purifier.sanitize(html, options); } };
        };
        const createUrl = vi.fn(() => 'blob:attachment'); const revokeUrl = vi.fn();
        const originalCreate = Object.getOwnPropertyDescriptor(window.URL, 'createObjectURL');
        const originalRevoke = Object.getOwnPropertyDescriptor(window.URL, 'revokeObjectURL');
        Object.defineProperty(window.URL, 'createObjectURL', { configurable: true, value: createUrl });
        Object.defineProperty(window.URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
        try {
            const { root, handle } = await mount([markdown(Array.from({ length: 32 }, () => '![Plot](attachment:plot.png)').join('\n'),
                { attachments: { 'plot.png': { 'image/png': 'a'.repeat(65_536) } } })], {}, context(), dependencies);
            expect(root.querySelectorAll('img')).toHaveLength(32);
            expect(Math.max(...sanitizeSizes)).toBeLessThan(10_000);
            expect(createUrl).toHaveBeenCalledTimes(1);
            expect([...root.querySelectorAll('img')].every(image => image.getAttribute('src') === 'blob:attachment')).toBe(true);
            handle.dispose(); handle.dispose(); expect(revokeUrl).toHaveBeenCalledTimes(1);
            expect(revokeUrl).toHaveBeenCalledWith('blob:attachment');
        } finally {
            if (originalCreate) Object.defineProperty(window.URL, 'createObjectURL', originalCreate); else Reflect.deleteProperty(window.URL, 'createObjectURL');
            if (originalRevoke) Object.defineProperty(window.URL, 'revokeObjectURL', originalRevoke); else Reflect.deleteProperty(window.URL, 'revokeObjectURL');
        }
    });

    it('renders Markdown tables and math, code, raw cells, and execution prompts in file order', async () => {
        const dependencies = deps();
        dependencies.math = { renderToHtml: (source, displayMode) => `<span class="katex" data-display="${displayMode}">${source}</span>` };
        dependencies.highlighter = { getLanguage: language => language === 'python',
            highlight: () => ({ value: '<span class="hljs-keyword">print</span>(1)' }), highlightAuto: source => ({ value: source }) };
        const { root } = await mount([markdown('# Analysis\n\n| x | y |\n|---|---|\n|1|2|\n\n$x_i$\n\n$$x^2$$'),
            code(), { cell_type: 'raw', source: '<script>raw text</script>' }], {}, context(), dependencies);
        expect(root.querySelector('h1.omni-notebook__title')?.textContent).toBe('analysis.ipynb');
        expect(root.querySelectorAll('.omni-notebook__cell')).toHaveLength(3);
        expect(root.querySelector('.omni-markdown__preview h1')?.textContent).toBe('Analysis');
        expect(root.querySelector('table td')?.textContent).toBe('1');
        expect(root.querySelectorAll('.katex')).toHaveLength(2);
        expect(root.querySelector('.hljs-keyword')?.textContent).toBe('print');
        expect(root.querySelector('.omni-notebook__prompt')?.textContent).toBe('In [7]:');
        expect(root.querySelector('.omni-notebook__raw')?.textContent).toBe('<script>raw text</script>');
        expect(root.querySelector('script')).toBeNull();
        expect(root.querySelector('style')?.textContent).toContain('.omni-notebook');
    });

    it('renders streams, HTML tables, PNG, SVG, JSON, Markdown, LaTeX, errors, and chooses only one MIME representation', async () => {
        const dependencies = deps(); dependencies.math = { renderToHtml: source => `<span class="katex">${source}</span>` };
        const { root } = await mount([code('analyze()', [
            { output_type: 'stream', name: 'stdout', text: ['loaded\n', '3 rows\n'] },
            { output_type: 'stream', name: 'stderr', text: 'warning' },
            display({ 'text/html': '<table><tr><td>Revenue</td><td>12</td></tr></table>', 'text/plain': 'duplicate fallback' },
                { output_type: 'execute_result', execution_count: 8 }),
            display({ 'image/png': PNG }, { metadata: { 'image/png': { width: 320, height: 200 } } }),
            display({ 'image/svg+xml': '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>' }),
            display({ 'application/json': { total: 3 } }), display({ 'text/markdown': '**Saved markdown**' }),
            display({ 'text/latex': '$$x^2$$' }),
            { output_type: 'error', ename: 'ValueError', evalue: '<invalid>', traceback: ['\u001b[31mTraceback\u001b[0m', 'line 3'] }
        ])], {}, context(), dependencies);
        expect(root.querySelectorAll('.omni-notebook__output')).toHaveLength(9);
        expect(root.querySelector('table')?.textContent).toBe('Revenue12');
        expect(root.textContent).not.toContain('duplicate fallback');
        expect(root.querySelector('.omni-notebook__stderr')?.textContent).toBe('warning');
        expect(root.querySelectorAll('.omni-notebook__image')).toHaveLength(2);
        expect(root.querySelector<HTMLImageElement>('.omni-notebook__image')?.src).toBe(`data:image/png;base64,${PNG}`);
        expect(root.querySelector<HTMLImageElement>('.omni-notebook__image')?.width).toBe(320);
        expect(root.querySelector('.omni-notebook__error')?.textContent).toBe('ValueError: <invalid>\nTraceback\nline 3');
        expect(root.textContent).toContain('Out [8]:');
        expect(root.textContent).toContain('"total":3');
        expect(root.querySelector('strong')?.textContent).toBe('Saved markdown');
        expect(root.querySelector('.katex')?.textContent).toBe('x^2');
    });

    it('renders cell attachments and embedded raster images without host services', async () => {
        const { root } = await mount([markdown('![Inline](attachment:plot%20one.png)\n\n![Embedded](data:image/png;base64,' + PNG + ')\n\n![SVG](attachment:chart.svg)',
            { attachments: { 'plot one.png': { 'image/png': PNG }, 'chart.svg': { 'image/svg+xml': '<svg xmlns="http://www.w3.org/2000/svg"><circle r="3"/></svg>' } } })]);
        const images = root.querySelectorAll<HTMLImageElement>('img');
        expect(images).toHaveLength(3);
        expect([...images].slice(0, 2).map(image => image.src)).toEqual([`data:image/png;base64,${PNG}`, `data:image/png;base64,${PNG}`]);
        expect(images[2]?.src).toMatch(/^data:image\/svg\+xml/);
        images[0]!.dispatchEvent(new Event('error'));
        expect(root.textContent).toContain('Inline');
        expect(root.querySelectorAll('img')).toHaveLength(2);
    });

    it('sanitizes saved HTML and blocks active content and remote media before inserting it', async () => {
        const { root } = await mount([code('', [display({ 'text/html':
            '<script>window.bad = true</script><iframe src="https://evil.test"></iframe><form><input></form>' +
            '<table style="background:url(https://evil.test)"><tr><td background="https://evil.test">Safe table</td></tr></table>' +
            '<img src="https://evil.test/a.png" srcset="https://evil.test/b.png 2x" onerror="bad()" alt="Blocked image">' +
            '<video src="https://evil.test/video" poster="https://evil.test/poster"></video><audio><source src="https://evil.test/audio"></audio>' +
            '<a href="javascript:bad()" onclick="bad()">Bad link</a>' })])]);
        expect(root.querySelectorAll('script,iframe,form,input:not([type]),video,audio,source,[onerror],[onclick],[style],[background],[srcset]')).toHaveLength(0);
        expect(root.querySelector('img')).toBeNull();
        expect(root.querySelector('table')?.textContent).toBe('Safe table');
        expect(root.querySelector('a')?.getAttribute('aria-disabled')).toBe('true');
        expect(root.textContent).toContain('External resources were blocked.');
    });

    it('uses the existing SVG sanitizer and falls back when an image is invalid or truncated', async () => {
        const malicious = '<svg xmlns="http://www.w3.org/2000/svg" onload="bad()"><script>bad()</script><image href="https://evil.test/a"/><foreignObject>bad</foreignObject><circle r="3"/></svg>';
        const { root } = await mount([code('', [display({ 'image/svg+xml': malicious }),
            display({ 'image/png': 'invalid base64', 'text/plain': 'image fallback' }),
            display({ 'application/vnd.jupyter.widget-view+json': { model_id: 'widget' }, 'text/plain': 'Widget(1)' })])]);
        const image = root.querySelector<HTMLImageElement>('img')!;
        const svg = decodeURIComponent(image.src.split(',')[1]!);
        expect(svg).toContain('circle'); expect(svg).not.toMatch(/script|onload|evil|foreignObject/);
        expect(root.textContent).toContain('image fallback'); expect(root.textContent).toContain('Widget(1)');
        const truncated = await mount([code('', [display({ 'image/png': PNG, 'text/plain': 'tiny' })])], { limits: { maxPreviewBytes: 8 } });
        expect(truncated.root.querySelector('img')).toBeNull(); expect(truncated.root.textContent).toContain('tiny');
        expect(truncated.root.textContent).toContain('truncated');
    });

    it('routes allowed links through navigation, supports keyboard activation and cross-cell fragments', async () => {
        const ctx = context(); ctx.navigation = { openExternalUrl: vi.fn(async () => {}) };
        const { root } = await mount([markdown('[Next](#results)\n\n[Open](https://example.com)'), markdown('<h2 id="results">Results</h2>')], {}, ctx);
        const anchors = root.querySelectorAll('a');
        const result = root.querySelector<HTMLElement>('#results')!;
        const focus = vi.spyOn(result, 'focus');
        anchors[0]!.click(); expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        anchors[1]!.click();
        anchors[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(ctx.navigation.openExternalUrl).toHaveBeenCalledTimes(2);
        expect(ctx.navigation.openExternalUrl).toHaveBeenCalledWith('https://example.com');
        expect([...anchors].every(anchor => !anchor.hasAttribute('href'))).toBe(true);
        const noService = await mount([markdown('[Open](https://example.com)')]);
        expect(noService.root.querySelector('a')?.getAttribute('aria-disabled')).toBe('true');
    });

    it('resolves relative assets only through the host and releases them on disposal, including late resolution', async () => {
        const release = vi.fn(); const ctx = context();
        ctx.documentAssets = { resolve: vi.fn(async () => ({ url: 'blob:relative', dispose: release })) };
        const { root, handle } = await mount([markdown('![Plot](images/plot.png)\n\n![Blocked](../outside.png)')], {}, ctx);
        await Promise.resolve();
        expect(ctx.documentAssets.resolve).toHaveBeenCalledTimes(1);
        expect(ctx.documentAssets.resolve).toHaveBeenCalledWith('images/plot.png');
        expect(root.querySelector<HTMLImageElement>('img')?.src).toBe('blob:relative');
        handle.dispose(); handle.dispose(); expect(release).toHaveBeenCalledTimes(1);
        let resolve!: (value: { url: string; dispose(): void }) => void;
        ctx.documentAssets.resolve = () => new Promise(done => { resolve = done; });
        const late = await mount([markdown('![Plot](plot.png)')], {}, ctx);
        late.handle.dispose(); const lateRelease = vi.fn(); resolve({ url: 'blob:late', dispose: lateRelease });
        await Promise.resolve(); expect(lateRelease).toHaveBeenCalledTimes(1);
        expect(late.root.childNodes).toHaveLength(0);
    });

    it('respects saved collapse hints and supports global visibility and searching code and outputs', async () => {
        const { root } = await mount([markdown('# Title'), code('x = 1', [{ output_type: 'stream', text: 'unique result' }],
            { metadata: { jupyter: { source_hidden: true }, collapsed: true } })]);
        const source = root.querySelector<HTMLDetailsElement>('.omni-notebook__source')!;
        const outputs = root.querySelector<HTMLDetailsElement>('.omni-notebook__outputs')!;
        expect(source.open).toBe(false); expect(outputs.open).toBe(false);
        const toggles = root.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
        toggles[0]!.checked = false; toggles[0]!.dispatchEvent(new Event('change')); expect(source.hidden).toBe(true);
        toggles[1]!.checked = false; toggles[1]!.dispatchEvent(new Event('change')); expect(outputs.hidden).toBe(true);
        const search = root.querySelector<HTMLInputElement>('input[type=search]')!;
        search.value = 'UNIQUE'; search.dispatchEvent(new Event('input'));
        const cards = root.querySelectorAll<HTMLElement>('.omni-notebook__cell');
        expect(cards[0]?.hidden).toBe(true); expect(cards[1]?.hidden).toBe(false);
        search.value = 'absent'; search.dispatchEvent(new Event('input'));
        expect(root.querySelector<HTMLElement>('.omni-notebook__empty')?.hidden).toBe(false);
        search.value = ''; search.dispatchEvent(new Event('input')); expect(cards[0]?.hidden).toBe(false);
    });

    it('has no execution or editing controls and reports an empty notebook', async () => {
        const { root } = await mount([]);
        expect(root.querySelector('.omni-notebook__empty')?.textContent).toBe('This notebook has no cells.');
        expect(root.querySelectorAll('button,textarea,[contenteditable]')).toHaveLength(0);
        expect(root.textContent).toContain('without execution');
    });

    it('keeps code text and formula source readable when optional renderers fail or are absent', async () => {
        const { root } = await mount([markdown('$x_i$ and `print(1)`'), code('<unsafe>')]);
        expect(root.textContent).toContain('$x_i$');
        expect(root.querySelector('.omni-notebook__source code')?.textContent).toBe('<unsafe>');
        const broken = deps(); broken.render.parse = () => { throw new Error('renderer error'); };
        const failed = await mount([markdown('# Original')], {}, context(), broken);
        expect(failed.root.textContent).toContain('Preview failed'); expect(failed.root.textContent).toContain('# Original');
    });

    it('cleans up only owned styles, classes, and listeners and can remount in scoped and shadow modes', async () => {
        const { root, container, handle } = await mount([markdown('hello')], { styleIsolation: 'scoped' });
        expect(container.classList.contains('omni-viewer--notebook')).toBe(true); expect(root.querySelector('style')).toBeNull();
        const remove = vi.spyOn(EventTarget.prototype, 'removeEventListener'); handle.dispose();
        expect(container.childNodes).toHaveLength(0); expect(container.classList.contains('omni-viewer')).toBe(false);
        expect(remove).toHaveBeenCalled();
        const next = await mountNotebookViewer({ fileName: 'again.ipynb', data: data([]) }, container, context(), deps());
        expect(container.shadowRoot?.querySelectorAll('style')).toHaveLength(1);
        next.dispose(); expect(container.shadowRoot?.childNodes).toHaveLength(0);
    });

    it('leaves no DOM on malformed input or cancellation during initialization', async () => {
        const container = document.createElement('div'); const controller = new AbortController();
        await expect(mountNotebookViewer({ fileName: 'bad.ipynb', data: new TextEncoder().encode('{}') }, container, context(), deps())).rejects.toThrow();
        expect(container.childNodes).toHaveLength(0);
        const dependencies = deps(); dependencies.render.parse = () => { controller.abort(); return '<p>pending</p>'; };
        await expect(mountNotebookViewer({ fileName: 'abort.ipynb', data: data([markdown('pending')]) }, container, context(), dependencies,
            { signal: controller.signal })).rejects.toBeInstanceOf(MountAbortedError);
        expect(container.childNodes).toHaveLength(0); expect(container.shadowRoot).toBeNull();
    });
});
