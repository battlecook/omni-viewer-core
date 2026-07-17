// Viewer layer contracts (DESIGN.md §3-②).

export interface ViewerInput {
    fileName: string;
    /** Whole file bytes. Streaming readers are a v2 concern. */
    data: Uint8Array;
    lastModified?: number;
}

export interface ViewerHandle {
    /**
     * Tear down the viewer: cancel in-flight async work, remove listeners,
     * terminate workers, clear the container. Nothing may remain after this
     * call (verified by the viewer contract tests).
     */
    dispose(): void;
}

export interface MountOptions {
    /**
     * Cancels initialization (tab switch, file reselect). When aborted, mount
     * rejects with an 'aborted' error after cleaning up anything it acquired.
     */
    signal?: AbortSignal;
    /**
     * Style isolation mode (DESIGN.md §6 reverse-contamination contract).
     * 'shadow' (default): render inside a shadow root with core CSS injected
     * there — host global styles cannot leak in, and --omni-* custom
     * properties still pierce the boundary.
     * 'scoped': render directly into the container under a scope class; the
     * adapter is responsible for loading the core CSS into the document.
     */
    styleIsolation?: 'shadow' | 'scoped';
}

export class MountAbortedError extends Error {
    override readonly name = 'MountAbortedError';
    constructor() {
        super('mount aborted');
    }
}

/** Root scope class applied to every core viewer root element. */
export const VIEWER_ROOT_CLASS = 'omni-viewer';
