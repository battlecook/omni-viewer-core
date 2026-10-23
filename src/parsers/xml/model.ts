// Generic XML document model (docs/viewers/xml.md §2). Every node keeps
// half-open character offsets into `XmlDocument.text`, so a host can map a
// node onto the source and a caret offset back onto a node. Line and column
// are derived from `lineStarts` on demand rather than stored per node.

export type XmlNodeKind = 'element' | 'attribute' | 'text' | 'cdata' | 'comment' | 'pi' | 'doctype';

/** Half-open character offsets into `XmlDocument.text`. */
export interface XmlRange {
    start: number;
    end: number;
}

export interface XmlNode {
    /** Index into `XmlDocument.nodes`, assigned in document (pre-)order. */
    id: number;
    kind: XmlNodeKind;
    /** Owning element id, or -1 for top-level nodes. */
    parent: number;
    /** 0 for top-level nodes; an attribute sits one level below its element. */
    depth: number;
    /** Qualified name as written for elements and attributes, the target for a
     *  processing instruction, the root name for a DOCTYPE, otherwise ''. */
    name: string;
    prefix: string;
    local: string;
    /** Resolved namespace URI ('' when none or unresolvable). */
    namespaceUri: string;
    /** Decoded value: attribute value, character data, comment text, PI data,
     *  or the raw DOCTYPE declaration. '' for elements. */
    value: string;
    attributes: readonly XmlNode[];
    children: readonly XmlNode[];
    range: XmlRange;
    /** Elements only: the start tag (or the whole empty-element tag). */
    openTag?: XmlRange;
    /** Elements only: `<a/>`. */
    selfClosing?: boolean;
    /** Elements only: false when the end tag was missing and recovery closed it. */
    closed?: boolean;
}

export interface XmlDeclaration {
    version: string;
    encoding: string;
    standalone: string;
}

export interface XmlDoctype {
    name: string;
    publicId: string;
    systemId: string;
    /** Names of the internal-subset general entities, in declaration order. */
    entities: readonly string[];
}

export interface XmlNamespaceDeclaration {
    /** '' for a default namespace declaration. */
    prefix: string;
    uri: string;
    /** Element carrying the `xmlns` attribute. */
    element: number;
}

export interface XmlStats {
    elements: number;
    attributes: number;
    text: number;
    cdata: number;
    comments: number;
    processingInstructions: number;
    maxDepth: number;
}

export interface XmlDocument {
    text: string;
    /** Encoding actually used to decode the bytes. */
    encoding: string;
    declaration: XmlDeclaration | null;
    doctype: XmlDoctype | null;
    /** The document element. */
    root: XmlNode | null;
    /** DOCTYPE, top-level comments and PIs, and the root, in document order. */
    topLevel: readonly XmlNode[];
    /** All nodes by id. */
    nodes: readonly XmlNode[];
    namespaces: readonly XmlNamespaceDeclaration[];
    stats: XmlStats;
    /** Offset of the first character of every line (`\n` separated). */
    lineStarts: readonly number[];
}

export const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
export const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

/** 1-based line and column of a character offset. */
export function xmlPosition(lineStarts: readonly number[], offset: number): { line: number; column: number } {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid]! <= offset) lo = mid;
        else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - (lineStarts[lo] ?? 0) + 1 };
}
