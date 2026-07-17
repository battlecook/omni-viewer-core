// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const parseParquet = vi.hoisted(() => vi.fn());
vi.mock('../../parsers/parquet/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../parsers/parquet/index.js')>();
    return { ...actual, parseParquet };
});

import { mountParquetViewer } from './index.js';

const ctx = {
    assets: { resolveAssetUrl: async (path: string) => path },
    logger: { log: vi.fn() },
    i18n: { t: (key: string, args?: Record<string, string | number>) =>
        ({ 'parquet.loadMore': `Load Next ${args?.count} Rows`, 'parquet.loading': 'Loading…', 'parquet.limited': `${args?.loaded} / ${args?.total}`, 'common.page': `${args?.page}/${args?.pages}` }[key] ?? key) }
};

describe('mountParquetViewer incremental loading', () => {
    beforeEach(() => parseParquet.mockReset());

    it('loads repeated chunks from the current loaded row offset and hides the action at EOF', async () => {
        parseParquet
            .mockResolvedValueOnce({ headers: ['id'], rows: [[1]], schema: {}, totalRows: 3, loadedRows: 1, fileSizeBytes: 60_000_000, isLimited: true })
            .mockResolvedValueOnce({ headers: ['id'], rows: [[2]], schema: {}, totalRows: 3, loadedRows: 1, fileSizeBytes: 60_000_000, isLimited: true })
            .mockResolvedValueOnce({ headers: ['id'], rows: [[3]], schema: {}, totalRows: 3, loadedRows: 1, fileSizeBytes: 60_000_000, isLimited: false });
        const container = document.createElement('div');
        const handle = await mountParquetViewer({ fileName: 'large.parquet', data: new Uint8Array() }, container, ctx, { styleIsolation: 'scoped' });
        const button = [...container.querySelectorAll('button')].find(node => node.textContent?.startsWith('Load Next')) as HTMLButtonElement;
        button.click(); await vi.waitFor(() => expect(parseParquet).toHaveBeenCalledTimes(2));
        expect(parseParquet.mock.calls[1]?.[1]).toMatchObject({ rowStart: 1 });
        button.click(); await vi.waitFor(() => expect(parseParquet).toHaveBeenCalledTimes(3));
        expect(parseParquet.mock.calls[2]?.[1]).toMatchObject({ rowStart: 2 });
        await vi.waitFor(() => expect((container.querySelector('.omni-parquet__warning') as HTMLElement).style.display).toBe('none'));
        expect(container.textContent).toContain('3 / 3');
        handle.dispose();
    });

    it('prevents duplicate requests while a chunk is loading', async () => {
        let resolveChunk!: (value: unknown) => void;
        parseParquet.mockResolvedValueOnce({ headers: ['id'], rows: [[1]], schema: {}, totalRows: 2, loadedRows: 1, fileSizeBytes: 60_000_000, isLimited: true })
            .mockImplementationOnce(() => new Promise(resolve => { resolveChunk = resolve; }));
        const container = document.createElement('div');
        await mountParquetViewer({ fileName: 'large.parquet', data: new Uint8Array() }, container, ctx, { styleIsolation: 'scoped' });
        const button = [...container.querySelectorAll('button')].find(node => node.textContent?.startsWith('Load Next')) as HTMLButtonElement;
        button.click(); button.click();
        expect(parseParquet).toHaveBeenCalledTimes(2);
        resolveChunk({ headers: ['id'], rows: [[2]], schema: {}, totalRows: 2, loadedRows: 1, fileSizeBytes: 60_000_000, isLimited: false });
    });

    it('resizes and auto-fits columns with pointer and keyboard controls', async () => {
        parseParquet.mockResolvedValueOnce({ headers: ['long header'], rows: [['z'], ['a']], schema: {}, totalRows: 2, loadedRows: 2, fileSizeBytes: 10, isLimited: false });
        const container = document.createElement('div');
        await mountParquetViewer({ fileName: 'data.parquet', data: new Uint8Array() }, container, ctx, { styleIsolation: 'scoped' });
        const col = container.querySelector('col') as HTMLTableColElement;
        const resizer = container.querySelector('.omni-parquet__resizer') as HTMLElement;
        const initial = Number.parseInt(col.style.width);
        resizer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 150 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        expect(Number.parseInt(col.style.width)).toBe(initial + 50);
        resizer.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }));
        expect(Number.parseInt(col.style.width)).toBe(initial + 40);
        resizer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        expect(Number.parseInt(col.style.width)).toBe(initial);
        resizer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        resizer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        resizer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        expect([...container.querySelectorAll('tbody td')].map(cell => cell.textContent)).toEqual(['z', 'a']);
    });

    it('copies cells, filtered columns, and the filtered table from menu and keyboard actions', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        parseParquet.mockResolvedValueOnce({ headers: ['name', 'score'], rows: [['alpha', 1], ['beta', 2]], schema: {}, totalRows: 2, loadedRows: 2, fileSizeBytes: 10, isLimited: false });
        const container = document.createElement('div'); document.body.append(container);
        await mountParquetViewer({ fileName: 'data.parquet', data: new Uint8Array() }, container, { ...ctx, clipboard: { writeText } }, { styleIsolation: 'scoped' });
        const search = container.querySelector('input') as HTMLInputElement; search.value = 'alpha'; search.dispatchEvent(new Event('input', { bubbles: true }));
        const firstCell = container.querySelector('td') as HTMLTableCellElement;
        firstCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('alpha'));
        const firstHeader = container.querySelector('th') as HTMLTableCellElement;
        firstHeader.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 20 }));
        const columnCopy = [...container.querySelectorAll('.omni-parquet__menu button')].find(button => button.textContent === 'parquet.copyColumn') as HTMLButtonElement;
        columnCopy.click(); await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('alpha'));
        const frame = container.querySelector('.omni-parquet') as HTMLElement;
        frame.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'c' }));
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('name\tscore\nalpha\t1'));
        frame.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'f' }));
        expect(document.activeElement).toBe(search);
    });
    it('copies a row as JSON from the cell context menu', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        parseParquet.mockResolvedValueOnce({ headers: ['name', 'score'], rows: [['alpha', 1]], schema: {}, totalRows: 1, loadedRows: 1, fileSizeBytes: 10, isLimited: false });
        const container = document.createElement('div'); document.body.append(container);
        await mountParquetViewer({ fileName: 'data.parquet', data: new Uint8Array() }, container, { ...ctx, clipboard: { writeText } }, { styleIsolation: 'scoped' });
        const firstCell = container.querySelector('td') as HTMLTableCellElement;
        firstCell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 20 }));
        const rowCopy = [...container.querySelectorAll('.omni-parquet__menu button')].find(button => button.textContent === 'parquet.copyRow') as HTMLButtonElement;
        rowCopy.click();
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify({ name: 'alpha', score: 1 }, null, 2)));
    });
});
