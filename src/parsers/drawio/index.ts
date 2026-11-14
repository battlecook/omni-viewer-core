import { EpubReadError, hasPlatformInflate, platformInflate } from '../epub/zip.js';
import { attribute, elements, invalidPreview, PREVIEW_XML_BYTES, PreviewError, previewParser, xmlText, type CompressedPreviewOptions } from '../file-preview.js';
import { decodeUtf8, utf8ByteLength, type ParseOutcome } from '../types.js';
import type { XmlNode } from '../xml/index.js';

export interface DiagramPoint { x: number; y: number }
export interface DrawioCell {
    id: string;
    parent: string;
    label: string;
    htmlLabel: boolean;
    /** draw.io `nl2Br` (default on): newlines in an HTML label are line breaks. */
    htmlNewlines: boolean;
    kind: 'layer' | 'vertex' | 'edge';
    x: number;
    y: number;
    width: number;
    height: number;
    shape: string;
    direction?: string | undefined;
    fill: string;
    stroke: string;
    fontColor: string;
    dashed: boolean;
    rounded: boolean;
    arrow: boolean;
    visible: boolean;
    /** Collapsed containers hide their children. */
    collapsed: boolean;
    relative: boolean;
    source: string;
    target: string;
    sourcePoint: DiagramPoint | undefined;
    targetPoint: DiagramPoint | undefined;
    /** Absolute label offset (`<mxPoint as="offset">`). */
    offset: DiagramPoint | undefined;
    points: DiagramPoint[];
}
export interface DrawioPage { name: string; cells: DrawioCell[] }
export interface DrawioDocument { pages: DrawioPage[] }

function measure(node: XmlNode | undefined, name: string, fallback = 0): number {
    const raw = node ? attribute(node, name) : '';
    const value = raw ? Number(raw) : fallback;
    return Number.isFinite(value) && Math.abs(value) <= 10_000_000 ? value : fallback;
}
function point(node: XmlNode): DiagramPoint {
    return { x: measure(node, 'x'), y: measure(node, 'y') };
}
// draw.io style keywords that are not CSS colours; SVG would paint them black or not at all.
const STYLE_KEYWORDS = new Set(['default', 'inherit', 'swimlane', 'strokecolor', 'fillcolor', 'indicated', 'auto']);
function color(value: string | undefined): string {
    return value && /^(?:none|#[0-9a-f]{3,8}|[a-z]{1,24})$/i.test(value) && !STYLE_KEYWORDS.has(value.toLowerCase()) ? value : '';
}
function readCell(node: XmlNode, wrapper: XmlNode): DrawioCell | undefined {
    const id = attribute(node, 'id') || attribute(wrapper, 'id');
    if (!id) return undefined;
    const parent = attribute(node, 'parent');
    const kind = attribute(node, 'vertex') === '1' ? 'vertex' : attribute(node, 'edge') === '1' ? 'edge' : 'layer';
    if (kind === 'layer' && !parent) return undefined;
    const geometry = elements(node, 'mxGeometry')[0];
    const points = geometry ? elements(geometry, 'mxPoint') : [];
    const endpoint = (role: string) => {
        const entry = points.find(item => attribute(item, 'as') === role);
        return entry ? point(entry) : undefined;
    };
    const style = new Map<string, string>();
    for (const declaration of attribute(node, 'style').split(';')) {
        const equals = declaration.indexOf('=');
        if (equals >= 0) style.set(declaration.slice(0, equals), declaration.slice(equals + 1));
        else if (declaration) style.set('shape', declaration);
    }
    const waypoints = geometry && elements(geometry, 'Array').find(item => attribute(item, 'as') === 'points');
    return {
        id, parent, kind,
        label: attribute(node, 'value') || attribute(wrapper, 'label') || attribute(wrapper, 'value'),
        htmlLabel: style.get('html') === '1', htmlNewlines: style.get('nl2Br') !== '0',
        x: measure(geometry, 'x'), y: measure(geometry, 'y'),
        width: Math.max(0, measure(geometry, 'width', 80)), height: Math.max(0, measure(geometry, 'height', 40)),
        shape: style.get('shape') ?? 'rectangle', fill: color(style.get('fillColor')),
        direction: style.get('direction'),
        stroke: color(style.get('strokeColor')), fontColor: color(style.get('fontColor')),
        rounded: style.get('rounded') === '1', dashed: style.get('dashed') === '1', arrow: style.get('endArrow') !== 'none',
        visible: attribute(node, 'visible') !== '0', collapsed: attribute(node, 'collapsed') === '1', relative: !!geometry && attribute(geometry, 'relative') === '1',
        source: attribute(node, 'source'), target: attribute(node, 'target'),
        sourcePoint: endpoint('sourcePoint'), targetPoint: endpoint('targetPoint'), offset: endpoint('offset'),
        points: waypoints ? elements(waypoints, 'mxPoint').map(point) : []
    };
}

async function expandPage(value: string, limit: number, options: CompressedPreviewOptions): Promise<Uint8Array> {
    const inflate = options.inflate ?? (hasPlatformInflate() ? platformInflate : undefined);
    if (!inflate) throw new EpubReadError('inflate-unavailable', '');
    let compressed: Uint8Array;
    try {
        const binary = atob(value.replace(/\s/g, ''));
        compressed = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) compressed[i] = binary.charCodeAt(i);
    } catch {
        return invalidPreview();
    }
    let inflated: Uint8Array;
    try {
        inflated = await inflate(compressed, limit, options.signal);
    } catch (error) {
        if (options.signal?.aborted) throw new EpubReadError('aborted', '');
        if (error instanceof EpubReadError) throw error;
        throw new EpubReadError('corrupted', '');
    }
    if (inflated.length > limit) throw new EpubReadError('too-large', '');
    return inflated;
}

export async function parseDrawio(input: Uint8Array, options: CompressedPreviewOptions = {}): Promise<ParseOutcome<DrawioDocument>> {
    const parser = previewParser(input, options);
    try {
        parser.check();
        const root = parser.xml(input).root!;
        if (!['mxfile', 'mxGraphModel'].includes(root.local) || root.namespaceUri) return invalidPreview();
        const entries = root.local === 'mxfile' ? elements(root, 'diagram') : [root];
        const limit = options.limits?.maxEntries ?? 30_000;
        let remaining = limit;
        let remainingBytes = options.limits?.maxDecompressedBytes ?? PREVIEW_XML_BYTES;
        const pages: DrawioPage[] = [];
        let missingInflater: EpubReadError | undefined;
        if (entries.length > 100) parser.warn('truncated');
        for (const entry of entries.slice(0, 100)) {
            if (!parser.checkpoint()) break;
            let model = entry === root && root.local === 'mxGraphModel' ? root : elements(entry, 'mxGraphModel')[0];
            const payload = model ? '' : xmlText(entry).trim();
            if (!model && payload) {
                try {
                    let content = payload;
                    if (payload.startsWith('<')) {
                        remainingBytes -= utf8ByteLength(payload);
                        if (remainingBytes < 0) throw new EpubReadError('too-large', '');
                    } else {
                        if (remainingBytes <= 0) throw new EpubReadError('too-large', '');
                        const inflated = await expandPage(payload, remainingBytes, options);
                        remainingBytes -= inflated.length;
                        try {
                            content = decodeURIComponent(decodeUtf8(inflated));
                        } catch {
                            parser.warn('skipped');
                            continue;
                        }
                    }
                    model = parser.xml(content).root ?? undefined;
                } catch (error) {
                    const limitReached = (error instanceof EpubReadError && error.code === 'too-large') ||
                        (error instanceof PreviewError && error.code === 'limit-exceeded');
                    if (limitReached) {
                        if (!pages.length) throw error;
                        parser.warn('truncated');
                        break;
                    }
                    if (error instanceof EpubReadError && error.code === 'inflate-unavailable') {
                        missingInflater = error;
                        parser.warn('unsupported');
                        continue;
                    }
                    if (error instanceof PreviewError && error.code === 'invalid-format') {
                        parser.warn('skipped');
                        continue;
                    }
                    if (!(error instanceof EpubReadError) || error.code !== 'corrupted') throw error;
                    remainingBytes = Math.max(0, remainingBytes - (error.outputBytes ?? remainingBytes));
                    parser.warn('skipped');
                    continue;
                }
            }
            const graph = model?.local === 'mxGraphModel' ? elements(model, 'root')[0] : undefined;
            if (!graph) {
                parser.warn('skipped');
                continue;
            }
            const cells: DrawioCell[] = [];
            const ids = new Set<string>();
            for (const wrapper of elements(graph)) {
                if (!parser.checkpoint()) break;
                if (remaining-- <= 0) {
                    parser.warn('truncated');
                    break;
                }
                const node = wrapper.local === 'mxCell' ? wrapper : elements(wrapper, 'mxCell')[0];
                if (!node) continue;
                const cell = readCell(node, wrapper);
                if (!cell || ids.has(cell.id)) continue;
                if (cell.kind === 'vertex' && !['rectangle', 'ellipse', 'rhombus', 'triangle', 'text', 'edgeLabel', 'group', 'swimlane'].includes(cell.shape)) parser.warn('unsupported');
                ids.add(cell.id);
                cells.push(cell);
            }
            pages.push({ name: attribute(entry, 'name'), cells });
            if (remaining < 0) break;
        }
        if (!pages.length) {
            parser.requireTime();
            if (missingInflater) throw missingInflater;
            return invalidPreview();
        }
        return parser.success({ pages });
    } catch (error) {
        return parser.failure(error);
    }
}
