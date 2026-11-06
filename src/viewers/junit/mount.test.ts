// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_EN } from '../../i18n/index.js';
import { parseJUnit } from '../../parsers/junit/index.js';
import { MountAbortedError } from '../types.js';
import { JUNIT_SEARCH_DEBOUNCE_MS, junitViewerCss, mountJUnitDocument, mountJUnitViewer } from './index.js';

// jsdom gives import.meta.url an http: base, so samples resolve from the repo root.
const sample = (name: string): Uint8Array => new Uint8Array(readFileSync(join(process.cwd(), 'examples/junit', name)));
const used = new Set<string>();
const ctx = {
    assets: { resolveAssetUrl: async (path: string) => path },
    logger: { log: vi.fn() },
    i18n: {
        t: (key: string, args?: Record<string, string | number>) => {
            used.add(key);
            return key === 'junit.rows' ? `${args?.shown} / ${args?.total}`
                : key === 'junit.verdict.failed' ? `${args?.count} failing`
                    : key === 'junit.declaredDiffers' ? `${args?.found} (declared ${args?.declared})`
                        : key;
        }
    }
};
const clipboardCtx = (writeText = vi.fn(async (_text: string) => {})) => ({ ...ctx, clipboard: { writeText } });

const mount = async (name: string, context: object = ctx) => {
    const container = document.createElement('div');
    document.body.append(container);
    const handle = await mountJUnitViewer({ fileName: name, data: sample(name) }, container, context as never, { styleIsolation: 'scoped' });
    return { container, handle };
};
const rows = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('.omni-junit__row')];
const rowNames = (container: HTMLElement): string[] => rows(container).map(row => row.querySelector('strong')?.textContent ?? '');
const button = (container: HTMLElement, label: string): HTMLButtonElement =>
    [...container.querySelectorAll('button')].find(node => node.textContent?.startsWith(label)) as HTMLButtonElement;
const setFilter = (container: HTMLElement, label: string, value: string): void => {
    const node = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
};
const search = (container: HTMLElement, text: string): void => {
    const input = container.querySelector<HTMLInputElement>('.omni-junit__search')!;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(JUNIT_SEARCH_DEBOUNCE_MS);
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe('mountJUnitViewer', () => {
    it('renders the verdict, summary and test list in a shadow root, then disposes cleanly', async () => {
        const container = document.createElement('div');
        const handle = await mountJUnitViewer({ fileName: 'TEST-demo.CalcTest.xml', data: sample('gradle-junit5.xml') }, container, ctx as never);
        const root = container.shadowRoot!;
        expect(root.querySelector('style')?.textContent).toBe(junitViewerCss);
        expect(root.querySelector('h1')?.textContent).toBe('TEST-demo.CalcTest.xml');
        expect(root.querySelector('.omni-junit__verdict')?.textContent).toBe('3 failing');
        expect(root.querySelector('.omni-junit__verdict--failed')).not.toBeNull();
        expect(root.querySelectorAll('.omni-junit__summary-item')).toHaveLength(8);
        expect(root.querySelectorAll('.omni-junit__row')).toHaveLength(7);
        expect(root.querySelector('.omni-junit__meter')?.getAttribute('aria-label')).toBe('junit.status.passed 2, junit.status.failed 3, junit.status.error 0, junit.status.skipped 2');
        handle.dispose();
        expect(root.childNodes).toHaveLength(0);
    });

    it('opens on the first failing test and shows its message and trace', async () => {
        const { container } = await mount('gradle-junit5.xml');
        const selected = container.querySelector('.omni-junit__row--selected')!;
        expect(selected.querySelector('strong')?.textContent).toBe('fails()');
        // aria-current, not aria-selected: a plain <table> does not expose selection.
        expect(selected.getAttribute('aria-current')).toBe('true');
        // The live region stays in the accessibility tree before anything is announced.
        expect(getComputedStyle(container.querySelector('.omni-junit__live')!).display).not.toBe('none');
        const detail = container.querySelector('.omni-junit__detail')!;
        expect(detail.querySelector('h2')?.textContent).toBe('fails()');
        expect(detail.querySelector('.omni-junit__result-type')?.textContent).toBe('org.opentest4j.AssertionFailedError');
        expect(detail.querySelector('.omni-junit__message')?.textContent).toContain('expected: <a> but was: <b>');
        expect(detail.querySelector('.omni-junit__pre')?.textContent).toContain('at app//demo.CalcTest.fails(CalcTest.java:9)');
    });

    it('selects with the mouse and keyboard and moves between rows with the arrow keys', async () => {
        const { container } = await mount('gradle-junit5.xml');
        rows(container)[1]!.click();
        expect(container.querySelector('.omni-junit__detail h2')?.textContent).toBe('passes()');
        rows(container)[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(container.querySelector('.omni-junit__detail h2')?.textContent).toBe('aborted()');
        rows(container)[0]!.focus();
        rows(container)[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(document.activeElement).toBe(rows(container)[1]);
    });

    it('filters by status, suite and search, including opt-in output search', async () => {
        const { container } = await mount('pytest-xunit2.xml');
        setFilter(container, 'junit.filter.status', 'problems');
        expect(rowNames(container)).toEqual(['test_fail', 'test_error', 'test_param[2]']);
        setFilter(container, 'junit.filter.status', 'skipped');
        expect(rowNames(container)).toEqual(['test_skip', 'test_xfail']);
        setFilter(container, 'junit.filter.status', '');
        search(container, 'fixture exploded');
        expect(rowNames(container)).toEqual(['test_error']);
        search(container, 'hello stdout');
        expect(rowNames(container)).toEqual([]);
        expect(container.querySelector('.omni-junit__list .omni-junit__empty')?.textContent).toBe('junit.noMatches');
        const toggle = container.querySelector<HTMLInputElement>('.omni-junit__toggle input')!;
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        expect(rowNames(container)).toEqual(['test_pass']);
        // A single suite needs no suite filter.
        expect(container.querySelector<HTMLSelectElement>('select[aria-label="junit.filter.suite"]')!.hidden).toBe(true);
    });

    it('sorts by status severity and by time with the slowest first', async () => {
        const { container } = await mount('gradle-junit5.xml');
        button(container, 'junit.column.status').click();
        expect(rows(container).map(row => row.querySelector('.omni-junit__status')?.textContent)).toEqual([
            'junit.status.failed', 'junit.status.failed', 'junit.status.failed', 'junit.status.skipped', 'junit.status.skipped', 'junit.status.passed', 'junit.status.passed'
        ]);
        expect(document.activeElement?.textContent).toBe('junit.column.status ▲');
        button(container, 'junit.column.time').click();
        expect(rowNames(container)[0]).toBe('aborted()');
        expect(container.querySelector('th[aria-sort]')?.getAttribute('aria-sort')).toBe('descending');
    });

    it('keeps untimed cases last when sorting by time in either direction', async () => {
        const { result } = parseJUnit('<testsuite><testcase name="untimed"/><testcase name="slow" time="2"/><testcase name="fast" time="1"/></testsuite>');
        if (result.status === 'failed') throw new Error('parse');
        const container = document.createElement('div');
        mountJUnitDocument(result.document, 'x.xml', container, ctx as never, { styleIsolation: 'scoped' });
        button(container, 'junit.column.time').click();
        expect(rowNames(container)).toEqual(['slow', 'fast', 'untimed']);
        button(container, 'junit.column.time').click();
        expect(rowNames(container)).toEqual(['fast', 'slow', 'untimed']);
    });

    it('shows nested suites with rolled-up counts and filters the tests to a suite subtree', async () => {
        const { container } = await mount('jenkins-nested-testsuites.xml');
        button(container, 'junit.tab.suites').click();
        const suiteRows = rows(container);
        expect(suiteRows.map(row => row.querySelector('strong')?.textContent)).toEqual(['test.AutomatedTests', 'test.fs.FileSystemTest', 'test.db.DatabaseTest', 'test.3rdlevel']);
        expect(suiteRows[3]!.style.paddingLeft || suiteRows[3]!.querySelector('td')!.style.paddingLeft).toBe('41px');
        expect([...suiteRows[2]!.querySelectorAll('td')].slice(1, 5).map(cell => cell.textContent)).toEqual(['2', '1', '0', '1']);
        suiteRows[2]!.click();
        button(container, 'junit.showTests').click();
        expect(container.querySelector<HTMLSelectElement>('select[aria-label="junit.filter.suite"]')!.value).toBe('2');
        expect(rowNames(container)).toEqual(['test.3rdlevel', 'testTable']);
        expect(container.querySelector('.omni-junit__detail h2')?.textContent).toBe('test.3rdlevel');
        expect(container.querySelector('.omni-junit__detail .omni-junit__note')?.textContent).toBe('junit.syntheticCase');
        // The pressed button is gone with its panel; focus lands on the selected row.
        expect(document.activeElement).toBe(container.querySelector('.omni-junit__row--selected'));
    });

    it('gives a run where every test was skipped its own verdict, not a pass', async () => {
        const { result } = parseJUnit('<testsuite><testcase name="a"><skipped/></testcase><testcase name="b"><skipped/></testcase></testsuite>');
        if (result.status === 'failed') throw new Error('parse');
        const container = document.createElement('div');
        mountJUnitDocument(result.document, 'x.xml', container, { ...ctx, i18n: { t: (key: string, args?: Record<string, string | number>) => `${key}:${args?.count ?? ''}` } } as never, { styleIsolation: 'scoped' });
        expect(container.querySelector('.omni-junit__verdict--skipped')?.textContent).toBe('junit.verdict.skipped:2');
    });

    it('scrolls only the list to the opening failure, and says so when it is past the rendered rows', async () => {
        const original = HTMLElement.prototype.getBoundingClientRect;
        // A 400px-tall list at the top of the page; rows are 40px tall in document order.
        HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
            const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
            if (this.classList.contains('omni-junit__list')) return rect(0, 400);
            if (this.classList.contains('omni-junit__panel-header')) return rect(0, 42);
            if (this.localName === 'thead') return rect(42, 30);
            if (this.classList.contains('omni-junit__row')) {
                const list = this.closest('.omni-junit__list') as HTMLElement;
                return rect(72 + [...this.parentElement!.children].indexOf(this) * 40 - list.scrollTop, 40);
            }
            return rect(0, 0);
        };
        const scrollIntoView = vi.fn();
        (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView = scrollIntoView;
        try {
            const near = parseJUnit(`<testsuite>${'<testcase name="ok"/>'.repeat(150)}<testcase name="bad"><failure/></testcase></testsuite>`).result;
            if (near.status === 'failed') throw new Error('parse');
            const container = document.createElement('div');
            mountJUnitDocument(near.document, 'x.xml', container, ctx as never, { styleIsolation: 'scoped' });
            const list = container.querySelector<HTMLElement>('.omni-junit__list')!;
            // Row 150 spans 6072–6112; the list shows 0–400, so it scrolls by 5712.
            expect(list.scrollTop).toBe(5712);
            expect(scrollIntoView).not.toHaveBeenCalled();
            // A later filter change does not yank the list back to the selection.
            list.scrollTop = 0;
            setFilter(container, 'junit.filter.status', 'passed');
            expect(list.scrollTop).toBe(0);

            const far = parseJUnit(`<testsuite>${'<testcase name="ok"/>'.repeat(2100)}<testcase name="bad"><failure/></testcase></testsuite>`).result;
            if (far.status === 'failed') throw new Error('parse');
            const farContainer = document.createElement('div');
            mountJUnitDocument(far.document, 'x.xml', farContainer, ctx as never, { styleIsolation: 'scoped' });
            expect(farContainer.querySelector('.omni-junit__panel-header span')?.textContent).toBe('2000 / 2101 · junit.selectedHidden');
            expect(farContainer.querySelector('.omni-junit__detail h2')?.textContent).toBe('bad');
        } finally {
            HTMLElement.prototype.getBoundingClientRect = original;
            delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
        }
    });

    it('renders at most the capped result blocks and counts the rest', async () => {
        const { result } = parseJUnit(`<testsuite><testcase name="t">${'<failure message="m"/>'.repeat(250)}</testcase></testsuite>`);
        if (result.status === 'failed') throw new Error('parse');
        const container = document.createElement('div');
        mountJUnitDocument(result.document, 'x.xml', container, ctx as never, { styleIsolation: 'scoped' });
        expect(container.querySelectorAll('.omni-junit__result')).toHaveLength(100);
        expect([...container.querySelectorAll('.omni-junit__detail .omni-junit__note')].map(node => node.textContent)).toContain('junit.moreRows');
    });

    it('keeps keyboard-focused rows clear of the sticky headers', () => {
        // jsdom has no layout; the contract is the scroll padding on the list.
        expect(junitViewerCss).toMatch(/\.omni-junit__list\{[^}]*scroll-padding-top:76px/);
    });

    it('leads the warning area with the report\'s own diagnostics and counts the overflow', async () => {
        const cases = Array.from({ length: 30 }, (_, i) => `<testcase name="t${i}">${i === 0 ? '<failure/>' : ''}<system-out>&#27;[31mred&#27;[0m</system-out></testcase>`).join('');
        const container = document.createElement('div');
        await mountJUnitViewer({ fileName: 'x.xml', data: new TextEncoder().encode(`<testsuite name="S" tests="30" failures="1">${cases}</testsuite>`) }, container, ctx as never,
            { styleIsolation: 'scoped', parse: { limits: { maxEntries: 10 } } });
        const rows = [...container.querySelectorAll('.omni-junit__warnings > div')].map(node => node.textContent);
        expect(rows[0]).toBe('diag.junit.caseLimit');
        expect(rows).toHaveLength(21);
        expect(rows[20]).toBe('junit.moreRows');
    });

    it('does not call a partly read report a pass', async () => {
        const text = '<testsuites tests="3" failures="1"><testsuite name="s" tests="3" failures="1"><testcase name="a"/><testcase name="b"/><testcase name="c"><failure message="boom"/></testcase></testsuite></testsuites>';
        const container = document.createElement('div');
        await mountJUnitViewer({ fileName: 'x.xml', data: new TextEncoder().encode(text) }, container,
            { ...ctx, i18n: { t: (key: string, args?: Record<string, string | number>) => `${key}:${args?.count ?? ''}` } } as never,
            { styleIsolation: 'scoped', parse: { limits: { maxEntries: 2 } } });
        expect(container.querySelector('.omni-junit__verdict--incomplete')?.textContent).toBe('junit.verdict.incomplete:2');
        expect(container.querySelector('.omni-junit__verdict--passed')).toBeNull();
    });

    it('shows the root\'s declared-vs-found totals in the suite detail when they disagree', async () => {
        const { container } = await mount('jenkins-nested-testsuites.xml');
        button(container, 'junit.tab.suites').click();
        // The root declares tests="186" for 3 cases.
        expect(container.querySelector('.omni-junit__detail')?.textContent).toContain('3 (declared 186)');
    });

    it('reports declared totals that disagree with the file', async () => {
        const { container } = await mount('jenkins-suite-error.xml');
        expect(container.querySelector<HTMLElement>('.omni-junit__warnings')?.hidden).toBe(false);
        expect(container.querySelector('.omni-junit__warnings')?.textContent).toContain('diag.junit.countMismatch');
        button(container, 'junit.tab.suites').click();
        // The symbol is hidden; the meaning is spoken through visually hidden text.
        expect(container.querySelector('.omni-junit__mismatch')?.getAttribute('aria-hidden')).toBe('true');
        expect(container.querySelector('.omni-junit__sr')?.textContent).toBe('junit.countMismatch');
        expect(container.querySelector('.omni-junit__detail')?.textContent).toContain('1 (declared 2)');
        // A single-suite root is that suite: its mismatch is stated once.
        expect(container.querySelectorAll('.omni-junit__detail-body .omni-junit__note.omni-junit__mismatch')).toHaveLength(1);
    });

    it('copies a failure report and the source, announcing the result', async () => {
        const writeText = vi.fn(async (_text: string) => {});
        const { container } = await mount('vitest.xml', clipboardCtx(writeText));
        const copy = button(container, 'junit.copyCase');
        expect(copy.disabled).toBe(false);
        copy.click();
        await vi.runAllTicks();
        await Promise.resolve();
        expect(writeText.mock.calls[0]![0]).toBe([
            'sample.test.ts › math > fails', 'junit.status.failed · 3.7 ms', 'sample.test.ts', '',
            '[junit.result.failure] AssertionError', 'expected { a: 1 } to deeply equal { a: 2 }',
            'AssertionError: expected { a: 1 } to deeply equal { a: 2 }\n\n- Expected\n+ Received\n\n  {\n-   "a": 2,\n+   "a": 1,\n  }\n\n ❯ sample.test.ts:4:40'
        ].join('\n'));
        expect(container.querySelector('.omni-junit__live')?.textContent).toBe('junit.copied');
        button(container, 'junit.tab.source').click();
        button(container, 'junit.copySource').click();
        expect(writeText.mock.calls[1]![0]).toBe(new TextDecoder().decode(sample('vitest.xml')));
        expect(container.querySelector('.omni-junit__source')?.textContent).toContain('<testsuites name="vitest tests"');
    });

    it('announces a clipboard failure and disables copying without a clipboard', async () => {
        const { container } = await mount('vitest.xml', clipboardCtx(vi.fn(async (_text: string) => { throw new Error('denied'); })));
        button(container, 'junit.copyCase').click();
        await Promise.resolve();
        await Promise.resolve();
        expect(container.querySelector('.omni-junit__live')?.textContent).toBe('junit.copyFailed');
        const { container: bare } = await mount('vitest.xml');
        expect(button(bare, 'junit.copyCase').disabled).toBe(true);
        expect(button(bare, 'junit.copyCase').title).toBe('common.noClipboard');
    });

    it('renders an unreadable file as a failure frame', async () => {
        const container = document.createElement('div');
        const handle = await mountJUnitViewer({ fileName: 'x.xml', data: new TextEncoder().encode('<project/>') }, container, ctx as never, { styleIsolation: 'scoped' });
        expect(container.classList.contains('omni-viewer--junit')).toBe(true);
        expect(container.querySelector('.omni-junit__warnings')?.textContent).toContain('diag.junit.notJunit');
        handle.dispose();
        expect(container.childNodes).toHaveLength(0);
        expect(container.classList.contains('omni-viewer--junit')).toBe(false);
    });

    it('rejects an aborted mount before adding UI', async () => {
        const controller = new AbortController();
        controller.abort();
        const container = document.createElement('div');
        await expect(mountJUnitViewer({ fileName: 'x.xml', data: sample('vitest.xml') }, container, ctx as never, { signal: controller.signal })).rejects.toBeInstanceOf(MountAbortedError);
        expect(container.childNodes).toHaveLength(0);
        expect(container.shadowRoot).toBeNull();
    });

    it('mounts a pre-parsed model, caps rendered rows, and cancels a pending search on dispose', async () => {
        const text = `<testsuite name="big">${Array.from({ length: 2100 }, (_, i) => `<testcase name="t${i}" time="0.001"/>`).join('')}</testsuite>`;
        const { result } = parseJUnit(text);
        if (result.status === 'failed') throw new Error('parse');
        const container = document.createElement('div');
        const handle = mountJUnitDocument(result.document, 'big.xml', container, ctx as never, { styleIsolation: 'scoped' });
        expect(rows(container)).toHaveLength(2000);
        expect(container.querySelector('.omni-junit__panel-header span')?.textContent).toBe('2000 / 2100');
        const input = container.querySelector<HTMLInputElement>('.omni-junit__search')!;
        input.value = 't1';
        input.dispatchEvent(new Event('input'));
        handle.dispose();
        expect(() => vi.advanceTimersByTime(JUNIT_SEARCH_DEBOUNCE_MS)).not.toThrow();
        expect(container.childNodes).toHaveLength(0);
    });

    it('uses only keys present in the English catalog', async () => {
        used.clear();
        for (const name of ['gradle-junit5.xml', 'pytest-xunit2.xml', 'jenkins-nested-testsuites.xml']) {
            const { container } = await mount(name, clipboardCtx());
            for (const tab of ['junit.tab.suites', 'junit.tab.source', 'junit.tab.tests']) button(container, tab).click();
        }
        const missing = [...used].filter(key => !(key in CATALOG_EN));
        expect(missing).toEqual([]);
    });
});
