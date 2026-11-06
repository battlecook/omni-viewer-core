import { describe, expect, it, vi } from 'vitest';
import * as lz4 from 'lz4js';
import { parseMcap, type McapDocument } from './index.js';
import { parseSelfLoadingMcap } from './self-loading.js';
import { attachment, channel, chunk, concat, crc, encode, file, header, magic, message, metadata, record, schema, statistics, str, time, u16, u32, u64, zstdRaw } from './__tests__/fixtures.js';
import type { ParseOutcome } from '../types.js';

function document(outcome: ParseOutcome<McapDocument>): McapDocument {
    if (outcome.result.status === 'failed') throw new Error(outcome.result.failure.messageKey);
    return outcome.result.document;
}
const warnings = (outcome: ParseOutcome<McapDocument>) => outcome.result.diagnostics.map(item => item.messageKey);

describe('MCAP v0 parser', () => {
    it('reads messages, schemas, channel metadata, attachments and exact nanosecond times', () => {
        const input = file([schema, channel(), message(), metadata, attachment]);
        const before = input.slice();
        const parsed = parseMcap(input), model = document(parsed);
        expect(parsed.result.status).toBe('ok');
        expect(model.library).toBe('omni-viewer fixture');
        expect(model.messageCount).toBe('1'); expect(model.startTime).toBe(String(time));
        expect(model.messages[0]).toMatchObject({ channelId: 1, sequence: 1, logTime: String(time), publishTime: String(time), preview: { text: '{"speed":42}', truncated: false } });
        expect(model.schemas[0]).toMatchObject({ id: 1, name: 'Telemetry', encoding: 'jsonschema' });
        expect(model.channels[0]).toMatchObject({ topic: '/telemetry', messageEncoding: 'json', metadata: { source: 'robot' }, messageCount: '1' });
        expect(model.attachments[0]).toMatchObject({ name: 'calibration.txt', sizeBytes: 3, mediaType: 'text/plain' });
        expect(Object.hasOwn(model.metadata[0]!.values, '__proto__')).toBe(true);
        expect(input).toEqual(before);
        expect(() => JSON.stringify(model)).not.toThrow();
        input.fill(0); expect(model.messages[0]?.preview.text).toContain('speed');
    });

    it('reads uncompressed chunks and deduplicates summary copies without double-counting', () => {
        const content = concat(schema, channel(), message(), message(2));
        const parsed = parseMcap(file([chunk(content)], [schema, channel(), statistics()]));
        const model = document(parsed);
        expect(parsed.result.status).toBe('ok');
        expect(model.schemas).toHaveLength(1); expect(model.channels).toHaveLength(1);
        expect(model.messages).toHaveLength(2); expect(model.messageCount).toBe('2');
        expect(model.chunks[0]?.decoded).toBe(true); expect(model.scanComplete).toBe(true);
    });

    it.each(['lz4', 'zstd'])('decodes real %s frames through optional peers', async compression => {
        const content = concat(schema, channel(), message(), message(2));
        const encoded = compression === 'lz4' ? lz4.compress(content) : zstdRaw(content);
        const parsed = await parseSelfLoadingMcap(file([chunk(content, compression, encoded)]));
        expect(parsed.result.status).toBe('ok');
        expect(document(parsed).messages[1]?.sequence).toBe(2);
        expect(document(parsed).chunks[0]?.compression).toBe(compression);
    });

    it('keeps summary metadata and exact uint64 statistics when codecs are missing', () => {
        const total = 18446744073709551615n;
        const parsed = parseMcap(file([chunk(new Uint8Array(), 'zstd')], [schema, channel(), statistics(total)]));
        const model = document(parsed);
        expect(parsed.result.status).toBe('partial'); expect(model.scanComplete).toBe(false);
        expect(model.messageCount).toBe(String(total)); expect(model.channels[0]?.messageCount).toBe(String(total));
        expect(model.messages).toHaveLength(0); expect(model.schemas).toHaveLength(1);
        expect(warnings(parsed)).toContain('diag.mcap.compression');
    });

    it('skips unknown codecs and reads subsequent records', () => {
        const parsed = parseMcap(file([chunk(new Uint8Array(), 'future'), schema, channel(), message()]));
        expect(document(parsed).messages).toHaveLength(1);
        expect(warnings(parsed)).toContain('diag.mcap.unsupportedCompression');
    });

    it('counts all scanned messages after retained samples or payload bytes are capped', () => {
        const input = file([schema, channel(), message(), message(2), message(3)]);
        const capped = document(parseMcap(input, {}, { previewMessages: 1 }));
        expect(capped.messages).toHaveLength(1); expect(capped.messageCount).toBe('3');
        expect(capped.channels[0]?.messageCount).toBe('3'); expect(capped.previewLimited).toBe(true);
        expect(capped.scanComplete).toBe(true);
        const none = document(parseMcap(input, {}, { previewMessages: 0 }));
        expect(none.messages).toHaveLength(0); expect(none.messageCount).toBe('3');
        const short = document(parseMcap(input, {}, { previewBytesPerMessage: 2 }));
        expect(short.messages[0]?.preview.text).toBe('{"'); expect(short.messages[0]?.preview.truncated).toBe(true);
        expect(document(parseMcap(input, {}, { limits: { maxPreviewBytes: 0 } })).messages).toHaveLength(0);
    });

    it('enforces cumulative chunk budgets before invoking a decoder', () => {
        const decode = vi.fn((data: Uint8Array) => data);
        const parsed = parseMcap(file([chunk(encode('x'), 'lz4', encode('x'), 100)]), { decompressLz4: decode }, { limits: { maxDecompressedBytes: 10 } });
        expect(decode).not.toHaveBeenCalled(); expect(warnings(parsed)).toContain('diag.mcap.limit-exceeded');
        const repeated = parseMcap(file([chunk(new Uint8Array()), chunk(encode('x'))]), {}, { limits: { maxDecompressedBytes: 0 } });
        expect(warnings(repeated)).toContain('diag.mcap.limit-exceeded');
    });

    it('bounds records and rejects over-limit input before scanning', () => {
        expect(parseMcap(file(), {}, { limits: { maxInputBytes: 8 } }).result).toMatchObject({ status: 'failed', failure: { code: 'limit-exceeded' } });
        const capped = parseMcap(file(), {}, { limits: { maxEntries: 2 } });
        expect(capped.result.status).toBe('partial'); expect(warnings(capped)).toContain('diag.mcap.limit-exceeded');
    });

    it('handles pre-aborted and checkpoint cancellation as failure, never partial success', async () => {
        const controller = new AbortController(); controller.abort();
        expect(parseMcap(file(), {}, { signal: controller.signal }).result).toMatchObject({ status: 'failed', failure: { code: 'aborted' } });
        expect((await parseSelfLoadingMcap(file(), { signal: controller.signal })).result.status).toBe('failed');
        const mid = new AbortController();
        const parsed = parseMcap(file([chunk(new Uint8Array(), 'lz4')]), { decompressLz4: () => { mid.abort(); return new Uint8Array(); } }, { signal: mid.signal });
        expect(parsed.result).toMatchObject({ status: 'failed', failure: { code: 'aborted' } });
    });

    it('returns recoverable records from every truncation without throwing', () => {
        const input = file([schema, channel(), message(), attachment, metadata]);
        for (let length = 0; length < input.length; length++) {
            const parsed = parseMcap(input.subarray(0, length));
            expect(parsed.result.status).not.toBe('ok');
        }
        const truncated = document(parseMcap(input.subarray(0, input.length - 8)));
        expect(truncated.messages).toHaveLength(1); expect(truncated.scanComplete).toBe(false);
    });

    it('rejects invalid magic, overflowing lengths and out-of-bounds string/map fields', () => {
        expect(parseMcap(encode('not MCAP')).result).toMatchObject({ status: 'failed', failure: { code: 'invalid-format' } });
        const overflow = concat(magic, Uint8Array.of(1), u64(0xffffffffffffffffn));
        expect(parseMcap(overflow).result.status).toBe('failed');
        const string = concat(magic, record(1, concat(u32(0xffffffff), str(''))));
        expect(parseMcap(string).result).toMatchObject({ status: 'failed', failure: { code: 'corrupted' } });
        const badMap = record(4, concat(u16(1), u16(0), str('/bad'), str('json'), u32(1), Uint8Array.of(0)));
        expect(warnings(parseMcap(file([badMap])))).toContain('diag.mcap.corrupted');
    });

    it('turns malformed compressed input and incorrect decoded lengths into diagnostics', async () => {
        const broken = file([chunk(new Uint8Array(), 'zstd', Uint8Array.of(1, 2, 3))]);
        const parsed = await parseSelfLoadingMcap(broken);
        expect(parsed.result.status).toBe('partial'); expect(warnings(parsed)).toContain('diag.mcap.corrupted');
        const mismatch = parseMcap(file([chunk(new Uint8Array(), 'lz4')]), { decompressLz4: () => Uint8Array.of(1) });
        expect(warnings(mismatch)).toContain('diag.mcap.corrupted');
        expect(warnings(parseMcap(file([chunk(encode('x'), '', encode('x'), 2)])))).toContain('diag.mcap.corrupted');
    });

    it('validates chunk, data-section and summary checksums', () => {
        const content = concat(schema, channel(), message());
        expect(parseMcap(file([chunk(content, '', content, content.length, crc(content))])).result.status).toBe('ok');
        expect(warnings(parseMcap(file([chunk(content, '', content, content.length, crc(content) ^ 1)])))).toContain('diag.mcap.crc');
        const prefix = concat(magic, header, schema, channel(), message());
        const data = concat(prefix, record(15, u32(crc(prefix))));
        const footerPrefix = concat(Uint8Array.of(2), u64(20), u64(0), u64(0));
        const valid = concat(data, footerPrefix, u32(crc(footerPrefix)), magic);
        expect(parseMcap(valid).result.status).toBe('ok');
        const invalid = valid.slice(); invalid[prefix.length + 9] = invalid[prefix.length + 9]! ^ 1;
        expect(warnings(parseMcap(invalid))).toContain('diag.mcap.crc');
        const summary = concat(schema, channel(), statistics(1n));
        const summaryFooter = concat(Uint8Array.of(2), u64(20), u64(data.length), u64(0));
        const indexed = concat(data, summary, summaryFooter, u32(crc(concat(summary, summaryFooter))), magic);
        expect(parseMcap(indexed).result.status).toBe('ok');
        indexed[indexed.length - 9] = indexed[indexed.length - 9]! ^ 1;
        expect(warnings(parseMcap(indexed))).toContain('diag.mcap.crc');
    });

    it('supports empty recordings, private records and forward-compatible extra fields', () => {
        expect(parseMcap(file([])).result.status).toBe('ok');
        const extraChannel = record(4, concat(u16(0), u16(0), str('/zero'), str('json'), u32(0), encode('future fields')));
        const parsed = parseMcap(file([record(0x80, encode('private')), record(0x33, encode('future')), extraChannel]));
        expect(parsed.result.status).toBe('ok'); expect(document(parsed).channels[0]?.id).toBe(0);
    });

    it('ignores schema ID zero and reports missing references', () => {
        const zero = record(3, u16(0));
        const parsed = parseMcap(file([zero, channel(), message(), message(2, 55)]));
        expect(document(parsed).schemas).toHaveLength(0);
        expect(warnings(parsed)).toEqual(expect.arrayContaining(['diag.mcap.schemaZero', 'diag.mcap.references']));
    });

    it('rejects nested chunks and invalid record positions', () => {
        expect(warnings(parseMcap(file([chunk(chunk(new Uint8Array()))])))).toContain('diag.mcap.corrupted');
        expect(parseMcap(concat(magic, schema, header, magic)).result.status).toBe('failed');
        expect(warnings(parseMcap(file([record(0, new Uint8Array())])))).toContain('diag.mcap.corrupted');
        const afterData = concat(magic, header, record(15, u32(0)), message(), record(2, concat(u64(0), u64(0), u32(0))), magic);
        expect(warnings(parseMcap(afterData))).toContain('diag.mcap.corrupted');
    });

    it('is deterministic for repeated reads of the same bytes and options', () => {
        const input = file([schema, channel(), message(), metadata]);
        expect(parseMcap(input).result).toEqual(parseMcap(input).result);
    });

    it.each(['lz4', 'zstd'])('continues counting %s chunks when preview budgets are exhausted', async compression => {
        const first = concat(schema, channel(), message(1, 1, '{"value":"' + 'x'.repeat(512) + '"}'));
        const second = message(2);
        const compressed = (bytes: Uint8Array) => compression === 'lz4' ? lz4.compress(bytes) : zstdRaw(bytes);
        const input = file([chunk(first, compression, compressed(first)), chunk(second, compression, compressed(second))]);
        for (const maxPreviewBytes of [0, 1, 128]) {
            const parsed = await parseSelfLoadingMcap(input, { limits: { maxPreviewBytes } });
            const model = document(parsed);
            expect(model.scanComplete).toBe(true); expect(model.messageCount).toBe('2');
            expect(model.chunks.every(chunk => chunk.decoded && chunk.compression === compression)).toBe(true);
            expect(warnings(parsed)).not.toContain('diag.mcap.corrupted');
            expect(model.channels[0]?.messageEncoding).toBe('json');
        }
    });

    it('reports valid Zstd history-window limits as resource failures instead of corruption', async () => {
        const content = concat(schema, channel(), message());
        const block = (content.length << 3) | 1;
        const encoded = concat(Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0, 8), Uint8Array.of(block & 255, (block >>> 8) & 255, (block >>> 16) & 255), content);
        const input = file([chunk(content, 'zstd', encoded)]);
        const limited = await parseSelfLoadingMcap(input, { limits: { maxDecompressedBytes: 1024 } });
        expect(warnings(limited)).toContain('diag.mcap.limit-exceeded');
        expect(warnings(limited)).not.toContain('diag.mcap.corrupted');
        const retried = await parseSelfLoadingMcap(input, { limits: { maxDecompressedBytes: 2048 } });
        expect(retried.result.status).toBe('ok'); expect(document(retried).messageCount).toBe('1');
    });
});
