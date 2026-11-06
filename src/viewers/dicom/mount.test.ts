// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { concat, dicomFixture, element } from '../../parsers/dicom/__tests__/fixture.js';
import { MountAbortedError, type ViewerHandle } from '../types.js';
import { mountDicomViewer } from './index.js';
const ctx = { assets: { resolveAssetUrl: vi.fn() }, i18n: createCatalogI18n(), logger: { log: vi.fn() } };
let rendered: Uint8ClampedArray[];
const handles: ViewerHandle[] = [];
beforeEach(() => {
    rendered = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
        putImageData: (data: ImageData) => { rendered.push(data.data.slice()); }
    } as never);
});
afterEach(() => { handles.splice(0).forEach(h => h.dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); });
async function mount(data = dicomFixture(), scoped = false, fileName = 'scan.dcm') {
    const container = document.createElement('div'); document.body.append(container);
    const handle = await mountDicomViewer({ fileName, data }, container, ctx, scoped ? { styleIsolation: 'scoped' } : {});
    handles.push(handle); return { container, handle, root: scoped ? container : container.shadowRoot! };
}
const input = (root: HTMLElement | ShadowRoot, name: string, value: string) => {
    const node = root.querySelector<HTMLInputElement>(`.omni-dicom__${name}`)!; node.value = value; node.dispatchEvent(new Event('input')); return node;
};
const click = (root: HTMLElement | ShadowRoot, name: string) => root.querySelector<HTMLButtonElement>(`.omni-dicom__${name}`)!.click();

describe('DICOM viewer', () => {
    it('renders actual RGBA pixels and metadata in shadow isolation', async () => {
        const { root } = await mount();
        expect(root.querySelector('style')?.textContent).toContain('.omni-dicom');
        expect(root.querySelector('h2')?.textContent).toBe('scan.dcm');
        expect(root.textContent).toContain('SYNTHETIC^TEST'); expect(root.textContent).toContain('Patient Name');
        expect(root.querySelector('canvas')?.width).toBe(2);
        expect(Array.from(rendered[0]!)).toEqual([0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
        expect(ctx.assets.resolveAssetUrl).not.toHaveBeenCalled();
    });
    it('adjusts windowing, inversion and zoom, and resets to the original window', async () => {
        const { root } = await mount();
        input(root, 'center', '128'); input(root, 'width', '1'); expect(Array.from(rendered.at(-1)!).filter((_, i) => i % 4 === 0)).toEqual([0, 0, 255, 255]);
        click(root, 'invert'); expect(root.querySelector('.omni-dicom__invert')?.getAttribute('aria-pressed')).toBe('true');
        expect(rendered.at(-1)?.[0]).toBe(255);
        input(root, 'zoom', '200'); expect(root.querySelector('canvas')?.style.width).toBe('4px');
        const before = rendered.length; input(root, 'center', ''); expect(rendered.length).toBe(before);
        click(root, 'reset'); expect(rendered.at(-1)).toEqual(rendered[0]); expect(root.querySelector('canvas')?.style.width).toBe('');
    });
    it('navigates multi-frame images with buttons and range control', async () => {
        const { root } = await mount(dicomFixture({ pixels: new Uint8Array([0, 64, 128, 255, 255, 128, 64, 0]), attributes: { '00280008': ['IS', '2'] } }));
        expect(root.querySelector<HTMLButtonElement>('.omni-dicom__previous')?.disabled).toBe(true);
        click(root, 'next'); expect(root.querySelector('output')?.textContent).toBe('Frame 2 / 2'); expect(rendered.at(-1)?.[0]).toBe(255);
        expect(root.querySelector<HTMLButtonElement>('.omni-dicom__next')?.disabled).toBe(true);
        input(root, 'frame', '1'); expect(root.querySelector('output')?.textContent).toBe('Frame 1 / 2'); expect(rendered.at(-1)?.[0]).toBe(0);
        click(root, 'next'); click(root, 'previous'); expect(root.querySelector('output')?.textContent).toBe('Frame 1 / 2');
    });
    it.each(['LINEAR_EXACT', 'SIGMOID'])('renders and adjusts positive fractional window widths for %s', async voiFunction => {
        const { root } = await mount(dicomFixture({ pixels: new Uint8Array([0, 1, 2, 3]), attributes: {
            '00281053': ['DS', '1e-10'], '00281056': ['CS', voiFunction],
            '00281050': ['DS', '1.5e-10'], '00281051': ['DS', '1e-9']
        } }));
        expect(rendered).toHaveLength(1);
        expect(rendered[0]![0]).toBeLessThan(rendered[0]![12]!);
        expect(root.querySelector('canvas')?.hidden).toBe(false);
        input(root, 'width', '1e-10'); expect(rendered).toHaveLength(2);
        input(root, 'width', '0'); expect(rendered).toHaveLength(2);
        input(root, 'width', '-1'); expect(rendered).toHaveLength(2);
        click(root, 'reset'); expect(rendered).toHaveLength(3); expect(rendered.at(-1)).toEqual(rendered[0]);
    });
    it.each([['center', ''], ['width', '0'], ['width', '0.5']] as const)('retains the last painted window when changing frames with invalid %s=%s', async (name, value) => {
        const { root } = await mount(dicomFixture({ pixels: new Uint8Array([0, 64, 128, 255, 255, 128, 64, 0]), attributes: { '00280008': ['IS', '2'] } }));
        input(root, 'center', '64'); input(root, 'width', '128');
        const painted = rendered.length;
        input(root, name, value); expect(rendered).toHaveLength(painted);
        click(root, 'next'); expect(rendered).toHaveLength(painted + 1);
        expect(root.querySelector('output')?.textContent).toBe('Frame 2 / 2');
        expect(rendered.at(-1)?.[0]).toBe(255);
        expect(root.querySelector<HTMLInputElement>('.omni-dicom__center')?.value).toBe('64');
        expect(root.querySelector<HTMLInputElement>('.omni-dicom__width')?.value).toBe('128');
        input(root, name, value); input(root, 'frame', '1');
        expect(rendered).toHaveLength(painted + 2); expect(rendered.at(-1)).toEqual(rendered[painted - 1]);
    });
    it('filters and paginates tags without executing file names or patient markup', async () => {
        const extra = Array.from({ length: 220 }, (_, i) => element(`0011${i.toString(16).padStart(4, '0')}`, 'LO', `private-${i}`));
        const { root } = await mount(dicomFixture({ attributes: { '00100010': ['PN', '<img src=x onerror=alert(1)>'] }, extra }), false, '<script>x</script>.dcm');
        expect(root.querySelector('script,img')).toBeNull(); expect(root.querySelector('h2')?.textContent).toBe('<script>x</script>.dcm');
        expect(root.querySelectorAll('tbody tr')).toHaveLength(100); click(root, 'tags-next'); expect(root.querySelector('.omni-dicom__tags-status')?.textContent).toContain('Page 2 /');
        input(root, 'search', '(0010,0010)'); expect(root.querySelectorAll('tbody tr')).toHaveLength(1); expect(root.querySelector('tbody')?.textContent).toContain('<img src=x onerror=alert(1)>');
        input(root, 'search', 'missing-value'); expect(root.querySelector('tbody')?.textContent).toBe('No matching attributes.');
        input(root, 'search', ''); expect(root.querySelectorAll('tbody tr')).toHaveLength(100);
    });
    it('keeps metadata available for compressed/non-image objects and missing canvas APIs', async () => {
        const compressed = await mount(dicomFixture({ syntax: '1.2.840.10008.1.2.4.90' }));
        expect(compressed.root.textContent).toContain('Compressed images require an external decoder');
        expect(compressed.root.querySelector('canvas')?.hidden).toBe(true); expect(compressed.root.textContent).toContain('SYNTHETIC^TEST');
        const noPixels = await mount(dicomFixture({ pixels: null })); expect(noPixels.root.textContent).toContain('no image Pixel Data');
        vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
        const unavailable = await mount(); expect(unavailable.root.textContent).toContain('could not be rendered'); expect(unavailable.root.textContent).toContain('Patient Name');
    });
    it('disables grayscale controls for RGB and preserves physical pixel aspect ratio', async () => {
        const { root } = await mount(dicomFixture({ pixels: new Uint8Array(12), attributes: { '00280002': ['US', 3], '00280004': ['CS', 'RGB'], '00280030': ['DS', '2\\1'] } }));
        expect(root.querySelector<HTMLInputElement>('.omni-dicom__center')?.disabled).toBe(true);
        expect(root.querySelector('canvas')?.style.aspectRatio).toBe('2 / 4');
    });
    it('removes listeners and only its own DOM on idempotent disposal and remount', async () => {
        const { container, root, handle } = await mount(undefined, true);
        const host = document.createElement('p'); host.textContent = 'Host content'; container.prepend(host);
        const invert = root.querySelector<HTMLButtonElement>('.omni-dicom__invert')!, canvas = root.querySelector('canvas')!;
        const previous = rendered.length; handle.dispose(); handle.dispose(); invert.click();
        expect(rendered.length).toBe(previous); expect(canvas.width).toBe(0); expect(container.textContent).toBe('Host content'); expect(container.shadowRoot).toBeNull();
        handles.push(await mountDicomViewer({ fileName: 'again.dcm', data: dicomFixture() }, container, ctx));
        expect(container.shadowRoot?.querySelectorAll('style')).toHaveLength(1);
    });
    it('localizes all interface messages', async () => {
        const container = document.createElement('div');
        handles.push(await mountDicomViewer({ fileName: '검사.dcm', data: dicomFixture() }, container, { ...ctx, i18n: createCatalogI18n('ko') }));
        expect(container.shadowRoot?.textContent).toContain('DICOM 메타데이터');
        expect(container.shadowRoot?.textContent).toContain('윈도우 중심'); expect(container.shadowRoot?.textContent).not.toMatch(/dicom\.[a-z]/);
    });
    it('rejects aborted, malformed and oversized input before touching the host DOM', async () => {
        const container = document.createElement('div'), controller = new AbortController(); controller.abort();
        await expect(mountDicomViewer({ fileName: 'scan.dcm', data: dicomFixture() }, container, ctx, { signal: controller.signal })).rejects.toBeInstanceOf(MountAbortedError);
        await expect(mountDicomViewer({ fileName: 'scan.dcm', data: concat(new Uint8Array(4)) }, container, ctx)).rejects.toThrow('truncated');
        await expect(mountDicomViewer({ fileName: 'scan.dcm', data: dicomFixture() }, container, ctx, { maxBytes: 10 })).rejects.toThrow('limit');
        expect(container.childNodes.length).toBe(0); expect(container.shadowRoot).toBeNull();
    });
});
