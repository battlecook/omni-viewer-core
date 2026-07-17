// Image viewer default limits (docs/viewers/image.md §4, I6). These are the
// *image-viewer* defaults — intentionally lower than core DEFAULT_LIMITS
// (256 MiB) because decoded pixel buffers (width × height × 4) dwarf the file
// size. Adapters keep any stricter existing limit and may override the rest,
// recording the value + memory measurement in their smoke.

export interface ImageLimits {
    /** Bytes; enforced before any decoder touches the input. */
    maxInputBytes: number;
    /** Decoded preview pixel cap (safe downscale territory). */
    maxDecodedPixels: number;
    /** Editable/export canvas pixel cap — beyond it editing/export disable. */
    maxCanvasPixels: number;
    /** Per-axis canvas dimension cap (browser canvas ceiling). */
    maxCanvasDimension: number;
    /** Undo history depth. */
    maxUndoEntries: number;
    /** Undo history byte budget. */
    maxUndoBytes: number;
}

export const IMAGE_LIMITS: ImageLimits = {
    maxInputBytes: 100 * 1024 * 1024, // 100 MiB
    maxDecodedPixels: 64 * 1_000_000, // 64 MP
    maxCanvasPixels: 32 * 1_000_000, // 32 MP
    maxCanvasDimension: 16_384,
    maxUndoEntries: 100,
    maxUndoBytes: 16 * 1024 * 1024 // 16 MiB
};

/** Whether an image of this size can back an editable/exportable canvas
 *  (image.md §4): both the pixel count and each axis must be within budget. */
export function canvasEditable(
    width: number,
    height: number,
    limits: ImageLimits = IMAGE_LIMITS
): boolean {
    return (
        width * height <= limits.maxCanvasPixels &&
        width <= limits.maxCanvasDimension &&
        height <= limits.maxCanvasDimension
    );
}
