import { beforeAll, describe, expect, it } from 'vitest';
import { loadYamlParserDeps } from '../yaml/self-loading.js';
import type { YamlParserDeps } from '../yaml/index.js';
import { openApiField as field, openApiText, parseOpenApi, printOpenApiNode, serializeOpenApiNode, resolveOpenApiRef, type OpenApiDocument } from './index.js';
import { parseSelfLoadingOpenApi } from './self-loading.js';
import { apiJson, apiObject, apiYaml, swaggerYaml } from './__tests__/fixtures.js';

let yamlDeps: YamlParserDeps;
beforeAll(async () => { yamlDeps = await loadYamlParserDeps(); });
function document(text: string, options = {}): OpenApiDocument {
    const result = parseOpenApi(text, { yamlDeps, ...options }).result;
    if (result.status === 'failed') throw new Error(`${result.failure.code}: ${result.failure.messageKey}`);
    return result.document;
}

describe('OpenAPI / Swagger parser', () => {
    it('reads JSON operations, inherited parameters, overrides, references, servers and security', () => {
        const model = document(apiJson());
        expect(model.title).toBe('Pet API'); expect(model.format).toBe('json');
        expect(model.operations).toHaveLength(4);
        const get = model.operations[0]!;
        expect(get.method).toBe('GET'); expect(get.operationId).toBe('getPet');
        expect(get.parameters).toHaveLength(2);
        expect(openApiText(field(get.parameters[1], 'description'))).toBe('Override');
        expect(get.responses[0]!.name).toBe('200');
        expect(openApiText(field(get.responses[0]!.node, 'description'))).toBe('A pet');
        expect(get.servers[0]!.url).toBe('https://api.example.test/v1');
        expect(get.security?.children?.[0]?.children?.[0]?.key).toBe('bearer');
        expect(model.operations[1]!.deprecated).toBe(true);
        expect(model.operations[1]!.security?.children).toEqual([]);
        expect(field(model.operations[2]!.requestBody, 'content')?.kind).toBe('object');
        expect(model.operations[2]!.servers[0]!.url).toBe('https://write.example.test');
        expect(model.operations[3]!.kind).toBe('webhook');
        expect(model.schemas[0]!.name).toBe('Pet'); expect(model.securitySchemes[0]!.name).toBe('bearer');
    });

    it.each(['3.0.4', '3.1.2', '3.2.0'])('supports OpenAPI %s', version => {
        const value = apiObject(); value.openapi = version;
        expect(document(JSON.stringify(value)).specVersion).toBe(version);
    });

    it('reads YAML, flow mappings and a single explicit document', async () => {
        const model = document(apiYaml);
        expect(model.format).toBe('yaml'); expect(model.operations[0]!.path).toBe('/pets');
        expect(model.description).toContain('A multiline description.');
        const flow = '{openapi: 3.1.0, info: {title: Flow API, version: "1.0"}, paths: {}}';
        expect(document(flow).title).toBe('Flow API');
        expect((await parseSelfLoadingOpenApi(flow)).result.status).toBe('ok');
        expect((await parseSelfLoadingOpenApi(apiYaml)).result.status).toBe('ok');
        expect((await parseSelfLoadingOpenApi(apiJson())).result.status).toBe('ok');
    });

    it('normalizes Swagger 2.0 definitions, host, schemes, payloads and response schemas', () => {
        const model = document(swaggerYaml);
        expect(model.specVersion).toBe('2.0');
        expect(model.servers.map(server => server.url)).toEqual(['https://legacy.example.test/v2', 'http://legacy.example.test/v2']);
        expect(model.schemas[0]!.name).toBe('Pet'); expect(model.securitySchemes[0]!.name).toBe('apiKey');
        expect(model.operations[0]!.consumes).toEqual(['application/json']);
        expect(openApiText(field(model.operations[0]!.parameters[0], 'in'))).toBe('body');
    });

    it('handles OpenAPI 3.2 additional methods and component-only definitions', () => {
        const source = { openapi: '3.2.0', info: { title: 'Extra', version: '1' }, paths: {
            '/pets': { query: { responses: {} }, additionalOperations: { COPY: { responses: {} } } }
        } };
        expect(document(JSON.stringify(source)).operations.map(op => op.method)).toEqual(['QUERY', 'COPY']);
        expect(document('{"openapi":"3.1.0","info":{"title":"Schema API","version":"1"},"components":{"schemas":{"Any":true}}}').schemas[0]?.node.kind).toBe('boolean');
    });

    it('resolves escaped and URI-encoded local pointers without prototype lookup', () => {
        const model = document('{"openapi":"3.1.0","info":{"title":"Refs","version":"1"},"paths":{},"components":{"schemas":{"a/b~c":{"type":"string"},"__proto__":{"type":"integer"}}}}');
        const ref = (value: string) => ({ kind: 'object' as const, key: '$', children: [{ kind: 'string' as const, key: '$ref', value }] });
        expect(openApiText(field(resolveOpenApiRef(model.root, ref('#/components/schemas/a~1b~0c')), 'type'))).toBe('string');
        expect(openApiText(field(resolveOpenApiRef(model.root, ref('#%2Fcomponents%2Fschemas%2Fa~1b~0c')), 'type'))).toBe('string');
        expect(openApiText(field(resolveOpenApiRef(model.root, ref('#/components/schemas/%5F%5Fproto%5F%5F')), 'type'))).toBe('integer');
        expect(resolveOpenApiRef(model.root, ref('#/components/schemas/constructor'))).toBeUndefined();
        expect(resolveOpenApiRef(model.root, ref('#/components/schemas/a~2b'))).toBeUndefined();
        expect(resolveOpenApiRef(model.root, ref('https://external.test/schema.json'))).toBeUndefined();
    });

    it('reports missing/external/cyclic references and terminates recursive schemas', () => {
        const source = { openapi: '3.1.0', info: { title: 'Refs', version: '1' }, paths: {
            '/missing': { $ref: '#/paths/missing' }, '/cycle': { $ref: '#/paths/~1cycle' },
            '/external': { $ref: './paths.yaml' }
        } };
        const result = parseOpenApi(JSON.stringify(source)).result;
        expect(result.status).toBe('partial'); expect(result.diagnostics).toHaveLength(3);
        expect(printOpenApiNode(document(apiJson()).schemas[0]!.node)).toContain('#/components/schemas/Pet');
    });

    it('resolves YAML anchors and merges without unbounded alias expansion', () => {
        const yaml = `openapi: 3.1.0\ninfo: {title: Anchors, version: '1'}\nx-base: &base\n  type: object\n  description: Shared\npaths: {}\ncomponents:\n  schemas:\n    A: *base\n    B:\n      <<: *base\n      description: Own\n`;
        const model = document(yaml);
        expect(openApiText(field(model.schemas[0]!.node, 'type'))).toBe('object');
        expect(openApiText(field(model.schemas[1]!.node, 'description'))).toBe('Own');
        expect(openApiText(field(model.schemas[1]!.node, 'type'))).toBe('object');
        expect(parseOpenApi(`openapi: 3.1.0\ninfo: {title: Cycle, version: '1'}\npaths: {}\nx-cycle: &a {again: *a}`, { yamlDeps }).result.status).toBe('failed');
    });

    it('keeps quoted literal merge keys distinct from real YAML merges', () => {
        const model = document(`openapi: 3.1.0
info: {title: Literal keys, version: '1'}
paths: {}
components:
  schemas:
    Test:
      type: object
      properties:
        <<: &base {inherited: {type: integer}}
        '<<': {type: string}
        other: {type: string}
`);
        const properties = field(model.schemas[0]!.node, 'properties')!;
        expect(properties.children?.map(node => node.key)).toEqual(['inherited', '<<', 'other']);
        expect(openApiText(field(field(properties, '<<'), 'type'))).toBe('string');
        expect(document("openapi: 3.1.0\ninfo: {title: Quoted, version: '1'}\npaths: {}\ncomponents: {schemas: {Test: {properties: {'<<': {type: string}, other: {type: string}}}}}").schemas[0]!.node.children?.[0]?.children?.map(n => n.key)).toEqual(['<<', 'other']);
        expect(parseOpenApi("openapi: 3.1.0\ninfo: {title: Bad merge, version: '1'}\npaths: {}\nx-invalid: {<<: 1}", { yamlDeps }).result.status).toBe('failed');
    });

    it('binds redefined aliases in source order and rejects forward aliases', () => {
        const model = document(`openapi: 3.1.0
info: {title: Anchors, version: '1'}
paths: {}
components:
  schemas:
    First: &s {type: string}
    FirstAlias: *s
    Second: &s {type: integer}
    SecondAlias: *s
`);
        expect(model.schemas.map(schema => openApiText(field(schema.node, 'type')))).toEqual(['string', 'string', 'integer', 'integer']);
        expect(parseOpenApi("openapi: 3.1.0\ninfo: {title: Forward, version: '1'}\npaths: {}\nx-first: *later\nx-later: &later {type: string}", { yamlDeps }).result.status).toBe('failed');
    });

    it('shares normalized lists for repeated Path Item references, including local descriptions', () => {
        const item = { parameters: Array.from({ length: 500 }, (_, i) => ({ name: `p${i}`, in: 'query', schema: { type: 'string' } })),
            get: { tags: ['shared'], responses: { '200': { description: 'OK' } } } };
        const model = document(JSON.stringify({ openapi: '3.1.0', info: { title: 'Shared paths', version: '1' },
            paths: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`/p${i}`, { $ref: '#/components/pathItems/Shared', description: `Path ${i}` }])),
            components: { pathItems: { Shared: item } } }));
        expect(model.operations).toHaveLength(500);
        expect(model.operations[0]!.parameters).toHaveLength(500);
        expect(new Set(model.operations.map(op => op.parameters)).size).toBe(1);
        expect(new Set(model.operations.map(op => op.responses)).size).toBe(1);
        expect(new Set(model.operations.map(op => op.tags)).size).toBe(1);
        expect(model.operations[499]!.description).toBe('Path 499');
    });

    it.each(['3.0.4', '3.1.0', '3.2.0'])('applies Reference Object descriptions according to OpenAPI %s', version => {
        const model = document(JSON.stringify({ openapi: version, info: { title: 'Overrides', version: '1' }, paths: { '/pets': { get: {
            parameters: [{ $ref: '#/components/parameters/P', description: 'Local parameter' }],
            requestBody: { $ref: '#/components/requestBodies/Body', description: 'Local body' },
            responses: { '200': { $ref: '#/components/responses/Alias', description: 'Local response' } }
        } } }, components: {
            parameters: { P: { name: 'id', in: 'query', description: 'Shared parameter' } },
            requestBodies: { Body: { description: 'Shared body', content: {} } },
            responses: { Alias: { $ref: '#/components/responses/Base', description: 'Intermediate response' }, Base: { description: 'Shared response' } },
            securitySchemes: { Alias: { $ref: '#/components/securitySchemes/Base', description: 'Local authentication' }, Base: { type: 'http', scheme: 'bearer', description: 'Shared authentication' } }
        } }));
        const operation = model.operations[0]!;
        const local = version !== '3.0.4';
        expect(openApiText(field(operation.parameters[0], 'description'))).toBe(local ? 'Local parameter' : 'Shared parameter');
        expect(openApiText(field(operation.requestBody, 'description'))).toBe(local ? 'Local body' : 'Shared body');
        expect(openApiText(field(operation.responses[0]!.node, 'description'))).toBe(local ? 'Local response' : 'Shared response');
        expect(openApiText(field(model.securitySchemes[0]!.node, 'description'))).toBe(local ? 'Local authentication' : 'Shared authentication');
    });

    it('keeps annotation overlays shared instead of copying large reference targets', () => {
        const base = { type: 'string', ...Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`x-${i}`, i])) };
        const schemas = { Base: base, ...Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`Alias${i}`, { $ref: '#/components/schemas/Base', description: `Alias ${i}` }])) };
        const model = document(JSON.stringify({ openapi: '3.1.0', info: { title: 'Overlays', version: '1' }, components: { schemas } }));
        expect(model.schemas).toHaveLength(1001);
        expect(model.schemas.reduce((count, schema) => count + (schema.node.children?.length ?? 0), 0)).toBeLessThan(10_000);
        expect(openApiText(field(model.schemas[1000]!.node, 'description'))).toBe('Alias 999');
        expect(openApiText(field(model.schemas[1000]!.node, 'type'))).toBe('string');
    });

    it.each(['3.0.4', '3.1.0'])('keeps nonconflicting Path Item siblings in OpenAPI %s', version => {
        const model = document(JSON.stringify({ openapi: version, info: { title: 'Path siblings', version: '1' },
            paths: { '/pets': { $ref: '#/x-path', get: { responses: { '200': { description: 'Local GET' } } } } },
            'x-path': { post: { responses: { '201': { description: 'Shared POST' } } } } }));
        expect(model.operations.map(operation => operation.method)).toEqual(['GET', 'POST']);
    });

    it('preserves declared Schema Object siblings and the referenced definition', () => {
        const extended = { $ref: '#/components/schemas/Base', properties: { name: { type: 'string' } }, required: ['name'] };
        const model = document(JSON.stringify({ openapi: '3.1.0', info: { title: 'Schema siblings', version: '1' },
            components: { schemas: { Base: { type: 'object', properties: { id: { type: 'integer' } } }, Extended: extended } } }));
        const node = model.schemas[1]!.node;
        expect(field(node, 'properties')?.children?.map(child => child.key)).toEqual(['name']);
        expect(field(node, 'required')?.children?.map(child => child.value)).toEqual(['name']);
        expect(field(node.referenceTarget, 'properties')?.children?.map(child => child.key)).toEqual(['id']);
        expect(JSON.parse(serializeOpenApiNode(node))).toEqual(extended);
    });

    it.each([
        '{}', '{"openapi":"3.1.0"}', '{"openapi":"3.1.0","info":{"title":"X","version":"1"},"paths":[]}',
        '{"openapi":"3.1.0","openapi":"3.1.1","info":{"title":"X","version":"1"},"paths":{}}',
        '{"openapi":"3.1.0","info":{"title":"X","version":"1"},"paths":{}} trailing',
        'openapi: 3.1.0\ninfo: {title: X, version: "1"}\npaths: []',
        'openapi: 3.1.0\ninfo: {title: X, version: "1"}\npaths: {}\n---\nvalue: 1',
        'openapi: 3.1.0\ninfo: {title: X, version: "1"}\npaths: {}\ninfo: [',
        'openapi: 3.1.0\ninfo: {title: X, version: 1.0}\npaths: {}'
    ])('rejects malformed, duplicate, ambiguous or unrelated input: %s', source => {
        expect(parseOpenApi(source, { yamlDeps }).result.status).toBe('failed');
    });

    it('preserves JSON integer tokens and bounds preview size', () => {
        const model = document('{"openapi":"3.1.0","info":{"title":"Numbers","version":"1"},"paths":{},"components":{"schemas":{"ID":{"type":"integer","example":900719925474099312345}}}}');
        expect(printOpenApiNode(model.schemas[0]!.node)).toContain('900719925474099312345');
        expect(printOpenApiNode(model.root, 32).length).toBeLessThanOrEqual(34);
        expect(serializeOpenApiNode(model.schemas[0]!.node)).toContain('900719925474099312345');
        expect(() => serializeOpenApiNode(model.root, 32)).toThrow(RangeError);
    });

    it('retains schema names starting with x- and preserves source BOMs for string input', () => {
        const text = '\uFEFF{"openapi":"3.1.0","info":{"title":"Schemas","version":"1"},"components":{"schemas":{"x-user":{"type":"string"}}}}';
        const model = document(text);
        expect(model.schemas[0]?.name).toBe('x-user'); expect(model.text).toBe(text);
    });

    it('returns typed failures for limits, cancellation and missing YAML dependencies', () => {
        const aborted = new AbortController(); aborted.abort();
        expect(parseOpenApi(apiJson(), { signal: aborted.signal }).result).toMatchObject({ status: 'failed', failure: { code: 'aborted' } });
        expect(parseOpenApi(apiJson(), { limits: { maxInputBytes: 8 } }).result).toMatchObject({ status: 'failed', failure: { code: 'limit-exceeded' } });
        expect(parseOpenApi(apiJson(), { maxNodes: 10 }).result).toMatchObject({ status: 'failed', failure: { code: 'limit-exceeded' } });
        expect(parseOpenApi(apiYaml).result).toMatchObject({ status: 'failed', failure: { code: 'missing-dependency' } });
        const limited = parseOpenApi(apiJson(), { limits: { maxEntries: 1 } }).result;
        expect(limited.status).toBe('partial');
        if (limited.status !== 'failed') expect(limited.document.operations).toHaveLength(1);
    });
});
