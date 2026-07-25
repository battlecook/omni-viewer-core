import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import { parsePptxVscode } from './vscode.js';

interface SlideFixture {
    slideXml: string;
    slideRelationships?: string;
    files?: Record<string, string | Uint8Array>;
}

async function pptx(fixture: SlideFixture): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file(
        'ppt/presentation.xml',
        '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="r1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>'
    );
    zip.file(
        'ppt/_rels/presentation.xml.rels',
        '<Relationships><Relationship Id="r1" Type="slide" Target="slides/slide1.xml"/></Relationships>'
    );
    zip.file('ppt/slides/slide1.xml', fixture.slideXml);
    if (fixture.slideRelationships) {
        zip.file('ppt/slides/_rels/slide1.xml.rels', fixture.slideRelationships);
    }
    for (const [name, data] of Object.entries(fixture.files ?? {})) zip.file(name, data);
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

const pictureSlide = `
<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>
  <p:pic><p:nvPicPr><p:cNvPr id="1" name="Metafile"/></p:nvPicPr>
    <p:spPr><a:xfrm><a:off x="9525" y="19050"/><a:ext cx="952500" cy="476250"/></a:xfrm></p:spPr>
    <p:blipFill><a:blip r:embed="img"/></p:blipFill>
  </p:pic>
</p:spTree></p:cSld></p:sld>`;

const pictureRelationships =
    '<Relationships><Relationship Id="img" Type="image" Target="../media/image1.wmf"/></Relationships>';

describe('PPTX review regressions', () => {
    it('rejects entry-count and declared decompression limits as limit-exceeded', async () => {
        const input = await pptx({
            slideXml: '<p:sld xmlns:p="p"><p:cSld><p:spTree/></p:cSld></p:sld>',
            files: {
                'ppt/media/a.txt': 'a',
                'ppt/media/b.txt': 'b',
                'ppt/media/c.txt': 'c'
            }
        });
        const entries = await parsePptxVscode(input, { limits: { maxEntries: 2 } });
        expect(entries.result).toMatchObject({
            status: 'failed',
            failure: { code: 'limit-exceeded' },
            diagnostics: [{ code: 'pptx.limit-exceeded', args: { kind: 'entries' } }]
        });
        expect(entries.execution.hardLimitEnforced).toBe(false);

        const bytes = await parsePptxVscode(input, {
            limits: { maxDecompressedBytes: 16 }
        });
        expect(bytes.result).toMatchObject({
            status: 'failed',
            failure: { code: 'limit-exceeded' },
            diagnostics: [{ args: { kind: 'decompressed' } }]
        });

        let clock = 0;
        const now = vi.spyOn(Date, 'now').mockImplementation(() => {
            clock += 10;
            return clock;
        });
        try {
            const timed = await parsePptxVscode(input, {
                limits: { maxParseMillis: 5 }
            });
            expect(timed.result).toMatchObject({
                status: 'failed',
                failure: { code: 'limit-exceeded' },
                diagnostics: [{ args: { kind: 'time' } }]
            });
        } finally {
            now.mockRestore();
        }
    });

    it('keeps a damaged ZIP distinct from a resource-limit failure', async () => {
        const input = await pptx({
            slideXml: '<p:sld xmlns:p="p"><p:cSld><p:spTree/></p:cSld></p:sld>'
        });
        const parsed = await parsePptxVscode(input.slice(0, -8));
        expect(parsed.result).toMatchObject({
            status: 'failed',
            failure: { code: 'corrupted' },
            diagnostics: []
        });
    });

    it('does not substitute an unrelated raster for a metafile and exposes a placeholder diagnostic', async () => {
        const input = await pptx({
            slideXml: pictureSlide,
            slideRelationships: pictureRelationships,
            files: {
                'ppt/media/image1.wmf': new Uint8Array([1, 2, 3]),
                'ppt/media/unrelated.png': new Uint8Array([4, 5, 6])
            }
        });
        const parsed = await parsePptxVscode(input);
        expect(parsed.result.status).toBe('ok');
        if (parsed.result.status !== 'ok') return;
        expect(parsed.result.document.slides[0]?.elements).toMatchObject([
            { type: 'shape', fillColor: '#f7f7f7' }
        ]);
        expect(parsed.result.document.slides[0]?.elements.some((element) =>
            element.src?.includes('unrelated')
        )).toBe(false);
        expect(parsed.result.diagnostics).toContainEqual(expect.objectContaining({
            code: 'pptx.image.placeholder',
            slideNumber: 1,
            objectKind: 'image',
            handling: 'placeholder',
            frame: { x: 1, y: 2, width: 100, height: 50 }
        }));
    });

    it('uses only an exact-basename raster fallback for a metafile', async () => {
        const input = await pptx({
            slideXml: pictureSlide,
            slideRelationships: pictureRelationships,
            files: {
                'ppt/media/image1.wmf': new Uint8Array([1, 2, 3]),
                'ppt/media/image1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
                'ppt/media/unrelated.jpg': new Uint8Array([4, 5, 6])
            }
        });
        const parsed = await parsePptxVscode(input);
        expect(parsed.result.status).toBe('ok');
        if (parsed.result.status !== 'ok') return;
        expect(parsed.result.document.slides[0]?.elements[0]).toMatchObject({
            type: 'image',
            vectorFallback: true,
            src: expect.stringMatching(/^data:image\/png;base64,/)
        });
        expect(parsed.result.diagnostics).not.toContainEqual(expect.objectContaining({
            objectKind: 'image'
        }));
    });

    it('uses an injected metafile renderer and observes abort after conversion', async () => {
        const input = await pptx({
            slideXml: pictureSlide,
            slideRelationships: pictureRelationships,
            files: { 'ppt/media/image1.wmf': new Uint8Array([1, 2, 3]) }
        });
        const renderMetafile = vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
        const parsed = await parsePptxVscode(input, {}, { renderMetafile });
        expect(renderMetafile).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            'wmf',
            undefined
        );
        expect(parsed.result.status).toBe('ok');
        if (parsed.result.status === 'ok') {
            expect(parsed.result.document.slides[0]?.elements[0]?.src)
                .toMatch(/^data:image\/png;base64,/);
        }

        const abort = new AbortController();
        const aborted = await parsePptxVscode(
            input,
            { signal: abort.signal },
            {
                renderMetafile: async () => {
                    abort.abort();
                    return new Uint8Array([1]);
                }
            }
        );
        expect(aborted.result).toMatchObject({
            status: 'failed',
            failure: { code: 'aborted' },
            diagnostics: [{ code: 'pptx.aborted' }]
        });
    });

    it('preserves priority text and rich-table properties', async () => {
        const input = await pptx({
            slideXml: `
<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>
  <p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></a:xfrm></p:spPr>
    <p:txBody><a:bodyPr lIns="9525" rIns="19050" tIns="28575" bIns="38100" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/>
      <a:p><a:pPr algn="ctr" rtl="1"><a:lnSpc><a:spcPct val="120000"/></a:lnSpc><a:spcBef><a:spcPts val="600"/></a:spcBef><a:buAutoNum type="arabicPeriod" startAt="3"/></a:pPr>
        <a:r><a:rPr sz="1800" u="sng" strike="sngStrike" spc="100"><a:latin typeface="+mn-lt"/><a:hlinkClick r:id="link"/></a:rPr><a:t>Styled</a:t></a:r>
      </a:p>
    </p:txBody>
  </p:sp>
  <p:graphicFrame><a:xfrm><a:off x="0" y="952500"/><a:ext cx="1905000" cy="952500"/></a:xfrm>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid><a:gridCol w="952500"/><a:gridCol w="952500"/></a:tblGrid>
      <a:tr h="476250"><a:tc gridSpan="2"><a:txBody><a:p><a:r><a:rPr b="1"/><a:t>Merged</a:t></a:r></a:p></a:txBody><a:tcPr anchor="ctr" marL="9525"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:lnL><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:lnL></a:tcPr></a:tc><a:tc hMerge="1"><a:txBody><a:p/></a:txBody></a:tc></a:tr>
    </a:tbl></a:graphicData></a:graphic>
  </p:graphicFrame>
</p:spTree></p:cSld></p:sld>`,
            slideRelationships: '<Relationships><Relationship Id="layout" Type="x/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>',
            files: {
                'ppt/slideLayouts/slideLayout1.xml': '<p:sldLayout xmlns:p="p"><p:cSld><p:spTree/></p:cSld></p:sldLayout>',
                'ppt/slideLayouts/_rels/slideLayout1.xml.rels': '<Relationships><Relationship Id="master" Type="x/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>',
                'ppt/slideMasters/slideMaster1.xml': '<p:sldMaster xmlns:p="p"><p:cSld><p:spTree/></p:cSld></p:sldMaster>',
                'ppt/slideMasters/_rels/slideMaster1.xml.rels': '<Relationships><Relationship Id="theme" Type="x/theme" Target="../theme/theme1.xml"/></Relationships>',
                'ppt/theme/theme1.xml': '<a:theme xmlns:a="a"><a:themeElements><a:fontScheme><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos Theme"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>'
            }
        });
        const parsed = await parsePptxVscode(input);
        expect(parsed.result.status).toBe('ok');
        if (parsed.result.status !== 'ok') return;
        const [text, table] = parsed.result.document.slides[0]!.elements;
        expect(text).toMatchObject({
            type: 'text',
            textMargins: { left: 1, right: 2, top: 3, bottom: 4 },
            verticalAlign: 'ctr',
            autofit: 'normal',
            paragraphs: [{
                numbered: true,
                numberingFormat: 'arabicPeriod',
                numberingStartAt: 3,
                lineSpacingPercent: 120,
                spaceBeforePx: expect.closeTo(7.998, 2),
                rtl: true,
                runs: [{
                    fontFamily: 'Aptos Theme',
                    underline: true,
                    strike: true,
                    characterSpacingPx: expect.closeTo(1.333, 2),
                    hyperlink: 'link'
                }]
            }]
        });
        expect(table).toMatchObject({
            type: 'table',
            table: {
                firstRow: true,
                bandedRows: true,
                columnWidths: [100, 100],
                rows: [{
                    height: 50,
                    cells: [{
                        colSpan: 2,
                        fillColor: '#ff0000',
                        verticalAlign: 'ctr',
                        margins: { left: 1 },
                        borders: { left: '#0000ff' },
                        paragraphs: [{ runs: [{ bold: true }] }]
                    }, { merged: true }]
                }]
            }
        });
    });

    it.each([
        ['clusteredColumn', 'clustered', 'col'],
        ['percentStackedColumn', 'percentStacked', 'col'],
        ['clusteredBar', 'clustered', 'bar'],
        ['stackedBar', 'stacked', 'bar']
    ] as const)('parses %s chart data', async (expected, grouping, barDir) => {
        const chartXml = `<c:chartSpace xmlns:c="c"><c:chart><c:plotArea><c:barChart><c:barDir val="${barDir}"/><c:grouping val="${grouping}"/><c:ser><c:tx><c:v>S1</c:v></c:tx><c:cat><c:strCache><c:pt idx="0"><c:v>A</c:v></c:pt></c:strCache></c:cat><c:val><c:numCache><c:pt idx="0"><c:v>-2</c:v></c:pt></c:numCache></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`;
        const input = await pptx({
            slideXml: '<p:sld xmlns:p="p" xmlns:a="a" xmlns:c="c" xmlns:r="r"><p:cSld><p:spTree><p:graphicFrame><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="chart"/></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>',
            slideRelationships: '<Relationships><Relationship Id="chart" Type="chart" Target="../charts/chart1.xml"/></Relationships>',
            files: { 'ppt/charts/chart1.xml': chartXml }
        });
        const parsed = await parsePptxVscode(input);
        expect(parsed.result.status).toBe('ok');
        if (parsed.result.status === 'ok') {
            expect(parsed.result.document.slides[0]?.elements[0]?.chartData)
                .toMatchObject({ kind: expected, grouping, barDir, categories: ['A'] });
        }
    });

    it('parses pie chart categories, values, colors, and legend data', async () => {
        const input = await pptx({
            slideXml: '<p:sld xmlns:p="p" xmlns:a="a" xmlns:c="c" xmlns:r="r"><p:cSld><p:spTree><p:graphicFrame><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="chart"/></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>',
            slideRelationships: '<Relationships><Relationship Id="chart" Type="chart" Target="../charts/chart1.xml"/></Relationships>',
            files: {
                'ppt/charts/chart1.xml': '<c:chartSpace xmlns:c="c" xmlns:a="a"><c:chart><c:plotArea><c:pieChart><c:ser><c:dPt><c:idx val="0"/><c:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></c:spPr></c:dPt><c:cat><c:strCache><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="1"><c:v>B</c:v></c:pt></c:strCache></c:cat><c:val><c:numCache><c:pt idx="0"><c:v>2</c:v></c:pt><c:pt idx="1"><c:v>3</c:v></c:pt></c:numCache></c:val></c:ser></c:pieChart></c:plotArea><c:legend><c:legendPos val="r"/></c:legend></c:chart></c:chartSpace>'
            }
        });
        const parsed = await parsePptxVscode(input);
        expect(parsed.result.status).toBe('ok');
        if (parsed.result.status === 'ok') {
            expect(parsed.result.document.slides[0]?.elements[0]?.chartData)
                .toMatchObject({
                    kind: 'pie',
                    categories: ['A', 'B'],
                    series: [
                        { name: 'A', color: '#ff0000', values: [2] },
                        { name: 'B', values: [3] }
                    ],
                    legend: { position: 'r' }
                });
        }
    });

    it('uses SmartArt text as a readable fallback and reports simplification', async () => {
        const input = await pptx({
            slideXml: '<p:sld xmlns:p="p" xmlns:a="a" xmlns:dgm="dgm" xmlns:r="r"><p:cSld><p:spTree><p:graphicFrame><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds r:dm="data"/></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>',
            slideRelationships: '<Relationships><Relationship Id="data" Type="diagramData" Target="../diagrams/data1.xml"/></Relationships>',
            files: {
                'ppt/diagrams/data1.xml': '<dgm:dataModel xmlns:dgm="dgm" xmlns:a="a"><a:t>Plan</a:t><a:t>Build</a:t></dgm:dataModel>'
            }
        });
        const parsed = await parsePptxVscode(input);
        expect(parsed.result.status).toBe('ok');
        if (parsed.result.status !== 'ok') return;
        expect(parsed.result.document.slides[0]?.elements[0]).toMatchObject({
            chartKind: 'smartart',
            paragraphs: [{ text: 'Plan' }, { text: 'Build' }]
        });
        expect(parsed.result.diagnostics).toContainEqual(expect.objectContaining({
            objectKind: 'smartart',
            handling: 'simplified'
        }));
    });

    it('prefers an explicitly related SmartArt fallback image', async () => {
        const input = await pptx({
            slideXml: '<p:sld xmlns:p="p" xmlns:a="a" xmlns:dgm="dgm" xmlns:r="r"><p:cSld><p:spTree><p:graphicFrame><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds r:dm="data"/><a:blip r:embed="fallback"/></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>',
            slideRelationships: '<Relationships><Relationship Id="data" Type="x/diagramData" Target="../diagrams/data1.xml"/><Relationship Id="fallback" Type="x/image" Target="../media/smartart.png"/></Relationships>',
            files: {
                'ppt/diagrams/data1.xml': '<dgm:dataModel xmlns:dgm="dgm" xmlns:a="a"><a:t>Text fallback</a:t></dgm:dataModel>',
                'ppt/media/smartart.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47])
            }
        });
        const parsed = await parsePptxVscode(input);
        expect(parsed.result.status).toBe('ok');
        if (parsed.result.status !== 'ok') return;
        expect(parsed.result.document.slides[0]?.elements[0]).toMatchObject({
            type: 'image',
            src: expect.stringMatching(/^data:image\/png;base64,/)
        });
        expect(parsed.result.diagnostics).toContainEqual(expect.objectContaining({
            objectKind: 'smartart',
            handling: 'simplified',
            args: expect.objectContaining({ fallback: 'image' })
        }));
    });

    it('reports slide-level unsupported features with host-countable metadata', async () => {
        const input = await pptx({
            slideXml: '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:contentPart/></p:spTree></p:cSld><p:transition/><p:timing/><a:hlinkClick action="ppaction://hlinkshowjump"/></p:sld>',
            slideRelationships: '<Relationships><Relationship Id="audio" Type="x/audio" Target="../media/audio1.mp3"/><Relationship Id="notes" Type="x/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>'
        });
        const parsed = await parsePptxVscode(input);
        expect(parsed.result.status).toBe('ok');
        if (parsed.result.status !== 'ok') return;
        const kinds = parsed.result.diagnostics.map((diagnostic) =>
            (diagnostic as { objectKind?: string }).objectKind
        );
        expect(kinds).toEqual(expect.arrayContaining([
            'transition',
            'animation',
            'hyperlink',
            'media',
            'notes'
        ]));
        for (const diagnostic of parsed.result.diagnostics) {
            expect(diagnostic).toMatchObject({
                location: 'slide:1',
                slideNumber: 1,
                sourcePath: 'ppt/slides/slide1.xml'
            });
        }
    });
});
