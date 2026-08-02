// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { MountAbortedError } from '../types.js';
import { mountLatexViewer, type LatexViewerContext, type LatexViewerHandle } from './index.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

const baseCtx: LatexViewerContext = {
    assets: { resolveAssetUrl: async (path: string) => path },
    i18n: createCatalogI18n(),
    logger: { log: () => undefined }
};

// jsdom does not implement scrollIntoView at all, so calling it throws and
// aborts whatever handler invoked it. Every outline/reference click goes through
// it, so it is stubbed for the whole file.
Element.prototype.scrollIntoView = function scrollIntoView(): void { /* no-op */ };

const doc = (body: string, preamble = '\\documentclass{article}\n'): string =>
    `${preamble}\\begin{document}\n${body}\n\\end{document}\n`;

async function mount(source: string, ctx: LatexViewerContext = baseCtx): Promise<{ root: ShadowRoot; dispose: () => void; container: HTMLElement; handle: LatexViewerHandle }> {
    const container = document.createElement('div');
    const handle = await mountLatexViewer({ fileName: 'paper.tex', data: enc(source) }, container, ctx);
    return { root: container.shadowRoot!, dispose: () => handle.dispose(), container, handle };
}

/** Ctrl+S sequences re-parse then save, so the outcome lands several
 *  microtasks later rather than synchronously. */
const flush = async (turns = 12): Promise<void> => {
    for (let i = 0; i < turns; i++) await Promise.resolve();
};

describe('mountLatexViewer — structure', () => {
    it('injects its CSS into a shadow root and cleans up on dispose', async () => {
        const { root, dispose, container } = await mount(doc('\\section{One}\ntext\n'));
        expect(root.querySelector('style')).not.toBeNull();
        expect(root.querySelector('.omni-latex')).not.toBeNull();
        dispose();
        expect(container.shadowRoot?.childNodes).toHaveLength(0);
    });

    it('renders headings at their mapped levels with an outline', async () => {
        const { root, dispose } = await mount(doc('\\section{One}\ntext\n\\subsection{Two}\nmore\n'));
        expect(root.querySelector('h2')?.textContent).toBe('One');
        expect(root.querySelector('h3')?.textContent).toBe('Two');
        expect([...root.querySelectorAll('.omni-latex__outline-link')].map(x => x.textContent)).toEqual(['One', 'Two']);
        dispose();
    });

    it('always shows that the preview is partial', async () => {
        const { root, dispose } = await mount(doc('text\n'));
        expect(root.querySelector('.omni-latex__partial')?.textContent).toMatch(/Partial preview/);
        dispose();
    });

    it('shows math as TeX source in stage 1 rather than dropping it', async () => {
        const { root, dispose } = await mount(doc('Let $x^2$ hold.\n\n$$E = mc^2$$\n'));
        expect(root.querySelector('.omni-latex__math--inline')?.textContent).toBe('$x^2$');
        const display = [...root.querySelectorAll('.omni-latex__math')].find(x => !x.classList.contains('omni-latex__math--inline'));
        expect(display?.textContent).toBe('E = mc^2');
        dispose();
    });

    it('renders lists as real list elements', async () => {
        const { root, dispose } = await mount(doc('\\begin{enumerate}\n\\item Alpha\n\\item Beta\n\\end{enumerate}\n'));
        expect(root.querySelectorAll('ol > li')).toHaveLength(2);
        dispose();
    });
});

describe('mountLatexViewer — honest degradation', () => {
    it('shows an unsupported environment with its source and a badge', async () => {
        const { root, dispose } = await mount(doc('\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}\n'));
        const block = root.querySelector('.omni-latex__unsupported');
        expect(block?.querySelector('.omni-latex__badge')?.textContent).toContain('tikzpicture');
        expect(block?.querySelector('pre')?.textContent).toContain('\\draw (0,0);');
        dispose();
    });

    it('renders tabular as a real table with alignment and a header row', async () => {
        const { root, dispose } = await mount(doc('\\begin{tabular}{|l|r|}\n\\hline\nName & Value \\\\\n\\hline\nalpha & 1.0 \\\\\n\\hline\n\\end{tabular}\n'));
        const table = root.querySelector('table');
        expect(table).not.toBeNull();
        expect([...table!.querySelectorAll('th')].map(x => x.textContent)).toEqual(['Name', 'Value']);
        expect([...table!.querySelectorAll('td')].map(x => x.textContent)).toEqual(['alpha', '1.0']);
        expect(table!.querySelector('th')?.style.textAlign).toBe('left');
        dispose();
    });

    it('does not invent a header row for a single-row table', async () => {
        const { root, dispose } = await mount(doc('\\begin{tabular}{ll}\na & b \\\\\n\\end{tabular}\n'));
        expect(root.querySelectorAll('th')).toHaveLength(0);
        expect(root.querySelectorAll('td')).toHaveLength(2);
        dispose();
    });

    it('emits colspan for a multicolumn cell', async () => {
        const { root, dispose } = await mount(doc('\\begin{tabular}{ll}\n\\multicolumn{2}{c}{Wide} \\\\\na & b \\\\\n\\end{tabular}\n'));
        expect(root.querySelector<HTMLTableCellElement>('table th')?.colSpan).toBe(2);
        dispose();
    });

    it('shows only the caption of a float and says so', async () => {
        const { root, dispose } = await mount(doc('\\begin{figure}\n\\includegraphics{plot.png}\n\\caption{A plot}\n\\end{figure}\n'));
        const float = root.querySelector('.omni-latex__float');
        expect(float?.querySelector('.omni-latex__float-caption')?.textContent).toBe('A plot');
        expect(root.querySelector('img')).toBeNull();
        dispose();
    });

    it('marks \\input unresolved and warns without reading anything', async () => {
        const { root, dispose } = await mount(doc('\\input{chapter1}\n'));
        expect(root.querySelector('.omni-latex__badge')?.textContent).toContain('input');
        expect(root.querySelector('.omni-latex__warning')?.textContent).toContain('chapter1');
        dispose();
    });

    it('renders an included file when a resolver is injected', async () => {
        const container = document.createElement('div');
        const handle = await mountLatexViewer(
            { fileName: 'paper.tex', data: enc(doc('\\input{chapters/one}\n')) },
            container, baseCtx,
            { resolveInclude: async path => path === 'chapters/one.tex' ? '\\section{Chapter one}\nText.\n' : null }
        );
        const root = container.shadowRoot!;
        expect(root.querySelector('.omni-latex__include-label')?.textContent).toContain('chapters/one.tex');
        expect(root.querySelector('h2')?.textContent).toBe('Chapter one');
        // The outline gains the included headings; the editor still holds the
        // main file only, so saving cannot write the included text back.
        expect([...root.querySelectorAll('.omni-latex__outline-link')].map(x => x.textContent)).toEqual(['Chapter one']);
        expect(root.querySelector<HTMLTextAreaElement>('.omni-latex__source')?.value).not.toContain('Chapter one');
        handle.dispose();
    });

    it('does not move the editor caret for a heading that lives in an included file', async () => {
        const container = document.createElement('div');
        const handle = await mountLatexViewer(
            { fileName: 'paper.tex', data: enc(doc('\\section{Main}\n\n\\input{one}\n')) },
            container, baseCtx,
            { resolveInclude: async () => `${'x'.repeat(4000)}\n\\section{Included}\n` }
        );
        const root = container.shadowRoot!;
        const area = root.querySelector<HTMLTextAreaElement>('.omni-latex__source')!;
        const links = [...root.querySelectorAll<HTMLButtonElement>('.omni-latex__outline-link')];
        expect(links.map(x => x.textContent)).toEqual(['Main', 'Included']);

        const before = area.selectionStart;
        links[1]!.click();
        // The included heading's span addresses that file, not this editor —
        // applying it would drop the caret at unrelated text (its offset is well
        // past the end of the main source, so it would clamp to the last char).
        expect(area.selectionStart).toBe(before);
        links[0]!.click();
        // A heading from the main file still moves the caret, to its own span.
        expect(area.selectionStart).toBe(doc('\\section{Main}\n\n\\input{one}\n').indexOf('\\section{Main}'));
        handle.dispose();
    });

    it('lets only the newest render write when include resolution is slow', async () => {
        const container = document.createElement('div');
        let release: ((text: string) => void) | undefined;
        let call = 0;
        const handle = await mountLatexViewer(
            { fileName: 'paper.tex', data: enc(doc('\\input{one}\n')) },
            container, baseCtx,
            {
                // Mount resolves at once; the *next* render is held open so a
                // later one can overtake it. (Mount awaits resolution, so
                // stalling the first call would stall the mount itself.)
                resolveInclude: async () => {
                    call++;
                    if (call === 1) return '\\section{Mounted}\n';
                    if (call === 2) return new Promise<string>(resolve => { release = resolve; });
                    return '\\section{Newest}\n';
                }
            }
        );
        const root = container.shadowRoot!;
        const render = (): void => {
            [...root.querySelectorAll<HTMLButtonElement>('.omni-latex__button')]
                .find(x => x.textContent === 'Render')!.click();
        };
        const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
        expect(root.querySelector('h2')?.textContent).toBe('Mounted');

        render();                 // call 2 — stalls
        await settle();
        render();                 // call 3 — resolves immediately and wins
        await settle();
        expect(root.querySelector('h2')?.textContent).toBe('Newest');

        // The stale render lands last and must not overwrite the newer one.
        release?.('\\section{Stale}\n');
        await settle();
        expect(root.querySelector('h2')?.textContent).toBe('Newest');
        handle.dispose();
    });

    it('opens on the source view when the file is not LaTeX', async () => {
        const { root, dispose } = await mount('\\input plain\n$x$\n\\bye\n');
        const sourcePanel = root.querySelector<HTMLElement>('.omni-latex__source-panel');
        const previewPanel = root.querySelector<HTMLElement>('.omni-latex__preview-panel');
        expect(sourcePanel?.hidden).toBe(false);
        expect(previewPanel?.hidden).toBe(true);
        expect(root.querySelector<HTMLTextAreaElement>('.omni-latex__source')?.value).toContain('\\bye');
        dispose();
    });
});

describe('mountLatexViewer — cross references', () => {
    it('jumps from a \\ref to the labelled block, including forward references', async () => {
        const { root, dispose } = await mount(doc(
            'See \\ref{sec:later} and \\ref{eq:one}.\n\n' +
            '\\begin{equation}\\label{eq:one}\nx = y\n\\end{equation}\n\n' +
            '\\section{Later}\\label{sec:later}\nText.\n'
        ));
        const scrolls: Element[] = [];
        Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolls.push(this); };
        const refs = [...root.querySelectorAll<HTMLButtonElement>('.omni-latex__ref')];
        expect(refs.map(x => x.textContent)).toEqual(['sec:later', 'eq:one']);

        refs[0]!.click();
        expect(scrolls[0]?.tagName).toBe('H2');
        refs[1]!.click();
        expect((scrolls[1] as HTMLElement).classList.contains('omni-latex__math')).toBe(true);
        dispose();
    });

    it('leaves a reference with no target inert rather than jumping somewhere wrong', async () => {
        const { root, dispose } = await mount(doc('See \\ref{nowhere}.\n'));
        const scrolls: Element[] = [];
        Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolls.push(this); };
        root.querySelector<HTMLButtonElement>('.omni-latex__ref')!.click();
        expect(scrolls).toHaveLength(0);
        dispose();
    });
});

describe('mountLatexViewer — security boundaries', () => {
    it('never turns document source into live HTML', async () => {
        const payload = '<script>alert(1)</script><img src=x onerror="alert(2)">';
        const { root, dispose } = await mount(doc(`\\section{${payload}}\n${payload}\n\n\\begin{verbatim}\n${payload}\n\\end{verbatim}\n`));
        expect(root.querySelector('script')).toBeNull();
        expect(root.querySelector('img')).toBeNull();
        expect(root.textContent).toContain('<script>alert(1)</script>');
        dispose();
    });

    it('disables links whose scheme is not allowed', async () => {
        const navigation = { openExternalUrl: vi.fn(async () => undefined) };
        const { root, dispose } = await mount(doc('\\href{javascript:alert(1)}{click}\n'), { ...baseCtx, navigation });
        const link = root.querySelector<HTMLButtonElement>('.omni-latex__link');
        expect(link?.disabled).toBe(true);
        link?.click();
        expect(navigation.openExternalUrl).not.toHaveBeenCalled();
        dispose();
    });

    it('opens an allowed link through the navigation service only', async () => {
        const navigation = { openExternalUrl: vi.fn(async () => undefined) };
        const { root, dispose } = await mount(doc('\\url{https://example.test/a}\n'), { ...baseCtx, navigation });
        const link = root.querySelector<HTMLButtonElement>('.omni-latex__link');
        expect(link?.disabled).toBe(false);
        link?.click();
        expect(navigation.openExternalUrl).toHaveBeenCalledWith('https://example.test/a');
        dispose();
    });

    it('disables links entirely when no navigation service is provided', async () => {
        const { root, dispose } = await mount(doc('\\url{https://example.test/a}\n'));
        expect(root.querySelector<HTMLButtonElement>('.omni-latex__link')?.disabled).toBe(true);
        dispose();
    });
});

describe('mountLatexViewer — editing and saving', () => {
    it('gives split view the preview and an editable source, without the outline', async () => {
        const { root, dispose } = await mount(doc('\\section{One}\ntext\n'));
        [...root.querySelectorAll<HTMLButtonElement>('.omni-latex__button')]
            .find(x => x.textContent === 'Split')!.click();

        const outlinePanel = root.querySelector<HTMLElement>('.omni-latex__outline-panel')!;
        const previewPanel = root.querySelector<HTMLElement>('.omni-latex__preview-panel')!;
        const area = root.querySelector<HTMLTextAreaElement>('.omni-latex__source')!;
        expect(outlinePanel.hidden).toBe(true);
        expect(previewPanel.hidden).toBe(false);
        expect(area.closest<HTMLElement>('.omni-latex__source-panel')!.hidden).toBe(false);
        expect(area.readOnly).toBe(false);

        area.value = doc('\\section{Edited in split}\n');
        area.dispatchEvent(new Event('input'));
        expect(root.querySelector('.omni-latex__button.is-dirty')).not.toBeNull();
        [...root.querySelectorAll<HTMLButtonElement>('.omni-latex__button')]
            .find(x => x.textContent === 'Render')!.click();
        await Promise.resolve();
        expect(root.querySelector('h2')?.textContent).toBe('Edited in split');
        dispose();
    });

    it('brings the outline back when leaving split view', async () => {
        const { root, dispose } = await mount(doc('\\section{One}\ntext\n'));
        const button = (label: string): HTMLButtonElement =>
            [...root.querySelectorAll<HTMLButtonElement>('.omni-latex__button')].find(x => x.textContent === label)!;
        const outlinePanel = root.querySelector<HTMLElement>('.omni-latex__outline-panel')!;
        button('Split').click();
        expect(outlinePanel.hidden).toBe(true);
        button('Preview').click();
        expect(outlinePanel.hidden).toBe(false);
        button('Source').click();
        expect(outlinePanel.hidden).toBe(false);
        dispose();
    });

    it('re-parses edited source on render', async () => {
        const { root, dispose } = await mount(doc('\\section{One}\n'));
        const area = root.querySelector<HTMLTextAreaElement>('.omni-latex__source')!;
        area.value = doc('\\section{Renamed}\n');
        area.dispatchEvent(new Event('input'));
        root.querySelector<HTMLButtonElement>('.omni-latex__button.is-dirty')?.click();
        expect(root.querySelector('h2')?.textContent).toBe('Renamed');
        dispose();
    });

    it('writes back to the original file and clears the dirty flag', async () => {
        const write = vi.fn(async (_data: Uint8Array) => undefined);
        const { root, dispose } = await mount(doc('text\n'), { ...baseCtx, writeback: { write } });
        const area = root.querySelector<HTMLTextAreaElement>('.omni-latex__source')!;
        area.value = doc('changed\n');
        area.dispatchEvent(new Event('input'));
        area.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
        await Promise.resolve();
        await Promise.resolve();
        expect(write).toHaveBeenCalledTimes(1);
        expect(new TextDecoder().decode(write.mock.calls[0]![0])).toContain('changed');
        dispose();
    });

    it('explains that saving is unavailable when no service is provided', async () => {
        const { root, dispose } = await mount(doc('text\n'));
        const area = root.querySelector<HTMLTextAreaElement>('.omni-latex__source')!;
        area.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
        // Ctrl+S re-parses and only then saves, so the notice lands a few
        // microtasks later rather than synchronously.
        for (let i = 0; i < 6; i++) await Promise.resolve();
        expect(root.querySelector('.omni-latex__message')?.textContent).toBeTruthy();
        dispose();
    });

    it('disables copy without a clipboard service', async () => {
        const { root, dispose } = await mount(doc('text\n'));
        const copy = [...root.querySelectorAll<HTMLButtonElement>('.omni-latex__button')].find(x => x.textContent === 'Copy source');
        expect(copy?.disabled).toBe(true);
        dispose();
    });
});

describe('mountLatexViewer — handle.isDirty', () => {
    // Hosts re-mount on file change or refresh; without this they had to read
    // `.omni-latex__source` out of the shadow root to know whether that would
    // discard unsaved edits.
    it('is false on a freshly mounted document', async () => {
        const { handle, dispose } = await mount(doc('text\n'));
        expect(handle.isDirty()).toBe(false);
        dispose();
    });

    it('turns true once the source is edited', async () => {
        const { root, handle, dispose } = await mount(doc('text\n'));
        const area = root.querySelector<HTMLTextAreaElement>('.omni-latex__source')!;
        area.value = doc('changed\n');
        area.dispatchEvent(new Event('input'));
        expect(handle.isDirty()).toBe(true);
        dispose();
    });

    it('returns to false when undo restores the last saved source', async () => {
        const { root, handle, dispose } = await mount(doc('text\n'));
        const area = root.querySelector<HTMLTextAreaElement>('.omni-latex__source')!;
        area.value = doc('changed\n');
        area.dispatchEvent(new Event('input'));
        expect(handle.isDirty()).toBe(true);
        area.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
        expect(handle.isDirty()).toBe(false);
        dispose();
    });

    it('clears after a successful writeback', async () => {
        const write = vi.fn(async (_data: Uint8Array) => undefined);
        const { root, handle, dispose } = await mount(doc('text\n'), { ...baseCtx, writeback: { write } });
        const area = root.querySelector<HTMLTextAreaElement>('.omni-latex__source')!;
        area.value = doc('changed\n');
        area.dispatchEvent(new Event('input'));
        area.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
        await flush();
        expect(write).toHaveBeenCalledTimes(1);
        expect(handle.isDirty()).toBe(false);
        dispose();
    });

    it('stays dirty when the writeback fails', async () => {
        const write = vi.fn(async (_data: Uint8Array) => { throw new Error('disk full'); });
        const { root, handle, dispose } = await mount(doc('text\n'), { ...baseCtx, writeback: { write } });
        const area = root.querySelector<HTMLTextAreaElement>('.omni-latex__source')!;
        area.value = doc('changed\n');
        area.dispatchEvent(new Event('input'));
        area.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
        await flush();
        // Losing the flag here would let the host re-mount over edits that never
        // reached the file.
        expect(handle.isDirty()).toBe(true);
        dispose();
    });

    it('stays dirty when the user keeps typing while the writeback is in flight', async () => {
        // The editor stays live during an async write. If the save marks "what is
        // in the editor now" as saved, the edit made mid-write is declared to be
        // on disk and a host trusting isDirty() would discard it on re-mount.
        let release = (): void => undefined;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const write = vi.fn(async (_data: Uint8Array) => { await gate; });
        const { root, handle, dispose } = await mount(doc('text\n'), { ...baseCtx, writeback: { write } });
        const area = root.querySelector<HTMLTextAreaElement>('.omni-latex__source')!;

        area.value = doc('first\n');
        area.dispatchEvent(new Event('input'));
        area.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
        await flush();
        expect(write).toHaveBeenCalledTimes(1);
        expect(new TextDecoder().decode(write.mock.calls[0]![0])).toContain('first');

        area.value = doc('second\n');
        area.dispatchEvent(new Event('input'));
        release();
        await flush();

        // 'second' never reached the file.
        expect(handle.isDirty()).toBe(true);
        // Undoing back to what the file holds is genuinely clean again.
        area.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
        expect(handle.isDirty()).toBe(false);
        dispose();
    });

    it('stays dirty after Save As, which writes a copy rather than the original', async () => {
        const saveFile = vi.fn(async () => undefined);
        const { root, handle, dispose } = await mount(doc('text\n'), { ...baseCtx, save: { saveFile } });
        const area = root.querySelector<HTMLTextAreaElement>('.omni-latex__source')!;
        area.value = doc('changed\n');
        area.dispatchEvent(new Event('input'));
        area.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
        await flush();
        expect(saveFile).toHaveBeenCalledTimes(1);
        expect(handle.isDirty()).toBe(true);
        dispose();
    });

    it('disposes exactly as before: DOM cleared and listeners detached', async () => {
        const { root, container, handle } = await mount(doc('\\section{One}\ntext\n'));
        const area = root.querySelector<HTMLTextAreaElement>('.omni-latex__source')!;
        handle.dispose();
        expect(container.shadowRoot?.childNodes).toHaveLength(0);
        expect(root.querySelector('.omni-latex')).toBeNull();

        // The detached textarea keeps no live handler: a late input event from a
        // host that held a reference must not resurrect controller work.
        area.value = doc('changed\n');
        area.dispatchEvent(new Event('input'));
        expect(handle.isDirty()).toBe(false);
        handle.dispose();
    });
});

describe('mountLatexViewer — mount contract', () => {
    it('rejects a pre-aborted mount', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(mountLatexViewer(
            { fileName: 'x.tex', data: enc(doc('text')) },
            document.createElement('div'),
            baseCtx,
            { signal: controller.signal }
        )).rejects.toBeInstanceOf(MountAbortedError);
    });

    it('renders into the container under a scope class when style isolation is scoped', async () => {
        const container = document.createElement('div');
        const handle = await mountLatexViewer(
            { fileName: 'paper.tex', data: enc(doc('\\section{One}\ntext\n')) },
            container, baseCtx, { styleIsolation: 'scoped' }
        );
        // Scoped mode is the adapter-loads-the-stylesheet path: no shadow root,
        // no injected <style>, but the scope classes must still be present.
        expect(container.shadowRoot).toBeNull();
        expect(container.classList.contains('omni-viewer')).toBe(true);
        expect(container.classList.contains('omni-viewer--latex')).toBe(true);
        expect(container.querySelector('style')).toBeNull();
        expect(container.querySelector('h2')?.textContent).toBe('One');
        handle.dispose();
        expect(container.querySelector('.omni-latex')).toBeNull();
        expect(container.classList.contains('omni-viewer--latex')).toBe(false);
    });

    it('keeps focus on the outline button it was activated from', async () => {
        const { root, dispose } = await mount(doc('\\section{One}\ntext\n\n\\section{Two}\nmore\n'));
        const focus = vi.spyOn(HTMLTextAreaElement.prototype, 'focus');
        const blur = vi.spyOn(HTMLTextAreaElement.prototype, 'blur');
        root.querySelectorAll<HTMLButtonElement>('.omni-latex__outline-link')[1]!.click();
        // The caret still moves, but focusing the editor to do it would pull
        // focus off the outline button and drop a keyboard user's place.
        expect(focus).not.toHaveBeenCalled();
        expect(blur).not.toHaveBeenCalled();
        expect(root.querySelector<HTMLTextAreaElement>('.omni-latex__source')!.selectionStart).toBeGreaterThan(0);
        focus.mockRestore();
        blur.mockRestore();
        dispose();
    });

    it('clears the outline and class badge when a re-parse fails', async () => {
        const source = doc('\\section{One}\ntext\n');
        const container = document.createElement('div');
        const handle = await mountLatexViewer(
            { fileName: 'paper.tex', data: enc(source) },
            container, baseCtx,
            { parse: { limits: { maxInputBytes: source.length + 4 } } }
        );
        const root = container.shadowRoot!;
        expect(root.querySelectorAll('.omni-latex__outline-link')).toHaveLength(1);
        expect(root.querySelector('.omni-latex__meta')?.textContent).toContain('article');

        const area = root.querySelector<HTMLTextAreaElement>('.omni-latex__source')!;
        area.value = `${source}\n% padding pushes it over the byte limit\n`;
        area.dispatchEvent(new Event('input'));
        [...root.querySelectorAll<HTMLButtonElement>('.omni-latex__button')]
            .find(x => x.textContent === 'Render')!.click();
        for (let i = 0; i < 6; i++) await Promise.resolve();

        // A stale outline beside an empty preview invites a click that seeks to
        // a span from a parse that no longer exists.
        expect(root.querySelector('.omni-latex__message')?.textContent).toBeTruthy();
        expect(root.querySelectorAll('.omni-latex__outline-link')).toHaveLength(0);
        expect(root.querySelector('.omni-latex__meta')?.textContent).toBe('');
        handle.dispose();
    });

    it('leaves nothing behind when the signal aborts during include resolution', async () => {
        const controller = new AbortController();
        const container = document.createElement('div');
        let observed = 0;
        let disconnected = 0;
        class Observer {
            observe(): void { observed++; }
            unobserve(): void { /* unused */ }
            disconnect(): void { disconnected++; }
        }
        (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = Observer;
        try {
            const pending = mountLatexViewer(
                { fileName: 'paper.tex', data: enc(doc('$x$\n\n\\input{one}\n')) },
                container, baseCtx,
                {
                    deps: {
                        math: { renderToHtml: () => '<span class="katex">x</span>' },
                        createDOMPurify: () => ({ sanitize: html => html })
                    },
                    signal: controller.signal,
                    // Abort lands while this is in flight — the path that used to
                    // skip most of the teardown.
                    resolveInclude: async () => { controller.abort(); return '\\section{Late}\n'; }
                }
            );
            await expect(pending).rejects.toBeInstanceOf(MountAbortedError);
            expect(container.shadowRoot?.childNodes ?? []).toHaveLength(0);
            expect(container.classList.contains('omni-viewer--latex')).toBe(false);
            expect(observed).toBeGreaterThan(0);
            expect(disconnected).toBe(observed > 0 ? 1 : 0);
        } finally {
            delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
        }
    });

    it('does not accumulate teardown work as the document is re-rendered', async () => {
        const source = doc('\\section{A}\\label{s}\nSee \\ref{s} and \\ref{s} and \\url{https://x.test}.\n');
        const teardownCount = async (renders: number): Promise<number> => {
            const container = document.createElement('div');
            const handle = await mountLatexViewer({ fileName: 'a.tex', data: enc(source) }, container, baseCtx);
            const root = container.shadowRoot!;
            const render = [...root.querySelectorAll<HTMLButtonElement>('.omni-latex__button')]
                .find(x => x.textContent === 'Render')!;
            for (let i = 0; i < renders; i++) render.click();
            const remove = vi.spyOn(EventTarget.prototype, 'removeEventListener');
            handle.dispose();
            const count = remove.mock.calls.length;
            remove.mockRestore();
            return count;
        };
        // Outline entries and reference chips are rebuilt on every render. When
        // their listeners were tracked for teardown, the list — and the detached
        // nodes it kept alive — grew with every render.
        expect(await teardownCount(10)).toBe(await teardownCount(0));
    });

    it('is idempotent on repeated dispose', async () => {
        const { dispose, container } = await mount(doc('text\n'));
        dispose();
        dispose();
        expect(container.shadowRoot?.childNodes).toHaveLength(0);
    });
});
