import { describe, expect, it } from 'vitest';
import type { ExcelCell, ExcelSheet } from '../../parsers/excel/index.js';
import { buildGridView, styleToCss } from './grid.js';

function sheet(over: Partial<ExcelSheet> & { cells: ExcelCell[]; usedRange: ExcelSheet['usedRange'] }): ExcelSheet {
    return { name: 'S', rowCount: 0, columnCount: 0, ...over };
}

function txt(r: number, c: number, w: string): ExcelCell {
    return { r, c, t: 'text', v: w, w };
}

describe('buildGridView — merges', () => {
    it('gives the top-left cell the span and skips covered cells', () => {
        const g = buildGridView(
            sheet({
                usedRange: { r0: 0, c0: 0, r1: 1, c1: 2 },
                cells: [txt(0, 0, 'title'), txt(1, 0, 'a'), txt(1, 1, 'b'), txt(1, 2, 'c')],
                merges: [{ r0: 0, c0: 0, r1: 0, c1: 2 }]
            })
        );
        expect(g.cols).toHaveLength(3);
        expect(g.rows[0]!.cells).toHaveLength(1); // merged: covered cells skipped
        expect(g.rows[0]!.cells[0]).toMatchObject({ colSpan: 3, rowSpan: 1, text: 'title' });
        expect(g.rows[1]!.cells).toHaveLength(3);
    });
});

describe('buildGridView — dimensions', () => {
    it('uses file column widths / row heights with defaults', () => {
        const g = buildGridView(
            sheet({
                usedRange: { r0: 0, c0: 0, r1: 1, c1: 2 },
                cells: [txt(0, 0, 'x')],
                columnWidthsPx: { 0: 120, 1: 60 },
                rowHeightsPx: { 0: 40 }
            })
        );
        expect(g.cols).toEqual([120, 60, 100]); // 3rd column default
        expect(g.rows[0]!.heightPx).toBe(40);
        expect(g.rows[1]!.heightPx).toBe(24); // default
    });
});

describe('buildGridView — styles → CSS', () => {
    it('maps a styled cell to inline CSS', () => {
        const styled: ExcelCell = {
            r: 0,
            c: 0,
            t: 'text',
            v: 'hi',
            w: 'hi',
            style: {
                bold: true,
                italic: true,
                fontSizePx: 14,
                color: '#ff0000',
                background: '#ffff00',
                align: 'right',
                valign: 'center',
                wrap: true,
                borders: { bottom: '2px solid #000000' }
            }
        };
        const g = buildGridView(sheet({ usedRange: { r0: 0, c0: 0, r1: 0, c1: 0 }, cells: [styled] }));
        expect(g.rows[0]!.cells[0]!.style).toEqual({
            fontWeight: '700',
            fontStyle: 'italic',
            fontSize: '14px',
            color: '#ff0000',
            backgroundColor: '#ffff00',
            textAlign: 'right',
            verticalAlign: 'center',
            whiteSpace: 'pre-wrap',
            borderBottom: '2px solid #000000'
        });
    });

    it('styleToCss ignores absent attributes', () => {
        expect(styleToCss({})).toEqual({});
        expect(styleToCss({ bold: true })).toEqual({ fontWeight: '700' });
    });
});

describe('buildGridView — truncation and empty', () => {
    it('caps rendered rows by the cell budget', () => {
        const g = buildGridView(
            sheet({ usedRange: { r0: 0, c0: 0, r1: 100, c1: 2 }, cells: [] }),
            { maxCells: 9 }
        );
        expect(g.truncatedRows).toBe(3); // floor(9 / 3 cols)
        expect(g.rows).toHaveLength(3);
        expect(g.cols).toHaveLength(3);
    });

    it('returns an empty view for a sheet with no used range', () => {
        expect(buildGridView(sheet({ usedRange: null, cells: [] }))).toEqual({
            cols: [],
            rows: [],
            truncatedRows: null
        });
    });
});
