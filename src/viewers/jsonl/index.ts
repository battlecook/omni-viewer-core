import type { ClipboardService, FileSaveService, FileWritebackService, HostContext } from '../../host/index.js';
import type { JsonlEntry, JsonlPagedInput } from '../../parsers/jsonl/index.js';
import { asciiLower } from '../../parsers/csv/index.js';
import type { MountOptions, ViewerHandle, ViewerInput } from '../types.js';
import { VIEWER_ROOT_CLASS } from '../types.js';
import { createJsonlController } from './controller.js';
import { clampJsonlPopupPosition } from './popup.js';
import { jsonlViewerCss } from './styles.js';
export * from './controller.js'; export * from './popup.js'; export { jsonlViewerCss } from './styles.js';
export const JSONL_VIEWER_META = { id: 'jsonl', displayNameKey: 'jsonl.title', extensions: ['jsonl', 'ndjson', 'jsonlines'], priority: 10, requiredServices: [] as const, optionalServices: ['clipboard', 'save', 'writeback'] as const, inputOwnership: 'borrows' as const };
export interface JsonlMountOptions extends MountOptions { pagedInput?: JsonlPagedInput; }

export async function mountJsonlViewer(input: ViewerInput, container: HTMLElement, ctx: HostContext & { clipboard?: ClipboardService; save?: FileSaveService; writeback?: FileWritebackService }, options: JsonlMountOptions = {}): Promise<ViewerHandle> {
    let root: HTMLElement | ShadowRoot;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && typeof container.attachShadow === 'function') { root = container.shadowRoot ?? container.attachShadow({ mode: 'open' }); const style = document.createElement('style'); style.textContent = jsonlViewerCss; root.append(style); }
    else { container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--jsonl'); root = container; }
    const controller = createJsonlController(options.pagedInput ?? input.data);
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; };
    const frame = el('div'); frame.className = 'omni-jsonl'; frame.tabIndex = 0;
    const popup = el('div'); popup.className = 'omni-jsonl__popup'; popup.setAttribute('role', 'tooltip'); popup.setAttribute('aria-hidden', 'true');
    root.append(frame, popup);
    let editing: string | null = null, dragged: string | null = null, disposed = false;
    let popupTimer: ReturnType<typeof setTimeout> | undefined;
    const popupSize = { width: 480, height: 360 };
    const visible = { count: 5_000 };
    const save = async (): Promise<void> => { if (!controller.canSave()) return; const data = new TextEncoder().encode(controller.serialize()); if (ctx.writeback) await ctx.writeback.write(data); else if (ctx.save) await ctx.save.saveFile(input.fileName, data, 'application/x-ndjson'); };
    const selectedEntry = (): JsonlEntry | undefined => controller.state.entries.find(entry => controller.state.selected.has(entry.id));
    const keydown = (event: KeyboardEvent): void => { if ((event.target as HTMLElement).matches('input,textarea')) return; if (event.key === 'Escape') { hidePopup(); if (controller.state.selected.size) controller.dispatch({ type: 'deselect' }); } else if ((event.key === 'Delete' || event.key === 'Backspace') && controller.state.loadState === 'complete') { event.preventDefault(); controller.dispatch({ type: 'delete-selected' }); } else if (event.key === 'Enter') { const entry = selectedEntry(); const row = entry ? [...frame.querySelectorAll<HTMLElement>('[data-id]')].find(candidate => candidate.dataset.id === entry.id) : undefined; if (entry && row) { const rect = row.getBoundingClientRect(); showEditor(entry, rect.left + Math.min(rect.width, 80), rect.top + rect.height); } } };
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
        const valid = isValid(entry);
        const row = el('div'); row.className = `omni-jsonl__row${valid ? '' : ' omni-jsonl__invalid'}`; row.tabIndex = 0; row.draggable = controller.state.loadState === 'complete'; row.dataset.id = entry.id; row.setAttribute('aria-selected', String(controller.state.selected.has(entry.id))); row.setAttribute('aria-label', ctx.i18n.t(valid ? 'jsonl.rowValid' : 'jsonl.rowInvalid', { line: entry.line }));
        const line = el('span', String(entry.line)); const code = el('code'); syntax(code, entry.raw); row.append(line, code);
        row.addEventListener('click', event => { controller.dispatch({ type: 'select', id: entry.id, additive: event.metaKey || event.ctrlKey, range: event.shiftKey }); if (!event.metaKey && !event.ctrlKey && !event.shiftKey) showEditor(entry, event.clientX, event.clientY); });
        if (valid && entry.raw.trim()) {
            row.addEventListener('mouseenter', event => scheduleDetail(entry, event.clientX, event.clientY));
            row.addEventListener('mousemove', event => scheduleDetail(entry, event.clientX, event.clientY));
            row.addEventListener('mouseleave', () => { if (!editing) hidePopup(); });
            row.addEventListener('focus', () => { const rect = row.getBoundingClientRect(); showDetail(entry, rect.left + Math.min(rect.width, 80), rect.top + rect.height); });
            row.addEventListener('blur', () => { if (!editing) hidePopup(); });
        }
        row.addEventListener('dragstart', () => { dragged = entry.id; }); row.addEventListener('dragover', event => event.preventDefault()); row.addEventListener('drop', event => { event.preventDefault(); if (dragged && dragged !== entry.id) controller.dispatch({ type: 'move', from: dragged, to: entry.id }); dragged = null; });
        return row;
    }
    function isValid(entry: JsonlEntry): boolean { return !entry.diagnostics.some(diagnostic => diagnostic.code === 'invalid-jsonl-line'); }
    function clearPopupTimer(): void { if (popupTimer !== undefined) { clearTimeout(popupTimer); popupTimer = undefined; } }
    function positionPopup(mouseX: number, mouseY: number): void {
        const view = popup.ownerDocument.defaultView;
        const position = clampJsonlPopupPosition({ mouseX, mouseY, popupWidth: popupSize.width, popupHeight: popupSize.height, viewportWidth: view?.innerWidth ?? popupSize.width + 24, viewportHeight: view?.innerHeight ?? popupSize.height + 24 });
        popup.style.left = `${position.left}px`; popup.style.top = `${position.top}px`; popup.style.display = 'block'; popup.setAttribute('aria-hidden', 'false');
    }
    function scheduleDetail(entry: JsonlEntry, mouseX: number, mouseY: number): void { if (editing) return; clearPopupTimer(); popupTimer = setTimeout(() => { popupTimer = undefined; showDetail(entry, mouseX, mouseY); }, 150); }
    function showDetail(entry: JsonlEntry, mouseX: number, mouseY: number): void { if (editing) return; clearPopupTimer(); popup.replaceChildren(); const panel = el('pre'); panel.className = 'omni-jsonl__popup-content'; syntax(panel, pretty(entry)); popup.append(panel); popup.style.pointerEvents = 'none'; positionPopup(mouseX, mouseY); }
    function showEditor(entry: JsonlEntry, mouseX: number, mouseY: number): void {
        if (controller.state.loadState !== 'complete') return;
        clearPopupTimer(); editing = entry.id; popup.replaceChildren(); popup.style.pointerEvents = 'auto';
        const box = el('div'); box.className = 'omni-jsonl__editor'; const textarea = el('textarea') as HTMLTextAreaElement; textarea.value = entry.raw;
        const error = el('div'); error.className = 'omni-jsonl__editor-error'; error.setAttribute('role', 'alert');
        const actions = el('div'); actions.className = 'omni-jsonl__editor-actions'; const apply = el('button', ctx.i18n.t('jsonl.apply')); const cancel = el('button', ctx.i18n.t('jsonl.cancel'));
        const validate = () => { try { if (/\r|\n/.test(textarea.value)) throw new Error(ctx.i18n.t('jsonl.singleLine')); JSON.parse(textarea.value); error.textContent = ''; apply.disabled = false; } catch (reason) { error.textContent = reason instanceof Error ? reason.message : String(reason); apply.disabled = true; } };
        textarea.addEventListener('input', validate); textarea.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); hidePopup(); } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !apply.disabled) { event.preventDefault(); apply.click(); } });
        apply.addEventListener('click', () => { controller.dispatch({ type: 'edit', id: entry.id, raw: textarea.value }); hidePopup(); }); cancel.addEventListener('click', hidePopup);
        actions.append(cancel, apply); box.append(textarea, error, actions); popup.append(box); validate(); positionPopup(mouseX, mouseY); textarea.focus();
    }
    function hidePopup(): void { clearPopupTimer(); editing = null; popup.style.display = 'none'; popup.style.pointerEvents = 'none'; popup.setAttribute('aria-hidden', 'true'); popup.replaceChildren(); }
    function pretty(entry: JsonlEntry): string { if (!entry.raw.trim()) return ''; try { return JSON.stringify(JSON.parse(entry.raw), null, 2); } catch { return entry.raw; } }
    render();
    return { dispose() { disposed = true; clearPopupTimer(); unsubscribe(); frame.removeEventListener('keydown', keydown); frame.remove(); popup.remove(); if (root instanceof ShadowRoot) root.replaceChildren(); else container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--jsonl'); } };
}
