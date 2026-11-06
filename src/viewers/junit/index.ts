// JUnit XML viewer: a run verdict and outcome summary, a filterable test list
// that opens on the first failure, a detail pane with the failure message,
// stack trace and captured output, a nested suite table, and the report
// source — the view a CI failure is actually read from.
//
// The report is XML, so the core XML scanner does the reading (parseJUnit);
// everything shown comes from the parsed model, and every label is a catalog
// key (ADR 17/28). Nothing in the report is executed or fetched.

import type { ClipboardService, HostContext } from '../../host/index.js';
import { asciiLower } from '../../parsers/csv/index.js';
import {
    formatSeconds,
    parseJUnit,
    type JUnitCase,
    type JUnitDocument,
    type JUnitParseOptions,
    type JUnitProperty,
    type JUnitResult,
    type JUnitStatus,
    type JUnitSuite
} from '../../parsers/junit/index.js';
import type { Diagnostic } from '../../parsers/types.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { junitViewerCss } from './styles.js';

export {
    JUNIT_DEFAULT_MAX_CASES,
    JUNIT_DEFAULT_MAX_INPUT_BYTES,
    JUNIT_DEFAULT_MAX_OUTPUT_CHARS,
    JUNIT_DEFAULT_MAX_TEXT_CHARS,
    JUNIT_INPUT_OWNERSHIP,
    formatSeconds,
    looksLikeJUnit,
    parseJUnit,
    parseSeconds,
    passRate
} from '../../parsers/junit/index.js';
export type {
    JUnitCase,
    JUnitCounts,
    JUnitDeclaredCounts,
    JUnitDocument,
    JUnitParseOptions,
    JUnitProperty,
    JUnitResult,
    JUnitResultKind,
    JUnitStatus,
    JUnitSuite,
    JUnitSummaryItem
} from '../../parsers/junit/index.js';
export { junitViewerCss } from './styles.js';

export const JUNIT_VIEWER_META = {
    id: 'junit',
    displayNameKey: 'junit.title',
    extensions: [] as string[],
    priority: 20,
    requiredServices: [] as const,
    optionalServices: ['clipboard'] as const,
    inputOwnership: 'borrows' as const
};

export type JUnitViewerContext = HostContext & { clipboard?: ClipboardService };

export interface JUnitMountOptions extends MountOptions {
    /** Forwarded to parseJUnit (limits, text and output budgets). */
    parse?: Omit<JUnitParseOptions, 'signal'>;
}

type TabId = 'tests' | 'suites' | 'source';
type StatusFilter = '' | 'problems' | JUnitStatus | 'flaky';
type SortKey = 'index' | 'status' | 'name' | 'suite' | 'time';

/** Rows rendered at once; the panel header always reports the full total. */
const MAX_TABLE_ROWS = 2000;
/** Suites offered in the suite filter; the suite tab lists every one. */
const MAX_SUITE_OPTIONS = 1000;
/** Properties shown per case or suite. */
const MAX_PROPERTY_ROWS = 200;
/** Source characters shown in the source tab. */
const MAX_SOURCE_CHARS = 512 * 1024;
/**
 * Keystrokes coalesce for this long before the list is rebuilt; the filter
 * selects and the sort headers stay immediate. Exported so tests can drive
 * the delay instead of guessing it.
 */
export const JUNIT_SEARCH_DEBOUNCE_MS = 150;

/** Sort and verdict order: what needs attention first. */
const STATUS_RANK: Record<JUnitStatus, number> = { error: 0, failed: 1, skipped: 2, passed: 3 };
const STATUSES: readonly JUnitStatus[] = ['passed', 'failed', 'error', 'skipped'];

export async function mountJUnitViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: JUnitViewerContext,
    options: JUnitMountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const { result } = parseJUnit(input.data, { ...options.parse, ...(options.signal ? { signal: options.signal } : {}) });
    if (options.signal?.aborted) throw new MountAbortedError();
    if (result.status === 'failed') {
        return mountJUnitFailure(result.failure.messageKey, result.failure.args, result.diagnostics, input.fileName, container, ctx, options);
    }
    return mountJUnitDocument(result.document, input.fileName, container, ctx, options, result.diagnostics);
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
        style.textContent = junitViewerCss;
        root.append(style);
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--junit');
    }
    const frame = element('div', 'omni-junit');
    root.append(frame);
    return style ? { root, frame, style } : { root, frame };
}

function disposeFrame(root: HTMLElement | ShadowRoot, container: HTMLElement, frame: HTMLElement, style?: HTMLStyleElement): void {
    frame.remove();
    style?.remove();
    if (!(root instanceof ShadowRoot)) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--junit');
}

function mountJUnitFailure(
    messageKey: string,
    args: Record<string, string | number> | undefined,
    diagnostics: readonly Diagnostic[],
    fileName: string,
    container: HTMLElement,
    ctx: JUnitViewerContext,
    options: MountOptions
): ViewerHandle {
    const { root, frame, style } = createFrame(container, options);
    const header = element('header', 'omni-junit__header');
    const heading = element('div');
    heading.append(element('div', 'omni-junit__eyebrow', 'JUnit'), element('h1', undefined, fileName));
    header.append(heading);
    const warnings = element('section', 'omni-junit__warnings');
    warnings.setAttribute('role', 'status');
    warnings.append(element('div', undefined, ctx.i18n.t(messageKey, args)));
    appendDiagnostics(warnings, ctx, diagnostics);
    frame.append(header, warnings, element('div', 'omni-junit__empty', ctx.i18n.t('junit.unreadable')));
    return { dispose: () => disposeFrame(root, container, frame, style) };
}

export function mountJUnitDocument(
    model: JUnitDocument,
    fileName: string,
    container: HTMLElement,
    ctx: JUnitViewerContext,
    options: MountOptions = {},
    diagnostics: readonly Diagnostic[] = []
): ViewerHandle {
    if (options.signal?.aborted) throw new MountAbortedError();
    const { root, frame, style } = createFrame(container, options);
    const t = (key: string, args?: Record<string, string | number>): string => ctx.i18n.t(key, args);
    const statusLabel = (status: JUnitStatus): string => t(`junit.status.${status}`);
    /** Joined once per suite: the list, search and sort ask for it per case. */
    const suitePaths: Array<string | undefined> = new Array(model.suites.length);
    const suitePath = (index: number): string => {
        if (index < 0) return '';
        return suitePaths[index] ??= model.suites[index]!.path.map(name => name || t('junit.unnamed')).join(' › ');
    };
    const { counts } = model;

    /* ── header, verdict, summary ────────────────────────────────────────── */
    const header = element('header', 'omni-junit__header');
    const heading = element('div');
    const subtitle = [
        model.name,
        t('junit.suiteCount', { count: model.suites.length }),
        t('junit.caseCount', { count: counts.tests }),
        model.timestamp
    ].filter(part => part);
    heading.append(
        element('div', 'omni-junit__eyebrow', 'JUnit'),
        element('h1', undefined, fileName),
        element('div', 'omni-junit__subtitle', subtitle.join(' · '))
    );
    const failing = counts.failed + counts.errors;
    // A run where nothing ran is not a pass: every test skipped gets its own
    // verdict. Nor is a report read only in part: the unread cases may fail.
    const verdictKind = failing > 0 ? 'failed' : model.incomplete ? 'incomplete'
        : counts.tests === 0 ? 'empty' : counts.passed === 0 ? 'skipped' : 'passed';
    const verdictCount = verdictKind === 'skipped' ? counts.skipped : verdictKind === 'incomplete' ? counts.tests : failing;
    const verdict = element('div', `omni-junit__verdict omni-junit__verdict--${verdictKind}`, t(`junit.verdict.${verdictKind}`, { count: verdictCount }));
    header.append(heading, verdict);

    // Proportional outcome bar; the summary cards below carry the numbers.
    const meter = element('div', 'omni-junit__meter');
    meter.setAttribute('role', 'img');
    meter.setAttribute('aria-label', STATUSES.map(status => `${statusLabel(status)} ${countOf(status)}`).join(', '));
    for (const status of STATUSES) {
        const value = countOf(status);
        if (!value) continue;
        const segment = element('span', `omni-junit__status--${status}`);
        segment.style.flex = `${value} 0 0`;
        segment.title = `${statusLabel(status)} ${value}`;
        meter.append(segment);
    }
    function countOf(status: JUnitStatus): number {
        return status === 'passed' ? counts.passed : status === 'failed' ? counts.failed : status === 'error' ? counts.errors : counts.skipped;
    }

    const summary = element('section', 'omni-junit__summary');
    for (const item of model.summary) {
        const card = element('div', 'omni-junit__summary-item');
        if (item.labelKey === 'junit.summary.failed' && counts.failed) card.classList.add('omni-junit__summary-item--failed');
        if (item.labelKey === 'junit.summary.errors' && counts.errors) card.classList.add('omni-junit__summary-item--error');
        card.append(element('div', 'omni-junit__summary-value', item.value), element('div', 'omni-junit__summary-label', t(item.labelKey)));
        summary.append(card);
    }

    /* ── toolbar ─────────────────────────────────────────────────────────── */
    const toolbar = element('div', 'omni-junit__toolbar');
    const search = element('input', 'omni-junit__search') as HTMLInputElement;
    search.type = 'search';
    search.placeholder = t('junit.search');
    search.setAttribute('aria-label', t('junit.search'));
    const outputToggleLabel = element('label', 'omni-junit__toggle');
    const outputToggle = element('input') as HTMLInputElement;
    outputToggle.type = 'checkbox';
    outputToggleLabel.append(outputToggle, element('span', undefined, t('junit.searchOutput')));

    const statusOptions: Array<[string, string]> = [['', t('junit.filter.allStatuses')], ['problems', t('junit.filter.problems')]];
    for (const status of STATUSES) statusOptions.push([status, statusLabel(status)]);
    if (counts.flaky) statusOptions.push(['flaky', t('junit.status.flaky')]);
    const statusFilter = filterSelect(t('junit.filter.status'), statusOptions);
    const suiteOptions: Array<[string, string]> = [['', t('junit.filter.allSuites')]];
    for (const suite of model.suites.slice(0, MAX_SUITE_OPTIONS)) suiteOptions.push([String(suite.index), suitePath(suite.index)]);
    const suiteFilter = filterSelect(t('junit.filter.suite'), suiteOptions);
    suiteFilter.hidden = model.suites.length < 2;

    const tabs = element('div', 'omni-junit__tabs');
    const copy = element('button', undefined, t('junit.copyCase')) as HTMLButtonElement;
    copy.type = 'button';
    const live = element('span', 'omni-junit__live');
    live.setAttribute('role', 'status');
    toolbar.append(search, outputToggleLabel, statusFilter, suiteFilter, tabs, copy, live);

    const warnings = element('section', 'omni-junit__warnings');
    warnings.setAttribute('role', 'status');
    appendDiagnostics(warnings, ctx, diagnostics);
    warnings.hidden = diagnostics.length === 0;

    const content = element('main', 'omni-junit__content');
    frame.append(header, meter, summary, toolbar, warnings, content);

    /* ── state ───────────────────────────────────────────────────────────── */
    let activeTab: TabId = 'tests';
    // Open on the first failure: that is what a report is opened to read.
    let selected: JUnitCase | undefined = model.cases.find(item => item.status === 'error' || item.status === 'failed') ?? model.cases[0];
    let selectedSuite: JUnitSuite | undefined = model.suites[0];
    let revealSelected = true;
    let sortKey: SortKey = 'index';
    let sortAscending = true;
    let disposed = false;
    const disposers: Array<() => void> = [];
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, listener: (event: HTMLElementEventMap[K]) => void): void => {
        target.addEventListener(type, listener as EventListener);
        disposers.push(() => target.removeEventListener(type, listener as EventListener));
    };

    /** Lower-cased names and messages per case, built on the first search so
     *  a report nobody searches costs nothing. */
    const searchIndex: Array<string | undefined> = new Array(model.cases.length);
    const indexText = (item: JUnitCase): string => {
        const cached = searchIndex[item.index];
        if (cached !== undefined) return cached;
        const parts = [item.name, item.classname, item.file, suitePath(item.suite)];
        for (const result of item.results) parts.push(result.message, result.type);
        const text = asciiLower(parts.join('\n'));
        searchIndex[item.index] = text;
        return text;
    };
    /** Stack traces and captured output, for the opt-in search. */
    const outputIndex: Array<string | undefined> = new Array(model.cases.length);
    const outputText = (item: JUnitCase): string => {
        const cached = outputIndex[item.index];
        if (cached !== undefined) return cached;
        const parts = [item.systemOut, item.systemErr];
        for (const result of item.results) parts.push(result.text, result.systemOut, result.systemErr);
        const text = asciiLower(parts.join('\n'));
        outputIndex[item.index] = text;
        return text;
    };
    /** Whether a case belongs to `suite` or one of its nested suites. */
    const inSuite = (item: JUnitCase, suite: number): boolean => {
        for (let current = item.suite; current >= 0; current = model.suites[current]!.parent) if (current === suite) return true;
        return false;
    };
    const matches = (item: JUnitCase, needle: string, searchOutput: boolean): boolean => {
        const status = statusFilter.value as StatusFilter;
        if (status === 'problems' ? item.status !== 'failed' && item.status !== 'error'
            : status === 'flaky' ? !item.flaky
                : status && item.status !== status) return false;
        if (suiteFilter.value && !inSuite(item, Number(suiteFilter.value))) return false;
        if (!needle) return true;
        if (indexText(item).includes(needle)) return true;
        return searchOutput && outputText(item).includes(needle);
    };
    const sortValue = (item: JUnitCase): string | number => {
        switch (sortKey) {
            case 'status': return STATUS_RANK[item.status];
            case 'name': return asciiLower(item.name);
            case 'suite': return asciiLower(suitePath(item.suite));
            case 'time': return item.time ?? -1;
            default: return item.index;
        }
    };
    const visibleCases = (): JUnitCase[] => {
        const needle = asciiLower(search.value.trim());
        const searchOutput = outputToggle.checked;
        const rows = model.cases.filter(item => matches(item, needle, searchOutput));
        if (sortKey !== 'index' || !sortAscending) {
            // Keys are computed once per row, not per comparison: lower-casing a
            // name inside the comparator costs ~1.4M allocations at 100k cases.
            const keys = new Array<string | number>(model.cases.length);
            for (const item of rows) keys[item.index] = sortValue(item);
            rows.sort((a, b) => {
                // Untimed cases sort below every timed one, in either direction.
                if (sortKey === 'time' && (a.time === null) !== (b.time === null)) return a.time === null ? 1 : -1;
                const left = keys[a.index]!;
                const right = keys[b.index]!;
                // Code-unit comparison, never localeCompare (ADR 41); document
                // order breaks ties after the direction is applied.
                const primary = left === right ? 0 : left < right ? -1 : 1;
                return (sortAscending ? primary : -primary) || a.index - b.index;
            });
        }
        return rows;
    };

    /* ── tabs ────────────────────────────────────────────────────────────── */
    const tabButtons = new Map<TabId, HTMLButtonElement>();
    for (const [id, label] of [['tests', t('junit.tab.tests')], ['suites', t('junit.tab.suites')], ['source', t('junit.tab.source')]] as Array<[TabId, string]>) {
        const button = element('button', undefined, label) as HTMLButtonElement;
        button.type = 'button';
        on(button, 'click', () => switchTab(id));
        tabButtons.set(id, button);
        tabs.append(button);
    }
    const switchTab = (id: TabId): void => {
        cancelSearch();
        activeTab = id;
        renderTabs();
        renderContent();
    };
    const renderTabs = (): void => {
        for (const [id, button] of tabButtons) button.setAttribute('aria-pressed', String(activeTab === id));
        const filtering = activeTab === 'tests';
        for (const control of [search, outputToggleLabel, statusFilter, copy]) control.hidden = !filtering;
        suiteFilter.hidden = !filtering || model.suites.length < 2;
    };

    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelSearch = (): void => {
        if (searchTimer !== undefined) clearTimeout(searchTimer);
        searchTimer = undefined;
    };
    /** A filter change rebuilds the row list only; the detail pane keeps its
     *  scroll position and whatever focus it holds. */
    const renderFiltered = (): void => { if (activeTab === 'tests') renderRows(); };
    on(search, 'input', () => {
        cancelSearch();
        searchTimer = setTimeout(() => { searchTimer = undefined; renderFiltered(); }, JUNIT_SEARCH_DEBOUNCE_MS);
    });
    on(outputToggle, 'change', () => { cancelSearch(); renderFiltered(); });
    for (const filter of [statusFilter, suiteFilter]) on(filter, 'change', () => { cancelSearch(); renderFiltered(); });

    let liveTimer: ReturnType<typeof setTimeout> | undefined;
    const announce = (key: string): void => {
        live.textContent = t(key);
        if (liveTimer !== undefined) clearTimeout(liveTimer);
        liveTimer = setTimeout(() => { live.textContent = ''; liveTimer = undefined; }, 4000);
    };
    const writeClipboard = (text: string): void => {
        if (!ctx.clipboard) return;
        void ctx.clipboard.writeText(text).then(
            () => { if (!disposed) announce('junit.copied'); },
            () => { if (!disposed) announce('junit.copyFailed'); }
        );
    };
    on(copy, 'click', () => { if (selected) writeClipboard(caseReport(selected)); });

    /** Plain-text report of one case: what gets pasted into an issue. */
    const caseReport = (item: JUnitCase): string => {
        const lines = [
            item.classname && !item.synthetic ? `${item.classname} › ${item.name}` : item.name,
            `${statusLabel(item.status)}${item.time !== null ? ` · ${formatSeconds(item.time)}` : ''}`
        ];
        if (item.suite >= 0) lines.push(suitePath(item.suite));
        for (const result of item.results) {
            lines.push('', `[${t(`junit.result.${result.kind}`)}]${result.type ? ` ${result.type}` : ''}`);
            if (result.message) lines.push(result.message);
            if (result.text && result.text !== result.message) lines.push(result.text);
        }
        return lines.join('\n');
    };

    /* ── tests tab ───────────────────────────────────────────────────────── */
    const list = element('div', 'omni-junit__list');
    const detail = element('aside', 'omni-junit__detail');
    const rowElements = new Map<number, HTMLElement>();
    const headerButtons = new Map<SortKey, HTMLButtonElement>();
    let focusHeader: SortKey | undefined;

    const renderTests = (): void => {
        const layout = element('div', 'omni-junit__layout');
        list.replaceChildren();
        detail.replaceChildren();
        layout.append(list, detail);
        content.append(layout);
        renderRows();
        renderDetail();
    };

    const sortableHeader = (key: SortKey, labelKey: string, numeric = false): HTMLTableCellElement => {
        const cell = element('th', numeric ? 'omni-junit__num' : undefined);
        const button = element('button', undefined, t(labelKey)) as HTMLButtonElement;
        button.type = 'button';
        if (sortKey === key) {
            cell.setAttribute('aria-sort', sortAscending ? 'ascending' : 'descending');
            button.textContent = `${t(labelKey)} ${sortAscending ? '▲' : '▼'}`;
        }
        // Not registered through `on()`: the header is replaced on every
        // render, so its listener dies with it.
        button.addEventListener('click', () => {
            if (sortKey === key) sortAscending = !sortAscending;
            // Slowest first is the useful first click on the time column.
            else { sortKey = key; sortAscending = key !== 'time'; }
            focusHeader = key;
            renderRows();
        });
        headerButtons.set(key, button);
        cell.append(button);
        return cell;
    };

    const activeElement = (): HTMLElement | null =>
        (root instanceof ShadowRoot ? root.activeElement : document.activeElement) as HTMLElement | null;
    /** The case whose row holds focus, so a rebuild can hand it back. */
    const focusedRow = (): number | undefined => {
        const active = activeElement();
        if (!active?.classList.contains('omni-junit__row')) return undefined;
        for (const [index, row] of rowElements) if (row === active) return index;
        return undefined;
    };

    const renderRows = (): void => {
        const restoreRow = focusedRow();
        list.replaceChildren();
        rowElements.clear();
        headerButtons.clear();
        const rows = visibleCases();
        const shown = rows.slice(0, MAX_TABLE_ROWS);
        const panel = element('div', 'omni-junit__panel-header');
        const rowCount = element('span', undefined, t('junit.rows', { shown: shown.length, total: rows.length }));
        panel.append(element('h2', undefined, t('junit.tab.tests')), rowCount);
        list.append(panel);
        // The opening selection (the first failure) and a suite's "show
        // tests" selection are made for the reader, so the row is brought
        // into view — or, past the rendered rows, its absence is explained.
        const reveal = revealSelected;
        revealSelected = false;
        if (reveal && selected && !shown.includes(selected) && rows.includes(selected)) {
            rowCount.textContent += ` · ${t('junit.selectedHidden')}`;
        }
        const restoreFocus = focusHeader;
        focusHeader = undefined;
        if (rows.length === 0) {
            list.append(element('div', 'omni-junit__empty', t(model.cases.length ? 'junit.noMatches' : 'junit.noCases')));
            return;
        }
        const table = element('table');
        const headRow = element('tr');
        headRow.append(
            sortableHeader('index', 'junit.column.index', true),
            sortableHeader('status', 'junit.column.status'),
            sortableHeader('name', 'junit.column.name'),
            sortableHeader('suite', 'junit.column.suite'),
            sortableHeader('time', 'junit.column.time', true)
        );
        const head = element('thead');
        head.append(headRow);
        const body = element('tbody');
        for (const item of shown) body.append(renderRow(item));
        table.append(head, body);
        list.append(table);
        if (restoreFocus) headerButtons.get(restoreFocus)?.focus();
        else if (restoreRow !== undefined) rowElements.get(restoreRow)?.focus();
        if (reveal && selected) revealRow(rowElements.get(selected.index));
    };

    /** Scrolls the list — and only the list: `scrollIntoView` would scroll
     *  every ancestor, the host page included — so the row clears the sticky
     *  panel and column headers. */
    const revealRow = (row: HTMLElement | undefined): void => {
        if (!row) return;
        const view = list.getBoundingClientRect();
        const box = row.getBoundingClientRect();
        const covered = (list.querySelector('.omni-junit__panel-header')?.getBoundingClientRect().height ?? 0)
            + (list.querySelector('thead')?.getBoundingClientRect().height ?? 0);
        if (box.top < view.top + covered) list.scrollTop -= view.top + covered - box.top;
        else if (box.bottom > view.bottom) list.scrollTop += box.bottom - view.bottom;
    };

    const statusPill = (item: JUnitCase): HTMLElement => {
        const wrap = element('span');
        wrap.append(element('span', `omni-junit__status omni-junit__status--${item.status}`, statusLabel(item.status)));
        if (item.flaky) wrap.append(' ', element('span', 'omni-junit__status omni-junit__status--flaky', t('junit.status.flaky')));
        return wrap;
    };

    const renderRow = (item: JUnitCase): HTMLElement => {
        const row = element('tr', 'omni-junit__row');
        row.tabIndex = 0;
        if (item.status === 'failed' || item.status === 'error') row.classList.add(`omni-junit__row--${item.status}`);
        // aria-current: aria-selected is only exposed inside grid/listbox roles.
        if (selected?.index === item.index) {
            row.classList.add('omni-junit__row--selected');
            row.setAttribute('aria-current', 'true');
        }
        const status = element('td');
        status.append(statusPill(item));
        const name = element('td');
        const stack = element('div', 'omni-junit__name');
        stack.append(element('strong', undefined, item.name || t('junit.unnamed')));
        if (item.classname) stack.append(element('small', undefined, item.classname));
        name.title = item.classname ? `${item.classname} › ${item.name}` : item.name;
        name.append(stack);
        const suite = element('td', undefined, suitePath(item.suite) || '—');
        suite.title = suite.textContent ?? '';
        row.append(element('td', 'omni-junit__num', String(item.index + 1)), status, name, suite, element('td', 'omni-junit__num', formatSeconds(item.time)));
        row.addEventListener('click', () => select(item));
        row.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(item); }
            else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                const next = (event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null;
                if (next) { event.preventDefault(); next.focus(); }
            }
        });
        rowElements.set(item.index, row);
        return row;
    };

    const select = (item: JUnitCase): void => {
        if (selected?.index === item.index) return;
        const previous = selected ? rowElements.get(selected.index) : undefined;
        previous?.classList.remove('omni-junit__row--selected');
        previous?.removeAttribute('aria-current');
        selected = item;
        const row = rowElements.get(item.index);
        row?.classList.add('omni-junit__row--selected');
        row?.setAttribute('aria-current', 'true');
        renderDetail();
    };

    const renderDetail = (): void => {
        detail.replaceChildren();
        const item = selected;
        copy.disabled = !ctx.clipboard || !item;
        if (!item) {
            detail.append(element('div', 'omni-junit__empty', t(model.cases.length ? 'junit.selectCase' : 'junit.noCases')));
            return;
        }
        const head = element('div', 'omni-junit__detail-header');
        const title = element('h2', undefined, item.name || t('junit.unnamed'));
        const line = element('div');
        line.append(statusPill(item), ` ${formatSeconds(item.time)}`);
        head.append(title, line);
        if (item.classname) head.append(element('div', undefined, item.classname));
        const body = element('div', 'omni-junit__detail-body');
        detail.append(head, body);

        if (item.synthetic) body.append(element('div', 'omni-junit__note', t('junit.syntheticCase')));
        for (const result of item.results) body.append(resultBlock(result));
        if (item.droppedResults > 0) body.append(element('div', 'omni-junit__note', t('junit.moreRows', { count: item.droppedResults })));

        const rows: Array<[string, string]> = [
            [t('junit.field.status'), statusLabel(item.status) + (item.flaky ? ` · ${t('junit.status.flaky')}` : '')],
            [t('junit.field.classname'), item.classname || '—'],
            [t('junit.field.suite'), suitePath(item.suite) || '—'],
            [t('junit.field.time'), formatSeconds(item.time)]
        ];
        if (item.file) rows.push([t('junit.field.file'), item.line !== null ? `${item.file}:${item.line}` : item.file]);
        body.append(element('h3', undefined, t('junit.detail.general')), definitionList(rows));
        appendProperties(body, item.properties);
        appendOutput(body, item.systemOut, item.systemErr, item.outputTruncated);
    };

    const resultBlock = (result: JUnitResult): HTMLElement => {
        const block = element('section', 'omni-junit__result');
        const head = element('div', 'omni-junit__result-head');
        const pillStatus = result.kind === 'error' || result.kind.endsWith('Error') ? 'error' : result.kind === 'skipped' ? 'skipped' : 'failed';
        head.append(element('span', `omni-junit__status omni-junit__status--${pillStatus}`, t(`junit.result.${result.kind}`)));
        if (result.type) head.append(element('span', 'omni-junit__result-type', result.type));
        block.append(head);
        if (result.message) block.append(element('div', 'omni-junit__message', result.message));
        // Most writers repeat the message as the first line of the trace; a
        // body that *is* the message adds nothing.
        if (result.text && result.text !== result.message) {
            block.append(element('pre', 'omni-junit__pre', result.text));
            if (result.truncated) block.append(element('div', 'omni-junit__note', t('junit.textTruncated')));
        }
        if (result.systemOut || result.systemErr) {
            const attempt = element('div', 'omni-junit__message');
            appendOutput(attempt, result.systemOut, result.systemErr, result.outputTruncated);
            block.append(attempt);
        }
        return block;
    };

    const appendProperties = (body: HTMLElement, properties: readonly JUnitProperty[]): void => {
        if (!properties.length) return;
        body.append(element('h3', undefined, `${t('junit.detail.properties')} (${properties.length})`));
        body.append(definitionList(properties.slice(0, MAX_PROPERTY_ROWS).map(property => [property.name, property.value] as [string, string])));
        if (properties.length > MAX_PROPERTY_ROWS) body.append(element('div', 'omni-junit__note', t('junit.moreRows', { count: properties.length - MAX_PROPERTY_ROWS })));
    };

    const appendOutput = (body: HTMLElement, out: string, err: string, truncated: boolean): void => {
        if (out) body.append(element('h3', undefined, t('junit.detail.systemOut')), element('pre', 'omni-junit__pre', out));
        if (err) body.append(element('h3', undefined, t('junit.detail.systemErr')), element('pre', 'omni-junit__pre', err));
        if (truncated) body.append(element('div', 'omni-junit__note', t('junit.textTruncated')));
    };

    /* ── suites tab ──────────────────────────────────────────────────────── */
    const suiteRows = new Map<number, HTMLElement>();
    const renderSuites = (): void => {
        const layout = element('div', 'omni-junit__layout');
        const suiteList = element('div', 'omni-junit__list');
        detail.replaceChildren();
        suiteRows.clear();
        layout.append(suiteList, detail);
        content.append(layout);
        const panel = element('div', 'omni-junit__panel-header');
        panel.append(element('h2', undefined, t('junit.tab.suites')), element('span', undefined, t('junit.rows', { shown: Math.min(model.suites.length, MAX_TABLE_ROWS), total: model.suites.length })));
        suiteList.append(panel);
        if (!model.suites.length) {
            suiteList.append(element('div', 'omni-junit__empty', t('junit.noSuites')));
            renderSuiteDetail();
            return;
        }
        const table = element('table');
        const headRow = element('tr');
        headRow.append(element('th', undefined, t('junit.column.suite')));
        for (const key of ['junit.column.tests', 'junit.status.passed', 'junit.status.failed', 'junit.status.error', 'junit.status.skipped', 'junit.column.time']) {
            headRow.append(element('th', 'omni-junit__num', t(key)));
        }
        const head = element('thead');
        head.append(headRow);
        const body = element('tbody');
        for (const suite of model.suites.slice(0, MAX_TABLE_ROWS)) {
            const row = element('tr', 'omni-junit__row');
            row.tabIndex = 0;
            if (suite.counts.errors) row.classList.add('omni-junit__row--error');
            else if (suite.counts.failed) row.classList.add('omni-junit__row--failed');
            if (selectedSuite?.index === suite.index) {
                row.classList.add('omni-junit__row--selected');
                row.setAttribute('aria-current', 'true');
            }
            const name = element('td');
            name.style.paddingLeft = `${9 + Math.min(suite.depth, 12) * 16}px`;
            name.append(element('strong', undefined, suite.name || t('junit.unnamed')));
            if (suite.countMismatch) {
                // A role-less span's aria-label is ignored: the symbol is hidden
                // from assistive technology and the meaning is spoken instead.
                const flag = element('span', 'omni-junit__mismatch', ' ⚠');
                flag.title = t('junit.countMismatch');
                flag.setAttribute('aria-hidden', 'true');
                name.append(flag, element('span', 'omni-junit__sr', t('junit.countMismatch')));
            }
            name.title = suitePath(suite.index);
            row.append(name);
            for (const value of [suite.counts.tests, suite.counts.passed, suite.counts.failed, suite.counts.errors, suite.counts.skipped]) {
                row.append(element('td', 'omni-junit__num', String(value)));
            }
            row.append(element('td', 'omni-junit__num', formatSeconds(suite.time)));
            row.addEventListener('click', () => selectSuite(suite));
            row.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectSuite(suite); }
                else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    const next = (event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null;
                    if (next) { event.preventDefault(); next.focus(); }
                }
            });
            suiteRows.set(suite.index, row);
            body.append(row);
        }
        table.append(head, body);
        suiteList.append(table);
        if (model.suites.length > MAX_TABLE_ROWS) suiteList.append(element('div', 'omni-junit__note', t('junit.moreRows', { count: model.suites.length - MAX_TABLE_ROWS })));
        renderSuiteDetail();
    };

    const selectSuite = (suite: JUnitSuite): void => {
        if (selectedSuite?.index === suite.index) return;
        const previous = selectedSuite ? suiteRows.get(selectedSuite.index) : undefined;
        previous?.classList.remove('omni-junit__row--selected');
        previous?.removeAttribute('aria-current');
        selectedSuite = suite;
        const row = suiteRows.get(suite.index);
        row?.classList.add('omni-junit__row--selected');
        row?.setAttribute('aria-current', 'true');
        renderSuiteDetail();
    };

    const renderSuiteDetail = (): void => {
        detail.replaceChildren();
        const suite = selectedSuite;
        const head = element('div', 'omni-junit__detail-header');
        const body = element('div', 'omni-junit__detail-body');
        detail.append(head, body);
        if (!suite) {
            // No suites: the root is all there is to describe.
            head.append(element('h2', undefined, model.name || t('junit.report')));
            body.append(definitionList(countRows(model.declared, model.counts)));
            appendProperties(body, model.properties);
            return;
        }
        head.append(element('h2', undefined, suite.name || t('junit.unnamed')), element('div', undefined, suitePath(suite.index)));
        // A <testsuites> root has no row of its own; when its totals disagree
        // with the file, its declared-vs-found figures lead every suite's
        // detail. A <testsuite> root is the suite itself and says so below.
        if (model.countMismatch && model.rootKind === 'testsuites') {
            body.append(
                element('h3', undefined, model.name || t('junit.report')),
                element('div', 'omni-junit__note omni-junit__mismatch', t('junit.countMismatchDetail')),
                definitionList(countRows(model.declared, model.counts))
            );
        }
        const actions = element('div', 'omni-junit__actions');
        const showTests = element('button', undefined, t('junit.showTests')) as HTMLButtonElement;
        showTests.type = 'button';
        showTests.disabled = suite.counts.tests === 0;
        showTests.addEventListener('click', () => {
            // A suite past the filter's option cap has no option to select.
            if (suite.index >= MAX_SUITE_OPTIONS) return;
            // A hidden filter must never narrow the list behind the user's back;
            // with fewer than two suites there is nothing to narrow anyway.
            if (model.suites.length >= 2) suiteFilter.value = String(suite.index);
            statusFilter.value = '';
            search.value = '';
            const first = model.cases.find(item => inSuite(item, suite.index) && (item.status === 'failed' || item.status === 'error'))
                ?? model.cases.find(item => inSuite(item, suite.index));
            if (first) selected = first;
            revealSelected = true;
            switchTab('tests');
            // The pressed button went with the panel it sat in: focus follows
            // the selection, or the tab when nothing is selected.
            ((selected && rowElements.get(selected.index)) ?? tabButtons.get('tests'))?.focus();
        });
        showTests.hidden = suite.index >= MAX_SUITE_OPTIONS;
        actions.append(showTests);
        body.append(actions);
        if (suite.countMismatch) body.append(element('div', 'omni-junit__note omni-junit__mismatch', t('junit.countMismatchDetail')));
        const rows: Array<[string, string]> = [...countRows(suite.declared, suite.counts), [t('junit.field.time'), formatSeconds(suite.time)]];
        if (suite.timestamp) rows.push([t('junit.field.timestamp'), suite.timestamp]);
        if (suite.hostname) rows.push([t('junit.field.hostname'), suite.hostname]);
        if (suite.package) rows.push([t('junit.field.package'), suite.package]);
        if (suite.id) rows.push([t('junit.field.id'), suite.id]);
        if (suite.file) rows.push([t('junit.field.file'), suite.file]);
        body.append(element('h3', undefined, t('junit.detail.general')), definitionList(rows));
        appendProperties(body, suite.properties);
        appendOutput(body, suite.systemOut, suite.systemErr, suite.outputTruncated);
    };

    /** Found counts, each with the declared value beside it when they differ. */
    const countRows = (declared: JUnitDocument['declared'], found: JUnitDocument['counts']): Array<[string, string]> => {
        const withDeclared = (value: number, declaredValue: number | null): string =>
            declaredValue === null || declaredValue === value ? String(value) : t('junit.declaredDiffers', { found: value, declared: declaredValue });
        return [
            [t('junit.column.tests'), withDeclared(found.tests, declared.tests)],
            [t('junit.status.passed'), String(found.passed)],
            [t('junit.status.failed'), withDeclared(found.failed, declared.failures)],
            [t('junit.status.error'), withDeclared(found.errors, declared.errors)],
            [t('junit.status.skipped'), withDeclared(found.skipped, declared.skipped)]
        ];
    };

    /* ── source tab ──────────────────────────────────────────────────────── */
    const renderSource = (): void => {
        const wrap = element('div', 'omni-junit__list');
        const panel = element('div', 'omni-junit__panel-header');
        const copySource = element('button', undefined, t('junit.copySource')) as HTMLButtonElement;
        copySource.type = 'button';
        copySource.disabled = !ctx.clipboard;
        if (!ctx.clipboard) copySource.title = t('common.noClipboard');
        copySource.addEventListener('click', () => writeClipboard(model.text));
        panel.append(element('h2', undefined, t('junit.tab.source')), copySource);
        wrap.append(panel);
        if (model.text.length > MAX_SOURCE_CHARS) {
            wrap.append(element('div', 'omni-junit__note', t('junit.sourceTruncated', { chars: MAX_SOURCE_CHARS })));
        }
        wrap.append(element('pre', 'omni-junit__pre omni-junit__source', model.text.slice(0, MAX_SOURCE_CHARS)));
        content.append(wrap);
    };

    const definitionList = (rows: Array<[string, string]>): HTMLElement => {
        const dl = element('dl', 'omni-junit__props');
        for (const [key, value] of rows) dl.append(element('dt', undefined, key), element('dd', undefined, value || '—'));
        return dl;
    };

    function renderContent(): void {
        content.replaceChildren();
        if (activeTab === 'tests') renderTests();
        else if (activeTab === 'suites') renderSuites();
        else renderSource();
    }

    if (!ctx.clipboard) copy.title = t('common.noClipboard');
    renderTabs();
    renderContent();

    return {
        dispose(): void {
            disposed = true;
            cancelSearch();
            if (liveTimer !== undefined) clearTimeout(liveTimer);
            disposers.splice(0).forEach(dispose => dispose());
            disposeFrame(root, container, frame, style);
        }
    };
}

/** Diagnostics shown in the warning area; the rest are counted. */
const MAX_DIAGNOSTIC_ROWS = 20;
const SEVERITY_RANK: Record<Diagnostic['severity'], number> = { error: 0, warning: 1, info: 2 };

/** The report's own diagnostics (lost cases, caps, totals) lead: a colored
 *  Surefire log alone can fill the area with one XML character-reference
 *  error per escape. Within each group, more severe first; order otherwise kept. */
function appendDiagnostics(target: HTMLElement, ctx: JUnitViewerContext, diagnostics: readonly Diagnostic[]): void {
    const ranked = diagnostics
        .map((diagnostic, index) => ({ diagnostic, index }))
        .sort((a, b) =>
            Number(!a.diagnostic.code.startsWith('junit-')) - Number(!b.diagnostic.code.startsWith('junit-'))
            || SEVERITY_RANK[a.diagnostic.severity] - SEVERITY_RANK[b.diagnostic.severity]
            || a.index - b.index);
    for (const { diagnostic } of ranked.slice(0, MAX_DIAGNOSTIC_ROWS)) target.append(element('div', undefined, diagnosticText(ctx, diagnostic)));
    if (ranked.length > MAX_DIAGNOSTIC_ROWS) {
        target.append(element('div', undefined, ctx.i18n.t('junit.moreRows', { count: ranked.length - MAX_DIAGNOSTIC_ROWS })));
    }
}

function diagnosticText(ctx: JUnitViewerContext, diagnostic: Diagnostic): string {
    const message = ctx.i18n.t(diagnostic.messageKey, diagnostic.args);
    return diagnostic.location ? `${message} (${diagnostic.location})` : message;
}

function filterSelect(label: string, options: Array<[string, string]>): HTMLSelectElement {
    const node = element('select', 'omni-junit__select') as HTMLSelectElement;
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
