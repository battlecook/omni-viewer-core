import type { ClipboardService, FileSaveService, FileWritebackService, HostContext } from '../host/index.js';
import { asciiLower } from '../parsers/csv/index.js';
import { VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from './types.js';

export interface StructuredRange { start: number; end: number; }
export interface StructuredNode { key: string; path: string; kind: string; raw?: string; value?: unknown; comment?: string; range?: StructuredRange; children?: readonly StructuredNode[]; }
export interface StructuredState { text: string; mode: 'tree' | 'flat' | 'json' | 'raw'; search: string; expanded: ReadonlySet<string>; diagnostics: readonly { messageKey: string; args?: Record<string, string | number>; location?: string }[]; searchScope?: string; searchScopes?: readonly string[]; selected?: string | null; matchCount?: number; }
/** The optional members are progressive enhancements: a controller that omits
 * them simply renders without source sync, scoped search or a match count. */
export interface StructuredController<S extends StructuredState> { readonly state: S; subscribe(listener: (state: S) => void): () => void; dispatch(action: unknown): void; nodePath(id: string): string; nodeValue(id: string): string; nodeJson?(id: string): string; documentJson?(): string; nodeRange?(id: string): StructuredRange | null; nodeAtOffset?(offset: number): string | null; nodeMatches?(node: StructuredNode): boolean; }
export type StructuredContext = HostContext & { clipboard?: ClipboardService; save?: FileSaveService; writeback?: FileWritebackService };
export type StructuredSourceHighlighter = (target: HTMLElement, text: string) => void;

export function mountStructured<S extends StructuredState>(input: ViewerInput, container: HTMLElement, ctx: StructuredContext, options: MountOptions, className: string, css: string, controller: StructuredController<S>, sourceHighlighter?: StructuredSourceHighlighter): ViewerHandle {
    let root: HTMLElement | ShadowRoot;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && typeof container.attachShadow === 'function') { root = container.shadowRoot ?? container.attachShadow({ mode: 'open' }); const style = document.createElement('style'); style.textContent = css; root.append(style); }
    else { container.classList.add(VIEWER_ROOT_CLASS, className); root = container; }
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, value?: string): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); if (cls) node.className = cls; if (value !== undefined) node.textContent = value; return node; };
    const frame = el('div', 'omni-structured'); root.append(frame); const disposers: Array<() => void> = [];
    const on = <K extends keyof HTMLElementEventMap>(node: HTMLElement, type: K, listener: (event: HTMLElementEventMap[K]) => void): void => { node.addEventListener(type, listener as EventListener); disposers.push(() => node.removeEventListener(type, listener as EventListener)); };
    const toolbar = el('div', 'omni-structured__bar');
    const expand = el('button', undefined, ctx.i18n.t('structured.expandAll')); const collapse = el('button', undefined, ctx.i18n.t('structured.collapseAll')); const search = el('input', 'omni-structured__search') as HTMLInputElement; const scopeSelect = el('select', 'omni-structured__scope') as HTMLSelectElement; const documentSelect = el('select') as HTMLSelectElement; const save = el('button', undefined, ctx.i18n.t('json.save')); const saveAs = el('button', undefined, ctx.i18n.t('json.saveAs'));
    search.type = 'search'; search.placeholder = ctx.i18n.t('structured.search'); [expand, collapse, save, saveAs].forEach(button => { button.type = 'button'; });
    const scopes = controller.state.searchScopes ?? []; scopeSelect.title = ctx.i18n.t('structured.scopeLabel'); scopeSelect.setAttribute('aria-label', ctx.i18n.t('structured.scopeLabel'));
    for (const scope of scopes) { const option = el('option', undefined, ctx.i18n.t(`structured.scope.${scope}`)); option.value = scope; scopeSelect.append(option); }
    on(scopeSelect, 'change', () => controller.dispatch({ type: 'set-search-scope', scope: scopeSelect.value }));
    const status = el('span', 'omni-structured__status'); status.setAttribute('aria-live', 'polite');
    on(expand, 'click', () => controller.dispatch({ type: 'expand-all' })); on(collapse, 'click', () => controller.dispatch({ type: 'collapse-all' })); on(search, 'input', () => controller.dispatch({ type: 'set-search', search: search.value })); on(save, 'click', () => { if (ctx.writeback) void ctx.writeback.write(new TextEncoder().encode(controller.state.text)); }); on(saveAs, 'click', () => { if (ctx.save) void ctx.save.saveFile(input.fileName, new TextEncoder().encode(controller.state.text), 'text/plain'); }); toolbar.append(expand, collapse, search); if (scopes.length) toolbar.append(scopeSelect); toolbar.append(documentSelect, save, saveAs, status);
    const diagnostics = el('div', 'omni-structured__diagnostics'); diagnostics.setAttribute('aria-live', 'polite'); const workspace = el('div', 'omni-structured__workspace');
    const sourcePane = el('section', 'omni-structured__pane omni-structured__editor-pane'); const sourceHeader = el('header', 'omni-structured__pane-header'); sourceHeader.append(el('strong', undefined, ctx.i18n.t('json.editor.title')), el('span', undefined, ctx.i18n.t('json.editor.description'))); const editor = el('textarea', 'omni-structured__editor') as HTMLTextAreaElement; editor.spellcheck = false; on(editor, 'input', () => controller.dispatch({ type: 'edit-source', text: editor.value })); const sourceHighlight = sourceHighlighter ? el('pre', 'omni-structured__source-highlight') : undefined;
    if (sourceHighlight) { const surface = el('div', 'omni-structured__source-surface'); surface.append(sourceHighlight, editor); on(editor, 'scroll', () => { sourceHighlight.scrollTop = editor.scrollTop; sourceHighlight.scrollLeft = editor.scrollLeft; }); sourcePane.classList.add('omni-structured__pane--highlighted-source'); sourcePane.append(sourceHeader, surface); } else sourcePane.append(sourceHeader, editor);
    const previewPane = el('section', 'omni-structured__pane omni-structured__preview-pane'); const previewHeader = el('header', 'omni-structured__pane-header'); const treeMode = el('button', undefined, ctx.i18n.t('structured.tree')); const flatMode = el('button', undefined, ctx.i18n.t('structured.flat')); const jsonMode = el('button', undefined, ctx.i18n.t('structured.json')); const rawMode = el('button', undefined, ctx.i18n.t('structured.raw')); treeMode.type = flatMode.type = jsonMode.type = rawMode.type = 'button'; on(treeMode, 'click', () => controller.dispatch({ type: 'set-mode', mode: 'tree' })); on(flatMode, 'click', () => controller.dispatch({ type: 'set-mode', mode: 'flat' })); on(jsonMode, 'click', () => controller.dispatch({ type: 'set-mode', mode: 'json' })); on(rawMode, 'click', () => controller.dispatch({ type: 'set-mode', mode: 'raw' })); const modes = el('span', 'omni-structured__preview-modes'); modes.append(treeMode, flatMode); if (controller.documentJson) modes.append(jsonMode); modes.append(rawMode); previewHeader.append(el('strong', undefined, ctx.i18n.t('json.preview.title')), el('span', undefined, ctx.i18n.t('structured.treeDescription')), modes); const treeBody = el('div', 'omni-structured__tree'); const flatBody = el('div', 'omni-structured__tree omni-structured__flat'); const jsonPreview = el('pre', 'omni-structured__json-preview'); const rawPreview = el('pre', 'omni-structured__raw-preview'); const previewBody = el('div', 'omni-structured__preview-body'); previewBody.append(treeBody, flatBody, jsonPreview, rawPreview); previewPane.append(previewHeader, previewBody); workspace.append(sourcePane, previewPane); frame.append(toolbar, diagnostics, workspace);
    const copy = (value: string | undefined): void => { if (value !== undefined) void ctx.clipboard?.writeText(value); };
    // Cursor sync only exists when the controller can map ids to source ranges.
    const syncsSource = !!controller.nodeRange && !!controller.nodeAtOffset;
    const revealSource = (id: string): void => {
        const range = controller.nodeRange?.(id); if (!range) return;
        editor.focus(); editor.setSelectionRange(range.start, range.end);
        const line = controller.state.text.slice(0, range.start).split('\n').length - 1;
        const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 20;
        editor.scrollTop = Math.max(0, line * lineHeight - editor.clientHeight / 2);
        if (sourceHighlight) { sourceHighlight.scrollTop = editor.scrollTop; sourceHighlight.scrollLeft = editor.scrollLeft; }
    };
    const selectNode = (id: string, reveal: boolean): void => { controller.dispatch({ type: 'select-node', id }); if (reveal) revealSource(id); };
    // Every keystroke passes through here, so skip the re-render unless the
    // caret actually moved onto a different node.
    if (syncsSource) { const fromCursor = (): void => { const id = controller.nodeAtOffset!(editor.selectionStart); if (id !== (controller.state.selected ?? null)) controller.dispatch({ type: 'select-offset', offset: editor.selectionStart }); }; on(editor, 'click', fromCursor); on(editor, 'keyup', fromCursor); }
    const matchesQuery = (node: StructuredNode, query: string): boolean => controller.nodeMatches ? controller.nodeMatches(node) : !query || asciiLower(`${node.key} ${node.path} ${node.raw ?? node.value ?? ''}`).includes(query);
    const subtreeMatches = (node: StructuredNode, query: string): boolean => matchesQuery(node, query) || !!node.children?.some(child => subtreeMatches(child, query));
    /** Containers whose own text is empty preview their size instead. */
    const valueText = (node: StructuredNode): string => {
        const raw = node.raw ?? (node.value === undefined ? '' : String(node.value));
        if (raw || !node.children?.length) return raw;
        const count = node.children.length;
        return node.kind === 'array' || node.kind === 'seq'
            ? `[ ${ctx.i18n.t('structured.itemCount', { count })} ]`
            : `{ ${ctx.i18n.t('structured.keyCount', { count })} }`;
    };
    const renderFlatRows = (node: StructuredNode, query: string, state: S, out: HTMLElement[]): void => {
        if (node.children?.length) { for (const child of node.children) renderFlatRows(child, query, state, out); return; }
        if (!matchesQuery(node, query)) return;
        const id = node.path || '$'; const row = el('div', 'omni-structured__node omni-structured__flat-row');
        if (state.selected === id) row.classList.add('omni-structured__node--selected');
        row.append(el('span', 'omni-structured__key', id), el('span', 'omni-structured__kind', node.kind), el('span', 'omni-structured__value', valueText(node)));
        if (syncsSource) { row.tabIndex = 0; row.classList.add('omni-structured__node--interactive'); row.addEventListener('click', () => selectNode(id, true)); row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectNode(id, true); } }); }
        out.push(row);
    };
    const renderNode = (node: StructuredNode, depth: number, state: S): HTMLElement | null => {
        const id = node.path || '$', query = asciiLower(state.search.trim()); if (!subtreeMatches(node, query)) return null;
        const wrap = el('div'); const row = el('div', 'omni-structured__node'); row.style.paddingInlineStart = `${depth * 16}px`;
        if (state.selected === id) row.classList.add('omni-structured__node--selected');
        const hasChildren = !!node.children?.length;
        if (hasChildren) { const toggle = el('button', 'omni-structured__toggle', state.expanded.has(id) ? '▾' : '▸'); toggle.type = 'button'; toggle.setAttribute('aria-expanded', String(state.expanded.has(id))); toggle.setAttribute('aria-label', ctx.i18n.t(state.expanded.has(id) ? 'structured.collapse' : 'structured.expand')); toggle.addEventListener('click', event => { event.stopPropagation(); controller.dispatch({ type: 'toggle-node', id }); }); row.append(toggle); } else row.append(el('span', 'omni-structured__toggle'));
        row.append(el('span', 'omni-structured__key', node.key || '$'), el('span', 'omni-structured__kind', node.kind), el('span', 'omni-structured__value', valueText(node)));
        if (node.comment) row.append(el('span', 'omni-structured__node-comment', `# ${node.comment.replace(/\n/g, ' ')}`));
        if (syncsSource) { row.tabIndex = 0; row.classList.add('omni-structured__node--interactive'); row.addEventListener('click', () => selectNode(id, true)); row.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); selectNode(id, true); } }); }
        const actions = el('span', 'omni-structured__actions');
        for (const [key, value] of [['structured.copyPath', controller.nodePath(id)], ['structured.copyValue', controller.nodeValue(id)], ['structured.copyJson', controller.nodeJson?.(id)]] as const) { if (value === undefined) continue; const button = el('button', undefined, ctx.i18n.t(key)); button.type = 'button'; button.disabled = !ctx.clipboard; button.title = ctx.clipboard ? '' : ctx.i18n.t('common.noClipboard'); button.addEventListener('click', event => { event.stopPropagation(); copy(value); }); actions.append(button); }
        row.append(actions); wrap.append(row);
        if (hasChildren && state.expanded.has(id)) for (const child of node.children!) { const rendered = renderNode(child, depth + 1, state); if (rendered) wrap.append(rendered); }
        return wrap;
    };
    let lastSelected: string | null | undefined;
    const statusText = (state: S): string => {
        const parts: string[] = [];
        if (state.selected) parts.push(controller.nodePath(state.selected) || '$');
        if (state.search.trim() && state.matchCount !== undefined) parts.push(ctx.i18n.t('structured.matchCount', { count: state.matchCount }));
        return parts.join(' · ');
    };
    const render = (state: S): void => { if (editor.value !== state.text && document.activeElement !== editor) editor.value = state.text; editor.rows = Math.min(state.text.split('\n').length + 1, 200); if (sourceHighlight && sourceHighlighter) sourceHighlighter(sourceHighlight, state.text); if (sourceHighlighter) sourceHighlighter(rawPreview, state.text); else rawPreview.textContent = state.text; search.value = state.search; if (state.searchScope !== undefined) scopeSelect.value = state.searchScope; status.textContent = statusText(state); treeMode.setAttribute('aria-pressed', String(state.mode === 'tree')); flatMode.setAttribute('aria-pressed', String(state.mode === 'flat')); jsonMode.setAttribute('aria-pressed', String(state.mode === 'json')); rawMode.setAttribute('aria-pressed', String(state.mode === 'raw')); treeBody.style.display = state.mode === 'tree' ? '' : 'none'; flatBody.style.display = state.mode === 'flat' ? '' : 'none'; jsonPreview.style.display = state.mode === 'json' ? '' : 'none'; rawPreview.style.display = state.mode === 'raw' ? '' : 'none'; jsonPreview.textContent = state.mode === 'json' ? controller.documentJson?.() ?? '' : ''; expand.disabled = collapse.disabled = state.mode !== 'tree'; save.disabled = !ctx.writeback; save.title = ctx.writeback ? '' : ctx.i18n.t('common.noWriteback'); saveAs.disabled = !ctx.save; saveAs.title = ctx.save ? '' : ctx.i18n.t('common.noFileSave'); diagnostics.replaceChildren(); diagnostics.style.display = state.diagnostics.length ? '' : 'none'; for (const diagnostic of state.diagnostics) diagnostics.append(el('div', undefined, `${ctx.i18n.t(diagnostic.messageKey, diagnostic.args)}${diagnostic.location ? ` (${diagnostic.location})` : ''}`)); const shaped = state as S & { root?: StructuredNode; documents?: readonly StructuredNode[]; selectedDocument?: number }; const docs = shaped.documents; documentSelect.replaceChildren(); documentSelect.style.display = docs && docs.length > 1 ? '' : 'none'; if (docs && docs.length > 1) { docs.forEach((_, index) => { const option = el('option', undefined, String(index + 1)); option.value = String(index); option.selected = index === shaped.selectedDocument; documentSelect.append(option); }); documentSelect.onchange = () => controller.dispatch({ type: 'select-document', index: Number(documentSelect.value) }); } treeBody.replaceChildren(); flatBody.replaceChildren(); const roots = shaped.root ? [shaped.root] : docs ? [docs[shaped.selectedDocument ?? 0]].filter((node): node is StructuredNode => !!node) : []; roots.forEach(node => { const rendered = renderNode(node, 0, state); if (rendered) treeBody.append(rendered); }); if (state.mode === 'flat') { const rows: HTMLElement[] = []; roots.forEach(node => renderFlatRows(node, asciiLower(state.search.trim()), state, rows)); flatBody.append(...rows); }
        // Follow a selection that moved because of the source caret, but leave
        // the tree alone while the user is only re-rendering the same node.
        if (state.selected !== lastSelected) { lastSelected = state.selected ?? null; (state.mode === 'flat' ? flatBody : treeBody).querySelector<HTMLElement>('.omni-structured__node--selected')?.scrollIntoView?.({ block: 'nearest' }); } };
    const unsubscribe = controller.subscribe(render); render(controller.state); return { dispose() { unsubscribe(); disposers.splice(0).forEach(dispose => dispose()); frame.remove(); if (root instanceof ShadowRoot) root.replaceChildren(); else container.classList.remove(VIEWER_ROOT_CLASS, className); } };
}
