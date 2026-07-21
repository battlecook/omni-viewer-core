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

    it('recolors a markup annotation and tracks the change in history', () => {
        const c = createPdfController(1);
        c.dispatch({
            type: 'add-annotation',
            annotation: { kind: 'highlight', page: 1, color: '#ffeb3b', text: 'hi', rects: [{ x: 0, y: 0, width: 10, height: 4 }] }
        });
        const id = c.state.annotations[0]!.id;
        const colorOf = () => {
            const a = c.state.annotations[0]!;
            return a.kind === 'signature' ? undefined : a.color;
        };
        c.dispatch({ type: 'set-annotation-color', id, color: '#ffc9c9' });
        expect(colorOf()).toBe('#ffc9c9');
        c.dispatch({ type: 'undo' });
        expect(colorOf()).toBe('#ffeb3b');
        c.dispatch({ type: 'redo' });
        expect(colorOf()).toBe('#ffc9c9');
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

    it('uses the VS Code-compatible intermediate zoom steps', () => {
        const c = createPdfController(1);
        for (const expected of [125, 150, 175, 200, 225, 250, 275, 300]) {
            c.dispatch({ type: 'zoom-in' });
            expect(c.state.zoom).toBe(expected);
        }
    });

    it('keeps arbitrary fit zooms and reaches the real minimum and maximum', () => {
        const c = createPdfController(1);
        c.dispatch({ type: 'set-zoom', zoom: 33 });
        expect(c.state.zoom).toBe(33);
        c.dispatch({ type: 'zoom-out' });
        expect(c.state.zoom).toBe(25);
        c.dispatch({ type: 'zoom-out' });
        expect(c.state.zoom).toBe(25);

        c.dispatch({ type: 'set-zoom', zoom: 350 });
        c.dispatch({ type: 'zoom-in' });
        expect(c.state.zoom).toBe(400);
        c.dispatch({ type: 'zoom-in' });
        expect(c.state.zoom).toBe(400);
    });

    it('supports mount-provided zoom steps without changing the default API', () => {
        const c = createPdfController(1, undefined, {
            zoomLevels: [80, 100, 160], minZoom: 40, maxZoom: 220
        });
        c.dispatch({ type: 'zoom-in' });
        expect(c.state.zoom).toBe(160);
        c.dispatch({ type: 'zoom-in' });
        expect(c.state.zoom).toBe(220);
        c.dispatch({ type: 'zoom-out' });
        expect(c.state.zoom).toBe(160);
    });
});
