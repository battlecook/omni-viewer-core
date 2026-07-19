import type { YamlNode, YamlParserDeps } from './model.js';
/** Dynamic optional-peer loader; base parser/viewer modules never import yaml. */
export async function loadYamlParserDeps(): Promise<YamlParserDeps> {
 const yaml = await import('yaml');
 const normalizeDocument = (document: unknown, index: number): YamlNode => {
  const anchors = new Map<string, YamlNode>();
  const record = (node: YamlNode): YamlNode => { if (node.anchorId) anchors.set(node.anchorId, node); return node; };
  const normalize = (node: unknown, path: string, key = '$'): YamlNode => {
   const n = node as { contents?: unknown; items?: unknown[]; key?: unknown; value?: unknown; source?: unknown; anchor?: string; range?: readonly number[]; type?: string; constructor?: { name?: string } };
   if (n.contents !== undefined) return normalize(n.contents, path, key);
   const common = { key, path, range: n.range, anchorId: n.anchor };
   if (n.type === 'ALIAS' || n.constructor?.name === 'Alias') { const name = String(n.source ?? ''); const target = anchors.get(name); if (target?.kind !== 'scalar') return { ...common, kind: 'alias', aliasOf: name, raw: `*${name}` }; return { ...common, kind: 'alias', aliasOf: name, value: target.value ?? null, raw: target.raw ?? `*${name}` }; }
   if (Array.isArray(n.items)) {
    const pairs = n.items.every(item => item && typeof item === 'object' && 'key' in item);
    const seen = new Map<string, number>();
    return record({ ...common, kind: pairs ? 'map' : 'seq', children: n.items.map((item, i) => { const pair = item as { key?: { value?: unknown; source?: unknown }; value?: unknown }; const keyValue = typeof pair.key?.value === 'symbol' ? pair.key?.source ?? '<<' : pair.key?.value; const childKey = pairs ? String(keyValue ?? pair.key?.source ?? i) : String(i); const occurrence = (seen.get(childKey) ?? 0) + 1; seen.set(childKey, occurrence); return normalize(pairs ? pair.value : item, pairs ? `${path}.${childKey}${occurrence > 1 ? `#${occurrence}` : ''}` : `${path}[${i}]`, childKey); }) });
   }
   const value = (n as { value?: unknown }).value ?? node;
   return record({ ...common, kind: 'scalar', value: value as string | boolean | number | null, raw: n.source === undefined ? String(value) : String(n.source) });
  };
  return normalize(document, `$doc[${index}]`);
 };
 return { parse: (text) => yaml.parseAllDocuments(text, { schema: 'core', customTags: [], uniqueKeys: false, merge: true }), normalize: normalizeDocument };
}
