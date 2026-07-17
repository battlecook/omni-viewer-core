// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../i18n/index.js';
import { mountMediaViewer } from './media.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('media viewer Blob input', () => {
    it('passes the original Uint8Array view directly to Blob', async () => {
        const NativeBlob = Blob;
        const captured: BlobPart[][] = [];
        class RecordingBlob extends NativeBlob {
            constructor(parts: BlobPart[] = [], options?: BlobPropertyBag) {
                captured.push(parts);
                super(parts, options);
            }
        }
        vi.stubGlobal('Blob', RecordingBlob);
        vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
        vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);

        const backing = Uint8Array.of(9, 1, 2, 3, 9);
        const input = backing.subarray(1, 4);
        const handle = await mountMediaViewer(
            'audio',
            { fileName: 'sample.mp3', data: input },
            document.createElement('div'),
            { assets: { resolveAssetUrl: async path => path }, i18n: createCatalogI18n(), logger: { log: () => undefined } },
            'audio/mpeg',
            [],
            { createObjectUrl: () => 'blob:test', revokeObjectUrl: () => undefined }
        );

        expect(captured[0]?.[0]).toBe(input);
        handle.dispose();
    });
});
