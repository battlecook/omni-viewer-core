import type { HostContext } from '../../host/index.js';
import { parseDbf, type DbfTable, type DbfValue } from '../../parsers/shapefile/dbf.js';
import {
    parseShapefile,
    type ShapefileModel,
    type ShpGeometry,
    type ShpPosition
} from '../../parsers/shapefile/index.js';
import {
    isGeographicWkt,
    projectionName,
    reprojectModel,
    type CoordinateConverter
} from '../../parsers/shapefile/reproject.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { shapefileViewerCss } from './styles.js';

export { parseShapefile } from '../../parsers/shapefile/index.js';
export { parseDbf, type DbfField, type DbfTable, type DbfValue } from '../../parsers/shapefile/dbf.js';
export { isGeographicWkt, projectionName, reprojectModel, type CoordinateConverter } from '../../parsers/shapefile/reproject.js';
export { shapefileViewerCss } from './styles.js';

export type ShapefileViewerContext = HostContext;

/** Sidecar files that accompany a .shp. The core receives one file as
 *  ViewerInput; the adapter reads the neighbours and passes them here. */
export interface ShapefileSidecars {
    /** .dbf attribute table bytes. */
    dbf?: Uint8Array;
    /** .prj WKT text. */
    prj?: string;
}

export interface ShapefileMountOptions extends MountOptions {
    maxBytes?: number;
    maxFeatures?: number;
    maxVertices?: number;
    sidecars?: ShapefileSidecars;
    /** proj4-style converter factory (projected WKT → WGS84 lon/lat).
     *  Optional peer; see viewers/shapefile/self-loading.ts. */
    createReprojector?(wkt: string): CoordinateConverter | null;
}

export const SHAPEFILE_VIEWER_META = {
    id: 'shapefile',
    displayNameKey: 'shapefile.title',
    extensions: ['shp'],
    priority: 20,
    requiredServices: [] as const,
    optionalServices: [] as const,
    inputOwnership: 'borrows' as const
};

const ZOOM_FACTOR = 1.5;

interface ViewBox { x: number; y: number; w: number; h: number }

export async function mountShapefileViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: ShapefileViewerContext,
    options: ShapefileMountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const t = (key: string, args?: Record<string, string | number>): string => ctx.i18n.t(key, args);
    let model = parseShapefile(input.data, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
        ...(options.maxFeatures ? { maxFeatures: options.maxFeatures } : {}),
        ...(options.maxVertices ? { maxVertices: options.maxVertices } : {})
    });
    const warnings = [...model.warnings];

    // Optional .prj reprojection to WGS84 (only for projected systems).
    let projectionLabel: string | null = null;
    const wkt = options.sidecars?.prj?.trim();
    if (wkt) {
        projectionLabel = projectionName(wkt) ?? wkt.slice(0, 40);
        if (!isGeographicWkt(wkt) && options.createReprojector) {
            try {
                const convert = options.createReprojector(wkt);
                if (convert) {
                    model = reprojectModel(model, convert);
                    projectionLabel = `${projectionLabel} → WGS84`;
                }
            } catch {
                warnings.push(t('shapefile.reprojectFailed'));
            }
        }
    }

    // Optional .dbf attribute table; records pair with features by ordinal.
    let attributes: DbfTable | null = null;
    if (options.sidecars?.dbf) {
        try {
            attributes = parseDbf(options.sidecars.dbf, {
                ...(options.signal ? { signal: options.signal } : {}),
                ...(options.maxFeatures ? { maxRecords: options.maxFeatures } : {})
            });
            warnings.push(...attributes.warnings);
        } catch (error) {
            warnings.push(`${t('shapefile.dbfFailed')} ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const root: HTMLElement | ShadowRoot =
        options.styleIsolation !== 'scoped' && container.attachShadow
            ? (container.shadowRoot ?? container.attachShadow({ mode: 'open' }))
            : container;
    if (root === container) container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--shapefile');
    else {
        const style = document.createElement('style');
        style.textContent = shapefileViewerCss;
        root.append(style);
    }

    const disposers: Array<() => void> = [];
    const listen = (target: EventTarget, type: string, handler: EventListener, opts?: AddEventListenerOptions): void => {
        target.addEventListener(type, handler, opts);
        disposers.push(() => target.removeEventListener(type, handler, opts));
    };

    const shell = element('section', `${VIEWER_ROOT_CLASS} omni-shp`);
    const header = element('header', 'omni-shp__header');
    const title = element('div', 'omni-shp__title', input.fileName);
    const summaryParts = [
        model.shapeTypeName,
        `${model.features.length.toLocaleString()} features`,
        `${model.vertexCount.toLocaleString()} vertices`
    ];
    if (attributes) summaryParts.push(`${attributes.fields.length.toLocaleString()} attribute fields`);
    const summary = element('div', 'omni-shp__summary', summaryParts.join(' · '));
    header.append(title, summary);

    const toolbar = element('div', 'omni-shp__toolbar');
    const zoomIn = button(t('shapefile.zoomIn'));
    const zoomOut = button(t('shapefile.zoomOut'));
    const reset = button(t('shapefile.reset'));
    toolbar.append(zoomIn, zoomOut, reset);
    if (projectionLabel) toolbar.append(element('span', 'omni-shp__projection', t('shapefile.projection', { name: projectionLabel })));

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('omni-shp__map');
    svg.setAttribute('role', 'img');
    const initialView = renderModel(svg, model);
    let view: ViewBox | null = initialView ? { ...initialView } : null;

    const attributesPanel = element('div', 'omni-shp__attributes');
    const attributesTitle = element('div', 'omni-shp__attributes-title', t('shapefile.attributes'));
    const attributesBody = element('div');
    attributesBody.className = 'omni-shp__attributes-empty';
    attributesBody.textContent = t('shapefile.noSelection');
    attributesPanel.append(attributesTitle, attributesBody);

    const warning = element('div', 'omni-shp__warning');
    warning.hidden = warnings.length === 0;
    warning.textContent = warnings.join('\n');
    shell.append(header, toolbar, svg, attributesPanel, warning);
    root.append(shell);

    // --- pan / zoom ---------------------------------------------------------
    const applyView = (): void => {
        if (view) svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    };
    const zoomAt = (factor: number, cx?: number, cy?: number): void => {
        if (!view) return;
        const centerX = cx ?? view.x + view.w / 2;
        const centerY = cy ?? view.y + view.h / 2;
        view = {
            x: centerX - (centerX - view.x) / factor,
            y: centerY - (centerY - view.y) / factor,
            w: view.w / factor,
            h: view.h / factor
        };
        applyView();
    };
    listen(zoomIn, 'click', () => zoomAt(ZOOM_FACTOR));
    listen(zoomOut, 'click', () => zoomAt(1 / ZOOM_FACTOR));
    listen(reset, 'click', () => { if (initialView) { view = { ...initialView }; applyView(); } });
    listen(svg, 'wheel', ((event: WheelEvent) => {
        if (!view) return;
        event.preventDefault();
        const rect = svg.getBoundingClientRect();
        const point = rect.width > 0 && rect.height > 0
            ? {
                x: view.x + ((event.clientX - rect.left) / rect.width) * view.w,
                y: view.y + ((event.clientY - rect.top) / rect.height) * view.h
            }
            : undefined;
        zoomAt(event.deltaY > 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR, point?.x, point?.y);
    }) as EventListener, { passive: false });

    let panFrom: { clientX: number; clientY: number; view: ViewBox } | null = null;
    listen(svg, 'pointerdown', ((event: PointerEvent) => {
        if (!view) return;
        panFrom = { clientX: event.clientX, clientY: event.clientY, view: { ...view } };
        svg.classList.add('is-panning');
    }) as EventListener);
    listen(document, 'pointermove', ((event: PointerEvent) => {
        if (!panFrom || !view) return;
        const rect = svg.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        view = {
            ...view,
            x: panFrom.view.x - ((event.clientX - panFrom.clientX) / rect.width) * panFrom.view.w,
            y: panFrom.view.y - ((event.clientY - panFrom.clientY) / rect.height) * panFrom.view.h
        };
        applyView();
    }) as EventListener);
    listen(document, 'pointerup', (() => {
        panFrom = null;
        svg.classList.remove('is-panning');
    }) as EventListener);

    // --- feature selection ---------------------------------------------------
    let selected: Element | null = null;
    const renderAttributes = (featureIndex: number): void => {
        const feature = model.features[featureIndex];
        attributesTitle.textContent = `${t('shapefile.attributes')} — ${t('shapefile.featureLabel', { id: feature?.id ?? featureIndex + 1 })}`;
        const record = attributes?.records[featureIndex];
        if (!record) {
            attributesBody.className = 'omni-shp__attributes-empty';
            attributesBody.textContent = t(attributes ? 'shapefile.noRecord' : 'shapefile.noAttributes');
            return;
        }
        attributesBody.className = '';
        const table = document.createElement('table');
        for (const field of attributes!.fields) {
            const row = document.createElement('tr');
            const name = document.createElement('th');
            name.textContent = field.name;
            const value = document.createElement('td');
            value.textContent = formatValue(record[field.name]);
            row.append(name, value);
            table.append(row);
        }
        attributesBody.replaceChildren(table);
    };
    listen(svg, 'click', ((event: MouseEvent) => {
        const target = (event.target as Element).closest?.('[data-feature]');
        selected?.classList.remove('is-selected');
        if (!target) {
            selected = null;
            attributesTitle.textContent = t('shapefile.attributes');
            attributesBody.className = 'omni-shp__attributes-empty';
            attributesBody.textContent = t('shapefile.noSelection');
            return;
        }
        selected = target;
        target.classList.add('is-selected');
        renderAttributes(Number(target.getAttribute('data-feature')));
    }) as EventListener);

    if (options.signal?.aborted) {
        disposers.forEach((dispose) => dispose());
        shell.remove();
        throw new MountAbortedError();
    }
    return {
        dispose(): void {
            disposers.forEach((dispose) => dispose());
            shell.remove();
            if (root === container) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--shapefile');
            else root.replaceChildren();
        }
    };
}

// --- SVG rendering (source coordinates, y flipped) ---------------------------

function renderModel(svg: SVGSVGElement, model: ShapefileModel): ViewBox | null {
    const bbox = model.bbox && (model.bbox[2] > model.bbox[0] || model.bbox[3] > model.bbox[1])
        ? model.bbox
        : deriveBBox(model);
    if (!bbox) return null;
    const [minX, minY, maxX, maxY] = bbox;
    const span = Math.max(maxX - minX, maxY - minY);
    const pad = span * 0.03 || 1;
    const viewWidth = maxX - minX + 2 * pad;
    const viewHeight = maxY - minY + 2 * pad;
    const pointRadius = Math.max(viewWidth, viewHeight) * 0.006;
    const view: ViewBox = { x: minX - pad, y: -(maxY + pad), w: viewWidth, h: viewHeight };
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    model.features.forEach((feature, index) => {
        if (feature.geometry) appendGeometry(svg, feature.geometry, pointRadius, index);
    });
    return view;
}

function appendGeometry(svg: SVGSVGElement, g: ShpGeometry, pointRadius: number, featureIndex: number): void {
    const ns = 'http://www.w3.org/2000/svg';
    const tag = (node: Element): void => node.setAttribute('data-feature', String(featureIndex));
    const point = (coordinates: ShpPosition): void => {
        const c = document.createElementNS(ns, 'circle');
        c.classList.add('omni-shp__point');
        c.setAttribute('cx', String(coordinates[0]));
        c.setAttribute('cy', String(-coordinates[1]));
        c.setAttribute('r', String(pointRadius));
        tag(c);
        svg.append(c);
    };
    if (g.type === 'Point') { point(g.coordinates); return; }
    if (g.type === 'MultiPoint') { g.coordinates.forEach(point); return; }
    if (g.type === 'LineString' || g.type === 'MultiLineString') {
        const groups = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
        for (const points of groups) {
            const p = document.createElementNS(ns, 'path');
            p.classList.add('omni-shp__geometry');
            p.setAttribute('d', points.map((x, i) => `${i ? 'L' : 'M'}${x[0]} ${-x[1]}`).join(' '));
            p.setAttribute('fill', 'none');
            tag(p);
            svg.append(p);
        }
        return;
    }
    const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const rings of polygons) {
        const p = document.createElementNS(ns, 'path');
        p.classList.add('omni-shp__geometry');
        p.setAttribute('d', rings.map(points => points.map((x, i) => `${i ? 'L' : 'M'}${x[0]} ${-x[1]}`).join(' ') + ' Z').join(' '));
        p.setAttribute('fill-rule', 'evenodd');
        p.setAttribute('clip-rule', 'evenodd');
        tag(p);
        svg.append(p);
    }
}

function deriveBBox(model: ShapefileModel): [number, number, number, number] | null {
    let b: [number, number, number, number] | null = null;
    const visit = (p: ShpPosition): void => {
        b = b ? [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])] : [p[0], p[1], p[0], p[1]];
    };
    for (const f of model.features) {
        const g = f.geometry;
        if (!g) continue;
        if (g.type === 'Point') visit(g.coordinates);
        else if (g.type === 'MultiLineString' || g.type === 'Polygon') for (const ring of g.coordinates) ring.forEach(visit);
        else if (g.type === 'MultiPolygon') for (const polygon of g.coordinates) for (const ring of polygon) ring.forEach(visit);
        else g.coordinates.forEach(visit);
    }
    return b;
}

function formatValue(value: DbfValue | undefined): string {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value);
}

function element(tag: string, className?: string, text?: string): HTMLElement {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(label: string): HTMLButtonElement {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'omni-shp__btn';
    node.textContent = label;
    return node;
}
