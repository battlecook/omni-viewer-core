import { declaredZipUncompressedBytes } from '../../parsers/zip-scan.js';

export interface ZipEntry { dir: boolean; async(type: 'string'): Promise<string>; async(type: 'uint8array'): Promise<Uint8Array> }
export interface ZipArchive { file(path: string): ZipEntry | null; file(path: string, data: string): ZipArchive; forEach(callback: (path: string, entry: ZipEntry) => void): void; generateAsync(options: { type: 'uint8array' }): Promise<Uint8Array> }
export interface ZipModule { loadAsync(data: Uint8Array): Promise<ZipArchive> }
export interface SheetModule { read(data: Uint8Array, options: { type: 'array' }): { SheetNames: string[]; Sheets: Record<string, unknown> }; utils: { sheet_to_json(sheet: unknown, options: { header: 1; blankrows: false }): unknown[][] } }
export interface ChartModel { title: string; categories: string[]; series: Array<{ name: string; color: string; values: number[] }> }
export type DocxPlaceholder = { token: string; kind: 'chart'; chart: ChartModel } | { token: string; kind: 'sheet'; title: string; rows: string[][] };
export interface DocxPreprocessResult { data: Uint8Array; placeholders: DocxPlaceholder[] }

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

export async function preprocessDocx(data: Uint8Array, zipModule: ZipModule, sheetModule?: SheetModule, maxDecompressedBytes: number = DOCX_MAX_DECOMPRESSED_BYTES): Promise<DocxPreprocessResult> {
    // Zip-bomb guard: reject on the central directory's declared total before
    // any inflate, then keep a running budget over what we actually extract
    // (headers can lie about per-entry sizes).
    const declared = declaredZipUncompressedBytes(data);
    if (declared !== null && declared > maxDecompressedBytes) throw new DocxDecompressionLimitError();
    let budget = maxDecompressedBytes;
    const spend = <T extends string | Uint8Array>(value: T): T => { budget -= value.length; if (budget < 0) throw new DocxDecompressionLimitError(); return value; };
    const zip = await zipModule.loadAsync(data); const placeholders: DocxPlaceholder[] = []; let changed = false;
    const xmlFiles: string[] = []; zip.forEach((path, entry) => { if (!entry.dir && /^word\/.*\.xml$/i.test(path)) xmlFiles.push(path); });
    for (const path of xmlFiles) { const entry = zip.file(path); if (!entry) continue; const xml = spend(await entry.async('string')); const normalized = xml.replace(/<mc:AlternateContent[\s\S]*?<mc:Fallback>([\s\S]*?)<\/mc:Fallback>[\s\S]*?<\/mc:AlternateContent>/g, '$1'); if (normalized !== xml) { zip.file(path, normalized); changed = true; } }
    const documentEntry = zip.file('word/document.xml'), relsEntry = zip.file('word/_rels/document.xml.rels');
    if (!documentEntry || !relsEntry) return { data, placeholders };
    let documentXml = spend(await documentEntry.async('string')); const relsXml = spend(await relsEntry.async('string'));
    const relationships = new Map<string, { target: string; type: string }>();
    for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/?\s*>/g)) { const values = attrs(match[0]); const id = values.get('Id'), target = values.get('Target'); if (id && target) relationships.set(id, { target: resolvePath('word/document.xml', target), type: values.get('Type') ?? '' }); }
    let index = 0;
    const chartRegex = /<w:drawing[\s\S]*?<c:chart\b[^>]*r:id="([^"]+)"[\s\S]*?<\/w:drawing>/g; let output = '', cursor = 0;
    for (const match of documentXml.matchAll(chartRegex)) { const start = match.index ?? 0; output += documentXml.slice(cursor, start); cursor = start + match[0].length; const relation = relationships.get(match[1] ?? ''); const entry = relation ? zip.file(relation.target) : null; const chart = entry ? parseChart(spend(await entry.async('string'))) : null; if (!chart) { output += match[0]; continue; } const token = `__OMNI_WORD_CHART_${index++}__`; placeholders.push({ token, kind: 'chart', chart }); output += `<w:r><w:t xml:space="preserve">${token}</w:t></w:r>`; changed = true; }
    documentXml = output + documentXml.slice(cursor);
    if (sheetModule) {
        const objectRegex = /<w:object[\s\S]*?<o:OLEObject\b[^>]*r:id="([^"]+)"[\s\S]*?<\/w:object>/g; output = ''; cursor = 0;
        for (const match of documentXml.matchAll(objectRegex)) { const start = match.index ?? 0; output += documentXml.slice(cursor, start); cursor = start + match[0].length; const relation = relationships.get(match[1] ?? ''); const entry = relation ? zip.file(relation.target) : null; if (!entry || !/package|oleObject/i.test(relation?.type ?? '')) { output += match[0]; continue; } try { const bytes = spend(await entry.async('uint8array')); if ((declaredZipUncompressedBytes(bytes) ?? 0) > budget) { output += match[0]; continue; } const workbook = sheetModule.read(bytes, { type: 'array' }); const name = workbook.SheetNames[0]; const sheet = name ? workbook.Sheets[name] : undefined; if (!name || !sheet) { output += match[0]; continue; } const rows = sheetModule.utils.sheet_to_json(sheet, { header: 1, blankrows: false }).slice(0, 10).map((row) => row.slice(0, 10).map((cell) => String(cell ?? ''))); const token = `__OMNI_WORD_SHEET_${index++}__`; placeholders.push({ token, kind: 'sheet', title: name, rows }); output += `<w:r><w:t xml:space="preserve">${token}</w:t></w:r>`; changed = true; } catch { output += match[0]; } }
        documentXml = output + documentXml.slice(cursor);
    }
    if (changed) { zip.file('word/document.xml', documentXml); return { data: await zip.generateAsync({ type: 'uint8array' }), placeholders }; }
    return { data, placeholders };
}

export function parseChart(xml: string): ChartModel | null {
    const seriesXml = [...xml.matchAll(/<c:ser>([\s\S]*?)<\/c:ser>/g)].map((match) => match[1] ?? ''); if (!seriesXml.length) return null;
    const points = (block: string, numeric: boolean): Array<string | number> => { const result: Array<string | number> = []; for (const match of block.matchAll(/<c:pt\b[^>]*idx="(\d+)"[^>]*>[\s\S]*?<c:v>([\s\S]*?)<\/c:v>[\s\S]*?<\/c:pt>/g)) result[Number(match[1])] = numeric ? Number(match[2]) || 0 : entities(match[2] ?? ''); return result; };
    const parsed = seriesXml.map((series, index) => { const cat = series.match(/<c:cat[\s\S]*?<\/c:cat>/)?.[0] ?? ''; const val = series.match(/<c:val[\s\S]*?<\/c:val>/)?.[0] ?? ''; const name = entities(series.match(/<c:tx[\s\S]*?<c:v>([\s\S]*?)<\/c:v>/)?.[1] ?? `Series ${index + 1}`); const color = `#${series.match(/<a:srgbClr\b[^>]*val="([0-9a-f]{6})"/i)?.[1] ?? ['004586','ff420e','ffd320','579d1c'][index % 4]}`; return { name, color, categories: points(cat, false).map(String), values: points(val, true).map(Number) }; });
    const categories = parsed[0]?.categories ?? []; if (!categories.length) return null; const title = entities([...xml.matchAll(/<c:title[\s\S]*?<a:t>([\s\S]*?)<\/a:t>[\s\S]*?<\/c:title>/g)].map((match) => match[1]).join(' ')); return { title, categories, series: parsed.map(({ name, color, values }) => ({ name, color, values })) };
}
