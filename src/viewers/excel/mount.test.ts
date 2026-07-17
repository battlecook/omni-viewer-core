// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import type { HostContext } from '../../host/index.js';
import { createCatalogI18n } from '../../i18n/index.js';
import { MountAbortedError, type ViewerInput } from '../types.js';
import { mountExcelViewer, type ExcelViewerContext, type ExcelViewerDeps } from './index.js';

function stubCtx(extra: Partial<ExcelViewerContext> = {}): ExcelViewerContext {
    const base: HostContext = {
        assets: { resolveAssetUrl: async (p) => p },
        i18n: createCatalogI18n(),
        logger: { log: () => undefined }
    };
    return { ...base, ...extra };
}

const deps: ExcelViewerDeps = { loadXlsx: async () => XLSX };

function excelInput(aoa: unknown[][], sheetName = 'Sheet1', fileName = 'test.xlsx'): ViewerInput {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
    return { fileName, data: bytes };
}

function multiSheetInput(): ViewerInput {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]]), 'First');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['k'], ['x']]), 'Second');
    return { fileName: 'multi.xlsx', data: new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })) };
}

function shadow(container: HTMLElement): ShadowRoot {
    const root = container.shadowRoot;
    if (!root) throw new Error('expected shadow root');
    return root;
}

/** Header sort is deferred behind a double-click window; click + flush it. */
function clickSort(th: Element | null): void {
    vi.useFakeTimers();
    try {
        (th as HTMLElement).click();
        vi.runAllTimers();
    } finally {
        vi.useRealTimers();
    }
}

/** Commit an inline edit: double-click the cell, type, press Enter. */
function editCell(cell: HTMLElement, value: string): void {
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = cell.querySelector('input') as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

describe('mountExcelViewer', () => {
    it('renders headers and rows inside a shadow root', async () => {
        const container = document.createElement('div');
        const handle = await mountExcelViewer(
            excelInput([['name', 'age'], ['alice', 30], ['bob', 25]]),
            container,
            stubCtx(),
            deps
        );
        const root = shadow(container);
        const headers = [...root.querySelectorAll('thead th')].map((th) =>
            th.textContent?.replace(/[▲▼]/g, '').trim()
        );
        expect(headers).toEqual(['name', 'age']);
        expect(root.querySelectorAll('tbody tr').length).toBe(2);
        handle.dispose();
        expect(root.childNodes.length).toBe(0);
    });

    it('renders a merged cell as a colspan in grid mode (X3)', async () => {
        const ws = XLSX.utils.aoa_to_sheet([['title', '', ''], ['a', 'b', 'c']]);
        ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Grid');
        const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));

        const container = document.createElement('div');
        await mountExcelViewer({ fileName: 'g.xlsx', data: bytes }, container, stubCtx(), deps);
        const root = shadow(container);
        const select = [...root.querySelectorAll('select')].find((s) =>
            [...s.options].some((o) => o.value === 'grid')
        )!;
        select.value = 'grid';
        select.dispatchEvent(new Event('change'));

        const grid = root.querySelector('.omni-excel__grid');
        expect(grid).not.toBeNull();
        const firstCell = grid!.querySelector('tbody td') as HTMLTableCellElement;
        expect(firstCell.colSpan).toBe(3);
        expect(firstCell.textContent).toBe('title');
    });

    it('sorts when a header is clicked (aria-sort reflects direction)', async () => {
        const container = document.createElement('div');
        await mountExcelViewer(
            excelInput([['n'], [9], [10], [2]]),
            container,
            stubCtx(),
            deps
        );
        const root = shadow(container);
        clickSort(root.querySelector('thead th'));
        // The table re-renders on sort, so re-query the (new) header node.
        expect(root.querySelector('thead th')?.getAttribute('aria-sort')).toBe('ascending');
        const firstCol = [...root.querySelectorAll('tbody tr td:first-child')].map((td) => td.textContent);
        expect(firstCol).toEqual(['2', '9', '10']); // numeric, deterministic
    });

    it('resizes columns from their header boundaries and resets on double-click', async () => {
        const container = document.createElement('div');
        await mountExcelViewer(
            excelInput([['name', 'age', 'role'], ['alice', 30, 'admin']]),
            container,
            stubCtx(),
            deps
        );
        const root = shadow(container);
        const handles = () =>
            [...root.querySelectorAll('.omni-excel__resize-handle')] as HTMLElement[];
        const table = () => root.querySelector('table') as HTMLTableElement;
        const firstCol = () => table().querySelector('col') as HTMLTableColElement;

        handles()[0]?.dispatchEvent(
            new MouseEvent('pointerdown', { clientX: 100, bubbles: true })
        );
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 160 }));
        window.dispatchEvent(new MouseEvent('pointerup'));

        expect(firstCol().style.width).toBe('180px');
        expect(table().style.tableLayout).toBe('fixed');
        expect(table().style.width).toBe('360px');
        expect(table().querySelectorAll('col')[1]?.getAttribute('style')).toContain('60px');
        expect(root.querySelector('thead th')?.getAttribute('aria-sort')).toBeNull();

        // Sorting rebuilds the table but keeps the session width selection.
        clickSort(root.querySelector('thead th'));
        expect(firstCol().style.width).toBe('180px');

        handles()[0]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        expect(firstCol().style.width).toBe('');
    });

    it('filters and highlights on search', async () => {
        const container = document.createElement('div');
        await mountExcelViewer(
            excelInput([['a', 'b'], ['xx', 'y'], ['p', 'q']]),
            container,
            stubCtx(),
            deps
        );
        const root = shadow(container);
        const search = root.querySelector('input[type="search"]') as HTMLInputElement;
        search.value = 'xx';
        search.dispatchEvent(new Event('input'));
        expect(root.querySelectorAll('tbody tr').length).toBe(1);
        expect(root.querySelector('.omni-excel__hit')?.textContent).toBe('xx');
    });

    it('edits a cell inline on double-click and shows the dirty badge', async () => {
        const container = document.createElement('div');
        await mountExcelViewer(excelInput([['name', 'age'], ['alice', 30]]), container, stubCtx(), deps);
        const root = shadow(container);
        editCell(root.querySelector('tbody td') as HTMLElement, 'ally');
        expect(root.querySelector('tbody td')?.textContent).toBe('ally');
        expect(root.querySelector('.omni-excel__dirty')?.textContent).toBeTruthy();
    });

    it('undoes an edit via the undo button', async () => {
        const container = document.createElement('div');
        await mountExcelViewer(excelInput([['name'], ['alice']]), container, stubCtx(), deps);
        const root = shadow(container);
        editCell(root.querySelector('tbody td') as HTMLElement, 'ally');
        const undo = [...root.querySelectorAll('.omni-excel__toolbar button')].find(
            (b) => b.getAttribute('aria-label') === 'Undo'
        ) as HTMLButtonElement;
        undo.click();
        expect(root.querySelector('tbody td')?.textContent).toBe('alice');
    });

    it('inserts and deletes rows via the row context menu', async () => {
        const container = document.createElement('div');
        await mountExcelViewer(excelInput([['h'], ['one'], ['two']]), container, stubCtx(), deps);
        const root = shadow(container);
        const rowCount = () => root.querySelectorAll('tbody tr').length;
        expect(rowCount()).toBe(2);

        (root.querySelector('tbody tr') as HTMLElement).dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true })
        );
        const insert = [...root.querySelectorAll('.omni-excel__menu button')].find(
            (b) => b.textContent === 'Insert row below'
        ) as HTMLButtonElement;
        insert.click();
        expect(rowCount()).toBe(3);

        (root.querySelector('tbody tr') as HTMLElement).dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true })
        );
        const del = [...root.querySelectorAll('.omni-excel__menu button')].find(
            (b) => b.textContent === 'Delete row'
        ) as HTMLButtonElement;
        del.click();
        expect(rowCount()).toBe(2);
    });

    it('exports edits with the edited value keeping its inferred type', async () => {
        let savedData: Uint8Array | null = null;
        const saveFile = async (_n: string, data: Uint8Array) => {
            savedData = data;
        };
        const container = document.createElement('div');
        await mountExcelViewer(
            excelInput([['n'], ['1']], 'People', 'team.xlsx'),
            container,
            stubCtx({ save: { saveFile } }),
            deps
        );
        const root = shadow(container);
        // Edit the text-looking "1" to 99 → inferred number, must save as numeric.
        editCell(root.querySelector('tbody td') as HTMLElement, '99');
        const exportBtn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Export XLSX')!;
        exportBtn.click();
        await new Promise((r) => setTimeout(r, 0));

        const wb = XLSX.read(savedData!, { type: 'array' });
        expect(wb.Sheets.People!['A2']!.t).toBe('n');
        expect(wb.Sheets.People!['A2']!.v).toBe(99);
        // Saving clears the dirty badge (markSaved).
        expect(root.querySelector('.omni-excel__dirty')?.textContent).toBeFalsy();
    });

    it('exports a type-preserving XLSX via the save service', async () => {
        let savedData: Uint8Array | null = null;
        let savedName = '';
        let savedMime = '';
        const saveFile = async (name: string, data: Uint8Array, mime: string) => {
            savedName = name;
            savedData = data;
            savedMime = mime;
        };
        const container = document.createElement('div');
        await mountExcelViewer(
            excelInput([['n', 'when'], [42, new Date(2020, 0, 15)]], 'People', 'team.xlsx'),
            container,
            stubCtx({ save: { saveFile } }),
            deps
        );
        const root = shadow(container);
        const exportBtn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Export XLSX')!;
        exportBtn.click();
        await new Promise((r) => setTimeout(r, 0));

        expect(savedName).toBe('team.xlsx');
        expect(savedMime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        // The number stays a numeric cell (not stringified) — the bug this fixes.
        const wb = XLSX.read(savedData!, { type: 'array' });
        expect(wb.Sheets.People!['A2']!.t).toBe('n');
        expect(wb.Sheets.People!['A2']!.v).toBe(42);
        // The date round-trips as a date-typed cell under cellDates.
        const wbDates = XLSX.read(savedData!, { type: 'array', cellDates: true });
        expect(wbDates.Sheets.People!['B2']!.t).toBe('d');
    });

    it('switches sheets via the selector (multi-sheet only)', async () => {
        const container = document.createElement('div');
        await mountExcelViewer(multiSheetInput(), container, stubCtx(), deps);
        const root = shadow(container);
        const select = root.querySelector('select') as HTMLSelectElement;
        expect(select.options.length).toBe(2);
        select.value = '1';
        select.dispatchEvent(new Event('change'));
        const headers = [...root.querySelectorAll('thead th')].map((th) => th.textContent?.trim());
        expect(headers).toEqual(['k']);
    });

    it('switches to the raw JSON view and disables search there', async () => {
        const container = document.createElement('div');
        await mountExcelViewer(excelInput([['a'], ['1']]), container, stubCtx(), deps);
        const root = shadow(container);
        const select = [...root.querySelectorAll('select')].find((s) =>
            [...s.options].some((o) => o.value === 'raw')
        )!;
        select.value = 'raw';
        select.dispatchEvent(new Event('change'));
        expect(root.querySelector('.omni-excel__raw')).not.toBeNull();
        expect((root.querySelector('input[type="search"]') as HTMLInputElement).disabled).toBe(true);
    });

    it('copies via the clipboard service', async () => {
        const writeText = vi.fn(async () => undefined);
        const container = document.createElement('div');
        await mountExcelViewer(
            excelInput([['a', 'b'], ['1', '2']]),
            container,
            stubCtx({ clipboard: { writeText } }),
            deps
        );
        const root = shadow(container);
        const copyTsv = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Copy as TSV')!;
        copyTsv.click();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith('a\tb\n1\t2');
    });

    it('disables copy in degraded mode (no clipboard service)', async () => {
        const container = document.createElement('div');
        await mountExcelViewer(excelInput([['a'], ['1']]), container, stubCtx(), deps);
        const root = shadow(container);
        const copyTsv = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Copy as TSV') as HTMLButtonElement;
        expect(copyTsv.disabled).toBe(true);
        expect(copyTsv.title).toBeTruthy();
    });

    it('disables Export XLSX in degraded mode (no save service)', async () => {
        const container = document.createElement('div');
        await mountExcelViewer(excelInput([['a'], ['1']]), container, stubCtx(), deps);
        const exportBtn = [...shadow(container).querySelectorAll('.omni-excel__toolbar button')].find(
            (button) => button.textContent === 'Export XLSX'
        ) as HTMLButtonElement | undefined;
        expect(exportBtn).toBeDefined();
        expect(exportBtn?.disabled).toBe(true);
    });

    it('surfaces a missing-dependency reason when xlsx fails to load', async () => {
        const container = document.createElement('div');
        const failingDeps: ExcelViewerDeps = { loadXlsx: async () => { throw new Error('no xlsx'); } };
        await mountExcelViewer(excelInput([['a'], ['1']]), container, stubCtx(), failingDeps);
        const root = shadow(container);
        expect(root.querySelector('.omni-excel__diag-error')?.textContent).toContain('engine');
        expect(root.querySelector('tbody')).toBeNull();
    });

    it('rejects when already aborted and leaves nothing mounted', async () => {
        const container = document.createElement('div');
        await expect(
            mountExcelViewer(excelInput([['a']]), container, stubCtx(), deps, {
                signal: AbortSignal.abort()
            })
        ).rejects.toBeInstanceOf(MountAbortedError);
        expect(container.shadowRoot?.childNodes.length ?? 0).toBe(0);
    });

    it('dispose removes listeners (no re-render after teardown)', async () => {
        const container = document.createElement('div');
        const handle = await mountExcelViewer(multiSheetInput(), container, stubCtx(), deps);
        const root = shadow(container);
        const select = root.querySelector('select') as HTMLSelectElement;
        handle.dispose();
        // Dispatching after dispose must not throw or repopulate the container.
        select.value = '1';
        select.dispatchEvent(new Event('change'));
        expect(root.childNodes.length).toBe(0);
    });
});
