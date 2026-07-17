// ImageController — the behavior-controller layer for the image viewer
// (DESIGN.md §3-②, docs/viewers/image.md §2 편집 모델). Pure state machine:
// no DOM, no host services, no ImageBitmap. The DOM renderer (mount.ts) and a
// future web (Vue) host consume the same controller so interaction semantics
// and the conformance kit's "action sequence → normalized state" stay shared.
//
// Coordinates: every annotation is stored in *source pixel* coordinates. View
// transform (zoom/fit) is display-only and never mutates annotation geometry;
// rotation/flip/filter are edits that the exporter composes into the output
// (image.md §2, §5 export 기준선).

import type { Diagnostic, ParseFailure } from '../../parsers/types.js';

/** Zoom range and step (image.md §3): 10 %–500 %, 25 % increments. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5;
export const ZOOM_STEP = 0.25;

/** Undo history depth cap (image.md §4 maxUndoEntries). */
export const MAX_UNDO_ENTRIES = 100;

export type Rotation = 0 | 90 | 180 | 270;

export type AnnotationTool =
    | 'select'
    | 'brush'
    | 'eraser'
    | 'line'
    | 'rectangle'
    | 'circle'
    | 'text';

export interface Point {
    x: number;
    y: number;
}

export interface AnnotationStyle {
    color: string;
    fillOpacity: number;
    borderOpacity: number;
    fontSize: number;
    brushSize: number;
}

export const DEFAULT_STYLE: AnnotationStyle = {
    color: '#e23b3b',
    fillOpacity: 0,
    borderOpacity: 1,
    fontSize: 16,
    brushSize: 4
};

/** Annotation geometry, all in source pixel coordinates. */
export type Annotation =
    | { id: string; type: 'rectangle'; x: number; y: number; w: number; h: number; style: AnnotationStyle }
    | { id: string; type: 'circle'; x: number; y: number; w: number; h: number; style: AnnotationStyle }
    | { id: string; type: 'line'; x1: number; y1: number; x2: number; y2: number; style: AnnotationStyle }
    | { id: string; type: 'text'; x: number; y: number; text: string; style: AnnotationStyle }
    | { id: string; type: 'stroke'; points: Point[]; erase: boolean; style: AnnotationStyle };

export interface FilterState {
    /** Percent values (image.md §3). brightness/contrast/saturation 0–200, grayscale 0–100. */
    brightness: number;
    contrast: number;
    saturation: number;
    grayscale: number;
}

export const NEUTRAL_FILTER: FilterState = {
    brightness: 100,
    contrast: 100,
    saturation: 100,
    grayscale: 0
};

export type FilterPreset = 'original' | 'bright' | 'dark' | 'vintage' | 'bw';

/**
 * Preset filter values. NOTE (image.md §3, I-preset): the exact numbers must be
 * pinned to the existing VS Code / Obsidian fixtures during migration — these
 * are the working defaults until those goldens land.
 */
export const FILTER_PRESETS: Record<FilterPreset, FilterState> = {
    original: { brightness: 100, contrast: 100, saturation: 100, grayscale: 0 },
    bright: { brightness: 120, contrast: 105, saturation: 105, grayscale: 0 },
    dark: { brightness: 80, contrast: 110, saturation: 100, grayscale: 0 },
    vintage: { brightness: 110, contrast: 90, saturation: 80, grayscale: 20 },
    bw: { brightness: 100, contrast: 100, saturation: 0, grayscale: 100 }
};

export type GridMode = 'cell-size' | 'rows-cols';

export interface GridState {
    visible: boolean;
    /** Preserves both VS Code/Obsidian (source-pixel cell) and Web (rows×cols)
     *  meanings without lossy conversion on platform switch (image.md I3). */
    mode: GridMode;
    cellWidth: number;
    cellHeight: number;
    rows: number;
    cols: number;
}

export const DEFAULT_GRID: GridState = {
    visible: false,
    mode: 'cell-size',
    cellWidth: 32,
    cellHeight: 32,
    rows: 4,
    cols: 4
};

/** Image metadata surfaced after decode (mount fills this via `setDocument`). */
export interface ImageMeta {
    mime: string;
    width: number;
    height: number;
    byteLength: number;
    animated: boolean;
}

/** The undoable slice of state (image.md §2: reset returns all of these to
 *  initial; zoom/fit are display-only and excluded). */
interface EditSnapshot {
    rotation: Rotation;
    flipH: boolean;
    flipV: boolean;
    filter: FilterState;
    preset: FilterPreset | null;
    grid: GridState;
    annotations: Annotation[];
}

export interface ImageViewState {
    status: 'ok' | 'partial' | 'failed';
    failure: ParseFailure | null;
    diagnostics: Diagnostic[];
    meta: ImageMeta | null;
    /** Editing/PNG export disabled (canvas limit exceeded → partial, image.md §4). */
    editingEnabled: boolean;

    // View (display-only, not exported, not undoable)
    zoom: number;
    fitMode: boolean;

    // Edit slice (exported + undoable)
    rotation: Rotation;
    flipH: boolean;
    flipV: boolean;
    filter: FilterState;
    preset: FilterPreset | null;
    grid: GridState;
    annotations: Annotation[];

    // Interaction
    tool: AnnotationTool;
    selectedId: string | null;
    style: AnnotationStyle;

    dirty: boolean;
    canUndo: boolean;
}

export type ImageAction =
    | { type: 'set-zoom'; zoom: number }
    | { type: 'zoom-in' }
    | { type: 'zoom-out' }
    | { type: 'fit' }
    | { type: 'actual-size' }
    | { type: 'rotate-cw' }
    | { type: 'flip-h' }
    | { type: 'flip-v' }
    | { type: 'reset' }
    | { type: 'set-filter'; filter: Partial<FilterState> }
    | { type: 'set-preset'; preset: FilterPreset }
    | { type: 'toggle-grid' }
    | { type: 'set-grid-mode'; mode: GridMode }
    | { type: 'set-grid-value'; key: 'cellWidth' | 'cellHeight' | 'rows' | 'cols'; value: number }
    | { type: 'set-tool'; tool: AnnotationTool }
    | { type: 'set-style'; style: Partial<AnnotationStyle> }
    | { type: 'add-annotation'; annotation: Annotation }
    | { type: 'select-annotation'; id: string | null }
    | { type: 'move-annotation'; dx: number; dy: number }
    | { type: 'update-annotation'; id: string; patch: Partial<Extract<Annotation, { type: 'text' }>> }
    | { type: 'delete-annotation'; id?: string }
    | { type: 'undo' };

export interface ImageController {
    readonly state: ImageViewState;
    dispatch(action: ImageAction): void;
    subscribe(listener: (state: ImageViewState) => void): () => void;
    /** CSS `filter` string for the current filter values (display + export). */
    filterCss(): string;
    /** Record decode metadata / status; editingEnabled gates the canvas ops. */
    setDocument(input: {
        status: 'ok' | 'partial' | 'failed';
        failure?: ParseFailure | null;
        diagnostics?: Diagnostic[];
        meta?: ImageMeta | null;
        editingEnabled?: boolean;
    }): void;
}

let idCounter = 0;
/** Deterministic monotonic ids so conformance snapshots stay comparable. */
function nextId(): string {
    return `a${idCounter++}`;
}

function clamp(value: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, value));
}

/** Snap zoom to the 25 % grid within range (image.md §3). */
export function normalizeZoom(zoom: number): number {
    const snapped = Math.round(zoom / ZOOM_STEP) * ZOOM_STEP;
    return clamp(Number(snapped.toFixed(4)), MIN_ZOOM, MAX_ZOOM);
}

export function filterToCss(filter: FilterState): string {
    return (
        `brightness(${filter.brightness}%) contrast(${filter.contrast}%) ` +
        `saturate(${filter.saturation}%) grayscale(${filter.grayscale}%)`
    );
}

function initialEdit(): EditSnapshot {
    return {
        rotation: 0,
        flipH: false,
        flipV: false,
        filter: { ...NEUTRAL_FILTER },
        preset: 'original',
        grid: { ...DEFAULT_GRID },
        annotations: []
    };
}

function cloneEdit(edit: EditSnapshot): EditSnapshot {
    return {
        rotation: edit.rotation,
        flipH: edit.flipH,
        flipV: edit.flipV,
        filter: { ...edit.filter },
        preset: edit.preset,
        grid: { ...edit.grid },
        annotations: edit.annotations.map(cloneAnnotation)
    };
}

function cloneAnnotation(a: Annotation): Annotation {
    if (a.type === 'stroke') {
        return { ...a, points: a.points.map((p) => ({ ...p })), style: { ...a.style } };
    }
    return { ...a, style: { ...a.style } } as Annotation;
}

export function createImageController(): ImageController {
    const listeners = new Set<(s: ImageViewState) => void>();

    let status: 'ok' | 'partial' | 'failed' = 'ok';
    let failure: ParseFailure | null = null;
    let diagnostics: Diagnostic[] = [];
    let meta: ImageMeta | null = null;
    let editingEnabled = true;

    let zoom = 1;
    let fitMode = true;

    let edit = initialEdit();

    let tool: AnnotationTool = 'select';
    let selectedId: string | null = null;
    let style: AnnotationStyle = { ...DEFAULT_STYLE };

    // Cursor-based linear history (image.md I4): undo only in v1, but the model
    // supports a future redo without a refactor. history[0] is the initial edit.
    const history: EditSnapshot[] = [cloneEdit(edit)];
    let historyIndex = 0;

    function emit(): void {
        const snapshot = buildState();
        for (const listener of listeners) listener(snapshot);
    }

    function buildState(): ImageViewState {
        return {
            status,
            failure,
            diagnostics,
            meta,
            editingEnabled,
            zoom,
            fitMode,
            rotation: edit.rotation,
            flipH: edit.flipH,
            flipV: edit.flipV,
            filter: { ...edit.filter },
            preset: edit.preset,
            grid: { ...edit.grid },
            annotations: edit.annotations.map(cloneAnnotation),
            tool,
            selectedId,
            style: { ...style },
            dirty: historyIndex !== 0,
            canUndo: historyIndex > 0
        };
    }

    /** Commit the current `edit` as a new history entry (image.md §4: drop the
     *  oldest past the cap; a new edit truncates any undone tail). */
    function pushHistory(): void {
        history.splice(historyIndex + 1); // drop redo branch (none in v1 UI)
        history.push(cloneEdit(edit));
        historyIndex = history.length - 1;
        while (history.length > MAX_UNDO_ENTRIES + 1) {
            history.shift();
            historyIndex--;
        }
    }

    function restore(index: number): void {
        historyIndex = index;
        edit = cloneEdit(history[index] as EditSnapshot);
        // A restored document may no longer contain the selected annotation.
        if (selectedId && !edit.annotations.some((a) => a.id === selectedId)) {
            selectedId = null;
        }
    }

    /** Grid inputs keep the previous valid value on 0/negative/NaN (image.md §3). */
    function normalizeGridValue(value: number): number | null {
        if (!Number.isFinite(value) || value <= 0) return null;
        return Math.floor(value);
    }

    function dispatch(action: ImageAction): void {
        switch (action.type) {
            // ---- view (display-only) ----------------------------------------
            case 'set-zoom':
                zoom = normalizeZoom(action.zoom);
                fitMode = false;
                break;
            case 'zoom-in':
                zoom = normalizeZoom(zoom + ZOOM_STEP);
                fitMode = false;
                break;
            case 'zoom-out':
                zoom = normalizeZoom(zoom - ZOOM_STEP);
                fitMode = false;
                break;
            case 'fit':
                fitMode = true;
                break;
            case 'actual-size':
                zoom = 1;
                fitMode = false;
                break;

            // ---- edits (undoable) -------------------------------------------
            case 'rotate-cw':
                edit.rotation = ((edit.rotation + 90) % 360) as Rotation;
                pushHistory();
                break;
            case 'flip-h':
                edit.flipH = !edit.flipH;
                pushHistory();
                break;
            case 'flip-v':
                edit.flipV = !edit.flipV;
                pushHistory();
                break;
            case 'reset':
                // Transform, filter, grid, annotation and selection all return to
                // initial (image.md §3). Zoom/fit reset too (display-only).
                edit = initialEdit();
                zoom = 1;
                fitMode = true;
                selectedId = null;
                pushHistory();
                break;
            case 'set-filter':
                edit.filter = {
                    brightness: clamp(action.filter.brightness ?? edit.filter.brightness, 0, 200),
                    contrast: clamp(action.filter.contrast ?? edit.filter.contrast, 0, 200),
                    saturation: clamp(action.filter.saturation ?? edit.filter.saturation, 0, 200),
                    grayscale: clamp(action.filter.grayscale ?? edit.filter.grayscale, 0, 100)
                };
                edit.preset = null;
                pushHistory();
                break;
            case 'set-preset':
                edit.filter = { ...FILTER_PRESETS[action.preset] };
                edit.preset = action.preset;
                pushHistory();
                break;
            case 'toggle-grid':
                edit.grid = { ...edit.grid, visible: !edit.grid.visible };
                pushHistory();
                break;
            case 'set-grid-mode':
                edit.grid = { ...edit.grid, mode: action.mode };
                pushHistory();
                break;
            case 'set-grid-value': {
                const normalized = normalizeGridValue(action.value);
                if (normalized === null) return; // keep previous valid value; no history
                edit.grid = { ...edit.grid, [action.key]: normalized };
                pushHistory();
                break;
            }

            // ---- annotations -------------------------------------------------
            case 'set-tool':
                tool = action.tool;
                break;
            case 'set-style':
                style = { ...style, ...action.style };
                if (selectedId) {
                    const target = edit.annotations.find((a) => a.id === selectedId);
                    if (target) {
                        target.style = { ...target.style, ...action.style };
                        pushHistory();
                    }
                }
                break;
            case 'add-annotation':
                edit.annotations = [...edit.annotations, cloneAnnotation(action.annotation)];
                selectedId = action.annotation.id;
                pushHistory();
                break;
            case 'select-annotation':
                selectedId = action.id;
                break; // selection is not an edit
            case 'move-annotation': {
                if (!selectedId) return;
                const target = edit.annotations.find((a) => a.id === selectedId);
                if (!target) return;
                edit.annotations = edit.annotations.map((a) =>
                    a.id === selectedId ? translate(a, action.dx, action.dy) : a
                );
                pushHistory();
                break;
            }
            case 'update-annotation': {
                const target = edit.annotations.find((a) => a.id === action.id);
                if (!target || target.type !== 'text') return;
                edit.annotations = edit.annotations.map((a) =>
                    a.id === action.id && a.type === 'text' ? { ...a, ...action.patch } : a
                );
                pushHistory();
                break;
            }
            case 'delete-annotation': {
                const id = action.id ?? selectedId;
                if (!id || !edit.annotations.some((a) => a.id === id)) return;
                edit.annotations = edit.annotations.filter((a) => a.id !== id);
                if (selectedId === id) selectedId = null;
                pushHistory();
                break;
            }

            // ---- history -----------------------------------------------------
            case 'undo':
                if (historyIndex === 0) return;
                restore(historyIndex - 1);
                break;
        }
        emit();
    }

    function setDocument(input: {
        status: 'ok' | 'partial' | 'failed';
        failure?: ParseFailure | null;
        diagnostics?: Diagnostic[];
        meta?: ImageMeta | null;
        editingEnabled?: boolean;
    }): void {
        status = input.status;
        failure = input.failure ?? null;
        diagnostics = input.diagnostics ?? [];
        meta = input.meta ?? null;
        editingEnabled = input.editingEnabled ?? input.status !== 'failed';
        emit();
    }

    return {
        get state() {
            return buildState();
        },
        dispatch,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        filterCss() {
            return filterToCss(edit.filter);
        },
        setDocument
    };
}

/** Shift every coordinate of an annotation by (dx, dy) in source pixels. */
function translate(a: Annotation, dx: number, dy: number): Annotation {
    switch (a.type) {
        case 'line':
            return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
        case 'stroke':
            return { ...a, points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
        default:
            return { ...a, x: a.x + dx, y: a.y + dy };
    }
}

/** Factory helper for the renderer: build an annotation with a fresh id. */
export function makeAnnotation(
    spec: Omit<Extract<Annotation, { type: 'rectangle' }>, 'id'>
        | Omit<Extract<Annotation, { type: 'circle' }>, 'id'>
        | Omit<Extract<Annotation, { type: 'line' }>, 'id'>
        | Omit<Extract<Annotation, { type: 'text' }>, 'id'>
        | Omit<Extract<Annotation, { type: 'stroke' }>, 'id'>
): Annotation {
    return { id: nextId(), ...spec } as Annotation;
}
