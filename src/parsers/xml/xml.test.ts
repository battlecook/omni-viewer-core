import { describe, expect, it } from 'vitest';
import { parseXml, xmlPosition, XML_ENTITY_EXPANSION_BUDGET, XMLNS_NAMESPACE, type XmlDocument, type XmlNode } from './index.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const parse = (text: string | Uint8Array, options = {}) => parseXml(typeof text === 'string' ? encode(text) : text, options).result;
const documentOf = (text: string): XmlDocument => {
    const result = parse(text);
    if (result.status === 'failed') throw new Error(`failed: ${result.failure.messageKey}`);
    return result.document;
};
const codes = (text: string): string[] => parse(text).diagnostics.map((diagnostic) => diagnostic.messageKey);
const elements = (node: XmlNode): XmlNode[] => node.children.filter((child) => child.kind === 'element');

// Shape of `mvn archetype:generate` output (declaration, default namespace,
// xsi:schemaLocation, a comment between siblings).
const POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <!-- FIXME change it to the project's website -->
  <dependencies>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <version>4.11</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
    </dependency>
  </dependencies>
</project>
`;

describe('parseXml — structure', () => {
    it('builds the element tree with declaration, namespaces, comments and ranges', () => {
        const doc = documentOf(POM);
        expect(doc.declaration).toEqual({ version: '1.0', encoding: 'UTF-8', standalone: '' });
        expect(doc.encoding).toBe('utf-8');
        const root = doc.root!;
        expect(root.name).toBe('project');
        expect(root.namespaceUri).toBe('http://maven.apache.org/POM/4.0.0');
        expect(root.attributes.map((a) => [a.name, a.namespaceUri])).toEqual([
            ['xmlns', XMLNS_NAMESPACE],
            ['xmlns:xsi', XMLNS_NAMESPACE],
            ['xsi:schemaLocation', 'http://www.w3.org/2001/XMLSchema-instance']
        ]);
        expect(doc.namespaces).toEqual([
            { prefix: '', uri: 'http://maven.apache.org/POM/4.0.0', element: root.id },
            { prefix: 'xsi', uri: 'http://www.w3.org/2001/XMLSchema-instance', element: root.id }
        ]);
        expect(root.children.map((c) => c.kind)).toEqual(['element', 'element', 'comment', 'element']);
        const dependencies = elements(root)[2]!;
        expect(elements(dependencies)).toHaveLength(2);
        const version = elements(elements(dependencies)[0]!)[2]!;
        expect(version.children[0]).toMatchObject({ kind: 'text', value: '4.11' });
        // Every element range covers its start tag through its end tag.
        expect(doc.text.slice(version.range.start, version.range.end)).toBe('<version>4.11</version>');
        expect(doc.text.slice(version.openTag!.start, version.openTag!.end)).toBe('<version>');
        expect(xmlPosition(doc.lineStarts, version.range.start)).toEqual({ line: 11, column: 7 });
        // Ids are document order and index `nodes`.
        doc.nodes.forEach((node, index) => expect(node.id).toBe(index));
        expect(doc.nodes[version.parent]!.name).toBe('dependency');
        expect(doc.stats).toMatchObject({ elements: 12, attributes: 3, comments: 1, maxDepth: 4 });
        expect(parse(POM).status).toBe('ok');
    });

    it('keeps mixed content, CDATA, PIs, and the DOCTYPE with its internal entities', () => {
        const doc = documentOf(`<?xml version="1.0"?>
<!DOCTYPE note [
  <!ENTITY writer "Donald Duck.">
  <!ENTITY logo SYSTEM "logo.gif">
  <!-- a comment with a ] and a > inside -->
]>
<?xml-stylesheet href="style.xsl" type="text/xsl"?>
<note>Hello <b>big</b> world &writer; &#x41;&#66; &lt;tag&gt;<![CDATA[<raw> & stuff]]><?php echo 1; ?></note>`);
        expect(doc.doctype).toEqual({ name: 'note', publicId: '', systemId: '', entities: ['writer', 'logo'] });
        expect(doc.topLevel.map((n) => n.kind)).toEqual(['doctype', 'pi', 'element']);
        expect(doc.topLevel[1]).toMatchObject({ name: 'xml-stylesheet', value: 'href="style.xsl" type="text/xsl"' });
        const note = doc.root!;
        expect(note.children.map((c) => c.kind)).toEqual(['text', 'element', 'text', 'cdata', 'pi']);
        expect(note.children[2]!.value).toBe(' world Donald Duck. AB <tag>');
        expect(note.children[3]!.value).toBe('<raw> & stuff');
        expect(note.children[4]).toMatchObject({ name: 'php', value: 'echo 1;' });
    });

    it('drops whitespace-only text and normalizes line ends and attribute whitespace', () => {
        const doc = documentOf('<a x="1\r\n\t2" y="&#10;">\r\n  <b>one\r\ntwo</b>\r\n</a>');
        expect(doc.root!.children.map((c) => c.kind)).toEqual(['element']);
        expect(doc.root!.attributes.map((a) => a.value)).toEqual(['1  2', '\n']);
        expect(doc.root!.children[0]!.children[0]!.value).toBe('one\ntwo');
    });

    it('resolves prefixed, default, and re-declared namespaces with scope', () => {
        // Shape of a SOAP 1.1 envelope as JAX-WS writes it.
        const doc = documentOf(`<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/">
<S:Body><ns2:getQuote xmlns:ns2="urn:quotes" xmlns="urn:default"><symbol>ACME</symbol><inner xmlns=""/></ns2:getQuote></S:Body></S:Envelope>`);
        const body = elements(doc.root!)[0]!;
        const call = elements(body)[0]!;
        expect([doc.root!.prefix, doc.root!.local, doc.root!.namespaceUri]).toEqual(['S', 'Envelope', 'http://schemas.xmlsoap.org/soap/envelope/']);
        expect(call.namespaceUri).toBe('urn:quotes');
        expect(elements(call).map((e) => e.namespaceUri)).toEqual(['urn:default', '']);
    });

    it('reads Android manifest attributes in the android namespace', () => {
        const doc = documentOf(`<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app">
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:label="@string/app_name" android:theme="@style/AppTheme">
        <activity android:name=".MainActivity" android:exported="true"/>
    </application>
</manifest>`);
        const permission = elements(doc.root!)[0]!;
        expect(permission.selfClosing).toBe(true);
        expect(permission.attributes[0]).toMatchObject({ prefix: 'android', local: 'name', namespaceUri: 'http://schemas.android.com/apk/res/android', value: 'android.permission.INTERNET' });
        expect(doc.root!.attributes.find((a) => a.name === 'package')!.namespaceUri).toBe('');
    });

    it('reads an MSBuild SDK project', () => {
        // Shape of `dotnet new console` output: no namespace, conditions in attributes.
        const doc = documentOf(`<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>

  <ItemGroup Condition="'$(Configuration)' == 'Debug'">
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>

</Project>
`);
        expect(doc.root!.attributes[0]).toMatchObject({ name: 'Sdk', value: 'Microsoft.NET.Sdk', namespaceUri: '' });
        const [properties, items] = elements(doc.root!);
        expect(elements(properties!).map((e) => [e.name, e.children[0]!.value])).toEqual([['OutputType', 'Exe'], ['TargetFramework', 'net8.0'], ['Nullable', 'enable']]);
        expect(items!.attributes[0]!.value).toBe("'$(Configuration)' == 'Debug'");
        expect(elements(items!)[0]!.attributes.map((a) => a.name)).toEqual(['Include', 'Version']);
    });

    it('reads an RSS 2.0 feed, reporting the bare & a sloppy writer leaves in a link', () => {
        const result = parse(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>Example &amp; Co</title>
  <atom:link href="https://example.com/feed" rel="self" type="application/rss+xml"/>
  <item>
    <title>First post</title>
    <link>https://example.com/?p=1&utm_source=rss</link>
    <dc:creator><![CDATA[Jane Doe]]></dc:creator>
    <description><![CDATA[<p>Hello <b>world</b></p>]]></description>
    <pubDate>Mon, 05 Oct 2026 09:00:00 +0000</pubDate>
  </item>
</channel>
</rss>`);
        expect(result.status).toBe('partial');
        expect(result.diagnostics.map((d) => [d.messageKey, d.location])).toEqual([['diag.xml.bareAmpersand', '8:35']]);
        if (result.status === 'failed') return;
        const channel = elements(result.document.root!)[0]!;
        expect(elements(channel)[0]!.children[0]!.value).toBe('Example & Co');
        expect(elements(channel)[1]).toMatchObject({ prefix: 'atom', namespaceUri: 'http://www.w3.org/2005/Atom' });
        const item = elements(channel)[2]!;
        expect(elements(item)[1]!.children[0]!.value).toBe('https://example.com/?p=1&utm_source=rss');
        expect(elements(item)[2]).toMatchObject({ prefix: 'dc', namespaceUri: 'http://purl.org/dc/elements/1.1/' });
        expect(elements(item)[3]!.children[0]).toMatchObject({ kind: 'cdata', value: '<p>Hello <b>world</b></p>' });
    });

    it('decodes UTF-16 with a BOM and CP1252 under an ISO-8859-1 declaration', () => {
        const utf16 = new Uint8Array([0xff, 0xfe, ...[...'<a>é</a>'].flatMap((c) => [c.charCodeAt(0), 0])]);
        expect(documentOf16(utf16).root!.children[0]!.value).toBe('é');
        const latin = new Uint8Array([...encode('<?xml version="1.0" encoding="ISO-8859-1"?><a>'), 0x93, 0xe9, 0x94, ...encode('</a>')]);
        const result = parse(latin);
        expect(result.status).toBe('ok');
        if (result.status !== 'failed') expect(result.document.root!.children[0]!.value).toBe('“é”');
    });
});

function documentOf16(bytes: Uint8Array): XmlDocument {
    const result = parseXml(bytes).result;
    if (result.status === 'failed') throw new Error(result.failure.messageKey);
    return result.document;
}

describe('parseXml — well-formedness diagnostics and recovery', () => {
    it('recovers a missing end tag by closing to the matching ancestor', () => {
        const result = parse('<a>\n  <b><c>text</b>\n</a>');
        expect(result.status).toBe('partial');
        if (result.status === 'failed') return;
        const c = result.document.root!.children[0]!.children[0]!;
        expect(c).toMatchObject({ name: 'c', closed: false });
        expect(result.diagnostics[0]).toMatchObject({ messageKey: 'diag.xml.unclosedElement', args: { name: 'c', line: 2, column: 6 }, location: '2:6' });
    });

    it('reports stray and mismatched end tags without losing the tree', () => {
        expect(codes('<a></b></a>')).toEqual(['diag.xml.mismatchedTag']);
        expect(codes('<a/></a>')).toEqual(['diag.xml.unexpectedEndTag']);
        expect(codes('<a><b>')).toEqual(['diag.xml.unclosedElement', 'diag.xml.unclosedElement']);
    });

    it('reports end tags carrying more than their name without losing the next element', () => {
        const missing = parse('<r><a></a <b>x</b></r>');
        expect(missing.diagnostics.map((d) => [d.messageKey, d.location])).toEqual([['diag.xml.unterminatedTag', '1:7']]);
        if (missing.status !== 'failed') expect(missing.document.root!.children.map((c) => c.name)).toEqual(['a', 'b']);
        expect(codes('<r></r junk="1">')).toEqual(['diag.xml.endTagSyntax']);
        expect(codes('<r></r  \n>')).toEqual([]);
    });

    it('reports attribute errors and keeps the attribute', () => {
        expect(codes('<a x="1" x="2"/>')).toEqual(['diag.xml.duplicateAttribute']);
        expect(codes('<a x=1/>')).toEqual(['diag.xml.attributeSyntax']);
        expect(codes('<a checked/>')).toEqual(['diag.xml.attributeSyntax']);
        expect(parse('<item id="1", name="x"/>').diagnostics.map((d) => [d.messageKey, d.args?.char, d.args?.name, d.location])).toEqual([['diag.xml.tagSyntax', ',', 'item', '1:13']]);
        expect(codes('<a x="<"/>')).toEqual(['diag.xml.ltInAttribute']);
        const doc = documentOf('<a x=1 checked/>');
        expect(doc.root!.attributes.map((a) => [a.name, a.value])).toEqual([['x', '1'], ['checked', '']]);
    });

    it('reports a < that an entity brings into an attribute value as an error', () => {
        const result = parse('<!DOCTYPE r [<!ENTITY e "a<b">]><r a="&e;">&e;</r>');
        expect(result.status).toBe('partial');
        expect(result.diagnostics.map((d) => [d.severity, d.messageKey])).toEqual([
            ['error', 'diag.xml.entityLtInAttribute'],
            ['info', 'diag.xml.entityMarkup']
        ]);
    });

    it('ignores entity declarations commented out in the internal subset', () => {
        const doc = documentOf('<!DOCTYPE a [<!-- <!ENTITY e "bad"> --><?pi <!ENTITY e "worse">?><!ENTITY e "good"><!ENTITY c "<!-- kept -->">]><a>&e;</a>');
        expect(doc.root!.children[0]!.value).toBe('good');
        expect(doc.doctype!.entities).toEqual(['e', 'c']);
    });

    it('skips processing instructions holding quotes inside the internal subset', () => {
        const doc = documentOf(`<!DOCTYPE r [<?pi don't?><!ENTITY e "x">]><r>&e;</r>`);
        expect(doc.root!.children[0]!.value).toBe('x');
        expect(doc.doctype!.entities).toEqual(['e']);
    });

    it('rejects floods of unmatched end tags under a deep stack in linear time', () => {
        const started = Date.now();
        const result = parse(`${'<a>'.repeat(999)}${'</x>'.repeat(300_000)}${'</a>'.repeat(999)}`);
        expect(Date.now() - started).toBeLessThan(1500);
        expect(result.diagnostics.filter((d) => d.messageKey === 'diag.xml.mismatchedTag').length).toBe(200);
    });

    it('reports attributes run together and expanded-name duplicates', () => {
        expect(parse('<a b="1"c="2"/>').diagnostics.map((d) => [d.messageKey, d.args?.name, d.location])).toEqual([['diag.xml.missingAttributeSpace', 'c', '1:9']]);
        expect(codes('<a b="1" c="2"/>')).toEqual([]);
        expect(codes('<a xmlns:p="u" xmlns:q="u" p:x="1" q:x="2"/>')).toEqual(['diag.xml.duplicateAttribute']);
        // Unprefixed attributes have no namespace, so x and p:x never collide.
        expect(codes('<a xmlns:p="u" x="1" p:x="2"/>')).toEqual([]);
    });

    it('reports namespace, root, placement, and character-data errors', () => {
        expect(codes('<p:a><p:b/></p:a>')).toEqual(['diag.xml.undeclaredPrefix']);
        expect(codes('<a/><b/><c/>')).toEqual(['diag.xml.multipleRoots']);
        expect(codes('junk<a/>')).toEqual(['diag.xml.textOutsideRoot']);
        expect(codes(' <?xml version="1.0"?><a/>')).toEqual(['diag.xml.misplacedDeclaration']);
        expect(codes('<a/><!DOCTYPE a>')).toEqual(['diag.xml.misplacedDoctype']);
        expect(codes('<a>1 < 2</a>')).toEqual(['diag.xml.unescapedLt']);
        expect(codes('<a>Tom & Jerry</a>')).toEqual(['diag.xml.bareAmpersand']);
        expect(codes('<a>&#0;</a>')).toEqual(['diag.xml.invalidCharRef']);
        expect(codes('<a><!-- open')).toContain('diag.xml.unterminatedComment');
        expect(documentOf('<a>1 < 2</a>').root!.children).toHaveLength(1);
    });

    it('keeps undefined and external entity references verbatim, reporting each name once', () => {
        const result = parse('<!DOCTYPE a [<!ENTITY ext SYSTEM "http://evil/x">]><a>&nbsp;&nbsp;&ext;</a>');
        expect(result.status).toBe('ok');
        expect(result.diagnostics.map((d) => [d.severity, d.messageKey])).toEqual([
            ['warning', 'diag.xml.undefinedEntity'],
            ['info', 'diag.xml.externalEntity']
        ]);
        if (result.status !== 'failed') expect(result.document.root!.children[0]!.value).toBe('&nbsp;&nbsp;&ext;');
    });

    it('decodes character references and predefined entities inside an internal entity value', () => {
        const doc = documentOf('<!DOCTYPE a [<!ENTITY co "AT&amp;T"><!ENTITY tag "&lt;b&gt;"><!ENTITY lt2 "&#38;lt;"><!ENTITY other "x&co;y">]><a>&co; &tag; &lt2; &other;</a>');
        expect(doc.root!.children[0]!.value).toBe('AT&T <b> < x&co;y');
    });

    it('normalizes entity text in attributes and reports entity markup shown as text', () => {
        const result = parse('<!DOCTYPE a [<!ENTITY t "x&#9;y"><!ENTITY m "<b>hi</b>">]><a v="&t;">&t; &m; &m;</a>');
        expect(result.diagnostics.map((d) => [d.severity, d.messageKey, d.args?.name])).toEqual([['info', 'diag.xml.entityMarkup', 'm']]);
        if (result.status === 'failed') return;
        expect(result.document.root!.attributes[0]!.value).toBe('x y');
        expect(result.document.root!.children[0]!.value).toBe('x\ty <b>hi</b> <b>hi</b>');
        expect(result.document.stats.elements).toBe(1);
    });

    it('expands internal entities one level only, so billion laughs stays linear', () => {
        const levels = ['<!ENTITY lol0 "lol">'];
        for (let i = 1; i < 10; i++) levels.push(`<!ENTITY lol${i} "${`&lol${i - 1};`.repeat(10)}">`);
        const doc = documentOf(`<!DOCTYPE lolz [${levels.join('')}]><lolz>&lol9;</lolz>`);
        expect(doc.root!.children[0]!.value).toBe('&lol8;'.repeat(10));
        // A flood of references to a plain entity stops at the budget.
        const big = 'x'.repeat(64 * 1024);
        const result = parse(`<!DOCTYPE a [<!ENTITY big "${big}">]><a>${'&big;'.repeat(20)}</a>`);
        expect(result.diagnostics.map((d) => d.messageKey)).toEqual(['diag.xml.entityExpansionLimit']);
        if (result.status !== 'failed') expect(result.document.root!.children[0]!.value.length).toBeLessThanOrEqual(XML_ENTITY_EXPANSION_BUDGET + 20 * 5);
    });

    it('decodes long runs of bare ampersands in linear time', () => {
        const run = 'x & y '.repeat(200_000);
        const started = Date.now();
        const result = parse(`<a b="${run}">${run};</a>`);
        expect(Date.now() - started).toBeLessThan(2000);
        expect(result.diagnostics.map((d) => d.messageKey)).toEqual(['diag.xml.bareAmpersand']);
    });

    it('summarizes diagnostics past the cap', () => {
        const result = parse(`<a>${'<b x="1" x="2"/>'.repeat(250)}</a>`);
        expect(result.diagnostics).toHaveLength(201);
        expect(result.diagnostics[200]).toMatchObject({ messageKey: 'diag.xml.moreDiagnostics', args: { count: 50 } });
    });
});

describe('parseXml — failures and limits', () => {
    it('fails without a root element or on binary input', () => {
        expect(parse('')).toMatchObject({ status: 'failed', failure: { code: 'invalid-format', messageKey: 'diag.xml.noRoot' } });
        expect(parse('just text')).toMatchObject({ status: 'failed', failure: { messageKey: 'diag.xml.noRoot' } });
        expect(parse(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toMatchObject({ status: 'failed', failure: { messageKey: 'diag.xml.notText' } });
    });

    it('enforces the input, node, and depth limits', () => {
        expect(parse('<a/>', { limits: { maxInputBytes: 2 } })).toMatchObject({ status: 'failed', failure: { code: 'limit-exceeded' } });
        // Exactly at the cap is complete; one node more is cut.
        expect(parse('<a><b/><c/></a>', { limits: { maxEntries: 3 } })).toMatchObject({ status: 'ok', diagnostics: [] });
        expect(parse('<a x="1"><!--c--><?p d?>t<![CDATA[u]]></a>', { limits: { maxEntries: 6 } }).status).toBe('ok');
        expect(parse('<a x="1"><!--c--><?p d?>t<![CDATA[u]]></a>', { limits: { maxEntries: 5 } }).status).toBe('partial');
        const nodes = parse(`<a>${'<b/>'.repeat(100)}</a>`, { limits: { maxEntries: 10 } });
        expect(nodes.status).toBe('partial');
        if (nodes.status !== 'failed') expect(nodes.document.nodes).toHaveLength(10);
        expect(nodes.diagnostics.map((d) => d.messageKey)).toEqual(['diag.xml.nodeLimit']);
        const deep = parse(`${'<d>'.repeat(50)}${'</d>'.repeat(50)}`, { maxDepth: 5 });
        expect(deep.status).toBe('partial');
        if (deep.status !== 'failed') expect(deep.document.stats.maxDepth).toBe(5);
        expect(deep.diagnostics.map((d) => d.messageKey)).toEqual(['diag.xml.depthLimit']);
    });

    it('honours an aborted signal', () => {
        const controller = new AbortController();
        controller.abort();
        expect(parse('<a/>', { signal: controller.signal })).toMatchObject({ status: 'failed', failure: { code: 'aborted' } });
    });

    it('accepts string input and warns about an encoding it cannot decode', () => {
        expect(parseXml('<a>ü</a>').result.status).toBe('ok');
        const result = parse('<?xml version="1.0" encoding="Shift_JIS"?><a/>');
        expect(result.status).toBe('ok');
        expect(result.diagnostics).toEqual([expect.objectContaining({ messageKey: 'diag.xml.unsupportedEncoding', args: { encoding: 'Shift_JIS' } })]);
    });

    it('parses a large flat document quickly and deterministically', () => {
        const text = `<rows>${Array.from({ length: 20_000 }, (_, i) => `<row id="${i}"><v>${i}</v></row>`).join('\n')}</rows>`;
        const first = parse(text);
        const second = parse(text);
        expect(first.status).toBe('ok');
        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
        if (first.status !== 'failed') expect(first.document.stats).toMatchObject({ elements: 40_001, attributes: 20_000, text: 20_000 });
    });
});
