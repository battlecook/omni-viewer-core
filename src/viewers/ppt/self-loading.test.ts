import {beforeEach, describe, expect, it, vi} from 'vitest';

const convertEmfToDataUrl = vi.fn<(buffer: ArrayBuffer) => Promise<string | null>>();
const convertWmfToDataUrl = vi.fn<(buffer: ArrayBuffer) => Promise<string | null>>();
vi.mock('emf-converter', () => ({convertEmfToDataUrl, convertWmfToDataUrl}));

import {renderPptMetafile, selfLoadingPptPdfDeps} from './self-loading.js';

describe('self-loading PPT metafile adapter', () => {
    beforeEach(() => {
        convertEmfToDataUrl.mockReset();
        convertWmfToDataUrl.mockReset();
    });

    it('routes emf to convertEmfToDataUrl and returns the data url', async () => {
        convertEmfToDataUrl.mockResolvedValue('data:image/png;base64,AAAA');
        const result = await renderPptMetafile(new Uint8Array([1, 2, 3]), 'emf');
        expect(result).toBe('data:image/png;base64,AAAA');
        expect(convertEmfToDataUrl).toHaveBeenCalledTimes(1);
        expect(convertWmfToDataUrl).not.toHaveBeenCalled();
    });

    it('routes wmf to convertWmfToDataUrl', async () => {
        convertWmfToDataUrl.mockResolvedValue('data:image/png;base64,BBBB');
        const result = await renderPptMetafile(new Uint8Array([9]), 'wmf');
        expect(result).toBe('data:image/png;base64,BBBB');
        expect(convertWmfToDataUrl).toHaveBeenCalledTimes(1);
        expect(convertEmfToDataUrl).not.toHaveBeenCalled();
    });

    it('maps a null conversion result to undefined so the parser can fall back', async () => {
        convertEmfToDataUrl.mockResolvedValue(null);
        expect(await renderPptMetafile(new Uint8Array([1]), 'emf')).toBeUndefined();
    });

    it('passes exactly the view bytes even when the Uint8Array is an offset window', async () => {
        convertEmfToDataUrl.mockResolvedValue('data:image/png;base64,CCCC');
        const backing = new Uint8Array([0, 0, 7, 8, 9, 0]);
        const view = backing.subarray(2, 5); // bytes [7, 8, 9] with byteOffset 2
        await renderPptMetafile(view, 'emf');
        const passed = convertEmfToDataUrl.mock.calls[0]![0];
        expect(passed).toBeInstanceOf(ArrayBuffer);
        expect(Array.from(new Uint8Array(passed))).toEqual([7, 8, 9]);
    });

    it('wires renderMetafile into the self-loading deps', () => {
        expect(selfLoadingPptPdfDeps.renderMetafile).toBe(renderPptMetafile);
    });
});
