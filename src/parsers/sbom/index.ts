import { array, invalidPreview, object, previewJson, previewParser, string, type JsonObject } from '../file-preview.js';
import type { ParseOptions, ParseOutcome } from '../types.js';

export interface SbomComponent {
    ref: string;
    name: string;
    group: string;
    version: string;
    type: string;
    purl: string;
    licenses: string[];
    description: string;
}

export interface SbomDocument {
    specVersion: string;
    subject: string;
    subjectComponent: SbomComponent | undefined;
    components: SbomComponent[];
    dependencies: ReadonlyMap<string, readonly string[]>;
}

function readComponent(item: JsonObject): SbomComponent {
    return {
        ref: string(item['bom-ref']), name: string(item.name), group: string(item.group),
        version: string(item.version), type: string(item.type), purl: string(item.purl),
        description: string(item.description),
        licenses: array(item.licenses).map(entry => {
            const choice = object(entry);
            const license = object(choice?.license);
            return string(choice?.expression) || string(license?.id) || string(license?.name);
        }).filter(Boolean)
    };
}

export function parseSbom(input: Uint8Array, options: ParseOptions = {}): ParseOutcome<SbomDocument> {
    const parser = previewParser(input, options);
    try {
        parser.check();
        const root = object(previewJson(input));
        parser.requireTime();
        if (root?.bomFormat !== 'CycloneDX' || !/^1\.[0-9]+$/.test(string(root.specVersion))) return invalidPreview();
        const subject = object(object(root.metadata)?.component);
        const components: SbomComponent[] = [];
        const limit = options.limits?.maxEntries ?? 50_000;
        const pending = [array(subject?.components).values(), array(root.components).values()];
        let examined = 0;
        while (pending.length && parser.checkpoint()) {
            const next = pending.at(-1)!.next();
            if (next.done) {
                pending.pop();
                continue;
            }
            if (examined++ >= limit) {
                parser.warn('truncated');
                break;
            }
            const item = object(next.value);
            if (!item || !string(item.name)) {
                parser.warn('skipped');
                continue;
            }
            components.push(readComponent(item));
            if (Array.isArray(item.components) && item.components.length) pending.push(array(item.components).values());
        }
        const dependencies = new Map<string, string[]>();
        const entries = array(root.dependencies);
        let edgeBudget = limit * 4;
        if (entries.length > limit) parser.warn('truncated');
        for (const entry of entries.slice(0, limit)) {
            if (!parser.checkpoint()) break;
            const item = object(entry);
            const ref = string(item?.ref);
            if (!ref) continue;
            const refs = array(item?.dependsOn);
            if (refs.length > edgeBudget) parser.warn('truncated');
            const retained = Math.min(refs.length, edgeBudget);
            const edges = refs.slice(0, retained).map(string).filter(Boolean);
            edgeBudget -= retained;
            if (edges.length < retained) parser.warn('skipped');
            if (!refs.length || edges.length) dependencies.set(ref, edges);
        }
        return parser.success({
            specVersion: string(root.specVersion), subject: string(subject?.name),
            subjectComponent: subject && string(subject.name) ? readComponent(subject) : undefined,
            components, dependencies
        });
    } catch (error) {
        return parser.failure(error);
    }
}
