import type { FileSaveService, HostContext } from '../../host/index.js';
import { safeEmlFileName } from '../../parsers/eml/index.js';
import { parseMsg } from '../../parsers/msg/index.js';
import { MSG_VIEWER_DESCRIPTOR } from '../../registry/file-previews.js';
import { mountFilePreview, previewDetails, type FilePreviewOptions } from '../file-preview.js';
import { HTML_PREVIEW_MAX_BYTES, HTML_PREVIEW_MAX_DELIMITERS, htmlPreviewDocument } from '../html/index.js';
import { utf8ByteLength } from '../../parsers/types.js';
import type { ViewerInput } from '../types.js';

export * from '../../parsers/msg/index.js';
export const MSG_VIEWER_META = { ...MSG_VIEWER_DESCRIPTOR, inputOwnership: 'borrows' as const };
export type MsgViewerContext = HostContext & { save?: FileSaveService };

function boundedHtml(html: string): boolean {
    if (utf8ByteLength(html) > HTML_PREVIEW_MAX_BYTES) return false;
    let tags = 0;
    for (let at = html.indexOf('<'); at >= 0; at = html.indexOf('<', at + 1)) {
        if (++tags > HTML_PREVIEW_MAX_DELIMITERS) return false;
    }
    return true;
}

export async function mountMsgViewer(input: ViewerInput, container: HTMLElement, ctx: MsgViewerContext, options: FilePreviewOptions = {}) {
    return mountFilePreview(input, container, ctx, options, 'msg', parseMsg(input.data, options).result, (ui, model) => {
        const { t } = ui;
        ui.body.append(ui.el('h3', model.subject || t('eml.noSubject')), previewDetails(ui, [
            [t('msg.from'), model.from], [t('msg.to'), model.to], [t('msg.cc'), model.cc], [t('msg.date'), model.date]
        ]));
        const toolbar = ui.el('div', undefined, 'preview-toolbar');
        const body = ui.el('div');
        ui.body.append(toolbar, body);
        let frame: HTMLIFrameElement | undefined;
        if (model.html && boundedHtml(model.html)) {
            frame = ui.el('iframe');
            frame.title = t('eml.html');
            frame.setAttribute('sandbox', '');
            frame.referrerPolicy = 'no-referrer';
            frame.srcdoc = htmlPreviewDocument(model.html);
        } else if (model.html) {
            body.append(ui.el('p', t('eml.htmlUnavailable')));
        }
        const text = model.text ? ui.el('pre', model.text) : undefined;
        if (frame && text) {
            const choose = (html: boolean) => {
                body.replaceChildren(html ? frame! : text);
                htmlButton.setAttribute('aria-pressed', String(html));
                textButton.setAttribute('aria-pressed', String(!html));
            };
            const htmlButton = ui.button(t('eml.html'), () => choose(true));
            const textButton = ui.button(t('eml.text'), () => choose(false));
            toolbar.append(htmlButton, textButton);
            choose(true);
        } else if (frame || text) body.append((frame ?? text)!);
        else body.append(ui.el('p', t('eml.noBody')));
        let disposed = false;
        if (model.attachments.length) {
            ui.body.append(ui.el('h3', t('eml.attachments', { count: model.attachments.length })));
            const list = ui.el('ul');
            const status = ui.el('p', undefined, 'preview-warning');
            status.setAttribute('role', 'status');
            for (const attachment of model.attachments) {
                const name = safeEmlFileName(attachment.name);
                const row = ui.el('li', `${name} · ${attachment.size} B `);
                const button = ui.button(t('eml.saveAttachment'), () => {
                    if (!ctx.save || !attachment.data) return;
                    button.disabled = true;
                    void ctx.save.saveFile(name, new Uint8Array(attachment.data), 'application/octet-stream')
                        .catch(() => { if (!disposed) status.textContent = t('eml.saveFailed'); })
                        .finally(() => { if (!disposed) button.disabled = false; });
                });
                button.disabled = !ctx.save || !attachment.data;
                button.setAttribute('aria-label', t('eml.saveNamedAttachment', { name }));
                row.append(button);
                list.append(row);
            }
            ui.body.append(list, status);
        }
        return () => { disposed = true; frame?.removeAttribute('srcdoc'); };
    });
}
