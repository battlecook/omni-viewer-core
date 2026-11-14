import { array, finite, invalidPreview, object, previewJson, previewParser, previewUtf8, string, type JsonObject } from '../file-preview.js';
import type { ParseOptions, ParseOutcome } from '../types.js';

export interface SarifFinding {
    tool: string;
    level: string;
    rule: string;
    ruleDescription: string;
    message: string;
    locations: { file: string; line: number | undefined; column: number | undefined }[];
}

export interface SarifDocument {
    runCount: number;
    tools: string[];
    findings: SarifFinding[];
}

function messageText(value: unknown): string {
    const message = object(value);
    return string(message?.text) || string(message?.markdown);
}

const uriScheme = /^[a-z][a-z\d+.-]{0,63}:/i;

function location(value: unknown, artifacts: unknown[], bases: JsonObject, text: (parts: Iterable<string>) => string) {
    const physical = object(object(value)?.physicalLocation);
    const artifact = object(physical?.artifactLocation);
    const stored = object(object(artifacts[finite(artifact?.index) ?? -1])?.location);
    const uri = string(artifact?.uri) || string(stored?.uri);
    const parts = [uri];
    let base = string(artifact?.uriBaseId) || string(stored?.uriBaseId);
    const visited = new Set<string>();
    // Only the scheme prefix matters; testing the whole URI makes long shared URIs quadratic.
    while (base && !visited.has(base) && visited.size < 16 && !uriScheme.test(parts.at(-1)!.slice(0, 65))) {
        visited.add(base);
        const entry = Object.hasOwn(bases, base) ? object(bases[base]) : undefined;
        if (!entry) break;
        const prefix = string(entry.uri);
        if (prefix) parts.push(prefix);
        base = string(entry.uriBaseId);
    }
    parts.reverse();
    const basePrefix = parts.length > 1 ? parts[0]! : '';
    const scheme = uriScheme.exec(basePrefix.slice(0, 65))?.[0];
    if (uri.startsWith('//')) {
        parts.splice(0, parts.length - 1, ...(scheme ? [scheme] : []));
    } else if (uri.startsWith('/')) {
        const origin = scheme && /^[a-z][a-z\d+.-]*:\/\/[^/?#]*(?=\/)/i.exec(basePrefix.slice(0, 4096))?.[0];
        parts.splice(0, parts.length - 1, ...(origin ? [origin] : []));
    } else if (scheme && scheme.toLowerCase() !== 'file:' && parts.reduce((length, part) => length + part.length, 0) <= 4096) {
        // File references preserve dot segments because symbolic links can change their meaning.
        try {
            const resolved = new URL(uri, parts.slice(0, -1).join('')).href;
            parts.splice(0, parts.length, resolved);
        } catch {
            // Keep the literal components for opaque schemes and malformed references.
        }
    }
    const region = object(physical?.region);
    return { file: text(parts), line: finite(region?.startLine), column: finite(region?.startColumn) };
}

function* messageParts(template: string, args: unknown[]): Iterable<string> {
    let offset = 0;
    for (const match of template.matchAll(/\{\{|\}\}|\{(\d+)\}/g)) {
        yield template.slice(offset, match.index);
        if (match[1] === undefined) yield match[0][0]!;
        else {
            const value = args[Number(match[1])];
            yield typeof value === 'string' ? value : match[0];
        }
        offset = match.index + match[0].length;
    }
    yield template.slice(offset);
}

export function parseSarif(input: Uint8Array, options: ParseOptions = {}): ParseOutcome<SarifDocument> {
    const parser = previewParser(input, options);
    try {
        parser.check();
        const root = object(previewJson(input));
        parser.requireTime();
        if (root?.version !== '2.1.0' || !(root.runs === null || Array.isArray(root.runs))) return invalidPreview();
        if (root.runs === null) {
            parser.warn('skipped');
            return parser.success({ runCount: 0, tools: [], findings: [] });
        }
        const limit = options.limits?.maxEntries ?? 50_000;
        let remainingText = options.limits?.maxPreviewBytes ?? 8 * 1024 * 1024;
        let remainingTemplate = remainingText;
        const text = (parts: Iterable<string>) => {
            let available = Math.min(64 * 1024, remainingText);
            const output: string[] = [];
            for (const part of parts) {
                const shown = previewUtf8(part, available);
                if (shown.text) output.push(shown.text);
                available -= shown.bytes;
                remainingText -= shown.bytes;
                if (shown.text.length < part.length) {
                    parser.warn('truncated');
                    break;
                }
            }
            return output.join('');
        };

        const findings: SarifFinding[] = [];
        const tools = new Set<string>();
        let examined = 0;
        let validRuns = 0;
        runs: for (const candidate of root.runs) {
            if (!parser.checkpoint()) break;
            const run = object(candidate);
            const tool = object(run?.tool);
            const driver = object(tool?.driver);
            if (!driver || !string(driver.name)) {
                parser.warn('skipped');
                continue;
            }
            validRuns++;
            const toolName = string(driver.name);
            tools.add(toolName);
            if (!Array.isArray(run?.results)) {
                parser.warn('skipped', 'sarif.resultsUnavailable');
                continue;
            }
            const artifacts = array(run?.artifacts);
            const extensions = array(tool?.extensions);
            const extensionsByGuid = new Map<string, JsonObject>();
            for (const item of extensions) {
                if (!parser.checkpoint()) break;
                const component = object(item);
                const guid = string(component?.guid);
                if (component && guid) extensionsByGuid.set(guid.toLowerCase(), component);
            }
            const ruleOwner = (reference: JsonObject | undefined) => {
                const component = object(reference?.toolComponent);
                return object(extensions[finite(component?.index) ?? -1])
                    ?? extensionsByGuid.get(string(component?.guid).toLowerCase()) ?? driver;
            };
            const ruleIndexes = new Map<JsonObject, { ids: Map<string, JsonObject>; guids: Map<string, JsonObject> }>();
            const findRule = (owner: JsonObject, index: number, id: string, guid: string) => {
                const rules = array(owner.rules);
                if (index >= 0 && rules[index] !== undefined) return object(rules[index]);
                let indexes = ruleIndexes.get(owner);
                if (!indexes) {
                    indexes = { ids: new Map(), guids: new Map() };
                    for (const entry of rules) {
                        if (!parser.checkpoint()) break;
                        const rule = object(entry);
                        if (!rule) continue;
                        const ruleId = string(rule.id);
                        const ruleGuid = string(rule.guid).toLowerCase();
                        if (ruleId && !indexes.ids.has(ruleId)) indexes.ids.set(ruleId, rule);
                        if (ruleGuid && !indexes.guids.has(ruleGuid)) indexes.guids.set(ruleGuid, rule);
                    }
                    ruleIndexes.set(owner, indexes);
                }
                return guid ? indexes.guids.get(guid.toLowerCase()) : indexes.ids.get(id);
            };
            const bases = object(run?.originalUriBaseIds) ?? {};
            // SARIF §3.27.10: an invocation's rule configuration override outranks the rule's default level.
            const invocations = array(run?.invocations);
            const invocationOverrides = new Map<number, Map<JsonObject, string>>();
            const overrideLevel = (rule: JsonObject, index: number) => {
                if (!Number.isInteger(index) || index < 0 || index >= invocations.length) return undefined;
                let overrides = invocationOverrides.get(index);
                if (!overrides) {
                    overrides = new Map();
                    const items = array(object(invocations[index])?.ruleConfigurationOverrides);
                    if (items.length > 10_000) parser.warn('truncated');
                    for (const item of items.slice(0, 10_000)) {
                        if (!parser.checkpoint()) break;
                        const override = object(item);
                        const level = string(object(override?.configuration)?.level);
                        const descriptor = object(override?.descriptor);
                        if (!level || !descriptor) continue;
                        const target = findRule(ruleOwner(descriptor), finite(descriptor.index) ?? -1,
                            string(descriptor.id), string(descriptor.guid));
                        if (target && !overrides.has(target)) overrides.set(target, level);
                    }
                    invocationOverrides.set(index, overrides);
                }
                return overrides.get(rule);
            };
            for (const entry of run.results) {
                if (!parser.checkpoint()) break runs;
                if (examined++ >= limit) {
                    parser.warn('truncated');
                    break runs;
                }
                const finding = object(entry);
                if (!finding || !object(finding.message)) {
                    parser.warn('skipped');
                    continue;
                }
                const reference = object(finding.rule);
                const id = string(finding.ruleId) || string(reference?.id);
                const index = finite(finding.ruleIndex) ?? finite(reference?.index) ?? -1;
                const owner = ruleOwner(reference);
                const rule = findRule(owner, index, id, string(reference?.guid));
                const message = object(finding.message);
                const messageId = string(message?.id);
                const template = messageText(message)
                    || messageText(object(rule?.messageStrings)?.[messageId])
                    || messageText(object(owner.globalMessageStrings)?.[messageId]);
                const args = array(message?.arguments);
                const retained = previewUtf8(template, Math.min(64 * 1024, remainingTemplate));
                if (retained.text.length < template.length) parser.warn('truncated');
                remainingTemplate -= retained.bytes;
                const messageValue = text(messageParts(retained.text, args));
                const locations = array(finding.locations);
                const invocationIndex = finite(object(finding.provenance)?.invocationIndex) ?? (invocations.length === 1 ? 0 : -1);
                if (locations.length > 100) parser.warn('truncated');
                const findingModel: SarifFinding = {
                    tool: toolName,
                    rule: id || string(rule?.id),
                    level: string(finding.level) || (finding.kind && finding.kind !== 'fail' ? 'none' :
                        (rule && overrideLevel(rule, invocationIndex)) || string(object(rule?.defaultConfiguration)?.level) || 'warning'),
                    ruleDescription: messageText(rule?.fullDescription) || messageText(rule?.shortDescription),
                    message: messageValue,
                    locations: locations.slice(0, 100).map(item => location(item, artifacts, bases, text))
                };
                if (!parser.checkpoint()) break runs;
                findings.push(findingModel);
            }
        }
        if (root.runs.length && !validRuns && parser.checkpoint()) return invalidPreview();
        return parser.success({ runCount: root.runs.length, tools: [...tools], findings });
    } catch (error) {
        return parser.failure(error);
    }
}
