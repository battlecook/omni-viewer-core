import type JSZip from 'jszip';
import { declaredZipEntryCount, declaredZipUncompressedBytes } from '../zip-scan.js';
import {
    DEFAULT_LIMITS,
    LimitTracker,
    type LimitViolation,
    type ParseOptions,
    type ResourceLimits
} from '../types.js';

export const PPTX_DEFAULT_LIMITS: Required<Pick<ResourceLimits, 'maxInputBytes' | 'maxEntries' | 'maxDecompressedBytes' | 'maxParseMillis'>> = {
    maxInputBytes: 50 * 1024 * 1024,
    maxEntries: Math.min(DEFAULT_LIMITS.maxEntries, 100_000),
    maxDecompressedBytes: 256 * 1024 * 1024,
    maxParseMillis: DEFAULT_LIMITS.maxParseMillis
};

export class PptxLimitError extends Error {
    constructor(
        readonly violation: LimitViolation,
        readonly location?: string
    ) {
        super(`PPTX parsing stopped: ${violation.kind}`);
        this.name = 'PptxLimitError';
    }
}

export function pptxLimits(options: ParseOptions): ResourceLimits {
    return { ...PPTX_DEFAULT_LIMITS, ...options.limits };
}

export function preflightPptxZip(input: Uint8Array, limits: ResourceLimits): void {
    const count = declaredZipEntryCount(input);
    if (
        count !== null &&
        Number.isFinite(count) &&
        limits.maxEntries !== undefined &&
        count > limits.maxEntries
    ) {
        throw new PptxLimitError({ kind: 'entries', count });
    }
    const decompressed = declaredZipUncompressedBytes(input);
    if (
        decompressed !== null &&
        Number.isFinite(decompressed) &&
        limits.maxDecompressedBytes !== undefined &&
        decompressed > limits.maxDecompressedBytes
    ) {
        throw new PptxLimitError({ kind: 'decompressed', bytes: decompressed });
    }
}

export class PptxParseGuard {
    private readonly tracker: LimitTracker;

    constructor(
        readonly options: ParseOptions,
        readonly limits: ResourceLimits = pptxLimits(options)
    ) {
        this.tracker = new LimitTracker(limits, options.signal);
    }

    checkpoint(location?: string): void {
        const violation = this.tracker.checkpoint();
        if (violation) throw new PptxLimitError(violation, location);
    }

    addDecompressedBytes(bytes: number, location?: string): void {
        this.tracker.addDecompressedBytes(bytes);
        this.checkpoint(location);
    }
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function convertBytes(bytes: Uint8Array, type: string): unknown {
    switch (type.toLowerCase()) {
        case 'text':
        case 'string':
            return new TextDecoder().decode(bytes);
        case 'base64':
            return bytesToBase64(bytes);
        case 'arraybuffer':
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        case 'array':
            return Array.from(bytes);
        case 'nodebuffer': {
            const NodeBuffer = (globalThis as typeof globalThis & {
                Buffer?: { from(data: Uint8Array): unknown };
            }).Buffer;
            return NodeBuffer ? NodeBuffer.from(bytes) : bytes;
        }
        default:
            return bytes;
    }
}

/**
 * Replaces JSZip's per-entry `async()` accumulator with a bounded streaming
 * implementation. This is intentionally installed after central-directory
 * preflight: declared limits reject ordinary ZIP bombs before inflate, while
 * this wrapper catches lying headers and cancellation between 16 KiB chunks.
 */
export function installBoundedZipReaders(zip: JSZip, guard: PptxParseGuard): void {
    for (const [entryPath, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        let cachedBytes: Uint8Array | undefined;
        entry.async = (async (type: string) => {
            guard.checkpoint(entryPath);
            if (cachedBytes) return convertBytes(cachedBytes, type);
            const helper = (entry as typeof entry & {
                internalStream(type: string): {
                    on(event: string, callback: (...args: any[]) => void): any;
                    pause(): void;
                    resume(): void;
                };
            }).internalStream('uint8array');
            const chunks: Uint8Array[] = [];
            let total = 0;
            const bytes = await new Promise<Uint8Array>((resolve, reject) => {
                let settled = false;
                const fail = (error: unknown): void => {
                    if (settled) return;
                    settled = true;
                    helper.pause();
                    reject(error);
                };
                helper
                    .on('data', (chunk: Uint8Array) => {
                        if (settled) return;
                        try {
                            guard.addDecompressedBytes(chunk.byteLength, entryPath);
                            chunks.push(chunk);
                            total += chunk.byteLength;
                        } catch (error) {
                            fail(error);
                        }
                    })
                    .on('error', fail)
                    .on('end', () => {
                        if (settled) return;
                        settled = true;
                        const output = new Uint8Array(total);
                        let offset = 0;
                        for (const chunk of chunks) {
                            output.set(chunk, offset);
                            offset += chunk.byteLength;
                        }
                        resolve(output);
                    })
                    .resume();
            });
            guard.checkpoint(entryPath);
            cachedBytes = bytes;
            return convertBytes(bytes, type);
        }) as typeof entry.async;
    }
}

export function limitDiagnosticArgs(error: PptxLimitError): Record<string, string | number> {
    const { violation } = error;
    if (violation.kind === 'entries') return { kind: violation.kind, count: violation.count };
    if (violation.kind === 'decompressed') return { kind: violation.kind, bytes: violation.bytes };
    if (violation.kind === 'time') return { kind: violation.kind, elapsedMillis: violation.elapsedMillis };
    return { kind: violation.kind };
}
