// Tolerant XML 1.0 scanner (docs/viewers/xml.md §2). No DOM (DESIGN.md §3-①):
// one forward pass over the decoded text builds the node arena, resolves
// namespaces, and reports well-formedness errors with their offsets while
// recovering, so a broken config file still opens as a tree.
//
// Security: external entities are never read, and internal entities expand
// one level only — the replacement text is inserted verbatim, never re-parsed
// for further references — under a cumulative budget, so neither XXE nor
// exponential expansion is possible.

import type { Diagnostic } from '../types.js';
import {
    XML_NAMESPACE,
    XMLNS_NAMESPACE,
    xmlPosition,
    type XmlDeclaration,
    type XmlDoctype,
    type XmlDocument,
    type XmlNamespaceDeclaration,
    type XmlNode,
    type XmlNodeKind,
    type XmlStats
} from './model.js';

export interface XmlTextLimits {
    maxNodes: number;
    maxDepth: number;
    signal?: AbortSignal;
}

export interface XmlTextResult {
    document: XmlDocument;
    diagnostics: Diagnostic[];
    /** Why the scan ended early, if it did; the tree holds what came before. */
    stopped: 'nodes' | 'depth' | 'aborted' | null;
}

/** Individual diagnostics kept before the rest are summarized. */
export const XML_MAX_DIAGNOSTICS = 200;
/** Cumulative characters internal entity references may expand into. */
export const XML_ENTITY_EXPANSION_BUDGET = 1024 * 1024;

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const ENTITY_NAME = /^[A-Za-z_:À-￿][\w.:\-·À-￿]*$/;
const EMPTY: readonly XmlNode[] = Object.freeze([]);

interface MutableNode extends XmlNode {
    attributes: XmlNode[];
    children: XmlNode[];
}

const isSpace = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
const isNameStart = (code: number): boolean =>
    (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || code === 0x5f || code === 0x3a || code >= 0xc0;
const isNameChar = (code: number): boolean =>
    isNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x2e || code === 0xb7;

function isBlank(text: string, start: number, end: number): boolean {
    for (let i = start; i < end; i++) if (!isSpace(text.charCodeAt(i))) return false;
    return true;
}

function splitName(name: string): { prefix: string; local: string } {
    const colon = name.indexOf(':');
    return colon <= 0 ? { prefix: '', local: name } : { prefix: name.slice(0, colon), local: name.slice(colon + 1) };
}

/** Removes one level of matching quotes from a DTD literal. */
const unquote = (literal: string | undefined): string => (literal ? literal.slice(1, -1) : '');

export function parseXmlText(text: string, encoding: string, limits: XmlTextLimits): XmlTextResult {
    const length = text.length;
    const lineStarts: number[] = [0];
    for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lineStarts.push(at + 1);

    const nodes: XmlNode[] = [];
    const topLevel: XmlNode[] = [];
    const namespaces: XmlNamespaceDeclaration[] = [];
    const stats: XmlStats = { elements: 0, attributes: 0, text: 0, cdata: 0, comments: 0, processingInstructions: 0, maxDepth: 0 };
    const diagnostics: Diagnostic[] = [];
    const reported = new Set<string>();
    let overflow = 0;
    // Cast, not annotated: these are assigned inside the scanning closures,
    // which control-flow narrowing of a `null` initializer does not see.
    let declaration = null as XmlDeclaration | null;
    let doctype = null as XmlDoctype | null;
    let root = null as XmlNode | null;
    let stopped = null as XmlTextResult['stopped'];
    /** The node cap is reached: the scan stops when the next node is due. */
    let full = false;

    const stack: MutableNode[] = [];
    /** Open elements per name, so an end tag with no open match is rejected
     *  without walking a deep stack (hostile `</x>` floods stay linear). */
    const openNames = new Map<string, number>();
    const pushOpen = (element: MutableNode): void => {
        stack.push(element);
        openNames.set(element.name, (openNames.get(element.name) ?? 0) + 1);
    };
    const popOpen = (): MutableNode => {
        const element = stack.pop()!;
        openNames.set(element.name, openNames.get(element.name)! - 1);
        return element;
    };
    const baseScope: ReadonlyMap<string, string> = new Map([['xml', XML_NAMESPACE]]);
    const scopes: ReadonlyMap<string, string>[] = [];
    const internalEntities = new Map<string, string>();
    const externalEntities = new Set<string>();
    let expandedChars = 0;

    const report = (severity: Diagnostic['severity'], code: string, offset: number, args: Record<string, string | number> = {}, once?: string): void => {
        if (once !== undefined) {
            if (reported.has(once)) return;
            reported.add(once);
        }
        if (diagnostics.length >= XML_MAX_DIAGNOSTICS) {
            overflow++;
            return;
        }
        const { line, column } = xmlPosition(lineStarts, offset);
        diagnostics.push({
            severity,
            code: `xml-${code.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
            messageKey: `diag.xml.${code}`,
            args: { ...args, line, column, offset },
            location: `${line}:${column}`
        });
    };

    const createNode = (kind: XmlNodeKind, parent: MutableNode | undefined, fields: Partial<Omit<XmlNode, 'attributes' | 'children'>> & { range: XmlNode['range'] }): MutableNode => {
        const node: MutableNode = {
            id: nodes.length,
            kind,
            parent: parent ? parent.id : -1,
            depth: parent ? parent.depth + 1 : 0,
            name: '',
            prefix: '',
            local: '',
            namespaceUri: '',
            value: '',
            attributes: EMPTY as XmlNode[],
            children: EMPTY as XmlNode[],
            ...fields
        };
        nodes.push(node);
        if (nodes.length >= limits.maxNodes) full = true;
        return node;
    };
    /** False — and the scan stops — when another node is due past the cap, so
     *  a document of exactly `maxNodes` nodes still reads in full. */
    const admit = (): boolean => {
        if (full) stopped = 'nodes';
        return !full;
    };

    /** Attach a non-attribute node to the open element or the top level. */
    const attach = (node: MutableNode): void => {
        const parent = stack[stack.length - 1];
        if (!parent) {
            topLevel.push(node);
            return;
        }
        if (parent.children === EMPTY) parent.children = [];
        parent.children.push(node);
    };

    /**
     * Decodes character and entity references. `literal` transforms the runs
     * between references (line-end or attribute-value normalization), so a
     * `&#13;` survives normalization as the spec requires.
     */
    const decodeReferences = (raw: string, offset: number, literal: (run: string) => string): string => {
        if (raw.indexOf('&') < 0) return literal(raw);
        let out = '';
        let last = 0;
        for (let at = raw.indexOf('&'); at >= 0; at = raw.indexOf('&', last)) {
            out += literal(raw.slice(last, at));
            // A reference is short: look for its ';' within the next 80
            // characters only, so a long run of bare '&'s stays linear.
            let semi = -1;
            for (let i = at + 1, stop = Math.min(raw.length, at + 81); i < stop; i++) {
                const code = raw.charCodeAt(i);
                if (code === 0x3b /* ; */) {
                    semi = i;
                    break;
                }
                // No reference spans whitespace or another '&'.
                if (isSpace(code) || code === 0x26) break;
            }
            const body = semi > at + 1 ? raw.slice(at + 1, semi) : '';
            const verbatim = raw.slice(at, semi + 1);
            if (body.charCodeAt(0) === 0x23 /* # */) {
                const hex = body.charCodeAt(1) === 0x78 /* x */;
                const digits = body.slice(hex ? 2 : 1);
                const code = (hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits) ? Number.parseInt(digits, hex ? 16 : 10) : NaN;
                if (code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && code !== 0xfffe && code !== 0xffff)) {
                    out += String.fromCodePoint(code);
                } else {
                    report('error', 'invalidCharRef', offset + at, { reference: verbatim });
                    out += verbatim;
                }
                last = semi + 1;
                continue;
            }
            if (!ENTITY_NAME.test(body)) {
                report('error', 'bareAmpersand', offset + at, {}, 'bare-ampersand');
                out += '&';
                last = at + 1;
                continue;
            }
            if (Object.hasOwn(PREDEFINED_ENTITIES, body)) out += PREDEFINED_ENTITIES[body]!;
            else if (internalEntities.has(body)) {
                const replacement = internalEntities.get(body)!;
                if (expandedChars + replacement.length > XML_ENTITY_EXPANSION_BUDGET) {
                    report('warning', 'entityExpansionLimit', offset + at, { max: XML_ENTITY_EXPANSION_BUDGET }, 'entity-budget');
                    out += verbatim;
                } else {
                    expandedChars += replacement.length;
                    // Inside an attribute the replacement is normalized like
                    // literal text (§3.3.3); its markup is never parsed.
                    out += literal(replacement);
                    // A '<' an entity brings into an attribute value is not
                    // well-formed (XML 1.0 WFC: No < in Attribute Values); in
                    // content it is markup the viewer shows as text.
                    if (replacement.indexOf('<') >= 0) {
                        if (literal === normalizeAttribute) report('error', 'entityLtInAttribute', offset + at, { name: body });
                        else report('info', 'entityMarkup', offset + at, { name: body }, `markup:${body}`);
                    }
                }
            } else if (externalEntities.has(body)) {
                report('info', 'externalEntity', offset + at, { name: body }, `external:${body}`);
                out += verbatim;
            } else {
                report('warning', 'undefinedEntity', offset + at, { name: body }, `undefined:${body}`);
                out += verbatim;
            }
            last = semi + 1;
        }
        return out + literal(raw.slice(last));
    };
    const normalizeLines = (run: string): string => (run.indexOf('\r') < 0 ? run : run.replace(/\r\n?/g, '\n'));
    // XML 1.0 §3.3.3: literal whitespace becomes a space; references are kept.
    const normalizeAttribute = (run: string): string => run.replace(/\r\n|[\r\n\t]/g, ' ');

    const addText = (start: number, end: number): void => {
        if (isBlank(text, start, end)) return;
        const parent = stack[stack.length - 1];
        if (!parent) {
            report('error', 'textOutsideRoot', start, {}, 'text-outside-root');
            return;
        }
        const value = decodeReferences(text.slice(start, end), start, normalizeLines);
        // A stray '<' is reported and kept as character data, which splits a
        // run of text; join the pieces back into one node.
        const last = parent.children[parent.children.length - 1];
        if (last?.kind === 'text' && last.range.end === start) {
            (last as MutableNode).value += value;
            last.range.end = end;
            return;
        }
        if (!admit()) return;
        attach(createNode('text', parent, { range: { start, end }, value }));
        stats.text++;
    };

    const scanName = (from: number): number => {
        let at = from;
        while (at < length && isNameChar(text.charCodeAt(at))) at++;
        return at;
    };
    const skipSpace = (from: number): number => {
        let at = from;
        while (at < length && isSpace(text.charCodeAt(at))) at++;
        return at;
    };

    const processingInstruction = (lt: number, documentStart: number): number => {
        const close = text.indexOf('?>', lt + 2);
        const end = close < 0 ? length : close + 2;
        const body = text.slice(lt + 2, close < 0 ? length : close);
        const targetEnd = scanName(lt + 2) - (lt + 2);
        const target = body.slice(0, targetEnd);
        if (target && target !== 'xml' && !admit()) return lt;
        if (close < 0) report('error', 'unterminatedPi', lt);
        if (!target) {
            report('error', 'invalidMarkup', lt);
            return end;
        }
        if (target === 'xml') {
            if (lt !== documentStart) report('error', 'misplacedDeclaration', lt);
            else {
                const pseudo = (name: string): string =>
                    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(body)?.slice(1).find((v) => v !== undefined) ?? '';
                declaration = { version: pseudo('version'), encoding: pseudo('encoding'), standalone: pseudo('standalone') };
            }
            return end;
        }
        attach(createNode('pi', stack[stack.length - 1], { range: { start: lt, end }, name: target, local: target, value: body.slice(target.length).trim() }));
        stats.processingInstructions++;
        return end;
    };

    const doctypeDeclaration = (lt: number): number => {
        let at = lt + 9;
        let subsetStart = -1;
        let subsetEnd = -1;
        let closed = false;
        while (at < length) {
            const code = text.charCodeAt(at);
            if (code === 0x22 || code === 0x27) {
                const quote = text.indexOf(code === 0x22 ? '"' : "'", at + 1);
                at = quote < 0 ? length : quote + 1;
                continue;
            }
            if (subsetStart >= 0 && subsetEnd < 0 && text.startsWith('<!--', at)) {
                const close = text.indexOf('-->', at + 4);
                at = close < 0 ? length : close + 3;
                continue;
            }
            // A PI in the subset is not a literal, even if it holds a quote.
            if (subsetStart >= 0 && subsetEnd < 0 && text.startsWith('<?', at)) {
                const close = text.indexOf('?>', at + 2);
                at = close < 0 ? length : close + 2;
                continue;
            }
            if (code === 0x5b /* [ */ && subsetStart < 0) subsetStart = at + 1;
            else if (code === 0x5d /* ] */ && subsetStart >= 0 && subsetEnd < 0) subsetEnd = at;
            else if (code === 0x3e /* > */ && (subsetStart < 0 || subsetEnd >= 0)) {
                closed = true;
                break;
            }
            at++;
        }
        const end = closed ? at + 1 : length;
        if (!closed) report('error', 'unterminatedDoctype', lt);
        const header = text.slice(lt + 9, subsetStart >= 0 ? subsetStart - 1 : end - (closed ? 1 : 0));
        const name = /^\s*([^\s[>]+)/.exec(header)?.[1] ?? '';
        const external = /\b(?:PUBLIC\s+("[^"]*"|'[^']*')\s*("[^"]*"|'[^']*')?|SYSTEM\s+("[^"]*"|'[^']*'))/.exec(header);
        const entities: string[] = [];
        if (subsetStart >= 0) {
            const subset = text.slice(subsetStart, subsetEnd >= 0 ? subsetEnd : end);
            // Comments and PIs are alternatives of the same scan, so a
            // commented-out `<!ENTITY>` is consumed as a comment and never
            // binds; a declaration's literal is consumed whole, so a `<!--`
            // inside an entity value is not taken for a comment either.
            const declarationPattern = /<!--[\s\S]*?(?:-->|$)|<\?[\s\S]*?(?:\?>|$)|<!ENTITY\s+(%\s+)?([^\s%"'>]+)\s+(?:("[^"]*"|'[^']*')|(SYSTEM|PUBLIC)\b)/g;
            for (let match = declarationPattern.exec(subset); match; match = declarationPattern.exec(subset)) {
                if (match[2] === undefined) continue;
                const entity = match[2];
                // Parameter entities only matter to DTD processing, which the
                // viewer does not do; the first declaration of a name binds.
                if (match[1] || internalEntities.has(entity) || externalEntities.has(entity)) continue;
                entities.push(entity);
                if (match[4]) externalEntities.add(entity);
                // Character references in an entity value are expanded at
                // declaration time, and the five predefined entities when the
                // replacement is included (one pass each, so `&#38;lt;` reads
                // '<'). Other general entity references stay verbatim in the
                // replacement text: there is no second level to recurse into.
                else internalEntities.set(entity, unquote(match[3])
                    .replace(/&#(x[0-9a-fA-F]+|[0-9]+);/g, (whole, digits: string) => {
                        const code = digits[0] === 'x' ? Number.parseInt(digits.slice(1), 16) : Number.parseInt(digits, 10);
                        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
                    })
                    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => PREDEFINED_ENTITIES[name]!));
            }
        }
        if (doctype || root || stack.length) {
            report('error', 'misplacedDoctype', lt);
            return end;
        }
        doctype = {
            name,
            publicId: unquote(external?.[1]),
            systemId: unquote(external?.[2] ?? external?.[3]),
            entities
        };
        if (!admit()) return lt;
        attach(createNode('doctype', undefined, { range: { start: lt, end }, name, local: name, value: text.slice(lt, end) }));
        return end;
    };

    const endTag = (lt: number): number => {
        const nameEnd = scanName(lt + 2);
        const name = text.slice(lt + 2, nameEnd);
        // Only whitespace may follow the name. Anything else up to a '>' is
        // reported and skipped; a '<' first means the '>' is missing, and the
        // '<' is left for the next construct (as startTag does).
        const after = skipSpace(nameEnd);
        let end = after + 1;
        if (text.charCodeAt(after) !== 0x3e /* > */) {
            let at = after;
            while (at < length && text.charCodeAt(at) !== 0x3e && text.charCodeAt(at) !== 0x3c) at++;
            if (at < length && text.charCodeAt(at) === 0x3e) {
                report('error', 'endTagSyntax', after, { name });
                end = at + 1;
            } else {
                report('error', 'unterminatedTag', lt);
                end = at;
            }
        }
        if (!stack.length) {
            report('error', 'unexpectedEndTag', lt, { name });
            return end;
        }
        let match = (openNames.get(name) ?? 0) > 0 ? stack.length - 1 : -1;
        while (match >= 0 && stack[match]!.name !== name) match--;
        if (match < 0) {
            report('error', 'mismatchedTag', lt, { expected: stack[stack.length - 1]!.name, found: name });
            return end;
        }
        while (stack.length - 1 > match) {
            const unclosed = popOpen();
            scopes.pop();
            unclosed.closed = false;
            unclosed.range.end = lt;
            report('error', 'unclosedElement', unclosed.range.start, { name: unclosed.name });
        }
        const element = popOpen();
        scopes.pop();
        element.range.end = end;
        return end;
    };

    const startTag = (lt: number): number => {
        const nameEnd = scanName(lt + 1);
        const name = text.slice(lt + 1, nameEnd);
        const attributes: Array<{ name: string; start: number; end: number; raw: string; rawOffset: number }> = [];
        let at = nameEnd;
        let tagEnd = -1;
        let selfClosing = false;
        while (tagEnd < 0) {
            at = skipSpace(at);
            if (at >= length) {
                report('error', 'unterminatedTag', lt);
                tagEnd = length;
                break;
            }
            const code = text.charCodeAt(at);
            if (code === 0x3e /* > */) tagEnd = at + 1;
            else if (code === 0x2f /* / */ && text.charCodeAt(at + 1) === 0x3e) {
                tagEnd = at + 2;
                selfClosing = true;
            } else if (code === 0x3c /* < */) {
                // A missing '>' — leave the '<' for the next construct.
                report('error', 'unterminatedTag', lt);
                tagEnd = at;
            } else if (!isNameStart(code)) {
                // A stray character between attributes (`id="1", name=…`).
                report('error', 'tagSyntax', at, { char: String.fromCodePoint(text.codePointAt(at)!), name });
                at++;
            } else {
                const start = at;
                at = scanName(at);
                const attribute = text.slice(start, at);
                at = skipSpace(at);
                if (text.charCodeAt(at) !== 0x3d /* = */) {
                    report('error', 'attributeSyntax', start, { name: attribute });
                    attributes.push({ name: attribute, start, end: start + attribute.length, raw: '', rawOffset: at });
                    continue;
                }
                at = skipSpace(at + 1);
                const quote = text.charCodeAt(at);
                let raw: string;
                let rawOffset: number;
                if (quote === 0x22 || quote === 0x27) {
                    const close = text.indexOf(quote === 0x22 ? '"' : "'", at + 1);
                    rawOffset = at + 1;
                    if (close < 0) {
                        report('error', 'unterminatedAttribute', start);
                        raw = text.slice(rawOffset);
                        at = length;
                    } else {
                        raw = text.slice(rawOffset, close);
                        at = close + 1;
                    }
                } else {
                    report('error', 'attributeSyntax', start, { name: attribute });
                    rawOffset = at;
                    while (at < length && !isSpace(text.charCodeAt(at)) && text.charCodeAt(at) !== 0x3e && !(text.charCodeAt(at) === 0x2f && text.charCodeAt(at + 1) === 0x3e)) at++;
                    raw = text.slice(rawOffset, at);
                }
                if (raw.indexOf('<') >= 0) report('error', 'ltInAttribute', start, { name: attribute });
                attributes.push({ name: attribute, start, end: at, raw, rawOffset });
                // XML 1.0 [40]: attributes are separated by whitespace.
                if (isNameStart(text.charCodeAt(at))) {
                    const next = text.slice(at, scanName(at));
                    report('error', 'missingAttributeSpace', at, { name: next });
                }
            }
        }

        const parent = stack[stack.length - 1];
        const depth = stack.length;
        if (depth >= limits.maxDepth) {
            report('warning', 'depthLimit', lt, { max: limits.maxDepth });
            stopped = 'depth';
            return tagEnd;
        }
        if (!admit()) return lt;
        if (!parent && root) report('error', 'multipleRoots', lt, {}, 'multiple-roots');

        // Namespace declarations on this tag are in scope for the tag itself.
        const parentScope = scopes[scopes.length - 1] ?? baseScope;
        let scope = parentScope;
        for (const attribute of attributes) {
            if (attribute.name !== 'xmlns' && !attribute.name.startsWith('xmlns:')) continue;
            if (scope === parentScope) scope = new Map(parentScope);
            (scope as Map<string, string>).set(attribute.name === 'xmlns' ? '' : attribute.name.slice(6), decodeReferences(attribute.raw, attribute.rawOffset, normalizeAttribute));
        }
        const resolve = (prefix: string, offset: number, isElement: boolean): string => {
            if (!prefix) return isElement ? scope.get('') ?? '' : '';
            if (prefix === 'xmlns') return XMLNS_NAMESPACE;
            const uri = scope.get(prefix);
            if (uri === undefined || uri === '') {
                report('error', 'undeclaredPrefix', offset, { prefix }, `prefix:${prefix}`);
                return '';
            }
            return uri;
        };

        const elementName = splitName(name);
        const element = createNode('element', parent, {
            range: { start: lt, end: tagEnd },
            openTag: { start: lt, end: tagEnd },
            name,
            ...elementName,
            namespaceUri: resolve(elementName.prefix, lt, true),
            selfClosing,
            closed: true
        });
        attach(element);
        if (!parent && !root) root = element;
        stats.elements++;
        if (depth + 1 > stats.maxDepth) stats.maxDepth = depth + 1;

        // Qualified names must be unique, and so must expanded names
        // (namespace URI + local name; Namespaces in XML §6.3): `p:x` and
        // `q:x` collide when p and q are bound to the same URI.
        const seen = new Set<string>();
        for (const attribute of attributes) {
            if (!admit()) break;
            const attributeName = splitName(attribute.name);
            const isDeclaration = attribute.name === 'xmlns' || attributeName.prefix === 'xmlns';
            const namespaceUri = isDeclaration ? XMLNS_NAMESPACE : resolve(attributeName.prefix, attribute.start, false);
            const expanded = attributeName.prefix && namespaceUri ? `{${namespaceUri}}${attributeName.local}` : attribute.name;
            if (seen.has(attribute.name) || seen.has(expanded)) report('error', 'duplicateAttribute', attribute.start, { name: attribute.name });
            seen.add(attribute.name);
            seen.add(expanded);
            const node = createNode('attribute', element, {
                range: { start: attribute.start, end: attribute.end },
                name: attribute.name,
                ...attributeName,
                namespaceUri,
                value: decodeReferences(attribute.raw, attribute.rawOffset, normalizeAttribute)
            });
            if (element.attributes === EMPTY) element.attributes = [];
            element.attributes.push(node);
            stats.attributes++;
            if (isDeclaration) namespaces.push({ prefix: attribute.name === 'xmlns' ? '' : attributeName.local, uri: node.value, element: element.id });
        }
        if (!selfClosing && !stopped) {
            pushOpen(element);
            scopes.push(scope);
        }
        return tagEnd;
    };

    const documentStart = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    let pos = documentStart;
    let steps = 0;
    while (pos < length && !stopped) {
        if ((++steps & 4095) === 0 && limits.signal?.aborted) {
            stopped = 'aborted';
            break;
        }
        const lt = text.indexOf('<', pos);
        const textEnd = lt < 0 ? length : lt;
        if (textEnd > pos) addText(pos, textEnd);
        if (lt < 0 || stopped) break;
        const next = text.charCodeAt(lt + 1);
        if (next === 0x3f /* ? */) pos = processingInstruction(lt, documentStart);
        else if (next === 0x21 /* ! */) {
            if (text.startsWith('<!--', lt)) {
                if (!admit()) break;
                const close = text.indexOf('-->', lt + 4);
                if (close < 0) report('error', 'unterminatedComment', lt);
                const end = close < 0 ? length : close + 3;
                attach(createNode('comment', stack[stack.length - 1], { range: { start: lt, end }, value: text.slice(lt + 4, close < 0 ? length : close) }));
                stats.comments++;
                pos = end;
            } else if (text.startsWith('<![CDATA[', lt)) {
                if (stack.length && !admit()) break;
                const close = text.indexOf(']]>', lt + 9);
                if (close < 0) report('error', 'unterminatedCdata', lt);
                const end = close < 0 ? length : close + 3;
                const parent = stack[stack.length - 1];
                if (!parent) report('error', 'textOutsideRoot', lt, {}, 'text-outside-root');
                else {
                    attach(createNode('cdata', parent, { range: { start: lt, end }, value: normalizeLines(text.slice(lt + 9, close < 0 ? length : close)) }));
                    stats.cdata++;
                }
                pos = end;
            } else if (text.startsWith('<!DOCTYPE', lt)) pos = doctypeDeclaration(lt);
            else {
                report('error', 'invalidMarkup', lt);
                const gt = text.indexOf('>', lt);
                pos = gt < 0 ? length : gt + 1;
            }
        } else if (next === 0x2f /* / */) pos = endTag(lt);
        else if (isNameStart(next)) pos = startTag(lt);
        else {
            // Not markup: keep the '<' as character data up to the next '<'.
            report('error', 'unescapedLt', lt, {}, 'unescaped-lt');
            const following = text.indexOf('<', lt + 1);
            pos = following < 0 ? length : following;
            addText(lt, pos);
        }
    }

    if (stopped === 'nodes') report('warning', 'nodeLimit', Math.min(pos, length), { max: limits.maxNodes });
    // Elements still open at the end of input: a limit stop already explains
    // the cut, otherwise each missing end tag is an error of its own.
    for (let depth = stack.length - 1; depth >= 0; depth--) {
        const element = stack[depth]!;
        element.closed = false;
        element.range.end = stopped ? Math.min(pos, length) : length;
        if (!stopped) report('error', 'unclosedElement', element.range.start, { name: element.name });
    }
    if (overflow > 0) {
        diagnostics.push({ severity: 'info', code: 'xml-more-diagnostics', messageKey: 'diag.xml.moreDiagnostics', args: { count: overflow } });
    }

    return {
        document: { text, encoding, declaration, doctype, root, topLevel, nodes, namespaces, stats, lineStarts },
        diagnostics,
        stopped
    };
}
