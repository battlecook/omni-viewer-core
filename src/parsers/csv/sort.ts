// CSV column sort. Ported from omni-viewer-chrome `templates/csv/js/csvSort.ts`
// with the engine/locale-dependent pieces replaced by deterministic
// equivalents (DESIGN.md §3-① determinism rule, ADR 41):
//
//   - `Date.parse(...)` (implementation-defined for non-ISO input) is replaced
//     by an explicit ISO-shape parser (`parseDateKey`) that computes the epoch
//     via Date.UTC. Values that don't match the supported shapes make the
//     column non-date.
//   - `localeCompare(..., { numeric: true })` (ICU-dependent collation) is
//     replaced by a code-point natural compare with digit-run chunking.
//   - `toLocaleLowerCase()` is replaced by `toLowerCase()` (Unicode default
//     case conversion — locale-independent per spec).
//
// Sort semantics preserved from the original:
//   - Three-state cycle per column: asc -> desc -> none.
//   - Stable: equal pairs keep original order.
//   - Empty ("", whitespace) values sort to the bottom for both directions.
//   - Column-level type detection (number / date / text) so one mixed cell
//     can't flip the ordering rule mid-sort.

export type SortDirection = 'asc' | 'desc' | null;

export interface SortState {
    columnIndex: number | null;
    direction: SortDirection;
}

export type ColumnType = 'number' | 'date' | 'text';

/** Cycle asc -> desc -> none; switching column restarts at asc. */
export function nextSortState(current: SortState, columnIndex: number): SortState {
    if (current.columnIndex !== columnIndex) {
        return { columnIndex, direction: 'asc' };
    }
    if (current.direction === 'asc') {
        return { columnIndex, direction: 'desc' };
    }
    if (current.direction === 'desc') {
        return { columnIndex: null, direction: null };
    }
    return { columnIndex, direction: 'asc' };
}

// Supported deterministic date shapes:
//   YYYY-MM-DD / YYYY/MM/DD, optionally followed by [T or space]
//   hh:mm[:ss[.SSS]] and an optional timezone (Z or ±hh[:]mm).
// Timezone-less values are interpreted as UTC — deterministic and
// order-consistent within a column.
const DATE_RE =
    /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Parse a supported date shape to epoch millis; null when not date-shaped. */
export function parseDateKey(value: string): number | null {
    const m = DATE_RE.exec(value);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    // Date.UTC silently normalizes overflow (2024-02-31 -> Mar 2). Round-trip
    // the calendar date so nonexistent dates stay text, not date keys.
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (
        calendar.getUTCFullYear() !== year ||
        calendar.getUTCMonth() !== month - 1 ||
        calendar.getUTCDate() !== day
    ) {
        return null;
    }

    const hour = m[4] !== undefined ? Number(m[4]) : 0;
    const minute = m[5] !== undefined ? Number(m[5]) : 0;
    const second = m[6] !== undefined ? Number(m[6]) : 0;
    const millis = m[7] !== undefined ? Number(m[7].padEnd(3, '0')) : 0;
    if (hour > 23 || minute > 59 || second > 59) return null;

    let epoch = Date.UTC(year, month - 1, day, hour, minute, second, millis);

    const tz = m[8];
    if (tz && tz !== 'Z') {
        const sign = tz[0] === '-' ? -1 : 1;
        const digits = tz.slice(1).replace(':', '');
        const offsetHours = Number(digits.slice(0, 2));
        const offsetMins = Number(digits.slice(2, 4));
        // Real-world offsets span -12:00..+14:00; reject syntactic garbage
        // like +99:99 so it stays text instead of poisoning date detection.
        if (offsetMins > 59 || offsetHours > 14 || (offsetHours === 14 && offsetMins > 0)) {
            return null;
        }
        epoch -= sign * (offsetHours * 60 + offsetMins) * 60_000;
    }
    return epoch;
}

/**
 * Detect the type of a column from its values. Empty strings are ignored —
 * they sort separately at the end.
 */
export function detectColumnType(values: readonly string[]): ColumnType {
    let nonEmpty = 0;
    let allNumeric = true;
    let allDate = true;
    for (const raw of values) {
        const v = (raw ?? '').trim();
        if (!v) continue;
        nonEmpty++;
        if (allNumeric && !Number.isFinite(Number(v))) {
            allNumeric = false;
        }
        if (allDate && parseDateKey(v) === null) {
            allDate = false;
        }
        if (!allNumeric && !allDate) break;
    }
    if (nonEmpty === 0) return 'text';
    if (allNumeric) return 'number';
    if (allDate) return 'date';
    return 'text';
}

/**
 * Deterministic natural compare: splits both strings into digit / non-digit
 * runs; digit runs compare numerically ("10" > "9"), other runs compare by
 * code point over the Unicode-default lowercased form.
 */
export function naturalCompare(a: string, b: string): number {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    let i = 0;
    let j = 0;
    while (i < la.length && j < lb.length) {
        const ca = la.charCodeAt(i);
        const cb = lb.charCodeAt(j);
        const aDigit = ca >= 48 && ca <= 57;
        const bDigit = cb >= 48 && cb <= 57;

        if (aDigit && bDigit) {
            let ia = i;
            while (ia < la.length && isDigitCode(la.charCodeAt(ia))) ia++;
            let jb = j;
            while (jb < lb.length && isDigitCode(lb.charCodeAt(jb))) jb++;
            // Compare digit runs numerically via zero-trimmed length + lexical.
            const ra = trimLeadingZeros(la.slice(i, ia));
            const rb = trimLeadingZeros(lb.slice(j, jb));
            if (ra.length !== rb.length) return ra.length - rb.length;
            if (ra !== rb) return ra < rb ? -1 : 1;
            i = ia;
            j = jb;
            continue;
        }

        if (ca !== cb) return ca - cb;
        i++;
        j++;
    }
    if (la.length !== lb.length) return la.length - i - (lb.length - j);
    // Equal ignoring case: fall back to raw code-point compare for stability.
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

function isDigitCode(code: number): boolean {
    return code >= 48 && code <= 57;
}

function trimLeadingZeros(s: string): string {
    let k = 0;
    while (k < s.length - 1 && s[k] === '0') k++;
    return s.slice(k);
}

interface NormalizedValue {
    isEmpty: boolean;
    /** number for numeric/date columns; original string for text. */
    key: number | string;
}

function normalize(raw: string, type: ColumnType): NormalizedValue {
    const v = (raw ?? '').trim();
    if (!v) return { isEmpty: true, key: '' };
    if (type === 'number') {
        const n = Number(v);
        return Number.isFinite(n) ? { isEmpty: false, key: n } : { isEmpty: false, key: v };
    }
    if (type === 'date') {
        const ms = parseDateKey(v);
        return ms !== null ? { isEmpty: false, key: ms } : { isEmpty: false, key: v };
    }
    return { isEmpty: false, key: v };
}

function compareNormalized(a: NormalizedValue, b: NormalizedValue): number {
    if (a.isEmpty && b.isEmpty) return 0;
    if (a.isEmpty) return 1;
    if (b.isEmpty) return -1;

    if (typeof a.key === 'number' && typeof b.key === 'number') {
        if (a.key < b.key) return -1;
        if (a.key > b.key) return 1;
        return 0;
    }
    return naturalCompare(String(a.key), String(b.key));
}

/**
 * Produce a sorted copy of `rowIndices` according to `state`. Stable; never
 * mutates the input; empties end up at the bottom in both directions.
 */
export function applySort(
    rowIndices: readonly number[],
    state: SortState,
    getCell: (rowIndex: number, columnIndex: number) => string,
    columnType?: ColumnType
): number[] {
    if (state.columnIndex === null || !state.direction) {
        return [...rowIndices];
    }
    const { columnIndex, direction } = state;
    const dir = direction === 'asc' ? 1 : -1;

    const type =
        columnType ?? detectColumnType(rowIndices.map((i) => getCell(i, columnIndex)));

    const decorated = rowIndices.map((rowIndex, position) => ({
        rowIndex,
        position,
        norm: normalize(getCell(rowIndex, columnIndex), type)
    }));

    decorated.sort((a, b) => {
        if (a.norm.isEmpty || b.norm.isEmpty) {
            const cmp = compareNormalized(a.norm, b.norm);
            if (cmp !== 0) return cmp;
            return a.position - b.position;
        }
        const cmp = compareNormalized(a.norm, b.norm);
        if (cmp !== 0) return cmp * dir;
        return a.position - b.position;
    });

    return decorated.map((d) => d.rowIndex);
}
