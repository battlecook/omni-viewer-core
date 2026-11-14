import type { HostContext } from '../../host/index.js';
import type { CompressedPreviewOptions } from '../../parsers/file-preview.js';
import type { GeoJsonDocument, GeoJsonGeometry, GeoJsonPosition } from '../../parsers/geojson/index.js';
import { parseGps, type GpsDocument } from '../../parsers/gps/index.js';
import { GPS_VIEWER_DESCRIPTOR } from '../../registry/file-previews.js';
import { mountFilePreview, previewDetails, renderPreviewTable, type FilePreviewOptions } from '../file-preview.js';
import { mountGeoJsonDocument } from '../geojson/index.js';
import type { ViewerInput } from '../types.js';

export * from '../../parsers/gps/index.js';
export const GPS_VIEWER_META = { ...GPS_VIEWER_DESCRIPTOR, inputOwnership: 'borrows' as const };

/** Consecutive positions follow the shorter arc, independent of traversal order. */
function unwrappedLine(points: GeoJsonPosition[]): number[] {
    let previous = points[0]?.[0] ?? 0, longitude = previous;
    return points.map(([raw]) => {
        const delta = raw - previous;
        longitude += delta > 180 ? delta - 360 : delta < -180 ? delta + 360 : delta;
        previous = raw;
        return longitude;
    });
}

function longitudeWindow(features: GeoJsonDocument['features'], fallback: number): number {
    const intervals: [number, number][] = [];
    const path = (points: GeoJsonPosition[]) => {
        if (!points.length) return;
        let min = Infinity, max = -Infinity;
        for (const lon of unwrappedLine(points)) {
            min = Math.min(min, lon);
            max = Math.max(max, lon);
        }
        if (max - min >= 360) {
            intervals.push([0, 360]);
            return;
        }
        const start = ((min % 360) + 360) % 360;
        const end = start + max - min;
        intervals.push([start, Math.min(end, 360)]);
        if (end > 360) intervals.push([0, end - 360]);
    };
    const visit = (geometry: GeoJsonGeometry): void => {
        switch (geometry.type) {
            case 'Point': path([geometry.coordinates]); break;
            case 'MultiPoint': geometry.coordinates.forEach(point => path([point])); break;
            case 'LineString': path(geometry.coordinates); break;
            case 'MultiLineString': case 'Polygon': geometry.coordinates.forEach(path); break;
            case 'MultiPolygon': geometry.coordinates.forEach(polygon => polygon.forEach(path)); break;
            case 'GeometryCollection': geometry.geometries.forEach(visit); break;
        }
    };
    for (const feature of features) if (feature.geometry) visit(feature.geometry);
    intervals.sort((a, b) => a[0] - b[0]);
    const first = intervals[0];
    if (!first) return fallback;
    let end = first[1], gapSize = 0, gapStart = end;
    for (const [start, last] of intervals) {
        if (start - end > gapSize) {
            gapSize = start - end;
            gapStart = end;
        }
        end = Math.max(end, last);
    }
    if (first[0] + 360 - end > gapSize) {
        gapSize = first[0] + 360 - end;
        gapStart = end;
    }
    if (gapSize <= 0) return fallback;
    const center = gapStart + gapSize / 2 + 180;
    return center + 360 * Math.round((fallback - center) / 360);
}

function displayMap(model: GpsDocument): GeoJsonDocument {
    const map: GeoJsonDocument = {
        type: 'FeatureCollection', bbox: model.bbox, vertexCount: model.pointCount, text: '',
        features: model.features.map(feature => ({ id: feature.name || null, geometry: feature.geometry, properties: null }))
    };
    if (!model.bbox || model.bbox[2] - model.bbox[0] <= 180) return map;

    // Keep neighboring coordinates on the same side of the display seam.
    // The parser's WGS84 coordinates and distance calculations remain intact.
    const anchor = longitudeWindow(map.features, (model.bbox[0] + model.bbox[2] + 360) / 2);
    const bounds: NonNullable<GeoJsonDocument['bbox']> = [Infinity, Infinity, -Infinity, -Infinity];
    const point = ([longitude, latitude, ...rest]: GeoJsonPosition, near: number): GeoJsonPosition => {
        const lon = longitude + 360 * Math.round((near - longitude) / 360);
        bounds[0] = Math.min(bounds[0], lon);
        bounds[1] = Math.min(bounds[1], latitude);
        bounds[2] = Math.max(bounds[2], lon);
        bounds[3] = Math.max(bounds[3], latitude);
        return [lon, latitude, ...rest];
    };
    const line = (points: GeoJsonPosition[], near = anchor) => {
        const longitudes = unwrappedLine(points);
        let min = Infinity, max = -Infinity;
        for (const longitude of longitudes) {
            min = Math.min(min, longitude);
            max = Math.max(max, longitude);
        }
        const shift = 360 * Math.round((near - (min + max) / 2) / 360);
        return points.map(([raw, lat, ...rest], index) => {
            const lon = longitudes[index]! + shift;
            return point([raw, lat, ...rest], lon);
        });
    };
    const polygon = ([outer, ...holes]: GeoJsonPosition[][]) => {
        if (!outer) return [];
        const shell = line(outer);
        let left = Infinity, right = -Infinity;
        for (const [longitude] of shell) {
            left = Math.min(left, longitude);
            right = Math.max(right, longitude);
        }
        const near = shell.length ? (left + right) / 2 : anchor;
        return [shell, ...holes.map(hole => line(hole, near))];
    };
    const unwrap = (geometry: GeoJsonGeometry): GeoJsonGeometry => {
        switch (geometry.type) {
            case 'Point': return { type: geometry.type, coordinates: point(geometry.coordinates, anchor) };
            case 'MultiPoint': return { type: geometry.type, coordinates: geometry.coordinates.map(position => point(position, anchor)) };
            case 'LineString': return { type: geometry.type, coordinates: line(geometry.coordinates) };
            case 'MultiLineString': return { type: geometry.type, coordinates: geometry.coordinates.map(points => line(points)) };
            case 'Polygon': return { type: geometry.type, coordinates: polygon(geometry.coordinates) };
            case 'MultiPolygon': return { type: geometry.type, coordinates: geometry.coordinates.map(polygon) };
            case 'GeometryCollection': return { type: geometry.type, geometries: geometry.geometries.map(unwrap) };
        }
    };
    for (const feature of map.features) {
        if (feature.geometry) feature.geometry = unwrap(feature.geometry);
    }
    map.bbox = Number.isFinite(bounds[0]) ? bounds : null;
    return map;
}

export async function mountGpsViewer(input: ViewerInput, container: HTMLElement, ctx: HostContext, options: FilePreviewOptions & CompressedPreviewOptions = {}) {
    const { result } = await parseGps(input.data, options);
    return mountFilePreview(input, container, ctx, options, 'gps', result, (ui, model) => {
        const { t } = ui;
        ui.body.append(ui.el('p', t('gps.summary', { features: model.features.length, points: model.pointCount })));
        const map = ui.el('div');
        ui.body.append(map);
        if (model.format === 'gpx' && model.features.length) {
            const headers = [t('preview.name'), t('gps.distance'), t('gps.elapsed'), t('gps.elevation')];
            const rows = model.features.map((feature, index) => ({
                name: feature.name || t('geojson.feature', { id: index + 1 }),
                distance: t('gps.km', { value: feature.distanceKm.toFixed(2) }),
                elapsed: feature.elapsedSeconds === undefined ? '–' : t('gps.seconds', { value: feature.elapsedSeconds }),
                elevation: feature.minElevation === undefined ? '–' : t('gps.meters', { min: feature.minElevation, max: feature.maxElevation ?? feature.minElevation })
            }));
            renderPreviewTable(ui, {
                rows, headers,
                cells: row => [row.name, row.distance, row.elapsed, row.elevation],
                details: row => previewDetails(ui, headers.map((label, index) => [label, Object.values(row)[index] ?? '']))
            });
        }
        const handle = mountGeoJsonDocument(displayMap(model), [], model.format.toUpperCase(), map, ctx, options);
        return () => handle.dispose();
    });
}
