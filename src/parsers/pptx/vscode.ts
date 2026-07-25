import type { SlideDeck } from '../slide-model.js';
import type { Diagnostic, ParseOptions, ParseOutcome } from '../types.js';
import {
    limitDiagnosticArgs,
    pptxLimits,
    PptxLimitError,
    type PptxParseGuard
} from './limits.js';
import {
    PptxXmlParser,
    type PptxXmlParserDeps
} from './vscode-parser.js';

export type PptxVscodeParserDeps = PptxXmlParserDeps;

function failureFromLimit(
    error: PptxLimitError,
    diagnostics: Diagnostic[],
    started: number
): ParseOutcome<SlideDeck> {
    const aborted = error.violation.kind === 'aborted';
    const args = limitDiagnosticArgs(error);
    const diagnostic: Diagnostic = {
        severity: 'warning',
        code: aborted ? 'pptx.aborted' : 'pptx.limit-exceeded',
        messageKey: aborted ? 'diag.aborted' : 'diag.ppt.limit-exceeded',
        args,
        ...(error.location ? { location: error.location } : {})
    };
    diagnostics.push(diagnostic);
    return {
        result: {
            status: 'failed',
            failure: {
                code: aborted ? 'aborted' : 'limit-exceeded',
                retryable: aborted,
                messageKey: diagnostic.messageKey,
                args
            },
            diagnostics
        },
        execution: {
            workerUsed: false,
            hardLimitEnforced: false,
            elapsedMillis: Date.now() - started
        }
    };
}

/** Full-fidelity PPTX parser adapted from VS Code's file-path parser to bytes. */
export async function parsePptxVscode(
    input: Uint8Array,
    options: ParseOptions = {},
    deps: PptxVscodeParserDeps = {}
): Promise<ParseOutcome<SlideDeck>> {
    const started = Date.now();
    const diagnostics: Diagnostic[] = [];
    if (options.signal?.aborted) {
        return failureFromLimit(
            new PptxLimitError({ kind: 'aborted' }),
            diagnostics,
            started
        );
    }
    if (input.byteLength > (pptxLimits(options).maxInputBytes ?? Number.POSITIVE_INFINITY)) {
        const error = new PptxLimitError(
            { kind: 'decompressed', bytes: input.byteLength },
            'input'
        );
        const outcome = failureFromLimit(error, diagnostics, started);
        if (outcome.result.status === 'failed') {
            outcome.result.failure.messageKey = 'diag.limit-exceeded.input';
            outcome.result.failure.args = {
                kind: 'input',
                bytes: input.byteLength,
                maxBytes: pptxLimits(options).maxInputBytes ?? 0
            };
            outcome.result.diagnostics[0]!.messageKey = 'diag.limit-exceeded.input';
            outcome.result.diagnostics[0]!.args = outcome.result.failure.args;
        }
        return outcome;
    }

    try {
        const parsed = await PptxXmlParser.parse(input, options, deps);
        diagnostics.push(...parsed.diagnostics);
        const slides = parsed.slides as SlideDeck['slides'];
        return {
            result: {
                status: 'ok',
                document: {
                    slides,
                    totalSlides: parsed.totalSlides,
                    ...(slides[0]
                        ? { slideSize: { widthPx: slides[0].widthPx, heightPx: slides[0].heightPx } }
                        : {})
                },
                diagnostics
            },
            execution: {
                workerUsed: false,
                // JSZip runs in-process. Entry, byte, time and abort checks are
                // cooperative; callers must not mistake them for a killable worker.
                hardLimitEnforced: false,
                elapsedMillis: Date.now() - started
            }
        };
    } catch (error) {
        if (error instanceof PptxLimitError) {
            return failureFromLimit(error, diagnostics, started);
        }
        const corrupted = input[0] === 0x50 && input[1] === 0x4b;
        return {
            result: {
                status: 'failed',
                failure: {
                    code: corrupted ? 'corrupted' : 'invalid-format',
                    retryable: false,
                    messageKey: corrupted
                        ? 'diag.ppt.corrupted'
                        : 'diag.ppt.invalid-format'
                },
                diagnostics
            },
            execution: {
                workerUsed: false,
                hardLimitEnforced: false,
                elapsedMillis: Date.now() - started
            }
        };
    }
}

// Kept only to make generated declaration diffs clearer when callers used the
// old parser symbol through inferred types.
export type PptxParserGuard = PptxParseGuard;
