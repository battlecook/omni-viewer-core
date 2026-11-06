import { loadYamlParserDeps } from '../yaml/self-loading.js';
import { decodeUtf8 } from '../types.js';
import { parseOpenApi, readOpenApiRoot, type OpenApiParseOptions } from './index.js';
import type { YamlParserDeps } from '../yaml/index.js';

export { loadYamlParserDeps as loadOpenApiYamlDeps } from '../yaml/self-loading.js';
export * from './index.js';

/** JSON stays dependency-free. Only YAML loads the installed optional peer. */
export async function parseSelfLoadingOpenApi(input: Uint8Array | string, options: OpenApiParseOptions = {}) {
    const initial = parseOpenApi(input, options);
    if (initial.result.status !== 'failed' || options.signal?.aborted || options.yamlDeps || options.format === 'json') return initial;
    if (initial.result.failure.code !== 'missing-dependency' && initial.result.failure.code !== 'invalid-format') return initial;
    const text = typeof input === 'string' ? input : decodeUtf8(input.subarray(0, 4096));
    // Well-formed but unsupported JSON is not a reason to load a YAML peer.
    if (/^\s*[{[]/.test(text.replace(/^\uFEFF/, '')) && readOpenApiRoot(input, options).result.status !== 'failed') return initial;
    const yamlDeps = await new Promise<YamlParserDeps | undefined>(resolve => {
        let done = false;
        const finish = (deps: YamlParserDeps | undefined): void => {
            if (done) return; done = true; options.signal?.removeEventListener('abort', abort); resolve(deps);
        };
        const abort = (): void => finish(undefined);
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) { abort(); return; }
        void loadYamlParserDeps().then(finish, () => finish(undefined));
    });
    return parseOpenApi(input, yamlDeps ? { ...options, yamlDeps } : options);
}
