import type { AutomotiveViewerContext } from '../automotive/index.js';
import { mountAutomotiveViewer } from '../automotive/index.js';
import type { MountOptions, ViewerHandle, ViewerInput } from '../types.js';
export { parseReqif } from '../../parsers/automotive/index.js';
export { automotiveViewerCss as reqifViewerCss } from '../automotive/styles.js';
export type ReqifViewerContext = AutomotiveViewerContext;
export const REQIF_VIEWER_META = { id: 'reqif', displayNameKey: 'reqif.title', extensions: ['reqif'], priority: 20, requiredServices: [] as const, optionalServices: ['clipboard'] as const, inputOwnership: 'borrows' as const };
export const mountReqifViewer = (input: ViewerInput, container: HTMLElement, ctx: ReqifViewerContext, options: MountOptions = {}): Promise<ViewerHandle> => mountAutomotiveViewer('reqif', input, container, ctx, options);
