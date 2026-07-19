// Host service contracts (DESIGN.md §3-③).
//
// The host contract is deliberately split into small service interfaces
// instead of one large `PlatformHost`: most viewers need only the required
// trio in `HostContext`, and optional capabilities are requested per-viewer
// through the mount signature's intersection type. Behavior when an optional
// service is absent is a core contract (degraded mode), not adapter
// discretion.

/** Required minimal contract every viewer receives. */
export interface HostContext {
    assets: AssetService;
    i18n: I18nService;
    logger: LoggerService;
}

export interface AssetService {
    /**
     * Resolve a bundled asset (wasm, worker, font) to a loadable URL.
     * vscode: webview.asWebviewUri / chrome: chrome.runtime.getURL /
     * obsidian: bundled bytes -> blob URL / web: static path.
     * Always a Promise: a dual sync/async return type only complicates
     * call sites (ADR 32).
     */
    resolveAssetUrl(assetPath: string): Promise<string>;
}

export interface I18nService {
    /**
     * Key + args lookup. The lookup mechanism may be the platform's i18n,
     * but the source of truth for message text (all locales) is the core
     * catalog (DESIGN.md §3-③, ADR 28). Inline English fallbacks at call
     * sites are forbidden.
     */
    t(key: string, args?: Record<string, string | number>): string;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LoggerService {
    log(level: LogLevel, message: string): void;
}

// ---------------------------------------------------------------------------
// Optional services — viewers that need one require it in their mount
// signature (`ctx: HostContext & { save: FileSaveService }`). Absence rules
// (excluded vs degraded mode) are declared per viewer (DESIGN.md ADR 24).
// ---------------------------------------------------------------------------

export type FileSaveResult =
    | { status: 'saved'; fileName?: string; uri?: string }
    | { status: 'cancelled' };

export interface FileSaveService {
    /** Creates a new file. Implementations present the platform's save
     *  destination picker (or browser-equivalent download prompt) so the
     *  user chooses the target path and may change the suggested name.
     *
     * Existing implementations may continue returning `void` (treated as a
     * successful save). New implementations should return `cancelled` when the
     * picker is dismissed, and may open the saved file or show host UI before
     * resolving `saved`. */
    saveFile(
        name: string,
        data: Uint8Array,
        mimeType: string
    ): Promise<void | FileSaveResult>;
}

export interface ClipboardService {
    writeText(text: string): Promise<void>;
}

/** Prints the viewer surface selected by the platform adapter. */
export interface PrintService {
    print(): void | Promise<void>;
}

export interface FileWritebackService {
    /**
     * Overwrite the currently open source file. Distinct from FileSaveService
     * (new files); takes no path — the adapter binds it to the open file via
     * closure, ruling out arbitrary-path writes.
     */
    write(data: Uint8Array): Promise<void>;
}

/** Lets an editing viewer ask the host for one user-selected input file. */
export interface FilePickService {
    pickFile(options: { accept: readonly string[]; maxBytes?: number }): Promise<
        | { fileName: string; data: Uint8Array; mimeType?: string }
        | undefined
    >;
}

export interface NavigationService {
    /** Open an external link. Scheme allow-list is checked by core before this call. */
    openExternalUrl(url: string): Promise<void>;
}

/** Resolves a relative asset referenced by the document currently being viewed. */
export interface DocumentAssetsService {
    resolve(path: string): Promise<ResolvedDocumentAsset | null>;
}

export interface ResolvedDocumentAsset {
    url: string;
    /** Releases a transient URL (for example a blob URL). */
    dispose(): void;
}

export interface WorkerFactoryService {
    /** Create a Worker for a core-defined worker entry. URL resolution and
     *  module/classic choice are the adapter's responsibility. The adapter
     *  must be able to terminate() it (hard limits, DESIGN.md §3-①). */
    createWorker(entry: string): Worker;
}

/**
 * Plain RGBA pixel buffer used to hand images to/from model-backed services
 * (docs/viewers/image.md §2). Deliberately not an ImageBitmap: a data buffer is
 * Worker-transferable, unit-testable, and keeps the image viewer's state model
 * DOM-free (§3-②). `data` is row-major RGBA with `length === width * height * 4`.
 */
export interface RgbaImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
}

/**
 * Background removal (currently Web's Transformers.js). Model acquisition,
 * network use and WASM/Worker creation are the adapter's responsibility; core
 * only consumes the result and its failure/cancel/dispose (image.md I8).
 */
export interface ImageBackgroundRemovalService {
    /** Returns an RGBA cutout (background alpha = 0). Rejects on abort. */
    removeBackground(source: RgbaImage, options?: { signal?: AbortSignal }): Promise<RgbaImage>;
    /** Release any model/Worker/WASM the service holds. */
    dispose?(): void;
}

/** One detected sprite contour in source pixel coordinates. Core crops and
 *  composes the object PNG from these — the service returns geometry only. */
export interface SpriteContour {
    box: { x: number; y: number; width: number; height: number };
    /** Overlay polygon (source px). */
    polygon?: readonly { x: number; y: number }[];
}

/**
 * Sprite outline detection (currently Web's OpenCV Canny/contour). Worker/WASM,
 * CDN and bundled-asset choices belong to the providing adapter (image.md I8).
 */
export interface ImageSpriteDetectionService {
    detectSprites(source: RgbaImage, options?: { signal?: AbortSignal }): Promise<readonly SpriteContour[]>;
    dispose?(): void;
}

/** Identifiers for optional services, used in viewer metadata. */
export type ServiceId =
    | 'save'
    | 'writeback'
    | 'clipboard'
    | 'navigation'
    | 'workerFactory'
    | 'filePick'
    | 'backgroundRemoval'
    | 'spriteDetection'
    | 'documentAssets'
    | 'print';

/** URL schemes viewers may open via NavigationService (DESIGN.md §3-③). */
export const ALLOWED_LINK_SCHEMES: readonly string[] = ['https:', 'http:', 'mailto:'];
