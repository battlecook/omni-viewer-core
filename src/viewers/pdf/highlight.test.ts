import { describe, expect, it } from 'vitest';
import * as pdfLib from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
    buildEditedPdf,
    buildSavedPdf,
    markupLineY,
    parseLayer,
    SIDECAR_LAYER_NAME
} from './editing.js';
import { createPdfController, mergeHighlightRects } from './controller.js';

async function samplePdf(pageCount: number): Promise<Uint8Array> {
    const doc = await pdfLib.PDFDocument.create();
    for (let i = 0; i < pageCount; i++) {
        doc.addPage([300, 400]).drawText(`p${i + 1}`, { x: 20, y: 350, size: 24 });
    }
    return doc.save();
}

const sampleHighlight = {
    kind: 'highlight' as const,
    page: 1,
    color: '#ffeb3b',
    rects: [
        { x: 20, y: 40, width: 120, height: 14 },
        { x: 20, y: 58, width: 80, height: 14 }
    ]
};

describe('highlight annotations', () => {
    it('joins text-span rectangles on the same line, including their spaces', () => {
        expect(mergeHighlightRects([
            { x: 20, y: 40, width: 24, height: 14 },
            { x: 48, y: 40, width: 18, height: 14 },
            { x: 70, y: 40, width: 30, height: 14 },
            { x: 20, y: 58, width: 80, height: 14 }
        ])).toEqual([
            { x: 20, y: 40, width: 80, height: 14 },
            { x: 20, y: 58, width: 80, height: 14 }
        ]);
    });

    it('controller adds and removes a highlight and tracks dirty', () => {
        const c = createPdfController(2);
        c.dispatch({ type: 'add-annotation', annotation: sampleHighlight });
        const added = c.state.annotations[0];
        expect(added?.kind).toBe('highlight');
        expect(c.state.dirty).toBe(true);

        c.dispatch({ type: 'remove-annotation', id: added!.id });
        expect(c.state.annotations).toHaveLength(0);
    });

    it('buildEditedPdf stamps a highlight without throwing (Multiply blend)', async () => {
        const source = await samplePdf(1);
        const c = createPdfController(1);
        c.dispatch({ type: 'add-annotation', annotation: sampleHighlight });
        const out = await buildEditedPdf(pdfLib, source, c.state);
        expect((await pdfLib.PDFDocument.load(out)).getPageCount()).toBe(1);
    });

    it.each(['strikeout', 'underline'] as const)('stamps and restores a %s selection', async (kind) => {
        const source = await samplePdf(1);
        const c = createPdfController(1);
        c.dispatch({ type: 'add-annotation', annotation: { ...sampleHighlight, kind } });
        const out = await buildEditedPdf(pdfLib, source, c.state);
        expect((await pdfLib.PDFDocument.load(out)).getPageCount()).toBe(1);

        const parsed = parseLayer(JSON.stringify({
            version: 2,
            pageOrder: [1],
            annotations: [{ id: 'pdf-a1', ...sampleHighlight, kind }]
        }));
        expect(parsed?.annotations[0]?.kind).toBe(kind);
    });

    it('places an underline near the box bottom and a strikeout at the middle', () => {
        const rect = { y: 100, height: 20 };
        const pageHeight = 400;
        const boxTop = pageHeight - rect.y;        // 300 in PDF (bottom-left) space
        const boxBottom = pageHeight - rect.y - rect.height; // 280
        const underline = markupLineY('underline', rect, pageHeight);
        const strikeout = markupLineY('strikeout', rect, pageHeight);
        // Underline hugs the bottom edge, not the top (the previous bug drew it
        // near the top, at height - y - height*0.1 = 298).
        expect(underline).toBeCloseTo(282);
        expect(underline).toBeGreaterThan(boxBottom);
        expect(underline).toBeLessThan(boxTop - rect.height * 0.5);
        // Strikeout runs through the vertical middle, above the underline.
        expect(strikeout).toBeCloseTo(290);
        expect(underline).toBeLessThan(strikeout);
    });

    it('parseLayer keeps valid highlights and drops malformed rects', () => {
        const layer = JSON.stringify({
            version: 2,
            pageOrder: [1],
            annotations: [
                { id: 'pdf-a1', kind: 'highlight', page: 1, color: '#ffeb3b', rects: [{ x: 1, y: 2, width: 3, height: 4 }, { x: 'bad', y: 2, width: 3, height: 4 }] }
            ]
        });
        const parsed = parseLayer(layer);
        const hl = parsed?.annotations[0];
        expect(hl?.kind).toBe('highlight');
        expect(hl && hl.kind === 'highlight' && hl.rects).toHaveLength(1);
    });

    it('drops a highlight with no usable rects', () => {
        const layer = JSON.stringify({
            version: 2,
            pageOrder: [1],
            annotations: [{ id: 'pdf-a1', kind: 'highlight', page: 1, color: '#fff', rects: [] }]
        });
        expect(parseLayer(layer)?.annotations).toEqual([]);
    });

    it('round-trips a highlight through the embedded sidecar', async () => {
        const pristine = await samplePdf(1);
        const c = createPdfController(1);
        c.dispatch({ type: 'add-annotation', annotation: sampleHighlight });

        const saved = await buildSavedPdf(pdfLib, pristine, c.state);
        const pdf = await getDocument({ data: saved.slice() }).promise;
        const attachments = (await pdf.getAttachments()) as Record<
            string,
            { filename: string; content: Uint8Array }
        >;
        const layerBytes = Object.values(attachments).find(
            (a) => a.filename === SIDECAR_LAYER_NAME
        )!.content;

        const layer = parseLayer(new TextDecoder().decode(layerBytes));
        const hl = layer?.annotations[0];
        expect(hl?.kind).toBe('highlight');
        expect(hl && hl.kind === 'highlight' && hl.rects).toHaveLength(2);
    });
});
