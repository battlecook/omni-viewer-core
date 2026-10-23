// EPUB (OCF container + OPF package) contract parser (DESIGN.md §3-①).
//
// `parseEpub` reads only the package files — `META-INF/container.xml`, the
// package (OPF) document, the navigation document or NCX, and
// `META-INF/encryption.xml` — and returns the book's metadata, manifest,
// reading order (spine) and table of contents. Chapter bodies and images stay
// compressed until the viewer asks for them through `openEpubArchive`, so a
// large illustrated book costs only its package files to open.
//
// EPUB 2.0.1 and EPUB 3.x are both read: EPUB 2 metadata attributes
// (`opf:role`, `opf:file-as`, `opf:scheme`, `opf:event`) and EPUB 3 `refines`
// metadata map onto the same model, and the table of contents comes from the
// EPUB 3 navigation document when it has entries, else from the NCX. Input-
// caused failures are `status: 'failed'`, never thrown.

import { asciiLower } from '../csv/index.js';
import {
    DEFAULT_LIMITS,
    LimitTracker,
    type Diagnostic,
    type ParseOptions,
    type ParseOutcome,
    type ParseResult
} from '../types.js';
import type {
    EpubContentKind,
    EpubContributor,
    EpubDocument,
    EpubIdentifier,
    EpubManifestItem,
    EpubMetadata,
    EpubMetadataEntry,
    EpubSpineItem,
    EpubTocEntry,
    EpubTocSource
} from './model.js';
import {
    attribute,
    childElements,
    collapseWhitespace,
    findElements,
    firstChild,
    decodeXmlEntities,
    readXml,
    textContent,
    type XmlElement
} from './xml.js';
import {
    EpubReadError,
    hasPlatformInflate,
    memberPayload,
    platformInflate,
    readZipDirectory,
    type EpubInflate,
    type EpubReadErrorCode,
    type EpubZipEntry
} from './zip.js';

export type * from './model.js';
export { EpubReadError, type EpubInflate, type EpubReadErrorCode, type EpubZipEntry } from './zip.js';

/** The parser and the viewer only read the caller's bytes; they never detach them. */
export const EPUB_INPUT_OWNERSHIP = 'borrows' as const;
/** Cap on manifest items, spine items, and table-of-contents entries (each). */
export const EPUB_DEFAULT_MAX_ITEMS = 10_000;
/** ZIP members admitted from the central directory. */
export const EPUB_DEFAULT_MAX_ZIP_ENTRIES = 65_535;
/** Largest package file (OPF, NCX, navigation document, container/encryption XML). */
export const EPUB_MAX_PACKAGE_FILE_BYTES = 8 * 1024 * 1024;
/** Default cap on one chapter or image read on demand. */
export const EPUB_DEFAULT_MAX_RESOURCE_BYTES = 64 * 1024 * 1024;
/**
 * Default cap on one chapter's markup. Parsing, sanitizing and laying out
 * markup is far costlier per byte than showing an image, so chapters get a
 * smaller cap than other resources (real chapters are rarely over 2 MiB).
 */
export const EPUB_DEFAULT_MAX_CHAPTER_BYTES = 8 * 1024 * 1024;
/** Default cumulative inflate budget for one opened archive. */
export const EPUB_DEFAULT_MAX_DECOMPRESSED_BYTES = 1024 * 1024 * 1024;
/** Table-of-contents nesting kept (deeper levels are flattened into their parent). */
export const EPUB_MAX_TOC_DEPTH = 16;

const XML_LIMITS = { maxNodes: 400_000, maxDepth: 256 };
const MAX_FALLBACK_HOPS = 8;
const MAX_LABEL_CHARS = 500;
const MAX_DESCRIPTION_CHARS = 20_000;

/** EPUB's required first member. */
export const EPUB_MIMETYPE = 'application/epub+zip';

/** Font-obfuscation algorithms (IDPF, Adobe): the font is mangled, not the text. */
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

export interface EpubParseOptions extends ParseOptions {
    /** Raw-deflate inflater for hosts without `DecompressionStream`. */
    inflate?: EpubInflate;
    /** Overrides EPUB_DEFAULT_MAX_ITEMS. */
    maxItems?: number;
}

// ─── Archive access ───────────────────────────────────────────────────────

export interface EpubArchiveOptions {
    inflate?: EpubInflate;
    /** Cumulative inflate budget (default EPUB_DEFAULT_MAX_DECOMPRESSED_BYTES). */
    maxDecompressedBytes?: number;
    maxEntries?: number;
}

/**
 * On-demand member reader over the container bytes. Reads are capped per call
 * and against a cumulative budget; member lookups fall back to an ASCII
 * case-insensitive match because hand-built books often disagree with their
 * own manifest about case.
 */
export class EpubArchive {
    private readonly byName = new Map<string, EpubZipEntry>();
    private readonly byLowerName = new Map<string, EpubZipEntry>();
    private readonly inflate: EpubInflate | undefined;
    private readonly budget: number;
    private inflated = 0;
    /** Members already charged against the budget; re-reading one costs nothing more. */
    private readonly charged = new Set<string>();
    /** Members whose reservation is backed by a completed inflation. */
    private readonly settled = new Set<string>();
    /** In-flight reads per member that rely on its reservation. */
    private readonly holders = new Map<string, number>();
    /** Inflations in progress, shared by concurrent readers of the same member. */
    private readonly inflight = new Map<string, { signal: AbortSignal | undefined; promise: Promise<Uint8Array> }>();

    constructor(
        private readonly data: Uint8Array,
        readonly entries: readonly EpubZipEntry[],
        readonly truncated: boolean,
        options: EpubArchiveOptions = {}
    ) {
        for (const entry of entries) {
            if (!this.byName.has(entry.name)) this.byName.set(entry.name, entry);
            const lower = asciiLower(entry.name);
            if (!this.byLowerName.has(lower)) this.byLowerName.set(lower, entry);
        }
        this.inflate = options.inflate ?? (hasPlatformInflate() ? platformInflate : undefined);
        this.budget = options.maxDecompressedBytes ?? EPUB_DEFAULT_MAX_DECOMPRESSED_BYTES;
    }

    /** Bytes inflated so far against the cumulative budget. */
    get decompressedBytes(): number {
        return this.inflated;
    }

    find(path: string): EpubZipEntry | undefined {
        return this.byName.get(path) ?? this.byLowerName.get(asciiLower(path));
    }

    has(path: string): boolean {
        return this.find(path) !== undefined;
    }

    /** Member bytes. Throws EpubReadError (never anything else) when it cannot be read. */
    async read(path: string, maxBytes: number = EPUB_DEFAULT_MAX_RESOURCE_BYTES, signal?: AbortSignal): Promise<Uint8Array> {
        if (signal?.aborted) throw new EpubReadError('aborted', path);
        const entry = this.find(path);
        if (!entry) throw new EpubReadError('missing', path);
        if (entry.encrypted) throw new EpubReadError('encrypted', path);
        if (entry.uncompressedSize > maxBytes) throw new EpubReadError('too-large', path);
        const payload = memberPayload(this.data, entry);
        if (!payload) throw new EpubReadError('corrupted', path);
        if (entry.method === 0) {
            return payload.byteLength > entry.uncompressedSize ? payload.subarray(0, entry.uncompressedSize) : payload;
        }
        if (entry.method !== 8) throw new EpubReadError('unsupported-method', path);
        const inflate = this.inflate;
        if (!inflate) throw new EpubReadError('inflate-unavailable', path);
        // Shared only between callers with the same signal: aborting one reader
        // (a chapter that was left) must not fail another (the cover) mid-read.
        const pending = this.inflight.get(entry.name);
        if (pending && pending.signal === signal) return pending.promise;
        // The budget bounds distinct inflated content (the zip-bomb case), not a
        // reader paging back and forth through members already accepted. The
        // declared size is reserved before the first await, so reads started
        // together (a chapter's images) cannot all pass the check at once.
        if (!this.charged.has(entry.name)) {
            if (this.inflated + entry.uncompressedSize > this.budget) throw new EpubReadError('budget-exceeded', path);
            this.charged.add(entry.name);
            this.inflated += entry.uncompressedSize;
        }
        // Every in-flight read of a member leans on its one reservation; it is
        // released only when the last of them fails and none ever succeeded,
        // so an aborted reader cannot free a charge a concurrent read still uses.
        this.holders.set(entry.name, (this.holders.get(entry.name) ?? 0) + 1);
        const run = (async (): Promise<Uint8Array> => {
            let succeeded = false;
            try {
                // The declared size is the cap: a member that inflates past its own
                // directory record is lying about its size, and is rejected as corrupt.
                const bytes = await inflate(payload, entry.uncompressedSize, signal);
                succeeded = true;
                this.settled.add(entry.name);
                return bytes;
            } catch (error) {
                const code: EpubReadErrorCode = error instanceof EpubReadError
                    ? (error.code === 'too-large' ? 'corrupted' : error.code)
                    : 'corrupted';
                throw new EpubReadError(signal?.aborted ? 'aborted' : code, path);
            } finally {
                const left = (this.holders.get(entry.name) ?? 1) - 1;
                if (left > 0) this.holders.set(entry.name, left);
                else this.holders.delete(entry.name);
                if (!succeeded && left === 0 && !this.settled.has(entry.name) && this.charged.delete(entry.name)) {
                    this.inflated -= entry.uncompressedSize;
                }
            }
        })();
        const record = { signal, promise: run };
        this.inflight.set(entry.name, record);
        // Cleanup is attached after registration so even an inflater that fails
        // synchronously cannot leave a settled promise behind in the map.
        void run.catch(() => undefined).finally(() => {
            if (this.inflight.get(entry.name) === record) this.inflight.delete(entry.name);
        });
        return run;
    }

    /** Member decoded as XML/XHTML text (BOM, UTF-16, Latin-1 and CP1252 aware). */
    async readText(path: string, maxBytes?: number, signal?: AbortSignal): Promise<DecodedText> {
        return decodeMarkupText(await this.read(path, maxBytes, signal));
    }
}

/** Opens the container's ZIP directory; null when the bytes are not a readable ZIP. */
export function openEpubArchive(data: Uint8Array, options: EpubArchiveOptions = {}): EpubArchive | null {
    const directory = readZipDirectory(data, options.maxEntries ?? EPUB_DEFAULT_MAX_ZIP_ENTRIES);
    if (!directory) return null;
    return new EpubArchive(data, directory.entries, directory.truncated, options);
}

// ─── Text decoding ────────────────────────────────────────────────────────

export interface DecodedText {
    text: string;
    /** Encoding actually used. */
    encoding: string;
    /** The declared encoding was not one the core decodes; UTF-8 was used instead. */
    unsupportedEncoding: string;
}

/** Windows-1252 0x80–0x9F (undefined positions map to U+FFFD). */
const CP1252_HIGH = [
    0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0xfffd, 0x017d, 0xfffd,
    0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178
];

/**
 * Decodes an XML/XHTML member. Unicode encodings follow the BOM or the XML
 * declaration; ASCII, ISO-8859-1 and Windows-1252 labels — the legacy encodings
 * older EPUB 2 writers still declare — are decoded as windows-1252 (as browsers
 * do) from a bundled table, because
 * `TextDecoder` support for legacy labels varies by engine (ADR 41). Anything
 * else is read as UTF-8 and reported.
 */
export function decodeMarkupText(bytes: Uint8Array): DecodedText {
    const decode = (label: 'utf-8' | 'utf-16le' | 'utf-16be', from = 0): string => {
        if (label !== 'utf-16be') return new TextDecoder(label, { fatal: false }).decode(bytes.subarray(from));
        // Builds without full ICU lack the 'utf-16be' label (ADR 41); swap to LE instead.
        const swapped = new Uint8Array((bytes.length - from) & ~1);
        for (let i = 0; i < swapped.length; i += 2) {
            swapped[i] = bytes[from + i + 1]!;
            swapped[i + 1] = bytes[from + i]!;
        }
        return new TextDecoder('utf-16le', { fatal: false }).decode(swapped);
    };
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: decode('utf-8', 3), encoding: 'utf-8', unsupportedEncoding: '' };
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: decode('utf-16be', 2), encoding: 'utf-16be', unsupportedEncoding: '' };
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: decode('utf-16le', 2), encoding: 'utf-16le', unsupportedEncoding: '' };
    // UTF-16 without a BOM still starts with '<' as a 16-bit unit.
    if (bytes[0] === 0x00 && bytes[1] === 0x3c) return { text: decode('utf-16be'), encoding: 'utf-16be', unsupportedEncoding: '' };
    if (bytes[0] === 0x3c && bytes[1] === 0x00) return { text: decode('utf-16le'), encoding: 'utf-16le', unsupportedEncoding: '' };

    let head = '';
    // 1024 bytes, as HTML's encoding prescan reads; a label counts only when a
    // delimiter follows it, so one cut off at the window edge is not taken.
    for (let i = 0; i < Math.min(bytes.length, 1024); i++) head += String.fromCharCode(bytes[i]!);
    const declared = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/.exec(head)?.[1]
        ?? /<meta[^>]+charset\s*=\s*["']?([A-Za-z0-9._:-]+)(?=["'\s;/>])/i.exec(head)?.[1]
        ?? '';
    const label = asciiLower(declared);
    if (label === '' || label === 'utf-8' || label === 'utf8') {
        return { text: decode('utf-8'), encoding: 'utf-8', unsupportedEncoding: '' };
    }
    // The WHATWG Encoding Standard, which browsers' XML parsers follow, maps
    // ASCII and Latin-1 labels to windows-1252 as well; books relying on that
    // (cp1252 smart quotes under an iso-8859-1 declaration) read the same here.
    if (['iso-8859-1', 'latin1', 'iso_8859-1', 'l1', 'us-ascii', 'ascii', 'windows-1252', 'cp1252'].includes(label)) {
        // Map into code units first and join in chunks: appending one character
        // per byte builds a rope per byte (seconds and gigabytes for a large chapter).
        const units = new Uint16Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) {
            const byte = bytes[i]!;
            units[i] = byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80]! : byte;
        }
        const parts: string[] = [];
        for (let at = 0; at < units.length; at += 16_384) {
            parts.push(String.fromCharCode.apply(null, units.subarray(at, at + 16_384) as unknown as number[]));
        }
        return { text: parts.join(''), encoding: 'windows-1252', unsupportedEncoding: '' };
    }
    if (label === 'utf-16' || label === 'utf-16le' || label === 'utf-16be') {
        // A UTF-16 declaration is only readable as ASCII if the bytes are not
        // UTF-16 after all; treat it as the writer's mistake.
        return { text: decode('utf-8'), encoding: 'utf-8', unsupportedEncoding: '' };
    }
    return { text: decode('utf-8'), encoding: 'utf-8', unsupportedEncoding: declared };
}

// ─── Paths ────────────────────────────────────────────────────────────────

/** True for an href with a URL scheme (`https:`, `mailto:`, `data:` …). */
export function isExternalHref(href: string): boolean {
    return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(href.trim());
}

/**
 * Resolves an href written inside `baseFile` to a container path plus
 * fragment. Returns null for external URLs and for paths that climb out of the
 * container. An empty path part refers to `baseFile` itself.
 */
export function resolveEpubHref(baseFile: string, href: string): { path: string; fragment: string } | null {
    const trimmed = href.trim();
    if (isExternalHref(trimmed)) return null;
    const hash = trimmed.indexOf('#');
    const fragment = hash < 0 ? '' : safeDecode(trimmed.slice(hash + 1));
    let pathPart = hash < 0 ? trimmed : trimmed.slice(0, hash);
    const query = pathPart.indexOf('?');
    if (query >= 0) pathPart = pathPart.slice(0, query);
    if (pathPart === '') return { path: baseFile, fragment };

    const segments = pathPart.startsWith('/')
        ? []
        : baseFile.split('/').slice(0, -1);
    for (const raw of pathPart.split('/')) {
        const segment = safeDecode(raw);
        if (segment === '' || segment === '.') continue;
        if (segment === '..') {
            if (segments.length === 0) return null;
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    if (segments.length === 0) return null;
    return { path: segments.join('/'), fragment };
}

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

// ─── Parser ───────────────────────────────────────────────────────────────

const CONTENT_KINDS: Readonly<Record<string, EpubContentKind>> = {
    'application/xhtml+xml': 'xhtml',
    'text/html': 'html',
    // Deprecated but still an OPS Core Media Type in EPUB 2.0.1 (§1.3.7); OEB 1.x tag soup.
    'text/x-oeb1-document': 'html',
    'image/svg+xml': 'svg'
};

function splitTokens(value: string | undefined): string[] {
    return (value ?? '').split(/[ \t\r\n]+/).filter(Boolean);
}

export async function parseEpub(input: Uint8Array, options: EpubParseOptions = {}): Promise<ParseOutcome<EpubDocument>> {
    const started = Date.now();
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    const maxItems = options.maxItems ?? options.limits?.maxEntries ?? EPUB_DEFAULT_MAX_ITEMS;
    const diagnostics: Diagnostic[] = [];
    const finish = (result: ParseResult<EpubDocument>): ParseOutcome<EpubDocument> => ({
        result,
        execution: { workerUsed: false, hardLimitEnforced: false, elapsedMillis: Date.now() - started }
    });
    const fail = (
        code: 'invalid-format' | 'corrupted' | 'password-required' | 'limit-exceeded' | 'aborted' | 'missing-dependency',
        messageKey: string,
        args?: Record<string, string | number>
    ): ParseOutcome<EpubDocument> =>
        finish({
            status: 'failed',
            failure: { code, retryable: code === 'aborted', messageKey, ...(args ? { args } : {}) },
            diagnostics
        });
    const warn = (code: string, args?: Record<string, string | number>, location?: string, severity: Diagnostic['severity'] = 'warning'): void => {
        diagnostics.push({
            severity,
            code,
            messageKey: `diag.epub.${code}`,
            ...(args ? { args } : {}),
            ...(location ? { location } : {})
        });
    };

    if (input.byteLength > limits.maxInputBytes) {
        return fail('limit-exceeded', 'diag.limit-exceeded.input', { maxBytes: limits.maxInputBytes });
    }
    const tracker = new LimitTracker(limits, options.signal);
    if (options.signal?.aborted) return fail('aborted', 'diag.aborted');

    const archive = openEpubArchive(input, {
        ...(options.inflate ? { inflate: options.inflate } : {}),
        maxDecompressedBytes: options.limits?.maxDecompressedBytes ?? EPUB_DEFAULT_MAX_DECOMPRESSED_BYTES
    });
    if (!archive) return fail('invalid-format', 'diag.epub.not-zip');
    let partial = false;
    if (archive.truncated) {
        partial = true;
        warn('zip-entry-limit', { limit: EPUB_DEFAULT_MAX_ZIP_ENTRIES });
    }

    // A read failure on a package file is either fatal for the whole parse
    // (abort, missing inflater, budget) or a per-file problem the caller decides.
    type Read = { ok: true; text: string } | { ok: false; code: EpubReadErrorCode };
    const readPackageFile = async (path: string): Promise<Read> => {
        try {
            const decoded = await archive.readText(path, EPUB_MAX_PACKAGE_FILE_BYTES, options.signal);
            if (decoded.unsupportedEncoding) warn('encoding', { encoding: decoded.unsupportedEncoding }, path);
            return { ok: true, text: decoded.text };
        } catch (error) {
            return { ok: false, code: error instanceof EpubReadError ? error.code : 'corrupted' };
        }
    };
    const fatalRead = (code: EpubReadErrorCode): ParseOutcome<EpubDocument> | null => {
        if (code === 'aborted') return fail('aborted', 'diag.aborted');
        if (code === 'inflate-unavailable') return fail('missing-dependency', 'diag.epub.inflate-unavailable');
        if (code === 'budget-exceeded') return fail('limit-exceeded', 'diag.epub.decompressed-limit');
        return null;
    };
    const parseXmlFile = (text: string, path: string): XmlElement | null => {
        const xml = readXml(text, XML_LIMITS);
        if (xml.truncated) {
            partial = true;
            warn('xml-truncated', undefined, path);
        }
        return xml.root;
    };

    // ── mimetype ──
    const mimetypeEntry = archive.find('mimetype');
    if (!mimetypeEntry) warn('mimetype-missing', undefined, undefined, 'info');
    else {
        const mimetype = await readPackageFile('mimetype');
        if (mimetype.ok && mimetype.text.trim() !== EPUB_MIMETYPE) {
            warn('mimetype-mismatch', { value: mimetype.text.trim().slice(0, 80) });
        } else if (!mimetype.ok) {
            const fatal = fatalRead(mimetype.code);
            if (fatal) return fatal;
        }
    }

    // ── container.xml → package document ──
    let packagePath = '';
    const container = await readPackageFile('META-INF/container.xml');
    if (container.ok) {
        const root = parseXmlFile(container.text, 'META-INF/container.xml');
        const rootfiles = root ? findElements(root, node => node.local === 'rootfile') : [];
        const packages = rootfiles.filter(node => {
            const type = attribute(node, 'media-type');
            return !type || type === 'application/oebps-package+xml';
        });
        const chosen = packages.find(node => archive.has(attribute(node, 'full-path') ?? '')) ?? packages[0];
        packagePath = (attribute(chosen ?? rootfiles[0] ?? emptyElement(), 'full-path') ?? '').replace(/^\/+/, '');
        if (packages.length > 1) warn('multiple-renditions', { count: packages.length }, undefined, 'info');
    } else {
        const fatal = fatalRead(container.code);
        if (fatal) return fatal;
    }
    if (!packagePath || !archive.has(packagePath)) {
        // Hand-zipped books sometimes lose or misname container.xml; a lone
        // package document is unambiguous enough to open anyway.
        const candidates = archive.entries.filter(entry => asciiLower(entry.name).endsWith('.opf'));
        if (candidates.length === 0) return fail('invalid-format', 'diag.epub.no-package');
        warn('container-missing', { path: candidates[0]!.name });
        packagePath = candidates[0]!.name;
    }
    packagePath = archive.find(packagePath)?.name ?? packagePath;

    const opf = await readPackageFile(packagePath);
    if (!opf.ok) {
        return fatalRead(opf.code) ?? fail(opf.code === 'too-large' ? 'limit-exceeded' : 'corrupted', 'diag.epub.package-unreadable');
    }
    const pkg = parseXmlFile(opf.text, packagePath);
    if (!pkg || pkg.local !== 'package') return fail('invalid-format', 'diag.epub.package-invalid');
    const version = attribute(pkg, 'version') ?? '';
    const metadataElement = firstChild(pkg, 'metadata')
        // EPUB 2 allows dc-metadata/x-metadata wrappers (OEB 1.2 heritage).
        ?? findElements(pkg, node => node.local === 'metadata')[0];
    const manifestElement = firstChild(pkg, 'manifest');
    const spineElement = firstChild(pkg, 'spine');
    if (!manifestElement || !spineElement) return fail('invalid-format', 'diag.epub.package-invalid');

    // ── encryption ──
    const encryptedPaths = new Set<string>();
    const encryptionEntry = archive.find('META-INF/encryption.xml');
    if (encryptionEntry) {
        const encryption = await readPackageFile(encryptionEntry.name);
        if (encryption.ok) {
            const root = parseXmlFile(encryption.text, encryptionEntry.name);
            for (const data of root ? findElements(root, node => node.local === 'EncryptedData') : []) {
                const method = findElements(data, node => node.local === 'EncryptionMethod')[0];
                const algorithm = method ? attribute(method, 'Algorithm') ?? '' : '';
                if (FONT_OBFUSCATION.has(algorithm)) continue;
                for (const reference of findElements(data, node => node.local === 'CipherReference')) {
                    const resolved = resolveEpubHref('', attribute(reference, 'URI') ?? '');
                    if (resolved) encryptedPaths.add(archive.find(resolved.path)?.name ?? resolved.path);
                }
            }
        } else {
            const fatal = fatalRead(encryption.code);
            if (fatal) return fatal;
        }
    }
    if (archive.has('META-INF/rights.xml')) warn('rights-file', undefined, undefined, 'info');

    // ── metadata ──
    const metadata = readMetadata(metadataElement, attribute(pkg, 'unique-identifier') ?? '');

    // ── manifest ──
    const manifest: EpubManifestItem[] = [];
    const manifestById = new Map<string, EpubManifestItem>();
    let missingManifest = 0;
    for (const node of childElements(manifestElement, 'item')) {
        if (manifest.length >= maxItems) {
            partial = true;
            warn('item-limit', { limit: maxItems }, 'manifest');
            break;
        }
        if (manifest.length % 256 === 0) {
            const violation = tracker.checkpoint();
            if (violation?.kind === 'aborted') return fail('aborted', 'diag.aborted');
            if (violation) {
                partial = true;
                warn('time-limit', undefined, 'manifest');
                break;
            }
        }
        const href = attribute(node, 'href') ?? '';
        const resolved = resolveEpubHref(packagePath, href);
        const entry = resolved ? archive.find(resolved.path) : undefined;
        const path = entry?.name ?? resolved?.path ?? '';
        const item: EpubManifestItem = {
            id: attribute(node, 'id') ?? '',
            href,
            path,
            mediaType: asciiLower((attribute(node, 'media-type') ?? '').trim()),
            properties: splitTokens(attribute(node, 'properties')),
            fallback: attribute(node, 'fallback') ?? '',
            size: entry ? entry.uncompressedSize : null,
            present: entry !== undefined,
            encrypted: (entry?.encrypted ?? false) || (path !== '' && encryptedPaths.has(path))
        };
        if (!item.present && resolved) missingManifest++;
        manifest.push(item);
        if (item.id && !manifestById.has(item.id)) manifestById.set(item.id, item);
    }
    if (missingManifest > 0) warn('manifest-missing', { count: missingManifest }, undefined, 'info');

    // ── spine ──
    const spine: EpubSpineItem[] = [];
    let encryptedSpine = 0;
    let unknownIdrefs = 0;
    let firstUnknownIdref = '';
    for (const node of childElements(spineElement, 'itemref')) {
        if (spine.length >= maxItems) {
            partial = true;
            warn('item-limit', { limit: maxItems }, 'spine');
            break;
        }
        const idref = attribute(node, 'idref') ?? '';
        const declared = manifestById.get(idref);
        if (!declared) {
            // Counted, not one diagnostic each: an OPF of 390k bogus itemrefs
            // must not become 390k rows in the info panel.
            partial = true;
            if (unknownIdrefs++ === 0) firstUnknownIdref = idref.slice(0, 120);
            continue;
        }
        // Follow the manifest fallback chain to a content document the viewer
        // can render (EPUB 3 allows foreign resources in the spine).
        let target = declared;
        const seen = new Set<string>([declared.id]);
        for (let hop = 0; !Object.hasOwn(CONTENT_KINDS, target.mediaType) && target.fallback && hop < MAX_FALLBACK_HOPS; hop++) {
            const next = manifestById.get(target.fallback);
            if (!next || seen.has(next.id)) break;
            seen.add(next.id);
            target = next;
        }
        const kind = Object.hasOwn(CONTENT_KINDS, target.mediaType) ? CONTENT_KINDS[target.mediaType]! : 'unsupported';
        if (kind === 'unsupported') warn('spine-unsupported', { mediaType: declared.mediaType || '?' }, declared.path || declared.href);
        else if (!target.present) {
            partial = true;
            warn('resource-missing', undefined, target.path || target.href);
        }
        if (target.encrypted) encryptedSpine++;
        spine.push({
            index: spine.length,
            idref,
            path: target.path,
            mediaType: target.mediaType,
            kind,
            linear: asciiLower(attribute(node, 'linear') ?? 'yes') !== 'no',
            properties: splitTokens(attribute(node, 'properties')),
            present: target.present,
            encrypted: target.encrypted,
            title: ''
        });
    }
    if (unknownIdrefs > 0) warn('spine-idref', { count: unknownIdrefs, idref: firstUnknownIdref });
    if (spine.length === 0) return fail('invalid-format', 'diag.epub.no-spine');
    if (encryptedSpine === spine.length) return fail('password-required', 'diag.epub.drm');
    if (encryptedSpine > 0) {
        partial = true;
        warn('encrypted', { count: encryptedSpine });
    }

    // ── table of contents ──
    const spineIndexByPath = new Map<string, number>();
    for (const item of spine) if (item.path && !spineIndexByPath.has(item.path)) spineIndexByPath.set(item.path, item.index);
    const tocBudget = { remaining: maxItems, hit: false };
    let toc: EpubTocEntry[] = [];
    let tocSource: EpubTocSource = 'none';
    let tocPath = '';

    const navItem = manifest.find(item => item.properties.includes('nav') && item.present);
    if (navItem) {
        const nav = await readPackageFile(navItem.path);
        if (nav.ok) {
            const root = parseXmlFile(nav.text, navItem.path);
            if (root) toc = readNavToc(root, navItem.path, archive, spineIndexByPath, tocBudget);
            if (toc.length > 0) {
                tocSource = 'nav';
                tocPath = navItem.path;
            }
        } else {
            const fatal = fatalRead(nav.code);
            if (fatal) return fatal;
            warn('toc-unreadable', undefined, navItem.path);
        }
    }
    if (toc.length === 0) {
        const tocId = attribute(spineElement, 'toc') ?? '';
        const ncxItem = (tocId ? manifestById.get(tocId) : undefined)
            ?? manifest.find(item => item.mediaType === 'application/x-dtbncx+xml');
        if (ncxItem?.present) {
            const ncx = await readPackageFile(ncxItem.path);
            if (ncx.ok) {
                const root = parseXmlFile(ncx.text, ncxItem.path);
                const navMap = root ? findElements(root, node => node.local === 'navMap')[0] : undefined;
                if (navMap) toc = readNcxPoints(navMap, ncxItem.path, archive, spineIndexByPath, tocBudget, 0);
                if (toc.length > 0) {
                    tocSource = 'ncx';
                    tocPath = ncxItem.path;
                }
            } else {
                const fatal = fatalRead(ncx.code);
                if (fatal) return fatal;
                warn('toc-unreadable', undefined, ncxItem.path);
            }
        }
    }
    if (tocBudget.hit) {
        partial = true;
        warn('item-limit', { limit: maxItems }, 'toc');
    }
    if (tocSource === 'none') warn('toc-missing', undefined, undefined, 'info');
    // A label that targets the whole document names it better than one that
    // targets a section inside it (a single-file book's first heading).
    const wholeTitle = new Map<string, string>();
    const sectionTitle = new Map<string, string>();
    const collectTitles = (entries: EpubTocEntry[]): void => {
        for (const entry of entries) {
            const target = entry.fragment ? sectionTitle : wholeTitle;
            if (entry.path && entry.label && !target.has(entry.path)) target.set(entry.path, entry.label);
            collectTitles(entry.children);
        }
    };
    collectTitles(toc);
    for (const item of spine) item.title = wholeTitle.get(item.path) ?? sectionTitle.get(item.path) ?? '';

    // ── cover, direction, layout ──
    let coverPath = manifest.find(item => item.properties.includes('cover-image') && item.present)?.path ?? '';
    if (!coverPath && metadataElement) {
        // EPUB 2: <meta name="cover" content="<manifest id>">; some writers put the href there.
        const coverMeta = metadataChildren(metadataElement).filter(node => node.local === 'meta').find(node => attribute(node, 'name') === 'cover');
        const content = coverMeta ? attribute(coverMeta, 'content') ?? '' : '';
        const byId = manifestById.get(content);
        const byHref = byId ? undefined : manifest.find(item => item.href === content);
        const candidate = byId ?? byHref;
        if (candidate?.present && candidate.mediaType.startsWith('image/')) coverPath = candidate.path;
    }
    const progression = asciiLower(attribute(spineElement, 'page-progression-direction') ?? '');
    const direction: EpubDocument['direction'] = progression === 'rtl' ? 'rtl' : progression === 'ltr' ? 'ltr' : 'default';
    const layoutMeta = metadataElement
        ? metadataChildren(metadataElement).find(node => node.local === 'meta' && attribute(node, 'property') === 'rendition:layout' && !attribute(node, 'refines'))
        : undefined;
    const layout: EpubDocument['layout'] = layoutMeta && collapseWhitespace(textContent(layoutMeta)) === 'pre-paginated' ? 'pre-paginated' : 'reflowable';
    if (layout === 'pre-paginated') warn('fixed-layout', undefined, undefined, 'info');

    const violation = tracker.checkpoint();
    if (violation?.kind === 'aborted') return fail('aborted', 'diag.aborted');
    if (violation) {
        partial = true;
        warn('time-limit');
    }

    const document: EpubDocument = {
        version,
        packagePath,
        metadata,
        manifest,
        spine,
        toc,
        tocSource,
        tocPath,
        coverPath,
        direction,
        layout,
        fileCount: archive.entries.length
    };
    return finish({ status: partial ? 'partial' : 'ok', document, diagnostics });
}

function emptyElement(): XmlElement {
    return { kind: 'element', name: '', local: '', attributes: {}, children: [] };
}

// ─── Metadata ─────────────────────────────────────────────────────────────

/** `<metadata>` children with `dc-metadata` / `x-metadata` wrappers (OEB 1.2 heritage) flattened. */
function metadataChildren(element: XmlElement): XmlElement[] {
    return childElements(element).flatMap(node =>
        node.local === 'dc-metadata' || node.local === 'x-metadata' ? childElements(node) : [node]);
}

function readMetadata(element: XmlElement | undefined, uniqueId: string): EpubMetadata {
    const metadata: EpubMetadata = {
        title: '', otherTitles: [], creators: [], contributors: [], languages: [], identifiers: [],
        publisher: '', date: '', modified: '', description: '', subjects: [], rights: '', source: '',
        series: '', seriesIndex: '', other: []
    };
    if (!element) return metadata;
    // `dc-metadata` / `x-metadata` wrappers (OEB 1.2 heritage) hold the same children.
    const nodes = metadataChildren(element);

    // id → property → first value: each lookup is O(1), so a long refines list
    // cannot make metadata reading O(entries × refinements).
    const refinements = new Map<string, Map<string, string>>();
    for (const node of nodes) {
        if (node.local !== 'meta') continue;
        const refines = attribute(node, 'refines');
        const property = attribute(node, 'property');
        if (!refines || !property || !refines.startsWith('#')) continue;
        const byProperty = refinements.get(refines.slice(1)) ?? new Map<string, string>();
        if (!byProperty.has(property)) byProperty.set(property, collapseWhitespace(textContent(node)));
        refinements.set(refines.slice(1), byProperty);
    }
    const refined = (node: XmlElement, property: string): string => {
        const id = attribute(node, 'id');
        return (id ? refinements.get(id)?.get(property) : undefined) ?? '';
    };
    const text = (node: XmlElement): string => collapseWhitespace(textContent(node));
    const person = (node: XmlElement): EpubContributor => ({
        name: text(node),
        role: attribute(node, 'role') || refined(node, 'role'),
        fileAs: attribute(node, 'file-as') || refined(node, 'file-as')
    });

    const titles: Array<{ value: string; type: string }> = [];
    const dates: Array<{ value: string; event: string }> = [];
    for (const node of nodes) {
        const prefix = node.name.includes(':') ? node.name.slice(0, node.name.indexOf(':')) : '';
        const isDc = prefix === 'dc' || (prefix === '' && node.local !== 'meta' && node.local !== 'link');
        if (isDc) {
            const value = text(node);
            // OEB 1.2 capitalizes Dublin Core names (`dc:Title`, `dc:Creator`).
            switch (asciiLower(node.local)) {
                case 'title': if (value) titles.push({ value, type: refined(node, 'title-type') }); break;
                case 'creator': if (value) metadata.creators.push(person(node)); break;
                case 'contributor': if (value) metadata.contributors.push(person(node)); break;
                case 'language': if (value) metadata.languages.push(value); break;
                case 'identifier':
                    if (value) {
                        metadata.identifiers.push({
                            value,
                            scheme: attribute(node, 'scheme') || refined(node, 'identifier-type') || inferScheme(value),
                            unique: uniqueId !== '' && attribute(node, 'id') === uniqueId
                        });
                    }
                    break;
                case 'publisher': if (value && !metadata.publisher) metadata.publisher = value; break;
                case 'date': if (value) dates.push({ value, event: asciiLower(attribute(node, 'event') ?? '') }); break;
                case 'description':
                    if (value && !metadata.description) metadata.description = stripMarkup(value).slice(0, MAX_DESCRIPTION_CHARS);
                    break;
                case 'subject': if (value) metadata.subjects.push(value); break;
                case 'rights': if (value && !metadata.rights) metadata.rights = value; break;
                case 'source': if (value && !metadata.source) metadata.source = value; break;
                default: break;
            }
            continue;
        }
        if (node.local !== 'meta' || attribute(node, 'refines')) continue;
        const property = attribute(node, 'property');
        if (property) {
            const value = text(node);
            if (!value) continue;
            if (property === 'dcterms:modified') metadata.modified = value;
            else if (property === 'belongs-to-collection' && !metadata.series) {
                metadata.series = value;
                metadata.seriesIndex = refined(node, 'group-position');
            } else if (property !== 'rendition:layout') metadata.other.push({ property, value });
            continue;
        }
        const name = attribute(node, 'name');
        const content = attribute(node, 'content');
        if (!name || content === undefined || name === 'cover') continue;
        if (name === 'calibre:series' && !metadata.series) metadata.series = content;
        else if (name === 'calibre:series_index' && !metadata.seriesIndex) metadata.seriesIndex = content;
        else metadata.other.push({ property: name, value: content });
    }

    const main = titles.find(entry => entry.type === 'main') ?? titles[0];
    metadata.title = main?.value ?? '';
    metadata.otherTitles = titles.filter(entry => entry !== main).map(entry => entry.value);
    // EPUB 2 may list several dated events; the publication date is the one a reader expects.
    metadata.date = (dates.find(entry => entry.event === 'publication') ?? dates.find(entry => entry.event === '') ?? dates[0])?.value ?? '';
    const resolvedUnique = metadata.identifiers.some(entry => entry.unique);
    if (!resolvedUnique && metadata.identifiers[0]) metadata.identifiers[0].unique = true;
    return metadata;
}

function inferScheme(value: string): string {
    const lower = asciiLower(value);
    if (lower.startsWith('urn:isbn:') || /^(97[89])?\d{9}[\dx]$/.test(lower.replace(/-/g, ''))) return 'ISBN';
    if (lower.startsWith('urn:uuid:')) return 'UUID';
    if (lower.startsWith('urn:doi:') || lower.startsWith('doi:')) return 'DOI';
    return '';
}

/** Descriptions often carry escaped XHTML; the model keeps plain text only. */
function stripMarkup(value: string): string {
    // Only real HTML counts — a closing tag or a void tag. Plain text with
    // angle brackets (`신작 <채식주의자>`, `x < 3 and y > 2`) is kept verbatim.
    // Every scanning class excludes `<`, so a failed match stops at the next tag
    // start instead of rescanning to the end (linear on hostile descriptions).
    if (!/<\/[A-Za-z][\w:-]*\s*>|<(?:br|hr|img)\b[^<>]*>/i.test(value)) return value;
    // The markup was escaped once inside the OPF, so its own entities are still
    // encoded (`&amp;amp;` → `&amp;` after the XML pass); decode them once more.
    return decodeXmlEntities(collapseWhitespace(value.replace(/<[^<>]*>/g, ' ')));
}

// ─── Table of contents ────────────────────────────────────────────────────

interface TocBudget {
    remaining: number;
    hit: boolean;
}

function tocEntry(
    label: string,
    href: string,
    baseFile: string,
    archive: EpubArchive,
    spineIndexByPath: ReadonlyMap<string, number>,
    hidden: boolean
): EpubTocEntry {
    const resolved = href ? resolveEpubHref(baseFile, href) : null;
    const path = resolved ? archive.find(resolved.path)?.name ?? resolved.path : '';
    return {
        label: label.slice(0, MAX_LABEL_CHARS),
        path,
        fragment: resolved?.fragment ?? '',
        spineIndex: path ? spineIndexByPath.get(path) ?? -1 : -1,
        hidden,
        children: []
    };
}

/** EPUB 3: `<nav epub:type="toc">` → `ol > li > (a | span) [ol]`. */
function readNavToc(
    root: XmlElement,
    navPath: string,
    archive: EpubArchive,
    spineIndexByPath: ReadonlyMap<string, number>,
    budget: TocBudget
): EpubTocEntry[] {
    const navs = findElements(root, node => node.local === 'nav');
    const tocNav = navs.find(node => splitTokens(attribute(node, 'type')).includes('toc'))
        ?? navs.find(node => attribute(node, 'role') === 'doc-toc')
        ?? navs[0];
    if (!tocNav) return [];
    const list = findElements(tocNav, node => node.local === 'ol' || node.local === 'ul')[0];
    if (!list) return [];

    const readList = (ol: XmlElement, depth: number, hidden: boolean): EpubTocEntry[] => {
        const out: EpubTocEntry[] = [];
        const listHidden = hidden || attribute(ol, 'hidden') !== undefined;
        for (const li of childElements(ol, 'li')) {
            if (budget.remaining <= 0) {
                budget.hit = true;
                break;
            }
            const itemHidden = listHidden || attribute(li, 'hidden') !== undefined;
            const isList = (node: XmlElement): boolean => node.local === 'ol' || node.local === 'ul';
            // The fallback looks for a wrapped label but never inside the nested list,
            // which would make a child's link the parent's.
            const head = childElements(li).find(node => node.local === 'a' || node.local === 'span')
                ?? childElements(li).filter(node => !isList(node))
                    .flatMap(node => findElements(node, child => child.local === 'a' || child.local === 'span'))[0];
            const nested = childElements(li).find(node => node.local === 'ol' || node.local === 'ul');
            const label = head ? navLabel(head) : '';
            if (!head && !nested) continue;
            budget.remaining--;
            const entry = tocEntry(label, head?.local === 'a' ? attribute(head, 'href') ?? '' : '', navPath, archive, spineIndexByPath, itemHidden);
            const children = nested ? readList(nested, depth + 1, itemHidden) : [];
            if (depth + 1 < EPUB_MAX_TOC_DEPTH) {
                entry.children = children;
                out.push(entry);
            } else {
                out.push(entry, ...children.map(child => ({ ...child, children: [] })));
            }
        }
        return out;
    };
    return readList(list, 0, false);
}

/** Visible label of a nav link: its text, else an image's alt, else its title. */
function navLabel(node: XmlElement): string {
    const text = collapseWhitespace(textContent(node));
    if (text) return text;
    const image = findElements(node, child => child.local === 'img')[0];
    return collapseWhitespace((image ? attribute(image, 'alt') : undefined) ?? attribute(node, 'title') ?? '');
}

/** EPUB 2: NCX `navMap > navPoint (navLabel/text, content@src) navPoint*`. */
function readNcxPoints(
    parent: XmlElement,
    ncxPath: string,
    archive: EpubArchive,
    spineIndexByPath: ReadonlyMap<string, number>,
    budget: TocBudget,
    depth: number
): EpubTocEntry[] {
    const out: EpubTocEntry[] = [];
    for (const point of childElements(parent, 'navPoint')) {
        if (budget.remaining <= 0) {
            budget.hit = true;
            break;
        }
        budget.remaining--;
        const labelNode = firstChild(point, 'navLabel');
        const textNode = labelNode ? firstChild(labelNode, 'text') : undefined;
        const label = collapseWhitespace(textNode ? textContent(textNode) : labelNode ? textContent(labelNode) : '');
        const content = firstChild(point, 'content');
        const entry = tocEntry(label, content ? attribute(content, 'src') ?? '' : '', ncxPath, archive, spineIndexByPath, false);
        const children = readNcxPoints(point, ncxPath, archive, spineIndexByPath, budget, depth + 1);
        if (depth + 1 < EPUB_MAX_TOC_DEPTH) {
            entry.children = children;
            out.push(entry);
        } else {
            out.push(entry, ...children.map(child => ({ ...child, children: [] })));
        }
    }
    return out;
}
