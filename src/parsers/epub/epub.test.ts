import { describe, expect, it, vi } from 'vitest';
import {
    CONTAINER_XML,
    NCX,
    OPF_EPUB3,
    buildZip,
    epub2Fixture,
    epub3Fixture,
    epub3Members,
    type ZipMember
} from './__tests__/fixture.js';
import { decodeMarkupText, isExternalHref, openEpubArchive, parseEpub, resolveEpubHref, type EpubDocument, type EpubTocEntry } from './index.js';
import { readXml } from './xml.js';

async function documentOf(data: Uint8Array): Promise<EpubDocument> {
    const { result } = await parseEpub(data);
    if (result.status === 'failed') throw new Error(result.failure.messageKey);
    return result.document;
}

const replace = (name: string, data: string): ZipMember[] =>
    epub3Members().map(member => (member.name === name ? { ...member, data } : member));
const without = (...names: string[]): ZipMember[] => epub3Members().filter(member => !names.includes(member.name));
const codes = async (data: Uint8Array): Promise<string[]> => (await parseEpub(data)).result.diagnostics.map(d => d.code);
const flatten = (entries: readonly EpubTocEntry[]): EpubTocEntry[] => entries.flatMap(entry => [entry, ...flatten(entry.children)]);

describe('parseEpub — EPUB 3', () => {
    it('reads refines metadata, titles, series, and a markup-free description', async () => {
        const { result } = await parseEpub(epub3Fixture());
        expect(result.status).toBe('ok');
        expect(result.diagnostics).toEqual([]);
        if (result.status === 'failed') return;
        const { metadata, version, packagePath } = result.document;
        expect(version).toBe('3.0');
        expect(packagePath).toBe('OEBPS/content.opf');
        expect(metadata.title).toBe("Alice's Adventures in Wonderland");
        expect(metadata.otherTitles).toEqual(['An Illustrated Edition']);
        expect(metadata.creators).toEqual([{ name: 'Lewis Carroll', role: 'aut', fileAs: 'Carroll, Lewis' }]);
        expect(metadata.contributors).toEqual([{ name: 'John Tenniel', role: 'ill', fileAs: '' }]);
        expect(metadata.identifiers).toEqual([{ value: 'http://www.gutenberg.org/11', scheme: '', unique: true }]);
        expect(metadata.languages).toEqual(['en']);
        expect(metadata.subjects).toEqual(['Fantasy fiction', "Children's stories"]);
        expect(metadata.description).toBe('A girl falls down a rabbit hole.');
        expect(metadata.modified).toBe('2026-10-01T07:31:59Z');
        expect(metadata.series).toBe('Wonderland');
        expect(metadata.seriesIndex).toBe('1');
        expect(metadata.other).toEqual([{ property: 'schema:accessMode', value: 'textual' }]);
    });

    it('resolves the manifest, percent-encoded hrefs, the cover, and the spine', async () => {
        const book = await documentOf(epub3Fixture());
        expect(book.coverPath).toBe('OEBPS/images/cover art.jpg');
        const cover = book.manifest.find(item => item.id === 'cover-img')!;
        expect(cover).toMatchObject({ href: 'images/cover%20art.jpg', path: 'OEBPS/images/cover art.jpg', present: true, size: 67 });
        expect(book.spine.map(item => [item.path, item.linear, item.kind])).toEqual([
            ['OEBPS/wrap0000.xhtml', false, 'xhtml'],
            ['OEBPS/text/ch01.xhtml', true, 'xhtml'],
            ['OEBPS/notes.xhtml', false, 'xhtml'],
            ['OEBPS/text/ch02.xhtml', true, 'xhtml']
        ]);
        expect(book.fileCount).toBe(11);
        expect(book.layout).toBe('reflowable');
        expect(book.direction).toBe('default');
    });

    it('prefers the navigation document and keeps span headings and hidden lists', async () => {
        const book = await documentOf(epub3Fixture());
        expect(book.tocSource).toBe('nav');
        expect(book.tocPath).toBe('OEBPS/toc.xhtml');
        expect(flatten(book.toc).map(entry => [entry.label, entry.path, entry.fragment, entry.spineIndex, entry.hidden])).toEqual([
            ['CHAPTER I. Down the Rabbit-Hole', 'OEBPS/text/ch01.xhtml', '', 1, false],
            ['The Fall', 'OEBPS/text/ch01.xhtml', 'fall', 1, true],
            ['Part Two', '', '', -1, false],
            ['CHAPTER II. The Pool of Tears — Part', 'OEBPS/text/ch02.xhtml', 'pool', 3, false]
        ]);
        // Chapters are named from the contents, a whole-document entry first.
        expect(book.spine.map(item => item.title)).toEqual(['', 'CHAPTER I. Down the Rabbit-Hole', '', 'CHAPTER II. The Pool of Tears — Part']);
    });

    it('falls back to the NCX when the navigation document has no entries', async () => {
        const book = await documentOf(buildZip(replace('OEBPS/toc.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc"><ol/></nav></body></html>')));
        expect(book.tocSource).toBe('ncx');
        expect(flatten(book.toc).map(entry => [entry.label, entry.fragment, entry.children.length])).toEqual([
            ['CHAPTER I. Down the Rabbit-Hole', 'pgepubid00003', 1],
            ['The Fall', 'fall', 0],
            ['CHAPTER II. The Pool of Tears', '', 0]
        ]);
    });

    it('reads stored and deflated members alike', async () => {
        const stored = buildZip(epub3Members().map(member => ({ ...member, method: 0 as const })));
        expect(await documentOf(stored)).toEqual(await documentOf(epub3Fixture()));
    });

    it('is deterministic for the same bytes', async () => {
        const data = epub3Fixture();
        expect((await parseEpub(data)).result).toEqual((await parseEpub(data)).result);
    });
});

describe('parseEpub — EPUB 2', () => {
    it('reads opf: attributes, the publication date event, calibre series, and the NCX', async () => {
        const book = await documentOf(epub2Fixture());
        expect(book.version).toBe('2.0');
        expect(book.metadata.creators).toEqual([{ name: 'Lewis Carroll', role: 'aut', fileAs: 'Carroll, Lewis' }]);
        expect(book.metadata.identifiers).toEqual([
            { value: 'http://www.gutenberg.org/11', scheme: 'URI', unique: true },
            { value: '9780000000002', scheme: 'ISBN', unique: false }
        ]);
        expect(book.metadata.date).toBe('2008-06-27');
        expect(book.metadata.series).toBe('Alice');
        expect(book.metadata.seriesIndex).toBe('1.0');
        expect(book.metadata.source).toBe('https://www.gutenberg.org/files/11/11-h/11-h.htm');
        expect(book.coverPath).toBe('OEBPS/7981341119032183217_cover.jpg');
        expect(book.tocSource).toBe('ncx');
        expect(book.toc[0]).toMatchObject({ label: 'CHAPTER I. Down the Rabbit-Hole', spineIndex: 0, fragment: 'pgepubid00003' });
    });
});

describe('parseEpub — OEB-style metadata wrappers', () => {
    it('reads OEB 1.2 capitalized Dublin Core names', async () => {
        const opf = OPF_EPUB3.replace(/<metadata>[\s\S]*<\/metadata>/,
            '<metadata><dc-metadata><dc:Title>Alice</dc:Title><dc:Creator role="aut">Lewis Carroll</dc:Creator><dc:Identifier id="BookId">123</dc:Identifier><dc:Language>en</dc:Language></dc-metadata></metadata>');
        const { metadata } = await documentOf(buildZip(replace('OEBPS/content.opf', opf)));
        expect([metadata.title, metadata.creators[0]?.name, metadata.creators[0]?.role, metadata.identifiers[0]?.value, metadata.languages]).toEqual(['Alice', 'Lewis Carroll', 'aut', '123', ['en']]);
    });

    it('finds an EPUB 2 cover named inside x-metadata', async () => {
        const opf = OPF_EPUB3
            .replace(' properties="cover-image"', '')
            .replace('<meta name="cover" content="cover-img"/>', '<x-metadata><meta name="cover" content="cover-img"/><meta property="rendition:layout">pre-paginated</meta></x-metadata>');
        const book = await documentOf(buildZip(replace('OEBPS/content.opf', opf)));
        expect(book.coverPath).toBe('OEBPS/images/cover art.jpg');
        expect(book.layout).toBe('pre-paginated');
    });
});

describe('parseEpub — damaged and hostile input', () => {
    it('fails for non-ZIP input and for a ZIP without a package', async () => {
        const notZip = (await parseEpub(new TextEncoder().encode('hello'))).result;
        expect(notZip.status === 'failed' && notZip.failure).toMatchObject({ code: 'invalid-format', messageKey: 'diag.epub.not-zip' });
        const bare = (await parseEpub(buildZip([{ name: 'readme.txt', data: 'x' }]))).result;
        expect(bare.status === 'failed' && bare.failure.messageKey).toBe('diag.epub.no-package');
    });

    it('opens a lone package document when container.xml is missing, and reports it', async () => {
        const { result } = await parseEpub(buildZip(without('META-INF/container.xml', 'mimetype')));
        expect(result.status).toBe('ok');
        expect(result.diagnostics.map(d => [d.code, d.args])).toEqual([
            ['mimetype-missing', undefined],
            ['container-missing', { path: 'OEBPS/content.opf' }]
        ]);
    });

    it('reports a wrong mimetype without failing', async () => {
        expect(await codes(buildZip(replace('mimetype', 'application/zip')))).toEqual(['mimetype-mismatch']);
    });

    it('marks the book partial when a spine document or idref is missing', async () => {
        const opf = OPF_EPUB3.replace('<itemref idref="ch2"/>', '<itemref idref="ch2"/><itemref idref="ghost"/>');
        const { result } = await parseEpub(buildZip([...replace('OEBPS/content.opf', opf).filter(member => member.name !== 'OEBPS/text/ch02.xhtml')]));
        expect(result.status).toBe('partial');
        expect(result.diagnostics.map(d => [d.code, d.location ?? d.args?.['idref'] ?? d.args?.['count']])).toEqual([
            ['manifest-missing', 1],
            ['resource-missing', 'OEBPS/text/ch02.xhtml'],
            ['spine-idref', 'ghost']
        ]);
        if (result.status !== 'failed') expect(result.document.spine.find(item => item.idref === 'ch2')?.present).toBe(false);
    });

    it('reports unknown itemrefs as one counted diagnostic', async () => {
        const ghosts = '<itemref idref="x"/>'.repeat(5000);
        const opf = OPF_EPUB3.replace('<itemref idref="ch2"/>', `<itemref idref="ch2"/>${ghosts}`);
        const { result } = await parseEpub(buildZip(replace('OEBPS/content.opf', opf)));
        const idrefs = result.diagnostics.filter(d => d.code === 'spine-idref');
        expect(idrefs.map(d => d.args)).toEqual([{ count: 5000, idref: 'x' }]);
    });

    it('fails as DRM-protected when every spine document is encrypted, ignoring font obfuscation', async () => {
        const encryption = (algorithm: string, uris: string[]) => `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
${uris.map(uri => `<enc:EncryptedData><enc:EncryptionMethod Algorithm="${algorithm}"/><enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData>`).join('\n')}
</encryption>`;
        const all = ['OEBPS/wrap0000.xhtml', 'OEBPS/text/ch01.xhtml', 'OEBPS/notes.xhtml', 'OEBPS/text/ch02.xhtml'];
        const drm = (await parseEpub(buildZip([...epub3Members(), { name: 'META-INF/encryption.xml', data: encryption('http://www.w3.org/2001/04/xmlenc#aes128-cbc', all) }]))).result;
        expect(drm.status === 'failed' && drm.failure).toMatchObject({ code: 'password-required', retryable: false, messageKey: 'diag.epub.drm' });

        const some = (await parseEpub(buildZip([...epub3Members(), { name: 'META-INF/encryption.xml', data: encryption('http://www.w3.org/2001/04/xmlenc#aes128-cbc', ['OEBPS/text/ch02.xhtml']) }]))).result;
        expect(some.status).toBe('partial');
        expect(some.diagnostics.map(d => [d.code, d.args])).toEqual([['encrypted', { count: 1 }]]);

        const fonts = (await parseEpub(buildZip([...epub3Members(), { name: 'META-INF/encryption.xml', data: encryption('http://www.idpf.org/2008/embedding', all) }]))).result;
        expect(fonts.status).toBe('ok');
    });

    it('rejects a member that inflates past its declared size instead of trusting it', async () => {
        const members = epub3Members().map(member =>
            member.name === 'OEBPS/content.opf' ? { ...member, declaredSize: 64 } : member);
        const { result } = await parseEpub(buildZip(members));
        expect(result.status === 'failed' && result.failure).toMatchObject({ code: 'corrupted', messageKey: 'diag.epub.package-unreadable' });
    });

    it('enforces the input, decompression, and item limits', async () => {
        const data = epub3Fixture();
        const big = (await parseEpub(data, { limits: { maxInputBytes: 100 } })).result;
        expect(big.status === 'failed' && big.failure.code).toBe('limit-exceeded');
        const budget = (await parseEpub(data, { limits: { maxDecompressedBytes: 200 } })).result;
        expect(budget.status === 'failed' && budget.failure.messageKey).toBe('diag.epub.decompressed-limit');
        const items = (await parseEpub(data, { maxItems: 5 })).result;
        expect(items.status).toBe('partial');
        expect(items.diagnostics.filter(d => d.code === 'item-limit').map(d => d.location)).toEqual(['manifest']);
        // A cap that leaves no spine document is a failure, not an empty book.
        const none = (await parseEpub(data, { maxItems: 2 })).result;
        expect(none.status === 'failed' && none.failure.messageKey).toBe('diag.epub.no-spine');
    });

    it('fails cleanly when aborted and when no inflater exists', async () => {
        const controller = new AbortController();
        controller.abort();
        const aborted = (await parseEpub(epub3Fixture(), { signal: controller.signal })).result;
        expect(aborted.status === 'failed' && aborted.failure).toMatchObject({ code: 'aborted', retryable: true });
        const noInflate = (await parseEpub(epub3Fixture(), {
            inflate: async () => { throw new Error('nope'); }
        })).result;
        expect(noInflate.status === 'failed' && noInflate.failure.code).toBe('corrupted');
    });

    it('uses an injected inflater', async () => {
        let calls = 0;
        const { inflateRawSync } = await import('node:zlib');
        const { result } = await parseEpub(epub3Fixture(), {
            inflate: async compressed => { calls++; return new Uint8Array(inflateRawSync(compressed)); }
        });
        expect(result.status).toBe('ok');
        expect(calls).toBeGreaterThan(0);
    });

    it('fails when the package has no manifest or spine', async () => {
        const { result } = await parseEpub(buildZip(replace('OEBPS/content.opf', '<package version="3.0"><metadata/></package>')));
        expect(result.status === 'failed' && result.failure.messageKey).toBe('diag.epub.package-invalid');
        const empty = OPF_EPUB3.replace(/<spine[\s\S]*<\/spine>/, '<spine/>');
        const noSpine = (await parseEpub(buildZip(replace('OEBPS/content.opf', empty)))).result;
        expect(noSpine.status === 'failed' && noSpine.failure.messageKey).toBe('diag.epub.no-spine');
    });

    it('reports fixed layout and RTL progression', async () => {
        const opf = OPF_EPUB3
            .replace('<meta name="cover"', '<meta property="rendition:layout">pre-paginated</meta><meta name="cover"')
            .replace('<spine toc="ncx2">', '<spine toc="ncx2" page-progression-direction="rtl">');
        const { result } = await parseEpub(buildZip(replace('OEBPS/content.opf', opf)));
        expect(result.diagnostics.map(d => d.code)).toEqual(['fixed-layout']);
        if (result.status !== 'failed') expect([result.document.layout, result.document.direction]).toEqual(['pre-paginated', 'rtl']);
    });

    it('notes the absence of any table of contents', async () => {
        const opf = OPF_EPUB3.replace(' properties="nav"', '').replace('<spine toc="ncx2">', '<spine>').replace(/<item href="toc.ncx"[^>]*\/>/, '');
        const book = await parseEpub(buildZip(replace('OEBPS/content.opf', opf).filter(member => member.name !== 'OEBPS/toc.ncx')));
        expect(book.result.diagnostics.map(d => d.code)).toEqual(['toc-missing']);
        if (book.result.status !== 'failed') expect(book.result.document.tocSource).toBe('none');
    });

    it('never resolves book strings to Object.prototype members', async () => {
        const opf = OPF_EPUB3
            .replace("<dc:title id=\"t1\">Alice's Adventures in Wonderland</dc:title>", '<dc:title id="t1">&constructor; &toString;</dc:title>')
            .replace('href="text/ch02.xhtml" id="ch2" media-type="application/xhtml+xml"', 'href="text/ch02.xhtml" id="ch2" media-type="constructor"');
        const book = await documentOf(buildZip(replace('OEBPS/content.opf', opf)));
        expect(book.metadata.title).toBe('&constructor; &toString;');
        expect(book.spine.find(item => item.idref === 'ch2')?.kind).toBe('unsupported');
        expect(() => structuredClone(book)).not.toThrow();
    });

    it('reads EPUB 2 OEB 1.x documents as HTML chapters', async () => {
        const opf = OPF_EPUB3.replace('href="text/ch01.xhtml" id="ch1" media-type="application/xhtml+xml"', 'href="text/ch01.xhtml" id="ch1" media-type="text/x-oeb1-document"');
        const { result } = await parseEpub(buildZip(replace('OEBPS/content.opf', opf)));
        expect(result.diagnostics).toEqual([]);
        if (result.status !== 'failed') expect(result.document.spine.find(item => item.idref === 'ch1')?.kind).toBe('html');
    });

    it('strips description markup in linear time on hostile input', async () => {
        for (const body of ['&lt;br'.repeat(40_000), '&lt;/p&gt;' + '&lt;'.repeat(100_000)]) {
            const opf = OPF_EPUB3.replace(/<dc:description>[\s\S]*?<\/dc:description>/, `<dc:description>${body}</dc:description>`);
            const data = buildZip(replace('OEBPS/content.opf', opf));
            const started = performance.now();
            await parseEpub(data);
            expect(performance.now() - started).toBeLessThan(2000);
        }
    });

    it('reads long refines lists in linear time', async () => {
        const n = 20_000;
        const flood = '<dc:creator id="a">x</dc:creator>'.repeat(n) + '<meta refines="#a" property="z">1</meta>'.repeat(n);
        const opf = OPF_EPUB3.replace('<dc:language>en</dc:language>', `<dc:language>en</dc:language>${flood}`);
        const data = buildZip(replace('OEBPS/content.opf', opf));
        const started = performance.now();
        const { result } = await parseEpub(data);
        expect(performance.now() - started).toBeLessThan(3000);
        if (result.status !== 'failed') expect(result.document.metadata.creators.length).toBe(n + 1);
    });

    it('does not let hrefs climb out of the container', async () => {
        const opf = OPF_EPUB3.replace('href="text/ch01.xhtml"', 'href="../../../etc/passwd"');
        const book = await documentOf(buildZip(replace('OEBPS/content.opf', opf)));
        expect(book.manifest.find(item => item.id === 'ch1')).toMatchObject({ path: '', present: false });
    });
});

describe('EPUB helpers', () => {
    it('resolves hrefs relative to the referring file', () => {
        expect(resolveEpubHref('OEBPS/text/ch01.xhtml', '../images/a%20b.png#x')).toEqual({ path: 'OEBPS/images/a b.png', fragment: 'x' });
        expect(resolveEpubHref('OEBPS/text/ch01.xhtml', '#top')).toEqual({ path: 'OEBPS/text/ch01.xhtml', fragment: 'top' });
        expect(resolveEpubHref('OEBPS/a.xhtml', './b.xhtml?x=1')).toEqual({ path: 'OEBPS/b.xhtml', fragment: '' });
        expect(resolveEpubHref('a.xhtml', '../../x')).toBeNull();
        expect(resolveEpubHref('a.xhtml', 'https://example.com/')).toBeNull();
        expect(isExternalHref('mailto:a@b.c')).toBe(true);
        expect(isExternalHref('chapter:1.xhtml')).toBe(true);
        expect(isExternalHref('chapter1.xhtml')).toBe(false);
    });

    it('decodes Unicode BOMs and bundled legacy encodings', () => {
        const latin = Uint8Array.from([...new TextEncoder().encode('<?xml version="1.0" encoding="windows-1252"?><p>'), 0x93, 0xe9, 0x94]);
        expect(decodeMarkupText(latin).text).toBe('<?xml version="1.0" encoding="windows-1252"?><p>“é”');
        const utf16 = Uint8Array.from([0xff, 0xfe, 0x3c, 0x00, 0x61, 0x00]);
        expect(decodeMarkupText(utf16)).toMatchObject({ text: '<a', encoding: 'utf-16le' });
        const sjis = new TextEncoder().encode('<?xml version="1.0" encoding="Shift_JIS"?><a/>');
        expect(decodeMarkupText(sjis).unsupportedEncoding).toBe('Shift_JIS');
    });

    it('opens a container with trailing bytes after the end record', async () => {
        const data = epub3Fixture();
        const padded = new Uint8Array(data.byteLength + 4);
        padded.set(data);
        padded.set([0x0a, 0, 0, 0], data.byteLength);
        expect((await parseEpub(padded)).result.status).toBe('ok');
    });

    it('reads members on demand, capped per call', async () => {
        const archive = openEpubArchive(epub3Fixture())!;
        expect((await archive.readText('OEBPS/toc.ncx')).text).toBe(NCX);
        expect(archive.has('oebps/TOC.ncx')).toBe(true);
        await expect(archive.read('OEBPS/toc.ncx', 10)).rejects.toMatchObject({ code: 'too-large' });
        await expect(archive.read('nope')).rejects.toMatchObject({ code: 'missing' });
        const encrypted = openEpubArchive(buildZip([{ name: 'a', data: 'x', encrypted: true }]))!;
        await expect(encrypted.read('a')).rejects.toMatchObject({ code: 'encrypted' });
    });

    it('charges each member against the decompression budget only once', async () => {
        const archive = openEpubArchive(epub3Fixture(), { maxDecompressedBytes: NCX.length + 10 })!;
        for (let i = 0; i < 5; i++) expect((await archive.readText('OEBPS/toc.ncx')).text).toBe(NCX);
        expect(archive.decompressedBytes).toBe(NCX.length);
        await expect(archive.read('OEBPS/content.opf')).rejects.toMatchObject({ code: 'budget-exceeded' });
    });

    it('reserves the budget before inflating, so concurrent reads cannot overshoot it', async () => {
        const members = Array.from({ length: 5 }, (_, i) => ({ name: `img${i}.bin`, data: new Uint8Array(1000).fill(i) }));
        const archive = openEpubArchive(buildZip(members), { maxDecompressedBytes: 2500 })!;
        const results = await Promise.allSettled(members.map(member => archive.read(member.name)));
        expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected', 'rejected', 'rejected']);
        expect(archive.decompressedBytes).toBe(2000);
        // Concurrent readers of one member share a single inflation and charge.
        const shared = openEpubArchive(buildZip(members), { maxDecompressedBytes: 1000 })!;
        const [a, b] = await Promise.all([shared.read('img0.bin'), shared.read('img0.bin')]);
        expect(a).toBe(b);
        expect(shared.decompressedBytes).toBe(1000);
    });

    it('keeps a reservation while another read of the same member is still in flight', async () => {
        const { inflateRawSync } = await import('node:zlib');
        const inflate = (compressed: Uint8Array, _max: number, signal?: AbortSignal): Promise<Uint8Array> =>
            new Promise((resolve, reject) => {
                const timer = setTimeout(() => resolve(new Uint8Array(inflateRawSync(compressed))), 20);
                signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
            });
        const members = [0, 1, 2].map(i => ({ name: `m${i}`, data: new Uint8Array(1000).fill(i) }));
        const archive = openEpubArchive(buildZip(members), { maxDecompressedBytes: 2000, inflate })!;
        const first = new AbortController();
        const left = archive.read('m0', undefined, first.signal);
        const back = archive.read('m0', undefined, new AbortController().signal);
        first.abort();
        await expect(left).rejects.toMatchObject({ code: 'aborted' });
        expect((await back).byteLength).toBe(1000);
        expect(archive.decompressedBytes).toBe(1000);
        const rest = await Promise.allSettled([archive.read('m1'), archive.read('m2')]);
        expect(rest.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    });

    it('keeps the charge of a member that inflated once, even if a later read of it fails', async () => {
        const { inflateRawSync } = await import('node:zlib');
        let calls = 0;
        const archive = openEpubArchive(buildZip([{ name: 'a', data: 'hello world' }]), {
            inflate: async compressed => { if (calls++ > 0) throw new Error('flaky'); return new Uint8Array(inflateRawSync(compressed)); }
        })!;
        await archive.read('a');
        await expect(archive.read('a')).rejects.toMatchObject({ code: 'corrupted' });
        expect(archive.decompressedBytes).toBe(11);
    });

    it('labels image-only and title-only nav links', async () => {
        const nav = '<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc"><ol><li><a href="text/ch01.xhtml"><img src="x.png" alt="Opening"/></a></li><li><a href="text/ch02.xhtml" title="Second"></a></li></ol></nav></body></html>';
        const book = await documentOf(buildZip(replace('OEBPS/toc.xhtml', nav)));
        expect(book.toc.map(entry => entry.label)).toEqual(['Opening', 'Second']);
    });

    it('releases a reservation when inflation fails', async () => {
        const archive = openEpubArchive(buildZip([{ name: 'a', data: 'hello' }]), { inflate: async () => { throw new Error('x'); } })!;
        await expect(archive.read('a')).rejects.toMatchObject({ code: 'corrupted' });
        expect(archive.decompressedBytes).toBe(0);
    });

    it('decodes UTF-16BE without relying on the utf-16be TextDecoder label', () => {
        // Builds without full ICU reject the label; make this one do the same.
        const Real = TextDecoder;
        vi.stubGlobal('TextDecoder', class extends Real {
            constructor(label?: string, options?: TextDecoderOptions) {
                if (label === 'utf-16be') throw new RangeError('unsupported label');
                super(label, options);
            }
        });
        try {
            expect(decodeMarkupText(Uint8Array.from([0xfe, 0xff, 0x00, 0x3c]))).toMatchObject({ text: '<', encoding: 'utf-16be' });
        } finally {
            vi.unstubAllGlobals();
        }
        expect(decodeMarkupText(Uint8Array.from([0xfe, 0xff, 0x00, 0x3c, 0x00, 0x61, 0xac, 0x00]))).toMatchObject({ text: '<a\uac00', encoding: 'utf-16be' });
        expect(decodeMarkupText(Uint8Array.from([0x00, 0x3c, 0x00, 0x62])).text).toBe('<b');
    });

    it('stops at the time limit and says so', async () => {
        const { result } = await parseEpub(epub3Fixture(), { limits: { maxParseMillis: -1 } });
        expect(result.diagnostics.some(d => d.code === 'time-limit')).toBe(true);
    });

    it('ignores floods of stray end tags in constant time per tag', () => {
        // Relative, not absolute: with a backward stack scan the deep case costs
        // ~depth times the shallow one; with the open-name count they match.
        const flood = '</z>'.repeat(1_500_000);
        const time = (depth: number): number => {
            const started = performance.now();
            readXml('<a>'.repeat(depth) + flood, { maxNodes: 400_000, maxDepth: 256 });
            return performance.now() - started;
        };
        time(1);
        const shallow = time(1);
        const deep = time(250);
        expect(deep).toBeLessThan(shallow * 4 + 100);
    });

    it('decodes large windows-1252 chapters in chunks', () => {
        const size = 16 * 1024 * 1024;
        const legacy = new Uint8Array(size).fill(0x93);
        legacy.set(new TextEncoder().encode('<?xml version="1.0" encoding="windows-1252"?>'));
        const utf8 = new Uint8Array(size).fill(0x61);
        let started = performance.now();
        decodeMarkupText(utf8);
        const baseline = performance.now() - started;
        started = performance.now();
        const { text } = decodeMarkupText(legacy);
        const chunked = performance.now() - started;
        expect(text.length).toBe(size);
        expect(text.endsWith('\u201c\u201c')).toBe(true);
        // Per-character `+=` was ~100× the UTF-8 path; the chunked join stays close.
        expect(chunked).toBeLessThan(baseline * 40 + 200);
    });

    it('caps attributes per element and marks the read truncated', () => {
        const attributes = Array.from({ length: 5000 }, (_, i) => ` a${i}=""`).join('');
        const { root, truncated } = readXml(`<meta${attributes} name="cover"/>`, { maxNodes: 100, maxDepth: 10 });
        expect(Object.keys(root!.attributes)).toHaveLength(256);
        expect(truncated).toBe(true);
    });

    it('finds a meta charset past byte 256 and ignores a label cut off at the window edge', () => {
        const pad = (n: number): string => `<!DOCTYPE html><html><head><title>${'t'.repeat(n)}</title>`;
        const late = Uint8Array.from([...new TextEncoder().encode(`${pad(400)}<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"/></head><body>f`), 0xe9]);
        expect(decodeMarkupText(late).text.endsWith('f\u00e9')).toBe(true);
        const head = `${pad(0)}`;
        const cut = new TextEncoder().encode(`${head}${' '.repeat(1024 - head.length - '<meta charset="windows-'.length)}<meta charset="windows-1252">`);
        expect(decodeMarkupText(cut).unsupportedEncoding).toBe('');
    });

    it('recovers XML with mismatched tags, entities, and DOCTYPE subsets', () => {
        const { root } = readXml(`<!DOCTYPE x [<!ENTITY a "b">]><root><a>1<b>2</a><c x='&amp;&#x41;'/>&unknown;</root>`, { maxNodes: 100, maxDepth: 10 });
        expect(root?.name).toBe('root');
        expect(root?.children.map(node => (node.kind === 'element' ? node.name : node.text))).toEqual(['a', 'c', '&unknown;']);
        const limited = readXml('<a><b/><c/><d/></a>', { maxNodes: 2, maxDepth: 10 });
        expect(limited.truncated).toBe(true);
    });

    it('decodes ASCII and Latin-1 labels as windows-1252, as browsers do', () => {
        const latin = Uint8Array.from([...new TextEncoder().encode('<?xml version="1.0" encoding="iso-8859-1"?>'), 0x93, 0xe9, 0x94]);
        expect(decodeMarkupText(latin)).toMatchObject({ text: '<?xml version="1.0" encoding="iso-8859-1"?>\u201c\u00e9\u201d', encoding: 'windows-1252' });
        const ascii = Uint8Array.from([...new TextEncoder().encode('<?xml version="1.0" encoding="us-ascii"?>'), 0xe9]);
        expect(decodeMarkupText(ascii).text.endsWith('\u00e9')).toBe(true);
    });

    it('decodes the entities of an escaped-HTML description once more', async () => {
        const opf = OPF_EPUB3.replace(/<dc:description>[\s\S]*?<\/dc:description>/,
            '<dc:description>&lt;p&gt;Tom &amp;amp; Jerry&amp;#39;s &amp;quot;tale&amp;quot;&lt;/p&gt;</dc:description>');
        expect((await documentOf(buildZip(replace('OEBPS/content.opf', opf)))).metadata.description).toBe('Tom & Jerry\'s "tale"');
        // Plain text with angle brackets is not markup.
        for (const text of ['한강의 신작 &lt;채식주의자&gt;는 2007년에 출간되었다.', 'If x &lt; 3 and y &gt; 2 then z.']) {
            const angled = OPF_EPUB3.replace(/<dc:description>[\s\S]*?<\/dc:description>/, `<dc:description>${text}</dc:description>`);
            const expected = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
            expect((await documentOf(buildZip(replace('OEBPS/content.opf', angled)))).metadata.description).toBe(expected);
        }
        // Plain text that merely mentions an entity is left alone.
        const plain = OPF_EPUB3.replace(/<dc:description>[\s\S]*?<\/dc:description>/, '<dc:description>R&amp;amp;D</dc:description>');
        expect((await documentOf(buildZip(replace('OEBPS/content.opf', plain)))).metadata.description).toBe('R&amp;D');
    });

    it('does not take a nested list item as its parent\'s label', async () => {
        const nav = '<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc"><ol><li><div><a href="text/ch01.xhtml">Part</a></div><ol><li><a href="text/ch02.xhtml">Two</a></li></ol></li><li><ol><li><a href="text/ch01.xhtml">One</a></li></ol></li></ol></nav></body></html>';
        const book = await documentOf(buildZip(replace('OEBPS/toc.xhtml', nav)));
        expect(book.toc.map(entry => [entry.label, entry.path, entry.children.map(child => child.label)])).toEqual([
            ['Part', 'OEBPS/text/ch01.xhtml', ['Two']],
            ['', '', ['One']]
        ]);
    });

    it('keeps CONTAINER_XML parseable with tab-separated attributes', () => {
        const { root } = readXml(CONTAINER_XML, { maxNodes: 100, maxDepth: 10 });
        expect(JSON.stringify(root)).toContain('OEBPS/content.opf');
    });
});
