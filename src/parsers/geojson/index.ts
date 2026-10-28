import { parseJson, type JsonNode } from '../json/index.js';
import { decodeUtf8, utf8ByteLength, type Diagnostic, type ParseOptions, type ParseOutcome, type ParseResult } from '../types.js';

/** WGS84 longitude, latitude, and optional extra ordinates (e.g. altitude). */
export type GeoJsonPosition = [number, number, ...number[]];
export type GeoJsonGeometry =
    | { type: 'Point'; coordinates: GeoJsonPosition }
    | { type: 'MultiPoint' | 'LineString'; coordinates: GeoJsonPosition[] }
    | { type: 'MultiLineString' | 'Polygon'; coordinates: GeoJsonPosition[][] }
    | { type: 'MultiPolygon'; coordinates: GeoJsonPosition[][][] }
    | { type: 'GeometryCollection'; geometries: GeoJsonGeometry[] };

export interface GeoJsonFeature {
    /** Numeric IDs retain their original token, including integers beyond 2^53. */
    id: string | null;
    geometry: GeoJsonGeometry | null;
    /** Original JSON tree: ordered keys, nested values, and lossless numbers. */
    properties: JsonNode | null;
}

export interface GeoJsonDocument {
    type: string;
    features: GeoJsonFeature[];
    /** Derived from the retained geometry, never trusted from an input bbox. */
    bbox: [number, number, number, number] | null;
    vertexCount: number;
    text: string;
}

export interface GeoJsonParseOptions extends ParseOptions {
    /** Maximum retained features (default 10,000; limits.maxEntries also applies). */
    maxFeatures?: number;
    /** Maximum retained positions (default 200,000). */
    maxVertices?: number;
    /** JSON tree budget, including properties (default 1,000,000 nodes). */
    maxNodes?: number;
    /** JSON nesting limit (default 64). */
    maxDepth?: number;
}

export const GEOJSON_INPUT_OWNERSHIP = 'borrows' as const;
export const GEOJSON_GEOMETRY_TYPES: readonly string[] = [
    'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'
];

function member(node: JsonNode, key: string): JsonNode | undefined {
    return node.kind === 'object' ? node.children?.find(child => child.key === key) : undefined;
}

class InvalidGeometry extends Error {}
class VertexLimit extends Error {}

/** RFC 7946 parser. Input-caused failures are returned, never thrown. */
export function parseGeoJson(input: Uint8Array | string, options: GeoJsonParseOptions = {}): ParseOutcome<GeoJsonDocument> {
    const started = Date.now();
    const diagnostics: Diagnostic[] = [];
    const finish = (result: ParseResult<GeoJsonDocument>): ParseOutcome<GeoJsonDocument> => ({
        result, execution: { workerUsed: false, hardLimitEnforced: false, elapsedMillis: Date.now() - started }
    });
    const fail = (code: 'invalid-format' | 'limit-exceeded' | 'aborted', messageKey: string): ParseOutcome<GeoJsonDocument> =>
        finish({ status: 'failed', failure: { code, retryable: code === 'aborted', messageKey }, diagnostics });
    if (options.signal?.aborted) return fail('aborted', 'diag.aborted');
    const maxInputBytes = options.limits?.maxInputBytes ?? 128 * 1024 * 1024;
    const bytes = typeof input === 'string' ? utf8ByteLength(input) : input.byteLength;
    if (bytes > maxInputBytes) return fail('limit-exceeded', 'diag.geojson.limit');
    const text = (typeof input === 'string' ? input : decodeUtf8(input)).replace(/^\uFEFF/, '');
    const json = parseJson(text, {
        ...options,
        maxDepth: options.maxDepth ?? 64,
        maxDuplicateKeyDiagnostics: 20,
        limits: { ...options.limits, maxInputBytes, maxEntries: options.maxNodes ?? 1_000_000 }
    }).result;
    for (const diagnostic of json.diagnostics) diagnostics.push(diagnostic);
    if (json.status === 'failed') {
        return finish({ ...json, diagnostics });
    }
    if (json.status === 'partial') {
        return fail(diagnostics.some(d => d.code === 'limit-exceeded' || d.code === 'json.max-depth') ? 'limit-exceeded' : 'invalid-format',
            diagnostics.some(d => d.code === 'limit-exceeded' || d.code === 'json.max-depth') ? 'diag.geojson.limit' : 'diag.geojson.invalid');
    }
    const root = json.document.root;
    const type = member(root, 'type')?.value;
    if (typeof type !== 'string' || !['Feature', 'FeatureCollection', ...GEOJSON_GEOMETRY_TYPES].includes(type)) {
        return fail('invalid-format', 'diag.geojson.invalid');
    }
    if (member(root, 'crs')) diagnostics.push({ severity: 'warning', code: 'geojson.crs', messageKey: 'diag.geojson.crs' });
    const maxFeatures = Math.min(options.maxFeatures ?? 10_000, options.limits?.maxEntries ?? 10_000);
    const maxVertices = options.maxVertices ?? 200_000;
    const features: GeoJsonFeature[] = [];
    let vertexCount = 0;
    let bbox: GeoJsonDocument['bbox'] = null;
    let limited = false;
    let malformed = 0;

    const position = (node: JsonNode): GeoJsonPosition => {
        const values = node.children ?? [];
        if (node.kind !== 'array' || values.length < 2 || values.some(value => value.kind !== 'number' || !Number.isFinite(Number(value.rawNumber)))) {
            throw new InvalidGeometry();
        }
        if (vertexCount >= maxVertices) throw new VertexLimit();
        const coordinates = values.map(value => Number(value.rawNumber)) as GeoJsonPosition;
        if (Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) throw new InvalidGeometry();
        vertexCount++;
        bbox = bbox
            ? [Math.min(bbox[0], coordinates[0]), Math.min(bbox[1], coordinates[1]), Math.max(bbox[2], coordinates[0]), Math.max(bbox[3], coordinates[1])]
            : [coordinates[0], coordinates[1], coordinates[0], coordinates[1]];
        return coordinates;
    };
    const array = <T>(node: JsonNode | undefined, read: (item: JsonNode) => T): T[] => {
        if (node?.kind !== 'array') throw new InvalidGeometry();
        return (node.children ?? []).map(read);
    };
    const line = (node: JsonNode): GeoJsonPosition[] => {
        const points = array(node, position);
        if (points.length === 1) throw new InvalidGeometry();
        return points;
    };
    const ring = (node: JsonNode): GeoJsonPosition[] => {
        const points = array(node, position);
        const first = points[0], last = points[points.length - 1];
        if (points.length < 4 || !first || !last || first.length !== last.length || first.some((value, index) => value !== last[index])) {
            throw new InvalidGeometry();
        }
        return points;
    };
    const geometry = (node: JsonNode): GeoJsonGeometry | null => {
        if (node.kind !== 'object') throw new InvalidGeometry();
        const kind = member(node, 'type')?.value;
        const coordinates = member(node, 'coordinates');
        if (kind === 'GeometryCollection') {
            return { type: kind, geometries: array(member(node, 'geometries'), item => geometry(item)).filter((item): item is GeoJsonGeometry => item !== null) };
        }
        if (!coordinates || !GEOJSON_GEOMETRY_TYPES.includes(String(kind))) throw new InvalidGeometry();
        // RFC 7946 permits empty coordinates to be interpreted as null geometry.
        if (coordinates.kind === 'array' && coordinates.children?.length === 0) return null;
        switch (kind) {
            case 'Point': return { type: kind, coordinates: position(coordinates) };
            case 'MultiPoint': return { type: kind, coordinates: array(coordinates, position) };
            case 'LineString': return { type: kind, coordinates: line(coordinates) };
            case 'MultiLineString': return { type: kind, coordinates: array(coordinates, line) };
            case 'Polygon': return { type: kind, coordinates: array(coordinates, ring) };
            case 'MultiPolygon': return { type: kind, coordinates: array(coordinates, polygon => array(polygon, ring)) };
            default: throw new InvalidGeometry();
        }
    };
    const readFeature = (node: JsonNode, bare: boolean): GeoJsonFeature => {
        if (bare) return { id: null, properties: null, geometry: geometry(node) };
        if (member(node, 'type')?.value !== 'Feature') throw new InvalidGeometry();
        const properties = member(node, 'properties'), shape = member(node, 'geometry'), id = member(node, 'id');
        if (!properties || !['object', 'null'].includes(properties.kind) || !shape || (id && !['string', 'number'].includes(id.kind))) throw new InvalidGeometry();
        return {
            id: id?.kind === 'number' ? id.rawNumber! : id?.kind === 'string' ? String(id.value) : null,
            properties: properties.kind === 'null' ? null : properties,
            geometry: shape.kind === 'null' ? null : geometry(shape)
        };
    };
    const collection = member(root, 'features');
    if (type === 'FeatureCollection' && collection?.kind !== 'array') return fail('invalid-format', 'diag.geojson.invalid');
    const entries = type === 'FeatureCollection' ? collection!.children ?? [] : [root];
    for (const [index, entry] of entries.entries()) {
        if (options.signal?.aborted) return fail('aborted', 'diag.aborted');
        if (features.length >= maxFeatures) { limited = true; break; }
        const previousCount = vertexCount;
        const previousBbox: GeoJsonDocument['bbox'] = bbox;
        try {
            features.push(readFeature(entry, type !== 'FeatureCollection' && type !== 'Feature'));
        } catch (error) {
            vertexCount = previousCount;
            bbox = previousBbox;
            if (error instanceof VertexLimit) { limited = true; break; }
            if (!(error instanceof InvalidGeometry)) throw error;
            malformed++;
            if (malformed <= 20) diagnostics.push({ severity: 'warning', code: 'geojson.geometry', messageKey: 'diag.geojson.geometry', args: { index: index + 1 }, location: entry.path });
        }
    }
    if (malformed && features.length === 0 && !limited) return fail('invalid-format', 'diag.geojson.invalid');
    if (limited) diagnostics.push({ severity: 'warning', code: 'geojson.limit', messageKey: 'diag.geojson.limit' });
    return finish({
        status: malformed || limited ? 'partial' : 'ok',
        document: { type, features, bbox, vertexCount, text }, diagnostics
    });
}
