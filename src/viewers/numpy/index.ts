import type { ClipboardService, HostContext } from '../../host/index.js';
import { parseNumpy, type NumpyArray, type NumpyDocument } from '../../parsers/numpy/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { numpyViewerCss } from './styles.js';

export { parseNpy, parseNumpy } from '../../parsers/numpy/index.js';
export type { NumpyArray, NumpyDocument, NumpyScalar, NumpyTable } from '../../parsers/numpy/index.js';
export { numpyViewerCss } from './styles.js';

export const NUMPY_VIEWER_META = {
    id: 'numpy', displayNameKey: 'numpy.title', extensions: ['npy', 'npz'], priority: 20,
    requiredServices: [] as const, optionalServices: ['clipboard'] as const,
    inputOwnership: 'borrows' as const
};

export type NumpyViewerContext = HostContext & { clipboard?: ClipboardService };
export const NUMPY_GRID_ROW_LIMIT = 100;
export const NUMPY_GRID_COLUMN_LIMIT = 100;

export async function mountNumpyViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: NumpyViewerContext,
    options: MountOptions = {}
): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const model = await parseNumpy(input.data, input.fileName);
    if (options.signal?.aborted) throw new MountAbortedError();
    return mountNumpyDocument(model, input.fileName, container, ctx, options);
}

export function mountNumpyDocument(
    model: NumpyDocument,
    fileName: string,
    container: HTMLElement,
    ctx: NumpyViewerContext,
    options: MountOptions = {}
): ViewerHandle {
    if (options.signal?.aborted) throw new MountAbortedError();
    const t = ctx.i18n.t.bind(ctx.i18n);
    let root: HTMLElement | ShadowRoot = container;
    let style: HTMLStyleElement | undefined;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && typeof container.attachShadow === 'function') {
        root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        style = el('style'); style.textContent = numpyViewerCss; root.append(style);
    } else container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--numpy');

    const disposers: Array<() => void> = [];
    const on = (target: EventTarget, type: string, listener: EventListener): void => {
        target.addEventListener(type, listener); disposers.push(() => target.removeEventListener(type, listener));
    };
    const frame = el('div', 'omni-numpy');
    const header = el('header', 'omni-numpy__header');
    const mark = el('div', 'omni-numpy__mark', model.format.endsWith('NPZ') ? 'NPZ' : 'NPY');
    const heading = el('div', 'omni-numpy__heading');
    heading.append(el('h1', undefined, fileName), el('div', 'omni-numpy__subtitle', `${model.title} · ${model.fileSize}`));
    header.append(mark, heading);

    const summary = el('section', 'omni-numpy__summary');
    for (const item of model.summary) {
        const card = el('div', 'omni-numpy__stat');
        card.append(el('span', 'omni-numpy__stat-label', item.label), el('strong', 'omni-numpy__stat-value', String(item.value)));
        summary.append(card);
    }

    const toolbar = el('nav', 'omni-numpy__toolbar');
    const arraySelect = el('select', 'omni-numpy__select') as HTMLSelectElement;
    arraySelect.setAttribute('aria-label', t('numpy.selectArray'));
    model.arrays.forEach((array, index) => {
        const option = el('option', undefined, `${array.name} · ${formatShape(array.shape)} · ${array.dtype}`) as HTMLOptionElement;
        option.value = String(index); arraySelect.append(option);
    });
    const dataButton = el('button', undefined, t('numpy.data')) as HTMLButtonElement;
    const arraysButton = el('button', undefined, t('numpy.arrays')) as HTMLButtonElement;
    const copyButton = el('button', undefined, t('numpy.copyJson')) as HTMLButtonElement;
    for (const button of [dataButton, arraysButton, copyButton]) button.type = 'button';
    copyButton.disabled = !ctx.clipboard;
    copyButton.title = ctx.clipboard ? '' : t('common.noClipboard');
    toolbar.append(arraySelect, dataButton, arraysButton, copyButton);

    const warnings = el('section', 'omni-numpy__warnings');
    warnings.setAttribute('role', 'status');
    model.warnings.forEach(warning => warnings.append(el('div', undefined, warning)));
    warnings.hidden = model.warnings.length === 0;
    const content = el('main', 'omni-numpy__content');
    frame.append(header, summary, toolbar, warnings, content); root.append(frame);

    let view: 'data' | 'arrays' = model.arrays.length ? 'data' : 'arrays';
    let activeArray = 0;
    const slices: number[] = [];

    const renderArrays = (): void => {
        const table = model.tables[0];
        if (!table) { content.append(el('div', 'omni-numpy__empty', t('numpy.noData'))); return; }
        const wrap = el('div', 'omni-numpy__table-wrap');
        const tableNode = el('table');
        const head = el('thead'); const headRow = el('tr');
        table.headers.forEach(headerText => headRow.append(el('th', undefined, headerText))); head.append(headRow);
        const body = el('tbody');
        table.rows.forEach((row, index) => {
            const tr = el('tr'); tr.tabIndex = 0;
            row.forEach(value => tr.append(el('td', undefined, String(value))));
            const activate = (): void => { activeArray = index; arraySelect.value = String(index); view = 'data'; resetSlices(); render(); };
            on(tr, 'click', activate);
            on(tr, 'keydown', event => { if ((event as KeyboardEvent).key === 'Enter') activate(); });
            body.append(tr);
        });
        tableNode.append(head, body); wrap.append(tableNode); content.append(wrap);
    };

    const resetSlices = (): void => {
        slices.splice(0);
        const array = model.arrays[activeArray];
        if (array) for (let axis = 0; axis < Math.max(0, array.shape.length - 2); axis++) slices.push(0);
    };

    const renderData = (): void => {
        const array = model.arrays[activeArray];
        if (!array) { content.append(el('div', 'omni-numpy__empty', t('numpy.noData'))); return; }
        const details = el('section', 'omni-numpy__details');
        for (const [label, value] of [
            ['dtype', array.dtype], ['shape', formatShape(array.shape)], ['order', array.fortranOrder ? 'Fortran' : 'C'],
            ['elements', String(array.elements)], ['bytes', String(array.byteLength)], ['kind', array.kind]
        ]) {
            const item = el('div'); item.append(el('span', undefined, label), el('strong', undefined, value)); details.append(item);
        }
        content.append(details);
        if (!array.values.length && array.elements > 0) {
            content.append(el('div', 'omni-numpy__empty', t('numpy.previewUnavailable'))); return;
        }
        if (array.shape.length > 2) content.append(renderSliceControls(array));
        content.append(renderGrid(array));
    };

    const renderSliceControls = (array: NumpyArray): HTMLElement => {
        const panel = el('section', 'omni-numpy__slices');
        panel.append(el('span', 'omni-numpy__slices-label', t('numpy.slice')));
        for (let axis = 0; axis < array.shape.length - 2; axis++) {
            const label = el('label'); label.append(el('span', undefined, `axis ${axis}`));
            const input = el('input') as HTMLInputElement;
            input.type = 'number'; input.min = '0'; input.max = String(Math.max(0, array.shape[axis]! - 1)); input.value = String(slices[axis] ?? 0);
            on(input, 'change', () => {
                slices[axis] = Math.max(0, Math.min(array.shape[axis]! - 1, Number.parseInt(input.value, 10) || 0));
                render();
            });
            label.append(input); panel.append(label);
        }
        return panel;
    };

    const renderGrid = (array: NumpyArray): HTMLElement => {
        const section = el('section', 'omni-numpy__grid-section');
        const rank = array.shape.length;
        const rowCount = rank >= 2 ? array.shape[rank - 2]! : rank === 1 ? array.shape[0]! : 1;
        const columnCount = rank >= 2 ? array.shape[rank - 1]! : 1;
        const shownRows = Math.min(rowCount, NUMPY_GRID_ROW_LIMIT);
        const shownColumns = Math.min(columnCount, NUMPY_GRID_COLUMN_LIMIT);
        const caption = el('div', 'omni-numpy__caption', t('numpy.gridShown', {
            rows: shownRows, totalRows: rowCount, columns: shownColumns, totalColumns: columnCount
        }));
        const wrap = el('div', 'omni-numpy__table-wrap');
        const table = el('table', 'omni-numpy__grid');
        const head = el('thead'); const headRow = el('tr'); headRow.append(el('th', undefined, '#'));
        if (rank === 1) headRow.append(el('th', undefined, 'value'));
        else for (let column = 0; column < shownColumns; column++) headRow.append(el('th', undefined, String(column)));
        head.append(headRow); table.append(head);
        const body = el('tbody');
        for (let row = 0; row < shownRows; row++) {
            const tr = el('tr'); tr.append(el('th', undefined, String(row)));
            if (rank === 1) tr.append(valueCell(array, [row]));
            else {
                for (let column = 0; column < shownColumns; column++) {
                    const coordinates = rank === 0 ? [] : [...slices, row, column];
                    tr.append(valueCell(array, coordinates));
                }
            }
            body.append(tr);
        }
        table.append(body); wrap.append(table); section.append(caption, wrap); return section;
    };

    const valueCell = (array: NumpyArray, coordinates: number[]): HTMLTableCellElement => {
        const index = storageIndex(array.shape, coordinates, array.fortranOrder);
        const value = index < array.values.length ? String(array.values[index]) : '…';
        const td = el('td', undefined, value); td.title = `[${coordinates.join(', ')}] = ${value}`; return td;
    };

    const render = (): void => {
        content.replaceChildren();
        dataButton.setAttribute('aria-pressed', String(view === 'data'));
        arraysButton.setAttribute('aria-pressed', String(view === 'arrays'));
        arraySelect.hidden = model.arrays.length === 0;
        if (view === 'data') renderData(); else renderArrays();
    };

    on(arraySelect, 'change', () => { activeArray = Number(arraySelect.value); view = 'data'; resetSlices(); render(); });
    on(dataButton, 'click', () => { view = 'data'; render(); });
    on(arraysButton, 'click', () => { view = 'arrays'; render(); });
    on(copyButton, 'click', () => {
        if (!ctx.clipboard) return;
        void ctx.clipboard.writeText(JSON.stringify(model, null, 2)).catch(error => ctx.logger.log('error', `NumPy JSON copy failed: ${String(error)}`));
    });
    resetSlices(); render();

    return {
        dispose(): void {
            disposers.splice(0).forEach(dispose => dispose()); frame.remove(); style?.remove();
            if (!(root instanceof ShadowRoot)) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--numpy');
        }
    };
}

function storageIndex(shape: readonly number[], coordinates: readonly number[], fortranOrder: boolean): number {
    if (shape.length === 0) return 0;
    if (fortranOrder) {
        let index = 0; let stride = 1;
        for (let axis = 0; axis < shape.length; axis++) { index += (coordinates[axis] ?? 0) * stride; stride *= shape[axis]!; }
        return index;
    }
    let index = 0;
    for (let axis = 0; axis < shape.length; axis++) index = index * shape[axis]! + (coordinates[axis] ?? 0);
    return index;
}

function formatShape(shape: readonly number[]): string { return shape.length ? shape.join(' × ') : 'scalar'; }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
}
