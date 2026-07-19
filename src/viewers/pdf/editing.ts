// PDF editing helpers built on pdf-lib.
//
// pdf-lib is an optional peer dependency: this module never imports it at
// runtime (ADR 14 — the base viewer entry must stay free of external
// imports). Callers inject the loaded module; `viewers/pdf/self-loading`
// provides the dynamic-import loader for platforms whose bundler resolves it.

import { mergeHighlightRects, type PdfAnnotation, type PdfHighlightRect, type PdfViewState } from './controller.js';

/** Type-only reference — erased at compile time. */
export type PdfLibModule = typeof import('pdf-lib');

// Hybrid sidecar: saved PDFs keep flattened (portable) pages for external
// readers while embedding a re-editable base + a layer JSON, so the omni
// viewer can restore a removable overlay layer on reopen. The embedded base
// holds only the kept pages (deleted pages are gone for good) with signatures
// permanently flattened in; text/markup stay out so they remain editable.
// External readers only ever see the flat pages.
export const SIDECAR_LAYER_NAME = 'omni-viewer-layer.json';
export const SIDECAR_BASE_NAME = 'omni-viewer-base.pdf';
/** Bumped when the sidecar shape changes; older/newer versions are ignored. */
const SIDECAR_VERSION = 2;
/** Defensive ceilings — the sidecar is untrusted input on reopen. */
const MAX_ANNOTATIONS = 2000;
const MAX_TEXT_LENGTH = 10_000;
const MAX_DATAURL_LENGTH = 4_000_000;
const MAX_HIGHLIGHT_RECTS = 500;

/** Result of parsing a sidecar's layer JSON. */
export interface ParsedLayer {
    pageOrder: number[];
    annotations: PdfAnnotation[];
}

type PdfLibPage = ReturnType<
    Awaited<ReturnType<PdfLibModule['PDFDocument']['load']>>['getPages']
>[number];

function parseColor(pdfLib: PdfLibModule, value: string) {
    const hex = /^#?([0-9a-f]{6})$/i.exec(value)?.[1] ?? '000000';
    return pdfLib.rgb(
        parseInt(hex.slice(0, 2), 16) / 255,
        parseInt(hex.slice(2, 4), 16) / 255,
        parseInt(hex.slice(4, 6), 16) / 255
    );
}

function pngBytes(dataUrl: string): Uint8Array | undefined {
    const encoded = /^data:image\/png;base64,(.*)$/i.exec(dataUrl)?.[1];
    if (!encoded) return undefined;
    const binary = atob(encoded);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function stamp(
    pdfLib: PdfLibModule,
    page: PdfLibPage,
    annotation: PdfAnnotation
): Promise<void> {
    const { height } = page.getSize();
    if (annotation.kind === 'text') {
        if (annotation.rasterDataUrl && annotation.rasterWidth && annotation.rasterHeight) {
            const bytes = pngBytes(annotation.rasterDataUrl);
            if (bytes) {
                const image = await page.doc.embedPng(bytes);
                page.drawImage(image, {
                    x: annotation.x,
                    y: height - annotation.y - annotation.rasterHeight,
                    width: annotation.rasterWidth,
                    height: annotation.rasterHeight
                });
                return;
            }
        }
        const font = await page.doc.embedFont(pdfLib.StandardFonts.Helvetica);
        page.drawText(annotation.text, {
            x: annotation.x,
            y: height - annotation.y - annotation.size,
            size: annotation.size,
            font,
            color: parseColor(pdfLib, annotation.color)
        });
        return;
    }
    if (annotation.kind === 'highlight') {
        const color = parseColor(pdfLib, annotation.color);
        for (const rect of mergeHighlightRects(annotation.rects)) {
            page.drawRectangle({
                x: rect.x,
                y: height - rect.y - rect.height,
                width: rect.width,
                height: rect.height,
                color,
                // Multiply keeps the underlying text legible through the tint.
                blendMode: pdfLib.BlendMode.Multiply
            });
        }
        return;
    }
    if (annotation.kind === 'strikeout') {
        const color = parseColor(pdfLib, annotation.color);
        for (const rect of mergeHighlightRects(annotation.rects)) {
            page.drawLine({
                start: { x: rect.x, y: height - rect.y - rect.height / 2 },
                end: { x: rect.x + rect.width, y: height - rect.y - rect.height / 2 },
                thickness: Math.max(1, rect.height * 0.08),
                color
            });
        }
        return;
    }
    if (annotation.kind === 'underline') {
        const color = parseColor(pdfLib, annotation.color);
        for (const rect of mergeHighlightRects(annotation.rects)) {
            page.drawLine({
                start: { x: rect.x, y: height - rect.y - rect.height * 0.1 },
                end: { x: rect.x + rect.width, y: height - rect.y - rect.height * 0.1 },
                thickness: Math.max(1, rect.height * 0.08),
                color
            });
        }
        return;
    }
    const bytes = pngBytes(annotation.dataUrl);
    if (!bytes) return;
    const image = await page.doc.embedPng(bytes);
    page.drawImage(image, {
        x: annotation.x,
        y: height - annotation.y - annotation.height,
        width: annotation.width,
        height: annotation.height
    });
}

type PdfLibDocument = Awaited<ReturnType<PdfLibModule['PDFDocument']['create']>>;

/** Copy the kept pages (in display order) from `source` into a fresh doc. */
async function copyKeptPages(
    pdfLib: PdfLibModule,
    source: Uint8Array,
    pageOrder: readonly number[]
): Promise<PdfLibDocument> {
    const original = await pdfLib.PDFDocument.load(source);
    const output = await pdfLib.PDFDocument.create();
    const indices = pageOrder
        .map((page) => page - 1)
        .filter((page) => page >= 0 && page < original.getPageCount());
    const copied = await output.copyPages(original, indices);
    copied.forEach((page) => output.addPage(page));
    return output;
}

/** Reorder/delete pages and stamp the overlays into a fresh (unsaved) doc. */
async function flattenInto(
    pdfLib: PdfLibModule,
    source: Uint8Array,
    state: PdfViewState
): Promise<PdfLibDocument> {
    const output = await copyKeptPages(pdfLib, source, state.pageOrder);
    for (const annotation of state.annotations) {
        const outputIndex = state.pageOrder.indexOf(annotation.page);
        const page = output.getPages()[outputIndex];
        if (page) await stamp(pdfLib, page, annotation);
    }
    return output;
}

/**
 * The re-editable base embedded in a saved PDF: the kept pages (unflattened)
 * with ONLY signatures permanently stamped in. Text/markup are deliberately
 * left out so the omni viewer can restore them as a removable layer, while
 * signatures — and any pages the user deleted — cannot be recovered.
 */
async function buildEditableBase(
    pdfLib: PdfLibModule,
    pristine: Uint8Array,
    state: PdfViewState
): Promise<PdfLibDocument> {
    const output = await copyKeptPages(pdfLib, pristine, state.pageOrder);
    for (const annotation of state.annotations) {
        if (annotation.kind !== 'signature') continue;
        const outputIndex = state.pageOrder.indexOf(annotation.page);
        const page = output.getPages()[outputIndex];
        if (page) await stamp(pdfLib, page, annotation);
    }
    return output;
}

/** Persist reordered/deleted pages plus the text/signature overlays,
 *  flattened into the page content (portable, non-editable output). */
export async function buildEditedPdf(
    pdfLib: PdfLibModule,
    source: Uint8Array,
    state: PdfViewState
): Promise<Uint8Array> {
    const output = await flattenInto(pdfLib, source, state);
    return output.save();
}

/**
 * Like {@link buildEditedPdf}, but also embeds the hybrid sidecar so the
 * omni viewer can rehydrate a removable overlay layer on reopen:
 *   - a re-editable base (kept pages only, signatures flattened in), and
 *   - the layer JSON `{ version, pageOrder, annotations }` for text/markup,
 *     with page references remapped onto the kept-pages base.
 * Deleted pages and signatures are unrecoverable; external readers only ever
 * see the flattened pages.
 */
export async function buildSavedPdf(
    pdfLib: PdfLibModule,
    pristine: Uint8Array,
    state: PdfViewState
): Promise<Uint8Array> {
    const output = await flattenInto(pdfLib, pristine, state);
    const base = await buildEditableBase(pdfLib, pristine, state);
    // The base is already in display order, so its pages number 1..keptCount.
    // Remap each overlay's page reference (an original page number) onto that.
    const remap = new Map(state.pageOrder.map((page, index) => [page, index + 1]));
    const layer = JSON.stringify({
        version: SIDECAR_VERSION,
        pageOrder: base.getPages().map((_, index) => index + 1),
        annotations: state.annotations
            .filter((annotation) => annotation.kind !== 'signature')
            .map((annotation) => ({ ...annotation, page: remap.get(annotation.page) ?? annotation.page }))
    });
    await output.attach(new TextEncoder().encode(layer), SIDECAR_LAYER_NAME, {
        mimeType: 'application/json'
    });
    await output.attach(await base.save(), SIDECAR_BASE_NAME, {
        mimeType: 'application/pdf'
    });
    return output.save();
}

function toAnnotation(raw: unknown): PdfAnnotation | null {
    if (!raw || typeof raw !== 'object') return null;
    const a = raw as Record<string, unknown>;
    const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    if (typeof a.id !== 'string' || !Number.isInteger(a.page) || (a.page as number) < 1) return null;
    if (a.kind === 'text') {
        if (!num(a.x) || !num(a.y)) return null;
        if (typeof a.text !== 'string' || a.text.length > MAX_TEXT_LENGTH) return null;
        if (!num(a.size) || typeof a.color !== 'string') return null;
        return {
            id: a.id, kind: 'text', page: a.page as number,
            x: a.x, y: a.y, text: a.text, size: a.size, color: a.color,
            ...(typeof a.rasterDataUrl === 'string'
                && /^data:image\/png;base64,/i.test(a.rasterDataUrl)
                && num(a.rasterWidth) && num(a.rasterHeight)
                ? {
                    rasterDataUrl: a.rasterDataUrl,
                    rasterWidth: a.rasterWidth,
                    rasterHeight: a.rasterHeight
                }
                : {})
        };
    }
    if (a.kind === 'signature') {
        if (!num(a.x) || !num(a.y)) return null;
        if (typeof a.dataUrl !== 'string' || a.dataUrl.length > MAX_DATAURL_LENGTH) return null;
        if (!/^data:image\/png;base64,/i.test(a.dataUrl)) return null;
        if (!num(a.width) || !num(a.height)) return null;
        return {
            id: a.id, kind: 'signature', page: a.page as number,
            x: a.x, y: a.y, width: a.width, height: a.height, dataUrl: a.dataUrl
        };
    }
    if (a.kind === 'highlight' || a.kind === 'strikeout' || a.kind === 'underline') {
        if (typeof a.color !== 'string' || !Array.isArray(a.rects)) return null;
        const rects: PdfHighlightRect[] = [];
        for (const r of a.rects.slice(0, MAX_HIGHLIGHT_RECTS)) {
            if (!r || typeof r !== 'object') continue;
            const rr = r as Record<string, unknown>;
            if (num(rr.x) && num(rr.y) && num(rr.width) && num(rr.height)) {
                rects.push({ x: rr.x, y: rr.y, width: rr.width, height: rr.height });
            }
        }
        if (rects.length === 0) return null;
        return { id: a.id, kind: a.kind, page: a.page as number, rects, color: a.color };
    }
    return null;
}

/** Parse and validate a sidecar layer JSON string; null if unusable. */
export function parseLayer(text: string): ParsedLayer | null {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (obj.version !== SIDECAR_VERSION) return null;
    const pageOrder = Array.isArray(obj.pageOrder)
        ? obj.pageOrder.filter((n): n is number => Number.isInteger(n) && n > 0)
        : [];
    const annotationsRaw = Array.isArray(obj.annotations)
        ? obj.annotations.slice(0, MAX_ANNOTATIONS)
        : [];
    const annotations: PdfAnnotation[] = [];
    for (const entry of annotationsRaw) {
        const parsed = toAnnotation(entry);
        if (parsed) annotations.push(parsed);
    }
    if (pageOrder.length === 0 && annotations.length === 0) return null;
    return { pageOrder, annotations };
}

/** Append every page of `second` after `first`. */
export async function mergePdfBytes(
    pdfLib: PdfLibModule,
    first: Uint8Array,
    second: Uint8Array
): Promise<Uint8Array> {
    const [left, right] = await Promise.all([
        pdfLib.PDFDocument.load(first),
        pdfLib.PDFDocument.load(second)
    ]);
    const output = await pdfLib.PDFDocument.create();
    for (const source of [left, right]) {
        // pdf-lib's addPage takes a single page — spreading silently drops
        // all but the first one.
        for (const page of await output.copyPages(source, source.getPageIndices())) {
            output.addPage(page);
        }
    }
    return output.save();
}

export function savedPdfName(name: string): string {
    // The host can supply a page/URL-like name (for example `viewer.html`
    // or `report.pdf?token=...`). Keep only the final path component and
    // replace its extension, so Save As is always a real `.pdf` download.
    const leaf = name.trim().split(/[\\/]/).pop()?.split(/[?#]/, 1)[0] ?? '';
    const stem = leaf.replace(/\.[^.]*$/, '') || 'document';
    return `${stem}-edited.pdf`;
}
