import { describe, expect, it } from 'vitest';
import {
    CONTAINER_SNIFF_BYTES,
    OFFICE_CONTAINER_BY_EXT,
    OLE_MAGIC,
    ZIP_MAGIC,
    sniffContainer
} from './container.js';

describe('sniffContainer', () => {
    it('classifies zip (PK\\x03\\x04)', () => {
        expect(sniffContainer(new Uint8Array([...ZIP_MAGIC, 0x14, 0x00]))).toBe('zip');
    });

    it('classifies ole/cfb', () => {
        expect(sniffContainer(new Uint8Array([...OLE_MAGIC, 0x00, 0x00]))).toBe('ole');
    });

    it('returns null for non-container bytes', () => {
        expect(sniffContainer(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBeNull(); // %PDF-
        expect(sniffContainer(new Uint8Array([]))).toBeNull();
        expect(sniffContainer(new Uint8Array([0x50, 0x4b]))).toBeNull(); // truncated
    });
});

describe('OFFICE_CONTAINER_BY_EXT', () => {
    it('maps xlsx/xlsm to zip and xls to ole', () => {
        expect(OFFICE_CONTAINER_BY_EXT['xlsx']).toBe('zip');
        expect(OFFICE_CONTAINER_BY_EXT['xlsm']).toBe('zip');
        expect(OFFICE_CONTAINER_BY_EXT['xls']).toBe('ole');
    });

    it('sniff budget covers TAR\'s ustar signature at offset 257', () => {
        expect(CONTAINER_SNIFF_BYTES).toBe(262);
    });
});
