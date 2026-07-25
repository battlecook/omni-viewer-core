import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { DocxDecompressionLimitError, parseChart, preprocessDocx, type ZipModule } from './docx-preprocess.js';

const zipModule = JSZip as unknown as ZipModule;

async function docxBytes(documentXml: string): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file('word/document.xml', documentXml);
    zip.file('word/_rels/document.xml.rels', '<Relationships></Relationships>');
    return zip.generateAsync({ type: 'uint8array' });
}

describe('DOCX preprocessing', () => {
    it('extracts cached chart categories, series, title and color', () => {
        const chart = parseChart(`<c:chart><c:title><a:t>Revenue</a:t></c:title><c:ser><c:tx><c:v>Sales</c:v></c:tx><a:srgbClr val="112233"/><c:cat><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:cat><c:val><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:val></c:ser></c:chart>`);
        expect(chart).toEqual({
            type: 'bar',
            sourceType: 'barChart',
            title: 'Revenue',
            categories: ['Q1', 'Q2'],
            series: [{ name: 'Sales', color: '#112233', values: [10, 20] }]
        });
    });

    it.each([
        ['barChart', 'bar'],
        ['lineChart', 'line'],
        ['pieChart', 'pie'],
        ['radarChart', 'unsupported']
    ] as const)('preserves %s instead of coercing it to bar', (sourceType, type) => {
        const chart = parseChart(`<c:${sourceType}><c:ser><c:tx><c:v>Sales</c:v></c:tx><c:cat><c:pt idx="0"><c:v>Q1</c:v></c:pt></c:cat><c:val><c:pt idx="0"><c:v>10</c:v></c:pt></c:val></c:ser></c:${sourceType}>`);
        expect(chart?.sourceType).toBe(sourceType);
        expect(chart?.type).toBe(type);
    });

    it('passes an ordinary document through under the default cap', async () => {
        const data = await docxBytes('<w:document><w:body></w:body></w:document>');
        const result = await preprocessDocx(data, zipModule);
        expect(result.placeholders).toEqual([]);
    });

    it('rejects a document that declares more uncompressed data than the cap', async () => {
        const data = await docxBytes(`<w:document>${'x'.repeat(4096)}</w:document>`);
        await expect(preprocessDocx(data, zipModule, undefined, 64)).rejects.toBeInstanceOf(DocxDecompressionLimitError);
    });

    it('loads xlsx only after an embedded workbook is discovered', async () => {
        const ordinary = await docxBytes('<w:document><w:body></w:body></w:document>');
        let loads = 0;
        await preprocessDocx(ordinary, zipModule, {
            loadSheet: async () => {
                loads += 1;
                throw new Error('should not load');
            }
        });
        expect(loads).toBe(0);

        const zip = new JSZip();
        zip.file(
            'word/document.xml',
            '<w:document><w:body><w:object><o:OLEObject r:id="rWorkbook"/></w:object></w:body></w:document>'
        );
        zip.file(
            'word/_rels/document.xml.rels',
            '<Relationships><Relationship Id="rWorkbook" Target="embeddings/book.xlsx" Type="package"/></Relationships>'
        );
        zip.file('word/embeddings/book.xlsx', new Uint8Array([1, 2, 3]));
        const embedded = await zip.generateAsync({ type: 'uint8array' });
        const result = await preprocessDocx(embedded, zipModule, {
            loadSheet: async () => {
                loads += 1;
                throw new Error('xlsx unavailable');
            }
        });
        expect(loads).toBe(1);
        expect(result.partial).toBe(true);
        expect(result.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'embedded-workbook-disabled' })
        ]));
    });

    it('uses AlternateContent chart fallback and reports it', async () => {
        const data = await docxBytes(
            '<w:document><mc:AlternateContent><mc:Choice><w:drawing><c:chart r:id="r1"/></w:drawing></mc:Choice><mc:Fallback><w:p><w:r><w:t>fallback</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent></w:document>'
        );
        const result = await preprocessDocx(data, zipModule);
        expect(result.partial).toBe(true);
        expect(result.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'chart-fallback-used' })
        ]));
    });

    it('omits media above a stricter host image limit', async () => {
        const zip = new JSZip();
        zip.file('word/document.xml', '<w:document><w:body/></w:document>');
        zip.file('word/_rels/document.xml.rels', '<Relationships/>');
        zip.file('word/media/image1.png', new Uint8Array(128));
        const data = await zip.generateAsync({ type: 'uint8array' });
        const result = await preprocessDocx(data, zipModule, { maxImageBytes: 16 });
        const prepared = await JSZip.loadAsync(result.data);
        expect((await prepared.file('word/media/image1.png')?.async('uint8array'))?.byteLength).toBe(0);
        expect(result.partial).toBe(true);
        expect(result.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'limit-exceeded',
                location: 'word/media/image1.png'
            })
        ]));
    });
});
