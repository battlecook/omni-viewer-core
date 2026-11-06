import { parseJson } from '../json/index.js';
import { parseYaml, type YamlNode, type YamlParserDeps } from '../yaml/index.js';
import { decodeUtf8, utf8ByteLength, LimitTracker, type Diagnostic, type ParseOptions, type ParseOutcome, type ParseResult } from '../types.js';
import type { OpenApiDocument, OpenApiNamedNode, OpenApiNode, OpenApiOperation, OpenApiServer } from './model.js';
import { openApiEntries, openApiField as field, openApiItems, openApiStrings, openApiText as textOf, openApiVersion, resolveOpenApiRef, type OpenApiRefContext } from './nodes.js';

export * from './model.js';
export * from './nodes.js';
export const OPENAPI_INPUT_OWNERSHIP = 'borrows' as const;
export const OPENAPI_MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const OPENAPI_MAX_OPERATIONS = 10_000;
export const OPENAPI_HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query'] as const;

export interface OpenApiParseOptions extends ParseOptions {
    yamlDeps?: YamlParserDeps;
    /** Auto by default; use JSON to reject YAML-only syntax in .json files. */
    format?: 'json' | 'yaml';
    maxDepth?: number;
    maxNodes?: number;
}
export interface OpenApiRoot { text: string; format: 'json' | 'yaml'; root: OpenApiNode; }

/** Shared by parsing and full-content detection; no optional peer imports. */
export function readOpenApiRoot(input: Uint8Array | string, options: OpenApiParseOptions = {}): ParseOutcome<OpenApiRoot> {
    const started = Date.now();
    const finish = (result: ParseResult<OpenApiRoot>): ParseOutcome<OpenApiRoot> => ({ result,
        execution: { workerUsed: false, hardLimitEnforced: false, elapsedMillis: Date.now() - started } });
    const fail = (code: 'invalid-format' | 'limit-exceeded' | 'missing-dependency' | 'aborted', messageKey: string, diagnostics: Diagnostic[] = []): ParseOutcome<OpenApiRoot> =>
        finish({ status: 'failed', failure: { code, retryable: code === 'aborted' || code === 'missing-dependency', messageKey }, diagnostics });
    if (options.signal?.aborted) return fail('aborted', 'diag.aborted');
    const maxInputBytes = options.limits?.maxInputBytes ?? OPENAPI_MAX_INPUT_BYTES;
    if ((typeof input === 'string' ? utf8ByteLength(input) : input.byteLength) > maxInputBytes) return fail('limit-exceeded', 'diag.openapi.inputLimit');
    const originalText = typeof input === 'string' ? input : decodeUtf8(input);
    const text = originalText.replace(/^\uFEFF/, '');
    const maxDepth = options.maxDepth ?? 64;
    const maxNodes = options.maxNodes ?? 100_000;
    const tracker = new LimitTracker({ maxParseMillis: options.limits?.maxParseMillis ?? 30_000 }, options.signal);
    let root: OpenApiNode;
    let diagnostics: Diagnostic[];
    const json = options.format !== 'yaml' && (options.format === 'json' || /^\s*[{[]/.test(text)) ? parseJson(text, { ...options, maxDepth, limits: { ...options.limits, maxInputBytes, maxEntries: maxNodes } }).result : undefined;
    const format = options.format ?? (json && (json.status === 'ok' || !options.yamlDeps || json.diagnostics.some(d => /limit/.test(d.code))) ? 'json' : 'yaml');
    if (format === 'json' && json) {
        const parsed = json;
        if (parsed.status === 'failed') return fail(parsed.failure.code === 'aborted' ? 'aborted' : parsed.failure.code === 'limit-exceeded' ? 'limit-exceeded' : 'invalid-format', parsed.failure.messageKey, parsed.diagnostics);
        // Recovery is useful in a generic tree, but must not claim unrelated or
        // malformed JSON as an API document. Duplicate keys are ambiguous too.
        if (parsed.status !== 'ok' || parsed.diagnostics.some(d => /duplicate/.test(d.code))) return fail(parsed.diagnostics.some(d => /limit/.test(d.code)) ? 'limit-exceeded' : 'invalid-format', 'diag.openapi.invalid', parsed.diagnostics);
        root = parsed.document.root;
        diagnostics = parsed.diagnostics;
    } else {
        const parsed = parseYaml(text, { ...(options.yamlDeps ? { deps: options.yamlDeps } : {}),
            ...(options.signal ? { signal: options.signal } : {}), limits: { maxInputBytes, maxEntries: maxNodes, maxDocuments: 2, maxDepth, maxAliases: 100 } }).result;
        if (parsed.status === 'failed') return fail(parsed.failure.code === 'missing-dependency' ? 'missing-dependency' : parsed.failure.code === 'aborted' ? 'aborted' : 'invalid-format', parsed.failure.messageKey, parsed.diagnostics);
        if (parsed.status !== 'ok' || parsed.document.documents.length !== 1) return fail(parsed.diagnostics.some(d => /limit/.test(d.code)) ? 'limit-exceeded' : 'invalid-format', 'diag.openapi.invalid', parsed.diagnostics);
        diagnostics = parsed.diagnostics;
        // Expand aliases under one cumulative node budget, never through JS
        // objects or prototypes. Recursive aliases fail instead of recursing.
        const anchors = new Map<string, YamlNode>();
        const aliasTargets = new WeakMap<YamlNode, YamlNode>();
        const stack = [...parsed.document.documents];
        while (stack.length) {
            const node = stack.pop()!;
            if (node.anchorId) anchors.set(node.anchorId, node);
            if (node.kind === 'alias') { const target = anchors.get(node.aliasOf ?? ''); if (target) aliasTargets.set(node, target); }
            // Bind aliases in source order, before later declarations can
            // redefine the same anchor name. Container anchors precede children.
            const children = node.children ?? [];
            for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
        }
        let nodes = 0;
        const active = new Set<YamlNode>();
        const convert = (node: YamlNode, key: string, depth: number): OpenApiNode => {
            if (++nodes > maxNodes || depth > maxDepth) throw new Error('limit');
            if (nodes % 256 === 0 && tracker.checkpoint()) throw new Error('limit');
            if (active.has(node)) throw new Error('alias');
            if (node.kind === 'alias') {
                const target = aliasTargets.get(node);
                if (!target) throw new Error('alias');
                active.add(node);
                const result = convert(target, key, depth + 1);
                active.delete(node);
                return result;
            }
            active.add(node);
            let result: OpenApiNode;
            if (node.kind === 'map' || node.kind === 'seq') {
                const children = (node.children ?? []).map(child => convert(child, child.key, depth + 1));
                if (node.kind === 'map') {
                    const merged = new Map<string, OpenApiNode>();
                    for (let i = 0; i < children.length; i++) if (node.children![i]!.mergeKey) {
                        const child = children[i]!;
                        const sources = child.kind === 'array' ? child.children ?? [] : [child];
                        for (const source of sources) {
                            if (source.kind !== 'object') throw new Error('merge');
                            for (const entry of openApiEntries(source)) if (!merged.has(entry.key)) merged.set(entry.key, entry);
                        }
                    }
                    for (let i = 0; i < children.length; i++) if (!node.children![i]!.mergeKey) merged.set(children[i]!.key, children[i]!);
                    result = { kind: 'object', key, children: [...merged.values()] };
                } else result = { kind: 'array', key, children };
            }
            else if (typeof node.value === 'number') {
                const raw = node.raw && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(node.raw) ? node.raw : undefined;
                if (!raw && !Number.isFinite(node.value)) throw new Error('scalar');
                result = { kind: 'number', key, rawNumber: raw ?? String(node.value) };
            } else if (typeof node.value === 'string') result = { kind: 'string', key, value: node.value };
            else if (typeof node.value === 'boolean') result = { kind: 'boolean', key, value: node.value };
            else result = { kind: 'null', key, value: null };
            active.delete(node);
            return result;
        };
        try { root = convert(parsed.document.documents[0]!, '$', 0); }
        catch (error) { return fail(options.signal?.aborted ? 'aborted' : error instanceof Error && error.message === 'limit' ? 'limit-exceeded' : 'invalid-format', 'diag.openapi.invalid', diagnostics); }
    }
    if (options.signal?.aborted) return fail('aborted', 'diag.aborted');
    if (tracker.checkpoint()) return fail('limit-exceeded', 'diag.openapi.parseLimit');
    return finish({ status: 'ok', document: { text: originalText, format, root }, diagnostics });
}

export function parseOpenApi(input: Uint8Array | string, options: OpenApiParseOptions = {}): ParseOutcome<OpenApiDocument> {
    const started = Date.now();
    const loaded = readOpenApiRoot(input, options);
    const finish = (result: ParseResult<OpenApiDocument>): ParseOutcome<OpenApiDocument> => ({ result,
        execution: { ...loaded.execution, elapsedMillis: Date.now() - started } });
    if (loaded.result.status === 'failed') return finish(loaded.result);
    const { root, text, format } = loaded.result.document;
    const specVersion = openApiVersion(root);
    if (!specVersion) return finish({ status: 'failed', failure: { code: 'invalid-format', retryable: false, messageKey: 'diag.openapi.invalid' }, diagnostics: [] });
    const diagnostics = [...loaded.result.diagnostics];
    const warn = (code: string, ref: string): void => {
        if (diagnostics.length < 50) diagnostics.push({ severity: 'warning', code: `openapi.${code}`, messageKey: `diag.openapi.${code}`, args: { ref } });
    };
    const resolve = (node: OpenApiNode | undefined, context: OpenApiRefContext = 'reference'): OpenApiNode | undefined => {
        const resolved = resolveOpenApiRef(root, node, 32, context);
        if (node && !resolved) warn('reference', textOf(field(node, '$ref')));
        return resolved;
    };
    const serverLists = new WeakMap<OpenApiNode, OpenApiServer[]>();
    const serversOf = (node: OpenApiNode | undefined): OpenApiServer[] => {
        const cached = node && serverLists.get(node);
        if (cached) return cached;
        const list = openApiItems(node).map(server => ({ url: textOf(field(server, 'url')), description: textOf(field(server, 'description')) })).filter(server => server.url);
        if (node) serverLists.set(node, list);
        return list;
    };
    const stringLists = new WeakMap<OpenApiNode, string[]>();
    const strings = (node: OpenApiNode | undefined): string[] => {
        const cached = node && stringLists.get(node);
        if (cached) return cached;
        const list = openApiStrings(node);
        if (node) stringLists.set(node, list);
        return list;
    };
    const namedLists = new WeakMap<OpenApiNode, Map<string, OpenApiNamedNode[]>>();
    const named = (node: OpenApiNode | undefined, excludeExtensions = false, context: OpenApiRefContext = 'reference'): OpenApiNamedNode[] => {
        const cacheKey = `${context}:${excludeExtensions}`;
        const cached = node && namedLists.get(node)?.get(cacheKey);
        if (cached) return cached;
        const list = openApiEntries(node).filter(child => !excludeExtensions || !child.key.startsWith('x-')).map(child => ({ name: child.key, node: resolve(child, context) ?? child }));
        if (node) {
            let cache = namedLists.get(node);
            if (!cache) { cache = new Map(); namedLists.set(node, cache); }
            cache.set(cacheKey, list);
        }
        return list;
    };
    const parameterLists = new WeakMap<OpenApiNode, WeakMap<OpenApiNode, OpenApiNode[]>>();
    const parametersOf = (item: OpenApiNode, operation: OpenApiNode): OpenApiNode[] => {
        const inherited = field(item, 'parameters') ?? root, own = field(operation, 'parameters') ?? root;
        let cache = parameterLists.get(inherited);
        const cached = cache?.get(own);
        if (cached) return cached;
        const parameters = new Map<string, OpenApiNode>();
        for (const value of [...openApiItems(inherited), ...openApiItems(own)]) {
            const parameter = resolve(value) ?? value;
            const name = textOf(field(parameter, 'name')), location = textOf(field(parameter, 'in'));
            parameters.set(name && location ? `${location}\0${name}` : `ref\0${textOf(field(parameter, '$ref'))}`, parameter);
        }
        const list = [...parameters.values()];
        if (!cache) { cache = new WeakMap(); parameterLists.set(inherited, cache); }
        cache.set(own, list);
        return list;
    };
    let servers = serversOf(field(root, 'servers'));
    if (specVersion === '2.0') {
        const host = textOf(field(root, 'host'));
        const base = textOf(field(root, 'basePath')) || '/';
        const schemes = strings(field(root, 'schemes'));
        servers = host ? (schemes.length ? schemes.map(scheme => `${scheme}://${host}${base}`) : [`//${host}${base}`]).map(url => ({ url, description: '' })) : [{ url: base, description: '' }];
    }
    if (!servers.length) servers = [{ url: '/', description: '' }];
    const operations: OpenApiOperation[] = [];
    // A Path Item referenced by thousands of paths must not multiply its
    // inherited parameters/responses into thousands of copied arrays.
    type OperationDetails = Omit<OpenApiOperation, 'id' | 'kind' | 'path' | 'method'>;
    const detailsByItem = new WeakMap<OpenApiNode, WeakMap<OpenApiNode, OperationDetails>>();
    const operationLimit = Math.max(0, Math.floor(options.limits?.maxEntries ?? OPENAPI_MAX_OPERATIONS));
    const tracker = new LimitTracker({ maxParseMillis: options.limits?.maxParseMillis ?? 30_000 }, options.signal);
    let limited = false;
    for (const kind of ['path', 'webhook'] as const) {
        const paths = openApiEntries(field(root, kind === 'path' ? 'paths' : 'webhooks'));
        for (const path of paths) {
            if (path.key.startsWith('x-') || (kind === 'path' && !path.key.startsWith('/'))) continue;
            const item = resolve(path, 'pathItem');
            if (item?.kind !== 'object') continue;
            const methods: [string, OpenApiNode][] = [];
            for (const method of OPENAPI_HTTP_METHODS) { const node = field(item, method); if (node?.kind === 'object') methods.push([method.toUpperCase(), node]); }
            if (specVersion.startsWith('3.2.')) for (const node of openApiEntries(field(item, 'additionalOperations'))) {
                if (node.kind === 'object' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(node.key)) methods.push([node.key, node]);
            }
            for (const [method, node] of methods) {
                if (operations.length >= operationLimit || tracker.checkpoint()) { limited = true; break; }
                let detailsByOperation = detailsByItem.get(item);
                if (!detailsByOperation) { detailsByOperation = new WeakMap(); detailsByItem.set(item, detailsByOperation); }
                const cached = detailsByOperation.get(node);
                if (cached) {
                    operations.push({ id: `${kind}:${path.key}:${method}`, kind, path: path.key, method, ...cached });
                    continue;
                }
                const parameters = parametersOf(item, node);
                const ownServers = field(node, 'servers') ?? field(item, 'servers');
                let operationServers = ownServers ? serversOf(ownServers) : servers;
                if (specVersion === '2.0' && field(node, 'schemes')) {
                    const host = textOf(field(root, 'host'));
                    if (host) operationServers = strings(field(node, 'schemes')).map(scheme => ({ url: `${scheme}://${host}${textOf(field(root, 'basePath')) || '/'}`, description: '' }));
                }
                const details: OperationDetails = {
                    operationId: textOf(field(node, 'operationId')), summary: textOf(field(node, 'summary')),
                    description: textOf(field(node, 'description')) || textOf(field(item, 'description')),
                    tags: strings(field(node, 'tags')), deprecated: field(node, 'deprecated')?.value === true,
                    parameters, requestBody: resolve(field(node, 'requestBody')) ?? field(node, 'requestBody'),
                    responses: named(field(node, 'responses'), true), security: field(node, 'security') ?? field(root, 'security'),
                    servers: operationServers, consumes: strings(field(node, 'consumes') ?? field(root, 'consumes')),
                    produces: strings(field(node, 'produces') ?? field(root, 'produces')), node };
                detailsByOperation.set(node, details);
                operations.push({ id: `${kind}:${path.key}:${method}`, kind, path: path.key, method, ...details });
            }
            if (limited) break;
        }
        if (limited) break;
    }
    if (options.signal?.aborted) return finish({ status: 'failed', failure: { code: 'aborted', retryable: true, messageKey: 'diag.aborted' }, diagnostics });
    if (limited) diagnostics.push({ severity: 'warning', code: 'openapi.operationLimit', messageKey: 'diag.openapi.operationLimit', args: { count: operations.length } });
    const info = field(root, 'info');
    const tags = openApiItems(field(root, 'tags')).map(tag => ({ name: textOf(field(tag, 'name')), description: textOf(field(tag, 'description')) })).filter(tag => tag.name);
    const tagNames = new Set(tags.map(tag => tag.name));
    const visitedTags = new Set<readonly string[]>();
    for (const operation of operations) if (!visitedTags.has(operation.tags)) {
        visitedTags.add(operation.tags);
        for (const name of operation.tags) if (!tagNames.has(name)) { tagNames.add(name); tags.push({ name, description: '' }); }
    }
    const components = field(root, 'components');
    const document: OpenApiDocument = { text, format, root, specVersion, title: textOf(field(info, 'title')),
        apiVersion: textOf(field(info, 'version')), description: textOf(field(info, 'description')), servers, tags, operations,
        schemas: named(specVersion === '2.0' ? field(root, 'definitions') : field(components, 'schemas'), false, 'schema'),
        securitySchemes: named(specVersion === '2.0' ? field(root, 'securityDefinitions') : field(components, 'securitySchemes')) };
    return finish({ status: diagnostics.length ? 'partial' : 'ok', document, diagnostics });
}
