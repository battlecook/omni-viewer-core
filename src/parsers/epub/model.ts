// EPUB document model (contract parser, DESIGN.md §3-①). Everything here is
// derived from the container bytes alone, so the same file yields the same
// model on every platform. Chapter bodies and images are not part of the
// model — the viewer reads them on demand through `EpubArchive`.

export interface EpubContributor {
    name: string;
    /** MARC relator code (`aut`, `edt`, `trl`, `ill` …); empty when unstated. */
    role: string;
    /** Sort form (`Carroll, Lewis`); empty when unstated. */
    fileAs: string;
}

export interface EpubIdentifier {
    value: string;
    /** `ISBN`, `UUID`, `URI`, or the writer's `identifier-type`; empty when unstated. */
    scheme: string;
    /** This identifier is the package's `unique-identifier`. */
    unique: boolean;
}

export interface EpubMetadataEntry {
    property: string;
    value: string;
}

export interface EpubMetadata {
    /** Main title (EPUB 3 `title-type main`, else the first `dc:title`). */
    title: string;
    /** Every other `dc:title`, in document order. */
    otherTitles: string[];
    creators: EpubContributor[];
    contributors: EpubContributor[];
    languages: string[];
    identifiers: EpubIdentifier[];
    publisher: string;
    /** `dc:date` as written (publication event when EPUB 2 lists several). */
    date: string;
    /** `dcterms:modified` (EPUB 3) as written. */
    modified: string;
    /** Plain text: markup that writers embed in descriptions is stripped. */
    description: string;
    subjects: string[];
    rights: string;
    source: string;
    /** `belongs-to-collection` (EPUB 3) or `calibre:series`. */
    series: string;
    seriesIndex: string;
    /** Remaining non-refining `<meta property>` / `<meta name content>` pairs. */
    other: EpubMetadataEntry[];
}

export interface EpubManifestItem {
    id: string;
    /** `href` as written in the package document. */
    href: string;
    /** Container path the href resolves to; empty when it escapes the container or is remote. */
    path: string;
    mediaType: string;
    properties: string[];
    fallback: string;
    /** Uncompressed size from the ZIP directory; null when the member is absent. */
    size: number | null;
    present: boolean;
    /** Listed in `META-INF/encryption.xml` (font obfuscation excluded) or ZIP-encrypted. */
    encrypted: boolean;
}

export type EpubContentKind = 'xhtml' | 'html' | 'svg' | 'unsupported';

export interface EpubSpineItem {
    /** Position in the spine. */
    index: number;
    idref: string;
    /** Container path of the content document actually rendered (after fallbacks). */
    path: string;
    mediaType: string;
    kind: EpubContentKind;
    /** `linear="no"` items are reachable through links but skipped by next/previous. */
    linear: boolean;
    properties: string[];
    present: boolean;
    encrypted: boolean;
    /** First table-of-contents label that targets this document; empty when none. */
    title: string;
}

export interface EpubTocEntry {
    label: string;
    /** Target document; empty for a heading entry without a link. */
    path: string;
    fragment: string;
    /** Spine position of `path`; -1 when it is not in the spine. */
    spineIndex: number;
    /** Inside an `hidden` list of the navigation document. */
    hidden: boolean;
    children: EpubTocEntry[];
}

export type EpubTocSource = 'nav' | 'ncx' | 'none';

export interface EpubDocument {
    /** Package `version` attribute (`2.0`, `3.0`, `3.3` …). */
    version: string;
    /** Container path of the package (OPF) document. */
    packagePath: string;
    metadata: EpubMetadata;
    manifest: EpubManifestItem[];
    spine: EpubSpineItem[];
    toc: EpubTocEntry[];
    tocSource: EpubTocSource;
    /** Navigation document (EPUB 3) or NCX (EPUB 2) path the TOC came from. */
    tocPath: string;
    /** Cover image path; empty when the package names none. */
    coverPath: string;
    /** Spine `page-progression-direction`. */
    direction: 'ltr' | 'rtl' | 'default';
    layout: 'reflowable' | 'pre-paginated';
    /** ZIP members in the container. */
    fileCount: number;
}
