import type { AutomotiveViewerContext } from '../automotive/index.js';
import { mountAutomotiveViewer } from '../automotive/index.js';
import type { MountOptions, ViewerHandle, ViewerInput } from '../types.js';
export { parseDbc } from '../../parsers/dbc/index.js';
export { automotiveViewerCss as dbcViewerCss } from '../automotive/styles.js';
export type DbcViewerContext = AutomotiveViewerContext;
export const DBC_VIEWER_META = { id: 'dbc', displayNameKey: 'dbc.title', extensions: ['dbc'], priority: 20, requiredServices: [] as const, optionalServices: ['clipboard'] as const, inputOwnership: 'borrows' as const };
export const mountDbcViewer = (input: ViewerInput, container: HTMLElement, ctx: DbcViewerContext, options: MountOptions = {}): Promise<ViewerHandle> => mountAutomotiveViewer('dbc', input, container, ctx, options);
