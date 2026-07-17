// JSON parser entry — the core contract surface (DESIGN.md §3-①, J1 = 원문
// 보존 토크나이저). parseJson(bytes or text) -> ParseOutcome<JsonDocument>.
// Input-caused failures never throw; limits stop with `partial` + a diagnostic;
// a syntax error yields the recovered prefix as `partial` (or `failed` if
// nothing parsed) while the source text stays available for the verbatim view.

import type {
    Diagnostic,
    ParseOptions,
    ParseOutcome,
    ParseResult
} from '../types.js';
import { DEFAULT_LIMITS, LimitTracker, decodeUtf8, utf8ByteLength } from '../types.js';
import type { JsonDocument } from './model.js';
import { JSON_DEFAULT_MAX_DEPTH, parseJsonDocument, type StopReason } from './parse.js';

export type { JsonDocument, JsonNode, JsonValueKind } from './model.js';
export { appendPath, decodeJsonString, encodeJsonString } from './model.js';
export { tokenizeJson } from './tokenizer.js';
export type { JsonToken, JsonTokenKind } from './tokenizer.js';
export { parseJsonDocument, JSON_DEFAULT_MAX_DEPTH } from './parse.js';
export type { JsonParseTree, ParseTreeOptions } from './parse.js';

export interface JsonParseOptions extends ParseOptions {
    /** Nesting depth cap (default JSON_DEFAULT_MAX_DEPTH) — deep-nesting defense. */
    maxDepth?: number;
}

/** Input ownership: borrows the input; the caller keeps the bytes (DESIGN §3-①). */
export const JSON_INPUT_OWNERSHIP = 'borrows' as const;

/** How often (in nodes) the cooperative abort/time checkpoint runs. */
const CHECKPOINT_INTERVAL = 256;

export function parseJson(
    input: Uint8Array | string,
    options: JsonParseOptions = {}
): ParseOutcome<JsonDocument> {
    const started = Date.now();
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    const diagnostics: Diagnostic[] = [];

    const finish = (
        result: ParseResult<JsonDocument>
    ): ParseOutcome<JsonDocument> => ({
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

    const tracker = new LimitTracker(limits, options.signal);
    const onNode = (): StopReason | null => {
        tracker.addEntries(1);
        const count = tracker.entryCount;
        // Amortize the abort/time checks; always enforce the node cap.
        if (count % CHECKPOINT_INTERVAL !== 0 && count <= limits.maxEntries) {
            return null;
        }
        const violation = tracker.checkpoint();
        if (!violation) return null;
        return violation.kind === 'aborted' ? 'abort' : 'limit';
    };

    const tree = parseJsonDocument(text, {
        maxDepth: options.maxDepth ?? JSON_DEFAULT_MAX_DEPTH,
        onNode
    });
    diagnostics.push(...tree.diagnostics);

    // Cancellation is a failure regardless of how much parsed (parity with csv).
    if (tree.stopped && tree.stopReason === 'abort') {
        return finish({
            status: 'failed',
            failure: { code: 'aborted', retryable: true, messageKey: 'diag.aborted' },
            diagnostics
        });
    }

    // Nothing recovered — the verbatim view falls back to the raw bytes (J20),
    // so the viewer still shows the source; the model result is `failed`.
    if (!tree.root) {
        return finish({
            status: 'failed',
            failure: {
                code: 'invalid-format',
                retryable: false,
                messageKey: 'diag.json.invalid'
            },
            diagnostics
        });
    }

    const document: JsonDocument = { root: tree.root, text };

    if (tree.stopped && tree.stopReason === 'limit') {
        diagnostics.push({
            severity: 'warning',
            code: 'limit-exceeded',
            messageKey: 'diag.limit-exceeded.nodes',
            args: { count: tracker.entryCount }
        });
        return finish({ status: 'partial', document, diagnostics });
    }

    // A syntax error or trailing content means we recovered only a prefix.
    if (tree.errored || tree.trailing) {
        return finish({ status: 'partial', document, diagnostics });
    }

    return finish({ status: 'ok', document, diagnostics });
}
