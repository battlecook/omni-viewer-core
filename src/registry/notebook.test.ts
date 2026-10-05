import { describe, expect, it } from 'vitest';
import { NOTEBOOK_VIEWER_META } from '../viewers/notebook/index.js';
import { CORE_VIEWER_DESCRIPTORS, NOTEBOOK_VIEWER_DESCRIPTOR, detectViewer, looksLikeNotebook, sniffTextViewer } from './index.js';

const notebook = '{"nbformat":4,"nbformat_minor":5,"metadata":{},"cells":[{"cell_type":"markdown","source":"hello"}]}';
describe('notebook detection', () => {
    it('routes case-insensitive .ipynb and keeps the registry aligned', () => {
        for (const name of ['analysis.ipynb', 'ANALYSIS.IPYNB']) expect(detectViewer(name)).toEqual({ viewerId: 'notebook', matchedBy: 'extension' });
        const { inputOwnership: _ownership, ...meta } = NOTEBOOK_VIEWER_META;
        expect(NOTEBOOK_VIEWER_DESCRIPTOR).toMatchObject(meta);
        expect(CORE_VIEWER_DESCRIPTORS.filter(d => d.id === 'notebook')).toHaveLength(1);
    });
    it('detects structure before generic JSON, including a truncated sniff sample', () => {
        expect(looksLikeNotebook(notebook)).toBe(true);
        expect(looksLikeNotebook(notebook.slice(0, 70))).toBe(true);
        expect(sniffTextViewer(notebook)).toBe('notebook');
        expect(detectViewer('analysis', undefined, undefined, undefined, notebook)).toEqual({ viewerId: 'notebook', matchedBy: 'content' });
    });
    it('does not claim ordinary JSON, nested lookalikes, wrong versions, or override a known extension', () => {
        for (const sample of ['{"cells":[]}', '{"nbformat":4}', '{"nbformat":3,"cells":[]}', '{"data":{"nbformat":4,"cells":[]}}'])
            expect(looksLikeNotebook(sample)).toBe(false);
        expect(sniffTextViewer('{"cells":[],"value":4}')).toBe('json');
        expect(detectViewer('analysis.json', undefined, undefined, undefined, notebook).viewerId).toBe('json');
    });
});
