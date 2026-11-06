// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { CATALOG_EN } from '../../i18n/catalog.en.js';
import { attachment, channel, chunk, concat, file, message, metadata, schema, statistics, time } from '../../parsers/mcap/__tests__/fixtures.js';
import * as loader from '../../parsers/mcap/self-loading.js';
import { MountAbortedError, type ViewerHandle } from '../types.js';
import { formatMcapTime, mountMcapViewer, type McapMountOptions } from './index.js';
import { mountSelfLoadingMcapViewer } from './self-loading.js';
import * as lz4 from 'lz4js';

const ctx = { assets: { resolveAssetUrl: vi.fn() }, i18n: createCatalogI18n(), logger: { log: vi.fn() } };
const handles: ViewerHandle[] = [];
afterEach(() => { handles.splice(0).forEach(handle => handle.dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); });
async function mount(data = file([schema, channel(), message(), metadata, attachment]), options: McapMountOptions = {}) {
    const container = document.createElement('div'); document.body.append(container);
    const writeText = vi.fn(async (_value: string) => undefined);
    const handle = await mountMcapViewer({ fileName: 'robot.mcap', data }, container, { ...ctx, clipboard: { writeText } }, {}, options);
    handles.push(handle);
    const root = options.styleIsolation === 'scoped' ? container : container.shadowRoot!;
    return { container, root, handle, writeText };
}
function tab(root: ParentNode, name: string) { [...root.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(button => button.textContent === name)!.click(); }
function button(root: ParentNode, name: string): HTMLButtonElement { return [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === name)!; }

describe('MCAP viewer', () => {
    it('renders a localized topic table, summary and exact recording times in shadow isolation', async () => {
        const { root } = await mount();
        expect(root.querySelector('h1')?.textContent).toBe('robot.mcap');
        expect(root.querySelector('style')?.textContent).toContain('.omni-mcap');
        expect(root.querySelector('tbody')?.textContent).toContain('/telemetry');
        expect(root.querySelector('tbody')?.textContent).toContain('Telemetry');
        expect(root.querySelector('dl')?.textContent).toContain('1700000000.000000123 s');
        expect(root.querySelectorAll('[role=tab]')).toHaveLength(6);
        expect(ctx.assets.resolveAssetUrl).not.toHaveBeenCalled();
    });

    it('explores messages as formatted JSON or exact raw hex and copies a selected sample', async () => {
        const { root, writeText } = await mount();
        tab(root, 'Messages'); button(root, 'Inspect').click();
        expect(root.querySelector('pre')?.textContent).toBe('{\n  "speed": 42\n}');
        button(root, 'Hex').click(); expect(root.querySelector('pre')?.textContent).toContain('7b 22 73 70');
        button(root, 'Text').click(); button(root, 'Copy JSON').click(); await Promise.resolve();
        expect(writeText).toHaveBeenCalledOnce(); expect(JSON.parse(writeText.mock.calls[0]![0]).preview.text).toContain('speed');
        expect(root.querySelector('.omni-mcap__status')?.textContent).toBe('Copied to clipboard');
        button(root, 'Close preview').click(); expect(root.querySelector<HTMLElement>('.omni-mcap__detail')?.hidden).toBe(true);
    });

    it('searches retained messages, filters topics and copies only the filtered table', async () => {
        const data = file([schema, channel(), channel(2, '/camera'), message(1, 1, '{"speed":42}'), message(2, 2, '{"camera":true}')]);
        const { root, writeText } = await mount(data); tab(root, 'Messages');
        const topic = root.querySelector<HTMLSelectElement>('select')!; topic.value = '2'; topic.dispatchEvent(new Event('change'));
        expect(root.querySelector('tbody')?.textContent).toContain('/camera'); expect(root.querySelector('tbody')?.textContent).not.toContain('/telemetry');
        const search = root.querySelector<HTMLInputElement>('input')!; search.value = 'camera'; search.dispatchEvent(new Event('input'));
        button(root, 'Copy JSON').click(); await Promise.resolve();
        const copied = JSON.parse(writeText.mock.calls[0]![0]); expect(copied.rows).toHaveLength(1); expect(copied.rows[0].cells[0]).toBe('/camera');
        search.value = 'no such topic'; search.dispatchEvent(new Event('input'));
        expect(root.querySelector('.omni-mcap__empty')?.textContent).toContain('No matching records');
    });

    it('paginates message samples and resets the page when searching', async () => {
        const { root } = await mount(file([schema, channel(), ...Array.from({ length: 205 }, (_, index) => message(index + 1))]));
        tab(root, 'Messages'); expect(root.querySelectorAll('tbody tr')).toHaveLength(100);
        button(root, 'Next page').click(); expect(root.querySelector('.omni-mcap__pagination')?.textContent).toContain('Page 2 / 3');
        button(root, 'Next page').click(); expect(root.querySelectorAll('tbody tr')).toHaveLength(5);
        expect(button(root, 'Next page').disabled).toBe(true);
        button(root, 'Previous page').click(); expect(root.querySelectorAll('tbody tr')).toHaveLength(100);
        const search = root.querySelector<HTMLInputElement>('input')!; search.value = '/telemetry'; search.dispatchEvent(new Event('input'));
        expect(root.querySelector('.omni-mcap__pagination')?.textContent).toContain('Page 1 / 3');
    });

    it('shows schemas, channel metadata and attachments, and defaults binary payloads to hex', async () => {
        const { root } = await mount(file([schema, channel(1, '/cdr', 'cdr'), message(1, 1, '\u0000\u0001'), metadata, attachment]));
        tab(root, 'Schemas'); button(root, 'Inspect').click(); expect(root.querySelector('pre')?.textContent).toContain('"type": "object"');
        tab(root, 'Metadata'); expect(root.querySelector('tbody')?.textContent).toContain('alpha'); expect(root.querySelector('tbody')?.textContent).toContain('robot');
        tab(root, 'Attachments'); expect(root.querySelector('tbody')?.textContent).toContain('calibration.txt');
        tab(root, 'Messages'); button(root, 'Inspect').click(); expect(root.querySelector('pre')?.textContent).toBe('00 01');
    });

    it('supports keyboard tab navigation and safe untrusted topic/file content', async () => {
        const { root } = await mount(file([schema, channel(1, '<img src=x onerror=alert(1)>'), message()]));
        expect(root.querySelector('img')).toBeNull(); expect(root.querySelector('tbody')?.textContent).toContain('<img');
        const current = root.querySelector<HTMLButtonElement>('[role=tab][aria-selected=true]')!;
        current.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(root.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe('Messages');
        expect(root.querySelector('[role=tabpanel]')?.getAttribute('aria-labelledby')).toBe(root.querySelector('[role=tab][aria-selected=true]')?.id);
    });

    it('cleans up scoped/shadow mounts and removes listeners while preserving host content', async () => {
        const { container, root, handle } = await mount(file(), { styleIsolation: 'scoped' });
        const host = document.createElement('p'); host.textContent = 'host content'; container.append(host);
        const input = root.querySelector<HTMLInputElement>('input')!;
        const content = root.querySelector('.omni-mcap__content')!; const before = content.innerHTML;
        handle.dispose(); handle.dispose();
        input.value = 'missing'; input.dispatchEvent(new Event('input')); expect(content.innerHTML).toBe(before);
        expect(container.childNodes).toHaveLength(1); expect(container.textContent).toBe('host content');
        const shadow = await mount(); shadow.handle.dispose(); expect(shadow.root.childNodes).toHaveLength(0);
    });

    it('shows graceful failure, missing-codec and truncated-preview messages', async () => {
        const invalid = await mount(new Uint8Array()); expect(invalid.root.querySelector('[role=alert]')?.textContent).toContain('not an MCAP');
        const compressed = await mount(file([chunk(new Uint8Array(), 'zstd')], [schema, channel(), statistics()]));
        expect(compressed.root.querySelector('.omni-mcap__warnings')?.textContent).toContain('LZ4/Zstd');
        tab(compressed.root, 'Chunks'); expect(compressed.root.querySelector('tbody')?.textContent).toContain('zstd');
        const limited = await mount(file(), { parse: { previewBytesPerMessage: 2 } });
        tab(limited.root, 'Messages'); button(limited.root, 'Inspect').click();
        expect(limited.root.querySelector('.omni-mcap__detail-note')?.textContent).toContain('truncated preview');
        for (const outcome of [invalid, compressed, limited]) expect(outcome.root.textContent).not.toMatch(/diag\.mcap\.|mcap\.rows/);
    });

    it('uses Korean controls and diagnostics without unresolved message keys', async () => {
        const container = document.createElement('div');
        handles.push(await mountMcapViewer({ fileName: 'robot.mcap', data: file() }, container, { ...ctx, i18n: createCatalogI18n('ko') }));
        expect(container.shadowRoot?.textContent).toContain('토픽 / 채널'); expect(container.shadowRoot?.textContent).toContain('JSON 복사');
        for (const key of Object.keys(CATALOG_EN).filter(key => key.startsWith('mcap.') || key.startsWith('diag.mcap.'))) expect(createCatalogI18n('ko').t(key)).not.toBe(key);
    });

    it('rejects aborted initialization without attaching UI', async () => {
        const controller = new AbortController(); controller.abort(); const container = document.createElement('div');
        const input = { fileName: 'x.mcap', data: file() };
        await expect(mountMcapViewer(input, container, ctx, {}, { signal: controller.signal })).rejects.toBeInstanceOf(MountAbortedError);
        await expect(mountSelfLoadingMcapViewer(input, container, ctx, { parse: { signal: controller.signal } })).rejects.toBeInstanceOf(MountAbortedError);
        expect(container.shadowRoot).toBeNull(); expect(container.childNodes).toHaveLength(0);
    });

    it('aborts while optional dependencies load and removes signal listeners', async () => {
        let resolve!: (deps: {}) => void;
        vi.spyOn(loader, 'loadMcapDeps').mockImplementation(() => new Promise(done => { resolve = done; }));
        const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
        const container = document.createElement('div');
        const mounted = mountSelfLoadingMcapViewer({ fileName: 'x.mcap', data: file() }, container, ctx, { signal: controller.signal });
        controller.abort(); await expect(mounted).rejects.toBeInstanceOf(MountAbortedError);
        resolve({}); await Promise.resolve();
        expect(remove).toHaveBeenCalled(); expect(container.shadowRoot).toBeNull();
    });

    it('opens compressed recordings through the self-loading viewer entry', async () => {
        const content = concat(schema, channel(), message());
        const container = document.createElement('div');
        handles.push(await mountSelfLoadingMcapViewer({ fileName: 'compressed.mcap', data: file([chunk(content, 'lz4', lz4.compress(content))]) }, container, ctx));
        tab(container.shadowRoot!, 'Messages'); expect(container.shadowRoot?.querySelector('tbody')?.textContent).toContain('speed');
        expect(button(container.shadowRoot!, 'Copy JSON').disabled).toBe(true);
    });

    it('reports rejected clipboard writes and formats timestamp precision independently of locale', async () => {
        const container = document.createElement('div');
        const writeText = vi.fn(async () => { throw new Error('denied'); });
        handles.push(await mountMcapViewer({ fileName: 'x.mcap', data: file() }, container, { ...ctx, clipboard: { writeText } }));
        button(container.shadowRoot!, 'Copy JSON').click(); await Promise.resolve(); await Promise.resolve();
        expect(container.shadowRoot?.querySelector('.omni-mcap__status')?.textContent).toBe('Could not copy JSON.');
        expect(formatMcapTime(String(time))).toBe('1700000000.000000123 s'); expect(formatMcapTime(null)).toBe('—');
    });

    it('preserves large JSON numbers and duplicate keys during inspection', async () => {
        const body = '{"n":18446744073709551615,"key":1,"key":2,"negative":-0,"huge":1e999}';
        const { root } = await mount(file([schema, channel(), message(1, 1, body)]));
        tab(root, 'Messages'); button(root, 'Inspect').click();
        const text = root.querySelector('pre')!.textContent!;
        expect(text).toContain('18446744073709551615');
        expect(text).toContain('"key": 1'); expect(text).toContain('"key": 2');
        expect(text).toContain('"negative": -0'); expect(text).toContain('1e999');
    });

    it('copies full retained payloads and explicit truncation flags without inspecting first', async () => {
        const body = JSON.stringify({ value: 'complete retained payload '.repeat(30) });
        const { root, writeText } = await mount(file([schema, channel(), message(1, 1, body)]));
        tab(root, 'Messages'); button(root, 'Copy JSON').click(); await Promise.resolve();
        const exported = JSON.parse(writeText.mock.calls[0]![0]);
        expect(exported.rows[0].preview.text).toBe(body);
        expect(exported.rows[0].preview.truncated).toBe(false);
        const limited = await mount(file([schema, channel(), message(1, 1, body)]), { parse: { previewBytesPerMessage: 64 } });
        tab(limited.root, 'Messages'); button(limited.root, 'Copy JSON').click(); await Promise.resolve();
        expect(JSON.parse(limited.writeText.mock.calls[0]![0]).rows[0].preview.truncated).toBe(true);
    });
});
