import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { parseMat } from './index.js';

const MI_INT8 = 1;
const MI_INT32 = 5;
const MI_UINT32 = 6;
const MI_DOUBLE = 9;
const MI_MATRIX = 14;
const MI_COMPRESSED = 15;
const MI_UTF8 = 16;

function concat(...chunks: Uint8Array[]): Uint8Array {
    const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
}

function pad8(data: Uint8Array): Uint8Array {
    const padding = (8 - data.length % 8) % 8; return padding ? concat(data, new Uint8Array(padding)) : data;
}

function element(type: number, payload: Uint8Array): Uint8Array {
    if (payload.length <= 4) {
        const result = new Uint8Array(8); const view = new DataView(result.buffer); view.setUint16(0, type, true); view.setUint16(2, payload.length, true); result.set(payload, 4); return result;
    }
    const tag = new Uint8Array(8); const view = new DataView(tag.buffer); view.setUint32(0, type, true); view.setUint32(4, payload.length, true); return concat(tag, pad8(payload));
}

function int32s(values: number[]): Uint8Array { const result = new Uint8Array(values.length * 4); const view = new DataView(result.buffer); values.forEach((value, index) => view.setInt32(index * 4, value, true)); return result; }
function doubles(values: number[]): Uint8Array { const result = new Uint8Array(values.length * 8); const view = new DataView(result.buffer); values.forEach((value, index) => view.setFloat64(index * 8, value, true)); return result; }

function matrix(name: string, classId: number, dimensions: number[], dataType: number, data: Uint8Array): Uint8Array {
    const flags = new Uint8Array(8); new DataView(flags.buffer).setUint32(0, classId, true);
    return element(MI_MATRIX, concat(element(MI_UINT32, flags), element(MI_INT32, int32s(dimensions)), element(MI_INT8, new TextEncoder().encode(name)), element(dataType, data)));
}

function level5(): Uint8Array {
    const header = new Uint8Array(128).fill(0x20); header.set(new TextEncoder().encode('MATLAB 5.0 MAT-file, Platform: omni-viewer, Created for tests')); const view = new DataView(header.buffer); view.setUint16(124, 0x0100, true); header.set(new TextEncoder().encode('IM'), 126);
    return concat(header, matrix('answer', 6, [1, 3], MI_DOUBLE, doubles([1.5, 2.5, 3.5])), matrix('label', 4, [1, 5], MI_UTF8, new TextEncoder().encode('hello')));
}

function level5Header(endian: 'LE' | 'BE'): Uint8Array {
    const header = new Uint8Array(128).fill(0x20); header.set(new TextEncoder().encode('MATLAB 7.0 MAT-file, Platform: omni-viewer, Created for tests')); const view = new DataView(header.buffer); view.setUint16(124, 0x0100, endian === 'LE'); header.set(new TextEncoder().encode(endian === 'LE' ? 'IM' : 'MI'), 126); return header;
}

function compressedElement(payload: Uint8Array): Uint8Array {
    const compressed = deflateSync(payload); const tag = new Uint8Array(8); const view = new DataView(tag.buffer); view.setUint32(0, MI_COMPRESSED, true); view.setUint32(4, compressed.length, true); return concat(tag, compressed);
}

function bigEndianElement(type: number, payload: Uint8Array): Uint8Array {
    if (payload.length <= 4) { const result = new Uint8Array(8); const view = new DataView(result.buffer); view.setUint16(0, type, false); view.setUint16(2, payload.length, false); result.set(payload, 4); return result; }
    const tag = new Uint8Array(8); const view = new DataView(tag.buffer); view.setUint32(0, type, false); view.setUint32(4, payload.length, false); return concat(tag, pad8(payload));
}

function bigEndianLevel5(): Uint8Array {
    const flags = new Uint8Array(8); new DataView(flags.buffer).setUint32(0, 6, false);
    const dimensions = new Uint8Array(8); const dimensionsView = new DataView(dimensions.buffer); dimensionsView.setInt32(0, 1, false); dimensionsView.setInt32(4, 1, false);
    const value = new Uint8Array(8); new DataView(value.buffer).setFloat64(0, 42, false);
    const matrixPayload = concat(bigEndianElement(MI_UINT32, flags), bigEndianElement(MI_INT32, dimensions), bigEndianElement(MI_INT8, new TextEncoder().encode('abc')), bigEndianElement(MI_DOUBLE, value));
    return concat(level5Header('BE'), bigEndianElement(MI_MATRIX, matrixPayload));
}

function level4(): Uint8Array {
    const name = new TextEncoder().encode('legacy\0'); const values = doubles([10, 20, 30, 40]); const header = new Uint8Array(20); const view = new DataView(header.buffer); view.setInt32(0, 0, true); view.setInt32(4, 2, true); view.setInt32(8, 2, true); view.setInt32(12, 0, true); view.setInt32(16, name.length, true); return concat(header, name, values);
}

describe('parseMat', () => {
    it('parses Level 5 numeric and character variables', async () => {
        const document = await parseMat(level5());
        expect(document.format).toBe('MAT v5/v6/v7');
        expect(document.summary).toContainEqual({ label: 'Variables', value: 2 });
        expect(document.variables).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'answer', className: 'double', dimensions: [1, 3], preview: '1.5, 2.5, 3.5' }),
            expect.objectContaining({ name: 'label', className: 'char', preview: '"hello"' })
        ]));
    });

    it('parses Level 4 matrix records', async () => {
        const data = level4(); const document = await parseMat(data);
        expect(document.format).toBe('MAT v4');
        expect(document.variables[0]).toMatchObject({ name: 'legacy', className: 'double', dimensions: [2, 2], bytes: data.length, preview: '10, 20, 30, 40' });
    });

    it('routes v7.3 through HDF5 metadata parsing', async () => {
        const document = await parseMat(new Uint8Array([0x89,0x48,0x44,0x46,0x0d,0x0a,0x1a,0x0a,0,0,0,0]));
        expect(document.format).toBe('MAT v7.3');
        expect(document.title).toBe('MATLAB MAT-file (HDF5)');
        expect(document.warnings.join(' ')).toContain('MAT v7.3 files are HDF5 containers');
    });

    it('finds an HDF5-backed v7.3 signature after a 512-byte user block', async () => {
        const data = new Uint8Array(528); data.set([0x89,0x48,0x44,0x46,0x0d,0x0a,0x1a,0x0a], 512);
        const document = await parseMat(data);
        expect(document.format).toBe('MAT v7.3');
        expect(document.title).toBe('MATLAB MAT-file (HDF5)');
    });

    it('inflates consecutive unpadded miCOMPRESSED variable blocks', async () => {
        const data = concat(
            level5Header('LE'),
            compressedElement(matrix('first', 6, [1, 1], MI_DOUBLE, doubles([11]))),
            compressedElement(matrix('second', 6, [1, 1], MI_DOUBLE, doubles([22])))
        );
        const document = await parseMat(data);
        expect(document.variables.map(variable => [variable.name, variable.preview])).toEqual([['first', '11'], ['second', '22']]);
        expect(document.warnings.join(' ')).not.toContain('Unable to expand');
    });

    it('decodes big-endian small data element tags without truncating names', async () => {
        const document = await parseMat(bigEndianLevel5());
        expect(document.variables[0]).toMatchObject({ name: 'abc', preview: '42', dimensions: [1, 1] });
    });
});
