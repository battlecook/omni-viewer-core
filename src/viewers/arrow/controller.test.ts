import { describe, expect, it } from 'vitest';
import { createArrowController } from './controller.js';
import type { ArrowDocument } from '../../parsers/arrow/index.js';

function model(): ArrowDocument {
    return { format: 'file', headers: ['id', 'name'], fields: [], metadata: {},
        rows: [['9007199254740993', 'beta'], ['9007199254740992', 'alpha'], [null, 'gamma']],
        totalRows: 10, loadedRows: 3, recordBatches: 1, compression: [], fileSizeBytes: 100, isLimited: true };
}
describe('Arrow controller', () => {
    it('sorts large integers losslessly, keeps nulls last and cycles through original order', () => {
        const controller = createArrowController(model());
        controller.dispatch({ type: 'sort', column: 0 });
        expect(controller.visibleRows().map(row => row[0])).toEqual(['9007199254740992', '9007199254740993', null]);
        controller.dispatch({ type: 'sort', column: 0 });
        expect(controller.visibleRows().map(row => row[0])).toEqual(['9007199254740993', '9007199254740992', null]);
        controller.dispatch({ type: 'sort', column: 0 }); expect(controller.state.sortColumn).toBeNull();
        expect(controller.visibleRows()).toEqual(model().rows);
    });
    it('filters, paginates, clamps invalid actions and exports preview provenance', () => {
        const controller = createArrowController(model());
        controller.dispatch({ type: 'page-size', size: 2 }); expect(controller.state.pageCount).toBe(2);
        controller.dispatch({ type: 'page', page: 500 }); expect(controller.visibleRows()).toEqual([[null, 'gamma']]);
        controller.dispatch({ type: 'search', value: 'ALPHA' }); expect(controller.visibleRows()).toEqual([['9007199254740992', 'alpha']]);
        expect(controller.state.page).toBe(0);
        controller.dispatch({ type: 'page-size', size: 0 }); expect(controller.state.pageSize).toBe(2);
        controller.dispatch({ type: 'page', page: NaN }); expect(controller.state.page).toBe(0);
        const output = JSON.parse(controller.toJson());
        expect(output.rows).toHaveLength(1); expect(output.preview).toEqual({ totalRows: 10, loadedRows: 3, matchedRows: 1, isLimited: true });
    });
    it('sorts decimal strings without floating-point precision loss', () => {
        const document = model();
        document.rows = [['10.00'], ['2.000000000000000002'], ['2.000000000000000001'], ['-10.10'], ['-10.2'], ['-0.0'], ['0']];
        const controller = createArrowController(document);
        controller.dispatch({ type: 'sort', column: 0 });
        expect(controller.visibleRows().map(row => row[0])).toEqual(['-10.2', '-10.10', '-0.0', '0', '2.000000000000000001', '2.000000000000000002', '10.00']);
    });
});
