// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import type { ViewerHandle } from '../types.js';
import { geoJsonViewerCss, mountGeoJsonViewer } from './index.js';

const ctx = { assets: { resolveAssetUrl: async (path: string) => path }, i18n: createCatalogI18n(), logger: { log: () => undefined } };
const feature = (geometry: unknown, properties: unknown = { name: 'Seoul' }) => ({ type: 'Feature', geometry, properties });
const ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
const hole = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];
const sample = { type: 'FeatureCollection', features: [
    feature({ type: 'Point', coordinates: [127, 37] }),
    feature({ type: 'Polygon', coordinates: [ring, hole] }, { name: 'Area' }),
    feature(null, { hidden: true })
] };
const handles: ViewerHandle[] = [];
afterEach(() => { handles.forEach(handle => handle.dispose()); handles.length = 0; document.body.replaceChildren(); vi.restoreAllMocks(); });
async function mount(data: unknown = sample, scoped = false) {
    const container = document.createElement('div'); document.body.append(container);
    const handle = await mountGeoJsonViewer({ fileName: 'map.geojson', data: new TextEncoder().encode(JSON.stringify(data)) }, container, ctx, scoped ? { styleIsolation: 'scoped' } : {});
    handles.push(handle);
    const root = scoped ? container : container.shadowRoot!;
    return { container, handle, root, svg: root.querySelector('svg')! };
}
function pointer(target: EventTarget, type: string, x: number, y: number, buttons = type === 'pointerup' ? 0 : 1, pointerId = 1): void {
    const event = new Event(type, { bubbles: true });
    Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y }, button: { value: 0 }, buttons: { value: buttons }, pointerId: { value: pointerId } });
    target.dispatchEvent(event);
}

describe('GeoJSON viewer', () => {
    it('renders an offline map in shadow isolation with polygon holes', async () => {
        const { root, svg } = await mount();
        expect(root.querySelector('style')?.textContent).toContain('.omni-geojson');
        expect(svg.querySelectorAll('circle')).toHaveLength(1);
        const path = svg.querySelector('path')!;
        expect(path.getAttribute('fill-rule')).toBe('evenodd');
        expect(path.getAttribute('d')?.match(/ Z/g)).toHaveLength(2);
        expect(root.textContent).toContain('3 features · 11 vertices · WGS84');
        expect(root.querySelectorAll('script,iframe,img,image,a')).toHaveLength(0);
    });

    it('selects features and shows original numeric, nested, and hostile properties as text', async () => {
        const container = document.createElement('div');
        const raw = '{"type":"Feature","geometry":{"type":"Point","coordinates":[0,0]},"properties":{"name":"<img src=x onerror=alert(1)>","big":9007199254740993,"nested":{"a":[true,null]}}}';
        const handle = await mountGeoJsonViewer({ fileName: '<script>.geojson', data: new TextEncoder().encode(raw) }, container, ctx);
        handles.push(handle);
        const root = container.shadowRoot!;
        root.querySelector('circle')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(root.querySelector('.is-selected')).not.toBeNull();
        expect(root.querySelector('table')?.textContent).toContain('9007199254740993');
        expect(root.querySelector('table')?.textContent).toContain('{"a":[true,null]}');
        expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
        expect(root.querySelector('img,script')).toBeNull();
    });

    it('allows keyboard-accessible selection of features with no geometry and clears selection', async () => {
        const { root, svg } = await mount();
        const select = root.querySelector('select')!;
        select.value = '2'; select.dispatchEvent(new Event('change'));
        expect(root.querySelector('table')?.textContent).toContain('true');
        expect(root.querySelector('h3')?.textContent).toContain('Feature 3');
        svg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(select.value).toBe('');
        expect(root.querySelector('table')).toBeNull();
        expect(root.textContent).toContain('Select a feature');
    });

    it('highlights every component of a GeometryCollection as one feature', async () => {
        const { root, svg } = await mount(feature({ type: 'GeometryCollection', geometries: [
            { type: 'Point', coordinates: [0, 0] }, { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }
        ] }));
        svg.querySelector('path')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const group = svg.querySelector('.is-selected')!;
        expect(group.querySelector('circle')).not.toBeNull();
        expect(root.querySelector('table')?.textContent).toContain('Seoul');
        expect(svg.querySelector('path')?.style.fill).toBe('none');
    });

    it('zooms, pans with keys, and resets the view', async () => {
        const { root, svg } = await mount();
        const initial = svg.getAttribute('viewBox');
        const buttons = root.querySelectorAll('button');
        buttons[0]!.click(); expect(svg.getAttribute('viewBox')).not.toBe(initial);
        buttons[2]!.click(); expect(svg.getAttribute('viewBox')).toBe(initial);
        svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
        expect(svg.getAttribute('viewBox')).not.toBe(initial);
        svg.dispatchEvent(new KeyboardEvent('keydown', { key: '0' }));
        expect(svg.getAttribute('viewBox')).toBe(initial);
        svg.dispatchEvent(new KeyboardEvent('keydown', { key: '+' }));
        const zoomed = svg.getAttribute('viewBox');
        svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
        expect(zoomed).not.toBe(initial); expect(svg.getAttribute('viewBox')).toBe(initial);
    });

    it('anchors wheel zoom correctly inside a letterboxed SVG viewport', async () => {
        const { svg } = await mount(feature({ type: 'Point', coordinates: [0, 0] }));
        vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 800, height: 400, left: 0, top: 0, right: 800, bottom: 400, toJSON: () => ({}) });
        // Square data centered in a wide viewport; x=200 is the left data edge.
        const before = svg.getAttribute('viewBox')!.split(' ').map(Number);
        const event = new WheelEvent('wheel', { deltaY: -1, clientX: 200, clientY: 200, cancelable: true });
        svg.dispatchEvent(event);
        const after = svg.getAttribute('viewBox')!.split(' ').map(Number);
        expect(event.defaultPrevented).toBe(true);
        expect(after[0]).toBeCloseTo(before[0]!);
        expect(after[2]).toBeCloseTo(before[2]! / 1.5);
    });

    it.each([0, 50, -50])('ignores horizontal or stationary wheel input with deltaX=%s', async deltaX => {
        const { svg } = await mount();
        const before = svg.getAttribute('viewBox');
        const event = new WheelEvent('wheel', { deltaX, deltaY: 0, cancelable: true });
        svg.dispatchEvent(event);
        expect(svg.getAttribute('viewBox')).toBe(before);
        expect(event.defaultPrevented).toBe(false);
    });

    it('bounds duplicate-key warnings in the mounted preview', async () => {
        const input = '{"type":"Feature","geometry":null,"properties":{' + Array(10_000).fill('"a":0').join(',') + '}}';
        const container = document.createElement('div');
        handles.push(await mountGeoJsonViewer({ fileName: 'duplicates.geojson', data: new TextEncoder().encode(input) }, container, ctx));
        expect(container.shadowRoot?.querySelector('.omni-geojson__warning')?.textContent?.split('\n')).toHaveLength(20);
    });

    it('pans with a pointer and does not select on the click after a drag', async () => {
        const { root, svg } = await mount();
        vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 800, height: 400, left: 0, top: 0, right: 800, bottom: 400, toJSON: () => ({}) });
        const before = svg.getAttribute('viewBox');
        pointer(svg, 'pointerdown', 200, 200); pointer(document, 'pointermove', 240, 210); pointer(document, 'pointerup', 240, 210);
        expect(svg.getAttribute('viewBox')).not.toBe(before);
        expect(svg.classList.contains('is-panning')).toBe(false);
        svg.querySelector('circle')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(root.querySelector('table')).toBeNull();
    });

    it.each(['host-widget', '1'])('does not select a scoped host data-feature=%s on a map background click', async value => {
        const { root, container, svg } = await mount(sample, true);
        container.setAttribute('data-feature', value);
        svg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(root.querySelector('select')?.value).toBe('');
        expect(root.querySelector('table')).toBeNull();
    });

    it('stops panning when the pointer returns with no buttons held', async () => {
        const { svg } = await mount();
        vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 800, height: 400, left: 0, top: 0, right: 800, bottom: 400, toJSON: () => ({}) });
        pointer(svg, 'pointerdown', 200, 200); pointer(document, 'pointermove', 240, 210);
        const before = svg.getAttribute('viewBox');
        pointer(document, 'pointermove', 280, 220, 0);
        expect(svg.getAttribute('viewBox')).toBe(before);
        expect(svg.classList.contains('is-panning')).toBe(false);
    });

    it.each(['zoom', 'reset', 'keyboard'])('ends dragging before a %s view change so movement cannot restore the old view', async action => {
        const { root, svg } = await mount();
        vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 800, height: 400, left: 0, top: 0, right: 800, bottom: 400, toJSON: () => ({}) });
        pointer(svg, 'pointerdown', 200, 200); pointer(document, 'pointermove', 240, 210);
        if (action === 'zoom') svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, clientX: 200, clientY: 200 }));
        else if (action === 'reset') root.querySelectorAll('button')[2]!.click();
        else svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
        const changed = svg.getAttribute('viewBox');
        pointer(document, 'pointermove', 280, 220);
        expect(svg.getAttribute('viewBox')).toBe(changed);
        expect(svg.classList.contains('is-panning')).toBe(false);
    });

    it('captures and releases the active pointer without another pointer ending its drag', async () => {
        const { svg } = await mount();
        vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 800, height: 400, left: 0, top: 0, right: 800, bottom: 400, toJSON: () => ({}) });
        const capture = vi.fn(), release = vi.fn();
        Object.defineProperties(svg, { setPointerCapture: { value: capture }, hasPointerCapture: { value: () => true }, releasePointerCapture: { value: release } });
        pointer(svg, 'pointerdown', 200, 200);
        expect(capture).not.toHaveBeenCalled();
        pointer(document, 'pointermove', 240, 210);
        expect(capture).toHaveBeenCalledWith(1);
        pointer(document, 'pointerup', 200, 200, 0, 2);
        expect(svg.classList.contains('is-panning')).toBe(true);
        pointer(document, 'pointerup', 200, 200);
        expect(svg.classList.contains('is-panning')).toBe(false);
        expect(release).toHaveBeenCalledWith(1);
    });

    it('keeps dragging when implicit touch capture transfers from a shape to the SVG', async () => {
        const { svg } = await mount();
        vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 800, height: 400, left: 0, top: 0, right: 800, bottom: 400, toJSON: () => ({}) });
        const shape = svg.querySelector('circle')!;
        pointer(shape, 'pointerdown', 200, 200); pointer(document, 'pointermove', 240, 210);
        const before = svg.getAttribute('viewBox');
        pointer(shape, 'lostpointercapture', 240, 210);
        expect(svg.classList.contains('is-panning')).toBe(true);
        pointer(document, 'pointermove', 280, 220);
        expect(svg.getAttribute('viewBox')).not.toBe(before);
        pointer(svg, 'lostpointercapture', 280, 220);
        expect(svg.classList.contains('is-panning')).toBe(false);
    });

    it('supports scoped mounting and leaves existing host nodes on dispose', async () => {
        const { container, handle } = await mount(sample, true);
        const host = document.createElement('p'); host.textContent = 'Host content'; container.prepend(host);
        expect(container.shadowRoot).toBeNull();
        expect(container.querySelector('.omni-viewer--geojson')).not.toBeNull();
        handle.dispose(); handle.dispose(); expect(container.children).toHaveLength(1); expect(container.firstElementChild).toBe(host);
    });

    it('keeps scoped controls visible under hostile host element styles', async () => {
        const hostStyles = document.createElement('style'), viewerStyles = document.createElement('style');
        hostStyles.textContent = 'button,select { display:none; position:fixed; }';
        viewerStyles.textContent = geoJsonViewerCss;
        document.head.append(hostStyles, viewerStyles);
        try {
            const outside = document.createElement('button'); document.body.append(outside);
            const { root } = await mount(sample, true);
            for (const control of root.querySelectorAll('button,select')) {
                expect(getComputedStyle(control).display).toBe('inline-block');
                expect(getComputedStyle(control).position).toBe('static');
            }
            expect(getComputedStyle(outside).display).toBe('none');
        } finally { hostStyles.remove(); viewerStyles.remove(); }
    });

    it('preserves polygon holes under scoped host path fill rules', async () => {
        const hostStyles = document.createElement('style'), viewerStyles = document.createElement('style');
        hostStyles.textContent = 'path { fill-rule:nonzero; }';
        viewerStyles.textContent = geoJsonViewerCss;
        document.head.append(hostStyles, viewerStyles);
        try {
            const { svg } = await mount(sample, true);
            expect(svg.querySelector('path')!.getAttribute('fill-rule')).toBe('evenodd');
            expect(getComputedStyle(svg.querySelector('path')!).fillRule).toBe('evenodd');
        } finally { hostStyles.remove(); viewerStyles.remove(); }
    });

    it('protects the scoped map viewport from host SVG positioning without resetting shape coordinates', async () => {
        const hostStyles = document.createElement('style'), viewerStyles = document.createElement('style');
        hostStyles.textContent = 'svg { position:fixed; transform:scale(0); }';
        viewerStyles.textContent = geoJsonViewerCss;
        document.head.append(hostStyles, viewerStyles);
        try {
            const { svg } = await mount(sample, true);
            expect(getComputedStyle(svg).position).toBe('static');
            expect(getComputedStyle(svg).transform).toBe('none');
            expect(svg.querySelector('circle')!.getAttribute('cx')).toBe('127');
            expect(svg.querySelector('circle')!.getAttribute('cy')).toBe('-37');
            expect(svg.querySelector('path')!.getAttribute('d')).toContain('M0 0 L10 0');
        } finally { hostStyles.remove(); viewerStyles.remove(); }
    });

    it('keeps scoped SVG groups and shapes visible and selectable under host appearance rules', async () => {
        const hostStyles = document.createElement('style'), viewerStyles = document.createElement('style');
        hostStyles.textContent = 'g,path,circle { display:none; opacity:0; pointer-events:none; visibility:hidden; transform:scale(0); filter:blur(8px); fill-opacity:0; stroke-opacity:0; }';
        viewerStyles.textContent = geoJsonViewerCss;
        document.head.append(hostStyles, viewerStyles);
        try {
            const { root, svg } = await mount(feature({ type: 'GeometryCollection', geometries: [
                { type: 'Point', coordinates: [127, 37] }, { type: 'LineString', coordinates: [[127, 37], [128, 38]] }
            ] }), true);
            for (const shape of svg.querySelectorAll('g,path,circle')) {
                const css = getComputedStyle(shape);
                expect(css.display).toBe('inline'); expect(css.opacity).toBe('1');
                expect(css.pointerEvents).toBe('visiblePainted'); expect(css.visibility).toBe('visible');
                expect(css.transform).toBe('none'); expect(css.filter).toBe('none');
                expect(css.fillOpacity).toBe('1'); expect(css.strokeOpacity).toBe('1');
            }
            expect(svg.querySelector('circle')!.getAttribute('cx')).toBe('127');
            expect(svg.querySelector('path')!.getAttribute('d')).toBe('M127 -37 L128 -38');
            svg.querySelector('circle')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            expect(root.querySelector('table')?.textContent).toContain('Seoul');
        } finally { hostStyles.remove(); viewerStyles.remove(); }
    });

    it('removes styles, DOM, and event handlers when disposed and can remount', async () => {
        const { container, root, handle, svg } = await mount();
        const before = svg.getAttribute('viewBox');
        handle.dispose();
        expect(root.childNodes).toHaveLength(0);
        svg.dispatchEvent(new KeyboardEvent('keydown', { key: '+' }));
        expect(svg.getAttribute('viewBox')).toBe(before);
        const second = await mountGeoJsonViewer({ fileName: 'again.geojson', data: new TextEncoder().encode(JSON.stringify(sample)) }, container, ctx);
        handles.push(second); expect(root.querySelectorAll('style')).toHaveLength(1);
    });

    it('shows empty states and bounded-preview diagnostics', async () => {
        const { root, svg } = await mount({ type: 'FeatureCollection', features: [] });
        expect(root.textContent).toContain('No geometry to display.');
        expect(svg.hasAttribute('viewBox')).toBe(false);
        expect(root.querySelector('button')?.disabled).toBe(true);
        const container = document.createElement('div');
        handles.push(await mountGeoJsonViewer({ fileName: 'limited.geojson', data: new TextEncoder().encode(JSON.stringify(sample)) }, container, ctx, { maxFeatures: 1 }));
        expect(container.shadowRoot?.querySelector('.omni-geojson__warning')?.textContent).toContain('resource limit');
    });

    it('rejects invalid input and aborted mounting without leaving content', async () => {
        const container = document.createElement('div'), controller = new AbortController(); controller.abort();
        const input = { fileName: 'invalid.geojson', data: new TextEncoder().encode('{}') };
        await expect(mountGeoJsonViewer(input, container, ctx)).rejects.toThrow('Invalid GeoJSON');
        await expect(mountGeoJsonViewer(input, container, ctx, { signal: controller.signal })).rejects.toThrow('aborted');
        expect(container.shadowRoot).toBeNull(); expect(container.childNodes).toHaveLength(0);
    });

    it('does not retain document listeners when the shadow host is unsupported', async () => {
        const add = vi.spyOn(document, 'addEventListener');
        const addWindow = vi.spyOn(window, 'addEventListener');
        const container = document.createElement('table');
        const input = { fileName: 'map.geojson', data: new TextEncoder().encode(JSON.stringify(sample)) };
        await expect(mountGeoJsonViewer(input, container, ctx)).rejects.toThrow();
        expect(add.mock.calls.filter(([type]) => ['pointermove', 'pointerup', 'pointercancel'].includes(type))).toHaveLength(0);
        expect(addWindow.mock.calls.filter(([type]) => type === 'blur')).toHaveLength(0);
        expect(container.childNodes).toHaveLength(0);
    });

    it('localizes the map controls and summaries in Korean', async () => {
        const container = document.createElement('div');
        handles.push(await mountGeoJsonViewer({ fileName: '지도.geojson', data: new TextEncoder().encode(JSON.stringify(sample)) }, container, { ...ctx, i18n: createCatalogI18n('ko-KR') }));
        expect(container.shadowRoot?.textContent).toContain('피처 3개 · 정점 11개');
        expect(container.shadowRoot?.querySelector('button')?.textContent).toBe('확대');
    });

    it('bounds large property panels without altering the parsed values', async () => {
        const properties = Object.fromEntries(Array.from({ length: 600 }, (_, index) => [`key${index}`, 'value']));
        const { root } = await mount(feature(null, properties));
        const select = root.querySelector('select')!; select.value = '0'; select.dispatchEvent(new Event('change'));
        expect(root.querySelectorAll('tr')).toHaveLength(500);
        expect(root.querySelector('.omni-geojson__properties')?.textContent).toContain('Some properties were truncated');
    });

    it('bounds warning text even when duplicate property keys are very long', async () => {
        const key = 'x'.repeat(1_000_000);
        const input = '{"type":"Feature","geometry":null,"properties":{' + JSON.stringify(key) + ':0,' + JSON.stringify(key) + ':1}}';
        const container = document.createElement('div');
        handles.push(await mountGeoJsonViewer({ fileName: 'long-key.geojson', data: new TextEncoder().encode(input) }, container, ctx, { limits: { maxPreviewBytes: 64 } }));
        const warning = container.shadowRoot!.querySelector('.omni-geojson__warning')!.textContent!;
        expect(new TextEncoder().encode(warning).byteLength).toBeLessThanOrEqual(64);
        expect(warning).toContain('…');
    });

    it.each([0, 1, 2, 3, 4, 5, 8, 13])('respects a %s-byte property budget including multibyte text and ellipses', async budget => {
        const container = document.createElement('div');
        const data = new TextEncoder().encode(JSON.stringify(feature(null, { '😀': '😀가a'.repeat(10) })));
        handles.push(await mountGeoJsonViewer({ fileName: 'text.geojson', data }, container, ctx, { limits: { maxPreviewBytes: budget } }));
        const root = container.shadowRoot!;
        const select = root.querySelector('select')!; select.value = '0'; select.dispatchEvent(new Event('change'));
        const text = root.querySelector('table')?.textContent ?? '';
        expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(budget);
        expect(Array.from(text).every(char => char.codePointAt(0)! < 0xd800 || char.codePointAt(0)! > 0xdfff)).toBe(true);
    });

    it('bounds feature ID labels while retaining a usable selection', async () => {
        const { root } = await mount({ ...feature(null), id: '😀'.repeat(100_000) });
        const option = root.querySelectorAll('option')[1]!;
        expect(new TextEncoder().encode(option.textContent!).byteLength).toBeLessThanOrEqual(1024);
        expect(option.textContent).toContain('…');
        const select = root.querySelector('select')!; select.value = '0'; select.dispatchEvent(new Event('change'));
        expect(root.querySelector('table')?.textContent).toContain('Seoul');
    });

    it('does not create SVG paths for empty components', async () => {
        const { svg } = await mount({ type: 'MultiPolygon', coordinates: [[], [], []] });
        expect(svg.querySelector('path')).toBeNull();
    });
});
