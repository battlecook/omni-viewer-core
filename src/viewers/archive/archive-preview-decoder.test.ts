import { describe, expect, it } from 'vitest';
import { tryDecodeArchiveEntryPreview } from './archive-preview-decoder.js';

describe('archive preview decoder', () => {
    it('falls back for ordinary text and non-XML binary entries', () => {
        expect(tryDecodeArchiveEntryPreview('notes.txt', new TextEncoder().encode('hello'))).toBeNull();
        expect(tryDecodeArchiveEntryPreview('classes.dex', new Uint8Array([3, 0, 8, 0]))).toBeNull();
    });

    it('decodes Android binary XML into readable XML', () => {
        const result = tryDecodeArchiveEntryPreview('AndroidManifest.xml', createBinaryXmlFixture());
        expect(result?.content).toContain('<?xml version="1.0" encoding="utf-8"?>');
        expect(result?.content).toContain('<manifest package="com.example.app">');
        expect(result?.content).toContain('</manifest>');
    });

    it('rejects malformed binary XML without throwing', () => {
        const fixture = createBinaryXmlFixture();
        expect(tryDecodeArchiveEntryPreview('AndroidManifest.xml', fixture.subarray(0, 20))).toBeNull();
    });
});

function createBinaryXmlFixture(): Uint8Array {
    const manifest = poolString('manifest'); const packageName = poolString('package'); const packageValue = poolString('com.example.app');
    const strings = align4(join(manifest, packageName, packageValue));
    const offsets = join(u32(0), u32(manifest.length), u32(manifest.length + packageName.length));
    const poolSize = 28 + offsets.length + strings.length;
    const pool = join(header(0x0001, 28, poolSize), u32(3), u32(0), u32(0x100), u32(28 + offsets.length), u32(0), offsets, strings);
    const start = join(header(0x0102, 36, 56), u32(1), u32(0xffffffff), u32(0xffffffff), u32(0), u16(20), u16(20), u16(1), u16(0), u16(0), u16(0), u32(0xffffffff), u32(1), u32(2), u16(8), new Uint8Array([0, 3]), u32(2));
    const end = join(header(0x0103, 24, 24), u32(1), u32(0xffffffff), u32(0xffffffff), u32(0));
    const body = join(pool, start, end);
    return join(header(0x0003, 8, 8 + body.length), body);
}

function poolString(value: string): Uint8Array { const bytes = new TextEncoder().encode(value); return join(new Uint8Array([value.length, bytes.length]), bytes, new Uint8Array(1)); }
function header(type: number, headerSize: number, size: number): Uint8Array { return join(u16(type), u16(headerSize), u32(size)); }
function u16(value: number): Uint8Array { const bytes = new Uint8Array(2); new DataView(bytes.buffer).setUint16(0, value, true); return bytes; }
function u32(value: number): Uint8Array { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value >>> 0, true); return bytes; }
function align4(bytes: Uint8Array): Uint8Array { const padding = (4 - bytes.length % 4) % 4; return padding ? join(bytes, new Uint8Array(padding)) : bytes; }
function join(...parts: Uint8Array[]): Uint8Array { const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }
