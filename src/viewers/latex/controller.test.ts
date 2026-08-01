import { describe, expect, it } from 'vitest';
import { createLatexController } from './controller.js';

describe('createLatexController — history', () => {
    it('bounds undo memory on a large document instead of keeping 100 copies', () => {
        // Snapshots are whole-source copies, so the entry cap alone is not a
        // bound: at the parser's 10 MiB limit, 100 of them is a gigabyte.
        const big = 'x'.repeat(1024 * 1024);
        const controller = createLatexController(big);
        for (let i = 0; i < 20; i++) controller.dispatch({ type: 'edit-source', source: big + i });
        let depth = 0;
        while (controller.state.canUndo) { controller.dispatch({ type: 'undo' }); depth++; }
        expect(depth).toBeGreaterThan(0);
        expect(depth).toBeLessThanOrEqual(5);
    });

    it('keeps full depth for ordinary documents', () => {
        const controller = createLatexController('start');
        for (let i = 0; i < 20; i++) controller.dispatch({ type: 'edit-source', source: `edit ${i}` });
        let depth = 0;
        while (controller.state.canUndo) { controller.dispatch({ type: 'undo' }); depth++; }
        expect(depth).toBe(20);
    });
});
