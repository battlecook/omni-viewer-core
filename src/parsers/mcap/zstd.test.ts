import { describe, expect, it, vi } from 'vitest';
import * as zstd from 'fzstd';
import { decodeZstdFrames } from './zstd.js';
import { McapDecompressionLimitError } from './errors.js';
import { concat, encode, u32, zstdRaw } from './__tests__/fixtures.js';

describe('bounded MCAP Zstandard decoder', () => {
    const forbidden = { Decompress: vi.fn(function () { throw new Error('decoder must not allocate'); }) };
    it('rejects oversized advertised content sizes before constructing a decoder', () => {
        const frame = zstdRaw(new Uint8Array());
        new DataView(frame.buffer).setUint32(5, 8 * 1024 * 1024, true);
        expect(() => decodeZstdFrames(frame, 0, forbidden, 1024)).toThrow();
        expect(forbidden.Decompress).not.toHaveBeenCalled();
    });
    it('bounds unknown-content history windows and validates every concatenated frame first', () => {
        // Non-single-segment frame, unknown content size, 8 MiB history, final empty raw block.
        const oversized = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0, 104, 1, 0, 0);
        expect(() => decodeZstdFrames(oversized, 0, forbidden, 1024)).toThrow(McapDecompressionLimitError);
        expect(() => decodeZstdFrames(concat(zstdRaw(encode('ok')), oversized), 2, forbidden, 1024)).toThrow();
        expect(forbidden.Decompress).not.toHaveBeenCalled();
    });
    it('reads concatenated frames and skippable frames with exact output lengths', () => {
        const input = concat(zstdRaw(encode('first')), concat(u32(0x184d2a50), u32(3), encode('pad')), zstdRaw(encode('second')));
        expect(new TextDecoder().decode(decodeZstdFrames(input, 11, zstd, 1024))).toBe('firstsecond');
        expect(() => decodeZstdFrames(input, 12, zstd, 1024)).toThrow();
    });
    it('supports unknown-size streaming frames within the configured history bound', () => {
        const frame = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0, 0, 25, 0, 0, 97, 98, 99);
        expect(new TextDecoder().decode(decodeZstdFrames(frame, 3, zstd, 1024))).toBe('abc');
        expect(() => decodeZstdFrames(frame, 3, forbidden, 512)).toThrow();
    });
    it.each([
        '28b52ffd0008b50000784d4341502074656c656d65747279200100cac93feb',
        '28b52ffd60dc04b50000784d4341502074656c656d65747279200100cac93feb'
    ])('decodes real compressed blocks with known and unknown frame content sizes', hex => {
        // Generated from this test's text by Node's native Zstandard encoder.
        const bytes = Uint8Array.from(hex.match(/../g)!, value => parseInt(value, 16));
        const expected = encode('MCAP telemetry '.repeat(100));
        expect(decodeZstdFrames(bytes, expected.length, zstd, 2048)).toEqual(expected);
    });
    it('rejects advertised lengths that do not match decoded output', () => {
        const frame = zstdRaw(encode('abc'));
        new DataView(frame.buffer).setUint32(5, 4, true);
        expect(() => decodeZstdFrames(frame, 4, zstd, 1024)).toThrow();
    });
    it('rejects malformed/truncated frame headers and blocks without decoder allocations', () => {
        const frame = zstdRaw(encode('abc'));
        for (let length = 0; length < frame.length; length++) expect(() => decodeZstdFrames(frame.subarray(0, length), 3, forbidden, 1024)).toThrow();
        expect(forbidden.Decompress).not.toHaveBeenCalled();
    });
});
