import type { ViewerHandle, ViewerInput } from '../types.js';
import { MountAbortedError } from '../types.js';
import { parseSelfLoadingOpenApi } from '../../parsers/openapi/self-loading.js';
import { mountOpenApiDocument, type OpenApiMountOptions, type OpenApiViewerContext } from './index.js';

export * from './index.js';
export { loadOpenApiYamlDeps } from '../../parsers/openapi/self-loading.js';

export async function mountSelfLoadingOpenApiViewer(input: ViewerInput, container: HTMLElement, ctx: OpenApiViewerContext, options: OpenApiMountOptions = {}): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const { result } = await parseSelfLoadingOpenApi(input.data, /\.json$/i.test(input.fileName) && !options.format ? { ...options, format: 'json' } : options);
    if (options.signal?.aborted) throw new MountAbortedError();
    return mountOpenApiDocument(result.status === 'failed' ? undefined : result.document, input, container, ctx, options,
        result.status === 'failed' ? [{ severity: 'error', code: result.failure.code, messageKey: result.failure.messageKey }, ...result.diagnostics] : result.diagnostics);
}
