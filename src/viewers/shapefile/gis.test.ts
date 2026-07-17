// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { mountShapefileViewer } from './index.js';

const ctx = { assets: { resolveAssetUrl: async (p: string) => p }, i18n: createCatalogI18n(), logger: { log: () => undefined } };

/** Two point records at (1,1) and (3,3), file bbox (0,0)-(4,4). */
function twoPoints(): Uint8Array {
    const data = new Uint8Array(100 + 2 * 28);
    const view = new DataView(data.buffer);
    view.setInt32(0, 9994);
    view.setInt32(24, data.byteLength / 2);
    view.setInt32(28, 1000, true);
    view.setInt32(32, 1, true);
    view.setFloat64(36, 0, true); view.setFloat64(44, 0, true);
    view.setFloat64(52, 4, true); view.setFloat64(60, 4, true);
    let offset = 100;
    [[1, 1], [3, 3]].forEach(([x, y], index) => {
        view.setInt32(offset, index + 1);
        view.setInt32(offset + 4, 10);
        view.setInt32(offset + 8, 1, true);
        view.setFloat64(offset + 12, x!, true);
        view.setFloat64(offset + 20, y!, true);
        offset += 28;
    });
    return data;
}

function pointsDbf(): Uint8Array {
    const fields = [{ name: 'CITY', type: 'C', length: 8 }, { name: 'POP', type: 'N', length: 6 }];
    const headerSize = 32 + fields.length * 32 + 1;
    const recordSize = 1 + 14;
    const rows = [['Seoul', '  9736'], ['Busan', '  3350']];
    const data = new Uint8Array(headerSize + rows.length * recordSize + 1);
    const view = new DataView(data.buffer);
    data[0] = 0x03;
    view.setUint32(4, rows.length, true);
    view.setUint16(8, headerSize, true);
    view.setUint16(10, recordSize, true);
    fields.forEach((field, index) => {
        const at = 32 + index * 32;
        for (let i = 0; i < field.name.length; i++) data[at + i] = field.name.charCodeAt(i);
        data[at + 11] = field.type.charCodeAt(0);
        data[at + 16] = field.length;
    });
    data[32 + fields.length * 32] = 0x0d;
    rows.forEach((row, rowIndex) => {
        const at = headerSize + rowIndex * recordSize;
        data[at] = 0x20;
        const text = row[0]!.padEnd(8) + row[1]!.padEnd(6);
        for (let i = 0; i < text.length; i++) data[at + 1 + i] = text.charCodeAt(i);
    });
    data[data.length - 1] = 0x1a;
    return data;
}

function viewBoxOf(container: HTMLElement): number[] {
    return container.shadowRoot!.querySelector('svg')!.getAttribute('viewBox')!.split(/\s+/).map(Number);
}

describe('shapefile GIS features', () => {
    it('selects a feature and shows its DBF attributes', async () => {
        const container = document.createElement('div');
        const handle = await mountShapefileViewer(
            { fileName: 'cities.shp', data: twoPoints() }, container, ctx,
            { sidecars: { dbf: pointsDbf() } }
        );
        const root = container.shadowRoot!;
        expect(root.textContent).toContain('2 attribute fields');
        expect(root.textContent).toContain('Click a feature');

        const circles = [...root.querySelectorAll('circle')];
        expect(circles).toHaveLength(2);
        circles[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const panel = root.querySelector('.omni-shp__attributes')!;
        expect(panel.textContent).toContain('Feature 2');
        expect(panel.textContent).toContain('Busan');
        expect(panel.textContent).toContain('3350');
        expect(circles[1]!.classList.contains('is-selected')).toBe(true);

        // Clicking the empty map clears the selection.
        root.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(circles[1]!.classList.contains('is-selected')).toBe(false);
        expect(panel.textContent).toContain('Click a feature');
        handle.dispose();
    });

    it('reports an unreadable DBF as a warning instead of failing', async () => {
        const container = document.createElement('div');
        const handle = await mountShapefileViewer(
            { fileName: 'cities.shp', data: twoPoints() }, container, ctx,
            { sidecars: { dbf: new Uint8Array(4) } }
        );
        const warning = container.shadowRoot!.querySelector('.omni-shp__warning') as HTMLElement;
        expect(warning.hidden).toBe(false);
        expect(warning.textContent).toContain('.dbf');
        handle.dispose();
    });

    it('reprojects projected coordinates through the injected converter', async () => {
        const container = document.createElement('div');
        const wkt = 'PROJCS["Test Grid",GEOGCS["Test",DATUM["Test"]]]';
        const handle = await mountShapefileViewer(
            { fileName: 'grid.shp', data: twoPoints() }, container, ctx,
            {
                sidecars: { prj: wkt },
                createReprojector: () => ([x, y]) => [x * 10, y * 10]
            }
        );
        const root = container.shadowRoot!;
        expect(root.querySelector('.omni-shp__projection')!.textContent).toContain('Test Grid → WGS84');
        const first = root.querySelector('circle')!;
        expect(Number(first.getAttribute('cx'))).toBe(10);
        expect(Number(first.getAttribute('cy'))).toBe(-10);
        handle.dispose();
    });

    it('keeps native coordinates for geographic WKT and failed reprojection', async () => {
        const container = document.createElement('div');
        const geographic = await mountShapefileViewer(
            { fileName: 'geo.shp', data: twoPoints() }, container, ctx,
            {
                sidecars: { prj: 'GEOGCS["WGS 84",DATUM["WGS_1984"]]' },
                createReprojector: () => { throw new Error('must not be called'); }
            }
        );
        expect(Number(container.shadowRoot!.querySelector('circle')!.getAttribute('cx'))).toBe(1);
        geographic.dispose();

        const failing = document.createElement('div');
        const handle = await mountShapefileViewer(
            { fileName: 'grid.shp', data: twoPoints() }, failing, ctx,
            {
                sidecars: { prj: 'PROJCS["Broken",GEOGCS["x",DATUM["y"]]]' },
                createReprojector: () => { throw new Error('no definition'); }
            }
        );
        const warning = failing.shadowRoot!.querySelector('.omni-shp__warning') as HTMLElement;
        expect(warning.textContent).toContain('Reprojection failed');
        expect(Number(failing.shadowRoot!.querySelector('circle')!.getAttribute('cx'))).toBe(1);
        handle.dispose();
    });

    it('zooms around the view centre and resets', async () => {
        const container = document.createElement('div');
        const handle = await mountShapefileViewer({ fileName: 'cities.shp', data: twoPoints() }, container, ctx);
        const root = container.shadowRoot!;
        const initial = viewBoxOf(container);
        const [zoomInButton, , resetButton] = [...root.querySelectorAll('button')];
        zoomInButton!.click();
        const zoomed = viewBoxOf(container);
        expect(zoomed[2]!).toBeCloseTo(initial[2]! / 1.5);
        expect(zoomed[0]! + zoomed[2]! / 2).toBeCloseTo(initial[0]! + initial[2]! / 2); // same centre
        resetButton!.click();
        expect(viewBoxOf(container)).toEqual(initial);
        handle.dispose();
    });
});
