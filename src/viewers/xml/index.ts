// Generic XML viewer (docs/viewers/xml.md): an element/attribute tree, an
// inspector for the selected node, and the original source, linked both ways —
// selecting a node highlights and scrolls to its source, clicking the source
// selects the node under it.
//
// The tree and the source are both virtualized on fixed row heights, and the
// source splits very long lines into display segments, so a multi-megabyte or
// single-line (minified) document stays responsive. Every label is a catalog
// key (ADR 17/28); the state machine lives in the DOM-free controller.

import type { ClipboardService, HostContext } from '../../host/index.js';
import { parseXml, xmlPosition, type XmlDocument, type XmlNode, type XmlParseOptions } from '../../parsers/xml/index.js';
import type { Diagnostic } from '../../parsers/types.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { createXmlController, XML_SEARCH_SCOPES, type XmlController, type XmlMoveDirection, type XmlSearchScope } from './controller.js';
import { xmlViewerCss } from './styles.js';

export * from './controller.js';
export {
    parseXml,
    xmlPosition,
    XML_DEFAULT_MAX_DEPTH,
    XML_DEFAULT_MAX_INPUT_BYTES,
    XML_DEFAULT_MAX_NODES,
    XML_INPUT_OWNERSHIP,
    XML_NAMESPACE,
    XMLNS_NAMESPACE
} from '../../parsers/xml/index.js';
export type { XmlDeclaration, XmlDoctype, XmlDocument, XmlNamespaceDeclaration, XmlNode, XmlNodeKind, XmlParseOptions, XmlRange, XmlStats } from '../../parsers/xml/index.js';
export { xmlViewerCss } from './styles.js';

export const XML_VIEWER_META = {
    id: 'xml',
    displayNameKey: 'xml.title',
    extensions: ['xml', 'xsd', 'xsl', 'xslt', 'wsdl', 'xlf', 'xliff', 'rss', 'atom', 'xaml', 'kml', 'gpx', 'resx', 'csproj', 'vcxproj', 'nuspec'] as string[],
    priority: 10,
    requiredServices: [] as const,
    optionalServices: ['clipboard'] as const,
    inputOwnership: 'borrows' as const
};

export type XmlViewerContext = HostContext & { clipboard?: ClipboardService };
export interface XmlViewerOptions extends MountOptions {
    /** Parser limits; defaults are XML_DEFAULT_* (docs/viewers/xml.md §4). */
    parse?: Omit<XmlParseOptions, 'signal'>;
}

/**
 * Keystrokes coalesce for this long before the search runs: a search walks
 * every node of the document. Exported so tests can drive the delay.
 */
export const XML_SEARCH_DEBOUNCE_MS = 150;
/** Fixed row heights the virtualized panes are laid out with (px); styles.ts matches. */
export const XML_TREE_ROW_HEIGHT = 24;
export const XML_SOURCE_ROW_HEIGHT = 20;
/** Source lines longer than this are shown as several display segments. */
export const XML_SOURCE_SEGMENT_CHARS = 2000;
/** Characters of text content the inspector previews. */
const INSPECTOR_TEXT_CHARS = 10_000;
/** Attributes previewed on an element row. */
const ROW_ATTRIBUTE_PREVIEW = 3;
const ROW_TEXT_PREVIEW = 160;
const OVERSCAN = 10;
/** Used when layout reports no height (hidden container, jsdom). */
const FALLBACK_VIEWPORT_HEIGHT = 600;
/**
 * Tallest scroll canvas the panes lay out. Browsers cap element heights
 * (about 17.9M px in Firefox, 33.5M px in Chromium), so past this the scroll
 * position maps proportionally onto row indices instead of 1:1.
 */
export const XML_MAX_CANVAS_HEIGHT = 8_000_000;

/** The rows a virtualized pane renders for a scroll position. */
export interface XmlVirtualWindow {
    /** Canvas height to lay out. */
    height: number;
    /** First rendered row (inclusive) and last (exclusive). */
    start: number;
    end: number;
    /** translateY of the rendered window. */
    offset: number;
    /** Row at the top of the viewport (fractional when scaled). */
    first: number;
}

export function xmlVirtualWindow(count: number, rowHeight: number, scrollTop: number, viewport: number): XmlVirtualWindow {
    const full = count * rowHeight;
    const height = Math.min(full, XML_MAX_CANVAS_HEIGHT);
    // Rows in view, fractional: mapping onto a whole number would leave the
    // last row partly below the canvas when the viewport is not a multiple.
    const span = viewport / rowHeight;
    const first = full <= XML_MAX_CANVAS_HEIGHT
        ? scrollTop / rowHeight
        : Math.min(1, scrollTop / Math.max(1, height - viewport)) * Math.max(0, count - span);
    const start = Math.max(0, Math.floor(first) - OVERSCAN);
    const end = Math.min(count, Math.floor(first) + Math.ceil(span) + 1 + OVERSCAN);
    return { height, start, end, offset: scrollTop - (first - start) * rowHeight, first };
}

/** scrollTop that puts row `index` (fractional allowed) at the top of the viewport. */
export function xmlScrollTopForRow(index: number, count: number, rowHeight: number, viewport: number): number {
    const full = count * rowHeight;
    if (full <= XML_MAX_CANVAS_HEIGHT) return Math.max(0, index) * rowHeight;
    const scrollable = Math.max(1, count - viewport / rowHeight);
    return (Math.min(Math.max(0, index), scrollable) / scrollable) * (XML_MAX_CANVAS_HEIGHT - viewport);
}

let instances = 0;

export async function mountXmlViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: XmlViewerContext,
    options: XmlViewerOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const { result } = parseXml(input.data, { ...options.parse, ...(options.signal ? { signal: options.signal } : {}) });
    if (options.signal?.aborted || (result.status === 'failed' && result.failure.code === 'aborted')) throw new MountAbortedError();
    if (result.status === 'failed') {
        return mountXmlFailure(result.failure.messageKey, result.failure.args, result.diagnostics, input.fileName, container, ctx, options);
    }
    return mountXmlDocument(result.document, input.fileName, container, ctx, options, result.diagnostics);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(label: string, className?: string): HTMLButtonElement {
    const node = element('button', className, label);
    node.type = 'button';
    return node;
}

/** Shared shell: style injection plus the frame every mount path renders into. */
function createFrame(container: HTMLElement, options: MountOptions): { frame: HTMLElement; style?: HTMLStyleElement } {
    let root: HTMLElement | ShadowRoot = container;
    let style: HTMLStyleElement | undefined;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && container.attachShadow) {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        style = element('style');
        style.textContent = xmlViewerCss;
        root.append(style);
    } else {
        container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--xml');
    }
    const frame = element('div', 'omni-xml');
    root.append(frame);
    return style ? { frame, style } : { frame };
}

function disposer(container: HTMLElement, frame: HTMLElement, style: HTMLStyleElement | undefined, extra: () => void): ViewerHandle {
    let disposed = false;
    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            extra();
            frame.remove();
            style?.remove();
            container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--xml');
        }
    };
}

function diagnosticText(ctx: XmlViewerContext, diagnostic: Diagnostic): string {
    const message = ctx.i18n.t(diagnostic.messageKey, diagnostic.args);
    return diagnostic.location ? `${message} (${diagnostic.location})` : message;
}

function mountXmlFailure(
    messageKey: string,
    args: Record<string, string | number> | undefined,
    diagnostics: readonly Diagnostic[],
    fileName: string,
    container: HTMLElement,
    ctx: XmlViewerContext,
    options: MountOptions
): ViewerHandle {
    const { frame, style } = createFrame(container, options);
    const header = element('header', 'omni-xml__header');
    const heading = element('div');
    heading.append(element('div', 'omni-xml__eyebrow', 'XML'), element('h1', undefined, fileName));
    header.append(heading);
    const failure = element('div', 'omni-xml__failure');
    failure.setAttribute('role', 'alert');
    failure.append(element('strong', undefined, ctx.i18n.t('xml.unreadable')), element('p', undefined, ctx.i18n.t(messageKey, args)));
    if (diagnostics.length) {
        const list = element('ul', 'omni-xml__failure-list');
        for (const diagnostic of diagnostics) list.append(element('li', undefined, diagnosticText(ctx, diagnostic)));
        failure.append(list);
    }
    frame.append(header, failure);
    return disposer(container, frame, style, () => undefined);
}

/** Collapses runs of whitespace and cuts to `max` characters. */
function preview(value: string, max: number): string {
    // Rows re-render on every scroll frame, so never touch more than a bounded
    // head of a value (a base64 blob or data URI can be megabytes).
    const head = value.length > max * 4 ? value.slice(0, max * 4) : value;
    const flat = head.replace(/\s+/g, ' ').trim();
    return flat.length > max || head.length < value.length ? `${flat.slice(0, max)}…` : flat;
}

/** Display segments of the source: one per line, more for very long lines. */
interface SourceSegments {
    count: number;
    start: Int32Array;
    end: Int32Array;
    /** 1-based line number, negated for continuation segments. */
    line: Int32Array;
}

function buildSegments(document: XmlDocument): SourceSegments {
    const { text, lineStarts } = document;
    const lineEnd = (line: number): number => {
        let end = line + 1 < lineStarts.length ? lineStarts[line + 1]! - 1 : text.length;
        if (end > lineStarts[line]! && text.charCodeAt(end - 1) === 0x0d) end--;
        return end;
    };
    let count = 0;
    for (let line = 0; line < lineStarts.length; line++) {
        count += Math.max(1, Math.ceil((lineEnd(line) - lineStarts[line]!) / XML_SOURCE_SEGMENT_CHARS));
    }
    const segments: SourceSegments = { count, start: new Int32Array(count), end: new Int32Array(count), line: new Int32Array(count) };
    let at = 0;
    for (let line = 0; line < lineStarts.length; line++) {
        const end = lineEnd(line);
        let start = lineStarts[line]!;
        let first = true;
        do {
            segments.start[at] = start;
            segments.end[at] = Math.min(end, start + XML_SOURCE_SEGMENT_CHARS);
            segments.line[at] = first ? line + 1 : -(line + 1);
            start = segments.end[at]!;
            first = false;
            at++;
        } while (start < end);
    }
    return segments;
}

/** Segment index holding a character offset. */
function segmentAt(segments: SourceSegments, offset: number): number {
    let lo = 0;
    let hi = segments.count - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (segments.start[mid]! <= offset) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

// Quoted runs exclude '<': a stray quote in character data must not swallow the
// tags after it, since a click resolves to its token's start offset.
//
// Name runs are matched once, at their start: group 1 takes a whole run as an
// attribute name when `="` follows ((?=(…))\1 is an atomic match, so a failed
// lookahead does not backtrack through every shorter prefix), and group 2
// otherwise consumes the run as plain text. Without that, a long run of name
// characters — a CJK paragraph, a hex blob — costs O(n²) per segment, on every
// scroll frame. No lookbehind, which older Safari cannot parse.
const NAME_START = 'A-Za-z_:\\u00C0-\\uFFFF';
const NAME_CHAR = `${NAME_START}0-9.\\-\\u00B7`;
const SOURCE_TOKEN = new RegExp(
    `<!--|-->|<!\\[CDATA\\[|\\]\\]>|<\\?[\\w.:-]*|\\?>|<!DOCTYPE|</?[${NAME_START}][${NAME_CHAR}]*|/?>` +
    `|(?=([${NAME_START}][${NAME_CHAR}]*))\\1(?=\\s*=\\s*["'])` +
    `|([${NAME_START}0-9.\\u00B7]+)` +
    `|"[^"<]*"|'[^'<]*'`,
    'g'
);

function tokenClass(token: string): string {
    if (token.startsWith('<!--') || token === '-->') return 'omni-xml__src-comment';
    if (token.startsWith('<![') || token === ']]>' || token.startsWith('<?') || token === '?>' || token === '<!DOCTYPE') return 'omni-xml__src-meta';
    if (token[0] === '"' || token[0] === "'") return 'omni-xml__src-value';
    return 'omni-xml__src-tag';
}

/** Appends `text` (starting at absolute `offset`) as tokens carrying their offsets. */
function appendTokens(target: HTMLElement, text: string, offset: number, extraClass: string): void {
    const add = (value: string, at: number, className: string): void => {
        if (!value) return;
        const span = element('span', [className, extraClass].filter(Boolean).join(' '), value);
        span.dataset.offset = String(at);
        target.append(span);
    };
    // Plain text between highlighted tokens is one span, however many name
    // runs it was matched as.
    let plainFrom = 0;
    SOURCE_TOKEN.lastIndex = 0;
    for (let match = SOURCE_TOKEN.exec(text); match; match = SOURCE_TOKEN.exec(text)) {
        if (match[2] !== undefined) continue;
        add(text.slice(plainFrom, match.index), offset + plainFrom, '');
        add(match[0], offset + match.index, match[1] !== undefined ? 'omni-xml__src-attr' : tokenClass(match[0]));
        plainFrom = match.index + match[0].length;
    }
    add(text.slice(plainFrom), offset + plainFrom, '');
}

export function mountXmlDocument(
    xml: XmlDocument,
    fileName: string,
    container: HTMLElement,
    ctx: XmlViewerContext,
    options: MountOptions = {},
    diagnostics: readonly Diagnostic[] = []
): XmlViewerHandle {
    const { frame, style } = createFrame(container, options);
    const controller = createXmlController(xml);
    const { nodes } = xml;
    const t = ctx.i18n.t.bind(ctx.i18n);
    const uid = `omni-xml-${++instances}`;
    const events = new AbortController();
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, listener: (event: HTMLElementEventMap[K]) => void): void =>
        target.addEventListener(type, listener as EventListener, { signal: events.signal });
    let searchTimer: ReturnType<typeof setTimeout> | undefined;

    // ── Header and summary ────────────────────────────────────────────────
    const header = element('header', 'omni-xml__header');
    const heading = element('div');
    const subtitle = [
        xml.root ? `<${xml.root.name}>` : '',
        xml.root?.namespaceUri ?? '',
        xml.encoding.toUpperCase()
    ].filter(Boolean).join(' · ');
    heading.append(
        element('div', 'omni-xml__eyebrow', t('xml.eyebrow', { version: xml.declaration?.version || '1.0' })),
        element('h1', undefined, fileName),
        element('div', 'omni-xml__subtitle', subtitle)
    );
    header.append(heading);
    const summary = element('div', 'omni-xml__summary');
    // `xmlns=""` un-declares the default namespace; it is not one more namespace.
    const namespaceUris = new Set(xml.namespaces.map((declaration) => declaration.uri).filter(Boolean));
    for (const [key, value] of [
        ['xml.summary.elements', xml.stats.elements],
        ['xml.summary.attributes', xml.stats.attributes],
        ['xml.summary.depth', xml.stats.maxDepth],
        ['xml.summary.namespaces', namespaceUris.size],
        ['xml.summary.lines', xml.lineStarts.length]
    ] as const) {
        const item = element('div', 'omni-xml__summary-item');
        item.append(element('div', 'omni-xml__summary-value', String(value)), element('div', 'omni-xml__summary-label', t(key)));
        summary.append(item);
    }

    // ── Toolbar ───────────────────────────────────────────────────────────
    const toolbar = element('div', 'omni-xml__toolbar');
    const search = element('input', 'omni-xml__search');
    search.type = 'search';
    search.placeholder = t('xml.search');
    search.setAttribute('aria-label', t('xml.searchLabel'));
    const scope = element('select', 'omni-xml__select');
    scope.setAttribute('aria-label', t('xml.scopeLabel'));
    for (const value of XML_SEARCH_SCOPES) {
        const option = element('option', undefined, t(`xml.scope.${value}`));
        option.value = value;
        scope.append(option);
    }
    const previous = button('↑', 'omni-xml__icon-button');
    previous.setAttribute('aria-label', t('xml.previousMatch'));
    previous.title = t('xml.previousMatch');
    const next = button('↓', 'omni-xml__icon-button');
    next.setAttribute('aria-label', t('xml.nextMatch'));
    next.title = t('xml.nextMatch');
    const matchStatus = element('span', 'omni-xml__match-status');
    matchStatus.setAttribute('aria-live', 'polite');
    const checkbox = (labelKey: string, checked: boolean): { label: HTMLLabelElement; input: HTMLInputElement } => {
        const label = element('label', 'omni-xml__toggle');
        const input = element('input');
        input.type = 'checkbox';
        input.checked = checked;
        label.append(input, document.createTextNode(t(labelKey)));
        return { label, input };
    };
    const matchesOnly = checkbox('xml.matchesOnly', false);
    const showAttributes = checkbox('xml.showAttributes', true);
    const expandAll = button(t('xml.expandAll'));
    const collapseAll = button(t('xml.collapseAll'));
    toolbar.append(search, scope, previous, next, matchStatus, matchesOnly.label, showAttributes.label, expandAll, collapseAll);

    // ── Diagnostics ───────────────────────────────────────────────────────
    const problems = element('details', 'omni-xml__diagnostics');
    if (diagnostics.length) {
        const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
        problems.open = errors > 0;
        problems.append(element('summary', undefined, t(errors ? 'xml.problemsPartial' : 'xml.problems', { count: diagnostics.length })));
        const list = element('ul');
        for (const diagnostic of diagnostics) {
            const item = element('li', `omni-xml__diagnostic omni-xml__diagnostic--${diagnostic.severity}`);
            const offset = diagnostic.args?.offset;
            if (typeof offset === 'number') {
                const jump = button(diagnosticText(ctx, diagnostic), 'omni-xml__link');
                on(jump, 'click', () => revealOffset(offset));
                item.append(jump);
            } else item.textContent = diagnosticText(ctx, diagnostic);
            list.append(item);
        }
        problems.append(list);
    } else problems.hidden = true;

    // ── Panes ─────────────────────────────────────────────────────────────
    const layout = element('div', 'omni-xml__layout');
    const treePane = element('section', 'omni-xml__pane omni-xml__tree-pane');
    const treeHeader = element('header', 'omni-xml__pane-header');
    const rowCount = element('span');
    treeHeader.append(element('h2', undefined, t('xml.tree')), rowCount);
    const tree = element('div', 'omni-xml__tree');
    tree.tabIndex = 0;
    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', t('xml.treeLabel'));
    const treeCanvas = element('div', 'omni-xml__canvas');
    const treeWindow = element('div', 'omni-xml__window');
    treeCanvas.append(treeWindow);
    tree.append(treeCanvas);
    treePane.append(treeHeader, tree);

    const side = element('div', 'omni-xml__side');
    const inspector = element('section', 'omni-xml__pane omni-xml__inspector');
    inspector.setAttribute('aria-label', t('xml.inspector'));
    const sourcePane = element('section', 'omni-xml__pane omni-xml__source-pane');
    const sourceHeader = element('header', 'omni-xml__pane-header');
    sourceHeader.append(element('h2', undefined, t('xml.source')), element('span', undefined, t('xml.lineCount', { count: xml.lineStarts.length })));
    const source = element('div', 'omni-xml__source');
    source.setAttribute('role', 'region');
    source.setAttribute('aria-label', t('xml.source'));
    source.tabIndex = 0;
    const sourceCanvas = element('div', 'omni-xml__canvas');
    const sourceWindow = element('div', 'omni-xml__window');
    sourceCanvas.append(sourceWindow);
    source.append(sourceCanvas);
    sourcePane.append(sourceHeader, source);
    side.append(inspector, sourcePane);
    layout.append(treePane, side);

    const announcer = element('div', 'omni-xml__sr-only');
    announcer.setAttribute('aria-live', 'polite');
    frame.append(header, summary, toolbar, problems, layout, announcer);

    // ── Copy ──────────────────────────────────────────────────────────────
    const copy = (text: string): void => {
        if (!ctx.clipboard) return;
        ctx.clipboard.writeText(text).then(
            () => { announcer.textContent = t('xml.copied'); },
            () => { announcer.textContent = t('xml.copyFailed'); }
        );
    };
    const copyButton = (labelKey: string, value: () => string): HTMLButtonElement => {
        const node = button(t(labelKey));
        node.disabled = !ctx.clipboard;
        if (!ctx.clipboard) node.title = t('common.noClipboard');
        on(node, 'click', () => copy(value()));
        return node;
    };

    // ── Tree rendering ────────────────────────────────────────────────────
    const matchSet = (): ReadonlySet<number> => {
        if (matchSetCache.source !== controller.state.matches) matchSetCache = { source: controller.state.matches, set: new Set(controller.state.matches) };
        return matchSetCache.set;
    };
    let matchSetCache: { source: readonly number[]; set: ReadonlySet<number> } = { source: [], set: new Set() };

    const rowContent = (node: XmlNode, row: HTMLElement): void => {
        const span = (className: string, text: string): void => { row.append(element('span', className, text)); };
        switch (node.kind) {
            case 'element': {
                span('omni-xml__tag', `<${node.name}`);
                for (const attribute of node.attributes.slice(0, ROW_ATTRIBUTE_PREVIEW)) {
                    span('omni-xml__attr-name', ` ${attribute.name}`);
                    span('omni-xml__punct', '=');
                    span('omni-xml__attr-value', `"${preview(attribute.value, 40)}"`);
                }
                if (node.attributes.length > ROW_ATTRIBUTE_PREVIEW) span('omni-xml__muted', ` ${t('xml.moreAttributes', { count: node.attributes.length - ROW_ATTRIBUTE_PREVIEW })}`);
                span('omni-xml__tag', node.children.length || node.selfClosing === false ? '>' : '/>');
                const inline = controller.inlineText(node.id);
                if (inline) span('omni-xml__inline-text', preview(inline.value, ROW_TEXT_PREVIEW));
                else if (node.children.length && !controller.isExpanded(node.id)) span('omni-xml__muted', ` ${t('xml.childCount', { count: node.children.length })}`);
                break;
            }
            case 'attribute':
                span('omni-xml__attr-name', `@${node.name}`);
                span('omni-xml__punct', ' = ');
                span('omni-xml__attr-value', `"${preview(node.value, ROW_TEXT_PREVIEW)}"`);
                break;
            case 'text': span('omni-xml__text', preview(node.value, ROW_TEXT_PREVIEW)); break;
            case 'cdata':
                span('omni-xml__badge', 'CDATA');
                span('omni-xml__text', preview(node.value, ROW_TEXT_PREVIEW));
                break;
            case 'comment': span('omni-xml__comment', `<!-- ${preview(node.value, ROW_TEXT_PREVIEW)} -->`); break;
            case 'pi': span('omni-xml__comment', `<?${node.name} ${preview(node.value, ROW_TEXT_PREVIEW)}?>`); break;
            case 'doctype': span('omni-xml__comment', `<!DOCTYPE ${node.name}>`); break;
        }
    };

    const renderTree = (): void => {
        const { rows, matches, matchIndex } = controller.state;
        const selected = controller.selectedRow();
        const viewport = tree.clientHeight || FALLBACK_VIEWPORT_HEIGHT;
        const { height, start, end, offset, first } = xmlVirtualWindow(rows.length, XML_TREE_ROW_HEIGHT, tree.scrollTop, viewport);
        // Remember what is under the viewport so a change in the row list can
        // put it back: the selected row if it is in view, else the top row.
        // Only the rendered window is searched: this runs on every scroll frame.
        let selectedIndex = -1;
        if (selected !== null) for (let index = start; index < end && selectedIndex < 0; index++) if (rows[index] === selected) selectedIndex = index;
        const inView = selectedIndex >= first && selectedIndex < first + viewport / XML_TREE_ROW_HEIGHT;
        const anchorIndex = inView ? selectedIndex : Math.min(rows.length - 1, Math.floor(first));
        treeAnchor = anchorIndex >= 0 ? { rows, id: rows[anchorIndex]!, offset: anchorIndex - first } : null;
        treeCanvas.style.height = `${height}px`;
        treeWindow.style.transform = `translateY(${offset}px)`;
        const matched = matchSet();
        const current = matchIndex >= 0 ? matches[matchIndex] : undefined;
        const fragment = document.createDocumentFragment();
        for (let index = start; index < end; index++) {
            const id = rows[index]!;
            const node = nodes[id]!;
            const row = element('div', `omni-xml__row omni-xml__row--${node.kind}`);
            row.id = `${uid}-n${id}`;
            row.dataset.id = String(id);
            row.setAttribute('role', 'treeitem');
            row.setAttribute('aria-level', String(node.depth + 1));
            row.setAttribute('aria-selected', String(id === selected));
            row.style.paddingInlineStart = `${8 + node.depth * 16}px`;
            if (matched.has(id)) row.classList.add('omni-xml__row--match');
            if (id === current) row.classList.add('omni-xml__row--current');
            const twisty = element('span', 'omni-xml__twisty');
            if (controller.isExpandable(id)) {
                const open = controller.isExpanded(id);
                row.setAttribute('aria-expanded', String(open));
                twisty.textContent = open ? '▾' : '▸';
                twisty.dataset.toggle = String(id);
            }
            row.append(twisty);
            rowContent(node, row);
            fragment.append(row);
        }
        treeWindow.replaceChildren(fragment);
        rowCount.textContent = t('xml.rowCount', { count: rows.length });
        if (selected !== null && treeWindow.querySelector(`[data-id="${selected}"]`)) tree.setAttribute('aria-activedescendant', `${uid}-n${selected}`);
        else tree.removeAttribute('aria-activedescendant');
    };

    let treeAnchor: { rows: readonly number[]; id: number; offset: number } | null = null;
    /**
     * After the row list changes (toggle, expand/collapse all, filter), keep
     * the anchored row at the same place in the viewport. Without this a
     * scaled canvas would re-map the unchanged scrollTop onto other rows.
     */
    const reanchorTree = (): void => {
        const rows = controller.state.rows;
        if (!treeAnchor || treeAnchor.rows === rows) return;
        // A collapsed-away row hands its place to its nearest listed ancestor.
        let index = -1;
        for (let id = treeAnchor.id; id >= 0 && index < 0; id = nodes[id]!.parent) index = rows.indexOf(id);
        if (index < 0) return;
        tree.scrollTop = xmlScrollTopForRow(index - treeAnchor.offset, rows.length, XML_TREE_ROW_HEIGHT, tree.clientHeight || FALLBACK_VIEWPORT_HEIGHT);
    };

    const scrollTreeTo = (id: number): void => {
        const index = controller.state.rows.indexOf(id);
        if (index < 0) return;
        const viewport = tree.clientHeight || FALLBACK_VIEWPORT_HEIGHT;
        const count = controller.state.rows.length;
        const { first } = xmlVirtualWindow(count, XML_TREE_ROW_HEIGHT, tree.scrollTop, viewport);
        const visible = Math.floor(viewport / XML_TREE_ROW_HEIGHT);
        if (index < first) tree.scrollTop = xmlScrollTopForRow(index, count, XML_TREE_ROW_HEIGHT, viewport);
        else if (index >= first + visible) tree.scrollTop = xmlScrollTopForRow(Math.max(0, index - visible + 1), count, XML_TREE_ROW_HEIGHT, viewport);
    };

    // ── Source rendering ──────────────────────────────────────────────────
    const segments = buildSegments(xml);
    const highlight = (): { range: { start: number; end: number } | null; focus: { start: number; end: number } | null } => {
        const node = controller.state.selected === null ? undefined : nodes[controller.state.selected];
        if (!node) return { range: null, focus: null };
        return { range: node.range, focus: node.kind === 'element' ? node.openTag ?? node.range : node.range };
    };
    const renderSource = (): void => {
        const { height, start, end, offset } = xmlVirtualWindow(segments.count, XML_SOURCE_ROW_HEIGHT, source.scrollTop, source.clientHeight || FALLBACK_VIEWPORT_HEIGHT);
        sourceCanvas.style.height = `${height}px`;
        sourceWindow.style.transform = `translateY(${offset}px)`;
        const { range, focus } = highlight();
        const fragment = document.createDocumentFragment();
        for (let index = start; index < end; index++) {
            const from = segments.start[index]!;
            const to = segments.end[index]!;
            const line = segments.line[index]!;
            const row = element('div', 'omni-xml__source-row');
            row.dataset.offset = String(from);
            if (range && range.start < Math.max(to, from + 1) && range.end > from) row.classList.add('omni-xml__source-row--range');
            row.append(element('span', 'omni-xml__ln', line > 0 ? String(line) : '↪'));
            const code = element('span', 'omni-xml__code');
            // Cut the segment at the focus bounds so the focused part gets its own mark.
            const cuts = [from, ...(focus ? [focus.start, focus.end].filter((at) => at > from && at < to) : []), to];
            for (let piece = 0; piece + 1 < cuts.length; piece++) {
                const a = cuts[piece]!;
                const b = cuts[piece + 1]!;
                const focused = !!focus && a >= focus.start && b <= focus.end;
                appendTokens(code, xml.text.slice(a, b), a, focused ? 'omni-xml__src-focus' : '');
            }
            row.append(code);
            fragment.append(row);
        }
        sourceWindow.replaceChildren(fragment);
    };
    const scrollSourceTo = (offset: number): void => {
        const index = segmentAt(segments, offset);
        const viewport = source.clientHeight || FALLBACK_VIEWPORT_HEIGHT;
        const { first } = xmlVirtualWindow(segments.count, XML_SOURCE_ROW_HEIGHT, source.scrollTop, viewport);
        const visible = Math.floor(viewport / XML_SOURCE_ROW_HEIGHT);
        if (index < first || index >= first + visible) {
            source.scrollTop = xmlScrollTopForRow(Math.max(0, index - Math.floor(visible / 3)), segments.count, XML_SOURCE_ROW_HEIGHT, viewport);
        }
    };
    const revealOffset = (offset: number): void => {
        controller.dispatch({ type: 'select-offset', offset });
        scrollSourceTo(offset);
        renderSource();
    };

    // ── Inspector ─────────────────────────────────────────────────────────
    const field = (list: HTMLElement, labelKey: string, value: string | HTMLElement): void => {
        list.append(element('dt', undefined, t(labelKey)));
        const dd = element('dd');
        if (typeof value === 'string') dd.textContent = value;
        else dd.append(value);
        list.append(dd);
    };
    const renderDocumentInfo = (): void => {
        inspector.append(element('h2', undefined, t('xml.document')));
        const facts = element('dl', 'omni-xml__facts');
        const declared = xml.declaration?.encoding;
        field(facts, 'xml.field.version', xml.declaration?.version || '-');
        field(facts, 'xml.field.encoding', declared && declared.toLowerCase() !== xml.encoding ? t('xml.field.encodingValue', { used: xml.encoding.toUpperCase(), declared }) : xml.encoding.toUpperCase());
        if (xml.declaration?.standalone) field(facts, 'xml.field.standalone', xml.declaration.standalone);
        if (xml.doctype) {
            field(facts, 'xml.field.doctype', xml.doctype.name);
            if (xml.doctype.publicId) field(facts, 'xml.field.publicId', xml.doctype.publicId);
            if (xml.doctype.systemId) field(facts, 'xml.field.systemId', xml.doctype.systemId);
        }
        if (xml.root) {
            field(facts, 'xml.field.root', xml.root.name);
            if (xml.root.namespaceUri) field(facts, 'xml.field.namespace', xml.root.namespaceUri);
        }
        inspector.append(facts);

        inspector.append(element('h3', undefined, t('xml.namespaces')));
        if (!xml.namespaces.length) inspector.append(element('p', 'omni-xml__muted', t('xml.noNamespaces')));
        else {
            const table = element('table', 'omni-xml__table');
            const head = element('tr');
            head.append(element('th', undefined, t('xml.field.prefix')), element('th', undefined, t('xml.field.uri')), element('th', undefined, t('xml.field.count')));
            table.append(head);
            const grouped = new Map<string, { prefix: string; uri: string; count: number; first: number }>();
            for (const declaration of xml.namespaces) {
                const key = `${declaration.prefix}\u0000${declaration.uri}`;
                const entry = grouped.get(key);
                if (entry) entry.count++;
                else grouped.set(key, { prefix: declaration.prefix, uri: declaration.uri, count: 1, first: declaration.element });
            }
            for (const entry of grouped.values()) {
                const row = element('tr', 'omni-xml__clickable');
                row.append(element('td', undefined, entry.prefix || t('xml.defaultNamespace')), element('td', undefined, entry.uri), element('td', undefined, String(entry.count)));
                on(row, 'click', () => selectAndReveal(entry.first));
                table.append(row);
            }
            inspector.append(table);
        }

        inspector.append(element('h3', undefined, t('xml.statistics')));
        const stats = element('dl', 'omni-xml__facts');
        field(stats, 'xml.summary.elements', String(xml.stats.elements));
        field(stats, 'xml.summary.attributes', String(xml.stats.attributes));
        field(stats, 'xml.stat.text', String(xml.stats.text));
        field(stats, 'xml.stat.cdata', String(xml.stats.cdata));
        field(stats, 'xml.stat.comments', String(xml.stats.comments));
        field(stats, 'xml.stat.pis', String(xml.stats.processingInstructions));
        field(stats, 'xml.summary.depth', String(xml.stats.maxDepth));
        inspector.append(stats);
    };
    const renderNodeInfo = (node: XmlNode): void => {
        const title = element('h2');
        title.append(element('span', 'omni-xml__badge', t(`xml.kind.${node.kind}`)), document.createTextNode(` ${node.name || ''}`));
        inspector.append(title);
        const xpath = controller.xpath(node.id);
        const actions = element('div', 'omni-xml__actions');
        if (xpath) actions.append(copyButton('xml.copyXpath', () => controller.xpath(node.id)));
        actions.append(copyButton('xml.copyValue', () => controller.value(node.id)), copyButton('xml.copyXml', () => controller.outerXml(node.id)));
        const show = button(t('xml.showInSource'));
        on(show, 'click', () => {
            scrollSourceTo(node.range.start);
            renderSource();
            source.focus();
        });
        actions.append(show);
        inspector.append(actions);

        const facts = element('dl', 'omni-xml__facts');
        if (xpath) field(facts, 'xml.field.xpath', element('code', 'omni-xml__xpath', xpath));
        if (node.namespaceUri) field(facts, 'xml.field.namespace', node.namespaceUri);
        const position = xmlPosition(xml.lineStarts, node.range.start);
        field(facts, 'xml.field.position', t('xml.field.positionValue', position));
        if (node.kind === 'element') {
            field(facts, 'xml.field.children', t('xml.field.childrenValue', {
                elements: node.children.filter((child) => child.kind === 'element').length,
                attributes: node.attributes.length
            }));
            if (node.closed === false) field(facts, 'xml.field.status', t('xml.unclosed'));
        }
        inspector.append(facts);

        if (node.kind === 'element' && node.attributes.length) {
            inspector.append(element('h3', undefined, t('xml.attributes')));
            const table = element('table', 'omni-xml__table');
            const head = element('tr');
            head.append(element('th', undefined, t('xml.field.name')), element('th', undefined, t('xml.field.value')));
            table.append(head);
            for (const attribute of node.attributes) {
                const row = element('tr', 'omni-xml__clickable');
                row.append(element('td', 'omni-xml__attr-name', attribute.name), element('td', undefined, attribute.value));
                on(row, 'click', () => selectAndReveal(attribute.id));
                table.append(row);
            }
            inspector.append(table);
        }

        const content = controller.textContent(node.id, INSPECTOR_TEXT_CHARS);
        inspector.append(element('h3', undefined, t(node.kind === 'element' ? 'xml.field.text' : 'xml.field.value')));
        if (!content.text) inspector.append(element('p', 'omni-xml__muted', t('xml.emptyText')));
        else {
            inspector.append(element('pre', 'omni-xml__value', content.text));
            if (content.truncated) inspector.append(element('p', 'omni-xml__muted', t('xml.truncated', { count: INSPECTOR_TEXT_CHARS })));
        }
    };
    const renderInspector = (): void => {
        inspector.replaceChildren();
        const selected = controller.state.selected;
        if (selected === null) renderDocumentInfo();
        else renderNodeInfo(nodes[selected]!);
        inspector.scrollTop = 0;
    };

    // ── State → DOM ───────────────────────────────────────────────────────
    const renderMatchStatus = (): void => {
        const { search: query, matches, matchIndex } = controller.state;
        if (!query.trim()) matchStatus.textContent = '';
        else if (!matches.length) matchStatus.textContent = t('xml.noMatches');
        else matchStatus.textContent = t('xml.matchPosition', { current: matchIndex + 1, total: matches.length });
        previous.disabled = next.disabled = matches.length === 0;
    };
    let lastSelected: number | null | undefined;
    /** Set while a source click dispatches, so the source keeps its scroll. */
    let sourceClick = false;
    let lastShowAttributes = controller.state.showAttributes;
    const render = (): void => {
        const { selected, showAttributes: attributesShown } = controller.state;
        const selectionChanged = selected !== lastSelected || attributesShown !== lastShowAttributes;
        lastShowAttributes = attributesShown;
        reanchorTree();
        const row = controller.selectedRow();
        if (selectionChanged && row !== null) scrollTreeTo(row);
        renderTree();
        renderMatchStatus();
        if (selectionChanged) {
            lastSelected = selected;
            renderInspector();
            if (selected !== null && !sourceClick) scrollSourceTo(nodes[selected]!.range.start);
            renderSource();
        }
    };

    const selectAndReveal = (id: number): void => controller.dispatch({ type: 'select', id });

    // ── Events ────────────────────────────────────────────────────────────
    on(tree, 'scroll', () => renderTree());
    on(source, 'scroll', () => renderSource());
    on(tree, 'click', (event) => {
        const target = event.target as HTMLElement;
        const toggle = target.closest<HTMLElement>('[data-toggle]');
        if (toggle) {
            controller.dispatch({ type: 'toggle', id: Number(toggle.dataset.toggle) });
            return;
        }
        const row = target.closest<HTMLElement>('.omni-xml__row');
        if (row) controller.dispatch({ type: 'select', id: Number(row.dataset.id) });
    });
    on(tree, 'dblclick', (event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>('.omni-xml__row');
        if (row && controller.isExpandable(Number(row.dataset.id))) controller.dispatch({ type: 'toggle', id: Number(row.dataset.id) });
    });
    const KEY_MOVES: Record<string, XmlMoveDirection> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home', End: 'end' };
    on(tree, 'keydown', (event) => {
        const direction = KEY_MOVES[event.key];
        if (direction) {
            event.preventDefault();
            controller.dispatch({ type: 'move', direction });
        } else if (event.key === 'Enter' && controller.state.selected !== null) {
            event.preventDefault();
            scrollSourceTo(nodes[controller.state.selected]!.range.start);
            renderSource();
        } else if (event.key === ' ' && controller.state.selected !== null && controller.isExpandable(controller.state.selected)) {
            event.preventDefault();
            controller.dispatch({ type: 'toggle', id: controller.state.selected });
        }
    });
    on(source, 'click', (event) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>('[data-offset]');
        if (!target) return;
        sourceClick = true;
        try {
            controller.dispatch({ type: 'select-offset', offset: Number(target.dataset.offset) });
        } finally {
            sourceClick = false;
        }
    });

    const flushSearch = (): boolean => {
        if (searchTimer === undefined) return false;
        clearTimeout(searchTimer);
        searchTimer = undefined;
        controller.dispatch({ type: 'set-search', search: search.value });
        return true;
    };
    on(search, 'input', () => {
        if (searchTimer !== undefined) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            searchTimer = undefined;
            controller.dispatch({ type: 'set-search', search: search.value });
        }, XML_SEARCH_DEBOUNCE_MS);
    });
    on(search, 'keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            // The first Enter after typing lands on the first match itself.
            if (!flushSearch()) controller.dispatch({ type: event.shiftKey ? 'previous-match' : 'next-match' });
        } else if (event.key === 'Escape' && search.value) {
            event.preventDefault();
            search.value = '';
            if (searchTimer !== undefined) clearTimeout(searchTimer);
            searchTimer = undefined;
            controller.dispatch({ type: 'set-search', search: '' });
        }
    });
    on(scope, 'change', () => {
        flushSearch();
        controller.dispatch({ type: 'set-search-scope', scope: scope.value as XmlSearchScope });
    });
    on(previous, 'click', () => controller.dispatch({ type: 'previous-match' }));
    on(next, 'click', () => controller.dispatch({ type: 'next-match' }));
    on(matchesOnly.input, 'change', () => controller.dispatch({ type: 'set-matches-only', value: matchesOnly.input.checked }));
    on(showAttributes.input, 'change', () => controller.dispatch({ type: 'set-show-attributes', value: showAttributes.input.checked }));
    on(expandAll, 'click', () => controller.dispatch({ type: 'expand-all' }));
    on(collapseAll, 'click', () => controller.dispatch({ type: 'collapse-all' }));

    const unsubscribe = controller.subscribe(render);
    render();

    const handle = disposer(container, frame, style, () => {
        unsubscribe();
        events.abort();
        if (searchTimer !== undefined) clearTimeout(searchTimer);
        searchTimer = undefined;
    });
    return { ...handle, controller };
}

/** The mounted viewer's controller, for hosts that drive selection or search. */
export interface XmlViewerHandle extends ViewerHandle {
    readonly controller: XmlController;
}
