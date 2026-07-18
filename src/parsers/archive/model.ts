export interface ArchiveEntry { entryId: number; path: string; isDirectory: boolean; compressedSize?: number; uncompressedSize?: number; modifiedAt?: string | number | Date; mimeType?: string; encrypted?: boolean; }
export interface ArchiveDocument { entries: readonly ArchiveEntry[]; }
export interface ArchiveExtractOptions { signal?: AbortSignal; /** Decoder must stop before allocating beyond this output size. */ maxBytes: number; }
export interface OpenArchiveHandle { entries: readonly ArchiveEntry[]; extract(entryId: number, options: ArchiveExtractOptions): Promise<Uint8Array>; close(): void | Promise<void>; }
export interface ArchiveDecoder { openArchive(data: Uint8Array, options?: { signal?: AbortSignal; maxEntries?: number; maxDecompressedBytes?: number }): Promise<OpenArchiveHandle>; }
/** Path/handle-based decoder that opens an archive without materializing the
 *  whole file in memory (e.g. an adapter wrapping the system `7z`/`tar`). Core
 *  drives listing and single-entry extraction lazily through the returned
 *  handle; it never receives the archive bytes. */
export interface ArchiveStreamDecoder { openArchive(options?: { signal?: AbortSignal; maxEntries?: number; maxDecompressedBytes?: number }): Promise<OpenArchiveHandle>; }
/** Streams one archive entry to an adapter-chosen destination without loading
 *  the entry into memory. Core never sees the bytes — the adapter owns the
 *  destination picker and the pipe (e.g. `7z e -so entry | createWriteStream`).
 *  Resolves to the saved file name, or null when the user cancels. */
export interface ArchiveEntrySaver { saveEntry(entry: ArchiveEntry, options: { signal?: AbortSignal }): Promise<string | null>; }
