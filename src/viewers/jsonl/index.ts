import type { ClipboardService, FileSaveService, FileWritebackService, HostContext } from '../../host/index.js';
import type { JsonlEntry, JsonlPagedInput } from '../../parsers/jsonl/index.js';
import { asciiLower } from '../../parsers/csv/index.js';
import type { MountOptions, ViewerHandle, ViewerInput } from '../types.js';
import { VIEWER_ROOT_CLASS } from '../types.js';
import { createJsonlController } from './controller.js';
import { jsonlViewerCss } from './styles.js';
export * from './controller.js'; export { jsonlViewerCss } from './styles.js';
export const JSONL_VIEWER_META = { id: 'jsonl', displayNameKey: 'jsonl.title', extensions: ['jsonl', 'ndjson', 'jsonlines'], priority: 10, requiredServices: [] as const, optionalServices: ['clipboard', 'save', 'writeback'] as const, inputOwnership: 'borrows' as const };
export interface JsonlMountOptions extends MountOptions { pagedInput?: JsonlPagedInput; }

export async function mountJsonlViewer(input: ViewerInput, container: HTMLElement, ctx: HostContext & { clipboard?: ClipboardService; save?: FileSaveService; writeback?: FileWritebackService }, options: JsonlMountOptions = {}): Promise<ViewerHandle> {
    let root: HTMLElement | ShadowRoot;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && typeof container.attachShadow === 'function') { root = container.shadowRoot ?? container.attachShadow({ mode: 'open' }); const style = document.createElement('style'); style.textContent = jsonlViewerCss; root.append(style); }
    else { container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--jsonl'); root = container; }
    const controller = createJsonlController(options.pagedInput ?? input.data);
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; };
    const frame = el('div'); frame.className = 'omni-jsonl'; frame.tabIndex = 0; root.append(frame);
    let editing: string | null = null, detail: string | null = null, dragged: string | null = null, disposed = false;
    const visible = { count: 5_000 };
    const save = async (): Promise<void> => { if (!controller.canSave()) return; const data = new TextEncoder().encode(controller.serialize()); if (ctx.writeback) await ctx.writeback.write(data); else if (ctx.save) await ctx.save.saveFile(input.fileName, data, 'application/x-ndjson'); };
    const selectedEntry = (): JsonlEntry | undefined => controller.state.entries.find(entry => controller.state.selected.has(entry.id));
    const keydown = (event: KeyboardEvent): void => { if ((event.target as HTMLElement).matches('input,textarea')) return; if (event.key === 'Escape') { editing = detail = null; controller.state.selected.forEach(() => undefined); render(); } else if ((event.key === 'Delete' || event.key === 'Backspace') && controller.state.loadState === 'complete') { event.preventDefault(); controller.dispatch({ type: 'delete-selected' }); } else if (event.key === 'Enter') { const entry = selectedEntry(); if (entry) { editing = entry.id; render(); } } };
    frame.addEventListener('keydown', keydown);
    const unsubscribe = controller.subscribe(() => { if (!disposed) render(); });

    function syntax(parent: HTMLElement, raw: string): void {
        const pattern = /("(?:\\.|[^"\\])*"(?=\s*:))|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi; let offset = 0;
        for (const match of raw.matchAll(pattern)) { const index = match.index; parent.append(document.createTextNode(raw.slice(offset, index))); const token = el('span', match[0]); token.className = match[1] ? 'omni-jsonl__key' : match[2] ? 'omni-jsonl__string' : /true|false|null/i.test(match[0]) ? 'omni-jsonl__literal' : 'omni-jsonl__number'; parent.append(token); offset = index + match[0].length; }
        parent.append(document.createTextNode(raw.slice(offset)));
    }
    function render(): void {
        frame.replaceChildren(); const state = controller.state; const bar = el('div'); bar.className = 'omni-jsonl__bar';
        const search = el('input') as HTMLInputElement; search.type = 'search'; search.placeholder = ctx.i18n.t('structured.search'); search.value = state.search; search.addEventListener('input', () => controller.dispatch({ type: 'set-search', search: search.value }));
        const add = el('button', ctx.i18n.t('jsonl.add')); add.disabled = state.loadState !== 'complete'; add.addEventListener('click', () => controller.dispatch({ type: 'insert' }));
        const remove = el('button', ctx.i18n.t('jsonl.delete')); remove.disabled = state.loadState !== 'complete' || !state.selected.size; remove.addEventListener('click', () => controller.dispatch({ type: 'delete-selected' }));
        const more = el('button', ctx.i18n.t('jsonl.loadMore')); more.disabled = state.loadState !== 'preview'; more.addEventListener('click', () => void controller.dispatch({ type: 'load-more' }));
        const all = el('button', ctx.i18n.t('jsonl.loadAll')); all.disabled = state.loadState !== 'preview'; all.addEventListener('click', () => void controller.dispatch({ type: 'load-all' }));
        const saveButton = el('button', ctx.i18n.t('jsonl.save')); saveButton.disabled = !controller.canSave() || (!ctx.writeback && !ctx.save); saveButton.title = controller.canSave() ? '' : ctx.i18n.t('jsonl.invalidSave'); saveButton.addEventListener('click', () => void save());
        bar.append(search, add, remove, more, all, saveButton); frame.append(bar);
        if (state.loadState !== 'complete') { const banner = el('div', ctx.i18n.t('jsonl.preview')); banner.className = 'omni-jsonl__banner'; frame.append(banner); }
        const rows = el('div'); rows.className = 'omni-jsonl__rows'; const query = asciiLower(state.search);
        const filtered = state.entries.filter(entry => !query || asciiLower(`${entry.raw} ${pretty(entry)}`).includes(query));
        for (const entry of filtered.slice(0, visible.count)) rows.append(renderRow(entry));
        if (filtered.length > visible.count) { const batch = el('button', ctx.i18n.t('jsonl.showMore')); batch.addEventListener('click', () => { visible.count += 5_000; render(); }); rows.append(batch); }
        frame.append(rows);
    }
    function renderRow(entry: JsonlEntry): HTMLElement {
        const row = el('div'); row.className = `omni-jsonl__row${entry.value ? '' : ' omni-jsonl__invalid'}`; row.tabIndex = 0; row.draggable = controller.state.loadState === 'complete'; row.dataset.id = entry.id; row.setAttribute('aria-selected', String(controller.state.selected.has(entry.id))); row.setAttribute('aria-label', ctx.i18n.t(entry.value ? 'jsonl.rowValid' : 'jsonl.rowInvalid', { line: entry.line }));
        const line = el('span', String(entry.line)); const code = el('code'); syntax(code, entry.raw); row.append(line, code);
        const actions = el('span'); actions.className = 'omni-jsonl__actions'; const copy = el('button', ctx.i18n.t('structured.copyValue')); copy.disabled = !ctx.clipboard; copy.addEventListener('click', event => { event.stopPropagation(); void ctx.clipboard?.writeText(entry.raw); }); const edit = el('button', ctx.i18n.t('jsonl.edit')); edit.disabled = controller.state.loadState !== 'complete'; edit.addEventListener('click', event => { event.stopPropagation(); editing = entry.id; render(); }); actions.append(copy, edit); row.append(actions);
        row.addEventListener('click', event => { controller.dispatch({ type: 'select', id: entry.id, additive: event.metaKey || event.ctrlKey, range: event.shiftKey }); detail = entry.id; });
        row.addEventListener('focus', () => { detail = entry.id; renderDetail(row, entry); }); row.addEventListener('mouseenter', () => renderDetail(row, entry));
        row.addEventListener('dragstart', () => { dragged = entry.id; }); row.addEventListener('dragover', event => event.preventDefault()); row.addEventListener('drop', event => { event.preventDefault(); if (dragged && dragged !== entry.id) controller.dispatch({ type: 'move', from: dragged, to: entry.id }); dragged = null; });
        if (editing === entry.id) { const box = el('div'); box.className = 'omni-jsonl__editor'; const textarea = el('textarea') as HTMLTextAreaElement; textarea.value = entry.raw; const error = el('div'); const apply = el('button', ctx.i18n.t('jsonl.apply')); const cancel = el('button', ctx.i18n.t('jsonl.cancel')); const validate = () => { try { JSON.parse(textarea.value); error.textContent = ''; apply.disabled = false; } catch (reason) { error.textContent = String(reason); apply.disabled = true; } }; textarea.addEventListener('input', validate); apply.addEventListener('click', () => { controller.dispatch({ type: 'edit', id: entry.id, raw: textarea.value }); editing = null; }); cancel.addEventListener('click', () => { editing = null; render(); }); validate(); box.append(textarea, error, apply, cancel); row.append(box); }
        if (detail === entry.id) renderDetail(row, entry); return row;
    }
    function renderDetail(row: HTMLElement, entry: JsonlEntry): void { row.querySelector('.omni-jsonl__detail')?.remove(); const panel = el('pre', pretty(entry)); panel.className = 'omni-jsonl__detail'; row.append(panel); }
    function pretty(entry: JsonlEntry): string { if (!entry.raw.trim()) return ''; try { return JSON.stringify(JSON.parse(entry.raw), null, 2); } catch { return entry.raw; } }
    render();
    return { dispose() { disposed = true; unsubscribe(); frame.removeEventListener('keydown', keydown); frame.remove(); if (root instanceof ShadowRoot) root.replaceChildren(); else container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--jsonl'); } };
}
