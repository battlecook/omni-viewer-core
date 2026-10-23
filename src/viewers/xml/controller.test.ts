import { describe, expect, it } from 'vitest';
import { parseXml, type XmlDocument } from '../../parsers/xml/index.js';
import { createXmlController, XML_INITIAL_EXPAND_CHILDREN } from './controller.js';

const load = (text: string): XmlDocument => {
    const { result } = parseXml(text);
    if (result.status === 'failed') throw new Error(result.failure.messageKey);
    return result.document;
};

const POM = `<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" version="1">
  <!-- deps -->
  <dependencies>
    <dependency scope="test"><groupId>junit</groupId><artifactId>junit</artifactId></dependency>
    <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId></dependency>
  </dependencies>
  <description>Mixed <b>bold</b> text<![CDATA[ <raw> ]]></description>
  <?build fast?>
</project>`;

const byName = (doc: XmlDocument, name: string, nth = 0) => doc.nodes.filter((n) => n.name === name)[nth]!;
const labels = (doc: XmlDocument, rows: readonly number[]) => rows.map((id) => {
    const node = doc.nodes[id]!;
    return node.kind === 'element' ? node.name : node.kind === 'attribute' ? `@${node.name}` : `#${node.kind}`;
});

describe('createXmlController', () => {
    it('opens with the root and its children expanded, attributes first, single text folded', () => {
        const doc = load(POM);
        const controller = createXmlController(doc);
        expect(labels(doc, controller.state.rows)).toEqual([
            'project', '@xmlns', '@version', '#comment',
            'dependencies', 'dependency', 'dependency',
            'description', '#text', 'b', '#text', '#cdata',
            '#pi'
        ]);
        // <groupId>junit</groupId> is one row with its text inline.
        const groupId = byName(doc, 'groupId');
        expect(controller.inlineText(groupId.id)?.value).toBe('junit');
        expect(controller.isExpandable(groupId.id)).toBe(false);
        expect(controller.isExpandable(byName(doc, 'b').id)).toBe(false);
    });

    it('does not pre-expand the children of a very wide root', () => {
        const wide = load(`<r>${'<i><v>1</v></i>'.repeat(XML_INITIAL_EXPAND_CHILDREN + 1)}</r>`);
        expect(createXmlController(wide).state.rows).toHaveLength(XML_INITIAL_EXPAND_CHILDREN + 2);
    });

    it('builds XPaths with positions only where names repeat', () => {
        const doc = load(POM);
        const controller = createXmlController(doc);
        expect(controller.xpath(doc.root!.id)).toBe('/project');
        expect(controller.xpath(byName(doc, 'artifactId', 1).id)).toBe('/project/dependencies/dependency[2]/artifactId');
        expect(controller.xpath(byName(doc, 'scope').id)).toBe('/project/dependencies/dependency[1]/@scope');
        const description = byName(doc, 'description');
        expect(controller.xpath(description.children[2]!.id)).toBe('/project/description/text()[2]');
        // The CDATA right after the text is the same XPath text node.
        expect(controller.xpath(description.children[3]!.id)).toBe('/project/description/text()[2]');
        expect(controller.xpath(doc.root!.children.find((c) => c.kind === 'comment')!.id)).toBe('/project/comment()');
        expect(controller.xpath(doc.root!.children.find((c) => c.kind === 'pi')!.id)).toBe("/project/processing-instruction('build')");
    });

    it('counts adjacent text and CDATA as one XPath text node', () => {
        const doc = load('<a>foo<![CDATA[bar]]><b/>baz<!--c-->qux</a>');
        const controller = createXmlController(doc);
        expect(doc.root!.children.map((child) => controller.xpath(child.id))).toEqual([
            '/a/text()[1]', '/a/text()[1]', '/a/b', '/a/text()[2]', '/a/comment()', '/a/text()[3]'
        ]);
    });

    it('addresses namespace declarations on the namespace axis', () => {
        const doc = load('<a xmlns:p="urn:p" xmlns="urn:d" p:x="1"/>');
        const controller = createXmlController(doc);
        expect(doc.root!.attributes.map((a) => controller.xpath(a.id))).toEqual(['/a/namespace::p', "/a/namespace::*[name()='']", '/a/@p:x']);
    });

    it('counts the whitespace-only text the parser drops in text() positions', () => {
        const xpathOf = (text: string, needle: string): string => {
            const doc = load(text);
            const node = doc.nodes.find((n) => n.kind === 'text' && n.value === needle)!;
            return createXmlController(doc).xpath(node.id);
        };
        // xmllint: text()[2] is the ' ' between </b> and <i>.
        expect(xpathOf('<p>Hello <b>x</b> <i>y</i> world</p>', ' world')).toBe('/p/text()[3]');
        expect(xpathOf('<p><b/> <i/>tail</p>', 'tail')).toBe('/p/text()[2]');
        expect(xpathOf('<p>tail<b/> </p>', 'tail')).toBe('/p/text()[1]');
        expect(xpathOf('<p><b/> <![CDATA[c]]>tail<i/></p>', 'tail')).toBe('/p/text()');
        expect(xpathOf('<p>only</p>', 'only')).toBe('/p/text()');
    });

    it('keeps a selection without its own row on the nearest visible ancestor row', () => {
        const doc = load('<r><a k="1"/><d/></r>');
        const controller = createXmlController(doc);
        controller.dispatch({ type: 'set-show-attributes', value: false });
        controller.dispatch({ type: 'select', id: byName(doc, 'k').id });
        // The inspector keeps the attribute; the tree stands on its element.
        expect(controller.state.selected).toBe(byName(doc, 'k').id);
        expect(controller.selectedRow()).toBe(byName(doc, 'a').id);
        controller.dispatch({ type: 'move', direction: 'down' });
        expect(controller.state.selected).toBe(byName(doc, 'd').id);
    });

    it('reports kept rows as expanded and ignores toggles under the matches-only filter', () => {
        const doc = load('<r><a><b><c>needle</c></b></a><z/></r>');
        const controller = createXmlController(doc);
        controller.dispatch({ type: 'set-search', search: 'needle' });
        controller.dispatch({ type: 'set-matches-only', value: true });
        controller.dispatch({ type: 'collapse-all' });
        expect(labels(doc, controller.state.rows)).toEqual(['r', 'a', 'b', 'c']);
        expect(['r', 'a', 'b'].map((name) => controller.isExpanded(byName(doc, name).id))).toEqual([true, true, true]);
        expect(controller.isExpandable(byName(doc, 'c').id)).toBe(false);
        controller.dispatch({ type: 'toggle', id: byName(doc, 'a').id });
        expect(controller.state.rows).toHaveLength(4);
    });

    it('keeps the whitespace between inline elements in text content and Copy value', () => {
        // XLIFF segment: the space between the two <g> is whitespace-only text.
        const doc = load('<source>Click <g id="1">Save</g> <g id="2">now</g></source>');
        const controller = createXmlController(doc);
        expect(controller.value(doc.root!.id)).toBe('Click Save now');
        const block = load('<a>\r\n  <b>x</b>\r\n  <c/>\r\n</a>');
        expect(createXmlController(block).textContent(block.root!.id)).toEqual({ text: '\n  x\n  \n', truncated: false });
        expect(createXmlController(block).textContent(block.root!.id, 3)).toEqual({ text: '\n  ', truncated: true });
    });

    it('returns text content, values, and source slices', () => {
        const doc = load(POM);
        const controller = createXmlController(doc);
        const description = byName(doc, 'description');
        expect(controller.textContent(description.id)).toEqual({ text: 'Mixed bold text <raw> ', truncated: false });
        expect(controller.textContent(description.id, 5)).toEqual({ text: 'Mixed', truncated: true });
        expect(controller.value(byName(doc, 'scope').id)).toBe('test');
        expect(controller.outerXml(byName(doc, 'groupId').id)).toBe('<groupId>junit</groupId>');
        expect(controller.outerXml(byName(doc, 'scope').id)).toBe('scope="test"');
    });

    it('maps source offsets to the deepest node row', () => {
        const doc = load(POM);
        const controller = createXmlController(doc);
        const at = (needle: string, delta = 0) => controller.nodeAtOffset(doc.text.indexOf(needle) + delta);
        expect(at('scope="test"', 2)).toBe(byName(doc, 'scope').id);
        expect(at('<dependency scope', 3)).toBe(byName(doc, 'dependency').id);
        // Folded text resolves to its element; mixed text to the text node.
        expect(at('junit</groupId>', 1)).toBe(byName(doc, 'groupId').id);
        expect(at('Mixed')).toBe(byName(doc, 'description').children[0]!.id);
        expect(at('</project>', 2)).toBe(doc.root!.id);
        expect(controller.nodeAtOffset(0)).toBe(null);
        controller.dispatch({ type: 'set-show-attributes', value: false });
        expect(at('scope="test"', 2)).toBe(byName(doc, 'dependency').id);
    });

    it('searches by scope, steps through matches, and reveals them', () => {
        const doc = load(POM);
        const controller = createXmlController(doc);
        controller.dispatch({ type: 'collapse-all' });
        expect(controller.state.rows).toEqual([doc.root!.id]);
        controller.dispatch({ type: 'set-search', search: 'JUNIT' });
        // groupId and artifactId fold their text, so the elements are the matches.
        expect(labels(doc, controller.state.matches)).toEqual(['groupId', 'artifactId']);
        expect(controller.state.matchIndex).toBe(0);
        expect(controller.state.selected).toBe(byName(doc, 'groupId').id);
        expect(controller.state.rows).toContain(byName(doc, 'groupId').id);
        controller.dispatch({ type: 'next-match' });
        expect(controller.state.selected).toBe(byName(doc, 'artifactId').id);
        controller.dispatch({ type: 'next-match' });
        expect(controller.state.matchIndex).toBe(0);
        controller.dispatch({ type: 'previous-match' });
        expect(controller.state.matchIndex).toBe(1);

        controller.dispatch({ type: 'set-search-scope', scope: 'name' });
        expect(controller.state.matches).toEqual([]);
        controller.dispatch({ type: 'set-search', search: 'scope' });
        expect(labels(doc, controller.state.matches)).toEqual(['@scope']);
        controller.dispatch({ type: 'set-search-scope', scope: 'comment' });
        controller.dispatch({ type: 'set-search', search: 'fast' });
        expect(labels(doc, controller.state.matches)).toEqual(['#pi']);
        controller.dispatch({ type: 'set-search-scope', scope: 'value' });
        controller.dispatch({ type: 'set-search', search: 'raw' });
        expect(labels(doc, controller.state.matches)).toEqual(['#cdata']);
    });

    it('filters to matches and their ancestors', () => {
        const doc = load(POM);
        const controller = createXmlController(doc);
        controller.dispatch({ type: 'set-search', search: 'slf4j' });
        controller.dispatch({ type: 'set-matches-only', value: true });
        expect(labels(doc, controller.state.rows)).toEqual(['project', 'dependencies', 'dependency', 'groupId', 'artifactId']);
        controller.dispatch({ type: 'set-matches-only', value: false });
        expect(controller.state.rows.length).toBeGreaterThan(5);
    });

    it('moves the selection with the keyboard', () => {
        const doc = load('<a><b><c/></b><d x="1"/></a>');
        const controller = createXmlController(doc);
        const id = (name: string) => byName(doc, name).id;
        controller.dispatch({ type: 'move', direction: 'down' });
        expect(controller.state.selected).toBe(id('a'));
        controller.dispatch({ type: 'move', direction: 'down' });
        expect(controller.state.selected).toBe(id('b'));
        controller.dispatch({ type: 'move', direction: 'right' });
        expect(controller.state.selected).toBe(id('c'));
        controller.dispatch({ type: 'move', direction: 'left' });
        expect(controller.state.selected).toBe(id('b'));
        controller.dispatch({ type: 'move', direction: 'left' });
        expect(controller.state.expanded.has(id('b'))).toBe(false);
        // <d> opened expanded (a root child), so End lands on its attribute row.
        controller.dispatch({ type: 'move', direction: 'end' });
        expect(controller.state.selected).toBe(id('x'));
        controller.dispatch({ type: 'move', direction: 'left' });
        expect(controller.state.selected).toBe(id('d'));
        controller.dispatch({ type: 'move', direction: 'left' });
        expect(labels(doc, controller.state.rows)).toEqual(['a', 'b', 'd']);
        controller.dispatch({ type: 'move', direction: 'right' });
        expect(labels(doc, controller.state.rows)).toEqual(['a', 'b', 'd', '@x']);
        controller.dispatch({ type: 'move', direction: 'right' });
        expect(controller.state.selected).toBe(id('x'));
        controller.dispatch({ type: 'move', direction: 'home' });
        expect(controller.state.selected).toBe(id('a'));
    });

    it('selects by offset and expands the ancestors of the selection', () => {
        const doc = load('<a><b><c>deep</c></b></a>');
        const controller = createXmlController(doc);
        controller.dispatch({ type: 'collapse-all' });
        controller.dispatch({ type: 'select-offset', offset: doc.text.indexOf('deep') });
        expect(controller.state.selected).toBe(byName(doc, 'c').id);
        expect(labels(doc, controller.state.rows)).toEqual(['a', 'b', 'c']);
        controller.dispatch({ type: 'expand-all' });
        controller.dispatch({ type: 'select', id: null });
        expect(controller.state.selected).toBe(null);
    });
});
