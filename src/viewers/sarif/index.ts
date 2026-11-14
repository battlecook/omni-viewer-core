import type { HostContext } from '../../host/index.js';
import { parseSarif, type SarifFinding } from '../../parsers/sarif/index.js';
import { SARIF_VIEWER_DESCRIPTOR } from '../../registry/file-previews.js';
import { mountFilePreview, previewDetails, previewLines, renderPreviewTable, type FilePreviewOptions } from '../file-preview.js';
import type { ViewerInput } from '../types.js';

export * from '../../parsers/sarif/index.js';
export const SARIF_VIEWER_META = { ...SARIF_VIEWER_DESCRIPTOR, inputOwnership: 'borrows' as const };

const labelLocation = ({ file, line, column }: SarifFinding['locations'][number]) =>
    [file, line, column].filter(value => value !== undefined && value !== '').join(':');

export async function mountSarifViewer(input: ViewerInput, container: HTMLElement, ctx: HostContext, options: FilePreviewOptions = {}) {
    return mountFilePreview(input, container, ctx, options, 'sarif', parseSarif(input.data, options).result, (ui, model) => {
        const { t } = ui;
        const levels = new Map<string, number>();
        for (const row of model.findings) levels.set(row.level, (levels.get(row.level) ?? 0) + 1);
        const level = (value: string) => ['error', 'warning', 'note', 'none'].includes(value) ? t(`sarif.${value}`) : value;
        ui.body.append(ui.el('p', t('sarif.summary', { runs: model.runCount, count: model.findings.length })));
        if (levels.size) ui.body.append(ui.el('p', [...levels].map(([name, count]) => `${level(name)} ${count}`).join(' · ')));
        const headings = [t('preview.message'), t('sarif.level'), t('sarif.rule'), t('preview.file'), t('sarif.tool')];
        renderPreviewTable(ui, {
            rows: model.findings,
            headers: headings,
            cells: row => [row.message, level(row.level), row.rule, row.locations[0] ? labelLocation(row.locations[0]) : '', row.tool],
            details: row => previewDetails(ui, [
                [headings[0]!, row.message], [headings[1]!, level(row.level)], [headings[2]!, row.rule],
                [headings[3]!, previewLines(row.locations.map(labelLocation))], [headings[4]!, row.tool],
                [t('preview.description'), row.ruleDescription]
            ]),
            filters: [
                { label: t('sarif.level'), value: row => row.level, format: level },
                { label: t('sarif.rule'), value: row => row.rule },
                { label: t('preview.file'), value: row => row.locations.map(location => location.file) },
                { label: t('sarif.tool'), value: row => row.tool }
            ]
        });
    });
}
