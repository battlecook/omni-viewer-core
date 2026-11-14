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
const CDF_DIGITAL_SIGNATURE = 0x05054b50;
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
    constructor(readonly code: EpubReadErrorCode, readonly path: string, readonly outputBytes?: number) {
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
    const candidates: { directory: ZipDirectoryLocation; rank: number; eocd: number }[] = [];
    for (let p = data.byteLength - 22; p >= Math.max(0, data.byteLength - (22 + 0xffff)); p--) {
        if (view.getUint32(p, true) !== EOCD_SIG) continue;
        const end = p + 22 + view.getUint16(p + 20, true);
        if (end > data.byteLength) continue;
        const directory = zipDirectoryAt(view, p);
        if (!directory) continue;
        const rank = (directory.count ? 4 : 0) + (directory.adjacent ? 2 : 0) + (end === data.byteLength ? 1 : 0);
        candidates.push({ directory, rank, eocd: p });
    }
    // Prefer the earlier EOCD on a tie. A later marker may be inside its comment.
    candidates.sort((a, b) => b.rank - a.rank || a.eocd - b.eocd);
    const validateEntries = Math.max(0xffff, maxEntries);
    let remainingChecks = validateEntries * 2;
    const directory = candidates.find(({ directory }) => {
        const count = Math.min(directory.count, validateEntries);
        let at = directory.offset;
        for (let index = 0; index < count; index++) {
            if (remainingChecks-- <= 0) return false;
            at = nextDirectoryEntry(view, at, directory.end);
            if (at < 0) return false;
        }
        // Larger ZIP64 archives still get a bounded probe. For a complete walk,
        // the declared count must consume the directory, optionally with its signature.
        return count < directory.count || at === directory.end ||
            (at + 6 <= directory.end && view.getUint32(at, true) === CDF_DIGITAL_SIGNATURE &&
                at + 6 + view.getUint16(at + 4, true) === directory.end);
    })?.directory;
    if (!directory) return null;
    const declared = directory.count;
    let position = directory.offset;

    const decoder = new TextDecoder('utf-8', { fatal: false });
    const entries: EpubZipEntry[] = [];
    const count = Math.min(declared, maxEntries);
    for (let index = 0; index < count; index++) {
        const next = nextDirectoryEntry(view, position, directory.end);
        if (next < 0) return null;
        const nameLength = view.getUint16(position + 28, true);
        const extraLength = view.getUint16(position + 30, true);
        const nameStart = position + 46;
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
        position = next;
    }
    if (entries.length === 0 && declared > 0) return null;
    return { entries, truncated: declared > count };
}

function nextDirectoryEntry(view: DataView, offset: number, end: number): number {
    if (offset + 46 > end || view.getUint32(offset, true) !== CDFH_SIG) return -1;
    const next = offset + 46 + view.getUint16(offset + 28, true) +
        view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    return next <= end ? next : -1;
}

interface ZipDirectoryLocation {
    count: number;
    offset: number;
    end: number;
    adjacent: boolean;
}

function zipDirectoryAt(view: DataView, eocd: number): ZipDirectoryLocation | undefined {
    let count = view.getUint16(eocd + 10, true);
    let size = view.getUint32(eocd + 12, true);
    let offset = view.getUint32(eocd + 16, true);
    let end = eocd;
    const locator = eocd - 20;
    const hasZip64Locator = locator >= 0 && view.getUint32(locator, true) === EOCD64_LOCATOR_SIG;
    // Exactly 65,535 entries can also be represented by a classic ZIP.
    if (size === 0xffffffff || offset === 0xffffffff || (count === 0xffff && hasZip64Locator)) {
        if (!hasZip64Locator) return;
        const eocd64 = readUint64(view, locator + 8);
        if (eocd64 === null || eocd64 + 56 > locator || view.getUint32(eocd64, true) !== EOCD64_SIG) return;
        const count64 = readUint64(view, eocd64 + 32);
        const size64 = readUint64(view, eocd64 + 40);
        const offset64 = readUint64(view, eocd64 + 48);
        if (count64 === null || size64 === null || offset64 === null) return;
        count = count64;
        size = size64;
        offset = offset64;
        end = eocd64;
    }
    if (offset + size > end) return;
    if (count ? offset + 4 > end || view.getUint32(offset, true) !== CDFH_SIG : offset + size !== end) return;
    return { count, offset, end: offset + size, adjacent: offset + size === end };
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
    if (typeof DecompressionStream !== 'function') return false;
    try {
        // Some runtimes implement gzip and zlib streams only.
        new DecompressionStream('deflate-raw');
        return true;
    } catch {
        return false;
    }
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
        throw new EpubReadError('corrupted', '', total);
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
