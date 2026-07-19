import type { FileSaveService, HostContext } from '../../host/index.js';
import { ARCHIVE_DEFAULT_LIMITS, ArchiveError, openArchiveStream, parseArchive, type ArchiveDecoder, type ArchiveDocument, type ArchiveEntry, type ArchiveEntrySaver, type ArchiveStreamDecoder, type OpenArchiveHandle } from '../../parsers/archive/index.js';
import type { ParseOutcome, ResourceLimits } from '../../parsers/types.js';
import { audioMimeType } from '../../parsers/audio/index.js';
import { videoMimeType } from '../../parsers/video/index.js';
import { detectImageMime } from '../image/decode.js';
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
export type ArchiveViewerContext = HostContext & {
    /** Buffered save: core extracts the entry and hands over its bytes. */
    save?: FileSaveService;
    /** Streaming save: the adapter pipes the entry to disk itself, so a
     *  multi-GB entry is never materialized in memory. Preferred over `save`
     *  when present. */
    saveEntry?: ArchiveEntrySaver;
};
export interface ArchiveMountOptions extends MountOptions { limits?: ResourceLimits; createObjectUrl?(blob: Blob): string; revokeObjectUrl?(url: string): void; }

/** Lazy streaming input: the adapter's path-based decoder opens the archive
 *  without core ever holding the full file bytes (opt-in, opposite the buffered
 *  {@link ViewerInput} path used by vscode/chrome/web). */
export interface ArchiveStreamingSource extends ArchiveStreamDecoder { fileName: string; totalSize?: number; lastModified?: number; }

/** Ceiling for extracting an audio entry into memory for inline playback.
 *  Larger than the text/hex preview budget, but bounded to avoid huge allocations. */
const ARCHIVE_AUDIO_PREVIEW_BYTES = 64 * 1024 * 1024;
/** Ceiling for extracting an image entry into memory for inline preview. */
const ARCHIVE_IMAGE_PREVIEW_BYTES = 32 * 1024 * 1024;
/** Ceiling for extracting a video entry into memory for inline playback. The
 *  whole entry is buffered into a blob URL, so this is the largest of the caps. */
const ARCHIVE_VIDEO_PREVIEW_BYTES = 128 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['jpg','jpeg','png','gif','bmp','webp','svg']);
const hasImageExtension = (path: string): boolean => IMAGE_EXTENSIONS.has(path.toLowerCase().split('.').pop() ?? '');

const blobPart = (data: Uint8Array): Uint8Array<ArrayBuffer> => (data.buffer instanceof ArrayBuffer ? (data as Uint8Array<ArrayBuffer>) : new Uint8Array(data));

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

export function mountArchiveViewer(input: ViewerInput, container: HTMLElement, ctx: ArchiveViewerContext, deps: ArchiveViewerDeps, options?: ArchiveMountOptions): Promise<ViewerHandle>;
export function mountArchiveViewer(source: ArchiveStreamingSource, container: HTMLElement, ctx: ArchiveViewerContext, options?: ArchiveMountOptions): Promise<ViewerHandle>;
export async function mountArchiveViewer(inputOrSource: ViewerInput | ArchiveStreamingSource, container: HTMLElement, ctx: ArchiveViewerContext, depsOrOptions?: ArchiveViewerDeps | ArchiveMountOptions, maybeOptions?: ArchiveMountOptions): Promise<ViewerHandle> {
    const streaming = !('data' in inputOrSource);
    const options: ArchiveMountOptions = ((streaming ? depsOrOptions : maybeOptions) as ArchiveMountOptions | undefined) ?? {};
    if (options.signal?.aborted) throw new MountAbortedError();
    let fileName: string; let totalBytes: number | undefined;
    let parsed: { outcome: ParseOutcome<ArchiveDocument>; handle?: OpenArchiveHandle };
    if (streaming) {
        const source = inputOrSource as ArchiveStreamingSource;
        fileName = source.fileName; totalBytes = source.totalSize;
        parsed = await openArchiveStream(source, { fileName, ...(source.totalSize !== undefined ? { totalSize: source.totalSize } : {}), ...(options.signal ? { signal: options.signal } : {}), ...(options.limits ? { limits: options.limits } : {}) });
    } else {
        const input = inputOrSource as ViewerInput;
        fileName = input.fileName; totalBytes = input.data.byteLength;
        parsed = await parseArchive(input.data, depsOrOptions as ArchiveViewerDeps, { fileName, ...(options.signal ? { signal: options.signal } : {}), ...(options.limits ? { limits: options.limits } : {}) });
    }
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
    const heading = element('div'); heading.append(element('div', 'omni-archive__eyebrow', t('archive.preview')), element('h1', '', fileName), element('p', 'omni-archive__subtitle', t('archive.summary')));
    const pills = element('div', 'omni-archive__pills');
    pills.append(element('span', 'omni-archive__pill', archiveFormat(fileName)), element('span', 'omni-archive__pill', t('archive.entries', { count: entries.length })), element('span', 'omni-archive__pill', formatSize(totalBytes)));
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
    const previewMedia = element('div', 'omni-archive__preview-media'); previewMedia.style.display = 'none';
    const saveButton = element('button', 'omni-archive__save', t('archive.saveEntry')) as HTMLButtonElement;
    saveButton.type = 'button'; saveButton.hidden = !ctx.save && !ctx.saveEntry; saveButton.disabled = true;
    previewPanel.append(previewHeader, previewMeta, preview, previewMedia, saveButton); workspace.append(tableWrap, previewPanel);
    wrap.append(hero, controls, stats, workspace); root.append(wrap);

    let ticket = 0; let extraction: AbortController | undefined; let saveExtraction: AbortController | undefined; let selectedEntry: ArchiveEntry | undefined;
    let previewUrl: string | undefined;
    const createUrl = options.createObjectUrl ?? URL.createObjectURL.bind(URL);
    const revokeUrl = options.revokeObjectUrl ?? URL.revokeObjectURL.bind(URL);
    // Inline display beats author CSS (.omni-archive__preview-media sets display:flex,
    // which would otherwise override the [hidden] attribute), so the text preview and
    // the media preview stay reliably mutually exclusive.
    const clearPreviewMedia = () => { if (previewUrl) { revokeUrl(previewUrl); previewUrl = undefined; } previewMedia.replaceChildren(); previewMedia.style.display = 'none'; preview.style.display = ''; };
    const setPreview = (entry: ArchiveEntry | undefined, status: string, meta: string, content: string) => { clearPreviewMedia(); previewTitle.textContent = entry?.path ?? t('archive.chooseFile'); previewStatus.textContent = status; previewMeta.textContent = meta; preview.textContent = content; };
    const MEDIA_META: Record<'audio' | 'image' | 'video', string> = { audio: 'archive.audioReady', image: 'archive.imageReady', video: 'archive.videoReady' };
    const showMediaPreview = (entry: ArchiveEntry, data: Uint8Array, kind: 'audio' | 'image' | 'video', mimeType: string): void => {
        clearPreviewMedia();
        let objectUrl: string;
        try { objectUrl = createUrl(new Blob([blobPart(data)], { type: mimeType })); }
        catch { setPreview(entry, t('archive.previewUnavailable'), t('archive.mediaUnsupported'), t('archive.previewUnavailable')); return; }
        previewUrl = objectUrl;
        let node: HTMLElement;
        if (kind === 'image') { const img = document.createElement('img'); img.className = 'omni-archive__image'; img.alt = entry.path; img.src = objectUrl; node = img; }
        else { const media = document.createElement(kind); media.controls = true; media.preload = 'metadata'; media.className = `omni-archive__${kind}`; media.src = objectUrl; node = media; }
        previewMedia.replaceChildren(node); previewMedia.style.display = 'flex'; preview.style.display = 'none';
        previewTitle.textContent = entry.path; previewStatus.textContent = t('archive.ready'); previewMeta.textContent = t(MEDIA_META[kind]);
    };
    const select = async (entry: ArchiveEntry): Promise<void> => {
        extraction?.abort(); extraction = undefined; const local = ++ticket;
        selectedEntry = entry; saveButton.disabled = entry.isDirectory;
        if (entry.isDirectory) controller.dispatch({ type: 'toggle-directory', path: entry.path });
        controller.dispatch({ type: 'select', entryId: entry.entryId });
        if (entry.isDirectory) { setPreview(entry, t('archive.directory'), t('archive.directoryHint'), t('archive.directoryContent')); return; }
        if (!handle) return;
        extraction = new AbortController(); const request = extraction;
        setPreview(entry, t('archive.loading'), t('archive.loadingHint'), t('archive.loadingContent'));
        const audioMime = audioMimeType(entry.path);
        const videoMime = !audioMime ? videoMimeType(entry.path) : undefined;
        const imageCandidate = !audioMime && !videoMime && hasImageExtension(entry.path);
        const maxPreview = audioMime ? ARCHIVE_AUDIO_PREVIEW_BYTES : videoMime ? ARCHIVE_VIDEO_PREVIEW_BYTES : imageCandidate ? ARCHIVE_IMAGE_PREVIEW_BYTES : ARCHIVE_DEFAULT_LIMITS.maxPreviewBytes;
        if (entry.uncompressedSize !== undefined && entry.uncompressedSize > maxPreview) { setPreview(entry, t('archive.previewUnavailable'), t('diag.archive.limit-exceeded'), t('archive.previewUnavailable')); return; }
        try {
            const data = await handle.extract(entry.entryId, { signal: request.signal, maxBytes: maxPreview });
            if (local !== ticket) return;
            if (audioMime) { showMediaPreview(entry, data, 'audio', audioMime); return; }
            if (videoMime) { showMediaPreview(entry, data, 'video', videoMime); return; }
            if (imageCandidate) { const imageMime = detectImageMime(data, entry.path); if (imageMime) { showMediaPreview(entry, data, 'image', imageMime); return; } }
            const decoded = tryDecodeArchiveEntryPreview(entry.path, data);
            const text = isText(data);
            setPreview(entry, t('archive.ready'), t(decoded ? 'archive.androidBinaryXmlReady' : text ? 'archive.textReady' : 'archive.binaryReady'), decoded?.content ?? (text ? new TextDecoder().decode(data) : hexPreview(data)));
        } catch (error) {
            if (local === ticket && !request.signal.aborted) setPreview(entry, t('archive.previewUnavailable'), t(error instanceof ArchiveError && error.code === 'limit-exceeded' ? 'diag.archive.limit-exceeded' : 'archive.previewUnavailable'), t('archive.previewUnavailable'));
        }
    };
    saveButton.addEventListener('click', async () => {
        const entry = selectedEntry;
        if (!entry || entry.isDirectory || !handle || (!ctx.save && !ctx.saveEntry)) return;
        saveExtraction?.abort(); saveExtraction = new AbortController(); const request = saveExtraction;
        saveButton.disabled = true; saveButton.textContent = t('archive.savingEntry');
        const suggestedName = entry.path.split('/').filter(Boolean).pop() ?? 'archive-entry';
        try {
            // Streaming save (adapter pipes the entry to disk) is preferred: a
            // multi-GB entry never lands in memory. Buffered save is the fallback.
            if (ctx.saveEntry) {
                const savedName = await ctx.saveEntry.saveEntry(entry, { signal: request.signal });
                if (!request.signal.aborted && savedName) previewMeta.textContent = t('common.saved', { name: savedName });
            } else {
                const configuredLimit = options.limits?.maxDecompressedBytes ?? ARCHIVE_DEFAULT_LIMITS.maxDecompressedBytes;
                const maxBytes = Math.max(1, Math.min(entry.uncompressedSize ?? configuredLimit, configuredLimit));
                const data = await handle.extract(entry.entryId, { signal: request.signal, maxBytes });
                if (request.signal.aborted) return;
                await ctx.save!.saveFile(suggestedName, data, entry.mimeType ?? 'application/octet-stream');
                if (!request.signal.aborted) previewMeta.textContent = t('common.saved', { name: suggestedName });
            }
        } catch {
            if (!request.signal.aborted) previewMeta.textContent = t('archive.saveFailed');
        } finally {
            if (!request.signal.aborted) { saveButton.disabled = false; saveButton.textContent = t('archive.saveEntry'); }
        }
    });
    const ROW_HEIGHT = 43; const OVERSCAN = 8; const FALLBACK_VIEWPORT_HEIGHT = 600;
    let lastStart = -1; let lastEnd = -1; let lastLength = -1;
    let lastQuery: string | undefined; let lastExpanded: ReadonlySet<string> | undefined;
    /** `force` covers state changes (search/select/expand) that must repaint the
     *  rows; scroll events pass `false` so an unchanged window is a no-op. */
    const render = (force = true): void => {
        const visible = controller.visibleEntries();
        // Measure before mutating: emptying the tbody first would collapse the
        // scroll height, so the layout flush from reading clientHeight clamps
        // scrollTop to 0 and every scroll snaps back to the top of the list.
        const viewportHeight = tableWrap.clientHeight || FALLBACK_VIEWPORT_HEIGHT;
        const scrollTop = tableWrap.scrollTop;
        const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
        const count = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
        const end = Math.min(visible.length, start + count);
        // Most scroll ticks land inside the overscan margin. Rebuilding the rows
        // anyway would destroy the focused row on every tick, and the resulting
        // focus restore plus scroll anchoring drags the viewport around.
        // The rendered window is fully determined by these; the controller hands
        // out a fresh `expanded` set per toggle, so identity comparison is enough.
        const sameWindow = start === lastStart && end === lastEnd && visible.length === lastLength
            && controller.state.query === lastQuery && controller.state.expanded === lastExpanded;
        // Most scroll ticks land inside the overscan margin. Rebuilding the rows
        // anyway would destroy the focused row on every tick, and the resulting
        // focus restore plus scroll anchoring drags the viewport around.
        if (!force && sameWindow) return;
        // Selecting an entry only flips a class. Rebuilding every row for that is
        // what threw the viewport back to the top the moment a row was clicked,
        // so patch the existing rows in place and leave the scroll state alone.
        if (sameWindow) {
            for (const row of tbody.querySelectorAll<HTMLElement>('.omni-archive__entry'))
                row.classList.toggle('is-selected', Number(row.dataset.entryId) === controller.state.selectedId);
            return;
        }
        lastStart = start; lastEnd = end; lastLength = visible.length;
        lastQuery = controller.state.query; lastExpanded = controller.state.expanded;
        visibleStat[1] = visible.length;
        stats.querySelectorAll('.omni-archive__stat-value')[3]!.textContent = visible.length.toLocaleString();
        empty.hidden = visible.length !== 0; table.hidden = visible.length === 0;
        const spacer = (height: number): HTMLTableRowElement => { const row = element('tr', 'omni-archive__spacer'); const cell = element('td'); cell.colSpan = 5; cell.style.height = `${height}px`; row.append(cell); return row; };
        // Build off-DOM and swap once, so the tbody is never laid out empty.
        const rows: HTMLTableRowElement[] = [];
        if (start > 0) rows.push(spacer(start * ROW_HEIGHT));
        for (const entry of visible.slice(start, end)) {
            const row = element('tr', `omni-archive__entry${controller.state.selectedId === entry.entryId ? ' is-selected' : ''}`); row.tabIndex = 0; row.dataset.entryId = String(entry.entryId);
            const path = element('td', 'omni-archive__path', `${entry.isDirectory ? (controller.state.expanded.has(entry.path) ? '▾ ' : '▸ ') : ''}${entry.path}`);
            path.style.paddingInlineStart = `${Math.max(0, entry.path.split('/').filter(Boolean).length - 1) * 12 + 14}px`;
            row.append(path, element('td', '', t(entry.isDirectory ? 'archive.directory' : 'archive.file')), element('td', '', formatSize(entry.compressedSize)), element('td', '', formatSize(entry.uncompressedSize)), element('td', '', formatDate(entry.modifiedAt)));
            row.addEventListener('click', () => void select(entry));
            row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void select(entry); } });
            rows.push(row);
        }
        if (end < visible.length) rows.push(spacer((visible.length - end) * ROW_HEIGHT));
        // Recycling rows destroys the focused one; hand focus back to its
        // replacement so keyboard navigation survives a scroll.
        const active = (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot ? root.activeElement : document.activeElement);
        const focusedId = active instanceof HTMLElement && tbody.contains(active) ? active.dataset.entryId : undefined;
        tbody.replaceChildren(...rows);
        // Swapping the rows can still make the browser adjust the offset (focus
        // fixup, anchoring, a transient height change). The list is virtualized,
        // so the pre-swap offset is authoritative — put it back.
        if (tableWrap.scrollTop !== scrollTop) tableWrap.scrollTop = scrollTop;
        if (focusedId !== undefined) rows.find(row => row.dataset.entryId === focusedId)?.focus({ preventScroll: true });
    };
    tableWrap.addEventListener('scroll', () => render(false), { passive: true });
    search.addEventListener('input', () => { tableWrap.scrollTop = 0; controller.dispatch({ type: 'set-search', query: search.value }); });
    const unsubscribe = controller.subscribe(() => render(true)); render();
    return { dispose() { ticket++; extraction?.abort(); saveExtraction?.abort(); clearPreviewMedia(); unsubscribe(); wrap.remove(); void handle?.close(); handle = undefined; } };
}
