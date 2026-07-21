export type TomlValueKind = 'table' | 'array' | 'string' | 'integer' | 'float' | 'boolean' | 'datetime';

/** Half-open character offsets into `TomlDocument.text`, so a host can map a
 * node onto a text selection and a caret offset back onto a node. */
export interface TomlRange {
    start: number;
    end: number;
}

export interface TomlNode {
    kind: TomlValueKind;
    key: string;
    path: string;
    value?: string | boolean;
    raw: string;
    line: number;
    /** `#` comments attached to the node: the run directly above it plus any
     * trailing comment on the declaration line, `#` and padding removed. */
    comment?: string;
    range?: TomlRange;
    children?: TomlNode[];
}

export interface TomlDocument {
    text: string;
    root: TomlNode;
}

export const tomlPath = (parent: string, key: string): string =>
    parent ? `${parent}.${key}` : key;
