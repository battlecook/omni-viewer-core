import type { ClipboardService, HostContext } from '../../host/index.js';
import { parseMcap, MCAP_MAGIC, type McapDocument, type McapParseDeps, type McapParseOptions, type McapPreview } from '../../parsers/mcap/index.js';
import { utf8ByteLength, type ParseOutcome } from '../../parsers/types.js';
import { parseJson } from '../../parsers/json/index.js';
import { serialize } from '../json/transforms.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { mcapViewerCss } from './styles.js';

export * from '../../parsers/mcap/index.js';
export { mcapViewerCss } from './styles.js';
export type McapViewerContext = HostContext & { clipboard?: ClipboardService };
export interface McapMountOptions extends MountOptions { parse?: McapParseOptions }
export const MCAP_VIEWER_META = {
    id: 'mcap', displayNameKey: 'mcap.title', extensions: ['mcap'], priority: 20,
    magicSignatures: [[{ offset: 0, bytes: MCAP_MAGIC }]],
    requiredServices: [] as const, optionalServices: ['clipboard'] as const, inputOwnership: 'borrows' as const
};
type Tab = 'channels' | 'messages' | 'schemas' | 'metadata' | 'attachments' | 'chunks';
interface Row { cells: Array<string | number>; topicId?: number; preview?: McapPreview; encoding?: string }
interface Table { headers: string[]; rows: Row[] }
let nextId = 0;

export async function mountMcapViewer(input: ViewerInput, container: HTMLElement, ctx: McapViewerContext, deps: McapParseDeps = {}, options: McapMountOptions = {}): Promise<ViewerHandle> {
    if (options.signal?.aborted || options.parse?.signal?.aborted) throw new MountAbortedError();
    const outcome = parseMcap(input.data, deps, { ...options.parse, ...(options.signal ? { signal: options.signal } : {}) });
    return mountMcapOutcome(outcome, input.fileName, container, ctx, options);
}

/** Renders both normal and partial reads, including missing optional codecs. */
export function mountMcapOutcome(outcome: ParseOutcome<McapDocument>, fileName: string, container: HTMLElement, ctx: McapViewerContext, options: McapMountOptions = {}): ViewerHandle {
    if (options.signal?.aborted || options.parse?.signal?.aborted || outcome.result.status === 'failed' && outcome.result.failure.code === 'aborted') throw new MountAbortedError();
    const doc = container.ownerDocument, t = ctx.i18n.t.bind(ctx.i18n);
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, value?: string): HTMLElementTagNameMap[K] => {
        const node = doc.createElement(tag);
        if (cls) node.className = `omni-mcap__${cls}`;
        if (value !== undefined) node.textContent = value;
        return node;
    };
    const button = (key: string, cls?: string) => { const node = el('button', cls, t(key)); node.type = 'button'; return node; };
    const root = (options.styleIsolation ?? 'shadow') === 'shadow' ? container.shadowRoot ?? container.attachShadow({ mode: 'open' }) : container;
    const style = root !== container ? el('style') : undefined;
    if (style) { style.textContent = mcapViewerCss; root.append(style); }
    const shell = el('section'); shell.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--mcap', 'omni-mcap');
    const header = el('header', 'header');
    header.append(el('span', 'format', t('mcap.title')), el('h1', 'filename', fileName));
    const warnings = el('div', 'warnings'); warnings.setAttribute('role', 'status');
    shell.append(header, warnings); root.append(shell);
    const listeners: Array<() => void> = [];
    let disposed = false;
    const on = (target: EventTarget, name: string, callback: EventListener) => {
        target.addEventListener(name, callback); listeners.push(() => target.removeEventListener(name, callback));
    };
    const handle: ViewerHandle = { dispose() {
        if (disposed) return;
        disposed = true; listeners.splice(0).forEach(remove => remove()); shell.remove(); style?.remove();
    } };
    const { result } = outcome;
    if (result.status === 'failed') {
        warnings.setAttribute('role', 'alert'); warnings.textContent = t(result.failure.messageKey, result.failure.args);
        return handle;
    }
    const model = result.document;
    warnings.textContent = result.diagnostics.map(diagnostic => t(diagnostic.messageKey, diagnostic.args)).join('\n');
    warnings.hidden = !warnings.textContent;
    const channelMap = new Map(model.channels.map(channel => [channel.id, channel]));
    const schemaMap = new Map(model.schemas.map(schema => [schema.id, schema]));
    const summary = el('dl', 'summary');
    const fields: Array<[string, string | number]> = [
        ['profile', model.profile || '—'], ['library', model.library || '—'], ['fileSize', `${model.fileSizeBytes} B`],
        ['messages', `${!model.scanComplete && !model.statistics ? '≥ ' : ''}${model.messageCount}`],
        ['channels', model.statistics?.channelCount ?? model.channels.length], ['schemas', model.statistics?.schemaCount ?? model.schemas.length],
        ['startTime', formatMcapTime(model.startTime)], ['duration', model.startTime !== null && model.endTime !== null ? formatMcapTime(String(BigInt(model.endTime) - BigInt(model.startTime))) : '—']
    ];
    for (const [key, value] of fields) { const item = el('div'); item.append(el('dt', undefined, t(`mcap.${key}`)), el('dd', undefined, String(value))); summary.append(item); }
    shell.append(summary);
    const tabs: Tab[] = ['channels', 'messages', 'schemas', 'metadata', 'attachments', 'chunks'];
    const nav = el('nav', 'tabs'); nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', t('mcap.title'));
    const tabButtons = new Map<Tab, HTMLButtonElement>();
    const toolbar = el('div', 'toolbar');
    const search = el('input', 'search'); search.type = 'search'; search.maxLength = 256; search.placeholder = t('mcap.search'); search.setAttribute('aria-label', t('mcap.search'));
    const topic = el('select', 'topic'); topic.setAttribute('aria-label', t('mcap.topic'));
    const all = el('option', undefined, t('mcap.allTopics')); all.value = ''; topic.append(all);
    for (const channel of model.channels) { const item = el('option', undefined, `${channel.topic} (${channel.id})`); item.value = String(channel.id); topic.append(item); }
    const copy = button('mcap.copyJson', 'copy'); copy.disabled = !ctx.clipboard;
    if (!ctx.clipboard) copy.title = t('common.noClipboard');
    toolbar.append(search, topic, copy);
    const content = el('div', 'content'); content.setAttribute('role', 'tabpanel');
    const id = `omni-mcap-${++nextId}`; content.id = `${id}-panel`;
    const pagination = el('div', 'pagination');
    const previous = button('common.prevPage'), next = button('common.nextPage'), pageLabel = el('span');
    pageLabel.setAttribute('role', 'status'); pagination.append(previous, pageLabel, next);
    const detail = el('section', 'detail'); detail.hidden = true;
    const detailHeading = el('h2', undefined, t('mcap.payload'));
    const detailControls = el('div', 'detail-controls');
    const text = button('mcap.text'), hex = button('mcap.hex'), close = button('mcap.close');
    detailControls.append(text, hex, close);
    const detailNote = el('p', 'detail-note'), payload = el('pre', 'payload');
    detail.append(detailHeading, detailControls, detailNote, payload);
    const status = el('div', 'status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    shell.append(nav, toolbar, content, pagination, detail, status);
    let active: Tab = 'channels', page = 0, filtered: Row[] = [], selected: Row | undefined, showHex = false;
    const tables: Record<Tab, Table> = {
        channels: {
            headers: ['id', 'topic', 'encoding', 'schema', 'messages'],
            rows: model.channels.map(channel => ({ cells: [channel.id, channel.topic, channel.messageEncoding, schemaMap.get(channel.schemaId)?.name ?? channel.schemaId,
                `${!model.scanComplete && model.statistics?.channelMessageCounts[channel.id] === undefined ? '≥ ' : ''}${channel.messageCount}`], topicId: channel.id }))
        },
        messages: {
            headers: ['topic', 'sequence', 'logTime', 'publishTime', 'size', 'payload'],
            rows: model.messages.map(message => {
                const channel = channelMap.get(message.channelId);
                return { cells: [channel?.topic ?? `#${message.channelId}`, message.sequence, formatMcapTime(message.logTime), formatMcapTime(message.publishTime), message.sizeBytes, message.preview.text.slice(0, 120)],
                    topicId: message.channelId, preview: message.preview, encoding: channel?.messageEncoding ?? '' };
            })
        },
        schemas: { headers: ['id', 'name', 'encoding', 'size'], rows: model.schemas.map(schema => ({ cells: [schema.id, schema.name, schema.encoding, schema.sizeBytes], preview: schema.preview, encoding: schema.encoding })) },
        metadata: { headers: ['name', 'key', 'value'], rows: [
            ...model.metadata.flatMap(item => Object.entries(item.values).map(([key, value]) => ({ cells: [item.name, key, value] }))),
            ...model.channels.flatMap(channel => Object.entries(channel.metadata).map(([key, value]) => ({ cells: [channel.topic, key, value] })))
        ] },
        attachments: { headers: ['name', 'mediaType', 'size', 'logTime', 'createTime'], rows: model.attachments.map(item => ({ cells: [item.name, item.mediaType, item.sizeBytes, formatMcapTime(item.logTime), formatMcapTime(item.createTime)] })) },
        chunks: { headers: ['offset', 'compression', 'compressed', 'uncompressed', 'startTime', 'endTime', 'decoded'], rows: model.chunks.map(chunk => ({ cells: [chunk.offset, chunk.compression || t('mcap.none'), chunk.compressedBytes, chunk.uncompressedBytes, formatMcapTime(chunk.startTime), formatMcapTime(chunk.endTime), t(chunk.decoded ? 'mcap.yes' : 'mcap.no')] })) }
    };
    const renderDetail = () => {
        if (!selected?.preview) { detail.hidden = true; return; }
        detail.hidden = false;
        text.setAttribute('aria-pressed', String(!showHex)); hex.setAttribute('aria-pressed', String(showHex));
        let value = showHex ? selected.preview.hex : selected.preview.text;
        if (!showHex && !selected.preview.truncated && ['json', 'jsonschema'].includes(selected.encoding ?? '')) {
            const { result } = parseJson(value, { maxDepth: 64, limits: { maxInputBytes: 1024 * 1024, maxEntries: 100_000 } });
            if (result.status === 'ok') value = serialize(result.document.root, true);
        }
        payload.textContent = value;
        detailNote.textContent = selected.preview.truncated ? t('mcap.truncated') : t('mcap.payloadHint');
    };
    const render = () => {
        const table = tables[active], query = search.value.trim().toLowerCase();
        filtered = table.rows.filter(row => (!topic.value || active !== 'messages' || row.topicId === Number(topic.value)) && (!query || row.cells.some(cell => String(cell).toLowerCase().includes(query)) || row.preview?.text.toLowerCase().includes(query)));
        const pages = Math.max(1, Math.ceil(filtered.length / 100)); page = Math.min(page, pages - 1);
        content.replaceChildren();
        topic.hidden = active !== 'messages';
        content.setAttribute('aria-labelledby', `${id}-${active}`);
        for (const [tab, node] of tabButtons) { node.setAttribute('aria-selected', String(tab === active)); node.tabIndex = tab === active ? 0 : -1; }
        if (!filtered.length) content.append(el('p', 'empty', t('mcap.empty')));
        else {
            const grid = el('table'); const head = el('thead'), tr = el('tr');
            for (const key of table.headers) { const th = el('th', undefined, t(`mcap.${key}`)); th.scope = 'col'; tr.append(th); }
            if (filtered.some(row => row.preview)) tr.append(el('th', undefined, t('mcap.inspect')));
            head.append(tr); const body = el('tbody');
            for (let i = page * 100; i < Math.min(filtered.length, (page + 1) * 100); i++) {
                const row = filtered[i]!, line = el('tr');
                for (const value of row.cells) { const cell = el('td', undefined, String(value)); cell.title = String(value); line.append(cell); }
                if (row.preview) { const cell = el('td'), inspect = button('mcap.inspect'); inspect.dataset.index = String(i); cell.append(inspect); line.append(cell); }
                body.append(line);
            }
            grid.append(head, body); content.append(grid);
        }
        previous.disabled = page === 0; next.disabled = page + 1 >= pages;
        pageLabel.textContent = `${t('common.page', { page: page + 1, pages })} · ${t('mcap.rows', { count: filtered.length })}`;
    };
    for (const tab of tabs) {
        const node = button(`mcap.${tab}`); node.id = `${id}-${tab}`; node.setAttribute('role', 'tab'); node.setAttribute('aria-controls', content.id);
        tabButtons.set(tab, node); nav.append(node);
        on(node, 'click', () => { active = tab; page = 0; selected = undefined; renderDetail(); render(); });
        on(node, 'keydown', event => {
            const e = event as KeyboardEvent, index = tabs.indexOf(tab);
            const target = e.key === 'ArrowRight' ? (index + 1) % tabs.length : e.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
            if (target < 0) return;
            e.preventDefault(); const nextTab = tabButtons.get(tabs[target]!)!; nextTab.click(); nextTab.focus();
        });
    }
    on(search, 'input', () => { page = 0; selected = undefined; renderDetail(); render(); });
    on(topic, 'change', () => { page = 0; selected = undefined; renderDetail(); render(); });
    on(previous, 'click', () => { page = Math.max(0, page - 1); render(); });
    on(next, 'click', () => { page++; render(); });
    on(content, 'click', event => {
        const target = event.target as HTMLElement;
        const index = target.closest<HTMLButtonElement>('button[data-index]')?.dataset.index;
        if (index === undefined) return;
        selected = filtered[Number(index)]; showHex = !['json', 'jsonschema', 'ros1msg', 'ros2msg', 'ros2idl', 'text'].includes(selected?.encoding ?? ''); renderDetail();
    });
    on(text, 'click', () => { showHex = false; renderDetail(); });
    on(hex, 'click', () => { showHex = true; renderDetail(); });
    on(close, 'click', () => { selected = undefined; renderDetail(); });
    on(copy, 'click', () => {
        if (!ctx.clipboard || disposed) return;
        const rows = filtered.map(row => row.preview ? { cells: row.cells, preview: row.preview, encoding: row.encoding } : row.cells);
        const value = JSON.stringify(selected ?? { table: active, headers: tables[active].headers, rows }, null, 2);
        if (utf8ByteLength(value) > 1024 * 1024) { status.textContent = t('common.copyTooLargeNoExport', { size: utf8ByteLength(value) }); return; }
        void ctx.clipboard.writeText(value).then(() => { if (!disposed) status.textContent = t('common.copied'); }, error => {
            ctx.logger.log('error', `mcap copy failed: ${String(error)}`); if (!disposed) status.textContent = t('mcap.copyFailed');
        });
    });
    render();
    return handle;
}

/** MCAP timestamps have a user-defined epoch, so display exact seconds, never local dates. */
export function formatMcapTime(value: string | null): string {
    if (value === null) return '—';
    const nanos = BigInt(value);
    return `${nanos / 1_000_000_000n}.${String(nanos % 1_000_000_000n).padStart(9, '0')} s`;
}
