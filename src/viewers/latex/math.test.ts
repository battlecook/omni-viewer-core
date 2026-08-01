// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { MATH_SANITIZE_PROFILE } from '../math.js';
import { MATH_NOOP_MACROS, mountLatexViewer, prepareMathSource, type LatexViewerContext, type LatexViewerDeps } from './index.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const doc = (body: string, preamble = '\\documentclass{article}\n'): string =>
    `${preamble}\\begin{document}\n${body}\n\\end{document}\n`;

const logs: Array<[string, string]> = [];
const baseCtx: LatexViewerContext = {
    assets: { resolveAssetUrl: async (path: string) => path },
    i18n: createCatalogI18n(),
    logger: { log: (level, message) => { logs.push([level, message]); } }
};

/** Stands in for KaTeX: echoes the TeX inside a marker element. */
const echoRenderer: LatexViewerDeps = {
    math: { renderToHtml: (source, display) => `<span class="katex" data-display="${display}">${source}</span>` },
    createDOMPurify: () => ({ sanitize: html => html })
};

async function mount(source: string, deps?: LatexViewerDeps, extra: Record<string, unknown> = {}): Promise<{
    root: ShadowRoot; dispose: () => void;
}> {
    const container = document.createElement('div');
    const handle = await mountLatexViewer(
        { fileName: 'paper.tex', data: enc(source) },
        container,
        baseCtx,
        { ...(deps ? { deps } : {}), renderAllMath: true, ...extra }
    );
    return { root: container.shadowRoot!, dispose: () => handle.dispose() };
}

afterEach(() => {
    logs.length = 0;
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
});

describe('latex math rendering', () => {
    it('renders inline and display math through the injected engine', async () => {
        const { root, dispose } = await mount(doc('Let $x^2$ hold.\n\n$$E = mc^2$$\n'), echoRenderer);
        const rendered = [...root.querySelectorAll('.omni-latex__math .katex')];
        expect(rendered.map(x => x.textContent)).toEqual(['x^2', 'E = mc^2']);
        expect(rendered.map(x => x.getAttribute('data-display'))).toEqual(['false', 'true']);
        dispose();
    });

    it('passes preamble macros keyed by control sequence', async () => {
        const renderToHtml = vi.fn(() => '<span class="katex">ok</span>');
        await mount(
            doc('$\\R$\n', '\\documentclass{article}\n\\newcommand{\\R}{\\mathbb{R}}\n'),
            { math: { renderToHtml }, createDOMPurify: () => ({ sanitize: html => html }) }
        );
        // Document macros are merged over the no-op defaults, and win.
        expect(renderToHtml).toHaveBeenCalledWith('\\R', false, {
            macros: { ...MATH_NOOP_MACROS, '\\R': '\\mathbb{R}' }
        });
    });

    it('keeps the rest of the document when one formula fails', async () => {
        let calls = 0;
        const { root, dispose } = await mount(doc('$good$ and $bad$\n'), {
            math: {
                renderToHtml: source => {
                    calls++;
                    if (source === 'bad') throw new Error('boom');
                    return `<span class="katex">${source}</span>`;
                }
            },
            createDOMPurify: () => ({ sanitize: html => html })
        });
        expect(calls).toBe(2);
        expect(root.querySelector('.omni-latex__math .katex')?.textContent).toBe('good');
        const failed = root.querySelector('.omni-latex__math.is-invalid');
        // The failed slot keeps its TeX rather than going blank.
        expect(failed?.textContent).toBe('$bad$');
        dispose();
    });

    it('leaves math as TeX source and says so when no renderer is injected', async () => {
        const { root, dispose } = await mount(doc('Let $x^2$ hold.\n'));
        expect(root.querySelector('.omni-latex__math--inline')?.textContent).toBe('$x^2$');
        expect(root.querySelector('.katex')).toBeNull();
        expect(root.querySelector('.omni-latex__preview-panel .omni-latex__caption')?.textContent)
            .toContain('Math renderer not installed');
        dispose();
    });

    it('omits the missing-renderer note for a document without formulas', async () => {
        const { root, dispose } = await mount(doc('Plain text only.\n'));
        expect(root.querySelector('.omni-latex__preview-panel .omni-latex__caption')?.textContent)
            .not.toContain('Math renderer');
        dispose();
    });

    it('re-renders math after the source is edited', async () => {
        const { root, dispose } = await mount(doc('$before$\n'), echoRenderer);
        const area = root.querySelector<HTMLTextAreaElement>('.omni-latex__source')!;
        area.value = doc('$after$\n');
        area.dispatchEvent(new Event('input'));
        root.querySelector<HTMLButtonElement>('.omni-latex__button.is-dirty')?.click();
        expect(root.querySelector('.omni-latex__math .katex')?.textContent).toBe('after');
        dispose();
    });
});

describe('prepareMathSource', () => {
    it('drops \\label, which typesets nothing', () => {
        expect(prepareMathSource('\\label{eq:a}A+B=C')).toBe('A+B=C');
        expect(prepareMathSource('\\label {eq:a} x')).toBe(' x');
    });

    it('degrades cross-references to their target key', () => {
        expect(prepareMathSource('\\tag{\\ref{align:c}}E=F')).toBe('\\tag{\\text{align:c}}E=F');
        expect(prepareMathSource('\\eqref{eq:1}')).toBe('\\text{eq:1}');
        expect(prepareMathSource('\\Cref{sec:2}')).toBe('\\text{sec:2}');
    });

    it('leaves ordinary math untouched', () => {
        expect(prepareMathSource('\\begin{align}a &= b \\\\ c &= d\\end{align}'))
            .toBe('\\begin{align}a &= b \\\\ c &= d\\end{align}');
    });
});

describe('latex math cross-references', () => {
    it('does not hand \\label to the engine, and keeps the TeX fallback faithful', async () => {
        const renderToHtml = vi.fn((_source: string, _display: boolean) => '<span class="katex">ok</span>');
        const { root, dispose } = await mount(
            doc('\\begin{align}\n\\label{align:a}A+B&=B+A\n\\end{align}\n'),
            { math: { renderToHtml }, createDOMPurify: () => ({ sanitize: html => html }) }
        );
        const passed = renderToHtml.mock.calls[0]![0];
        expect(passed).not.toContain('\\label');
        expect(passed).toContain('A+B&=B+A');
        // The parser's own record of the formula is untouched.
        expect(root.querySelector('.omni-latex__math')).not.toBeNull();
        dispose();
    });

    it('keeps \\label in the TeX shown when no renderer is injected', async () => {
        const { root, dispose } = await mount(doc('\\begin{align}\n\\label{align:a}A=B\n\\end{align}\n'));
        expect(root.querySelector('.omni-latex__math')?.textContent).toContain('\\label{align:a}');
        dispose();
    });
});

describe('latex math security boundary', () => {
    it('routes renderer output through the core math sanitize profile', async () => {
        const sanitize = vi.fn((html: string, _options: Record<string, unknown>) =>
            html.replace(/<script[\s\S]*?<\/script>/g, ''));
        const { root, dispose } = await mount(doc('$x$\n'), {
            math: { renderToHtml: () => '<span class="katex">x</span><script>alert(1)</script>' },
            createDOMPurify: () => ({ sanitize })
        });
        expect(sanitize).toHaveBeenCalledTimes(1);
        expect(sanitize.mock.calls[0]![1]).toBe(MATH_SANITIZE_PROFILE);
        expect(root.querySelector('script')).toBeNull();
        expect(root.querySelector('.katex')?.textContent).toBe('x');
        dispose();
    });

    it('inserts only what the purifier returned', async () => {
        const { root, dispose } = await mount(doc('$x$\n'), {
            math: { renderToHtml: () => '<span class="katex">x</span>' },
            createDOMPurify: () => ({ sanitize: () => '' })
        });
        expect(root.querySelector('.katex')).toBeNull();
        expect(root.querySelector('.omni-latex__math--inline')?.textContent).toBe('');
        dispose();
    });

    it('refuses a math renderer that comes without a purifier', async () => {
        const renderToHtml = vi.fn(() => '<span class="katex">x</span>');
        const { root, dispose } = await mount(doc('$x$\n'), { math: { renderToHtml } });
        expect(renderToHtml).not.toHaveBeenCalled();
        expect(root.querySelector('.omni-latex__math--inline')?.textContent).toBe('$x$');
        expect(logs.some(([level, message]) => level === 'warn' && message.includes('createDOMPurify'))).toBe(true);
        dispose();
    });
});

describe('latex progressive math rendering', () => {
    class FakeObserver {
        static instances: FakeObserver[] = [];
        readonly elements = new Set<Element>();
        disconnected = false;
        constructor(private readonly callback: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {
            FakeObserver.instances.push(this);
        }
        observe(element: Element): void { this.elements.add(element); }
        unobserve(element: Element): void { this.elements.delete(element); }
        disconnect(): void { this.elements.clear(); this.disconnected = true; }
        trigger(): void {
            this.callback([...this.elements].map(target => ({ target, isIntersecting: true })));
        }
    }

    const install = (): void => {
        FakeObserver.instances = [];
        (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
    };

    it('defers formulas until they approach the viewport', async () => {
        install();
        const renderToHtml = vi.fn(() => '<span class="katex">x</span>');
        const container = document.createElement('div');
        const handle = await mountLatexViewer(
            { fileName: 'paper.tex', data: enc(doc('$a$\n\n$b$\n')) },
            container, baseCtx,
            { deps: { math: { renderToHtml }, createDOMPurify: () => ({ sanitize: html => html }) } }
        );
        expect(renderToHtml).not.toHaveBeenCalled();
        expect(container.shadowRoot!.querySelectorAll('.omni-latex__math.is-pending')).toHaveLength(2);

        FakeObserver.instances[0]!.trigger();
        expect(renderToHtml).toHaveBeenCalledTimes(2);
        expect(container.shadowRoot!.querySelectorAll('.omni-latex__math.is-pending')).toHaveLength(0);
        handle.dispose();
    });

    it('disconnects the observer on dispose', async () => {
        install();
        const container = document.createElement('div');
        const handle = await mountLatexViewer(
            { fileName: 'paper.tex', data: enc(doc('$a$\n')) },
            container, baseCtx,
            { deps: echoRenderer }
        );
        handle.dispose();
        expect(FakeObserver.instances[0]?.disconnected).toBe(true);
    });

    it('renders everything at once when the platform has no IntersectionObserver', async () => {
        const renderToHtml = vi.fn(() => '<span class="katex">x</span>');
        const container = document.createElement('div');
        const handle = await mountLatexViewer(
            { fileName: 'paper.tex', data: enc(doc('$a$\n\n$b$\n')) },
            container, baseCtx,
            { deps: { math: { renderToHtml }, createDOMPurify: () => ({ sanitize: html => html }) } }
        );
        expect(renderToHtml).toHaveBeenCalledTimes(2);
        handle.dispose();
    });
});
