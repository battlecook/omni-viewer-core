import * as fs from 'node:fs';
import { Readable } from 'node:stream';
import { formatByteSize, parseGgufUri, type GgufDocument } from './index.js';

/** Parses a local GGUF file without reading its tensor payload. */
export async function parseGgufFile(
    filePath: string,
    fileSize?: string,
    signal?: AbortSignal
): Promise<GgufDocument> {
    let fileByteLength: number | undefined;
    let statError: unknown;
    try {
        fileByteLength = fs.statSync(filePath).size;
    } catch (error) {
        statError = error;
    }
    const displaySize = fileSize ?? (fileByteLength === undefined ? 'Unknown' : formatByteSize(fileByteLength));
    return parseGgufUri('https://omni-viewer.invalid/local-file.gguf', {
        fetch: statError === undefined && fileByteLength !== undefined
            ? createGgufFileRangeFetch(filePath, fileByteLength)
            : (async () => { throw statError ?? new Error('Unable to determine GGUF file size.'); }) as typeof fetch,
        fileSize: displaySize,
        ...(fileByteLength === undefined ? {} : { fileByteLength }),
        ...(signal ? { signal } : {})
    });
}

/** Serves bounded file ranges through an AbortSignal-aware Node stream. */
export function createGgufFileRangeFetch(filePath: string, fileByteLength: number): typeof fetch {
    return (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const match = new Headers(init?.headers).get('range')?.match(/^bytes=(\d+)-(\d+)$/i);
        if (!match) return new Response(null, { status: 400 });
        const start = Number(match[1]);
        const requestedEnd = Number(match[2]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || requestedEnd < start) {
            return new Response(null, { status: 400 });
        }
        if (start >= fileByteLength) {
            return new Response(null, {
                status: 416,
                headers: { 'Content-Range': `bytes */${fileByteLength}` }
            });
        }

        const end = Math.min(requestedEnd, fileByteLength - 1);
        const stream = fs.createReadStream(filePath, {
            start,
            end,
            ...(init?.signal ? { signal: init.signal } : {})
        });
        return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
            status: 206,
            headers: {
                'Content-Range': `bytes ${start}-${end}/${fileByteLength}`,
                'Content-Length': String(end - start + 1)
            }
        });
    }) as typeof fetch;
}
