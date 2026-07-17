// Container-format signatures and the office extension → container map
// (DESIGN.md §7-3, docs/viewers/excel.md §5). ZIP (xlsx/xlsm/docx/pptx/hwpx…)
// and OLE/CFB (xls/doc/ppt/hwp…) each share one signature across many formats,
// so the leading bytes only tell us the *container* — which viewer it holds is
// resolved by probeContainer (stage 2). Excel is the first such viewer; the
// office family inherits this contract.

export type ContainerKind = 'zip' | 'ole';

/** Local file header 'PK\x03\x04' — the start of every OOXML/ODF/zip file. */
export const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;
/** Empty ZIP end-of-central-directory record. */
export const EMPTY_ZIP_MAGIC = [0x50, 0x4b, 0x05, 0x06] as const;

/** OLE2 / Compound File Binary signature. */
export const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

/** Longest container signature — how many leading bytes a probe needs to sniff. */
export const CONTAINER_SNIFF_BYTES = 262; // TAR's `ustar` reaches byte 261

/**
 * Which container an office extension lives in. Used in stage-1 detection to
 * verify a trusted extension against the actual bytes and to route ambiguous
 * containers. Extend this as word/ppt/hwpx land (they share the same map).
 */
export const OFFICE_CONTAINER_BY_EXT: Readonly<Record<string, ContainerKind>> = {
    xlsx: 'zip',
    xlsm: 'zip',
    xlsb: 'zip', // binary workbook — still an OOXML-style zip with an xl/ tree
    ods: 'zip', // OpenDocument spreadsheet — zip with a spreadsheet mimetype
    xls: 'ole',
    pptx: 'zip',
    ppt: 'ole',
    docx: 'zip',
    doc: 'ole',
    hwpx: 'zip',
    hwp: 'ole'
};

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
    if (bytes.byteLength < magic.length) return false;
    for (let i = 0; i < magic.length; i++) {
        if (bytes[i] !== magic[i]) return false;
    }
    return true;
}

/** Classify the container from leading bytes, or null when neither matches. */
export function sniffContainer(bytes: Uint8Array): ContainerKind | null {
    if (startsWith(bytes, ZIP_MAGIC) || startsWith(bytes, EMPTY_ZIP_MAGIC)) return 'zip';
    if (startsWith(bytes, OLE_MAGIC)) return 'ole';
    return null;
}
