import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { declaredZipUncompressedBytes } from './zip-scan.js';

function zipBytes(): Uint8Array {
    const ws = XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'S');
    return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

/** Overwrite the uncompressed-size field of the first central directory
 *  record — simulates an archive whose headers declare an oversized payload. */
function patchFirstDeclaredSize(bytes: Uint8Array, size: number): Uint8Array {
    const patched = bytes.slice();
    const v = new DataView(patched.buffer);
    for (let p = 0; p + 46 <= patched.length; p++) {
        if (v.getUint32(p, true) === 0x02014b50) {
            v.setUint32(p + 24, size, true);
            return patched;
        }
    }
    throw new Error('no central directory record found');
}

function findEocd(bytes: Uint8Array): number {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let p = bytes.length - 22; p >= 0; p--) {
        if (v.getUint32(p, true) === 0x06054b50) return p;
    }
    throw new Error('no EOCD found');
}

function corruptSecondCentralDirectoryRecord(bytes: Uint8Array): Uint8Array {
    const patched = bytes.slice();
    const v = new DataView(patched.buffer);
    const eocd = findEocd(patched);
    const first = v.getUint32(eocd + 16, true);
    const second = first + 46 + v.getUint16(first + 28, true) +
        v.getUint16(first + 30, true) + v.getUint16(first + 32, true);
    if (v.getUint32(second, true) !== 0x02014b50) throw new Error('no second central directory record found');
    v.setUint32(second, 0, true);
    return patched;
}

describe('declaredZipUncompressedBytes', () => {
    it('returns null for non-ZIP input', () => {
        expect(declaredZipUncompressedBytes(new Uint8Array(64))).toBeNull();
        expect(declaredZipUncompressedBytes(new TextEncoder().encode('a,b\n1,2'))).toBeNull();
        expect(declaredZipUncompressedBytes(new Uint8Array(0))).toBeNull();
    });

    it('sums the declared uncompressed sizes of a real archive', () => {
        const total = declaredZipUncompressedBytes(zipBytes());
        expect(total).toBeGreaterThan(0);
        expect(total).toBeLessThan(1024 * 1024);
    });

    it('reports headers that declare an oversized payload', () => {
        const total = declaredZipUncompressedBytes(patchFirstDeclaredSize(zipBytes(), 0xfffffffe));
        expect(total).toBeGreaterThan(0xf0000000);
    });

    it('treats ZIP64 size markers as unbounded', () => {
        const total = declaredZipUncompressedBytes(patchFirstDeclaredSize(zipBytes(), 0xffffffff));
        expect(total).toBe(Number.POSITIVE_INFINITY);
    });

    it('fails closed when a declared central-directory record is malformed', () => {
        expect(declaredZipUncompressedBytes(corruptSecondCentralDirectoryRecord(zipBytes())))
            .toBe(Number.POSITIVE_INFINITY);
    });

    it('fails closed when the EOCD record count does not match the directory', () => {
        const patched = zipBytes().slice();
        const v = new DataView(patched.buffer);
        const eocd = findEocd(patched);
        const count = v.getUint16(eocd + 10, true);
        v.setUint16(eocd + 8, count + 1, true);
        v.setUint16(eocd + 10, count + 1, true);
        expect(declaredZipUncompressedBytes(patched)).toBe(Number.POSITIVE_INFINITY);
    });

    it('does not accept a fake trailing EOCD as an empty archive', () => {
        const original = zipBytes();
        const patched = new Uint8Array(original.length + 22);
        patched.set(original);
        new DataView(patched.buffer).setUint32(original.length, 0x06054b50, true);
        expect(declaredZipUncompressedBytes(patched)).toBe(Number.POSITIVE_INFINITY);
    });

    it('fails closed when a recognizable ZIP is truncated', () => {
        const original = zipBytes();
        expect(declaredZipUncompressedBytes(original.slice(0, -1))).toBe(Number.POSITIVE_INFINITY);
    });

    it('accepts a valid EOCD comment', () => {
        const original = zipBytes();
        const comment = new TextEncoder().encode('safe comment');
        const patched = new Uint8Array(original.length + comment.length);
        patched.set(original);
        patched.set(comment, original.length);
        const eocd = findEocd(original);
        new DataView(patched.buffer).setUint16(eocd + 20, comment.length, true);
        expect(declaredZipUncompressedBytes(patched)).toBe(declaredZipUncompressedBytes(original));
    });
});
