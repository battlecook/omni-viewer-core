import * as fs from 'node:fs';
import { Hdf5Parser, formatFileSize, type Hdf5Document, type Hdf5Reader } from './index.js';

const EMPTY = new Uint8Array(0);

/**
 * File-descriptor-backed random-access reader for Node hosts such as VS Code.
 * A 4 MiB LRU page cache keeps metadata traversal cheap without loading HDF5
 * dataset payloads or the complete file into memory.
 */
export class Hdf5FileReader implements Hdf5Reader {
    private static readonly PAGE_BYTES = 64 * 1024;
    private static readonly MAX_PAGES = 64;
    private readonly cache = new Map<number, Uint8Array>();
    private closed = false;

    private constructor(
        private readonly fd: number,
        public readonly size: number
    ) {}

    static open(filePath: string): Hdf5FileReader {
        const fd = fs.openSync(filePath, 'r');
        try {
            return new Hdf5FileReader(fd, fs.fstatSync(fd).size);
        } catch (error) {
            fs.closeSync(fd);
            throw error;
        }
    }

    read(offset: number, length: number): Uint8Array {
        if (this.closed) throw new Error('HDF5 reader is closed');
        const start = Math.max(0, offset);
        const end = Math.min(offset + length, this.size);
        if (end <= start) return EMPTY;

        const out = new Uint8Array(end - start);
        let position = start;
        while (position < end) {
            const pageIndex = Math.floor(position / Hdf5FileReader.PAGE_BYTES);
            const page = this.getPage(pageIndex);
            const inPage = position - pageIndex * Hdf5FileReader.PAGE_BYTES;
            const copyLength = Math.min(page.byteLength - inPage, end - position);
            if (copyLength <= 0) break;
            out.set(page.subarray(inPage, inPage + copyLength), position - start);
            position += copyLength;
        }
        return out;
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.cache.clear();
        try {
            fs.closeSync(this.fd);
        } catch {
            // Closing is best-effort and must not mask a parser failure.
        }
    }

    private getPage(pageIndex: number): Uint8Array {
        const cached = this.cache.get(pageIndex);
        if (cached) {
            this.cache.delete(pageIndex);
            this.cache.set(pageIndex, cached);
            return cached;
        }

        const start = pageIndex * Hdf5FileReader.PAGE_BYTES;
        const length = Math.min(Hdf5FileReader.PAGE_BYTES, this.size - start);
        if (length <= 0) return EMPTY;
        const page = new Uint8Array(length);
        const bytesRead = fs.readSync(this.fd, page, 0, length, start);
        const value = bytesRead === length ? page : page.subarray(0, bytesRead);
        if (this.cache.size >= Hdf5FileReader.MAX_PAGES) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
        }
        this.cache.set(pageIndex, value);
        return value;
    }
}

/** Parse an HDF5 file without loading dataset payloads into memory. */
export function parseHdf5File(filePath: string, fileSize?: string): Hdf5Document {
    const reader = Hdf5FileReader.open(filePath);
    try {
        return Hdf5Parser.parseReader(reader, fileSize ?? formatFileSize(reader.size));
    } finally {
        reader.close();
    }
}
