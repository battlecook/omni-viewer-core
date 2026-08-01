import { beforeEach, describe, expect, it, vi } from 'vitest';

const parquetMetadataAsync = vi.hoisted(() => vi.fn());
const parquetReadObjects = vi.hoisted(() => vi.fn());
const parquetSchema = vi.hoisted(() => vi.fn());

vi.mock('hyparquet', () => ({ parquetMetadataAsync, parquetReadObjects, parquetSchema }));
vi.mock('hyparquet-compressors', () => ({ compressors: {} }));

import { parseParquetSource, type ParquetSource } from './index.js';

const source: ParquetSource = { byteLength: 1024, slice: () => new ArrayBuffer(0) };

describe('parseParquetSource footer metadata', () => {
    beforeEach(() => {
        parquetMetadataAsync.mockReset().mockResolvedValue({ num_rows: 2n });
        parquetReadObjects.mockReset().mockResolvedValue([{ id: 1 }, { id: 2 }]);
        parquetSchema.mockReset().mockReturnValue({ children: [] });
    });

    it('reads the footer once and hands it back for reuse', async () => {
        const metadata = { num_rows: 2n };
        parquetMetadataAsync.mockResolvedValue(metadata);

        const doc = await parseParquetSource(source);

        expect(parquetMetadataAsync).toHaveBeenCalledTimes(1);
        expect(doc.fileMetadata).toBe(metadata);
    });

    it('skips the footer read when a previous parse supplied the metadata', async () => {
        const metadata = { num_rows: 9n } as unknown as NonNullable<Awaited<ReturnType<typeof parseParquetSource>>['fileMetadata']>;

        const doc = await parseParquetSource(source, { metadata });

        expect(parquetMetadataAsync).not.toHaveBeenCalled();
        // The supplied footer is authoritative: schema and row count come from it.
        expect(parquetSchema).toHaveBeenCalledWith(metadata);
        expect(doc.totalRows).toBe(9);
        expect(doc.fileMetadata).toBe(metadata);
    });
});
