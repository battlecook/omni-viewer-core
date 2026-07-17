import { describe, expect, it } from 'vitest';
import { parseDbf } from './dbf.js';
import { projectionName, isGeographicWkt, reprojectModel } from './reproject.js';
import type { ShapefileModel } from './index.js';

interface DbfFieldSpec { name: string; type: string; length: number; decimals?: number }

/** Minimal dBASE III writer for fixtures. */
function buildDbf(fields: DbfFieldSpec[], rows: string[][], options: { deletedRows?: number[] } = {}): Uint8Array {
    const headerSize = 32 + fields.length * 32 + 1;
    const recordSize = 1 + fields.reduce((sum, f) => sum + f.length, 0);
    const data = new Uint8Array(headerSize + rows.length * recordSize + 1);
    const view = new DataView(data.buffer);
    data[0] = 0x03;
    view.setUint32(4, rows.length, true);
    view.setUint16(8, headerSize, true);
    view.setUint16(10, recordSize, true);
    fields.forEach((field, index) => {
        const at = 32 + index * 32;
        for (let i = 0; i < Math.min(field.name.length, 11); i++) data[at + i] = field.name.charCodeAt(i);
        data[at + 11] = field.type.charCodeAt(0);
        data[at + 16] = field.length;
        data[at + 17] = field.decimals ?? 0;
    });
    data[32 + fields.length * 32] = 0x0d;
    rows.forEach((row, rowIndex) => {
        const at = headerSize + rowIndex * recordSize;
        data[at] = options.deletedRows?.includes(rowIndex) ? 0x2a : 0x20;
        let cursor = at + 1;
        fields.forEach((field, fieldIndex) => {
            const text = (row[fieldIndex] ?? '').padEnd(field.length).slice(0, field.length);
            for (let i = 0; i < text.length; i++) data[cursor + i] = text.charCodeAt(i);
            cursor += field.length;
        });
    });
    data[data.length - 1] = 0x1a;
    return data;
}

describe('parseDbf', () => {
    const fields: DbfFieldSpec[] = [
        { name: 'NAME', type: 'C', length: 10 },
        { name: 'POP', type: 'N', length: 8 },
        { name: 'ACTIVE', type: 'L', length: 1 },
        { name: 'FOUNDED', type: 'D', length: 8 }
    ];

    it('parses fields and typed records', () => {
        const table = parseDbf(buildDbf(fields, [
            ['Seoul', ' 9736027', 'T', '13940101'],
            ['Busan', ' 3350000', 'F', '']
        ]));
        expect(table.fields.map((f) => f.name)).toEqual(['NAME', 'POP', 'ACTIVE', 'FOUNDED']);
        expect(table.records).toEqual([
            { NAME: 'Seoul', POP: 9736027, ACTIVE: true, FOUNDED: '1394-01-01' },
            { NAME: 'Busan', POP: 3350000, ACTIVE: false, FOUNDED: null }
        ]);
        expect(table.warnings).toEqual([]);
    });

    it('skips deleted records and honours the record limit', () => {
        const rows = [['A', '1', 'T', ''], ['B', '2', 'T', ''], ['C', '3', 'T', '']];
        const withDeleted = parseDbf(buildDbf(fields, rows, { deletedRows: [1] }));
        expect(withDeleted.records.map((r) => r.NAME)).toEqual(['A', 'C']);

        const limited = parseDbf(buildDbf(fields, rows), { maxRecords: 2 });
        expect(limited.records).toHaveLength(2);
        expect(limited.warnings.join(' ')).toContain('limited');
    });

    it('rejects broken headers', () => {
        expect(() => parseDbf(new Uint8Array(8))).toThrow(/truncated/);
        const noFields = new Uint8Array(64);
        new DataView(noFields.buffer).setUint16(8, 33, true);
        new DataView(noFields.buffer).setUint16(10, 4, true);
        noFields[32] = 0x0d;
        expect(() => parseDbf(noFields)).toThrow(/no field descriptors/);
    });
});

describe('prj helpers and reprojection', () => {
    const projectedWkt = 'PROJCS["Korea 2000 / Unified CS",GEOGCS["Korea 2000",DATUM["Geocentric_datum_of_Korea"]]]';

    it('reads the projection name and detects geographic systems', () => {
        expect(projectionName(projectedWkt)).toBe('Korea 2000 / Unified CS');
        expect(isGeographicWkt(projectedWkt)).toBe(false);
        expect(isGeographicWkt('GEOGCS["WGS 84",DATUM["WGS_1984"]]')).toBe(true);
    });

    it('converts every coordinate and recomputes the bbox', () => {
        const model: ShapefileModel = {
            shapeType: 3, shapeTypeName: 'PolyLine', fileLengthBytes: 0,
            bbox: [0, 0, 10, 10], vertexCount: 3, warnings: [],
            features: [{ id: 1, geometry: { type: 'LineString', coordinates: [[0, 0], [10, 10], [5, 5]] } }]
        };
        const projected = reprojectModel(model, ([x, y]) => [x / 10, y / 10 + 1]);
        expect(projected.features[0]?.geometry).toEqual({ type: 'LineString', coordinates: [[0, 1], [1, 2], [0.5, 1.5]] });
        expect(projected.bbox).toEqual([0, 1, 1, 2]);
        expect(model.features[0]?.geometry?.type === 'LineString' && model.features[0].geometry.coordinates[0]).toEqual([0, 0]);
    });

    it('throws on non-finite conversion results', () => {
        const model: ShapefileModel = {
            shapeType: 1, shapeTypeName: 'Point', fileLengthBytes: 0,
            bbox: null, vertexCount: 1, warnings: [],
            features: [{ id: 1, geometry: { type: 'Point', coordinates: [1, 2] } }]
        };
        expect(() => reprojectModel(model, () => [Number.NaN, 0])).toThrow(/non-finite/);
    });
});
