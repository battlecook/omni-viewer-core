export type TomlValueKind = 'table' | 'array' | 'string' | 'integer' | 'float' | 'boolean' | 'datetime';

export interface TomlNode {
    kind: TomlValueKind;
    key: string;
    path: string;
    value?: string | boolean;
    raw: string;
    line: number;
    children?: TomlNode[];
}

export interface TomlDocument {
    text: string;
    root: TomlNode;
}

export const tomlPath = (parent: string, key: string): string =>
    parent ? `${parent}.${key}` : key;
