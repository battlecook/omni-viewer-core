// Type-preserving XLSX export (docs/viewers/excel.md §2, X7). Re-serializes the
// original parsed model — using each cell's typed value (`v`/`t`), NOT the
// display string (`w`) — so numbers stay numbers, booleans stay booleans, and
// dates stay date-typed cells. Building a worksheet from `w` strings would make
// everything a text cell (the bug this replaces).
//
// Dates: the model stores a calendar-preserving ISO string (model.ts). We
// rebuild a Date from its numeric components — `new Date(y, m, d, …)`, which is
// well-defined (not the impl-defined string parse the parser avoided) — and let
// SheetJS serialize it. SheetJS's own Date→serial→date round-trip is exact,
// whereas hand-computed serials pick up a sub-minute read-back rounding error.
// `xlsx` is injected (base entries never import it — ADR 14).

import type * as XLSX from 'xlsx';
import type { ExcelCell, ExcelWorkbook } from './model.js';

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?)?$/;

export function serializeWorkbook(
    workbook: ExcelWorkbook,
    xlsx: typeof XLSX
): Uint8Array {
    const wb = xlsx.utils.book_new();

    const sheets = workbook.sheets.length
        ? workbook.sheets
        : [{ name: 'Sheet1', usedRange: null, cells: [], rowCount: 0, columnCount: 0 }];

    for (const sheet of sheets) {
        const ws: XLSX.WorkSheet = {};
        for (const cell of sheet.cells) {
            const address = xlsx.utils.encode_cell({ r: cell.r, c: cell.c });
            ws[address] = toCellObject(cell);
        }
        ws['!ref'] = sheet.usedRange
            ? xlsx.utils.encode_range({
                  s: { r: sheet.usedRange.r0, c: sheet.usedRange.c0 },
                  e: { r: sheet.usedRange.r1, c: sheet.usedRange.c1 }
              })
            : 'A1';
        // book_append_sheet enforces the 31-char / uniqueness rules SheetJS
        // expects; it also wires SheetNames + Sheets.
        xlsx.utils.book_append_sheet(wb, ws, sheet.name);
    }

    if (workbook.date1904) {
        wb.Workbook = { ...(wb.Workbook ?? {}), WBProps: { ...(wb.Workbook?.WBProps ?? {}), date1904: true } };
    }

    return new Uint8Array(xlsx.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

function toCellObject(cell: ExcelCell): XLSX.CellObject {
    switch (cell.t) {
        case 'number':
            return { t: 'n', v: typeof cell.v === 'number' ? cell.v : Number(cell.v) };
        case 'boolean':
            return { t: 'b', v: Boolean(cell.v) };
        case 'date': {
            const date = typeof cell.v === 'string' ? isoToDate(cell.v) : null;
            if (!date) {
                // Non-ISO date value — keep the visible text rather than guess.
                return { t: 's', v: cell.w || String(cell.v ?? '') };
            }
            // A date-typed cell + date number format makes SheetJS emit a serial
            // and read it back as a date on the next parse (type preserved).
            return { t: 'd', v: date, z: 'yyyy-mm-dd' };
        }
        case 'error':
            return { t: 's', v: cell.w };
        default:
            return { t: 's', v: cell.v == null ? '' : String(cell.v) };
    }
}

/** Rebuild a Date from ISO components (local, well-defined) — mirrors the
 *  parser's local-getter formatting so the calendar date round-trips. */
function isoToDate(iso: string): Date | null {
    const m = ISO_RE.exec(iso);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = m[4] !== undefined ? Number(m[4]) : 0;
    const minute = m[5] !== undefined ? Number(m[5]) : 0;
    const second = m[6] !== undefined ? Number(m[6]) : 0;
    const millis = m[7] !== undefined ? Number(m[7].padEnd(3, '0')) : 0;
    return new Date(year, month - 1, day, hour, minute, second, millis);
}
