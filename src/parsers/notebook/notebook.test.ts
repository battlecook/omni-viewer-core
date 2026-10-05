import { describe, expect, it } from 'vitest';
import { parseNotebook } from './index.js';

const cell = (source: unknown = 'print(1)', outputs: unknown = []) => ({
    cell_type: 'code', metadata: {}, source, execution_count: 3, outputs
});
const notebook = (cells: unknown[] = [], extra = {}) => JSON.stringify({
    nbformat: 4, nbformat_minor: 5, metadata: { language_info: { name: 'python' }, kernelspec: { display_name: 'Python 3' } }, cells, ...extra
});
const document = (source: string, options: Parameters<typeof parseNotebook>[1] = {}) => {
    const { result } = parseNotebook(source, options);
    expect(result.status).not.toBe('failed');
    if (result.status === 'failed') throw new Error(result.failure.messageKey);
    return result;
};

describe('parseNotebook', () => {
    it('reads ordered Markdown, code, and raw cells, string lists, execution counts, and optional metadata', () => {
        const { document: doc } = document(notebook([
            { cell_type: 'markdown', source: ['# Title\n', '$x_i$'], metadata: {} },
            cell(['a = 1\n', 'print(a)']), { cell_type: 'raw', source: '<raw>', metadata: {} }
        ]));
        expect(doc.cells.map(c => c.type)).toEqual(['markdown', 'code', 'raw']);
        expect(doc.cells.map(c => c.source)).toEqual(['# Title\n$x_i$', 'a = 1\nprint(a)', '<raw>']);
        expect(doc.cells[1]?.executionCount).toBe(3);
        expect(doc).toMatchObject({ nbformat: 4, nbformatMinor: 5, language: 'python', kernelName: 'Python 3', totalCells: 3 });
        expect(document(notebook([cell()], { metadata: {} })).document.language).toBe('');
        expect(parseNotebook(new TextEncoder().encode(notebook([]))).result.status).toBe('ok');
    });

    it('normalizes every v4 output, keeps MIME priority, and preserves JSON numeric fidelity', () => {
        const source = notebook([cell('', [
            { output_type: 'stream', name: 'stdout', text: ['first\n', 'second\n'] },
            { output_type: 'display_data', data: { 'text/plain': 'fallback', 'text/html': ['<table>', '</table>'], 'image/png': ['YW', 'Jj'], 'application/json': { n: 'TOKEN' } }, metadata: { 'image/png': { width: 640, height: 480 } } },
            { output_type: 'execute_result', execution_count: 9, data: { 'text/plain': '42' }, metadata: {} },
            { output_type: 'error', ename: 'ValueError', evalue: 'bad value', traceback: ['frame 1', 'frame 2'] }
        ])]).replace('"TOKEN"', '9007199254740993');
        const doc = document(source).document;
        expect(doc.outputCount).toBe(4); expect(doc.errorCount).toBe(1);
        const outputs = doc.cells[0]!.outputs;
        expect(outputs[0]?.text).toBe('first\nsecond\n');
        expect(outputs[1]?.representations.map(v => v.mimeType)).toEqual(['text/html', 'image/png', 'application/json', 'text/plain']);
        expect(outputs[1]?.representations[1]).toMatchObject({ text: 'YWJj', width: 640, height: 480 });
        expect(outputs[1]?.representations[2]?.text).toContain('9007199254740993');
        expect(outputs[2]?.executionCount).toBe(9);
        expect(outputs[3]).toMatchObject({ errorName: 'ValueError', errorValue: 'bad value', traceback: 'frame 1\nframe 2' });
    });

    it('reads cell attachments without treating filenames as object prototypes', () => {
        const { document: doc } = document(notebook([{ cell_type: 'markdown', source: '![image](attachment:__proto__)',
            metadata: {}, attachments: { ['__proto__']: { 'image/png': ['YW', 'Jj'] } } }]));
        expect(doc.cells[0]!.attachments['__proto__']?.[0]?.text).toBe('YWJj');
        expect(Object.getPrototypeOf(doc.cells[0]!.attachments)).toBeNull();
    });

    it('honors persisted visibility hints and null execution counts', () => {
        const { document: doc } = document(notebook([{ ...cell(), execution_count: null,
            metadata: { jupyter: { source_hidden: true, outputs_hidden: true } } },
            { ...cell(), metadata: { collapsed: true } }]));
        expect(doc.cells[0]).toMatchObject({ executionCount: null, sourceHidden: true, outputsHidden: true });
        expect(doc.cells[1]?.outputsHidden).toBe(true);
    });

    it.each(['{', '[]', '{}', '{"nbformat":4,"nbformat_minor":0,"cells":{}}',
        '{"nbformat":4,"nbformat_minor":0,"cells":[]} trailing'])('returns a typed failure for %s', source => {
        expect(() => parseNotebook(source)).not.toThrow();
        expect(parseNotebook(source).result.status).toBe('failed');
    });

    it('rejects unsupported major versions and accepts future minor versions', () => {
        expect(parseNotebook(notebook([], { nbformat: 3 })).result).toMatchObject({ status: 'failed', failure: { messageKey: 'diag.notebook.version' } });
        expect(parseNotebook(notebook([], { nbformat_minor: 99 })).result.status).toBe('ok');
    });

    it('reports malformed and unknown content while preserving valid cells', () => {
        const result = document(notebook([null, cell([1]), { cell_type: 'future', source: 'raw source' },
            cell('ok', [{ output_type: 'future-output' }])]));
        expect(result.status).toBe('partial'); expect(result.document.cells).toHaveLength(2);
        expect(result.document.cells[0]?.type).toBe('unknown');
        expect(result.document.cells[1]?.outputs[0]?.type).toBe('unknown');
        expect(result.diagnostics.map(d => d.messageKey)).toEqual(expect.arrayContaining(['diag.notebook.malformed', 'diag.notebook.unknownCell', 'diag.notebook.unknownOutput']));
    });

    it('bounds cells and total outputs independently from the JSON node budget', () => {
        expect(document(notebook([cell(), cell(), cell()]), { limits: { maxEntries: 1 } })).toMatchObject({
            status: 'partial', document: { cells: [expect.objectContaining({ index: 0 })], totalCells: 3 }
        });
        const stream = { output_type: 'stream', name: 'stdout', text: 'saved' };
        const result = document(notebook([cell('', [stream, stream]), cell('', [stream])]), { maxOutputs: 1 });
        expect(result.status).toBe('partial'); expect(result.document.outputCount).toBe(1);
        expect(result.document.cells).toHaveLength(2);
        expect(document(notebook([cell()]), { limits: { maxEntries: 0 } }).document.cells).toHaveLength(0);
    });

    it('bounds previews in UTF-8 bytes without splitting strings or surrogate pairs', () => {
        const result = document(notebook([cell(['한글', '😀end'])]), { limits: { maxPreviewBytes: 8 } });
        expect(result.status).toBe('partial'); expect(result.document.cells[0]?.source).toBe('한글');
        const total = document(notebook([cell('123'), cell('456')]), { maxTotalPreviewBytes: 4 });
        expect(total.document.cells.map(c => c.source)).toEqual(['123', '4']);
        const mime = document(notebook([cell('', [{ output_type: 'display_data', data: { 'image/png': 'YWJjYWJj', 'text/plain': 'ok' } }])]),
            { limits: { maxPreviewBytes: 4 } });
        expect(mime.document.cells[0]?.outputs[0]?.representations[0]).toMatchObject({ truncated: true, text: 'YWJj' });
        expect(mime.document.cells[0]?.outputs[0]?.representations[1]).toMatchObject({ truncated: false, text: 'ok' });
    });

    it('returns input-size and cancellation failures', () => {
        expect(parseNotebook(notebook([]), { limits: { maxInputBytes: 1 } }).result).toMatchObject({ status: 'failed', failure: { code: 'limit-exceeded' } });
        const controller = new AbortController(); controller.abort();
        expect(parseNotebook(notebook([]), { signal: controller.signal }).result).toMatchObject({ status: 'failed', failure: { code: 'aborted' } });
    });

    it('is deterministic apart from the execution report and does not mutate input', () => {
        const bytes = new TextEncoder().encode(notebook([cell()])); const copy = bytes.slice();
        expect(parseNotebook(bytes).result).toEqual(parseNotebook(bytes).result); expect(bytes).toEqual(copy);
    });
});
