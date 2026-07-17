// Image decoding + detection (docs/viewers/image.md §1, §2, §4). The pure
// helpers (MIME sniffing, SVG probing, animation + limit checks) are engine-
// independent and unit-tested; the async `decodeImage` uses browser decoders
// (createImageBitmap / <img> + blob URL) and is exercised by the mount smoke.
//
// SVG isolation (image.md I1, §5 보안): SVG is decoded only through an
// `image/svg+xml` blob URL into <img>/createImageBitmap — never injected into
// the document DOM. img-loaded SVG neither runs scripts nor fetches external
// resources, so the decode path itself is the isolation boundary.

import type { Diagnostic, ParseFailure, ParseResult } from '../../parsers/types.js';
import type { ImageMeta } from './controller.js';
import { IMAGE_LIMITS } from './limits.js';

export type ImageMime =
    | 'image/png'
    | 'image/jpeg'
    | 'image/gif'
    | 'image/bmp'
    | 'image/webp'
    | 'image/svg+xml';

/** A decoded document is just metadata — the drawable lives separately so the
 *  controller stays DOM-free (image.md §2). */
export interface ImageDocument extends ImageMeta {}

export type ImageLoadResult = ParseResult<ImageDocument>;

const startsWith = (data: Uint8Array, sig: readonly number[], offset = 0): boolean =>
    data.length >= offset + sig.length && sig.every((b, i) => data[offset + i] === b);

/**
 * Byte-level MIME sniff (image.md §1). Returns null when the bytes match no
 * known raster signature and the content is not SVG text — the caller then
 * declines the image viewer (extension/byte conflict → fallback).
 */
export function detectImageMime(data: Uint8Array, fileName: string): ImageMime | null {
    if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
    if (startsWith(data, [0x42, 0x4d])) return 'image/bmp';
    if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8))
        return 'image/webp';
    if (isSvgText(data) && /\.svg$/i.test(fileName)) return 'image/svg+xml';
    return null;
}

/**
 * SVG text probe (image.md §1): scan the first ~1 KiB for an `<svg` root while
 * rejecting `<html` (a document, not an image). BOM / XML declaration /
 * comments before the root are tolerated.
 */
export function isSvgText(data: Uint8Array): boolean {
    const head = new TextDecoder('utf-8', { fatal: false })
        .decode(data.subarray(0, 1024))
        .toLowerCase();
    if (head.includes('<html')) return false;
    return head.includes('<svg');
}

/** Cheap animation sniff for the first-frame policy (image.md I2). Conservative:
 *  a false negative just means we show a static frame without the badge. */
export function isAnimated(data: Uint8Array, mime: ImageMime): boolean {
    if (mime === 'image/gif') {
        // More than one Graphic Control Extension (0x21 0xF9) ⇒ multiple frames.
        let count = 0;
        for (let i = 0; i + 1 < data.length; i++) {
            if (data[i] === 0x21 && data[i + 1] === 0xf9 && ++count > 1) return true;
        }
        return false;
    }
    if (mime === 'image/webp') {
        // 'ANIM' chunk marks an animated WebP.
        for (let i = 12; i + 3 < data.length && i < 4096; i++) {
            if (data[i] === 0x41 && data[i + 1] === 0x4e && data[i + 2] === 0x49 && data[i + 3] === 0x4d)
                return true;
        }
    }
    return false;
}

function fail(code: ParseFailure['code'], messageKey: string, args?: Record<string, string | number>): ImageLoadResult {
    return {
        status: 'failed',
        failure: { code, retryable: false, messageKey, ...(args ? { args } : {}) },
        diagnostics: []
    };
}

/**
 * Enforce the input-byte cap before touching a decoder (image.md §4). Returns a
 * `failed(limit-exceeded)` result, or null when within budget.
 */
export function checkInputLimit(data: Uint8Array, maxInputBytes = IMAGE_LIMITS.maxInputBytes): ImageLoadResult | null {
    if (data.byteLength > maxInputBytes) {
        return fail('limit-exceeded', 'diag.limit-exceeded.input', { maxBytes: maxInputBytes });
    }
    return null;
}

/** A decoded image plus its disposable browser resources (mount owns cleanup). */
export interface DecodedImage {
    load: ImageLoadResult;
    /** Drawable for canvas composition; absent on failure. */
    source?: CanvasImageSource & { width: number; height: number };
    /** Revoked on dispose. */
    objectUrl?: string;
    dispose(): void;
}

/**
 * Decode input bytes into a drawable + normalized ImageLoadResult. Never throws
 * on input-caused failure (parser determinism rule): unsupported/corrupt →
 * `invalid-format`/`corrupted`, oversize → `limit-exceeded`, no decoder →
 * `missing-dependency`. Honors `signal` and cleans up on abort.
 */
export async function decodeImage(
    input: { fileName: string; data: Uint8Array },
    options: { signal?: AbortSignal; maxInputBytes?: number; maxDecodedPixels?: number } = {}
): Promise<DecodedImage> {
    const noop: DecodedImage = { load: fail('invalid-format', 'diag.image.invalid-format'), dispose() {} };

    const limitHit = checkInputLimit(input.data, options.maxInputBytes);
    if (limitHit) return { load: limitHit, dispose() {} };

    const mime = detectImageMime(input.data, input.fileName);
    if (!mime) return noop;

    if (typeof createImageBitmap !== 'function' || typeof Blob !== 'function') {
        return { load: fail('missing-dependency', 'diag.image.invalid-format'), dispose() {} };
    }

    const blob = new Blob([input.data.slice().buffer], { type: mime });
    let objectUrl: string | undefined;
    let bitmap: ImageBitmap | undefined;

    const dispose = () => {
        bitmap?.close?.();
        if (objectUrl && typeof URL !== 'undefined') URL.revokeObjectURL(objectUrl);
    };

    try {
        // SVG and raster both go through blob decoding — SVG via <img> keeps it
        // isolated (no DOM injection, no script execution).
        bitmap = await createImageBitmap(blob);
        if (options.signal?.aborted) {
            dispose();
            return { load: fail('aborted' as ParseFailure['code'], 'diag.aborted'), dispose() {} };
        }

        const pixels = bitmap.width * bitmap.height;
        const maxPixels = options.maxDecodedPixels ?? IMAGE_LIMITS.maxDecodedPixels;
        if (pixels > maxPixels) {
            // v1: no downscaler wired yet — decline rather than risk OOM (I6).
            dispose();
            return { load: fail('limit-exceeded', 'diag.image.limit-exceeded.pixels'), dispose() {} };
        }

        const animated = isAnimated(input.data, mime);
        const diagnostics: Diagnostic[] = [];
        if (animated) {
            diagnostics.push({
                severity: 'info',
                code: 'animated-first-frame',
                messageKey: 'diag.image.animated-first-frame'
            });
        }
        const doc: ImageDocument = {
            mime,
            width: bitmap.width,
            height: bitmap.height,
            byteLength: input.data.byteLength,
            animated
        };
        return {
            load: { status: animated ? 'partial' : 'ok', document: doc, diagnostics },
            source: bitmap,
            ...(objectUrl ? { objectUrl } : {}),
            dispose
        };
    } catch {
        dispose();
        return { load: fail('corrupted', 'diag.image.corrupted'), dispose() {} };
    }
}
