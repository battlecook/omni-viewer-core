// Coordinate reprojection over a parsed shapefile model. The converter is
// injected (proj4 is an optional peer loaded by the adapter or the viewer's
// self-loading entry); this module only walks the geometry.

import type { ShapefileModel, ShpGeometry, ShpPosition } from './index.js';

export type CoordinateConverter = (position: ShpPosition) => ShpPosition;

/** WKT PROJCS/GEOGCS name, used for the projection label in the viewer. */
export function projectionName(wkt: string): string | null {
    return /^\s*(?:PROJCS|GEOGCS|GEOGCRS|PROJCRS)\s*\[\s*"([^"]+)"/i.exec(wkt)?.[1] ?? null;
}

/** True for WKT that is already geographic (lon/lat) — no reprojection needed. */
export function isGeographicWkt(wkt: string): boolean {
    return /^\s*(?:GEOGCS|GEOGCRS)\s*\[/i.test(wkt);
}

/** Returns a new model with every coordinate converted; bbox is recomputed.
 *  Non-finite conversion results fail the whole reprojection (throw) so the
 *  caller can fall back to rendering native coordinates. */
export function reprojectModel(model: ShapefileModel, convert: CoordinateConverter): ShapefileModel {
    let bbox: [number, number, number, number] | null = null;
    const convertChecked = (position: ShpPosition): ShpPosition => {
        const next = convert(position);
        if (!Number.isFinite(next[0]) || !Number.isFinite(next[1])) throw new Error('reprojection produced a non-finite coordinate');
        bbox = bbox
            ? [Math.min(bbox[0], next[0]), Math.min(bbox[1], next[1]), Math.max(bbox[2], next[0]), Math.max(bbox[3], next[1])]
            : [next[0], next[1], next[0], next[1]];
        return next;
    };
    const features = model.features.map((feature) => ({
        ...feature,
        geometry: feature.geometry ? convertGeometry(feature.geometry, convertChecked) : null
    }));
    return { ...model, features, bbox };
}

function convertGeometry(geometry: ShpGeometry, convert: CoordinateConverter): ShpGeometry {
    switch (geometry.type) {
        case 'Point': return { type: 'Point', coordinates: convert(geometry.coordinates) };
        case 'MultiPoint': return { type: 'MultiPoint', coordinates: geometry.coordinates.map(convert) };
        case 'LineString': return { type: 'LineString', coordinates: geometry.coordinates.map(convert) };
        case 'MultiLineString': return { type: 'MultiLineString', coordinates: geometry.coordinates.map((line) => line.map(convert)) };
        case 'Polygon': return { type: 'Polygon', coordinates: geometry.coordinates.map((ring) => ring.map(convert)) };
        case 'MultiPolygon': return { type: 'MultiPolygon', coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(convert))) };
    }
}
