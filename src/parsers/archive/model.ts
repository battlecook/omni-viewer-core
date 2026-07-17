export interface ArchiveEntry { entryId: number; path: string; isDirectory: boolean; compressedSize?: number; uncompressedSize?: number; modifiedAt?: string | number | Date; mimeType?: string; encrypted?: boolean; }
export interface ArchiveDocument { entries: readonly ArchiveEntry[]; }
export interface ArchiveExtractOptions { signal?: AbortSignal; /** Decoder must stop before allocating beyond this output size. */ maxBytes: number; }
export interface OpenArchiveHandle { entries: readonly ArchiveEntry[]; extract(entryId: number, options: ArchiveExtractOptions): Promise<Uint8Array>; close(): void | Promise<void>; }
export interface ArchiveDecoder { openArchive(data: Uint8Array, options?: { signal?: AbortSignal; maxEntries?: number; maxDecompressedBytes?: number }): Promise<OpenArchiveHandle>; }
