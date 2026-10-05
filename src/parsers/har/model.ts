// HAR document model (HTTP Archive 1.2). The model is derived entirely from the
// archive's own fields plus deterministic classification of them — no clock, no
// locale, no network — so the same bytes yield the same document everywhere
// (DESIGN.md §3-① determinism rule).

/** One `name`/`value` pair: a header, a query parameter, or a form field. */
export interface HarNameValue {
    name: string;
    value: string;
}

export interface HarCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    /** Verbatim `expires` text — dates are never reformatted (ADR 29/41). */
    expires: string;
    httpOnly: boolean;
    secure: boolean;
}

/** Status classes the viewer filters by; `none` covers a request that never
 *  got a response (status 0, the shape a failed or aborted request takes). */
export type HarStatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'none';

/** Coarse resource kind, from `_resourceType` when the writer supplied one and
 *  from the MIME type and URL otherwise. */
export type HarResourceType =
    | 'document' | 'stylesheet' | 'script' | 'xhr' | 'image' | 'font'
    | 'media' | 'websocket' | 'manifest' | 'text' | 'binary' | 'other';

/** A request or response body, held as text only up to the preview limit. */
export interface HarBody {
    mimeType: string;
    /** Body size in bytes as the archive reports it — `content.size` for a
     *  response, `request.bodySize` for a request body (the UTF-8 length of the
     *  stored text when the archive states neither). -1 = unknown. */
    size: number;
    /** Decoded text, truncated to the preview limit. Empty for a binary body. */
    text: string;
    /** Characters dropped by the preview limit. */
    truncated: boolean;
    /** The stored body ended before its content did — a base64 field that is
     *  several padded chunks, or whose tail is outside the alphabet. Distinct
     *  from `truncated`: nothing about the preview limit is involved. */
    incomplete: boolean;
    /** The body was base64 in the archive and holds bytes, not text. */
    binary: boolean;
    /** `content.encoding` as written (usually '' or 'base64'). */
    encoding: string;
    /** `content.compression` (bytes saved), when the archive reports it. */
    compression: number | null;
    /** Form fields of an `application/x-www-form-urlencoded` request body. */
    params: readonly HarNameValue[];
    /** Set when the text is JSON the viewer can pretty-print. */
    json: boolean;
}

export type HarTimingKind = 'blocked' | 'dns' | 'connect' | 'ssl' | 'send' | 'wait' | 'receive';

/** A phase with a non-negative duration. Phases the archive marks as `-1`
 *  (not applicable) are left out rather than drawn as zero-width slivers. */
export interface HarTimingPhase {
    kind: HarTimingKind;
    millis: number;
}

export interface HarTimings {
    blocked: number;
    dns: number;
    connect: number;
    ssl: number;
    send: number;
    wait: number;
    receive: number;
    /** Sum of the applicable phases; 0 when the archive timed nothing. */
    total: number;
    phases: readonly HarTimingPhase[];
}

export interface HarEntry {
    /** Position in the archive (stable id for selection). */
    index: number;
    startedDateTime: string;
    /** Epoch millis from a deterministic ISO-8601 parse; null when unparseable. */
    startedMillis: number | null;
    /** Millis after the earliest timed entry — the waterfall's x origin. */
    offsetMillis: number;
    /** `entry.time` as written (-1 = unknown). */
    time: number;
    method: string;
    url: string;
    /** Host of `url`, or '' when the URL has no parseable authority. */
    host: string;
    scheme: string;
    /** Path of `url` without the query string. */
    path: string;
    query: string;
    /** Last path segment (or the host) — the table's short name. */
    name: string;
    httpVersion: string;
    status: number;
    statusText: string;
    statusClass: HarStatusClass;
    resourceType: HarResourceType;
    mimeType: string;
    requestHeaders: readonly HarNameValue[];
    responseHeaders: readonly HarNameValue[];
    queryString: readonly HarNameValue[];
    requestCookies: readonly HarCookie[];
    responseCookies: readonly HarCookie[];
    requestBody: HarBody | null;
    responseBody: HarBody;
    requestHeadersSize: number;
    requestBodySize: number;
    responseHeadersSize: number;
    responseBodySize: number;
    /** Bytes on the wire: `_transferSize` when present, else the reported sizes. */
    transferredBytes: number;
    /** Whether the archive reported a transfer size at all for this entry; an
     *  HTTP/2 entry with no `_transferSize` reports `-1/-1` and knows nothing. */
    transferredKnown: boolean;
    /** Decoded body size (`content.size`); -1 when the archive omits it, so an
     *  unknown size is never shown as a confident 0 B. */
    resourceBytes: number;
    /** The response came from a cache rather than the network: `_fromCache`
     *  ('memory' / 'disk' / a boolean) when the writer set it, otherwise a
     *  `cache.beforeRequest` entry. */
    fromCache: boolean;
    redirectUrl: string;
    serverIpAddress: string;
    connection: string;
    pageRef: string;
    timings: HarTimings;
    /** `_error` / `response._error`, the field writers use for a failed request. */
    error: string;
    comment: string;
}

export interface HarPage {
    id: string;
    title: string;
    startedDateTime: string;
    startedMillis: number | null;
    /** `pageTimings.onContentLoad` / `onLoad` (-1 = not measured). */
    onContentLoad: number;
    onLoad: number;
    /** Entries whose `pageref` names this page. */
    entryCount: number;
}

export interface HarCreator {
    name: string;
    version: string;
    comment: string;
}

/** One headline figure; `labelKey` is a catalog key, never a sentence. */
export interface HarSummaryItem {
    labelKey: string;
    value: string;
}

export interface HarDocument {
    /** `log.version` as written ('' when the archive omits it). */
    version: string;
    creator: HarCreator;
    browser: HarCreator | null;
    pages: readonly HarPage[];
    entries: readonly HarEntry[];
    /** Entries in the archive, including any the entry limit dropped. */
    totalEntries: number;
    summary: readonly HarSummaryItem[];
    /** Filter vocabularies, in the order the viewer offers them. */
    hosts: readonly string[];
    methods: readonly string[];
    resourceTypes: readonly HarResourceType[];
    statusClasses: readonly HarStatusClass[];
    /** Earliest start and latest end across timed entries (null when none). */
    timelineStartMillis: number | null;
    timelineSpanMillis: number;
    /** Sum of `entry.time` over entries that report one. */
    totalTimeMillis: number;
    /** Wire and decoded byte totals; -1 when no entry in the archive reported
     *  the figure, so an unknown total is never shown as a confident 0 B. */
    transferredBytes: number;
    resourceBytes: number;
    errorCount: number;
    comment: string;
}
