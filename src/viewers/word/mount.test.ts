// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { HostContext, PrintService } from '../../host/index.js';
import { createCatalogI18n } from '../../i18n/index.js';
import { mountWordViewer, type WordViewerContext } from './index.js';
import type { ZipModule } from './docx-preprocess.js';

const ctx = (print?: PrintService): WordViewerContext => ({
    assets: { resolveAssetUrl: async (path) => path }, i18n: createCatalogI18n(), logger: { log: () => undefined }, ...(print ? { print } : {})
});
const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const zip = { loadAsync: async () => { const archive = { file: (() => null) as never, forEach: () => undefined, generateAsync: async () => docx }; return archive; } } as ZipModule;
const deps = (renderAsync: (...args: any[]) => Promise<unknown>) => ({ loadDocxPreview: async () => ({ renderAsync }), loadZip: async () => zip });

describe('mountWordViewer', () => {
    it('renders docx-preview in a shadow root and disposes cleanly', async () => {
        const renderAsync = vi.fn(async (_data, body: HTMLElement) => { body.append(document.createElement('article')); });
        const container = document.createElement('div');
        const handle = await mountWordViewer({ fileName: 'sample.docx', data: docx }, container, ctx(), deps(renderAsync));
        expect(renderAsync).toHaveBeenCalledOnce();
        expect(container.shadowRoot?.querySelector('[role="document"] article')).not.toBeNull();
        handle.dispose();
        expect(container.shadowRoot?.querySelector('.omni-word')).toBeNull();
    });

    it('shows a visible dependency error instead of a blank frame', async () => {
        const container = document.createElement('div');
        await mountWordViewer({ fileName: 'sample.docx', data: docx }, container, ctx());
        expect(container.shadowRoot?.querySelector('.omni-word__error')?.textContent).toContain('not installed');
    });

    it('supports zoom controls and degrades print explicitly', async () => {
        const container = document.createElement('div');
        const handle = await mountWordViewer({ fileName: 'sample.docx', data: docx }, container, ctx(), deps(async () => undefined));
        const buttons = [...(container.shadowRoot?.querySelectorAll('button') ?? [])] as HTMLButtonElement[];
        buttons.find((button) => button.getAttribute('aria-label') === 'Zoom in')?.click();
        expect(handle.controller.state.zoom).toBe(1.1);
        const print = buttons.find((button) => button.getAttribute('aria-label') === 'Print');
        expect(print?.disabled).toBe(true);
    });

    it('uses the host print service', async () => {
        const print = { print: vi.fn() };
        const container = document.createElement('div');
        await mountWordViewer({ fileName: 'sample.docx', data: docx }, container, ctx(print), deps(async () => undefined));
        const button = [...(container.shadowRoot?.querySelectorAll('button') ?? [])].find((node) => node.getAttribute('aria-label') === 'Print') as HTMLButtonElement;
        button.click(); expect(print.print).toHaveBeenCalledOnce();
    });

    it('blocks remote resources and routes allowed links through navigation', async () => {
        const openExternalUrl = vi.fn(async () => undefined); const container = document.createElement('div');
        const render = async (_data: unknown, body: HTMLElement): Promise<void> => { const anchor = document.createElement('a'); anchor.href = 'https://example.com/path'; anchor.textContent = 'safe'; const image = document.createElement('img'); image.src = 'https://tracker.example/pixel'; body.append(anchor, image); };
        await mountWordViewer({ fileName: 'sample.docx', data: docx }, container, { ...ctx(), navigation: { openExternalUrl } }, deps(render));
        const anchor = container.shadowRoot?.querySelector('a') as HTMLAnchorElement; const image = container.shadowRoot?.querySelector('img') as HTMLImageElement;
        expect(anchor.hasAttribute('href')).toBe(false); expect(image.hasAttribute('src')).toBe(false); anchor.click(); expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/path');
    });

    it('logs explicit degraded-mode warnings when legacy embedded deps are absent', async () => {
        const log = vi.fn(); const container = document.createElement('div');
        await mountWordViewer({ fileName: 'legacy.doc', data: new Uint8Array([1, 2, 3]) }, container, { ...ctx(), logger: { log } });
        expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('loadSheet'));
        expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('loadZip'));
    });
});
