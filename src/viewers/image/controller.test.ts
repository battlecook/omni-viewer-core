import { describe, expect, it } from 'vitest';
import {
    createImageController,
    filterToCss,
    normalizeZoom,
    FILTER_PRESETS,
    MAX_UNDO_ENTRIES,
    type Annotation
} from './controller.js';

const rect = (id: string): Annotation => ({
    id,
    type: 'rectangle',
    x: 10,
    y: 10,
    w: 20,
    h: 20,
    style: { color: '#fff', fillOpacity: 0, borderOpacity: 1, fontSize: 16, brushSize: 4 }
});

describe('normalizeZoom', () => {
    it('snaps to the 25% grid and clamps to 10%–500%', () => {
        expect(normalizeZoom(1.07)).toBe(1);
        expect(normalizeZoom(1.13)).toBe(1.25);
        expect(normalizeZoom(0.01)).toBe(0.1);
        expect(normalizeZoom(9)).toBe(5);
    });
});

describe('ImageController — view transform', () => {
    it('zoom in/out steps by 25% and leaves fit mode', () => {
        const c = createImageController();
        expect(c.state.fitMode).toBe(true);
        c.dispatch({ type: 'zoom-in' });
        expect(c.state.zoom).toBe(1.25);
        expect(c.state.fitMode).toBe(false);
        c.dispatch({ type: 'zoom-out' });
        expect(c.state.zoom).toBe(1);
    });

    it('clamps zoom at the range ends', () => {
        const c = createImageController();
        for (let i = 0; i < 30; i++) c.dispatch({ type: 'zoom-in' });
        expect(c.state.zoom).toBe(5);
        for (let i = 0; i < 60; i++) c.dispatch({ type: 'zoom-out' });
        expect(c.state.zoom).toBe(0.1);
    });

    it('fit and actual-size set the view without editing history', () => {
        const c = createImageController();
        c.dispatch({ type: 'zoom-in' });
        c.dispatch({ type: 'actual-size' });
        expect(c.state.zoom).toBe(1);
        expect(c.state.fitMode).toBe(false);
        c.dispatch({ type: 'fit' });
        expect(c.state.fitMode).toBe(true);
        expect(c.state.canUndo).toBe(false); // view changes are not undoable
        expect(c.state.dirty).toBe(false);
    });

    it('rotates in 90° steps and wraps', () => {
        const c = createImageController();
        c.dispatch({ type: 'rotate-cw' });
        expect(c.state.rotation).toBe(90);
        c.dispatch({ type: 'rotate-cw' });
        c.dispatch({ type: 'rotate-cw' });
        c.dispatch({ type: 'rotate-cw' });
        expect(c.state.rotation).toBe(0);
    });

    it('flip toggles are independent', () => {
        const c = createImageController();
        c.dispatch({ type: 'flip-h' });
        expect(c.state.flipH).toBe(true);
        expect(c.state.flipV).toBe(false);
        c.dispatch({ type: 'flip-v' });
        expect(c.state.flipV).toBe(true);
    });

    it('reset returns transform, filter, grid, annotations and selection to initial', () => {
        const c = createImageController();
        c.dispatch({ type: 'rotate-cw' });
        c.dispatch({ type: 'set-preset', preset: 'bw' });
        c.dispatch({ type: 'add-annotation', annotation: rect('r1') });
        c.dispatch({ type: 'toggle-grid' });
        c.dispatch({ type: 'reset' });
        expect(c.state.rotation).toBe(0);
        expect(c.state.preset).toBe('original');
        expect(c.state.annotations).toHaveLength(0);
        expect(c.state.grid.visible).toBe(false);
        expect(c.state.selectedId).toBeNull();
        expect(c.state.zoom).toBe(1);
        expect(c.state.fitMode).toBe(true);
    });
});

describe('ImageController — filters', () => {
    it('clamps filter values to their ranges and clears the preset', () => {
        const c = createImageController();
        c.dispatch({ type: 'set-filter', filter: { brightness: 999, grayscale: -5 } });
        expect(c.state.filter.brightness).toBe(200);
        expect(c.state.filter.grayscale).toBe(0);
        expect(c.state.preset).toBeNull();
    });

    it('applies a preset and reflects it in the CSS filter string', () => {
        const c = createImageController();
        c.dispatch({ type: 'set-preset', preset: 'bw' });
        expect(c.state.filter).toEqual(FILTER_PRESETS.bw);
        expect(c.filterCss()).toBe(filterToCss(FILTER_PRESETS.bw));
    });
});

describe('ImageController — grid', () => {
    it('keeps the previous valid value on non-positive input (image.md §3)', () => {
        const c = createImageController();
        c.dispatch({ type: 'set-grid-value', key: 'cellWidth', value: 48 });
        expect(c.state.grid.cellWidth).toBe(48);
        c.dispatch({ type: 'set-grid-value', key: 'cellWidth', value: 0 });
        expect(c.state.grid.cellWidth).toBe(48);
        c.dispatch({ type: 'set-grid-value', key: 'cellWidth', value: -3 });
        expect(c.state.grid.cellWidth).toBe(48);
    });

    it('preserves both cell-size and rows-cols meaning (image.md I3)', () => {
        const c = createImageController();
        c.dispatch({ type: 'set-grid-value', key: 'rows', value: 8 });
        c.dispatch({ type: 'set-grid-mode', mode: 'rows-cols' });
        expect(c.state.grid.mode).toBe('rows-cols');
        expect(c.state.grid.rows).toBe(8);
        c.dispatch({ type: 'set-grid-mode', mode: 'cell-size' });
        expect(c.state.grid.rows).toBe(8); // not lost on mode switch
    });
});

describe('ImageController — annotations', () => {
    it('adds, selects and moves in source coordinates', () => {
        const c = createImageController();
        c.dispatch({ type: 'add-annotation', annotation: rect('r1') });
        expect(c.state.selectedId).toBe('r1');
        c.dispatch({ type: 'move-annotation', dx: 5, dy: -3 });
        const a = c.state.annotations[0];
        expect(a).toMatchObject({ x: 15, y: 7 });
    });

    it('deletes the selected annotation', () => {
        const c = createImageController();
        c.dispatch({ type: 'add-annotation', annotation: rect('r1') });
        c.dispatch({ type: 'add-annotation', annotation: rect('r2') });
        c.dispatch({ type: 'select-annotation', id: 'r1' });
        c.dispatch({ type: 'delete-annotation' });
        expect(c.state.annotations.map((x) => x.id)).toEqual(['r2']);
        expect(c.state.selectedId).toBeNull();
    });
});

describe('ImageController — undo / dirty (image.md I4)', () => {
    it('undoes edit commands and tracks dirty', () => {
        const c = createImageController();
        expect(c.state.dirty).toBe(false);
        c.dispatch({ type: 'add-annotation', annotation: rect('r1') });
        expect(c.state.dirty).toBe(true);
        expect(c.state.canUndo).toBe(true);
        c.dispatch({ type: 'undo' });
        expect(c.state.annotations).toHaveLength(0);
        expect(c.state.dirty).toBe(false);
        expect(c.state.canUndo).toBe(false);
    });

    it('undo is a no-op at the initial state', () => {
        const c = createImageController();
        c.dispatch({ type: 'undo' });
        expect(c.state.canUndo).toBe(false);
    });

    it('caps history at MAX_UNDO_ENTRIES, dropping the oldest', () => {
        const c = createImageController();
        for (let i = 0; i < MAX_UNDO_ENTRIES + 20; i++) {
            c.dispatch({ type: 'add-annotation', annotation: rect(`r${i}`) });
        }
        let undone = 0;
        while (c.state.canUndo) {
            c.dispatch({ type: 'undo' });
            undone++;
            if (undone > MAX_UNDO_ENTRIES + 50) break; // guard against infinite loop
        }
        // Only the capped number of steps are reachable; oldest edits are gone.
        expect(undone).toBeLessThanOrEqual(MAX_UNDO_ENTRIES);
        expect(c.state.annotations.length).toBeGreaterThan(0);
    });
});

describe('ImageController — subscribe / setDocument', () => {
    it('notifies subscribers on dispatch and records decode status', () => {
        const c = createImageController();
        const seen: number[] = [];
        const unsub = c.subscribe((s) => seen.push(s.zoom));
        c.dispatch({ type: 'zoom-in' });
        expect(seen).toContain(1.25);
        unsub();
        c.setDocument({ status: 'failed', failure: { code: 'invalid-format', retryable: false, messageKey: 'x' } });
        expect(c.state.status).toBe('failed');
        expect(c.state.editingEnabled).toBe(false);
    });
});
