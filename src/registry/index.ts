// Viewer registry — pure detection data, no dynamic loading (DESIGN.md §7,
// ADR 21). Adapters register the viewers they enable via their own explicit
// import map. For the pilot the descriptor list is hand-maintained from the
// viewer metadata exports; the build-time codegen replaces this when more
// viewers land (ADR 37).

import type { ServiceId } from '../host/index.js';
import { asciiLower } from '../parsers/csv/index.js';
import { sniffTextViewer } from './sniff.js';
import {
    CONTAINER_SNIFF_BYTES,
    OFFICE_CONTAINER_BY_EXT,
    sniffContainer,
    type ContainerKind
} from './container.js';

/** One contiguous byte run at a fixed offset. */
export interface MagicByteRun {
    offset: number;
    bytes: readonly number[];
}

/** A signature matches when *every* run matches (AND). A descriptor's
 *  `magicSignatures` list matches when *any* signature matches (OR) — this is
 *  how one viewer covers several formats (e.g. the image viewer's PNG/JPEG/
 *  GIF/BMP/WebP), and how a multi-part signature like WebP's `RIFF`@0 + `WEBP`@8
 *  is expressed (docs/viewers/image.md §1). */
export type MagicSignature = readonly MagicByteRun[];

export interface ViewerDescriptor {
    id: string;
    displayNameKey: string;
    /** Lower-case, no leading dot. */
    extensions: string[];
    priority: number;
    /** Leading file bytes that must match when sniff bytes are provided
     *  (e.g. '%PDF-'). A mismatch excludes the viewer (docs/viewers/pdf.md). */
    magicPrefix?: readonly number[];
    /** Offset-aware alternative to magicPrefix for viewers that span multiple
     *  formats or need non-zero offsets. Excludes the viewer when sniff bytes
     *  are present and no signature matches. */
    magicSignatures?: readonly MagicSignature[];
    requiredServices: readonly ServiceId[];
    optionalServices: readonly ServiceId[];
}

/** Raster image signatures (docs/viewers/image.md §1). SVG has no fixed magic
 *  and is handled by extension + text probe in the viewer, not here. */
export const IMAGE_MAGIC_SIGNATURES: readonly MagicSignature[] = [
    [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }], // PNG
    [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }], // JPEG
    [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }], // GIF87a/89a → 'GIF8'
    [{ offset: 0, bytes: [0x42, 0x4d] }], // BMP → 'BM'
    [
        { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // 'RIFF'
        { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } // 'WEBP'
    ]
];

export const AVRO_MAGIC_SIGNATURES: readonly MagicSignature[] = [[
    { offset: 0, bytes: [0x4f, 0x62, 0x6a, 0x01] }
]];
export const BAG_MAGIC_SIGNATURES: readonly MagicSignature[] = [[
    { offset: 0, bytes: [0x23, 0x52, 0x4f, 0x53, 0x42, 0x41, 0x47, 0x20, 0x56, 0x32, 0x2e] }
]];
export const STP_MAGIC_SIGNATURES: readonly MagicSignature[] = [[
    { offset: 0, bytes: [0x49, 0x53, 0x4f, 0x2d, 0x31, 0x30, 0x33, 0x30, 0x33, 0x2d, 0x32, 0x31, 0x3b] }
]];
export const DB3_MAGIC_SIGNATURES: readonly MagicSignature[] = [[
    { offset: 0, bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00] }
]];
export const BLF_MAGIC_SIGNATURES: readonly MagicSignature[] = [[{ offset: 0, bytes: [0x4c,0x4f,0x47,0x47] }]];
export const MF4_MAGIC_SIGNATURES: readonly MagicSignature[] = [[{ offset: 0, bytes: [0x4d,0x44,0x46,0x20,0x20,0x20,0x20,0x20] }]];
export const PCAP_MAGIC_SIGNATURES: readonly MagicSignature[] = [
    [{offset:0,bytes:[0xa1,0xb2,0xc3,0xd4]}],[{offset:0,bytes:[0xd4,0xc3,0xb2,0xa1]}],
    [{offset:0,bytes:[0xa1,0xb2,0x3c,0x4d]}],[{offset:0,bytes:[0x4d,0x3c,0xb2,0xa1]}]
];
export const PCAPNG_MAGIC_SIGNATURES: readonly MagicSignature[] = [[{offset:0,bytes:[0x0a,0x0d,0x0d,0x0a]}]];
export const PSD_MAGIC_SIGNATURES: readonly MagicSignature[] = [[{offset:0,bytes:[0x38,0x42,0x50,0x53]}]];
export const SHAPEFILE_MAGIC_SIGNATURES: readonly MagicSignature[] = [[{offset:0,bytes:[0x00,0x00,0x27,0x0a]}]];

/** Farthest byte any signature needs (WebP reaches offset 8 + 4 = 12). */
const signatureReach = (sigs: readonly MagicSignature[]): number =>
    Math.max(0, ...sigs.flat().map((run) => run.offset + run.bytes.length));

/**
 * How many leading bytes an adapter should sniff for detection — the longest of
 * the longest magicPrefix (PDF, 5B), the container signatures (OLE, 8B), and the
 * image signatures (WebP, 12B). Stage-1 uses only these; container probing
 * (stage 2) needs the whole file to read the central directory / CFB
 * (docs/viewers/excel.md §5).
 */
export const REQUIRED_SNIFF_BYTES = Math.max(
    5,
    CONTAINER_SNIFF_BYTES,
    signatureReach(IMAGE_MAGIC_SIGNATURES),
    signatureReach(AVRO_MAGIC_SIGNATURES),
    signatureReach(BAG_MAGIC_SIGNATURES),
    signatureReach(STP_MAGIC_SIGNATURES),
    signatureReach(DB3_MAGIC_SIGNATURES)
    ,signatureReach(MF4_MAGIC_SIGNATURES)
);

export const CSV_VIEWER_DESCRIPTOR: ViewerDescriptor = {
    id: 'csv',
    displayNameKey: 'csv.tableView',
    extensions: ['csv', 'tsv'],
    priority: 10,
    requiredServices: [],
    optionalServices: ['clipboard', 'save', 'writeback']
};

export const FALLBACK_VIEWER_DESCRIPTOR: ViewerDescriptor = {
    id: 'fallback',
    displayNameKey: 'fallback.title.text',
    extensions: [],
    priority: -1,
    requiredServices: [],
    optionalServices: []
};

export const PDF_VIEWER_DESCRIPTOR: ViewerDescriptor = {
    id: 'pdf',
    displayNameKey: 'pdf.title',
    extensions: ['pdf'],
    priority: 20,
    magicPrefix: [0x25, 0x50, 0x44, 0x46, 0x2d], // '%PDF-'
    requiredServices: [],
    optionalServices: ['save', 'writeback', 'filePick', 'clipboard']
};
export const PARQUET_MAGIC_SIGNATURES: readonly MagicSignature[] = [[{ offset: 0, bytes: [0x50, 0x41, 0x52, 0x31] }]];
export const PARQUET_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'parquet',displayNameKey:'parquet.title',extensions:['parquet'],priority:20,magicSignatures:PARQUET_MAGIC_SIGNATURES,requiredServices:[],optionalServices:['clipboard','save']};
export const AVRO_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'avro',displayNameKey:'avro.title',extensions:['avro'],priority:20,magicSignatures:AVRO_MAGIC_SIGNATURES,requiredServices:[],optionalServices:['clipboard']};
export const BAG_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'bag',displayNameKey:'bag.title',extensions:['bag'],priority:20,magicSignatures:BAG_MAGIC_SIGNATURES,requiredServices:[],optionalServices:['clipboard']};
export const STP_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'stp',displayNameKey:'stp.title',extensions:['stp','step'],priority:20,magicSignatures:STP_MAGIC_SIGNATURES,requiredServices:[],optionalServices:['clipboard']};
export const DB3_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'db3',displayNameKey:'db3.title',extensions:['db3'],priority:20,magicSignatures:DB3_MAGIC_SIGNATURES,requiredServices:[],optionalServices:['clipboard']};
export const REQIF_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'reqif',displayNameKey:'reqif.title',extensions:['reqif'],priority:20,requiredServices:[],optionalServices:['clipboard']};
export const HDF5_MAGIC_PREFIX = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a] as const;
// HDF5 permits a user block before the signature (offset 512, 1024, ...), so
// named files are admitted by extension and validated by the parser. A leading
// signature still enables extensionless content routing below.
export const HDF5_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'hdf5',displayNameKey:'hdf5.title',extensions:['h5','hdf5','he5'],priority:20,requiredServices:[],optionalServices:['clipboard']};
export const MAT_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'mat',displayNameKey:'mat.title',extensions:['mat'],priority:20,requiredServices:[],optionalServices:['clipboard']};
// Safetensors has no fixed leading magic (the file opens with an 8-byte header
// length), so it is admitted by extension and validated by the parser.
export const SAFETENSORS_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'safetensors',displayNameKey:'safetensors.title',extensions:['safetensors'],priority:20,requiredServices:[],optionalServices:['clipboard']};
export const AUDIO_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'audio',displayNameKey:'audio.title',extensions:['mp3','wav','pcm','aiff','aif','aifc','amr','awb','ogg','flac','ac3','aac','m4a'],priority:20,requiredServices:[],optionalServices:[]};
export const VIDEO_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'video',displayNameKey:'video.title',extensions:['mp4','mts','m2ts','avi','mov','wmv','flv','webm','mkv'],priority:20,requiredServices:[],optionalServices:[]};
export const DBC_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'dbc',displayNameKey:'dbc.title',extensions:['dbc'],priority:20,requiredServices:[],optionalServices:['clipboard']};
export const ARXML_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'arxml',displayNameKey:'arxml.title',extensions:['arxml'],priority:20,requiredServices:[],optionalServices:['clipboard']};
export const A2L_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'a2l',displayNameKey:'a2l.title',extensions:['a2l'],priority:20,requiredServices:[],optionalServices:['clipboard']};
export const ASC_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'asc',displayNameKey:'asc.title',extensions:['asc'],priority:20,requiredServices:[],optionalServices:['clipboard']};
export const BLF_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'blf',displayNameKey:'blf.title',extensions:['blf'],priority:20,magicSignatures:BLF_MAGIC_SIGNATURES,requiredServices:[],optionalServices:['clipboard']};
export const MF4_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'mf4',displayNameKey:'mf4.title',extensions:['mf4'],priority:20,magicSignatures:MF4_MAGIC_SIGNATURES,requiredServices:[],optionalServices:['clipboard']};
export const PCAP_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'pcap',displayNameKey:'pcap.title',extensions:['pcap'],priority:20,magicSignatures:PCAP_MAGIC_SIGNATURES,requiredServices:[],optionalServices:['clipboard']};
export const PCAPNG_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'pcapng',displayNameKey:'pcapng.title',extensions:['pcapng'],priority:20,magicSignatures:PCAPNG_MAGIC_SIGNATURES,requiredServices:[],optionalServices:['clipboard']};
export const MERMAID_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'mermaid',displayNameKey:'mermaid.title',extensions:['mmd','mermaid'],priority:20,requiredServices:[],optionalServices:[]};
export const PLANTUML_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'plantuml',displayNameKey:'plantuml.title',extensions:['puml','plantuml','iuml'],priority:20,requiredServices:[],optionalServices:[]};
export const SHAPEFILE_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'shapefile',displayNameKey:'shapefile.title',extensions:['shp'],priority:20,magicSignatures:SHAPEFILE_MAGIC_SIGNATURES,requiredServices:[],optionalServices:[]};
export const PSD_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'psd',displayNameKey:'psd.title',extensions:['psd'],priority:20,magicSignatures:PSD_MAGIC_SIGNATURES,requiredServices:[],optionalServices:[]};

export const JSON_VIEWER_DESCRIPTOR: ViewerDescriptor = {
    id: 'json',
    displayNameKey: 'json.treeView',
    extensions: ['json'],
    priority: 10,
    // JSON has no signature; extensionless content sniffing is stage-2 (J17,
    // docs/viewers/json.md) and not part of this synchronous descriptor.
    requiredServices: [],
    optionalServices: ['clipboard', 'save', 'writeback']
};

export const TOML_VIEWER_DESCRIPTOR: ViewerDescriptor = {
    id: 'toml', displayNameKey: 'toml.treeView', extensions: ['toml'], priority: 10,
    requiredServices: [], optionalServices: ['clipboard']
};
export const JSONL_VIEWER_DESCRIPTOR: ViewerDescriptor = {
    id: 'jsonl', displayNameKey: 'jsonl.title', extensions: ['jsonl', 'ndjson', 'jsonlines'], priority: 10,
    requiredServices: [], optionalServices: ['clipboard', 'save', 'writeback']
};
export const YAML_VIEWER_DESCRIPTOR: ViewerDescriptor = {
    id: 'yaml', displayNameKey: 'yaml.treeView', extensions: ['yaml', 'yml'], priority: 10,
    requiredServices: [], optionalServices: ['clipboard']
};
export const PROTO_VIEWER_DESCRIPTOR: ViewerDescriptor = {
    id: 'proto', displayNameKey: 'proto.title', extensions: ['proto'], priority: 10,
    requiredServices: [], optionalServices: ['clipboard']
};

/**
 * Excel spans two containers (xlsx/xlsm are zip, xls is ole), so it has no
 * single magicPrefix — the container is verified via OFFICE_CONTAINER_BY_EXT
 * and, when ambiguous, probeContainer (docs/viewers/excel.md §5, X-감지).
 */
export const EXCEL_VIEWER_DESCRIPTOR: ViewerDescriptor = {
    id: 'excel',
    displayNameKey: 'excel.tableView',
    extensions: ['xlsx', 'xlsm', 'xlsb', 'ods', 'xls'],
    priority: 15,
    requiredServices: [],
    optionalServices: ['clipboard', 'save']
};
export const PPT_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'ppt',displayNameKey:'ppt.title',extensions:['pptx','ppt'],priority:15,requiredServices:[],optionalServices:[]};
export const WORD_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'word',displayNameKey:'word.title',extensions:['docx','doc'],priority:15,requiredServices:[],optionalServices:['print','navigation']};
export const HWP_VIEWER_DESCRIPTOR: ViewerDescriptor = {id:'hwp',displayNameKey:'hwp.title',extensions:['hwp','hwpx'],priority:15,requiredServices:[],optionalServices:[]};

/**
 * Image viewer detection metadata (docs/viewers/image.md §1). Background removal
 * and sprite detection are optional host services (image.md I8), never
 * requiredServices: gating them here would exclude the image viewer on platforms
 * that don't provide them. SVG has no fixed magic — it is admitted by extension
 * and the viewer's text probe (decode.ts).
 */
export const IMAGE_VIEWER_DESCRIPTOR: ViewerDescriptor = {
    id: 'image',
    displayNameKey: 'image.title',
    extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'],
    priority: 15,
    magicSignatures: IMAGE_MAGIC_SIGNATURES,
    requiredServices: [],
    optionalServices: ['save', 'writeback', 'backgroundRemoval', 'spriteDetection']
};

export const MARKDOWN_VIEWER_DESCRIPTOR: ViewerDescriptor = {
    id: 'markdown', displayNameKey: 'markdown.title',
    extensions: ['md', 'markdown', 'mdown', 'mkdn', 'mkd'], priority: 10,
    requiredServices: [], optionalServices: ['clipboard', 'navigation', 'documentAssets', 'writeback', 'save']
};
export const ARCHIVE_MAGIC_SIGNATURES: readonly MagicSignature[] = [
    [{ offset: 0, bytes: [0x50,0x4b,0x03,0x04] }], [{ offset: 0, bytes: [0x50,0x4b,0x05,0x06] }],
    [{ offset: 257, bytes: [0x75,0x73,0x74,0x61,0x72] }], [{ offset: 0, bytes: [0x1f,0x8b] }],
    [{ offset: 0, bytes: [0x42,0x5a,0x68] }], [{ offset: 0, bytes: [0xfd,0x37,0x7a,0x58,0x5a,0x00] }],
    [{ offset: 0, bytes: [0x37,0x7a,0xbc,0xaf,0x27,0x1c] }], [{ offset: 0, bytes: [0x52,0x61,0x72,0x21,0x1a,0x07,0x00] }], [{ offset: 0, bytes: [0x52,0x61,0x72,0x21,0x1a,0x07,0x01,0x00] }]
];

/** Archive is intentionally lower priority than Office container viewers. */
export const ARCHIVE_VIEWER_DESCRIPTOR: ViewerDescriptor = {
    id: 'archive', displayNameKey: 'archive.title',
    extensions: ['zip', 'jar', 'apk', 'tar', 'tgz', 'tar.gz', 'tbz', 'tbz2', 'tar.bz2', 'txz', 'tar.xz', 'gz', 'bz2', 'xz', '7z', 'rar', 'dmg'],
    priority: 5, magicSignatures: ARCHIVE_MAGIC_SIGNATURES, requiredServices: [], optionalServices: ['save']
};

export const CORE_VIEWER_DESCRIPTORS: readonly ViewerDescriptor[] = [
    PDF_VIEWER_DESCRIPTOR,
    AUDIO_VIEWER_DESCRIPTOR,
    VIDEO_VIEWER_DESCRIPTOR,
    DBC_VIEWER_DESCRIPTOR,
    ARXML_VIEWER_DESCRIPTOR,
    A2L_VIEWER_DESCRIPTOR,
    ASC_VIEWER_DESCRIPTOR,
    BLF_VIEWER_DESCRIPTOR,
    MF4_VIEWER_DESCRIPTOR,
    PCAP_VIEWER_DESCRIPTOR,
    PCAPNG_VIEWER_DESCRIPTOR,
    MERMAID_VIEWER_DESCRIPTOR,
    PLANTUML_VIEWER_DESCRIPTOR,
    SHAPEFILE_VIEWER_DESCRIPTOR,
    PSD_VIEWER_DESCRIPTOR,
    PARQUET_VIEWER_DESCRIPTOR,
    AVRO_VIEWER_DESCRIPTOR,
    BAG_VIEWER_DESCRIPTOR,
    STP_VIEWER_DESCRIPTOR,
    DB3_VIEWER_DESCRIPTOR,
    REQIF_VIEWER_DESCRIPTOR,
    HDF5_VIEWER_DESCRIPTOR,
    MAT_VIEWER_DESCRIPTOR,
    SAFETENSORS_VIEWER_DESCRIPTOR,
    PPT_VIEWER_DESCRIPTOR,
    WORD_VIEWER_DESCRIPTOR,
    HWP_VIEWER_DESCRIPTOR,
    EXCEL_VIEWER_DESCRIPTOR,
    IMAGE_VIEWER_DESCRIPTOR,
    MARKDOWN_VIEWER_DESCRIPTOR,
    ARCHIVE_VIEWER_DESCRIPTOR,
    CSV_VIEWER_DESCRIPTOR,
    JSON_VIEWER_DESCRIPTOR,
    TOML_VIEWER_DESCRIPTOR,
    JSONL_VIEWER_DESCRIPTOR,
    YAML_VIEWER_DESCRIPTOR,
    PROTO_VIEWER_DESCRIPTOR,
    FALLBACK_VIEWER_DESCRIPTOR
];

export { looksLikeJsonDocument, looksLikeJsonl, looksLikeProto, sniffTextViewer } from './sniff.js';
export {
    CONTAINER_SNIFF_BYTES,
    OFFICE_CONTAINER_BY_EXT,
    OLE_MAGIC,
    ZIP_MAGIC,
    sniffContainer,
    type ContainerKind
} from './container.js';
export { probeContainer } from './probe.js';

export interface DetectionResult {
    /** The resolved viewer, or 'fallback' when unresolved. For
     *  'ambiguous-container' this is 'fallback' (the safe default if the caller
     *  does not run probeContainer). */
    viewerId: string;
    /** 'extension' for an extension match; 'content' for a text sniff (J17);
     *  'ambiguous-container' when the bytes are a zip/ole container the caller
     *  should refine with probeContainer; 'fallback' when nothing matched. */
    matchedBy: 'extension' | 'content' | 'ambiguous-container' | 'fallback';
    /** Present only when matchedBy === 'ambiguous-container'. */
    container?: ContainerKind;
}

/**
 * Detection (DESIGN.md §7): ASCII-lowercased extension matching with priority
 * tie-breaking (stage 1). When no extension matches and a text sample is
 * provided, content sniffing (J17, 부록 B-6) classifies signature-less text
 * formats — the extension is always trusted first (§7 point 3).
 *
 * Container-format viewers (excel; later word/ppt/hwpx) share zip/ole
 * signatures, so stage-1 verifies a trusted office extension against the actual
 * bytes: a match confirms it, a contradicting container (or a container with no
 * matching extension) returns 'ambiguous-container' for the caller to resolve
 * with probeContainer (stage 2, docs/viewers/excel.md §5). Services the host
 * cannot provide exclude a viewer whose requiredServices demand them.
 */
export function detectViewer(
    fileName: string,
    availableServices: ReadonlySet<ServiceId> = new Set(),
    descriptors: readonly ViewerDescriptor[] = CORE_VIEWER_DESCRIPTORS,
    sniffBytes?: Uint8Array,
    sniffText?: string
): DetectionResult {
    const lower = asciiLower(fileName);
    const magicMatches = (d: ViewerDescriptor): boolean => {
        // No sniff bytes → trust the extension (offline-friendly, stage-1).
        if (!sniffBytes) return true;
        if (d.magicPrefix) {
            if (sniffBytes.byteLength < d.magicPrefix.length) return false;
            if (!d.magicPrefix.every((byte, i) => sniffBytes[i] === byte)) return false;
        }
        if (d.magicSignatures) {
            const runMatches = (run: MagicByteRun): boolean =>
                sniffBytes.byteLength >= run.offset + run.bytes.length &&
                run.bytes.every((byte, i) => sniffBytes[run.offset + i] === byte);
            if (!d.magicSignatures.some((sig) => sig.every(runMatches))) return false;
        }
        return true;
    };
    const servicesMet = (d: ViewerDescriptor): boolean =>
        d.requiredServices.every((s) => availableServices.has(s));

    const container = sniffBytes ? sniffContainer(sniffBytes) : null;

    const candidates = descriptors
        .map((d) => ({ d, ext: d.extensions.find((ext) => lower.endsWith(`.${ext}`)) }))
        .filter((c): c is { d: ViewerDescriptor; ext: string } => c.ext !== undefined)
        .filter((c) => servicesMet(c.d))
        // DMG has a tail signature, checked by its decoder; it cannot be
        // represented by leading-byte magic matching.
        .filter((c) => c.d.id === 'archive' ? archiveMagicMatches(c.ext, sniffBytes) : magicMatches(c.d))
        .sort((a, b) => b.d.priority - a.d.priority);

    const winner = candidates[0];
    if (winner) {
        const expected = OFFICE_CONTAINER_BY_EXT[winner.ext];
        // A trusted office extension whose bytes are a *different* container is
        // a contradiction (§7-3) — hand off to stage-2 probing. Non-container
        // or unreadable bytes fall back to trusting the extension (offline-
        // friendly; the parser reports invalid-format if it truly isn't one).
        if (expected && container && container !== expected) {
            return { viewerId: 'fallback', matchedBy: 'ambiguous-container', container };
        }
        return { viewerId: winner.d.id, matchedBy: 'extension' };
    }

    // No extension match. Container bytes are ambiguous → probe decides.
    if (container) {
        return { viewerId: 'fallback', matchedBy: 'ambiguous-container', container };
    }
    if (sniffBytes && HDF5_MAGIC_PREFIX.every((byte, index) => sniffBytes[index] === byte)) {
        const hdf5 = descriptors.find(d => d.id === 'hdf5');
        if (hdf5 && servicesMet(hdf5)) return { viewerId: 'hdf5', matchedBy: 'content' };
    }
    if (sniffBytes && looksLikeClassicMat(sniffBytes)) {
        const mat = descriptors.find(d => d.id === 'mat');
        if (mat && servicesMet(mat)) return { viewerId: 'mat', matchedBy: 'content' };
    }
    if (sniffBytes) {
        const unambiguous = descriptors.find(d =>
            ['avro', 'bag', 'stp', 'db3', 'blf', 'mf4', 'pcap', 'pcapng', 'shapefile', 'psd'].includes(d.id) && servicesMet(d) && magicMatches(d)
        );
        if (unambiguous) return { viewerId: unambiguous.id, matchedBy: 'content' };
    }
    // Non-ZIP archive formats have unambiguous leading magic. ZIP stays on the
    // container-probe path above so Office/HWPX gets first refusal.
    if (sniffBytes && !ARCHIVE_VIEWER_DESCRIPTOR.extensions.some(ext => lower.endsWith(`.${ext}`)) && ARCHIVE_MAGIC_SIGNATURES.slice(2).some(sig => sig.every(run => run.bytes.every((b, i) => sniffBytes[run.offset + i] === b)))) {
        const archive = descriptors.find(d => d.id === 'archive');
        if (archive && servicesMet(archive)) return { viewerId: 'archive', matchedBy: 'content' };
    }

    // Stage 2 (text content sniffing) — only when the extension gave no match.
    if (sniffText !== undefined) {
        const sniffedId = sniffTextViewer(sniffText);
        if (sniffedId) {
            const d = descriptors.find((x) => x.id === sniffedId);
            if (d && servicesMet(d)) return { viewerId: d.id, matchedBy: 'content' };
        }
    }

    return { viewerId: 'fallback', matchedBy: 'fallback' };
}

function looksLikeClassicMat(bytes: Uint8Array): boolean {
    if (bytes.length < 19) return false;
    let header = '';
    for (let i = 0; i < Math.min(bytes.length, 116); i++) header += String.fromCharCode(bytes[i]!);
    return /^MATLAB\s+(?:5\.0|7\.)\s+MAT-file/i.test(header);
}

function archiveMagicMatches(ext: string, bytes: Uint8Array | undefined): boolean {
    if (!bytes) return true;
    const starts = (...magic: number[]): boolean => magic.every((x, i) => bytes[i] === x);
    const zip = starts(0x50,0x4b,0x03,0x04) || starts(0x50,0x4b,0x05,0x06);
    const tar = bytes.length >= 262 && [0x75,0x73,0x74,0x61,0x72].every((x,i)=>bytes[257+i]===x);
    const gzip=starts(0x1f,0x8b), bzip=starts(0x42,0x5a,0x68), xz=starts(0xfd,0x37,0x7a,0x58,0x5a,0x00), seven=starts(0x37,0x7a,0xbc,0xaf,0x27,0x1c), rar=starts(0x52,0x61,0x72,0x21,0x1a,0x07);
    // DMG has no leading magic. A standard sniff contains only the head of
    // the file, so the registry must trust its extension; parseArchive owns
    // validation of the `koly` signature in the final 512-byte trailer.
    if (ext === 'dmg') return true;
    if (['zip','jar','apk'].includes(ext)) return zip; if (ext==='tar') return tar; if (['tgz','tar.gz','gz'].includes(ext)) return gzip; if(['tbz','tbz2','tar.bz2','bz2'].includes(ext))return bzip; if(['txz','tar.xz','xz'].includes(ext))return xz; if(ext==='7z')return seven; if(ext==='rar')return rar; return false;
}
