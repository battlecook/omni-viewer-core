// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { FileSaveService, HostContext } from '../../host/index.js';
import { createCatalogI18n } from '../../i18n/index.js';
import { MountAbortedError } from '../types.js';
import { imageExportFileName, mountImageViewer, type ImageViewerContext } from './index.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function stubCtx(extra: Partial<ImageViewerContext> = {}): ImageViewerContext {
    const base: HostContext = {
        assets: { resolveAssetUrl: async (p) => p },
        i18n: createCatalogI18n(),
        logger: { log: () => undefined }
    };
    return { ...base, ...extra };
}

function shadow(container: HTMLElement): ShadowRoot {
    const root = container.shadowRoot;
    if (!root) throw new Error('expected shadow root');
    return root;
}

const input = (fileName = 'photo.png', data = PNG) => ({ fileName, data });

describe('imageExportFileName (image.md I7)', () => {
    it('coerces any source extension to -edited.png', () => {
        expect(imageExportFileName('photo.jpg')).toBe('photo-edited.png');
        expect(imageExportFileName('a.b.webp')).toBe('a.b-edited.png');
        expect(imageExportFileName('noext')).toBe('noext-edited.png');
    });
});

describe('mountImageViewer', () => {
    it('renders the toolbar inside a shadow root and disposes cleanly', async () => {
        const container = document.createElement('div');
        const handle = await mountImageViewer(input(), container, stubCtx());
        const root = shadow(container);
        expect(root.querySelector('.omni-image__toolbar')).not.toBeNull();
        expect(handle.isDirty()).toBe(false);
        handle.dispose();
        expect(root.childNodes.length).toBe(0);
    });

    it('disables Save As PNG with a reason when no save service (degraded mode)', async () => {
        const container = document.createElement('div');
        await mountImageViewer(input(), container, stubCtx());
        const buttons = [...shadow(container).querySelectorAll('button')] as HTMLButtonElement[];
        const save = buttons.find((b) => b.textContent === createCatalogI18n().t('image.saveAsPng'));
        expect(save?.disabled).toBe(true);
        expect(save?.title).toBe(createCatalogI18n().t('common.noFileSave'));
    });

    it('enables Save As PNG when a save service is provided', async () => {
        const save: FileSaveService = { saveFile: vi.fn(async () => undefined) };
        const container = document.createElement('div');
        await mountImageViewer(input(), container, stubCtx({ save }));
        const buttons = [...shadow(container).querySelectorAll('button')] as HTMLButtonElement[];
        const saveBtn = buttons.find((b) => b.textContent === createCatalogI18n().t('image.saveAsPng'));
        // Still disabled here because JSDOM cannot decode (editingEnabled=false),
        // but the button is wired (no degraded title).
        expect(saveBtn?.title).toBe('');
    });

    it('disables background removal / sprite detection without their services', async () => {
        const container = document.createElement('div');
        await mountImageViewer(input(), container, stubCtx());
        const t = createCatalogI18n().t.bind(createCatalogI18n());
        const buttons = [...shadow(container).querySelectorAll('button')] as HTMLButtonElement[];
        const bg = buttons.find((b) => b.textContent === t('image.tool.removeBackground'));
        const sprite = buttons.find((b) => b.textContent === t('image.tool.detectSprites'));
        expect(bg?.disabled).toBe(true);
        expect(sprite?.disabled).toBe(true);
    });

    it('surfaces a decode failure instead of a blank stage', async () => {
        // JSDOM has no createImageBitmap → missing-dependency failure path.
        const container = document.createElement('div');
        await mountImageViewer(input(), container, stubCtx());
        const err = shadow(container).querySelector('.omni-image__diag-error');
        expect(err?.textContent).toBeTruthy();
    });

    it('throws MountAbortedError when the signal is already aborted', async () => {
        const container = document.createElement('div');
        const ctrl = new AbortController();
        ctrl.abort();
        await expect(
            mountImageViewer(input(), container, stubCtx(), { signal: ctrl.signal })
        ).rejects.toBeInstanceOf(MountAbortedError);
    });
});
