/** Protocol names shared by decoder-specific Worker adapters. */
export type ArchiveWorkerRequest = { type:'list' } | { type:'extract'; entryId:number } | { type:'close' };
export type ArchiveWorkerResponse = { type:'entries'; entries: unknown[] } | { type:'bytes'; data: Uint8Array } | { type:'error'; messageKey:string } | { type:'closed' };
