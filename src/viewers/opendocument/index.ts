import type { HostContext } from '../../host/index.js';
import type { CompressedPreviewOptions } from '../../parsers/file-preview.js';
import { parseOpenDocument, type OpenDocumentBlock, type OpenDocumentShape } from '../../parsers/opendocument/index.js';
import { OPENDOCUMENT_VIEWER_DESCRIPTOR } from '../../registry/file-previews.js';
import { mountFilePreview, observePreviewWidth, previewPager, svgElement, type PreviewUi, type FilePreviewOptions } from '../file-preview.js';
import type { ViewerInput } from '../types.js';

export * from '../../parsers/opendocument/index.js';
export const OPENDOCUMENT_VIEWER_META = { ...OPENDOCUMENT_VIEWER_DESCRIPTOR, inputOwnership: 'borrows' as const };

function appendBlocks(ui: PreviewUi, container: HTMLElement, blocks: OpenDocumentBlock[]) {
    for (const block of blocks) {
        if (block.kind === 'list') {
            const list = ui.el('ul');
            for (const item of block.items) {
                const entry = ui.el('li');
                appendBlocks(ui, entry, item);
                list.append(entry);
            }
            container.append(list);
        } else if (block.kind === 'table') {
            const table = ui.el('table');
            const tbody = table.createTBody();
            for (const values of block.rows) {
                const row = tbody.insertRow();
                for (const value of values) {
                    const cell = row.insertCell();
                    cell.textContent = value.text;
                    cell.colSpan = value.colSpan;
                    cell.rowSpan = value.rowSpan;
                }
            }
            container.append(table);
        } else {
            container.append(ui.el(block.kind === 'heading' ? `h${block.level}` as 'h1' : 'p', block.text));
        }
    }
}
function appendShape(ui: PreviewUi, slide: HTMLElement, shape: OpenDocumentShape) {
    const node = ui.el('div', undefined, 'preview-shape');
    const { x, y, width, height } = shape;
    if (shape.kind === 'line') {
        const dx = Math.abs(width), dy = Math.abs(height);
        const w = dx + 2, h = dy + 2;
        const svg = svgElement(ui.doc, 'svg', { width: w, height: h, 'aria-hidden': 'true' });
        svg.append(svgElement(ui.doc, 'line', {
            x1: 1 + (width < 0 ? dx : 0), y1: 1 + (height < 0 ? dy : 0),
            x2: 1 + (width < 0 ? 0 : dx), y2: 1 + (height < 0 ? 0 : dy),
            stroke: shape.stroke || '#555', 'stroke-width': 2
        }));
        Object.assign(node.style, {
            left: `${Math.min(x, x + width) - 1}px`, top: `${Math.min(y, y + height) - 1}px`,
            width: `${w}px`, height: `${h}px`
        });
        node.append(svg);
    } else {
        Object.assign(node.style, {
            left: `${x}px`, top: `${y}px`, width: `${width > 0 ? width : 280}px`, height: `${height > 0 ? height : 90}px`,
            backgroundColor: shape.fill === 'none' ? 'transparent' : shape.fill || (shape.kind === 'frame' ? 'transparent' : '#edf4fb'),
            border: shape.stroke === 'none' ? 'none' : shape.stroke ? `1px solid ${shape.stroke}` : shape.kind === 'frame' ? '' : '1px solid #64748b',
            borderRadius: shape.kind === 'ellipse' ? '50%' : ''
        });
        appendBlocks(ui, node, shape.blocks);
    }
    slide.append(node);
    if (shape.kind === 'line' && shape.blocks.length) {
        const label = ui.el('div', undefined, 'preview-shape preview-line-label');
        label.style.left = `${x + width / 2}px`;
        label.style.top = `${y + height / 2}px`;
        appendBlocks(ui, label, shape.blocks);
        slide.append(label);
    }
}
export async function mountOpenDocumentViewer(input: ViewerInput, container: HTMLElement, ctx: HostContext, options: FilePreviewOptions & CompressedPreviewOptions = {}) {
    const { result } = await parseOpenDocument(input.data, options);
    return mountFilePreview(input, container, ctx, options, 'opendocument', result, (ui, model) => {
        if (model.format === 'odt') {
            const article = ui.el('article', undefined, 'preview-document');
            appendBlocks(ui, article, model.blocks);
            if (!model.blocks.length) article.append(ui.el('p', ui.t('preview.empty')));
            ui.body.append(article);
            return;
        }
        const { t } = ui;
        const tools = ui.el('div', undefined, 'preview-toolbar');
        const title = ui.el('h3');
        const scroll = ui.el('div', undefined, 'preview-scroll');
        const wrapper = ui.el('div');
        scroll.tabIndex = 0;
        scroll.append(wrapper);
        let slide: HTMLElement | undefined, width = 960, height = 540, zoom = 1;
        const resize = (value: number) => {
            if (!slide) return;
            zoom = Math.min(6, Math.max(.25, value));
            const scale = Math.min(1, (scroll.clientWidth || 800) / width, 560 / height) * zoom;
            Object.assign(wrapper.style, { width: `${width * scale}px`, height: `${height * scale}px`, overflow: 'hidden' });
            slide.style.transform = `scale(${scale})`;
        };
        const pager = previewPager(ui, tools, index => {
            const page = model.pages[index];
            if (!page) {
                wrapper.replaceChildren(ui.el('p', t('preview.empty')));
                return;
            }
            width = page.width; height = page.height;
            title.textContent = page.name || t('drawio.page', { index: index + 1 });
            slide = ui.el('article', undefined, 'preview-slide');
            slide.setAttribute('aria-label', title.textContent);
            Object.assign(slide.style, { width: `${width}px`, height: `${height}px` });
            for (const shape of page.shapes) appendShape(ui, slide, shape);
            wrapper.replaceChildren(slide);
            resize(1);
            scroll.scrollTop = scroll.scrollLeft = 0;
        });
        tools.append(ui.button(t('preview.zoomIn'), () => resize(zoom * 1.4)), ui.button(t('preview.zoomOut'), () => resize(zoom / 1.4)), ui.button(t('preview.fit'), () => resize(1)));
        ui.body.append(tools, title, scroll);
        pager.reset(model.pages.length);
        return observePreviewWidth(scroll, () => resize(zoom));
    });
}
