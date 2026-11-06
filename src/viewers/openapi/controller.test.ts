import { describe, expect, it } from 'vitest';
import { parseOpenApi } from '../../parsers/openapi/index.js';
import { createOpenApiController, filterOpenApiOperations } from './controller.js';

describe('OpenAPI shared-text search', () => {
    it('searches large shared descriptions without rescanning them for every path', () => {
        const source = { openapi: '3.1.0', info: { title: 'Shared search', version: '1' },
            paths: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`/pets/${i}`, { $ref: '#/x-shared' }])),
            'x-shared': { get: { description: 'shared '.repeat(125_000), tags: ['pets'], responses: {} } } };
        const parsed = parseOpenApi(JSON.stringify(source)).result;
        if (parsed.status === 'failed') throw new Error(parsed.failure.messageKey);
        const started = performance.now();
        expect(filterOpenApiOperations(parsed.document, { search: 'UNMATCHED', method: '', tag: '' })).toHaveLength(0);
        expect(performance.now() - started).toBeLessThan(2000);
        const controller = createOpenApiController(parsed.document);
        controller.update({ search: 'shared' });
        const filtered = controller.filtered;
        controller.update({ tab: 'schemas' });
        expect(controller.filtered).toBe(filtered);
        expect(controller.filtered).toHaveLength(1000);
        controller.update({ search: 'pets/999', tag: 'pets', method: 'GET' });
        expect(controller.filtered.map(operation => operation.path)).toEqual(['/pets/999']);
    });
});
