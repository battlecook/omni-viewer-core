// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const parseParquet = vi.hoisted(() => vi.fn());
vi.mock('../../parsers/parquet/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../parsers/parquet/index.js')>();
    return { ...actual, parseParquet };
});

import { MountAbortedError } from '../types.js';
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
        const copyTable = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'parquet.copyTable')!;
        copyTable.click();
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('name\tscore\nalpha\t1'));
        frame.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'c' }));
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('name\tscore\nalpha\t1'));
        frame.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'f' }));
        expect(document.activeElement).toBe(search);
    });

    it('renders disabled table and JSON copy buttons without a clipboard service', async () => {
        parseParquet.mockResolvedValueOnce({ headers: ['id'], rows: [[1]], schema: {}, totalRows: 1, loadedRows: 1, fileSizeBytes: 10, isLimited: false });
        const container = document.createElement('div');
        await mountParquetViewer({ fileName: 'data.parquet', data: new Uint8Array() }, container, ctx, { styleIsolation: 'scoped' });
        for (const key of ['parquet.copyTable', 'parquet.copyJson']) {
            const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === key)!;
            expect(button.disabled).toBe(true); expect(button.title).toBe('common.noClipboard');
        }
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

    it('reuses the parsed footer metadata for follow-up chunks instead of re-reading it', async () => {
        const fileMetadata = { num_rows: 3n };
        parseParquet
            .mockResolvedValueOnce({ headers: ['id'], rows: [[1]], schema: {}, totalRows: 3, loadedRows: 1, fileSizeBytes: 60_000_000, isLimited: true, fileMetadata })
            .mockResolvedValueOnce({ headers: ['id'], rows: [[2]], schema: {}, totalRows: 3, loadedRows: 1, fileSizeBytes: 60_000_000, isLimited: false, fileMetadata });
        const container = document.createElement('div');
        await mountParquetViewer({ fileName: 'large.parquet', data: new Uint8Array() }, container, ctx, { styleIsolation: 'scoped' });
        const button = [...container.querySelectorAll('button')].find(node => node.textContent?.startsWith('Load Next')) as HTMLButtonElement;
        button.click();
        await vi.waitFor(() => expect(parseParquet).toHaveBeenCalledTimes(2));
        expect(parseParquet.mock.calls[1]?.[1]).toMatchObject({ rowStart: 1, metadata: fileMetadata });
        // The initial parse must not carry a metadata hint — there is nothing to reuse yet.
        expect(parseParquet.mock.calls[0]?.[1]).not.toHaveProperty('metadata');
    });
});

describe('mountParquetViewer teardown', () => {
    beforeEach(() => parseParquet.mockReset());

    it('tears itself down when the signal fires while parsing, instead of returning a live handle', async () => {
        const controller = new AbortController();
        parseParquet.mockImplementationOnce(async () => {
            // Abort lands after the parse resolves but before mount returns.
            controller.abort();
            return { headers: ['id'], rows: [[1]], schema: {}, totalRows: 1, loadedRows: 1, fileSizeBytes: 10, isLimited: false };
        });
        const container = document.createElement('div');
        // The viewer attaches document-level drag/dismiss listeners; an abandoned
        // mount leaks them globally, so every add must be matched by a remove.
        const addSpy = vi.spyOn(document, 'addEventListener');
        const removeSpy = vi.spyOn(document, 'removeEventListener');

        await expect(mountParquetViewer({ fileName: 'data.parquet', data: new Uint8Array() }, container, ctx, { styleIsolation: 'scoped', signal: controller.signal })).rejects.toBeInstanceOf(MountAbortedError);

        expect(container.children).toHaveLength(0);
        expect(container.classList.contains('omni-viewer--parquet')).toBe(false);
        expect(addSpy).toHaveBeenCalled();
        expect(removeSpy.mock.calls.length).toBe(addSpy.mock.calls.length);
        addSpy.mockRestore(); removeSpy.mockRestore();
    });

    it('clears the container and its scoped classes on dispose', async () => {
        parseParquet.mockResolvedValueOnce({ headers: ['id'], rows: [[1]], schema: {}, totalRows: 1, loadedRows: 1, fileSizeBytes: 10, isLimited: false });
        const container = document.createElement('div');
        const handle = await mountParquetViewer({ fileName: 'data.parquet', data: new Uint8Array() }, container, ctx, { styleIsolation: 'scoped' });
        expect(container.classList.contains('omni-viewer--parquet')).toBe(true);

        handle.dispose();
        handle.dispose(); // Idempotent — a second dispose must not throw.

        expect(container.children).toHaveLength(0);
        expect(container.classList.contains('omni-viewer--parquet')).toBe(false);
    });

    it('dismisses the context menu on Escape from outside the frame', async () => {
        parseParquet.mockResolvedValueOnce({ headers: ['id'], rows: [[1]], schema: {}, totalRows: 1, loadedRows: 1, fileSizeBytes: 10, isLimited: false });
        const container = document.createElement('div'); document.body.append(container);
        const handle = await mountParquetViewer({ fileName: 'data.parquet', data: new Uint8Array() }, container, ctx, { styleIsolation: 'scoped' });
        const menu = container.querySelector('.omni-parquet__menu') as HTMLElement;
        (container.querySelector('td') as HTMLTableCellElement).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 20 }));
        expect(menu.style.display).toBe('flex');

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(menu.style.display).toBe('none');
        handle.dispose();
    });
});

describe('mountParquetViewer sort affordance', () => {
    beforeEach(() => parseParquet.mockReset());

    it('exposes the active sort column and direction through aria-sort and an indicator', async () => {
        parseParquet.mockResolvedValueOnce({ headers: ['name', 'score'], rows: [['b', 2], ['a', 1]], schema: {}, totalRows: 2, loadedRows: 2, fileSizeBytes: 10, isLimited: false });
        const container = document.createElement('div');
        await mountParquetViewer({ fileName: 'data.parquet', data: new Uint8Array() }, container, ctx, { styleIsolation: 'scoped' });
        const header = () => container.querySelector('th') as HTMLTableCellElement;
        const indicator = () => container.querySelector('.omni-parquet__sort-indicator')?.textContent ?? null;

        expect(header().getAttribute('aria-sort')).toBeNull();
        expect(indicator()).toBeNull();

        header().click();
        expect(header().getAttribute('aria-sort')).toBe('ascending');
        expect(indicator()).toBe('▲');

        header().click();
        expect(header().getAttribute('aria-sort')).toBe('descending');
        expect(indicator()).toBe('▼');

        // Third click clears the sort, so the affordance must clear with it.
        header().click();
        expect(header().getAttribute('aria-sort')).toBeNull();
        expect(indicator()).toBeNull();
    });

    it('marks only the sorted column and labels the search input', async () => {
        parseParquet.mockResolvedValueOnce({ headers: ['name', 'score'], rows: [['b', 2]], schema: {}, totalRows: 1, loadedRows: 1, fileSizeBytes: 10, isLimited: false });
        const container = document.createElement('div');
        await mountParquetViewer({ fileName: 'data.parquet', data: new Uint8Array() }, container, ctx, { styleIsolation: 'scoped' });
        (container.querySelectorAll('th')[1] as HTMLTableCellElement).click();
        const sorted = [...container.querySelectorAll('th')].map(th => th.getAttribute('aria-sort'));
        expect(sorted).toEqual([null, 'ascending']);
        expect(container.querySelectorAll('.omni-parquet__sort-indicator')).toHaveLength(1);
        expect((container.querySelector('input') as HTMLInputElement).getAttribute('aria-label')).toBe('parquet.search');
    });
});

describe('mountParquetViewer clipboard payload guard', () => {
    beforeEach(() => parseParquet.mockReset());

    it('refuses an oversized Copy JSON payload and reports why instead of writing it', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        parseParquet.mockResolvedValueOnce({ headers: ['blob'], rows: [['x'.repeat(1024 * 1024 + 1)]], schema: {}, totalRows: 1, loadedRows: 1, fileSizeBytes: 10, isLimited: false });
        const container = document.createElement('div');
        await mountParquetViewer({ fileName: 'data.parquet', data: new Uint8Array() }, container, { ...ctx, clipboard: { writeText } }, { styleIsolation: 'scoped' });
        const copyJson = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'parquet.copyJson')!;

        copyJson.click();

        await vi.waitFor(() => expect(container.querySelector('.omni-parquet__toast')?.textContent).toBe('common.copyTooLarge'));
        expect(writeText).not.toHaveBeenCalled();
    });

    it('confirms a copy that fits under the limit', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        parseParquet.mockResolvedValueOnce({ headers: ['id'], rows: [[1]], schema: {}, totalRows: 1, loadedRows: 1, fileSizeBytes: 10, isLimited: false });
        const container = document.createElement('div');
        await mountParquetViewer({ fileName: 'data.parquet', data: new Uint8Array() }, container, { ...ctx, clipboard: { writeText } }, { styleIsolation: 'scoped' });
        const copyJson = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'parquet.copyJson')!;

        copyJson.click();

        await vi.waitFor(() => expect(container.querySelector('.omni-parquet__toast')?.textContent).toBe('common.copied'));
        expect(writeText).toHaveBeenCalledTimes(1);
    });

    it('keeps the viewer alive and logs when the clipboard service rejects', async () => {
        const writeText = vi.fn().mockRejectedValue(new Error('denied'));
        const logger = { log: vi.fn() };
        parseParquet.mockResolvedValueOnce({ headers: ['id'], rows: [[1]], schema: {}, totalRows: 1, loadedRows: 1, fileSizeBytes: 10, isLimited: false });
        const container = document.createElement('div');
        await mountParquetViewer({ fileName: 'data.parquet', data: new Uint8Array() }, container, { ...ctx, logger, clipboard: { writeText } }, { styleIsolation: 'scoped' });
        const copyJson = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'parquet.copyJson')!;

        copyJson.click();

        await vi.waitFor(() => expect(logger.log).toHaveBeenCalledWith('error', expect.stringContaining('parquet copy failed')));
        expect(container.querySelector('.omni-parquet__toast')).toBeNull();
    });
});
