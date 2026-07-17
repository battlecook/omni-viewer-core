// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { HWP_MAX_RENDERED_PAGES, HwpViewerError, mountHwpViewer, type RhwpDocument } from './index.js';

const context = { assets: { resolveAssetUrl: async (path: string) => path }, i18n: createCatalogI18n(), logger: { log: () => undefined } };

describe('mountHwpViewer', () => {
    it('renders every WASM page as SVG and frees the document', async () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText: () => ({ width: 10 }) } as unknown as CanvasRenderingContext2D);
        const free = vi.fn();
        class Document implements RhwpDocument { pageCount() { return 2; } renderPageSvg(index: number) { return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="120"><text>${index + 1}</text></svg>`; } free = free; }
        const container = document.createElement('div');
        const handle = await mountHwpViewer({ fileName: 'sample.hwp', data: new Uint8Array([1, 2]) }, container, context, { loadRhwp: async () => ({ HwpDocument: Document }) });
        expect(container.shadowRoot?.querySelectorAll('.omni-hwp__page')).toHaveLength(2);
        expect(container.shadowRoot?.querySelector('.omni-hwp__page')?.getAttribute('aria-label')).toBe('Page 1');
        expect(container.shadowRoot?.querySelector('.omni-hwp__meta')?.textContent).toContain('2 pages');
        expect(free).toHaveBeenCalledOnce(); handle.dispose(); expect(free).toHaveBeenCalledOnce();
    });

    it('rejects missing dependencies so the host can enter the fallback chain', async () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const container = document.createElement('div');
        await expect(mountHwpViewer({ fileName: 'sample.hwpx', data: new Uint8Array() }, container, context)).rejects.toMatchObject({ code: 'missing-dependency' });
        expect(container.shadowRoot?.childElementCount).toBe(0);
        await expect(mountHwpViewer({ fileName: 'sample.hwp', data: new Uint8Array() }, document.createElement('div'), context, { loadRhwp: async () => { throw new Error('wasm unavailable'); } })).rejects.toMatchObject({ code: 'missing-dependency' });
    });

    it('sanitizes active SVG content and external references', async () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        class Document implements RhwpDocument { pageCount() { return 1; } renderPageSvg() { return '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject><div>bad</div></foreignObject><a href="https://evil.test"><text style="fill:url(https://evil.test/x)">safe</text></a><rect fill="url(https://evil.test/x)"/></svg>'; } }
        const container = document.createElement('div');
        const handle = await mountHwpViewer({ fileName: 'sample.hwp', data: new Uint8Array() }, container, context, { loadRhwp: async () => ({ HwpDocument: Document }) });
        const svg = container.shadowRoot?.querySelector('svg');
        expect(svg?.querySelector('script, foreignObject')).toBeNull(); expect(svg?.hasAttribute('onload')).toBe(false);
        expect(svg?.querySelector('a')?.hasAttribute('href')).toBe(false); expect(svg?.querySelector('text')?.hasAttribute('style')).toBe(false); expect(svg?.querySelector('rect')?.hasAttribute('fill')).toBe(false);
        handle.dispose();
    });

    it('preserves rhwp raster images and local SVG paint references', async () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        class Document implements RhwpDocument { pageCount() { return 1; } renderPageSvg() { return '<svg xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="clip1"><rect width="10" height="10"/></clipPath><linearGradient id="gradient1"><stop offset="0"/></linearGradient><path id="shape1" d="M0 0h10v10z"/></defs><image href="data:image/png;base64,iVBORw0KGgo=" clip-path="url(#clip1)"/><image href="data:image/bmp;base64,Qk0="/><image href="data:image/tiff;base64,SUk="/><use href="#shape1" fill="url(#gradient1)"/><rect style="clip-path:url(#clip1);fill:url(#gradient1)"/></svg>'; } }
        const container = document.createElement('div');
        const handle = await mountHwpViewer({ fileName: 'rich.hwp', data: new Uint8Array() }, container, context, { loadRhwp: async () => ({ HwpDocument: Document }) });
        const svg = container.shadowRoot?.querySelector('svg');
        expect(svg?.querySelector('image')?.getAttribute('href')).toMatch(/^data:image\/png/);
        expect([...svg?.querySelectorAll('image') ?? []].map((node) => node.getAttribute('href'))).toEqual(expect.arrayContaining([expect.stringMatching(/^data:image\/bmp/), expect.stringMatching(/^data:image\/tiff/)]));
        expect(svg?.querySelector('image')?.getAttribute('clip-path')).toBe('url(#clip1)');
        expect(svg?.querySelector('use')?.getAttribute('href')).toBe('#shape1');
        expect(svg?.querySelector('use')?.getAttribute('fill')).toBe('url(#gradient1)');
        expect(svg?.querySelector('rect[style]')).not.toBeNull(); handle.dispose();
    });

    it('loads every page in bounded batches while freeing each WASM document', async () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const free = vi.fn(); class Document implements RhwpDocument { pageCount() { return HWP_MAX_RENDERED_PAGES * 2 + 50; } renderPageSvg() { return '<svg xmlns="http://www.w3.org/2000/svg"/>'; } free = free; }
        const container = document.createElement('div');
        const handle = await mountHwpViewer({ fileName: 'large.hwp', data: new Uint8Array() }, container, context, { loadRhwp: async () => ({ HwpDocument: Document }) });
        expect(container.shadowRoot?.querySelectorAll('.omni-hwp__page')).toHaveLength(HWP_MAX_RENDERED_PAGES);
        expect(container.shadowRoot?.querySelector('.omni-hwp__status')?.textContent).toContain('first 100 of 250');
        expect(free).toHaveBeenCalledOnce(); (container.shadowRoot?.querySelector('.omni-hwp__load-more') as HTMLButtonElement).click(); await Promise.resolve();
        expect(container.shadowRoot?.querySelectorAll('.omni-hwp__page')).toHaveLength(200); expect(free).toHaveBeenCalledTimes(2);
        const more = container.shadowRoot?.querySelector('.omni-hwp__load-more') as HTMLButtonElement; expect(more.disabled).toBe(false); more.click(); await Promise.resolve();
        expect(container.shadowRoot?.querySelectorAll('.omni-hwp__page')).toHaveLength(250); expect(free).toHaveBeenCalledTimes(3); expect(container.shadowRoot?.querySelector('.omni-hwp__status')).toBeNull();
        handle.dispose();
    });

    it('cleans partial DOM and WASM state when a page fails mid-render', async () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); const free = vi.fn();
        class Document implements RhwpDocument { pageCount() { return 3; } renderPageSvg(index: number) { if (index === 1) throw new Error('bad page'); return '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>'; } free = free; }
        const container = document.createElement('div');
        await expect(mountHwpViewer({ fileName: 'bad-page.hwp', data: new Uint8Array() }, container, context, { loadRhwp: async () => ({ HwpDocument: Document }) })).rejects.toMatchObject({ code: 'corrupted' });
        expect(free).toHaveBeenCalledOnce(); expect(container.shadowRoot?.childElementCount).toBe(0);
    });

    it('handles button and Ctrl/Cmd-wheel zoom and detaches clicks on dispose', async () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        class Document implements RhwpDocument { pageCount() { return 0; } renderPageSvg() { return ''; } }
        const container = document.createElement('div'); const handle = await mountHwpViewer({ fileName: 'zoom.hwp', data: new Uint8Array() }, container, context, { loadRhwp: async () => ({ HwpDocument: Document }) });
        const zoomIn = container.shadowRoot?.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement; const viewport = container.shadowRoot?.querySelector('.omni-hwp__viewport') as HTMLElement;
        zoomIn.click(); expect(handle.controller.state.zoom).toBe(1.1); viewport.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -1, cancelable: true })); expect(handle.controller.state.zoom).toBe(1.2);
        viewport.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true })); document.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: '+', cancelable: true })); expect(handle.controller.state.zoom).toBe(1.3);
        handle.dispose(); zoomIn.click(); document.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: '+' })); expect(handle.controller.state.zoom).toBe(1.3);
    });

    it('shows loading UI while the rhwp dependency is pending', async () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        class Document implements RhwpDocument { pageCount() { return 0; } renderPageSvg() { return ''; } }
        let resolve!: (module: { HwpDocument: typeof Document }) => void; const pending = new Promise<{ HwpDocument: typeof Document }>((done) => { resolve = done; });
        const container = document.createElement('div'); const mounting = mountHwpViewer({ fileName: 'slow.hwp', data: new Uint8Array() }, container, context, { loadRhwp: async () => pending });
        expect(container.shadowRoot?.querySelector('.omni-hwp__loading')?.textContent).toContain('Loading HWP/HWPX');
        resolve({ HwpDocument: Document }); const handle = await mounting; expect(container.shadowRoot?.querySelector('.omni-hwp__loading')).toBeNull(); handle.dispose();
    });

    it('maps damaged input to a typed fallback error', async () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        class Document { constructor() { throw new Error('parser details'); } }
        await expect(mountHwpViewer({ fileName: 'bad.hwp', data: new Uint8Array() }, document.createElement('div'), context, { loadRhwp: async () => ({ HwpDocument: Document as never }) })).rejects.toBeInstanceOf(HwpViewerError);
    });

    it('keeps the shared text measurement hook until the last viewer disposes', async () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const target = globalThis as typeof globalThis & { measureTextWidth?: (font: string, text: string) => number };
        const original = () => 7; target.measureTextWidth = original;
        class Document implements RhwpDocument { pageCount() { return 0; } renderPageSvg() { return ''; } }
        const deps = { loadRhwp: async () => ({ HwpDocument: Document }) };
        const first = await mountHwpViewer({ fileName: 'a.hwp', data: new Uint8Array() }, document.createElement('div'), context, deps);
        const shared = target.measureTextWidth; const second = await mountHwpViewer({ fileName: 'b.hwp', data: new Uint8Array() }, document.createElement('div'), context, deps);
        first.dispose(); expect(target.measureTextWidth).toBe(shared);
        second.dispose(); expect(target.measureTextWidth).toBe(original); delete target.measureTextWidth;
    });

    it('releases owned styles and scoped container classes', async () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        class Document implements RhwpDocument { pageCount() { return 0; } renderPageSvg() { return ''; } }
        const deps = { loadRhwp: async () => ({ HwpDocument: Document }) };
        const shadowContainer = document.createElement('div'); const shadow = await mountHwpViewer({ fileName: 'a.hwp', data: new Uint8Array() }, shadowContainer, context, deps);
        expect(shadowContainer.shadowRoot?.querySelector('style')).not.toBeNull(); shadow.dispose(); expect(shadowContainer.shadowRoot?.childElementCount).toBe(0);
        const scopedContainer = document.createElement('div'); const scoped = await mountHwpViewer({ fileName: 'b.hwp', data: new Uint8Array() }, scopedContainer, context, deps, { styleIsolation: 'scoped' });
        expect(scopedContainer.classList.contains('omni-viewer--hwp')).toBe(true); scoped.dispose(); expect(scopedContainer.className).toBe('');
    });
});
