import type { HostContext } from '../../host/index.js';
import type { CompressedPreviewOptions } from '../../parsers/file-preview.js';
import { parseDrawio, type DiagramPoint, type DrawioCell, type DrawioPage } from '../../parsers/drawio/index.js';
import { DRAWIO_VIEWER_DESCRIPTOR } from '../../registry/file-previews.js';
import { mountFilePreview, observePreviewWidth, previewPager, svgElement, type PreviewUi, type FilePreviewOptions } from '../file-preview.js';
import type { ViewerInput } from '../types.js';

export * from '../../parsers/drawio/index.js';
export const DRAWIO_VIEWER_META = { ...DRAWIO_VIEWER_DESCRIPTOR, inputOwnership: 'borrows' as const };

interface Placement extends DiagramPoint { visible: boolean; layer: string }
const MAX_DRAW_CELLS = 4000;
const MAX_LAYER_CONTROLS = 100;
const TRIANGLE_TIPS = new Map<string, DiagramPoint>([
    ['north', { x: 0, y: -1 }],
    ['south', { x: 0, y: 1 }],
    ['west', { x: -1, y: 0 }]
]);
const EAST_TIP: DiagramPoint = { x: 1, y: 0 };
const triangleTip = (cell: DrawioCell) => TRIANGLE_TIPS.get(cell.direction ?? '') ?? EAST_TIP;

const MAX_LABEL_LINES = 20;
const MAX_LABEL_HTML = 64 * 1024;
const MAX_LABEL_TEXT = 4096;
/** HTML label markup parsed per page; nested markup costs seconds per MiB to parse. */
const MAX_PAGE_LABEL_HTML = 256 * 1024;
/**
 * HTML parsing re-opens every active formatting element (`<b>`, `<font>`…) at each later block, so the parse cost
 * grows with formatting tags² × tags rather than bytes. Real draw.io labels peak near 2M (98 formatting of 210 tags).
 */
const MAX_LABEL_PARSE_COST = 8_000_000;
const MAX_PAGE_PARSE_COST = 32_000_000;
const FORMATTING_TAG = /<(?:a|b|big|code|em|font|i|nobr|s|small|strike|strong|tt|u)[\s>/]/gi;
const BLOCK_TAGS = new Set(['ADDRESS', 'BLOCKQUOTE', 'DIV', 'DL', 'DT', 'DD', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HEADER', 'HR', 'LI', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL']);
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD']);

/**
 * Lines of an HTML label, approximating the browser's innerText as draw.io renders it: blocks start and end lines
 * (an empty block adds nothing, `<br>` always does), whitespace collapses, and table cells are joined by ` | `.
 * The markup is parsed into an inert DOMParser document and only text is read from it, so nothing is rendered.
 */
function htmlLabelLines(html: string): { lines: string[]; truncated: boolean } {
    const body = new DOMParser().parseFromString(html.slice(0, MAX_LABEL_HTML), 'text/html').body;
    const lines: string[] = [];
    let line = '', length = 0, breaks = 0, truncated = html.length > MAX_LABEL_HTML;
    const full = () => lines.length > MAX_LABEL_LINES || length >= MAX_LABEL_TEXT;
    const hard = () => { lines.push(line.trimEnd()); line = ''; };
    // A `<br>` only shows when content follows it on the line; at a block edge one `<br>` is absorbed,
    // except in an otherwise empty block, where each one is a blank line (`<div><br></div>`).
    const soft = () => {
        const empty = !line.trim();
        for (let i = empty ? 0 : 1; i < breaks; i++) hard();
        breaks = 0;
        if (!line.trim()) line = '';
        else hard();
    };
    // Iterative walk: hostile labels can nest deeper than the call stack.
    const stack: { node: Node; leaving: boolean }[] = [...body.childNodes].reverse().map(node => ({ node, leaving: false }));
    while (stack.length && !full()) {
        const { node, leaving } = stack.pop()!;
        if (node.nodeType === 3) {
            // HTML white space only; U+00A0 from `&nbsp;` is kept.
            let text = (node.nodeValue ?? '').replace(/[ \t\n\r\f]+/g, ' ');
            if (text.trim()) {
                for (; breaks; breaks--) hard();
            }
            if (!line || line.endsWith(' ')) text = text.replace(/^ /, '');
            line += text;
            length += text.length;
            continue;
        }
        if (node.nodeType !== 1) continue;
        const tag = (node as Element).tagName;
        if (leaving) {
            if (BLOCK_TAGS.has(tag)) soft();
            continue;
        }
        if (SKIPPED_TAGS.has(tag)) continue;
        if (tag === 'BR') {
            breaks++;
            continue;
        }
        if (BLOCK_TAGS.has(tag)) soft();
        if (tag === 'TD' || tag === 'TH') {
            breaks = 0;
            if ((node as Element).previousElementSibling) line = `${line.trimEnd()} | `;
        }
        stack.push({ node, leaving: true });
        for (let child = node.lastChild; child; child = child.previousSibling) stack.push({ node: child, leaving: false });
    }
    if (line.trim()) hard();
    if (stack.length || length > MAX_LABEL_TEXT || lines.length > MAX_LABEL_LINES) truncated = true;
    const kept = lines.slice(0, MAX_LABEL_LINES).map(text => text.slice(0, MAX_LABEL_TEXT));
    while (kept.length && !kept[0]) kept.shift();
    return { lines: kept, truncated };
}

interface EdgePath {
    points: DiagramPoint[];
    cumulative: Float64Array;
    terminalLayers: string[];
}

/** Point on an edge path for relative label geometry, following mxGraphView.getPoint. */
function alongPath({ points, cumulative }: EdgePath, cell: DrawioCell): DiagramPoint {
    const total = cumulative[cumulative.length - 1]!;
    const distance = Math.round(((cell.relative ? cell.x / 2 : 0) + .5) * total);
    let index = 1, last = points.length - 1;
    while (index < last) {
        const middle = Math.floor((index + last) / 2);
        if (distance >= Math.round(cumulative[middle]!)) index = middle + 1;
        else last = middle;
    }
    const length = cumulative[index - 1]!;
    const p0 = points[index - 1]!, pe = points[index]!;
    const segment = Math.hypot(pe.x - p0.x, pe.y - p0.y);
    const factor = segment ? (distance - length) / segment : 0;
    const dx = pe.x - p0.x, dy = pe.y - p0.y;
    const nx = segment ? dy / segment : 0, ny = segment ? dx / segment : 0;
    const gy = cell.relative ? cell.y : 0;
    const offset = cell.offset ?? { x: 0, y: 0 };
    return { x: p0.x + dx * factor + nx * gy + offset.x, y: p0.y + dy * factor - (ny * gy - offset.y) };
}

/** Renders one page; returns whether label text was cut by the page's HTML budget. */
function renderPage(ui: PreviewUi, page: DrawioPage, svg: SVGSVGElement, layers: HTMLElement, setSize: (width: number, height: number) => void): boolean {
    svg.replaceChildren();
    layers.replaceChildren();
    const { doc } = ui;
    const cells = new Map(page.cells.map(cell => [cell.id, cell]));
    const placement = new Map<string, Placement>();
    const locate = (cell: DrawioCell, depth = 0): Placement => {
        const saved = placement.get(cell.id);
        if (saved) return saved;
        if (depth >= 64) return { x: 0, y: 0, visible: false, layer: '' };
        const parent = cells.get(cell.parent);
        const origin = parent ? locate(parent, depth + 1) : { x: 0, y: 0, visible: true, layer: '' };
        const result = {
            // mxGraphView.updateVertexState: relative children of a vertex also shift by their offset.
            x: origin.x + (cell.relative && parent?.kind === 'vertex' ? cell.x * parent.width + (cell.offset?.x ?? 0) : cell.x),
            y: origin.y + (cell.relative && parent?.kind === 'vertex' ? cell.y * parent.height + (cell.offset?.y ?? 0) : cell.y),
            visible: origin.visible && (cell.kind === 'layer' || cell.visible) && !(parent?.kind === 'vertex' && parent.collapsed),
            layer: cell.kind === 'layer' ? cell.id : origin.layer
        };
        placement.set(cell.id, result);
        return result;
    };
    const groups = new Map<string, SVGGElement>();
    const edgeGroups = new Map<SVGGElement, SVGGElement[]>();
    const group = (id: string) => {
        let node = groups.get(id);
        if (!node) {
            node = svgElement(doc, 'g');
            if (cells.get(id)?.visible === false) node.style.display = 'none';
            groups.set(id, node);
            svg.append(node);
        }
        return node;
    };
    const edgeGroup = (layer: string, path: EdgePath) => {
        const parent = group(layer);
        if (path.terminalLayers.every(id => id === layer)) return parent;
        const node = svgElement(doc, 'g');
        edgeGroups.set(node, [parent, ...path.terminalLayers.map(group)]);
        parent.append(node);
        return node;
    };
    type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
    const bounds = new Map<SVGGElement, Bounds>();
    const extend = (target: SVGGElement, x: number, y: number) => {
        const box = bounds.get(target);
        if (!box) {
            bounds.set(target, { minX: x, minY: y, maxX: x, maxY: y });
            return;
        }
        box.minX = Math.min(box.minX, x);
        box.minY = Math.min(box.minY, y);
        box.maxX = Math.max(box.maxX, x);
        box.maxY = Math.max(box.maxY, y);
    };
    const fit = () => {
        for (const [edge, layers] of edgeGroups) {
            edge.style.display = layers.some(layer => layer.style.display === 'none') ? 'none' : '';
        }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [layer, box] of bounds) {
            if (layer.style.display === 'none') continue;
            minX = Math.min(minX, box.minX);
            minY = Math.min(minY, box.minY);
            maxX = Math.max(maxX, box.maxX);
            maxY = Math.max(maxY, box.maxY);
        }
        const width = Number.isFinite(minX) ? Math.max(maxX - minX, 1) + 32 : 400;
        const height = Number.isFinite(minY) ? Math.max(maxY - minY, 1) + 32 : 240;
        svg.setAttribute('viewBox', `${Number.isFinite(minX) ? minX - 16 : 0} ${Number.isFinite(minY) ? minY - 16 : 0} ${width} ${height}`);
        setSize(width, height);
    };
    group('');
    for (const cell of page.cells.filter(cell => cell.kind === 'layer').slice(0, MAX_LAYER_CONTROLS)) {
        const layer = group(cell.id);
        const toggle = ui.el('input');
        toggle.type = 'checkbox';
        toggle.checked = cell.visible;
        const label = ui.el('label', cell.label.slice(0, 200) || ui.t('drawio.layer', { index: layers.childElementCount + 1 }));
        toggle.addEventListener('change', () => {
            layer.style.display = toggle.checked ? '' : 'none';
            fit();
        });
        label.prepend(toggle);
        layers.append(label);
    }
    let htmlBudget = MAX_PAGE_LABEL_HTML, parseBudget = MAX_PAGE_PARSE_COST, budgetSpent = false;
    const htmlLines = (cell: DrawioCell) => {
        // mxText turns newlines into `<br/>` unless the style sets nl2Br=0.
        const html = cell.htmlNewlines ? cell.label.replace(/\r?\n/g, '<br>') : cell.label;
        const parsed = html.slice(0, MAX_LABEL_HTML);
        const formatting = parsed.match(FORMATTING_TAG)?.length ?? 0;
        const cost = formatting * formatting * (parsed.match(/<[a-z]/gi)?.length ?? 0);
        if (parsed.length <= htmlBudget && cost <= MAX_LABEL_PARSE_COST && cost <= parseBudget) {
            htmlBudget -= parsed.length;
            parseBudget -= cost;
            return htmlLabelLines(html);
        }
        // Over budget: one stripped line, flagged as cut.
        budgetSpent = true;
        return { lines: [html.slice(0, MAX_LABEL_TEXT).replace(/<[^<>]*>/g, ' ').replace(/[ \t\n\r\f]+/g, ' ').trim()], truncated: true };
    };
    const label = (target: SVGGElement, cell: DrawioCell, x: number, y: number, halo = false) => {
        if (!cell.label) return;
        const plain = cell.label.slice(0, MAX_LABEL_TEXT).split(/\r?\n/);
        const { lines, truncated } = cell.htmlLabel ? htmlLines(cell)
            : { lines: plain.slice(0, MAX_LABEL_LINES), truncated: plain.length > MAX_LABEL_LINES || cell.label.length > MAX_LABEL_TEXT };
        while (lines.length && !lines.at(-1)) lines.pop();
        if (!lines.length) return;
        if (truncated) lines[lines.length - 1] += ' …';
        const halfHeight = (lines.length - 1) * 7 + 12;
        const halfWidth = Math.max(...lines.map(line => line.length)) * 6;
        extend(target, x - halfWidth, y - halfHeight);
        extend(target, x + halfWidth, y + halfHeight);
        const text = svgElement(doc, 'text', {
            x, y, 'text-anchor': 'middle', 'font-size': 12, fill: cell.fontColor || '#202124',
            // A halo in the artboard color keeps labels drawn over edges legible without measuring text.
            ...(halo ? { stroke: '#f8fafc', 'stroke-width': 3, 'paint-order': 'stroke' } : {})
        });
        lines.forEach((line, index) => {
            const span = svgElement(doc, 'tspan', { x, dy: index ? 14 : 4 - (lines.length - 1) * 7 });
            span.textContent = line;
            text.append(span);
        });
        target.append(text);
    };
    const center = (cell: DrawioCell) => {
        const point = locate(cell);
        return { x: point.x + cell.width / 2, y: point.y + cell.height / 2 };
    };
    const boundary = (cell: DrawioCell, toward: DiagramPoint): DiagramPoint => {
        const point = center(cell);
        const dx = toward.x - point.x, dy = toward.y - point.y;
        if (!dx && !dy) return point;
        if (!cell.width || !cell.height) {
            const ratio = Math.min(dx ? cell.width / (2 * Math.abs(dx)) : Infinity, dy ? cell.height / (2 * Math.abs(dy)) : Infinity);
            return { x: point.x + dx * ratio, y: point.y + dy * ratio };
        }
        const x = 2 * dx / cell.width, y = 2 * dy / cell.height;
        let scale = Math.max(Math.abs(x), Math.abs(y));
        if (cell.shape === 'ellipse') scale = Math.hypot(x, y);
        if (cell.shape === 'rhombus') scale = Math.abs(x) + Math.abs(y);
        if (cell.shape === 'triangle') {
            const tip = triangleTip(cell);
            const forward = x * tip.x + y * tip.y;
            const across = x * tip.y - y * tip.x;
            // In tip-aligned coordinates the three sides are at -forward = 1 and forward ± 2*across = 1.
            scale = Math.max(-forward, forward + 2 * Math.abs(across));
        }
        const ratio = scale > 0 && Number.isFinite(scale) ? 1 / scale : 0;
        return { x: point.x + dx * ratio, y: point.y + dy * ratio };
    };
    // An edge to a cell inside a collapsed container attaches to the nearest visible ancestor.
    const visibleTerminal = (cell: DrawioCell | undefined) => {
        for (let depth = 0; cell && !locate(cell).visible && depth < 64; depth++) {
            const parent = cells.get(cell.parent);
            if (parent?.kind !== 'vertex') return undefined;
            cell = parent;
        }
        return cell && locate(cell).visible ? cell : undefined;
    };
    const paths = new Map<string, EdgePath | undefined>();
    const edgePath = (cell: DrawioCell) => {
        if (paths.has(cell.id)) return paths.get(cell.id);
        const source = visibleTerminal(cells.get(cell.source)), destination = visibleTerminal(cells.get(cell.target));
        // Both ends folded into the same collapsed container: mxGraph draws nothing.
        if (source && source === destination && cell.source !== cell.target) {
            paths.set(cell.id, undefined);
            return undefined;
        }
        const parent = cells.get(cell.parent);
        const origin = parent ? locate(parent) : { x: 0, y: 0 };
        const absolute = (point: DiagramPoint) => ({ x: point.x + origin.x, y: point.y + origin.y });
        const path = cell.points.map(absolute);
        const start = source ? center(source) : cell.sourcePoint && absolute(cell.sourcePoint);
        const end = destination ? center(destination) : cell.targetPoint && absolute(cell.targetPoint);
        if (!start || !end) {
            paths.set(cell.id, undefined);
            return undefined;
        }
        if (source && source === destination && !path.length) {
            const right = start.x + source.width / 2 + 24;
            const top = start.y - source.height / 2 - 24;
            path.push({ x: right, y: start.y }, { x: right, y: top }, { x: start.x, y: top });
        }
        path.unshift(source ? boundary(source, path[0] ?? end) : start);
        path.push(destination ? boundary(destination, path.at(-1) ?? start) : end);
        const cumulative = new Float64Array(path.length);
        for (let i = 1; i < path.length; i++) {
            const previous = path[i - 1]!, current = path[i]!;
            cumulative[i] = cumulative[i - 1]! + Math.hypot(current.x - previous.x, current.y - previous.y);
        }
        const terminalLayers: string[] = [];
        if (source) terminalLayers.push(locate(source).layer);
        if (destination) terminalLayers.push(locate(destination).layer);
        const indexed = { points: path, cumulative, terminalLayers };
        paths.set(cell.id, indexed);
        return indexed;
    };
    for (const cell of page.cells.filter(cell => cell.kind !== 'layer').slice(0, MAX_DRAW_CELLS)) {
        const { x, y, visible, layer } = locate(cell);
        if (!visible) continue;
        const bare = cell.shape === 'text' || cell.shape === 'edgeLabel' || cell.shape === 'group';
        const fill = cell.fill || (bare ? 'none' : '#fff');
        const stroke = cell.stroke || (bare ? 'none' : '#425466');
        if (cell.kind === 'edge') {
            const indexed = edgePath(cell);
            if (!indexed) continue;
            const target = edgeGroup(layer, indexed);
            const path = indexed.points;
            path.forEach(point => extend(target, point.x, point.y));
            const line = svgElement(doc, 'polyline', { points: path.map(point => `${point.x},${point.y}`).join(' '), fill: 'none', stroke });
            if (cell.dashed) line.setAttribute('stroke-dasharray', '5 4');
            target.append(line);
            const tip = path.at(-1)!, before = path.at(-2)!;
            if (cell.arrow && stroke !== 'none' && (tip.x !== before.x || tip.y !== before.y)) {
                const angle = Math.atan2(tip.y - before.y, tip.x - before.x);
                const arrow = svgElement(doc, 'path', { d: 'M 0 0 L -9 -4 L -9 4 Z', fill: stroke, transform: `translate(${tip.x} ${tip.y}) rotate(${angle * 180 / Math.PI})` });
                target.append(arrow);
            }
            const point = alongPath(indexed, cell);
            label(target, cell, point.x, point.y, true);
            continue;
        }
        const owner = cells.get(cell.parent);
        if (owner?.kind === 'edge') {
            // Labels dragged off an edge are child vertices placed relative to the edge path.
            const path = edgePath(owner);
            if (!path) continue;
            const target = edgeGroup(layer, path);
            const point = alongPath(path, cell);
            extend(target, point.x, point.y);
            label(target, cell, point.x, point.y, true);
            continue;
        }
        const target = group(layer);
        const { width, height } = cell;
        extend(target, x, y); extend(target, x + width, y + height);
        let shape: SVGElement;
        if (cell.shape === 'ellipse') {
            shape = svgElement(doc, 'ellipse', { cx: x + width / 2, cy: y + height / 2, rx: width / 2, ry: height / 2, fill, stroke });
        } else if (cell.shape === 'rhombus') {
            const points = `${x + width / 2},${y} ${x + width},${y + height / 2} ${x + width / 2},${y + height} ${x},${y + height / 2}`;
            shape = svgElement(doc, 'polygon', { points, fill, stroke });
        } else if (cell.shape === 'triangle') {
            const tip = triangleTip(cell);
            const corners = [tip, { x: -tip.x - tip.y, y: -tip.y + tip.x }, { x: -tip.x + tip.y, y: -tip.y - tip.x }];
            const points = corners.map(corner => `${x + (corner.x + 1) * width / 2},${y + (corner.y + 1) * height / 2}`).join(' ');
            shape = svgElement(doc, 'polygon', { points, fill, stroke });
        } else {
            shape = svgElement(doc, 'rect', { x, y, width, height, fill, stroke, rx: cell.rounded ? 8 : 0 });
        }
        if (cell.dashed) shape.setAttribute('stroke-dasharray', '5 4');
        target.append(shape);
        label(target, cell, x + width / 2, y + height / 2);
    }
    fit();
    return budgetSpent;
}

export async function mountDrawioViewer(input: ViewerInput, container: HTMLElement, ctx: HostContext, options: FilePreviewOptions & CompressedPreviewOptions = {}) {
    const { result } = await parseDrawio(input.data, options);
    return mountFilePreview(input, container, ctx, options, 'drawio', result, (ui, model) => {
        const { t } = ui;
        const tools = ui.el('div', undefined, 'preview-toolbar');
        const layerTools = ui.el('div', undefined, 'preview-toolbar');
        const title = ui.el('h3');
        const warning = ui.el('p', undefined, 'preview-warning');
        const scroll = ui.el('div', undefined, 'preview-scroll');
        const svg = svgElement(ui.doc, 'svg', { role: 'img', class: 'preview-artboard' });
        svg.style.background = '#f8fafc';
        scroll.tabIndex = 0;
        scroll.append(svg);
        let width = 400, height = 240, zoom = 1;
        const resize = (value: number) => {
            zoom = Math.min(8, Math.max(.25, value));
            const scale = Math.min(1, (scroll.clientWidth || 800) / width, 560 / height) * zoom;
            svg.setAttribute('width', String(Math.ceil(width * scale)));
            svg.setAttribute('height', String(Math.ceil(height * scale)));
        };
        const pager = previewPager(ui, tools, index => {
            const page = model.pages[index];
            if (!page) return;
            title.textContent = page.name || t('drawio.page', { index: index + 1 });
            svg.setAttribute('aria-label', title.textContent);
            const layerCount = page.cells.filter(cell => cell.kind === 'layer').length;
            const labelsCut = renderPage(ui, page, svg, layerTools, (w, h) => { width = w; height = h; resize(1); });
            warning.textContent = labelsCut || page.cells.length - layerCount > MAX_DRAW_CELLS || layerCount > MAX_LAYER_CONTROLS
                ? t('preview.truncated') : '';
            scroll.scrollTop = scroll.scrollLeft = 0;
        });
        tools.append(ui.button(t('preview.zoomIn'), () => resize(zoom * 1.4)), ui.button(t('preview.zoomOut'), () => resize(zoom / 1.4)), ui.button(t('preview.fit'), () => resize(1)));
        ui.body.append(tools, title, layerTools, warning, scroll);
        pager.reset(model.pages.length);
        return observePreviewWidth(scroll, () => resize(zoom));
    });
}
