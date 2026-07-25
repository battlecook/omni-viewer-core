import type { ClipboardService, FileSaveService, FileWritebackService, HostContext } from '../host/index.js';
import { createDiagramController, MERMAID_THEMES, PLANTUML_THEMES, type DiagramKind, type DiagramTheme, type DiagramViewMode } from './diagram-controller.js';
import { diagramViewerCss } from './diagram-styles.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from './types.js';

export { diagramViewerCss } from './diagram-styles.js';
export { createDiagramController, type DiagramAction, type DiagramController, type DiagramKind, type DiagramTheme, type DiagramViewMode, type DiagramViewState } from './diagram-controller.js';

export type DiagramViewerContext = HostContext & {
    clipboard?: ClipboardService;
    writeback?: FileWritebackService;
    save?: FileSaveService;
};
export interface DiagramMountOptions extends MountOptions {
    renderMermaid?(id: string, source: string, theme?: DiagramTheme): Promise<string>;
    renderPlantUml?(source: string, document: Document, theme?: DiagramTheme): SVGElement | string;
    maxSvgBytes?: number;
    maxSvgNodes?: number;
    /** Initial theme the adapter wants (e.g. matching the host app's dark mode).
     *  Ignored if the kind does not support it; falls back to the kind default. */
    initialTheme?: DiagramTheme;
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;

export async function mountDiagramViewer(
    kind: DiagramKind,
    parsed: { source: string; warnings: string[] },
    input: ViewerInput,
    container: HTMLElement,
    ctx: DiagramViewerContext,
    options: DiagramMountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const themes = kind === 'mermaid' ? MERMAID_THEMES : PLANTUML_THEMES;
    const initialTheme: DiagramTheme = options.initialTheme && themes.includes(options.initialTheme) ? options.initialTheme : themes[0]!;
    const hasRenderer = kind === 'mermaid' ? Boolean(options.renderMermaid) : Boolean(options.renderPlantUml);

    const root: HTMLElement | ShadowRoot = options.styleIsolation !== 'scoped' && typeof container.attachShadow === 'function'
        ? (container.shadowRoot ?? container.attachShadow({ mode: 'open' })) : container;
    if (root === container) container.classList.add(VIEWER_ROOT_CLASS, `omni-viewer--${kind}`);
    else { const style = document.createElement('style'); style.textContent = diagramViewerCss; root.append(style); }

    const t = ctx.i18n.t.bind(ctx.i18n);
    const controller = createDiagramController(parsed.source, initialTheme);
    const disposers: Array<() => void> = [];
    let disposed = false;
    let renderVersion = 0;
    let renderedSvg = '';
    let zoom = 1;

    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
        const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
    };
    const on = (node: EventTarget, type: string, listener: EventListener): void => {
        node.addEventListener(type, listener); disposers.push(() => node.removeEventListener(type, listener));
    };
    const button = (key: string, className = 'omni-diagram__button'): HTMLButtonElement => {
        const node = el('button', className, t(key)); node.type = 'button'; return node;
    };

    const shell = el('section', `${VIEWER_ROOT_CLASS} omni-viewer--${kind} omni-diagram omni-diagram--${kind}`);
    const header = el('header', 'omni-diagram__header');
    header.append(el('div', 'omni-diagram__title', input.fileName), el('div', undefined, kind === 'mermaid' ? 'Mermaid' : 'PlantUML'));
    const status = el('div', 'omni-diagram__status', t('diagram.ready'));
    header.append(status);

    const toolbar = el('div', 'omni-diagram__toolbar');
    const modeGroup = el('div', 'omni-diagram__toolbar-group');
    const modeButtons = new Map<DiagramViewMode, HTMLButtonElement>();
    for (const [mode, key] of [['diagram', 'diagram.diagram'], ['split', 'diagram.split'], ['source', 'diagram.source']] as const) {
        const node = button(key); node.dataset.viewMode = mode; modeButtons.set(mode, node); modeGroup.append(node);
    }
    const actionGroup = el('div', 'omni-diagram__toolbar-group');
    const renderButton = button('diagram.render', 'omni-diagram__button omni-diagram__button--primary');
    const undoButton = button('diagram.undo'); const redoButton = button('diagram.redo');
    actionGroup.append(renderButton, undoButton, redoButton);
    const zoomGroup = el('div', 'omni-diagram__toolbar-group');
    const zoomOutButton = button('diagram.zoomOut'); zoomOutButton.textContent = '−';
    const zoomLabel = el('span', 'omni-diagram__zoom-label', '100%');
    const zoomInButton = button('diagram.zoomIn'); zoomInButton.textContent = '+';
    const zoomResetButton = button('diagram.zoomReset'); zoomResetButton.textContent = '100%';
    zoomGroup.append(zoomOutButton, zoomLabel, zoomInButton, zoomResetButton);
    const themeGroup = el('div', 'omni-diagram__toolbar-group');
    const themeSelect = el('select', 'omni-diagram__select'); themeSelect.title = t('diagram.theme');
    for (const theme of themes) { const opt = el('option', undefined, theme); opt.value = theme; themeSelect.append(opt); }
    themeSelect.value = initialTheme;
    themeGroup.append(themeSelect);
    const copyGroup = el('div', 'omni-diagram__toolbar-group');
    const copySvgButton = button('diagram.copySvg'); const copySourceButton = button('diagram.copySource');
    copyGroup.append(copySvgButton, copySourceButton);
    toolbar.append(modeGroup, actionGroup, zoomGroup, themeGroup, copyGroup);

    const workspace = el('main', 'omni-diagram__workspace');
    const stagePanel = el('section', 'omni-diagram__panel omni-diagram__stage-panel');
    const stageHeader = el('div', 'omni-diagram__panel-header');
    const stageCaption = el('span', 'omni-diagram__caption', t('diagram.ready'));
    stageHeader.append(el('span', undefined, t('diagram.diagram')), stageCaption);
    const stage = el('div', 'omni-diagram__stage'); stage.setAttribute('role', 'img');
    const stageInner = el('div', 'omni-diagram__stage-inner');
    stage.append(stageInner); stagePanel.append(stageHeader, stage);
    const sourcePanel = el('section', 'omni-diagram__panel omni-diagram__source-panel');
    const sourceHeader = el('div', 'omni-diagram__panel-header');
    const sourceCaption = el('span', 'omni-diagram__caption', t('diagram.editable'));
    sourceHeader.append(el('span', undefined, t('diagram.source')), sourceCaption);
    const source = el('textarea', 'omni-diagram__source'); source.spellcheck = false; source.value = parsed.source;
    sourcePanel.append(sourceHeader, source);
    workspace.append(stagePanel, sourcePanel);

    const warning = el('div', 'omni-diagram__warning'); warning.hidden = true;
    const message = el('div', 'omni-diagram__message'); message.hidden = true;
    shell.append(header, toolbar, workspace, warning, message); root.append(shell);

    const setStatus = (key: string, kind2 = ''): void => {
        status.textContent = t(key); status.className = `omni-diagram__status${kind2 ? ` is-${kind2}` : ''}`;
    };
    const showMessage = (text: string): void => { message.textContent = text; message.hidden = !text; };
    const showWarnings = (values: string[]): void => { warning.hidden = values.length === 0; warning.textContent = values.join('\n'); };
    const applyZoom = (): void => { stageInner.style.transform = `scale(${zoom})`; zoomLabel.textContent = `${Math.round(zoom * 100)}%`; };
    const setZoom = (value: number): void => { zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100)); applyZoom(); };
    const syncState = (): void => {
        const state = controller.state;
        workspace.classList.toggle('is-split', state.mode === 'split');
        stagePanel.hidden = state.mode === 'source'; sourcePanel.hidden = state.mode === 'diagram';
        for (const [mode, node] of modeButtons) node.classList.toggle('is-active', mode === state.mode);
        renderButton.classList.toggle('is-dirty', state.dirty);
        undoButton.disabled = !state.canUndo; redoButton.disabled = !state.canRedo;
        themeSelect.value = state.theme;
        sourceCaption.textContent = t(state.dirty ? 'diagram.edited' : 'diagram.editable');
        if (state.dirty) setStatus('diagram.modified');
    };

    const renderDiagram = async (save: boolean): Promise<void> => {
        const version = ++renderVersion; showMessage('');
        if (!hasRenderer) {
            controller.dispatch({ type: 'set-mode', mode: 'source' });
            showMessage(t('diagram.notInstalled')); stageCaption.textContent = t('diagram.notInstalled'); setStatus('diagram.ready');
            return;
        }
        setStatus('diagram.rendering'); stageCaption.textContent = t('diagram.rendering');
        try {
            const src = controller.state.source; const theme = controller.state.theme;
            // The engine renders a dark-backgrounded SVG for the dark theme; match
            // the stage padding around it so it doesn't sit on a white gutter.
            stage.classList.toggle('is-theme-dark', theme === 'dark');
            let svg: string;
            if (kind === 'mermaid') svg = await abortable(options.renderMermaid!(`omni-mermaid-${nextId++}`, src, theme), options.signal);
            else { const out = options.renderPlantUml!(src, document, theme); svg = typeof out === 'string' ? out : new XMLSerializer().serializeToString(out); }
            if (disposed || version !== renderVersion) return;
            const safe = sanitizeSvg(svg, options.maxSvgBytes ?? 2_000_000, options.maxSvgNodes ?? 20_000);
            renderedSvg = new XMLSerializer().serializeToString(safe);
            stageInner.replaceChildren(safe);
            stageCaption.textContent = t('diagram.rendered'); setStatus('diagram.rendered', 'valid');
            if (save) await saveSource();
        } catch (error) {
            if (error instanceof MountAbortedError || disposed || version !== renderVersion) return;
            stageInner.replaceChildren(); renderedSvg = '';
            stageCaption.textContent = t('diagram.renderFailed'); setStatus('diagram.invalid', 'invalid');
            showMessage(errorText(error, t('diagram.renderFailed')));
        }
    };
    const saveSource = async (): Promise<void> => {
        const bytes = new TextEncoder().encode(controller.state.source);
        if (ctx.writeback) {
            try { await ctx.writeback.write(bytes); controller.dispatch({ type: 'mark-saved' }); setStatus('common.savedToOriginal', 'valid'); sourceCaption.textContent = t('common.savedToOriginal'); }
            catch (error) { ctx.logger.log('error', `diagram save failed: ${String(error)}`); setStatus('common.saveFailed', 'invalid'); showMessage(errorText(error, t('common.saveFailed'))); }
            return;
        }
        if (ctx.save) {
            // Download fallback saves a copy, not the original — dirty state is
            // intentionally kept (no mark-saved), mirroring the markdown viewer.
            try { await ctx.save.saveFile(input.fileName, bytes, 'text/plain'); setStatus('common.savedToOriginal', 'valid'); }
            catch (error) { ctx.logger.log('error', `diagram save failed: ${String(error)}`); setStatus('common.saveFailed', 'invalid'); showMessage(errorText(error, t('common.saveFailed'))); }
            return;
        }
        showMessage(t('common.noWriteback')); setStatus('common.saveFailed', 'invalid');
    };
    const copy = async (value: string, successKey: string): Promise<void> => {
        if (!ctx.clipboard || !value) return;
        try { await ctx.clipboard.writeText(value); setStatus(successKey, 'valid'); }
        catch (error) { ctx.logger.log('error', `diagram copy failed: ${String(error)}`); }
    };

    for (const [mode, node] of modeButtons) on(node, 'click', (() => controller.dispatch({ type: 'set-mode', mode })) as EventListener);
    on(source, 'input', (() => controller.dispatch({ type: 'edit-source', source: source.value })) as EventListener);
    on(source, 'keydown', (event => {
        const keyboard = event as KeyboardEvent; const key = keyboard.key.toLowerCase(); const command = keyboard.metaKey || keyboard.ctrlKey;
        if (command && key === 'z') { keyboard.preventDefault(); controller.dispatch({ type: keyboard.shiftKey ? 'redo' : 'undo' }); source.value = controller.state.source; }
        else if (command && key === 'y') { keyboard.preventDefault(); controller.dispatch({ type: 'redo' }); source.value = controller.state.source; }
        else if (command && key === 's') { keyboard.preventDefault(); if (ctx.writeback) void renderDiagram(true); else void saveSource(); }
        else if (keyboard.shiftKey && keyboard.key === 'Enter') { keyboard.preventDefault(); void renderDiagram(Boolean(ctx.writeback)); }
    }) as EventListener);
    on(renderButton, 'click', (() => void renderDiagram(Boolean(ctx.writeback))) as EventListener);
    on(undoButton, 'click', (() => { controller.dispatch({ type: 'undo' }); source.value = controller.state.source; }) as EventListener);
    on(redoButton, 'click', (() => { controller.dispatch({ type: 'redo' }); source.value = controller.state.source; }) as EventListener);
    on(zoomOutButton, 'click', (() => setZoom(zoom - 0.25)) as EventListener);
    on(zoomInButton, 'click', (() => setZoom(zoom + 0.25)) as EventListener);
    on(zoomResetButton, 'click', (() => setZoom(1)) as EventListener);
    on(themeSelect, 'change', (() => { controller.dispatch({ type: 'set-theme', theme: themeSelect.value as DiagramTheme }); void renderDiagram(false); }) as EventListener);
    on(copySvgButton, 'click', (() => void copy(renderedSvg, 'diagram.svgCopied')) as EventListener);
    on(copySourceButton, 'click', (() => void copy(source.value, 'diagram.sourceCopied')) as EventListener);

    if (!hasRenderer) for (const node of [renderButton, zoomOutButton, zoomInButton, zoomResetButton, copySvgButton, themeSelect]) { node.disabled = true; }
    if (!ctx.clipboard) for (const node of [copySvgButton, copySourceButton]) { node.disabled = true; node.title = t('common.noClipboard'); }

    const off = controller.subscribe(syncState); disposers.push(off);
    syncState(); applyZoom(); showWarnings(parsed.warnings);
    await renderDiagram(false);
    if (options.signal?.aborted) { disposed = true; renderVersion++; shell.remove(); for (const dispose of disposers.splice(0)) dispose(); throw new MountAbortedError(); }
    return {
        dispose() {
            disposed = true; renderVersion++;
            for (const dispose of disposers.splice(0)) dispose();
            shell.remove();
            if (root === container) container.classList.remove(VIEWER_ROOT_CLASS, `omni-viewer--${kind}`); else root.replaceChildren();
        }
    };
}

let nextId = 1;

function errorText(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }

export function sanitizeSvg(svg: string, maxBytes = 2_000_000, maxNodes = 20_000): SVGElement {
    if (new TextEncoder().encode(svg).byteLength > maxBytes) throw new Error('Rendered SVG exceeds the size limit.');
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const root = doc.documentElement;
    if (root.localName !== 'svg' || root.querySelector('parsererror')) throw new Error('Renderer returned invalid SVG.');
    const nodes = [root, ...root.querySelectorAll('*')];
    if (nodes.length > maxNodes) throw new Error('Rendered SVG exceeds the node limit.');
    for (const node of nodes) {
        if (['script', 'foreignObject', 'iframe', 'object', 'embed', 'audio', 'video', 'image', 'feImage', 'animate', 'set'].includes(node.localName)) { node.remove(); continue; }
        if (node.localName === 'style' && /(?:@import|url\s*\(|expression\s*\()/i.test(node.textContent ?? '')) { node.remove(); continue; }
        for (const attr of [...node.attributes]) {
            const name = attr.name.toLowerCase(), value = attr.value.trim();
            if (name.startsWith('on') || name === 'srcdoc' || /^javascript:/i.test(value) || /url\s*\(\s*(?!["']?#)/i.test(value) || name === 'style' && /url\s*\(/i.test(value) || ['href', 'xlink:href'].includes(name) && !value.startsWith('#')) node.removeAttribute(attr.name);
        }
    }
    return document.importNode(root, true) as unknown as SVGElement;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new MountAbortedError());
    return new Promise<T>((resolve, reject) => {
        const abort = (): void => reject(new MountAbortedError());
        signal.addEventListener('abort', abort, { once: true });
        promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
}
