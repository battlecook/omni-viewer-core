// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { MountAbortedError } from '../types.js';
import { mountXmlViewer, XML_MAX_CANVAS_HEIGHT, XML_SEARCH_DEBOUNCE_MS, XML_SOURCE_ROW_HEIGHT, xmlScrollTopForRow, xmlVirtualWindow, XML_SOURCE_SEGMENT_CHARS, xmlViewerCss, type XmlViewerHandle } from './index.js';

const ctx = {
    assets: { resolveAssetUrl: async (path: string) => path },
    logger: { log: vi.fn() },
    i18n: { t: (key: string, args?: Record<string, string | number>) => (args ? `${key} ${JSON.stringify(args)}` : key) }
};
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <dependencies>
    <dependency scope="test"><groupId>junit</groupId></dependency>
    <dependency><groupId>org.slf4j</groupId></dependency>
  </dependencies>
</project>`;

async function mount(text: string, context: object = ctx, container = document.createElement('div')) {
    document.body.append(container);
    const handle = await mountXmlViewer({ fileName: 'pom.xml', data: encode(text) }, container, context as never, { styleIsolation: 'scoped' }) as XmlViewerHandle;
    return { container, handle };
}
const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.omni-xml__row')];
const rowFor = (container: HTMLElement, text: string) => rows(container).find((row) => row.textContent?.includes(text))!;
const buttonNamed = (container: HTMLElement, key: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === key)!;

describe('mountXmlViewer', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        document.body.replaceChildren();
    });

    it('renders the header, tree, document info, and line-numbered source', async () => {
        const { container } = await mount(POM);
        expect(container.classList.contains('omni-viewer--xml')).toBe(true);
        expect(container.querySelector('h1')?.textContent).toBe('pom.xml');
        expect(container.querySelector('.omni-xml__subtitle')?.textContent).toBe('<project> · http://maven.apache.org/POM/4.0.0 · UTF-8');
        expect(container.querySelector('.omni-xml__tree')?.getAttribute('role')).toBe('tree');
        expect(rows(container).map((row) => row.getAttribute('aria-level'))).toEqual(['1', '2', '2', '2', '3', '3']);
        expect(rowFor(container, '<modelVersion').textContent).toContain('4.0.0');
        expect(container.querySelector('.omni-xml__inspector h2')?.textContent).toBe('xml.document');
        const source = [...container.querySelectorAll('.omni-xml__source-row')];
        expect(source).toHaveLength(8);
        expect(source[1]!.querySelector('.omni-xml__ln')?.textContent).toBe('2');
        expect(source[1]!.querySelector('.omni-xml__src-tag')?.textContent).toBe('<project');
        expect(container.querySelector('.omni-xml__diagnostics')?.hasAttribute('hidden')).toBe(true);
    });

    it('selects a row, shows its XPath and attributes, and highlights its source', async () => {
        const { container } = await mount(POM);
        rowFor(container, '<dependency scope').click();
        expect(rowFor(container, '<dependency scope').getAttribute('aria-selected')).toBe('true');
        expect(container.querySelector('.omni-xml__xpath')?.textContent).toBe('/project/dependencies/dependency[1]');
        expect(container.querySelector('.omni-xml__table td')?.textContent).toBe('scope');
        expect(container.querySelector('.omni-xml__src-focus')?.textContent).toBe('<dependency');
        expect(container.querySelectorAll('.omni-xml__source-row--range')).toHaveLength(1);
        expect(container.querySelector('.omni-xml__tree')?.getAttribute('aria-activedescendant')).toMatch(/-n\d+$/);
    });

    it('selects the node under a source click', async () => {
        const { container, handle } = await mount(POM);
        const token = [...container.querySelectorAll<HTMLElement>('.omni-xml__src-value')].find((span) => span.textContent === '"test"')!;
        token.click();
        expect(handle.controller.xpath(handle.controller.state.selected!)).toBe('/project/dependencies/dependency[1]/@scope');
        expect(container.querySelector('.omni-xml__inspector .omni-xml__badge')?.textContent).toBe('xml.kind.attribute');
    });

    it('keeps a stray quote in text from swallowing the tags after it on a source click', async () => {
        const { container, handle } = await mount(`<r><a>He said "hi</a><b c="x">it's</b></r>`);
        const tag = [...container.querySelectorAll<HTMLElement>('.omni-xml__src-tag')].find((span) => span.textContent === '<b')!;
        tag.click();
        expect(handle.controller.xpath(handle.controller.state.selected!)).toBe('/r/b');
    });

    it('does not count an xmlns="" un-declaration as a namespace', async () => {
        const { container } = await mount('<s:E xmlns:s="urn:s"><c xmlns="urn:d"><i xmlns=""/></c></s:E>');
        const items = [...container.querySelectorAll('.omni-xml__summary-item')];
        const namespaces = items.find((item) => item.textContent?.includes('xml.summary.namespaces'))!;
        expect(namespaces.querySelector('.omni-xml__summary-value')?.textContent).toBe('2');
    });

    it('marks the ancestor row selected while a hidden attribute is inspected', async () => {
        const { container } = await mount(POM);
        const attributes = container.querySelectorAll<HTMLInputElement>('.omni-xml__toggle input')[1]!;
        attributes.checked = false;
        attributes.dispatchEvent(new Event('change'));
        rowFor(container, '<dependency scope').click();
        container.querySelector<HTMLElement>('.omni-xml__inspector .omni-xml__clickable')!.click();
        expect(container.querySelector('.omni-xml__inspector .omni-xml__badge')?.textContent).toBe('xml.kind.attribute');
        expect(rowFor(container, '<dependency scope').getAttribute('aria-selected')).toBe('true');
        expect([...container.querySelectorAll('.omni-xml__src-focus')].map((span) => span.textContent).join('')).toBe('scope="test"');
    });

    it('previews only the head of a huge attribute value on a row', async () => {
        const { container } = await mount(`<r><img src="data:image/png;base64,${'QUJD\n'.repeat(400_000)}"/></r>`);
        const value = rowFor(container, '<img').querySelector('.omni-xml__attr-value')!.textContent!;
        expect(value.length).toBeLessThan(50);
        expect(value.endsWith('…"')).toBe(true);
    });

    it('searches after the debounce, steps with Enter, and reports the position', async () => {
        const { container, handle } = await mount(POM);
        const search = container.querySelector<HTMLInputElement>('.omni-xml__search')!;
        search.value = 'groupid';
        search.dispatchEvent(new Event('input'));
        expect(handle.controller.state.matches).toEqual([]);
        vi.advanceTimersByTime(XML_SEARCH_DEBOUNCE_MS);
        expect(container.querySelector('.omni-xml__match-status')?.textContent).toBe('xml.matchPosition {"current":1,"total":2}');
        // The second match sits in a collapsed <dependency>; only the first was revealed.
        expect(container.querySelectorAll('.omni-xml__row--match')).toHaveLength(1);
        expect(container.querySelector('.omni-xml__row--current')?.textContent).toContain('junit');
        search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(container.querySelector('.omni-xml__match-status')?.textContent).toBe('xml.matchPosition {"current":2,"total":2}');
        search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
        expect(handle.controller.state.matchIndex).toBe(0);
        // Enter right after typing lands on the first match, not the second.
        search.value = 'dependency';
        search.dispatchEvent(new Event('input'));
        search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(handle.controller.state.matchIndex).toBe(0);
        search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(container.querySelector('.omni-xml__match-status')?.textContent).toBe('');
    });

    it('navigates the tree with the keyboard and toggles attribute rows', async () => {
        const { container, handle } = await mount(POM);
        const tree = container.querySelector<HTMLElement>('.omni-xml__tree')!;
        const key = (k: string) => tree.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
        key('ArrowDown');
        key('ArrowDown');
        expect(handle.controller.xpath(handle.controller.state.selected!)).toBe("/project/namespace::*[name()='']");
        key('ArrowLeft');
        key('Home');
        key(' ');
        expect(rows(container)).toHaveLength(1);
        key(' ');
        const attributes = container.querySelectorAll<HTMLInputElement>('.omni-xml__toggle input')[1]!;
        attributes.checked = false;
        attributes.dispatchEvent(new Event('change'));
        expect(rows(container).some((row) => row.classList.contains('omni-xml__row--attribute'))).toBe(false);
    });

    it('copies XPath, value, and XML through the clipboard service, disabling copy without one', async () => {
        const writeText = vi.fn(async () => undefined);
        const { container } = await mount(POM, { ...ctx, clipboard: { writeText } });
        buttonNamed(container, 'xml.expandAll').click();
        rowFor(container, '<groupId').click();
        buttonNamed(container, 'xml.copyXpath').click();
        buttonNamed(container, 'xml.copyValue').click();
        buttonNamed(container, 'xml.copyXml').click();
        expect(writeText.mock.calls).toEqual([['/project/dependencies/dependency[1]/groupId'], ['junit'], ['<groupId>junit</groupId>']]);
        await vi.runAllTimersAsync();
        expect(container.querySelector('.omni-xml__sr-only')?.textContent).toBe('xml.copied');

        const bare = await mount(POM);
        buttonNamed(bare.container, 'xml.expandAll').click();
        rowFor(bare.container, '<groupId').click();
        expect(buttonNamed(bare.container, 'xml.copyXpath').disabled).toBe(true);
        expect(buttonNamed(bare.container, 'xml.copyXpath').title).toBe('common.noClipboard');
    });

    it('lists well-formedness problems and jumps to them', async () => {
        const { container, handle } = await mount('<a>\n  <b><c>text</b>\n</a>');
        const problems = container.querySelector<HTMLDetailsElement>('.omni-xml__diagnostics')!;
        expect(problems.open).toBe(true);
        const jump = problems.querySelector<HTMLButtonElement>('.omni-xml__link')!;
        expect(jump.textContent).toContain('diag.xml.unclosedElement');
        jump.click();
        expect(handle.controller.xpath(handle.controller.state.selected!)).toBe('/a/b/c');
    });

    it('splits a long single-line document into source segments', async () => {
        const text = `<r>${'<i v="1"/>'.repeat(1000)}</r>`;
        const { container } = await mount(text);
        const lines = [...container.querySelectorAll('.omni-xml__source-row .omni-xml__ln')].map((n) => n.textContent);
        expect(lines.length).toBe(Math.ceil(text.length / XML_SOURCE_SEGMENT_CHARS));
        expect(lines.slice(0, 2)).toEqual(['1', '↪']);
    });

    it('maps scroll positions proportionally once a pane outgrows the canvas cap', () => {
        const small = xmlVirtualWindow(100, 20, 200, 400);
        expect(small).toMatchObject({ height: 2000, first: 10, start: 0, offset: 0 });
        const count = 2_000_000;
        const top = xmlVirtualWindow(count, 20, 0, 400);
        expect(top).toMatchObject({ height: XML_MAX_CANVAS_HEIGHT, first: 0, start: 0, offset: 0 });
        const bottom = xmlVirtualWindow(count, 20, XML_MAX_CANVAS_HEIGHT - 400, 400);
        expect(bottom.end).toBe(count);
        expect(bottom.first).toBe(count - 20);
        // The window's last row ends at the bottom of the canvas.
        expect(bottom.offset + (bottom.end - bottom.start) * 20).toBeCloseTo(XML_MAX_CANVAS_HEIGHT, 6);
        for (const index of [0, 1, 999_999, count - 20]) {
            expect(xmlVirtualWindow(count, 20, xmlScrollTopForRow(index, count, 20, 400), 400).first).toBeCloseTo(index, 6);
        }
    });

    it('lands the last row fully in view when the viewport is not a whole number of rows', () => {
        for (const [count, rowHeight, viewport] of [[400_000, 24, 610], [500_000, 20, 590]] as const) {
            const bottom = xmlVirtualWindow(count, rowHeight, XML_MAX_CANVAS_HEIGHT - viewport, viewport);
            expect(bottom.end).toBe(count);
            expect(bottom.offset + (bottom.end - bottom.start) * rowHeight).toBeCloseTo(XML_MAX_CANVAS_HEIGHT, 6);
            const lastTop = (count - 1 - bottom.first) * rowHeight;
            expect(lastTop + rowHeight).toBeCloseTo(viewport, 6);
            expect(xmlScrollTopForRow(count, count, rowHeight, viewport)).toBeCloseTo(XML_MAX_CANVAS_HEIGHT - viewport, 6);
        }
    });

    it('keeps the toggled row in place when a scaled tree changes size', async () => {
        const text = `<r><a>${'<i/>'.repeat(200_000)}</a><b>${'<i/>'.repeat(200_000)}</b></r>`;
        const { container, handle } = await mount(text);
        const tree = container.querySelector<HTMLElement>('.omni-xml__tree')!;
        const rowsBefore = handle.controller.state.rows.length;
        const b = handle.controller.document.nodes.find((n) => n.name === 'b')!.id;
        tree.scrollTop = xmlScrollTopForRow(handle.controller.state.rows.indexOf(b), rowsBefore, 24, 600);
        tree.dispatchEvent(new Event('scroll'));
        container.querySelector<HTMLElement>(`[data-toggle="${b}"]`)!.click();
        const rows = handle.controller.state.rows;
        expect(rows.length).toBe(rowsBefore - 200_000);
        const { first } = xmlVirtualWindow(rows.length, 24, tree.scrollTop, 600);
        expect(first).toBeCloseTo(rows.indexOf(b), 3);
        expect(container.querySelector(`.omni-xml__row[data-id="${b}"]`)).not.toBeNull();
    });

    it('keeps the end of a document with millions of source rows reachable', async () => {
        const lines = 500_000;
        const text = `<log><![CDATA[${'x\n'.repeat(lines)}]]><end/></log>`;
        const { container, handle } = await mount(text);
        const canvas = container.querySelectorAll<HTMLElement>('.omni-xml__canvas')[1]!;
        expect(parseFloat(canvas.style.height)).toBe(Math.min(XML_MAX_CANVAS_HEIGHT, (lines + 1) * XML_SOURCE_ROW_HEIGHT));
        handle.controller.dispatch({ type: 'select-offset', offset: text.indexOf('<end/>') + 1 });
        expect(handle.controller.xpath(handle.controller.state.selected!)).toBe('/log/end');
        const numbers = [...container.querySelectorAll('.omni-xml__source-row .omni-xml__ln')].map((n) => n.textContent);
        expect(numbers).toContain(String(lines + 1));
    });

    it('tokenizes long CJK and hex runs in linear time with the same highlighting', async () => {
        const cjk = '漢字，かな。'.repeat(330);
        const text = `<book>${`<p a="1" xml:lang='zh'>${cjk}</p>\n<Binary>${'0F'.repeat(1000)}</Binary>\n`.repeat(100)}</book>`;
        const started = Date.now();
        const { container } = await mount(text);
        expect(Date.now() - started).toBeLessThan(1500);
        const row = [...container.querySelectorAll('.omni-xml__source-row')].find((r) => r.textContent?.includes('<p a='))!;
        const all = [...row.querySelectorAll('.omni-xml__code span')].map((span) => [span.className, span.textContent!.slice(0, 6)]);
        const tokens = all.slice(all.findIndex(([, value]) => value === '<p'));
        expect(tokens.slice(0, 6)).toEqual([
            ['omni-xml__src-tag', '<p'], ['', ' '], ['omni-xml__src-attr', 'a'], ['', '='], ['omni-xml__src-value', '"1"'], ['', ' ']
        ]);
        expect(tokens.slice(6, 10)).toEqual([['omni-xml__src-attr', 'xml:la'], ['', '='], ['omni-xml__src-value', "'zh'"], ['omni-xml__src-tag', '>']]);
        // The CJK paragraph stays one plain span.
        expect(tokens[10]).toEqual(['', cjk.slice(0, 6)]);
    });

    it('shows a failure screen for input that is not XML', async () => {
        const { container } = await mount('plain text');
        expect(container.querySelector('[role=alert]')?.textContent).toContain('diag.xml.noRoot');
        expect(container.querySelector('.omni-xml__tree')).toBeNull();
    });

    it('rejects when aborted and leaves nothing behind on dispose', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(mountXmlViewer({ fileName: 'a.xml', data: encode('<a/>') }, document.createElement('div'), ctx as never, { signal: controller.signal })).rejects.toBeInstanceOf(MountAbortedError);

        const { container, handle } = await mount(POM);
        const search = container.querySelector<HTMLInputElement>('.omni-xml__search')!;
        search.value = 'x';
        search.dispatchEvent(new Event('input'));
        handle.dispose();
        vi.advanceTimersByTime(XML_SEARCH_DEBOUNCE_MS);
        expect(container.childElementCount).toBe(0);
        expect(container.classList.contains('omni-viewer--xml')).toBe(false);
        expect(handle.controller.state.search).toBe('');
    });

    it('mounts in a shadow root with its stylesheet and real catalog text', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const handle = await mountXmlViewer({ fileName: 'pom.xml', data: encode(POM) }, container, { ...ctx, i18n: createCatalogI18n('ko') } as never);
        expect(container.shadowRoot?.querySelector('style')?.textContent).toBe(xmlViewerCss);
        expect(container.shadowRoot?.querySelector('.omni-xml__inspector h2')?.textContent).toBe('문서');
        handle.dispose();
        expect(container.shadowRoot?.childElementCount).toBe(0);
    });
});
