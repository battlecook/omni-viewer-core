import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { NUMPY_PREVIEW_ELEMENT_LIMIT, parseNpy, parseNumpy } from './index.js';

function makeNpy(descr: string, shape: number[], payload: Uint8Array, fortranOrder = false, version: 1 | 2 | 3 = 1): Uint8Array {
    const dictionary = `{'descr': '${descr}', 'fortran_order': ${fortranOrder ? 'True' : 'False'}, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
    const prefixLength = version === 1 ? 10 : 12;
    const padding = (64 - ((prefixLength + dictionary.length + 1) % 64)) % 64;
    const header = new TextEncoder().encode(dictionary + ' '.repeat(padding) + '\n');
    const result = new Uint8Array(prefixLength + header.length + payload.length);
    result.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, version, 0]);
    const view = new DataView(result.buffer);
    if (version === 1) view.setUint16(8, header.length, true); else view.setUint32(8, header.length, true);
    result.set(header, prefixLength); result.set(payload, prefixLength + header.length);
    return result;
}

describe('NumPy NPY parser', () => {
    it('decodes a little-endian C-order float matrix', () => {
        const payload = new Uint8Array(24);
        const view = new DataView(payload.buffer);
        [1.5, 2.5, -3, 4, 5, 6].forEach((value, index) => view.setFloat32(index * 4, value, true));
        const document = parseNpy(makeNpy('<f4', [2, 3], payload), 'matrix');

        expect(document.arrays[0]).toMatchObject({
            name: 'matrix', dtype: '<f4', shape: [2, 3], fortranOrder: false,
            elements: 6, values: [1.5, 2.5, -3, 4, 5, 6]
        });
        expect(document.warnings).toEqual([]);
        expect(document.tables[0]?.rows[0]).toContain('2 × 3');
    });

    it('supports big-endian integers, Fortran order, complex values, and Unicode strings', () => {
        const integers = new Uint8Array(8);
        const integerView = new DataView(integers.buffer);
        [10, 20, 30, 40].forEach((value, index) => integerView.setInt16(index * 2, value, false));
        expect(parseNpy(makeNpy('>i2', [2, 2], integers, true)).arrays[0]).toMatchObject({
            byteOrder: 'big', fortranOrder: true, values: [10, 20, 30, 40]
        });

        const complex = new Uint8Array(8);
        new DataView(complex.buffer).setFloat32(0, 2, true);
        new DataView(complex.buffer).setFloat32(4, -3, true);
        expect(parseNpy(makeNpy('<c8', [1], complex)).arrays[0]?.values).toEqual(['2-3j']);
        new DataView(complex.buffer).setFloat32(4, -0, true);
        expect(parseNpy(makeNpy('<c8', [1], complex)).arrays[0]?.values).toEqual(['2-0j']);

        const unicode = new Uint8Array(8);
        const unicodeView = new DataView(unicode.buffer);
        unicodeView.setUint32(0, '한'.codePointAt(0)!, true); unicodeView.setUint32(4, '글'.codePointAt(0)!, true);
        expect(parseNpy(makeNpy('<U2', [1], unicode)).arrays[0]?.values).toEqual(['한글']);
    });

    it('preserves embedded NULs and escapes arbitrary fixed-width bytes', () => {
        expect(parseNpy(makeNpy('|S4', [1], new Uint8Array([0x61, 0, 0x62, 0]))).arrays[0]?.values).toEqual(['a\\0b']);
        expect(parseNpy(makeNpy('|S2', [1], new Uint8Array([0x80, 0]))).arrays[0]?.values).toEqual(['\\x80']);

        const unicode = new Uint8Array(16);
        const view = new DataView(unicode.buffer);
        [0x61, 0, 0x62, 0].forEach((value, index) => view.setUint32(index * 4, value, true));
        expect(parseNpy(makeNpy('<U4', [1], unicode)).arrays[0]?.values).toEqual(['a\\0b']);

        const nulValue = new Uint8Array(12); const slashValue = new Uint8Array(12);
        const nulView = new DataView(nulValue.buffer); const slashView = new DataView(slashValue.buffer);
        [0, 0x61, 0].forEach((value, index) => nulView.setUint32(index * 4, value, true));
        [0x5c, 0x30, 0x61].forEach((value, index) => slashView.setUint32(index * 4, value, true));
        const nulPreview = parseNpy(makeNpy('<U3', [1], nulValue)).arrays[0]?.values[0];
        const slashPreview = parseNpy(makeNpy('<U3', [1], slashValue)).arrays[0]?.values[0];
        expect(nulPreview).not.toBe(slashPreview);
    });

    it('bounds individual string previews and excessive array rank', () => {
        const string = parseNpy(makeNpy('|S5000', [1], new Uint8Array(5000).fill(0x61)));
        expect(String(string.arrays[0]?.values[0])).toHaveLength(4096);
        expect(string.arrays[0]?.diagnostics?.some(item => item.code === 'textPreviewLimit')).toBe(true);

        const shape = Array.from({ length: 65 }, () => 1);
        const ranked = parseNpy(makeNpy('|u1', shape, new Uint8Array([1])));
        expect(ranked.arrays[0]?.diagnostics?.some(item => item.code === 'npyRank')).toBe(true);
        expect(ranked.arrays[0]?.shape).toEqual([]);
    });

    it('decodes zero-width strings and removes padding beyond the preview width', () => {
        expect(parseNpy(makeNpy('|S0', [2], new Uint8Array())).arrays[0]?.values).toEqual(['', '']);
        expect(parseNpy(makeNpy('<U0', [2], new Uint8Array())).arrays[0]?.values).toEqual(['', '']);

        const byteString = new Uint8Array(5000); byteString[0] = 0x61;
        expect(parseNpy(makeNpy('|S5000', [1], byteString)).arrays[0]?.values).toEqual(['a']);
        const unicode = new Uint8Array(5000 * 4); new DataView(unicode.buffer).setUint32(0, 0x61, true);
        expect(parseNpy(makeNpy('<U5000', [1], unicode)).arrays[0]?.values).toEqual(['a']);

        const trailing = parseNpy(makeNpy('|S0', [2], new Uint8Array([1])));
        expect(trailing.arrays[0]?.diagnostics?.some(item => item.code === 'payloadTrailing')).toBe(true);
    });

    it('rejects non-integer Python literals in shape tuples', () => {
        const malformed = makeNpy('|u1', [100], new Uint8Array(100));
        const text = new TextDecoder().decode(malformed);
        const location = text.indexOf('(100,)');
        malformed.set(new TextEncoder().encode('(1e3,)'), location);
        const document = parseNpy(malformed);
        expect(document.arrays[0]?.diagnostics?.some(item => item.code === 'npyShape')).toBe(true);

        for (const replacement of ['(1,,2)', '(,1, )', '(2)   ']) {
            const sample = makeNpy('|u1', [1, 2], new Uint8Array([1, 2]));
            const source = new TextDecoder().decode(sample);
            const start = source.indexOf('(1, 2)');
            sample.set(new TextEncoder().encode(replacement), start);
            expect(parseNpy(sample).arrays[0]?.diagnostics?.some(item => item.code === 'npyShape'), replacement).toBe(true);
        }
    });

    it('rejects duplicate header fields and trailing header syntax', () => {
        const replaceHeader = (find: string, replacement: string): ReturnType<typeof parseNpy> => {
            const bytes = makeNpy('|u1', [2], new Uint8Array([1, 2]), false, 2);
            const text = new TextDecoder().decode(bytes);
            const location = text.indexOf(find);
            bytes.set(new TextEncoder().encode(replacement), location);
            return parseNpy(bytes);
        };
        const duplicate = replaceHeader("'shape': (2,), }", "'shape': (2,), 'shape': (3,), }");
        expect(duplicate.arrays[0]?.diagnostics?.some(item => item.code === 'npyHeaderGrammar')).toBe(true);
        const trailing = replaceHeader("'shape': (2,), }", "'shape': (2,) garbage }");
        expect(trailing.arrays[0]?.diagnostics?.some(item => item.code === 'npyHeaderGrammar')).toBe(true);

        const wrongDuplicate = replaceHeader("'shape': (2,), }", "'shape': (2,), 'shape': True, }");
        expect(wrongDuplicate.arrays[0]?.values).toEqual([]);
        expect(wrongDuplicate.arrays[0]?.diagnostics?.some(item => ['npyHeaderFields', 'npyHeaderGrammar'].includes(item.code))).toBe(true);

        const quotedFalse = replaceHeader("'fortran_order': False", "'fortran_order': 'False'");
        expect(quotedFalse.arrays[0]?.values).toEqual([]);
        const tupleFalse = replaceHeader("'fortran_order': False", "'fortran_order': (1,) ");
        expect(tupleFalse.arrays[0]?.values).toEqual([]);
    });

    it('rejects datetime units on other dtypes and malformed time units', () => {
        expect(parseNpy(makeNpy('<i4[ns]', [1], new Uint8Array(4))).arrays[0]?.diagnostics?.some(item => item.code === 'dtypeUnsupported')).toBe(true);
        expect(parseNpy(makeNpy('<M8[bogus]', [1], new Uint8Array(8))).arrays[0]?.diagnostics?.some(item => item.code === 'dtypeUnsupported')).toBe(true);
        expect(parseNpy(makeNpy('<M8[2147483648ns]', [1], new Uint8Array(8))).arrays[0]?.diagnostics?.some(item => item.code === 'dtypeUnsupported')).toBe(true);
        expect(parseNpy(makeNpy('<M8[2147483647ns]', [1], new Uint8Array(8))).arrays[0]?.values).toEqual(['0']);
        expect(parseNpy(makeNpy('<M8[ns]', [1], new Uint8Array(8))).arrays[0]?.values).toEqual(['0']);
    });

    it('handles a large malformed header with a linear scanner', () => {
        const text = `{'descr': '|u1'${' '.repeat(200_000)}x}`;
        const header = new TextEncoder().encode(text);
        const bytes = new Uint8Array(12 + header.length);
        bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 2, 0]);
        new DataView(bytes.buffer).setUint32(8, header.length, true); bytes.set(header, 12);
        const started = performance.now();
        expect(parseNpy(bytes).arrays).toHaveLength(1);
        expect(performance.now() - started).toBeLessThan(500);
    });

    it('stops adding string values when the document text budget is exhausted', () => {
        const count = 100_000;
        const payload = new Uint8Array(count * 11).fill(0x61);
        const array = parseNpy(makeNpy('|S11', [count], payload)).arrays[0]!;
        expect(array.values.length).toBeLessThan(count);
        expect(array.values.at(-1)).not.toBe('');
        expect(array.diagnostics?.some(item => item.code === 'textPreviewLimit')).toBe(true);
    });

    it('does not scan or decode an excessively wide string item', () => {
        const width = 1024 * 1024 + 1;
        const document = parseNpy(makeNpy(`|S${width}`, [1], new Uint8Array(width)));
        expect(document.arrays[0]?.values).toEqual([]);
        expect(document.arrays[0]?.diagnostics?.some(item => item.code === 'stringItemSize')).toBe(true);
    });

    it('never deserializes object/pickle payloads and reports malformed headers', () => {
        const object = parseNpy(makeNpy('|O', [1], new TextEncoder().encode('pickle payload')));
        expect(object.arrays[0]?.values).toEqual([]);
        expect(object.warnings.join(' ')).toContain('unsafe pickle');
        expect(object.warnings.join(' ')).not.toContain('trailing bytes');

        const invalid = parseNpy(new Uint8Array([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 9, 0, 0, 0]));
        expect(invalid.warnings.join(' ')).toContain('Unsupported NPY format version');
        const minor = makeNpy('|u1', [1], new Uint8Array([1])); minor[7] = 1;
        expect(parseNpy(minor).diagnostics?.[0]).toMatchObject({ code: 'npyVersion', args: { version: '1.1' } });
        expect(parseNpy(new Uint8Array([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 2, 0, 0, 0])).diagnostics?.[0]?.code).toBe('npyHeader');

        const unsupported = parseNpy(makeNpy('<f16', [1], new Uint8Array(16)));
        expect(unsupported.arrays[0]?.diagnostics?.map(item => item.code)).toContain('dtypeUnsupported');
        expect(unsupported.arrays[0]?.diagnostics?.map(item => item.code)).not.toContain('previewLimit');
        expect(unsupported.arrays[0]?.previewTruncated).toBe(false);
    });

    it('caps decoded value previews', () => {
        const payload = new Uint8Array(NUMPY_PREVIEW_ELEMENT_LIMIT + 1);
        const array = parseNpy(makeNpy('|u1', [payload.length], payload)).arrays[0]!;
        expect(array.values).toHaveLength(NUMPY_PREVIEW_ELEMENT_LIMIT);
        expect(array.previewTruncated).toBe(true);
    });

    it('rejects oversized v2/v3 headers before decoding them', () => {
        const bytes = new Uint8Array(12 + 1024 * 1024 + 1);
        bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 2, 0]);
        new DataView(bytes.buffer).setUint32(8, 1024 * 1024 + 1, true);
        expect(parseNpy(bytes).diagnostics?.[0]?.code).toBe('npyHeaderSize');
    });

    it('honors an already-aborted parse signal', async () => {
        const signal = AbortSignal.abort(new DOMException('cancelled', 'AbortError'));
        await expect(parseNumpy(makeNpy('|u1', [1], new Uint8Array([1])), 'a.npy', { signal })).rejects.toMatchObject({ name: 'AbortError' });
    });
});

describe('NumPy NPZ parser', () => {
    it('loads and names multiple NPY members from a compressed archive', async () => {
        const zip = new JSZip();
        zip.file('weights.npy', makeNpy('|u1', [3], new Uint8Array([1, 2, 3])));
        zip.file('nested/bias.npy', makeNpy('<i4', [1], new Uint8Array([7, 0, 0, 0])));
        zip.file('README.txt', 'ignored');
        const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
        const document = await parseNumpy(bytes, 'model.npz');

        expect(document.format).toBe('NumPy NPZ');
        expect(document.arrays.map(array => array.name)).toEqual(['nested/bias', 'weights']);
        expect(document.arrays[1]?.values).toEqual([1, 2, 3]);
        expect(document.summary[0]).toEqual({ label: 'Arrays', value: 2 });
    });

    it('shares one bounded value-preview budget across all NPZ arrays', async () => {
        const zip = new JSZip();
        const values = new Uint8Array(60_000);
        zip.file('a.npy', makeNpy('|u1', [values.length], values));
        zip.file('b.npy', makeNpy('|u1', [values.length], values));
        const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
        const document = await parseNumpy(bytes, 'many.npz');
        expect(document.arrays.reduce((sum, array) => sum + array.values.length, 0)).toBe(NUMPY_PREVIEW_ELEMENT_LIMIT);
        expect(document.arrays[1]?.previewTruncated).toBe(true);
    });

    it('rejects a ZIP whose central directory declares an oversized expansion before loading entries', async () => {
        const zip = new JSZip();
        zip.file('a.npy', makeNpy('|u1', [1], new Uint8Array([1])));
        const bytes = await zip.generateAsync({ type: 'uint8array' });
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let offset = 0; offset + 46 <= bytes.length; offset++) {
            if (view.getUint32(offset, true) === 0x02014b50) {
                view.setUint32(offset + 24, 0x30000000, true);
                break;
            }
        }
        const document = await parseNumpy(bytes, 'bomb.npz');
        expect(document.diagnostics?.[0]?.code).toBe('npzDeclaredSize');
        expect(document.arrays).toEqual([]);
    });

    it('CRC-checks selected members and skips only the corrupted array', async () => {
        const zip = new JSZip();
        zip.file('bad.npy', makeNpy('|u1', [1], new Uint8Array([1])));
        zip.file('good.npy', makeNpy('|u1', [1], new Uint8Array([2])));
        const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let offset = 0; offset + 30 <= bytes.length; offset++) {
            if (view.getUint32(offset, true) !== 0x04034b50) continue;
            const nameLength = view.getUint16(offset + 26, true);
            const extraLength = view.getUint16(offset + 28, true);
            const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
            if (name === 'bad.npy') {
                const payloadOffset = offset + 30 + nameLength + extraLength;
                const compressedSize = view.getUint32(offset + 18, true);
                const target = payloadOffset + compressedSize - 1;
                bytes[target] = bytes[target]! ^ 0xff;
                break;
            }
        }
        const document = await parseNumpy(bytes, 'crc.npz');
        expect(document.arrays.map(array => array.name)).toEqual(['good']);
        expect(document.diagnostics?.some(item => item.code === 'npzCrc' && item.args?.name === 'bad.npy')).toBe(true);
    });

    it('isolates a malformed compressed member and retains valid siblings', async () => {
        const zip = new JSZip();
        zip.file('bad.npy', makeNpy('|u1', [1024], new Uint8Array(1024).fill(7)));
        zip.file('good.npy', makeNpy('|u1', [1], new Uint8Array([2])));
        const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let offset = 0; offset + 30 <= bytes.length; offset++) {
            if (view.getUint32(offset, true) !== 0x04034b50) continue;
            const nameLength = view.getUint16(offset + 26, true); const extraLength = view.getUint16(offset + 28, true);
            const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
            if (name === 'bad.npy') {
                bytes[offset + 30 + nameLength + extraLength] = 0xff;
                break;
            }
        }
        const document = await parseNumpy(bytes, 'broken.npz');
        expect(document.arrays.map(array => array.name)).toEqual(['good']);
        expect(document.diagnostics?.some(item => item.code === 'npzEntryRead')).toBe(true);
    });
});
