import type {HostContext} from '../../host/index.js';import type {ViewerInput} from '../types.js';import type {PdfJsModule} from '../pdf/index.js';import {mountPptViewer,type PptMountOptions,type PptViewerDeps,type PptViewerHandle} from './index.js';
export * from './index.js';
export const selfLoadingPptPdfDeps={loadPdfjs:()=>import('pdfjs-dist/build/pdf.mjs') as unknown as Promise<PdfJsModule>};
export function mountSelfLoadingPptViewer(input:ViewerInput,container:HTMLElement,ctx:HostContext,deps:Omit<PptViewerDeps,'loadPdfjs'>={},options:PptMountOptions={}):Promise<PptViewerHandle>{return mountPptViewer(input,container,ctx,{...deps,...selfLoadingPptPdfDeps},options);}
