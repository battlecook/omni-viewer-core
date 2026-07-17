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
        expect(chart).toEqual({ title: 'Revenue', categories: ['Q1', 'Q2'], series: [{ name: 'Sales', color: '#112233', values: [10, 20] }] });
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
});
