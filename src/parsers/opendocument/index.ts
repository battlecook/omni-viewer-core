import { attribute, elements, invalidPreview, PREVIEW_XML_BYTES, PreviewError, previewParser, previewUtf8, previewZip, type CompressedPreviewOptions } from '../file-preview.js';
import { EpubReadError } from '../epub/zip.js';
import type { ParseOutcome } from '../types.js';
import type { XmlNode } from '../xml/index.js';

const NS = {
    office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
    text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
    table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
    draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
    style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
    svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
    fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
    manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0'
} as const;
const INDEXES = new Set(['table-of-content', 'alphabetical-index', 'illustration-index', 'table-index', 'object-index', 'user-index', 'bibliography']);
const RECT_PRESETS = new Set(['rectangle', 'round-rectangle', 'mso-spt202', 'ooxml-rect', 'ooxml-roundRect']);
export const ODT_MIMETYPE = 'application/vnd.oasis.opendocument.text';
export const ODP_MIMETYPE = 'application/vnd.oasis.opendocument.presentation';

export type OpenDocumentBlock =
    | { kind: 'paragraph' | 'heading'; text: string; level: number }
    | { kind: 'list'; items: OpenDocumentBlock[][] }
    | { kind: 'table'; rows: { text: string; colSpan: number; rowSpan: number }[][] };
export interface OpenDocumentShape {
    kind: 'frame' | 'rect' | 'ellipse' | 'line';
    x: number;
    y: number;
    width: number;
    height: number;
    /** `#rrggbb`, `'none'`, or `''` for the viewer default. */
    fill: string;
    stroke: string;
    blocks: OpenDocumentBlock[];
}
export interface OpenDocumentPage {
    name: string;
    width: number;
    height: number;
    shapes: OpenDocumentShape[];
}
export type OpenDocument = { format: 'odt'; blocks: OpenDocumentBlock[] } | { format: 'odp'; pages: OpenDocumentPage[] };

function pixels(value: string): number | undefined {
    const match = /^(-?(?:\d+(?:\.\d*)?|\.\d+))(cm|mm|in|pt|pc|px)$/.exec(value.trim());
    if (!match) return undefined;
    const scale = { cm: 96 / 2.54, mm: 96 / 25.4, in: 96, pt: 96 / 72, pc: 16, px: 1 };
    const length = Number(match[1]) * scale[match[2] as keyof typeof scale];
    return Math.abs(length) <= 100_000 ? length : undefined;
}
function count(value: string, cap: number): number {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? Math.min(number, cap) : 1;
}
function hex(value: string): string {
    return /^#[0-9a-f]{6}$/i.test(value) ? value : '';
}

export async function parseOpenDocument(input: Uint8Array, options: CompressedPreviewOptions = {}): Promise<ParseOutcome<OpenDocument>> {
    const parser = previewParser(input, options);
    try {
        parser.check();
        const archive = previewZip(input, options);
        const read = (path: string, limit = PREVIEW_XML_BYTES) => archive.read(path, limit, options.signal);
        const hasManifest = archive.has('META-INF/manifest.xml');
        const hasMime = archive.has('mimetype');
        if (!archive.has('content.xml') || (!hasMime && !hasManifest)) return invalidPreview();
        const mime = hasMime ? new TextDecoder().decode(await read('mimetype', 128)).trim() : undefined;
        if (hasMime && mime !== ODT_MIMETYPE && mime !== ODP_MIMETYPE) return invalidPreview();
        const encrypted = new Set<string>();
        if (hasManifest) {
            const manifest = parser.xml(await read('META-INF/manifest.xml', 1024 * 1024)).root!;
            if (manifest.namespaceUri !== NS.manifest || manifest.local !== 'manifest') return invalidPreview();
            for (const entry of elements(manifest, 'file-entry', NS.manifest)) {
                if (elements(entry, 'encryption-data', NS.manifest).length) {
                    encrypted.add(attribute(entry, 'full-path', NS.manifest).toLowerCase());
                }
            }
        }
        if (encrypted.has('content.xml')) throw new PreviewError('password-required', 'preview.encrypted');
        const content = parser.xml(await read('content.xml'));
        const body = elements(content.root!, 'body', NS.office)[0];
        const data = body && elements(body, undefined, NS.office).find(node => node.local === 'text' || node.local === 'presentation');
        if (content.root!.namespaceUri !== NS.office || content.root!.local !== 'document-content' || !data) return invalidPreview();
        const isText = data.local === 'text';
        if (mime !== undefined && mime !== (isText ? ODT_MIMETYPE : ODP_MIMETYPE)) return invalidPreview();
        let remaining = options.limits?.maxEntries ?? 12_000;
        let textBudget = options.limits?.maxPreviewBytes ?? 2 * 1024 * 1024;
        const take = () => {
            if (!parser.checkpoint()) return false;
            if (remaining > 0) {
                remaining--;
                return true;
            }
            parser.warn('truncated');
            return false;
        };
        const takeText = (value: string, limit = 100_000) => {
            const retained = previewUtf8(value, Math.min(textBudget, limit));
            if (retained.text.length < value.length) parser.warn('truncated');
            textBudget -= retained.bytes;
            return retained.text;
        };
        const limitedCount = (value: string, cap: number) => {
            const requested = count(value, Infinity);
            if (requested > cap) parser.warn('truncated');
            return Math.min(requested, cap);
        };
        const readText = (root: XmlNode) => {
            let remainingText = Math.min(textBudget, 100_000);
            const parts: string[] = [];
            // ODF 1.2 §6.1.2: whitespace runs in character data collapse to one space and are dropped at the
            // paragraph's start and end; text:s, text:tab and text:line-break are kept verbatim. The XML parser
            // drops whitespace-only text nodes, so those are recovered from source gaps between siblings.
            let started = false;
            let pendingSpace = false;
            let stopped = false;
            const gap = () => { pendingSpace = true; };
            const emit = (value: string) => {
                if (stopped) return;
                const before = textBudget;
                const shown = takeText(value, remainingText);
                if (shown) parts.push(shown);
                remainingText -= before - textBudget;
                stopped = shown.length < value.length;
            };
            const append = (node: XmlNode) => {
                if (node.kind === 'text' || node.kind === 'cdata') {
                    const normalized = node.value.replace(/[ \t\r\n]+/g, ' ');
                    const startsWithSpace = normalized.startsWith(' ');
                    const endsWithSpace = normalized.endsWith(' ');
                    const value = normalized.slice(startsWithSpace ? 1 : 0, endsWithSpace ? -1 : undefined);
                    if (!value) {
                        pendingSpace ||= startsWithSpace;
                        return;
                    }
                    if (started && (pendingSpace || startsWithSpace)) emit(' ');
                    emit(value);
                    started = true;
                    pendingSpace = endsWithSpace;
                    return;
                }
                // Comments are not part of the body text.
                if (node.kind !== 'element' || (node.namespaceUri === NS.office && node.local === 'annotation')) return;
                const local = node.namespaceUri === NS.text ? node.local : '';
                const verbatim = local === 's' ? ' '.repeat(limitedCount(attribute(node, 'c', NS.text), 1000))
                    : local === 'line-break' ? '\n' : local === 'tab' ? '\t' : '';
                if (verbatim) {
                    if (pendingSpace && started) emit(' ');
                    pendingSpace = false;
                    emit(verbatim);
                    started = true;
                    return;
                }
                if (local === 'note' || local === 'soft-page-break') return;
                let cursor = node.openTag?.end ?? node.range.end;
                for (const child of node.children) {
                    if (stopped || !parser.checkpoint()) break;
                    if (child.range.start > cursor) gap();
                    append(child);
                    cursor = child.range.end;
                }
                if (!node.selfClosing && node.closed !== false && cursor < node.range.end && /[ \t\r\n]/.test(content.text[cursor] ?? '')) gap();
            };
            append(root);
            return parts.join('');
        };
        const flatten = (content: readonly OpenDocumentBlock[]): string => content.map(block =>
            block.kind === 'list' ? block.items.map(flatten).join('\n')
                : block.kind === 'table' ? block.rows.map(row => row.map(cell => cell.text).join(' | ')).join('\n')
                    : block.text).join('\n');
        const readRows = (table: XmlNode) => {
            const rows: Extract<OpenDocumentBlock, { kind: 'table' }>['rows'] = [];
            const append = (node: XmlNode) => {
                for (const row of elements(node, undefined, NS.table)) {
                    if (['table-header-rows', 'table-row-group', 'table-rows'].includes(row.local)) {
                        append(row);
                        continue;
                    }
                    if (row.local !== 'table-row') continue;
                    if (!take()) break;
                    const cells: typeof rows[number] = [];
                    for (const cell of elements(row, 'table-cell', NS.table)) {
                        if (!take()) break;
                        // Cells hold the same block content as the body (lists, headings, nested tables…).
                        // Stage up to three extra bytes so a split UTF-8 code point cannot leave a hole in the prefix.
                        // Charge the flattened cell once, with its separators in display order.
                        const available = textBudget;
                        textBudget += 3;
                        const joined = flatten(blocks(cell));
                        textBudget = available;
                        const text = joined ? takeText(joined, Infinity) : takeText(attribute(cell, 'string-value', NS.office));
                        const colSpan = limitedCount(attribute(cell, 'number-columns-spanned', NS.table), 100);
                        const rowSpan = limitedCount(attribute(cell, 'number-rows-spanned', NS.table), 100);
                        const repeats = count(attribute(cell, 'number-columns-repeated', NS.table), Infinity);
                        for (let i = 0; i < repeats; i++) {
                            if (i && !take()) break;
                            cells.push({ text: i ? takeText(text) : text, colSpan, rowSpan });
                        }
                    }
                    const repeats = count(attribute(row, 'number-rows-repeated', NS.table), Infinity);
                    for (let i = 0; i < repeats; i++) {
                        const cost = cells.length + 1;
                        if (i && (remaining < cost || !parser.checkpoint())) {
                            parser.warn('truncated');
                            break;
                        }
                        if (i) remaining -= cost;
                        rows.push(i ? cells.map(cell => ({ ...cell, text: takeText(cell.text, Infinity) })) : cells);
                    }
                }
            };
            append(table);
            return rows;
        };
        const blocks = (root: XmlNode): OpenDocumentBlock[] => {
            const output: OpenDocumentBlock[] = [];
            for (const node of root.children) {
                if (node.kind !== 'element') continue;
                if (!take()) break;
                if (node.namespaceUri === NS.text && (node.local === 'p' || node.local === 'h')) {
                    if (node.children.some(child => child.namespaceUri === NS.draw)) parser.warn('unsupported');
                    output.push({ kind: node.local === 'h' ? 'heading' : 'paragraph', text: readText(node), level: count(attribute(node, 'outline-level', NS.text), 6) });
                } else if (node.namespaceUri === NS.text && node.local === 'list') {
                    const items: OpenDocumentBlock[][] = [];
                    // A leading text:list-header holds unnumbered entries (ODF 1.2 §5.3.3).
                    for (const item of elements(node, undefined, NS.text).filter(child => child.local === 'list-item' || child.local === 'list-header')) {
                        if (!take()) break;
                        items.push(blocks(item));
                    }
                    output.push({ kind: 'list', items });
                } else if (node.namespaceUri === NS.table && node.local === 'table') {
                    output.push({ kind: 'table', rows: readRows(node) });
                } else if (node.namespaceUri === NS.text && (node.local === 'section' || node.local === 'index-body' || node.local === 'index-title')) {
                    for (const block of blocks(node)) output.push(block);
                } else if (node.namespaceUri === NS.text && INDEXES.has(node.local)) {
                    // Tables of contents and other indexes keep their generated entries in text:index-body.
                    const body = elements(node, 'index-body', NS.text)[0];
                    if (body) for (const block of blocks(body)) output.push(block);
                } else if (node.namespaceUri === NS.draw && node.local !== 'enhanced-geometry') parser.warn('unsupported');
            }
            return output;
        };
        if (isText) return parser.success({ format: 'odt', blocks: blocks(data) });

        let styles: readonly XmlNode[] = [];
        const stylesEntry = archive.find('styles.xml');
        if (stylesEntry) {
            if (stylesEntry.encrypted || encrypted.has('styles.xml')) parser.warn('skipped');
            else {
                try {
                    styles = parser.xml(await read('styles.xml', 4 * 1024 * 1024)).nodes;
                } catch (error) {
                    if (!(error instanceof EpubReadError || error instanceof PreviewError) || error.code === 'aborted') throw error;
                    parser.warn(['too-large', 'budget-exceeded', 'limit-exceeded'].includes(error.code) ? 'truncated' : 'skipped');
                }
            }
        }
        const layouts = new Map<string, XmlNode>();
        const masters = new Map<string, string>();
        const graphicStyles = new Map<string, XmlNode>();
        for (const nodes of [styles, content.nodes]) {
            for (const node of nodes) {
                if (!parser.checkpoint()) break;
                if (node.kind !== 'element' || node.namespaceUri !== NS.style) continue;
                const name = attribute(node, 'name', NS.style);
                if (node.local === 'page-layout') {
                    const props = elements(node, 'page-layout-properties', NS.style)[0];
                    if (props) layouts.set(name, props);
                }
                if (node.local === 'master-page') masters.set(name, attribute(node, 'page-layout-name', NS.style));
                if (node.local === 'style') {
                    const props = elements(node, 'graphic-properties', NS.style)[0];
                    if (props) graphicStyles.set(name, props);
                }
            }
        }
        const pages: OpenDocumentPage[] = [];
        for (const page of elements(data, 'page', NS.draw)) {
            if (!take() || pages.length >= 200) {
                parser.warn('truncated');
                break;
            }
            const layout = layouts.get(masters.get(attribute(page, 'master-page-name', NS.draw)) ?? '');
            const width = layout ? pixels(attribute(layout, 'page-width', NS.fo)) : undefined;
            const height = layout ? pixels(attribute(layout, 'page-height', NS.fo)) : undefined;
            const shapes: OpenDocumentShape[] = [];
            const appendShapes = (root: XmlNode) => {
                for (const node of elements(root, undefined, NS.draw)) {
                    if (!take()) break;
                    if (node.local === 'g') {
                        if (attribute(node, 'transform', NS.draw)) parser.warn('unsupported');
                        appendShapes(node);
                        continue;
                    }
                    // Impress saves basic shapes and imported placeholders as custom shapes; draw their bounds.
                    let kind = node.local;
                    if (kind === 'custom-shape') {
                        const type = attribute(elements(node, 'enhanced-geometry', NS.draw)[0] ?? node, 'type', NS.draw);
                        kind = type === 'ellipse' ? 'ellipse' : 'rect';
                        // Other presets (callouts, arrows, stars…) keep their text but are drawn as their bounds.
                        if (type !== 'ellipse' && !RECT_PRESETS.has(type)) parser.warn('unsupported');
                    }
                    if (kind !== 'frame' && kind !== 'rect' && kind !== 'ellipse' && kind !== 'line') {
                        parser.warn('unsupported');
                        continue;
                    }
                    if (attribute(node, 'transform', NS.draw)) parser.warn('unsupported');
                    const textBox = elements(node, 'text-box', NS.draw)[0];
                    if (kind === 'frame' && !textBox && node.children.some(child => child.kind === 'element')) parser.warn('unsupported');
                    const props = graphicStyles.get(attribute(node, 'style-name', NS.draw));
                    const length = (name: string) => pixels(attribute(node, name, NS.svg)) ?? 0;
                    const x = length(kind === 'line' ? 'x1' : 'x'), y = length(kind === 'line' ? 'y1' : 'y');
                    shapes.push({
                        kind, x, y,
                        width: kind === 'line' ? length('x2') - x : length('width'),
                        height: kind === 'line' ? length('y2') - y : length('height'),
                        // `draw:fill`/`draw:stroke` modes win over a colour LibreOffice still writes alongside them.
                        fill: !props ? '' : attribute(props, 'fill', NS.draw) === 'none' ? 'none'
                            : ['', 'solid'].includes(attribute(props, 'fill', NS.draw)) ? hex(attribute(props, 'fill-color', NS.draw)) : '',
                        stroke: !props ? '' : attribute(props, 'stroke', NS.draw) === 'none' ? 'none' : hex(attribute(props, 'stroke-color', NS.svg)),
                        blocks: blocks(textBox ?? node)
                    });
                }
            };
            appendShapes(page);
            pages.push({ name: attribute(page, 'name', NS.draw), width: width && width > 0 ? width : 960, height: height && height > 0 ? height : 540, shapes });
        }
        return parser.success({ format: 'odp', pages });
    } catch (error) {
        return parser.failure(error);
    }
}
