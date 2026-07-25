export interface ArchiveEntry {
    entryId: number;
    path: string;
    isDirectory: boolean;
    compressedSize?: number;
    uncompressedSize?: number;
    modifiedAt?: string | number | Date;
    mimeType?: string;
    encrypted?: boolean;
    /** Decoder-native compression method, for example `store`, `deflate`, or `lzma`. */
    compressionMethod?: string;
    /** Explicit compression state when the decoder exposes it. */
    compressed?: boolean;
    /** Optional integrity metadata retained for host UI and diagnostics. */
    crc32?: number;
}
/** `encrypted` describes archive-wide encryption. Entry-level encryption is
 * represented by {@link ArchiveEntry.encrypted}; adapters may provide both. */
export interface ArchiveDocument { entries: readonly ArchiveEntry[]; encrypted?: boolean; }
export interface ArchiveDecoderCapabilities {
    /** Extensions/formats this concrete adapter can open. */
    formats?: readonly string[];
    /** `password` means the adapter can retry encrypted content with a password. */
    encryption?: 'none' | 'detect' | 'password';
    /** True when opening does not require buffering the complete archive. */
    streaming?: boolean;
    /** True when entries include `compressionMethod` and/or `compressed`. */
    compressionMetadata?: boolean;
}
export interface ArchiveOpenOptions {
    signal?: AbortSignal;
    maxEntries?: number;
    maxDecompressedBytes?: number;
    /** Optional password supplied by a host-owned prompt. */
    password?: string;
}
export interface ArchiveExtractOptions {
    signal?: AbortSignal;
    /** Decoder must stop before allocating beyond this output size. */
    maxBytes: number;
    /** Optional password supplied by a host-owned prompt. */
    password?: string;
}
export interface OpenArchiveHandle { entries: readonly ArchiveEntry[]; encrypted?: boolean; extract(entryId: number, options: ArchiveExtractOptions): Promise<Uint8Array>; close(): void | Promise<void>; }
export interface ArchiveDecoder {
    readonly capabilities?: ArchiveDecoderCapabilities;
    openArchive(data: Uint8Array, options?: ArchiveOpenOptions): Promise<OpenArchiveHandle>;
}
/** Path/handle-based decoder that opens an archive without materializing the
 *  whole file in memory (e.g. an adapter wrapping the system `7z`/`tar`). Core
 *  drives listing and single-entry extraction lazily through the returned
 *  handle; it never receives the archive bytes. */
export interface ArchiveStreamDecoder {
    readonly capabilities?: ArchiveDecoderCapabilities;
    openArchive(options?: ArchiveOpenOptions): Promise<OpenArchiveHandle>;
}
/** Streams one archive entry to an adapter-chosen destination without loading
 *  the entry into memory. Core never sees the bytes — the adapter owns the
 *  destination picker and the pipe (e.g. `7z e -so entry | createWriteStream`).
 *  Resolves to the saved file name, or null when the user cancels. */
export interface ArchiveEntrySaver {
    saveEntry(entry: ArchiveEntry, options: { signal?: AbortSignal; password?: string }): Promise<string | null>;
}
