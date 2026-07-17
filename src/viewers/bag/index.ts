import type { AutomotiveViewerContext } from '../automotive/index.js';
import { mountAutomotiveViewer } from '../automotive/index.js';
import type { MountOptions, ViewerHandle, ViewerInput } from '../types.js';
export { parseBag } from '../../parsers/automotive/index.js';
export { automotiveViewerCss as bagViewerCss } from '../automotive/styles.js';
export type BagViewerContext = AutomotiveViewerContext;
export const BAG_VIEWER_META = { id: 'bag', displayNameKey: 'bag.title', extensions: ['bag'], priority: 20, requiredServices: [] as const, optionalServices: ['clipboard'] as const, inputOwnership: 'borrows' as const };
export const mountBagViewer = (input: ViewerInput, container: HTMLElement, ctx: BagViewerContext, options: MountOptions = {}): Promise<ViewerHandle> => mountAutomotiveViewer('bag', input, container, ctx, options);
