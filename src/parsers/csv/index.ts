// CSV parser entry — the core contract surface (DESIGN.md §3-①).
//
// parseCsv(bytes or text) -> ParseOutcome<CsvDocument>. Input-caused failures
// never throw; limits stop parsing with `partial` + a limit diagnostic.

import type {
    Diagnostic,
    ParseOptions,
    ParseOutcome,
    ParseResult
} from '../types.js';
import { DEFAULT_LIMITS, LimitTracker, decodeUtf8, utf8ByteLength } from '../types.js';
import { parseCsvText } from './parseText.js';
import {
    detectDelimiter,
    detectDelimiterForFile,
    asciiLower,
    type CsvDelimiter,
    type DelimiterDetectionResult
} from './delimiter.js';

export type { CsvDelimiter, DelimiterDetectionResult } from './delimiter.js';
export { detectDelimiter, detectDelimiterForFile, DELIMITER_PRIORITY, asciiLower } from './delimiter.js';
export * from './sort.js';
export * from './statistics.js';
export type { RawCsv } from './parseText.js';

export interface CsvDocument {
    headers: string[];
    rows: string[][];
    columnCount: number;
    delimiter: CsvDelimiter;
    detection: {
        delimiter: CsvDelimiter;
        confidence: number;
        source: 'auto' | 'extension' | 'override';
    };
}

export interface CsvParseOptions extends ParseOptions {
    /** Explicit delimiter override; skips auto-detection. */
    delimiter?: CsvDelimiter;
    /** Used for the `.tsv` extension shortcut during auto-detection. */
    fileName?: string;
    /** First row is headers (default true). */
    hasHeader?: boolean;
}

/** Input ownership: this parser borrows the input (DESIGN.md §3-① — the
 *  caller keeps the bytes; nothing is transferred or mutated). */
export const CSV_INPUT_OWNERSHIP = 'borrows' as const;

export function parseCsv(
    input: Uint8Array | string,
    options: CsvParseOptions = {}
): ParseOutcome<CsvDocument> {
    const started = Date.now();
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    const diagnostics: Diagnostic[] = [];

    const finish = (result: ParseResult<CsvDocument>): ParseOutcome<CsvDocument> => ({
        result,
        execution: {
            workerUsed: false,
            hardLimitEnforced: false,
            elapsedMillis: Date.now() - started
        }
    });

    const inputBytes =
        typeof input === 'string' ? utf8ByteLength(input) : input.byteLength;
    if (inputBytes > limits.maxInputBytes) {
        return finish({
            status: 'failed',
            failure: {
                code: 'limit-exceeded',
                retryable: false,
                messageKey: 'diag.limit-exceeded.input',
                args: { maxBytes: limits.maxInputBytes }
            },
            diagnostics
        });
    }

    if (options.signal?.aborted) {
        return finish({
            status: 'failed',
            failure: { code: 'aborted', retryable: true, messageKey: 'diag.aborted' },
            diagnostics
        });
    }

    const text = typeof input === 'string' ? input : decodeUtf8(input);

    let detection: CsvDocument['detection'];
    if (options.delimiter !== undefined) {
        detection = { delimiter: options.delimiter, confidence: 1, source: 'override' };
    } else if (options.fileName !== undefined && asciiLower(options.fileName).endsWith('.tsv')) {
        detection = { ...detectDelimiterForFile(options.fileName, text), source: 'extension' };
    } else {
        detection = { ...detectDelimiter(text), source: 'auto' };
    }

    const tracker = new LimitTracker(limits, options.signal);
    let violation: ReturnType<LimitTracker['checkpoint']> = null;

    const parseTextOptions: Parameters<typeof parseCsvText>[1] = {
        delimiter: detection.delimiter,
        checkpoint: (recordCount) => {
            tracker.addEntries(1);
            // Amortize the time/abort checks: every 256 records.
            if (recordCount % 256 !== 0 && recordCount <= limits.maxEntries) {
                return true;
            }
            violation = tracker.checkpoint();
            return violation === null;
        }
    };
    if (options.hasHeader !== undefined) {
        parseTextOptions.hasHeader = options.hasHeader;
    }
    const raw = parseCsvText(text, parseTextOptions);

    if (raw.raggedRowCount > 0) {
        diagnostics.push({
            severity: 'warning',
            code: 'csv.ragged-rows',
            messageKey: 'diag.csv.ragged-rows',
            args: { count: raw.raggedRowCount }
        });
    }

    const document: CsvDocument = {
        headers: raw.headers,
        rows: raw.rows,
        columnCount: raw.columnCount,
        delimiter: detection.delimiter,
        detection
    };

    if (raw.stoppedEarly) {
        const v = violation as ReturnType<LimitTracker['checkpoint']>;
        if (v && v.kind === 'aborted') {
            return finish({
                status: 'failed',
                failure: { code: 'aborted', retryable: true, messageKey: 'diag.aborted' },
                diagnostics
            });
        }
        diagnostics.push({
            severity: 'warning',
            code: 'limit-exceeded',
            messageKey: 'diag.limit-exceeded.rows',
            args: { count: document.rows.length }
        });
        return finish({ status: 'partial', document, diagnostics });
    }

    return finish({ status: 'ok', document, diagnostics });
}
