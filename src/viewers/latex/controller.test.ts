import { describe, expect, it } from 'vitest';
import { createLatexController } from './controller.js';

describe('createLatexController — dirty', () => {
    // `dirty` is what the mount handle's isDirty() reports, so a host's unsaved
    // guard rests on these transitions.
    it('tracks the distance from the last saved source, not the number of edits', () => {
        const controller = createLatexController('one');
        expect(controller.state.dirty).toBe(false);

        controller.dispatch({ type: 'edit-source', source: 'two' });
        expect(controller.state.dirty).toBe(true);

        // Typed back by hand rather than undone: same text, same verdict.
        controller.dispatch({ type: 'edit-source', source: 'one' });
        expect(controller.state.dirty).toBe(false);

        controller.dispatch({ type: 'edit-source', source: 'three' });
        controller.dispatch({ type: 'undo' });
        expect(controller.state.dirty).toBe(false);

        controller.dispatch({ type: 'redo' });
        expect(controller.state.dirty).toBe(true);
        controller.dispatch({ type: 'mark-saved' });
        expect(controller.state.dirty).toBe(false);

        // Saving moved the baseline: undoing past it is an edit again.
        controller.dispatch({ type: 'undo' });
        expect(controller.state.dirty).toBe(true);
    });

    it('stays dirty when mark-saved names an older source than the editor holds', () => {
        // A write is async and the editor stays live during it. Marking "what is
        // in the editor now" as saved would declare an edit made mid-write to be
        // on disk, and a host trusting isDirty() would then discard it.
        const controller = createLatexController('A');
        controller.dispatch({ type: 'edit-source', source: 'B' });
        controller.dispatch({ type: 'mark-saved', source: 'A' });
        expect(controller.state.dirty).toBe(true);
        expect(controller.state.savedSource).toBe('A');

        // Returning to what the file holds is genuinely clean.
        controller.dispatch({ type: 'undo' });
        expect(controller.state.dirty).toBe(false);
    });

    it('leaves dirty alone for view-only actions', () => {
        const controller = createLatexController('one');
        controller.dispatch({ type: 'edit-source', source: 'two' });
        controller.dispatch({ type: 'set-mode', mode: 'split' });
        controller.dispatch({ type: 'select-heading', id: 'h1' });
        expect(controller.state.dirty).toBe(true);
    });
});

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
