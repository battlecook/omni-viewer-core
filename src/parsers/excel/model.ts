// Excel document model (docs/viewers/excel.md §2, X1). The parser preserves a
// sparse, coordinate-bearing grid — cell address + type + raw value (`v`) +
// the source file's formatted text (`w`). The AOA text table that the core
// viewer renders is *derived* from this model (see `sheetToAoa`), so the model
// stays the single source and web can keep its own grid renderer on top of it
// (ADR 33). Cell styles / merges / column widths are optional follow-up fields
// (X3) and are not populated in v1.

export type ExcelCellType = 'number' | 'text' | 'boolean' | 'date' | 'error';

/**
 * Semantic (non-CSS) presentation attributes for the grid render mode (X3).
 * Populated only when the parser reads styles; the data (AOA) mode ignores it.
 * Colors are `#rrggbb`; borders are CSS shorthand strings (e.g. '1px solid #333').
 */
export interface CellStyle {
    bold?: boolean;
    italic?: boolean;
    fontSizePx?: number;
    color?: string;
    background?: string;
    align?: 'left' | 'center' | 'right' | 'justify';
    valign?: 'top' | 'center' | 'bottom';
    wrap?: boolean;
    borders?: { top?: string; right?: string; bottom?: string; left?: string };
}

/** Inclusive 0-based cell range (used for merges and used ranges). */
export interface CellRange {
    r0: number;
    c0: number;
    r1: number;
    c1: number;
}

export interface ExcelCell {
    /** 0-based absolute row index (sheet origin). */
    r: number;
    /** 0-based absolute column index. */
    c: number;
    t: ExcelCellType;
    /**
     * Raw value. Dates are calendar-preserving ISO-8601 strings (see
     * `dateToIso`); numbers are float64 (SheetJS reads workbook numbers as JS
     * numbers, so values beyond 2^53 already lost precision upstream — X5);
     * errors carry the error text (e.g. '#DIV/0!').
     */
    v: string | number | boolean | null;
    /** Display text as formatted by the source file's number format (`w`). */
    w: string;
    /** Presentation attributes for grid mode (X3); absent when unstyled. */
    style?: CellStyle;
}

export interface ExcelSheet {
    name: string;
    /** Inclusive 0-based bounds of the used range, or null when empty. */
    usedRange: CellRange | null;
    /** Sparse — only cells present in the file, row-major (r, then c). */
    cells: ExcelCell[];
    rowCount: number;
    columnCount: number;
    /** Merged cell ranges (grid mode, X3). */
    merges?: CellRange[];
    /** Absolute column index → width in px (grid mode, X3). */
    columnWidthsPx?: Record<number, number>;
    /** Absolute row index → height in px (grid mode, X3). */
    rowHeightsPx?: Record<number, number>;
}

export interface ExcelWorkbook {
    sheetNames: string[];
    sheets: ExcelSheet[];
    /** 1904 date system flag (affects how date serials map to calendar dates). */
    date1904: boolean;
}

export interface SheetAoa {
    headers: string[];
    rows: string[][];
}

/**
 * Derive a dense AOA (header row + data rows) of display strings from a sparse
 * sheet. Missing cells become '' (X5). When `hasHeader`, the first used row is
 * the header; otherwise headers are empty and every used row is a data row.
 * Pure and deterministic — the core viewer/controller calls this; the parser
 * does not, keeping the model grid-shaped.
 */
export function sheetToAoa(sheet: ExcelSheet, hasHeader = true): SheetAoa {
    if (!sheet.usedRange) return { headers: [], rows: [] };
    const { r0, c0, r1, c1 } = sheet.usedRange;
    const width = c1 - c0 + 1;

    // Bucket cell display text by row for O(cells) fill instead of O(rows*cols)
    // address lookups.
    const byRow = new Map<number, string[]>();
    for (const cell of sheet.cells) {
        let row = byRow.get(cell.r);
        if (!row) {
            row = new Array<string>(width).fill('');
            byRow.set(cell.r, row);
        }
        const col = cell.c - c0;
        if (col >= 0 && col < width) row[col] = cell.w;
    }

    const rowAt = (r: number): string[] => byRow.get(r) ?? new Array<string>(width).fill('');

    let headers: string[];
    let dataStart: number;
    if (hasHeader) {
        headers = rowAt(r0);
        dataStart = r0 + 1;
    } else {
        headers = new Array<string>(width).fill('');
        dataStart = r0;
    }

    const rows: string[][] = [];
    for (let r = dataStart; r <= r1; r++) rows.push(rowAt(r));
    return { headers, rows };
}
