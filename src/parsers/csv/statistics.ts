// CSV statistics + TSV/JSON serialization helpers. Ported unchanged (already
// pure and deterministic) from omni-viewer-chrome
// `templates/csv/js/csvStatistics.ts`.

export interface NumericStats {
    count: number;
    mean: number;
    min: number;
    max: number;
}

export interface ColumnStats {
    header: string;
    columnIndex: number;
    total: number;
    count: number;
    nullCount: number;
    /** nullCount / total in [0, 1]; 0 when total === 0. */
    nullPercent: number;
    /** Populated only when the column qualifies as numeric. */
    numeric: NumericStats | null;
}

export function isNullCell(value: string | undefined | null): boolean {
    if (value === undefined || value === null) return true;
    return value.trim().length === 0;
}

export function parseNumericCell(value: string | undefined | null): number | null {
    if (isNullCell(value)) return null;
    const n = Number((value as string).trim());
    return Number.isFinite(n) ? n : null;
}

export function isNumericColumn(
    values: ReadonlyArray<string | undefined | null>
): boolean {
    let nonEmpty = 0;
    for (const v of values) {
        if (isNullCell(v)) continue;
        nonEmpty++;
        if (parseNumericCell(v) === null) return false;
    }
    return nonEmpty > 0;
}

export function computeStatistics(
    rows: ReadonlyArray<ReadonlyArray<string | undefined | null>>,
    headers: ReadonlyArray<string>
): ColumnStats[] {
    const total = rows.length;
    const out: ColumnStats[] = [];

    for (let col = 0; col < headers.length; col++) {
        const header = headers[col] ?? '';
        let nullCount = 0;
        let count = 0;
        const numericValues: number[] = [];
        let allNonEmptyNumeric = true;

        for (let r = 0; r < total; r++) {
            const rowArr = rows[r];
            const cell = rowArr ? rowArr[col] : undefined;
            if (isNullCell(cell)) {
                nullCount++;
                continue;
            }
            count++;
            const n = parseNumericCell(cell);
            if (n === null) {
                allNonEmptyNumeric = false;
            } else {
                numericValues.push(n);
            }
        }

        const nullPercent = total === 0 ? 0 : nullCount / total;

        let numeric: NumericStats | null = null;
        if (allNonEmptyNumeric && numericValues.length > 0) {
            let min = numericValues[0] as number;
            let max = numericValues[0] as number;
            let sum = 0;
            for (const v of numericValues) {
                if (v < min) min = v;
                if (v > max) max = v;
                sum += v;
            }
            numeric = {
                count: numericValues.length,
                mean: sum / numericValues.length,
                min,
                max
            };
        }

        out.push({ header, columnIndex: col, total, count, nullCount, nullPercent, numeric });
    }

    return out;
}

/**
 * Serialize rows (and optional header record) to normalized CSV
 * (docs/viewers/csv.md §6 file export): RFC-4180 quoting — a cell is quoted
 * only when it contains the delimiter, a quote, or a line break; `"` doubles
 * to `""`. LF row separators, no BOM. Original quoting style is not preserved.
 */
export function serializeRowsToCsv(
    rows: ReadonlyArray<ReadonlyArray<string | undefined | null>>,
    headers: ReadonlyArray<string> | undefined,
    delimiter: string
): string {
    const escapeCell = (value: string | undefined | null): string => {
        const v = value == null ? '' : String(value);
        if (v.length === 0) return '';
        if (!v.includes(delimiter) && !/[\r\n"]/.test(v)) return v;
        return '"' + v.replace(/"/g, '""') + '"';
    };
    const lines: string[] = [];
    if (headers && headers.length > 0) {
        lines.push(headers.map(escapeCell).join(delimiter));
    }
    for (const row of rows) {
        lines.push(row.map(escapeCell).join(delimiter));
    }
    return lines.join('\n');
}

/** RFC-4180-style escaping for a TSV cell (quote when tab/CR/LF/`"` present). */
export function escapeTsvCell(value: string | undefined | null): string {
    const v = value == null ? '' : String(value);
    if (v.length === 0) return '';
    if (!/[\t\r\n"]/.test(v)) return v;
    return '"' + v.replace(/"/g, '""') + '"';
}

/** Serialize rows (and optional header record) to TSV with LF separators. */
export function serializeRowsToTsv(
    rows: ReadonlyArray<ReadonlyArray<string | undefined | null>>,
    headers?: ReadonlyArray<string>
): string {
    const lines: string[] = [];
    if (headers && headers.length > 0) {
        lines.push(headers.map(escapeTsvCell).join('\t'));
    }
    for (const row of rows) {
        lines.push(row.map(escapeTsvCell).join('\t'));
    }
    return lines.join('\n');
}

/**
 * Canonical JSON export envelope (docs/viewers/csv.md §6). Headers live in an
 * array, not object keys, so duplicate and empty headers survive verbatim —
 * header-keyed object arrays (and suffix-uniquified variants) are not
 * provided (2026-07-11 decision).
 */
export const CSV_EXPORT_FORMAT = 'omni-viewer/csv-export@1';

export interface CsvExportMetadata {
    scope: 'current-page' | 'loaded-results' | 'full-results';
    sourceRowsLoaded: number;
    sourceFullyScanned: boolean;
}

export function serializeRowsToJson(
    rows: ReadonlyArray<ReadonlyArray<string>>,
    headers: ReadonlyArray<string>,
    metadata: CsvExportMetadata
): string {
    return JSON.stringify(
        {
            format: CSV_EXPORT_FORMAT,
            headers: [...headers],
            rows: rows.map((row) => [...row]),
            metadata
        },
        null,
        2
    );
}

/** Stats-panel number formatting: max 4 fraction digits, no trailing zeros. */
export function formatStatNumber(value: number): string {
    if (!Number.isFinite(value)) return '—';
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(4).replace(/\.?0+$/, '');
}

/** Format a 0..1 fraction as a percentage with up to one decimal place. */
export function formatPercent(fraction: number): string {
    if (!Number.isFinite(fraction)) return '—';
    const pct = fraction * 100;
    if (Number.isInteger(pct)) return `${pct}%`;
    return `${pct.toFixed(1).replace(/\.0$/, '')}%`;
}
