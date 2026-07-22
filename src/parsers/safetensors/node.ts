import * as fs from 'node:fs';
import {
    formatFileSize,
    parseSafetensorsSource,
    type SafetensorsDocument,
    type SafetensorsSource
} from './index.js';

const EMPTY = new Uint8Array(0);

/** File-descriptor-backed source that reads only requested safetensors ranges. */
export class SafetensorsFileSource implements SafetensorsSource {
    private closed = false;

    private constructor(
        private readonly fd: number,
        public readonly size: number
    ) {}

    public static open(filePath: string): SafetensorsFileSource {
        const fd = fs.openSync(filePath, 'r');
        try {
            return new SafetensorsFileSource(fd, fs.fstatSync(fd).size);
        } catch (error) {
            fs.closeSync(fd);
            throw error;
        }
    }

    public read(offset: number, length: number, signal?: AbortSignal): Uint8Array {
        if (this.closed) throw new Error('Safetensors source is closed');
        if (signal?.aborted) throw signal.reason ?? new Error('The operation was aborted.');
        const start = Math.max(0, offset);
        const end = Math.min(start + Math.max(0, length), this.size);
        if (end <= start) return EMPTY;

        const bytes = new Uint8Array(end - start);
        const bytesRead = fs.readSync(this.fd, bytes, 0, bytes.byteLength, start);
        return bytesRead === bytes.byteLength ? bytes : bytes.subarray(0, bytesRead);
    }

    public close(): void {
        if (this.closed) return;
        this.closed = true;
        fs.closeSync(this.fd);
    }
}

/** Parses a safetensors file after reading only its length prefix and JSON header. */
export async function parseSafetensorsFile(filePath: string, fileSize?: string): Promise<SafetensorsDocument> {
    const source = SafetensorsFileSource.open(filePath);
    try {
        return await parseSafetensorsSource(source, { fileSize: fileSize ?? formatFileSize(source.size) });
    } finally {
        source.close();
    }
}
