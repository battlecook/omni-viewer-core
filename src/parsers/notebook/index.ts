// nbformat v4 contract parser. Never runs a kernel or trusts stored outputs.
import { parseJson, type JsonNode } from '../json/index.js';
import { DEFAULT_LIMITS, LimitTracker, decodeUtf8, utf8ByteLength } from '../types.js';
import type { Diagnostic, ParseOptions, ParseOutcome, ParseResult } from '../types.js';
import type { NotebookCell, NotebookDocument, NotebookOutput, NotebookRepresentation } from './model.js';

export type { NotebookCell, NotebookDocument, NotebookOutput, NotebookRepresentation } from './model.js';
export const NOTEBOOK_INPUT_OWNERSHIP = 'borrows' as const;
export const NOTEBOOK_DEFAULT_MAX_CELLS = 2_000;
export const NOTEBOOK_DEFAULT_MAX_OUTPUTS = 10_000;
export const NOTEBOOK_DEFAULT_MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
export const NOTEBOOK_DEFAULT_MAX_TOTAL_PREVIEW_BYTES = 16 * 1024 * 1024;
/** Preference order; render one representation of a MIME bundle, not duplicates. */
export const NOTEBOOK_MIME_PRIORITY = [
    'text/html', 'image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'text/markdown', 'text/latex', 'application/json', 'text/plain'
] as const;

export interface NotebookParseOptions extends ParseOptions {
    /** Total output count across cells (default 10,000). */
    maxOutputs?: number;
    /** Cumulative UTF-8 budget for source, output, and attachment previews. */
    maxTotalPreviewBytes?: number;
}

const field = (node: JsonNode | undefined, key: string): JsonNode | undefined =>
    node?.kind === 'object' ? node.children?.find(child => child.key === key) : undefined;
const string = (node: JsonNode | undefined): string => node?.kind === 'string' ? node.value as string : '';
const integer = (node: JsonNode | undefined): number | null => {
    if (node?.kind !== 'number') return null;
    const number = Number(node.rawNumber);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
};
const flag = (node: JsonNode | undefined): boolean => node?.kind === 'boolean' && node.value === true;
const multiline = (node: JsonNode | undefined): boolean => node?.kind === 'string' ||
    (node?.kind === 'array' && (node.children ?? []).every(child => child.kind === 'string'));

export function parseNotebook(input: Uint8Array | string, options: NotebookParseOptions = {}): ParseOutcome<NotebookDocument> {
    const started = Date.now();
    const limits = { ...DEFAULT_LIMITS, maxInputBytes: 64 * 1024 * 1024, ...options.limits };
    const maxCells = options.limits?.maxEntries ?? NOTEBOOK_DEFAULT_MAX_CELLS;
    const maxOutputs = options.maxOutputs ?? NOTEBOOK_DEFAULT_MAX_OUTPUTS;
    const maxPreview = options.limits?.maxPreviewBytes ?? NOTEBOOK_DEFAULT_MAX_PREVIEW_BYTES;
    let remaining = options.maxTotalPreviewBytes ?? NOTEBOOK_DEFAULT_MAX_TOTAL_PREVIEW_BYTES;
    const diagnostics: Diagnostic[] = [];
    const finish = (result: ParseResult<NotebookDocument>): ParseOutcome<NotebookDocument> => ({
        result, execution: { workerUsed: false, hardLimitEnforced: false, elapsedMillis: Date.now() - started }
    });
    const fail = (code: 'invalid-format' | 'aborted' | 'limit-exceeded', key: string, args?: Record<string, string | number>): ParseOutcome<NotebookDocument> =>
        finish({ status: 'failed', failure: { code, messageKey: key, retryable: code === 'aborted', ...(args ? { args } : {}) }, diagnostics });
    if (options.signal?.aborted) return fail('aborted', 'diag.aborted');
    if ((typeof input === 'string' ? utf8ByteLength(input) : input.byteLength) > limits.maxInputBytes)
        return fail('limit-exceeded', 'diag.limit-exceeded.input', { maxBytes: limits.maxInputBytes });
    const text = typeof input === 'string' ? input : decodeUtf8(input);
    // maxEntries here counts CELLS. JSON has a separate bounded node budget.
    const json = parseJson(text, { ...(options.signal ? { signal: options.signal } : {}),
        limits: { ...limits, maxEntries: DEFAULT_LIMITS.maxEntries } });
    diagnostics.push(...json.result.diagnostics);
    if (json.result.status === 'failed') return finish(json.result);
    if (json.result.status !== 'ok') return fail(
        diagnostics.some(d => d.code === 'limit-exceeded') ? 'limit-exceeded' : 'invalid-format', 'diag.notebook.invalid');
    const root = json.result.document.root;
    const version = integer(field(root, 'nbformat'));
    const minor = integer(field(root, 'nbformat_minor'));
    if (version !== 4) return fail('invalid-format', 'diag.notebook.version');
    const cellList = field(root, 'cells');
    if (minor === null || cellList?.kind !== 'array') return fail('invalid-format', 'diag.notebook.invalid');
    let partial = false;
    const warn = (key: string, location?: string): void => {
        partial = true;
        // One warning per category; avoid growing diagnostics with hostile cells.
        if (!diagnostics.some(d => d.messageKey === key)) diagnostics.push({ severity: 'warning', code: key,
            messageKey: key, ...(location ? { location } : {}) });
    };
    const tracker = new LimitTracker(limits, options.signal);
    const read = (node: JsonNode | undefined, join = '', rawJson = false): { text: string; truncated: boolean } => {
        let out = '', budget = Math.max(0, Math.min(maxPreview, remaining)), used = 0, truncated = false;
        const append = (value: string): void => {
            if (truncated) return;
            const bytes = utf8ByteLength(value);
            if (bytes <= budget - used) { out += value; used += bytes; return; }
            let lo = 0, hi = Math.min(value.length, budget - used);
            while (lo < hi) {
                const mid = Math.ceil((lo + hi) / 2);
                if (utf8ByteLength(value.slice(0, mid)) <= budget - used) lo = mid; else hi = mid - 1;
            }
            // Never split a UTF-16 surrogate pair in the preview.
            if (lo && /[\uD800-\uDBFF]/.test(value[lo - 1]!) && /[\uDC00-\uDFFF]/.test(value[lo] ?? '')) lo--;
            const kept = value.slice(0, lo); out += kept; used += utf8ByteLength(kept); truncated = true;
        };
        if (rawJson && node) append(text.slice(node.span.start, node.span.end));
        else if (node?.kind === 'string') append(string(node));
        else if (node?.kind === 'array') for (const [index, child] of (node.children ?? []).entries()) {
            if (index) append(join);
            append(string(child));
            if (truncated) break;
        }
        remaining -= used;
        if (truncated) warn('diag.notebook.previewLimit', node?.path);
        return { text: out, truncated };
    };
    const bundle = (node: JsonNode | undefined, metadata?: JsonNode): NotebookRepresentation[] => {
        if (node?.kind !== 'object') return [];
        const values: NotebookRepresentation[] = [];
        for (const mimeType of NOTEBOOK_MIME_PRIORITY) {
            const data = field(node, mimeType);
            if (!data) continue;
            if (mimeType !== 'application/json' && !multiline(data)) { warn('diag.notebook.malformed', data.path); continue; }
            const value = read(data, '', mimeType === 'application/json');
            const size = field(metadata, mimeType);
            const width = integer(field(size, 'width')), height = integer(field(size, 'height'));
            values.push({ mimeType, ...value, ...(width && width <= 16_384 ? { width } : {}),
                ...(height && height <= 16_384 ? { height } : {}) });
        }
        return values;
    };
    const cells: NotebookCell[] = [];
    const nodes = cellList.children ?? [];
    let outputCount = 0, errorCount = 0;
    for (const [index, node] of nodes.entries()) {
        const violation = tracker.checkpoint();
        if (violation?.kind === 'aborted') return fail('aborted', 'diag.aborted');
        if (violation || index >= maxCells) { warn('diag.notebook.cellLimit'); break; }
        const kind = string(field(node, 'cell_type'));
        const source = field(node, 'source');
        if (node.kind !== 'object' || !kind || !multiline(source)) { warn('diag.notebook.malformed', node.path); continue; }
        const type = kind === 'markdown' || kind === 'code' || kind === 'raw' ? kind : 'unknown';
        if (type === 'unknown') warn('diag.notebook.unknownCell', node.path);
        const metadata = field(node, 'metadata'), jupyter = field(metadata, 'jupyter');
        const cell: NotebookCell = { index, id: string(field(node, 'id')).slice(0, 64), type,
            source: read(source).text, executionCount: integer(field(node, 'execution_count')),
            sourceHidden: flag(field(jupyter, 'source_hidden')),
            outputsHidden: flag(field(jupyter, 'outputs_hidden')) || flag(field(metadata, 'collapsed')),
            outputs: [], attachments: Object.create(null) as Record<string, NotebookRepresentation[]> };
        const attachments = field(node, 'attachments');
        if (attachments?.kind === 'object') for (const attachment of (attachments.children ?? []).slice(0, 100))
            cell.attachments[attachment.key] = bundle(attachment);
        if ((attachments?.children?.length ?? 0) > 100) warn('diag.notebook.previewLimit', attachments?.path);
        const outputs = field(node, 'outputs');
        if (type === 'code' && outputs && outputs.kind !== 'array') warn('diag.notebook.malformed', outputs.path);
        if (type === 'code' && outputs?.kind === 'array') for (const outputNode of outputs.children ?? []) {
            const violation = tracker.checkpoint();
            if (violation?.kind === 'aborted') return fail('aborted', 'diag.aborted');
            if (violation || outputCount >= maxOutputs) { warn('diag.notebook.outputLimit'); break; }
            const outputType = string(field(outputNode, 'output_type'));
            if (!outputType || outputNode.kind !== 'object') { warn('diag.notebook.malformed', outputNode.path); continue; }
            const type = ['stream', 'display_data', 'execute_result', 'error'].includes(outputType)
                ? outputType as NotebookOutput['type'] : 'unknown';
            const output: NotebookOutput = { type, name: string(field(outputNode, 'name')).slice(0, 32),
                executionCount: integer(field(outputNode, 'execution_count')), text: '', errorName: '', errorValue: '',
                traceback: '', representations: [] };
            if (type === 'stream') {
                if (!multiline(field(outputNode, 'text'))) warn('diag.notebook.malformed', outputNode.path);
                output.text = read(field(outputNode, 'text')).text;
            } else if (type === 'error') {
                output.errorName = read(field(outputNode, 'ename')).text;
                output.errorValue = read(field(outputNode, 'evalue')).text;
                output.traceback = read(field(outputNode, 'traceback'), '\n').text; errorCount++;
            } else if (type === 'display_data' || type === 'execute_result') {
                output.representations = bundle(field(outputNode, 'data'), field(outputNode, 'metadata'));
            } else warn('diag.notebook.unknownOutput', outputNode.path);
            cell.outputs.push(output); outputCount++;
        }
        cells.push(cell); tracker.addEntries(1);
    }
    const metadata = field(root, 'metadata');
    const document: NotebookDocument = { nbformat: version, nbformatMinor: minor, cells, totalCells: nodes.length,
        language: string(field(field(metadata, 'language_info'), 'name')).slice(0, 128),
        kernelName: string(field(field(metadata, 'kernelspec'), 'display_name')).slice(0, 256), outputCount, errorCount };
    return finish({ status: partial ? 'partial' : 'ok', document, diagnostics });
}
