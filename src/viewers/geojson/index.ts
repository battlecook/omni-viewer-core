import type { HostContext } from '../../host/index.js';
import { utf8ByteLength } from '../../parsers/types.js';
import { parseGeoJson, type GeoJsonGeometry, type GeoJsonParseOptions, type GeoJsonPosition } from '../../parsers/geojson/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { geoJsonViewerCss } from './styles.js';

export * from '../../parsers/geojson/index.js';
export { geoJsonViewerCss } from './styles.js';
export type GeoJsonViewerContext = HostContext;
export interface GeoJsonMountOptions extends MountOptions, GeoJsonParseOptions {}
export const GEOJSON_VIEWER_META = {
    id: 'geojson', displayNameKey: 'geojson.title', extensions: ['geojson'], priority: 20,
    requiredServices: [] as const, optionalServices: [] as const, inputOwnership: 'borrows' as const
};

interface ViewBox { x: number; y: number; w: number; h: number }
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Bound displayed text in UTF-8 bytes, including the ellipsis when it fits. */
function previewText(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
    const budget = Math.max(0, maxBytes);
    let end = 0, bytes = 0;
    while (end < text.length) {
        const code = text.codePointAt(end)!;
        const width = code > 0xffff ? 2 : 1;
        const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code > 0xffff ? 4 : 3;
        if (bytes + size > budget) break;
        bytes += size; end += width;
    }
    if (end === text.length) return { text, bytes, truncated: false };
    const suffix = budget >= 3 ? '…' : '';
    const suffixBytes = suffix ? 3 : 0;
    while (end > 0 && bytes + suffixBytes > budget) {
        const last = text.charCodeAt(end - 1), previous = text.charCodeAt(end - 2);
        const width = last >= 0xdc00 && last <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff ? 2 : 1;
        bytes -= utf8ByteLength(text.slice(end - width, end)); end -= width;
    }
    return { text: text.slice(0, end) + suffix, bytes: bytes + suffixBytes, truncated: true };
}

/** Offline longitude/latitude map; file content is only ever inserted as text. */
export async function mountGeoJsonViewer(
    input: ViewerInput, container: HTMLElement, ctx: GeoJsonViewerContext, options: GeoJsonMountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const { result } = parseGeoJson(input.data, options);
    if (result.status === 'failed') {
        if (result.failure.code === 'aborted') throw new MountAbortedError();
        throw new Error(ctx.i18n.t(result.failure.messageKey, result.failure.args));
    }
    const model = result.document;
    const previewBudget = options.limits?.maxPreviewBytes ?? 64 * 1024;
    // Acquire the rendering host before subscribing to document/window events.
    // Unsupported shadow hosts can reject here without retaining the model in listeners.
    const root = options.styleIsolation === 'scoped' ? container : container.shadowRoot ?? container.attachShadow({ mode: 'open' });
    const doc = container.ownerDocument;
    const t = ctx.i18n.t.bind(ctx.i18n);
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
        const node = doc.createElement(tag);
        node.className = `omni-geojson__${className}`;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const shell = doc.createElement('section');
    shell.className = `${VIEWER_ROOT_CLASS} omni-viewer--geojson omni-geojson`;
    const heading = el('h2', 'title', input.fileName);
    const summary = el('p', 'summary', t('geojson.summary', { features: model.features.length, vertices: model.vertexCount }));
    const toolbar = el('div', 'toolbar');
    const button = (key: string): HTMLButtonElement => {
        const node = el('button', 'button', t(key)); node.type = 'button'; return node;
    };
    const zoomIn = button('geojson.zoomIn'), zoomOut = button('geojson.zoomOut'), reset = button('geojson.reset');
    const selectLabel = el('label', 'label', t('geojson.features'));
    const select = el('select', 'select');
    select.setAttribute('aria-label', t('geojson.features'));
    const placeholder = doc.createElement('option'); placeholder.value = ''; placeholder.textContent = t('geojson.noSelection'); select.append(placeholder);
    const label = (index: number): string => {
        const id = model.features[index]!.id;
        return previewText(t('geojson.feature', { id: id === null ? index + 1 : previewText(id, 768).text }), 1024).text;
    };
    model.features.forEach((_, index) => {
        const option = doc.createElement('option'); option.value = String(index); option.textContent = label(index); select.append(option);
    });
    selectLabel.append(' ', select);
    toolbar.append(zoomIn, zoomOut, reset, selectLabel);
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.classList.add('omni-geojson__map');
    svg.setAttribute('role', 'group'); svg.setAttribute('tabindex', '0'); svg.setAttribute('aria-label', t('geojson.map'));
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const hint = el('p', 'hint', t('geojson.hint'));
    const empty = el('p', 'empty', t('geojson.empty')); empty.hidden = model.vertexCount > 0;
    const properties = el('section', 'properties');
    properties.setAttribute('aria-live', 'polite');
    const propertiesTitle = el('h3', 'properties-title', t('geojson.properties'));
    const propertiesBody = el('div', 'empty', t('geojson.noSelection'));
    properties.append(propertiesTitle, propertiesBody);
    const warningsText = result.diagnostics.map(d => {
        const args = d.args && Object.fromEntries(Object.entries(d.args).map(([key, value]) =>
            [key, typeof value === 'string' ? previewText(value, 1024).text : value]));
        return t(d.messageKey, args);
    }).join('\n');
    const warnings = el('div', 'warning', previewText(warningsText, previewBudget).text);
    warnings.hidden = result.diagnostics.length === 0;
    shell.append(heading, summary, toolbar, svg, empty, hint, properties, warnings);

    let initial: ViewBox | null = null;
    if (model.bbox) {
        const [minX, minY, maxX, maxY] = model.bbox;
        const pad = Math.max(maxX - minX, maxY - minY) * 0.04 || 0.01;
        initial = { x: minX - pad, y: -maxY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
    }
    let view = initial ? { ...initial } : null;
    const apply = (): void => { if (view) svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`); };
    apply();
    const radius = initial ? Math.max(initial.w, initial.h) * 0.006 : 0.01;
    const groups: SVGGElement[] = [];
    model.features.forEach((feature, index) => {
        const group = doc.createElementNS(SVG_NS, 'g');
        group.classList.add('omni-geojson__feature'); group.setAttribute('data-feature', String(index));
        group.setAttribute('aria-label', label(index));
        if (feature.geometry) appendGeometry(group, feature.geometry, radius);
        groups.push(group); svg.append(group);
    });
    zoomIn.disabled = zoomOut.disabled = reset.disabled = !initial;
    const listeners: Array<() => void> = [];
    const on = (target: EventTarget, type: string, listener: EventListener, opts?: AddEventListenerOptions): void => {
        target.addEventListener(type, listener, opts);
        listeners.push(() => target.removeEventListener(type, listener, opts));
    };
    let pan: { id: number; x: number; y: number; scale: number; view: ViewBox } | null = null;
    const stopPan = (): void => {
        const pointerId = pan?.id;
        pan = null; svg.classList.remove('is-panning');
        if (pointerId !== undefined && svg.hasPointerCapture?.(pointerId)) svg.releasePointerCapture(pointerId);
    };
    let selected: number | null = null;
    const choose = (index: number | null): void => {
        if (index !== null && (!Number.isInteger(index) || index < 0 || index >= model.features.length)) index = null;
        if (selected !== null) groups[selected]?.classList.remove('is-selected');
        selected = index;
        select.value = index === null ? '' : String(index);
        propertiesBody.replaceChildren();
        propertiesBody.className = 'omni-geojson__empty';
        propertiesTitle.textContent = t('geojson.properties');
        if (index === null) { propertiesBody.textContent = t('geojson.noSelection'); return; }
        groups[index]?.classList.add('is-selected');
        propertiesTitle.textContent += ` — ${label(index)}`;
        const fields = model.features[index]!.properties?.children ?? [];
        if (!fields.length) { propertiesBody.textContent = t('geojson.noProperties'); return; }
        propertiesBody.className = '';
        const table = doc.createElement('table');
        // A single feature can own most of the JSON tree. Bound the DOM and text
        // preview independently of the geometry budget; the model stays lossless.
        let remaining = previewBudget;
        let shown = 0, truncated = false;
        for (const field of fields) {
            if (shown >= 500 || remaining <= 0) { truncated = true; break; }
            const row = doc.createElement('tr'), key = doc.createElement('th'), value = doc.createElement('td');
            const preview = (text: string): string => {
                const part = previewText(text, remaining);
                remaining -= part.bytes;
                truncated ||= part.truncated;
                return part.text;
            };
            key.scope = 'row'; key.textContent = preview(field.key);
            value.textContent = preview(field.kind === 'string' ? String(field.value) : model.text.slice(field.span.start, field.span.end));
            row.append(key, value); table.append(row);
            shown++;
        }
        propertiesBody.append(table);
        if (truncated) propertiesBody.append(el('p', 'warning', t('geojson.propertiesTruncated')));
    };
    on(select, 'change', () => choose(select.value === '' ? null : Number(select.value)));
    let dragged = false;
    on(svg, 'click', event => {
        if (dragged) { dragged = false; return; }
        const target = event.target as Element;
        const feature = target.closest?.('[data-feature]');
        choose(feature && svg.contains(feature) ? Number(feature.getAttribute('data-feature')) : null);
    });
    const zoom = (factor: number, point?: { x: number; y: number }): void => {
        if (!view || !initial) return;
        const width = view.w / factor;
        if (width < initial.w / 10_000 || width > initial.w * 100) return;
        stopPan();
        const x = point?.x ?? view.x + view.w / 2, y = point?.y ?? view.y + view.h / 2;
        view = { x: x - (x - view.x) / factor, y: y - (y - view.y) / factor, w: width, h: view.h / factor }; apply();
    };
    const resetView = (): void => { stopPan(); view = initial ? { ...initial } : null; apply(); };
    on(zoomIn, 'click', () => zoom(1.5)); on(zoomOut, 'click', () => zoom(1 / 1.5)); on(reset, 'click', resetView);
    // Account for SVG's centered letterboxing when converting screen positions.
    const screen = (): { scale: number; left: number; top: number } | null => {
        if (!view) return null;
        const rect = svg.getBoundingClientRect(), scale = Math.min(rect.width / view.w, rect.height / view.h);
        return scale > 0 ? { scale, left: rect.left + (rect.width - view.w * scale) / 2, top: rect.top + (rect.height - view.h * scale) / 2 } : null;
    };
    on(svg, 'wheel', ((event: WheelEvent) => {
        if (!view || event.deltaY === 0) return;
        event.preventDefault();
        const transform = screen();
        zoom(event.deltaY > 0 ? 1 / 1.5 : 1.5, transform ? {
            x: view.x + (event.clientX - transform.left) / transform.scale,
            y: view.y + (event.clientY - transform.top) / transform.scale
        } : undefined);
    }) as EventListener, { passive: false });
    on(svg, 'pointerdown', ((event: PointerEvent) => {
        if (!view || pan || event.button !== 0) return;
        const transform = screen(); if (!transform) return;
        pan = { id: event.pointerId, x: event.clientX, y: event.clientY, scale: transform.scale, view: { ...view } };
        dragged = false; svg.classList.add('is-panning');
    }) as EventListener);
    on(doc, 'pointermove', ((event: PointerEvent) => {
        if (!pan || event.pointerId !== pan.id) return;
        if (event.buttons === 0) { stopPan(); return; }
        const dx = event.clientX - pan.x, dy = event.clientY - pan.y;
        if (Math.abs(dx) + Math.abs(dy) > 3 && !dragged) {
            dragged = true;
            // Delay capture until an actual drag so an ordinary click retains
            // its original feature target. The buttons check covers older hosts.
            try { svg.setPointerCapture?.(event.pointerId); } catch { /* synthetic events may have no active pointer */ }
        }
        view = { ...pan.view, x: pan.view.x - dx / pan.scale, y: pan.view.y - dy / pan.scale }; apply();
    }) as EventListener);
    const finishPan: EventListener = event => { if (pan && (event as PointerEvent).pointerId === pan.id) stopPan(); };
    on(doc, 'pointerup', finishPan); on(doc, 'pointercancel', finishPan);
    // Touch capture transfers from the original shape to the SVG when dragging
    // starts. Only loss of the SVG's own capture ends the gesture.
    on(svg, 'lostpointercapture', event => { if (event.target === svg) finishPan(event); });
    if (doc.defaultView) on(doc.defaultView, 'blur', stopPan);
    on(svg, 'keydown', ((event: KeyboardEvent) => {
        if (!view) return;
        switch (event.key) {
            case '+': case '=': zoom(1.5); break;
            case '-': zoom(1 / 1.5); break;
            case '0': case 'Home': resetView(); break;
            case 'ArrowLeft': stopPan(); view.x -= view.w * 0.1; apply(); break;
            case 'ArrowRight': stopPan(); view.x += view.w * 0.1; apply(); break;
            case 'ArrowUp': stopPan(); view.y -= view.h * 0.1; apply(); break;
            case 'ArrowDown': stopPan(); view.y += view.h * 0.1; apply(); break;
            default: return;
        }
        event.preventDefault();
    }) as EventListener);

    const style = doc.createElement('style'); style.textContent = geoJsonViewerCss;
    if (root !== container) root.append(style);
    root.append(shell);
    let disposed = false;
    const dispose = (): void => {
        if (disposed) return;
        disposed = true; stopPan(); listeners.forEach(off => off()); listeners.length = 0; shell.remove(); style.remove();
    };
    if (options.signal?.aborted) { dispose(); throw new MountAbortedError(); }
    return { dispose };
}

function appendGeometry(parent: SVGGElement, geometry: GeoJsonGeometry, radius: number): void {
    const doc = parent.ownerDocument;
    const point = (position: GeoJsonPosition): void => {
        const node = doc.createElementNS(SVG_NS, 'circle'); node.classList.add('omni-geojson__point');
        node.setAttribute('cx', String(position[0])); node.setAttribute('cy', String(-position[1])); node.setAttribute('r', String(radius)); parent.append(node);
    };
    const path = (lines: GeoJsonPosition[][], polygon: boolean): void => {
        if (!lines.some(line => line.length > 0)) return;
        const node = doc.createElementNS(SVG_NS, 'path'); node.classList.add('omni-geojson__geometry');
        node.setAttribute('d', lines.map(line => line.map((p, index) => `${index ? 'L' : 'M'}${p[0]} ${-p[1]}`).join(' ') + (polygon ? ' Z' : '')).join(' '));
        if (polygon) node.setAttribute('fill-rule', 'evenodd'); else node.style.fill = 'none';
        parent.append(node);
    };
    switch (geometry.type) {
        case 'Point': point(geometry.coordinates); break;
        case 'MultiPoint': geometry.coordinates.forEach(point); break;
        case 'LineString': path([geometry.coordinates], false); break;
        case 'MultiLineString': path(geometry.coordinates, false); break;
        case 'Polygon': path(geometry.coordinates, true); break;
        case 'MultiPolygon': geometry.coordinates.forEach(polygon => path(polygon, true)); break;
        case 'GeometryCollection': geometry.geometries.forEach(child => appendGeometry(parent, child, radius)); break;
    }
}
