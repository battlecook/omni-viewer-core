// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import type { GgufDocument } from '../../parsers/gguf/index.js';
import { mountGgufDocument, mountGgufViewer } from './index.js';

afterEach(() => vi.unstubAllGlobals());

const model: GgufDocument = {
    format: 'gguf',
    title: 'Tiny GGUF',
    fileSize: '4.00 KB',
    version: 3,
    byteOrder: 'little-endian',
    tensorDataOffset: '256',
    summary: [
        { labelKey: 'gguf.summary.version', value: 'GGUF v3' },
        { labelKey: 'gguf.summary.architecture', value: 'llama' },
        { labelKey: 'gguf.summary.tensors', value: 2 }
    ],
    metadata: [{ key: 'general.architecture', type: 'STRING', value: 'llama' }],
    tensors: [
        { name: 'token_embd.weight', dtype: 'Q4_K', shape: ['4096', '32000'], elements: '131072000', offset: '0', absoluteOffset: '256' },
        { name: 'output_norm.weight', dtype: 'F32', shape: ['4096'], elements: '4096', offset: '73400320', absoluteOffset: '73400576' }
    ],
    tables: [
        {
            titleKey: 'gguf.table.tensors',
            titleArgs: { count: 2 },
            headerKeys: ['gguf.column.name', 'gguf.column.dtype', 'gguf.column.shape'],
            rows: [['token_embd.weight', 'Q4_K', '4096 × 32000'], ['output_norm.weight', 'F32', '4096']]
        },
        {
            titleKey: 'gguf.table.metadata',
            titleArgs: { count: 1 },
            headerKeys: ['gguf.column.key', 'gguf.column.type', 'gguf.column.value'],
            rows: [['general.architecture', 'STRING', 'llama']]
        }
    ],
    rawPreview: 'token_embd.weight  [4096 × 32000]  Q4_K',
    warnings: [{ key: 'gguf.warning.preview' }]
};

const ctx = {
    assets: { resolveAssetUrl: async (assetPath: string) => assetPath },
    logger: { log: vi.fn() },
    i18n: { t: (key: string, args?: Record<string, string | number>) =>
        key === 'gguf.matchingRows' ? `${args?.count} matching rows` : key }
};

describe('mountGgufDocument', () => {
    it('supports the common ViewerInput byte contract', async () => {
        const bytes = new Uint8Array(32);
        bytes.set(new TextEncoder().encode('GGUF'));
        const view = new DataView(bytes.buffer);
        view.setUint32(4, 3, true);
        view.setBigUint64(8, 0n, true);
        view.setBigUint64(16, 0n, true);
        const container = document.createElement('div');

        const handle = await mountGgufViewer(
            { fileName: 'memory.gguf', data: bytes },
            container,
            ctx,
            { styleIsolation: 'scoped' }
        );

        expect(container.textContent).toContain('memory.gguf');
        expect(container.textContent).toContain('GGUF v3');
        handle.dispose();
    });

    it('renders summaries, searchable tables, structure, and warnings', () => {
        const container = document.createElement('div');
        const handle = mountGgufDocument(model, 'model.gguf', container, ctx, { styleIsolation: 'scoped' });

        expect(container.textContent).toContain('model.gguf');
        expect(container.textContent).toContain('gguf.warning.preview');
        expect(container.querySelectorAll('tbody tr')).toHaveLength(2);

        const search = container.querySelector('input') as HTMLInputElement;
        search.value = 'norm';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
        expect(container.textContent).toContain('output_norm.weight');

        const structure = [...container.querySelectorAll('button')]
            .find((button) => button.textContent === 'gguf.structure') as HTMLButtonElement;
        structure.click();
        expect(container.querySelector('pre')?.textContent).toContain('token_embd.weight');

        handle.dispose();
        expect(container.children).toHaveLength(0);
    });

    it('localizes summary labels, table titles, columns, and warnings', () => {
        const container = document.createElement('div');
        mountGgufDocument(
            { ...model, warnings: [{ key: 'gguf.warning.unverifiedDtype' }] },
            'model.gguf',
            container,
            { ...ctx, i18n: createCatalogI18n('ko') },
            { styleIsolation: 'scoped' }
        );

        expect(container.textContent).toContain('버전');
        expect(container.textContent).toContain('텐서 (2)');
        expect(container.textContent).toContain('이름');
        expect(container.textContent).toContain('payload 끝을 검증하지 못했습니다');
    });

    it('shows the parser reason next to the generic invalid warning', () => {
        const container = document.createElement('div');
        mountGgufDocument(
            {
                ...model,
                warnings: [{ key: 'gguf.warning.invalid' }],
                errorDetail: 'GGUF tensor index extends past the end of the file.'
            },
            'broken.gguf',
            container,
            ctx,
            { styleIsolation: 'scoped' }
        );

        const banner = container.querySelector('.omni-gguf__warnings') as HTMLElement;
        expect(banner.hidden).toBe(false);
        expect(banner.textContent).toContain('gguf.warning.invalid');
        expect(banner.querySelector('.omni-gguf__warning-detail')?.textContent)
            .toBe('GGUF tensor index extends past the end of the file.');
    });

    it('hides the warning banner when there is nothing to report', () => {
        const container = document.createElement('div');
        mountGgufDocument({ ...model, warnings: [] }, 'model.gguf', container, ctx, { styleIsolation: 'scoped' });

        expect((container.querySelector('.omni-gguf__warnings') as HTMLElement).hidden).toBe(true);
    });

    it('copies the normalized JSON-safe model through the host clipboard', async () => {
        let resolveCopy!: () => void;
        const writeText = vi.fn(() => new Promise<void>((resolve) => { resolveCopy = resolve; }));
        const container = document.createElement('div');
        mountGgufDocument(model, 'model.gguf', container, { ...ctx, clipboard: { writeText } }, { styleIsolation: 'scoped' });

        const copy = [...container.querySelectorAll('button')]
            .find((button) => button.textContent === 'gguf.copyJson') as HTMLButtonElement;
        copy.click();
        expect(copy.textContent).toBe('gguf.copyJson');
        expect(copy.disabled).toBe(true);
        resolveCopy();
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify(model, null, 2)));
        await vi.waitFor(() => expect(copy.textContent).toBe('common.copied'));
        expect(copy.disabled).toBe(false);
    });

    it('logs clipboard failures without showing a false success state', async () => {
        const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
        const logger = { log: vi.fn() };
        const container = document.createElement('div');
        mountGgufDocument(
            model,
            'model.gguf',
            container,
            { ...ctx, logger, clipboard: { writeText } },
            { styleIsolation: 'scoped' }
        );

        const copy = [...container.querySelectorAll('button')]
            .find((button) => button.textContent === 'gguf.copyJson') as HTMLButtonElement;
        copy.click();

        await vi.waitFor(() => expect(logger.log).toHaveBeenCalledWith('error', expect.stringMatching(/permission denied/)));
        expect(copy.textContent).toBe('gguf.copyJson');
        expect(copy.disabled).toBe(false);
    });

    it('aborts the active remote parse when the mount signal is cancelled', async () => {
        const abort = new AbortController();
        let fetchSignal: AbortSignal | null = null;
        const pendingFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
            fetchSignal = init?.signal as AbortSignal;
            return new Promise<Response>((_resolve, reject) => {
                fetchSignal?.addEventListener('abort', () => reject(fetchSignal?.reason), { once: true });
            });
        });
        vi.stubGlobal('fetch', pendingFetch);

        const mounting = mountGgufViewer(
            { uri: 'https://models.example/model.gguf', fileName: 'model.gguf' },
            document.createElement('div'),
            ctx,
            { signal: abort.signal }
        );
        await vi.waitFor(() => expect(pendingFetch).toHaveBeenCalledTimes(1));
        abort.abort();

        await expect(mounting).rejects.toMatchObject({ name: 'MountAbortedError' });
        expect(fetchSignal).toBe(abort.signal);
    });
});
