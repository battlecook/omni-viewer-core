import { describe, expect, it } from 'vitest';
import {
    detectViewer,
    IMAGE_VIEWER_DESCRIPTOR,
    REQUIRED_SNIFF_BYTES
} from './index.js';

describe('detectViewer (stage 1)', () => {
    it('matches csv/tsv extensions case-insensitively (ASCII)', () => {
        expect(detectViewer('data.csv').viewerId).toBe('csv');
        expect(detectViewer('DATA.CSV').viewerId).toBe('csv');
        expect(detectViewer('t.TsV').viewerId).toBe('csv');
        expect(detectViewer('report.PDF').viewerId).toBe('pdf');
    });

    it('resolves a known image extension to the image viewer', () => {
        const r = detectViewer('photo.png');
        expect(r.viewerId).toBe('image');
    });

    it('falls back for extensions without a viewer', () => {
        const r = detectViewer('archive.rar');
        expect(r.viewerId).toBe('archive');
        expect(r.matchedBy).toBe('extension');
    });

    it('rejects a .pdf whose bytes are not %PDF- when sniff bytes are given', () => {
        const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
        const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
        expect(detectViewer('doc.pdf', undefined, undefined, pdfMagic).viewerId).toBe('pdf');
        // Extension says pdf, bytes say zip -> signature mismatch -> fallback.
        expect(detectViewer('doc.pdf', undefined, undefined, zipMagic).viewerId).toBe('fallback');
        // Without sniff bytes the extension match stands (stage-1 contract).
        expect(detectViewer('doc.pdf').viewerId).toBe('pdf');
    });

    it('detects unlabelled non-ZIP archive magic and rejects extension conflicts', () => {
        const gzip = new Uint8Array([0x1f, 0x8b, 8, 0]);
        expect(detectViewer('no-name', undefined, undefined, gzip)).toMatchObject({ viewerId: 'archive', matchedBy: 'content' });
        expect(detectViewer('wrong.rar', undefined, undefined, gzip).viewerId).toBe('fallback');
    });

    it('routes a named DMG from the standard leading-byte sniff to parser validation', () => {
        const head = new Uint8Array(REQUIRED_SNIFF_BYTES);
        expect(REQUIRED_SNIFF_BYTES).toBe(262);
        expect(detectViewer('sample.dmg', undefined, undefined, head)).toEqual({
            viewerId: 'archive',
            matchedBy: 'extension'
        });
    });

    it('is a golden table: fileName -> viewer', () => {
        const table: Array<[string, string]> = [
            ['a.csv', 'csv'],
            ['a.tsv', 'csv'],
            ['a.pdf', 'pdf'],
            ['a.parquet', 'parquet'],
            ['a.mat', 'mat'],
            ['a.h5', 'hdf5'],
            ['a.hdf5', 'hdf5'],
            ['a.he5', 'hdf5'],
            ['a.safetensors', 'safetensors'],
            ['a.json', 'json'],
            ['a.toml', 'toml'],
            ['a.jsonl', 'jsonl'],
            ['a.ndjson', 'jsonl'],
            ['a.yaml', 'yaml'],
            ['a.yml', 'yaml'],
            ['a.proto', 'proto'],
            ['DATA.JSON', 'json'],
            ['archive.tar.gz', 'archive'],
            ['noext', 'fallback'],
            ['.csv', 'csv']
        ];
        for (const [fileName, expected] of table) {
            expect(detectViewer(fileName).viewerId, fileName).toBe(expected);
        }
    });
});

describe('detectViewer (MAT)', () => {
    it('detects .mat by extension and classic MAT headers by content', () => {
        expect(detectViewer('sample.mat').viewerId).toBe('mat');
        const header = new TextEncoder().encode('MATLAB 5.0 MAT-file, Platform: test');
        expect(detectViewer('sample.bin', undefined, undefined, header)).toEqual({ viewerId: 'mat', matchedBy: 'content' });
    });

    it('keeps generic HDF5 content on the HDF5 viewer while .mat selects MAT v7.3', () => {
        const hdf5 = new Uint8Array([0x89,0x48,0x44,0x46,0x0d,0x0a,0x1a,0x0a]);
        expect(detectViewer('sample.mat', undefined, undefined, hdf5).viewerId).toBe('mat');
        expect(detectViewer('sample.bin', undefined, undefined, hdf5).viewerId).toBe('hdf5');
    });
});

describe('detectViewer (HDF5)', () => {
    const HDF5 = new Uint8Array([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);

    it('validates named HDF5 files and detects the signature without an extension', () => {
        expect(detectViewer('sample.h5', undefined, undefined, HDF5)).toEqual({ viewerId: 'hdf5', matchedBy: 'extension' });
        expect(detectViewer('sample.hdf5', undefined, undefined, HDF5).viewerId).toBe('hdf5');
        expect(detectViewer('dataset', undefined, undefined, HDF5)).toEqual({ viewerId: 'hdf5', matchedBy: 'content' });
        expect(detectViewer('wrong.h5', undefined, undefined, new Uint8Array(8)).viewerId).toBe('hdf5');
    });
});

describe('detectViewer (container viewers — excel, stage 1)', () => {
    const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    const OLE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

    it('matches office extensions', () => {
        expect(detectViewer('book.xlsx').viewerId).toBe('excel');
        expect(detectViewer('macros.XLSM').viewerId).toBe('excel');
        expect(detectViewer('legacy.xls').viewerId).toBe('excel');
        expect(detectViewer('binary.xlsb').viewerId).toBe('excel');
        expect(detectViewer('open.ods').viewerId).toBe('excel');
    });

    it('trusts an office extension when the container signature agrees', () => {
        const r = detectViewer('book.xlsx', undefined, undefined, ZIP);
        expect(r.viewerId).toBe('excel');
        expect(r.matchedBy).toBe('extension');
        expect(detectViewer('legacy.xls', undefined, undefined, OLE).viewerId).toBe('excel');
    });

    it('flags a contradicting container as ambiguous for probing', () => {
        // .xlsx (zip) whose bytes are OLE → probe as ole.
        const r = detectViewer('book.xlsx', undefined, undefined, OLE);
        expect(r.viewerId).toBe('fallback');
        expect(r.matchedBy).toBe('ambiguous-container');
        expect(r.container).toBe('ole');
    });

    it('routes a named archive directly and extensionless containers through probing', () => {
        const r = detectViewer('archive.zip', undefined, undefined, ZIP);
        expect(r.viewerId).toBe('archive');
        expect(r.matchedBy).toBe('extension');

        const noext = detectViewer('data', undefined, undefined, OLE);
        expect(noext.matchedBy).toBe('ambiguous-container');
        expect(noext.container).toBe('ole');
    });

    it('does not let excel grab .csv', () => {
        expect(detectViewer('data.csv').viewerId).toBe('csv');
    });

    it('trusts the office extension offline (no sniff bytes)', () => {
        expect(detectViewer('book.xlsx').matchedBy).toBe('extension');
    });
});

describe('detectViewer (Word)', () => {
    it('detects docx and doc and rejects contradictory containers', () => {
        const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
        const OLE = new Uint8Array([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]);
        expect(detectViewer('report.docx', undefined, undefined, ZIP).viewerId).toBe('word');
        expect(detectViewer('legacy.doc', undefined, undefined, OLE).viewerId).toBe('word');
        expect(detectViewer('wrong.docx', undefined, undefined, OLE).matchedBy).toBe('ambiguous-container');
    });
});

describe('detectViewer (stage 2 — content sniffing, J17)', () => {
    const sniff = (name: string, text: string) =>
        detectViewer(name, undefined, undefined, undefined, text);

    it('detects extensionless JSON by content', () => {
        const r = sniff('noext', '{"a":1}');
        expect(r.viewerId).toBe('json');
        expect(r.matchedBy).toBe('content');
    });

    it('detects Protocol Buffer schemas by content', () => {
        expect(sniff('schema.txt', 'syntax = "proto3";\nmessage User { string id = 1; }').viewerId).toBe('proto');
    });

    it('detects a mislabeled JSON file by content', () => {
        expect(sniff('data.txt', '[1,2,3]').viewerId).toBe('json');
    });

    it('trusts the extension over content (§7 point 3)', () => {
        // .csv content that is valid JSON still opens as csv.
        expect(sniff('data.csv', '{"a":1}').viewerId).toBe('csv');
    });

    it('detects JSONL before JSON from content', () => {
        // JSONL is checked before JSON so a record stream is not mis-opened as JSON.
        expect(sniff('noext', '{"a":1}\n{"b":2}').viewerId).toBe('jsonl');
    });

    it('falls back for non-JSON content', () => {
        expect(sniff('noext', 'just some text').viewerId).toBe('fallback');
    });

    it('falls back when no sniff text is provided (stage-1 only)', () => {
        expect(detectViewer('noext').viewerId).toBe('fallback');
    });
});

describe('detectViewer (magicSignatures — image viewer, image.md §1)', () => {
    // The image viewer is defined but not yet in CORE_VIEWER_DESCRIPTORS (Phase 2),
    // so tests pass it explicitly via the descriptors argument.
    const descriptors = [IMAGE_VIEWER_DESCRIPTOR] as const;
    const detect = (name: string, bytes?: Uint8Array) =>
        detectViewer(name, undefined, descriptors, bytes);

    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    // RIFF container that is not WebP (e.g. WAV) — RIFF@0 matches but WEBP@8 does not.
    const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0, 0, 0, 0, 0, 0, 0]);

    it('sniffs at least 12 bytes so WebP (WEBP@8) is reachable', () => {
        expect(REQUIRED_SNIFF_BYTES).toBeGreaterThanOrEqual(12);
    });

    it('matches PNG and JPEG signatures at offset 0', () => {
        expect(detect('a.png', PNG).viewerId).toBe('image');
        expect(detect('a.jpg', JPEG).viewerId).toBe('image');
    });

    it('matches WebP only when both RIFF@0 and WEBP@8 are present', () => {
        expect(detect('a.webp', WEBP).viewerId).toBe('image');
        // RIFF/WAVE has RIFF@0 but not WEBP@8 → no signature matches → fallback.
        expect(detect('a.webp', WAV).viewerId).toBe('fallback');
    });

    it('excludes the viewer when bytes match no image signature', () => {
        expect(detect('a.png', PDF).viewerId).toBe('fallback');
    });

    it('trusts the extension when no sniff bytes are given', () => {
        expect(detect('a.png').viewerId).toBe('image');
    });
});
