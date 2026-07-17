export type YamlNodeKind = 'map' | 'seq' | 'scalar' | 'alias';
export interface YamlNode { kind: YamlNodeKind; key: string; path: string; value?: string | boolean | number | null; raw?: string; range?: readonly number[] | undefined; anchorId?: string | undefined; aliasOf?: string; children?: YamlNode[]; }
export interface YamlDocument { text: string; documents: YamlNode[]; }
export interface YamlParserDeps {
    /** Must parse with YAML 1.2 core schema and return YAML AST documents. */
    parse(text: string): readonly unknown[];
    /** Optional platform adapter to normalize its YAML AST into safe core nodes. */
    normalize?(document: unknown, index: number): YamlNode;
}
