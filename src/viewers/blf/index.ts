import type { AutomotiveViewerContext } from '../automotive/index.js'; import { mountAutomotiveViewer } from '../automotive/index.js'; import type { MountOptions, ViewerHandle, ViewerInput } from '../types.js';
export { parseBlf } from '../../parsers/blf/index.js'; export { automotiveViewerCss as blfViewerCss } from '../automotive/styles.js'; export type BlfViewerContext = AutomotiveViewerContext;
export const BLF_VIEWER_META={id:'blf',displayNameKey:'blf.title',extensions:['blf'],priority:20,requiredServices:[] as const,optionalServices:['clipboard'] as const,inputOwnership:'borrows' as const};
export const mountBlfViewer=(input:ViewerInput,container:HTMLElement,ctx:BlfViewerContext,options:MountOptions={}):Promise<ViewerHandle>=>mountAutomotiveViewer('blf',input,container,ctx,options);
