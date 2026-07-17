import { describe, expect, it } from 'vitest';
import { createMarkdownController } from './controller.js';

describe('MarkdownController', () => {
    it('searches the complete source, not only headings', () => {
        const controller = createMarkdownController('# Title\nparagraph needle\n```\nneedle\n```', [{ level: 1, text: 'Title', id: 'h', start: 0, end: 8 }]);
        controller.dispatch({ type: 'set-search', query: 'needle' });
        expect(controller.matches()).toEqual([{ start: 18, end: 24 }, { start: 29, end: 35 }]);
    });

    it('edits, undoes, redoes, and marks source as saved', () => {
        const controller = createMarkdownController('# Old', []);
        controller.dispatch({ type: 'edit-source', source: '# New' });
        expect(controller.state.dirty).toBe(true);
        expect(controller.state.canUndo).toBe(true);
        controller.dispatch({ type: 'undo' });
        expect(controller.state.source).toBe('# Old');
        controller.dispatch({ type: 'redo' });
        expect(controller.state.source).toBe('# New');
        controller.dispatch({ type: 'mark-saved' });
        expect(controller.state.dirty).toBe(false);
    });

    it('supports the split view mode', () => {
        const controller = createMarkdownController('', []);
        controller.dispatch({ type: 'set-mode', mode: 'split' });
        expect(controller.state.mode).toBe('split');
    });
});
