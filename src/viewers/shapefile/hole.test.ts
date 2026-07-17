// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { mountShapefileViewer } from './index.js';

function polygonWithHole(): Uint8Array {
    const data = new Uint8Array(320);
    const view = new DataView(data.buffer);
    view.setInt32(0, 9994);
    view.setInt32(24, 160);
    view.setInt32(28, 1000, true);
    view.setInt32(32, 5, true);
    view.setFloat64(52, 10, true);
    view.setFloat64(60, 10, true);
    view.setInt32(100, 1);
    view.setInt32(104, 106);
    view.setInt32(108, 5, true);
    view.setFloat64(128, 10, true);
    view.setFloat64(136, 10, true);
    view.setInt32(144, 2, true);
    view.setInt32(148, 10, true);
    view.setInt32(152, 0, true);
    view.setInt32(156, 5, true);
    const rings = [
        [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]], // clockwise outer
        [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]] // counterclockwise hole
    ] as const;
    let offset = 160;
    for (const ring of rings) for (const [x, y] of ring) {
        view.setFloat64(offset, x, true);
        view.setFloat64(offset + 8, y, true);
        offset += 16;
    }
    return data;
}

function pointWithExtent(span: number): Uint8Array {
    const data = new Uint8Array(128);
    const view = new DataView(data.buffer);
    view.setInt32(0, 9994);
    view.setInt32(24, 64);
    view.setInt32(28, 1000, true);
    view.setInt32(32, 1, true);
    view.setFloat64(36, 0, true);
    view.setFloat64(44, 0, true);
    view.setFloat64(52, span, true);
    view.setFloat64(60, span, true);
    view.setInt32(100, 1);
    view.setInt32(104, 10);
    view.setInt32(108, 1, true);
    view.setFloat64(112, span / 2, true);
    view.setFloat64(120, span / 2, true);
    return data;
}

describe('Shapefile polygon holes', () => {
    it('renders outer and hole rings in one even-odd SVG path', async () => {
        const container = document.createElement('div');
        await mountShapefileViewer(
            { fileName: 'donut.shp', data: polygonWithHole() },
            container,
            { assets: { resolveAssetUrl: async path => path }, i18n: createCatalogI18n(), logger: { log: () => undefined } }
        );
        const path = container.shadowRoot?.querySelector<SVGPathElement>('.omni-shp__geometry');
        expect(path?.getAttribute('fill-rule')).toBe('evenodd');
        expect(path?.getAttribute('d')?.match(/M/g)).toHaveLength(2);
    });

    it('derives point radius from the viewBox extent', async () => {
        const normalizedRadii: number[] = [];
        for (const span of [0.01, 10_000]) {
            const container = document.createElement('div');
            await mountShapefileViewer(
                { fileName: 'point.shp', data: pointWithExtent(span) },
                container,
                { assets: { resolveAssetUrl: async path => path }, i18n: createCatalogI18n(), logger: { log: () => undefined } }
            );
            const svg = container.shadowRoot?.querySelector<SVGSVGElement>('svg');
            const circle = svg?.querySelector<SVGCircleElement>('circle');
            const viewWidth = Number(svg?.getAttribute('viewBox')?.split(/\s+/)[2]);
            const radius = Number(circle?.getAttribute('r'));
            expect(radius).not.toBe(2);
            normalizedRadii.push(radius / viewWidth);
        }
        expect(normalizedRadii[0]).toBeCloseTo(0.006, 8);
        expect(normalizedRadii[1]).toBeCloseTo(0.006, 8);
    });
});
