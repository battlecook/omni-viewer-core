// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { HostContext } from '../../host/index.js';
import { createCatalogI18n } from '../../i18n/index.js';
import { MountAbortedError } from '../types.js';
import { mountJsonViewer, type JsonViewerContext } from './index.js';

const enc = new TextEncoder();

function stubCtx(
    clipboard?: JsonViewerContext['clipboard'],
    save?: JsonViewerContext['save'],
    writeback?: JsonViewerContext['writeback']
): JsonViewerContext {
    const base: HostContext = {
        assets: { resolveAssetUrl: async (p) => p },
        i18n: createCatalogI18n(),
        logger: { log: () => undefined }
    };
    return {
        ...base,
        ...(clipboard ? { clipboard } : {}),
        ...(save ? { save } : {}),
        ...(writeback ? { writeback } : {})
    };
}

function jsonInput(text: string, fileName = 'test.json') {
    return { fileName, data: enc.encode(text) };
}

function shadow(container: HTMLElement): ShadowRoot {
    const root = container.shadowRoot;
    if (!root) throw new Error('expected shadow root');
    return root;
}

function button(root: ParentNode, label: string): HTMLButtonElement {
    const btn = [...root.querySelectorAll('button')].find(
        (b) => b.textContent === label
    );
    if (!btn) throw new Error(`button "${label}" not found`);
    return btn as HTMLButtonElement;
}

describe('mountJsonViewer', () => {
    it('renders an editable source pane and tree preview by default', async () => {
        const container = document.createElement('div');
        const handle = await mountJsonViewer(jsonInput('{"a":1}'), container, stubCtx());
        const root = shadow(container);
        expect(root.querySelector('.omni-json')).not.toBeNull();
        expect(root.querySelector('.omni-json__editor')).not.toBeNull();
        expect(root.querySelector('.omni-json__tree')).not.toBeNull();
        handle.dispose();
        expect(root.childNodes.length).toBe(0);
    });

    it('updates the preview as source text changes', async () => {
        const container = document.createElement('div');
        await mountJsonViewer(jsonInput('{"a":1}'), container, stubCtx());
        const root = shadow(container);
        button(root, 'Source').click();
        const editor = root.querySelector('.omni-json__editor') as HTMLTextAreaElement;
        editor.value = '{"changed":true}';
        editor.dispatchEvent(new Event('input'));
        expect(root.querySelector('.omni-json__source')?.textContent).toBe('{"changed":true}');
        expect(root.querySelector('.omni-json__source .jv-tok-key')?.textContent).toBe('"changed"');
        expect(root.querySelector('.omni-json__editor-highlight .jv-tok-key')?.textContent).toBe('"changed"');
    });

    it('saves the edited JSON as a new JSON file through the host save service', async () => {
        const saveFile = vi.fn(async () => undefined);
        const container = document.createElement('div');
        await mountJsonViewer(jsonInput('{"a":1}', 'data'), container, stubCtx(undefined, { saveFile }));
        const root = shadow(container);
        const editor = root.querySelector('.omni-json__editor') as HTMLTextAreaElement;
        editor.value = '{"saved":true}';
        editor.dispatchEvent(new Event('input'));
        button(root, 'Save as').click();
        await Promise.resolve();
        expect(saveFile).toHaveBeenCalledWith(
            'data.json',
            new TextEncoder().encode('{"saved":true}'),
            'application/json'
        );
    });

    it('saves to the original file only when writeback is available', async () => {
        const write = vi.fn(async () => undefined);
        const container = document.createElement('div');
        await mountJsonViewer(jsonInput('{"a":1}'), container, stubCtx(undefined, undefined, { write }));
        const root = shadow(container);
        button(root, 'Save').click();
        await Promise.resolve();
        expect(write).toHaveBeenCalledWith(new TextEncoder().encode('{"a":1}'));
        expect(button(root, 'Save as').disabled).toBe(true);
    });

    it('places the tree control in the preview pane and keeps the editor visible', async () => {
        const container = document.createElement('div');
        await mountJsonViewer(jsonInput('{"a":1}'), container, stubCtx());
        const root = shadow(container);
        const source = button(root, 'Source');
        expect(root.querySelector('.omni-json__preview-pane')?.contains(source)).toBe(true);
        expect(root.querySelector('.omni-json__tree')).not.toBeNull();
        expect(root.querySelector('.omni-json__editor')).not.toBeNull();
    });

    it('highlights source matches in both editor and preview', async () => {
        const container = document.createElement('div');
        await mountJsonViewer(jsonInput('{"file":"file_walker"}'), container, stubCtx());
        const root = shadow(container);
        button(root, 'Source').click();
        const search = root.querySelector('.omni-json__search') as HTMLInputElement;
        search.value = 'file';
        search.dispatchEvent(new Event('input'));
        expect(root.querySelectorAll('.omni-json__editor-highlight .omni-json__search-hit')).toHaveLength(2);
        expect(root.querySelectorAll('.omni-json__source .omni-json__search-hit')).toHaveLength(2);
    });

    it('renders a tree when switched to tree mode', async () => {
        const container = document.createElement('div');
        await mountJsonViewer(jsonInput('{"a":1,"b":[2,3]}'), container, stubCtx());
        const root = shadow(container);
        const keys = [...root.querySelectorAll('.omni-json__key')].map((k) => k.textContent);
        expect(keys).toContain('a');
        expect(keys).toContain('b');
    });

    it('toggles a container node from the tree', async () => {
        const container = document.createElement('div');
        await mountJsonViewer(jsonInput('{"a":{"b":{"c":1}}}'), container, stubCtx());
        const root = shadow(container);
        // Depth-2 node ($.a.b) starts collapsed; its child 'c' isn't rendered.
        expect([...root.querySelectorAll('.omni-json__key')].map((k) => k.textContent)).not.toContain('c');
        const toggles = [...root.querySelectorAll('.omni-json__toggle')] as HTMLElement[];
        // Expand $.a.b (third toggle: $, $.a, $.a.b).
        toggles[2]!.click();
        expect([...root.querySelectorAll('.omni-json__key')].map((k) => k.textContent)).toContain('c');
    });

    it('renders container toggles as focusable buttons (a11y, P2b)', async () => {
        const container = document.createElement('div');
        await mountJsonViewer(jsonInput('{"a":{"b":1}}'), container, stubCtx());
        const root = shadow(container);
        const toggle = root.querySelector('.omni-json__toggle');
        expect(toggle?.tagName).toBe('BUTTON');
        expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    });

    it('opens the result panel for a converter (routing J11)', async () => {
        const container = document.createElement('div');
        await mountJsonViewer(jsonInput('[{"a":1}]'), container, stubCtx());
        const root = shadow(container);
        expect((root.querySelector('.omni-json__result') as HTMLElement).style.display).toBe('none');
        button(root, '→ CSV').click();
        const panel = root.querySelector('.omni-json__result') as HTMLElement;
        expect(panel.style.display).not.toBe('none');
        expect((root.querySelector('.omni-json__result-output') as HTMLTextAreaElement).value).toBe('a\n1');
        expect(root.querySelectorAll('.omni-json__result-table th')).toHaveLength(1);
        expect(root.querySelector('.omni-json__result-table td')?.textContent).toBe('1');
        const body = root.querySelector('.omni-json__body') as HTMLElement;
        expect(panel.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('syntax-highlights XML tags and YAML keys in converter output', async () => {
        const container = document.createElement('div');
        await mountJsonViewer(jsonInput('{"name":"Omni"}'), container, stubCtx());
        const root = shadow(container);
        button(root, '→ XML').click();
        expect(Array.from(root.querySelectorAll('.omni-json__result-tag')).map((node) => node.textContent).join('')).toContain('<root>');
        expect(Array.from(root.querySelectorAll('.omni-json__result-value')).map((node) => node.textContent).join('')).toContain('Omni');

        button(root, '→ YAML').click();
        expect(root.querySelector('.omni-json__result-key')?.textContent).toContain('name:');
        expect(root.querySelector('.omni-json__result-value')?.textContent).toContain('Omni');
    });

    it('reflects a transform in the verbatim editor (routing J11)', async () => {
        const container = document.createElement('div');
        await mountJsonViewer(jsonInput('{ "a" : 1 }'), container, stubCtx());
        const root = shadow(container);
        (root.querySelector('select') as HTMLSelectElement).value = 'verbatim';
        (root.querySelector('select') as HTMLSelectElement).dispatchEvent(new Event('change'));
        button(root, 'Minify').click();
        expect((root.querySelector('.omni-json__editor') as HTMLTextAreaElement).value).toBe('{"a":1}');
    });

    it('copies a node value via the clipboard service', async () => {
        const writeText = vi.fn(async () => undefined);
        const container = document.createElement('div');
        await mountJsonViewer(jsonInput('{"a":42}'), container, stubCtx({ writeText }));
        const root = shadow(container);
        // The leaf $.a Value button is the last one (root's is first).
        const valueBtns = [...root.querySelectorAll('button')].filter((b) => b.textContent === 'Value');
        valueBtns[valueBtns.length - 1]!.click();
        expect(writeText).toHaveBeenCalledWith('42');
    });

    it('disables copy controls without a clipboard service (degraded mode)', async () => {
        const container = document.createElement('div');
        await mountJsonViewer(jsonInput('{"a":1}'), container, stubCtx());
        const root = shadow(container);
        expect(button(root, 'Value').disabled).toBe(true);
    });

    it('shows a failure notice for broken JSON but keeps the source (J20)', async () => {
        const container = document.createElement('div');
        await mountJsonViewer(jsonInput('not json'), container, stubCtx());
        const root = shadow(container);
        expect(root.querySelector('.omni-json__diag-error')).not.toBeNull();
        (root.querySelector('select') as HTMLSelectElement).value = 'verbatim';
        (root.querySelector('select') as HTMLSelectElement).dispatchEvent(new Event('change'));
        expect((root.querySelector('.omni-json__editor') as HTMLTextAreaElement).value).toBe('not json');
    });

    it('rejects with MountAbortedError when the signal is aborted', async () => {
        const container = document.createElement('div');
        const controller = new AbortController();
        controller.abort();
        await expect(
            mountJsonViewer(jsonInput('{"a":1}'), container, stubCtx(), {
                signal: controller.signal
            })
        ).rejects.toBeInstanceOf(MountAbortedError);
    });
});
