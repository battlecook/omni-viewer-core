import type { AutomotiveViewerContext } from '../automotive/index.js';
import { mountAutomotiveViewer } from '../automotive/index.js';
import type { MountOptions, ViewerHandle, ViewerInput } from '../types.js';
export { parseAvro } from '../../parsers/automotive/index.js';
export { automotiveViewerCss as avroViewerCss } from '../automotive/styles.js';
export type AvroViewerContext = AutomotiveViewerContext;
export const AVRO_VIEWER_META = { id: 'avro', displayNameKey: 'avro.title', extensions: ['avro'], priority: 20, requiredServices: [] as const, optionalServices: ['clipboard'] as const, inputOwnership: 'borrows' as const };
export const mountAvroViewer = (input: ViewerInput, container: HTMLElement, ctx: AvroViewerContext, options: MountOptions = {}): Promise<ViewerHandle> => mountAutomotiveViewer('avro', input, container, ctx, options);
