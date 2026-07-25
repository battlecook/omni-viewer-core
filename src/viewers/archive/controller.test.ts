import { describe, expect, it } from 'vitest';
import { addImplicitArchiveDirectories, createArchiveController } from './controller.js';

describe('ArchiveController', () => {
    const entries = [{ entryId: 0, path: 'dir/', isDirectory: true }, { entryId: 1, path: 'dir/a.txt', isDirectory: false }, { entryId: 2, path: 'b.txt', isDirectory: false }];
    it('hides descendants of a collapsed directory and preserves search ancestors', () => {
        const controller = createArchiveController(entries);
        controller.dispatch({ type: 'toggle-directory', path: 'dir/' });
        expect(controller.visibleEntries().map(x => x.path)).toEqual(['dir/', 'b.txt']);
        controller.dispatch({ type: 'set-search', query: 'a.txt' });
        expect(controller.visibleEntries().map(x => x.path)).toEqual(['dir/', 'dir/a.txt']);
    });

    it('can synthesize missing directories without changing decoder entries or IDs', () => {
        const original = [{ entryId: 7, path: 'a/b/report.pdf', isDirectory: false }];
        const normalized = addImplicitArchiveDirectories(original);
        expect(normalized.map(entry => [entry.entryId, entry.path, entry.isDirectory])).toEqual([
            [-1, 'a/', true],
            [-2, 'a/b/', true],
            [7, 'a/b/report.pdf', false]
        ]);
        expect(original).toEqual([{ entryId: 7, path: 'a/b/report.pdf', isDirectory: false }]);
        expect(createArchiveController(normalized).visibleEntries().map(entry => entry.path)).toEqual(['a/', 'a/b/', 'a/b/report.pdf']);
    });
});
