// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createPsdDecoder } from './self-loading.js';

describe('PSD self-loading decoder', () => {
    it('requests ag-psd canvas output instead of redirecting the composite to imageData', async () => {
        const canvas = document.createElement('canvas');
        const readPsd = vi.fn((_buffer: ArrayBuffer, _options?: Record<string, unknown>) => ({ canvas, children: [{}, {}] }));
        const decoder = createPsdDecoder({ readPsd });
        const decoded = await decoder.decode!(new Uint8Array([1, 2, 3]), {
            version: 1,
            channels: 4,
            height: 1,
            width: 1,
            depth: 8,
            colorMode: 3,
            colorModeName: 'RGB',
            pixelCount: 1,
            warnings: []
        });

        expect(readPsd).toHaveBeenCalledWith(expect.any(ArrayBuffer), {
            skipLayerImageData: true,
            skipThumbnail: true
        });
        expect(readPsd.mock.calls[0]?.[1]).not.toHaveProperty('useImageData');
        expect(decoded).toEqual({ element: canvas, layerCount: 2 });
    });
});
