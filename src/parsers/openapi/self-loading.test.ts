import { afterEach, describe, expect, it, vi } from 'vitest';
import * as yamlLoader from '../yaml/self-loading.js';
import type { YamlParserDeps } from '../yaml/index.js';
import { apiJson, apiYaml } from './__tests__/fixtures.js';
import { parseSelfLoadingOpenApi } from './self-loading.js';

afterEach(() => vi.restoreAllMocks());

describe('OpenAPI optional YAML loading', () => {
    it('keeps valid JSON, unsupported JSON and oversized input independent of YAML', async () => {
        const loader = vi.spyOn(yamlLoader, 'loadYamlParserDeps').mockRejectedValue(new Error('not installed'));
        expect((await parseSelfLoadingOpenApi(apiJson())).result.status).toBe('ok');
        expect((await parseSelfLoadingOpenApi(apiJson().replace('3.1.0', '4.0.0'))).result.status).toBe('failed');
        expect((await parseSelfLoadingOpenApi(apiYaml, { limits: { maxInputBytes: 10 } })).result).toMatchObject({ status: 'failed', failure: { code: 'limit-exceeded' } });
        expect(loader).not.toHaveBeenCalled();
    });
    it('returns a typed missing-dependency failure when the optional peer is unavailable', async () => {
        vi.spyOn(yamlLoader, 'loadYamlParserDeps').mockRejectedValue(new Error('not installed'));
        expect((await parseSelfLoadingOpenApi(apiYaml)).result).toMatchObject({ status: 'failed', failure: { code: 'missing-dependency' } });
    });
    it('finishes cancellation while a dependency import is still pending', async () => {
        let finishImport!: (deps: YamlParserDeps) => void;
        vi.spyOn(yamlLoader, 'loadYamlParserDeps').mockReturnValue(new Promise(resolve => { finishImport = resolve; }));
        const controller = new AbortController();
        const result = parseSelfLoadingOpenApi(apiYaml, { signal: controller.signal });
        controller.abort();
        expect((await result).result).toMatchObject({ status: 'failed', failure: { code: 'aborted' } });
        finishImport({ parse: () => [] });
    });
    it('keeps enforced JSON syntax strict even when YAML could parse a trailing comma', async () => {
        const loader = vi.spyOn(yamlLoader, 'loadYamlParserDeps').mockRejectedValue(new Error('not installed'));
        const source = apiJson().slice(0, -1) + ',}';
        expect((await parseSelfLoadingOpenApi(source, { format: 'json' })).result.status).toBe('failed');
        expect(loader).not.toHaveBeenCalled();
    });
});
