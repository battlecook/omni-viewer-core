export const PDF_ZOOM_LEVELS = [50, 75, 100, 125, 150, 200, 300] as const;
export type PdfZoom = number;

export interface PdfTextAnnotation {
    id: string;
    kind: 'text';
    page: number;
    x: number;
    y: number;
    text: string;
    size: number;
    color: string;
    /** Portable raster used when flattening text into an external PDF. */
    rasterDataUrl?: string;
    rasterWidth?: number;
    rasterHeight?: number;
}

export interface PdfSignatureAnnotation {
    id: string;
    kind: 'signature';
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    dataUrl: string;
}

/** One rectangle of a highlight, in unscaled page coordinates. */
export interface PdfHighlightRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * PDF.js commonly returns one client rect per text span, even for a single
 * continuous selection. Join neighbouring spans on the same text line so
 * the highlight is rendered as one uninterrupted range (including spaces).
 */
export function mergeHighlightRects(rects: readonly PdfHighlightRect[]): PdfHighlightRect[] {
    const rows: PdfHighlightRect[][] = [];
    for (const rect of [...rects].sort((a, b) => a.y - b.y || a.x - b.x)) {
        const center = rect.y + rect.height / 2;
        const row = rows.at(-1);
        if (!row) {
            rows.push([rect]);
            continue;
        }
        const rowCenter = row.reduce((sum, item) => sum + item.y + item.height / 2, 0) / row.length;
        const rowHeight = Math.max(...row.map((item) => item.height));
        if (Math.abs(center - rowCenter) <= Math.max(2, Math.min(rect.height, rowHeight) / 2)) {
            row.push(rect);
            continue;
        }
        rows.push([rect]);
    }

    return rows.flatMap((row) => {
        const merged: PdfHighlightRect[] = [];
        for (const rect of row.sort((a, b) => a.x - b.x)) {
            const previous = merged.at(-1);
            const gap = Math.max(4, Math.min(16, rect.height * 0.9));
            if (previous && rect.x <= previous.x + previous.width + gap) {
                const right = Math.max(previous.x + previous.width, rect.x + rect.width);
                const bottom = Math.max(previous.y + previous.height, rect.y + rect.height);
                previous.x = Math.min(previous.x, rect.x);
                previous.y = Math.min(previous.y, rect.y);
                previous.width = right - previous.x;
                previous.height = bottom - previous.y;
            } else {
                merged.push({ ...rect });
            }
        }
        return merged;
    });
}

export interface PdfHighlightAnnotation {
    id: string;
    kind: 'highlight';
    page: number;
    /** A text selection can span several lines -> several rects. */
    rects: PdfHighlightRect[];
    color: string;
}

/** A text selection rendered as a horizontal strike through each line. */
export interface PdfStrikeoutAnnotation {
    id: string;
    kind: 'strikeout';
    page: number;
    rects: PdfHighlightRect[];
    color: string;
}

/** A text selection rendered as an underline beneath each line. */
export interface PdfUnderlineAnnotation {
    id: string;
    kind: 'underline';
    page: number;
    rects: PdfHighlightRect[];
    color: string;
}

export type PdfAnnotation =
    | PdfTextAnnotation
    | PdfSignatureAnnotation
    | PdfHighlightAnnotation
    | PdfStrikeoutAnnotation
    | PdfUnderlineAnnotation;
export type PdfAnnotationInput =
    | Omit<PdfTextAnnotation, 'id'>
    | Omit<PdfSignatureAnnotation, 'id'>
    | Omit<PdfHighlightAnnotation, 'id'>
    | Omit<PdfStrikeoutAnnotation, 'id'>
    | Omit<PdfUnderlineAnnotation, 'id'>;

export interface PdfViewState {
    zoom: PdfZoom;
    pageOrder: readonly number[];
    annotations: readonly PdfAnnotation[];
    selectedAnnotationId: string | null;
    dirty: boolean;
}

export type PdfAction =
    | { type: 'zoom-in' }
    | { type: 'zoom-out' }
    | { type: 'set-zoom'; zoom: number }
    | { type: 'reorder-pages'; from: number; to: number }
    | { type: 'delete-page'; page: number }
    | { type: 'reset-pages' }
    | { type: 'add-annotation'; annotation: PdfAnnotationInput }
    | { type: 'move-annotation'; id: string; x: number; y: number }
    | { type: 'remove-annotation'; id: string }
    | { type: 'select-annotation'; id: string | null }
    | { type: 'undo' }
    | { type: 'redo' }
    | { type: 'mark-saved' };

export interface PdfController {
    readonly state: PdfViewState;
    dispatch(action: PdfAction): void;
    subscribe(listener: (state: PdfViewState) => void): () => void;
}

function nearestZoom(value: number): PdfZoom {
    return PDF_ZOOM_LEVELS.reduce((best, candidate) =>
        Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best
    ) as PdfZoom;
}

/** Persisted layer used to restore an editing session (sidecar rehydration). */
export interface PdfControllerSeed {
    pageOrder?: readonly number[];
    annotations?: readonly PdfAnnotation[];
}

/** Highest `pdf-a<n>` suffix among seeded ids, so new ids never collide. */
function maxSequence(annotations: readonly PdfAnnotation[]): number {
    let max = 0;
    for (const annotation of annotations) {
        const n = /^pdf-a(\d+)$/.exec(annotation.id)?.[1];
        if (n) max = Math.max(max, Number(n));
    }
    return max;
}

interface PdfEditSnapshot {
    pageOrder: number[];
    annotations: PdfAnnotation[];
    selectedAnnotationId: string | null;
}

function copyAnnotations(annotations: readonly PdfAnnotation[]): PdfAnnotation[] {
    return annotations.map((annotation) => annotation.kind === 'highlight' || annotation.kind === 'strikeout' || annotation.kind === 'underline'
        ? { ...annotation, rects: annotation.rects.map((rect) => ({ ...rect })) }
        : { ...annotation });
}

export function createPdfController(pageCount: number, seed?: PdfControllerSeed): PdfController {
    const original = Array.from({ length: Math.max(0, Math.floor(pageCount)) }, (_, i) => i + 1);
    const listeners = new Set<(state: PdfViewState) => void>();
    let zoom: PdfZoom = 100;
    // A seeded order may only reference pages that still exist; an empty result
    // falls back to the natural order so the document is never left blank.
    const seededOrder = seed?.pageOrder?.filter((page) => page >= 1 && page <= original.length) ?? [];
    let pageOrder = seededOrder.length > 0 ? seededOrder.slice() : original.slice();
    let annotations: PdfAnnotation[] = seed?.annotations
        ? seed.annotations.filter((a) => pageOrder.includes(a.page)).map((a) => ({ ...a }))
        : [];
    let selectedAnnotationId: string | null = null;
    let savedSignature = '';
    let sequence = maxSequence(annotations);
    const undoStack: PdfEditSnapshot[] = [];
    const redoStack: PdfEditSnapshot[] = [];

    const signature = () => JSON.stringify({ pageOrder, annotations });
    const snapshot = (): PdfEditSnapshot => ({
        pageOrder: pageOrder.slice(),
        annotations: copyAnnotations(annotations),
        selectedAnnotationId
    });
    const restore = (value: PdfEditSnapshot) => {
        pageOrder = value.pageOrder.slice();
        annotations = copyAnnotations(value.annotations);
        selectedAnnotationId = value.selectedAnnotationId;
    };
    const state = (): PdfViewState => ({
        zoom, pageOrder: pageOrder.slice(), annotations: copyAnnotations(annotations),
        selectedAnnotationId, dirty: signature() !== savedSignature
    });
    const emit = () => { const next = state(); for (const listener of listeners) listener(next); };
    savedSignature = signature();

    return {
        get state() { return state(); },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        dispatch(action) {
            if (action.type === 'undo') {
                const previous = undoStack.pop();
                if (!previous) return;
                redoStack.push(snapshot());
                restore(previous);
                emit();
                return;
            }
            if (action.type === 'redo') {
                const next = redoStack.pop();
                if (!next) return;
                undoStack.push(snapshot());
                restore(next);
                emit();
                return;
            }
            const tracksHistory = action.type === 'reorder-pages'
                || action.type === 'delete-page'
                || action.type === 'reset-pages'
                || action.type === 'add-annotation'
                || action.type === 'move-annotation'
                || action.type === 'remove-annotation';
            const before = tracksHistory ? snapshot() : undefined;
            const beforeSignature = tracksHistory ? signature() : undefined;
            switch (action.type) {
                case 'zoom-in': {
                    zoom = PDF_ZOOM_LEVELS.find((level) => level > zoom)
                        ?? PDF_ZOOM_LEVELS[PDF_ZOOM_LEVELS.length - 1]!;
                    break;
                }
                case 'zoom-out': {
                    zoom = [...PDF_ZOOM_LEVELS].reverse().find((level) => level < zoom)
                        ?? PDF_ZOOM_LEVELS[0]!;
                    break;
                }
                case 'set-zoom': {
                    if (!Number.isFinite(action.zoom)) return;
                    zoom = Math.max(25, Math.min(400, Math.round(action.zoom)));
                    break;
                }
                case 'reorder-pages': {
                    if (!Number.isInteger(action.from) || !Number.isInteger(action.to) || action.from < 0 || action.to < 0 || action.from >= pageOrder.length || action.to >= pageOrder.length) return;
                    const [page] = pageOrder.splice(action.from, 1);
                    if (page !== undefined) pageOrder.splice(action.to, 0, page);
                    break;
                }
                case 'delete-page':
                    if (pageOrder.length <= 1) return;
                    pageOrder = pageOrder.filter((page) => page !== action.page);
                    annotations = annotations.filter((annotation) => annotation.page !== action.page);
                    break;
                case 'reset-pages': pageOrder = original.slice(); annotations = []; selectedAnnotationId = null; break;
                case 'add-annotation': {
                    const annotation: PdfAnnotation = action.annotation.kind === 'text'
                        ? { ...action.annotation, id: `pdf-a${++sequence}` }
                        : { ...action.annotation, id: `pdf-a${++sequence}` };
                    annotations = [...annotations, annotation];
                    break;
                }
                case 'move-annotation': annotations = annotations.map((a) => a.id === action.id ? { ...a, x: action.x, y: action.y } : a); break;
                case 'remove-annotation': annotations = annotations.filter((a) => a.id !== action.id); if (selectedAnnotationId === action.id) selectedAnnotationId = null; break;
                case 'select-annotation': selectedAnnotationId = action.id; break;
                case 'mark-saved': savedSignature = signature(); break;
            }
            if (before && beforeSignature !== signature()) {
                undoStack.push(before);
                redoStack.length = 0;
            }
            emit();
        }
    };
}
