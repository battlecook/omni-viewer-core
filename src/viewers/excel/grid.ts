// Grid render model (X3) — turns a parsed ExcelSheet (cells + merges + column/
// row sizes + styles) into a renderable, CSS-ready structure for the WYSIWYG
// grid view. Pure and DOM-free (ported from omni-viewer-web `buildSheetView`),
// so both the core DOM renderer and web's Vue renderer can consume it.
//
// This is a read-only view of the original parsed sheet — it does not reflect
// data-mode edits (docs/viewers/excel.md §3, X3 decision).

import type { CellStyle, ExcelCell, ExcelSheet } from '../../parsers/excel/index.js';

export interface GridCell {
    r: number;
    c: number;
    rowSpan: number;
    colSpan: number;
    text: string;
    /** CSS property → value (camelCase keys), applied as an inline style. */
    style: Record<string, string>;
}

export interface GridRow {
    heightPx: number;
    cells: GridCell[];
}

export interface GridView {
    /** Column widths in px, in used-range order. */
    cols: number[];
    rows: GridRow[];
    /** Rendered row count when the sheet was capped, else null. */
    truncatedRows: number | null;
}

const DEFAULT_COL_WIDTH = 100;
const DEFAULT_ROW_HEIGHT = 24;
/** Cell budget before the grid truncates to keep the DOM bounded (web parity). */
export const GRID_MAX_CELLS = 60000;

export function buildGridView(sheet: ExcelSheet, options: { maxCells?: number } = {}): GridView {
    const range = sheet.usedRange;
    if (!range) return { cols: [], rows: [], truncatedRows: null };

    const maxCells = options.maxCells ?? GRID_MAX_CELLS;
    const totalRows = range.r1 - range.r0 + 1;
    const totalCols = range.c1 - range.c0 + 1;

    let lastRow = range.r1;
    let truncatedRows: number | null = null;
    if (totalRows * totalCols > maxCells) {
        const maxRows = Math.max(1, Math.floor(maxCells / Math.max(1, totalCols)));
        lastRow = range.r0 + maxRows - 1;
        truncatedRows = maxRows;
    }

    const cellByAddr = new Map<string, ExcelCell>();
    for (const cell of sheet.cells) cellByAddr.set(`${cell.r}:${cell.c}`, cell);

    // Merges: the top-left cell carries the span; the rest are covered/skipped.
    const mergeStarts = new Map<string, { rowSpan: number; colSpan: number }>();
    const mergeCovered = new Set<string>();
    for (const m of sheet.merges ?? []) {
        for (let r = m.r0; r <= m.r1; r++) {
            for (let c = m.c0; c <= m.c1; c++) {
                const key = `${r}:${c}`;
                if (r === m.r0 && c === m.c0) {
                    mergeStarts.set(key, { rowSpan: m.r1 - m.r0 + 1, colSpan: m.c1 - m.c0 + 1 });
                } else {
                    mergeCovered.add(key);
                }
            }
        }
    }

    const cols: number[] = [];
    for (let c = range.c0; c <= range.c1; c++) {
        cols.push(sheet.columnWidthsPx?.[c] ?? DEFAULT_COL_WIDTH);
    }

    const rows: GridRow[] = [];
    for (let r = range.r0; r <= lastRow; r++) {
        const cells: GridCell[] = [];
        for (let c = range.c0; c <= range.c1; c++) {
            const key = `${r}:${c}`;
            if (mergeCovered.has(key)) continue;
            const cell = cellByAddr.get(key);
            const span = mergeStarts.get(key);
            cells.push({
                r,
                c,
                rowSpan: span?.rowSpan ?? 1,
                colSpan: span?.colSpan ?? 1,
                text: cell?.w ?? '',
                style: cell?.style ? styleToCss(cell.style) : {}
            });
        }
        rows.push({ heightPx: sheet.rowHeightsPx?.[r] ?? DEFAULT_ROW_HEIGHT, cells });
    }

    return { cols, rows, truncatedRows };
}

/** Convert the semantic CellStyle to CSS property→value pairs (camelCase). */
export function styleToCss(style: CellStyle): Record<string, string> {
    const css: Record<string, string> = {};
    if (style.bold) css.fontWeight = '700';
    if (style.italic) css.fontStyle = 'italic';
    if (typeof style.fontSizePx === 'number') css.fontSize = `${style.fontSizePx}px`;
    if (style.color) css.color = style.color;
    if (style.background) css.backgroundColor = style.background;
    if (style.align) css.textAlign = style.align;
    if (style.valign) css.verticalAlign = style.valign;
    if (style.wrap) css.whiteSpace = 'pre-wrap';
    if (style.borders?.top) css.borderTop = style.borders.top;
    if (style.borders?.right) css.borderRight = style.borders.right;
    if (style.borders?.bottom) css.borderBottom = style.borders.bottom;
    if (style.borders?.left) css.borderLeft = style.borders.left;
    return css;
}
