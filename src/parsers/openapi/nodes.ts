import { encodeJsonString } from '../json/index.js';
import type { OpenApiNode, OpenApiRefContext } from './model.js';
export type { OpenApiRefContext } from './model.js';

const resolvedViews = new WeakMap<OpenApiNode, WeakMap<OpenApiNode, Map<OpenApiRefContext, OpenApiNode>>>();

function ownField(node: OpenApiNode | undefined, key: string): OpenApiNode | undefined {
    return node?.kind === 'object' ? node.children?.find(child => child.key === key) : undefined;
}

export function openApiField(node: OpenApiNode | undefined, key: string): OpenApiNode | undefined {
    const value = ownField(node, key);
    if (!node?.referenceTarget) return value;
    if (key === '$ref') return value;
    if (node.referenceContext !== 'reference' || key === 'description') {
        if (value && (node.referenceContext !== 'reference' || value.kind === 'string')) return value;
    }
    return openApiField(node.referenceTarget, key);
}
export function openApiText(node: OpenApiNode | undefined): string {
    return node?.kind === 'string' ? String(node.value ?? '') : '';
}
export function openApiItems(node: OpenApiNode | undefined): readonly OpenApiNode[] {
    return node?.kind === 'array' ? node.children ?? [] : [];
}
export function openApiEntries(node: OpenApiNode | undefined): readonly OpenApiNode[] {
    if (node?.kind !== 'object') return [];
    if (!node.referenceTarget) return node.children ?? [];
    return [...iterateOpenApiEntries(node)];
}

/** Enumerate a resolved view without materializing copies of shared maps. */
export function* iterateOpenApiEntries(node: OpenApiNode | undefined): Generator<OpenApiNode> {
    const seen = new Set<string>();
    for (let current = node; current?.kind === 'object'; current = current.referenceTarget) {
        for (const child of current.children ?? []) {
            if (current.referenceTarget && (child.key === '$ref' || (current.referenceContext === 'reference' && (child.key !== 'description' || child.kind !== 'string')))) continue;
            if (!seen.has(child.key)) { seen.add(child.key); yield child; }
        }
    }
}
export function openApiStrings(node: OpenApiNode | undefined): string[] {
    return openApiItems(node).filter(child => child.kind === 'string').map(openApiText);
}

/** Routing is deliberately stricter than recognizing a word in a source file. */
export function openApiVersion(root: OpenApiNode): string | null {
    const swagger = openApiText(openApiField(root, 'swagger'));
    const openapi = openApiText(openApiField(root, 'openapi'));
    if (openApiField(root, 'swagger') && openApiField(root, 'openapi')) return null;
    const version = swagger === '2.0' ? swagger : /^3\.[012]\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(openapi) ? openapi : '';
    const info = openApiField(root, 'info');
    if (!version || !openApiText(openApiField(info, 'title')) || openApiField(info, 'version')?.kind !== 'string') return null;
    const fields = version === '2.0' || version.startsWith('3.0.') ? ['paths'] : ['paths', 'components', 'webhooks'];
    return fields.some(key => openApiField(root, key)?.kind === 'object') ? version : null;
}

/** JSON Pointer lookup only; external references are never fetched. Annotation
 * siblings are version/context aware; this is not a JSON Schema evaluator. */
export function resolveOpenApiRef(root: OpenApiNode, node: OpenApiNode | undefined, maxDepth = 32, context: OpenApiRefContext = 'reference'): OpenApiNode | undefined {
    if (node?.referenceTarget && node.referenceContext === context) return node;
    const seen = new Set<OpenApiNode>();
    const version = openApiText(openApiField(root, 'openapi'));
    const allowOverrides = /^3\.[12]\./.test(version);
    const layers: OpenApiNode[] = [];
    for (let depth = 0; node && depth < maxDepth; depth++) {
        const ref = openApiText(ownField(node, '$ref'));
        if (!ref) {
            let views = resolvedViews.get(root);
            if (!views) { views = new WeakMap(); resolvedViews.set(root, views); }
            for (let i = layers.length - 1; i >= 0; i--) {
                const layer = layers[i]!;
                let cache = views.get(layer);
                const cached = cache?.get(context);
                if (cached?.referenceTarget === node) { node = cached; continue; }
                const view: OpenApiNode = { ...layer, referenceTarget: node, referenceContext: context };
                if (!cache) { cache = new Map(); views.set(layer, cache); }
                cache.set(context, view);
                node = view;
            }
            return node;
        }
        if (seen.has(node)) return undefined;
        seen.add(node);
        const siblings = (node.children ?? []).filter(child => child.key !== '$ref');
        if ((context === 'pathItem' && siblings.length) || (allowOverrides && (context === 'schema' ? siblings.length : siblings.some(child => child.key === 'description' && child.kind === 'string')))) layers.push(node);
        if (!ref.startsWith('#')) return undefined;
        let decoded: string;
        try { decoded = decodeURIComponent(ref.slice(1)); } catch { return undefined; }
        if (decoded && !decoded.startsWith('/')) return undefined;
        let target: OpenApiNode | undefined = root;
        for (const raw of decoded ? decoded.slice(1).split('/') : []) {
            if (/~(?:[^01]|$)/.test(raw)) return undefined;
            const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
            target = target?.kind === 'array'
                ? /^(?:0|[1-9]\d*)$/.test(key) ? target.children?.[Number(key)] : undefined
                : openApiField(target, key);
        }
        node = target;
    }
    return undefined;
}

/** Bounded preview serialization without converting large numbers to float64. */
export function printOpenApiNode(node: OpenApiNode, maxChars = 64 * 1024): string {
    let out = '';
    let truncated = false;
    const add = (value: string): void => {
        const remaining = Math.max(0, maxChars - out.length);
        out += value.slice(0, remaining);
        if (value.length > remaining) truncated = true;
    };
    const write = (current: OpenApiNode, depth: number): void => {
        if (out.length >= maxChars) { truncated = true; return; }
        if (depth > 64) { add('null'); return; }
        if (current.kind === 'object' || current.kind === 'array') {
            const object = current.kind === 'object';
            add(object ? '{' : '[');
            const children = current.children ?? [];
            for (let i = 0; i < children.length; i++) {
                if (out.length >= maxChars) { truncated = true; break; }
                const child = children[i]!;
                add(`${i ? ',' : ''}\n${'  '.repeat(depth + 1)}`);
                if (object) add(`${encodeJsonString(child.key)}: `);
                write(child, depth + 1);
            }
            if (children.length) add(`\n${'  '.repeat(depth)}`);
            add(object ? '}' : ']');
        } else if (current.kind === 'string') add(encodeJsonString(String(current.value ?? '')));
        else if (current.kind === 'number') add(current.rawNumber ?? '0');
        else add(String(current.value ?? null));
    };
    write(node, 0);
    return out + (truncated ? '\n…' : '');
}

/** Complete, lossless JSON for copying. Unlike a preview, exceeding the
 * explicit output budget fails instead of returning truncated/invalid JSON. */
export function serializeOpenApiNode(node: OpenApiNode, maxChars = 10 * 1024 * 1024): string {
    const chunks: string[] = [];
    const stack: (OpenApiNode | string)[] = [node];
    let length = 0;
    const add = (value: string): void => {
        length += value.length;
        if (length > maxChars) throw new RangeError('OpenAPI JSON copy exceeds the output limit');
        chunks.push(value);
    };
    while (stack.length) {
        const current = stack.pop()!;
        if (typeof current === 'string') { add(current); continue; }
        if (current.kind === 'object' || current.kind === 'array') {
            const object = current.kind === 'object';
            add(object ? '{' : '[');
            stack.push(object ? '}' : ']');
            const children = current.children ?? [];
            for (let i = children.length - 1; i >= 0; i--) {
                const child = children[i]!;
                stack.push(child);
                if (object) stack.push(`${encodeJsonString(child.key)}:`);
                if (i > 0) stack.push(',');
            }
        } else if (current.kind === 'string') add(encodeJsonString(String(current.value ?? '')));
        else if (current.kind === 'number') add(current.rawNumber ?? '0');
        else add(String(current.value ?? null));
    }
    return chunks.join('');
}
