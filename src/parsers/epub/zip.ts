// Bounded ZIP access for EPUB (OCF) containers.
//
// An EPUB is an ordinary deflate ZIP, and a reader needs only a handful of its
// members at a time (the package document, the navigation document, the
// chapter on screen and its images). This reader walks the central directory
// once, then inflates single members on demand. Every inflate is capped twice:
// by the caller's per-member budget and by the size the central directory
// declares, so a member that inflates past its own header is rejected as
// corrupt instead of being trusted (zip-bomb defense, DESIGN.md §3-①).
//
// Inflation uses the platform's `DecompressionStream('deflate-raw')`; hosts
// without it can inject an inflater through `EpubInflate`.

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CDFH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;
/** General-purpose flag bit 0: the member is encrypted (traditional PKWARE / AES). */
const FLAG_ENCRYPTED = 0x0001;

export interface EpubZipEntry {
    /** Member path exactly as stored (UTF-8 decoded). */
    name: string;
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
    encrypted: boolean;
}

/**
 * Inflates one raw-deflate member. `maxBytes` is the most the caller will
 * accept; an implementation should stop and reject as soon as output exceeds
 * it rather than inflating the rest.
 */
export type EpubInflate = (compressed: Uint8Array, maxBytes: number, signal?: AbortSignal) => Promise<Uint8Array>;

/** Why a member could not be read — mapped to diagnostics by the caller. */
export type EpubReadErrorCode =
    | 'missing'
    | 'too-large'
    | 'unsupported-method'
    | 'encrypted'
    | 'corrupted'
    | 'inflate-unavailable'
    | 'budget-exceeded'
    | 'aborted';

export class EpubReadError extends Error {
    override readonly name = 'EpubReadError';
    constructor(readonly code: EpubReadErrorCode, readonly path: string) {
        super(`${code}: ${path}`);
    }
}

export interface EpubZipDirectory {
    entries: EpubZipEntry[];
    /** The directory declared more entries than `maxEntries` admitted. */
    truncated: boolean;
}

/**
 * Reads the central directory (ZIP64-aware). Returns null when the bytes are
 * not a readable ZIP. Never throws on malformed input.
 */
export function readZipDirectory(data: Uint8Array, maxEntries: number): EpubZipDirectory | null {
    if (data.byteLength < 22) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let eocd = -1;
    let fallback = -1;
    for (let p = data.byteLength - 22; p >= Math.max(0, data.byteLength - (22 + 0xffff)); p--) {
        if (view.getUint32(p, true) !== EOCD_SIG) continue;
        // A signature-like run inside the archive comment is not the EOCD; the
        // real record's comment ends exactly at the end of the input.
        if (p + 22 + view.getUint16(p + 20, true) === data.byteLength) {
            eocd = p;
            break;
        }
        // Tolerate trailing bytes after the record (a stray newline appended in
        // transit) when its directory offset really points at a directory.
        if (fallback < 0) {
            const count = view.getUint16(p + 10, true);
            const offset = view.getUint32(p + 16, true);
            if (count === 0 || (offset + 4 <= p && view.getUint32(offset, true) === CDFH_SIG)) fallback = p;
        }
    }
    if (eocd < 0) eocd = fallback;
    if (eocd < 0) return null;
    let declared = view.getUint16(eocd + 10, true);
    let position = view.getUint32(eocd + 16, true);
    if (declared === 0xffff || position === 0xffffffff) {
        const locator = eocd - 20;
        if (locator < 0 || view.getUint32(locator, true) !== EOCD64_LOCATOR_SIG) return null;
        const eocd64 = readUint64(view, locator + 8);
        if (eocd64 === null || eocd64 + 56 > data.byteLength || view.getUint32(eocd64, true) !== EOCD64_SIG) return null;
        const count = readUint64(view, eocd64 + 32);
        const offset = readUint64(view, eocd64 + 48);
        if (count === null || offset === null) return null;
        declared = count;
        position = offset;
    }

    const decoder = new TextDecoder('utf-8', { fatal: false });
    const entries: EpubZipEntry[] = [];
    const count = Math.min(declared, maxEntries);
    for (let index = 0; index < count; index++) {
        if (position + 46 > data.byteLength || view.getUint32(position, true) !== CDFH_SIG) break;
        const nameLength = view.getUint16(position + 28, true);
        const extraLength = view.getUint16(position + 30, true);
        const commentLength = view.getUint16(position + 32, true);
        const nameStart = position + 46;
        if (nameStart + nameLength + extraLength > data.byteLength) break;
        const entry: EpubZipEntry = {
            name: decoder.decode(data.subarray(nameStart, nameStart + nameLength)),
            method: view.getUint16(position + 10, true),
            compressedSize: view.getUint32(position + 20, true),
            uncompressedSize: view.getUint32(position + 24, true),
            localHeaderOffset: view.getUint32(position + 42, true),
            encrypted: (view.getUint16(position + 8, true) & FLAG_ENCRYPTED) !== 0
        };
        applyZip64Extra(view, nameStart + nameLength, extraLength, entry);
        entries.push(entry);
        position = nameStart + nameLength + extraLength + commentLength;
    }
    if (entries.length === 0 && declared > 0) return null;
    return { entries, truncated: declared > count };
}

function applyZip64Extra(view: DataView, start: number, length: number, entry: EpubZipEntry): void {
    let p = start;
    const end = start + length;
    while (p + 4 <= end) {
        const id = view.getUint16(p, true);
        const size = view.getUint16(p + 2, true);
        const body = p + 4;
        if (body + size > end) return;
        if (id === ZIP64_EXTRA_ID) {
            let q = body;
            const take = (): number | null => {
                if (q + 8 > body + size) return null;
                const value = readUint64(view, q);
                q += 8;
                return value;
            };
            if (entry.uncompressedSize === 0xffffffff) entry.uncompressedSize = take() ?? entry.uncompressedSize;
            if (entry.compressedSize === 0xffffffff) entry.compressedSize = take() ?? entry.compressedSize;
            if (entry.localHeaderOffset === 0xffffffff) entry.localHeaderOffset = take() ?? entry.localHeaderOffset;
            return;
        }
        p = body + size;
    }
}

function readUint64(view: DataView, at: number): number | null {
    if (at + 8 > view.byteLength) return null;
    const value = view.getBigUint64(at, true);
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
}

/** The member's stored payload (compressed bytes for deflate), viewed in place. */
export function memberPayload(data: Uint8Array, entry: EpubZipEntry): Uint8Array | undefined {
    const offset = entry.localHeaderOffset;
    if (offset < 0 || offset + 30 > data.byteLength) return undefined;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(offset, true) !== LFH_SIG) return undefined;
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const end = start + entry.compressedSize;
    if (start > data.byteLength || end > data.byteLength) return undefined;
    return data.subarray(start, end);
}

/** True when this environment can inflate without an injected inflater. */
export function hasPlatformInflate(): boolean {
    return typeof DecompressionStream === 'function';
}

/**
 * `DecompressionStream`-backed inflater that stops reading as soon as the
 * output passes `maxBytes`, so an oversized member costs at most one chunk
 * beyond the cap.
 */
export const platformInflate: EpubInflate = async (compressed, maxBytes, signal) => {
    const source = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(compressed);
            controller.close();
        }
    });
    const reader = source.pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            if (signal?.aborted) throw new EpubReadError('aborted', '');
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) throw new EpubReadError('too-large', '');
            chunks.push(value);
        }
    } catch (error) {
        void reader.cancel().catch(() => undefined);
        if (error instanceof EpubReadError) throw error;
        throw new EpubReadError('corrupted', '');
    }
    if (chunks.length === 1) return chunks[0]!;
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.byteLength;
    }
    return out;
};
