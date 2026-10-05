// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { harEntry, harFixture, harLog } from '../../parsers/har/__tests__/fixture.js';
import { parseHar } from '../../parsers/har/index.js';
import { MountAbortedError } from '../types.js';
import { HAR_SEARCH_DEBOUNCE_MS, harViewerCss, mountHarDocument, mountHarViewer } from './index.js';

const ctx = {
    assets: { resolveAssetUrl: async (path: string) => path },
    logger: { log: vi.fn() },
    i18n: {
        t: (key: string, args?: Record<string, string | number>) =>
            key === 'har.rows' ? `${args?.shown} / ${args?.total}`
                : key === 'har.requestCount' ? `${args?.count} requests`
                    : key === 'har.body.binary' ? `binary ${args?.size}`
                        : key
    }
};

const mount = (data: Uint8Array, options: Record<string, unknown> = {}, context = ctx) =>
    mountHarViewer({ fileName: 'session.har', data }, document.createElement('div'), context as never, { styleIsolation: 'scoped', ...options });

const rows = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('.omni-har__row')];
const rowNames = (container: HTMLElement): string[] => rows(container).map(row => row.querySelector('strong')?.textContent ?? '');
const button = (container: HTMLElement, label: string): HTMLButtonElement =>
    [...container.querySelectorAll('button')].find(node => node.textContent?.startsWith(label)) as HTMLButtonElement;
const setFilter = (container: HTMLElement, label: string, value: string): void => {
    const node = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
};
/** Types into the search box and lets its debounce fire. */
const search = (container: HTMLElement, text: string): void => {
    const input = container.querySelector<HTMLInputElement>('.omni-har__search')!;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(HAR_SEARCH_DEBOUNCE_MS);
};

async function mounted(): Promise<{ container: HTMLElement; dispose: () => void }> {
    const container = document.createElement('div');
    const handle = await mountHarViewer({ fileName: 'session.har', data: harFixture() }, container, ctx as never, { styleIsolation: 'scoped' });
    return { container, dispose: () => handle.dispose() };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('mountHarViewer', () => {
    it('renders the summary, the request table, and the waterfall, then disposes cleanly', async () => {
        const container = document.createElement('div');
        const handle = await mountHarViewer({ fileName: 'session.har', data: harFixture() }, container, ctx as never);
        const root = container.shadowRoot!;
        expect(root.querySelector('style')?.textContent).toContain('.omni-har');
        expect(root.querySelector('h1')?.textContent).toBe('session.har');
        expect(root.querySelector('.omni-har__subtitle')?.textContent).toContain('WebInspector 537.36');
        expect(root.querySelector('.omni-har__subtitle')?.textContent).toContain('8 requests');
        expect(root.querySelectorAll('.omni-har__summary-item')).toHaveLength(7);
        expect(root.querySelectorAll('.omni-har__row')).toHaveLength(8);
        // The failed request has neither a duration nor phases, so it draws no bar.
        expect(root.querySelectorAll('.omni-har__bar')).toHaveLength(7);
        expect(root.querySelectorAll('.omni-har__row')[0]!.querySelectorAll('.omni-har__phase')).toHaveLength(7);
        expect(root.querySelector('.omni-har__status--4xx')?.textContent).toBe('404');
        expect(root.querySelector('.omni-har__status--none')?.textContent).toBe('har.failed');
        expect(root.querySelectorAll('.omni-har__legend span').length).toBeGreaterThan(0);
        handle.dispose();
        expect(root.childNodes).toHaveLength(0);
    });

    it('positions the bar from the entry offset and scales it to the session span', async () => {
        const { container } = await mounted();
        const first = container.querySelector<HTMLElement>('.omni-har__bar')!;
        expect(first.style.left).toBe('0%');
        // 120ms of a 1415ms session.
        expect(Number.parseFloat(first.style.width)).toBeCloseTo(8.48, 1);
        const third = rows(container)[2]!.querySelector<HTMLElement>('.omni-har__bar')!;
        expect(Number.parseFloat(third.style.left)).toBeCloseTo(28.27, 1);
    });

    it('filters by method, status class, type, domain, and text', async () => {
        const { container } = await mounted();
        setFilter(container, 'har.filter.method', 'POST');
        expect(rows(container)).toHaveLength(1);
        expect(container.querySelector('.omni-har__panel-header span')?.textContent).toBe('1 / 1');
        setFilter(container, 'har.filter.method', '');
        setFilter(container, 'har.filter.status', '5xx');
        expect(rows(container)).toHaveLength(1);
        setFilter(container, 'har.filter.status', '');
        setFilter(container, 'har.filter.type', 'image');
        expect(rowNames(container)).toEqual(['logo.png']);
        setFilter(container, 'har.filter.type', '');
        setFilter(container, 'har.filter.domain', 'api.example.com');
        expect(rows(container)).toHaveLength(3);
        setFilter(container, 'har.filter.domain', '');
        search(container, 'app.css');
        expect(rowNames(container)).toEqual(['app.css']);
        // Headers are searched; bodies only when the toggle is on.
        search(container, 'abc-123');
        expect(rows(container)).toHaveLength(1);
        search(container, 'boom');
        expect(rows(container)).toHaveLength(0);
        expect(container.querySelector('.omni-har__empty')?.textContent).toBe('har.noMatches');
        const toggle = container.querySelector<HTMLInputElement>('.omni-har__toggle input')!;
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        expect(rowNames(container)).toEqual(['items']);
    });

    it('sorts by a column and reverses on a second click', async () => {
        const { container } = await mounted();
        // Slowest first: the 500ms POST, then the 240ms fetch.
        button(container, 'har.column.time').click();
        expect(rowNames(container).slice(0, 2)).toEqual(['items', 'items']);
        expect(rows(container)[0]!.textContent).toContain('500 ms');
        button(container, 'har.column.time').click();
        expect(rows(container)[0]!.textContent).toContain('—');
        button(container, 'har.column.domain').click();
        expect(rows(container)[0]!.querySelector('td:nth-child(6)')?.textContent).toBe('api.example.com');
    });

    it('shows headers, payload, response, cookies, and timings for the selected request', async () => {
        const { container } = await mounted();
        // The first entry is selected on mount.
        expect(container.querySelector('.omni-har__detail-header h2')?.textContent).toBe('GET example.com');
        rows(container)[2]!.click();
        const detail = container.querySelector('.omni-har__detail')!;
        expect(detail.querySelector('h2')?.textContent).toContain('items');
        expect(detail.textContent).toContain('x-request-id');
        expect(detail.textContent).toContain('93.184.216.34');

        button(container, 'har.detail.response').click();
        const body = container.querySelector('.omni-har__body')!;
        // Pretty-printed through the core JSON serializer, with keys coloured.
        expect(body.textContent).toBe('{\n  "error": "not found",\n  "code": 404\n}');
        expect(body.querySelector('.omni-har__json-key')?.textContent).toBe('"error"');
        expect(body.querySelector('.omni-har__json-number')?.textContent).toBe('404');

        button(container, 'har.detail.timings').click();
        // Four phases have a duration; the 0ms dns/connect/ssl are listed as
        // reported values but draw no segment.
        expect(container.querySelectorAll('.omni-har__phase-row')).toHaveLength(4);
        expect(container.querySelector('.omni-har__detail-body')?.textContent).toContain('har.timing.total240 ms');
        // The stylesheet reports dns/connect/ssl as -1 — not applicable, not zero.
        rows(container)[1]!.click();
        expect(container.querySelector('.omni-har__detail-body')?.textContent).toContain('har.notApplicable');

        button(container, 'har.detail.cookies').click();
        expect(container.querySelectorAll('.omni-har__note')).toHaveLength(2);

        // The POST carries a form payload.
        button(container, 'har.detail.payload').click();
        rows(container)[3]!.click();
        expect(container.querySelector('.omni-har__detail-body')?.textContent).toContain('application/x-www-form-urlencoded');
        expect(container.querySelector('.omni-har__detail-body')?.textContent).toContain('widget');
    });

    it('coalesces keystrokes instead of rebuilding the table on each one', async () => {
        const { container } = await mounted();
        const input = container.querySelector<HTMLInputElement>('.omni-har__search')!;
        for (const text of ['a', 'ap', 'app', 'app.']) {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // Nothing has been re-rendered yet — the debounce is still pending.
        expect(rows(container)).toHaveLength(8);
        vi.advanceTimersByTime(HAR_SEARCH_DEBOUNCE_MS);
        expect(rowNames(container)).toEqual(['app.css']);
    });

    it('does not accumulate listeners or detached tables as the table re-renders', async () => {
        const teardownCalls = async (renders: number): Promise<number> => {
            const container = document.createElement('div');
            const handle = await mountHarViewer({ fileName: 'session.har', data: harFixture() }, container, ctx as never, { styleIsolation: 'scoped' });
            for (let i = 0; i < renders; i++) button(container, 'har.column.time').click();
            const spy = vi.spyOn(EventTarget.prototype, 'removeEventListener');
            handle.dispose();
            const calls = spy.mock.calls.length;
            spy.mockRestore();
            return calls;
        };
        // Per-render listeners must die with their elements, so teardown work
        // is a function of the mount, not of how much the user filtered.
        expect(await teardownCalls(12)).toBe(await teardownCalls(0));
    });

    it('keeps keyboard focus on the control that was activated', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        try {
            await mountHarViewer({ fileName: 'session.har', data: harFixture() }, container, ctx as never, { styleIsolation: 'scoped' });
            // Both of these rebuild the subtree holding the button just pressed.
            const sortHeader = button(container, 'har.column.time');
            sortHeader.focus();
            sortHeader.click();
            expect(document.activeElement).toBe(button(container, 'har.column.time'));
            expect(document.activeElement).not.toBe(sortHeader);

            const tab = button(container, 'har.detail.timings');
            tab.focus();
            tab.click();
            expect(document.activeElement).toBe(button(container, 'har.detail.timings'));
        } finally {
            container.remove();
        }
    });

    it('keeps arrival order within a tied column in both directions', async () => {
        const { container } = await mounted();
        const indices = (): string[] => rows(container).map(row => row.querySelector('td')!.textContent!);
        // Seven GETs and one POST: the GET group is one big tie, and arrival
        // order is the reading order of a network log.
        button(container, 'har.column.method').click();
        expect(indices()).toEqual(['1', '2', '3', '5', '6', '7', '8', '4']);
        button(container, 'har.column.method').click();
        expect(indices()).toEqual(['4', '1', '2', '3', '5', '6', '7', '8']);
    });

    it('sorts the type column by the localized label, not the enum id', async () => {
        const container = document.createElement('div');
        const localized = {
            ...ctx,
            i18n: {
                t: (key: string, args?: Record<string, string | number>) =>
                    key === 'har.type.image' ? 'aaa image'
                        : key === 'har.type.document' ? 'zzz document'
                            : ctx.i18n.t(key, args)
            }
        };
        await mountHarViewer({ fileName: 'session.har', data: harFixture() }, container, localized as never, { styleIsolation: 'scoped' });
        button(container, 'har.column.type').click();
        expect(rowNames(container)[0]).toBe('logo.png');
        expect(rowNames(container).at(-1)).toBe('example.com');
    });

    it('keeps focus in the search box when the debounced render lands', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        try {
            await mountHarViewer({ fileName: 'session.har', data: harFixture() }, container, ctx as never, { styleIsolation: 'scoped' });
            const input = container.querySelector<HTMLInputElement>('.omni-har__search')!;
            // Sorting while a keystroke is still pending renders zero rows, so
            // the render that would restore focus never runs — its flag must not
            // survive to steal focus from a later, unrelated render.
            input.value = 'zzzz';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            button(container, 'har.column.time').click();
            vi.advanceTimersByTime(HAR_SEARCH_DEBOUNCE_MS);
            expect(rows(container)).toHaveLength(0);
            input.focus();
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            vi.advanceTimersByTime(HAR_SEARCH_DEBOUNCE_MS);
            expect(rows(container)).toHaveLength(8);
            expect(document.activeElement).toBe(input);
        } finally {
            container.remove();
        }
    });

    it('leaves the detail pane and its focus alone while filtering', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        try {
            await mountHarViewer({ fileName: 'session.har', data: harFixture() }, container, ctx as never, { styleIsolation: 'scoped' });
            const tab = button(container, 'har.detail.timings');
            tab.focus();
            tab.click();
            const active = document.activeElement;
            expect(active).toBe(button(container, 'har.detail.timings'));
            search(container, 'app.css');
            expect(rowNames(container)).toEqual(['app.css']);
            // A row filter has nothing to do with the detail pane.
            expect(document.activeElement).toBe(active);
            setFilter(container, 'har.filter.method', 'GET');
            expect(document.activeElement).toBe(active);
        } finally {
            container.remove();
        }
    });

    it('says how many form fields and cookies it left out', async () => {
        const params = Array.from({ length: 250 }, (_, i) => [`field${i}`, String(i)] as [string, string]);
        const cookies = Array.from({ length: 250 }, (_, i) => [`cookie${i}`, String(i)] as [string, string]);
        const data = new TextEncoder().encode(harLog([harEntry({
            method: 'POST', responseCookies: cookies,
            postData: { mimeType: 'application/x-www-form-urlencoded', params }
        })]));
        const container = document.createElement('div');
        await mountHarViewer({ fileName: 'session.har', data }, container, ctx as never, { styleIsolation: 'scoped' });
        button(container, 'har.detail.payload').click();
        expect(container.querySelectorAll('.omni-har__props dt')).toHaveLength(200);
        expect(container.querySelector('.omni-har__detail-body')?.textContent).toContain('har.moreRows');
        button(container, 'har.detail.cookies').click();
        expect(container.querySelectorAll('.omni-har__props dt')).toHaveLength(200);
        expect(container.querySelector('.omni-har__detail-body')?.textContent).toContain('har.moreRows');
    });

    it('keeps keyboard focus on a row when a debounced filter lands', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        try {
            await mountHarViewer({ fileName: 'session.har', data: harFixture() }, container, ctx as never, { styleIsolation: 'scoped' });
            const row = rows(container)[1]!;
            row.focus();
            expect(document.activeElement).toBe(row);
            search(container, 'example.com');
            // The row survives the filter, so the keyboard place is kept — a
            // row dropped by the filter has nothing left to focus.
            expect(document.activeElement).toBe(rows(container)[1]);
            expect(document.activeElement).not.toBe(row);
        } finally {
            container.remove();
        }
    });

    it('retires a pending keystroke render when an explicit control acts', async () => {
        const { container } = await mounted();
        const input = container.querySelector<HTMLInputElement>('.omni-har__search')!;
        input.value = 'v1/items';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setFilter(container, 'har.filter.method', 'POST');
        const table = container.querySelector('table');
        // The select applied the typed text immediately, without waiting.
        expect(rows(container)).toHaveLength(1);
        expect(rowNames(container)).toEqual(['items']);
        vi.advanceTimersByTime(HAR_SEARCH_DEBOUNCE_MS);
        // The filter already applied the typed text; the retired timer must not
        // rebuild the table a second time.
        expect(container.querySelector('table')).toBe(table);
    });

    it('does not render after dispose, even with a keystroke in flight', async () => {
        const t = vi.fn(ctx.i18n.t);
        const container = document.createElement('div');
        const handle = await mountHarViewer({ fileName: 'session.har', data: harFixture() }, container, { ...ctx, i18n: { t } } as never, { styleIsolation: 'scoped' });
        const input = container.querySelector<HTMLInputElement>('.omni-har__search')!;
        input.value = 'app';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        handle.dispose();
        t.mockClear();
        vi.advanceTimersByTime(HAR_SEARCH_DEBOUNCE_MS * 4);
        expect(t).not.toHaveBeenCalled();
    });

    it('says how many headers it left out', async () => {
        const headers = Array.from({ length: 250 }, (_, i) => [`x-header-${i}`, String(i)] as [string, string]);
        const data = new TextEncoder().encode(harLog([harEntry({ responseHeaders: headers })]));
        const container = document.createElement('div');
        await mountHarViewer({ fileName: 'session.har', data }, container, ctx as never, { styleIsolation: 'scoped' });
        const body = container.querySelector('.omni-har__detail-body')!;
        const lists = body.querySelectorAll('.omni-har__props');
        expect(lists[lists.length - 1]!.querySelectorAll('dt')).toHaveLength(200);
        expect(body.textContent).toContain('har.moreRows');
    });

    it('shows an unknown size and an unknown offset as unknown', async () => {
        const data = new TextEncoder().encode('{"log":{"version":"1.2","entries":[' +
            '{"startedDateTime":"not a date","time":-1,"request":{"method":"GET","url":"https://e.test/x"},' +
            '"response":{"status":200,"content":{"size":-1,"mimeType":"text/plain"}}}]}}');
        const container = document.createElement('div');
        await mountHarViewer({ fileName: 'odd.har', data }, container, ctx as never, { styleIsolation: 'scoped' });
        const headers = container.querySelector('.omni-har__detail-body')!;
        const value = (label: string): string => {
            const terms = [...headers.querySelectorAll('dt')];
            const term = terms.find(node => node.textContent === label)!;
            return term.nextElementSibling!.textContent!;
        };
        // 0 B and 0 ms would both read as measured values.
        expect(value('har.field.resourceSize')).toBe('—');
        expect(value('har.field.offset')).toBe('—');
        expect(value('har.field.time')).toBe('—');
        // The header drops the duration rather than claiming 0 ms.
        expect(container.querySelector('.omni-har__detail-header div')?.textContent).not.toContain('0 ms');
        button(container, 'har.detail.response').click();
        expect(value('har.field.resourceSize')).toBe('—');
    });

    it('tells the reader when a body could not be fully decoded', async () => {
        const data = new TextEncoder().encode(harLog([harEntry({
            mimeType: 'application/json', encoding: 'base64', text: 'eyJhIjoxfQ==eyJiIjoyfQ=='
        })]));
        const container = document.createElement('div');
        await mountHarViewer({ fileName: 'session.har', data }, container, ctx as never, { styleIsolation: 'scoped' });
        expect(container.querySelector('.omni-har__warnings')?.textContent).toContain('diag.har.body-incomplete');
        button(container, 'har.detail.response').click();
        const notes = [...container.querySelectorAll('.omni-har__note')].map(node => node.textContent);
        expect(notes).toContain('har.body.incomplete');
        expect(notes).not.toContain('har.body.truncated');
    });

    it('does not attribute an untimed bar to a phase nobody measured', async () => {
        // What Apple's and some proxy writers emit: a real `time`, every phase
        // reported as not applicable.
        const data = new TextEncoder().encode(harLog([harEntry({ time: 61, timings: {} })]));
        const container = document.createElement('div');
        await mountHarViewer({ fileName: 'session.har', data }, container, ctx as never, { styleIsolation: 'scoped' });
        const segment = container.querySelector('.omni-har__phase')!;
        expect(segment.className).toContain('omni-har__phase--untimed');
        expect(segment.className).not.toContain('omni-har__phase--receive');
        // The legend colours mean phases; this bar means the duration.
        expect(segment.getAttribute('title')).toBe('har.field.time 61 ms');
        button(container, 'har.detail.timings').click();
        const timings = container.querySelector('.omni-har__detail-body')!;
        expect(timings.textContent).toContain('har.noTimings');
        // The reported-phase list must not claim a total either.
        const terms = [...timings.querySelectorAll('dt')];
        const total = terms.find(node => node.textContent === 'har.timing.total')!;
        expect(total.nextElementSibling!.textContent).toBe('har.notApplicable');
    });

    it('reports a binary body by size instead of decoding it', async () => {
        const { container } = await mounted();
        rows(container)[4]!.click();
        button(container, 'har.detail.response').click();
        expect(container.querySelector('.omni-har__detail-body')?.textContent).toContain('binary 5.00 KB');
        expect(container.querySelector('.omni-har__body')).toBeNull();
    });

    it('copies the selected request and its body through the clipboard service', async () => {
        const writeText = vi.fn();
        const container = document.createElement('div');
        await mountHarViewer({ fileName: 'session.har', data: harFixture() }, container, { ...ctx, clipboard: { writeText } } as never, { styleIsolation: 'scoped' });
        rows(container)[2]!.click();
        button(container, 'har.copyEntry').click();
        expect(writeText.mock.calls[0]![0]).toContain('"url": "https://api.example.com/v1/items?page=2&limit=20"');
        button(container, 'har.detail.response').click();
        button(container, 'har.copyBody').click();
        expect(writeText.mock.calls[1]![0]).toBe('{"error":"not found","code":404}');
    });

    it('disables the copy actions when the host has no clipboard', async () => {
        const { container } = await mounted();
        expect(button(container, 'har.copyEntry').disabled).toBe(true);
        button(container, 'har.detail.response').click();
        expect(button(container, 'har.copyBody').disabled).toBe(true);
    });

    it('shows the page timings and the archive info tabs', async () => {
        const { container } = await mounted();
        button(container, 'har.pages').click();
        expect(container.textContent).toContain('page_1');
        expect(container.textContent).toContain('842 ms');
        button(container, 'har.info').click();
        const info = container.querySelector('.omni-har__props')!;
        // The waterfall's span, not the sum of request times.
        expect(info.textContent).toContain('1.42 s');
        expect(info.textContent).toContain('WebInspector 537.36');
        expect(info.textContent).toContain('Chrome 140.0');
        expect(info.textContent).toContain('2026-03-01T10:00:00.000Z');
    });

    it.each([
        ['unparseable JSON', 'nope', 'diag.har.invalid'],
        ['JSON that is not an archive', '{"notALog":1}', 'diag.har.missing-log']
    ])('reports %s instead of throwing', async (_label, text, messageKey) => {
        const host = document.createElement('div');
        const handle = await mountHarViewer({ fileName: 'broken.har', data: new TextEncoder().encode(text) }, host, ctx as never, { styleIsolation: 'scoped' });
        expect(host.querySelector('.omni-har__warnings')?.textContent).toContain(messageKey);
        expect(host.querySelector('.omni-har__empty')?.textContent).toBe('har.unreadable');
        handle.dispose();
        expect(host.querySelector('.omni-har')).toBeNull();
    });

    it('surfaces parser diagnostics as viewer warnings', async () => {
        const container = document.createElement('div');
        const { result } = parseHar(harLog([harEntry({ startedDateTime: 'nope' })]));
        if (result.status === 'failed') throw new Error('unexpected failure');
        mountHarDocument(result.document, 'session.har', container, ctx as never, { styleIsolation: 'scoped' }, result.diagnostics);
        expect(container.querySelector('.omni-har__warnings')?.textContent).toContain('diag.har.invalid-dates');
    });

    it('renders an archive with no requests without a table', async () => {
        const container = document.createElement('div');
        const handle = await mountHarViewer({ fileName: 'empty.har', data: new TextEncoder().encode(harLog([], { pages: false })) }, container, ctx as never, { styleIsolation: 'scoped' });
        expect(container.querySelector('.omni-har__empty')?.textContent).toBe('har.noEntries');
        expect(container.querySelector('table')).toBeNull();
        handle.dispose();
        expect(container.querySelector('.omni-har')).toBeNull();
    });

    it('rejects a pre-aborted mount', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(mount(harFixture(), { signal: controller.signal })).rejects.toBeInstanceOf(MountAbortedError);
    });

    it('offsets the sticky column header below the sticky panel header', () => {
        // Regression guard: a `top:0` here would hide the first row under the
        // panel header, which is itself sticky at the top of the scroller.
        const sticky = /\.omni-har th\{[^}]*position:sticky;top:(\d+)px/.exec(harViewerCss);
        expect(sticky, 'column headers must be sticky').not.toBeNull();
        expect(Number(sticky![1]), 'offset must clear the panel header').toBeGreaterThan(0);
        expect(harViewerCss).toContain('.omni-har__panel-header{position:sticky;left:0;top:0');
    });
});
