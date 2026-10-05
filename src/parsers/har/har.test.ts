import { describe, expect, it } from 'vitest';
import {
    formatByteSize,
    formatMillis,
    parseHar,
    parseIso8601Millis,
    resourceTypeOf,
    splitUrl,
    statusClassOf
} from './index.js';
import { harEntry, harFixture, harFixtureText, harLog } from './__tests__/fixture.js';

const ok = (input: Uint8Array | string, options?: Parameters<typeof parseHar>[1]) => {
    const { result } = parseHar(input, options);
    if (result.status === 'failed') throw new Error(`unexpected failure: ${result.failure.messageKey}`);
    return result;
};

describe('parseHar', () => {
    it('reads the log, its entries, and the filter vocabularies', () => {
        const result = ok(harFixture());
        expect(result.status).toBe('ok');
        const document = result.document;
        expect(document.version).toBe('1.2');
        expect(document.creator).toEqual({ name: 'WebInspector', version: '537.36', comment: '' });
        expect(document.browser?.name).toBe('Chrome');
        expect(document.entries).toHaveLength(8);
        expect(document.totalEntries).toBe(8);
        expect(document.hosts).toEqual(['api.example.com', 'cdn.example.com', 'down.example.com', 'example.com', 'live.example.com']);
        expect(document.methods).toEqual(['GET', 'POST']);
        // Declared order, not first-seen order, so the filter list is stable.
        expect(document.statusClasses).toEqual(['2xx', '4xx', '5xx', '1xx', 'none']);
        expect(document.resourceTypes).toEqual(['document', 'stylesheet', 'xhr', 'image', 'websocket', 'other']);
        expect(document.pages).toEqual([{
            id: 'page_1', title: 'https://example.com/', startedDateTime: '2026-03-01T10:00:00.000Z',
            startedMillis: Date.UTC(2026, 2, 1, 10, 0, 0, 0), onContentLoad: 310.5, onLoad: 842.25, entryCount: 8
        }]);
    });

    it('derives request identity, status class, and resource type per entry', () => {
        const [document_, stylesheet, notFound, posted, image, config, failed, socket] = ok(harFixture()).document.entries;
        expect(document_).toMatchObject({ index: 0, method: 'GET', host: 'example.com', path: '/', name: 'example.com', statusClass: '2xx', resourceType: 'document' });
        expect(stylesheet).toMatchObject({ host: 'cdn.example.com', path: '/assets/app.css', name: 'app.css', resourceType: 'stylesheet' });
        // A quoted status still classifies, and `_resourceType: fetch` maps to xhr.
        expect(notFound).toMatchObject({ status: 404, statusClass: '4xx', resourceType: 'xhr', query: 'page=2&limit=20' });
        expect(notFound!.queryString).toEqual([{ name: 'page', value: '2' }, { name: 'limit', value: '20' }]);
        // A lower-case method is normalized; the table groups by method.
        expect(posted).toMatchObject({ method: 'POST', status: 500, statusClass: '5xx' });
        expect(image).toMatchObject({ resourceType: 'image', statusClass: '2xx' });
        expect(config).toMatchObject({ resourceType: 'xhr' });
        expect(failed).toMatchObject({ status: 0, statusClass: 'none', error: 'net::ERR_CONNECTION_REFUSED', time: -1 });
        expect(socket).toMatchObject({ scheme: 'wss', resourceType: 'websocket', statusClass: '1xx' });
    });

    it('measures the timeline from the entries without reading the clock', () => {
        const document = ok(harFixture()).document;
        expect(document.timelineStartMillis).toBe(Date.UTC(2026, 2, 1, 10, 0, 0, 0));
        expect(document.entries.map(entry => entry.offsetMillis)).toEqual([0, 200, 400, 700, 1000, 1100, 1300, 1400]);
        // The last entry starts at +1400 and lasts 15ms; the POST ends at 1200.
        expect(document.timelineSpanMillis).toBe(1415);
        expect(document.totalTimeMillis).toBe(120 + 60 + 240 + 500 + 90 + 35 + 15);
    });

    it('splits timings into drawable phases with the TLS handshake taken out of connect', () => {
        const [first, second] = ok(harFixture()).document.entries;
        expect(first!.timings.phases).toEqual([
            { kind: 'blocked', millis: 1 }, { kind: 'dns', millis: 4 }, { kind: 'connect', millis: 8 },
            { kind: 'ssl', millis: 12 }, { kind: 'send', millis: 2 }, { kind: 'wait', millis: 80 }, { kind: 'receive', millis: 13 }
        ]);
        expect(first!.timings.total).toBe(120);
        // `-1` means "not applicable" and must not become a zero-width phase.
        expect(second!.timings.phases.map(phase => phase.kind)).toEqual(['send', 'wait', 'receive']);
        expect(second!.timings.connect).toBe(-1);
    });

    it('counts transferred and resource bytes, preferring _transferSize when present', () => {
        const document = ok(harFixture()).document;
        const [first, stylesheet] = document.entries;
        expect(first!.transferredBytes).toBe(220 + 1024);
        expect(stylesheet!.transferredBytes).toBe(1100);
        // Chrome/Playwright write `_transferSize` inside `response`; an archive
        // rewritten by a proxy can put it on the entry instead. Both count, and
        // an HTTP/2 entry (no raw header text, so -1/-1) must not read as 0.
        const h2 = ok('{"log":{"version":"1.2","entries":[' +
            '{"request":{"method":"GET","url":"https://e.test/a"},"response":{"status":200,' +
            '"content":{"size":9},"headersSize":-1,"bodySize":-1,"_transferSize":14223}},' +
            '{"_transferSize":8311,"request":{"method":"GET","url":"https://e.test/b"},' +
            '"response":{"status":200,"content":{"size":9},"headersSize":-1,"bodySize":-1}}]}}').document;
        expect(h2.entries.map(entry => entry.transferredBytes)).toEqual([14223, 8311]);
        expect(h2.transferredBytes).toBe(22534);
        expect(document.transferredBytes).toBe(document.entries.reduce((sum, entry) => sum + entry.transferredBytes, 0));
        expect(document.resourceBytes).toBe(1024 + 2048 + 48 + 30 + 5120 + 20 + 0 + 0);
        expect(document.errorCount).toBe(3);
        expect(document.summary.map(item => item.labelKey)).toEqual([
            'har.summary.requests', 'har.summary.elapsed', 'har.summary.transferred',
            'har.summary.resources', 'har.summary.domains', 'har.summary.errors', 'har.summary.pages'
        ]);
        expect(document.summary[0]!.value).toBe('8');
    });

    it('keeps text bodies, decodes base64 text, and leaves binary bodies as bytes', () => {
        const entries = ok(harFixture()).document.entries;
        expect(entries[2]!.responseBody).toMatchObject({ text: '{"error":"not found","code":404}', json: true, binary: false });
        expect(entries[3]!.requestBody).toMatchObject({
            mimeType: 'application/x-www-form-urlencoded', text: 'name=widget&qty=3', json: false
        });
        expect(entries[3]!.requestBody!.params).toEqual([{ name: 'name', value: 'widget' }, { name: 'qty', value: '3' }]);
        // image/png stays binary; the JSON config is decoded out of base64.
        expect(entries[4]!.responseBody).toMatchObject({ binary: true, text: '', encoding: 'base64' });
        expect(entries[5]!.responseBody).toMatchObject({ binary: false, text: '{"ok":true}', json: true });
    });

    it('truncates a body at the preview limit and reports it once', () => {
        const long = 'x'.repeat(5000);
        const { result } = parseHar(harLog([harEntry({ mimeType: 'text/plain', text: long })]), { maxBodyChars: 100 });
        if (result.status === 'failed') throw new Error('unexpected failure');
        expect(result.document.entries[0]!.responseBody).toMatchObject({ text: 'x'.repeat(100), truncated: true });
        expect(result.diagnostics.map(diagnostic => diagnostic.messageKey)).toContain('diag.har.body-truncated');
    });

    it('stops at the entry limit and reports a partial document', () => {
        const { result } = parseHar(harLog([harEntry({}), harEntry({}), harEntry({})]), { limits: { maxEntries: 2 } });
        if (result.status === 'failed') throw new Error('unexpected failure');
        expect(result.status).toBe('partial');
        expect(result.document.entries).toHaveLength(2);
        expect(result.document.totalEntries).toBe(3);
        expect(result.document.summary[0]!.value).toBe('2 / 3');
        expect(result.diagnostics).toContainEqual({
            severity: 'warning', code: 'har.entry-limit', messageKey: 'diag.har.entry-limit', args: { shown: 2, total: 3 }
        });
    });

    it('reads the cache markers writers actually emit', () => {
        const one = (fixture: Parameters<typeof harEntry>[0]) => ok(harLog([harEntry(fixture)])).document.entries[0]!;
        // `_fromCache: false` is what a network-served response carries — the
        // presence of the field says nothing by itself.
        expect(one({ fromCache: false }).fromCache).toBe(false);
        expect(one({ fromCache: true }).fromCache).toBe(true);
        expect(one({ fromCache: 'memory' }).fromCache).toBe(true);
        expect(one({}).fromCache).toBe(false);
        // `cache.beforeRequest` is a cached entry that existed before the
        // request; `afterRequest` only means the response was stored.
        expect(one({ cache: '{"beforeRequest":{"eTag":"x"}}' }).fromCache).toBe(true);
        expect(one({ cache: '{"afterRequest":{"eTag":"x"}}' }).fromCache).toBe(false);
    });

    it('does not let a hostile _resourceType reach the model', () => {
        const typeOf = (hint: string, mimeType = 'text/html') =>
            ok(harLog([harEntry({ resourceType: hint, mimeType })])).document.entries[0]!.resourceType;
        // Inherited Object members must not answer the hint lookup.
        expect(typeOf('constructor')).toBe('document');
        expect(typeOf('__proto__')).toBe('document');
        expect(typeOf('toString', 'application/octet-stream')).toBe('binary');
        expect(typeOf('Stylesheet')).toBe('stylesheet');
    });

    it('decodes url-safe base64 and keeps the prefix of a corrupt body', () => {
        const body = (text: string, mimeType = 'application/json') =>
            ok(harLog([harEntry({ mimeType, text, encoding: 'base64' })])).document.entries[0]!.responseBody;
        // base64url (`-` and `_`) is what tools that encode for URLs emit.
        expect(body('eyJhIjoiYj8-In0')).toMatchObject({ text: '{"a":"b?>"}', binary: false, json: true });
        // A corrupt tail keeps what decoded and is flagged as incomplete —
        // nothing about the preview limit is involved, so not `truncated`.
        expect(body('eyJhIjoiYiJ9!!!!')).toMatchObject({ text: '{"a":"b"}', binary: false, incomplete: true, truncated: false });
        // Nothing decodable is reported as bytes instead of an empty preview.
        expect(body('!!!!')).toMatchObject({ text: '', binary: true });
    });

    it('takes the request body size from the archive, not from the preview text', () => {
        const [withHeader] = ok(harFixture()).document.entries.slice(3);
        // `request.bodySize` is 17 for `name=widget&qty=3`.
        expect(withHeader!.requestBody).toMatchObject({ size: 17 });
        // With no bodySize the UTF-8 length stands in — never the UTF-16 length.
        const { result } = parseHar('{"log":{"version":"1.2","entries":[{"request":{"method":"POST","url":"https://e.test/x",' +
            '"postData":{"mimeType":"text/plain","text":"ééé"}},"response":{"status":200,"content":{"size":0}}}]}}');
        if (result.status === 'failed') throw new Error('unexpected failure');
        expect(result.document.entries[0]!.requestBody).toMatchObject({ size: 6 });
    });

    it('treats scheme and host as case-insensitive', () => {
        const document = ok(harLog([
            harEntry({ url: 'WSS://LIVE.example.com/socket', status: 101, mimeType: '' }),
            harEntry({ url: 'https://API.example.com/a' }),
            harEntry({ url: 'https://api.example.com/b' })
        ])).document;
        expect(document.entries[0]).toMatchObject({ scheme: 'wss', host: 'live.example.com', resourceType: 'websocket' });
        // One host, one entry in the domain filter.
        expect(document.hosts).toEqual(['api.example.com', 'live.example.com']);
    });

    it('clips a body preview without breaking a character in half', () => {
        const body = (text: string, maxBodyChars: number, encoding?: string) => {
            const { result } = parseHar(harLog([harEntry({ mimeType: 'text/plain', text, ...(encoding ? { encoding } : {}) })]), { maxBodyChars });
            if (result.status === 'failed') throw new Error('unexpected failure');
            return result.document.entries[0]!.responseBody;
        };
        const hasBrokenChar = (text: string): boolean => {
            const last = text.charCodeAt(text.length - 1);
            return text.includes('\uFFFD') || (last >= 0xd800 && last <= 0xdbff);
        };
        // A plain-text cut must not split a surrogate pair…
        const emoji = body('🎈'.repeat(40), 11);
        expect(hasBrokenChar(emoji.text)).toBe(false);
        expect(emoji).toMatchObject({ truncated: true });
        // …and a base64 cut lands on a 3-byte boundary that a 2-byte sequence
        // straddles, which must not decode to a replacement character.
        // base64 of 100 × 'é' (two bytes each). The limit admits 17 quads = 51
        // bytes, so the cut lands between the two bytes of the 26th character.
        const accented = body('w6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6k=', 52, 'base64');
        expect(hasBrokenChar(accented.text)).toBe(false);
        expect(accented).toMatchObject({ binary: false, truncated: true });
    });

    it('separates base64 padding from a body that is not base64 at all', () => {
        const body = (text: string) =>
            ok(harLog([harEntry({ mimeType: 'application/json', text, encoding: 'base64' })])).document.entries[0]!.responseBody;
        // Trailing `=` is padding, i.e. normal termination — not a truncation.
        expect(body('eyJvayI6dHJ1ZX0=')).toMatchObject({ text: '{"ok":true}', truncated: false, incomplete: false, binary: false });
        // A leading `=` decodes nothing: bytes, not an empty body.
        expect(body('=eyJhIjoxfQ==')).toMatchObject({ text: '', binary: true });
        // Padded chunks concatenated: content follows the first `=`, so the
        // body is incomplete — again not a preview-limit truncation.
        expect(body('eyJhIjoxfQ==eyJiIjoyfQ==')).toMatchObject({ text: '{"a":1}', incomplete: true, truncated: false });
        // An empty field really is an empty body.
        expect(body('')).toMatchObject({ text: '', binary: false });
    });

    it('upper-cases the method with ASCII rules only', () => {
        // `toUpperCase()` would fold the dotless ı to I, which differs by engine
        // and locale (DESIGN.md §3-①).
        const method = ok(harLog([harEntry({ method: 'ıget' })])).document.entries[0]!.method;
        expect(method).toBe('ıGET');
        expect(method).not.toBe('ıget'.toUpperCase());
    });

    it('keeps an unknown value unknown rather than rounding it to zero', () => {
        const { result } = parseHar('{"log":{"version":"1.2","entries":[' +
            '{"startedDateTime":"not a date","time":-1,"request":{"method":"GET","url":"https://e.test/x"},' +
            '"response":{"status":200,"content":{"size":-1,"mimeType":"text/plain"}}}],' +
            // HAR 1.2 requires `pages` to be an array; an object is not one.
            '"pages":{"a":{"id":"x","title":"T"}}}}');
        if (result.status === 'failed') throw new Error('unexpected failure');
        const [entry] = result.document.entries;
        // -1 survives to the entry so the viewer can render it as unknown; only
        // the document-level sum clamps it.
        expect(entry!.resourceBytes).toBe(-1);
        // No entry reported a size, so neither does the archive.
        expect(result.document.resourceBytes).toBe(-1);
        expect(entry!.startedMillis).toBeNull();
        expect(result.document.pages).toEqual([]);
    });

    it('separates a preview-limit cut from a body it could not fully decode', () => {
        const run = (text: string, maxBodyChars: number, encoding?: string) => {
            const { result } = parseHar(
                harLog([harEntry({ mimeType: 'application/json', text, ...(encoding ? { encoding } : {}) })]),
                { maxBodyChars }
            );
            if (result.status === 'failed') throw new Error('unexpected failure');
            return { body: result.document.entries[0]!.responseBody, keys: result.diagnostics.map(d => d.messageKey) };
        };
        // A ceiling below one base64 quad admits nothing — that is the limit,
        // not a body that was never base64.
        const starved = run('eyJvayI6dHJ1ZX0=', 0, 'base64');
        expect(starved.body).toMatchObject({ text: '', binary: false, truncated: true, incomplete: false });
        expect(starved.keys).toContain('diag.har.body-truncated');
        expect(starved.keys).not.toContain('diag.har.binary-bodies');
        // An undecodable body is reported under its own diagnostic, which
        // carries no character limit to misquote.
        const corrupt = run('eyJhIjoxfQ==eyJiIjoyfQ==', 64 * 1024, 'base64');
        expect(corrupt.keys).toContain('diag.har.body-incomplete');
        expect(corrupt.keys).not.toContain('diag.har.body-truncated');
    });

    it('leaves an unmeasured elapsed span unknown instead of summing request times', () => {
        const document = ok('{"log":{"version":"1.2","entries":[' +
            '{"time":100,"request":{"method":"GET","url":"https://e.test/a"},"response":{"status":200,"content":{"size":1}}},' +
            '{"time":200,"request":{"method":"GET","url":"https://e.test/b"},"response":{"status":200,"content":{"size":1}}}]}}').document;
        expect(document.timelineStartMillis).toBeNull();
        expect(document.totalTimeMillis).toBe(300);
        // The sum of request times is a different quantity, listed on its own.
        expect(document.summary.find(item => item.labelKey === 'har.summary.elapsed')!.value).toBe('—');
    });

    it('does not read the writers\' unknown-MIME sentinel as a media type', () => {
        // Chrome DevTools (`mimeType: … || 'x-unknown'`) and Playwright write
        // this for a redirect, a failed request, or any body-less response.
        const types = (mimeType: string, url = 'https://e.test/script.js') =>
            ok(harLog([harEntry({ url, mimeType, status: 301, size: -1 })])).document.entries[0]!;
        expect(types('x-unknown').resourceType).toBe('other');
        expect(types('application/x-unknown').resourceType).toBe('other');
        expect(types('X-Unknown').resourceType).toBe('other');
        // The archive's own spelling is still reported verbatim.
        expect(types('x-unknown').mimeType).toBe('x-unknown');
        // A real type still classifies.
        expect(types('application/javascript').resourceType).toBe('script');
    });

    it('reports a transfer total nobody measured as unknown', () => {
        // Apple's AMSEverywhere writes -1/-1 and no _transferSize throughout.
        const archive = ok('{"log":{"version":"1.2","creator":{"name":"AMSEverywhere"},"entries":[' +
            '{"time":61,"request":{"method":"GET","url":"https://e.test/a"},"response":{"status":200,' +
            '"content":{"size":120,"mimeType":"application/json"},"headersSize":-1,"bodySize":-1}}]}}').document;
        expect(archive.entries[0]!.transferredKnown).toBe(false);
        expect(archive.transferredBytes).toBe(-1);
        expect(archive.summary.find(item => item.labelKey === 'har.summary.transferred')!.value).toBe('—');
        // The decoded size *was* reported, so that total stands.
        expect(archive.resourceBytes).toBe(120);
        expect(archive.summary.find(item => item.labelKey === 'har.summary.resources')!.value).toBe('120 B');
    });

    it('reads a request error from either side of the entry', () => {
        // Chrome writes `_error` inside `response`, alongside `_transferSize`.
        const [response] = ok(harLog([harEntry({ error: 'net::ERR_FAILED' })])).document.entries;
        expect(response!.error).toBe('net::ERR_FAILED');
        // A proxy-rewritten archive can put it on the entry instead.
        const entry = ok('{"log":{"version":"1.2","entries":[{"_error":"net::ERR_ABORTED",' +
            '"request":{"method":"GET","url":"https://e.test/a"},"response":{"status":0,"content":{"size":0}}}]}}').document;
        expect(entry.entries[0]!.error).toBe('net::ERR_ABORTED');
    });

    it('reports input-caused failures instead of throwing', () => {
        const failure = (input: string, options?: Parameters<typeof parseHar>[1]) => {
            const { result } = parseHar(input, options);
            if (result.status !== 'failed') throw new Error(`expected failure, got ${result.status}`);
            return result.failure;
        };
        expect(failure('not json at all')).toMatchObject({ code: 'invalid-format', messageKey: 'diag.har.invalid' });
        expect(failure('{"notALog":1}')).toMatchObject({ code: 'invalid-format', messageKey: 'diag.har.missing-log' });
        expect(failure('{"log":{"version":"1.2"}}')).toMatchObject({ code: 'invalid-format', messageKey: 'diag.har.missing-entries' });
        expect(failure(harFixtureText(), { limits: { maxInputBytes: 10 } }))
            .toMatchObject({ code: 'limit-exceeded', messageKey: 'diag.limit-exceeded.input' });
        const controller = new AbortController();
        controller.abort();
        expect(failure(harFixtureText(), { signal: controller.signal })).toMatchObject({ code: 'aborted', retryable: true });
    });

    it('warns about an empty archive, a foreign version, and unreadable entries', () => {
        const empty = parseHar(harLog([], { version: '1.3', pages: false }));
        if (empty.result.status === 'failed') throw new Error('unexpected failure');
        expect(empty.result.document.entries).toHaveLength(0);
        expect(empty.result.diagnostics.map(diagnostic => diagnostic.messageKey))
            .toEqual(expect.arrayContaining(['diag.har.version', 'diag.har.no-entries']));
        expect(empty.result.document.summary.map(item => item.labelKey)).not.toContain('har.summary.pages');

        const mixed = parseHar(`{"log":{"version":"1.2","entries":[7,${harEntry({})}]}}`);
        if (mixed.result.status === 'failed') throw new Error('unexpected failure');
        expect(mixed.result.document.entries).toHaveLength(1);
        expect(mixed.result.diagnostics).toContainEqual({
            severity: 'warning', code: 'har.invalid-entries', messageKey: 'diag.har.invalid-entries', args: { count: 1 }
        });
    });

    it('shows the entries a truncated archive did hold', () => {
        const text = harLog([harEntry({}), harEntry({ url: 'https://example.com/second' })]);
        const { result } = parseHar(text.slice(0, text.length - 40));
        if (result.status === 'failed') throw new Error('unexpected failure');
        expect(result.status).toBe('partial');
        expect(result.document.entries.length).toBeGreaterThanOrEqual(1);
        expect(result.diagnostics.some(diagnostic => diagnostic.messageKey.startsWith('diag.json.'))).toBe(true);
    });

    it('flags unparseable timestamps rather than guessing them', () => {
        const { result } = parseHar(harLog([harEntry({ startedDateTime: 'yesterday' })]));
        if (result.status === 'failed') throw new Error('unexpected failure');
        expect(result.document.entries[0]!.startedMillis).toBeNull();
        expect(result.document.timelineStartMillis).toBeNull();
        expect(result.document.entries[0]!.offsetMillis).toBe(0);
        expect(result.diagnostics).toContainEqual({
            severity: 'warning', code: 'har.invalid-dates', messageKey: 'diag.har.invalid-dates', args: { count: 1 }
        });
    });

    it('is deterministic for the same bytes and options', () => {
        const first = parseHar(harFixture()).result;
        const second = parseHar(harFixture()).result;
        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });
});

describe('HAR field helpers', () => {
    it('parses ISO-8601 timestamps without new Date(string)', () => {
        expect(parseIso8601Millis('2026-03-01T10:00:00.000Z')).toBe(Date.UTC(2026, 2, 1, 10, 0, 0, 0));
        expect(parseIso8601Millis('2026-03-01T10:00:00')).toBe(Date.UTC(2026, 2, 1, 10, 0, 0, 0));
        expect(parseIso8601Millis('2026-03-01T19:00:00.500+09:00')).toBe(Date.UTC(2026, 2, 1, 10, 0, 0, 500));
        expect(parseIso8601Millis('2026-03-01T05:30:00-04:30')).toBe(Date.UTC(2026, 2, 1, 10, 0, 0, 0));
        expect(parseIso8601Millis('2024-02-29T00:00:00Z')).toBe(Date.UTC(2024, 1, 29));
        expect(parseIso8601Millis('2026-02-29T00:00:00Z')).toBeNull();
        expect(parseIso8601Millis('2026-13-01T00:00:00Z')).toBeNull();
        expect(parseIso8601Millis('2026-03-01T24:00:00Z')).toBeNull();
        expect(parseIso8601Millis('')).toBeNull();
        // Year 0001 is what a .NET writer emits for an unset DateTime; the
        // legacy two-digit window would place it in 1901.
        expect(parseIso8601Millis('0001-01-01T00:00:00Z')).toBe(-62135596800000);
        expect(parseIso8601Millis('0099-06-15T12:00:00Z')).toBe(-59028696000000);
    });

    it('splits URLs without throwing on the odd ones', () => {
        expect(splitUrl('https://user:pw@api.example.com:8443/v1/items?page=2#frag'))
            .toEqual({ scheme: 'https', host: 'api.example.com:8443', path: '/v1/items', query: 'page=2' });
        expect(splitUrl('https://example.com')).toEqual({ scheme: 'https', host: 'example.com', path: '/', query: '' });
        expect(splitUrl('data:text/plain;base64,AAAA')).toEqual({ scheme: 'data', host: '', path: 'text/plain;base64,AAAA', query: '' });
        expect(splitUrl('/relative/path?a=1')).toEqual({ scheme: '', host: '', path: '/relative/path', query: 'a=1' });
        // A query may contain `?`; only the first one separates it. The
        // fragment never reaches the server, so it is not part of the request.
        expect(splitUrl('/search?q=a?b')).toEqual({ scheme: '', host: '', path: '/search', query: 'q=a?b' });
        expect(splitUrl('/search?q=1#frag')).toEqual({ scheme: '', host: '', path: '/search', query: 'q=1' });
        expect(splitUrl('data:text/plain,hello?x=1#f')).toEqual({ scheme: 'data', host: '', path: 'text/plain,hello', query: 'x=1' });
    });

    it('classifies status codes and resource types', () => {
        expect([100, 204, 302, 404, 503, 0, -1, 999].map(statusClassOf))
            .toEqual(['1xx', '2xx', '3xx', '4xx', '5xx', 'none', 'none', 'none']);
        const parts = splitUrl('https://example.com/x');
        expect(resourceTypeOf('', 'text/html', parts)).toBe('document');
        expect(resourceTypeOf('', 'application/json', parts)).toBe('xhr');
        expect(resourceTypeOf('', 'font/woff2', parts)).toBe('font');
        expect(resourceTypeOf('', 'video/mp4', parts)).toBe('media');
        expect(resourceTypeOf('', 'application/octet-stream', parts)).toBe('binary');
        expect(resourceTypeOf('', '', parts)).toBe('other');
        // The writer's own label wins over the MIME type.
        expect(resourceTypeOf('Stylesheet', 'text/plain', parts)).toBe('stylesheet');
    });

    it('formats sizes and durations without Intl', () => {
        expect([0, 512, 1024, 1536, 20_480, 5_242_880].map(formatByteSize))
            .toEqual(['0 B', '512 B', '1.00 KB', '1.50 KB', '20.0 KB', '5.00 MB']);
        // A value that rounds up to 1024 of a unit belongs in the next one.
        expect([1_048_575, 1_073_741_823, 1_099_511_627_775].map(formatByteSize))
            .toEqual(['1.00 MB', '1.00 GB', '1.00 TB']);
        expect(formatByteSize(-1)).toBe('—');
        expect([0, 0.5, 4.25, 120, 1500, 95_000].map(formatMillis))
            .toEqual(['0 ms', '0.50 ms', '4.3 ms', '120 ms', '1.50 s', '1m 35s']);
        // A seconds remainder of 59.5 carries into the minute, never "1m 60s".
        expect([119_500, 179_500, 3_599_500].map(formatMillis))
            .toEqual(['2m 0s', '3m 0s', '1h 0m']);
        // A session-long archive: hours, not three-digit minutes.
        expect([3_600_000, 115_200_000].map(formatMillis)).toEqual(['1h 0m', '32h 0m']);
        // Each rung hands off on its own rounded label, so no value is ever
        // labelled one unit below where it belongs. Playwright and Chrome both
        // write fractional milliseconds, so these are reachable.
        expect([999.5, 999.4, 59_999.5, 59_994].map(formatMillis))
            .toEqual(['1.00 s', '999 ms', '1m 0s', '59.99 s']);
        expect([1023.5, 1023.4].map(formatByteSize)).toEqual(['1.00 KB', '1023 B']);
        expect(formatMillis(-1)).toBe('—');
    });
});
