import type { ArrowCell, ArrowDocument } from '../../parsers/arrow/index.js';

export type ArrowViewMode = 'table' | 'schema' | 'raw';
export interface ArrowViewState {
    search: string;
    sortColumn: number | null;
    sortDirection: 'asc' | 'desc' | null;
    page: number;
    pageSize: number;
    pageCount: number;
    matchedRows: number;
    viewMode: ArrowViewMode;
}
export type ArrowAction =
    | { type: 'search'; value: string }
    | { type: 'sort'; column: number }
    | { type: 'page'; page: number }
    | { type: 'page-size'; size: number }
    | { type: 'view'; mode: ArrowViewMode };

export function formatArrowCell(value: ArrowCell): string {
    return value === null ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Compare decimal strings without rounding large integers or fractional digits. */
function compareDecimal(left: string, right: string): number {
    const parts = (value: string) => {
        const [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.');
        const integer = whole.replace(/^0+/, '') || '0';
        return { integer, fraction, negative: value.startsWith('-') && /[1-9]/.test(integer + fraction) };
    };
    const a = parts(left), b = parts(right);
    if (a.negative !== b.negative) return a.negative ? -1 : 1;
    let comparison = a.integer.length - b.integer.length;
    if (!comparison) comparison = a.integer < b.integer ? -1 : a.integer > b.integer ? 1 : 0;
    if (!comparison) {
        const length = Math.max(a.fraction.length, b.fraction.length);
        const x = a.fraction.padEnd(length, '0'), y = b.fraction.padEnd(length, '0');
        comparison = x < y ? -1 : x > y ? 1 : 0;
    }
    return a.negative ? -comparison : comparison;
}

export function createArrowController(document: ArrowDocument) {
    const listeners = new Set<(state: ArrowViewState) => void>();
    let filtered = document.rows.slice();
    let state: ArrowViewState = {
        search: '', sortColumn: null, sortDirection: null, page: 0, pageSize: 100,
        pageCount: Math.max(1, Math.ceil(filtered.length / 100)), matchedRows: filtered.length, viewMode: 'table'
    };
    function rebuild() {
        const query = state.search.toLowerCase();
        filtered = document.rows.filter(row => !query || row.some(value => formatArrowCell(value).toLowerCase().includes(query)));
        const column = state.sortColumn, direction = state.sortDirection;
        if (column !== null && direction !== null) filtered = filtered.map((row, index) => ({ row, index })).sort((a, b) => {
            const x = a.row[column] ?? null, y = b.row[column] ?? null;
            if (x === null || y === null) return x === y ? a.index - b.index : x === null ? 1 : -1;
            let comparison: number;
            if (typeof x === 'number' && typeof y === 'number') comparison = x < y ? -1 : x > y ? 1 : 0;
            else if (typeof x === 'string' && typeof y === 'string' && /^-?\d+(?:\.\d+)?$/.test(x) && /^-?\d+(?:\.\d+)?$/.test(y)) {
                comparison = compareDecimal(x, y);
            } else {
                const left = formatArrowCell(x), right = formatArrowCell(y);
                comparison = left < right ? -1 : left > right ? 1 : 0;
            }
            return comparison ? comparison * (direction === 'asc' ? 1 : -1) : a.index - b.index;
        }).map(item => item.row);
        const pageCount = Math.max(1, Math.ceil(filtered.length / state.pageSize));
        state = { ...state, matchedRows: filtered.length, pageCount, page: Math.min(state.page, pageCount - 1) };
    }
    return {
        get state(): Readonly<ArrowViewState> { return state; },
        dispatch(action: ArrowAction): void {
            if (action.type === 'search') state = { ...state, search: action.value, page: 0 };
            if (action.type === 'sort' && Number.isInteger(action.column) && action.column >= 0 && action.column < document.headers.length) {
                const direction = state.sortColumn !== action.column ? 'asc' : state.sortDirection === 'asc' ? 'desc' : null;
                state = { ...state, sortColumn: direction ? action.column : null, sortDirection: direction, page: 0 };
            }
            if (action.type === 'page' && Number.isFinite(action.page)) state = { ...state, page: Math.max(0, Math.min(Math.floor(action.page), state.pageCount - 1)) };
            if (action.type === 'page-size' && Number.isInteger(action.size) && action.size > 0) state = { ...state, pageSize: Math.min(action.size, 1000), page: 0 };
            if (action.type === 'view') state = { ...state, viewMode: action.mode };
            rebuild();
            listeners.forEach(listener => listener(state));
        },
        subscribe(listener: (state: ArrowViewState) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
        visibleRows(): readonly ArrowCell[][] { return filtered.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize); },
        filteredRows(): readonly ArrowCell[][] { return filtered; },
        toJson(): string {
            return JSON.stringify({ format: document.format, fields: document.fields, metadata: document.metadata, headers: document.headers, rows: filtered,
                preview: { totalRows: document.totalRows, loadedRows: document.loadedRows, matchedRows: filtered.length, isLimited: document.isLimited } }, null, 2);
        }
    };
}
export type ArrowController = ReturnType<typeof createArrowController>;
