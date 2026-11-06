import { DEFAULT_LIMITS, type Diagnostic, type ParseOptions, type ParseOutcome, type ParseResult } from '../types.js';

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

export interface TextDocument {
    /** Decoded preview, preserving whitespace and line endings. */
    text: string;
    encoding: TextEncoding;
    /** True when the preview byte budget omitted part of the input. */
    truncated: boolean;
}

export interface TextParseOptions extends ParseOptions {
    /** Encoding for BOM-less input. A Unicode BOM takes precedence. */
    encoding?: TextEncoding;
}

export const TEXT_INPUT_OWNERSHIP = 'borrows' as const;
export const TEXT_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

function byteLimit(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Text byte limits must be non-negative safe integers');
    return value;
}

/** Dependency-free Unicode decoding; no DOM or host-specific charset guessing. */
export function parseText(data: Uint8Array, options: TextParseOptions = {}): ParseOutcome<TextDocument> {
    const started = Date.now();
    const finish = (result: ParseResult<TextDocument>): ParseOutcome<TextDocument> => ({
        result,
        execution: { workerUsed: false, hardLimitEnforced: false, elapsedMillis: Date.now() - started }
    });
    if (options.signal?.aborted) {
        return finish({ status: 'failed', failure: { code: 'aborted', retryable: true, messageKey: 'diag.aborted' }, diagnostics: [] });
    }
    const maxInput = byteLimit(options.limits?.maxInputBytes ?? DEFAULT_LIMITS.maxInputBytes);
    const maxPreview = byteLimit(options.limits?.maxPreviewBytes ?? TEXT_PREVIEW_MAX_BYTES);
    if (data.byteLength > maxInput) {
        return finish({
            status: 'failed',
            failure: { code: 'limit-exceeded', retryable: false, messageKey: 'diag.limit-exceeded.input', args: { maxBytes: maxInput } },
            diagnostics: []
        });
    }

    // UTF-32LE starts with the UTF-16LE BOM. Reject it before checking UTF-16.
    if ((data[0] === 0xff && data[1] === 0xfe && data[2] === 0 && data[3] === 0) ||
        (data[0] === 0 && data[1] === 0 && data[2] === 0xfe && data[3] === 0xff)) {
        return finish({ status: 'failed', failure: { code: 'invalid-format', retryable: false, messageKey: 'text.unsupportedEncoding' }, diagnostics: [] });
    }
    let encoding: TextEncoding = options.encoding ?? 'utf-8';
    let offset = 0;
    if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) { encoding = 'utf-8'; offset = 3; }
    else if (data[0] === 0xff && data[1] === 0xfe) { encoding = 'utf-16le'; offset = 2; }
    else if (data[0] === 0xfe && data[1] === 0xff) { encoding = 'utf-16be'; offset = 2; }

    const bytes = data.subarray(offset, offset + maxPreview);
    const truncated = data.byteLength - offset > maxPreview;
    const diagnostics: Diagnostic[] = [];
    let text: string;
    try {
        // Streaming mode leaves a character split by the preview boundary
        // buffered, instead of replacing it or incorrectly reporting corruption.
        text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes, { stream: truncated });
    } catch {
        text = new TextDecoder(encoding, { ignoreBOM: true }).decode(bytes, { stream: truncated });
        diagnostics.push({ severity: 'warning', code: 'text.invalid-encoding', messageKey: 'text.invalidEncoding', args: { encoding } });
    }
    if (truncated) {
        diagnostics.push({ severity: 'warning', code: 'text.preview-truncated', messageKey: 'text.truncated', args: { bytes: maxPreview } });
    }
    return finish({
        status: diagnostics.length ? 'partial' : 'ok',
        document: { text, encoding, truncated },
        diagnostics
    });
}
