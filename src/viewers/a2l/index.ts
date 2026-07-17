import type { AutomotiveViewerContext } from '../automotive/index.js'; import { mountAutomotiveViewer } from '../automotive/index.js'; import type { MountOptions, ViewerHandle, ViewerInput } from '../types.js';
export { parseA2l } from '../../parsers/a2l/index.js'; export { automotiveViewerCss as a2lViewerCss } from '../automotive/styles.js'; export type A2lViewerContext = AutomotiveViewerContext;
export const A2L_VIEWER_META={id:'a2l',displayNameKey:'a2l.title',extensions:['a2l'],priority:20,requiredServices:[] as const,optionalServices:['clipboard'] as const,inputOwnership:'borrows' as const};
export const mountA2lViewer=(input:ViewerInput,container:HTMLElement,ctx:A2lViewerContext,options:MountOptions={}):Promise<ViewerHandle>=>mountAutomotiveViewer('a2l',input,container,ctx,options);
