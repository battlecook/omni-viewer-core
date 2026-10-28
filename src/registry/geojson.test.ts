import { describe, expect, it } from 'vitest';
import { GEOJSON_VIEWER_META } from '../viewers/geojson/index.js';
import { CORE_VIEWER_DESCRIPTORS, GEOJSON_VIEWER_DESCRIPTOR, detectViewer, looksLikeGeoJson, sniffTextViewer } from './index.js';

const point = '{"type":"Point","coordinates":[127,37]}';
const collection = '{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[127,37]}}]}';
describe('GeoJSON detection', () => {
    it('registers .geojson case-insensitively with matching viewer metadata', () => {
        for (const name of ['map.geojson', 'MAP.GEOJSON']) expect(detectViewer(name)).toEqual({ viewerId: 'geojson', matchedBy: 'extension' });
        const { inputOwnership: _, ...meta } = GEOJSON_VIEWER_META;
        expect(GEOJSON_VIEWER_DESCRIPTOR).toEqual(meta);
        expect(CORE_VIEWER_DESCRIPTORS.filter(d => d.id === 'geojson')).toHaveLength(1);
    });
    it.each([point, collection, collection.slice(0, 65), '\uFEFF' + point,
        '{"type":"Feature","properties":null,"geometry":null}', '{"type":"GeometryCollection","geometries":[]}'
    ])('recognizes top-level GeoJSON before generic JSON: %s', sample => {
        expect(looksLikeGeoJson(sample)).toBe(true);
        expect(sniffTextViewer(sample)).toBe('geojson');
        expect(detectViewer('map', undefined, undefined, undefined, sample)).toEqual({ viewerId: 'geojson', matchedBy: 'content' });
    });
    it.each(['{}', '{"type":"Point"}', '{"data":{"type":"Point","coordinates":[]}}',
        '{"type":"FeatureCollection","features":{}}', '{"type":"point","coordinates":[]}',
        '{"type":"Feature","properties":4,"geometry":null}', '{"type":"Other","coordinates":[]}'
    ])('rejects lookalikes: %s', sample => expect(looksLikeGeoJson(sample)).toBe(false));
    it('preserves explicit JSON routing and JSONL detection', () => {
        expect(detectViewer('map.json', undefined, undefined, undefined, point).viewerId).toBe('json');
        expect(sniffTextViewer(point + '\n' + point)).toBe('jsonl');
        expect(detectViewer('map', undefined, CORE_VIEWER_DESCRIPTORS.filter(d => d.id !== 'geojson'), undefined, point).viewerId).toBe('fallback');
    });
});
