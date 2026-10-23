// Generic XML parser (docs/viewers/xml.md §2) — a contract parser: input-caused
// failures are `status: 'failed'`, recoverable well-formedness errors make the
// result `partial` with the recovered tree.

import { decodeMarkupText } from '../epub/index.js';
import type { Diagnostic, ParseOptions, ParseOutcome, ParseResult } from '../types.js';
import { utf8ByteLength } from '../types.js';
import type { XmlDocument } from './model.js';
import { parseXmlText } from './parse.js';

export * from './model.js';
export { parseXmlText, XML_ENTITY_EXPANSION_BUDGET, XML_MAX_DIAGNOSTICS, type XmlTextLimits, type XmlTextResult } from './parse.js';

export const XML_INPUT_OWNERSHIP = 'borrows' as const;
export const XML_DEFAULT_MAX_INPUT_BYTES = 64 * 1024 * 1024;
export const XML_DEFAULT_MAX_NODES = 500_000;
export const XML_DEFAULT_MAX_DEPTH = 1_000;

export interface XmlParseOptions extends ParseOptions {
    /** Element nesting cap; deeper content is cut and the result is partial. */
    maxDepth?: number;
}

export function parseXml(input: Uint8Array | string, options: XmlParseOptions = {}): ParseOutcome<XmlDocument> {
    const started = Date.now();
    const finish = (result: ParseResult<XmlDocument>): ParseOutcome<XmlDocument> => ({
        result,
        execution: { workerUsed: false, hardLimitEnforced: false, elapsedMillis: Date.now() - started }
    });
    const fail = (code: 'invalid-format' | 'limit-exceeded' | 'aborted', messageKey: string, diagnostics: Diagnostic[] = [], args?: Record<string, string | number>): ParseOutcome<XmlDocument> =>
        finish({ status: 'failed', failure: { code, retryable: code === 'aborted', messageKey, ...(args ? { args } : {}) }, diagnostics });

    const maxBytes = options.limits?.maxInputBytes ?? XML_DEFAULT_MAX_INPUT_BYTES;
    const bytes = typeof input === 'string' ? utf8ByteLength(input) : input.byteLength;
    if (bytes > maxBytes) return fail('limit-exceeded', 'diag.limit-exceeded.input', [], { maxBytes });
    if (options.signal?.aborted) return fail('aborted', 'diag.aborted');

    const diagnostics: Diagnostic[] = [];
    let text: string;
    let encoding: string;
    if (typeof input === 'string') {
        text = input;
        encoding = 'utf-16';
    } else {
        const decoded = decodeMarkupText(input);
        text = decoded.text;
        encoding = decoded.encoding;
        if (decoded.unsupportedEncoding) {
            diagnostics.push({
                severity: 'warning', code: 'xml-unsupported-encoding', messageKey: 'diag.xml.unsupportedEncoding',
                args: { encoding: decoded.unsupportedEncoding }
            });
        }
    }
    // A NUL is never XML character data; it means the bytes are binary (or a
    // UTF-16 file without the '<' the decoder keys on).
    if (text.slice(0, 4096).indexOf('\u0000') >= 0) return fail('invalid-format', 'diag.xml.notText', diagnostics);

    const scan = parseXmlText(text, encoding, {
        maxNodes: options.limits?.maxEntries ?? XML_DEFAULT_MAX_NODES,
        maxDepth: options.maxDepth ?? XML_DEFAULT_MAX_DEPTH,
        ...(options.signal ? { signal: options.signal } : {})
    });
    if (scan.stopped === 'aborted') return fail('aborted', 'diag.aborted');
    diagnostics.push(...scan.diagnostics);
    if (!scan.document.root) return fail('invalid-format', 'diag.xml.noRoot', diagnostics);
    const partial = scan.stopped !== null || diagnostics.some((diagnostic) => diagnostic.severity === 'error');
    return finish({ status: partial ? 'partial' : 'ok', document: scan.document, diagnostics });
}
