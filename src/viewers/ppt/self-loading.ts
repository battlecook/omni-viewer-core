import type {HostContext} from '../../host/index.js';import type {ViewerInput} from '../types.js';import type {PdfJsModule} from '../pdf/index.js';import {mountPptViewer,type PptMountOptions,type PptViewerDeps,type PptViewerHandle} from './index.js';
export * from './index.js';
// Rasterize an EMF/WMF metafile to a PNG data URL via emf-converter (lazily imported).
// Returns undefined on failure so the parser falls back to its own placeholder path.
export async function renderPptMetafile(input:Uint8Array,type:'wmf'|'emf'):Promise<string|undefined>{const buffer=input.buffer.slice(input.byteOffset,input.byteOffset+input.byteLength) as ArrayBuffer;const {convertEmfToDataUrl,convertWmfToDataUrl}=await import('emf-converter');const url=type==='wmf'?await convertWmfToDataUrl(buffer):await convertEmfToDataUrl(buffer);return url??undefined;}
export const selfLoadingPptPdfDeps={loadPdfjs:()=>import('pdfjs-dist/build/pdf.mjs') as unknown as Promise<PdfJsModule>,renderMetafile:renderPptMetafile};
export function mountSelfLoadingPptViewer(input:ViewerInput,container:HTMLElement,ctx:HostContext,deps:Omit<PptViewerDeps,'loadPdfjs'>={},options:PptMountOptions={}):Promise<PptViewerHandle>{return mountPptViewer(input,container,ctx,{...deps,...selfLoadingPptPdfDeps},options);}
