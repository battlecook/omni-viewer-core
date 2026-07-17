import type { FileSaveService, HostContext } from '../../host/index.js';
import { ARCHIVE_DEFAULT_LIMITS, ArchiveError, parseArchive, type ArchiveDecoder, type ArchiveEntry, type OpenArchiveHandle } from '../../parsers/archive/index.js';
import type { ResourceLimits } from '../../parsers/types.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { createArchiveController } from './controller.js';
import { tryDecodeArchiveEntryPreview } from './archive-preview-decoder.js';
import { hexPreview, isText } from './preview.js';
import { archiveViewerCss } from './styles.js';

export * from '../../parsers/archive/index.js';
export { createArchiveController } from './controller.js';
export { archiveViewerCss } from './styles.js';

export const ARCHIVE_VIEWER_META = { id: 'archive', displayNameKey: 'archive.title', extensions: ['zip','jar','apk','tar','tgz','tar.gz','tbz','tbz2','tar.bz2','txz','tar.xz','gz','bz2','xz','7z','rar','dmg'], priority: 5, requiredServices: [] as const, optionalServices: ['save'] as const, inputOwnership: 'consumes' as const };
export interface ArchiveViewerDeps extends ArchiveDecoder {}
export type ArchiveViewerContext = HostContext & { save?: FileSaveService };
export interface ArchiveMountOptions extends MountOptions { limits?: ResourceLimits; }

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

const formatSize = (value?: number): string => {
    if (value === undefined || !Number.isFinite(value)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB']; let size = value; let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
    const precision = size >= 100 || unit === 0 ? 0 : size >= 10 ? 1 : 2;
    return `${size.toFixed(precision)} ${units[unit]}`;
};

const formatDate = (value?: string | number | Date): string => {
    if (value === undefined) return '—';
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
};

const archiveFormat = (name: string): string => {
    const lower = name.toLocaleLowerCase();
    return ['tar.gz','tar.bz2','tar.xz'].find(ext => lower.endsWith(`.${ext}`))?.toUpperCase() ?? (lower.split('.').pop()?.toUpperCase() || 'ARCHIVE');
};

export async function mountArchiveViewer(input: ViewerInput, container: HTMLElement, ctx: ArchiveViewerContext, deps: ArchiveViewerDeps, options: ArchiveMountOptions = {}): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const parsed = await parseArchive(input.data, deps, { fileName: input.fileName, ...(options.signal ? { signal: options.signal } : {}), ...(options.limits ? { limits: options.limits } : {}) });
    if (parsed.outcome.result.status === 'failed') throw new Error(parsed.outcome.result.failure.messageKey);
    if (options.signal?.aborted) { await parsed.handle?.close(); throw new MountAbortedError(); }
    let handle: OpenArchiveHandle | undefined = parsed.handle;
    const root: HTMLElement | ShadowRoot = options.styleIsolation !== 'scoped' && typeof container.attachShadow === 'function' ? (container.shadowRoot ?? container.attachShadow({ mode: 'open' })) : container;
    if (root === container) container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--archive');
    else { const style = element('style'); style.textContent = archiveViewerCss; root.append(style); }

    const t = (key: string, args?: Record<string, string | number>) => ctx.i18n.t(key, args);
    const entries = parsed.outcome.result.document.entries;
    const controller = createArchiveController(entries);
    const wrap = element('section', `${VIEWER_ROOT_CLASS} omni-viewer--archive`);
    const hero = element('header', 'omni-archive__hero');
    const heading = element('div'); heading.append(element('div', 'omni-archive__eyebrow', t('archive.preview')), element('h1', '', input.fileName), element('p', 'omni-archive__subtitle', t('archive.summary')));
    const pills = element('div', 'omni-archive__pills');
    pills.append(element('span', 'omni-archive__pill', archiveFormat(input.fileName)), element('span', 'omni-archive__pill', t('archive.entries', { count: entries.length })), element('span', 'omni-archive__pill', formatSize(input.data.byteLength)));
    hero.append(heading, pills);

    const controls = element('section', 'omni-archive__controls');
    const label = element('label', 'omni-archive__search-label', t('archive.filter'));
    const search = element('input', 'omni-archive__search') as HTMLInputElement; search.type = 'search'; search.placeholder = t('archive.search');
    label.append(search); controls.append(label);
    const stats = element('section', 'omni-archive__stats');
    const files = entries.filter(entry => !entry.isDirectory).length;
    const statValues: Array<[string, number]> = [['archive.entries', entries.length], ['archive.files', files], ['archive.directories', entries.length - files], ['archive.visible', entries.length]];
    const visibleStat = statValues[3]!;
    for (const [key, value] of statValues) { const card = element('article', 'omni-archive__stat'); card.append(element('div', 'omni-archive__stat-label', key === 'archive.entries' ? t('archive.title') : t(key)), element('div', 'omni-archive__stat-value', value.toLocaleString())); stats.append(card); }

    const workspace = element('section', 'omni-archive__workspace');
    const tableWrap = element('div', 'omni-archive__table-wrap');
    const table = element('table', 'omni-archive__table');
    const thead = element('thead'); const headerRow = element('tr');
    for (const key of ['archive.path','archive.type','archive.compressedSize','archive.originalSize','archive.modified']) headerRow.append(element('th', '', t(key)));
    thead.append(headerRow); const tbody = element('tbody'); table.append(thead, tbody);
    const empty = element('div', 'omni-archive__empty', t('archive.noMatches')); empty.hidden = true; tableWrap.append(table, empty);

    const previewPanel = element('aside', 'omni-archive__preview-panel');
    const previewHeader = element('div', 'omni-archive__preview-header'); const previewHeading = element('div');
    const previewTitle = element('h2', '', t('archive.chooseFile')); previewHeading.append(element('div', 'omni-archive__preview-kicker', t('archive.entryPreview')), previewTitle);
    const previewStatus = element('span', 'omni-archive__preview-badge', t('archive.idle')); previewHeader.append(previewHeading, previewStatus);
    const previewMeta = element('p', 'omni-archive__preview-meta', t('archive.selectHint'));
    const preview = element('pre', 'omni-archive__preview', t('archive.noSelection')); preview.setAttribute('aria-live', 'polite');
    const saveButton = element('button', 'omni-archive__save', t('archive.saveEntry')) as HTMLButtonElement;
    saveButton.type = 'button'; saveButton.hidden = !ctx.save; saveButton.disabled = true;
    previewPanel.append(previewHeader, previewMeta, preview, saveButton); workspace.append(tableWrap, previewPanel);
    wrap.append(hero, controls, stats, workspace); root.append(wrap);

    let ticket = 0; let extraction: AbortController | undefined; let saveExtraction: AbortController | undefined; let selectedEntry: ArchiveEntry | undefined;
    const setPreview = (entry: ArchiveEntry | undefined, status: string, meta: string, content: string) => { previewTitle.textContent = entry?.path ?? t('archive.chooseFile'); previewStatus.textContent = status; previewMeta.textContent = meta; preview.textContent = content; };
    const select = async (entry: ArchiveEntry): Promise<void> => {
        extraction?.abort(); extraction = undefined; const local = ++ticket;
        selectedEntry = entry; saveButton.disabled = entry.isDirectory;
        if (entry.isDirectory) controller.dispatch({ type: 'toggle-directory', path: entry.path });
        controller.dispatch({ type: 'select', entryId: entry.entryId });
        if (entry.isDirectory) { setPreview(entry, t('archive.directory'), t('archive.directoryHint'), t('archive.directoryContent')); return; }
        if (!handle) return;
        extraction = new AbortController(); const request = extraction;
        setPreview(entry, t('archive.loading'), t('archive.loadingHint'), t('archive.loadingContent'));
        const maxPreview = ARCHIVE_DEFAULT_LIMITS.maxPreviewBytes;
        if (entry.uncompressedSize !== undefined && entry.uncompressedSize > maxPreview) { setPreview(entry, t('archive.previewUnavailable'), t('diag.archive.limit-exceeded'), t('archive.previewUnavailable')); return; }
        try {
            const data = await handle.extract(entry.entryId, { signal: request.signal, maxBytes: maxPreview });
            if (local !== ticket) return;
            const decoded = tryDecodeArchiveEntryPreview(entry.path, data);
            const text = isText(data);
            setPreview(entry, t('archive.ready'), t(decoded ? 'archive.androidBinaryXmlReady' : text ? 'archive.textReady' : 'archive.binaryReady'), decoded?.content ?? (text ? new TextDecoder().decode(data) : hexPreview(data)));
        } catch (error) {
            if (local === ticket && !request.signal.aborted) setPreview(entry, t('archive.previewUnavailable'), t(error instanceof ArchiveError && error.code === 'limit-exceeded' ? 'diag.archive.limit-exceeded' : 'archive.previewUnavailable'), t('archive.previewUnavailable'));
        }
    };
    saveButton.addEventListener('click', async () => {
        const entry = selectedEntry; const save = ctx.save;
        if (!entry || entry.isDirectory || !save || !handle) return;
        saveExtraction?.abort(); saveExtraction = new AbortController(); const request = saveExtraction;
        saveButton.disabled = true; saveButton.textContent = t('archive.savingEntry');
        try {
            const configuredLimit = options.limits?.maxDecompressedBytes ?? ARCHIVE_DEFAULT_LIMITS.maxDecompressedBytes;
            const maxBytes = Math.max(1, Math.min(entry.uncompressedSize ?? configuredLimit, configuredLimit));
            const data = await handle.extract(entry.entryId, { signal: request.signal, maxBytes });
            if (request.signal.aborted) return;
            const suggestedName = entry.path.split('/').filter(Boolean).pop() ?? 'archive-entry';
            await save.saveFile(suggestedName, data, entry.mimeType ?? 'application/octet-stream');
            if (!request.signal.aborted) previewMeta.textContent = t('common.saved', { name: suggestedName });
        } catch {
            if (!request.signal.aborted) previewMeta.textContent = t('archive.saveFailed');
        } finally {
            if (!request.signal.aborted) { saveButton.disabled = false; saveButton.textContent = t('archive.saveEntry'); }
        }
    });
    const ROW_HEIGHT = 43; const OVERSCAN = 8; const FALLBACK_VIEWPORT_HEIGHT = 600;
    const render = (): void => {
        const visible = controller.visibleEntries(); visibleStat[1] = visible.length;
        stats.querySelectorAll('.omni-archive__stat-value')[3]!.textContent = visible.length.toLocaleString();
        tbody.replaceChildren(); empty.hidden = visible.length !== 0; table.hidden = visible.length === 0;
        const viewportHeight = tableWrap.clientHeight || FALLBACK_VIEWPORT_HEIGHT;
        const start = Math.max(0, Math.floor(tableWrap.scrollTop / ROW_HEIGHT) - OVERSCAN);
        const count = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
        const end = Math.min(visible.length, start + count);
        const spacer = (height: number): HTMLTableRowElement => { const row = element('tr', 'omni-archive__spacer'); const cell = element('td'); cell.colSpan = 5; cell.style.height = `${height}px`; row.append(cell); return row; };
        if (start > 0) tbody.append(spacer(start * ROW_HEIGHT));
        for (const entry of visible.slice(start, end)) {
            const row = element('tr', `omni-archive__entry${controller.state.selectedId === entry.entryId ? ' is-selected' : ''}`); row.tabIndex = 0; row.dataset.entryId = String(entry.entryId);
            const path = element('td', 'omni-archive__path', `${entry.isDirectory ? (controller.state.expanded.has(entry.path) ? '▾ ' : '▸ ') : ''}${entry.path}`);
            path.style.paddingInlineStart = `${Math.max(0, entry.path.split('/').filter(Boolean).length - 1) * 12 + 14}px`;
            row.append(path, element('td', '', t(entry.isDirectory ? 'archive.directory' : 'archive.file')), element('td', '', formatSize(entry.compressedSize)), element('td', '', formatSize(entry.uncompressedSize)), element('td', '', formatDate(entry.modifiedAt)));
            row.addEventListener('click', () => void select(entry));
            row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void select(entry); } });
            tbody.append(row);
        }
        if (end < visible.length) tbody.append(spacer((visible.length - end) * ROW_HEIGHT));
    };
    tableWrap.addEventListener('scroll', render, { passive: true });
    search.addEventListener('input', () => { tableWrap.scrollTop = 0; controller.dispatch({ type: 'set-search', query: search.value }); });
    const unsubscribe = controller.subscribe(render); render();
    return { dispose() { ticket++; extraction?.abort(); saveExtraction?.abort(); unsubscribe(); wrap.remove(); void handle?.close(); handle = undefined; } };
}
