import type { HostContext } from '../../host/index.js';
import { decodeDicomFrame, parseDicom, renderDicomFrame, type DicomFrame, type DicomParseOptions } from '../../parsers/dicom/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { dicomViewerCss } from './styles.js';
export { dicomViewerCss } from './styles.js';
export { decodeDicomFrame, parseDicom, renderDicomFrame } from '../../parsers/dicom/index.js';
export type DicomViewerContext = HostContext;
export interface DicomMountOptions extends MountOptions, DicomParseOptions {}
export const DICOM_VIEWER_META = {
    id: 'dicom', displayNameKey: 'dicom.title', extensions: ['dcm', 'dicom'], priority: 20,
    requiredServices: [] as const, optionalServices: [] as const, inputOwnership: 'borrows' as const
};

export async function mountDicomViewer(input: ViewerInput, container: HTMLElement, ctx: DicomViewerContext, options: DicomMountOptions = {}): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const model = parseDicom(input.data, options), doc = container.ownerDocument;
    const t = (key: string, args?: Record<string, string | number>) => ctx.i18n.t(key, args);
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, name: string, text?: string): HTMLElementTagNameMap[K] => {
        const node = doc.createElement(tag); node.className = `omni-dicom__${name}`;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const shell = el('section', 'shell'); shell.className = `${VIEWER_ROOT_CLASS} omni-viewer--dicom omni-dicom`;
    const heading = el('h2', 'heading', input.fileName);
    const summary = el('div', 'summary', t('dicom.summary', { width: model.image.columns, height: model.image.rows, frames: model.image.frames, bits: model.image.bitsAllocated, modality: model.values['00080060'] ?? 'DICOM' }));
    const toolbar = el('div', 'toolbar'); toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', t('dicom.controls'));
    const listeners: Array<() => void> = [];
    const on = (target: EventTarget, type: string, handler: EventListener) => {
        target.addEventListener(type, handler); listeners.push(() => target.removeEventListener(type, handler));
    };
    const button = (name: string, key: string) => { const b = el('button', name, t(key)); b.type = 'button'; return b; };
    const numeric = (name: string, key: string, type: string) => {
        const label = el('label', `${name}-label`, t(key)), control = el('input', name); control.type = type;
        label.append(control); toolbar.append(label); return control;
    };
    const previous = button('previous', 'dicom.previous'), next = button('next', 'dicom.next');
    toolbar.append(previous);
    const frameInput = numeric('frame', 'dicom.frame', 'range'); frameInput.min = '1'; frameInput.max = String(model.image.frames); frameInput.value = '1';
    const frameStatus = el('output', 'frame-status'); frameStatus.setAttribute('aria-live', 'polite'); toolbar.append(frameStatus, next);
    const center = numeric('center', 'dicom.center', 'number'), width = numeric('width', 'dicom.width', 'number');
    center.step = width.step = 'any'; width.min = '1';
    const reset = button('reset', 'dicom.reset'), invert = button('invert', 'dicom.invert'); invert.setAttribute('aria-pressed', 'false'); toolbar.append(reset, invert);
    const zoom = numeric('zoom', 'dicom.zoom', 'range'); zoom.min = '25'; zoom.max = '400'; zoom.step = '25'; zoom.value = '100';
    const stage = el('div', 'stage'), canvas = el('canvas', 'canvas'); canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', t('dicom.image'));
    const message = el('p', 'message'); message.setAttribute('role', 'status');
    stage.append(canvas); shell.append(heading, summary, toolbar, stage, message);
    let frame: DicomFrame | undefined, frameIndex = 0, inverted = false;
    let appliedCenter: number | undefined, appliedWidth: number | undefined;
    let context: CanvasRenderingContext2D | null = null;
    const notices = model.diagnostics.map(d => t(d.messageKey, d.args));
    const setMessage = (notice?: string) => { message.textContent = [...notices, ...(notice ? [notice] : [])].join('\n'); message.hidden = !message.textContent; };
    const draw = () => {
        if (!frame || !context) return;
        const windowCenter = Number(center.value), windowWidth = Number(width.value);
        if (!center.value || !width.value || !Number.isFinite(windowCenter) || !Number.isFinite(windowWidth) || windowWidth <= 0 || (frame.voiFunction === 'LINEAR' && windowWidth < 1)) return;
        const output = context.createImageData(frame.width, frame.height);
        output.data.set(renderDicomFrame(frame, { windowCenter, windowWidth, invert: inverted }));
        context.putImageData(output, 0, 0);
        appliedCenter = windowCenter; appliedWidth = windowWidth;
    };
    const loadFrame = (keepWindow = false) => {
        frame = decodeDicomFrame(model, frameIndex);
        canvas.width = frame.width; canvas.height = frame.height;
        if (zoom.value !== '100') canvas.style.width = `${frame.width * Number(zoom.value) / 100}px`;
        // Respect non-square physical pixels without changing the decoded image dimensions.
        const spacing = model.image.pixelSpacing;
        const aspect = spacing.length === 2 ? spacing[0]! / spacing[1]! : 1;
        canvas.style.aspectRatio = `${frame.width} / ${frame.height * aspect}`;
        width.min = frame.voiFunction === 'LINEAR' ? '1' : String(Number.MIN_VALUE);
        // Editing a number field can temporarily leave it empty or invalid.
        // Frame changes retain the last window that was actually painted.
        center.value = String(keepWindow ? appliedCenter ?? frame.windowCenter : frame.windowCenter);
        width.value = String(keepWindow ? appliedWidth ?? frame.windowWidth : frame.windowWidth);
        center.disabled = width.disabled = frame.color;
        frameStatus.textContent = t('dicom.frameStatus', { frame: frameIndex + 1, frames: model.image.frames });
        frameInput.value = String(frameIndex + 1); previous.disabled = frameIndex === 0; next.disabled = frameIndex === model.image.frames - 1;
        draw();
    };
    if (model.previewIssue) {
        canvas.hidden = true; toolbar.hidden = true; stage.hidden = true; setMessage(t(model.previewIssue.messageKey, model.previewIssue.args));
    } else {
        try { context = canvas.getContext('2d'); if (!context) throw new Error('Canvas unavailable'); loadFrame(); setMessage(); }
        catch { canvas.hidden = true; toolbar.hidden = true; stage.hidden = true; setMessage(t('dicom.renderFailed')); }
    }
    on(previous, 'click', () => { if (frameIndex > 0) { frameIndex--; loadFrame(true); } });
    on(next, 'click', () => { if (frameIndex + 1 < model.image.frames) { frameIndex++; loadFrame(true); } });
    on(frameInput, 'input', () => { const n = Number(frameInput.value); if (Number.isInteger(n) && n >= 1 && n <= model.image.frames) { frameIndex = n - 1; loadFrame(true); } });
    on(center, 'input', draw); on(width, 'input', draw);
    on(invert, 'click', () => { inverted = !inverted; invert.setAttribute('aria-pressed', String(inverted)); draw(); });
    on(zoom, 'input', () => { if (frame) canvas.style.width = `${frame.width * Number(zoom.value) / 100}px`; canvas.style.maxWidth = 'none'; });
    on(reset, 'click', () => { inverted = false; invert.setAttribute('aria-pressed', 'false'); zoom.value = '100'; canvas.style.removeProperty('width'); canvas.style.removeProperty('max-width'); loadFrame(); });
    const metadata = el('section', 'metadata'); metadata.append(el('h3', 'metadata-title', t('dicom.metadata')));
    const searchLabel = el('label', 'search-label', t('dicom.search')), search = el('input', 'search'); search.type = 'search'; search.maxLength = 128; searchLabel.append(search);
    const wrap = el('div', 'table-wrap'), table = el('table', 'table'); table.setAttribute('aria-label', t('dicom.metadata'));
    const head = doc.createElement('thead'), header = doc.createElement('tr');
    for (const key of ['tag', 'name', 'vr', 'value']) { const th = el('th', key, t(`dicom.${key}`)); th.scope = 'col'; header.append(th); }
    head.append(header); const body = doc.createElement('tbody'); table.append(head, body); wrap.append(table);
    const pagination = el('div', 'pagination'), before = button('tags-previous', 'dicom.previous'), after = button('tags-next', 'dicom.next'), status = el('span', 'tags-status'); status.setAttribute('role', 'status'); pagination.append(before, status, after);
    metadata.append(searchLabel, wrap, pagination); shell.append(metadata);
    let page = 0;
    const renderMetadata = () => {
        const query = search.value.trim().toLowerCase();
        const filtered = model.elements.filter(e => !query || `${e.tag} (${e.tag.slice(0, 4)},${e.tag.slice(4)}) ${e.name} ${e.vr} ${e.value}`.toLowerCase().includes(query));
        const pages = Math.max(1, Math.ceil(filtered.length / 100)); page = Math.max(0, Math.min(page, pages - 1)); body.replaceChildren();
        for (const e of filtered.slice(page * 100, (page + 1) * 100)) {
            const row = doc.createElement('tr');
            const tag = el('td', 'tag', `(${e.tag.slice(0, 4)},${e.tag.slice(4)})`);
            tag.style.paddingInlineStart = `${10 + e.depth * 12}px`;
            row.append(tag, el('td', 'name', e.name || t('dicom.unknown')), el('td', 'vr', e.vr), el('td', 'value', e.value || t(e.vr === 'SQ' ? 'dicom.sequence' : 'dicom.binary', { bytes: e.length === 0xffffffff ? '?' : e.length })));
            body.append(row);
        }
        if (!filtered.length) { const row = doc.createElement('tr'), cell = el('td', 'empty', t('dicom.empty')); cell.colSpan = 4; row.append(cell); body.append(row); }
        status.textContent = t('dicom.page', { page: page + 1, pages, count: filtered.length }); before.disabled = page === 0; after.disabled = page + 1 === pages;
    };
    on(search, 'input', () => { page = 0; renderMetadata(); });
    on(before, 'click', () => { page--; renderMetadata(); }); on(after, 'click', () => { page++; renderMetadata(); }); renderMetadata();
    if (options.signal?.aborted) { listeners.forEach(remove => remove()); throw new MountAbortedError(); }
    const root = options.styleIsolation === 'scoped' ? container : container.shadowRoot ?? container.attachShadow({ mode: 'open' });
    let style: HTMLStyleElement | undefined;
    if (root !== container) { style = doc.createElement('style'); style.textContent = dicomViewerCss; root.append(style); }
    root.append(shell);
    let disposed = false;
    return { dispose() {
        if (disposed) return; disposed = true;
        listeners.splice(0).forEach(remove => remove()); frame = undefined; context = null;
        canvas.width = canvas.height = 0; shell.remove(); style?.remove();
    } };
}
