// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const parseParquet = vi.hoisted(() => vi.fn());
const parseParquetSource = vi.hoisted(() => vi.fn());
vi.mock('../../parsers/parquet/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../parsers/parquet/index.js')>();
    return { ...actual, parseParquet, parseParquetSource };
});

import { createParquetBlobSource, mountParquetViewer } from './index.js';

const ctx = {
    assets: { resolveAssetUrl: async (path: string) => path },
    logger: { log: vi.fn() },
    i18n: { t: (key: string, args?: Record<string, string | number>) =>
        ({ 'parquet.loadMore': `Load Next ${args?.count} Rows`, 'parquet.loading': 'Loading…', 'parquet.limited': `${args?.loaded} / ${args?.total}`, 'common.page': `${args?.page}/${args?.pages}` }[key] ?? key) }
};

describe('mountParquetViewer random-access source', () => {
    beforeEach(() => { parseParquet.mockReset(); parseParquetSource.mockReset(); });

    it('dispatches to parseParquetSource and re-reads chunks from the loaded offset via the lazy path', async () => {
        parseParquetSource
            .mockResolvedValueOnce({ headers: ['id'], rows: [[1]], schema: {}, totalRows: 3, loadedRows: 1, fileSizeBytes: 2_000_000_000, isLimited: true })
            .mockResolvedValueOnce({ headers: ['id'], rows: [[2]], schema: {}, totalRows: 3, loadedRows: 1, fileSizeBytes: 2_000_000_000, isLimited: false });
        const blob = new NodeBlob([new Uint8Array(64)]) as unknown as Blob;
        const source = createParquetBlobSource(blob, 'huge.parquet');
        const container = document.createElement('div');

        const handle = await mountParquetViewer(source, container, ctx, { styleIsolation: 'scoped' });

        // The whole-buffer entry point is never touched — only the random-access source is threaded through.
        expect(parseParquet).not.toHaveBeenCalled();
        expect(parseParquetSource).toHaveBeenCalledTimes(1);
        expect(parseParquetSource.mock.calls[0]?.[0]).toBe(source);

        const button = [...container.querySelectorAll('button')].find(node => node.textContent?.startsWith('Load Next')) as HTMLButtonElement;
        button.click();
        await vi.waitFor(() => expect(parseParquetSource).toHaveBeenCalledTimes(2));
        expect(parseParquetSource.mock.calls[1]?.[0]).toBe(source);
        expect(parseParquetSource.mock.calls[1]?.[1]).toMatchObject({ rowStart: 1 });
        handle.dispose();
    });

    it('createParquetBlobSource exposes a lazy source that only reads requested ranges', async () => {
        const blob = new NodeBlob([new Uint8Array(1024)]) as unknown as Blob;
        const slice = vi.spyOn(blob, 'slice');
        const source = createParquetBlobSource(blob, 'x.parquet');

        expect(source.fileName).toBe('x.parquet');
        expect(source.byteLength).toBe(1024);

        const part = await source.slice(8, 24);
        expect(slice).toHaveBeenCalledWith(8, 24);
        expect(new Uint8Array(part as ArrayBuffer).byteLength).toBe(16);
    });
});
