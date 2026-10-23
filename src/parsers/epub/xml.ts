// Small, bounded XML tree reader for the EPUB package files (container.xml,
// the OPF package document, the NCX, and the XHTML navigation document).
//
// The parser layer has no DOM (DESIGN.md §3-①), and these documents are small
// and regular, so a tolerant tree builder is enough: it keeps qualified names
// and attributes as written, decodes the XML entities plus the handful of HTML
// named entities navigation documents carry in practice, skips the prolog,
// comments, processing instructions and DOCTYPE, and recovers from mismatched
// or missing end tags instead of failing — real-world OPF and NCX files are
// not reliably well-formed. Node count and depth are capped.

export interface XmlElement {
    kind: 'element';
    /** Qualified name as written (`dc:title`, `opf:meta`). */
    name: string;
    /** Name without its prefix, for namespace-agnostic matching. */
    local: string;
    attributes: Record<string, string>;
    children: XmlNode[];
}

export interface XmlText {
    kind: 'text';
    text: string;
}

export type XmlNode = XmlElement | XmlText;

export interface XmlReadResult {
    root: XmlElement | null;
    /** Stopped at the node or depth cap; the tree holds what came before. */
    truncated: boolean;
}

export interface XmlReadLimits {
    maxNodes: number;
    maxDepth: number;
}

/** Attributes kept per element; the rest are dropped and the read marked truncated. */
const MAX_ATTRIBUTES = 256;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    // HTML entities that XHTML navigation documents use without declaring.
    nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
    ndash: '–', mdash: '—', hellip: '…', middot: '·', bull: '•',
    lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
    laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', shy: '­',
    zwj: '‍', zwnj: '‌'
};

/** Decodes character and entity references; unknown entities stay verbatim. */
export function decodeXmlEntities(value: string): string {
    if (!value.includes('&')) return value;
    return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
        if (body.charCodeAt(0) === 35 /* # */) {
            const code = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88
                ? Number.parseInt(body.slice(2), 16)
                : Number.parseInt(body.slice(1), 10);
            if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
            return String.fromCodePoint(code);
        }
        // Own keys only: `&constructor;` must not resolve to Object.prototype.
        return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body]! : whole;
    });
}

export function localName(name: string): string {
    const colon = name.indexOf(':');
    return colon < 0 ? name : name.slice(colon + 1);
}

export function readXml(text: string, limits: XmlReadLimits): XmlReadResult {
    const document: XmlElement = { kind: 'element', name: '#document', local: '#document', attributes: {}, children: [] };
    const stack: XmlElement[] = [document];
    /** Open elements per name (the document node excluded). */
    const open = new Map<string, number>();
    let nodes = 0;
    let truncated = false;
    let pos = 0;
    const length = text.length;

    const pushText = (raw: string): void => {
        if (!raw) return;
        const parent = stack[stack.length - 1]!;
        const last = parent.children[parent.children.length - 1];
        const decoded = decodeXmlEntities(raw);
        if (last?.kind === 'text') last.text += decoded;
        else {
            parent.children.push({ kind: 'text', text: decoded });
            nodes++;
        }
    };

    while (pos < length) {
        if (nodes >= limits.maxNodes) {
            truncated = true;
            break;
        }
        const lt = text.indexOf('<', pos);
        if (lt < 0) {
            pushText(text.slice(pos));
            break;
        }
        if (lt > pos) pushText(text.slice(pos, lt));

        if (text.startsWith('<!--', lt)) {
            const end = text.indexOf('-->', lt + 4);
            pos = end < 0 ? length : end + 3;
            continue;
        }
        if (text.startsWith('<![CDATA[', lt)) {
            const end = text.indexOf(']]>', lt + 9);
            const raw = text.slice(lt + 9, end < 0 ? length : end);
            const parent = stack[stack.length - 1]!;
            parent.children.push({ kind: 'text', text: raw });
            nodes++;
            pos = end < 0 ? length : end + 3;
            continue;
        }
        if (text.startsWith('<?', lt)) {
            const end = text.indexOf('?>', lt + 2);
            pos = end < 0 ? length : end + 2;
            continue;
        }
        if (text.startsWith('<!', lt)) {
            pos = skipDeclaration(text, lt);
            continue;
        }
        if (text.charCodeAt(lt + 1) === 47 /* / */) {
            const end = text.indexOf('>', lt + 2);
            const name = text.slice(lt + 2, end < 0 ? length : end).trim();
            pos = end < 0 ? length : end + 1;
            // Close up to the matching open element; a stray end tag with no
            // open match is ignored rather than unwinding the whole tree. The
            // open-name count makes that check O(1), so floods of stray end tags
            // cost nothing per tag regardless of stack depth.
            if (!open.get(name)) continue;
            for (;;) {
                const closed = stack.pop()!;
                open.set(closed.name, open.get(closed.name)! - 1);
                if (closed.name === name) break;
            }
            continue;
        }

        const tag = readStartTag(text, lt);
        if (!tag) {
            // A lone '<' in text content.
            pushText('<');
            pos = lt + 1;
            continue;
        }
        pos = tag.end;
        if (tag.dropped) truncated = true;
        const element: XmlElement = {
            kind: 'element',
            name: tag.name,
            local: localName(tag.name),
            attributes: tag.attributes,
            children: []
        };
        stack[stack.length - 1]!.children.push(element);
        nodes++;
        if (!tag.selfClosing) {
            if (stack.length > limits.maxDepth) {
                truncated = true;
                break;
            }
            stack.push(element);
            open.set(element.name, (open.get(element.name) ?? 0) + 1);
        }
    }

    const root = document.children.find((node): node is XmlElement => node.kind === 'element') ?? null;
    return { root, truncated };
}

/** Skips `<!DOCTYPE …>` including an internal subset in brackets. */
function skipDeclaration(text: string, start: number): number {
    let depth = 0;
    for (let i = start + 2; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code === 91 /* [ */) depth++;
        else if (code === 93 /* ] */) depth = Math.max(0, depth - 1);
        else if (code === 62 /* > */ && depth === 0) return i + 1;
    }
    return text.length;
}

function isNameStart(code: number): boolean {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 58 || code > 127;
}

function isSpace(code: number): boolean {
    return code === 32 || code === 9 || code === 10 || code === 13;
}

function readStartTag(
    text: string,
    start: number
): { name: string; attributes: Record<string, string>; selfClosing: boolean; end: number; dropped: boolean } | null {
    let i = start + 1;
    let count = 0;
    let dropped = false;
    if (!isNameStart(text.charCodeAt(i))) return null;
    const nameStart = i;
    while (i < text.length && !isSpace(text.charCodeAt(i)) && text[i] !== '>' && text[i] !== '/') i++;
    const name = text.slice(nameStart, i);
    const attributes: Record<string, string> = {};
    for (;;) {
        while (i < text.length && isSpace(text.charCodeAt(i))) i++;
        if (i >= text.length) return { name, attributes, selfClosing: false, end: text.length, dropped };
        const char = text[i];
        if (char === '>') return { name, attributes, selfClosing: false, end: i + 1, dropped };
        if (char === '/') {
            if (text[i + 1] === '>') return { name, attributes, selfClosing: true, end: i + 2, dropped };
            i++;
            continue;
        }
        const attrStart = i;
        while (i < text.length && !isSpace(text.charCodeAt(i)) && text[i] !== '=' && text[i] !== '>' && text[i] !== '/') i++;
        const attrName = text.slice(attrStart, i);
        while (i < text.length && isSpace(text.charCodeAt(i))) i++;
        let value = '';
        if (text[i] === '=') {
            i++;
            while (i < text.length && isSpace(text.charCodeAt(i))) i++;
            const quote = text[i];
            if (quote === '"' || quote === "'") {
                const close = text.indexOf(quote, i + 1);
                const end = close < 0 ? text.length : close;
                value = text.slice(i + 1, end);
                i = end + 1;
            } else {
                const valueStart = i;
                while (i < text.length && !isSpace(text.charCodeAt(i)) && text[i] !== '>') i++;
                value = text.slice(valueStart, i);
            }
        }
        // Package elements carry a handful of attributes; capping them keeps every
        // later lookup cheap however many a hostile element declares.
        if (attrName && !Object.hasOwn(attributes, attrName)) {
            if (count < MAX_ATTRIBUTES) {
                attributes[attrName] = decodeXmlEntities(value);
                count++;
            } else dropped = true;
        }
        if (i === attrStart) i++; // never stall on an unexpected character
    }
}

// ─── Tree helpers ──────────────────────────────────────────────────────────

export function childElements(element: XmlElement, local?: string): XmlElement[] {
    const out: XmlElement[] = [];
    for (const child of element.children) {
        if (child.kind === 'element' && (local === undefined || child.local === local)) out.push(child);
    }
    return out;
}

export function firstChild(element: XmlElement, local: string): XmlElement | undefined {
    for (const child of element.children) {
        if (child.kind === 'element' && child.local === local) return child;
    }
    return undefined;
}

/** Depth-first search for elements matching `predicate`, not descending into matches. */
export function findElements(element: XmlElement, predicate: (node: XmlElement) => boolean): XmlElement[] {
    const out: XmlElement[] = [];
    const visit = (node: XmlElement): void => {
        for (const child of node.children) {
            if (child.kind !== 'element') continue;
            if (predicate(child)) out.push(child);
            else visit(child);
        }
    };
    visit(element);
    return out;
}

/** Attribute by local name, so `opf:role`, `role`, and `xlink:href`/`href` all match. */
export function attribute(element: XmlElement, local: string): string | undefined {
    if (local in element.attributes) return element.attributes[local];
    for (const [name, value] of Object.entries(element.attributes)) {
        if (localName(name) === local) return value;
    }
    return undefined;
}

/** Concatenated descendant text. */
export function textContent(element: XmlElement): string {
    let out = '';
    const visit = (node: XmlElement): void => {
        for (const child of node.children) {
            if (child.kind === 'text') out += child.text;
            else visit(child);
        }
    };
    visit(element);
    return out;
}

/** Collapses XML whitespace runs to single spaces and trims. */
export function collapseWhitespace(value: string): string {
    return value.replace(/[ \t\r\n]+/g, ' ').trim();
}
