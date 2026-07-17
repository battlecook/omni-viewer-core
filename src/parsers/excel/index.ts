// Excel parser entry — the core contract surface (docs/viewers/excel.md §2,
// DESIGN.md §3-①). parseExcel(bytes) -> ParseOutcome<ExcelWorkbook>.
//
// SheetJS (`xlsx`) is an optional peer dependency and is **injected** rather
// than imported at runtime (ExcelParseDeps), so this base entry carries no
// `import 'xlsx'` — the bundler of a platform that doesn't use the Excel viewer
// never has to resolve it (ADR 14, X8). Type-only imports below are erased.
//
// Input-caused failures never throw; they return `status: 'failed'` (ADR 11).
// Input ownership is `consumes` — after parsing, the original bytes are not
// needed (no verbatim view), so a Worker may transfer them (X4, DESIGN §3-①).

import type * as XLSX from 'xlsx';
import type {
    Diagnostic,
    ParseFailure,
    ParseOptions,
    ParseOutcome,
    ParseResult
} from '../types.js';
import { DEFAULT_LIMITS, LimitTracker } from '../types.js';
import type { CellStyle, ExcelCell, ExcelCellType, ExcelSheet, ExcelWorkbook } from './model.js';

export type {
    CellRange,
    CellStyle,
    ExcelCell,
    ExcelCellType,
    ExcelSheet,
    ExcelWorkbook,
    SheetAoa
} from './model.js';
export { sheetToAoa } from './model.js';
export { serializeWorkbook } from './serialize.js';

/** SheetJS is provided by the caller; the base entry never imports it. */
export interface ExcelParseDeps {
    xlsx: typeof XLSX;
}

/** Input ownership: the parser consumes the input (DESIGN.md §3-①). */
export const EXCEL_INPUT_OWNERSHIP = 'consumes' as const;

export function parseExcel(
    input: Uint8Array,
    deps: ExcelParseDeps,
    options: ParseOptions = {}
): ParseOutcome<ExcelWorkbook> {
    const started = Date.now();
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    const diagnostics: Diagnostic[] = [];

    const finish = (result: ParseResult<ExcelWorkbook>): ParseOutcome<ExcelWorkbook> => ({
        result,
        execution: {
            workerUsed: false,
            // SheetJS decompresses the whole zip internally, so maxDecompressedBytes
            // is not enforced during read in v1 — only maxInputBytes (pre-load) and
            // maxEntries (post-read cell cap) are hard here (X4, follow-up: Worker).
            hardLimitEnforced: false,
            elapsedMillis: Date.now() - started
        }
    });

    if (input.byteLength > limits.maxInputBytes) {
        return finish(fail('limit-exceeded', false, 'diag.limit-exceeded.input', diagnostics, {
            maxBytes: limits.maxInputBytes
        }));
    }
    if (options.signal?.aborted) {
        return finish(fail('aborted', true, 'diag.aborted', diagnostics));
    }

    let wb: XLSX.WorkBook;
    try {
        wb = deps.xlsx.read(input, {
            type: 'array',
            cellDates: true,
            cellNF: true,
            cellText: true,
            cellStyles: true // grid mode (X3): populate cell.s / !cols / !rows
        });
    } catch (err) {
        const message = String((err as { message?: unknown })?.message ?? err).toLowerCase();
        if (message.includes('password') || message.includes('encrypt')) {
            return finish(fail('password-required', true, 'diag.excel.password-required', diagnostics));
        }
        return finish(fail('invalid-format', false, 'diag.excel.invalid-format', diagnostics));
    }

    const date1904 = readDate1904(wb);
    const sheetNames = Array.isArray(wb.SheetNames) ? [...wb.SheetNames] : [];
    const tracker = new LimitTracker(limits, options.signal);

    const sheets: ExcelSheet[] = [];
    let truncated = false;
    let aborted = false;
    let nonEmptySheets = 0;

    for (const name of sheetNames) {
        const ws = wb.Sheets[name];
        const built = ws ? buildSheet(name, ws, deps.xlsx, tracker, limits.maxEntries) : emptySheet(name);
        sheets.push(built.sheet);
        if (built.sheet.usedRange) nonEmptySheets++;
        if (built.aborted) { aborted = true; break; }
        if (built.truncated) { truncated = true; break; }
    }

    if (aborted) {
        return finish(fail('aborted', true, 'diag.aborted', diagnostics));
    }

    if (sheetNames.length === 0 || nonEmptySheets === 0) {
        diagnostics.push({
            severity: 'info',
            code: 'excel.empty-workbook',
            messageKey: 'diag.excel.empty-workbook'
        });
    }

    const document: ExcelWorkbook = { sheetNames, sheets, date1904 };

    if (truncated) {
        diagnostics.push({
            severity: 'warning',
            code: 'limit-exceeded',
            messageKey: 'diag.limit-exceeded.cells',
            args: { count: tracker.entryCount }
        });
        return finish({ status: 'partial', document, diagnostics });
    }

    return finish({ status: 'ok', document, diagnostics });
}

function fail(
    code: ParseFailure['code'],
    retryable: boolean,
    messageKey: string,
    diagnostics: Diagnostic[],
    args?: Record<string, string | number>
): ParseResult<ExcelWorkbook> {
    return {
        status: 'failed',
        failure: args ? { code, retryable, messageKey, args } : { code, retryable, messageKey },
        diagnostics
    };
}

interface BuiltSheet {
    sheet: ExcelSheet;
    truncated: boolean;
    aborted: boolean;
}

function emptySheet(name: string): BuiltSheet {
    return {
        sheet: { name, usedRange: null, cells: [], rowCount: 0, columnCount: 0 },
        truncated: false,
        aborted: false
    };
}

function buildSheet(
    name: string,
    ws: XLSX.WorkSheet,
    xlsx: typeof XLSX,
    tracker: LimitTracker,
    maxEntries: number
): BuiltSheet {
    const usedRange = resolveUsedRange(ws, xlsx);
    if (!usedRange) {
        return emptySheet(name);
    }

    // Collect present cells only (sparse) and emit row-major for deterministic
    // order regardless of the object key order SheetJS produced.
    const addresses: { r: number; c: number; addr: string }[] = [];
    for (const key of Object.keys(ws)) {
        if (key.charCodeAt(0) === 0x21 /* '!' */) continue;
        const decoded = xlsx.utils.decode_cell(key);
        addresses.push({ r: decoded.r, c: decoded.c, addr: key });
    }
    addresses.sort((a, b) => (a.r - b.r) || (a.c - b.c));

    const cells: ExcelCell[] = [];
    let truncated = false;
    let aborted = false;

    for (let i = 0; i < addresses.length; i++) {
        const entry = addresses[i]!;
        const raw = ws[entry.addr] as XLSX.CellObject | undefined;
        if (!raw || raw.t === 'z' || raw.t === undefined) continue; // blank/stub

        tracker.addEntries(1);
        // Amortize abort/limit checks: every 512 cells or once over the cap.
        if (i % 512 === 0 || tracker.entryCount > maxEntries) {
            const violation = tracker.checkpoint();
            if (violation?.kind === 'aborted') { aborted = true; break; }
            if (violation) { truncated = true; break; }
        }

        cells.push(mapCell(entry.r, entry.c, raw));
    }

    const sheet: ExcelSheet = {
        name,
        usedRange,
        cells,
        rowCount: usedRange.r1 - usedRange.r0 + 1,
        columnCount: usedRange.c1 - usedRange.c0 + 1
    };
    // Grid-mode presentation (X3): merges + column/row sizes. Optional — only
    // set when present, so the data mode and existing snapshots are unaffected.
    const merges = (ws['!merges'] as XLSX.Range[] | undefined)?.map((m) => ({
        r0: m.s.r,
        c0: m.s.c,
        r1: m.e.r,
        c1: m.e.c
    }));
    if (merges && merges.length) sheet.merges = merges;

    const cols = ws['!cols'] as XLSX.ColInfo[] | undefined;
    if (cols) {
        const widths: Record<number, number> = {};
        cols.forEach((col, c) => {
            const px = colWidthPx(col);
            if (px !== null) widths[c] = px;
        });
        if (Object.keys(widths).length) sheet.columnWidthsPx = widths;
    }
    const rows = ws['!rows'] as XLSX.RowInfo[] | undefined;
    if (rows) {
        const heights: Record<number, number> = {};
        rows.forEach((row, r) => {
            const px = rowHeightPx(row);
            if (px !== null) heights[r] = px;
        });
        if (Object.keys(heights).length) sheet.rowHeightsPx = heights;
    }

    return { sheet, truncated, aborted };
}

/** Column width in px from SheetJS ColInfo (ported from omni-viewer-web). */
function colWidthPx(col: XLSX.ColInfo | undefined): number | null {
    if (!col) return null;
    if (typeof col.wpx === 'number') return clampPx(col.wpx, 24, 800);
    if (typeof col.wch === 'number') return clampPx(col.wch * 8 + 12, 24, 800);
    if (typeof col.width === 'number') return clampPx((col.width / 256) * 8 + 12, 24, 800);
    return null;
}

/** Row height in px from SheetJS RowInfo (ported from omni-viewer-web). */
function rowHeightPx(row: XLSX.RowInfo | undefined): number | null {
    if (!row) return null;
    if (typeof row.hpx === 'number') return clampPx(row.hpx, 20, 240);
    if (typeof row.hpt === 'number') return clampPx((row.hpt * 96) / 72, 20, 240);
    return null;
}

function clampPx(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.round(value)));
}

function resolveUsedRange(
    ws: XLSX.WorkSheet,
    xlsx: typeof XLSX
): ExcelSheet['usedRange'] {
    const ref = ws['!ref'];
    if (ref) {
        try {
            const range = xlsx.utils.decode_range(ref);
            if (range.e.r >= range.s.r && range.e.c >= range.s.c) {
                return { r0: range.s.r, c0: range.s.c, r1: range.e.r, c1: range.e.c };
            }
        } catch {
            // fall through to manual reconstruction
        }
    }
    let r0 = Infinity, c0 = Infinity, r1 = -1, c1 = -1;
    for (const key of Object.keys(ws)) {
        if (key.charCodeAt(0) === 0x21) continue;
        const cell = xlsx.utils.decode_cell(key);
        if (cell.r < r0) r0 = cell.r;
        if (cell.c < c0) c0 = cell.c;
        if (cell.r > r1) r1 = cell.r;
        if (cell.c > c1) c1 = cell.c;
    }
    if (r1 < 0 || c1 < 0) return null;
    return { r0, c0, r1, c1 };
}

function mapCell(r: number, c: number, cell: XLSX.CellObject): ExcelCell {
    const w = cell.w != null ? String(cell.w) : (cell.v == null ? '' : String(cell.v));
    let t: ExcelCellType;
    let v: ExcelCell['v'];
    switch (cell.t) {
        case 'n':
            t = 'number';
            v = typeof cell.v === 'number' ? cell.v : Number(cell.v);
            break;
        case 'b':
            t = 'boolean';
            v = Boolean(cell.v);
            break;
        case 'd':
            t = 'date';
            v = cell.v instanceof Date ? dateToIso(cell.v) : String(cell.v ?? '');
            break;
        case 'e':
            t = 'error';
            v = w;
            break;
        default: // 's' | 'str' (formula string result) | anything else
            t = 'text';
            v = cell.v == null ? '' : String(cell.v);
            break;
    }
    const style = mapStyle((cell as { s?: unknown }).s);
    return style ? { r, c, t, v, w, style } : { r, c, t, v, w };
}

/** Map a SheetJS cell style object to the semantic CellStyle (grid mode, X3).
 *  Ported from omni-viewer-web `mapCellStyle`; stores semantic values, not CSS. */
function mapStyle(s: unknown): CellStyle | undefined {
    if (!s || typeof s !== 'object') return undefined;
    const style = s as Record<string, unknown>;
    const out: CellStyle = {};

    const font = style.font as Record<string, unknown> | undefined;
    if (font?.bold) out.bold = true;
    if (font?.italic) out.italic = true;
    if (typeof font?.sz === 'number') out.fontSizePx = Math.max(8, Math.min(64, font.sz));
    const color = normalizeColor(font?.color);
    if (color) out.color = color;

    const fill = style.fill as Record<string, unknown> | undefined;
    const bg = normalizeColor(fill?.fgColor) ?? normalizeColor(fill?.bgColor);
    if (bg && fill?.patternType && fill.patternType !== 'none') out.background = bg;

    const align = style.alignment as Record<string, unknown> | undefined;
    const h = align?.horizontal !== undefined ? String(align.horizontal) : '';
    if (h === 'left' || h === 'center' || h === 'right' || h === 'justify') out.align = h;
    else if (h === 'centerContinuous') out.align = 'center';
    else if (h === 'distributed') out.align = 'justify';
    const va = align?.vertical !== undefined ? String(align.vertical) : '';
    if (va === 'top' || va === 'center' || va === 'bottom') out.valign = va;
    if (align?.wrapText) out.wrap = true;

    const border = style.border as Record<string, unknown> | undefined;
    if (border) {
        const edges: NonNullable<CellStyle['borders']> = {};
        const toEdge = (edge: unknown): string | undefined => {
            if (!edge || typeof edge !== 'object') return undefined;
            const e = edge as Record<string, unknown>;
            const c = normalizeColor(e.color) ?? '#808080';
            return `${borderStyle(typeof e.style === 'string' ? e.style : undefined)} ${c}`;
        };
        const top = toEdge(border.top);
        const right = toEdge(border.right);
        const bottom = toEdge(border.bottom);
        const left = toEdge(border.left);
        if (top) edges.top = top;
        if (right) edges.right = right;
        if (bottom) edges.bottom = bottom;
        if (left) edges.left = left;
        if (Object.keys(edges).length) out.borders = edges;
    }

    return Object.keys(out).length ? out : undefined;
}

function normalizeColor(color: unknown): string | undefined {
    if (!color || typeof color !== 'object') return undefined;
    const rgb = (color as { rgb?: unknown }).rgb;
    if (typeof rgb !== 'string') return undefined;
    const raw = rgb.replace('#', '');
    const hex = raw.length > 6 ? raw.slice(-6) : raw;
    return /^[0-9A-Fa-f]{6}$/.test(hex) ? `#${hex}` : undefined;
}

function borderStyle(style: string | undefined): string {
    switch (style) {
        case 'medium': return '2px solid';
        case 'thick': return '3px solid';
        case 'dashed': return '1px dashed';
        case 'dotted': return '1px dotted';
        case 'double': return '3px double';
        default: return '1px solid'; // thin / hair / unknown
    }
}

/**
 * Format a SheetJS date cell to a calendar-preserving ISO string. SheetJS
 * constructs the Date from the serial's parts in local time; reading them back
 * with local getters round-trips the intended calendar date on any host
 * timezone (deterministic), so we never call the timezone-sensitive
 * `toISOString()` (X5, determinism rule).
 */
function dateToIso(d: Date): string {
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
    const y = pad(d.getFullYear(), 4);
    const mo = pad(d.getMonth() + 1);
    const da = pad(d.getDate());
    const h = d.getHours();
    const mi = d.getMinutes();
    const s = d.getSeconds();
    const ms = d.getMilliseconds();
    if (h === 0 && mi === 0 && s === 0 && ms === 0) return `${y}-${mo}-${da}`;
    const base = `${y}-${mo}-${da}T${pad(h)}:${pad(mi)}:${pad(s)}`;
    return ms ? `${base}.${pad(ms, 3)}` : base;
}

function readDate1904(wb: XLSX.WorkBook): boolean {
    // SheetJS types this as boolean | undefined, but files can carry 1/"1";
    // coerce defensively without tripping strict comparisons.
    const flag = wb.Workbook?.WBProps?.date1904 as unknown;
    return flag === true || flag === 1 || flag === '1' || flag === 'true';
}
