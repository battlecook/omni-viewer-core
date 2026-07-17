import type { DecodedPsd, PsdMountOptions } from './index.js';

interface AgPsdModule {
    readPsd?(buffer: ArrayBuffer, options?: Record<string, unknown>): {
        canvas?: HTMLCanvasElement;
        children?: unknown[];
    };
}

export function createPsdDecoder(mod: AgPsdModule): Pick<PsdMountOptions, 'decode'> {
    if (!mod.readPsd) throw new Error('ag-psd decoder is unavailable.');
    return {
        decode: async (data): Promise<DecodedPsd> => {
            const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
            // The preview consumes ag-psd's composite canvas. `useImageData`
            // redirects that bitmap to psd.imageData and therefore must not be
            // enabled here. Layer pixels are unnecessary for this preview.
            const psd = mod.readPsd!(copy, { skipLayerImageData: true, skipThumbnail: true });
            return {
                ...(psd.canvas ? { element: psd.canvas } : {}),
                layerCount: psd.children?.length ?? 0
            };
        }
    };
}

export async function loadPsdDecoder(): Promise<Pick<PsdMountOptions, 'decode'>> {
    return createPsdDecoder(await import('ag-psd' as string) as AgPsdModule);
}
