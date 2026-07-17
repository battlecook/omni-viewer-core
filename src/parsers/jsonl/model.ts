import type { JsonNode } from '../json/index.js';

export interface JsonlEntry {
    /** Immutable controller identity; physical `line` is presentation only. */
    id: string;
    line: number;
    raw: string;
    lineEnding: '\n' | '\r\n' | '';
    value: JsonNode | null;
    diagnostics: import('../types.js').Diagnostic[];
}
export interface JsonlDocument { text: string; entries: JsonlEntry[]; }

/** Deterministic append-only preview protocol (docs/viewers/jsonl.md JNL3). */
export interface JsonlPagedInput {
    initialData: Uint8Array;
    totalBytes?: number;
    loadMore?: () => Promise<{ data: Uint8Array; done: boolean }>;
}
