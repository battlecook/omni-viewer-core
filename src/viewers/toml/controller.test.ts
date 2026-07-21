import { describe, expect, it } from 'vitest';
import { createTomlController } from './controller.js';

const SOURCE = '# the listener\n[server]\nhost = "example.com"\nport = 8080\n';

describe('createTomlController', () => {
    it('scopes the search and counts matches', () => {
        const controller = createTomlController('[server]\nhost = "host.example"\nport = 8080\n');
        controller.dispatch({ type: 'set-search', search: 'host' });
        expect(controller.state.matchCount).toBe(1);
        expect(controller.nodeMatches({ key: 'host', path: 'server.host', raw: '"host.example"' })).toBe(true);
        controller.dispatch({ type: 'set-search-scope', scope: 'value' });
        expect(controller.nodeMatches({ key: 'host', path: 'server.host', raw: '"host.example"' })).toBe(true);
        expect(controller.nodeMatches({ key: 'host', path: 'server.host', raw: '""' })).toBe(false);
        controller.dispatch({ type: 'set-search-scope', scope: 'key' });
        controller.dispatch({ type: 'set-search', search: 'server' });
        expect(controller.state.matchCount).toBe(1);
    });
    it('maps a node to a source range and a caret back to the deepest node', () => {
        const controller = createTomlController(SOURCE);
        const range = controller.nodeRange('server.port')!;
        expect(SOURCE.slice(range.start, range.end)).toBe('port = 8080');
        expect(controller.nodeAtOffset(range.start + 2)).toBe('server.port');
        expect(controller.nodeAtOffset(range.end)).toBeNull();
        expect(controller.nodeAtOffset(SOURCE.indexOf('[server]') + 1)).toBe('server');
        expect(controller.nodeAtOffset(0)).toBeNull();
    });
    it('selects from a caret offset and expands the ancestors of the selection', () => {
        const controller = createTomlController(SOURCE);
        controller.dispatch({ type: 'collapse-all' });
        controller.dispatch({ type: 'select-offset', offset: SOURCE.indexOf('8080') });
        expect(controller.state.selected).toBe('server.port');
        expect([...controller.state.expanded]).toContain('server');
        controller.dispatch({ type: 'select-node', id: 'nope' });
        expect(controller.state.selected).toBeNull();
    });
    it('carries the comment above a declaration onto its node', () => {
        const controller = createTomlController(SOURCE);
        expect(controller.state.root?.children?.[0]?.comment).toBe('the listener');
    });
    it('drops a selection that no longer exists after an edit', () => {
        const controller = createTomlController(SOURCE);
        controller.dispatch({ type: 'select-node', id: 'server.port' });
        controller.dispatch({ type: 'edit-source', text: 'a = 1' });
        expect(controller.state.selected).toBeNull();
    });
});
