import { describe, expect, it } from 'vitest';
import * as pdfLib from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
    buildSavedPdf,
    parseLayer,
    SIDECAR_LAYER_NAME,
    SIDECAR_ORIGINAL_NAME
} from './editing.js';
import { createPdfController, type PdfAnnotation } from './controller.js';

async function samplePdf(pageCount: number): Promise<Uint8Array> {
    const doc = await pdfLib.PDFDocument.create();
    for (let i = 0; i < pageCount; i++) {
        doc.addPage([300, 400]).drawText(`p${i + 1}`, { x: 20, y: 350, size: 24 });
    }
    return doc.save();
}

/** Read a saved PDF's attachments through the real pdf.js path. */
async function readAttachments(
    bytes: Uint8Array
): Promise<Record<string, { filename: string; content: Uint8Array }>> {
    const pdf = await getDocument({ data: bytes.slice() }).promise;
    return (await pdf.getAttachments()) as Record<
        string,
        { filename: string; content: Uint8Array }
    >;
}

describe('parseLayer', () => {
    it('accepts a valid layer and keeps well-formed annotations', () => {
        const layer = JSON.stringify({
            version: 1,
            pageOrder: [2, 1],
            annotations: [
                { id: 'pdf-a1', kind: 'text', page: 1, x: 5, y: 6, text: 'hi', size: 12, color: '#000000' },
                { id: 'pdf-a2', kind: 'signature', page: 2, x: 1, y: 2, width: 10, height: 4, dataUrl: 'data:image/png;base64,AAAA' }
            ]
        });
        const parsed = parseLayer(layer);
        expect(parsed?.pageOrder).toEqual([2, 1]);
        expect(parsed?.annotations).toHaveLength(2);
    });

    it('rejects an unknown version and invalid JSON', () => {
        expect(parseLayer(JSON.stringify({ version: 2, annotations: [] }))).toBeNull();
        expect(parseLayer('{not json')).toBeNull();
    });

    it('drops malformed annotations and non-png signatures', () => {
        const layer = JSON.stringify({
            version: 1,
            pageOrder: [1],
            annotations: [
                { id: 'pdf-a1', kind: 'text', page: 1, x: 5, y: 6, text: 'ok', size: 12, color: '#000' },
                { id: 'pdf-a2', kind: 'text', page: 1, x: 'nan', y: 6, text: 'bad-x', size: 12, color: '#000' },
                { id: 'pdf-a3', kind: 'signature', page: 1, x: 1, y: 2, width: 10, height: 4, dataUrl: 'data:image/jpeg;base64,AAAA' }
            ]
        });
        const parsed = parseLayer(layer);
        expect(parsed?.annotations.map((a) => a.id)).toEqual(['pdf-a1']);
    });

    it('returns null when there is nothing to restore', () => {
        expect(parseLayer(JSON.stringify({ version: 1, pageOrder: [], annotations: [] }))).toBeNull();
    });
});

describe('createPdfController seeding', () => {
    const seedAnnotations: PdfAnnotation[] = [
        { id: 'pdf-a3', kind: 'text', page: 1, x: 5, y: 6, text: 'seeded', size: 12, color: '#000000' }
    ];

    it('restores a saved layer with a clean (not dirty) baseline', () => {
        const c = createPdfController(2, { pageOrder: [2, 1], annotations: seedAnnotations });
        expect(c.state.pageOrder).toEqual([2, 1]);
        expect(c.state.annotations).toHaveLength(1);
        expect(c.state.dirty).toBe(false);
    });

    it('removing a rehydrated annotation makes the session dirty', () => {
        const c = createPdfController(2, { pageOrder: [2, 1], annotations: seedAnnotations });
        c.dispatch({ type: 'remove-annotation', id: 'pdf-a3' });
        expect(c.state.annotations).toHaveLength(0);
        expect(c.state.dirty).toBe(true);
    });

    it('continues the id sequence past seeded ids', () => {
        const c = createPdfController(1, { annotations: seedAnnotations });
        c.dispatch({ type: 'add-annotation', annotation: { kind: 'text', page: 1, x: 0, y: 0, text: 'new', size: 12, color: '#000' } });
        const ids = c.state.annotations.map((a) => a.id);
        expect(new Set(ids).size).toBe(ids.length); // no id collision
    });

    it('drops seeded annotations that reference removed pages', () => {
        const c = createPdfController(2, {
            pageOrder: [1],
            annotations: [{ id: 'pdf-a1', kind: 'text', page: 2, x: 0, y: 0, text: 'gone', size: 12, color: '#000' }]
        });
        expect(c.state.annotations).toHaveLength(0);
    });
});

describe('hybrid sidecar round-trip', () => {
    it('embeds pristine source + layer JSON that reads back through pdf.js', async () => {
        const pristine = await samplePdf(3);
        const c = createPdfController(3);
        c.dispatch({ type: 'reorder-pages', from: 0, to: 2 }); // [2,3,1]
        c.dispatch({ type: 'delete-page', page: 3 }); // [2,1]
        c.dispatch({
            type: 'add-annotation',
            annotation: { kind: 'text', page: 1, x: 10, y: 20, text: 'hi', size: 14, color: '#ff0000' }
        });

        const saved = await buildSavedPdf(pdfLib, pristine, c.state);

        // Visible pages are flattened to the reordered/deleted set.
        expect((await pdfLib.PDFDocument.load(saved)).getPageCount()).toBe(2);

        const attachments = await readAttachments(saved);
        const byName = Object.fromEntries(
            Object.values(attachments).map((a) => [a.filename, a.content])
        );
        expect(Object.keys(byName).sort()).toEqual(
            [SIDECAR_LAYER_NAME, SIDECAR_ORIGINAL_NAME].sort()
        );

        // Pristine attachment is the untouched original.
        expect(byName[SIDECAR_ORIGINAL_NAME]).toEqual(pristine);

        // Layer JSON parses back to the live edit state.
        const layer = parseLayer(new TextDecoder().decode(byName[SIDECAR_LAYER_NAME]));
        expect(layer?.pageOrder).toEqual([2, 1]);
        expect(layer?.annotations).toHaveLength(1);
    });

    it('saving the rehydrated state twice does not double-bake pages', async () => {
        const pristine = await samplePdf(2);
        const first = createPdfController(2);
        first.dispatch({ type: 'reorder-pages', from: 0, to: 1 }); // [2,1]
        const savedOnce = await buildSavedPdf(pdfLib, pristine, first.state);

        // Reopen: rehydrate from pristine + parsed layer, then save again.
        const attachments = await readAttachments(savedOnce);
        const byName = Object.fromEntries(
            Object.values(attachments).map((a) => [a.filename, a.content])
        );
        const layer = parseLayer(new TextDecoder().decode(byName[SIDECAR_LAYER_NAME]!));
        const reopened = createPdfController(2, layer ?? undefined);
        const savedTwice = await buildSavedPdf(pdfLib, byName[SIDECAR_ORIGINAL_NAME]!, reopened.state);

        expect((await pdfLib.PDFDocument.load(savedTwice)).getPageCount()).toBe(2);
        expect(reopened.state.pageOrder).toEqual([2, 1]);
    });
});
