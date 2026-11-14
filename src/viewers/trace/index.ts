import type { HostContext } from '../../host/index.js';
import { parseTrace, type TraceEvent } from '../../parsers/trace/index.js';
import { TRACE_VIEWER_DESCRIPTOR } from '../../registry/file-previews.js';
import { mountFilePreview, previewDetails, previewPager, type FilePreviewOptions } from '../file-preview.js';
import type { ViewerInput } from '../types.js';
import { formatTraceArgs } from './args-preview.js';

export * from '../../parsers/trace/index.js';
export const TRACE_VIEWER_META = { ...TRACE_VIEWER_DESCRIPTOR, inputOwnership: 'borrows' as const };

const DRAW_LIMIT = 2000;
const TRACKS_PER_PAGE = 12;
const MAX_LANES = 8;

function firstVisible(endTimes: readonly number[], start: number): number {
    let left = 0, right = endTimes.length;
    while (left < right) {
        const middle = (left + right) >>> 1;
        if (endTimes[middle]! < start) left = middle + 1;
        else right = middle;
    }
    return left;
}
function prettyTime(micros: number): string {
    // Deterministic across host ICU locales (ADR 29): ASCII grouping, up to four fraction digits.
    const [whole = '', fraction] = (micros / 1000).toFixed(4).replace(/\.?0+$/, '').split('.');
    return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''} ms`;
}

export async function mountTraceViewer(input: ViewerInput, container: HTMLElement, ctx: HostContext, options: FilePreviewOptions = {}) {
    return mountFilePreview(input, container, ctx, options, 'trace', parseTrace(input.data, options).result, (ui, model) => {
        const { t } = ui;
        const relativeStart = (event: TraceEvent) => event.start - model.start;
        const indexEnds = (events: TraceEvent[]) => {
            let end = -Infinity;
            return events.map(event => end = Math.max(end, relativeStart(event) + event.duration));
        };
        const index = model.tracks.map(track => ({ track, events: track.events, ends: indexEnds(track.events) }));
        const relativeEnd = index.reduce((end, { ends }) => Math.max(end, ends.at(-1) ?? 0), 0);
        const span = Number.isFinite(relativeEnd) ? relativeEnd : model.end - model.start;
        const fullSpan = span > 0 ? span : 1;
        let viewSpan = fullSpan, offset = 0, trackPage = 0;
        const toolbar = ui.el('div', undefined, 'preview-toolbar');
        const search = ui.el('input');
        search.type = 'search';
        search.placeholder = t('preview.search');
        search.setAttribute('aria-label', search.placeholder);
        const scrub = ui.el('input');
        scrub.type = 'range';
        scrub.min = '0';
        scrub.max = '10000';
        scrub.value = '0';
        scrub.setAttribute('aria-label', t('trace.position'));
        const range = ui.el('p');
        range.setAttribute('aria-live', 'polite');
        const plot = ui.el('div', undefined, 'preview-scroll');
        const details = ui.el('div');
        let tracks = index;
        const pageTracks = () => tracks.slice(trackPage * TRACKS_PER_PAGE, (trackPage + 1) * TRACKS_PER_PAGE);
        const select = (event: TraceEvent, label: string, id: string) => {
            details.replaceChildren(previewDetails(ui, [
                [t('preview.name'), event.name], [t('trace.track'), label === id ? label : `${label} (${id})`], [t('trace.category'), event.category],
                [t('trace.start'), prettyTime(relativeStart(event))], [t('trace.duration'), prettyTime(event.duration)]
            ]));
            if (event.args) {
                const preview = formatTraceArgs(event.args);
                details.append(ui.el('pre', preview.text));
                if (preview.truncated) details.append(ui.el('p', t('preview.truncated')));
            }
        };
        const render = () => {
            const start = offset, end = start + viewSpan;
            range.textContent = t('trace.range', { start: prettyTime(offset), end: prettyTime(Math.min(span, offset + viewSpan)) });
            scrub.disabled = viewSpan >= fullSpan;
            scrub.value = String(Math.round(10_000 * (fullSpan > viewSpan ? offset / (fullSpan - viewSpan) : 0)));
            plot.replaceChildren();
            let count = 0, clipped = false;
            for (const { track, events, ends } of pageTracks()) {
                const row = ui.el('div', undefined, 'preview-track');
                const bars = ui.el('div', undefined, 'preview-track-plot');
                const trackLabel = ui.el('div', track.label, 'preview-track-label');
                const id = `${String(track.pid).slice(0, 512)}:${String(track.tid).slice(0, 512)}`;
                trackLabel.title = id;
                row.append(trackLabel, bars);
                plot.append(row);
                const lanes: number[] = [];
                for (let i = firstVisible(ends, start); i < events.length; i++) {
                    const event = events[i]!;
                    const eventStart = relativeStart(event);
                    if (eventStart > end) break;
                    const finish = eventStart + event.duration;
                    if (finish < start) continue;
                    if (count >= DRAW_LIMIT) {
                        clipped = true;
                        break;
                    }
                    let lane = lanes.findIndex(laneEnd => laneEnd <= eventStart);
                    if (lane < 0) lane = lanes.length;
                    if (lane >= MAX_LANES) {
                        clipped = true;
                        continue;
                    }
                    lanes[lane] = finish === eventStart ? finish + viewSpan / 250 : finish;
                    const label = event.name.slice(0, 512) || '•';
                    const bar = ui.button(label, () => select(event, track.label, id));
                    bar.className = 'preview-event';
                    bar.title = `${label} · ${prettyTime(event.duration)}`;
                    const left = (Math.max(start, eventStart) - start) / viewSpan;
                    const width = (Math.min(end, finish) - start) / viewSpan - left;
                    bar.style.left = `calc(${left * 100}% - ${left * 4}px)`;
                    bar.style.width = `${Math.max(0, width) * 100}%`;
                    bar.style.top = `${lane * 1.25}rem`;
                    bars.append(bar);
                    count++;
                }
                bars.style.height = `${Math.max(1, lanes.length) * 1.25 + .25}rem`;
            }
            if (clipped) plot.append(ui.el('p', t('trace.dense'), 'preview-warning'));
            if (!count) plot.append(ui.el('p', t('preview.empty')));
        };
        const zoom = (factor: number) => {
            const center = offset + viewSpan / 2;
            viewSpan = Math.max(Number.MIN_VALUE, fullSpan / 10_000, Math.min(fullSpan, viewSpan * factor));
            offset = Math.max(0, Math.min(fullSpan - viewSpan, center - viewSpan / 2));
            render();
        };
        const zoomIn = ui.button(t('preview.zoomIn'), () => zoom(.5));
        const zoomOut = ui.button(t('preview.zoomOut'), () => zoom(2));
        zoomIn.disabled = zoomOut.disabled = span === 0;
        toolbar.append(search, zoomIn, zoomOut,
            ui.button(t('preview.fit'), () => { offset = 0; viewSpan = fullSpan; render(); }), scrub);
        const trackToolbar = ui.el('div', undefined, 'preview-toolbar');
        const pager = previewPager(ui, trackToolbar, page => {
            trackPage = page;
            if (search.value.trim()) {
                const visible = pageTracks();
                const start = offset, end = start + viewSpan;
                const hasMatchInView = visible.some(({ events, ends }) => {
                    const first = events[firstVisible(ends, start)];
                    return first !== undefined && relativeStart(first) <= end;
                });
                if (visible.length && !hasMatchInView) {
                    const firstMatch = Math.min(...visible.map(track => relativeStart(track.events[0]!)));
                    offset = Math.max(0, Math.min(fullSpan - viewSpan, firstMatch - viewSpan / 4));
                }
            }
            render();
        });
        search.addEventListener('input', () => {
            const query = search.value.trim().toLowerCase();
            details.replaceChildren();
            tracks = query ? index.flatMap(item => {
                const events = item.track.label.toLowerCase().includes(query) ? item.events :
                    item.events.filter(event => event.name.toLowerCase().includes(query) || event.category.toLowerCase().includes(query));
                return events.length ? [{ track: item.track, events, ends: indexEnds(events) }] : [];
            }) : index;
            pager.reset(Math.ceil(tracks.length / TRACKS_PER_PAGE));
        });
        scrub.addEventListener('input', () => {
            offset = (fullSpan - viewSpan) * Number(scrub.value) / 10_000;
            render();
        });
        ui.body.append(ui.el('p', t('trace.summary', { tracks: model.tracks.length, events: model.eventCount })), toolbar, range, trackToolbar, plot, details);
        pager.reset(Math.ceil(tracks.length / TRACKS_PER_PAGE));
    });
}
