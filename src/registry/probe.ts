// Stage-2 container probe (DESIGN.md §7-3·ADR 16, docs/viewers/excel.md §5).
// Given bytes already known to be a zip/ole container (sniffContainer), look
// *inside* to decide which viewer holds it. Dependency-free and defensive —
// any structural anomaly returns null (→ fallback), never throws, so this can
// run before any heavy parser dependency is loaded.

import { readZipDirectory, memberPayload } from '../parsers/epub/zip.js';
import { parseCfb } from '../parsers/cfb.js';
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

function probeZip(input: Uint8Array, options: ParseOptions): string | null {
    const directory = readZipDirectory(input, options.limits?.maxEntries ?? DEFAULT_PROBE_ENTRY_CAP);
    if (!directory) return null;

    // A Keras 3 model is a zip of config.json + model.weights.h5; neither member
    // alone is distinctive, so the decision waits until the scan finishes.
    let hasContentTypes = false;
    let officeHint: string | null = null;
    let hasPt2Marker = false;
    let hasKerasConfig = false;
    let mainKmlCount = 0;
    let hasCanonicalKml = false;
    let hasKerasWeights = false;
    // A zipped .mlpackage bundle keeps its Manifest.json beside a Data tree
    // reserved to com.apple.CoreML, optionally under the bundle's own folder.
    let hasCoremlManifest = false;
    let hasCoremlData = false;

    for (const entry of directory.entries) {
        if (options.signal?.aborted) return null;
        const { name } = entry;

        // Office part prefixes alone can also occur in an archive's asset paths.
        if (name === '[Content_Types].xml') hasContentTypes = true;
        if (!officeHint) {
            if (name.startsWith('xl/')) officeHint = 'excel';
            else if (name.startsWith('word/')) officeHint = 'word';
            else if (name.startsWith('ppt/')) officeHint = 'ppt';
            else if (name.startsWith('Contents/') || name === 'content.hpf') officeHint = 'hwp';
        }
        // A PT2 package keeps its `archive_format` marker under the package
        // folder PyTorchFileWriter prefixes; the legacy torch.export.save
        // layout is flat and named by its program file.
        if (name === 'archive_format' || name.endsWith('/archive_format') ||
            name === 'serialized_exported_program.json' || name.endsWith('/serialized_exported_program.json')) hasPt2Marker = true;
        const rootName = name.replace(/^(?:\.\/)+/, '');
        if (/^[^/\\]+\.kml$/i.test(rootName)) {
            mainKmlCount++;
            if (rootName.toLowerCase() === 'doc.kml') hasCanonicalKml = true;
        }
        if (name === 'config.json') hasKerasConfig = true;
        if (name === 'model.weights.h5') hasKerasWeights = true;
        if (name === 'Manifest.json' || name.endsWith('/Manifest.json')) hasCoremlManifest = true;
        if (name.includes('Data/com.apple.CoreML/')) hasCoremlData = true;
        // ODF (.ods/.odt/.odp) — the stored `mimetype` member carries the type.
        if (name === 'mimetype' && entry.method === 0 && !entry.encrypted && entry.compressedSize <= 128) {
            const mimeBytes = memberPayload(input, entry);
            if (!mimeBytes) continue;
            const mimetype = new TextDecoder().decode(mimeBytes).trim();
            if (mimetype === 'application/hwp+zip') return 'hwp';
            // OCF (EPUB) uses the same stored-`mimetype` convention as ODF.
            if (mimetype === 'application/epub+zip') return 'epub';
            if (mimetype === 'application/vnd.oasis.opendocument.spreadsheet' ||
                mimetype === 'application/vnd.oasis.opendocument.spreadsheet-template') return 'excel';
            if (mimetype === 'application/vnd.oasis.opendocument.text' ||
                mimetype === 'application/vnd.oasis.opendocument.presentation') return 'opendocument';
        }
    }

    if (hasContentTypes && officeHint) return officeHint;
    if (hasCanonicalKml) return 'gps';
    if (hasCoremlManifest && hasCoremlData) return 'coreml';
    if (hasKerasConfig && hasKerasWeights) return 'keras';
    if (mainKmlCount === 1) return 'gps';
    if (hasPt2Marker) return 'pt2';
    return officeHint;
}

// ─── OLE / CFB (legacy Office) ──────────────────────────────────────────────
// Inspect only root streams and storages. Attachments and embedded Office
// objects cannot identify the format of their enclosing compound file.

function probeOle(input: Uint8Array, options: ParseOptions): string | null {
    const cap = options.limits?.maxEntries ?? DEFAULT_PROBE_ENTRY_CAP;
    try {
        const cfb = parseCfb(input, cap);
        if (!cfb.root) return null;
        const { entries } = cfb.children(cfb.root, cap);
        const streams = new Set(entries.filter(entry => entry.type === 2).map(entry => entry.name.toLowerCase()));
        if (streams.has('workbook') || streams.has('book')) return 'excel';
        if (streams.has('worddocument')) return 'word';
        if (streams.has('powerpoint document')) return 'ppt';
        if (streams.has('fileheader') && entries.some(entry => entry.type === 1 && entry.name.toLowerCase() === 'bodytext')) return 'hwp';
        if (streams.has('__properties_version1.0') &&
            (streams.has('__substg1.0_001a001e') || streams.has('__substg1.0_001a001f'))) return 'msg';
    } catch {
        // Corrupt or unsupported compound files fall through to generic preview.
    }
    return null;
}
