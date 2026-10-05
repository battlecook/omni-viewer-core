// HAR (HTTP Archive 1.2) parser — a contract parser (DESIGN.md §3-①):
// bytes or text in, `ParseOutcome<HarDocument>` out, input-caused failures
// returned as `status: 'failed'` instead of thrown.
//
// The archive is JSON, so the core JSON parser does the tokenizing (ADR 41 —
// never JSON.parse: duplicate keys, big numbers, and recovery of a truncated
// archive all have to behave identically on every engine). Everything above
// that is field reading and deterministic classification: timestamps go
// through a core ISO-8601 parser rather than `new Date(string)`, byte and
// duration labels are formatted without `Intl`, and nothing is read from the
// clock or the network.

import { asciiLower } from '../csv/index.js';
import { parseJson, type JsonNode } from '../json/index.js';
import type { Diagnostic, ParseOptions, ParseOutcome, ParseResult } from '../types.js';
import { DEFAULT_LIMITS, LimitTracker, decodeUtf8, utf8ByteLength } from '../types.js';
import type {
    HarBody,
    HarCookie,
    HarCreator,
    HarDocument,
    HarEntry,
    HarNameValue,
    HarPage,
    HarResourceType,
    HarStatusClass,
    HarSummaryItem,
    HarTimingKind,
    HarTimingPhase,
    HarTimings
} from './model.js';

export type {
    HarBody,
    HarCookie,
    HarCreator,
    HarDocument,
    HarEntry,
    HarNameValue,
    HarPage,
    HarResourceType,
    HarStatusClass,
    HarSummaryItem,
    HarTimingKind,
    HarTimingPhase,
    HarTimings
} from './model.js';

/** Input ownership: borrows the input; the caller keeps the bytes (DESIGN §3-①). */
export const HAR_INPUT_OWNERSHIP = 'borrows' as const;

/** Entries kept by default. An archive from a long session can hold hundreds of
 *  thousands of requests; the generic 1,000,000-entry default would let one
 *  build a model no viewer can show. */
export const HAR_DEFAULT_MAX_ENTRIES = 20_000;

/** Characters kept per body preview. Bodies are the bulk of an archive's size,
 *  and the detail pane shows a preview, not a file. */
export const HAR_DEFAULT_MAX_BODY_CHARS = 64 * 1024;

/** ASCII-only upper-casing — the locale-dependent `toUpperCase()` would fold
 *  a Turkish dotless `ı` differently per engine (DESIGN.md §3-①, ADR 41).
 *  `asciiLower` is the shared util; only the upper direction is missing. */
function asciiUpper(value: string): string {
    let out = '';
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        out += code >= 0x61 && code <= 0x7a ? String.fromCharCode(code - 32) : value[i];
    }
    return out;
}

/** Entries between cooperative abort/time checkpoints. */
const CHECKPOINT_INTERVAL = 64;

export interface HarParseOptions extends ParseOptions {
    /** Characters kept per request/response body (default HAR_DEFAULT_MAX_BODY_CHARS). */
    maxBodyChars?: number;
}

export function parseHar(
    input: Uint8Array | string,
    options: HarParseOptions = {}
): ParseOutcome<HarDocument> {
    const started = Date.now();
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    const maxEntries = options.limits?.maxEntries ?? HAR_DEFAULT_MAX_ENTRIES;
    const maxBodyChars = options.maxBodyChars ?? options.limits?.maxPreviewBytes ?? HAR_DEFAULT_MAX_BODY_CHARS;
    const diagnostics: Diagnostic[] = [];
    const finish = (result: ParseResult<HarDocument>): ParseOutcome<HarDocument> => ({
        result,
        execution: { workerUsed: false, hardLimitEnforced: false, elapsedMillis: Date.now() - started }
    });
    const fail = (
        code: 'invalid-format' | 'limit-exceeded' | 'aborted',
        messageKey: string,
        args?: Record<string, string | number>
    ): ParseOutcome<HarDocument> =>
        finish({
            status: 'failed',
            failure: { code, retryable: code === 'aborted', messageKey, ...(args ? { args } : {}) },
            diagnostics
        });

    const inputBytes = typeof input === 'string' ? utf8ByteLength(input) : input.byteLength;
    if (inputBytes > limits.maxInputBytes) {
        return fail('limit-exceeded', 'diag.limit-exceeded.input', { maxBytes: limits.maxInputBytes });
    }
    if (options.signal?.aborted) return fail('aborted', 'diag.aborted');

    const text = typeof input === 'string' ? input : decodeUtf8(input);
    // A truncated archive (the common way a HAR arrives broken) still parses to
    // a partial tree, and the entries it did hold are worth showing.
    // The JSON layer counts *nodes*, so it gets its own budget: `maxEntries`
    // here means HAR entries, and handing it straight to the JSON parser would
    // stop the tokenizer after a couple of requests. The node budget scales
    // with the entry cap (an entry is a hundred-odd nodes with its headers).
    const json = parseJson(text, {
        ...(options.signal ? { signal: options.signal } : {}),
        limits: {
            ...options.limits,
            maxEntries: Math.max(DEFAULT_LIMITS.maxEntries, maxEntries * 150)
        }
    });
    diagnostics.push(...json.result.diagnostics);
    if (json.result.status === 'failed') {
        return fail(json.result.failure.code === 'aborted' ? 'aborted' : 'invalid-format', 'diag.har.invalid');
    }
    let partial = json.result.status === 'partial';

    const log = field(json.result.document.root, 'log');
    if (!log || log.kind !== 'object') return fail('invalid-format', 'diag.har.missing-log');
    const entryNodes = field(log, 'entries');
    if (!entryNodes || entryNodes.kind !== 'array') return fail('invalid-format', 'diag.har.missing-entries');

    const version = textOf(field(log, 'version'));
    if (version && version !== '1.2' && version !== '1.1') {
        diagnostics.push({ severity: 'info', code: 'har.version', messageKey: 'diag.har.version', args: { version } });
    }

    const tracker = new LimitTracker(limits, options.signal);
    const entries: HarEntry[] = [];
    const nodes = entryNodes.children ?? [];
    let skipped = 0;
    let badDates = 0;
    let truncatedBodies = 0;
    let incompleteBodies = 0;
    let binaryBodies = 0;
    let errorCount = 0;
    let requestErrors = 0;
    let transferredBytes = 0;
    let resourceBytes = 0;
    // Whether *any* entry reported the figure, so an archive that reports none
    // (Apple's AMSEverywhere writes -1/-1 and no _transferSize) says so.
    let transferredKnown = false;
    let resourceKnown = false;
    let totalTimeMillis = 0;

    for (const node of nodes) {
        if (entries.length % CHECKPOINT_INTERVAL === 0) {
            const violation = tracker.checkpoint();
            if (violation?.kind === 'aborted') return fail('aborted', 'diag.aborted');
            if (violation) { partial = true; break; }
        }
        if (node.kind !== 'object') { skipped++; continue; }
        if (entries.length >= maxEntries) { partial = true; break; }
        const entry = readEntry(node, entries.length, maxBodyChars);
        tracker.addEntries(1);
        entries.push(entry);
        if (entry.startedDateTime && entry.startedMillis === null) badDates++;
        if (entry.responseBody.truncated || entry.requestBody?.truncated) truncatedBodies++;
        if (entry.responseBody.incomplete) incompleteBodies++;
        if (entry.responseBody.binary) binaryBodies++;
        if (entry.statusClass === '4xx' || entry.statusClass === '5xx') errorCount++;
        if (entry.error) { requestErrors++; if (entry.statusClass === 'none') errorCount++; }
        if (entry.time > 0) totalTimeMillis += entry.time;
        transferredBytes += entry.transferredBytes;
        if (entry.transferredKnown) transferredKnown = true;
        resourceBytes += Math.max(0, entry.resourceBytes);
        if (entry.resourceBytes >= 0) resourceKnown = true;
    }

    const dropped = nodes.length - entries.length - skipped;
    if (dropped > 0) {
        diagnostics.push({ severity: 'warning', code: 'har.entry-limit', messageKey: 'diag.har.entry-limit', args: { shown: entries.length, total: nodes.length } });
    }
    if (skipped > 0) {
        diagnostics.push({ severity: 'warning', code: 'har.invalid-entries', messageKey: 'diag.har.invalid-entries', args: { count: skipped } });
    }
    if (entries.length === 0) {
        diagnostics.push({ severity: 'warning', code: 'har.no-entries', messageKey: 'diag.har.no-entries' });
    }
    if (badDates > 0) {
        diagnostics.push({ severity: 'warning', code: 'har.invalid-dates', messageKey: 'diag.har.invalid-dates', args: { count: badDates } });
    }
    if (truncatedBodies > 0) {
        diagnostics.push({ severity: 'info', code: 'har.body-truncated', messageKey: 'diag.har.body-truncated', args: { count: truncatedBodies, limit: maxBodyChars } });
    }
    if (incompleteBodies > 0) {
        diagnostics.push({ severity: 'warning', code: 'har.body-incomplete', messageKey: 'diag.har.body-incomplete', args: { count: incompleteBodies } });
    }
    if (binaryBodies > 0) {
        diagnostics.push({ severity: 'info', code: 'har.binary-bodies', messageKey: 'diag.har.binary-bodies', args: { count: binaryBodies } });
    }
    if (requestErrors > 0) {
        diagnostics.push({ severity: 'warning', code: 'har.request-errors', messageKey: 'diag.har.request-errors', args: { count: requestErrors } });
    }

    // The waterfall's origin is the earliest start, and its span reaches the
    // latest end — an entry that started last can still finish first.
    let timelineStartMillis: number | null = null;
    let timelineEndMillis: number | null = null;
    for (const entry of entries) {
        if (entry.startedMillis === null) continue;
        const end = entry.startedMillis + Math.max(0, entry.time > 0 ? entry.time : entry.timings.total);
        if (timelineStartMillis === null || entry.startedMillis < timelineStartMillis) timelineStartMillis = entry.startedMillis;
        if (timelineEndMillis === null || end > timelineEndMillis) timelineEndMillis = end;
    }
    if (timelineStartMillis !== null) {
        for (const entry of entries) {
            if (entry.startedMillis !== null) entry.offsetMillis = entry.startedMillis - timelineStartMillis;
        }
    }
    const timelineSpanMillis = timelineStartMillis !== null && timelineEndMillis !== null
        ? Math.max(0, timelineEndMillis - timelineStartMillis)
        : 0;

    const pageCounts = new Map<string, number>();
    for (const entry of entries) {
        if (entry.pageRef) pageCounts.set(entry.pageRef, (pageCounts.get(entry.pageRef) ?? 0) + 1);
    }
    const pageNodes = field(log, 'pages');
    const pages: HarPage[] = (pageNodes?.kind === 'array' ? pageNodes.children ?? [] : [])
        .filter(node => node.kind === 'object')
        .map(node => {
            const timings = field(node, 'pageTimings');
            const id = textOf(field(node, 'id'));
            return {
                id,
                title: textOf(field(node, 'title')),
                startedDateTime: textOf(field(node, 'startedDateTime')),
                startedMillis: parseIso8601Millis(textOf(field(node, 'startedDateTime'))),
                onContentLoad: numberOf(field(timings, 'onContentLoad'), -1),
                onLoad: numberOf(field(timings, 'onLoad'), -1),
                entryCount: pageCounts.get(id) ?? 0
            };
        });

    const hosts = [...new Set(entries.map(entry => entry.host).filter(host => host))].sort();
    const methods = [...new Set(entries.map(entry => entry.method).filter(method => method))].sort();
    const resourceTypes = RESOURCE_TYPES.filter(type => entries.some(entry => entry.resourceType === type));
    const statusClasses = STATUS_CLASSES.filter(klass => entries.some(entry => entry.statusClass === klass));

    const summary: HarSummaryItem[] = [
        { labelKey: 'har.summary.requests', value: dropped > 0 ? `${entries.length} / ${nodes.length}` : String(entries.length) },
        // Not `|| totalTimeMillis`: the sum of request times is a different
        // quantity (the Info tab lists it separately), and an archive with no
        // timed entry has no elapsed span to report.
        { labelKey: 'har.summary.elapsed', value: timelineStartMillis === null ? '—' : formatMillis(timelineSpanMillis) },
        { labelKey: 'har.summary.transferred', value: formatByteSize(transferredKnown ? transferredBytes : -1) },
        { labelKey: 'har.summary.resources', value: formatByteSize(resourceKnown ? resourceBytes : -1) },
        { labelKey: 'har.summary.domains', value: String(hosts.length) },
        { labelKey: 'har.summary.errors', value: String(errorCount) }
    ];
    if (pages.length) summary.push({ labelKey: 'har.summary.pages', value: String(pages.length) });

    const browserNode = field(log, 'browser');
    const document: HarDocument = {
        version,
        creator: readCreator(field(log, 'creator')),
        browser: browserNode?.kind === 'object' ? readCreator(browserNode) : null,
        pages,
        entries,
        totalEntries: nodes.length,
        summary,
        hosts,
        methods,
        resourceTypes,
        statusClasses,
        timelineStartMillis,
        timelineSpanMillis,
        totalTimeMillis,
        transferredBytes: transferredKnown ? transferredBytes : -1,
        resourceBytes: resourceKnown ? resourceBytes : -1,
        errorCount,
        comment: textOf(field(log, 'comment'))
    };
    return finish({ status: partial ? 'partial' : 'ok', document, diagnostics });
}

const RESOURCE_TYPES: readonly HarResourceType[] = [
    'document', 'stylesheet', 'script', 'xhr', 'image', 'font', 'media', 'websocket', 'manifest', 'text', 'binary', 'other'
];
const STATUS_CLASSES: readonly HarStatusClass[] = ['2xx', '3xx', '4xx', '5xx', '1xx', 'none'];

/** `_resourceType` values writers emit, mapped onto the model's vocabulary. A
 *  Map, not an object literal: the key comes from the archive, and a plain
 *  lookup would let `constructor` or `__proto__` answer with an inherited
 *  member that is not a resource type at all. */
const RESOURCE_TYPE_HINTS = new Map<string, HarResourceType>(Object.entries({
    document: 'document', doc: 'document', main_frame: 'document', subdocument: 'document', signedexchange: 'document',
    stylesheet: 'stylesheet', css: 'stylesheet',
    script: 'script', js: 'script',
    xhr: 'xhr', fetch: 'xhr', eventsource: 'xhr', beacon: 'xhr',
    image: 'image', img: 'image',
    font: 'font',
    media: 'media', texttrack: 'media',
    websocket: 'websocket', ws: 'websocket',
    manifest: 'manifest',
    other: 'other', ping: 'other', preflight: 'other'
} as const));

function readCreator(node: JsonNode | undefined): HarCreator {
    return {
        name: textOf(field(node, 'name')),
        version: textOf(field(node, 'version')),
        comment: textOf(field(node, 'comment'))
    };
}

function readEntry(node: JsonNode, index: number, maxBodyChars: number): HarEntry {
    const request = field(node, 'request');
    const response = field(node, 'response');
    const content = field(response, 'content');
    const url = textOf(field(request, 'url'));
    const parts = splitUrl(url);
    const status = numberOf(field(response, 'status'), 0);
    const mimeType = textOf(field(content, 'mimeType'));
    const postData = field(request, 'postData');
    // Chrome DevTools and Playwright write `_transferSize` inside `response`,
    // next to `_error`; only `_fromCache`, `_resourceType`, `_initiator` and
    // `_priority` are entry-level. Both placements are accepted, because an
    // archive rewritten by a proxy or a test harness can carry either.
    const transferSize = numberOf(field(response, '_transferSize') ?? field(node, '_transferSize'), NaN);
    const responseHeadersSize = numberOf(field(response, 'headersSize'), -1);
    const responseBodySize = numberOf(field(response, 'bodySize'), -1);
    const resourceBytes = numberOf(field(content, 'size'), -1);
    const timings = readTimings(field(node, 'timings'));
    const cache = field(node, 'cache');

    return {
        index,
        startedDateTime: textOf(field(node, 'startedDateTime')),
        startedMillis: parseIso8601Millis(textOf(field(node, 'startedDateTime'))),
        offsetMillis: 0,
        time: numberOf(field(node, 'time'), -1),
        method: asciiUpper(textOf(field(request, 'method'))),
        url,
        host: parts.host,
        scheme: parts.scheme,
        path: parts.path,
        query: parts.query,
        name: entryName(parts, url),
        httpVersion: textOf(field(response, 'httpVersion')) || textOf(field(request, 'httpVersion')),
        status,
        statusText: textOf(field(response, 'statusText')),
        statusClass: statusClassOf(status),
        resourceType: resourceTypeOf(textOf(field(node, '_resourceType')), mimeType, parts),
        mimeType,
        requestHeaders: readNameValues(field(request, 'headers')),
        responseHeaders: readNameValues(field(response, 'headers')),
        queryString: readNameValues(field(request, 'queryString')),
        requestCookies: readCookies(field(request, 'cookies')),
        responseCookies: readCookies(field(response, 'cookies')),
        requestBody: postData?.kind === 'object'
            ? readRequestBody(postData, numberOf(field(request, 'bodySize'), -1), maxBodyChars)
            : null,
        responseBody: readResponseBody(content, maxBodyChars),
        requestHeadersSize: numberOf(field(request, 'headersSize'), -1),
        requestBodySize: numberOf(field(request, 'bodySize'), -1),
        responseHeadersSize,
        responseBodySize,
        // `_transferSize` is the only field that counts compressed bytes plus
        // protocol overhead; the spec fields are the fallback, and a cached
        // response legitimately transfers nothing.
        transferredBytes: Number.isFinite(transferSize) && transferSize >= 0
            ? transferSize
            : Math.max(0, responseHeadersSize) + Math.max(0, responseBodySize),
        transferredKnown: (Number.isFinite(transferSize) && transferSize >= 0)
            || responseHeadersSize >= 0 || responseBodySize >= 0,
        resourceBytes,
        fromCache: readFromCache(node, cache),
        redirectUrl: textOf(field(response, 'redirectURL')),
        serverIpAddress: textOf(field(node, 'serverIPAddress')),
        connection: textOf(field(node, 'connection')),
        pageRef: textOf(field(node, 'pageref')),
        timings,
        error: textOf(field(node, '_error')) || textOf(field(response, '_error')),
        comment: textOf(field(node, 'comment'))
    };
}

/**
 * Whether the response came from a cache. `_fromCache` is the field writers
 * actually set ('memory' / 'disk' in Chromium, a boolean elsewhere). The spec's
 * `cache.beforeRequest` — the state of the cache entry *before* the request —
 * is the fallback; `cache.afterRequest` is not usable here, because a response
 * fetched from the network and then stored also has one.
 */
function readFromCache(node: JsonNode, cache: JsonNode | undefined): boolean {
    const marker = field(node, '_fromCache');
    if (marker?.kind === 'boolean') return marker.value === true;
    if (marker?.kind === 'string') {
        const value = asciiLower(String(marker.value ?? ''));
        return value !== '' && value !== 'false';
    }
    return field(cache, 'beforeRequest')?.kind === 'object';
}

function readNameValues(node: JsonNode | undefined): readonly HarNameValue[] {
    if (node?.kind !== 'array') return [];
    return (node.children ?? [])
        .filter(child => child.kind === 'object')
        .map(child => ({ name: textOf(field(child, 'name')), value: textOf(field(child, 'value')) }));
}

function readCookies(node: JsonNode | undefined): readonly HarCookie[] {
    if (node?.kind !== 'array') return [];
    return (node.children ?? [])
        .filter(child => child.kind === 'object')
        .map(child => ({
            name: textOf(field(child, 'name')),
            value: textOf(field(child, 'value')),
            domain: textOf(field(child, 'domain')),
            path: textOf(field(child, 'path')),
            expires: textOf(field(child, 'expires')),
            httpOnly: boolOf(field(child, 'httpOnly')),
            secure: boolOf(field(child, 'secure'))
        }));
}

function readRequestBody(node: JsonNode, bodySize: number, maxBodyChars: number): HarBody {
    const mimeType = textOf(field(node, 'mimeType'));
    const raw = textOf(field(node, 'text'));
    const text = clipText(raw, maxBodyChars);
    return {
        mimeType,
        // The archive's own `request.bodySize` is authoritative (it counts the
        // bytes sent); the UTF-8 length of the stored text is the fallback, and
        // never its UTF-16 `length`, which would under-report any non-ASCII body.
        size: bodySize >= 0 ? bodySize : raw ? utf8ByteLength(raw) : -1,
        text,
        truncated: raw.length > text.length,
        incomplete: false,
        binary: false,
        encoding: '',
        compression: null,
        params: readNameValues(field(node, 'params')),
        json: looksLikeJsonBody(mimeType, text)
    };
}

function readResponseBody(node: JsonNode | undefined, maxBodyChars: number): HarBody {
    const mimeType = textOf(field(node, 'mimeType'));
    const encoding = textOf(field(node, 'encoding'));
    const raw = textOf(field(node, 'text'));
    const compressionNode = field(node, 'compression');
    const textual = isTextualMime(mimeType);
    let text = '';
    let truncated = false;
    let incomplete = false;
    let binary = false;
    if (asciiLower(encoding) === 'base64') {
        // Base64 is how a writer stores bytes. Decoding it for a textual MIME
        // type is what makes a response readable; for anything else the bytes
        // are left alone and only their size is reported.
        if (textual) {
            const decoded = decodeBase64(raw, maxBodyChars);
            text = decoded.text;
            truncated = decoded.truncated;
            incomplete = decoded.incomplete;
            binary = !decoded.valid;
        } else {
            binary = true;
        }
    } else {
        text = clipText(raw, maxBodyChars);
        truncated = raw.length > text.length;
    }
    return {
        mimeType,
        size: numberOf(field(node, 'size'), -1),
        text,
        truncated,
        incomplete,
        binary,
        encoding,
        compression: compressionNode ? numberOf(compressionNode, 0) : null,
        params: [],
        json: !binary && looksLikeJsonBody(mimeType, text)
    };
}

function readTimings(node: JsonNode | undefined): HarTimings {
    const read = (key: HarTimingKind): number => numberOf(field(node, key), -1);
    const blocked = read('blocked');
    const dns = read('dns');
    const connect = read('connect');
    const ssl = read('ssl');
    const send = read('send');
    const wait = read('wait');
    const receive = read('receive');
    // `ssl` is contained in `connect` (HAR 1.2), so the drawn connect phase is
    // the handshake-free remainder — otherwise the bar double-counts it.
    const connectOnly = connect >= 0 && ssl >= 0 ? Math.max(0, connect - ssl) : connect;
    const phases: HarTimingPhase[] = [];
    const push = (kind: HarTimingKind, millis: number): void => {
        if (millis > 0) phases.push({ kind, millis });
    };
    push('blocked', blocked);
    push('dns', dns);
    push('connect', connectOnly);
    push('ssl', ssl);
    push('send', send);
    push('wait', wait);
    push('receive', receive);
    return {
        blocked, dns, connect, ssl, send, wait, receive,
        total: phases.reduce((sum, phase) => sum + phase.millis, 0),
        phases
    };
}

/* ── field readers over the JSON node tree ────────────────────────────────── */

/** First child with `key` — duplicate keys are kept by the parser, and the
 *  first wins here so a hand-edited archive reads the same way twice. */
function field(node: JsonNode | undefined, key: string): JsonNode | undefined {
    if (node?.kind !== 'object') return undefined;
    return node.children?.find(child => child.key === key);
}

/** Text of a scalar node. Numbers use their verbatim token so a large id or a
 *  high-precision duration is never rounded on the way through. */
function textOf(node: JsonNode | undefined): string {
    if (!node) return '';
    if (node.kind === 'string') return typeof node.value === 'string' ? node.value : '';
    if (node.kind === 'number') return node.rawNumber ?? '';
    if (node.kind === 'boolean') return node.value ? 'true' : 'false';
    return '';
}

function numberOf(node: JsonNode | undefined, fallback: number): number {
    if (!node) return fallback;
    // Writers do quote numbers (`"status": "200"`), so a numeric string counts.
    const raw = node.kind === 'number' ? node.rawNumber ?? '' : node.kind === 'string' ? String(node.value ?? '').trim() : '';
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

function boolOf(node: JsonNode | undefined): boolean {
    if (!node) return false;
    if (node.kind === 'boolean') return node.value === true;
    if (node.kind === 'string') return asciiLower(String(node.value ?? '')) === 'true';
    return false;
}

/* ── classification and formatting (all locale-free) ──────────────────────── */

export interface HarUrlParts {
    scheme: string;
    host: string;
    path: string;
    query: string;
}

/**
 * Split a URL without `new URL`: a malformed or relative URL in an archive must
 * yield parts rather than throw, and the path and query are never re-encoded —
 * the table has to show the request as it was made. Scheme and host *are*
 * ASCII-lowered, because both are case-insensitive: `WSS://` has to classify as
 * a WebSocket, and `API.example.com` must not open a second row in the domain
 * filter next to `api.example.com`.
 */
export function splitUrl(url: string): HarUrlParts {
    const match = /^([A-Za-z][A-Za-z0-9+.-]*):(\/\/)?([^/?#]*)([^?#]*)(?:\?([^#]*))?/.exec(url);
    if (!match) {
        // Relative URL. Split at the *first* `?` — `split('?', 2)` would drop
        // everything past a second one, and a query may legally contain it.
        return { scheme: '', host: '', ...splitPathQuery(url) };
    }
    const [, scheme, slashes, authority = '', path = '', query = ''] = match;
    if (!slashes) {
        // Opaque scheme (data:, blob:, mailto:) — nothing is an authority.
        return { scheme: asciiLower(scheme ?? ''), host: '', ...splitPathQuery(url.slice((scheme ?? '').length + 1)) };
    }
    const at = authority.lastIndexOf('@');
    return {
        scheme: asciiLower(scheme ?? ''),
        host: asciiLower(at < 0 ? authority : authority.slice(at + 1)),
        path: path || '/',
        query
    };
}

/**
 * Path and query of a URL with no authority, split at the first `?`. The
 * fragment is dropped, as it is for an absolute URL: it never reaches the
 * server, so it is not part of the request the table shows.
 */
function splitPathQuery(rest: string): { path: string; query: string } {
    const hash = rest.indexOf('#');
    const body = hash < 0 ? rest : rest.slice(0, hash);
    const at = body.indexOf('?');
    return at < 0 ? { path: body, query: '' } : { path: body.slice(0, at), query: body.slice(at + 1) };
}

/** Short label for the requests table: the last path segment, or the host. */
function entryName(parts: HarUrlParts, url: string): string {
    const segments = parts.path.split('/').filter(segment => segment.length > 0);
    const last = segments[segments.length - 1];
    if (last) return last;
    if (parts.host) return parts.host;
    return url.slice(0, 80);
}

export function statusClassOf(status: number): HarStatusClass {
    if (!Number.isFinite(status) || status <= 0) return 'none';
    const group = Math.floor(status / 100);
    return group >= 1 && group <= 5 ? (`${group}xx` as HarStatusClass) : 'none';
}

/** MIME type without its parameters, lower-cased (ASCII only — ADR 41). */
export function baseMimeType(mimeType: string): string {
    return asciiLower((mimeType.split(';', 1)[0] ?? '').trim());
}

/**
 * The MIME type for classification, with the writers' unknown-type sentinel
 * normalized away: Chrome DevTools (`buildContent()`: `mimeType: … ||
 * 'x-unknown'`) and Playwright both write `x-unknown` for a redirect, a failed
 * request, or any response with no body. Treating it as a media type would
 * classify every such entry as binary content.
 */
function classifiableMime(mimeType: string): string {
    const base = baseMimeType(mimeType);
    return base === 'x-unknown' || base === 'application/x-unknown' ? '' : base;
}

function isTextualMime(mimeType: string): boolean {
    const base = classifiableMime(mimeType);
    if (!base) return false;
    if (base.startsWith('text/')) return true;
    return /^application\/(?:json|.*\+json|javascript|x-javascript|ecmascript|xml|.*\+xml|x-www-form-urlencoded|graphql)$/.test(base)
        || base === 'image/svg+xml';
}

export function resourceTypeOf(hint: string, mimeType: string, parts: HarUrlParts): HarResourceType {
    const hinted = RESOURCE_TYPE_HINTS.get(baseMimeType(hint));
    if (hinted) return hinted;
    if (parts.scheme === 'ws' || parts.scheme === 'wss') return 'websocket';
    const base = classifiableMime(mimeType);
    if (base === 'text/html' || base === 'application/xhtml+xml') return 'document';
    if (base === 'text/css') return 'stylesheet';
    if (/javascript|ecmascript/.test(base)) return 'script';
    if (base === 'application/manifest+json' || base === 'application/x-web-app-manifest+json') return 'manifest';
    if (/^(?:application\/(?:json|.*\+json|xml|.*\+xml|graphql)|text\/xml)$/.test(base)) return 'xhr';
    if (base.startsWith('image/')) return 'image';
    if (base.startsWith('font/') || /font/.test(base)) return 'font';
    if (base.startsWith('audio/') || base.startsWith('video/')) return 'media';
    if (base.startsWith('text/')) return 'text';
    return base ? 'binary' : 'other';
}

/** A body the viewer can offer a pretty-printed JSON view of. The cheap shape
 *  test keeps a JSON-typed-but-not-JSON body (an error page, say) out; the
 *  viewer re-checks with the core parser before formatting. */
function looksLikeJsonBody(mimeType: string, text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const opens = trimmed.startsWith('{') || trimmed.startsWith('[');
    if (!opens) return false;
    const base = classifiableMime(mimeType);
    return /json|javascript/.test(base) || base === '' || base.startsWith('text/');
}

/**
 * Clip text to `max` code units without splitting a surrogate pair — a cut
 * between the halves of an emoji would leave a lone surrogate in the preview.
 */
function clipText(text: string, max: number): string {
    if (text.length <= max) return text;
    const last = text.charCodeAt(max - 1);
    return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Length to decode so the cut does not land inside a UTF-8 sequence: the
 * base64 ceiling is a whole number of quads (a 3-byte boundary), which a 2- or
 * 4-byte sequence straddles, and decoding a partial one yields U+FFFD.
 */
function completeUtf8Length(bytes: Uint8Array, length: number): number {
    let start = length - 1;
    let steps = 0;
    while (start >= 0 && (bytes[start]! & 0xc0) === 0x80 && steps < 3) { start--; steps++; }
    if (start < 0) return 0;
    const lead = bytes[start]!;
    const needed = lead < 0x80 ? 1
        : (lead & 0xe0) === 0xc0 ? 2
            : (lead & 0xf0) === 0xe0 ? 3
                : (lead & 0xf8) === 0xf0 ? 4
                    : 1;
    return start + needed <= length ? length : start;
}

/**
 * Decode base64 to UTF-8 text, deterministically and without `atob`/`Buffer`
 * (neither exists in every target engine). The URL-safe alphabet is accepted
 * too — tools that base64url-encode a JSON response would otherwise have it
 * reported as binary. Decoding stops at `maxChars` worth of input so a 20 MB
 * inlined image cannot be materialized for a preview, and a character outside
 * the alphabet stops the decode while keeping the bytes already read: a body
 * whose tail is corrupt is still worth showing.
 */
function decodeBase64(
    raw: string,
    maxChars: number
): { text: string; truncated: boolean; incomplete: boolean; valid: boolean } {
    const limit = maxChars * 4 / 3;
    const source = raw.length > limit ? raw.slice(0, Math.floor(limit / 4) * 4) : raw;
    const bytes = new Uint8Array(Math.floor(source.length * 3 / 4) + 3);
    let length = 0;
    let buffer = 0;
    let bits = 0;
    let stopped = false;
    for (let i = 0; i < source.length; i++) {
        const char = source[i]!;
        if (char === '=') {
            // Padding ends the stream. A writer that base64s per chunk emits
            // several padded chunks back to back, and what follows this one is
            // real content the preview is dropping — report it as truncated
            // rather than letting the body look complete.
            stopped = /[^=\s]/.test(source.slice(i + 1));
            break;
        }
        if (char === '\n' || char === '\r' || char === ' ' || char === '\t') continue;
        const value = BASE64_ALPHABET.indexOf(char === '-' ? '+' : char === '_' ? '/' : char);
        if (value < 0) { stopped = true; break; }
        buffer = (buffer << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes[length++] = (buffer >> bits) & 0xff;
        }
    }
    // Nothing decoded from a non-empty field means this was not base64 (a
    // leading `=` included) — the caller reports the body as bytes rather than
    // showing it as an empty one. An empty field really is an empty body.
    const cut = source.length < raw.length;
    if (length === 0) {
        // A ceiling below one quad admits nothing: that is the preview limit at
        // work, not a body that was never base64.
        if (cut) return { text: '', truncated: true, incomplete: false, valid: true };
        return { text: '', truncated: false, incomplete: false, valid: raw.trim() === '' };
    }
    const whole = completeUtf8Length(bytes, length);
    const text = decodeUtf8(bytes.subarray(0, whole));
    const clipped = clipText(text, maxChars);
    return {
        text: clipped,
        truncated: cut || clipped.length < text.length,
        // `=` is normal termination (padding); `stopped` means content followed
        // it or a character outside the alphabet did. A trailing partial UTF-8
        // sequence only counts when the limit did not cause it.
        incomplete: stopped || (!cut && whole < length),
        valid: true
    };
}

/**
 * Epoch millis from an ISO-8601 timestamp, without `new Date(string)` (whose
 * result is implementation- and timezone-dependent — DESIGN.md §3-①). A
 * timestamp with no offset is read as UTC, which is what HAR 1.2 requires.
 * Returns null for anything it cannot read, so the caller can report it.
 */
export function parseIso8601Millis(value: string): number | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(?:([Zz])|([+-])(\d{2}):?(\d{2}))?$/
        .exec(value.trim());
    if (!match) return null;
    const [, year, month, day, hour, minute, second = '0', fraction = '', , sign, offsetHour, offsetMinute] = match;
    const y = Number(year), mo = Number(month), d = Number(day);
    const h = Number(hour), mi = Number(minute), s = Number(second);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
    if (d > daysInMonth(y, mo)) return null;
    const millis = Number((fraction + '000').slice(0, 3));
    // Built field by field rather than with Date.UTC, whose legacy two-digit
    // window would remap year 0001 (what a .NET writer emits for an unset
    // DateTime) to 1901. `new Date(0)` is an epoch, not a parsed string, so the
    // determinism rule still holds.
    const date = new Date(0);
    date.setUTCFullYear(y, mo - 1, d);
    date.setUTCHours(h, mi, Math.min(s, 59), millis);
    let epoch = date.getTime();
    if (!Number.isFinite(epoch)) return null;
    if (sign) {
        const offset = Number(offsetHour) * 60 + Number(offsetMinute);
        if (Number(offsetHour) > 23 || Number(offsetMinute) > 59) return null;
        epoch += (sign === '-' ? 1 : -1) * offset * 60_000;
    }
    return epoch;
}

function daysInMonth(year: number, month: number): number {
    if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
    return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Byte count with a fixed unit table — never `toLocaleString` (ADR 29). */
export function formatByteSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    // `Math.round`, not `bytes`, decides whether this stays in bytes: 1023.5
    // rounds to the 1024 that belongs in the next unit.
    if (Math.round(bytes) < 1024) return `${Math.round(bytes)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    const digits = (value: number): number => value < 10 ? 2 : 1;
    let scaled = bytes / 1024;
    let unit = 0;
    // The *rounded* label decides the unit: 1048575 B is 1023.999 KB, which
    // prints as "1024.0 KB" — a value that belongs in the next unit up.
    while (unit < units.length - 1 && Number(scaled.toFixed(digits(scaled))) >= 1024) {
        scaled /= 1024;
        unit++;
    }
    return `${scaled.toFixed(digits(scaled))} ${units[unit]}`;
}

/**
 * Duration label: sub-second in ms, then seconds, then minutes, then hours — a
 * session-long archive (32 hours is a real shape) must not read "1919m 59s".
 * Every rung
 * hands off on its own *rounded* label rather than on the raw value, the same
 * rule formatByteSize follows — 999.5 ms is "1000 ms" rounded, which belongs in
 * seconds, and 59999.5 ms is "60.00 s", which belongs in minutes.
 */
export function formatMillis(millis: number): string {
    if (!Number.isFinite(millis) || millis < 0) return '—';
    if (millis === 0) return '0 ms';
    if (millis < 1) return `${millis.toFixed(2)} ms`;
    if (millis < 10) return `${millis.toFixed(1)} ms`;
    if (Math.round(millis) < 1000) return `${Math.round(millis)} ms`;
    const seconds = Number((millis / 1000).toFixed(2));
    if (seconds < 60) return `${seconds.toFixed(2)} s`;
    // Whole seconds *before* splitting, so a remainder of 59.5 s carries into
    // the minute instead of printing as "1m 60s".
    const wholeSeconds = Math.round(millis / 1000);
    if (wholeSeconds < 3600) return `${Math.floor(wholeSeconds / 60)}m ${wholeSeconds % 60}s`;
    // Hours and minutes: seconds are noise at this scale.
    return `${Math.floor(wholeSeconds / 3600)}h ${Math.floor((wholeSeconds % 3600) / 60)}m`;
}
