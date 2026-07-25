// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../i18n/index.js';
import { createDiagramController } from './diagram-controller.js';
import { mountDiagramViewer, type DiagramViewerContext } from './diagram.js';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>';

function makeContext(extra: Partial<DiagramViewerContext> = {}): DiagramViewerContext {
    return {
        assets: { resolveAssetUrl: async (path: string) => path },
        i18n: createCatalogI18n(),
        logger: { log: () => undefined },
        ...extra
    };
}
function query<E extends Element>(container: HTMLElement, selector: string): E {
    return container.shadowRoot!.querySelector<E>(selector)!;
}
const flush = async (): Promise<void> => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

describe('diagram controller', () => {
    it('tracks dirty and round-trips undo/redo, capping history at 100', () => {
        const c = createDiagramController('a', 'default');
        expect(c.state.dirty).toBe(false);
        c.dispatch({ type: 'edit-source', source: 'ab' });
        expect(c.state.dirty).toBe(true);
        expect(c.state.canUndo).toBe(true);
        c.dispatch({ type: 'undo' });
        expect(c.state.source).toBe('a');
        expect(c.state.dirty).toBe(false);
        c.dispatch({ type: 'redo' });
        expect(c.state.source).toBe('ab');
        c.dispatch({ type: 'mark-saved' });
        expect(c.state.dirty).toBe(false);
        for (let i = 0; i < 150; i++) c.dispatch({ type: 'edit-source', source: `v${i}` });
        let depth = 0;
        while (c.state.canUndo) { c.dispatch({ type: 'undo' }); depth++; }
        expect(depth).toBe(100);
    });
    it('stores the theme set by the view', () => {
        const c = createDiagramController('a', 'default');
        c.dispatch({ type: 'set-theme', theme: 'dark' });
        expect(c.state.theme).toBe('dark');
    });
});

describe('diagram viewer mount', () => {
    it('renders the SVG into the stage and starts in diagram mode', async () => {
        const container = document.createElement('div');
        await mountDiagramViewer('mermaid', { source: 'flowchart TD\nA-->B', warnings: [] },
            { fileName: 'graph.mmd', data: new Uint8Array() }, container, makeContext(),
            { renderMermaid: async () => SVG });
        expect(query(container, '.omni-diagram__stage svg')).toBeTruthy();
        expect(query<HTMLTextAreaElement>(container, '.omni-diagram__source').value).toContain('flowchart');
        expect(query(container, '.omni-diagram__stage-panel').hasAttribute('hidden')).toBe(false);
    });

    it('falls back to source editing when no renderer is available', async () => {
        const container = document.createElement('div');
        await mountDiagramViewer('plantuml', { source: '@startuml\nA->B\n@enduml', warnings: [] },
            { fileName: 'graph.puml', data: new Uint8Array() }, container, makeContext());
        expect(query(container, '.omni-diagram__stage-panel').hasAttribute('hidden')).toBe(true);
        expect(query<HTMLTextAreaElement>(container, '.omni-diagram__source').value).toContain('@startuml');
        expect(query(container, '.omni-diagram__message').textContent).toBeTruthy();
    });

    it('re-renders with the selected theme', async () => {
        const container = document.createElement('div');
        const renderMermaid = vi.fn(async (_id: string, _source: string, _theme?: string) => SVG);
        await mountDiagramViewer('mermaid', { source: 'flowchart TD\nA-->B', warnings: [] },
            { fileName: 'g.mmd', data: new Uint8Array() }, container, makeContext(), { renderMermaid });
        const select = query<HTMLSelectElement>(container, '.omni-diagram__select');
        select.value = 'dark';
        select.dispatchEvent(new Event('change'));
        await flush();
        expect(renderMermaid).toHaveBeenCalledTimes(2);
        expect(renderMermaid.mock.calls[1]![2]).toBe('dark');
    });

    it('saves through writeback and marks the source clean', async () => {
        const container = document.createElement('div');
        const write = vi.fn(async () => undefined);
        await mountDiagramViewer('mermaid', { source: 'flowchart TD\nA-->B', warnings: [] },
            { fileName: 'g.mmd', data: new Uint8Array() }, container, makeContext({ writeback: { write } }),
            { renderMermaid: async () => SVG });
        const source = query<HTMLTextAreaElement>(container, '.omni-diagram__source');
        source.value = 'flowchart TD\nA-->C';
        source.dispatchEvent(new Event('input'));
        query<HTMLButtonElement>(container, '.omni-diagram__button--primary').click();
        await flush();
        expect(write).toHaveBeenCalledTimes(1);
        expect(query(container, '.omni-diagram__status').classList.contains('is-valid')).toBe(true);
    });

    it('copies the source through the clipboard service', async () => {
        const container = document.createElement('div');
        const writeText = vi.fn(async () => undefined);
        await mountDiagramViewer('mermaid', { source: 'flowchart TD\nA-->B', warnings: [] },
            { fileName: 'g.mmd', data: new Uint8Array() }, container, makeContext({ clipboard: { writeText } }),
            { renderMermaid: async () => SVG });
        const copySource = [...container.shadowRoot!.querySelectorAll<HTMLButtonElement>('.omni-diagram__button')]
            .find(b => b.textContent === createCatalogI18n().t('diagram.copySource'))!;
        copySource.click();
        await flush();
        expect(writeText).toHaveBeenCalledWith('flowchart TD\nA-->B');
    });

    it('clamps zoom between 25% and 300%', async () => {
        const container = document.createElement('div');
        await mountDiagramViewer('mermaid', { source: 'flowchart TD\nA-->B', warnings: [] },
            { fileName: 'g.mmd', data: new Uint8Array() }, container, makeContext(), { renderMermaid: async () => SVG });
        const label = query(container, '.omni-diagram__zoom-label');
        const zoomButtons = [...container.shadowRoot!.querySelectorAll<HTMLButtonElement>('.omni-diagram__toolbar-group:nth-child(3) .omni-diagram__button')];
        const out = zoomButtons[0]!; const inc = zoomButtons[1]!;
        for (let i = 0; i < 20; i++) inc.click();
        expect(label.textContent).toBe('300%');
        for (let i = 0; i < 20; i++) out.click();
        expect(label.textContent).toBe('25%');
    });
});
