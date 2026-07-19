// JSON viewer — DOM renderer consuming JsonController (DESIGN.md §3-②).
// CSP rules: no eval, no inline handlers, no innerHTML — all rendering goes
// through createElement/textContent. Mount is async and renders inside a shadow
// root by default (§6 reverse-contamination contract).
//
// Optional services: `clipboard`. Degraded mode (ADR 24): without it the copy
// controls render disabled with an explanatory tooltip — never hidden.

import type {
    ClipboardService,
    FileSaveService,
    FileWritebackService,
    HostContext
} from '../../host/index.js';
import {
    MountAbortedError,
    VIEWER_ROOT_CLASS,
    type MountOptions,
    type ViewerHandle,
    type ViewerInput
} from '../types.js';
import { tokenizeJson, type JsonNode } from '../../parsers/json/index.js';
import { parseCsv } from '../../parsers/csv/index.js';
import type { ResourceLimits } from '../../parsers/types.js';
import {
    createJsonController,
    type JsonController,
    type JsonToolAction,
    type JsonViewState
} from './controller.js';
import { jsonViewerCss } from './styles.js';

export {
    createJsonController,
    type JsonController,
    type JsonViewState,
    type JsonAction,
    type JsonToolAction,
    type JsonSourceForm,
    type JsonViewMode
} from './controller.js';
export { jsonViewerCss } from './styles.js';

/** Viewer metadata — single source for the registry codegen (DESIGN.md §7). */
export const JSON_VIEWER_META = {
    id: 'json',
    displayNameKey: 'json.treeView',
    extensions: ['json'],
    priority: 10,
    requiredServices: [] as const,
    optionalServices: ['clipboard', 'save', 'writeback'] as const,
    inputOwnership: 'borrows' as const
};

export type JsonViewerContext = HostContext & {
    clipboard?: ClipboardService;
    save?: FileSaveService;
    writeback?: FileWritebackService;
};

export interface JsonMountOptions extends MountOptions {
    limits?: ResourceLimits;
    maxDepth?: number;
}

/** Toolbox buttons: [label key suffix, action]. Routing per 부록 B-1. */
const TOOLBOX: ReadonlyArray<[string, JsonToolAction]> = [
    ['format', 'pretty'],
    ['minify', 'minify'],
    ['sort', 'sort-keys'],
    ['validate', 'validate'],
    ['escape', 'escape'],
    ['unescape', 'unescape'],
    ['base64Encode', 'base64-encode'],
    ['base64Decode', 'base64-decode'],
    ['toCsv', 'to-csv'],
    ['toXml', 'to-xml'],
    ['toYaml', 'to-yaml']
];

export async function mountJsonViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: JsonViewerContext,
    options: JsonMountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();

    const controllerOptions: Parameters<typeof createJsonController>[1] = {};
    if (options.limits !== undefined) controllerOptions.limits = options.limits;
    if (options.maxDepth !== undefined) controllerOptions.maxDepth = options.maxDepth;
    const controller = createJsonController(input.data, controllerOptions);

    const isolation = options.styleIsolation ?? 'shadow';
    let root: HTMLElement | ShadowRoot;
    if (isolation === 'shadow' && typeof container.attachShadow === 'function') {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = jsonViewerCss;
        root.appendChild(style);
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--json');
        root = container;
    }

    const t = ctx.i18n.t.bind(ctx.i18n);
    const clipboard = ctx.clipboard;
    const save = ctx.save;
    const writeback = ctx.writeback;
    const disposers: Array<() => void> = [];
    let editing = false;
    let saveNotice: string | null = null;

    const el = <K extends keyof HTMLElementTagNameMap>(
        tag: K,
        className?: string,
        text?: string
    ): HTMLElementTagNameMap[K] => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const on = <K extends keyof HTMLElementEventMap>(
        target: HTMLElement,
        type: K,
        handler: (ev: HTMLElementEventMap[K]) => void
    ): void => {
        target.addEventListener(type, handler as EventListener);
        disposers.push(() => target.removeEventListener(type, handler as EventListener));
    };

    const copy = async (value: string): Promise<void> => {
        if (!clipboard) return;
        try {
            await clipboard.writeText(value);
        } catch (error) {
            ctx.logger.log('error', `json copy failed: ${String(error)}`);
        }
    };

    const jsonBytes = (): Uint8Array => new TextEncoder().encode(controller.verbatimText());

    const saveAsJson = async (): Promise<void> => {
        if (!save) return;
        const name = input.fileName.toLowerCase().endsWith('.json')
            ? input.fileName
            : `${input.fileName}.json`;
        try {
            await save.saveFile(name, jsonBytes(), 'application/json');
            saveNotice = t('common.saved', { name });
        } catch (error) {
            ctx.logger.log('error', `json save failed: ${String(error)}`);
            saveNotice = t('common.saveFailed');
        }
        render(controller.state);
    };

    const saveToOriginal = async (): Promise<void> => {
        if (!writeback) return;
        try {
            await writeback.write(jsonBytes());
            saveNotice = t('common.savedToOriginal');
        } catch (error) {
            ctx.logger.log('error', `json save failed: ${String(error)}`);
            saveNotice = t('common.saveFailed');
        }
        render(controller.state);
    };

    // --- static frame ------------------------------------------------------
    const frame = el('div', 'omni-json');
    const toolbar = el('div', 'omni-json__toolbar');

    const treeBtn = el('button', undefined, t('json.view.tree'));
    treeBtn.type = 'button';
    on(treeBtn, 'click', () =>
        controller.dispatch({
            type: 'set-view-mode',
            mode: controller.state.viewMode === 'tree' ? 'source' : 'tree'
        })
    );

    const expandBtn = el('button', undefined, t('json.expandAll'));
    expandBtn.type = 'button';
    on(expandBtn, 'click', () => controller.dispatch({ type: 'expand-all' }));
    const collapseBtn = el('button', undefined, t('json.collapseAll'));
    collapseBtn.type = 'button';
    on(collapseBtn, 'click', () => controller.dispatch({ type: 'collapse-all' }));

    const formSelect = el('select');
    for (const form of ['verbatim', 'pretty', 'minified'] as const) {
        const opt = el('option', undefined, t(`json.form.${form}`));
        opt.value = form;
        formSelect.appendChild(opt);
    }
    on(formSelect, 'change', () =>
        controller.dispatch({
            type: 'set-source-form',
            form: formSelect.value as 'verbatim' | 'pretty' | 'minified'
        })
    );

    const searchInput = el('input', 'omni-json__search');
    searchInput.type = 'search';
    searchInput.placeholder = t('json.search');
    searchInput.setAttribute('aria-label', t('json.search'));
    on(searchInput, 'input', () =>
        controller.dispatch({ type: 'set-search', search: searchInput.value })
    );
    const prevBtn = el('button', undefined, '‹');
    prevBtn.type = 'button';
    prevBtn.setAttribute('aria-label', t('json.prevMatch'));
    on(prevBtn, 'click', () => controller.dispatch({ type: 'prev-match' }));
    const nextBtn = el('button', undefined, '›');
    nextBtn.type = 'button';
    nextBtn.setAttribute('aria-label', t('json.nextMatch'));
    on(nextBtn, 'click', () => controller.dispatch({ type: 'next-match' }));
    const matchInfo = el('span', 'omni-json__matchinfo');

    const toolButtons: HTMLButtonElement[] = [];
    const toolbox = el('span', 'omni-json__tool-group');
    TOOLBOX.forEach(([labelKey, action]) => {
        const btn = el('button', undefined, t(`json.tool.${labelKey}`));
        btn.type = 'button';
        on(btn, 'click', () => controller.dispatch({ type: 'run-tool', action }));
        toolButtons.push(btn);
        toolbox.appendChild(btn);
    });

    const meta = el('span', 'omni-json__meta');
    const saveActions = el('span', 'omni-json__save-actions');
    const saveBtn = el('button', undefined, t('json.save'));
    saveBtn.type = 'button';
    if (writeback) {
        on(saveBtn, 'click', () => void saveToOriginal());
    } else {
        saveBtn.disabled = true;
        saveBtn.title = t('common.noWriteback');
    }
    const saveAsBtn = el('button', undefined, t('json.saveAs'));
    saveAsBtn.type = 'button';
    if (save) {
        on(saveAsBtn, 'click', () => void saveAsJson());
    } else {
        saveAsBtn.disabled = true;
        saveAsBtn.title = t('common.noFileSave');
    }
    saveActions.append(saveBtn, saveAsBtn);

    toolbar.append(
        expandBtn,
        collapseBtn,
        formSelect,
        searchInput,
        prevBtn,
        nextBtn,
        matchInfo,
        saveActions,
        toolbox,
        meta
    );

    const statusBar = el('div', 'omni-json__status');
    const diagnosticsBar = el('div', 'omni-json__diagnostics');
    const body = el('div', 'omni-json__body');

    // Persistent editor (verbatim source) so edits keep caret/focus.
    const editor = el('textarea', 'omni-json__editor');
    editor.spellcheck = false;
    on(editor, 'focus', () => {
        editing = true;
    });
    on(editor, 'blur', () => {
        editing = false;
    });
    on(editor, 'input', () =>
        controller.dispatch({ type: 'edit-scratchpad', text: editor.value })
    );

    // Source mode keeps the original text beside its highlighted preview.
    // The editor stays mounted while typing so it retains its focus and caret.
    const sourceWorkspace = el('div', 'omni-json__source-workspace');
    const editorPanel = el('section', 'omni-json__pane omni-json__editor-pane');
    const editorHeader = el('header', 'omni-json__pane-header');
    editorHeader.append(
        el('strong', undefined, t('json.editor.title')),
        el('span', undefined, t('json.editor.description'))
    );
    const editorSurface = el('div', 'omni-json__editor-surface');
    const editorHighlight = el('pre', 'omni-json__editor-highlight');
    const editorCode = el('code');
    editorHighlight.appendChild(editorCode);
    on(editor, 'scroll', () => {
        editorHighlight.scrollTop = editor.scrollTop;
        editorHighlight.scrollLeft = editor.scrollLeft;
    });
    editorSurface.append(editorHighlight, editor);
    editorPanel.append(editorHeader, editorSurface);

    const previewPanel = el('section', 'omni-json__pane omni-json__preview-pane');
    const previewHeader = el('header', 'omni-json__pane-header');
    previewHeader.append(
        el('strong', undefined, t('json.preview.title')),
        el('span', undefined, t('json.preview.description')),
        treeBtn
    );
    const preview = el('pre', 'omni-json__source');
    const previewCode = el('code');
    preview.appendChild(previewCode);
    const previewContent = el('div', 'omni-json__preview-content');
    previewContent.appendChild(preview);
    previewPanel.append(previewHeader, previewContent);
    sourceWorkspace.append(editorPanel, previewPanel);

    // Result panel (converters).
    const resultPanel = el('div', 'omni-json__result');
    const resultTitle = el('div', 'omni-json__result-title');
    const resultOutput = el('textarea', 'omni-json__result-output');
    resultOutput.readOnly = true;
    const resultMarkup = el('pre', 'omni-json__result-markup');
    const resultMarkupCode = el('code');
    resultMarkup.appendChild(resultMarkupCode);
    const resultTableWrap = el('div', 'omni-json__result-table-wrap');
    const resultTable = el('table', 'omni-json__result-table');
    resultTableWrap.appendChild(resultTable);
    const resultActions = el('div', 'omni-json__result-actions');
    const copyResultBtn = el('button', undefined, t('json.result.copy'));
    copyResultBtn.type = 'button';
    if (clipboard) {
        on(copyResultBtn, 'click', () => void copy(resultOutput.value));
    } else {
        copyResultBtn.disabled = true;
        copyResultBtn.title = t('common.noClipboard');
    }
    const replaceResultBtn = el('button', undefined, t('json.result.replace'));
    replaceResultBtn.type = 'button';
    on(replaceResultBtn, 'click', () =>
        controller.dispatch({ type: 'apply-result-to-editor' })
    );
    const closeResultBtn = el('button', undefined, t('json.result.close'));
    closeResultBtn.type = 'button';
    on(closeResultBtn, 'click', () => controller.dispatch({ type: 'dismiss-result' }));
    resultActions.append(copyResultBtn, replaceResultBtn, closeResultBtn);
    resultPanel.append(resultTitle, resultOutput, resultMarkup, resultTableWrap, resultActions);

    frame.append(toolbar, statusBar, diagnosticsBar, resultPanel, body);
    root.appendChild(frame);

    // --- tree rendering ----------------------------------------------------
    function valueSpan(node: JsonNode): HTMLElement {
        switch (node.kind) {
            case 'string':
                return el('span', 'omni-json__val-string', `"${node.value as string}"`);
            case 'number':
                return el('span', 'omni-json__val-number', node.rawNumber ?? '');
            case 'boolean':
                return el('span', 'omni-json__val-boolean', String(node.value));
            case 'null':
                return el('span', 'omni-json__val-null', 'null');
            case 'array':
                return el('span', 'omni-json__type', `[${node.children?.length ?? 0}]`);
            case 'object':
                return el('span', 'omni-json__type', `{${node.children?.length ?? 0}}`);
        }
    }

    function renderNode(
        node: JsonNode,
        state: JsonViewState,
        currentId: string | undefined
    ): HTMLLIElement {
        // Address by stable id, not path — duplicate keys share a path (P1b).
        const id = controller.nodeId(node) ?? node.path;
        const li = el('li');
        const row = el('div', 'omni-json__row');
        if (controller.matches.includes(id)) row.classList.add('is-matched');
        if (id === currentId) row.classList.add('is-current');

        const container = node.kind === 'object' || node.kind === 'array';
        const expanded = state.expanded.has(id);
        if (container) {
            // A real button carries native focus + Enter/Space activation (P2b).
            const toggle = el('button', 'omni-json__toggle', expanded ? '▾' : '▸');
            toggle.type = 'button';
            toggle.setAttribute('aria-expanded', String(expanded));
            toggle.setAttribute(
                'aria-label',
                t(expanded ? 'json.collapseNode' : 'json.expandNode')
            );
            toggle.addEventListener('click', () =>
                controller.dispatch({ type: 'toggle-node', id })
            );
            row.appendChild(toggle);
        } else {
            row.appendChild(el('span', 'omni-json__toggle', ''));
        }

        row.appendChild(el('span', 'omni-json__key', node.key));
        row.appendChild(el('span', 'omni-json__type', node.kind));
        row.appendChild(valueSpan(node));

        const actions = el('span', 'omni-json__node-actions');
        const pathBtn = el('button', undefined, t('json.copyPath'));
        pathBtn.type = 'button';
        const valueBtn = el('button', undefined, t('json.copyValue'));
        valueBtn.type = 'button';
        if (clipboard) {
            pathBtn.addEventListener('click', () => void copy(controller.nodePath(id)));
            valueBtn.addEventListener('click', () => void copy(controller.nodeValue(id)));
        } else {
            for (const b of [pathBtn, valueBtn]) {
                b.disabled = true;
                b.title = t('common.noClipboard');
            }
        }
        actions.append(pathBtn, valueBtn);
        row.appendChild(actions);
        li.appendChild(row);

        if (container && expanded && node.children && node.children.length) {
            const ul = el('ul');
            for (const child of node.children) ul.appendChild(renderNode(child, state, currentId));
            li.appendChild(ul);
        }
        return li;
    }

    function renderHighlightedJson(target: HTMLElement, text: string, search = ''): void {
        target.replaceChildren();
        const query = search.trim().toLocaleLowerCase();
        for (const tok of tokenizeJson(text)) {
            const tokenClass =
                tok.kind === 'whitespace' || tok.kind === 'punct' ? '' : `jv-tok-${tok.kind}`;
            if (!query || !tok.text.toLocaleLowerCase().includes(query)) {
                if (tokenClass) target.appendChild(el('span', tokenClass, tok.text));
                else target.appendChild(document.createTextNode(tok.text));
                continue;
            }

            let cursor = 0;
            const lowerText = tok.text.toLocaleLowerCase();
            while (cursor < tok.text.length) {
                const matchAt = lowerText.indexOf(query, cursor);
                if (matchAt < 0) {
                    const rest = tok.text.slice(cursor);
                    if (tokenClass) target.appendChild(el('span', tokenClass, rest));
                    else target.appendChild(document.createTextNode(rest));
                    break;
                }
                if (matchAt > cursor) {
                    const before = tok.text.slice(cursor, matchAt);
                    if (tokenClass) target.appendChild(el('span', tokenClass, before));
                    else target.appendChild(document.createTextNode(before));
                }
                target.appendChild(
                    el(
                        'mark',
                        tokenClass ? `${tokenClass} omni-json__search-hit` : 'omni-json__search-hit',
                        tok.text.slice(matchAt, matchAt + query.length)
                    )
                );
                cursor = matchAt + query.length;
            }
        }
    }

    function renderCsvResult(text: string): void {
        const { result } = parseCsv(text, { delimiter: ',', hasHeader: true });
        resultTable.replaceChildren();
        if (result.status === 'failed') return;

        const head = el('thead');
        const headerRow = el('tr');
        for (const header of result.document.headers) headerRow.appendChild(el('th', undefined, header));
        head.appendChild(headerRow);
        const tableBody = el('tbody');
        for (const row of result.document.rows) {
            const tr = el('tr');
            for (let index = 0; index < result.document.columnCount; index++) {
                tr.appendChild(el('td', undefined, row[index] ?? ''));
            }
            tableBody.appendChild(tr);
        }
        resultTable.append(head, tableBody);
    }

    function renderMarkupResult(action: JsonToolAction, text: string): void {
        resultMarkupCode.replaceChildren();
        if (action === 'to-xml') {
            for (const token of text.match(/<[^>]+>|[^<]+/g) ?? []) {
                const className = token.startsWith('<') ? 'omni-json__result-tag' : 'omni-json__result-value';
                resultMarkupCode.appendChild(el('span', className, token));
            }
            return;
        }
        for (const line of text.split('\n')) {
            const match = /^(\s*(?:-\s*)?[^:#\n]+:)(.*)$/.exec(line);
            if (match) {
                resultMarkupCode.append(
                    el('span', 'omni-json__result-key', match[1]!),
                    el('span', 'omni-json__result-value', match[2]!)
                );
            } else {
                resultMarkupCode.appendChild(document.createTextNode(line));
            }
            resultMarkupCode.appendChild(document.createTextNode('\n'));
        }
    }

    function renderSource(state: JsonViewState): void {
        if (!editing) editor.value = controller.verbatimText();
        renderHighlightedJson(editorCode, controller.verbatimText(), state.search);
        if (body.firstChild !== sourceWorkspace) body.replaceChildren(sourceWorkspace);
    }

    function render(state: JsonViewState): void {
        treeBtn.setAttribute('aria-pressed', String(state.viewMode === 'tree'));
        treeBtn.textContent = t(state.viewMode === 'tree' ? 'json.view.source' : 'json.view.tree');
        const treeMode = state.viewMode === 'tree';
        expandBtn.style.display = treeMode ? '' : 'none';
        collapseBtn.style.display = treeMode ? '' : 'none';
        formSelect.style.display = 'none';
        if (formSelect.value !== state.sourceForm) formSelect.value = state.sourceForm;

        if (searchInput.value !== state.search) searchInput.value = state.search;
        matchInfo.textContent = state.search
            ? state.matchCount
                ? t('json.matchInfo', {
                      current: state.currentMatch + 1,
                      total: state.matchCount
                  })
                : t('json.noMatches')
            : '';

        for (const btn of toolButtons) btn.disabled = false;

        meta.textContent = state.statistics
            ? t('json.stats', {
                  total: state.statistics.total,
                  depth: state.statistics.maxDepth
              })
            : '';

        const statusText = state.statusMessage
            ? t(state.statusMessage.key, state.statusMessage.args)
            : saveNotice ?? '';
        statusBar.style.display = statusText ? '' : 'none';
        statusBar.textContent = statusText;

        diagnosticsBar.replaceChildren();
        const hasNotices = state.diagnostics.length > 0 || state.failure !== null;
        diagnosticsBar.style.display = hasNotices ? '' : 'none';
        if (state.failure) {
            diagnosticsBar.appendChild(
                el('div', 'omni-json__diag-error', t(state.failure.messageKey, state.failure.args))
            );
        }
        for (const diag of state.diagnostics) {
            diagnosticsBar.appendChild(el('div', undefined, t(diag.messageKey, diag.args)));
        }

        renderSource(state);
        if (treeMode && state.root) {
            const ul = el('ul', 'omni-json__tree');
            const currentId =
                state.currentMatch >= 0 ? controller.matches[state.currentMatch] : undefined;
            ul.appendChild(renderNode(state.root, state, currentId));
            previewContent.replaceChildren(ul);
        } else {
            renderHighlightedJson(previewCode, controller.verbatimText(), state.search);
            if (previewContent.firstChild !== preview) previewContent.replaceChildren(preview);
        }

        if (state.toolResult) {
            resultPanel.style.display = '';
            resultTitle.textContent = state.toolResult.error
                ? t(state.toolResult.error.key, state.toolResult.error.args)
                : t(state.toolResult.titleKey);
            resultOutput.value = state.toolResult.output;
            const isCsv = state.toolResult.action === 'to-csv' && !state.toolResult.error;
            const isMarkup = !state.toolResult.error
                && (state.toolResult.action === 'to-xml' || state.toolResult.action === 'to-yaml');
            resultOutput.style.display = isCsv || isMarkup ? 'none' : '';
            resultMarkup.style.display = isMarkup ? '' : 'none';
            resultTableWrap.style.display = isCsv ? '' : 'none';
            if (isCsv) renderCsvResult(state.toolResult.output);
            if (isMarkup) renderMarkupResult(state.toolResult.action, state.toolResult.output);
            copyResultBtn.disabled = !clipboard || !!state.toolResult.error;
            replaceResultBtn.disabled = !!state.toolResult.error;
        } else {
            resultPanel.style.display = 'none';
        }
    }

    const unsubscribe = controller.subscribe(render);
    render(controller.state);

    if (options.signal?.aborted) {
        cleanup();
        throw new MountAbortedError();
    }

    function cleanup(): void {
        unsubscribe();
        for (const dispose of disposers) dispose();
        disposers.length = 0;
        if (root instanceof ShadowRoot) {
            root.replaceChildren();
        } else {
            root.replaceChildren();
            root.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--json');
        }
    }

    return { dispose: cleanup };
}
