import { describe, expect, it } from 'vitest';
import { createJsonlController } from './controller.js';

describe('JsonlController', () => {
    it('completes a record that crosses append-only page boundaries', async () => {
        const c = createJsonlController({
            initialData: new TextEncoder().encode('{"a":1}\n{"b"'),
            loadMore: async () => ({ data: new TextEncoder().encode(':2}\n'), done: true })
        });
        expect(c.state.loadState).toBe('preview');
        expect(c.state.entries).toHaveLength(1);
        await c.dispatch({ type: 'load-more' });
        expect(c.state.loadState).toBe('complete');
        expect(c.state.entries).toHaveLength(2);
        expect(c.state.entries[1]?.value?.kind).toBe('object');
    });
    it('blocks preview edits and invalid saves and supports range selection', () => {
        const preview = createJsonlController({ initialData: new TextEncoder().encode('{"a":1}\n'), loadMore: async () => ({ data: new Uint8Array(), done: true }) });
        preview.dispatch({ type: 'insert' }); expect(preview.state.entries).toHaveLength(1);
        const c = createJsonlController('{"a":1}\n{"b":2}\n{"c":3}'); const [a, , cId] = c.state.entries.map(entry => entry.id);
        c.dispatch({ type: 'select', id: a! }); c.dispatch({ type: 'select', id: cId!, range: true }); expect(c.state.selected.size).toBe(3);
        c.dispatch({ type: 'edit', id: a!, raw: '{bad' }); expect(c.canSave()).toBe(false);
    });

    it('uses stable ids after deletion and insertion', () => {
        const c = createJsonlController('{"a":1}\n{"b":2}\n');
        const first = c.state.entries[0]!.id;
        c.dispatch({ type: 'select', id: first });
        c.dispatch({ type: 'delete-selected' });
        c.dispatch({ type: 'insert', raw: '{"c":3}' });
        const inserted = c.state.entries.at(-1)!;
        c.dispatch({ type: 'edit', id: inserted.id, raw: '{"c":4}' });
        expect(c.state.entries.at(-1)?.raw).toBe('{"c":4}');
    });
});
