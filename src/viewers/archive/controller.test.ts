import { describe, expect, it } from 'vitest';
import { createArchiveController } from './controller.js';

describe('ArchiveController', () => {
    const entries = [{ entryId: 0, path: 'dir/', isDirectory: true }, { entryId: 1, path: 'dir/a.txt', isDirectory: false }, { entryId: 2, path: 'b.txt', isDirectory: false }];
    it('hides descendants of a collapsed directory and preserves search ancestors', () => {
        const controller = createArchiveController(entries);
        controller.dispatch({ type: 'toggle-directory', path: 'dir/' });
        expect(controller.visibleEntries().map(x => x.path)).toEqual(['dir/', 'b.txt']);
        controller.dispatch({ type: 'set-search', query: 'a.txt' });
        expect(controller.visibleEntries().map(x => x.path)).toEqual(['dir/', 'dir/a.txt']);
    });
});
