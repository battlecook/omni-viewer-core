// Declared-size pre-scan for ZIP containers. Sums the uncompressed sizes
// recorded in the central directory *before* any inflate runs, so archives
// whose headers admit an oversized payload (zip bombs) are rejected up front
// without allocating anything. A crafted archive can lie in these fields, so
// callers that hand the bytes to a library with its own inflater (SheetJS,
// JSZip, docx-preview) must still treat this as a first line of defense, not
// a hard guarantee.

const EOCD = 0x06054b50;
const CDFH = 0x02014b50;
const LFH = 0x04034b50;
const CENTRAL_DIRECTORY_DIGITAL_SIGNATURE = 0x05054b50;
/** EOCD is 22 bytes plus a comment of at most 0xffff bytes. */
const EOCD_SEARCH_SPAN = 22 + 0xffff;

/**
 * Total uncompressed bytes declared by a ZIP central directory.
 *
 * Returns `null` when the input is not recognizably a ZIP, and `Infinity` when
 * ZIP64 markers or structural inconsistencies make the total unknowable from
 * the 32-bit central-directory fields (always over any finite limit).
 */
export function declaredZipUncompressedBytes(input: Uint8Array): number | null {
    if (input.length < 22) return null;
    const v = new DataView(input.buffer, input.byteOffset, input.byteLength);
    let eocd = -1;
    for (let p = input.length - 22; p >= Math.max(0, input.length - EOCD_SEARCH_SPAN); p--) {
        if (v.getUint32(p, true) !== EOCD) continue;
        // A signature-like byte sequence inside the ZIP comment is not an EOCD.
        // The real EOCD comment must end exactly at the end of the input.
        if (p + 22 + v.getUint16(p + 20, true) !== input.length) continue;
        eocd = p;
        break;
    }
    if (eocd < 0) {
        // Office ZIP containers start with a local-file header. If that marker
        // is present but a complete EOCD is not, treat the truncated/malformed
        // archive as unbounded instead of allowing the downstream inflater to
        // decide whether it can recover partial entries.
        return v.getUint32(0, true) === LFH ? Number.POSITIVE_INFINITY : null;
    }

    const disk = v.getUint16(eocd + 4, true);
    const centralDisk = v.getUint16(eocd + 6, true);
    const diskCount = v.getUint16(eocd + 8, true);
    const count = v.getUint16(eocd + 10, true);
    const centralSize = v.getUint32(eocd + 12, true);
    let p = v.getUint32(eocd + 16, true);
    if (
        disk === 0xffff || centralDisk === 0xffff || diskCount === 0xffff ||
        count === 0xffff || centralSize === 0xffffffff || p === 0xffffffff
    ) return Number.POSITIVE_INFINITY; // ZIP64
    // Multi-disk archives cannot be bounded from this single input.
    if (disk !== 0 || centralDisk !== 0 || diskCount !== count) return Number.POSITIVE_INFINITY;

    const centralEnd = p + centralSize;
    if (p > eocd || centralEnd !== eocd) return Number.POSITIVE_INFINITY;

    let total = 0;
    for (let i = 0; i < count; i++) {
        if (p + 46 > centralEnd || v.getUint32(p, true) !== CDFH) {
            return Number.POSITIVE_INFINITY;
        }
        const size = v.getUint32(p + 24, true);
        if (size === 0xffffffff) return Number.POSITIVE_INFINITY; // ZIP64
        total += size;
        const next = p + 46 + v.getUint16(p + 28, true) + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
        if (next > centralEnd) return Number.POSITIVE_INFINITY;
        p = next;
    }

    // A central-directory digital signature is permitted after the file
    // headers and is included in the EOCD central-directory byte count.
    if (p < centralEnd && p + 6 <= centralEnd && v.getUint32(p, true) === CENTRAL_DIRECTORY_DIGITAL_SIGNATURE) {
        p += 6 + v.getUint16(p + 4, true);
    }
    if (p !== centralEnd) return Number.POSITIVE_INFINITY;
    return total;
}
