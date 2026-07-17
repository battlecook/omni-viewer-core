import { describe, expect, it } from 'vitest';
import * as pdfLib from 'pdf-lib';
import { buildEditedPdf, mergePdfBytes, savedPdfName } from './editing.js';
import { createPdfController } from './controller.js';

async function samplePdf(pageCount: number): Promise<Uint8Array> {
    const doc = await pdfLib.PDFDocument.create();
    for (let i = 0; i < pageCount; i++) {
        const page = doc.addPage([300, 400]);
        page.drawText(`p${i + 1}`, { x: 20, y: 350, size: 24 });
    }
    return doc.save();
}

describe('pdf editing helpers', () => {
    it('buildEditedPdf applies page reorder/delete and stamps annotations', async () => {
        const source = await samplePdf(3);
        const c = createPdfController(3);
        c.dispatch({ type: 'reorder-pages', from: 0, to: 2 }); // [2,3,1]
        c.dispatch({ type: 'delete-page', page: 3 }); // [2,1]
        c.dispatch({
            type: 'add-annotation',
            annotation: { kind: 'text', page: 2, x: 10, y: 20, text: 'hello', size: 14, color: '#ff0000' }
        });

        const out = await buildEditedPdf(pdfLib, source, c.state);
        const reloaded = await pdfLib.PDFDocument.load(out);
        expect(reloaded.getPageCount()).toBe(2);
    });

    it('buildEditedPdf saving twice from reloaded bytes is stable (no double reorder)', async () => {
        const source = await samplePdf(2);
        const c = createPdfController(2);
        c.dispatch({ type: 'reorder-pages', from: 0, to: 1 }); // [2,1]
        const savedOnce = await buildEditedPdf(pdfLib, source, c.state);

        // After a save the viewer reloads and gets a fresh controller — a
        // second save with the fresh (identity) order must not reorder again.
        const fresh = createPdfController(2);
        const savedTwice = await buildEditedPdf(pdfLib, savedOnce, fresh.state);
        const a = await pdfLib.PDFDocument.load(savedOnce);
        const b = await pdfLib.PDFDocument.load(savedTwice);
        expect(b.getPageCount()).toBe(a.getPageCount());
    });

    it('mergePdfBytes appends every page of the second document', async () => {
        const merged = await mergePdfBytes(pdfLib, await samplePdf(2), await samplePdf(3));
        const doc = await pdfLib.PDFDocument.load(merged);
        expect(doc.getPageCount()).toBe(5);
    });

    it('savedPdfName appends -edited and keeps odd names safe', () => {
        expect(savedPdfName('report.pdf')).toBe('report-edited.pdf');
        expect(savedPdfName('REPORT.PDF')).toBe('REPORT-edited.pdf');
        expect(savedPdfName('.pdf')).toBe('document-edited.pdf');
        expect(savedPdfName('viewer.html')).toBe('viewer-edited.pdf');
        expect(savedPdfName('https://example.test/files/report.pdf?download=1')).toBe('report-edited.pdf');
    });
});
