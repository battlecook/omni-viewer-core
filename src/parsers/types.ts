// Parser layer contracts (DESIGN.md §3-①).
//
// Determinism rule: same bytes + same ParseOptions => identical ParseResult
// (including diagnostics) on every platform and engine. Environment-dependent
// information lives in ExecutionReport, which conformance comparison ignores
// (ADR 34). Input-caused failures never throw — they are `status: 'failed'`;
// throwing is reserved for programmer errors.

export type ParseResult<T> =
    | { status: 'ok'; document: T; diagnostics: Diagnostic[] }
    | { status: 'partial'; document: T; diagnostics: Diagnostic[] }
    | { status: 'failed'; failure: ParseFailure; diagnostics: Diagnostic[] };

export interface ParseFailure {
    code:
        | 'invalid-format'
        | 'corrupted'
        | 'password-required'
        | 'limit-exceeded'
        | 'aborted'
        | 'missing-dependency';
    /** true when retrying with amended input can succeed (e.g. password). */
    retryable: boolean;
    messageKey: string;
    args?: Record<string, string | number>;
}

export interface Diagnostic {
    severity: 'info' | 'warning' | 'error';
    code: string;
    /** Core catalog key (never inline English — ADR 17/28). */
    messageKey: string;
    args?: Record<string, string | number>;
    /** Sheet name, page number, entry path, row range … */
    location?: string;
}

export interface ParseOutcome<T> {
    /** Deterministic — the conformance kit compares this. */
    result: ParseResult<T>;
    /** Environment-dependent — logging / UI badges only, never compared. */
    execution: ExecutionReport;
}

export interface ExecutionReport {
    workerUsed: boolean;
    /** false = only cooperative (soft) limits applied in this environment. */
    hardLimitEnforced: boolean;
    elapsedMillis: number;
}

export interface ParseOptions {
    /** Cooperative cancellation — parsers check this at loop checkpoints. */
    signal?: AbortSignal;
    limits?: ResourceLimits;
}

export interface ResourceLimits {
    /** Enforced by the platform before loading bytes; parsers re-check as 2nd defense. */
    maxInputBytes?: number;
    /** Cumulative decompressed output cap (zip bomb defense). */
    maxDecompressedBytes?: number;
    /** Archive entries / table rows cap. */
    maxEntries?: number;
    /** Soft unless running in a terminatable Worker (DESIGN.md §3-①). */
    maxParseMillis?: number;
}

/** Core-defined default limits; platforms may override per call. */
export const DEFAULT_LIMITS: Required<Pick<ResourceLimits, 'maxInputBytes' | 'maxEntries' | 'maxParseMillis'>> = {
    maxInputBytes: 256 * 1024 * 1024,
    maxEntries: 1_000_000,
    maxParseMillis: 30_000
};

export type LimitViolation =
    | { kind: 'aborted' }
    | { kind: 'time'; elapsedMillis: number }
    | { kind: 'entries'; count: number }
    | { kind: 'decompressed'; bytes: number };

/**
 * Cooperative limit tracking (DESIGN.md §3-①). Parsers call `checkpoint()`
 * inside their record/row/chunk loops; a non-null return means stop now and
 * report `partial`/`failed`. Wall-clock use is confined to the tracker so the
 * *decision points* stay deterministic given the same limits and inputs
 * (time-based stops are inherently soft and excluded from conformance
 * fixtures).
 */
export class LimitTracker {
    private readonly startedAt: number;
    private entries = 0;
    private decompressedBytes = 0;

    constructor(
        private readonly limits: ResourceLimits,
        private readonly signal?: AbortSignal
    ) {
        this.startedAt = Date.now();
    }

    addEntries(n: number): void {
        this.entries += n;
    }

    addDecompressedBytes(n: number): void {
        this.decompressedBytes += n;
    }

    get entryCount(): number {
        return this.entries;
    }

    elapsedMillis(): number {
        return Date.now() - this.startedAt;
    }

    checkpoint(): LimitViolation | null {
        if (this.signal?.aborted) return { kind: 'aborted' };
        if (
            this.limits.maxEntries !== undefined &&
            this.entries > this.limits.maxEntries
        ) {
            return { kind: 'entries', count: this.entries };
        }
        if (
            this.limits.maxDecompressedBytes !== undefined &&
            this.decompressedBytes > this.limits.maxDecompressedBytes
        ) {
            return { kind: 'decompressed', bytes: this.decompressedBytes };
        }
        if (this.limits.maxParseMillis !== undefined) {
            const elapsed = this.elapsedMillis();
            if (elapsed > this.limits.maxParseMillis) {
                return { kind: 'time', elapsedMillis: elapsed };
            }
        }
        return null;
    }
}

/**
 * Decode input bytes as UTF-8 text (BOM tolerated; parseCsv strips it).
 * UTF-8 decoding is deterministic across engines. Legacy encodings must use
 * core-bundled decoding tables instead (determinism rule, ADR 41).
 */
export function decodeUtf8(data: Uint8Array): string {
    return new TextDecoder('utf-8', { fatal: false }).decode(data);
}

/**
 * UTF-8 byte length of a string without allocating an encoded copy, so
 * `maxInputBytes` can be enforced for string inputs too (allocating via
 * TextEncoder would defeat the memory cap being checked).
 */
export function utf8ByteLength(text: string): number {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) {
            bytes += 1;
        } else if (code < 0x800) {
            bytes += 2;
        } else if (code >= 0xd800 && code <= 0xdbff) {
            // Surrogate pair -> one 4-byte code point (lone surrogates encode
            // as 3-byte replacement chars; counting 4 here is a safe upper
            // bound only when the low surrogate follows, which we skip).
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                bytes += 4;
                i++;
            } else {
                bytes += 3;
            }
        } else {
            bytes += 3;
        }
    }
    return bytes;
}
