// Stage-2 container probe (DESIGN.md §7-3·ADR 16, docs/viewers/excel.md §5).
// Given bytes already known to be a zip/ole container (sniffContainer), look
// *inside* to decide which viewer holds it. Dependency-free and defensive —
// any structural anomaly returns null (→ fallback), never throws, so this can
// run before any heavy parser dependency is loaded.

import type { ParseOptions } from '../parsers/types.js';
import type { ContainerKind } from './container.js';

/** Default cap on entries/directory records a probe will scan. */
const DEFAULT_PROBE_ENTRY_CAP = 4096;

export async function probeContainer(
    input: Uint8Array,
    container: ContainerKind,
    options: ParseOptions = {}
): Promise<string | null> {
    // Async signature for contract symmetry (§5) and future worker/streaming;
    // the current implementations are synchronous scans over an in-memory view.
    if (options.signal?.aborted) return null;
    return container === 'zip' ? probeZip(input, options) : probeOle(input, options);
}

// ─── ZIP (OOXML / ODF) ────────────────────────────────────────────────────
// Parse the End Of Central Directory, then walk the central directory file
// headers collecting entry names. OOXML members live under `xl/`, `word/`,
// `ppt/`; ODF carries a `mimetype` member; a bare zip/jar matches none.

const EOCD_SIG = 0x06054b50; // PK\x05\x06 (little-endian uint32)
const CDFH_SIG = 0x02014b50; // PK\x01\x02

function probeZip(input: Uint8Array, options: ParseOptions): string | null {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const eocd = findEocd(view);
    if (eocd < 0) return null;

    const entryCount = view.getUint16(eocd + 10, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    const cap = Math.min(entryCount, options.limits?.maxEntries ?? DEFAULT_PROBE_ENTRY_CAP);

    let pos = cdOffset;
    for (let i = 0; i < cap; i++) {
        if (options.signal?.aborted) return null;
        if (pos + 46 > view.byteLength) break;
        if (view.getUint32(pos, true) !== CDFH_SIG) break;
        const nameLen = view.getUint16(pos + 28, true);
        const extraLen = view.getUint16(pos + 30, true);
        const commentLen = view.getUint16(pos + 32, true);
        const nameStart = pos + 46;
        if (nameStart + nameLen > view.byteLength) break;
        const name = asciiName(input, nameStart, nameLen);

        // OOXML (xlsx/xlsm/xlsb, docx, pptx) route by member-path prefix.
        if (name.startsWith('xl/')) return 'excel';
        if (name.startsWith('word/')) return 'word';
        if (name.startsWith('ppt/')) return 'ppt';
        if (name.startsWith('Contents/') || name === 'content.hpf') return 'hwp';
        // ODF (.ods/.odt/.odp) — the stored `mimetype` member carries the type.
        if (name === 'mimetype') {
            const localOffset = view.getUint32(pos + 42, true);
            const storedSize = view.getUint32(pos + 20, true);
            const mimetype = readStoredEntry(input, view, localOffset, storedSize);
            if (mimetype.trim() === 'application/hwp+zip') return 'hwp';
            if (mimetype.includes('spreadsheet')) return 'excel';
            if (mimetype.includes('text') || mimetype.includes('presentation')) return null;
        }

        pos = nameStart + nameLen + extraLen + commentLen;
    }

    // OOXML content-types with no recognized part prefix, or a plain zip/jar.
    return null;
}

/** Scan backwards for the EOCD signature (record is 22 bytes + comment). */
function findEocd(view: DataView): number {
    const min = Math.max(0, view.byteLength - (22 + 0xffff));
    for (let pos = view.byteLength - 22; pos >= min; pos--) {
        if (view.getUint32(pos, true) === EOCD_SIG) return pos;
    }
    return -1;
}

function asciiName(bytes: Uint8Array, start: number, len: number): string {
    let out = '';
    for (let i = 0; i < len; i++) {
        out += String.fromCharCode(bytes[start + i]!);
    }
    return out;
}

const LFH_SIG = 0x04034b50; // PK\x03\x04 (local file header)

/** Read a STORED (uncompressed) entry's bytes as ASCII — used for the ODF
 *  `mimetype` member, which spec-mandates be the first, stored entry. */
function readStoredEntry(bytes: Uint8Array, view: DataView, localOffset: number, size: number): string {
    if (localOffset < 0 || localOffset + 30 > view.byteLength) return '';
    if (view.getUint32(localOffset, true) !== LFH_SIG) return '';
    const nameLen = view.getUint16(localOffset + 26, true);
    const extraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + nameLen + extraLen;
    const end = Math.min(dataStart + size, view.byteLength);
    if (dataStart >= end) return '';
    return asciiName(bytes, dataStart, end - dataStart);
}

// ─── OLE / CFB (legacy Office) ──────────────────────────────────────────────
// Parse the Compound File header, follow the directory sector chain via the
// FAT, and read directory entry names. Excel BIFF workbooks carry a `Workbook`
// (BIFF8) or `Book` (BIFF5) stream.

const CFB_ENDOFCHAIN = 0xfffffffe;
const CFB_FREESECT = 0xffffffff;

function probeOle(input: Uint8Array, options: ParseOptions): string | null {
    if (input.byteLength < 512) return null;
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);

    const sectorShift = view.getUint16(30, true);
    const sectorSize = 1 << sectorShift;
    if (sectorSize !== 512 && sectorSize !== 4096) return null;

    const numFatSectors = view.getUint32(44, true);
    const dirStart = view.getUint32(48, true);

    const sectorOffset = (sid: number): number => (sid + 1) * sectorSize;
    const readU32 = (off: number): number =>
        off + 4 <= view.byteLength ? view.getUint32(off, true) : CFB_ENDOFCHAIN;

    // Build the FAT from the header DIFAT (first 109 entries). Enough to follow
    // the directory chain in typical office files; DIFAT-extension sectors are
    // out of scope for a probe (returns null if the chain can't be followed).
    const fat: number[] = [];
    const fatSectorCount = Math.min(numFatSectors, 109);
    for (let i = 0; i < fatSectorCount; i++) {
        const fatSid = view.getUint32(76 + i * 4, true);
        if (fatSid === CFB_FREESECT || fatSid === CFB_ENDOFCHAIN) continue;
        const base = sectorOffset(fatSid);
        if (base + sectorSize > view.byteLength) break;
        for (let j = 0; j < sectorSize; j += 4) fat.push(readU32(base + j));
    }
    if (fat.length === 0) return null;

    const decoder = new TextDecoder('utf-16le');
    const cap = options.limits?.maxEntries ?? DEFAULT_PROBE_ENTRY_CAP;
    let sid = dirStart;
    let scanned = 0;
    const seen = new Set<number>();
    let hasHwpFileHeader = false;
    let hasHwpBodyText = false;

    while (sid !== CFB_ENDOFCHAIN && sid !== CFB_FREESECT && scanned < cap) {
        if (options.signal?.aborted) return null;
        if (sid < 0 || sid >= fat.length || seen.has(sid)) break; // out of range / cycle
        seen.add(sid);
        const base = sectorOffset(sid);
        if (base + sectorSize > view.byteLength) break;

        for (let off = base; off + 128 <= base + sectorSize; off += 128) {
            if (scanned++ >= cap) break;
            const nameLen = view.getUint16(off + 64, true);
            const objType = view.getUint8(off + 66);
            if (objType !== 1 /* storage */ && objType !== 2 /* stream */) continue;
            if (nameLen < 4 || nameLen > 64) continue;
            const name = decoder.decode(input.subarray(off, off + nameLen - 2));
            if (objType === 2 && (name === 'Workbook' || name === 'Book')) return 'excel';
            if (objType === 2 && name === 'WordDocument') return 'word';
            if (objType === 2 && name === 'PowerPoint Document') return 'ppt';
            if (objType === 2 && name === 'FileHeader') hasHwpFileHeader = true;
            if (objType === 1 && name === 'BodyText') hasHwpBodyText = true;
        }

        sid = fat[sid] ?? CFB_ENDOFCHAIN;
    }

    return hasHwpFileHeader && hasHwpBodyText ? 'hwp' : null;
}
