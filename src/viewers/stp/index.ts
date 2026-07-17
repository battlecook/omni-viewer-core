import type { AutomotiveViewerContext } from '../automotive/index.js';
import { mountAutomotiveViewer } from '../automotive/index.js';
import type { MountOptions, ViewerHandle, ViewerInput } from '../types.js';
export { parseStp } from '../../parsers/automotive/index.js';
export { automotiveViewerCss as stpViewerCss } from '../automotive/styles.js';
export type StpViewerContext = AutomotiveViewerContext;
export const STP_VIEWER_META = { id: 'stp', displayNameKey: 'stp.title', extensions: ['stp', 'step'], priority: 20, requiredServices: [] as const, optionalServices: ['clipboard'] as const, inputOwnership: 'borrows' as const };
export const mountStpViewer = (input: ViewerInput, container: HTMLElement, ctx: StpViewerContext, options: MountOptions = {}): Promise<ViewerHandle> => mountAutomotiveViewer('stp', input, container, ctx, options);
