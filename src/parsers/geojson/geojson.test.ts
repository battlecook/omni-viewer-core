import { describe, expect, it } from 'vitest';
import { parseGeoJson, type GeoJsonDocument, type GeoJsonParseOptions } from './index.js';

const point = { type: 'Point', coordinates: [127, 37, 24] };
const feature = (geometry: unknown = point, properties: unknown = { city: '서울' }) => ({ type: 'Feature', id: 'seoul', geometry, properties });
const collection = (features: unknown[]) => ({ type: 'FeatureCollection', features });
function document(input: unknown, options: GeoJsonParseOptions = {}): GeoJsonDocument {
    const { result } = parseGeoJson(JSON.stringify(input), options);
    if (result.status === 'failed') throw new Error(result.failure.messageKey);
    return result.document;
}

describe('GeoJSON parser', () => {
    it('accepts bytes and BOM-prefixed text with identical deterministic results', () => {
        const text = JSON.stringify(collection([feature()]));
        const parsed = parseGeoJson(text);
        expect(parseGeoJson(new TextEncoder().encode(text)).result).toEqual(parsed.result);
        expect(parseGeoJson('\uFEFF' + text).result).toEqual(parsed.result);
        expect(parsed.execution).toMatchObject({ workerUsed: false, hardLimitEnforced: false });
        expect(document(feature())).toMatchObject({ bbox: [127, 37, 127, 37], vertexCount: 1 });
    });

    it.each([
        [point, 1],
        [{ type: 'MultiPoint', coordinates: [[0, 0], [1, 1]] }, 2],
        [{ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, 2],
        [{ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }, 4],
        [{ type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 0]]] }, 4],
        [{ type: 'MultiPolygon', coordinates: [[[[0, 0], [4, 0], [4, 4], [0, 0]]]] }, 4],
        [{ type: 'GeometryCollection', geometries: [point, { type: 'GeometryCollection', geometries: [point] }] }, 2]
    ])('accepts geometry %j directly and inside a feature', (geometry, count) => {
        expect(document(geometry).vertexCount).toBe(count);
        expect(document(feature(geometry)).features[0]?.geometry?.type).toBe(geometry.type);
    });

    it('preserves holes and ignores misleading declared bounds', () => {
        const rings = [
            [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
            [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]
        ];
        const model = document({ ...feature({ type: 'Polygon', coordinates: rings }), bbox: [-180, -90, 180, 90] });
        expect(model.bbox).toEqual([0, 0, 10, 10]);
        expect(model.features[0]?.geometry).toEqual({ type: 'Polygon', coordinates: rings });
    });

    it('retains original IDs, duplicate properties, nested values, and unsafe keys', () => {
        const { result } = parseGeoJson('{"type":"Feature","id":9007199254740993,"geometry":null,"properties":{"__proto__":{"polluted":true},"n":9007199254740993,"n":1,"nested":[true,null]}}');
        expect(result.status).toBe('ok');
        if (result.status === 'failed') return;
        expect(result.document.features[0]?.id).toBe('9007199254740993');
        const properties = result.document.features[0]!.properties!;
        expect(properties.children?.map(child => child.key)).toEqual(['__proto__', 'n', 'n', 'nested']);
        expect(properties.children?.[1]?.rawNumber).toBe('9007199254740993');
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it.each([
        { type: 'FeatureCollection', features: [] }, feature(null, null),
        { type: 'GeometryCollection', geometries: [] }, { type: 'Point', coordinates: [] }
    ])('supports empty documents and null geometry: %j', input => {
        const model = document(input);
        expect(model.bbox).toBeNull(); expect(model.vertexCount).toBe(0);
    });

    it.each([
        '', '[]', '{}', 'null', '{"type":"Point","coordinates":[1,2]} trailing',
        '{"type":"Point","coordinates":[1,2]', '{"type":"Point","coordinates":[1,"2"]}',
        '{"type":"Point","coordinates":[1,1e400]}', '{"type":"Point","coordinates":[181,0]}',
        '{"type":"Point","coordinates":[0,-91]}', '{"type":"Point","coordinates":[1]}',
        '{"type":"Feature","geometry":null}', '{"type":"Feature","geometry":null,"properties":[]}',
        '{"type":"FeatureCollection","features":{}}', '{"type":"GeometryCollection","geometries":[null]}'
    ])('returns failures without throwing for invalid input %s', input => {
        expect(parseGeoJson(input).result).toMatchObject({ status: 'failed', failure: { code: 'invalid-format' } });
    });

    it.each([
        { type: 'LineString', coordinates: [[0, 0]] },
        { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] },
        { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] }
    ])('validates line lengths and closed polygon rings: %j', shape => {
        expect(parseGeoJson(JSON.stringify(shape)).result.status).toBe('failed');
    });

    it('skips malformed features atomically, keeping bounds and counts consistent', () => {
        const bad = feature({ type: 'LineString', coordinates: [[-170, -80], ['bad', 20]] });
        const { result } = parseGeoJson(JSON.stringify(collection([bad, feature()])));
        expect(result.status).toBe('partial');
        if (result.status === 'failed') return;
        expect(result.document.features).toHaveLength(1);
        expect(result.document.bbox).toEqual([127, 37, 127, 37]);
        expect(result.document.vertexCount).toBe(1);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'geojson.geometry', args: { index: 1 } }));
    });

    it('caps diagnostic output for many malformed records', () => {
        const { result } = parseGeoJson(JSON.stringify(collection([...Array(100).fill(null), feature()])));
        expect(result.status).toBe('partial');
        expect(result.diagnostics.filter(d => d.code === 'geojson.geometry')).toHaveLength(20);
    });

    it('keeps large duplicate-key property sets without throwing or flooding diagnostics', () => {
        const input = '{"type":"Feature","geometry":null,"properties":{' + Array(150_000).fill('"a":0').join(',') + '}}';
        const { result } = parseGeoJson(input);
        expect(result.status).toBe('ok');
        expect(result.diagnostics.filter(d => d.code === 'json.duplicate-key')).toHaveLength(20);
        if (result.status !== 'failed') expect(result.document.features[0]?.properties?.children).toHaveLength(150_000);
    });

    it.each([{ maxFeatures: 1 }, { limits: { maxEntries: 1 } }])('caps retained features: %j', options => {
        const { result } = parseGeoJson(JSON.stringify(collection([feature(), feature()])), options);
        expect(result.status).toBe('partial');
        if (result.status !== 'failed') expect(result.document.features).toHaveLength(1);
    });

    it('rolls back a feature that exceeds the remaining vertex budget', () => {
        const { result } = parseGeoJson(JSON.stringify(collection([
            feature(), feature({ type: 'LineString', coordinates: [[-5, -5], [0, 0]] })
        ])), { maxVertices: 2 });
        expect(result.status).toBe('partial');
        if (result.status === 'failed') return;
        expect(result.document.features).toHaveLength(1);
        expect(result.document.vertexCount).toBe(1);
        expect(result.document.bbox).toEqual([127, 37, 127, 37]);
        expect(result.diagnostics.at(-1)?.code).toBe('geojson.limit');
    });

    it.each([{ limits: { maxInputBytes: 5 } }, { maxNodes: 0 }, { maxNodes: 2 }, { maxDepth: 1 }])('enforces parse resource limits: %j', options => {
        expect(parseGeoJson(JSON.stringify(feature()), options).result).toMatchObject({ status: 'failed', failure: { code: 'limit-exceeded' } });
    });

    it('reports cancellation and unsupported legacy CRS metadata', () => {
        const controller = new AbortController(); controller.abort();
        expect(parseGeoJson('{}', { signal: controller.signal }).result).toMatchObject({ status: 'failed', failure: { code: 'aborted' } });
        expect(parseGeoJson(JSON.stringify({ ...feature(), crs: { type: 'name' } })).result.diagnostics).toContainEqual(expect.objectContaining({ code: 'geojson.crs' }));
    });
});
