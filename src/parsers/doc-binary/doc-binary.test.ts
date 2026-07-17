import { describe, expect, it } from 'vitest';
import { parseDocBinary } from './index.js';

const writeName = (dir: Uint8Array, offset: number, name: string, type: number, sector: number, size: number): void => {
    const view = new DataView(dir.buffer, dir.byteOffset, dir.byteLength); for (let i = 0; i < name.length; i++) view.setUint16(offset + i * 2, name.charCodeAt(i), true);
    view.setUint16(offset + name.length * 2, 0, true); view.setUint16(offset + 64, (name.length + 1) * 2, true); dir[offset + 66] = type;
    view.setInt32(offset + 116, sector, true); view.setUint32(offset + 120, size, true);
};

function fixture(text: string): Uint8Array {
    const file = new Uint8Array(512 * 5), header = new DataView(file.buffer), fat = new DataView(file.buffer, 512, 512), dir = file.subarray(1024, 1536), word = file.subarray(1536, 2048), table = file.subarray(2048, 2560);
    file.set([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]); header.setUint16(24, 0x3e, true); header.setUint16(26, 3, true); header.setUint16(28, 0xfffe, true); header.setUint16(30, 9, true); header.setUint16(32, 6, true);
    header.setUint32(44, 1, true); header.setInt32(48, 1, true); header.setUint32(56, 0, true); header.setInt32(60, -2, true); header.setInt32(68, -2, true); for (let i = 0; i < 109; i++) header.setInt32(76 + i * 4, i === 0 ? 0 : -1, true);
    fat.setUint32(0, 0xfffffffd, true); fat.setUint32(4, 0xfffffffe, true); fat.setUint32(8, 0xfffffffe, true); fat.setUint32(12, 0xfffffffe, true); for (let i = 4; i < 128; i++) fat.setUint32(i * 4, 0xffffffff, true);
    writeName(dir, 0, 'Root Entry', 5, -2, 0); writeName(dir, 128, 'WordDocument', 2, 2, 512); writeName(dir, 256, '1Table', 2, 3, 512);
    const w = new DataView(word.buffer, word.byteOffset, word.byteLength); w.setUint16(0, 0xa5ec, true); w.setUint16(10, 1 << 9, true); w.setUint16(32, 0, true); w.setUint16(34, 6, true); w.setUint32(48, text.length, true); w.setUint16(60, 34, true); w.setUint32(62 + 33 * 8, 0, true); w.setUint32(62 + 33 * 8 + 4, 21, true);
    for (let i = 0; i < text.length; i++) word[384 + i] = text.charCodeAt(i);
    const t = new DataView(table.buffer, table.byteOffset, table.byteLength); table[0] = 2; t.setUint32(1, 16, true); t.setUint32(5, 0, true); t.setUint32(9, text.length, true); t.setUint32(15, 0x40000000 | (384 * 2), true);
    return file;
}

describe('parseDocBinary', () => {
    it('reads WordDocument through FIB/CLX instead of decoding the whole OLE file', () => {
        const parsed = parseDocBinary(fixture('Hello\rWorld')).result;
        expect(parsed.status, JSON.stringify(parsed)).toBe('ok');
        if (parsed.status === 'failed') throw new Error('expected document');
        expect(parsed.document.text).toBe('Hello\nWorld');
        expect(parsed.document.text).not.toContain('Root Entry');
    });

    it('creates a semantic table model from Word cell markers', () => {
        const parsed = parseDocBinary(fixture('A\tB\r1\t2')).result;
        if (parsed.status === 'failed') throw new Error('expected document');
        expect(parsed.document.sections[0]?.blocks).toEqual([{ kind: 'table', rows: [['A', 'B'], ['1', '2']] }]);
    });

    it('rejects non-CFB bytes', () => {
        expect(parseDocBinary(new Uint8Array([1, 2, 3])).result.status).toBe('failed');
    });
});
