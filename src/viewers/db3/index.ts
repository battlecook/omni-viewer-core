import type { AutomotiveViewerContext } from '../automotive/index.js';
import { mountAutomotiveViewer } from '../automotive/index.js';
import type { MountOptions, ViewerHandle, ViewerInput } from '../types.js';
export { parseDb3 } from '../../parsers/automotive/index.js';
export { automotiveViewerCss as db3ViewerCss } from '../automotive/styles.js';
export type Db3ViewerContext = AutomotiveViewerContext;
export const DB3_VIEWER_META = { id: 'db3', displayNameKey: 'db3.title', extensions: ['db3'], priority: 20, requiredServices: [] as const, optionalServices: ['clipboard'] as const, inputOwnership: 'borrows' as const };
export const mountDb3Viewer = (input: ViewerInput, container: HTMLElement, ctx: Db3ViewerContext, options: MountOptions = {}): Promise<ViewerHandle> => mountAutomotiveViewer('db3', input, container, ctx, options);
