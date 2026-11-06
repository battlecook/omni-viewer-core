import { LimitTracker, utf8ByteLength, type Diagnostic, type ParseOptions, type ParseOutcome } from '../types.js';

export const EML_INPUT_OWNERSHIP = 'borrows' as const;
export const EML_MAX_INPUT_BYTES = 32 * 1024 * 1024;
export interface EmlHeader { name: string; value: string; rawValue: string }
export interface EmlAttachment {
    fileName: string;
    contentType: string;
    contentId: string;
    inline: boolean;
    data: Uint8Array;
}
export interface EmlDocument {
    headers: EmlHeader[];
    subject: string;
    from: string;
    to: string;
    cc: string;
    bcc: string;
    replyTo: string;
    date: string;
    messageId: string;
    text: string;
    html: string;
    /** CID lookup scope for the selected HTML alternative. */
    htmlResources: EmlAttachment[];
    attachments: EmlAttachment[];
}
export interface EmlParseOptions extends ParseOptions { maxDepth?: number }
interface EmlBody { text: string; html: string; htmlResources: EmlAttachment[] }

class EmlFailure extends Error {
    constructor(readonly code: 'invalid-format' | 'corrupted' | 'limit-exceeded' | 'aborted') { super(code); }
}

/** Byte-preserving conversion: TextDecoder('latin1') would map C1 bytes to Windows-1252. */
function binaryString(bytes: Uint8Array): string {
    const chunks: string[] = [];
    for (let at = 0; at < bytes.length; at += 8192) chunks.push(String.fromCharCode(...bytes.subarray(at, at + 8192)));
    return chunks.join('');
}
function binaryBytes(text: string): Uint8Array {
    return Uint8Array.from(text, char => char.charCodeAt(0));
}

function base64(text: string): Uint8Array {
    const clean = text.replace(/[\t\r\n ]/g, '');
    const padding = clean.indexOf('=');
    if (/[^A-Za-z0-9+/=]/.test(clean) || clean.length % 4 === 1 ||
        padding >= 0 && (clean.length % 4 !== 0 || !/^={1,2}$/.test(clean.slice(padding)) || padding < clean.length - 2)) throw new EmlFailure('corrupted');
    return binaryBytes(atob(clean));
}
function quotedPrintable(text: string): Uint8Array {
    return binaryBytes(text.replace(/=[\t ]*(?:\r\n|\n|\r)/g, '').replace(/=([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))));
}
function decodeText(bytes: Uint8Array, charset: string, warn: (code: string) => void): string {
    try { return new TextDecoder(charset || 'utf-8').decode(bytes); }
    catch { warn('charset'); return new TextDecoder('utf-8').decode(bytes); }
}
function decodeWords(value: string, warn: (code: string) => void): string {
    // Linear whitespace between adjacent encoded words is not displayed (RFC 2047).
    return value.replace(/(\?=)[\t ]+(?==\?[^?\s]+\?[bq]\?)/gi, '$1')
        .replace(/=\?([^?\s]+)\?([bq])\?([^?]*)\?=/gi, (word: string, charset: string, encoding: string, text: string) => {
            try { return decodeText(encoding.toLowerCase() === 'b' ? base64(text) : quotedPrintable(text.replace(/_/g, ' ')), charset, warn); }
            catch { warn('encoding'); return word; }
        });
}

function readHeaders(source: string, warn: (code: string) => void): { headers: EmlHeader[]; body: string } {
    const emptyHead = /^(?:\r\n|\n|\r)/.exec(source);
    if (emptyHead) return { headers: [], body: source.slice(emptyHead[0].length) };
    const separator = /\r\n\r\n|\n\n|\r\r/.exec(source);
    const head = separator ? source.slice(0, separator.index) : source;
    if (head.length > 64 * 1024) throw new EmlFailure('limit-exceeded');
    const headers: EmlHeader[] = [];
    let previous: EmlHeader | undefined;
    for (const line of head.split(/\r\n|\n|\r/)) {
        if (/^[\t ]/.test(line) && previous) previous.rawValue += ' ' + line.trim();
        else {
            const match = /^([!#$%&'*+\-.^_`|~\da-z]+):[\t ]*(.*)$/i.exec(line);
            if (!match) { if (line) warn('headers'); previous = undefined; continue; }
            previous = { name: match[1]!, rawValue: match[2]!.trim(), value: '' };
            headers.push(previous);
        }
    }
    for (const header of headers) header.value = decodeWords(decodeText(binaryBytes(header.rawValue), 'utf-8', warn), warn);
    return { headers, body: separator ? source.slice(separator.index + separator[0].length) : '' };
}
function headerValue(headers: EmlHeader[], name: string): string {
    return headers.filter(header => header.name.toLowerCase() === name).map(header => header.value).join(', ');
}
function rawHeader(headers: EmlHeader[], name: string): string {
    return headers.find(header => header.name.toLowerCase() === name)?.rawValue ?? '';
}

/** Quoted parameters, RFC 2231 extended values, and numbered continuations. */
function parameters(value: string, warn: (code: string) => void): { type: string; params: Map<string, string> } {
    const type = value.split(';', 1)[0]!.trim().toLowerCase();
    const raw = new Map<string, string>();
    const pattern = /;\s*([^\s=;]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;\s]*))/g;
    for (const match of value.matchAll(pattern)) raw.set(match[1]!.toLowerCase(), (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1'));
    const params = new Map<string, string>();
    const percentBytes = (text: string): Uint8Array => binaryBytes(text.replace(/%([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))));
    const decodeExtended = (text: string): string => {
        const match = /^([^']*)'[^']*'(.*)$/s.exec(text);
        if (!match) { warn('encoding'); return text; }
        const bytes = percentBytes(match[2]!);
        return decodeText(bytes, match[1]!, warn);
    };
    for (const [name, text] of raw) {
        if (!name.includes('*')) params.set(name, decodeWords(decodeText(binaryBytes(text), 'utf-8', warn), warn));
    }
    for (const [name, text] of raw) {
        if (/^[^*]+\*$/.test(name)) params.set(name.slice(0, -1), decodeExtended(text));
        const numbered = /^([^*]+)\*0(\*)?$/.exec(name);
        if (numbered) {
            let joined = '';
            let charset = 'utf-8';
            for (let i = 0; i < raw.size; i++) {
                const encoded = raw.get(`${numbered[1]}*${i}*`), plain = raw.get(`${numbered[1]}*${i}`);
                if (encoded === undefined && plain === undefined) break;
                let segment = encoded ?? plain!;
                if (i === 0 && encoded !== undefined) {
                    const prefix = /^([^']*)'[^']*'(.*)$/s.exec(segment);
                    if (prefix) { charset = prefix[1] || 'utf-8'; segment = prefix[2]!; }
                    else warn('encoding');
                }
                // Decode starred segments only, then join bytes before charset
                // decoding because one character may span several segments.
                joined += encoded !== undefined ? binaryString(percentBytes(segment)) : segment;
            }
            params.set(numbered[1]!, decodeWords(decodeText(binaryBytes(joined), charset, warn), warn));
        }
    }
    return { type, params };
}

export function safeEmlFileName(name: string, fallback = 'attachment'): string {
    const leaf = name.replace(/\\/g, '/').split('/').pop() ?? '';
    return leaf.replace(/[\x00-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^\.+|[. ]+$/g, '').slice(0, 240) || fallback;
}

/** DOM-free MIME reader. Input-caused errors are returned as ParseResult failures. */
export function parseEml(input: Uint8Array | string, options: EmlParseOptions = {}): ParseOutcome<EmlDocument> {
    const started = Date.now();
    const diagnostics: Diagnostic[] = [];
    const warned = new Set<string>();
    const warn = (code: string) => {
        if (!warned.has(code)) { warned.add(code); diagnostics.push({ severity: 'warning', code: `eml.${code}`, messageKey: `diag.eml.${code}` }); }
    };
    const limits = { maxInputBytes: EML_MAX_INPUT_BYTES, maxEntries: 1000, maxDecompressedBytes: EML_MAX_INPUT_BYTES, maxPreviewBytes: 4 * 1024 * 1024, maxParseMillis: 30_000, ...options.limits };
    const tracker = new LimitTracker(limits, options.signal);
    const check = () => {
        const violation = tracker.checkpoint();
        if (violation) throw new EmlFailure(violation.kind === 'aborted' ? 'aborted' : 'limit-exceeded');
    };
    const execution = () => ({ workerUsed: false, hardLimitEnforced: false, elapsedMillis: Date.now() - started });
    try {
        check();
        if ((typeof input === 'string' ? utf8ByteLength(input) : input.byteLength) > limits.maxInputBytes) throw new EmlFailure('limit-exceeded');
        let source = typeof input === 'string' ? binaryString(new TextEncoder().encode(input)) : binaryString(input);
        // Some exported messages include the mbox envelope or a UTF-8 BOM.
        source = source.replace(/^\xef\xbb\xbf/, '').replace(/^From [^\r\n]*(?:\r\n|\n|\r)/, '');
        const root = readHeaders(source, warn);
        if (!root.headers.some(header => /^(from|to|subject|date|message-id|mime-version|content-type)$/i.test(header.name))) throw new EmlFailure('invalid-format');
        const attachments: EmlAttachment[] = [];
        const readPart = (headers: EmlHeader[], body: string, depth: number, defaultType = 'text/plain', role: 'normal' | 'related-root' | 'related-resource' = 'normal'): EmlBody => {
            check();
            if (depth > Math.min(options.maxDepth ?? 32, 64)) throw new EmlFailure('limit-exceeded');
            tracker.addEntries(1); check();
            const content = parameters(rawHeader(headers, 'content-type') || defaultType, warn);
            const disposition = parameters(rawHeader(headers, 'content-disposition'), warn);
            const fileName = disposition.params.get('filename') || content.params.get('name') || '';
            const contentId = headerValue(headers, 'content-id').replace(/^<|>$/g, '').trim();
            // Named/attached multipart entities are downloadable files, not the mail body.
            if (content.type.startsWith('multipart/') && role !== 'related-resource' && (role === 'related-root' || !fileName && disposition.type !== 'attachment')) {
                const boundary = content.params.get('boundary');
                if (!boundary || boundary.length > 70) { warn('multipart'); return { text: '', html: '', htmlResources: [] }; }
                const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const delimiter = new RegExp(`(?:^|\\r\\n|\\n|\\r)--${escaped}(--)?[\\t ]*(?=\\r\\n|\\n|\\r|$)`, 'g');
                let previous = -1, closed = false, childIndex = 0;
                const relatedStart = content.params.get('start')?.replace(/^<|>$/g, '').trim();
                let relatedRootFound = false;
                const result: EmlBody = { text: '', html: '', htmlResources: [] };
                const merge = (part: string) => {
                    const child = readHeaders(part, warn);
                    const childId = headerValue(child.headers, 'content-id').replace(/^<|>$/g, '').trim();
                    const isRoot = content.type === 'multipart/related' && !relatedRootFound && (relatedStart ? childId === relatedStart : childIndex === 0);
                    if (isRoot) relatedRootFound = true;
                    childIndex++;
                    const childRole = content.type === 'multipart/related' ? isRoot ? 'related-root' : 'related-resource' : 'normal';
                    const parsed = readPart(child.headers, child.body, depth + 1, content.type === 'multipart/digest' ? 'message/rfc822' : 'text/plain', childRole);
                    for (const key of ['text', 'html'] as const) if (parsed[key]) result[key] = content.type === 'multipart/alternative' ? parsed[key] : [result[key], parsed[key]].filter(Boolean).join('\n');
                    if (content.type === 'multipart/alternative') {
                        // Duplicate CIDs are valid in alternatives: carry only
                        // the resources belonging to the HTML body we chose.
                        if (parsed.html) result.htmlResources = parsed.htmlResources;
                    } else result.htmlResources.push(...parsed.htmlResources);
                };
                for (const match of body.matchAll(delimiter)) {
                    check();
                    if (previous >= 0) merge(body.slice(previous, match.index));
                    if (match[1]) { closed = true; break; }
                    previous = match.index! + match[0].length;
                    if (body.slice(previous, previous + 2) === '\r\n') previous += 2;
                    else if (/[\r\n]/.test(body[previous] ?? '')) previous++;
                }
                if (!closed) { warn('multipart'); if (previous >= 0) merge(body.slice(previous)); }
                if (content.type === 'multipart/related' && !relatedRootFound) warn('multipart');
                return result;
            }
            const encoding = rawHeader(headers, 'content-transfer-encoding').trim().toLowerCase();
            let bytes: Uint8Array;
            try {
                bytes = encoding === 'base64' ? base64(body) : encoding === 'quoted-printable' ? quotedPrintable(body) : binaryBytes(body);
                if (!['', 'base64', 'quoted-printable', '7bit', '8bit', 'binary'].includes(encoding)) warn('encoding');
            } catch (error) {
                if (!(error instanceof EmlFailure) && !(error instanceof DOMException)) throw error;
                warn('encoding'); return { text: '', html: '', htmlResources: [] };
            }
            tracker.addDecompressedBytes(bytes.length); check();
            if (role === 'related-resource' || !['text/plain', 'text/html'].includes(content.type) || role !== 'related-root' && (fileName || disposition.type === 'attachment')) {
                const attachment = { fileName: safeEmlFileName(fileName, `attachment-${attachments.length + 1}${content.type === 'message/rfc822' ? '.eml' : ''}`), contentType: content.type || 'application/octet-stream', contentId, inline: disposition.type === 'inline' || !!contentId, data: bytes };
                attachments.push(attachment);
                return { text: '', html: '', htmlResources: [attachment] };
            }
            if (bytes.length > limits.maxPreviewBytes) warn('preview');
            const text = decodeText(bytes.subarray(0, limits.maxPreviewBytes), content.params.get('charset') || 'utf-8', warn);
            return content.type === 'text/html' ? { text: '', html: text, htmlResources: [] } : { text, html: '', htmlResources: [] };
        };
        const body = readPart(root.headers, root.body, 0);
        const value = (name: string) => headerValue(root.headers, name);
        const document: EmlDocument = { headers: root.headers, subject: value('subject'), from: value('from'), to: value('to'), cc: value('cc'), bcc: value('bcc'), replyTo: value('reply-to'), date: value('date'), messageId: value('message-id'), ...body, attachments };
        check();
        return { result: { status: diagnostics.length ? 'partial' : 'ok', document, diagnostics }, execution: execution() };
    } catch (error) {
        if (!(error instanceof EmlFailure)) throw error;
        return { result: { status: 'failed', failure: { code: error.code, retryable: false, messageKey: `diag.eml.${error.code}` }, diagnostics }, execution: execution() };
    }
}
