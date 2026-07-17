import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { probeContainer } from './probe.js';

function xlsxBytes(bookType: 'xlsx' | 'xls' | 'xlsb' | 'ods'): Uint8Array {
    const ws = XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    return new Uint8Array(XLSX.write(wb, { type: 'array', bookType }));
}

/**
 * Build a minimal zip that carries only a central directory + EOCD (no local
 * file data) — enough for the probe, which reads entry names from the central
 * directory. Central directory sits at offset 0.
 */
function makeZip(names: string[]): Uint8Array {
    const enc = new TextEncoder();
    const cdfhs = names.map((name) => {
        const nameBytes = enc.encode(name);
        const buf = new Uint8Array(46 + nameBytes.length);
        const dv = new DataView(buf.buffer);
        dv.setUint32(0, 0x02014b50, true); // central directory file header
        dv.setUint16(28, nameBytes.length, true); // file name length
        buf.set(nameBytes, 46);
        return buf;
    });
    const cdSize = cdfhs.reduce((n, b) => n + b.length, 0);

    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true); // EOCD signature
    edv.setUint16(8, names.length, true); // entries on this disk
    edv.setUint16(10, names.length, true); // total entries
    edv.setUint32(12, cdSize, true); // central directory size
    edv.setUint32(16, 0, true); // central directory offset = 0

    const out = new Uint8Array(cdSize + 22);
    let pos = 0;
    for (const b of cdfhs) { out.set(b, pos); pos += b.length; }
    out.set(eocd, pos);
    return out;
}

function makeStoredMimetypeZip(mimetype: string): Uint8Array {
    const enc = new TextEncoder(); const name = enc.encode('mimetype'); const data = enc.encode(mimetype);
    const local = new Uint8Array(30 + name.length + data.length); const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, name.length, true); local.set(name, 30); local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length); const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, name.length, true); cv.setUint32(42, 0, true); central.set(name, 46);
    const eocd = new Uint8Array(22); const ev = new DataView(eocd.buffer); ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true); ev.setUint32(12, central.length, true); ev.setUint32(16, local.length, true);
    const out = new Uint8Array(local.length + central.length + eocd.length); out.set(local); out.set(central, local.length); out.set(eocd, local.length + central.length); return out;
}

function makeHwpOle(includeBodyText: boolean): Uint8Array {
    const out = new Uint8Array(1536); const view = new DataView(out.buffer);
    out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); view.setUint16(30, 9, true); view.setUint32(44, 1, true); view.setUint32(48, 1, true); view.setUint32(76, 0, true);
    view.setUint32(512, 0xfffffffd, true); view.setUint32(516, 0xfffffffe, true);
    const entry = (offset: number, name: string, type: number): void => { const bytes = new TextEncoder().encode(`${name.split('').map((char) => `${char}\0`).join('')}\0\0`); out.set(bytes, offset); view.setUint16(offset + 64, bytes.length, true); view.setUint8(offset + 66, type); };
    entry(1024, 'FileHeader', 2); if (includeBodyText) entry(1152, 'BodyText', 1); return out;
}

describe('probeContainer — zip', () => {
    it('detects a real xlsx workbook as excel', async () => {
        expect(await probeContainer(xlsxBytes('xlsx'), 'zip')).toBe('excel');
    });

    it('detects xlsb (xl/ tree) and ods (spreadsheet mimetype) as excel', async () => {
        expect(await probeContainer(xlsxBytes('xlsb'), 'zip')).toBe('excel');
        expect(await probeContainer(xlsxBytes('ods'), 'zip')).toBe('excel');
    });

    it('routes OOXML part prefixes (synthetic central directory)', async () => {
        expect(await probeContainer(makeZip(['xl/workbook.xml', '[Content_Types].xml']), 'zip')).toBe('excel');
        expect(await probeContainer(makeZip(['word/document.xml']), 'zip')).toBe('word');
        expect(await probeContainer(makeZip(['ppt/presentation.xml']), 'zip')).toBe('ppt');
        expect(await probeContainer(makeZip(['Contents/section0.xml', 'content.hpf']), 'zip')).toBe('hwp');
    });

    it('returns null for a plain zip (no office parts)', async () => {
        expect(await probeContainer(makeZip(['hello.txt', 'readme.md']), 'zip')).toBeNull();
        // Content-types map alone (odd OOXML with no recognized part) → null.
        expect(await probeContainer(makeZip(['[Content_Types].xml']), 'zip')).toBeNull();
    });

    it('detects the canonical HWPX mimetype', async () => {
        expect(await probeContainer(makeStoredMimetypeZip('application/hwp+zip'), 'zip')).toBe('hwp');
    });

    it('returns null when the EOCD is absent', async () => {
        expect(await probeContainer(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]), 'zip')).toBeNull();
    });
});

describe('probeContainer — ole', () => {
    it('detects a real xls (BIFF8) workbook as excel', async () => {
        expect(await probeContainer(xlsxBytes('xls'), 'ole')).toBe('excel');
    });

    it('returns null for a malformed CFB (bad sector size)', async () => {
        // 512 bytes of OLE magic + zeros → sector shift 0 → sector size 1 → rejected.
        const buf = new Uint8Array(512);
        buf.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        expect(await probeContainer(buf, 'ole')).toBeNull();
    });

    it('returns null for too-short input', async () => {
        expect(await probeContainer(new Uint8Array(64), 'ole')).toBeNull();
    });

    it('requires both FileHeader and BodyText for HWP', async () => {
        expect(await probeContainer(makeHwpOle(false), 'ole')).toBeNull();
        expect(await probeContainer(makeHwpOle(true), 'ole')).toBe('hwp');
    });
});

describe('probeContainer — cancellation', () => {
    it('returns null when the signal is aborted', async () => {
        expect(await probeContainer(xlsxBytes('xlsx'), 'zip', { signal: AbortSignal.abort() })).toBeNull();
    });
});
