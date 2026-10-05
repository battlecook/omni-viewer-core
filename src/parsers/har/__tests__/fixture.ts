// HAR fixtures shared by the parser and viewer tests. Written as text rather
// than built from objects so the bytes a test parses are the bytes a reader
// sees — including the quirks real writers produce (a quoted status, a
// base64 body, a request that never got a response).

export interface HarEntryFixture {
    startedDateTime?: string;
    time?: number;
    method?: string;
    url?: string;
    status?: number | string;
    statusText?: string;
    mimeType?: string;
    resourceType?: string;
    text?: string;
    encoding?: string;
    size?: number;
    headersSize?: number;
    bodySize?: number;
    transferSize?: number;
    requestHeaders?: Array<[string, string]>;
    responseHeaders?: Array<[string, string]>;
    responseCookies?: Array<[string, string]>;
    postData?: { mimeType: string; text?: string; params?: Array<[string, string]> };
    timings?: Partial<Record<'blocked' | 'dns' | 'connect' | 'ssl' | 'send' | 'wait' | 'receive', number>>;
    pageref?: string;
    error?: string;
    serverIPAddress?: string;
    /** `_fromCache` as a writer emits it: a boolean, or 'memory' / 'disk'. */
    fromCache?: boolean | string;
    /** Raw `cache` object JSON, for the beforeRequest / afterRequest split. */
    cache?: string;
}

const nameValues = (pairs: Array<[string, string]> = []): string =>
    JSON.stringify(pairs.map(([name, value]) => ({ name, value })));

/** One `log.entries` element, with the fields a writer always emits. */
export function harEntry(fixture: HarEntryFixture = {}): string {
    const {
        startedDateTime = '2026-03-01T10:00:00.000Z', time = 120, method = 'GET',
        url = 'https://example.com/', status = 200, statusText = 'OK',
        mimeType = 'text/html; charset=utf-8', resourceType, text, encoding, size = 1024,
        headersSize = 220, bodySize = 1024, transferSize, requestHeaders, responseHeaders, responseCookies,
        postData, timings = { blocked: 1, dns: 4, connect: 20, ssl: 12, send: 2, wait: 80, receive: 13 },
        pageref = 'page_1', error, serverIPAddress = '93.184.216.34', fromCache, cache = '{}'
    } = fixture;
    const content: string[] = [`"size":${size}`, `"mimeType":${JSON.stringify(mimeType)}`];
    if (text !== undefined) content.push(`"text":${JSON.stringify(text)}`);
    if (encoding !== undefined) content.push(`"encoding":${JSON.stringify(encoding)}`);
    const fields: string[] = [
        `"startedDateTime":${JSON.stringify(startedDateTime)}`,
        `"time":${time}`,
        `"pageref":${JSON.stringify(pageref)}`,
        `"serverIPAddress":${JSON.stringify(serverIPAddress)}`,
        `"request":{"method":${JSON.stringify(method)},"url":${JSON.stringify(url)},"httpVersion":"http/2.0",` +
            `"headers":${nameValues(requestHeaders)},"queryString":${nameValues(queryOf(url))},"cookies":[],` +
            `"headersSize":180,"bodySize":${postData?.text ? postData.text.length : 0}` +
            (postData ? `,"postData":{"mimeType":${JSON.stringify(postData.mimeType)}` +
                (postData.text === undefined ? '' : `,"text":${JSON.stringify(postData.text)}`) +
                (postData.params ? `,"params":${nameValues(postData.params)}` : '') + '}' : '') + '}',
        `"response":{"status":${typeof status === 'string' ? JSON.stringify(status) : status},` +
            `"statusText":${JSON.stringify(statusText)},"httpVersion":"http/2.0",` +
            `"headers":${nameValues(responseHeaders)},"cookies":${nameValues(responseCookies)},"content":{${content.join(',')}},` +
            `"redirectURL":"","headersSize":${headersSize},"bodySize":${bodySize}` +
            // Where Chrome DevTools and Playwright write these two.
            (transferSize === undefined ? '' : `,"_transferSize":${transferSize}`) +
            (error === undefined ? '' : `,"_error":${JSON.stringify(error)}`) + '}',
        `"cache":${cache}`,
        `"timings":{${Object.entries(timings).map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(',')}}`
    ];
    if (resourceType !== undefined) fields.push(`"_resourceType":${JSON.stringify(resourceType)}`);
    if (fromCache !== undefined) fields.push(`"_fromCache":${JSON.stringify(fromCache)}`);
    return `{${fields.join(',')}}`;
}

function queryOf(url: string): Array<[string, string]> {
    const query = url.split('?')[1];
    if (!query) return [];
    return query.split('&').map(pair => {
        const [name = '', value = ''] = pair.split('=', 2);
        return [name, value] as [string, string];
    });
}

export function harLog(entries: string[], options: { version?: string; pages?: boolean } = {}): string {
    const { version = '1.2', pages = true } = options;
    const pageJson = pages
        ? '"pages":[{"id":"page_1","title":"https://example.com/","startedDateTime":"2026-03-01T10:00:00.000Z",' +
          '"pageTimings":{"onContentLoad":310.5,"onLoad":842.25}}],'
        : '';
    return `{"log":{"version":${JSON.stringify(version)},` +
        '"creator":{"name":"WebInspector","version":"537.36"},' +
        '"browser":{"name":"Chrome","version":"140.0"},' +
        `${pageJson}"entries":[${entries.join(',')}]}}`;
}

/** A session that covers every status class, resource type, and body shape the
 *  viewer renders differently. */
export function harFixture(): Uint8Array {
    return new TextEncoder().encode(harFixtureText());
}

export function harFixtureText(): string {
    return harLog([
        harEntry({}),
        harEntry({
            startedDateTime: '2026-03-01T10:00:00.200Z', time: 60, url: 'https://cdn.example.com/assets/app.css',
            mimeType: 'text/css', size: 2048, bodySize: 900, transferSize: 1100,
            text: 'body{margin:0}', timings: { blocked: 0, dns: -1, connect: -1, ssl: -1, send: 1, wait: 40, receive: 19 }
        }),
        harEntry({
            startedDateTime: '2026-03-01T10:00:00.400Z', time: 240, url: 'https://api.example.com/v1/items?page=2&limit=20',
            status: '404', statusText: 'Not Found', mimeType: 'application/json', size: 48,
            text: '{"error":"not found","code":404}', resourceType: 'fetch',
            responseHeaders: [['content-type', 'application/json'], ['x-request-id', 'abc-123']],
            timings: { blocked: 2, dns: 0, connect: 0, ssl: 0, send: 1, wait: 200, receive: 37 }
        }),
        harEntry({
            startedDateTime: '2026-03-01T10:00:00.700Z', time: 500, method: 'post',
            url: 'https://api.example.com/v1/items', status: 500, statusText: 'Internal Server Error',
            mimeType: 'application/json', size: 30, text: '{"error":"boom"}', resourceType: 'xhr',
            postData: { mimeType: 'application/x-www-form-urlencoded', text: 'name=widget&qty=3', params: [['name', 'widget'], ['qty', '3']] },
            timings: { blocked: 1, dns: -1, connect: -1, ssl: -1, send: 3, wait: 480, receive: 16 }
        }),
        harEntry({
            startedDateTime: '2026-03-01T10:00:01.000Z', time: 90, url: 'https://cdn.example.com/logo.png',
            mimeType: 'image/png', size: 5120, bodySize: 5120, text: 'iVBORw0KGgo=', encoding: 'base64'
        }),
        harEntry({
            startedDateTime: '2026-03-01T10:00:01.100Z', time: 35, url: 'https://api.example.com/v1/config',
            mimeType: 'application/json', size: 20, encoding: 'base64',
            text: 'eyJvayI6dHJ1ZX0=', // base64 of {"ok":true}
            resourceType: 'fetch'
        }),
        harEntry({
            startedDateTime: '2026-03-01T10:00:01.300Z', time: -1, url: 'https://down.example.com/ping',
            status: 0, statusText: '', mimeType: 'x-unknown', size: 0, bodySize: -1, headersSize: -1,
            error: 'net::ERR_CONNECTION_REFUSED', timings: {}
        }),
        harEntry({
            startedDateTime: '2026-03-01T10:00:01.400Z', time: 15, url: 'wss://live.example.com/socket',
            status: 101, statusText: 'Switching Protocols', mimeType: 'x-unknown', size: 0, bodySize: 0
        })
    ]);
}
