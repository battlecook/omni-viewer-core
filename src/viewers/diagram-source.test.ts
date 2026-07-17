// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createCatalogI18n } from '../i18n/index.js';
import { mountDiagramViewer } from './diagram.js';

const context = {
    assets: { resolveAssetUrl: async (path: string) => path },
    i18n: createCatalogI18n(),
    logger: { log: () => undefined }
};

describe('diagram source disclosure', () => {
    it('keeps source collapsed after a successful render', async () => {
        const container = document.createElement('div');
        await mountDiagramViewer(
            'mermaid',
            { source: 'flowchart TD\nA-->B', warnings: [] },
            { fileName: 'graph.mmd', data: new Uint8Array() },
            container,
            context,
            { renderMermaid: async () => '<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>' }
        );
        expect(container.shadowRoot?.querySelector<HTMLDetailsElement>('.omni-diagram__source-details')?.open).toBe(false);
    });

    it('expands source when no renderer is available', async () => {
        const container = document.createElement('div');
        await mountDiagramViewer(
            'plantuml',
            { source: '@startuml\nA->B\n@enduml', warnings: [] },
            { fileName: 'graph.puml', data: new Uint8Array() },
            container,
            context
        );
        const details = container.shadowRoot?.querySelector<HTMLDetailsElement>('.omni-diagram__source-details');
        expect(details?.open).toBe(true);
        expect(details?.querySelector('pre')?.textContent).toContain('@startuml');
    });
});
