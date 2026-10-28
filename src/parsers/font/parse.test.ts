import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { parseFont } from './index.js';

const realFont = () => new Uint8Array(readFileSync('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'));
const align = (n: number) => Math.ceil(n / 4) * 4;
const bytes = (size: number) => new Uint8Array(size);
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
function cmap(format: number, range = 2): Uint8Array {
    const size = format === 4 ? 32 : format === 6 ? 14 : format === 0 ? 262 : 28;
    const data = bytes(12 + size), v = view(data);
    v.setUint16(2, 1); v.setUint16(4, 3); v.setUint16(6, format >= 12 ? 10 : 1); v.setUint32(8, 12);
    const s = new DataView(data.buffer, 12); s.setUint16(0, format);
    if (format >= 12) {
        s.setUint32(4, size); s.setUint32(12, 1); s.setUint32(16, 0x1f600); s.setUint32(20, 0x1f600 + range - 1); s.setUint32(24, 1);
    } else {
        s.setUint16(2, size);
        if (format === 4) {
            s.setUint16(6, 4); s.setUint16(14, 66); s.setUint16(16, 0xffff);
            s.setUint16(20, 65); s.setUint16(22, 0xffff); s.setInt16(24, -64); s.setInt16(26, 1);
        } else if (format === 6) {
            s.setUint16(6, 65); s.setUint16(8, 2); s.setUint16(10, 1); s.setUint16(12, 2);
        } else { s.setUint8(6 + 65, 1); s.setUint8(6 + 66, 2); }
    }
    return data;
}
function nameTable(text: string, id = 1): Uint8Array {
    const data = bytes(18 + text.length * 2), v = view(data);
    v.setUint16(2, 1); v.setUint16(4, 18); v.setUint16(6, 3); v.setUint16(8, 1);
    v.setUint16(10, 0x409); v.setUint16(12, id); v.setUint16(14, text.length * 2);
    for (let i = 0; i < text.length; i++) v.setUint16(18 + i * 2, text.charCodeAt(i));
    return data;
}
function font(tables: Record<string, Uint8Array>, woff = false, signature = 0x00010000): Uint8Array {
    const entries = Object.entries(tables).map(([tag, data]) => {
        const compressed = woff ? new Uint8Array(deflateSync(data)) : data;
        return { tag, data, stored: compressed.length < data.length ? compressed : data };
    });
    const stride = woff ? 20 : 16, header = woff ? 44 : 12;
    const data = bytes(header + entries.length * stride + entries.reduce((sum, t) => sum + align(t.stored.length), 0)), v = view(data);
    v.setUint32(0, woff ? 0x774f4646 : signature); v.setUint16(woff ? 12 : 4, entries.length);
    if (woff) { v.setUint32(4, signature); v.setUint32(8, data.length); v.setUint32(16, 12 + entries.length * 16 + entries.reduce((sum, t) => sum + align(t.data.length), 0)); }
    let offset = header + entries.length * stride;
    entries.forEach((t, i) => {
        const p = header + i * stride;
        data.set(new TextEncoder().encode(t.tag), p); v.setUint32(p + (woff ? 4 : 8), offset);
        v.setUint32(p + (woff ? 8 : 12), t.stored.length);
        if (woff) v.setUint32(p + 12, t.data.length);
        data.set(t.stored, offset); offset += align(t.stored.length);
    });
    return data;
}
function tables(format = 4): Record<string, Uint8Array> {
    const head = bytes(54), maxp = bytes(6), os2 = bytes(6);
    view(head).setUint16(18, 1000); view(maxp).setUint16(4, 100); view(os2).setUint16(4, 400);
    return { head, maxp, 'OS/2': os2, name: nameTable('테스트 Font'), cmap: cmap(format) };
}

describe('font parser', () => {
    it('reads an independently produced TrueType font without modifying borrowed input', async () => {
        const data = realFont(), original = data.slice();
        const { result } = await parseFont(data);
        expect(result.status).toBe('ok');
        if (result.status === 'failed') throw new Error(result.failure.code);
        expect(result.document).toMatchObject({ format: 'TrueType', family: 'Liberation Sans', subfamily: 'Regular', unitsPerEm: 2048 });
        expect(result.document.glyphCount).toBeGreaterThan(100);
        expect(result.document.characters.find(c => c.codePoint === 65)).toEqual({ codePoint: 65, glyphIndex: 36 });
        expect(data).toEqual(original);
    });

    it.each([0, 4, 6, 12, 13])('reads cmap format %s from an offset byte view', async format => {
        const data = font(tables(format));
        const wrapped = bytes(data.length + 10); wrapped.set(data, 5);
        const { result } = await parseFont(wrapped.subarray(5, -5));
        expect(result.status).toBe('ok');
        if (result.status === 'failed') return;
        expect(result.document.family).toBe('테스트 Font');
        expect(result.document.characters).toEqual(format < 12
            ? [{ codePoint: 65, glyphIndex: 1 }, { codePoint: 66, glyphIndex: 2 }]
            : [{ codePoint: 0x1f600, glyphIndex: 1 }, { codePoint: 0x1f601, glyphIndex: format === 13 ? 1 : 2 }]);
    });

    it('reads OpenType signatures and typographic family names', async () => {
        const { result } = await parseFont(font({ ...tables(), name: nameTable('Typographic family', 16) }, false, 0x4f54544f));
        expect(result.status !== 'failed' && result.document).toMatchObject({ format: 'OpenType', family: 'Typographic family' });
    });

    it('applies format 4 range offsets and deltas to glyph array entries', async () => {
        const mapping = bytes(48), v = view(mapping);
        v.setUint16(2, 1); v.setUint16(4, 3); v.setUint16(6, 1); v.setUint32(8, 12);
        const s = new DataView(mapping.buffer, 12);
        s.setUint16(0, 4); s.setUint16(2, 36); s.setUint16(6, 4);
        s.setUint16(14, 66); s.setUint16(16, 0xffff); s.setUint16(20, 65); s.setUint16(22, 0xffff);
        s.setInt16(24, 1); s.setInt16(26, 1); s.setUint16(28, 4); s.setUint16(32, 1); s.setUint16(34, 2);
        const { result } = await parseFont(font({ ...tables(), cmap: mapping }));
        expect(result.status !== 'failed' && result.document.characters).toEqual([{ codePoint: 65, glyphIndex: 2 }, { codePoint: 66, glyphIndex: 3 }]);
    });

    it('decompresses WOFF tables and produces identical metadata and characters', async () => {
        const original = tables(12);
        const sfnt = await parseFont(font(original)), woff = await parseFont(font(original, true));
        expect(woff.result.status).toBe('ok');
        if (woff.result.status === 'failed' || sfnt.result.status === 'failed') return;
        expect(woff.result.document).toMatchObject({ ...sfnt.result.document, format: 'WOFF', tables: expect.any(Array) });
        expect(woff.result.document.tables.some(t => t.compressedLength < t.length)).toBe(true);
    });

    it('reads variable axis bounds', async () => {
        const fvar = bytes(36), v = view(fvar);
        v.setUint16(4, 16); v.setUint16(8, 1); v.setUint16(10, 20);
        fvar.set(new TextEncoder().encode('wght'), 16);
        for (const [i, n] of [100, 400, 900].entries()) v.setInt32(20 + i * 4, n * 65536);
        const { result } = await parseFont(font({ ...tables(), fvar }));
        expect(result.status !== 'failed' && result.document.axes).toEqual([{ tag: 'wght', min: 100, default: 400, max: 900 }]);
    });

    it('bounds retained characters and exposes the partial preview', async () => {
        const { result } = await parseFont(font(tables(12)), { limits: { maxPreviewBytes: 16 } });
        expect(result.status).toBe('partial');
        if (result.status === 'failed') return;
        expect(result.document.characters).toHaveLength(1);
        expect(result.document.charactersTruncated).toBe(true);
        expect(result.diagnostics[0]?.messageKey).toBe('diag.font.preview');
        const zero = await parseFont(font(tables()), { limits: { maxPreviewBytes: 0 } });
        expect(zero.result.status !== 'failed' && zero.result.document.characters).toEqual([]);
    });

    it('reports unavailable character mappings while keeping metadata', async () => {
        const { cmap: _, ...noCmap } = tables();
        const { result } = await parseFont(font(noCmap));
        expect(result.status).toBe('partial');
        expect(result.diagnostics[0]?.messageKey).toBe('diag.font.cmap');
    });

    it('handles format, size, decompression, entry, cancellation, and time failures without throwing', async () => {
        const data = font(tables(), true), aborted = new AbortController(); aborted.abort();
        const outcomes = await Promise.all([
            parseFont(new TextEncoder().encode('not a font')),
            parseFont(data, { limits: { maxInputBytes: data.length - 1 } }),
            parseFont(data, { limits: { maxDecompressedBytes: 1 } }),
            parseFont(data, { limits: { maxEntries: 1 } }),
            parseFont(data, { signal: aborted.signal }),
            parseFont(data, { limits: { maxParseMillis: -1 } })
        ]);
        expect(outcomes.map(o => o.result.status === 'failed' && o.result.failure.code))
            .toEqual(['invalid-format', 'limit-exceeded', 'limit-exceeded', 'limit-exceeded', 'aborted', 'limit-exceeded']);
    });

    it('reports missing native WOFF decompression support', async () => {
        vi.stubGlobal('DecompressionStream', undefined);
        try {
            const { result } = await parseFont(font(tables(), true));
            expect(result.status === 'failed' && result.failure.code).toBe('missing-dependency');
        } finally { vi.unstubAllGlobals(); }
    });

    it('cancels WOFF decompression while a table read is pending', async () => {
        const controller = new AbortController();
        const pending = parseFont(font(tables(), true), { signal: controller.signal });
        controller.abort();
        const { result } = await pending;
        expect(result.status === 'failed' && result.failure.code).toBe('aborted');
    });

    it('rejects truncated, overlapping, duplicate, and out-of-bounds tables', async () => {
        const valid = font(tables());
        const duplicate = valid.slice(); duplicate.set(duplicate.subarray(12, 16), 28);
        const overlap = valid.slice(); view(overlap).setUint32(28 + 8, view(overlap).getUint32(12 + 8));
        const outside = valid.slice(); view(outside).setUint32(20, outside.length);
        for (const data of [valid.subarray(0, 3), valid.subarray(0, -20), duplicate, overlap, outside]) {
            const { result } = await parseFont(data);
            expect(result.status === 'failed' && result.failure.code).toBe('corrupted');
        }
    });

    it('rejects corrupt WOFF streams and declared lengths', async () => {
        const badHeader = font(tables(), true); view(badHeader).setUint32(8, badHeader.length + 1);
        const badStream = font(tables(), true); badStream[view(badStream).getUint32(48)] = 0;
        for (const data of [badHeader, badStream]) {
            const { result } = await parseFont(data);
            expect(result.status === 'failed' && result.failure.code).toBe('corrupted');
        }
    });

    it('rejects cmap glyph indices outside maxp and descending Unicode groups', async () => {
        const badGlyph = tables(); view(badGlyph.maxp!).setUint16(4, 1);
        const badGroup = tables(12); view(badGroup.cmap!).setUint32(12 + 20, 0x100);
        for (const data of [font(badGlyph), font(badGroup)]) {
            const { result } = await parseFont(data);
            expect(result.status === 'failed' && result.failure.code).toBe('corrupted');
        }
    });
});
