import { describe, expect, it } from 'vitest';
import { openArchiveStream, parseArchive, type ArchiveDecoder, type ArchiveStreamDecoder } from './index.js';

describe('parseArchive', () => {
    it('normalizes decoder entries and retains its closeable handle', async () => {
        const decoder: ArchiveDecoder = { openArchive: async () => ({ entries: [{ entryId: 0, path: 'a.txt', isDirectory: false }], extract: async () => new Uint8Array(), close() {} }) };
        const parsed = await parseArchive(new Uint8Array([1]), decoder);
        expect(parsed.outcome.result.status).toBe('ok');
        expect(parsed.handle?.entries[0]?.path).toBe('a.txt');
    });

    it('rejects input before invoking the decoder', async () => {
        const decoder: ArchiveDecoder = { openArchive: async () => { throw new Error('must not open'); } };
        const parsed = await parseArchive(new Uint8Array(3), decoder, { limits: { maxInputBytes: 2 } });
        expect(parsed.outcome.result.status).toBe('failed');
    });

    it('preserves normalized decoder failures', async () => {
        const decoder: ArchiveDecoder = { openArchive: async () => { const { ArchiveError } = await import('./index.js'); throw new ArchiveError('password-required', 'archive.encrypted'); } };
        const parsed = await parseArchive(new Uint8Array([1]), decoder);
        expect(parsed.outcome.result).toMatchObject({ status: 'failed', failure: { code: 'password-required' } });
    });

    it('counts every completed extraction, including one whose caller aborted', async () => {
        const decoder: ArchiveDecoder = { openArchive: async () => ({ entries: [], extract: async () => new Uint8Array(6), close() {} }) };
        const parsed = await parseArchive(new Uint8Array([1]), decoder, { limits: { maxDecompressedBytes: 10 } });
        if (!parsed.handle) throw new Error('missing handle');
        await parsed.handle.extract(0, { maxBytes: 8, signal: new AbortController().signal });
        await expect(parsed.handle.extract(0, { maxBytes: 8 })).rejects.toMatchObject({ code: 'limit-exceeded' });
    });

    it('reserves the cumulative budget while ignored cancellation is still extracting', async () => {
        let finish!: () => void; const slow = new Promise<void>(resolve => { finish = resolve; });
        const decoder: ArchiveDecoder = { openArchive: async () => ({ entries: [], extract: async () => { await slow; return new Uint8Array(8); }, close() {} }) };
        const parsed = await parseArchive(new Uint8Array([1]), decoder, { limits: { maxDecompressedBytes: 10 } });
        if (!parsed.handle) throw new Error('missing handle');
        const first = parsed.handle.extract(0, { maxBytes: 10 });
        await expect(parsed.handle.extract(1, { maxBytes: 8 })).rejects.toMatchObject({ code: 'limit-exceeded' });
        finish(); await first;
    });

    it('rejects a DMG without its koly trailer before invoking a decoder', async () => {
        const decoder: ArchiveDecoder = { openArchive: async () => { throw new Error('must not open'); } };
        const parsed = await parseArchive(new Uint8Array(512), decoder, { fileName: 'bad.dmg' });
        expect(parsed.outcome.result).toMatchObject({ status: 'failed', failure: { code: 'invalid-format' } });
    });
});

describe('openArchiveStream', () => {
    it('opens a path-based decoder without any file bytes and keeps its lazy handle', async () => {
        const source: ArchiveStreamDecoder = { openArchive: async () => ({ entries: [{ entryId: 0, path: 'a.txt', isDirectory: false }], extract: async () => new TextEncoder().encode('hi'), close() {} }) };
        const parsed = await openArchiveStream(source, { fileName: 'big.tar', totalSize: 5_000_000_000 });
        expect(parsed.outcome.result.status).toBe('ok');
        expect(parsed.handle?.entries[0]?.path).toBe('a.txt');
    });

    it('does not reject a multi-GB declared size unless maxInputBytes is set explicitly', async () => {
        const source: ArchiveStreamDecoder = { openArchive: async () => ({ entries: [], extract: async () => new Uint8Array(), close() {} }) };
        expect((await openArchiveStream(source, { totalSize: 8_000_000_000 })).outcome.result.status).toBe('ok');
        expect((await openArchiveStream(source, { totalSize: 8_000_000_000, limits: { maxInputBytes: 1_000 } })).outcome.result.status).toBe('failed');
    });

    it('still enforces the decompressed-bytes budget on the streaming handle (zip-bomb guard)', async () => {
        const source: ArchiveStreamDecoder = { openArchive: async () => ({ entries: [], extract: async () => new Uint8Array(6), close() {} }) };
        const parsed = await openArchiveStream(source, { limits: { maxDecompressedBytes: 10 } });
        if (!parsed.handle) throw new Error('missing handle');
        await parsed.handle.extract(0, { maxBytes: 8 });
        await expect(parsed.handle.extract(0, { maxBytes: 8 })).rejects.toMatchObject({ code: 'limit-exceeded' });
    });

    it('rejects when already aborted before opening', async () => {
        const controller = new AbortController(); controller.abort();
        const source: ArchiveStreamDecoder = { openArchive: async () => { throw new Error('must not open'); } };
        const parsed = await openArchiveStream(source, { signal: controller.signal });
        expect(parsed.outcome.result).toMatchObject({ status: 'failed', failure: { code: 'aborted' } });
    });
});
