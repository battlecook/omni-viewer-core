// XML viewer behavior controller (DESIGN.md §3-②): selection, expansion,
// search, and the XPath/offset mappings, with no DOM. The renderer is one
// consumer; a host can drive the same state machine with its own UI.

import { asciiLower } from '../../parsers/csv/index.js';
import type { XmlDocument, XmlNode } from '../../parsers/xml/index.js';

/** Which part of a node the search box looks at (docs/viewers/xml.md §3). */
export type XmlSearchScope = 'all' | 'name' | 'value' | 'comment';
export const XML_SEARCH_SCOPES: readonly XmlSearchScope[] = ['all', 'name', 'value', 'comment'];
/** Root children are pre-expanded on open only up to this many. */
export const XML_INITIAL_EXPAND_CHILDREN = 100;

export type XmlMoveDirection = 'up' | 'down' | 'left' | 'right' | 'home' | 'end';

export type XmlAction =
    | { type: 'select'; id: number | null }
    | { type: 'select-offset'; offset: number }
    | { type: 'toggle'; id: number }
    | { type: 'expand-all' }
    | { type: 'collapse-all' }
    | { type: 'set-search'; search: string }
    | { type: 'set-search-scope'; scope: XmlSearchScope }
    | { type: 'next-match' }
    | { type: 'previous-match' }
    | { type: 'set-matches-only'; value: boolean }
    | { type: 'set-show-attributes'; value: boolean }
    | { type: 'move'; direction: XmlMoveDirection };

export interface XmlViewState {
    selected: number | null;
    expanded: ReadonlySet<number>;
    /** Node ids of the visible tree rows, in display order. */
    rows: readonly number[];
    showAttributes: boolean;
    search: string;
    searchScope: XmlSearchScope;
    /** Row ids whose node (or folded text / hidden attribute) matches, in document order. */
    matches: readonly number[];
    /** Index into `matches` of the current match, or -1. */
    matchIndex: number;
    matchesOnly: boolean;
}

export interface XmlController {
    readonly document: XmlDocument;
    readonly state: XmlViewState;
    dispatch(action: XmlAction): void;
    subscribe(listener: (state: XmlViewState) => void): () => void;
    /** Absolute XPath with positional predicates only where a name repeats. */
    xpath(id: number): string;
    /** Concatenated descendant character data, cut at `max` characters. */
    textContent(id: number, max?: number): { text: string; truncated: boolean };
    /** The value Copy value puts on the clipboard. */
    value(id: number): string;
    /** The node's source as written. */
    outerXml(id: number): string;
    /** Deepest node (as a tree row) whose source range covers the offset. */
    nodeAtOffset(offset: number): number | null;
    /** Element whose only content is one text/CDATA node shown on its own row. */
    inlineText(id: number): XmlNode | null;
    isExpandable(id: number): boolean;
    /** Whether a row shows its children. With "matches only" on, rows show
     *  their kept children regardless of the expansion state. */
    isExpanded(id: number): boolean;
    /** The tree row standing for the selection: the selected node itself, or
     *  its nearest ancestor with a row (a hidden attribute, a filtered node). */
    selectedRow(): number | null;
}

export function createXmlController(document: XmlDocument): XmlController {
    const { nodes } = document;
    const listeners = new Set<(state: XmlViewState) => void>();
    const state: XmlViewState = {
        selected: null, expanded: new Set(), rows: [], showAttributes: true,
        search: '', searchScope: 'all', matches: [], matchIndex: -1, matchesOnly: false
    };
    let keep: ReadonlySet<number> | null = null;

    const inlineText = (id: number): XmlNode | null => {
        const node = nodes[id];
        if (node?.kind !== 'element' || node.children.length !== 1) return null;
        const only = node.children[0]!;
        return only.kind === 'text' || only.kind === 'cdata' ? only : null;
    };
    const visibleChildren = (node: XmlNode): readonly XmlNode[] => {
        if (node.kind !== 'element') return [];
        const children = inlineText(node.id) ? [] : node.children;
        if (!state.showAttributes || !node.attributes.length) return children;
        return children.length ? [...node.attributes, ...children] : node.attributes;
    };
    /** Tests the would-be child rows without building the list: this runs per
     *  visible row on every scroll frame, and a root may have 100k children. */
    const anyChildRow = (node: XmlNode, test: (child: XmlNode) => boolean): boolean => {
        if (node.kind !== 'element') return false;
        if (state.showAttributes) for (const attribute of node.attributes) if (test(attribute)) return true;
        if (!inlineText(node.id)) for (const child of node.children) if (test(child)) return true;
        return false;
    };
    const isExpandable = (id: number): boolean => {
        const node = nodes[id];
        if (!node) return false;
        const kept = keep;
        return kept ? anyChildRow(node, (child) => kept.has(child.id)) : anyChildRow(node, () => true);
    };
    const isExpanded = (id: number): boolean => (keep ? isExpandable(id) : state.expanded.has(id));
    let rowSet: ReadonlySet<number> = new Set();
    const selectedRow = (): number | null => {
        for (let id = state.selected ?? -1; id >= 0; id = nodes[id]!.parent) if (rowSet.has(id)) return id;
        return null;
    };
    /** The tree row a node is shown on: folded text and hidden attributes
     *  belong to their element's row. */
    const rowOf = (node: XmlNode): number => {
        if (node.kind === 'attribute' && !state.showAttributes) return node.parent;
        if ((node.kind === 'text' || node.kind === 'cdata') && node.parent >= 0 && inlineText(node.parent) === node) return node.parent;
        return node.id;
    };

    const rebuildRows = (): void => {
        const rows: number[] = [];
        const pending: XmlNode[] = [...document.topLevel].reverse();
        while (pending.length) {
            const node = pending.pop()!;
            if (keep && !keep.has(node.id)) continue;
            rows.push(node.id);
            if (!keep && !state.expanded.has(node.id)) continue;
            const children = visibleChildren(node);
            for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]!);
        }
        state.rows = rows;
        rowSet = new Set(rows);
    };

    const revealAncestors = (id: number): void => {
        let parent = nodes[id]?.parent ?? -1;
        if (parent < 0) return;
        const expanded = new Set(state.expanded);
        let changed = false;
        for (; parent >= 0; parent = nodes[parent]!.parent) {
            if (!expanded.has(parent)) {
                expanded.add(parent);
                changed = true;
            }
        }
        if (changed) {
            state.expanded = expanded;
            rebuildRows();
        }
    };
    const select = (id: number | null, reveal = true): void => {
        state.selected = id !== null && nodes[id] ? id : null;
        if (state.selected !== null && reveal) revealAncestors(state.selected);
    };

    const matchesNode = (node: XmlNode, query: string): boolean => {
        const scope = state.searchScope;
        const has = (value: string): boolean => asciiLower(value).includes(query);
        switch (node.kind) {
            case 'element': return (scope === 'all' || scope === 'name') && has(node.name);
            case 'attribute': return ((scope === 'all' || scope === 'name') && has(node.name)) || ((scope === 'all' || scope === 'value') && has(node.value));
            case 'text': case 'cdata': return (scope === 'all' || scope === 'value') && has(node.value);
            case 'comment': return (scope === 'all' || scope === 'comment') && has(node.value);
            case 'pi': return (scope === 'all' || scope === 'comment') && (has(node.name) || has(node.value));
            case 'doctype': return (scope === 'all' || scope === 'comment') && has(node.value);
        }
    };
    /** `jump` moves the selection to the first match (a new query does; a
     *  display change that only re-resolves rows does not). */
    const runSearch = (jump: boolean): void => {
        const query = asciiLower(state.search.trim());
        const matches: number[] = [];
        if (query) {
            // Rows resolve to their element, so drop the repeats this makes;
            // document order keeps an element's own id ahead of its content.
            const seen = new Set<number>();
            for (const node of nodes) {
                if (!matchesNode(node, query)) continue;
                const row = rowOf(node);
                if (!seen.has(row)) {
                    seen.add(row);
                    matches.push(row);
                }
            }
            matches.sort((a, b) => a - b);
        }
        state.matches = matches;
        state.matchIndex = matches.length ? (jump ? 0 : Math.max(-1, matches.indexOf(state.selected ?? -1))) : -1;
        refreshFilter();
        if (jump && matches.length) select(matches[0]!);
    };
    const refreshFilter = (): void => {
        if (state.matchesOnly && state.search.trim()) {
            const kept = new Set<number>();
            for (const id of state.matches) {
                for (let at = id; at >= 0 && !kept.has(at); at = nodes[at]!.parent) kept.add(at);
            }
            keep = kept;
        } else keep = null;
        rebuildRows();
    };
    const stepMatch = (delta: number): void => {
        const count = state.matches.length;
        if (!count) return;
        state.matchIndex = ((state.matchIndex < 0 ? (delta > 0 ? -1 : 0) : state.matchIndex) + delta + count) % count;
        select(state.matches[state.matchIndex]!);
    };

    const nodeAtOffset = (offset: number): number | null => {
        let list: readonly XmlNode[] = document.topLevel;
        let found: XmlNode | null = null;
        for (;;) {
            let lo = 0;
            let hi = list.length - 1;
            let hit: XmlNode | null = null;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const candidate = list[mid]!;
                if (offset < candidate.range.start) hi = mid - 1;
                else if (offset >= candidate.range.end) lo = mid + 1;
                else {
                    hit = candidate;
                    break;
                }
            }
            if (!hit) break;
            found = hit;
            if (hit.kind !== 'element') break;
            const attribute = hit.attributes.find((a) => offset >= a.range.start && offset < a.range.end);
            if (attribute) {
                found = attribute;
                break;
            }
            // Inside the start tag but not on an attribute: the element itself.
            if (hit.openTag && offset < hit.openTag.end) break;
            list = hit.children;
        }
        return found ? rowOf(found) : null;
    };

    const move = (direction: XmlMoveDirection): void => {
        const rows = state.rows;
        if (!rows.length) return;
        const current = selectedRow();
        const index = current === null ? -1 : rows.indexOf(current);
        if (direction === 'home') select(rows[0]!, false);
        else if (direction === 'end') select(rows[rows.length - 1]!, false);
        else if (index < 0 || current === null) select(rows[0]!, false);
        else if (direction === 'up') select(rows[Math.max(0, index - 1)]!, false);
        else if (direction === 'down') select(rows[Math.min(rows.length - 1, index + 1)]!, false);
        else if (direction === 'right') {
            if (!isExpandable(current)) return;
            if (!isExpanded(current)) toggle(current);
            else if (rows[index + 1] !== undefined && nodes[rows[index + 1]!]!.parent === current) select(rows[index + 1]!, false);
        } else {
            if (isExpandable(current) && isExpanded(current) && !keep) toggle(current);
            else if (nodes[current]!.parent >= 0) select(nodes[current]!.parent, false);
        }
    };
    const toggle = (id: number): void => {
        // The matches-only filter fixes what is shown; expansion would not change it.
        if (keep) return;
        const expanded = new Set(state.expanded);
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        state.expanded = expanded;
        rebuildRows();
    };

    const siblingStep = (node: XmlNode, test: (sibling: XmlNode) => boolean, step: string): string => {
        const siblings = node.parent >= 0 ? nodes[node.parent]!.children : document.topLevel;
        let position = 0;
        let count = 0;
        for (const sibling of siblings) {
            if (!test(sibling)) continue;
            count++;
            if (sibling === node) position = count;
        }
        return count > 1 ? `${step}[${position}]` : step;
    };
    /**
     * `text()` position in the XPath data model, where adjacent text and CDATA
     * are one node and whitespace-only runs — which the parser drops — still
     * count. Gaps between the source ranges of an element's content are those
     * runs (anything else there would have become a text node).
     */
    const textStep = (node: XmlNode): string => {
        const parent = nodes[node.parent];
        if (!parent) return 'text()';
        let cursor = parent.openTag?.end ?? parent.range.start;
        let count = 0;
        let position = 0;
        let previousText = false;
        for (const sibling of parent.children) {
            if (sibling.range.start > cursor && !previousText) {
                count++;
                previousText = true;
            }
            const isText = sibling.kind === 'text' || sibling.kind === 'cdata';
            if (isText && !previousText) count++;
            if (sibling === node) position = count;
            previousText = isText;
            cursor = sibling.range.end;
        }
        const contentEnd = parent.closed !== false && !parent.selfClosing
            ? document.text.lastIndexOf('</', parent.range.end - 1)
            : parent.range.end;
        if (contentEnd > cursor && !previousText) count++;
        return count > 1 ? `text()[${position}]` : 'text()';
    };
    const xpath = (id: number): string => {
        const steps: string[] = [];
        for (let node = nodes[id]; node; node = node.parent >= 0 ? nodes[node.parent] : undefined) {
            switch (node.kind) {
                case 'element': steps.push(siblingStep(node, (s) => s.kind === 'element' && s.name === node!.name, node.name)); break;
                // A namespace declaration is a namespace node in the XPath data
                // model, not an attribute: `@xmlns:p` would select nothing.
                case 'attribute': steps.push(node.name === 'xmlns' ? "namespace::*[name()='']" : node.prefix === 'xmlns' ? `namespace::${node.local}` : `@${node.name}`); break;
                case 'text': case 'cdata': steps.push(textStep(node)); break;
                case 'comment': steps.push(siblingStep(node, (s) => s.kind === 'comment', 'comment()')); break;
                case 'pi': steps.push(siblingStep(node, (s) => s.kind === 'pi' && s.name === node!.name, `processing-instruction('${node.name}')`)); break;
                case 'doctype': return '';
            }
        }
        return `/${steps.reverse().join('/')}`;
    };

    const textContent = (id: number, max = Number.POSITIVE_INFINITY): { text: string; truncated: boolean } => {
        const node = nodes[id];
        if (!node) return { text: '', truncated: false };
        if (node.kind !== 'element') return node.value.length > max ? { text: node.value.slice(0, max), truncated: true } : { text: node.value, truncated: false };
        // The XPath string-value: descendant character data in order,
        // including the whitespace-only runs the parser drops — they are the
        // source gaps between an element's content ranges (`Click <g>Save</g>
        // <g>now</g>` reads "Click Save now", not "Click Savenow").
        const parts: string[] = [];
        let length = 0;
        const add = (value: string): boolean => {
            parts.push(value);
            length += value.length;
            return length > max;
        };
        const gap = (from: number, to: number): string => {
            const run = document.text.slice(from, to);
            return /^[ \t\r\n]*$/.test(run) ? run.replace(/\r\n?/g, '\n') : '';
        };
        const contentEnd = (element: XmlNode): number => element.closed !== false && !element.selfClosing
            ? document.text.lastIndexOf('</', element.range.end - 1)
            : element.range.end;
        // Work items: a node to visit, or a source gap to emit.
        const pending: Array<XmlNode | [number, number]> = [];
        const pushContent = (element: XmlNode): void => {
            if (element.selfClosing) return;
            const items: Array<XmlNode | [number, number]> = [];
            let cursor = element.openTag?.end ?? element.range.start;
            for (const child of element.children) {
                if (child.range.start > cursor) items.push([cursor, child.range.start]);
                items.push(child);
                cursor = child.range.end;
            }
            const end = contentEnd(element);
            if (end > cursor) items.push([cursor, end]);
            for (let i = items.length - 1; i >= 0; i--) pending.push(items[i]!);
        };
        pushContent(node);
        while (pending.length) {
            const next = pending.pop()!;
            if (Array.isArray(next)) {
                const run = gap(next[0], next[1]);
                if (run && add(run)) return { text: parts.join('').slice(0, max), truncated: true };
            } else if (next.kind === 'text' || next.kind === 'cdata') {
                if (add(next.value)) return { text: parts.join('').slice(0, max), truncated: true };
            } else if (next.kind === 'element') pushContent(next);
        }
        return { text: parts.join(''), truncated: false };
    };

    const notify = (): void => listeners.forEach((listener) => listener(state));

    if (document.root) {
        const expanded = new Set<number>([document.root.id]);
        const children = document.root.children.filter((child) => child.kind === 'element');
        if (children.length <= XML_INITIAL_EXPAND_CHILDREN) children.forEach((child) => expanded.add(child.id));
        state.expanded = expanded;
    }
    rebuildRows();

    return {
        document,
        state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        xpath,
        textContent,
        value: (id) => textContent(id).text,
        outerXml: (id) => {
            const node = nodes[id];
            return node ? document.text.slice(node.range.start, node.range.end) : '';
        },
        nodeAtOffset,
        inlineText,
        isExpandable,
        isExpanded,
        selectedRow,
        dispatch(action) {
            switch (action.type) {
                case 'select': select(action.id); break;
                case 'select-offset': select(nodeAtOffset(action.offset)); break;
                case 'toggle': toggle(action.id); break;
                case 'expand-all':
                    state.expanded = new Set(nodes.filter((node) => node.kind === 'element').map((node) => node.id));
                    rebuildRows();
                    break;
                case 'collapse-all':
                    state.expanded = new Set();
                    rebuildRows();
                    break;
                case 'set-search': state.search = action.search; runSearch(true); break;
                case 'set-search-scope': state.searchScope = action.scope; runSearch(true); break;
                case 'next-match': stepMatch(1); break;
                case 'previous-match': stepMatch(-1); break;
                case 'set-matches-only': state.matchesOnly = action.value; refreshFilter(); break;
                case 'set-show-attributes':
                    state.showAttributes = action.value;
                    if (state.selected !== null) state.selected = rowOf(nodes[state.selected]!);
                    runSearch(false);
                    break;
                case 'move': move(action.direction); break;
            }
            notify();
        }
    };
}
