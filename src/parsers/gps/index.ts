import { attribute, elements, invalidPreview, PREVIEW_XML_BYTES, previewParser, previewZip, xmlText, type CompressedPreviewOptions } from '../file-preview.js';
import { parseIso8601Millis } from '../iso8601.js';
import type { GeoJsonDocument, GeoJsonGeometry, GeoJsonPosition } from '../geojson/index.js';
import type { ParseOutcome } from '../types.js';
import type { XmlNode } from '../xml/index.js';

export interface GpsFeature {
    name: string;
    geometry: GeoJsonGeometry;
    distanceKm: number;
    elapsedSeconds: number | undefined;
    minElevation: number | undefined;
    maxElevation: number | undefined;
}
export interface GpsDocument {
    format: 'gpx' | 'kml' | 'kmz';
    features: GpsFeature[];
    bbox: GeoJsonDocument['bbox'];
    pointCount: number;
}
const GPX_NAMESPACES = new Set(['', 'http://www.topografix.com/GPX/1/0', 'http://www.topografix.com/GPX/1/1']);
const GX_NAMESPACE = 'http://www.google.com/kml/ext/2.2';
const KML_SHAPES = ['Point', 'LineString', 'LinearRing', 'Polygon', 'MultiGeometry'];
const KML_NAMESPACES = new Set(['', 'http://www.opengis.net/kml/2.2', 'http://earth.google.com/kml/2.0', 'http://earth.google.com/kml/2.1', 'http://earth.google.com/kml/2.2']);

function childText(node: XmlNode, name: string): string {
    const child = elements(node, name)[0];
    return child ? xmlText(child).trim() : '';
}

function numeric(value: string): number | undefined {
    const number = value.trim() ? Number(value) : NaN;
    return Number.isFinite(number) ? number : undefined;
}

function distance(a: GeoJsonPosition, b: GeoJsonPosition): number {
    const rad = Math.PI / 180;
    const latitude = Math.sin((b[1] - a[1]) * rad / 2);
    const longitude = Math.sin((b[0] - a[0]) * rad / 2);
    const h = latitude ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * longitude ** 2;
    return 12_742 * Math.asin(Math.sqrt(Math.max(0, Math.min(h, 1))));
}

export async function parseGps(input: Uint8Array, options: CompressedPreviewOptions = {}): Promise<ParseOutcome<GpsDocument>> {
    const parser = previewParser(input, options);
    try {
        parser.check();
        let bytes = input;
        const zipped = input[0] === 0x50 && input[1] === 0x4b;
        if (zipped) {
            const archive = previewZip(input, options);
            const kml = archive.find('doc.kml')
                ?? archive.entries.find(entry => /^(?:\.\/)*doc\.kml$/i.test(entry.name))
                ?? archive.entries.find(entry => /^(?:\.\/)*[^/\\]+\.kml$/i.test(entry.name))
                ?? archive.entries.find(entry => /\.kml$/i.test(entry.name) && !entry.name.startsWith('__MACOSX/'));
            if (!kml) return invalidPreview();
            bytes = await archive.read(kml.name, PREVIEW_XML_BYTES, options.signal);
        }
        const xml = parser.xml(bytes);
        const root = xml.root!;
        const gpx = !zipped && root.local === 'gpx' && GPX_NAMESPACES.has(root.namespaceUri);
        if (!gpx && (root.local !== 'kml' || !KML_NAMESPACES.has(root.namespaceUri))) return invalidPreview();

        const features: GpsFeature[] = [];
        const maxPoints = options.limits?.maxEntries ?? 100_000;
        let bbox: GpsDocument['bbox'] = null;
        let pointCount = 0, pointsRead = 0;
        const position = (x: string, y: string, z = ''): GeoJsonPosition | undefined => {
            if (pointsRead >= maxPoints) {
                parser.warn('truncated');
                return undefined;
            }
            const lon = numeric(x), lat = numeric(y), altitude = numeric(z);
            if (lon === undefined || lat === undefined || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
                parser.warn('skipped');
                return undefined;
            }
            pointsRead++;
            return altitude === undefined ? [lon, lat] : [lon, lat, altitude];
        };
        const retain = (points: GeoJsonPosition[]) => {
            for (const [lon, lat] of points) {
                bbox = bbox
                    ? [Math.min(bbox[0], lon), Math.min(bbox[1], lat), Math.max(bbox[2], lon), Math.max(bbox[3], lat)]
                    : [lon, lat, lon, lat];
                pointCount++;
            }
        };

        const readGpx = (node: XmlNode) => {
            const source = node.local === 'trk' ? elements(node, 'trkseg').map(segment => elements(segment, 'trkpt'))
                : [node.local === 'rte' ? elements(node, 'rtept') : [node]];
            const segments: GeoJsonPosition[][] = [];
            let distanceKm = 0, firstTime = Infinity, lastTime = -Infinity;
            let minimum = Infinity, maximum = -Infinity, timed = 0;
            for (const group of source) {
                if (!parser.checkpoint()) break;
                let points: GeoJsonPosition[] = [];
                const endSegment = () => {
                    if (points.length) segments.push(points);
                    points = [];
                };
                for (const point of group) {
                    if (!parser.checkpoint()) break;
                    const coordinates = position(attribute(point, 'lon'), attribute(point, 'lat'), childText(point, 'ele'));
                    if (!coordinates) {
                        endSegment();
                        if (pointsRead >= maxPoints) break;
                        continue;
                    }
                    const previous = points.at(-1);
                    if (previous) distanceKm += distance(previous, coordinates);
                    points.push(coordinates);
                    const elevation = coordinates[2];
                    if (elevation !== undefined) {
                        minimum = Math.min(minimum, elevation);
                        maximum = Math.max(maximum, elevation);
                    }
                    const time = parseIso8601Millis(childText(point, 'time'));
                    if (time !== null) {
                        timed++;
                        firstTime = Math.min(firstTime, time);
                        lastTime = Math.max(lastTime, time);
                    }
                }
                endSegment();
            }
            if (!segments.length) return;
            for (const segment of segments) retain(segment);
            const geometries = segments.map<GeoJsonGeometry>(line => line.length === 1
                ? { type: 'Point', coordinates: line[0]! } : { type: 'LineString', coordinates: line });
            features.push({
                name: childText(node, 'name'),
                geometry: geometries.length === 1 ? geometries[0]! : { type: 'GeometryCollection', geometries },
                distanceKm,
                elapsedSeconds: timed >= 2 ? (lastTime - firstTime) / 1000 : undefined,
                minElevation: minimum === Infinity ? undefined : minimum,
                maxElevation: maximum === -Infinity ? undefined : maximum
            });
        };

        const coordinates = (node: XmlNode, limit = Infinity) => {
            const tuples = childText(node, 'coordinates').matchAll(/\S+/g);
            const points: GeoJsonPosition[] = [];
            for (const [tuple] of tuples) {
                if (!parser.checkpoint()) return { points, complete: false };
                if (points.length === limit) {
                    parser.warn('skipped');
                    break;
                }
                const [lon = '', lat = '', elevation] = tuple.split(',', 3);
                const point = position(lon, lat, elevation);
                if (point) points.push(point);
                if (!point && pointsRead >= maxPoints) return { points, complete: false };
            }
            return { points, complete: true };
        };
        // Google Earth recordings store tracks as gx:Track / gx:MultiTrack beside the KML shapes.
        const shapes = (node: XmlNode) => node.children.filter((item): item is XmlNode => item.kind === 'element' && (
            item.namespaceUri === root.namespaceUri ? KML_SHAPES.includes(item.local) :
                item.namespaceUri === GX_NAMESPACE && (item.local === 'Track' || item.local === 'MultiTrack')));
        const geometry = (node: XmlNode): GeoJsonGeometry | undefined => {
            if (node.namespaceUri === GX_NAMESPACE) {
                if (node.local !== 'Track' && node.local !== 'MultiTrack') return undefined;
                if (node.local === 'MultiTrack') {
                    const geometries = elements(node, 'Track').flatMap(item => geometry(item) ?? []);
                    return geometries.length ? { type: 'GeometryCollection', geometries } : undefined;
                }
                const points: GeoJsonPosition[] = [];
                for (const coord of elements(node, 'coord')) {
                    if (!parser.checkpoint()) break;
                    const [lon = '', lat = '', altitude] = xmlText(coord).trim().split(/\s+/, 3);
                    const point = position(lon, lat, altitude);
                    if (point) points.push(point);
                    else if (pointsRead >= maxPoints) break;
                }
                if (!points.length) return undefined;
                retain(points);
                return points.length === 1 ? { type: 'Point', coordinates: points[0]! } : { type: 'LineString', coordinates: points };
            }
            if (node.local === 'MultiGeometry') {
                const members = [...elements(node), ...elements(node, undefined, GX_NAMESPACE)];
                const geometries = members.flatMap(item => geometry(item) ?? []);
                return geometries.length ? { type: 'GeometryCollection', geometries } : undefined;
            }
            if (node.local === 'Polygon') {
                const readRing = (boundary: XmlNode) => {
                    const ring = elements(boundary, 'LinearRing')[0];
                    return ring ? coordinates(ring) : undefined;
                };
                const outer = elements(node, 'outerBoundaryIs')[0];
                const exterior = outer && readRing(outer);
                if (!exterior?.complete || exterior.points.length < 3) return undefined;
                const rings = [exterior.points];
                for (const boundary of elements(node, 'innerBoundaryIs')) {
                    const interior = readRing(boundary);
                    if (interior && !interior.complete) return undefined;
                    if (interior && interior.points.length >= 3) rings.push(interior.points);
                    else parser.warn('skipped');
                }
                for (const ring of rings) retain(ring);
                return { type: 'Polygon', coordinates: rings };
            }
            if (node.local === 'LineString' || node.local === 'LinearRing') {
                const { points } = coordinates(node);
                if (points.length < 2) return undefined;
                retain(points);
                return { type: 'LineString', coordinates: points };
            }
            if (node.local === 'Point') {
                const { points } = coordinates(node, 1);
                const point = points[0];
                if (!point) return undefined;
                retain(points);
                return { type: 'Point', coordinates: point };
            }
            if (node.local !== 'name' && node.local !== 'description') parser.warn('unsupported');
            return undefined;
        };
        const featureLimit = Math.min(10_000, maxPoints);
        if (gpx) {
            for (const node of elements(root)) {
                if (!parser.checkpoint()) break;
                if (!['trk', 'rte', 'wpt'].includes(node.local)) continue;
                if (features.length >= featureLimit) {
                    parser.warn('truncated');
                    break;
                }
                readGpx(node);
            }
        } else {
            for (const node of xml.nodes) {
                if (!parser.checkpoint()) break;
                if (node.kind !== 'element' || node.namespaceUri !== root.namespaceUri) continue;
                if (['NetworkLink', 'GroundOverlay', 'ScreenOverlay', 'Model'].includes(node.local)) parser.warn('unsupported');
                if (node.local !== 'Placemark') continue;
                if (features.length >= featureLimit) {
                    parser.warn('truncated');
                    break;
                }
                const geometries = shapes(node).flatMap(item => geometry(item) ?? []);
                if (!geometries.length) {
                    parser.warn('skipped');
                    continue;
                }
                features.push({
                    name: childText(node, 'name'),
                    geometry: geometries.length === 1 ? geometries[0]! : { type: 'GeometryCollection', geometries },
                    distanceKm: 0, elapsedSeconds: undefined, minElevation: undefined, maxElevation: undefined
                });
            }
        }
        return parser.success({ format: gpx ? 'gpx' : zipped ? 'kmz' : 'kml', features, bbox, pointCount });
    } catch (error) {
        return parser.failure(error);
    }
}
