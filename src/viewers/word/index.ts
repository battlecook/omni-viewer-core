import { ALLOWED_LINK_SCHEMES, type HostContext, type NavigationService, type PrintService } from '../../host/index.js';
import { bindFragmentAnchor, classifyAnchorTarget } from '../anchors.js';
import {
    hasEmbeddedDocWorkbook,
    parseDocBinaryHtml,
    type DocBinaryRuntimeDeps
} from '../../parsers/doc-binary/index.js';
import type { Diagnostic, ParseFailure } from '../../parsers/types.js';
import {
    MountAbortedError,
    VIEWER_ROOT_CLASS,
    type MountOptions,
    type ViewerHandle,
    type ViewerInput
} from '../types.js';
import { createWordController, type WordController } from './controller.js';
import {
    DOCX_MAX_DECOMPRESSED_BYTES,
    DocxDecompressionLimitError,
    preprocessDocx,
    type ChartModel,
    type DocxPlaceholder,
    type SheetModule,
    type ZipModule
} from './docx-preprocess.js';
import { normalizeDocxPreviewDom } from './normalize-docx.js';
import { paginateLegacyDocument } from './paginate.js';
import { wordViewerCss } from './styles.js';

export * from './controller.js';
export { wordViewerCss } from './styles.js';

export const WORD_VIEWER_META = {
    id: 'word',
    displayNameKey: 'word.title',
    extensions: ['docx', 'doc'],
    priority: 15,
    requiredServices: [] as const,
    optionalServices: ['print', 'navigation'] as const,
    inputOwnership: 'consumes' as const
};

export const WORD_MAX_INPUT_BYTES = 50 * 1024 * 1024;

export interface WordViewerLimits {
    maxInputBytes?: number;
    maxDecompressedBytes?: number;
    maxPages?: number;
    maxImageBytes?: number;
    maxEmbeddedFiles?: number;
}

export const WORD_VIEWER_DEFAULT_LIMITS: Readonly<Required<WordViewerLimits>> = Object.freeze({
    maxInputBytes: WORD_MAX_INPUT_BYTES,
    maxDecompressedBytes: DOCX_MAX_DECOMPRESSED_BYTES,
    maxPages: 10_000,
    maxImageBytes: 64 * 1024 * 1024,
    maxEmbeddedFiles: 128
});

/** Safe docx-preview options that hosts may tune. `inWrapper` remains true. */
export interface WordDocxRenderOptions {
    inWrapper: boolean;
    ignoreWidth: boolean;
    ignoreHeight: boolean;
    ignoreFonts: boolean;
    breakPages: boolean;
    renderHeaders: boolean;
    renderFooters: boolean;
    renderFootnotes: boolean;
    renderEndnotes: boolean;
    useBase64URL: boolean;
    experimental: boolean;
}

export const WORD_DOCX_RENDER_DEFAULTS: Readonly<WordDocxRenderOptions> = Object.freeze({
    inWrapper: true,
    ignoreWidth: false,
    ignoreHeight: false,
    ignoreFonts: false,
    breakPages: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    useBase64URL: true,
    experimental: true
});

export interface DocxPreviewModule {
    renderAsync(
        data: ArrayBuffer | Uint8Array,
        body: HTMLElement,
        styleContainer?: HTMLElement,
        options?: Record<string, unknown>
    ): Promise<unknown>;
}

export interface WordViewerDeps {
    loadDocxPreview(): Promise<DocxPreviewModule>;
    loadZip(): Promise<ZipModule>;
    /** Loaded only after an embedded workbook is discovered. */
    loadSheet?(): Promise<SheetModule>;
}

export type WordViewerContext = HostContext & {
    print?: PrintService;
    navigation?: NavigationService;
};

export type WordFormat = 'doc' | 'docx';
export type WordRenderFailureCode =
    | ParseFailure['code']
    | 'decompression-limit'
    | 'dependency-error'
    | 'render-failed'
    | 'fallback-renderer-failed';

export type WordDiagnosticCode =
    | 'password-required'
    | 'invalid-format'
    | 'corrupted'
    | 'recovered-corruption'
    | 'unsupported-feature'
    | 'blocked-external-resource'
    | 'limit-exceeded'
    | 'decompression-limit'
    | 'embedded-workbook-disabled'
    | 'chart-fallback-used'
    | 'fallback-renderer-used'
    | 'missing-dependency'
    | 'dependency-error'
    | 'render-failed'
    | 'fallback-renderer-failed'
    | (string & {});

export interface WordDiagnostic {
    severity: 'info' | 'warning' | 'error';
    code: WordDiagnosticCode;
    messageKey: string;
    args?: Record<string, string | number>;
    detail?: string;
    location?: string;
    recoverable?: boolean;
}

export type WordRenderStatus =
    | { state: 'loading'; format: WordFormat }
    | {
        state: 'ready';
        format: WordFormat;
        renderer: 'core' | 'fallback';
        diagnostics: readonly WordDiagnostic[];
    }
    | {
        state: 'partial';
        format: WordFormat;
        renderer: 'core';
        diagnostics: readonly WordDiagnostic[];
    }
    | {
        state: 'failed';
        format: WordFormat;
        error: Error;
        failure: { code: WordRenderFailureCode; recoverable: boolean };
        diagnostics: readonly WordDiagnostic[];
    }
    | {
        state: 'aborted';
        format: WordFormat;
        diagnostics: readonly WordDiagnostic[];
    };

export interface WordFallbackContext {
    input: ViewerInput;
    format: WordFormat;
    error: unknown;
    diagnostics: readonly WordDiagnostic[];
    /** Stable content root for the lifetime of the returned viewer handle. */
    container: HTMLElement;
    signal?: AbortSignal;
}

export interface WordToolbarAction {
    id: string;
    label: string;
    ariaLabel?: string;
    title?: string;
    disabled?: boolean | (() => boolean);
    run(): void | Promise<void>;
}

export interface WordViewerOptions extends MountOptions {
    fallbackRenderer?(
        context: WordFallbackContext
    ): boolean | Promise<boolean>;
    toolbarActions?: readonly WordToolbarAction[];
    onToolbarActionError?(error: unknown, action: WordToolbarAction): void;
    /**
     * Receives `loading` before the mount promise resolves and every terminal
     * transition. Exceptions from the callback are logged and ignored.
     */
    onStatusChange?(status: WordRenderStatus): void;
    docxRenderOptions?: Partial<WordDocxRenderOptions>;
    limits?: WordViewerLimits;
}

export interface WordViewerHandle extends ViewerHandle {
    readonly controller: WordController;
    readonly status: WordRenderStatus;
    /**
     * Rendered document root. It is stable in shadow and scoped modes and must
     * not be used after dispose().
     */
    readonly contentElement: HTMLElement;
    /**
     * Scroll viewport. It is stable in shadow and scoped modes and must not be
     * used after dispose().
     */
    readonly viewportElement: HTMLElement;
    subscribeStatus(listener: (status: WordRenderStatus) => void): () => void;
    /** Re-evaluates host action disabled callbacks. */
    refreshToolbarActions(): void;
}

class WordRenderError extends Error {
    constructor(
        readonly code: WordRenderFailureCode,
        message: string,
        readonly recoverable = false,
        readonly diagnostics: readonly WordDiagnostic[] = []
    ) {
        super(message);
        this.name = 'WordRenderError';
    }
}

const ACTIVE_MOUNTS = new WeakMap<HTMLElement, () => void>();

const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    text?: string
): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
};

export async function mountWordViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: WordViewerContext,
    deps: Partial<WordViewerDeps> = {},
    options: WordViewerOptions = {}
): Promise<WordViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    ACTIVE_MOUNTS.get(container)?.();

    const format: WordFormat = input.fileName.toLowerCase().endsWith('.docx') ? 'docx' : 'doc';
    const limits = resolveLimits(options.limits);
    const root: HTMLElement | ShadowRoot =
        options.styleIsolation !== 'scoped' && typeof container.attachShadow === 'function'
            ? (container.shadowRoot ?? container.attachShadow({ mode: 'open' }))
            : container;
    root.replaceChildren();
    if (root === container) container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--word');

    const frame = el('section', 'omni-word');
    const injectedStyle = root === container ? undefined : el('style');
    if (injectedStyle) {
        injectedStyle.textContent = wordViewerCss;
        frame.append(injectedStyle);
    }
    const header = el('header', 'omni-word__header');
    header.append(
        el('span', 'omni-word__title', `📄 ${input.fileName}`),
        el(
            'span',
            'omni-word__meta',
            `${formatBytes(input.data.byteLength)} · ${format === 'docx' ? 'DOCX' : 'legacy DOC'}`
        )
    );
    const toolbar = el('div', 'omni-word__toolbar');
    const out = el('button', undefined, '−');
    const level = el('span', 'omni-word__zoom', '100%');
    const inc = el('button', undefined, '+');
    const reset = el('button', undefined, ctx.i18n.t('word.reset'));
    const print = el('button', undefined, ctx.i18n.t('word.print'));
    out.type = inc.type = reset.type = print.type = 'button';
    out.setAttribute('aria-label', ctx.i18n.t('word.zoomOut'));
    inc.setAttribute('aria-label', ctx.i18n.t('word.zoomIn'));
    reset.setAttribute('aria-label', ctx.i18n.t('word.reset'));
    print.setAttribute('aria-label', ctx.i18n.t('word.print'));
    if (!ctx.print) {
        print.disabled = true;
        print.title = ctx.i18n.t('word.printUnavailable');
    }
    toolbar.append(out, level, inc, reset, print);
    const viewport = el('main', 'omni-word__viewport');
    const content = el('div', 'omni-word__content');
    content.setAttribute('role', 'document');
    viewport.append(content);
    frame.append(header, toolbar, viewport);
    root.append(frame);

    const controller = createWordController();
    const disposers: Array<() => void> = [];
    const statusListeners = new Set<(status: WordRenderStatus) => void>();
    let currentStatus: WordRenderStatus = { state: 'loading', format };
    let disposed = false;
    let abortStatusEmitted = false;
    const actionRecords: Array<{
        action: WordToolbarAction;
        button: HTMLButtonElement;
        running: boolean;
    }> = [];
    let cancelMount: () => void = () => undefined;
    const diagnostics: WordDiagnostic[] = [];
    const listen = (target: EventTarget, name: string, fn: EventListener): void => {
        target.addEventListener(name, fn);
        disposers.push(() => target.removeEventListener(name, fn));
    };
    const off = controller.subscribe((state) => {
        content.style.transform = `scale(${state.zoom})`;
        level.textContent = `${Math.round(state.zoom * 100)}%`;
    });
    const emitStatus = (status: WordRenderStatus): void => {
        currentStatus = status;
        for (const listener of statusListeners) listener(status);
        try {
            options.onStatusChange?.(status);
        } catch (error) {
            ctx.logger.log('error', `word status listener failed: ${String(error)}`);
        }
        syncToolbarActions();
    };
    const cleanup = (): void => {
        if (disposed) return;
        disposed = true;
        off();
        for (const dispose of disposers.splice(0)) dispose();
        statusListeners.clear();
        revokeBlobUrls(frame);
        frame.remove();
        if (ACTIVE_MOUNTS.get(container) === cancelMount) {
            ACTIVE_MOUNTS.delete(container);
            if (root === container) {
                container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--word');
            }
        }
    };
    const ensureActive = (): void => {
        if (
            disposed ||
            options.signal?.aborted ||
            ACTIVE_MOUNTS.get(container) !== cancelMount
        ) {
            throw new MountAbortedError();
        }
    };
    cancelMount = () => {
        if (currentStatus.state === 'loading') {
            abortStatusEmitted = true;
            emitStatus({ state: 'aborted', format, diagnostics: [...diagnostics] });
        }
        cleanup();
    };
    ACTIVE_MOUNTS.set(container, cancelMount);
    if (options.signal) {
        const abort = (): void => cancelMount();
        options.signal.addEventListener('abort', abort, { once: true });
        disposers.push(() => options.signal?.removeEventListener('abort', abort));
    }

    const syncToolbarActions = (): void => {
        if (disposed) return;
        for (const record of actionRecords) {
            let disabled = false;
            try {
                disabled = typeof record.action.disabled === 'function'
                    ? record.action.disabled()
                    : Boolean(record.action.disabled);
            } catch (error) {
                disabled = true;
                ctx.logger.log(
                    'error',
                    `word toolbar action ${record.action.id} disabled check failed: ${String(error)}`
                );
            }
            const renderUnavailable =
                currentStatus.state !== 'ready' && currentStatus.state !== 'partial';
            record.button.disabled = record.running || disabled || renderUnavailable;
            if (record.running) record.button.setAttribute('aria-busy', 'true');
            else record.button.removeAttribute('aria-busy');
            record.button.classList.toggle('is-loading', record.running);
        }
    };
    for (const action of options.toolbarActions ?? []) {
        const button = el('button', 'omni-word__host-action', action.label);
        button.type = 'button';
        button.dataset.actionId = action.id;
        button.setAttribute('aria-label', action.ariaLabel ?? action.label);
        if (action.title !== undefined) button.title = action.title;
        const record = { action, button, running: false };
        const run = (): void => {
            if (record.running || button.disabled) return;
            record.running = true;
            syncToolbarActions();
            void Promise.resolve()
                .then(() => action.run())
                .catch((error) => {
                    try {
                        if (options.onToolbarActionError) {
                            options.onToolbarActionError(error, action);
                        } else {
                            ctx.logger.log(
                                'error',
                                `word toolbar action ${action.id} failed: ${String(error)}`
                            );
                        }
                    } catch (callbackError) {
                        ctx.logger.log(
                            'error',
                            `word toolbar action ${action.id} error callback failed: ${String(callbackError)}`
                        );
                    }
                })
                .finally(() => {
                    record.running = false;
                    if (!disposed) syncToolbarActions();
                });
        };
        listen(button, 'click', run as EventListener);
        actionRecords.push(record);
        toolbar.append(button);
    }
    syncToolbarActions();

    out.onclick = () => controller.dispatch({ type: 'zoom-out' });
    inc.onclick = () => controller.dispatch({ type: 'zoom-in' });
    reset.onclick = () => controller.dispatch({ type: 'reset-zoom' });
    print.onclick = () => void ctx.print?.print();
    listen(frame, 'keydown', ((event: KeyboardEvent) => {
        if (!(event.ctrlKey || event.metaKey)) return;
        if (event.key === '+' || event.key === '=') controller.dispatch({ type: 'zoom-in' });
        else if (event.key === '-') controller.dispatch({ type: 'zoom-out' });
        else if (event.key === '0') controller.dispatch({ type: 'reset-zoom' });
        else if (event.key.toLowerCase() === 'p' && ctx.print) void ctx.print.print();
        else return;
        event.preventDefault();
    }) as EventListener);
    listen(viewport, 'wheel', ((event: WheelEvent) => {
        if (!(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        controller.dispatch({ type: event.deltaY < 0 ? 'zoom-in' : 'zoom-out' });
    }) as EventListener);

    emitStatus(currentStatus);
    let partial = false;
    try {
        if (input.data.byteLength > limits.maxInputBytes) {
            throw new WordRenderError(
                'limit-exceeded',
                ctx.i18n.t('diag.word.limit-exceeded'),
                false
            );
        }
        if (format === 'docx') {
            content.classList.add('word-content', 'docx-mode');
            if (isEncryptedOoxmlPackage(input.data)) {
                throw new WordRenderError(
                    'password-required',
                    ctx.i18n.t('diag.word.password-required'),
                    true
                );
            }
            if (!hasZipSignature(input.data)) {
                throw new WordRenderError(
                    'invalid-format',
                    ctx.i18n.t('diag.word.invalid-format')
                );
            }
            if (!deps.loadDocxPreview || !deps.loadZip) {
                throw new WordRenderError(
                    'missing-dependency',
                    ctx.i18n.t('diag.word.missing-dependency')
                );
            }
            const [docx, zip] = await Promise.all([
                deps.loadDocxPreview(),
                deps.loadZip()
            ]);
            ensureActive();
            const prepared = await preprocessDocx(input.data, zip, {
                maxDecompressedBytes: limits.maxDecompressedBytes,
                maxImageBytes: limits.maxImageBytes,
                maxEmbeddedFiles: limits.maxEmbeddedFiles,
                embeddedSheets: Boolean(deps.loadSheet),
                ...(deps.loadSheet ? { loadSheet: deps.loadSheet } : {}),
                ...(options.signal ? { signal: options.signal } : {})
            });
            ensureActive();
            diagnostics.push(...prepared.diagnostics.map(toWordDiagnostic));
            partial = prepared.partial;
            const docxOptions: WordDocxRenderOptions = {
                ...WORD_DOCX_RENDER_DEFAULTS,
                ...options.docxRenderOptions,
                // A stable wrapper is part of the core DOM contract.
                inWrapper: true
            };
            await docx.renderAsync(
                prepared.data,
                content,
                content,
                docxOptions as unknown as Record<string, unknown>
            );
            ensureActive();
            injectDocxPlaceholders(content, prepared.placeholders, ctx);
            normalizeDocxPreviewDom(content);
        } else {
            content.classList.add('word-content', 'legacy-mode');
            if (!deps.loadSheet) {
                ctx.logger.log(
                    'warn',
                    'word: legacy embedded workbook previews disabled because loadSheet is unavailable'
                );
            }
            if (!deps.loadZip) {
                ctx.logger.log(
                    'warn',
                    'word: legacy embedded package/chart previews disabled because loadZip is unavailable'
                );
            }
            const legacyDeps: DocBinaryRuntimeDeps = {};
            if (deps.loadZip) legacyDeps.jszip = await deps.loadZip();
            ensureActive();
            if (hasEmbeddedDocWorkbook(input.data) && deps.loadSheet) {
                try {
                    legacyDeps.xlsx = await deps.loadSheet();
                } catch (error) {
                    diagnostics.push({
                        severity: 'warning',
                        code: 'embedded-workbook-disabled',
                        messageKey: 'diag.word.embedded-workbook-disabled',
                        detail: error instanceof Error ? error.message : String(error),
                        recoverable: true
                    });
                    partial = true;
                }
            }
            ensureActive();
            const outcome = await parseDocBinaryHtml(
                input.data,
                legacyDeps,
                {
                    ...(options.signal ? { signal: options.signal } : {}),
                    limits: { maxInputBytes: limits.maxInputBytes }
                }
            );
            diagnostics.push(...outcome.result.diagnostics.map(toWordDiagnostic));
            if (outcome.result.status === 'failed') {
                if (outcome.result.failure.code === 'aborted') throw new MountAbortedError();
                throw new WordRenderError(
                    outcome.result.failure.code,
                    ctx.i18n.t(
                        outcome.result.failure.messageKey,
                        outcome.result.failure.args
                    ),
                    outcome.result.failure.retryable,
                    diagnostics
                );
            }
            partial = partial || outcome.result.status === 'partial';
            const parsed = new DOMParser().parseFromString(
                outcome.result.document.html,
                'text/html'
            );
            parsed
                .querySelectorAll('script:not(.ov-doc-legacy-section-meta),iframe,object,embed')
                .forEach((node) => node.remove());
            const fragment = document.createDocumentFragment();
            for (const child of [...parsed.body.childNodes]) {
                fragment.append(document.importNode(child, true));
            }
            content.append(fragment);
            paginateLegacyDocument(content);
        }
        ensureActive();
        const securityDiagnostics = secureWordDom(content, ctx, disposers, viewport);
        if (securityDiagnostics.length) {
            diagnostics.push(...securityDiagnostics);
            partial = true;
        }
        const pageDiagnostic = applyPageLimit(content, limits.maxPages);
        if (pageDiagnostic) {
            diagnostics.push(pageDiagnostic);
            partial = true;
        }
        emitStatus({
            state: partial ? 'partial' : 'ready',
            format,
            renderer: 'core',
            diagnostics: [...diagnostics]
        });
    } catch (error) {
        if (isAbortError(error) || disposed || options.signal?.aborted) {
            if (!abortStatusEmitted) {
                abortStatusEmitted = true;
                emitStatus({ state: 'aborted', format, diagnostics: [...diagnostics] });
            }
            cleanup();
            throw new MountAbortedError();
        }
        const failure = classifyFailure(error, ctx);
        if (failure.diagnostics.length) {
            for (const diagnostic of failure.diagnostics) {
                if (!diagnostics.some((item) =>
                    item.code === diagnostic.code &&
                    item.location === diagnostic.location &&
                    item.detail === diagnostic.detail
                )) diagnostics.push(diagnostic);
            }
        }
        if (!diagnostics.some((item) => item.code === failure.code && item.severity === 'error')) {
            diagnostics.push({
                severity: 'error',
                code: failure.code,
                messageKey: failure.messageKey,
                detail: failure.error.message,
                recoverable: failure.recoverable
            });
        }
        let fallbackReady = false;
        if (options.fallbackRenderer) {
            content.replaceChildren();
            try {
                fallbackReady = await options.fallbackRenderer({
                    input,
                    format,
                    error,
                    diagnostics: [...diagnostics],
                    container: content,
                    ...(options.signal ? { signal: options.signal } : {})
                });
                ensureActive();
            } catch (fallbackError) {
                if (isAbortError(fallbackError) || options.signal?.aborted) {
                    if (!abortStatusEmitted) {
                        abortStatusEmitted = true;
                        emitStatus({ state: 'aborted', format, diagnostics: [...diagnostics] });
                    }
                    cleanup();
                    throw new MountAbortedError();
                }
                diagnostics.push({
                    severity: 'error',
                    code: 'fallback-renderer-failed',
                    messageKey: 'diag.word.fallback-renderer-failed',
                    detail: fallbackError instanceof Error
                        ? fallbackError.message
                        : String(fallbackError),
                    recoverable: false
                });
                failure.code = 'fallback-renderer-failed';
                failure.recoverable = false;
                failure.error = fallbackError instanceof Error
                    ? fallbackError
                    : new Error(String(fallbackError));
                failure.messageKey = 'diag.word.fallback-renderer-failed';
            }
        }
        if (fallbackReady) {
            diagnostics.push({
                severity: 'info',
                code: 'fallback-renderer-used',
                messageKey: 'diag.word.fallback-renderer-used',
                recoverable: true
            });
            diagnostics.push(...secureWordDom(content, ctx, disposers, viewport));
            emitStatus({
                state: 'ready',
                format,
                renderer: 'fallback',
                diagnostics: [...diagnostics]
            });
        } else {
            content.replaceChildren(
                el('div', 'omni-word__error', ctx.i18n.t(failure.messageKey))
            );
            emitStatus({
                state: 'failed',
                format,
                error: failure.error,
                failure: {
                    code: failure.code,
                    recoverable: failure.recoverable
                },
                diagnostics: [...diagnostics]
            });
        }
    }

    return {
        controller,
        get status() {
            return currentStatus;
        },
        contentElement: content,
        viewportElement: viewport,
        subscribeStatus(listener) {
            statusListeners.add(listener);
            listener(currentStatus);
            return () => statusListeners.delete(listener);
        },
        refreshToolbarActions: syncToolbarActions,
        dispose: cleanup
    };
}

function resolveLimits(limits: WordViewerLimits | undefined): Required<WordViewerLimits> {
    const clamp = (value: number | undefined, coreDefault: number): number => {
        if (value === undefined || !Number.isFinite(value)) return coreDefault;
        return Math.min(coreDefault, Math.max(0, Math.floor(value)));
    };
    return {
        maxInputBytes: clamp(limits?.maxInputBytes, WORD_VIEWER_DEFAULT_LIMITS.maxInputBytes),
        maxDecompressedBytes: clamp(
            limits?.maxDecompressedBytes,
            WORD_VIEWER_DEFAULT_LIMITS.maxDecompressedBytes
        ),
        maxPages: clamp(limits?.maxPages, WORD_VIEWER_DEFAULT_LIMITS.maxPages),
        maxImageBytes: clamp(limits?.maxImageBytes, WORD_VIEWER_DEFAULT_LIMITS.maxImageBytes),
        maxEmbeddedFiles: clamp(
            limits?.maxEmbeddedFiles,
            WORD_VIEWER_DEFAULT_LIMITS.maxEmbeddedFiles
        )
    };
}

function classifyFailure(
    error: unknown,
    ctx: WordViewerContext
): {
    code: WordRenderFailureCode;
    recoverable: boolean;
    error: Error;
    messageKey: string;
    diagnostics: readonly WordDiagnostic[];
} {
    if (error instanceof WordRenderError) {
        return {
            code: error.code,
            recoverable: error.recoverable,
            error,
            messageKey: messageKeyForFailure(error.code),
            diagnostics: error.diagnostics
        };
    }
    if (error instanceof DocxDecompressionLimitError) {
        return {
            code: 'decompression-limit',
            recoverable: false,
            error,
            messageKey: 'diag.word.decompression-limit',
            diagnostics: []
        };
    }
    const normalized = error instanceof Error ? error : new Error(String(error));
    const text = normalized.message;
    if (/password|encrypted|encryption/i.test(text)) {
        return {
            code: 'password-required',
            recoverable: true,
            error: normalized,
            messageKey: 'diag.word.password-required',
            diagnostics: []
        };
    }
    if (/dependency|not installed|cannot find (?:module|package)|failed to fetch dynamically imported module/i.test(text)) {
        return {
            code: 'dependency-error',
            recoverable: true,
            error: normalized,
            messageKey: 'diag.word.missing-dependency',
            diagnostics: []
        };
    }
    if (/corrupt|crc|central directory|invalid zip|bad zip|missing .*stream/i.test(text)) {
        return {
            code: 'corrupted',
            recoverable: false,
            error: normalized,
            messageKey: 'diag.word.corrupted',
            diagnostics: []
        };
    }
    ctx.logger.log('error', `word render failed: ${text}`);
    return {
        code: 'render-failed',
        recoverable: true,
        error: normalized,
        messageKey: 'diag.word.render-failed',
        diagnostics: []
    };
}

function messageKeyForFailure(code: WordRenderFailureCode): string {
    switch (code) {
        case 'password-required': return 'diag.word.password-required';
        case 'corrupted': return 'diag.word.corrupted';
        case 'limit-exceeded': return 'diag.word.limit-exceeded';
        case 'decompression-limit': return 'diag.word.decompression-limit';
        case 'missing-dependency':
        case 'dependency-error': return 'diag.word.missing-dependency';
        case 'fallback-renderer-failed': return 'diag.word.fallback-renderer-failed';
        case 'aborted': return 'diag.aborted';
        case 'invalid-format': return 'diag.word.invalid-format';
        default: return 'diag.word.render-failed';
    }
}

function toWordDiagnostic(diagnostic: Diagnostic): WordDiagnostic {
    return {
        severity: diagnostic.severity,
        code: diagnostic.code,
        messageKey: diagnostic.messageKey,
        ...(diagnostic.args ? { args: diagnostic.args } : {}),
        ...(diagnostic.location ? { location: diagnostic.location } : {}),
        recoverable: diagnostic.severity !== 'error'
    };
}

function applyPageLimit(root: HTMLElement, maxPages: number): WordDiagnostic | null {
    const docxPages = [...root.querySelectorAll<HTMLElement>('.docx-wrapper > section')];
    const legacyPages = [...root.querySelectorAll<HTMLElement>('.ov-doc-legacy-page')];
    const pages = docxPages.length ? docxPages : legacyPages;
    if (pages.length <= maxPages) return null;
    for (const page of pages.slice(maxPages)) page.remove();
    return {
        severity: 'warning',
        code: 'limit-exceeded',
        messageKey: 'diag.word.page-limit',
        args: { count: maxPages },
        recoverable: true
    };
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function injectDocxPlaceholders(
    root: HTMLElement,
    placeholders: DocxPlaceholder[],
    ctx: WordViewerContext
): void {
    for (const placeholder of placeholders) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
            const value = node.textContent ?? '';
            const index = value.indexOf(placeholder.token);
            if (index < 0 || !node.parentNode) continue;
            const fragment = document.createDocumentFragment();
            if (index) fragment.append(value.slice(0, index));
            fragment.append(
                placeholder.kind === 'chart'
                    ? renderChart(placeholder.chart, ctx)
                    : renderEmbeddedSheet(placeholder.title, placeholder.rows)
            );
            if (index + placeholder.token.length < value.length) {
                fragment.append(value.slice(index + placeholder.token.length));
            }
            node.parentNode.replaceChild(fragment, node);
            break;
        }
    }
}

function renderEmbeddedSheet(title: string, rows: string[][]): HTMLElement {
    const section = el('section', 'omni-word__embedded-sheet');
    section.append(el('h3', undefined, title));
    const table = el('table', 'omni-word__legacy-table');
    rows.forEach((row, rowIndex) => {
        const tr = el('tr');
        row.forEach((value) => tr.append(el(rowIndex ? 'td' : 'th', undefined, value)));
        table.append(tr);
    });
    section.append(table);
    return section;
}

function renderChart(chart: ChartModel, ctx: WordViewerContext): HTMLElement {
    const card = el('figure', 'omni-word__chart');
    card.setAttribute('aria-label', chart.title || ctx.i18n.t('word.chart'));
    if (chart.title) card.append(el('figcaption', undefined, chart.title));
    if (chart.type === 'unsupported') {
        card.classList.add('omni-word__chart--unsupported');
        card.append(el(
            'div',
            'omni-word__chart-placeholder',
            ctx.i18n.t('word.chartUnsupported', { type: chart.sourceType })
        ));
        return card;
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 640 300');
    svg.setAttribute('role', 'img');
    if (chart.type === 'pie') renderPieChart(svg, chart);
    else renderCartesianChart(svg, chart);
    card.append(svg);

    const legend = el('div', 'omni-word__chart-legend');
    if (chart.type === 'pie') {
        const colors = pieColors(chart);
        const seriesName = chart.series[0]?.name;
        if (seriesName) legend.append(el('strong', 'omni-word__chart-series-name', seriesName));
        chart.categories.forEach((category, index) => {
            const item = el('span', undefined, category);
            item.style.borderLeft = `12px solid ${colors[index % colors.length]}`;
            legend.append(item);
        });
    } else {
        chart.series.forEach((series) => {
            const item = el('span', undefined, series.name);
            item.style.borderLeft = `12px solid ${series.color}`;
            legend.append(item);
        });
    }
    card.append(legend);
    return card;
}

function renderCartesianChart(
    svg: SVGSVGElement,
    chart: ChartModel
): void {
    const values = chart.series.flatMap((series) => series.values);
    const max = Math.max(1, ...values);
    const min = Math.min(0, ...values);
    const range = Math.max(1, max - min);
    const plotTop = 20;
    const plotHeight = 220;
    const baseline = plotTop + (max / range) * plotHeight;
    const group = 520 / Math.max(1, chart.categories.length);
    chart.categories.forEach((category, index) => {
        const label = document.createElementNS(svg.namespaceURI, 'text');
        label.setAttribute('x', String(70 + index * group + group / 2));
        label.setAttribute('y', '278');
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('font-size', '11');
        label.setAttribute('fill', '#333');
        label.textContent = category;
        svg.append(label);
    });
    if (chart.type === 'line') {
        chart.series.forEach((series) => {
            const points = series.values.map((value, valueIndex) => {
                const x = 70 + valueIndex * group + group / 2;
                const y = plotTop + ((max - value) / range) * plotHeight;
                return `${x},${y}`;
            }).join(' ');
            const line = document.createElementNS(svg.namespaceURI, 'polyline');
            line.setAttribute('points', points);
            line.setAttribute('fill', 'none');
            line.setAttribute('stroke', series.color);
            line.setAttribute('stroke-width', '3');
            svg.append(line);
            series.values.forEach((value, valueIndex) => {
                const circle = document.createElementNS(svg.namespaceURI, 'circle');
                circle.setAttribute('cx', String(70 + valueIndex * group + group / 2));
                circle.setAttribute(
                    'cy',
                    String(plotTop + ((max - value) / range) * plotHeight)
                );
                circle.setAttribute('r', '4');
                circle.setAttribute('fill', series.color);
                svg.append(circle);
            });
        });
        return;
    }
    const bar = group / Math.max(1, chart.series.length + 1);
    chart.series.forEach((series, seriesIndex) => {
        series.values.forEach((value, valueIndex) => {
            const y = plotTop + ((max - Math.max(0, value)) / range) * plotHeight;
            const valueY = plotTop + ((max - value) / range) * plotHeight;
            const rect = document.createElementNS(svg.namespaceURI, 'rect');
            rect.setAttribute('x', String(70 + valueIndex * group + seriesIndex * bar));
            rect.setAttribute('y', String(Math.min(baseline, valueY, y)));
            rect.setAttribute('width', String(Math.max(2, bar - 2)));
            rect.setAttribute('height', String(Math.abs(baseline - valueY)));
            rect.setAttribute('fill', series.color);
            svg.append(rect);
        });
    });
}

function renderPieChart(svg: SVGSVGElement, chart: ChartModel): void {
    const values = chart.series[0]?.values.map((value) => Math.max(0, value)) ?? [];
    const total = values.reduce((sum, value) => sum + value, 0);
    const colors = pieColors(chart);
    if (total <= 0) return;
    const cx = 320;
    const cy = 145;
    const radius = 115;
    if (values.length === 1) {
        const circle = document.createElementNS(svg.namespaceURI, 'circle');
        circle.setAttribute('cx', String(cx));
        circle.setAttribute('cy', String(cy));
        circle.setAttribute('r', String(radius));
        circle.setAttribute('fill', colors[0] ?? '#004586');
        svg.append(circle);
        return;
    }
    let angle = -Math.PI / 2;
    values.forEach((value, index) => {
        const next = angle + (value / total) * Math.PI * 2;
        const x1 = cx + radius * Math.cos(angle);
        const y1 = cy + radius * Math.sin(angle);
        const x2 = cx + radius * Math.cos(next);
        const y2 = cy + radius * Math.sin(next);
        const path = document.createElementNS(svg.namespaceURI, 'path');
        path.setAttribute(
            'd',
            `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${next - angle > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`
        );
        path.setAttribute('fill', colors[index % colors.length] ?? '#004586');
        svg.append(path);
        angle = next;
    });
}

function pieColors(chart: ChartModel): string[] {
    const palette = ['#004586', '#ff420e', '#ffd320', '#579d1c', '#7e57c2', '#0084d1'];
    const pointColors = chart.series[0]?.pointColors;
    if (pointColors?.length) {
        return chart.categories.map((_, index) => pointColors[index] ?? palette[index % palette.length]!);
    }
    const first = chart.series[0]?.color;
    return first ? [first, ...palette.filter((color) => color !== first)] : palette;
}

function secureWordDom(
    root: HTMLElement,
    ctx: WordViewerContext,
    disposers: Array<() => void>,
    viewport: HTMLElement | null
): WordDiagnostic[] {
    const diagnostics: WordDiagnostic[] = [];
    root.querySelectorAll('img,source,video,audio').forEach((node) => {
        for (const attr of ['src', 'srcset']) {
            const value = node.getAttribute(attr);
            if (!value || !/^(?:https?:)?\/\//i.test(value)) continue;
            node.removeAttribute(attr);
            diagnostics.push({
                severity: 'warning',
                code: 'blocked-external-resource',
                messageKey: 'diag.word.blocked-external-resource',
                detail: value,
                recoverable: true
            });
        }
    });
    root.querySelectorAll('a').forEach((anchor) => {
        const href = anchor.getAttribute('href') ?? '';
        anchor.removeAttribute('href');
        anchor.removeAttribute('target');
        const target = classifyAnchorTarget(href);
        // Bookmarks, table-of-contents entries and note back-references stay usable
        // without a navigation service: they never leave the document.
        if (
            target.kind === 'fragment' &&
            bindFragmentAnchor(anchor, target.name, root, viewport, disposers)
        ) return;
        const allowed = target.kind === 'absolute' &&
            ALLOWED_LINK_SCHEMES.includes(target.url.protocol);
        if (!allowed || !ctx.navigation) {
            anchor.setAttribute('aria-disabled', 'true');
            if (/^(?:https?:)?\/\//i.test(href)) {
                diagnostics.push({
                    severity: 'warning',
                    code: 'blocked-external-resource',
                    messageKey: 'diag.word.blocked-external-resource',
                    detail: href,
                    recoverable: true
                });
            }
            return;
        }
        anchor.setAttribute('role', 'link');
        anchor.tabIndex = 0;
        const open = (event: Event): void => {
            event.preventDefault();
            void ctx.navigation?.openExternalUrl(href);
        };
        anchor.addEventListener('click', open);
        disposers.push(() => anchor.removeEventListener('click', open));
    });
    root
        .querySelectorAll('iframe,object,embed,script:not(.ov-doc-legacy-section-meta)')
        .forEach((node) => node.remove());
    return diagnostics;
}

function revokeBlobUrls(root: ParentNode): void {
    const urls = new Set<string>();
    root.querySelectorAll<HTMLElement>('[src],[href],[srcset]').forEach((node) => {
        for (const attr of ['src', 'href', 'srcset']) {
            const value = node.getAttribute(attr);
            if (!value) continue;
            for (const part of value.split(/[\s,]+/)) {
                if (part.startsWith('blob:')) urls.add(part);
            }
        }
    });
    if (typeof URL.revokeObjectURL !== 'function') return;
    for (const url of urls) URL.revokeObjectURL(url);
}

function isEncryptedOoxmlPackage(input: Uint8Array): boolean {
    const oleMagic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    if (!oleMagic.every((byte, index) => input[index] === byte)) return false;
    return containsUtf16Le(input, 'EncryptedPackage') ||
        containsUtf16Le(input, 'EncryptionInfo');
}

function hasZipSignature(input: Uint8Array): boolean {
    return input[0] === 0x50 &&
        input[1] === 0x4b &&
        (
            (input[2] === 0x03 && input[3] === 0x04) ||
            (input[2] === 0x05 && input[3] === 0x06) ||
            (input[2] === 0x07 && input[3] === 0x08)
        );
}

function containsUtf16Le(input: Uint8Array, value: string): boolean {
    const needle = [...value].flatMap((char) => [char.charCodeAt(0), 0]);
    outer: for (let index = 0; index <= input.length - needle.length; index++) {
        for (let offset = 0; offset < needle.length; offset++) {
            if (input[index + offset] !== needle[offset]) continue outer;
        }
        return true;
    }
    return false;
}

function isAbortError(error: unknown): boolean {
    return error instanceof MountAbortedError ||
        (error instanceof Error && error.name === 'AbortError');
}
