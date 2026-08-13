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

        const unicode = new Uint8Array(8);
        const unicodeView = new DataView(unicode.buffer);
        unicodeView.setUint32(0, '한'.codePointAt(0)!, true); unicodeView.setUint32(4, '글'.codePointAt(0)!, true);
        expect(parseNpy(makeNpy('<U2', [1], unicode)).arrays[0]?.values).toEqual(['한글']);
    });

    it('never deserializes object/pickle payloads and reports malformed headers', () => {
        const object = parseNpy(makeNpy('|O8', [1], new TextEncoder().encode('pickle!!')));
        expect(object.arrays[0]?.values).toEqual([]);
        expect(object.warnings.join(' ')).toContain('unsafe pickle');

        const invalid = parseNpy(new Uint8Array([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 9, 0, 0, 0]));
        expect(invalid.warnings.join(' ')).toContain('Unsupported NPY format version');
    });

    it('caps decoded value previews', () => {
        const payload = new Uint8Array(NUMPY_PREVIEW_ELEMENT_LIMIT + 1);
        const array = parseNpy(makeNpy('|u1', [payload.length], payload)).arrays[0]!;
        expect(array.values).toHaveLength(NUMPY_PREVIEW_ELEMENT_LIMIT);
        expect(array.previewTruncated).toBe(true);
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
});
