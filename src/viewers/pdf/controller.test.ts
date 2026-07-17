import { describe, expect, it } from 'vitest';
import { createPdfController } from './controller.js';

describe('PdfController', () => {
    it('keeps page editing and annotations independent from zoom', () => {
        const c = createPdfController(3);
        c.dispatch({ type: 'zoom-in' });
        c.dispatch({ type: 'reorder-pages', from: 0, to: 2 });
        c.dispatch({ type: 'delete-page', page: 2 });
        c.dispatch({ type: 'add-annotation', annotation: { kind: 'text', page: 1, x: 10, y: 20, text: 'note', size: 16, color: '#000' } });
        expect(c.state.zoom).toBe(125);
        expect(c.state.pageOrder).toEqual([3, 1]);
        expect(c.state.annotations).toHaveLength(1);
        expect(c.state.dirty).toBe(true);
    });

    it('does not delete the last page and resets document edits', () => {
        const c = createPdfController(1);
        c.dispatch({ type: 'delete-page', page: 1 });
        expect(c.state.pageOrder).toEqual([1]);
        c.dispatch({ type: 'add-annotation', annotation: { kind: 'text', page: 1, x: 0, y: 0, text: 'x', size: 12, color: '#000' } });
        c.dispatch({ type: 'reset-pages' });
        expect(c.state.annotations).toEqual([]);
        expect(c.state.dirty).toBe(false);
    });

    it('undoes and redoes page and annotation edits', () => {
        const c = createPdfController(3);
        c.dispatch({ type: 'delete-page', page: 2 });
        c.dispatch({ type: 'add-annotation', annotation: { kind: 'text', page: 1, x: 0, y: 0, text: 'x', size: 12, color: '#000' } });
        c.dispatch({ type: 'undo' });
        expect(c.state.annotations).toEqual([]);
        expect(c.state.pageOrder).toEqual([1, 3]);
        c.dispatch({ type: 'undo' });
        expect(c.state.pageOrder).toEqual([1, 2, 3]);
        c.dispatch({ type: 'redo' });
        c.dispatch({ type: 'redo' });
        expect(c.state.pageOrder).toEqual([1, 3]);
        expect(c.state.annotations).toHaveLength(1);
    });

    it('rehydrates existing markup when merged pages are appended', () => {
        const beforeMerge = createPdfController(2);
        beforeMerge.dispatch({
            type: 'add-annotation',
            annotation: {
                kind: 'highlight', page: 1, color: '#ffeb3b',
                rects: [{ x: 10, y: 20, width: 30, height: 12 }]
            }
        });
        const merged = createPdfController(4, {
            pageOrder: [...beforeMerge.state.pageOrder, 3, 4],
            annotations: beforeMerge.state.annotations
        });
        expect(merged.state.pageOrder).toEqual([1, 2, 3, 4]);
        expect(merged.state.annotations).toHaveLength(1);
        expect(merged.state.annotations[0]?.kind).toBe('highlight');
    });
});
