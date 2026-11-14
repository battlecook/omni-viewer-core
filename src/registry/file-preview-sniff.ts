import { parseJson, type JsonNode } from '../parsers/json/index.js';
import { skipXmlPrologue } from '../parsers/xml/prologue.js';

const SAMPLE_SIZE = 64 * 1024;
type JsonPreview = 'sarif' | 'sbom' | 'trace';
type XmlPreview = 'gps' | 'drawio';

function field(node: JsonNode | undefined, name: string): JsonNode | undefined {
    const children = node?.kind === 'object' ? node.children : undefined;
    // Dedicated parsers use JSON.parse, which keeps the last occurrence.
    for (let index = (children?.length ?? 0) - 1; index >= 0; index--) {
        const child = children![index];
        if (child?.key === name) return child;
    }
    return undefined;
}
function traceId(node: JsonNode | undefined): boolean {
    return node?.kind === 'string' || (node?.kind === 'number' && Number.isFinite(Number(node.rawNumber)));
}
const TIMELINE_PHASES = new Set(['B', 'E', 'X', 'I', 'i', 'R']);
const TRACE_PHASES = new Set([...TIMELINE_PHASES, 'C', 'b', 'n', 'e', 's', 't', 'f', 'S', 'T', 'F', 'P', 'N', 'O', 'D', 'v', 'V', 'c']);

function traceEvent(node: JsonNode, phases = TRACE_PHASES): boolean {
    const phase = field(node, 'ph')?.value;
    if (!traceId(field(node, 'pid'))) return false;
    const name = field(node, 'name');
    const hasThread = traceId(field(node, 'tid'));
    if (phase === 'M') return phases === TRACE_PHASES && name?.kind === 'string' && (hasThread || name.value === 'process_name');
    const timestamp = field(node, 'ts');
    if (typeof phase !== 'string' || !phases.has(phase) || !hasThread ||
        timestamp?.kind !== 'number' || !Number.isFinite(Number(timestamp.rawNumber)) ||
        (phase !== 'E' && name?.kind !== 'string')) return false;
    if (phase !== 'X') return true;
    const duration = field(node, 'dur');
    const value = Number(duration?.rawNumber);
    return duration?.kind === 'number' && Number.isFinite(value) && value >= 0;
}

export function sniffJsonPreview(text: string): JsonPreview | null {
    const sample = text.slice(0, SAMPLE_SIZE).trim();
    if (!sample.startsWith('{') && !sample.startsWith('[')) return null;
    if (!/traceEvents|CycloneDX|"runs"|"ph"|\\u[0-9a-fA-F]{4}/.test(sample)) return null;
    const { result } = parseJson(sample, { maxDepth: 32, limits: { maxEntries: 12_000 } });
    if (result.status === 'failed' || result.diagnostics.some(item => item.code === 'json.trailing-content')) return null;
    const { root } = result.document;
    const runs = field(root, 'runs');
    const schema = field(root, '$schema')?.value;
    const schemaFile = typeof schema === 'string' ? schema.slice(schema.lastIndexOf('/') + 1) : '';
    const sarifSchema = schemaFile.length <= 256 && /^sarif[\w.-]*2\.1\.0[\w.-]*$/i.test(schemaFile);
    if (runs?.kind === 'null' && field(root, 'version')?.value === '2.1.0') return 'sarif';
    // `$schema` stands in for `version` only when the sample is cut before `version` (the parser requires it).
    if (runs?.kind === 'array' && (field(root, 'version')?.value === '2.1.0' || (result.status !== 'ok' && sarifSchema))) {
        if (runs.children?.some(run => field(field(field(run, 'tool'), 'driver'), 'name')?.kind === 'string') ||
            (result.status === 'ok' && runs.children?.length === 0)) return 'sarif';
        // Writers with sorted keys (Semgrep) put `results` before `tool` and `version` last, past the sample.
        const first = runs.children?.[0];
        if (result.status !== 'ok' && (field(first, 'results')?.kind === 'array' || field(first, 'invocations')?.kind === 'array')) return 'sarif';
    }
    if (field(root, 'bomFormat')?.value === 'CycloneDX') {
        const specVersion = field(root, 'specVersion');
        if (/^1\.[0-9]+$/.test(String(specVersion?.value)) ||
            (!specVersion && result.status === 'partial' && field(root, 'components')?.kind === 'array')) return 'sbom';
    }
    const events = root.kind === 'array' ? root : field(root, 'traceEvents');
    if (events?.kind === 'array') {
        if (root.kind === 'object') {
            if (events.children?.some(node => traceEvent(node))) return 'trace';
        } else {
            const sampleEvents = events.children?.slice(0, 8) ?? [];
            const matching = sampleEvents.filter(node => traceEvent(node)).length;
            if (matching >= 2 && matching >= sampleEvents.length - 1 &&
                (events.children?.some(node => traceEvent(node, TIMELINE_PHASES)) ||
                    (result.status === 'partial' && matching === sampleEvents.length))) return 'trace';
            if (sampleEvents.length === 1 && matching === 1 &&
                ['X', 'I', 'i', 'R'].includes(String(field(sampleEvents[0], 'ph')?.value))) return 'trace';
        }
    }
    return null;
}

export function sniffXmlPreview(text: string): XmlPreview | null {
    const sample = skipXmlPrologue(text.slice(0, SAMPLE_SIZE));
    const root = /^<(?:(\w[\w.-]*):)?(gpx|kml|mxfile|mxGraphModel)(?=[\s/>])((?:"[^"]*"|'[^']*'|[^>"'])*)>/.exec(sample);
    if (!root) return null;
    const [, prefix, name, attributes = ''] = root;
    const namespaceName = prefix ? `xmlns:${prefix}` : 'xmlns';
    const attribute = /\s+([^\s=/'"<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
    let namespace = '';
    for (let match; (match = attribute.exec(attributes));) {
        if (match[1] !== namespaceName) continue;
        namespace = match[2] ?? match[3] ?? '';
        break;
    }
    if (name === 'mxfile' || name === 'mxGraphModel') return !prefix && !namespace ? 'drawio' : null;
    if (name === 'gpx' && (namespace === 'http://www.topografix.com/GPX/1/1' || namespace === 'http://www.topografix.com/GPX/1/0')) return 'gps';
    if (name === 'kml' && (namespace === 'http://www.opengis.net/kml/2.2' || /^http:\/\/earth\.google\.com\/kml\/2\.[012]$/.test(namespace ?? ''))) return 'gps';
    return null;
}
