import type { ArchiveDecoderCapabilities } from './model.js';

/** Protocol names shared by decoder-specific Worker adapters. Optional fields
 * keep existing JSZip/libarchive workers source-compatible. */
export type ArchiveWorkerRequest =
    | { type: 'list'; password?: string }
    | { type: 'extract'; entryId: number; maxBytes?: number; password?: string }
    | { type: 'close' };
export type ArchiveWorkerResponse =
    | { type: 'entries'; entries: unknown[]; encrypted?: boolean; capabilities?: ArchiveDecoderCapabilities }
    | { type: 'bytes'; data: Uint8Array }
    | { type: 'error'; messageKey: string }
    | { type: 'closed' };
