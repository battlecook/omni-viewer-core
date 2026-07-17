import type { YamlParserDeps } from './model.js';
/** Dynamic optional-peer loader; base parser/viewer modules never import yaml. */
export async function loadYamlParserDeps(): Promise<YamlParserDeps> {
 const yaml = await import('yaml');
 const normalize = (node: unknown, path: string, key = '$'): import('./model.js').YamlNode => {
  const n = node as { contents?: unknown; items?: unknown[]; key?: unknown; value?: unknown; source?: unknown; anchor?: string; range?: readonly number[]; type?: string; constructor?: { name?: string } };
  if (n.contents !== undefined) return normalize(n.contents, path, key);
  const common = { key, path, range: n.range, anchorId: n.anchor };
  if (n.type === 'ALIAS' || n.constructor?.name === 'Alias') return { ...common, kind: 'alias', aliasOf: String(n.source ?? '') };
  if (Array.isArray(n.items)) {
   const pairs = n.items.every(item => item && typeof item === 'object' && 'key' in item);
   return { ...common, kind: pairs ? 'map' : 'seq', children: n.items.map((item, i) => { const pair = item as { key?: { value?: unknown; source?: unknown }; value?: unknown }; const childKey = pairs ? String(pair.key?.value ?? pair.key?.source ?? i) : String(i); return normalize(pairs ? pair.value : item, pairs ? `${path}.${childKey}` : `${path}[${i}]`, childKey); }) };
  }
  const value = (n as { value?: unknown }).value ?? node;
  return { ...common, kind: 'scalar', value: value as string | boolean | number | null, raw: n.source === undefined ? String(value) : String(n.source) };
 };
 return { parse: (text) => yaml.parseAllDocuments(text, { schema: 'core', customTags: [] }), normalize: (document, index) => normalize(document, `$doc[${index}]`) };
}
