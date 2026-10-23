// EPUB test fixtures. The package files reproduce what real writers emit —
// Project Gutenberg's ebookmaker (EPUB 2 with `opf:` attributes and an NCX;
// EPUB 3 with `refines` metadata, an SVG cover wrapper and `properties="nav"`)
// and the IDPF epub3-samples (nested navigation with `<span>` headings and
// `hidden` lists) — rather than the parser's own assumptions.
import { deflateRawSync } from 'node:zlib';

export interface ZipMember {
    name: string;
    data: string | Uint8Array;
    /** 0 = stored, 8 = deflate (default: stored for `mimetype`, deflate otherwise). */
    method?: 0 | 8;
    /** Overrides the uncompressed size written to the central directory. */
    declaredSize?: number;
    /** Sets the general-purpose encryption flag. */
    encrypted?: boolean;
}

const encoder = new TextEncoder();

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer (no data descriptors, no ZIP64). */
export function buildZip(members: readonly ZipMember[]): Uint8Array {
    const local: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const member of members) {
        const name = encoder.encode(member.name);
        const raw = typeof member.data === 'string' ? encoder.encode(member.data) : member.data;
        const method = member.method ?? (member.name === 'mimetype' ? 0 : 8);
        const payload = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
        const size = member.declaredSize ?? raw.byteLength;
        const flags = (member.encrypted ? 1 : 0) | 0x0800;
        const crc = crc32(raw);

        const header = new Uint8Array(30 + name.length);
        const hv = new DataView(header.buffer);
        hv.setUint32(0, 0x04034b50, true);
        hv.setUint16(4, 20, true);
        hv.setUint16(6, flags, true);
        hv.setUint16(8, method, true);
        hv.setUint32(14, crc, true);
        hv.setUint32(18, payload.byteLength, true);
        hv.setUint32(22, size, true);
        hv.setUint16(26, name.length, true);
        header.set(name, 30);
        local.push(header, payload);

        const record = new Uint8Array(46 + name.length);
        const cv = new DataView(record.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, flags, true);
        cv.setUint16(10, method, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, payload.byteLength, true);
        cv.setUint32(24, size, true);
        cv.setUint16(28, name.length, true);
        cv.setUint32(42, offset, true);
        record.set(name, 46);
        central.push(record);
        offset += header.byteLength + payload.byteLength;
    }
    const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, members.length, true);
    ev.setUint16(10, members.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    const parts = [...local, ...central, end];
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.byteLength;
    }
    return out;
}

export const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
\t<rootfiles>
\t\t<rootfile full-path="OEBPS/content.opf" \t
\t\t\tmedia-type="application/oebps-package+xml"/>
\t</rootfiles>
</container>`;

/** ebookmaker EPUB 3 package: `refines` creator metadata, cover-image, nav + NCX. */
export const OPF_EPUB3 = `<?xml version='1.0' encoding='UTF-8'?>

<package xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id" xml:lang="en">
  <metadata>
    <dc:rights>Public domain in the USA.</dc:rights>
    <dc:identifier id="id">http://www.gutenberg.org/11</dc:identifier>
    <dc:creator id="author_0">Lewis Carroll</dc:creator>
    <meta property="file-as" refines="#author_0">Carroll, Lewis</meta>
    <meta property="role" refines="#author_0" scheme="marc:relators">aut</meta>
    <dc:contributor id="ill">John Tenniel</dc:contributor>
    <meta property="role" refines="#ill" scheme="marc:relators">ill</meta>
    <dc:title id="t1">Alice's Adventures in Wonderland</dc:title>
    <dc:title id="t2">An Illustrated Edition</dc:title>
    <meta property="title-type" refines="#t2">subtitle</meta>
    <dc:language>en</dc:language>
    <dc:subject>Fantasy fiction</dc:subject>
    <dc:subject>Children's stories</dc:subject>
    <dc:date>2008-06-27</dc:date>
    <dc:description>&lt;p&gt;A girl falls &lt;em&gt;down&lt;/em&gt; a rabbit hole.&lt;/p&gt;</dc:description>
    <meta property="dcterms:modified">2026-10-01T07:31:59Z</meta>
    <meta property="belongs-to-collection" id="c1">Wonderland</meta>
    <meta property="group-position" refines="#c1">1</meta>
    <meta property="schema:accessMode">textual</meta>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <!--Image: 800 x 1104 size=104775 -->
    <item href="images/cover%20art.jpg" id="cover-img" media-type="image/jpeg" properties="cover-image"/>
    <item href="pgepub.css" id="item1" media-type="text/css"/>
    <item href="text/ch01.xhtml" id="ch1" media-type="application/xhtml+xml"/>
    <item href="text/ch02.xhtml" id="ch2" media-type="application/xhtml+xml"/>
    <item href="notes.xhtml" id="notes" media-type="application/xhtml+xml"/>
    <item href="toc.xhtml" id="nav" media-type="application/xhtml+xml" properties="nav"/>
    <item href="toc.ncx" id="ncx2" media-type="application/x-dtbncx+xml"/>
    <item href="wrap0000.xhtml" id="coverpage-wrapper" media-type="application/xhtml+xml" properties="svg"/>
  </manifest>
  <spine toc="ncx2">
    <itemref idref="coverpage-wrapper" linear="no"/>
    <itemref idref="ch1"/>
    <itemref idref="notes" linear="no"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

/** IDPF-style navigation: `<span>` heading, nested and `hidden` lists. */
export const NAV_XHTML = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
  <head><title>Contents</title></head>
  <body epub:type="frontmatter">
    <nav epub:type="landmarks"><ol><li><a epub:type="bodymatter" href="text/ch01.xhtml">Start</a></li></ol></nav>
    <nav epub:type="toc" role="doc-toc" aria-label="Table of Contents">
      <h2>THE CONTENTS</h2>
      <ol>
        <li>
          <a href="text/ch01.xhtml">CHAPTER I.
            Down the Rabbit-Hole</a>
          <ol hidden="hidden">
            <li><a href="text/ch01.xhtml#fall">The Fall</a></li>
          </ol>
        </li>
        <li class="body">
          <span class="author">Part Two</span>
          <ol>
            <li><a href="text/ch02.xhtml#pool">CHAPTER II. The Pool of Tears&#160;&mdash;&nbsp;Part</a></li>
          </ol>
        </li>
      </ol>
    </nav>
  </body>
</html>`;

export const NCX = `<?xml version='1.0' encoding='UTF-8'?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="en">
  <head><meta name="dtb:uid" content="http://www.gutenberg.org/11"/></head>
  <docTitle><text>Alice's Adventures in Wonderland</text></docTitle>
  <navMap>
    <navPoint id="np-1" playOrder="1">
      <navLabel><text>CHAPTER I. Down the Rabbit-Hole</text></navLabel>
      <content src="text/ch01.xhtml#pgepubid00003"/>
      <navPoint id="np-2" playOrder="2">
        <navLabel><text>The Fall</text></navLabel>
        <content src="text/ch01.xhtml#fall"/>
      </navPoint>
    </navPoint>
    <navPoint id="np-3" playOrder="3">
      <navLabel><text>CHAPTER II. The Pool of Tears</text></navLabel>
      <content src="text/ch02.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`;

export const COVER_WRAPPER = `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
  <head><title>"Cover"</title><link href="pgepub.css" rel="stylesheet"/></head>
<body class="x-ebookmaker-coverpage">
  <div class="x-ebookmaker-cover">
    <svg xmlns="http://www.w3.org/2000/svg" height="100%" preserveAspectRatio="xMidYMid meet" version="1.1" viewBox="0 0 800 1104" width="100%" xmlns:xlink="http://www.w3.org/1999/xlink">
      <image width="800" height="1104" xlink:href="images/cover%20art.jpg"/>
    </svg>
  </div>
</body>
</html>`;

export const CHAPTER_1 = `<?xml version='1.0' encoding='utf-8'?>

<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head>
<meta charset="utf-8"/><title>CHAPTER I.</title>
<link href="../pgepub.css" rel="stylesheet" type="text/css"/>
<style>body { background: red }</style>
</head>
<body class="x-ebookmaker"><div class="chapter omni-epub__page" id="pgepubid00003">
<h2><a id="chap01"/>CHAPTER I.<br/>
Down the Rabbit-Hole</h2>
<p style="position:fixed">Alice was beginning to get very tired.<a epub:type="noteref" href="../notes.xhtml#n1">1</a></p>
<p id="fall">She fell <a href="#chap01">back to top</a> and <a href="ch02.xhtml#pool">on to the pool</a>.</p>
<p><img src="../images/cover%20art.jpg" alt="Alice"/><img src="https://tracker.example/pixel.gif" alt="pixel"/></p>
<p><a href="https://www.gutenberg.org/">Gutenberg</a> <a href="javascript:alert(1)">bad</a> <a href="missing.xhtml">gone</a></p>
<script>window.pwned = true</script>
<form action="https://evil.example/"><input name="q"/></form>
</div></body>
</html>`;

export const CHAPTER_2 = `<?xml version='1.0' encoding='utf-8'?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" dir="ltr">
<head><title>CHAPTER II.</title></head>
<body><h2 id="pool">CHAPTER II. The Pool of Tears</h2><p>&#8220;Curiouser and curiouser!&#8221; cried Alice.</p>
<script type="text/javascript">
<![CDATA[
  var navLists = document.getElementsByTagName('nav');
]]>
</script>
</body>
</html>`;

export const NOTES = `<?xml version='1.0' encoding='utf-8'?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Notes</title></head>
<body><aside id="n1">The first note.</aside></body></html>`;

/** 1×1 transparent PNG — stands in for the cover JPEG (only its bytes travel). */
export const PIXEL = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82
]);

export function epub3Members(): ZipMember[] {
    return [
        { name: 'mimetype', data: 'application/epub+zip' },
        { name: 'META-INF/container.xml', data: CONTAINER_XML },
        { name: 'OEBPS/content.opf', data: OPF_EPUB3 },
        { name: 'OEBPS/toc.xhtml', data: NAV_XHTML },
        { name: 'OEBPS/toc.ncx', data: NCX },
        { name: 'OEBPS/wrap0000.xhtml', data: COVER_WRAPPER },
        { name: 'OEBPS/text/ch01.xhtml', data: CHAPTER_1 },
        { name: 'OEBPS/text/ch02.xhtml', data: CHAPTER_2 },
        { name: 'OEBPS/notes.xhtml', data: NOTES },
        { name: 'OEBPS/images/cover art.jpg', data: PIXEL, method: 0 },
        { name: 'OEBPS/pgepub.css', data: 'body{color:red}' }
    ];
}

export function epub3Fixture(): Uint8Array {
    return buildZip(epub3Members());
}

/** ebookmaker EPUB 2 package: `opf:` attributes, dated events, NCX only, cover by `<meta name="cover">`. */
export const OPF_EPUB2 = `<?xml version='1.0' encoding='UTF-8'?>
<package xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata>
    <dc:rights>Public domain in the USA.</dc:rights>
    <dc:identifier opf:scheme="URI" id="id">http://www.gutenberg.org/11</dc:identifier>
    <dc:identifier opf:scheme="ISBN">9780000000002</dc:identifier>
    <dc:creator opf:file-as="Carroll, Lewis" opf:role="aut">Lewis Carroll</dc:creator>
    <dc:title>Alice's Adventures in Wonderland</dc:title>
    <dc:language xsi:type="dcterms:RFC4646">en</dc:language>
    <dc:date opf:event="conversion">2026-10-01T07:31:56.365406+00:00</dc:date>
    <dc:date opf:event="publication">2008-06-27</dc:date>
    <dc:source>https://www.gutenberg.org/files/11/11-h/11-h.htm</dc:source>
    <meta name="calibre:series" content="Alice"/>
    <meta name="calibre:series_index" content="1.0"/>
    <meta name="cover" content="id-5123076874601297342"/>
  </metadata>
  <manifest>
    <item href="7981341119032183217_cover.jpg" id="id-5123076874601297342" media-type="image/jpeg"/>
    <item href="4040227324556390537_11-h-1.htm.html" id="item3" media-type="application/xhtml+xml"/>
    <item href="toc.ncx" id="ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="item3" linear="yes"/>
  </spine>
  <guide>
    <reference type="toc" title="Contents" href="4040227324556390537_11-h-1.htm.html#pgepubid00002"/>
  </guide>
</package>`;

export const NCX_EPUB2 = `<?xml version='1.0' encoding='UTF-8'?>
<!DOCTYPE ncx PUBLIC '-//NISO//DTD ncx 2005-1//EN' 'http://www.daisy.org/z3986/2005/ncx-2005-1.dtd'>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np-1" playOrder="1">
      <navLabel><text>CHAPTER I. Down the Rabbit-Hole</text></navLabel>
      <content src="4040227324556390537_11-h-1.htm.html#pgepubid00003"/>
    </navPoint>
  </navMap>
</ncx>`;

export function epub2Fixture(): Uint8Array {
    return buildZip([
        { name: 'mimetype', data: 'application/epub+zip' },
        { name: 'META-INF/container.xml', data: CONTAINER_XML },
        { name: 'OEBPS/content.opf', data: OPF_EPUB2 },
        { name: 'OEBPS/toc.ncx', data: NCX_EPUB2 },
        { name: 'OEBPS/4040227324556390537_11-h-1.htm.html', data: CHAPTER_2 },
        { name: 'OEBPS/7981341119032183217_cover.jpg', data: PIXEL, method: 0 }
    ]);
}
