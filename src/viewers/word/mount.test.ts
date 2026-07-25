// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type { HostContext, PrintService } from '../../host/index.js';
import { createCatalogI18n } from '../../i18n/index.js';
import {
    mountWordViewer,
    type WordRenderStatus,
    type WordViewerContext
} from './index.js';
import type { ZipModule } from './docx-preprocess.js';

const ctx = (print?: PrintService): WordViewerContext => ({
    assets: { resolveAssetUrl: async (path) => path }, i18n: createCatalogI18n(), logger: { log: () => undefined }, ...(print ? { print } : {})
});
const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const zip = { loadAsync: async () => { const archive = { file: (() => null) as never, forEach: () => undefined, generateAsync: async () => docx }; return archive; } } as ZipModule;
const deps = (renderAsync: (...args: any[]) => Promise<unknown>) => ({ loadDocxPreview: async () => ({ renderAsync }), loadZip: async () => zip });

async function chartDocx(sourceType: 'barChart' | 'lineChart' | 'pieChart'): Promise<Uint8Array> {
    const archive = new JSZip();
    archive.file(
        'word/document.xml',
        '<w:document><w:body><w:drawing><c:chart r:id="rChart"/></w:drawing></w:body></w:document>'
    );
    archive.file(
        'word/_rels/document.xml.rels',
        '<Relationships><Relationship Id="rChart" Target="charts/chart1.xml" Type="chart"/></Relationships>'
    );
    archive.file(
        'word/charts/chart1.xml',
        `<c:chartSpace><c:chart><c:title><a:t>Revenue</a:t></c:title><c:plotArea><c:${sourceType}><c:ser><c:tx><c:v>Sales</c:v></c:tx><a:srgbClr val="112233"/><c:cat><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:cat><c:val><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:val></c:ser></c:${sourceType}></c:plotArea></c:chart></c:chartSpace>`
    );
    return archive.generateAsync({ type: 'uint8array' });
}

describe('mountWordViewer', () => {
    it('renders docx-preview in a shadow root and disposes cleanly', async () => {
        const renderAsync = vi.fn(async (_data, body: HTMLElement) => { body.append(document.createElement('article')); });
        const container = document.createElement('div');
        const handle = await mountWordViewer({ fileName: 'sample.docx', data: docx }, container, ctx(), deps(renderAsync));
        expect(renderAsync).toHaveBeenCalledOnce();
        expect(container.shadowRoot?.querySelector('[role="document"] article')).not.toBeNull();
        expect(handle.contentElement.getAttribute('role')).toBe('document');
        expect(handle.viewportElement.contains(handle.contentElement)).toBe(true);
        expect(handle.status).toMatchObject({ state: 'ready', format: 'docx', renderer: 'core' });
        const statusListener = vi.fn();
        const unsubscribe = handle.subscribeStatus(statusListener);
        expect(statusListener).toHaveBeenCalledWith(handle.status);
        unsubscribe();
        handle.dispose();
        expect(container.shadowRoot?.querySelector('.omni-word')).toBeNull();
        expect(container.shadowRoot?.childNodes).toHaveLength(0);
    });

    it('shows a visible dependency error instead of a blank frame', async () => {
        const container = document.createElement('div');
        const handle = await mountWordViewer({ fileName: 'sample.docx', data: docx }, container, ctx());
        expect(container.shadowRoot?.querySelector('.omni-word__error')?.textContent).toContain('not installed');
        expect(handle.status).toMatchObject({
            state: 'failed',
            failure: { code: 'missing-dependency' }
        });
        if (handle.status.state === 'failed') {
            expect(handle.status.diagnostics).toEqual(expect.arrayContaining([
                expect.objectContaining({ code: 'missing-dependency', severity: 'error' })
            ]));
        }
    });

    it('supports zoom controls and degrades print explicitly', async () => {
        const container = document.createElement('div');
        const handle = await mountWordViewer({ fileName: 'sample.docx', data: docx }, container, ctx(), deps(async () => undefined));
        const buttons = [...(container.shadowRoot?.querySelectorAll('button') ?? [])] as HTMLButtonElement[];
        buttons.find((button) => button.getAttribute('aria-label') === 'Zoom in')?.click();
        expect(handle.controller.state.zoom).toBe(1.1);
        const print = buttons.find((button) => button.getAttribute('aria-label') === 'Print');
        expect(print?.disabled).toBe(true);
    });

    it('uses the host print service', async () => {
        const print = { print: vi.fn() };
        const container = document.createElement('div');
        await mountWordViewer({ fileName: 'sample.docx', data: docx }, container, ctx(print), deps(async () => undefined));
        const button = [...(container.shadowRoot?.querySelectorAll('button') ?? [])].find((node) => node.getAttribute('aria-label') === 'Print') as HTMLButtonElement;
        button.click(); expect(print.print).toHaveBeenCalledOnce();
    });

    it('blocks remote resources and routes allowed links through navigation', async () => {
        const openExternalUrl = vi.fn(async () => undefined); const container = document.createElement('div');
        const render = async (_data: unknown, body: HTMLElement): Promise<void> => { const anchor = document.createElement('a'); anchor.href = 'https://example.com/path'; anchor.textContent = 'safe'; const image = document.createElement('img'); image.src = 'https://tracker.example/pixel'; body.append(anchor, image); };
        const handle = await mountWordViewer({ fileName: 'sample.docx', data: docx }, container, { ...ctx(), navigation: { openExternalUrl } }, deps(render));
        const anchor = container.shadowRoot?.querySelector('a') as HTMLAnchorElement; const image = container.shadowRoot?.querySelector('img') as HTMLImageElement;
        expect(anchor.hasAttribute('href')).toBe(false); expect(image.hasAttribute('src')).toBe(false); anchor.click(); expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/path');
        expect(handle.status.state).toBe('partial');
        if (handle.status.state === 'partial') {
            expect(handle.status.diagnostics).toEqual(expect.arrayContaining([
                expect.objectContaining({ code: 'blocked-external-resource' })
            ]));
        }
    });

    it('logs explicit degraded-mode warnings when legacy embedded deps are absent', async () => {
        const log = vi.fn(); const container = document.createElement('div');
        await mountWordViewer({ fileName: 'legacy.doc', data: new Uint8Array([1, 2, 3]) }, container, { ...ctx(), logger: { log } });
        expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('loadSheet'));
        expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('loadZip'));
    });

    it.each(['shadow', 'scoped'] as const)(
        'exposes stable roots and custom toolbar actions in %s mode',
        async (styleIsolation) => {
            let disabled = false;
            let finish!: () => void;
            const pending = new Promise<void>((resolve) => { finish = resolve; });
            const run = vi.fn(() => pending);
            const actionError = vi.fn();
            const container = document.createElement('div');
            const handle = await mountWordViewer(
                { fileName: 'sample.docx', data: docx },
                container,
                ctx(),
                deps(async () => undefined),
                {
                    styleIsolation,
                    toolbarActions: [{
                        id: 'save-pdf',
                        label: 'PDF로 저장',
                        ariaLabel: 'PDF 저장',
                        disabled: () => disabled,
                        run
                    }],
                    onToolbarActionError: actionError
                }
            );
            const root = styleIsolation === 'shadow' ? container.shadowRoot! : container;
            const action = root.querySelector<HTMLButtonElement>('[data-action-id="save-pdf"]')!;
            expect(handle.viewportElement.contains(handle.contentElement)).toBe(true);
            action.click();
            await Promise.resolve();
            expect(run).toHaveBeenCalledOnce();
            expect(action.disabled).toBe(true);
            expect(action.getAttribute('aria-busy')).toBe('true');
            finish();
            await pending;
            await Promise.resolve();
            disabled = true;
            handle.refreshToolbarActions();
            expect(action.disabled).toBe(true);
            handle.dispose();
            expect(root.childNodes).toHaveLength(0);
            expect(actionError).not.toHaveBeenCalled();
        }
    );

    it('reports toolbar action failures to the host callback', async () => {
        const onToolbarActionError = vi.fn();
        const container = document.createElement('div');
        await mountWordViewer(
            { fileName: 'sample.docx', data: docx },
            container,
            ctx(),
            deps(async () => undefined),
            {
                toolbarActions: [{
                    id: 'fail',
                    label: 'Fail',
                    run: () => { throw new Error('action failed'); }
                }],
                onToolbarActionError
            }
        );
        container.shadowRoot
            ?.querySelector<HTMLButtonElement>('[data-action-id="fail"]')
            ?.click();
        await Promise.resolve();
        await Promise.resolve();
        expect(onToolbarActionError).toHaveBeenCalledWith(
            expect.objectContaining({ message: 'action failed' }),
            expect.objectContaining({ id: 'fail' })
        );
    });

    it('runs a host fallback with the same signal and exposes fallback-ready status', async () => {
        const controller = new AbortController();
        const statuses: WordRenderStatus[] = [];
        const fallbackRenderer = vi.fn(async (context) => {
            expect(context.signal).toBe(controller.signal);
            context.container.append(document.createElement('article'));
            return true;
        });
        const container = document.createElement('div');
        const handle = await mountWordViewer(
            { fileName: 'sample.docx', data: docx },
            container,
            ctx(),
            {},
            {
                signal: controller.signal,
                fallbackRenderer,
                onStatusChange: (status) => statuses.push(status)
            }
        );
        expect(statuses[0]).toMatchObject({ state: 'loading', format: 'docx' });
        expect(handle.status).toMatchObject({
            state: 'ready',
            format: 'docx',
            renderer: 'fallback'
        });
        expect(handle.contentElement.querySelector('article')).not.toBeNull();
        if (handle.status.state === 'ready') {
            expect(handle.status.diagnostics).toEqual(expect.arrayContaining([
                expect.objectContaining({ code: 'fallback-renderer-used' })
            ]));
        }
    });

    it('surfaces fallback renderer failures as structured diagnostics', async () => {
        const handle = await mountWordViewer(
            { fileName: 'sample.docx', data: docx },
            document.createElement('div'),
            ctx(),
            {},
            {
                fallbackRenderer: async () => {
                    throw new Error('mammoth failed');
                }
            }
        );
        expect(handle.status).toMatchObject({
            state: 'failed',
            failure: { code: 'fallback-renderer-failed' }
        });
        if (handle.status.state === 'failed') {
            expect(handle.status.diagnostics).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    code: 'fallback-renderer-failed',
                    detail: 'mammoth failed'
                })
            ]));
        }
    });

    it('passes the documented docx-preview options while keeping the wrapper stable', async () => {
        const renderAsync = vi.fn(async (..._args: unknown[]) => undefined);
        await mountWordViewer(
            { fileName: 'sample.docx', data: docx },
            document.createElement('div'),
            ctx(),
            deps(renderAsync),
            {
                docxRenderOptions: {
                    inWrapper: false,
                    experimental: false,
                    renderFootnotes: false,
                    renderEndnotes: false
                }
            }
        );
        expect(renderAsync.mock.calls[0]?.[3]).toMatchObject({
            inWrapper: true,
            renderHeaders: true,
            renderFooters: true,
            renderFootnotes: false,
            renderEndnotes: false,
            useBase64URL: true,
            experimental: false
        });
    });

    it.each([
        ['barChart', 'rect'],
        ['lineChart', 'polyline'],
        ['pieChart', 'path']
    ] as const)('renders cached %s data with its original SVG geometry', async (sourceType, selector) => {
        const data = await chartDocx(sourceType);
        const renderAsync = async (
            prepared: ArrayBuffer | Uint8Array,
            body: HTMLElement
        ): Promise<void> => {
            const archive = await JSZip.loadAsync(prepared);
            const xml = await archive.file('word/document.xml')?.async('string') ?? '';
            const token = xml.match(/__OMNI_WORD_CHART_\d+__/)?.[0] ?? '';
            body.append(document.createTextNode(token));
        };
        const handle = await mountWordViewer(
            { fileName: 'chart.docx', data },
            document.createElement('div'),
            ctx(),
            {
                loadDocxPreview: async () => ({ renderAsync }),
                loadZip: async () => JSZip as unknown as ZipModule
            }
        );
        expect(handle.contentElement.querySelector(`.omni-word__chart svg ${selector}`)).not.toBeNull();
        expect(handle.contentElement.textContent).toContain('Revenue');
        expect(handle.contentElement.textContent).toContain('Sales');
    });

    it('distinguishes password errors and configured input limits', async () => {
        const encrypted = await mountWordViewer(
            { fileName: 'encrypted.docx', data: docx },
            document.createElement('div'),
            ctx(),
            deps(async () => { throw new Error('Encrypted package requires a password'); })
        );
        expect(encrypted.status).toMatchObject({
            state: 'failed',
            failure: { code: 'password-required', recoverable: true }
        });

        const encryptedPackage = new Uint8Array(128);
        encryptedPackage.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        'EncryptedPackage'.split('').forEach((char, index) => {
            encryptedPackage[32 + index * 2] = char.charCodeAt(0);
        });
        const encryptedOoxml = await mountWordViewer(
            { fileName: 'encrypted.docx', data: encryptedPackage },
            document.createElement('div'),
            ctx()
        );
        expect(encryptedOoxml.status).toMatchObject({
            state: 'failed',
            failure: { code: 'password-required', recoverable: true }
        });

        const invalid = await mountWordViewer(
            { fileName: 'not-word.docx', data: new Uint8Array([1, 2, 3]) },
            document.createElement('div'),
            ctx(),
            deps(async () => undefined)
        );
        expect(invalid.status).toMatchObject({
            state: 'failed',
            failure: { code: 'invalid-format', recoverable: false }
        });

        const corrupted = await mountWordViewer(
            { fileName: 'damaged.docx', data: docx },
            document.createElement('div'),
            ctx(),
            {
                loadDocxPreview: async () => ({ renderAsync: async () => undefined }),
                loadZip: async () => {
                    throw new Error('Corrupt central directory');
                }
            }
        );
        expect(corrupted.status).toMatchObject({
            state: 'failed',
            failure: { code: 'corrupted', recoverable: false }
        });

        const limited = await mountWordViewer(
            { fileName: 'large.docx', data: docx },
            document.createElement('div'),
            ctx(),
            deps(async () => undefined),
            { limits: { maxInputBytes: 1 } }
        );
        expect(limited.status).toMatchObject({
            state: 'failed',
            failure: { code: 'limit-exceeded', recoverable: false }
        });
    });

    it('uses partial status when a host page limit truncates rendered pages', async () => {
        const handle = await mountWordViewer(
            { fileName: 'pages.docx', data: docx },
            document.createElement('div'),
            ctx(),
            deps(async (_data, body: HTMLElement) => {
                const wrapper = document.createElement('div');
                wrapper.className = 'docx-wrapper';
                wrapper.append(
                    document.createElement('section'),
                    document.createElement('section'),
                    document.createElement('section')
                );
                body.append(wrapper);
            }),
            { limits: { maxPages: 2 } }
        );
        expect(handle.contentElement.querySelectorAll('.docx-wrapper > section')).toHaveLength(2);
        expect(handle.status.state).toBe('partial');
        if (handle.status.state === 'partial') {
            expect(handle.status.diagnostics).toEqual(expect.arrayContaining([
                expect.objectContaining({ code: 'limit-exceeded' })
            ]));
        }
    });

    it('revokes renderer blob URLs on dispose', async () => {
        const revoke = vi.fn();
        const original = URL.revokeObjectURL;
        URL.revokeObjectURL = revoke;
        try {
            const handle = await mountWordViewer(
                { fileName: 'blob.docx', data: docx },
                document.createElement('div'),
                ctx(),
                deps(async (_data, body: HTMLElement) => {
                    const image = document.createElement('img');
                    image.src = 'blob:https://example.test/word-image';
                    body.append(image);
                }),
                { docxRenderOptions: { useBase64URL: false } }
            );
            handle.dispose();
            expect(revoke).toHaveBeenCalledWith('blob:https://example.test/word-image');
        } finally {
            URL.revokeObjectURL = original;
        }
    });

    it('aborts an in-flight render and removes its DOM', async () => {
        let finish!: () => void;
        const rendering = new Promise<void>((resolve) => { finish = resolve; });
        const controller = new AbortController();
        const statuses: WordRenderStatus[] = [];
        const container = document.createElement('div');
        const mounted = mountWordViewer(
            { fileName: 'sample.docx', data: docx },
            container,
            ctx(),
            deps(async (_data, body: HTMLElement) => {
                await rendering;
                body.append(document.createElement('article'));
            }),
            {
                signal: controller.signal,
                onStatusChange: (status) => statuses.push(status)
            }
        );
        await Promise.resolve();
        controller.abort();
        expect(container.shadowRoot?.childNodes).toHaveLength(0);
        expect(statuses.at(-1)?.state).toBe('aborted');
        finish();
        await expect(mounted).rejects.toMatchObject({ name: 'MountAbortedError' });
    });

    it('prevents a superseded render from overwriting the new mount', async () => {
        let finishFirst!: () => void;
        const firstRendering = new Promise<void>((resolve) => { finishFirst = resolve; });
        const container = document.createElement('div');
        const first = mountWordViewer(
            { fileName: 'first.docx', data: docx },
            container,
            ctx(),
            deps(async (_data, body: HTMLElement) => {
                await firstRendering;
                const article = document.createElement('article');
                article.textContent = 'old';
                body.append(article);
            })
        );
        await Promise.resolve();
        const second = await mountWordViewer(
            { fileName: 'second.docx', data: docx },
            container,
            ctx(),
            deps(async (_data, body: HTMLElement) => {
                const article = document.createElement('article');
                article.textContent = 'new';
                body.append(article);
            })
        );
        finishFirst();
        await expect(first).rejects.toMatchObject({ name: 'MountAbortedError' });
        expect(second.contentElement.textContent).toContain('new');
        expect(second.contentElement.textContent).not.toContain('old');
    });
});
