import { describe, expect, it } from 'vitest';
import { createYamlController } from './controller.js';
describe('YamlController', () => {
    it('selects exactly one document and uses ASCII search normalization', () => {
        const c = createYamlController('ignored', { parse: () => [{ one: 'A' }, { two: 'B' }] });
        c.dispatch({ type: 'select-document', index: 1 });
        expect(c.state.selectedDocument).toBe(1);
        c.dispatch({ type: 'set-search', search: 'B' });
        expect(c.state.search).toBe('B');
    });
    it('serializes the selected document as JSON and accepts flat/json modes', () => {
        const c = createYamlController('ignored', { parse: () => [{ one: 'A' }, { two: 'B' }] });
        c.dispatch({ type: 'select-document', index: 1 });
        expect(JSON.parse(c.documentJson())).toEqual({ two: 'B' });
        c.dispatch({ type: 'set-mode', mode: 'flat' });
        expect(c.state.mode).toBe('flat');
        c.dispatch({ type: 'set-mode', mode: 'json' });
        expect(c.state.mode).toBe('json');
    });
});
