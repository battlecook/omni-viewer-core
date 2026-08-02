// LaTeX viewer (docs/viewers/latex.md): structure navigation, source editing
// and saving, plus math rendered by an injected engine (L2).
//
// The document itself is turned into DOM with createElement/textContent only —
// no document-derived string ever reaches innerHTML. The single exception is
// the math renderer's output, which is sanitized with the shared math profile
// before insertion (L3; DESIGN.md forbids adding a sanitize route, so this is
// markdown's existing one, lifted into `../math.js`).

import {
    ALLOWED_LINK_SCHEMES,
    type ClipboardService,
    type FileSaveService,
    type FileWritebackService,
    type HostContext,
    type NavigationService
} from '../../host/index.js';
import {
    parseLatex,
    plainText,
    type LatexBlock,
    type LatexDocument,
    type LatexHeading,
    type LatexInline,
    type LatexParseOptions
} from '../../parsers/latex/index.js';
import type { Diagnostic } from '../../parsers/types.js';
import { classifyAnchorTarget } from '../anchors.js';
import { MATH_SANITIZE_PROFILE, type DomPurify, type MathRenderer } from '../math.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { createLatexController, type LatexViewMode } from './controller.js';
import { resolveIncludes, type IncludeLimits, type LatexIncludeResolver } from './includes.js';
import { latexViewerCss } from './styles.js';

export {
    normalizeIncludePath, resolveIncludes, INCLUDE_DEFAULT_LIMITS,
    type IncludeLimits, type LatexIncludeResolver
} from './includes.js';

export { latexViewerCss } from './styles.js';
export { MATH_SANITIZE_PROFILE, type DomPurify, type MathRenderer } from '../math.js';
export { createLatexController, type LatexAction, type LatexController, type LatexViewMode, type LatexViewState } from './controller.js';
export {
    parseLatex, plainText, LATEX_DEFAULT_LIMITS,
    type LatexBlock, type LatexDocument, type LatexHeading, type LatexInline, type LatexPreamble
} from '../../parsers/latex/index.js';

export type LatexViewerContext = HostContext & {
    clipboard?: ClipboardService;
    navigation?: NavigationService;
    writeback?: FileWritebackService;
    save?: FileSaveService;
};

/**
 * Optional engines the adapter injects. Both fields are optional and the
 * viewer is fully usable without them (structure, outline, editing); math then
 * stays visible as its TeX source rather than disappearing.
 *
 * `createDOMPurify` is required *whenever* `math` is present: KaTeX output is
 * sanitized before insertion, so a renderer without a purifier is refused
 * rather than trusted (fail closed, L3). Only the DOMPurify factory is
 * injected — the allow-list itself is core-owned (markdown M3).
 */
export interface LatexViewerDeps {
    math?: MathRenderer;
    createDOMPurify?(window: Window): DomPurify;
}

/** LaTeX mount handle: dirty inspection lets hosts guard a re-mount (file
 *  change, refresh) against discarding unsaved edits, without reaching into the
 *  viewer's DOM (csv/image/pdf expose the same method). */
export interface LatexViewerHandle extends ViewerHandle {
    isDirty(): boolean;
}

export interface LatexMountOptions extends MountOptions {
    /** Forwarded to the parser (limits, cancellation). */
    parse?: LatexParseOptions;
    /** Injected renderers. Absent → math shows as TeX source (degraded mode). */
    deps?: LatexViewerDeps;
    /**
     * Resolves `\input`/`\include` targets to their text. Absent (the default)
     * leaves them as unresolved references — the core never reads files (L4).
     * Path containment is enforced by the core before this is called; the
     * adapter still owns the filesystem boundary.
     */
    resolveInclude?: LatexIncludeResolver;
    includeLimits?: Partial<IncludeLimits>;
    /**
     * Render every formula immediately instead of when it scrolls into view.
     * Progressive rendering is the default; this exists for hosts that print
     * or snapshot the whole document.
     */
    renderAllMath?: boolean;
}

export const LATEX_VIEWER_META = {
    id: 'latex',
    displayNameKey: 'latex.title',
    extensions: ['tex', 'latex', 'ltx'],
    priority: 10,
    requiredServices: [] as const,
    optionalServices: ['clipboard', 'navigation', 'writeback', 'save'] as const,
    inputOwnership: 'borrows' as const
};

export async function mountLatexViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: LatexViewerContext,
    options: LatexMountOptions = {}
): Promise<LatexViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();

    const root: HTMLElement | ShadowRoot = options.styleIsolation !== 'scoped' && typeof container.attachShadow === 'function'
        ? (container.shadowRoot ?? container.attachShadow({ mode: 'open' })) : container;
    if (root === container) container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--latex');
    else { const style = document.createElement('style'); style.textContent = latexViewerCss; root.append(style); }

    const t = ctx.i18n.t.bind(ctx.i18n);
    const disposers: Array<() => void> = [];
    let disposed = false;

    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const on = (node: EventTarget, type: string, listener: EventListener): void => {
        node.addEventListener(type, listener);
        disposers.push(() => node.removeEventListener(type, listener));
    };
    /**
     * For nodes rebuilt on every render (outline entries, reference chips).
     * Routing these through `on` grew `disposers` by a few entries per render
     * and kept every discarded node reachable for the viewer's lifetime; the
     * nodes are detached wholesale by `replaceChildren`, so their listeners go
     * with them and need no separate teardown.
     */
    const onEphemeral = (node: EventTarget, type: string, listener: EventListener): void => {
        node.addEventListener(type, listener);
    };
    const button = (key: string, className = 'omni-latex__button'): HTMLButtonElement => {
        const node = el('button', className, t(key));
        node.type = 'button';
        return node;
    };

    // A renderer without a purifier cannot be used safely, so it is refused
    // outright instead of having its output inserted unsanitized (L3).
    const deps = options.deps;
    const purifier = deps?.math && deps.createDOMPurify ? deps.createDOMPurify(window) : null;
    const mathRenderer = purifier ? deps?.math ?? null : null;
    if (deps?.math && !purifier) {
        ctx.logger.log('warn', 'latex: math renderer ignored — createDOMPurify was not provided');
    }

    interface MathSlot { element: HTMLElement; source: string; display: boolean; }
    let mathSlots: MathSlot[] = [];
    // `\label` targets, so a `\ref` chip can actually go somewhere. Filled while
    // rendering and read on click, which is what makes forward references work.
    const labelTargets = new Map<string, HTMLElement>();
    let mathObserver: IntersectionObserver | null = null;
    let parseGeneration = 0;
    let macros: Record<string, string> = {};

    const initial = parseLatex(input.data, options.parse);
    let document_: LatexDocument | null = initial.result.status === 'failed' ? null : initial.result.document;
    const sourceText = document_?.text ?? new TextDecoder().decode(input.data);
    // A file we could not understand structurally opens on its source: an empty
    // preview would read as "this file is empty" (L6).
    const startMode: LatexViewMode = document_ && document_.body.length ? 'preview' : 'source';
    const controller = createLatexController(sourceText, startMode);

    const shell = el('section', `${VIEWER_ROOT_CLASS} omni-viewer--latex omni-latex`);
    const header = el('header', 'omni-latex__header');
    const identity = el('div');
    identity.append(el('div', 'omni-latex__title', input.fileName));
    const meta = el('div', 'omni-latex__meta');
    identity.append(meta);
    const status = el('div', 'omni-latex__status', t('latex.ready'));
    // The partial-render notice is permanent, not a transient state: every
    // preview this viewer draws is partial by construction (L8).
    const partialBadge = el('div', 'omni-latex__partial', t('latex.partialRender'));
    header.append(identity, partialBadge, status);

    const toolbar = el('div', 'omni-latex__toolbar');
    const modeGroup = el('div', 'omni-latex__toolbar-group');
    const modeButtons = new Map<LatexViewMode, HTMLButtonElement>();
    for (const [mode, key] of [['preview', 'latex.preview'], ['split', 'latex.split'], ['source', 'latex.source']] as const) {
        const node = button(key);
        node.dataset.viewMode = mode;
        modeButtons.set(mode, node);
        modeGroup.append(node);
    }
    const actionGroup = el('div', 'omni-latex__toolbar-group');
    const renderButton = button('latex.render');
    const undoButton = button('latex.undo');
    const redoButton = button('latex.redo');
    actionGroup.append(renderButton, undoButton, redoButton);
    const copyGroup = el('div', 'omni-latex__toolbar-group');
    const copyButton = button('latex.copySource');
    copyGroup.append(copyButton);
    toolbar.append(modeGroup, actionGroup, copyGroup);

    const workspace = el('main', 'omni-latex__workspace');
    const outlinePanel = el('section', 'omni-latex__panel omni-latex__outline-panel');
    const outlineHeader = el('div', 'omni-latex__panel-header');
    outlineHeader.append(el('span', undefined, t('latex.outline')));
    const outlineList = el('ul', 'omni-latex__outline');
    outlineList.setAttribute('aria-label', t('latex.outline'));
    outlinePanel.append(outlineHeader, outlineList);

    const previewPanel = el('section', 'omni-latex__panel omni-latex__preview-panel');
    const previewHeader = el('div', 'omni-latex__panel-header');
    const previewCaption = el('span', 'omni-latex__caption', '');
    previewHeader.append(el('span', undefined, t('latex.preview')), previewCaption);
    const preview = el('article', 'omni-latex__preview');
    preview.setAttribute('role', 'document');
    previewPanel.append(previewHeader, preview);

    const sourcePanel = el('section', 'omni-latex__panel omni-latex__source-panel');
    const sourceHeader = el('div', 'omni-latex__panel-header');
    const sourceCaption = el('span', 'omni-latex__caption', t('latex.editable'));
    sourceHeader.append(el('span', undefined, t('latex.source')), sourceCaption);
    const sourceArea = el('textarea', 'omni-latex__source');
    sourceArea.spellcheck = false;
    sourceArea.value = sourceText;
    sourceArea.setAttribute('aria-label', t('latex.source'));
    sourcePanel.append(sourceHeader, sourceArea);
    workspace.append(outlinePanel, previewPanel, sourcePanel);

    const warning = el('div', 'omni-latex__warning');
    warning.hidden = true;
    const message = el('div', 'omni-latex__message');
    message.hidden = true;
    shell.append(header, toolbar, workspace, warning, message);
    root.append(shell);

    const setStatus = (key: string, tone = ''): void => {
        status.textContent = t(key);
        status.className = `omni-latex__status${tone ? ` is-${tone}` : ''}`;
    };
    const showMessage = (text: string): void => { message.textContent = text; message.hidden = !text; };
    const showWarnings = (values: string[]): void => {
        warning.hidden = values.length === 0;
        warning.textContent = values.join('\n');
    };
    const describe = (diagnostic: Diagnostic): string => t(diagnostic.messageKey, diagnostic.args);

    // --- math ---------------------------------------------------------------

    /** A formula's place in the preview. Until it renders (or if it never can)
     *  it holds the TeX source, so a formula is never silently missing. */
    const mathSlot = (source: string, display: boolean): HTMLElement => {
        const element = display
            ? el('div', 'omni-latex__math', source)
            : el('code', 'omni-latex__math omni-latex__math--inline', `$${source}$`);
        if (mathRenderer) {
            element.classList.add('is-pending');
            mathSlots.push({ element, source, display });
        }
        return element;
    };

    const renderMathSlot = (slot: MathSlot): void => {
        if (disposed || !mathRenderer || !purifier) return;
        slot.element.classList.remove('is-pending');
        try {
            const html = mathRenderer.renderToHtml(prepareMathSource(slot.source), slot.display, { macros });
            // The renderer is not trusted with the DOM: its output goes through
            // the core-owned math profile before insertion (L3).
            slot.element.innerHTML = purifier.sanitize(html, MATH_SANITIZE_PROFILE);
            slot.element.classList.add('is-rendered');
        } catch (error) {
            // One bad formula must not cost the reader the whole document (§3):
            // this slot keeps its TeX and is marked, the rest still renders.
            slot.element.classList.add('is-invalid');
            slot.element.title = t('latex.mathFailed');
            ctx.logger.log('warn', `latex math render failed: ${String(error)}`);
        }
    };

    /** Formulas render as they approach the viewport; a document with hundreds
     *  of equations must not pay for all of them before first paint (§4). */
    const scheduleMath = (): void => {
        if (!mathSlots.length || !mathRenderer) return;
        const immediate = options.renderAllMath || typeof IntersectionObserver === 'undefined';
        if (immediate) {
            for (const slot of mathSlots) renderMathSlot(slot);
            return;
        }
        const pending = new Map<Element, MathSlot>(mathSlots.map(slot => [slot.element, slot]));
        mathObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const slot = pending.get(entry.target);
                if (!slot) continue;
                pending.delete(entry.target);
                mathObserver?.unobserve(entry.target);
                renderMathSlot(slot);
            }
        }, { root: preview, rootMargin: '200px' });
        for (const slot of mathSlots) mathObserver.observe(slot.element);
    };

    const resetMath = (): void => {
        mathObserver?.disconnect();
        mathObserver = null;
        mathSlots = [];
    };

    // --- preview rendering -------------------------------------------------

    const renderInline = (nodes: readonly LatexInline[], into: Node): void => {
        for (const node of nodes) {
            if (node.kind === 'text') { into.appendChild(document.createTextNode(node.value)); continue; }
            if (node.kind === 'math') {
                into.appendChild(mathSlot(node.source, false));
                continue;
            }
            if (node.kind === 'emphasis') {
                const tag = node.style === 'bf' ? 'strong' : node.style === 'tt' ? 'code' : 'em';
                const wrapper = el(tag);
                renderInline(node.content, wrapper);
                into.appendChild(wrapper);
                continue;
            }
            if (node.kind === 'ref') { into.appendChild(renderRef(node.target)); continue; }
            if (node.kind === 'cite') { into.appendChild(el('span', 'omni-latex__cite', `[${node.keys.join(', ')}]`)); continue; }
            if (node.kind === 'link') { into.appendChild(renderLink(node.url, node.text)); continue; }
            into.appendChild(el('code', 'omni-latex__unsupported omni-latex__unsupported--inline', node.source));
        }
    };

    /** `\ref{x}` cannot show a number without a compile pass, so it shows the
     *  target key — and, when that key is labelled somewhere in this document,
     *  becomes a control that scrolls to it. Resolution happens on click so a
     *  reference to a later section still works. */
    const renderRef = (target: string): HTMLElement => {
        const node = el('button', 'omni-latex__ref', target);
        node.type = 'button';
        node.title = t('latex.goToReference', { target });
        onEphemeral(node, 'click', (() => {
            const destination = labelTargets.get(target);
            if (!destination) return;
            destination.scrollIntoView({ block: 'center' });
            destination.classList.add('is-target');
            setTimeout(() => destination.classList.remove('is-target'), 1200);
        }) as EventListener);
        return node;
    };

    const registerLabel = (label: string | undefined, element: HTMLElement): void => {
        if (label) labelTargets.set(label, element);
    };

    const renderLink = (url: string, text: string): HTMLElement => {
        // Scheme checking is core's job and happens before the service call
        // (DESIGN.md §6). It goes through the shared classifier rather than a
        // local prefix test so there is one place that decides what an external
        // link is — §6 objects to duplicated boundary logic, not just to gaps.
        const target = classifyAnchorTarget(url);
        const allowed = target.kind === 'absolute' && ALLOWED_LINK_SCHEMES.includes(target.url.protocol);
        const node = el('button', 'omni-latex__link', text || url);
        node.type = 'button';
        if (!allowed || !ctx.navigation) {
            node.disabled = true;
            node.title = t(allowed ? 'latex.navigationUnavailable' : 'latex.linkBlocked');
            return node;
        }
        const navigation = ctx.navigation;
        onEphemeral(node, 'click', (() => {
            void navigation.openExternalUrl(url).catch((error: unknown) => {
                ctx.logger.log('error', `latex link failed: ${String(error)}`);
            });
        }) as EventListener);
        return node;
    };

    const renderBlocks = (blocks: readonly LatexBlock[], into: Node): void => {
        for (const block of blocks) {
            if (block.kind === 'heading') {
                const level = Math.min(6, Math.max(1, block.level));
                const heading = document.createElement(`h${level}`);
                heading.id = block.id;
                renderInline(block.title, heading);
                registerLabel(block.label, heading);
                into.appendChild(heading);
                continue;
            }
            if (block.kind === 'paragraph') {
                const paragraph = el('p');
                renderInline(block.content, paragraph);
                into.appendChild(paragraph);
                continue;
            }
            if (block.kind === 'math') {
                const slot = mathSlot(block.source, block.display);
                registerLabel(block.label, slot);
                into.appendChild(slot);
                continue;
            }
            if (block.kind === 'list') {
                const list = el(block.ordered ? 'ol' : 'ul');
                for (const item of block.items) {
                    const entry = el('li');
                    renderBlocks(item, entry);
                    list.appendChild(entry);
                }
                into.appendChild(list);
                continue;
            }
            if (block.kind === 'theorem') {
                const theorem = el('section', 'omni-latex__theorem');
                const heading = el('div', 'omni-latex__theorem-title');
                heading.append(el('span', 'omni-latex__theorem-name', block.title));
                if (block.note) {
                    const note = el('span', 'omni-latex__theorem-note');
                    note.append(document.createTextNode('('));
                    renderInline(block.note, note);
                    note.append(document.createTextNode(')'));
                    heading.append(note);
                }
                theorem.append(heading);
                const body = el('div', 'omni-latex__theorem-body');
                renderBlocks(block.body, body);
                theorem.append(body);
                registerLabel(block.label, theorem);
                into.appendChild(theorem);
                continue;
            }
            if (block.kind === 'table') {
                const wrapper = el('div', 'omni-latex__table-wrap');
                const table = el('table', 'omni-latex__table');
                const body = el('tbody');
                block.rows.forEach((row, rowIndex) => {
                    const tr = el('tr');
                    let column = 0;
                    for (const cell of row) {
                        // The first row is treated as a header only when the
                        // table has more than one row; a one-row tabular is data.
                        const isHeader = rowIndex === 0 && block.rows.length > 1;
                        const td = el(isHeader ? 'th' : 'td');
                        const align = block.columns[column];
                        if (align) td.style.textAlign = align;
                        if (cell.span && cell.span > 1) td.colSpan = cell.span;
                        renderInline(cell.content, td);
                        tr.appendChild(td);
                        column += cell.span ?? 1;
                    }
                    body.appendChild(tr);
                });
                table.appendChild(body);
                wrapper.appendChild(table);
                into.appendChild(wrapper);
                continue;
            }
            if (block.kind === 'verbatim') {
                into.appendChild(el('pre', 'omni-latex__verbatim', block.source));
                continue;
            }
            if (block.kind === 'float') {
                const float = el('figure', 'omni-latex__float');
                const body = el('div', 'omni-latex__float-body');
                renderBlocks(block.blocks, body);
                float.append(body);
                if (block.caption) {
                    const caption = el('figcaption', 'omni-latex__float-caption');
                    renderInline(block.caption, caption);
                    float.append(caption);
                }
                into.appendChild(float);
                continue;
            }
            if (block.kind === 'include') {
                const included = el('section', 'omni-latex__include');
                included.append(el('div', 'omni-latex__include-label', t('latex.includedFrom', { path: block.path })));
                const body = el('div');
                renderBlocks(block.blocks, body);
                included.append(body);
                into.appendChild(included);
                continue;
            }
            if (block.kind === 'unresolved') {
                const unresolved = el('div', 'omni-latex__unsupported');
                unresolved.append(
                    el('div', 'omni-latex__badge', t('latex.unresolvedInput', { command: block.command })),
                    el('pre', undefined, `\\${block.command}{${block.path}}`)
                );
                into.appendChild(unresolved);
                continue;
            }
            const unsupported = el('div', 'omni-latex__unsupported');
            unsupported.append(
                el('div', 'omni-latex__badge', t('latex.unsupportedEnvironment', { environment: block.environment })),
                el('pre', undefined, block.source)
            );
            into.appendChild(unsupported);
        }
    };

    const renderOutline = (): void => {
        outlineList.replaceChildren();
        const outline = document_?.outline ?? [];
        if (!outline.length) {
            outlineList.appendChild(el('li', 'omni-latex__outline-empty', t('latex.outlineEmpty')));
            return;
        }
        for (const heading of outline) {
            const item = el('li', 'omni-latex__outline-item');
            const link = el('button', 'omni-latex__outline-link', heading.text || heading.id);
            link.type = 'button';
            link.dataset.headingId = heading.id;
            link.dataset.level = String(heading.level);
            link.classList.toggle('is-active', controller.state.selectedHeading === heading.id);
            onEphemeral(link, 'click', (() => selectHeading(heading)) as EventListener);
            item.appendChild(link);
            outlineList.appendChild(item);
        }
    };

    const selectHeading = (heading: LatexHeading): void => {
        controller.dispatch({ type: 'select-heading', id: heading.id });
        preview.querySelector(`#${cssEscape(heading.id)}`)?.scrollIntoView({ block: 'start' });
        // An included heading's span addresses *that* file, and the editor holds
        // the main one — moving its caret would point at unrelated text.
        if (heading.source) return;
        // Keep the two panes talking about the same place. No focus()/blur()
        // pair: setSelectionRange does not need focus, and taking it would move
        // the caret off the outline button the user just activated — losing a
        // keyboard user's place on every jump.
        sourceArea.setSelectionRange(heading.span.start, heading.span.start);
    };

    const renderDocument = (): void => {
        resetMath();
        labelTargets.clear();
        preview.replaceChildren();
        if (!document_) {
            // The outline and the class badge must go too: leaving the previous
            // document's entries beside an empty preview invites a click that
            // seeks to a span from a parse that no longer exists.
            previewCaption.textContent = t('latex.parseFailed');
            meta.textContent = '';
            renderOutline();
            return;
        }
        // KaTeX keys macros by their control sequence; the parser stores the
        // bare name (docs/viewers/latex.md §2).
        macros = {
            ...MATH_NOOP_MACROS,
            ...Object.fromEntries(
                Object.entries(document_.preamble.macros).map(([name, body]) => [`\\${name}`, body])
            )
        };
        renderBlocks(document_.body, preview);
        const captions = [t('latex.sectionCount', { count: document_.outline.length })];
        if (!mathRenderer && hasMath(document_.body)) captions.push(t('latex.mathNotInstalled'));
        previewCaption.textContent = captions.join(' · ');
        meta.textContent = document_.preamble.documentClass
            ? t('latex.documentClass', { name: document_.preamble.documentClass })
            : '';
        renderOutline();
        scheduleMath();
    };

    const applyParse = async (outcome: ReturnType<typeof parseLatex>): Promise<void> => {
        // Include resolution is async and its duration depends on the host, so
        // two quick re-renders can finish out of order. Only the newest may write.
        const generation = ++parseGeneration;
        if (outcome.result.status === 'failed') {
            document_ = null;
            showMessage(t(outcome.result.failure.messageKey, outcome.result.failure.args));
            setStatus('latex.invalid', 'invalid');
            controller.dispatch({ type: 'set-mode', mode: 'source' });
            renderDocument();
            return;
        }
        let parsed = outcome.result.document;
        let diagnostics = outcome.result.diagnostics;
        if (options.resolveInclude) {
            const resolved = await resolveIncludes(parsed, options.resolveInclude, {
                ...(options.parse ? { parse: options.parse } : {}),
                ...(options.includeLimits ? { limits: options.includeLimits } : {}),
                ...(options.signal ? { signal: options.signal } : {})
            });
            if (disposed || generation !== parseGeneration) return;
            parsed = {
                ...parsed,
                body: resolved.body,
                outline: resolved.outline,
                preamble: { ...parsed.preamble, macros: resolved.macros, theorems: resolved.theorems }
            };
            diagnostics = [...diagnostics, ...resolved.diagnostics];
        }
        document_ = parsed;
        showMessage('');
        showWarnings(diagnostics.filter(d => d.severity !== 'info').map(describe));
        setStatus('latex.parsed', 'valid');
        renderDocument();
    };

    const reparse = async (): Promise<void> => {
        const bytes = new TextEncoder().encode(controller.state.source);
        await applyParse(parseLatex(bytes, options.parse));
    };

    // --- state sync --------------------------------------------------------

    const syncState = (): void => {
        const state = controller.state;
        workspace.classList.toggle('is-split', state.mode === 'split');
        previewPanel.hidden = state.mode === 'source';
        sourcePanel.hidden = state.mode === 'preview';
        // Split is the editing view: the outline steps aside so the two panes
        // that matter get the full width. Keeping all three squeezed the editor
        // to a column too narrow to work in — and below the responsive
        // breakpoint it pushed the editor off the bottom of the viewport.
        outlinePanel.hidden = state.mode === 'split';
        for (const [mode, node] of modeButtons) node.classList.toggle('is-active', mode === state.mode);
        renderButton.classList.toggle('is-dirty', state.dirty);
        undoButton.disabled = !state.canUndo;
        redoButton.disabled = !state.canRedo;
        sourceCaption.textContent = t(state.dirty ? 'latex.edited' : 'latex.editable');
        for (const link of outlineList.querySelectorAll('.omni-latex__outline-link')) {
            link.classList.toggle('is-active', (link as HTMLElement).dataset.headingId === state.selectedHeading);
        }
    };

    const saveSource = async (): Promise<void> => {
        // Snapshot once: the write is async and the editor stays live, so
        // `controller.state.source` after the await may already be a later edit
        // than the bytes that reached the file.
        const saved = controller.state.source;
        const bytes = new TextEncoder().encode(saved);
        if (ctx.writeback) {
            try {
                await ctx.writeback.write(bytes);
                controller.dispatch({ type: 'mark-saved', source: saved });
                setStatus('common.savedToOriginal', 'valid');
            } catch (error) {
                ctx.logger.log('error', `latex save failed: ${String(error)}`);
                setStatus('common.saveFailed', 'invalid');
                showMessage(errorText(error, t('common.saveFailed')));
            }
            return;
        }
        if (ctx.save) {
            // A copy, not the original — dirty state stays set, matching the
            // markdown and diagram viewers.
            try {
                await ctx.save.saveFile(input.fileName, bytes, 'text/x-tex');
                setStatus('common.savedToOriginal', 'valid');
            } catch (error) {
                ctx.logger.log('error', `latex save failed: ${String(error)}`);
                setStatus('common.saveFailed', 'invalid');
                showMessage(errorText(error, t('common.saveFailed')));
            }
            return;
        }
        showMessage(t('common.noWriteback'));
        setStatus('common.saveFailed', 'invalid');
    };

    for (const [mode, node] of modeButtons) {
        on(node, 'click', (() => controller.dispatch({ type: 'set-mode', mode })) as EventListener);
    }
    on(sourceArea, 'input', (() => controller.dispatch({ type: 'edit-source', source: sourceArea.value })) as EventListener);
    on(sourceArea, 'keydown', (event => {
        const keyboard = event as KeyboardEvent;
        const key = keyboard.key.toLowerCase();
        const command = keyboard.metaKey || keyboard.ctrlKey;
        if (command && key === 'z') {
            keyboard.preventDefault();
            controller.dispatch({ type: keyboard.shiftKey ? 'redo' : 'undo' });
            sourceArea.value = controller.state.source;
        } else if (command && key === 'y') {
            keyboard.preventDefault();
            controller.dispatch({ type: 'redo' });
            sourceArea.value = controller.state.source;
        } else if (command && key === 's') {
            keyboard.preventDefault();
            // Sequenced: both settle status text, and with an include resolver
            // attached they finish out of order, so "saved" could be overwritten
            // by "parsed" (or the reverse).
            void reparse().then(saveSource);
        } else if (keyboard.shiftKey && keyboard.key === 'Enter') {
            keyboard.preventDefault();
            void reparse();
        }
    }) as EventListener);
    on(renderButton, 'click', (() => void reparse()) as EventListener);
    on(undoButton, 'click', (() => { controller.dispatch({ type: 'undo' }); sourceArea.value = controller.state.source; }) as EventListener);
    on(redoButton, 'click', (() => { controller.dispatch({ type: 'redo' }); sourceArea.value = controller.state.source; }) as EventListener);
    on(copyButton, 'click', (() => {
        if (!ctx.clipboard) return;
        void ctx.clipboard.writeText(controller.state.source)
            .then(() => setStatus('latex.sourceCopied', 'valid'))
            .catch((error: unknown) => ctx.logger.log('error', `latex copy failed: ${String(error)}`));
    }) as EventListener);

    if (!ctx.clipboard) { copyButton.disabled = true; copyButton.title = t('common.noClipboard'); }

    disposers.push(controller.subscribe(syncState));
    await applyParse(initial);
    syncState();

    // One teardown for both exits. An abort arriving during the async parse used
    // to take a shortened path that left the observer connected and the scope
    // class (or the injected <style>) on a container the host considers unused.
    const teardown = (): void => {
        if (disposed) return;
        disposed = true;
        resetMath();
        for (const dispose of disposers.splice(0)) dispose();
        shell.remove();
        if (root === container) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--latex');
        else root.replaceChildren();
    };

    if (options.signal?.aborted) {
        teardown();
        throw new MountAbortedError();
    }

    // Reads the controller rather than the textarea: the source of truth for
    // "unsaved" is `source !== savedSource`, which undo restores and `mark-saved`
    // clears. A Save As copy never dispatches `mark-saved`, so it stays dirty.
    return { dispose: teardown, isDirty: () => controller.state.dirty };
}

function errorText(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
}

/**
 * Commands that produce no glyphs but that math engines do not implement.
 * Collecting the document's own macros (L18) means a text-mode macro can now
 * expand *inside* a formula — `\cn{over}` becomes
 * `{\protect\normalfont\ttfamily\bslash over}` — turning one unknown command
 * into four. Mapping them to nothing lets the readable part through.
 * The document's own definitions always win: these are merged underneath.
 */
export const MATH_NOOP_MACROS: Readonly<Record<string, string>> = {
    '\\protect': '', '\\relax': '', '\\ignorespaces': '', '\\noindent': '',
    '\\normalfont': '', '\\rmfamily': '', '\\sffamily': '', '\\ttfamily': '',
    '\\mdseries': '', '\\bfseries': '', '\\itshape': '', '\\upshape': '',
    '\\slshape': '', '\\scshape': '', '\\normalsize': '', '\\bslash': '\\backslash'
};

/**
 * Cross-reference commands are removed before the formula reaches the engine.
 * They are not typesetting: LaTeX prints *nothing* for `\label`, and `\ref`
 * prints a number that only a full compile pass can know. Math engines do not
 * implement either, so leaving them in makes the engine draw its unknown-command
 * marker in the middle of an otherwise correct formula. `\ref` degrades to its
 * target key, matching how references outside math are shown — the parser keeps
 * the untouched source for the TeX fallback.
 */
export function prepareMathSource(source: string): string {
    return source
        .replace(/\\label\s*\{[^}]*\}/g, '')
        .replace(/\\(?:eqref|autoref|pageref|Cref|cref|ref)\s*\{([^}]*)\}/g,
            (_whole, target: string) => `\\text{${target}}`);
}

/** Whether the document contains any formula, so the "no math renderer" note
 *  is shown only where it would actually change what the reader sees. */
function hasMath(blocks: readonly LatexBlock[]): boolean {
    return blocks.some(block =>
        block.kind === 'math'
        || (block.kind === 'paragraph' && block.content.some(node => node.kind === 'math'))
        || (block.kind === 'heading' && block.title.some(node => node.kind === 'math'))
        || (block.kind === 'list' && block.items.some(item => hasMath(item)))
        || (block.kind === 'theorem' && hasMath(block.body))
        || (block.kind === 'include' && hasMath(block.blocks))
        || (block.kind === 'table' && block.rows.some(row => row.some(cell => cell.content.some(node => node.kind === 'math'))))
        || (block.kind === 'float' && (hasMath(block.blocks) || (block.caption ?? []).some(node => node.kind === 'math')))
    );
}

/** Heading ids are core-generated (`heading-3`), so escaping only needs to
 *  cover the leading-digit case CSS selectors reject. */
function cssEscape(id: string): string {
    return /^[A-Za-z_-][\w-]*$/.test(id) ? id : id.replace(/[^\w-]/g, '\\$&');
}
