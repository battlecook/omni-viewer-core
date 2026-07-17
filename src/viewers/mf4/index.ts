import type { AutomotiveViewerContext } from '../automotive/index.js'; import { mountAutomotiveViewer } from '../automotive/index.js'; import type { MountOptions, ViewerHandle, ViewerInput } from '../types.js';
export { parseMf4 } from '../../parsers/mf4/index.js'; export { automotiveViewerCss as mf4ViewerCss } from '../automotive/styles.js'; export type Mf4ViewerContext = AutomotiveViewerContext;
export const MF4_VIEWER_META={id:'mf4',displayNameKey:'mf4.title',extensions:['mf4'],priority:20,requiredServices:[] as const,optionalServices:['clipboard'] as const,inputOwnership:'borrows' as const};
export const mountMf4Viewer=(input:ViewerInput,container:HTMLElement,ctx:Mf4ViewerContext,options:MountOptions={}):Promise<ViewerHandle>=>mountAutomotiveViewer('mf4',input,container,ctx,options);
