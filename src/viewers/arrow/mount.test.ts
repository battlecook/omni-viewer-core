// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import * as arrow from 'apache-arrow';
import { createCatalogI18n } from '../../i18n/index.js';
import { arrowViewerCss, mountArrowViewer, type ArrowViewerContext } from './index.js';
import { mountSelfLoadingArrowViewer } from './self-loading.js';
import { MountAbortedError } from '../types.js';

const ctx: ArrowViewerContext = { assets: { resolveAssetUrl: async path => path }, i18n: createCatalogI18n(), logger: { log: vi.fn() } };
const data = arrow.tableToIPC(arrow.tableFromArrays({ id: new Int32Array([3, 1, 2]), name: ['<script>alert(1)</script>', 'alpha', null] }), 'file');
const input = { fileName: 'sample.feather', data };
const button = (root: ParentNode, label: string) => [...root.querySelectorAll('button')].find(item => item.textContent === label)!;

describe('Arrow viewer', () => {
    it('mounts safely, filters, sorts, inspects schema/JSON and disposes its shadow DOM', async () => {
        const container = document.createElement('div');
        const handle = await mountArrowViewer(input, container, ctx, { arrow });
        const root = container.shadowRoot!;
        expect(root.querySelector('style')?.textContent).toContain('.omni-arrow');
        expect(root.querySelectorAll('tbody tr')).toHaveLength(3);
        expect(root.querySelector('script')).toBeNull(); expect(root.textContent).toContain('<script>alert(1)</script>');
        root.querySelector<HTMLButtonElement>('th button')!.click(); expect(root.querySelector('tbody td')?.textContent).toBe('1');
        expect(root.querySelector('th')?.getAttribute('aria-sort')).toBe('ascending');
        const search = root.querySelector('input')!; search.value = 'alpha'; search.dispatchEvent(new Event('input'));
        expect(root.querySelectorAll('tbody tr')).toHaveLength(1);
        button(root, 'Schema').click(); expect(root.querySelector('pre')?.textContent).toContain('Dictionary'); expect(search.disabled).toBe(true);
        button(root, 'JSON').click(); expect(JSON.parse(root.querySelector('pre')!.textContent!).rows).toEqual([[1, 'alpha']]);
        handle.dispose(); handle.dispose(); expect(root.childNodes).toHaveLength(0);
    });
    it('renders partial-preview warnings, page controls, and missing-service affordances', async () => {
        const container = document.createElement('div');
        const handle = await mountArrowViewer(input, container, ctx, { arrow }, { styleIsolation: 'scoped', parse: { previewRows: 1 } });
        expect(container.classList.contains('omni-viewer--arrow')).toBe(true);
        expect(container.querySelector('.omni-arrow__warning')?.textContent).toContain('1 / 3');
        expect(button(container, 'Copy table').disabled).toBe(true); expect(button(container, 'Export JSON').disabled).toBe(true);
        expect(button(container, 'Next page').disabled).toBe(true);
        handle.dispose(); expect(container.childNodes).toHaveLength(0); expect(container.className).toBe('');
    });
    it('hides pagination in schema and JSON views even with the viewer CSS loaded', async () => {
        const style = document.createElement('style'); style.textContent = arrowViewerCss; document.head.append(style);
        const container = document.createElement('div'); document.body.append(container);
        const handle = await mountArrowViewer(input, container, ctx, { arrow }, { styleIsolation: 'scoped' });
        try {
            const footer = container.querySelector('footer')!;
            expect(getComputedStyle(footer).display).toBe('flex');
            for (const label of ['Schema', 'JSON']) {
                button(container, label).click();
                expect(getComputedStyle(footer).display).toBe('none');
            }
            button(container, 'Table').click(); expect(getComputedStyle(footer).display).toBe('flex');
        } finally { handle.dispose(); container.remove(); style.remove(); }
    });
    it('does not submit a host form when scoped toolbar or pagination buttons are clicked', async () => {
        const form = document.createElement('form'), container = document.createElement('div');
        form.append(container); document.body.append(form);
        const submit = vi.fn((event: Event) => event.preventDefault()); form.addEventListener('submit', submit);
        const manyRows = arrow.tableToIPC(arrow.tableFromArrays({ id: Int32Array.from({ length: 101 }, (_, index) => index) }), 'file');
        const handle = await mountArrowViewer({ fileName: 'rows.arrow', data: manyRows }, container,
            { ...ctx, clipboard: { writeText: async () => {} }, save: { saveFile: async () => {} } }, { arrow }, { styleIsolation: 'scoped' });
        try {
            for (const item of container.querySelectorAll('button')) expect(item.type).toBe('button');
            for (const label of ['Copy table', 'Copy JSON', 'Export JSON', 'Next page', 'Previous page']) button(container, label).click();
            expect(submit).not.toHaveBeenCalled();
        } finally { handle.dispose(); form.remove(); }
    });
    it('copies filtered TSV/JSON and exports a preview with the correct filename', async () => {
        const writeText = vi.fn(async (_text: string) => {}), saveFile = vi.fn(async (_name: string, _data: Uint8Array, _mime: string) => ({ status: 'saved' as const }));
        const container = document.createElement('div');
        const handle = await mountArrowViewer(input, container, { ...ctx, clipboard: { writeText }, save: { saveFile } }, { arrow });
        const root = container.shadowRoot!, search = root.querySelector('input')!;
        search.value = 'alpha'; search.dispatchEvent(new Event('input'));
        button(root, 'Copy table').click(); await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
        expect(writeText.mock.calls[0]?.[0]).toBe('id\tname\n1\talpha');
        button(root, 'Copy JSON').click(); await vi.waitFor(() => expect(writeText.mock.calls).toHaveLength(2));
        expect(JSON.parse(writeText.mock.calls[1]![0]!).rows).toEqual([[1, 'alpha']]);
        button(root, 'Export JSON').click(); await vi.waitFor(() => expect(saveFile).toHaveBeenCalled());
        expect(saveFile.mock.calls[0]?.[0]).toBe('sample-export.json'); handle.dispose();
    });
    it('reports unreadable data and Feather V1 using catalog messages', async () => {
        const container = document.createElement('div');
        const handle = await mountArrowViewer({ fileName: 'old.feather', data: new TextEncoder().encode('FEA1') }, container, ctx, { arrow });
        expect(container.shadowRoot?.querySelector('[role=alert]')?.textContent).toContain('Feather V1');
        handle.dispose(); expect(container.shadowRoot?.childNodes).toHaveLength(0);
    });
    it('self-loads optional peers and honors cancellation', async () => {
        const container = document.createElement('div');
        const handle = await mountSelfLoadingArrowViewer(input, container, ctx);
        expect(container.shadowRoot?.querySelectorAll('tbody tr')).toHaveLength(3); handle.dispose();
        const controller = new AbortController(); controller.abort();
        await expect(mountArrowViewer(input, container, ctx, { arrow }, { signal: controller.signal })).rejects.toBeInstanceOf(MountAbortedError);
        await expect(mountSelfLoadingArrowViewer(input, container, ctx, { signal: controller.signal })).rejects.toBeInstanceOf(MountAbortedError);
    });
});
