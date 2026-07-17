import { describe, expect, it } from 'vitest';
import { parseArchive, type ArchiveDecoder } from './index.js';

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
