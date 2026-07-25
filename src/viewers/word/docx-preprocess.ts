import { declaredZipUncompressedBytes } from '../../parsers/zip-scan.js';
import type { Diagnostic } from '../../parsers/types.js';

export interface ZipEntry { dir: boolean; async(type: 'string'): Promise<string>; async(type: 'uint8array'): Promise<Uint8Array> }
export interface ZipArchive { file(path: string): ZipEntry | null; file(path: string, data: string | Uint8Array): ZipArchive; forEach(callback: (path: string, entry: ZipEntry) => void): void; generateAsync(options: { type: 'uint8array' }): Promise<Uint8Array> }
export interface ZipModule { loadAsync(data: Uint8Array): Promise<ZipArchive> }
export interface SheetModule { read(data: Uint8Array, options: { type: 'array' }): { SheetNames: string[]; Sheets: Record<string, unknown> }; utils: { sheet_to_json(sheet: unknown, options: { header: 1; blankrows: false }): unknown[][] } }
export type ChartType = 'bar' | 'line' | 'pie' | 'unsupported';
export interface ChartModel {
    type: ChartType;
    sourceType: string;
    title: string;
    categories: string[];
    series: Array<{
        name: string;
        color: string;
        values: number[];
        pointColors?: string[];
    }>;
}
export type DocxPlaceholder = { token: string; kind: 'chart'; chart: ChartModel } | { token: string; kind: 'sheet'; title: string; rows: string[][] };
export interface DocxPreprocessResult {
    data: Uint8Array;
    placeholders: DocxPlaceholder[];
    diagnostics: Diagnostic[];
    partial: boolean;
}

export interface DocxPreprocessOptions {
    maxDecompressedBytes?: number;
    maxImageBytes?: number;
    maxEmbeddedFiles?: number;
    embeddedSheets?: boolean;
    sheetModule?: SheetModule;
    loadSheet?: () => Promise<SheetModule>;
    signal?: AbortSignal;
}

/** Default cap on declared/observed uncompressed bytes (input is already
 *  capped at 50 MB by the viewer; this bounds the expansion ratio). */
export const DOCX_MAX_DECOMPRESSED_BYTES = 1024 * 1024 * 1024;

/** Thrown before any inflate when the archive declares more data than the cap
 *  — the word viewer maps it to `diag.word.decompression-limit`. */
export class DocxDecompressionLimitError extends Error {
    constructor() { super('DOCX declares more uncompressed data than the supported limit'); this.name = 'DocxDecompressionLimitError'; }
}

const entities = (value: string): string => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const resolvePath = (base: string, target: string): string => { const stack = base.split('/').slice(0, -1); for (const part of target.split('/')) { if (!part || part === '.') continue; if (part === '..') stack.pop(); else stack.push(part); } return stack.join('/'); };
const attrs = (xml: string): Map<string, string> => new Map([...xml.matchAll(/([\w:]+)="([^"]*)"/g)].map((match) => [match[1] ?? '', match[2] ?? '']));

export async function preprocessDocx(
    data: Uint8Array,
    zipModule: ZipModule,
    sheetOrOptions?: SheetModule | DocxPreprocessOptions,
    legacyMaxDecompressedBytes: number = DOCX_MAX_DECOMPRESSED_BYTES
): Promise<DocxPreprocessResult> {
    const options: DocxPreprocessOptions = isSheetModule(sheetOrOptions)
        ? { sheetModule: sheetOrOptions, maxDecompressedBytes: legacyMaxDecompressedBytes }
        : sheetOrOptions ?? { maxDecompressedBytes: legacyMaxDecompressedBytes };
    const maxDecompressedBytes = options.maxDecompressedBytes ?? DOCX_MAX_DECOMPRESSED_BYTES;
    const diagnostics: Diagnostic[] = [];
    let partial = false;
    const checkpoint = (): void => {
        if (!options.signal?.aborted) return;
        const error = new Error('DOCX preprocessing aborted');
        error.name = 'AbortError';
        throw error;
    };
    // Zip-bomb guard: reject on the central directory's declared total before
    // any inflate, then keep a running budget over what we actually extract
    // (headers can lie about per-entry sizes).
    const declared = declaredZipUncompressedBytes(data);
    if (declared !== null && declared > maxDecompressedBytes) throw new DocxDecompressionLimitError();
    let budget = maxDecompressedBytes;
    const spend = <T extends string | Uint8Array>(value: T): T => { budget -= value.length; if (budget < 0) throw new DocxDecompressionLimitError(); return value; };
    checkpoint();
    const zip = await zipModule.loadAsync(data);
    checkpoint();
    const placeholders: DocxPlaceholder[] = [];
    let changed = false;
    const xmlFiles: string[] = [];
    const mediaFiles: string[] = [];
    zip.forEach((path, entry) => {
        if (entry.dir) return;
        if (/^word\/.*\.xml$/i.test(path)) xmlFiles.push(path);
        if (/^word\/media\//i.test(path)) mediaFiles.push(path);
    });
    for (const path of mediaFiles) {
        checkpoint();
        if (options.maxImageBytes === undefined) break;
        const entry = zip.file(path);
        if (!entry) continue;
        const bytes = spend(await entry.async('uint8array'));
        if (bytes.byteLength <= options.maxImageBytes) continue;
        zip.file(path, new Uint8Array());
        changed = true;
        partial = true;
        diagnostics.push({
            severity: 'warning',
            code: 'limit-exceeded',
            messageKey: 'diag.word.image-limit',
            location: path
        });
    }
    for (const path of xmlFiles) {
        checkpoint();
        const entry = zip.file(path);
        if (!entry) continue;
        const xml = spend(await entry.async('string'));
        const normalized = xml.replace(
            /<mc:AlternateContent\b[\s\S]*?<mc:Choice\b[^>]*>([\s\S]*?)<\/mc:Choice>[\s\S]*?<mc:Fallback>([\s\S]*?)<\/mc:Fallback>[\s\S]*?<\/mc:AlternateContent>/g,
            (whole, choice: string, fallback: string) => {
                if (/<c:chart\b/i.test(choice)) {
                    partial = true;
                    diagnostics.push({
                        severity: 'warning',
                        code: 'chart-fallback-used',
                        messageKey: 'diag.word.chart-fallback-used',
                        location: path
                    });
                }
                return fallback || whole;
            }
        );
        if (normalized !== xml) {
            zip.file(path, normalized);
            changed = true;
        }
    }
    const documentEntry = zip.file('word/document.xml'), relsEntry = zip.file('word/_rels/document.xml.rels');
    if (!documentEntry || !relsEntry) {
        return {
            data: changed ? await zip.generateAsync({ type: 'uint8array' }) : data,
            placeholders,
            diagnostics,
            partial
        };
    }
    checkpoint();
    let documentXml = spend(await documentEntry.async('string')); const relsXml = spend(await relsEntry.async('string'));
    const relationships = new Map<string, { target: string; type: string }>();
    for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/?\s*>/g)) { const values = attrs(match[0]); const id = values.get('Id'), target = values.get('Target'); if (id && target) relationships.set(id, { target: resolvePath('word/document.xml', target), type: values.get('Type') ?? '' }); }
    let index = 0;
    const chartRegex = /<w:drawing[\s\S]*?<c:chart\b[^>]*r:id="([^"]+)"[\s\S]*?<\/w:drawing>/g; let output = '', cursor = 0;
    for (const match of documentXml.matchAll(chartRegex)) {
        checkpoint();
        const start = match.index ?? 0;
        output += documentXml.slice(cursor, start);
        cursor = start + match[0].length;
        const relation = relationships.get(match[1] ?? '');
        const entry = relation ? zip.file(relation.target) : null;
        const chart = entry ? parseChart(spend(await entry.async('string'))) : null;
        if (!chart) {
            output += match[0];
            continue;
        }
        if (
            options.maxEmbeddedFiles !== undefined &&
            placeholders.length >= options.maxEmbeddedFiles
        ) {
            partial = true;
            diagnostics.push({
                severity: 'warning',
                code: 'limit-exceeded',
                messageKey: 'diag.word.embedded-limit',
                ...(relation ? { location: relation.target } : {})
            });
            output += '<w:r/>';
            changed = true;
            continue;
        }
        if (chart.type === 'unsupported') {
            partial = true;
            diagnostics.push({
                severity: 'warning',
                code: 'unsupported-feature',
                messageKey: 'diag.word.unsupported-chart',
                args: { type: chart.sourceType },
                ...(relation ? { location: relation.target } : {})
            });
        }
        const token = `__OMNI_WORD_CHART_${index++}__`;
        placeholders.push({ token, kind: 'chart', chart });
        output += `<w:r><w:t xml:space="preserve">${token}</w:t></w:r>`;
        changed = true;
    }
    documentXml = output + documentXml.slice(cursor);
    const objectRegex = /<w:object[\s\S]*?<o:OLEObject\b[^>]*r:id="([^"]+)"[\s\S]*?<\/w:object>/g;
    output = '';
    cursor = 0;
    let sheetModule = options.sheetModule;
    let sheetLoadAttempted = Boolean(sheetModule);
    let workbookDisabledReported = false;
    for (const match of documentXml.matchAll(objectRegex)) {
        checkpoint();
        const start = match.index ?? 0;
        output += documentXml.slice(cursor, start);
        cursor = start + match[0].length;
        const relation = relationships.get(match[1] ?? '');
        const entry = relation ? zip.file(relation.target) : null;
        if (!entry || !/package|oleObject/i.test(relation?.type ?? '')) {
            output += match[0];
            continue;
        }
        if (
            options.maxEmbeddedFiles !== undefined &&
            placeholders.length >= options.maxEmbeddedFiles
        ) {
            partial = true;
            diagnostics.push({
                severity: 'warning',
                code: 'limit-exceeded',
                messageKey: 'diag.word.embedded-limit',
                ...(relation ? { location: relation.target } : {})
            });
            output += '<w:r/>';
            changed = true;
            continue;
        }
        if (!sheetLoadAttempted) {
            sheetLoadAttempted = true;
            if (options.embeddedSheets !== false && options.loadSheet) {
                try {
                    sheetModule = await options.loadSheet();
                    checkpoint();
                } catch (error) {
                    if (isAbortError(error) || options.signal?.aborted) throw error;
                    diagnostics.push({
                        severity: 'warning',
                        code: 'embedded-workbook-disabled',
                        messageKey: 'diag.word.embedded-workbook-disabled',
                        ...(relation ? { location: relation.target } : {})
                    });
                    partial = true;
                    workbookDisabledReported = true;
                }
            }
        }
        if (!sheetModule) {
            if (!workbookDisabledReported) {
                diagnostics.push({
                    severity: 'warning',
                    code: 'embedded-workbook-disabled',
                    messageKey: 'diag.word.embedded-workbook-disabled',
                    ...(relation ? { location: relation.target } : {})
                });
                partial = true;
                workbookDisabledReported = true;
            }
            output += match[0];
            continue;
        }
        try {
            const bytes = spend(await entry.async('uint8array'));
            if ((declaredZipUncompressedBytes(bytes) ?? 0) > budget) {
                output += match[0];
                continue;
            }
            const workbook = sheetModule.read(bytes, { type: 'array' });
            const name = workbook.SheetNames[0];
            const sheet = name ? workbook.Sheets[name] : undefined;
            if (!name || !sheet) {
                output += match[0];
                continue;
            }
            const rows = sheetModule.utils.sheet_to_json(sheet, { header: 1, blankrows: false })
                .slice(0, 10)
                .map((row) => row.slice(0, 10).map((cell) => String(cell ?? '')));
            const token = `__OMNI_WORD_SHEET_${index++}__`;
            placeholders.push({ token, kind: 'sheet', title: name, rows });
            output += `<w:r><w:t xml:space="preserve">${token}</w:t></w:r>`;
            changed = true;
        } catch (error) {
            if (isAbortError(error) || options.signal?.aborted) throw error;
            diagnostics.push({
                severity: 'warning',
                code: 'unsupported-feature',
                messageKey: 'diag.word.embedded-workbook-failed',
                ...(relation ? { location: relation.target } : {})
            });
            partial = true;
            output += match[0];
        }
    }
    documentXml = output + documentXml.slice(cursor);
    checkpoint();
    if (changed) {
        zip.file('word/document.xml', documentXml);
        return {
            data: await zip.generateAsync({ type: 'uint8array' }),
            placeholders,
            diagnostics,
            partial
        };
    }
    return { data, placeholders, diagnostics, partial };
}

export function parseChart(xml: string): ChartModel | null {
    const sourceType = xml.match(/<c:([A-Za-z0-9]+Chart)\b/)?.[1]
        ?? (/<c:ser>/i.test(xml) ? 'barChart' : '');
    if (!sourceType) return null;
    const normalizedType = sourceType.toLowerCase();
    const type: ChartType = normalizedType === 'barchart' || normalizedType === 'bar3dchart'
        ? 'bar'
        : normalizedType === 'linechart' || normalizedType === 'line3dchart'
            ? 'line'
            : normalizedType === 'piechart' || normalizedType === 'pie3dchart' || normalizedType === 'doughnutchart'
                ? 'pie'
                : 'unsupported';
    const seriesXml = [...xml.matchAll(/<c:ser>([\s\S]*?)<\/c:ser>/g)].map((match) => match[1] ?? '');
    const points = (block: string, numeric: boolean): Array<string | number> => { const result: Array<string | number> = []; for (const match of block.matchAll(/<c:pt\b[^>]*idx="(\d+)"[^>]*>[\s\S]*?<c:v>([\s\S]*?)<\/c:v>[\s\S]*?<\/c:pt>/g)) result[Number(match[1])] = numeric ? Number(match[2]) || 0 : entities(match[2] ?? ''); return result; };
    const parsed = seriesXml.map((series, index) => {
        const cat = series.match(/<c:cat[\s\S]*?<\/c:cat>/)?.[0] ?? '';
        const val = series.match(/<c:val[\s\S]*?<\/c:val>/)?.[0] ?? '';
        const name = entities(series.match(/<c:tx[\s\S]*?<c:v>([\s\S]*?)<\/c:v>/)?.[1] ?? `Series ${index + 1}`);
        const color = `#${series.match(/<a:srgbClr\b[^>]*val="([0-9a-f]{6})"/i)?.[1] ?? ['004586','ff420e','ffd320','579d1c'][index % 4]}`;
        const pointColors: string[] = [];
        for (const point of series.matchAll(/<c:dPt>([\s\S]*?)<\/c:dPt>/g)) {
            const pointXml = point[1] ?? '';
            const pointIndex = Number(pointXml.match(/<c:idx\b[^>]*val="(\d+)"/)?.[1]);
            const pointColor = pointXml.match(/<a:srgbClr\b[^>]*val="([0-9a-f]{6})"/i)?.[1];
            if (Number.isFinite(pointIndex) && pointColor) pointColors[pointIndex] = `#${pointColor}`;
        }
        return {
            name,
            color,
            categories: points(cat, false).map(String),
            values: points(val, true).map(Number),
            ...(pointColors.length ? { pointColors } : {})
        };
    });
    const categories = parsed[0]?.categories ?? [];
    const titleXml = xml.match(/<c:title\b[\s\S]*?<\/c:title>/)?.[0] ?? '';
    const title = entities(
        [...titleXml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
            .map((match) => match[1] ?? '')
            .join('')
    );
    const renderableType = seriesXml.length > 0 && categories.length > 0 ? type : 'unsupported';
    return {
        type: renderableType,
        sourceType,
        title,
        categories,
        series: parsed.map(({ name, color, values, pointColors }) => ({
            name,
            color,
            values,
            ...(pointColors ? { pointColors } : {})
        }))
    };
}

function isSheetModule(value: SheetModule | DocxPreprocessOptions | undefined): value is SheetModule {
    return Boolean(value && 'read' in value && 'utils' in value);
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}
