import { beforeAll, describe, expect, it } from 'vitest';
import { apiJson, apiYaml, swaggerYaml } from '../parsers/openapi/__tests__/fixtures.js';
import { loadYamlParserDeps } from '../parsers/yaml/self-loading.js';
import type { YamlParserDeps } from '../parsers/yaml/index.js';
import { OPENAPI_VIEWER_META } from '../viewers/openapi/index.js';
import { CORE_VIEWER_DESCRIPTORS, OPENAPI_VIEWER_DESCRIPTOR, detectViewer, looksLikeOpenApi, sniffTextViewer } from './index.js';

let yamlDeps: YamlParserDeps;
beforeAll(async () => { yamlDeps = await loadYamlParserDeps(); });
const detect = (name: string, text: string) => detectViewer(name, undefined, undefined, undefined, text);

describe('OpenAPI content routing', () => {
    it('registers a content-only viewer with matching metadata', () => {
        expect(OPENAPI_VIEWER_META).toMatchObject(OPENAPI_VIEWER_DESCRIPTOR);
        expect(OPENAPI_VIEWER_DESCRIPTOR.extensions).toEqual([]);
        expect(CORE_VIEWER_DESCRIPTORS.filter(d => d.id === 'openapi')).toHaveLength(1);
    });
    it.each(['api.json', 'OPENAPI.JSON', 'swagger.json', 'arbitrary.yaml', 'spec.yml', 'extensionless'])('routes API JSON by content: %s', name => {
        expect(detect(name, apiJson())).toEqual({ viewerId: 'openapi', matchedBy: 'content' });
    });
    it.each([apiYaml, swaggerYaml])('detects ordinary block YAML without loading its optional peer', text => {
        expect(detect('api.yaml', text).viewerId).toBe('openapi');
        expect(detect('api.yml', text).viewerId).toBe('openapi');
        expect(sniffTextViewer(text)).toBe('openapi');
        expect(looksLikeOpenApi(text, { yamlDeps })).toBe(true);
    });
    it('retains generic viewers without content and for non-API files', () => {
        expect(detectViewer('openapi.json').viewerId).toBe('json');
        expect(detectViewer('swagger.yaml').viewerId).toBe('yaml');
        expect(detect('openapi.json', '{"name":"ordinary"}').viewerId).toBe('json');
        expect(detect('swagger.yaml', 'openapi: just a setting\ninfo: text').viewerId).toBe('yaml');
        expect(detect('readme.md', apiJson()).viewerId).toBe('markdown');
    });
    it('does not mistake nested markers, block strings or JSONL records for a document', () => {
        expect(looksLikeOpenApi('{"settings":' + apiJson() + '}')).toBe(false);
        expect(looksLikeOpenApi('description: |\n  openapi: 3.1.0\n  info: {"title":"X","version":"1"}\n  paths: {}')).toBe(false);
        expect(sniffTextViewer(`${apiJson()}\n${apiJson()}`)).toBe('jsonl');
        expect(detect('data.json', `${apiJson()}\n${apiJson()}`).viewerId).toBe('json');
    });
    it('rejects multiple documents, malformed JSON, duplicate markers and unsupported versions', () => {
        expect(looksLikeOpenApi(apiYaml + '\n---\nname: second')).toBe(false);
        expect(looksLikeOpenApi(apiJson().slice(0, -2))).toBe(false);
        expect(looksLikeOpenApi(apiYaml + '\nopenapi: 3.1.1')).toBe(false);
        expect(looksLikeOpenApi(apiJson().replace('3.1.0', '4.0.0'))).toBe(false);
        expect(detectViewer('bad.yaml', undefined, undefined, undefined, apiYaml + '\ninvalid: [', { yamlDeps }).viewerId).toBe('yaml');
        const trailingComma = apiJson().slice(0, -1) + ',}';
        expect(detectViewer('bad.json', undefined, undefined, undefined, trailingComma, { yamlDeps }).viewerId).toBe('json');
    });
    it('accepts quoted YAML keys and comments, with full parsing available for flow YAML', () => {
        expect(looksLikeOpenApi("'openapi': '3.1.0' # version\n'info':\n  'title': 'API'\n  'version': '1'\n'paths': {}\n")).toBe(true);
        const flow = '{openapi: 3.1.0, info: {title: API, version: "1"}, paths: {}}';
        expect(detectViewer('api.yaml', undefined, undefined, undefined, flow, { yamlDeps }).viewerId).toBe('openapi');
    });
    it('detects API documents with large comment prefixes within an interactive budget', () => {
        const text = '#\n'.repeat(250_000) + apiYaml;
        const started = performance.now();
        expect(looksLikeOpenApi(text)).toBe(true);
        expect(performance.now() - started).toBeLessThan(2000);
    });
    it('detects escaped top-level version keys in JSON and quoted YAML', () => {
        const json = '{"\\u006fpenapi":"3.1.0","info":{"title":"Escaped API","version":"1"},"paths":{}}';
        expect(detect('api.json', json).viewerId).toBe('openapi');
        expect(looksLikeOpenApi('"\\u006fpenapi": 3.1.0\ninfo:\n  title: API\n  version: "1"\npaths: {}')).toBe(true);
    });
    it('keeps generic JSON/YAML available when the specialized viewer is disabled', () => {
        const descriptors = CORE_VIEWER_DESCRIPTORS.filter(d => d.id !== 'openapi');
        expect(detectViewer('api.json', undefined, descriptors, undefined, apiJson()).viewerId).toBe('json');
        expect(detectViewer('api.yaml', undefined, descriptors, undefined, apiYaml).viewerId).toBe('yaml');
        expect(detectViewer('api', undefined, descriptors, undefined, apiJson()).viewerId).toBe('json');
        expect(detectViewer('api', undefined, descriptors, undefined, apiYaml).viewerId).toBe('yaml');
    });
});
