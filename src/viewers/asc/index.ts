import type { AutomotiveViewerContext } from '../automotive/index.js'; import { mountAutomotiveViewer } from '../automotive/index.js'; import type { MountOptions, ViewerHandle, ViewerInput } from '../types.js';
export { parseAsc } from '../../parsers/asc/index.js'; export { automotiveViewerCss as ascViewerCss } from '../automotive/styles.js'; export type AscViewerContext = AutomotiveViewerContext;
export const ASC_VIEWER_META={id:'asc',displayNameKey:'asc.title',extensions:['asc'],priority:20,requiredServices:[] as const,optionalServices:['clipboard'] as const,inputOwnership:'borrows' as const};
export const mountAscViewer=(input:ViewerInput,container:HTMLElement,ctx:AscViewerContext,options:MountOptions={}):Promise<ViewerHandle>=>mountAutomotiveViewer('asc',input,container,ctx,options);
