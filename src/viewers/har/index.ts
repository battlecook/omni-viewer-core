// HAR viewer: a filterable request list with a per-request waterfall and a
// detail pane for headers, payload, bodies, cookies, and timings — the view a
// web or API failure is actually diagnosed from.
//
// The archive is JSON, so the core JSON layer does the reading (parseHar) and
// the JSON toolbox's serializer pretty-prints JSON bodies; nothing here
// re-implements either. Everything the viewer shows comes from the parsed
// model, and every label is a catalog key (ADR 17/28).

import type { ClipboardService, HostContext } from '../../host/index.js';
import {
    formatByteSize,
    formatMillis,
    parseHar,
    type HarBody,
    type HarCookie,
    type HarDocument,
    type HarEntry,
    type HarNameValue,
    type HarTimingKind
} from '../../parsers/har/index.js';
import { asciiLower } from '../../parsers/csv/index.js';
import { parseJson } from '../../parsers/json/index.js';
import type { Diagnostic } from '../../parsers/types.js';
import { serialize } from '../json/transforms.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { harViewerCss } from './styles.js';

export {
    HAR_DEFAULT_MAX_BODY_CHARS,
    HAR_DEFAULT_MAX_ENTRIES,
    HAR_INPUT_OWNERSHIP,
    formatByteSize,
    formatMillis,
    parseHar,
    parseIso8601Millis,
    splitUrl,
    statusClassOf
} from '../../parsers/har/index.js';
export type {
    HarBody,
    HarCookie,
    HarCreator,
    HarDocument,
    HarEntry,
    HarNameValue,
    HarPage,
    HarParseOptions,
    HarResourceType,
    HarStatusClass,
    HarSummaryItem,
    HarTimingKind,
    HarTimingPhase,
    HarTimings
} from '../../parsers/har/index.js';
export { harViewerCss } from './styles.js';

export const HAR_VIEWER_META = {
    id: 'har',
    displayNameKey: 'har.title',
    extensions: ['har'] as string[],
    priority: 20,
    requiredServices: [] as const,
    optionalServices: ['clipboard'] as const,
    inputOwnership: 'borrows' as const
};

export type HarViewerContext = HostContext & { clipboard?: ClipboardService };

type TabId = 'requests' | 'pages' | 'info';
type DetailTabId = 'headers' | 'payload' | 'response' | 'cookies' | 'timings';
type SortKey = 'index' | 'name' | 'method' | 'status' | 'type' | 'domain' | 'size' | 'time';

/** Rows rendered at once; the filter count always reports the full total. */
const MAX_TABLE_ROWS = 2000;
/** Name/value pairs shown per header or cookie group. */
const MAX_PAIR_ROWS = 200;
/** Body characters handed to the JSON pretty-printer. */
const MAX_PRETTY_CHARS = 256 * 1024;
/**
 * Keystrokes coalesce for this long before the table is rebuilt. A broad match
 * rebuilds up to MAX_TABLE_ROWS rows with their waterfall segments, which is
 * not work to redo on every keypress of a 20,000-entry archive; the filter
 * selects and the sort headers stay immediate, since each is one deliberate
 * action. Exported so tests can drive the delay instead of guessing it.
 */
export const HAR_SEARCH_DEBOUNCE_MS = 150;

const TIMING_KINDS: readonly HarTimingKind[] = ['blocked', 'dns', 'connect', 'ssl', 'send', 'wait', 'receive'];

export async function mountHarViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: HarViewerContext,
    options: MountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const outcome = parseHar(input.data, options.signal ? { signal: options.signal } : {});
    if (options.signal?.aborted) throw new MountAbortedError();
    const { result } = outcome;
    if (result.status === 'failed') {
        return mountHarFailure(result.failure.messageKey, result.failure.args, result.diagnostics, input.fileName, container, ctx, options);
    }
    return mountHarDocument(result.document, input.fileName, container, ctx, options, result.diagnostics);
}

/** Shared shell: style injection plus the frame every mount path renders into. */
function createFrame(
    container: HTMLElement,
    options: MountOptions
): { root: HTMLElement | ShadowRoot; frame: HTMLElement; style?: HTMLStyleElement } {
    let root: HTMLElement | ShadowRoot = container;
    let style: HTMLStyleElement | undefined;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && container.attachShadow) {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        style = element('style');
        style.textContent = harViewerCss;
        root.append(style);
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--har');
    }
    const frame = element('div', 'omni-har');
    root.append(frame);
    return style ? { root, frame, style } : { root, frame };
}

function mountHarFailure(
    messageKey: string,
    args: Record<string, string | number> | undefined,
    diagnostics: readonly Diagnostic[],
    fileName: string,
    container: HTMLElement,
    ctx: HarViewerContext,
    options: MountOptions
): ViewerHandle {
    const { root, frame, style } = createFrame(container, options);
    const header = element('header', 'omni-har__header');
    const heading = element('div');
    heading.append(element('div', 'omni-har__eyebrow', 'HAR'), element('h1', undefined, fileName));
    header.append(heading);
    const warnings = element('section', 'omni-har__warnings');
    warnings.setAttribute('role', 'status');
    warnings.append(element('div', undefined, ctx.i18n.t(messageKey, args)));
    for (const diagnostic of diagnostics) warnings.append(element('div', undefined, diagnosticText(ctx, diagnostic)));
    frame.append(header, warnings, element('div', 'omni-har__empty', ctx.i18n.t('har.unreadable')));
    return {
        dispose(): void {
            frame.remove();
            style?.remove();
            if (!(root instanceof ShadowRoot)) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--har');
        }
    };
}

export function mountHarDocument(
    model: HarDocument,
    fileName: string,
    container: HTMLElement,
    ctx: HarViewerContext,
    options: MountOptions = {},
    diagnostics: readonly Diagnostic[] = []
): ViewerHandle {
    if (options.signal?.aborted) throw new MountAbortedError();
    const { root, frame, style } = createFrame(container, options);
    const t = (key: string, args?: Record<string, string | number>): string => ctx.i18n.t(key, args);

    /* ── header, summary ─────────────────────────────────────────────────── */
    const header = element('header', 'omni-har__header');
    const heading = element('div');
    const subtitle = [
        model.creator.name ? `${model.creator.name}${model.creator.version ? ` ${model.creator.version}` : ''}` : t('har.unknownCreator'),
        model.browser?.name ? `${model.browser.name}${model.browser.version ? ` ${model.browser.version}` : ''}` : '',
        model.version ? t('har.version', { version: model.version }) : '',
        t('har.requestCount', { count: model.entries.length })
    ].filter(part => part);
    heading.append(
        element('div', 'omni-har__eyebrow', 'HAR'),
        element('h1', undefined, fileName),
        element('div', 'omni-har__subtitle', subtitle.join(' · '))
    );
    header.append(heading);

    const summary = element('section', 'omni-har__summary');
    for (const item of model.summary) {
        const card = element('div', 'omni-har__summary-item');
        card.append(element('div', 'omni-har__summary-value', item.value), element('div', 'omni-har__summary-label', t(item.labelKey)));
        summary.append(card);
    }

    /* ── toolbar ─────────────────────────────────────────────────────────── */
    const toolbar = element('div', 'omni-har__toolbar');
    const search = element('input', 'omni-har__search') as HTMLInputElement;
    search.type = 'search';
    search.placeholder = t('har.search');
    search.setAttribute('aria-label', t('har.search'));
    const bodyToggleLabel = element('label', 'omni-har__toggle');
    const bodyToggle = element('input') as HTMLInputElement;
    bodyToggle.type = 'checkbox';
    bodyToggleLabel.append(bodyToggle, element('span', undefined, t('har.searchBodies')));

    const methodFilter = filterSelect(t('har.filter.method'), [['', t('har.filter.allMethods')], ...model.methods.map(method => [method, method] as [string, string])]);
    const statusFilter = filterSelect(t('har.filter.status'), [['', t('har.filter.allStatuses')], ...model.statusClasses.map(klass => [klass, t(`har.statusClass.${klass}`)] as [string, string])]);
    const typeFilter = filterSelect(t('har.filter.type'), [['', t('har.filter.allTypes')], ...model.resourceTypes.map(type => [type, t(`har.type.${type}`)] as [string, string])]);
    const hostFilter = filterSelect(t('har.filter.domain'), [['', t('har.filter.allDomains')], ...model.hosts.map(host => [host, host] as [string, string])]);

    const tabs = element('div', 'omni-har__tabs');
    const copy = element('button', undefined, t('har.copyEntry')) as HTMLButtonElement;
    copy.type = 'button';
    toolbar.append(search, bodyToggleLabel, methodFilter, statusFilter, typeFilter, hostFilter, tabs, copy);

    const warnings = element('section', 'omni-har__warnings');
    warnings.setAttribute('role', 'status');
    for (const diagnostic of diagnostics) warnings.append(element('div', undefined, diagnosticText(ctx, diagnostic)));
    warnings.hidden = diagnostics.length === 0;

    const content = element('main', 'omni-har__content');
    frame.append(header, summary, toolbar, warnings, content);

    /* ── state ───────────────────────────────────────────────────────────── */
    let activeTab: TabId = 'requests';
    let detailTab: DetailTabId = 'headers';
    let selected: HarEntry | undefined = model.entries[0];
    let sortKey: SortKey = 'index';
    let sortAscending = true;
    const disposers: Array<() => void> = [];
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, listener: (event: HTMLElementEventMap[K]) => void): void => {
        target.addEventListener(type, listener as EventListener);
        disposers.push(() => target.removeEventListener(type, listener as EventListener));
    };

    /** Lower-cased metadata + headers per entry, built on the first search so
     *  an archive nobody searches costs nothing. Both caches hold a lowered
     *  copy of text the model already holds, so together they stay within the
     *  same order as the parser's own allocation — which `maxInputBytes` and
     *  the body preview cap bound. */
    const searchIndex: Array<string | undefined> = new Array(model.entries.length);
    const indexText = (entry: HarEntry): string => {
        const cached = searchIndex[entry.index];
        if (cached !== undefined) return cached;
        const parts = [
            entry.url, entry.name, entry.method, String(entry.status), entry.statusText, entry.mimeType,
            entry.host, entry.resourceType, entry.httpVersion, entry.serverIpAddress, entry.error, entry.pageRef
        ];
        for (const pair of [...entry.requestHeaders, ...entry.responseHeaders, ...entry.queryString]) {
            parts.push(pair.name, pair.value);
        }
        const text = asciiLower(parts.join(' '));
        searchIndex[entry.index] = text;
        return text;
    };
    /** Same lazy cache for the body previews, which the opt-in search scans.
     *  Lower-casing up to 64 KB per entry on every keystroke is what makes an
     *  archive of this size unusable, so it is done once per entry. */
    const bodyIndex: Array<string | undefined> = new Array(model.entries.length);
    const bodyText = (entry: HarEntry): string => {
        const cached = bodyIndex[entry.index];
        if (cached !== undefined) return cached;
        const text = asciiLower(`${entry.requestBody?.text ?? ''} ${entry.responseBody.text}`);
        bodyIndex[entry.index] = text;
        return text;
    };

    /** The needle is lowered once per pass by the caller — doing it inside the
     *  predicate would repeat it for every entry in the archive. */
    const matches = (entry: HarEntry, needle: string, searchBodies: boolean): boolean => {
        if (methodFilter.value && entry.method !== methodFilter.value) return false;
        if (statusFilter.value && entry.statusClass !== statusFilter.value) return false;
        if (typeFilter.value && entry.resourceType !== typeFilter.value) return false;
        if (hostFilter.value && entry.host !== hostFilter.value) return false;
        if (!needle) return true;
        if (indexText(entry).includes(needle)) return true;
        return searchBodies && bodyText(entry).includes(needle);
    };

    const durationOf = (entry: HarEntry): number => entry.time > 0 ? entry.time : entry.timings.total;
    /** '—' for an entry the archive never timed: 0 ms would read as measured. */
    const durationLabel = (entry: HarEntry): string =>
        entry.time >= 0 || entry.timings.total > 0 ? formatMillis(durationOf(entry)) : '—';
    const sortValue = (entry: HarEntry): string | number => {
        switch (sortKey) {
            case 'name': return asciiLower(entry.name);
            case 'method': return entry.method;
            case 'status': return entry.status;
            // The localized label, not the enum id: a ja/ko/zh column sorted by
            // 'binary' < 'document' < 'font' reads as unsorted.
            case 'type': return asciiLower(t(`har.type.${entry.resourceType}`));
            case 'domain': return asciiLower(entry.host);
            case 'size': return entry.transferredBytes;
            case 'time': return durationOf(entry);
            default: return entry.index;
        }
    };
    const visibleEntries = (): HarEntry[] => {
        const needle = asciiLower(search.value.trim());
        const searchBodies = bodyToggle.checked;
        const rows = model.entries.filter(entry => matches(entry, needle, searchBodies));
        if (sortKey !== 'index' || !sortAscending) {
            rows.sort((a, b) => {
                const left = sortValue(a);
                const right = sortValue(b);
                // Code-unit comparison, never localeCompare (ADR 41) — the same
                // archive must sort identically on every platform. The tie-break
                // is applied *after* the direction so arrival order survives a
                // descending sort: in a network log the low-cardinality columns
                // are almost all ties, and arrival order is the reading order.
                const primary = left === right ? 0 : left < right ? -1 : 1;
                return (sortAscending ? primary : -primary) || a.index - b.index;
            });
        }
        return rows;
    };

    /* ── tabs ────────────────────────────────────────────────────────────── */
    const tabButtons = new Map<TabId, HTMLButtonElement>();
    const tabItems: Array<[TabId, string]> = [['requests', t('har.requests')], ['pages', t('har.pages')], ['info', t('har.info')]];
    for (const [id, label] of tabItems) {
        const button = element('button', undefined, label) as HTMLButtonElement;
        button.type = 'button';
        on(button, 'click', () => { cancelSearch(); activeTab = id; renderTabs(); renderContent(); });
        tabButtons.set(id, button);
        tabs.append(button);
    }
    const renderTabs = (): void => {
        for (const [id, button] of tabButtons) button.setAttribute('aria-pressed', String(activeTab === id));
        copy.hidden = activeTab !== 'requests';
    };

    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelSearch = (): void => {
        if (searchTimer !== undefined) clearTimeout(searchTimer);
        searchTimer = undefined;
    };
    /** A filter change affects the row list and nothing else, so the detail
     *  pane — and whatever focus and scroll position it holds — is left alone.
     *  Rebuilding the whole content subtree here would drop keyboard focus
     *  150 ms after the last keystroke, with no user action to explain it. */
    const renderFiltered = (): void => { if (activeTab === 'requests') renderRows(); };
    on(search, 'input', () => {
        cancelSearch();
        searchTimer = setTimeout(() => { searchTimer = undefined; renderFiltered(); }, HAR_SEARCH_DEBOUNCE_MS);
    });
    // An explicit control acts at once and retires the pending keystroke render.
    on(bodyToggle, 'change', () => { cancelSearch(); renderFiltered(); });
    for (const filter of [methodFilter, statusFilter, typeFilter, hostFilter]) {
        on(filter, 'change', () => { cancelSearch(); renderFiltered(); });
    }
    on(copy, 'click', () => {
        if (!selected || !ctx.clipboard) return;
        void ctx.clipboard.writeText(JSON.stringify(selected, null, 2));
    });

    /* ── requests tab ────────────────────────────────────────────────────── */
    const scale = model.timelineSpanMillis;
    const list = element('div', 'omni-har__list');
    const detail = element('aside', 'omni-har__detail');
    const rowElements = new Map<number, HTMLElement>();

    const renderRequests = (): void => {
        const layout = element('div', 'omni-har__layout');
        list.replaceChildren();
        detail.replaceChildren();
        layout.append(list, detail);
        content.append(layout, legend());
        renderRows();
        renderDetail();
    };

    /** Header buttons of the current render, so the sort that was just pressed
     *  can get its focus back — the click rebuilds the table head it sits in. */
    const headerButtons = new Map<SortKey, HTMLButtonElement>();
    let focusHeader: SortKey | undefined;

    const sortableHeader = (key: SortKey, labelKey: string): HTMLTableCellElement => {
        const cell = element('th');
        const button = element('button', undefined, t(labelKey)) as HTMLButtonElement;
        button.type = 'button';
        if (sortKey === key) {
            cell.setAttribute('aria-sort', sortAscending ? 'ascending' : 'descending');
            button.textContent = `${t(labelKey)} ${sortAscending ? '▲' : '▼'}`;
        }
        // Not registered through `on()`: this element is replaced on every
        // render, so its listener dies with it and collecting one per render in
        // the mount-lifetime disposer list would leak both listeners and the
        // detached tables they pin.
        button.addEventListener('click', () => {
            if (sortKey === key) sortAscending = !sortAscending;
            else { sortKey = key; sortAscending = key !== 'size' && key !== 'time'; }
            focusHeader = key;
            renderRows();
        });
        headerButtons.set(key, button);
        cell.append(button);
        return cell;
    };

    /** The focused row's entry, if focus is currently parked in the row list —
     *  the rebuild below replaces every row element, and a keyboard user must
     *  not lose their place because a debounced filter landed. */
    const focusedRow = (): number | undefined => {
        const active = (root instanceof ShadowRoot ? root.activeElement : document.activeElement) as HTMLElement | null;
        if (!active?.classList.contains('omni-har__row')) return undefined;
        for (const [index, row] of rowElements) if (row === active) return index;
        return undefined;
    };

    const renderRows = (): void => {
        const restoreRow = focusedRow();
        list.replaceChildren();
        rowElements.clear();
        headerButtons.clear();
        const rows = visibleEntries();
        const shown = rows.slice(0, MAX_TABLE_ROWS);
        const panel = element('div', 'omni-har__panel-header');
        panel.append(
            element('h2', undefined, t('har.requests')),
            element('span', undefined, t('har.rows', { shown: shown.length, total: rows.length }))
        );
        list.append(panel);
        // Consumed before the empty-result return: a flag left set would hand
        // focus to a header button on some later, unrelated render.
        const restoreFocus = focusHeader;
        focusHeader = undefined;
        if (rows.length === 0) {
            list.append(element('div', 'omni-har__empty', t(model.entries.length ? 'har.noMatches' : 'har.noEntries')));
            return;
        }
        const table = element('table');
        const headRow = element('tr');
        headRow.append(
            sortableHeader('index', 'har.column.index'),
            sortableHeader('name', 'har.column.name'),
            sortableHeader('method', 'har.column.method'),
            sortableHeader('status', 'har.column.status'),
            sortableHeader('type', 'har.column.type'),
            sortableHeader('domain', 'har.column.domain'),
            sortableHeader('size', 'har.column.size'),
            sortableHeader('time', 'har.column.time')
        );
        const waterfallHead = element('th', 'omni-har__waterfall', t('har.column.waterfall'));
        headRow.append(waterfallHead);
        const head = element('thead');
        head.append(headRow);
        const body = element('tbody');
        for (const entry of shown) body.append(renderRow(entry));
        table.append(head, body);
        list.append(table);
        // A row that the filter dropped has nothing to focus; the header and a
        // row are never both pending, since activating one moves focus to it.
        if (restoreFocus) headerButtons.get(restoreFocus)?.focus();
        else if (restoreRow !== undefined) rowElements.get(restoreRow)?.focus();
    };

    const renderRow = (entry: HarEntry): HTMLElement => {
        const row = element('tr', 'omni-har__row');
        row.tabIndex = 0;
        if (entry.statusClass === '4xx' || entry.statusClass === '5xx' || entry.error) row.classList.add('omni-har__row--error');
        if (selected?.index === entry.index) row.classList.add('omni-har__row--selected');

        const name = element('td');
        const stack = element('div', 'omni-har__name');
        stack.append(element('strong', undefined, entry.name || entry.url), element('small', undefined, entry.path + (entry.query ? `?${entry.query}` : '')));
        name.title = entry.url;
        name.append(stack);

        const status = element('td');
        const pill = element('span', `omni-har__status omni-har__status--${entry.statusClass}`, entry.status > 0 ? String(entry.status) : t('har.failed'));
        pill.title = entry.error || entry.statusText;
        status.append(pill);

        const type = element('td');
        type.append(element('span', 'omni-har__chip', t(`har.type.${entry.resourceType}`)));
        type.title = entry.mimeType;

        const size = element('td', undefined, entry.transferredBytes > 0 ? formatByteSize(entry.transferredBytes) : entry.fromCache ? t('har.cached') : '—');
        size.title = t('har.resourceSize', { size: formatByteSize(entry.resourceBytes) });

        row.append(
            element('td', undefined, String(entry.index + 1)),
            name,
            element('td', undefined, entry.method),
            status,
            type,
            element('td', undefined, entry.host || '—'),
            size,
            element('td', undefined, durationLabel(entry)),
            waterfallCell(entry)
        );
        row.addEventListener('click', () => select(entry));
        row.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(entry); }
        });
        rowElements.set(entry.index, row);
        return row;
    };

    const waterfallCell = (entry: HarEntry): HTMLTableCellElement => {
        const cell = element('td', 'omni-har__waterfall');
        const duration = durationOf(entry);
        if (scale <= 0 || entry.startedMillis === null || duration <= 0) {
            cell.append(element('span', undefined, '—'));
            return cell;
        }
        const track = element('div', 'omni-har__track');
        const bar = element('div', 'omni-har__bar');
        const left = Math.min(100, (entry.offsetMillis / scale) * 100);
        bar.style.left = `${left}%`;
        bar.style.width = `${Math.max(0.6, Math.min(100 - left, (duration / scale) * 100))}%`;
        // Phases are laid out proportionally inside the bar. An entry whose
        // archive timed nothing still gets one solid bar for its duration, but
        // in a neutral colour outside the legend and labelled as the duration:
        // attributing it to a phase the archive reports as n/a would put a
        // measurement in the reader's hands that nobody took.
        if (entry.timings.phases.length) {
            for (const phase of entry.timings.phases) {
                const segment = element('div', `omni-har__phase omni-har__phase--${phase.kind}`);
                segment.style.flex = `${phase.millis} 0 0`;
                segment.title = `${t(`har.timing.${phase.kind}`)} ${formatMillis(phase.millis)}`;
                bar.append(segment);
            }
        } else {
            const segment = element('div', 'omni-har__phase omni-har__phase--untimed');
            segment.style.flex = '1 0 0';
            segment.title = `${t('har.field.time')} ${formatMillis(duration)}`;
            bar.append(segment);
        }
        track.append(bar);
        track.title = `${t('har.startedAt', { offset: formatMillis(entry.offsetMillis) })} · ${formatMillis(duration)}`;
        cell.append(track);
        return cell;
    };

    const legend = (): HTMLElement => {
        const bar = element('div', 'omni-har__legend');
        for (const kind of TIMING_KINDS) {
            const item = element('span');
            item.append(element('i', `omni-har__swatch omni-har__phase--${kind}`), element('span', undefined, t(`har.timing.${kind}`)));
            bar.append(item);
        }
        return bar;
    };

    const select = (entry: HarEntry): void => {
        if (selected?.index === entry.index) return;
        const previous = selected ? rowElements.get(selected.index) : undefined;
        previous?.classList.remove('omni-har__row--selected');
        selected = entry;
        rowElements.get(entry.index)?.classList.add('omni-har__row--selected');
        copy.disabled = !ctx.clipboard;
        renderDetail();
    };

    /* ── detail pane ─────────────────────────────────────────────────────── */
    const detailItems: Array<[DetailTabId, string]> = [
        ['headers', t('har.detail.headers')], ['payload', t('har.detail.payload')],
        ['response', t('har.detail.response')], ['cookies', t('har.detail.cookies')],
        ['timings', t('har.detail.timings')]
    ];

    let focusDetailTab: DetailTabId | undefined;
    const renderDetail = (): void => {
        detail.replaceChildren();
        const entry = selected;
        if (!entry) {
            detail.append(element('div', 'omni-har__empty', t('har.selectRequest')));
            return;
        }
        const head = element('div', 'omni-har__detail-header');
        head.append(
            element('h2', undefined, `${entry.method} ${entry.name || entry.url}`),
            element('div', undefined, [
                entry.status > 0 ? `${entry.status} ${entry.statusText}`.trim() : t('har.failed'),
                entry.mimeType,
                // Dropped entirely when unknown, rather than shown as 0 ms.
                entry.time >= 0 || entry.timings.total > 0 ? formatMillis(durationOf(entry)) : ''
            ].filter(part => part).join(' · ')),
            element('div', undefined, entry.url)
        );
        const strip = element('div', 'omni-har__detail-tabs');
        const stripButtons = new Map<DetailTabId, HTMLButtonElement>();
        for (const [id, label] of detailItems) {
            const button = element('button', undefined, label) as HTMLButtonElement;
            button.type = 'button';
            button.setAttribute('aria-pressed', String(detailTab === id));
            button.addEventListener('click', () => { detailTab = id; focusDetailTab = id; renderDetail(); });
            stripButtons.set(id, button);
            strip.append(button);
        }
        const body = element('div', 'omni-har__detail-body');
        detail.append(head, strip, body);
        // The pressed tab button is replaced by this very render, so keyboard
        // focus has to be handed to its replacement.
        if (focusDetailTab) {
            stripButtons.get(focusDetailTab)?.focus();
            focusDetailTab = undefined;
        }
        if (detailTab === 'headers') renderHeadersTab(body, entry);
        else if (detailTab === 'payload') renderPayloadTab(body, entry);
        else if (detailTab === 'response') renderResponseTab(body, entry);
        else if (detailTab === 'cookies') renderCookiesTab(body, entry);
        else renderTimingsTab(body, entry);
    };

    const renderHeadersTab = (body: HTMLElement, entry: HarEntry): void => {
        const general: Array<[string, string]> = [
            [t('har.field.url'), entry.url],
            [t('har.field.method'), entry.method],
            [t('har.field.status'), entry.status > 0 ? `${entry.status} ${entry.statusText}`.trim() : t('har.failed')],
            [t('har.field.protocol'), entry.httpVersion || '—'],
            [t('har.field.type'), `${t(`har.type.${entry.resourceType}`)}${entry.mimeType ? ` · ${entry.mimeType}` : ''}`],
            [t('har.field.started'), entry.startedDateTime || '—'],
            // An unparseable start time has no offset — 0 would read as one.
            [t('har.field.offset'), entry.startedMillis === null ? '—' : formatMillis(entry.offsetMillis)],
            [t('har.field.time'), durationLabel(entry)],
            [t('har.field.transferred'), entry.transferredBytes > 0 ? formatByteSize(entry.transferredBytes) : entry.fromCache ? t('har.cached') : '—'],
            [t('har.field.resourceSize'), formatByteSize(entry.resourceBytes)],
            [t('har.field.remoteAddress'), entry.serverIpAddress || '—'],
            [t('har.field.connection'), entry.connection || '—']
        ];
        if (entry.redirectUrl) general.push([t('har.field.redirect'), entry.redirectUrl]);
        if (entry.pageRef) general.push([t('har.field.page'), entry.pageRef]);
        if (entry.error) general.push([t('har.field.error'), entry.error]);
        if (entry.comment) general.push([t('har.field.comment'), entry.comment]);
        body.append(element('h3', undefined, t('har.detail.general')), definitionList(general));
        appendPairs(body, t('har.detail.requestHeaders'), entry.requestHeaders);
        appendPairs(body, t('har.detail.responseHeaders'), entry.responseHeaders);
    };

    const renderPayloadTab = (body: HTMLElement, entry: HarEntry): void => {
        appendPairs(body, t('har.detail.queryString'), entry.queryString);
        body.append(element('h3', undefined, t('har.detail.requestBody')));
        const request = entry.requestBody;
        if (!request) {
            body.append(element('div', 'omni-har__note', t('har.body.none')));
            return;
        }
        if (request.mimeType) body.append(element('div', 'omni-har__note', request.mimeType));
        if (request.params.length) {
            body.append(definitionList(request.params.slice(0, MAX_PAIR_ROWS).map(pair => [pair.name, pair.value] as [string, string])));
            appendCapNote(body, request.params.length);
        }
        if (request.text || !request.params.length) appendBody(body, request);
    };

    const renderResponseTab = (body: HTMLElement, entry: HarEntry): void => {
        const actions = element('div', 'omni-har__actions');
        const copyBody = element('button', undefined, t('har.copyBody')) as HTMLButtonElement;
        copyBody.type = 'button';
        copyBody.disabled = !ctx.clipboard || !entry.responseBody.text;
        if (!ctx.clipboard) copyBody.title = t('common.noClipboard');
        copyBody.addEventListener('click', () => { void ctx.clipboard?.writeText(entry.responseBody.text); });
        actions.append(copyBody);
        body.append(actions, element('h3', undefined, t('har.detail.responseBody')));
        const meta: Array<[string, string]> = [
            [t('har.field.mimeType'), entry.responseBody.mimeType || '—'],
            // Same `content.size` node as entry.resourceBytes, -1 and all.
            [t('har.field.resourceSize'), formatByteSize(entry.responseBody.size)]
        ];
        if (entry.responseBody.encoding) meta.push([t('har.field.encoding'), entry.responseBody.encoding]);
        if (entry.responseBody.compression !== null) meta.push([t('har.field.compression'), formatByteSize(Math.max(0, entry.responseBody.compression))]);
        body.append(definitionList(meta));
        appendBody(body, entry.responseBody);
    };

    const renderCookiesTab = (body: HTMLElement, entry: HarEntry): void => {
        appendCookies(body, t('har.detail.requestCookies'), entry.requestCookies);
        appendCookies(body, t('har.detail.responseCookies'), entry.responseCookies);
    };

    const renderTimingsTab = (body: HTMLElement, entry: HarEntry): void => {
        body.append(element('h3', undefined, t('har.detail.timings')));
        const total = entry.timings.total;
        if (!entry.timings.phases.length) {
            body.append(element('div', 'omni-har__note', t('har.noTimings')));
        }
        for (const phase of entry.timings.phases) {
            const row = element('div', 'omni-har__phase-row');
            const bar = element('div', `omni-har__phase-bar omni-har__phase--${phase.kind}`);
            bar.style.width = `${total > 0 ? Math.max(2, (phase.millis / total) * 100) : 0}%`;
            row.append(element('span', undefined, t(`har.timing.${phase.kind}`)), bar, element('span', undefined, formatMillis(phase.millis)));
            body.append(row);
        }
        const rows: Array<[string, string]> = TIMING_KINDS.map(kind => [
            t(`har.timing.${kind}`),
            entry.timings[kind] < 0 ? t('har.notApplicable') : formatMillis(entry.timings[kind])
        ]);
        // `total` is 0 exactly when nothing was timed; 0 ms between seven n/a
        // rows and a real duration reads as a measurement nobody took.
        rows.push([t('har.timing.total'), entry.timings.phases.length ? formatMillis(total) : t('har.notApplicable')]);
        if (entry.time >= 0) rows.push([t('har.field.time'), formatMillis(entry.time)]);
        body.append(element('h3', undefined, t('har.detail.rawTimings')), definitionList(rows));
    };

    const appendPairs = (body: HTMLElement, title: string, pairs: readonly HarNameValue[]): void => {
        body.append(element('h3', undefined, `${title} (${pairs.length})`));
        if (!pairs.length) {
            body.append(element('div', 'omni-har__note', t('har.body.none')));
            return;
        }
        body.append(definitionList(pairs.slice(0, MAX_PAIR_ROWS).map(pair => [pair.name, pair.value] as [string, string])));
        appendCapNote(body, pairs.length);
    };

    const appendCookies = (body: HTMLElement, title: string, cookies: readonly HarCookie[]): void => {
        body.append(element('h3', undefined, `${title} (${cookies.length})`));
        if (!cookies.length) {
            body.append(element('div', 'omni-har__note', t('har.body.none')));
            return;
        }
        const rows: Array<[string, string]> = [];
        for (const cookie of cookies.slice(0, MAX_PAIR_ROWS)) {
            const flags = [
                cookie.domain, cookie.path, cookie.expires,
                cookie.httpOnly ? 'HttpOnly' : '', cookie.secure ? 'Secure' : ''
            ].filter(flag => flag);
            rows.push([cookie.name, flags.length ? `${cookie.value} · ${flags.join(' · ')}` : cookie.value]);
        }
        body.append(definitionList(rows));
        appendCapNote(body, cookies.length);
    };

    /** Rows past the cap are dropped from the DOM, never silently. */
    const appendCapNote = (body: HTMLElement, total: number): void => {
        if (total > MAX_PAIR_ROWS) {
            body.append(element('div', 'omni-har__note', t('har.moreRows', { count: total - MAX_PAIR_ROWS })));
        }
    };

    /** Body preview: pretty-printed through the core JSON layer when the body
     *  really is JSON, verbatim text otherwise, and a size note for bytes. */
    const appendBody = (body: HTMLElement, content_: HarBody): void => {
        if (content_.binary) {
            body.append(element('div', 'omni-har__note', t('har.body.binary', { size: formatByteSize(content_.size) })));
            return;
        }
        if (!content_.text) {
            body.append(element('div', 'omni-har__note', t('har.body.empty')));
            return;
        }
        const pre = element('pre', 'omni-har__body');
        const pretty = content_.json ? prettyJson(content_.text) : null;
        if (pretty) highlightJson(pre, pretty);
        else pre.textContent = content_.text;
        body.append(pre);
        if (content_.truncated) body.append(element('div', 'omni-har__note', t('har.body.truncated')));
        if (content_.incomplete) body.append(element('div', 'omni-har__note', t('har.body.incomplete')));
    };

    /* ── pages and info tabs ─────────────────────────────────────────────── */
    const renderPages = (): void => {
        const panel = element('div', 'omni-har__panel-header');
        panel.append(element('h2', undefined, t('har.pages')), element('span', undefined, t('har.rows', { shown: model.pages.length, total: model.pages.length })));
        list.replaceChildren(panel);
        content.append(list);
        if (!model.pages.length) {
            list.append(element('div', 'omni-har__empty', t('har.noPages')));
            return;
        }
        const table = element('table');
        const headRow = element('tr');
        for (const key of ['har.column.page', 'har.column.title', 'har.column.started', 'har.column.contentLoad', 'har.column.load', 'har.column.requests']) {
            headRow.append(element('th', undefined, t(key)));
        }
        const head = element('thead');
        head.append(headRow);
        const tbody = element('tbody');
        for (const page of model.pages) {
            const row = element('tr');
            for (const cell of [
                page.id, page.title, page.startedDateTime,
                page.onContentLoad >= 0 ? formatMillis(page.onContentLoad) : '—',
                page.onLoad >= 0 ? formatMillis(page.onLoad) : '—',
                String(page.entryCount)
            ]) {
                const td = element('td', undefined, cell || '—');
                td.title = cell;
                row.append(td);
            }
            tbody.append(row);
        }
        table.append(head, tbody);
        list.append(table);
    };

    const renderInfo = (): void => {
        const earliest = model.entries.find(entry => entry.startedMillis !== null && entry.startedMillis === model.timelineStartMillis);
        const rows: Array<[string, string]> = [
            [t('har.info.version'), model.version || '—'],
            [t('har.info.creator'), [model.creator.name, model.creator.version].filter(part => part).join(' ') || '—'],
            [t('har.info.browser'), model.browser ? [model.browser.name, model.browser.version].filter(part => part).join(' ') : '—'],
            [t('har.info.entries'), model.totalEntries > model.entries.length ? `${model.entries.length} / ${model.totalEntries}` : String(model.entries.length)],
            [t('har.info.pages'), String(model.pages.length)],
            [t('har.info.domains'), model.hosts.join(', ') || '—'],
            [t('har.info.methods'), model.methods.join(', ') || '—'],
            [t('har.info.firstRequest'), earliest?.startedDateTime || '—'],
            [t('har.info.elapsed'), model.timelineStartMillis === null ? '—' : formatMillis(model.timelineSpanMillis)],
            [t('har.info.totalTime'), formatMillis(model.totalTimeMillis)],
            [t('har.info.transferred'), formatByteSize(model.transferredBytes)],
            [t('har.info.resources'), formatByteSize(model.resourceBytes)],
            [t('har.info.errors'), String(model.errorCount)]
        ];
        if (model.creator.comment) rows.push([t('har.info.creatorComment'), model.creator.comment]);
        if (model.comment) rows.push([t('har.field.comment'), model.comment]);
        const panel = element('div', 'omni-har__panel-header');
        panel.append(element('h2', undefined, t('har.info')));
        const wrap = element('div', 'omni-har__list');
        wrap.append(panel, definitionList(rows));
        content.append(wrap);
    };

    const definitionList = (rows: Array<[string, string]>): HTMLElement => {
        const dl = element('dl', 'omni-har__props');
        for (const [key, value] of rows) {
            dl.append(element('dt', undefined, key), element('dd', undefined, value || '—'));
        }
        return dl;
    };

    function renderContent(): void {
        content.replaceChildren();
        if (activeTab === 'requests') renderRequests();
        else if (activeTab === 'pages') renderPages();
        else renderInfo();
    }

    copy.disabled = !ctx.clipboard;
    if (!ctx.clipboard) copy.title = t('common.noClipboard');
    renderTabs();
    renderContent();

    return {
        dispose(): void {
            cancelSearch();
            disposers.splice(0).forEach(dispose => dispose());
            frame.remove();
            style?.remove();
            if (!(root instanceof ShadowRoot)) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--har');
        }
    };
}

/** Pretty-print through the core JSON layer: the shape test in the parser is
 *  cheap and can be wrong, so a body that does not actually parse falls back to
 *  its verbatim text instead of being reformatted. */
function prettyJson(text: string): string | null {
    if (text.length > MAX_PRETTY_CHARS) return null;
    const { result } = parseJson(text);
    if (result.status !== 'ok') return null;
    return serialize(result.document.root, true);
}

/** Colour pretty-printed JSON. The input is always serializer output, so the
 *  token scan cannot be led astray by stray quotes. */
function highlightJson(target: HTMLElement, text: string): void {
    target.replaceChildren();
    const token = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = token.exec(text))) {
        if (match.index > last) target.append(document.createTextNode(text.slice(last, match.index)));
        const value = match[0];
        const className = value.startsWith('"')
            ? (/^\s*:/.test(text.slice(token.lastIndex)) ? 'omni-har__json-key' : 'omni-har__json-string')
            : value === 'true' || value === 'false' ? 'omni-har__json-boolean'
                : value === 'null' ? 'omni-har__json-null' : 'omni-har__json-number';
        target.append(element('span', className, value));
        last = token.lastIndex;
    }
    if (last < text.length) target.append(document.createTextNode(text.slice(last)));
}

function diagnosticText(ctx: HarViewerContext, diagnostic: Diagnostic): string {
    const message = ctx.i18n.t(diagnostic.messageKey, diagnostic.args);
    return diagnostic.location ? `${message} (${diagnostic.location})` : message;
}

function filterSelect(label: string, options: Array<[string, string]>): HTMLSelectElement {
    const node = element('select', 'omni-har__select') as HTMLSelectElement;
    node.setAttribute('aria-label', label);
    node.title = label;
    for (const [value, text] of options) {
        const option = element('option', undefined, text) as HTMLOptionElement;
        option.value = value;
        node.append(option);
    }
    return node;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
