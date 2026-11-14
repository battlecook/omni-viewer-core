import type { HostContext } from '../../host/index.js';
import { parseSbom } from '../../parsers/sbom/index.js';
import { SBOM_VIEWER_DESCRIPTOR } from '../../registry/file-previews.js';
import { mountFilePreview, previewDetails, previewLines, renderPreviewTable, type FilePreviewOptions } from '../file-preview.js';
import type { ViewerInput } from '../types.js';

export * from '../../parsers/sbom/index.js';
export const SBOM_VIEWER_META = { ...SBOM_VIEWER_DESCRIPTOR, inputOwnership: 'borrows' as const };

export async function mountSbomViewer(input: ViewerInput, container: HTMLElement, ctx: HostContext, options: FilePreviewOptions = {}) {
    return mountFilePreview(input, container, ctx, options, 'sbom', parseSbom(input.data, options).result, (ui, model) => {
        const { t } = ui;
        ui.body.append(ui.el('p', t('sbom.summary', { version: model.specVersion, count: model.components.length })));
        if (model.subject) ui.body.append(ui.el('p', model.subject));
        const subject = model.subjectComponent;
        const rows = subject && (!subject.ref || !model.components.some(component => component.ref === subject.ref))
            ? [subject, ...model.components] : model.components;
        const names = new Map(rows.filter(component => component.ref).map(component => [
            component.ref, [component.group, component.name, component.version].filter(Boolean).join(' / ')
        ]));
        function* dependencyLabels(refs: readonly string[]): Iterable<string> {
            for (const ref of refs) yield names.get(ref) ?? ref;
        }
        const dependencies = (componentRef: string) => {
            const refs = model.dependencies.get(componentRef);
            if (!refs) return t('sbom.dependenciesUnknown');
            return refs.length ? previewLines(dependencyLabels(refs)) : t('sbom.dependenciesNone');
        };
        const headers = [t('preview.name'), t('sbom.version'), t('sbom.type'), t('sbom.license'), t('sbom.purl')];
        renderPreviewTable(ui, {
            rows, headers,
            cells: component => [
                [component.group, component.name].filter(Boolean).join(' / '),
                component.version, component.type, component.licenses.join(', '), component.purl
            ],
            details: component => previewDetails(ui, [
                [headers[0]!, component.name], [headers[1]!, component.version], [headers[2]!, component.type],
                [headers[3]!, component.licenses.join(', ')], [headers[4]!, component.purl],
                [t('preview.description'), component.description],
                [t('sbom.dependencies'), dependencies(component.ref)]
            ]),
            filters: [{ label: headers[2]!, value: component => component.type }, { label: headers[3]!, value: component => component.licenses }]
        });
    });
}
