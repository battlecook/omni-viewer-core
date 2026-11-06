import { describe, expect, it } from 'vitest';
import { parseText, TEXT_PREVIEW_MAX_BYTES, type TextParseOptions } from './index.js';

const utf8 = (text: string) => new TextEncoder().encode(text);
function utf16(text: string, bigEndian = false, bom = true): Uint8Array {
    const bytes = new Uint8Array(text.length * 2 + (bom ? 2 : 0));
    const view = new DataView(bytes.buffer);
    if (bom) view.setUint16(0, 0xfeff, !bigEndian);
    for (let i = 0; i < text.length; i++) view.setUint16((bom ? 2 : 0) + i * 2, text.charCodeAt(i), !bigEndian);
    return bytes;
}
function parsed(bytes: Uint8Array, options: TextParseOptions = {}) {
    const { result } = parseText(bytes, options);
    if (result.status === 'failed') throw new Error(result.failure.messageKey);
    return result;
}

describe('plain text decoding', () => {
    it('preserves Unicode, whitespace, all line endings and literal markup without mutating input', () => {
        const text = '  안녕 世界 😀\t\r\n\n# heading\r<script>alert(1)</script>  ';
        const bytes = utf8(text), original = bytes.slice();
        expect(parsed(bytes)).toEqual({ status: 'ok', document: { text, encoding: 'utf-8', truncated: false }, diagnostics: [] });
        expect(bytes).toEqual(original);
    });

    it('supports empty input and strips only the initial UTF-8 BOM', () => {
        expect(parsed(new Uint8Array()).document.text).toBe('');
        expect(parsed(utf8('\ufeff\ufefftext'))).toMatchObject({ status: 'ok', document: { text: '\ufefftext', encoding: 'utf-8' } });
    });

    it.each([false, true])('decodes UTF-16 (big endian: %s) from a BOM or explicit option', bigEndian => {
        const text = '한글\t中文\r\n😀';
        const encoding = bigEndian ? 'utf-16be' : 'utf-16le';
        expect(parsed(utf16(text, bigEndian))).toMatchObject({ status: 'ok', document: { text, encoding } });
        expect(parsed(utf16(text, bigEndian, false), { encoding })).toMatchObject({ status: 'ok', document: { text, encoding } });
        expect(parsed(utf16(text, bigEndian), { encoding: 'utf-8' }).document.encoding).toBe(encoding);
    });

    it.each([
        [new Uint8Array([0xff, 0xfe, 0, 0, 0x41, 0, 0, 0])],
        [new Uint8Array([0, 0, 0xfe, 0xff, 0, 0, 0, 0x41])]
    ])('rejects UTF-32 instead of misreading it as UTF-16', bytes => {
        expect(parseText(bytes).result).toMatchObject({ status: 'failed', failure: { code: 'invalid-format', messageKey: 'text.unsupportedEncoding' } });
    });

    it.each([
        [new Uint8Array([0x61, 0xff, 0x62]), 'a\ufffdb'],
        [new Uint8Array([0xe2, 0x82]), '\ufffd'],
        [new Uint8Array([0xff, 0xfe, 0x61]), '\ufffd'],
        [new Uint8Array([0xff, 0xfe, 0, 0xd8]), '\ufffd']
    ])('keeps malformed text visible with an encoding warning', (bytes, text) => {
        expect(parsed(bytes)).toMatchObject({ status: 'partial', document: { text, truncated: false }, diagnostics: [{ code: 'text.invalid-encoding' }] });
    });

    it('does not warn for a valid literal replacement character', () => {
        expect(parsed(utf8('a\ufffdb')).status).toBe('ok');
    });

    it('shows more than the fallback preview and bounds large files by default', () => {
        expect(parsed(utf8('x'.repeat(300 * 1024))).status).toBe('ok');
        const result = parsed(new Uint8Array(TEXT_PREVIEW_MAX_BYTES + 1).fill(0x61));
        expect(result.document.text.length).toBe(TEXT_PREVIEW_MAX_BYTES);
        expect(result).toMatchObject({ status: 'partial', document: { truncated: true }, diagnostics: [{ code: 'text.preview-truncated' }] });
    });

    it('omits only incomplete UTF-8 characters at every preview boundary', () => {
        const text = 'a한😀é끝';
        const bytes = utf8(text);
        for (let budget = 0; budget < bytes.length; budget++) {
            const result = parsed(bytes, { limits: { maxPreviewBytes: budget } });
            expect(text.startsWith(result.document.text)).toBe(true);
            expect(result.document.text).not.toContain('\ufffd');
            expect(result.diagnostics.map(d => d.code)).toEqual(['text.preview-truncated']);
        }
        expect(parsed(bytes, { limits: { maxPreviewBytes: bytes.length } }).status).toBe('ok');
    });

    it.each([false, true])('handles UTF-16 code unit and surrogate boundaries (BE: %s)', bigEndian => {
        const bytes = utf16('a😀끝', bigEndian);
        const expected = ['', '', 'a', 'a', 'a', 'a', 'a😀', 'a😀', 'a😀끝'];
        for (let budget = 0; budget <= bytes.length - 2; budget++) {
            const result = parsed(bytes, { limits: { maxPreviewBytes: budget } });
            expect(result.document.text).toBe(expected[budget]);
            expect(result.diagnostics.some(d => d.code === 'text.invalid-encoding')).toBe(false);
        }
    });

    it('reports malformed bytes even in a truncated preview', () => {
        expect(parsed(new Uint8Array([0xff, 0x61, 0x62]), { limits: { maxPreviewBytes: 2 } }).diagnostics.map(d => d.code))
            .toEqual(['text.invalid-encoding', 'text.preview-truncated']);
    });

    it('enforces the input limit before decoding and handles cancellation', () => {
        const bytes = utf8('한글');
        expect(parseText(bytes, { limits: { maxInputBytes: 5 } }).result).toMatchObject({ status: 'failed', failure: { code: 'limit-exceeded' } });
        expect(parsed(bytes, { limits: { maxInputBytes: 6 } }).status).toBe('ok');
        const controller = new AbortController(); controller.abort();
        expect(parseText(bytes, { signal: controller.signal }).result).toMatchObject({ status: 'failed', failure: { code: 'aborted' } });
        expect(() => parseText(bytes, { limits: { maxPreviewBytes: -1 } })).toThrow(RangeError);
    });
});
