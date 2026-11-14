import { openEpubArchive } from './epub/index.js';
import { EpubReadError, type EpubInflate } from './epub/zip.js';
import { DEFAULT_LIMITS, LimitTracker, decodeUtf8, type Diagnostic, type ParseFailure, type ParseOptions, type ParseOutcome, type ParseResult } from './types.js';
import { parseXml, type XmlNode } from './xml/index.js';

export const PREVIEW_INPUT_BYTES = 32 * 1024 * 1024;
export const PREVIEW_XML_BYTES = 16 * 1024 * 1024;

export class PreviewError extends Error {
    constructor(readonly code: ParseFailure['code'], readonly messageKey: string, readonly args?: ParseFailure['args']) {
        super(messageKey);
    }
}

export function invalidPreview(): never {
    throw new PreviewError('invalid-format', 'preview.invalid');
}

export function previewParser(input: Uint8Array, options: ParseOptions, maxBytes = PREVIEW_INPUT_BYTES) {
    const tracker = new LimitTracker({ maxParseMillis: options.limits?.maxParseMillis ?? DEFAULT_LIMITS.maxParseMillis }, options.signal);
    const diagnostics: Diagnostic[] = [];
    const finish = <T>(result: ParseResult<T>): ParseOutcome<T> => ({
        result,
        execution: { workerUsed: false, hardLimitEnforced: false, elapsedMillis: tracker.elapsedMillis() }
    });
    const warn = (code: 'unsupported' | 'truncated' | 'skipped', messageKey = `preview.${code}`) => {
        if (!diagnostics.some(diagnostic => diagnostic.messageKey === messageKey)) {
            diagnostics.push({ severity: 'warning', code, messageKey });
        }
    };
    const checkpoint = () => {
        const violation = tracker.checkpoint();
        if (violation?.kind === 'aborted') throw new PreviewError('aborted', 'diag.aborted');
        if (violation?.kind === 'time') {
            warn('truncated');
            return false;
        }
        return true;
    };
    const requireTime = () => {
        if (!checkpoint()) throw new PreviewError('limit-exceeded', 'preview.truncated');
    };
    return {
        check() {
            requireTime();
            const limit = options.limits?.maxInputBytes ?? maxBytes;
            if (input.length > limit) throw new PreviewError('limit-exceeded', 'diag.limit-exceeded.input', { maxBytes: limit });
        },
        checkpoint,
        requireTime,
        warn,
        xml(bytes: Uint8Array | string) {
            requireTime();
            const result = parseXml(bytes, {
                ...options,
                limits: { maxInputBytes: PREVIEW_XML_BYTES, maxEntries: 250_000 },
                maxDepth: 128
            }).result;
            if (result.status === 'failed') throw new PreviewError(result.failure.code, result.failure.messageKey, result.failure.args);
            for (const diagnostic of result.diagnostics) {
                if (diagnostics.length >= 50) break;
                diagnostics.push(diagnostic);
            }
            requireTime();
            return result.document;
        },
        success<T>(document: T) {
            checkpoint();
            return finish<T>({ status: diagnostics.length ? 'partial' : 'ok', document, diagnostics });
        },
        failure<T>(error: unknown) {
            if (error instanceof EpubReadError) {
                const code = error.code;
                if (code === 'aborted') error = new PreviewError('aborted', 'diag.aborted');
                else if (code === 'encrypted') error = new PreviewError('password-required', 'preview.encrypted');
                else if (code === 'too-large' || code === 'budget-exceeded') error = new PreviewError('limit-exceeded', 'preview.truncated');
                else if (code === 'inflate-unavailable') error = new PreviewError('missing-dependency', 'diag.epub.inflate-unavailable');
                else error = new PreviewError('corrupted', 'preview.invalid');
            }
            if (!(error instanceof PreviewError)) throw error;
            const { code, messageKey, args } = error;
            return finish<T>({ status: 'failed', diagnostics, failure: {
                code, messageKey, retryable: code === 'aborted', ...(args ? { args } : {})
            } });
        }
    };
}

export interface CompressedPreviewOptions extends ParseOptions {
    /** Bounded raw DEFLATE decoder for runtimes without native support. */
    inflate?: EpubInflate;
}

export function previewZip(input: Uint8Array, options: CompressedPreviewOptions) {
    const budget = options.limits?.maxDecompressedBytes ?? PREVIEW_XML_BYTES;
    const archive = openEpubArchive(input, {
        maxEntries: 10_000,
        maxDecompressedBytes: budget,
        ...(options.inflate ? { inflate: options.inflate } : {})
    });
    if (!archive) return invalidPreview();
    if (archive.truncated) throw new PreviewError('limit-exceeded', 'preview.truncated');
    const readMembers = new Set<string>();
    let total = 0;
    return {
        entries: archive.entries,
        has: archive.has.bind(archive),
        find: archive.find.bind(archive),
        async read(path: string, maxBytes: number, signal?: AbortSignal) {
            const member = archive.find(path);
            const charge = member && !readMembers.has(member.name) ? member.uncompressedSize : 0;
            if (total + charge > budget) throw new PreviewError('limit-exceeded', 'preview.truncated');
            if (member && !readMembers.has(member.name)) {
                readMembers.add(member.name);
                total += charge;
            }
            const result = await archive.read(path, maxBytes, signal);
            if (member && result.length !== member.uncompressedSize) throw new EpubReadError('corrupted', path);
            return result;
        }
    };
}

/** Retain the longest UTF-8 prefix that fits without splitting a code point. */
export function previewUtf8(value: string, maxBytes: number): { text: string; bytes: number } {
    let end = 0, bytes = 0;
    for (const character of value) {
        const code = character.codePointAt(0)!;
        const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
        if (bytes + size > maxBytes) break;
        bytes += size;
        end += character.length;
    }
    return { text: value.slice(0, end), bytes };
}

export function previewJson(input: Uint8Array): unknown {
    try {
        return JSON.parse(decodeUtf8(input)) as unknown;
    } catch {
        return invalidPreview();
    }
}

export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}
export function array(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}
export function string(value: unknown): string {
    return typeof value === 'string' ? value : '';
}
export function finite(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function elements(node: XmlNode, local?: string, namespace = node.namespaceUri): XmlNode[] {
    return node.children.filter(child => child.kind === 'element' && child.namespaceUri === namespace && (local === undefined || child.local === local));
}
export function attribute(node: XmlNode, local: string, namespace = ''): string {
    return node.attributes.find(item => item.local === local && item.namespaceUri === namespace)?.value ?? '';
}
export function xmlText(node: XmlNode): string {
    return node.children.map(child => {
        if (child.kind === 'element') return xmlText(child);
        return child.kind === 'text' || child.kind === 'cdata' ? child.value : '';
    }).join('');
}
