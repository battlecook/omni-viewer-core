// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { MountAbortedError, type ViewerHandle } from '../types.js';
import { mountFontViewer } from './index.js';

const ctx = { assets: { resolveAssetUrl: vi.fn() }, i18n: createCatalogI18n(), logger: { log: vi.fn() } };
const input = () => ({ fileName: 'LiberationSans.ttf', data: new Uint8Array(readFileSync('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf')) });
const handles: ViewerHandle[] = [];
let fontSet: Set<FontFace>;
let load: () => Promise<unknown>;
let sources: ArrayBuffer[];
class TestFontFace {
    constructor(readonly family: string, source: ArrayBuffer) { sources.push(source); }
    async load() { await load(); return this; }
}
beforeEach(() => {
    fontSet = new Set(); sources = []; load = async () => undefined;
    Object.defineProperty(document, 'fonts', { configurable: true, value: fontSet });
    vi.stubGlobal('FontFace', TestFontFace);
});
afterEach(() => {
    handles.splice(0).forEach(handle => handle.dispose()); document.body.replaceChildren();
    vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function mount(scoped = false, file = input()) {
    const container = document.createElement('div'); document.body.append(container);
    const handle = await mountFontViewer(file, container, ctx, scoped ? { styleIsolation: 'scoped' } : {});
    handles.push(handle);
    return { container, handle, root: scoped ? container : container.shadowRoot! };
}

describe('font viewer', () => {
    it('renders metadata, a real-font specimen, and bounded glyphs in shadow isolation', async () => {
        const file = input(), { root } = await mount(false, file);
        expect(root.querySelector('style')?.textContent).toContain('.omni-font');
        expect(root.querySelector('h2')?.textContent).toBe('Liberation Sans');
        expect(root.querySelector('dl')?.textContent).toContain('TrueType');
        expect(root.querySelector('dl')?.textContent).toContain('2048');
        expect(root.querySelectorAll('[role=listitem]')).toHaveLength(128);
        expect(root.querySelector('.omni-font__preview')?.hasAttribute('hidden')).toBe(false);
        expect(fontSet.size).toBe(1);
        expect(sources[0]?.byteLength).toBe(file.data.length);
        file.data.fill(0);
        expect(new Uint8Array(sources[0]!)[1]).toBe(1);
        expect(ctx.assets.resolveAssetUrl).not.toHaveBeenCalled();
    });

    it('edits sample text safely and adjusts specimen size', async () => {
        const { root } = await mount();
        const text = root.querySelector('textarea')!;
        text.value = '<img src=x onerror=alert(1)>'; text.dispatchEvent(new Event('input'));
        const specimen = root.querySelector<HTMLElement>('.omni-font__specimen')!;
        expect(specimen.textContent).toBe(text.value); expect(specimen.querySelector('img')).toBeNull();
        const size = root.querySelector<HTMLInputElement>('.omni-font__size')!;
        size.value = '72'; size.dispatchEvent(new Event('input'));
        expect(specimen.style.fontSize).toBe('72px'); expect(root.querySelector('output')?.textContent).toBe('72 px');
    });

    it('paginates Unicode glyphs and searches by character or code point', async () => {
        const { root } = await mount();
        const next = root.querySelector<HTMLButtonElement>('.omni-font__next')!, previous = root.querySelector<HTMLButtonElement>('.omni-font__previous')!;
        expect(previous.disabled).toBe(true); next.click();
        expect(root.querySelector('.omni-font__status')?.textContent).toContain('Page 2 /');
        previous.click(); expect(previous.disabled).toBe(true);
        const search = root.querySelector<HTMLInputElement>('input[type=search]')!;
        for (const query of ['U+0041', 'A']) {
            search.value = query; search.dispatchEvent(new Event('input'));
            expect(root.querySelector('.omni-font__grid')?.textContent).toContain('U+0041');
            expect(root.querySelector('.omni-font__status')?.textContent).toContain('Page 1 /');
        }
        search.value = 'U+10FFFF'; search.dispatchEvent(new Event('input'));
        expect(root.querySelector('.omni-font__empty')?.textContent).toBe('No matching characters.');
        expect(previous.disabled).toBe(true); expect(next.disabled).toBe(true);
    });

    it('applies variable axis defaults and updates the specimen when a slider changes', async () => {
        const data = new Uint8Array(64), v = new DataView(data.buffer);
        v.setUint32(0, 0x10000); v.setUint16(4, 1); data.set(new TextEncoder().encode('fvar'), 12);
        v.setUint32(20, 28); v.setUint32(24, 36);
        v.setUint16(32, 16); v.setUint16(36, 1); v.setUint16(38, 20);
        data.set(new TextEncoder().encode('wght'), 44);
        v.setInt32(48, 100 * 65536); v.setInt32(52, 400 * 65536); v.setInt32(56, 900 * 65536);
        const { root } = await mount(false, { fileName: 'variable.ttf', data });
        const specimen = root.querySelector<HTMLElement>('.omni-font__specimen')!;
        expect(specimen.style.fontVariationSettings).toBe('"wght" 400');
        const axis = root.querySelector<HTMLInputElement>('.omni-font__axis')!;
        axis.value = '700'; axis.dispatchEvent(new Event('input'));
        expect(specimen.style.fontVariationSettings).toBe('"wght" 700');
        expect(root.querySelector('.omni-font__axis-value')?.textContent).toBe('700');
    });

    it('disposes fonts and listeners, preserves host content, and supports remounting', async () => {
        const { container, root, handle } = await mount(true);
        const host = document.createElement('p'); host.textContent = 'Host'; container.prepend(host);
        const textarea = root.querySelector('textarea')!, specimen = root.querySelector('.omni-font__specimen')!;
        expect(container.shadowRoot).toBeNull(); expect(root.querySelector('.omni-viewer--font')).not.toBeNull();
        handle.dispose(); handle.dispose();
        expect(fontSet.size).toBe(0); expect(container.textContent).toBe('Host');
        const before = specimen.textContent; textarea.value = 'after disposal'; textarea.dispatchEvent(new Event('input'));
        expect(specimen.textContent).toBe(before);
        handles.push(await mountFontViewer(input(), container, ctx));
        expect(container.shadowRoot?.querySelectorAll('style')).toHaveLength(1);
        expect(fontSet.size).toBe(1);
    });

    it('uses a unique family for each simultaneous viewer', async () => {
        const first = await mount(), second = await mount();
        expect(first.root.querySelector<HTMLElement>('.omni-font__specimen')?.style.fontFamily)
            .not.toBe(second.root.querySelector<HTMLElement>('.omni-font__specimen')?.style.fontFamily);
        expect(fontSet.size).toBe(2); first.handle.dispose(); expect(fontSet.size).toBe(1);
    });

    it('keeps metadata available when the font API is absent or loading fails', async () => {
        load = async () => { throw new Error('Font rejected'); };
        const rejected = await mount();
        expect(rejected.root.textContent).toContain('Font rendering is unavailable.');
        expect(rejected.root.querySelector('.omni-font__preview')?.hasAttribute('hidden')).toBe(true);
        vi.stubGlobal('FontFace', undefined);
        const absent = await mount();
        expect(absent.root.textContent).toContain('Liberation Sans'); expect(fontSet.size).toBe(0);
    });

    it('rejects pre-aborted or invalid inputs without acquiring resources', async () => {
        const controller = new AbortController(); controller.abort();
        const container = document.createElement('div');
        await expect(mountFontViewer(input(), container, ctx, { signal: controller.signal })).rejects.toBeInstanceOf(MountAbortedError);
        await expect(mountFontViewer({ fileName: 'bad.ttf', data: new Uint8Array([1, 2, 3, 4]) }, container, ctx)).rejects.toThrow('Unsupported font');
        expect(container.childNodes).toHaveLength(0); expect(container.shadowRoot).toBeNull(); expect(fontSet.size).toBe(0);
    });

    it('aborts pending font loading promptly and never registers the late font', async () => {
        let resolveLoad!: () => void, started!: () => void;
        const loading = new Promise<void>(resolve => { started = resolve; });
        load = () => { started(); return new Promise<void>(resolve => { resolveLoad = resolve; }); };
        const controller = new AbortController(), container = document.createElement('div');
        const pending = mountFontViewer(input(), container, ctx, { signal: controller.signal });
        const assertion = expect(pending).rejects.toBeInstanceOf(MountAbortedError);
        await loading; controller.abort(); await assertion;
        resolveLoad(); await Promise.resolve();
        expect(container.shadowRoot).toBeNull(); expect(fontSet.size).toBe(0);
    });

    it('keeps font file names as plain text and localizes the interface', async () => {
        const container = document.createElement('div');
        handles.push(await mountFontViewer({ ...input(), fileName: '<script>alert(1)</script>.ttf' }, container, { ...ctx, i18n: createCatalogI18n('ko') }));
        expect(container.shadowRoot?.textContent).toContain('<script>alert(1)</script>.ttf');
        expect(container.shadowRoot?.querySelector('script')).toBeNull();
        expect(container.shadowRoot?.textContent).toContain('샘플 문구');
    });
});
