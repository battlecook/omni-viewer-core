// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { HTML_PREVIEW_MAX_DELIMITERS, htmlPreviewDocument } from '../html/index.js';
import { MountAbortedError } from '../types.js';
import { mountEmlViewer, type EmlViewerContext } from './index.js';

const ctx: EmlViewerContext = {
    assets: { resolveAssetUrl: async path => path },
    logger: { log: () => undefined }, i18n: createCatalogI18n('en')
};
const mail = (body = 'Hello world', headers = 'Content-Type: text/plain; charset=utf-8') =>
    `From: Sender <sender@example.com>\nTo: reader@example.com\nSubject: =?UTF-8?B?7JWI64WV?=\nDate: Thu, 29 Oct 2026 10:00:00 +0900\n${headers}\n\n${body}`;
const fixture = () => mail([
    '--mix', 'Content-Type: multipart/alternative; boundary=alt', '',
    '--alt', 'Content-Type: text/plain', '', 'Plain message',
    '--alt', 'Content-Type: text/html', '', '<body class="newsletter"><p>Hello <b>HTML</b></p><img src="cid:logo"><img src="https://tracker.test/open"><script>alert(1)</script><a href="https://external.test">Link</a><form action="https://evil.test">Bad</form></body>',
    '--alt--', '--mix', 'Content-Type: image/png', 'Content-ID: <logo>', 'Content-Transfer-Encoding: base64', '', 'AAEC/w==',
    '--mix', 'Content-Type: application/pdf', 'Content-Disposition: attachment; filename="../../report.pdf"', 'Content-Transfer-Encoding: base64', '', 'JVBERg==', '--mix--'
].join('\n'), 'Content-Type: multipart/mixed; boundary=mix');
async function mount(source = mail(), context: EmlViewerContext = ctx, shadow = false) {
    const container = document.createElement('div');
    const handle = await mountEmlViewer({ fileName: 'message.eml', data: new TextEncoder().encode(source) }, container, context, { styleIsolation: shadow ? 'shadow' : 'scoped' });
    return { container, handle, root: shadow ? container.shadowRoot! : container };
}
const button = (root: ParentNode, label: string): HTMLButtonElement => [...root.querySelectorAll('button')].find(node => node.textContent === label)!;

describe('EML viewer', () => {
    it('renders decoded subject and metadata and switches text, headers and raw source', async () => {
        const { root, handle } = await mount();
        expect(root.querySelector('h1')?.textContent).toBe('안녕');
        expect(root.querySelector('.omni-eml__metadata')?.textContent).toContain('Sender <sender@example.com>');
        expect(root.querySelector('.omni-eml__text')?.textContent).toBe('Hello world');
        expect(root.querySelector<HTMLElement>('.omni-eml__text')?.hidden).toBe(false);
        button(root, 'Headers').click();
        expect(root.querySelector<HTMLElement>('.omni-eml__text')?.hidden).toBe(true);
        expect(button(root, 'Headers').getAttribute('aria-pressed')).toBe('true');
        button(root, 'Source').click();
        expect(root.querySelector('.omni-eml__source')?.textContent).toContain('Subject: =?UTF-8?B?');
        handle.dispose();
    });

    it('isolates HTML, resolves embedded images and blocks scripts, navigation and remote tracking', async () => {
        const { root, handle } = await mount(fixture());
        const frame = root.querySelector('iframe')!;
        expect(frame.getAttribute('sandbox')).toBe('');
        expect(frame.referrerPolicy).toBe('no-referrer');
        const doc = new DOMParser().parseFromString(frame.srcdoc, 'text/html');
        expect(doc.body.className).toBe('newsletter');
        expect(doc.querySelector('b')?.textContent).toBe('HTML');
        expect(doc.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAEC/w==');
        expect(doc.querySelectorAll('img')[1]?.getAttribute('src')).toBeNull();
        expect(doc.querySelectorAll('script,form,iframe')).toHaveLength(0);
        expect(doc.querySelector('a')?.hasAttribute('href')).toBe(false);
        expect(doc.querySelector('meta[http-equiv]')?.getAttribute('content')).toContain("default-src 'none'");
        button(root, 'Text').click(); expect(frame.hidden).toBe(true);
        handle.dispose(); expect(frame.hasAttribute('srcdoc')).toBe(false);
    });

    it('validates mapped embedded resources through the shared sanitizer', () => {
        const preview = htmlPreviewDocument('<img src="cid:bad"><iframe src="cid:bad"></iframe>', new Map([['cid:bad', 'https://tracker.test/pixel']]));
        expect(preview).not.toContain('tracker.test');
        expect(preview).not.toContain('<iframe');
    });

    it('bounds CID data URL expansion across repeated image occurrences', async () => {
        const image = btoa('x'.repeat(64 * 1024));
        const source = (count: number) => mail([
            '--x', 'Content-Type: text/html', '', '<img src="cid:logo">'.repeat(count),
            '--x', 'Content-Type: image/png', 'Content-ID: <logo>', 'Content-Transfer-Encoding: base64', '', image, '--x--'
        ].join('\n'), 'Content-Type: multipart/related; boundary=x');
        const repeated = await mount(source(70));
        expect(repeated.root.querySelector('iframe')).toBeNull();
        expect(repeated.root.querySelector('.omni-eml__status')?.textContent).toContain('too large or complex');
        repeated.handle.dispose();
        const bounded = await mount(source(2));
        const frame = bounded.root.querySelector('iframe')!;
        expect(frame.srcdoc.match(/data:image\/png;base64,/g)).toHaveLength(2);
        expect(frame.srcdoc.length).toBeLessThan(8 * 1024 * 1024);
        bounded.handle.dispose();
    });

    it('uses CID images from the selected related alternative rather than discarded branches', async () => {
        const branch = (boundary: string, text: string, image: string) => [
            `--${boundary}`, 'Content-Type: text/html', '', `<p>${text}<img src="cid:logo"></p>`,
            `--${boundary}`, 'Content-Type: image/png', 'Content-ID: <logo>', '', image, `--${boundary}--`
        ].join('\n');
        const { root, handle } = await mount(mail([
            '--alt', 'Content-Type: multipart/related; boundary=old', '', branch('old', 'Old', 'OLD'),
            '--alt', 'Content-Type: multipart/related; boundary=new', '', branch('new', 'New', 'NEW'), '--alt--'
        ].join('\n'), 'Content-Type: multipart/alternative; boundary=alt'));
        const preview = root.querySelector('iframe')!.srcdoc;
        expect(preview).toContain('<p>New');
        expect(preview).toContain(`data:image/png;base64,${btoa('NEW')}`);
        expect(preview).not.toContain(`data:image/png;base64,${btoa('OLD')}`);
        handle.dispose();
    });

    it('saves decoded attachment bytes with sanitized filenames and copies text through host services', async () => {
        const saveFile = vi.fn().mockResolvedValue({ status: 'saved' });
        const writeText = vi.fn().mockResolvedValue(undefined);
        const { root, handle } = await mount(fixture(), { ...ctx, save: { saveFile }, clipboard: { writeText } });
        expect(root.querySelector('.omni-eml__attachments')?.textContent).toContain('Attachments (2)');
        root.querySelector<HTMLButtonElement>('[aria-label="Save report.pdf"]')!.click();
        expect(saveFile).toHaveBeenCalledWith('report.pdf', Uint8Array.of(37, 80, 68, 70), 'application/pdf');
        button(root, 'Copy text').click(); expect(writeText).toHaveBeenCalledWith('Plain message');
        await Promise.resolve(); handle.dispose();
    });

    it('disables host actions in degraded mode', async () => {
        const { root, handle } = await mount(fixture());
        expect(button(root, 'Copy text').disabled).toBe(true);
        for (const save of root.querySelectorAll<HTMLButtonElement>('.omni-eml__attachments button')) expect(save.disabled).toBe(true);
        handle.dispose();
    });

    it('reports rejected host actions and ignores later completions after disposal', async () => {
        const { root, handle } = await mount(fixture(), {
            ...ctx, clipboard: { writeText: async () => { throw new Error('denied'); } },
            save: { saveFile: async () => { throw new Error('denied'); } }
        });
        button(root, 'Copy text').click(); button(root, 'Save').click();
        await vi.waitFor(() => expect(root.querySelector('.omni-eml__status')?.textContent).toContain('Could not save'));
        expect(root.querySelector('.omni-eml__status')?.textContent).toContain('Could not copy');
        const detached = button(root, 'Copy text'); handle.dispose(); detached.click();
        expect(root.childNodes).toHaveLength(0);
    });

    it('cleans shadow styles and listeners while preserving unrelated host elements', async () => {
        const { root, container, handle } = await mount(mail(), ctx, true);
        expect(root.querySelector('style')).not.toBeNull();
        const marker = document.createElement('div'); root.append(marker);
        handle.dispose(); handle.dispose();
        expect([...root.childNodes]).toEqual([marker]);
        expect(container.classList.contains('omni-viewer--eml')).toBe(false);
    });

    it('renders malformed input with diagnostics and bounded raw source', async () => {
        const { root, handle } = await mount('bad input');
        expect(root.querySelector('.omni-eml__status')?.textContent).toContain('recognizable email');
        expect(root.querySelector('.omni-eml__source')?.textContent).toBe('bad input'); handle.dispose();
        const large = await mount(mail('x'.repeat(600 * 1024)));
        expect(large.root.querySelector('.omni-eml__source')?.textContent?.length).toBe(512 * 1024);
        expect(large.root.textContent).toContain('Showing the first 524288 bytes'); large.handle.dispose();
    });

    it('limits dense HTML before any DOM parsing and selects source view', async () => {
        const { root, handle } = await mount(mail('<b>'.repeat(HTML_PREVIEW_MAX_DELIMITERS + 1), 'Content-Type: text/html'));
        expect(root.querySelector('iframe')).toBeNull();
        expect(root.querySelector('.omni-eml__status')?.textContent).toContain('too large or complex');
        expect(button(root, 'Source').getAttribute('aria-pressed')).toBe('true'); handle.dispose();
    });

    it('renders empty messages and localizes labels', async () => {
        const { root, handle } = await mount('From: sender@example.com\n\n', { ...ctx, i18n: createCatalogI18n('ko') });
        expect(root.querySelector('h1')?.textContent).toBe('(제목 없음)');
        expect(root.querySelector('.omni-eml__empty')?.textContent).toBe('표시할 수 있는 메일 본문이 없습니다.');
        expect(button(root, '원문')).toBeDefined(); handle.dispose();
    });

    it('rejects pre-aborted mounts without touching the container', async () => {
        const abort = new AbortController(); abort.abort();
        const container = document.createElement('div');
        await expect(mountEmlViewer({ fileName: 'mail.eml', data: new Uint8Array() }, container, ctx, { signal: abort.signal })).rejects.toBeInstanceOf(MountAbortedError);
        expect(container.childNodes).toHaveLength(0); expect(container.shadowRoot).toBeNull();
    });
});
