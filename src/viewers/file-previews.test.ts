// @vitest-environment jsdom
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import type { HostContext } from '../host/index.js';
import { createCatalogI18n } from '../i18n/index.js';
import { buildZip, type ZipMember } from '../parsers/epub/__tests__/fixture.js';
import { parseDrawio } from '../parsers/drawio/index.js';
import { parseGps } from '../parsers/gps/index.js';
import { ODP_MIMETYPE, ODT_MIMETYPE, parseOpenDocument } from '../parsers/opendocument/index.js';
import { parseSarif } from '../parsers/sarif/index.js';
import { parseMsg } from '../parsers/msg/index.js';
import { formatTraceArgs } from './trace/args-preview.js';
import { filePreviewCss } from './file-preview-styles.js';
import { parseTrace } from '../parsers/trace/index.js';
import { CORE_VIEWER_DESCRIPTORS, detectViewer, probeContainer } from '../registry/index.js';
import { mountDrawioViewer } from './drawio/index.js';
import { mountGpsViewer } from './gps/index.js';
import { mountMsgViewer } from './msg/index.js';
import { mountOpenDocumentViewer } from './opendocument/index.js';
import { mountSarifViewer } from './sarif/index.js';
import { mountSbomViewer } from './sbom/index.js';
import { mountTraceViewer } from './trace/index.js';
import { MountAbortedError, type MountOptions, type ViewerHandle, type ViewerInput } from './types.js';

const ctx: HostContext = {
    assets: { resolveAssetUrl: async path => path },
    logger: { log: () => undefined },
    i18n: createCatalogI18n('en')
};
const bytes = (value: string) => new TextEncoder().encode(value);
const json = (value: unknown) => JSON.stringify(value);
const sarif = json({
    version: '2.1.0',
    runs: [{
        tool: { driver: { name: 'Example', rules: [{ id: 'R1', shortDescription: { text: 'Avoid this API' } }] } },
        artifacts: [{ location: { uri: 'src/example.ts', uriBaseId: 'ROOT' } }],
        originalUriBaseIds: { ROOT: { uri: 'file:///workspace/' } },
        results: [
            { level: 'error', ruleIndex: 0, message: { text: 'Unsafe call' }, locations: [{
                physicalLocation: { artifactLocation: { index: 0 }, region: { startLine: 12, startColumn: 4 } }
            }] },
            { level: 'note', ruleId: 'R2', message: { text: 'Review this' } }
        ]
    }]
});
const sbom = json({
    bomFormat: 'CycloneDX', specVersion: '1.6',
    components: [{ name: 'app', version: '1.0', 'bom-ref': 'app', components: [
        { name: 'library', version: '2.0', 'bom-ref': 'library', licenses: [{ license: { id: 'MIT' } }] }
    ] }],
    dependencies: [{ ref: 'app', dependsOn: ['library'] }]
});
const trace = json({ traceEvents: [
    { pid: 1, tid: 2, ph: 'M', name: 'thread_name', args: { name: 'Renderer' } },
    { pid: 1, tid: 2, ph: 'B', name: 'Frame', ts: 10 },
    { pid: 1, tid: 2, ph: 'X', name: 'Layout', ts: 15, dur: 10 },
    { pid: 1, tid: 2, ph: 'E', ts: 50 },
    { pid: 1, tid: 2, ph: 'i', name: 'Ready', ts: 51 }
] });
const gpx = '<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Morning route</name><trkseg><trkpt lat="37" lon="127"><ele>5</ele><time>2026-01-01T00:00:00Z</time></trkpt><trkpt lat="37.01" lon="127"><ele>10</ele><time>2026-01-01T00:01:00Z</time></trkpt></trkseg><trkseg><trkpt lat="38" lon="128"/></trkseg></trk></gpx>';
const kml = '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>Park</name><Point><coordinates>127,37,20</coordinates></Point></Placemark><NetworkLink/></Document></kml>';
const graph = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" value="Work" parent="0"/><mxCell id="a" value="Start" parent="1" vertex="1"><mxGeometry x="20" y="30" width="80" height="40"/></mxCell><mxCell id="b" value="End" parent="1" vertex="1" style="ellipse"><mxGeometry x="180" y="30" width="80" height="40"/></mxCell><mxCell id="c" parent="1" edge="1" source="a" target="b"/></root></mxGraphModel>';
const drawio = `<mxfile><diagram name="Plain">${graph}</diagram><diagram name="Compressed">${deflateRawSync(encodeURIComponent(graph)).toString('base64')}</diagram></mxfile>`;
const odf = (type: string, body: string, extra: ZipMember[] = []) => buildZip([
    { name: 'mimetype', data: type },
    { name: 'content.xml', data: `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"><office:body>${body}</office:body></office:document-content>` },
    ...extra
]);
const odt = () => odf(ODT_MIMETYPE, '<office:text><text:h text:outline-level="2">Project outline</text:h><text:p>Intro<text:s text:c="2"/>text</text:p><text:list><text:list-item><text:p>First step</text:p></text:list-item></text:list></office:text>');
const odp = () => odf(ODP_MIMETYPE, '<office:presentation><draw:page draw:name="Slide one"><draw:frame svg:x="1in" svg:y="2in" svg:width="3in" svg:height="1in"><draw:text-box><text:p>First slide</text:p></draw:text-box></draw:frame></draw:page><draw:page draw:name="Slide two"/></office:presentation>');

interface CfbWriter {
    utils: {
        cfb_new(): unknown;
        cfb_add(file: unknown, name: string, data: Buffer): void;
    };
    write(file: unknown, options: { type: 'buffer' }): Buffer;
}
function msg({ legacyHtml = false, embeddedWord = false, utf8Body = false, messageCodePage = false } = {}): Uint8Array {
    const cfb = (XLSX as unknown as { CFB: CfbWriter }).CFB;
    const file = cfb.utils.cfb_new();
    const add = (path: string, data: Buffer) => cfb.utils.cfb_add(file, path, data);
    const unicode = (path: string, value: string) => add(path, Buffer.from(value + '\0', 'utf16le'));
    const props = Buffer.alloc(messageCodePage ? 80 : legacyHtml || utf8Body ? 64 : 48);
    props.writeUInt32LE(0x00390040, 32);
    props.writeBigUInt64LE(134116992000000000n, 40);
    if (legacyHtml || utf8Body) {
        props.writeUInt32LE(0x3fde0003, 48);
        props.writeUInt32LE(utf8Body ? 65001 : 1252, 56);
    }
    if (messageCodePage) {
        props.writeUInt32LE(0x3ffd0003, 64);
        props.writeUInt32LE(1252, 72);
    }
    add('__properties_version1.0', props);
    unicode('__substg1.0_001A001F', 'IPM.Note');
    unicode('__substg1.0_0037001F', 'Quarterly report');
    if (utf8Body) add('__substg1.0_1000001E', Buffer.from('café', messageCodePage ? 'latin1' : 'utf8'));
    else unicode('__substg1.0_1000001F', 'Plain body');
    if (utf8Body && !messageCodePage) add('__substg1.0_1013001E', Buffer.from('<p>café</p>\0'));
    else add('__substg1.0_10130102', messageCodePage ? Buffer.from('<p>café</p>') : legacyHtml
        ? Buffer.from('<p>café</p>', 'latin1')
        : Buffer.from('<p>HTML body</p><script>alert(1)</script><img src="https://example.org/tracker">'));
    const attachment = '__attach_version1.0_#00000000/';
    unicode(attachment + '__substg1.0_3707001F', '../../report.txt');
    if (embeddedWord) add(attachment + '__substg1.0_3701000D/WordDocument', Buffer.from('embedded stream'));
    else add(attachment + '__substg1.0_37010102', Buffer.from('file data'));
    return cfb.write(file, { type: 'buffer' });
}

type Mount = (input: ViewerInput, root: HTMLElement, ctx: HostContext, options?: MountOptions) => Promise<ViewerHandle>;
async function mount(viewer: Mount, fileName: string, data: string | Uint8Array, context = ctx) {
    const root = document.createElement('div');
    const handle = await viewer({ fileName, data: typeof data === 'string' ? bytes(data) : data }, root, context, { styleIsolation: 'scoped' });
    return { root, handle };
}
const button = (root: ParentNode, title: string) => [...root.querySelectorAll('button')].find(node => node.textContent === title)!;
const search = (root: ParentNode, value: string) => {
    const field = root.querySelector<HTMLInputElement>('input[type=search]')!;
    field.value = value;
    field.dispatchEvent(new Event('input'));
};

describe('preview detection', () => {
    it.each([
        ['analysis.sarif', sarif, 'sarif'], ['export.json', sarif, 'sarif'], ['trace.json', trace, 'trace'],
        ['export.json', trace, 'trace'], ['bom.cdx.json', sbom, 'sbom'], ['export.json', sbom, 'sbom'],
        ['run.GPX', gpx, 'gps'], ['route.xml', kml, 'gps'], ['flow.drawio', drawio, 'drawio'],
        ['flow.xml', drawio, 'drawio']
    ])('opens %s in its preview', (name, source, id) => {
        expect(detectViewer(name, undefined, undefined, bytes(source), source).viewerId).toBe(id);
    });

    it('keeps generic JSON/XML and supports hosts that disable dedicated previews', () => {
        expect(detectViewer('application.json', undefined, undefined, undefined, '{"version":"2.1.0","runs":[{"name":"test"}]}').viewerId).toBe('json');
        expect(detectViewer('config.xml', undefined, undefined, undefined, '<gpx xmlns="urn:unrelated"/>').viewerId).toBe('xml');
        const descriptors = CORE_VIEWER_DESCRIPTORS.filter(item => item.id !== 'sbom' && item.id !== 'gps');
        expect(detectViewer('bom.json', undefined, descriptors, undefined, sbom).viewerId).toBe('json');
        expect(detectViewer('route.gpx', undefined, descriptors, undefined, gpx).viewerId).toBe('xml');
    });

    it('detects a SARIF log with an unsuccessful run collection and no schema', () => {
        const source = '{"version":"2.1.0","runs":null}';
        for (const name of ['report.json', 'report']) {
            expect(detectViewer(name, undefined, undefined, bytes(source), source).viewerId).toBe('sarif');
        }
    });

    it.each([
        [String.raw`{"version":"2.1.0","\u0072uns":[{"tool":{"driver":{"name":"Scanner"}},"results":[]}]}`, 'sarif'],
        [String.raw`{"bomFormat":"\u0043ycloneDX","specVersion":"1.6"}`, 'sbom'],
        [String.raw`[{"\u0070h":"X","pid":1,"tid":2,"ts":0,"dur":1,"name":"Work"}]`, 'trace']
    ])('detects preview signatures containing JSON Unicode escapes', (source, id) => {
        expect(detectViewer('report.json', undefined, undefined, bytes(source), source).viewerId).toBe(id);
    });

    it.each([
        ['{"version":"2.1.0","runs":[],"version":"other"}', 'json'],
        ['{"bomFormat":"CycloneDX","specVersion":"1.6","bomFormat":"other"}', 'json'],
        ['{"traceEvents":[{"ph":"X","pid":1,"tid":1,"ts":0,"dur":1,"name":"event"}],"traceEvents":null}', 'json'],
        ['{"bomFormat":"other","bomFormat":"CycloneDX","specVersion":"1.6"}', 'sbom']
    ])('uses the last value of a repeated JSON signature key', (source, id) => {
        expect(detectViewer('report.json', undefined, undefined, bytes(source), source).viewerId).toBe(id);
    });

    it('preserves JSON Lines detection when the first line matches a dedicated preview', () => {
        for (const line of [sarif, sbom, trace]) {
            expect(detectViewer('untitled', undefined, undefined, undefined, line + '\n' + line).viewerId).toBe('jsonl');
        }
    });

    it('scans a long XML prologue before inspecting the actual root', () => {
        const source = '<!-- <mxfile> -->'.repeat(3000) + '<ordinary/>';
        expect(detectViewer('config.xml', undefined, undefined, undefined, source).viewerId).toBe('xml');
    });

    it('detects and opens a KMZ whose main KML has a custom top-level name', async () => {
        const archive = buildZip([
            { name: 'assets/overlay.kml', data: '<kml/>' },
            { name: 'route.KML', data: kml }
        ]);
        expect(await probeContainer(archive, 'zip')).toBe('gps');
        expect((await parseGps(archive)).result).toMatchObject({ document: { format: 'kmz', features: [{ name: 'Park' }] } });
    });

    it('recognizes a dot-prefixed root doc.kml and prefers it over other KML files', async () => {
        const archive = buildZip([
            { name: 'overlay.kml', data: '<kml/>' },
            { name: './doc.kml', data: kml }
        ]);
        expect(await probeContainer(archive, 'zip')).toBe('gps');
        expect((await parseGps(archive)).result).toMatchObject({ document: { format: 'kmz', features: [{ name: 'Park' }] } });
    });

    it('ignores fake end-of-directory signatures in ZIP comments', async () => {
        const zip = buildZip([{ name: 'doc.kml', data: kml }]);
        const comment = Uint8Array.of(0x50, 0x4b, 5, 6, ...Array<number>(16).fill(0), 1, 0);
        const archive = new Uint8Array(zip.length + comment.length);
        archive.set(zip);
        new DataView(archive.buffer).setUint16(zip.length - 2, comment.length, true);
        archive.set(comment, zip.length);
        expect(await probeContainer(archive, 'zip')).toBe('gps');
    });

    it('uses the ZIP64 directory for extensionless KMZ and ignores an empty EOCD in a ZIP comment', async () => {
        const zip = buildZip([{ name: 'doc.kml', data: kml }]);
        const offset = zip.length - 22;
        const legacy = new DataView(zip.buffer, zip.byteOffset + offset, 22);
        const archive = new Uint8Array(zip.length + 76);
        archive.set(zip.subarray(0, offset));
        const end64 = new DataView(archive.buffer, offset);
        end64.setUint32(0, 0x06064b50, true);
        end64.setBigUint64(4, 44n, true);
        end64.setUint16(12, 45, true);
        end64.setUint16(14, 45, true);
        end64.setBigUint64(24, 1n, true);
        end64.setBigUint64(32, 1n, true);
        end64.setBigUint64(40, BigInt(legacy.getUint32(12, true)), true);
        end64.setBigUint64(48, BigInt(legacy.getUint32(16, true)), true);
        end64.setUint32(56, 0x07064b50, true);
        end64.setBigUint64(64, BigInt(offset), true);
        end64.setUint32(72, 1, true);
        archive.set(zip.subarray(offset), offset + 76);
        end64.setUint16(84, 0xffff, true);
        end64.setUint16(86, 0xffff, true);
        end64.setUint32(88, 0xffffffff, true);
        end64.setUint32(92, 0xffffffff, true);
        expect(await probeContainer(archive, 'zip')).toBe('gps');
        expect((await parseGps(archive)).result).toMatchObject({ document: { format: 'kmz' } });

        const commented = new Uint8Array(zip.length + 22);
        commented.set(zip);
        const view = new DataView(commented.buffer);
        view.setUint16(zip.length - 2, 22, true);
        view.setUint32(zip.length, 0x06054b50, true);
        view.setUint32(zip.length + 16, zip.length, true);
        expect(await probeContainer(commented, 'zip')).toBe('gps');
        expect((await parseGps(commented)).result).toMatchObject({ document: { format: 'kmz' } });
    });

    it('prefers the real ZIP directory when a comment points to a prefix of it', async () => {
        const zip = buildZip([{ name: 'README.txt', data: 'readme' }, { name: 'doc.kml', data: kml }]);
        const archive = new Uint8Array(zip.length + 22);
        archive.set(zip);
        const view = new DataView(archive.buffer);
        const central = view.getUint32(zip.length - 6, true);
        view.setUint16(zip.length - 2, 22, true);
        view.setUint32(zip.length, 0x06054b50, true);
        view.setUint16(zip.length + 8, 1, true);
        view.setUint16(zip.length + 10, 1, true);
        view.setUint32(zip.length + 12, zip.length - central, true);
        view.setUint32(zip.length + 16, central, true);
        expect(await probeContainer(archive, 'zip')).toBe('gps');
        expect((await parseGps(archive)).result).toMatchObject({ document: { features: [{ name: 'Park' }] } });
    });

    it('keeps extensionless KMZ routing when asset folders resemble Office part paths', async () => {
        const archive = buildZip([
            { name: 'word/map-overlay.png', data: '' },
            { name: 'assets/archive_format', data: 'overlay image' },
            { name: 'doc.kml', data: kml }
        ]);
        expect(await probeContainer(archive, 'zip')).toBe('gps');
    });

    it('routes an Outlook compound file by its own streams, even with embedded Word data', async () => {
        expect(await probeContainer(msg({ embeddedWord: true }), 'ole')).toBe('msg');
    });

    it('resolves extensionless ZIP and OLE members and recognizes named containers', async () => {
        const kmz = buildZip([{ name: 'doc.kml', data: kml }]);
        for (const [fileName, data, id, container] of [
            ['map.kmz', kmz, 'gps', 'zip'], ['outline.odt', odt(), 'opendocument', 'zip'],
            ['slides.odp', odp(), 'opendocument', 'zip'], ['mail.msg', msg(), 'msg', 'ole']
        ] as const) {
            expect(detectViewer(fileName, undefined, undefined, data).viewerId).toBe(id);
            expect(detectViewer('download', undefined, undefined, data).matchedBy).toBe('ambiguous-container');
            expect(await probeContainer(data, container)).toBe(id);
        }
    });
});

describe('read-only previews', () => {
    it('bounds generated SARIF text and resolves direct and global messages', () => {
        const result = parseSarif(bytes(json({
            version: '2.1.0',
            runs: [{
                tool: { driver: { name: 'Tool', globalMessageStrings: { note: { text: 'Global {{0}} {0}' } } } },
                results: [
                    { kind: 'pass', message: { id: 'note', arguments: ['test'] } },
                    { message: { text: '{0}'.repeat(24_000), arguments: ['x'.repeat(24_000)] } }
                ]
            }]
        }))).result;
        expect(result.status).toBe('partial');
        if (result.status === 'failed') throw new Error('Could not parse SARIF');
        expect(result.document.findings[0]).toMatchObject({ level: 'none', message: 'Global {0} test' });
        expect(result.document.findings[1]?.message.length).toBe(64 * 1024);
    });

    it('distinguishes missing SARIF run results from an empty result array', () => {
        const tool = { driver: { name: 'Scanner' } };
        const invocations = [{ executionSuccessful: false, processStartFailureMessage: 'Could not start Scanner' }];
        const runs = [{ tool, results: [] }, { tool, invocations }, { tool, invocations, results: null }];
        for (const run of runs.slice(1)) {
            const result = parseSarif(bytes(json({ version: '2.1.0', runs: [run, runs[0]] }))).result;
            expect(result).toMatchObject({
                status: 'partial', diagnostics: [{ messageKey: 'sarif.resultsUnavailable' }],
                document: { runCount: 2, findings: [] }
            });
        }
        expect(parseSarif(bytes(json({ version: '2.1.0', runs: [runs[0]] }))).result)
            .toMatchObject({ status: 'ok', document: { runCount: 1, findings: [] } });
    });

    it('charges SARIF templates that interpolate to empty strings', () => {
        const log = json({
            version: '2.1.0',
            runs: [{
                tool: { driver: { name: 'Tool', globalMessageStrings: { repeated: { text: '{0}'.repeat(500) } } } },
                results: Array.from({ length: 10 }, () => ({ message: { id: 'repeated', arguments: [''] } }))
            }]
        });
        const result = parseSarif(bytes(log), { limits: { maxPreviewBytes: 1500 } }).result;
        expect(result).toMatchObject({ status: 'partial', diagnostics: [{ code: 'truncated' }] });
    });

    it('applies SARIF invocation rule overrides and resolves long shared URIs once per scheme check', () => {
        const uri = 'a'.repeat(1_100_000);
        const log = json({
            version: '2.1.0',
            runs: [{
                tool: { driver: { name: 'Tool', rules: [{ id: 'R', defaultConfiguration: { level: 'note' } }, { id: 'S' }] } },
                invocations: [
                    { executionSuccessful: true, ruleConfigurationOverrides: [
                        { descriptor: { id: 'R' }, configuration: { level: 'error' } },
                        { descriptor: {}, configuration: { level: 'none' } }
                    ] },
                    { executionSuccessful: true, ruleConfigurationOverrides: [
                        { descriptor: { id: 'R' }, configuration: { level: 'warning' } }
                    ] }
                ],
                artifacts: [{ location: { uri, uriBaseId: 'SRC' } }],
                originalUriBaseIds: { SRC: { uri: 'file:///x/' } },
                results: [
                    { ruleId: 'S', provenance: { invocationIndex: 0 }, message: { text: 'default' } },
                    ...Array.from({ length: 1000 }, () => ({
                        rule: { id: 'R' }, provenance: { invocationIndex: 0 }, message: { text: 'm' },
                        locations: [{ physicalLocation: { artifactLocation: { index: 0 } } }]
                    })),
                    { rule: { id: 'R' }, provenance: { invocationIndex: 1 }, message: { text: 'second invocation' } },
                    { rule: { id: 'R' }, message: { text: 'no invocation' } }
                ]
            }]
        });
        const started = Date.now();
        const result = parseSarif(bytes(log)).result;
        expect(Date.now() - started).toBeLessThan(1500);
        if (result.status === 'failed') throw new Error('Could not parse SARIF');
        expect(result.document.findings[0]?.level).toBe('warning');
        expect(result.document.findings[1]?.level).toBe('error');
        expect(result.document.findings.slice(-2).map(finding => finding.level)).toEqual(['warning', 'note']);
        expect(result.document.findings[1]?.locations[0]?.file.startsWith('file:///x/aaa')).toBe(true);
    });

    it('defaults a missing SARIF invocation index to the only invocation', () => {
        const result = parseSarif(bytes(json({
            version: '2.1.0',
            runs: [{
                tool: { driver: { name: 'Tool', rules: [{ id: 'R', defaultConfiguration: { level: 'note' } }] } },
                invocations: [{ executionSuccessful: true, ruleConfigurationOverrides: [
                    { descriptor: { index: 0 }, configuration: { level: 'error' } }
                ] }],
                results: [
                    { rule: { index: 0 }, provenance: { firstDetectionTimeUtc: '2026-01-01T00:00:00Z' }, message: { text: 'implicit' } },
                    { rule: { index: 0 }, provenance: { invocationIndex: -1 }, message: { text: 'unknown' } }
                ]
            }]
        }))).result;
        expect(result).toMatchObject({ status: 'ok', document: { findings: [{ level: 'error' }, { level: 'note' }] } });
    });

    it('resolves SARIF URI references while preserving file path dot segments', () => {
        const locations = [
            ['/src/a.c', 'WEB'], ['//cdn.example/a.c', 'WEB'], ['../src/a.c', 'WEB'],
            ['../src/a.c', 'FILE'], ['/src/a.c', 'missing'], ['https://other.example/a.c', 'WEB']
        ].map(([uri, uriBaseId]) => ({ physicalLocation: { artifactLocation: { uri, uriBaseId } } }));
        const result = parseSarif(bytes(json({ version: '2.1.0', runs: [{
            tool: { driver: { name: 'Tool' } },
            originalUriBaseIds: { WEB: { uri: 'https://code.example/repo/build/' }, FILE: { uri: 'file:///repo/build/' } },
            results: [{ message: { text: 'Problem' }, locations }]
        }] }))).result;
        expect(result.status === 'failed' ? undefined : result.document.findings[0]?.locations.map(item => item.file)).toEqual([
            'https://code.example/src/a.c', 'https://cdn.example/a.c', 'https://code.example/repo/src/a.c',
            'file:///repo/build/../src/a.c', '/src/a.c', 'https://other.example/a.c'
        ]);
    });

    it('resolves SARIF rules and invocation descriptors by GUID', () => {
        const ruleGuid = 'eb2ecdf7-d2ab-4847-be0d-f59592ddf95a';
        const componentGuid = '4c89fcf3-9535-42b0-ae0e-827639b09912';
        const reference = { guid: ruleGuid, toolComponent: { guid: componentGuid } };
        const source = json({
            version: '2.1.0',
            runs: [{
                tool: { driver: { name: 'Tool' }, extensions: [{ name: 'Extension', guid: componentGuid, rules: [{ id: 'R', guid: ruleGuid }] }] },
                invocations: [{ executionSuccessful: true, ruleConfigurationOverrides: [{ descriptor: reference, configuration: { level: 'error' } }] }],
                results: [{ rule: reference, message: { text: 'GUID reference' } }]
            }]
        });
        expect(parseSarif(bytes(source)).result).toMatchObject({
            status: 'ok', document: { findings: [{ rule: 'R', level: 'error' }] }
        });
    });

    it('shows the CycloneDX subject and its direct dependencies', async () => {
        const source = json({
            bomFormat: 'CycloneDX', specVersion: '1.6',
            metadata: { component: { type: 'application', name: 'app', 'bom-ref': 'app' } },
            components: [{ type: 'library', name: 'lib', 'bom-ref': 'lib' }],
            dependencies: [{ ref: 'app', dependsOn: ['lib'] }]
        });
        const { root, handle } = await mount(mountSbomViewer, 'bom.cdx.json', source);
        button(root, 'app').click();
        expect(root.querySelector('dl')?.textContent).toContain('Direct dependencieslib');
        handle.dispose();
    });

    it('distinguishes unreported CycloneDX dependencies from explicit empty dependencies', async () => {
        const source = json({
            bomFormat: 'CycloneDX', specVersion: '1.6',
            components: [{ name: 'Known', 'bom-ref': 'known' }, { name: 'Unknown', 'bom-ref': 'unknown' }],
            dependencies: [{ ref: 'known', dependsOn: [] }]
        });
        const { root, handle } = await mount(mountSbomViewer, 'bom.cdx.json', source);
        button(root, 'Known').click();
        expect(root.querySelector('dl')?.textContent).toContain('Direct dependenciesNone');
        button(root, 'Unknown').click();
        expect(root.querySelector('dl')?.textContent).toContain('Direct dependenciesUnknown');
        handle.dispose();
    });

    it('does not label wholly omitted CycloneDX dependencies as empty', async () => {
        const source = json({
            bomFormat: 'CycloneDX', specVersion: '1.6',
            components: [{ name: 'First', 'bom-ref': 'first' }, { name: 'Second', 'bom-ref': 'second' }],
            dependencies: [
                { ref: 'first', dependsOn: Array.from({ length: 8 }, (_, i) => `service-${i}`) },
                { ref: 'second', dependsOn: ['first'] }
            ]
        });
        const root = document.createElement('div');
        const handle = await mountSbomViewer({ fileName: 'bom.cdx.json', data: bytes(source) }, root, ctx,
            { styleIsolation: 'scoped', limits: { maxEntries: 2 } });
        button(root, 'Second').click();
        expect(root.querySelector('dl')?.textContent).toContain('Direct dependenciesUnknown');
        handle.dispose();
    });

    it('charges malformed draw.io pages after inflation', async () => {
        const payload = deflateRawSync('%'.repeat(1024)).toString('base64');
        const source = bytes(`<mxfile><diagram>${graph}</diagram>${`<diagram>${payload}</diagram>`.repeat(3)}</mxfile>`);
        const inflate = vi.fn(async (input: Uint8Array, maxOutputLength: number) =>
            new Uint8Array(inflateRawSync(input, { maxOutputLength })));
        expect((await parseDrawio(source, { limits: { maxDecompressedBytes: 1024 }, inflate })).result.status).toBe('partial');
        expect(inflate).toHaveBeenCalledTimes(1);
    });

    it('requires a password only for encrypted OpenDocument content', async () => {
        const preview = (path: string) => parseOpenDocument(odf(ODT_MIMETYPE, '<office:text><text:p>Public</text:p></office:text>', [{
            name: 'META-INF/manifest.xml',
            data: `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="${path}"><manifest:encryption-data/></manifest:file-entry></manifest:manifest>`
        }]));
        expect((await preview('private.bin')).result).toMatchObject({ status: 'ok' });
        expect((await preview('content.xml')).result).toMatchObject({ status: 'failed', failure: { code: 'password-required' } });
    });

    it('counts ODT list items against the entry limit', async () => {
        const content = '<office:text><text:list>' + '<text:list-item/>'.repeat(100) + '</text:list></office:text>';
        expect((await parseOpenDocument(odf(ODT_MIMETYPE, content), { limits: { maxEntries: 2 } })).result)
            .toMatchObject({ status: 'partial', document: { blocks: [{ kind: 'list', items: [[]] }] } });
    });

    it('bounds deeply nested trace details before formatting', () => {
        const args = JSON.parse('{"nested":' + '['.repeat(3000) + ('0,'.repeat(44999)) + '0' + ']'.repeat(3000) + '}');
        const preview = formatTraceArgs(args);
        expect(preview.truncated).toBe(true);
        expect(preview.text.length).toBeLessThanOrEqual(16_384);
    });

    it('decodes binary MSG HTML using the declared internet code page', () => {
        expect(parseMsg(msg({ legacyHtml: true })).result).toMatchObject({
            status: 'ok', document: { html: '<p>café</p>' }
        });
    });

    it('decodes ISO-2022-JP Outlook HTML even when all bytes are seven-bit', () => {
        const cfb = (XLSX as unknown as { CFB: CfbWriter }).CFB;
        const file = cfb.utils.cfb_new();
        const props = Buffer.alloc(48);
        props.writeUInt32LE(0x3fde0003, 32);
        props.writeUInt32LE(50220, 40);
        cfb.utils.cfb_add(file, '__properties_version1.0', props);
        cfb.utils.cfb_add(file, '__substg1.0_001A001E', Buffer.from('IPM.Note\0'));
        cfb.utils.cfb_add(file, '__substg1.0_10130102', Buffer.from('3c703e1b2442467c4b5c386c1b28423c2f703e', 'hex'));
        expect(parseMsg(cfb.write(file, { type: 'buffer' })).result)
            .toMatchObject({ status: 'ok', document: { html: '<p>日本語</p>' } });
    });

    it('uses the internet code page for plain and HTML MSG String8 bodies', () => {
        expect(parseMsg(msg({ utf8Body: true })).result).toMatchObject({
            status: 'ok', document: { text: 'café', html: '<p>café</p>' }
        });
    });

    it('uses the message code page for String8 and the internet code page for binary MSG HTML', () => {
        expect(parseMsg(msg({ utf8Body: true, messageCodePage: true })).result).toMatchObject({
            status: 'ok', document: { text: 'café', html: '<p>café</p>' }
        });
    });

    it.each([
        [949, 'bec8b3e7c7cfbcbcbfe4', '안녕하세요'],
        [1251, 'cff0e8e2e5f2', 'Привет']
    ])('decodes legacy Outlook MSG strings in code page %i', (page, hex, decoded) => {
        const cfb = (XLSX as unknown as { CFB: CfbWriter }).CFB;
        const file = cfb.utils.cfb_new();
        const props = Buffer.alloc(48);
        props.writeUInt32LE(0x3ffd0003, 32);
        props.writeUInt32LE(page, 40);
        cfb.utils.cfb_add(file, '__properties_version1.0', props);
        cfb.utils.cfb_add(file, '__substg1.0_001A001E', Buffer.from('IPM.Note\0'));
        for (const id of ['0037', '1000']) {
            cfb.utils.cfb_add(file, `__substg1.0_${id}001E`, Buffer.from(hex + '00', 'hex'));
        }
        expect(parseMsg(cfb.write(file, { type: 'buffer' })).result)
            .toMatchObject({ status: 'ok', document: { subject: decoded, text: decoded } });
    });

    it.each([
        ['', '', 'Delegate <delegate@example.com>'],
        ['Operations', '', 'Operations'],
        ['Operations', 'operations@example.com', 'Operations <operations@example.com>']
    ])('displays the represented Outlook From identity for name "%s" and address "%s"', (name, address, from) => {
        const cfb = (XLSX as unknown as { CFB: CfbWriter }).CFB;
        const file = cfb.utils.cfb_new();
        cfb.utils.cfb_add(file, '__properties_version1.0', Buffer.alloc(32));
        for (const [id, value] of [['001A', 'IPM.Note'], ['0C1A', 'Delegate'], ['5D01', 'delegate@example.com'], ['0042', name], ['5D02', address]]) {
            if (value) cfb.utils.cfb_add(file, `__substg1.0_${id}001F`, Buffer.from(value + '\0', 'utf16le'));
        }
        expect(parseMsg(cfb.write(file, { type: 'buffer' })).result)
            .toMatchObject({ status: 'ok', document: { from } });
    });

    it('warns when a non-Unicode MSG without a code page comes from a non-Western locale', () => {
        const cfb = (XLSX as unknown as { CFB: CfbWriter }).CFB;
        const ansi = (locale: number, subject: Buffer) => {
            const file = cfb.utils.cfb_new();
            const props = Buffer.alloc(48);
            props.writeUInt32LE(0x3ff10003, 32);
            props.writeUInt32LE(locale, 40);
            cfb.utils.cfb_add(file, '__properties_version1.0', props);
            cfb.utils.cfb_add(file, '__substg1.0_001A001E', Buffer.from('IPM.Note\0', 'latin1'));
            cfb.utils.cfb_add(file, '__substg1.0_0037001E', subject);
            return cfb.write(file, { type: 'buffer' });
        };
        // "日本語" in Shift_JIS, as Outlook writes it for ja-JP non-Unicode messages.
        expect(parseMsg(ansi(1041, Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]))).result)
            .toMatchObject({ status: 'partial', diagnostics: [{ code: 'unsupported' }] });
        expect(parseMsg(ansi(1041, Buffer.from('ASCII only', 'latin1'))).result).toMatchObject({ status: 'ok', document: { subject: 'ASCII only' } });
        expect(parseMsg(ansi(1036, Buffer.from('défini', 'latin1'))).result).toMatchObject({ status: 'ok', document: { subject: 'défini' } });
    });

    it('charges ODT repeated table text against the output budget', async () => {
        const table = '<table:table xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">' +
            '<table:table-row table:number-rows-repeated="100"><table:table-cell table:number-columns-repeated="100">' +
            '<text:p>' + 'x'.repeat(500) + '</text:p></table:table-cell></table:table-row></table:table>';
        const result = (await parseOpenDocument(odf(ODT_MIMETYPE, '<office:text>' + table + '</office:text>'),
            { limits: { maxPreviewBytes: 1200 } })).result;
        expect(result.status).toBe('partial');
        if (result.status === 'failed' || result.document.format !== 'odt') throw new Error('Could not parse ODT');
        const block = result.document.blocks[0];
        if (block?.kind !== 'table') throw new Error('Could not read table');
        expect(block.rows.flat().reduce((size, cell) => size + cell.text.length, 0)).toBe(1200);
    });

    it('finds retained SARIF message text beyond the visible table cell', async () => {
        const source = json({ version: '2.1.0', runs: [{
            tool: { driver: { name: 'T' } },
            results: [{ message: { text: 'a'.repeat(2050) + ' unique-diagnostic' } }]
        }] });
        const { root, handle } = await mount(mountSarifViewer, 'audit.sarif', source);
        expect(root.querySelector('tbody')?.textContent).not.toContain('unique-diagnostic');
        search(root, 'unique-diagnostic');
        expect(root.querySelectorAll('tbody tr')).toHaveLength(1);
        handle.dispose();
    });

    it('filters SARIF findings and resolves an indexed source URI and rule', async () => {
        const { root, handle } = await mount(mountSarifViewer, 'audit.sarif', sarif);
        expect(root.querySelectorAll('tbody tr')).toHaveLength(2);
        search(root, 'unsafe');
        expect(root.querySelectorAll('tbody tr')).toHaveLength(1);
        button(root, 'Unsafe call').click();
        expect(root.querySelector('dl')?.textContent).toContain('file:///workspace/src/example.ts:12:4');
        expect(root.querySelector('dl')?.textContent).toContain('Avoid this API');
        handle.dispose();
        expect(root.childElementCount).toBe(0);
    });

    it('normalizes nested SBOM components and displays direct dependencies', async () => {
        const { root, handle } = await mount(mountSbomViewer, 'bom.cdx.json', sbom);
        expect(root.querySelectorAll('tbody tr')).toHaveLength(2);
        button(root, 'app').click();
        expect(root.querySelector('dl')?.textContent).toContain('library / 2.0');
        search(root, 'MIT');
        expect(root.querySelectorAll('tbody tr')).toHaveLength(1);
        handle.dispose();
    });

    it('matches B/E events, shows trace tracks, and supports search and zoom', async () => {
        const result = parseTrace(bytes(trace)).result;
        expect(result).toMatchObject({ status: 'ok', document: { tracks: [{ label: 'Renderer', events: [{ name: 'Frame', duration: 40 }, { name: 'Layout' }, { name: 'Ready' }] }] } });
        const { root, handle } = await mount(mountTraceViewer, 'trace.json', trace);
        expect(root.querySelectorAll('.preview-event')).toHaveLength(3);
        search(root, 'layout');
        expect(root.querySelectorAll('.preview-event')).toHaveLength(1);
        button(root, 'Layout').click();
        expect(root.querySelector('dl')?.textContent).toContain('Renderer');
        button(root, 'Zoom in').click();
        expect(root.querySelector<HTMLInputElement>('input[type=range]')?.disabled).toBe(false);
        handle.dispose();
    });

    it('reveals an off-screen Trace search match without requiring Fit', async () => {
        const source = json({ traceEvents: [
            { name: 'early', ph: 'X', pid: 1, tid: 1, ts: 0, dur: 1 },
            { name: 'target', ph: 'X', pid: 1, tid: 1, ts: 100, dur: 1 }
        ] });
        const { root, handle } = await mount(mountTraceViewer, 'search.trace.json', source);
        button(root, 'Zoom in').click();
        expect(button(root, 'target')).toBeUndefined();
        search(root, 'target');
        expect(button(root, 'target')).toBeDefined();
        handle.dispose();
    });

    it.each([1, 0.0625])('keeps a %s µs Trace event visible when zooming an epoch timestamp', async duration => {
        const source = json([{ pid: 1, tid: 2, ph: 'X', name: 'Timing', ts: 1_700_000_000_000_000, dur: duration }]);
        const { root, handle } = await mount(mountTraceViewer, 'epoch.trace.json', source);
        const width = () => root.querySelector<HTMLElement>('.preview-event')?.style.width;
        expect(width()).toBe('100%');
        for (let i = 0; i < 3; i++) button(root, 'Zoom in').click();
        expect(width()).toBe('100%');
        handle.dispose();
    });

    it('keeps instant events visible when the Trace timeline has no duration', async () => {
        const source = json({ traceEvents: [{ pid: 1, tid: 2, ph: 'i', s: 't', name: 'Only event', ts: 10 }] });
        const { root, handle } = await mount(mountTraceViewer, 'instant.trace.json', source);
        const zoomIn = button(root, 'Zoom in');
        expect(zoomIn.disabled).toBe(true);
        zoomIn.click();
        expect(root.querySelector('.preview-event')?.textContent).toBe('Only event');
        handle.dispose();
    });

    it('preserves GPX segment boundaries and opens KMZ without following network links', async () => {
        const result = (await parseGps(bytes(gpx))).result;
        expect(result).toMatchObject({ status: 'ok', document: { features: [{
            geometry: { type: 'GeometryCollection' }, elapsedSeconds: 60, minElevation: 5, maxElevation: 10
        }] } });
        if (result.status === 'failed') throw new Error('GPX parse failed');
        expect(result.document.features[0]?.distanceKm).toBeCloseTo(1.11, 2);
        const { root, handle } = await mount(mountGpsViewer, 'map.kmz', buildZip([{ name: 'doc.kml', data: kml }]));
        expect(root.querySelector('circle')).not.toBeNull();
        expect(root.textContent).toContain('Park');
        handle.dispose();
        expect(root.childElementCount).toBe(0);
    });

    it('reads MSG mini streams, isolates HTML and saves an attachment using the host', async () => {
        const saveFile = vi.fn<NonNullable<Parameters<typeof mountMsgViewer>[2]['save']>['saveFile']>(async () => undefined);
        const context = { ...ctx, save: { saveFile } };
        const { root, handle } = await mount(mountMsgViewer, 'mail.msg', msg(), context);
        expect(root.textContent).toContain('Quarterly report');
        const frame = root.querySelector('iframe')!;
        expect(frame.getAttribute('sandbox')).toBe('');
        const rendered = new DOMParser().parseFromString(frame.srcdoc, 'text/html');
        expect(rendered.body.textContent).toContain('HTML body');
        expect(rendered.querySelector('script, img[src]')).toBeNull();
        button(root, 'Text').click();
        expect(root.querySelector('pre')?.textContent).toBe('Plain body');
        root.querySelector<HTMLButtonElement>('button[aria-label="Save report.txt"]')!.click();
        expect(saveFile).toHaveBeenCalledTimes(1);
        const [name, data, mime] = saveFile.mock.calls[0]!;
        expect([name, new TextDecoder().decode(data), mime]).toEqual(['report.txt', 'file data', 'application/octet-stream']);
        handle.dispose();
    });

    it('opens compressed draw.io pages and toggles their layers', async () => {
        const { root, handle } = await mount(mountDrawioViewer, 'flow.drawio', drawio);
        expect(root.querySelector('svg polyline')).not.toBeNull();
        button(root, 'Next').click();
        expect(root.querySelector('h3')?.textContent).toBe('Compressed');
        expect(root.querySelector('svg ellipse')).not.toBeNull();
        const toggle = root.querySelector<HTMLInputElement>('input[type=checkbox]')!;
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));
        expect(root.querySelector('svg ellipse')?.parentElement?.style.display).toBe('none');
        handle.dispose();
    });

    it('places draw.io edge labels along their edge and decodes HTML label text', async () => {
        // Shapes as written by draw.io: an edge label child with relative geometry, no size and an offset.
        const source = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
            '<mxCell id="a" value="A" parent="1" vertex="1"><mxGeometry x="0" y="0" width="100" height="40" as="geometry"/></mxCell>' +
            '<mxCell id="b" value="B" parent="1" vertex="1"><mxGeometry x="300" y="0" width="100" height="40" as="geometry"/></mxCell>' +
            '<mxCell id="e" value="Arrange &amp;gt; Layout" style="html=1;" parent="1" edge="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>' +
            '<mxCell id="l" value="User&amp;nbsp;ID&lt;br style=&quot;font-size: 10px;&quot;&gt;Password" style="edgeLabel;html=1;" parent="e" vertex="1" connectable="0">' +
            '<mxGeometry x="-0.5" y="10" relative="1" as="geometry"><mxPoint x="2" y="-3" as="offset"/></mxGeometry></mxCell></root></mxGraphModel>';
        const parsed = (await parseDrawio(bytes(source))).result;
        expect(parsed.status).toBe('ok');
        const { root, handle } = await mount(mountDrawioViewer, 'labels.drawio', source);
        const texts = [...root.querySelectorAll('svg text')];
        const edgeText = texts.find(node => node.textContent === 'Arrange > Layout')!;
        expect([edgeText.getAttribute('x'), edgeText.getAttribute('y')]).toEqual(['200', '20']);
        const child = texts.find(node => node.textContent?.startsWith('User'))!;
        expect([...child.querySelectorAll('tspan')].map(span => span.textContent)).toEqual(['User ID', 'Password']);
        // A quarter of the 200px path from x=100, pushed 10px perpendicular, plus the offset.
        expect([child.getAttribute('x'), child.getAttribute('y')]).toEqual(['152', '7']);
        expect(root.querySelectorAll('svg rect')).toHaveLength(2);
        handle.dispose();
    });

    it('includes a detached draw.io edge label in the fitted viewBox', async () => {
        const source = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
            '<mxCell id="e" edge="1" parent="1" value="Detached label"><mxGeometry relative="1" y="80">' +
            '<mxPoint as="sourcePoint" x="0" y="50"/><mxPoint as="targetPoint" x="100" y="50"/>' +
            '</mxGeometry></mxCell></root></mxGraphModel>';
        const { root, handle } = await mount(mountDrawioViewer, 'label.drawio', source);
        const labelY = Number(root.querySelector('svg text')?.getAttribute('y'));
        const viewTop = Number(root.querySelector('svg')?.getAttribute('viewBox')?.split(' ')[1]);
        expect(labelY).toBe(-30);
        expect(viewTop).toBeLessThan(labelY);
        handle.dispose();
    });

    it('reads Google Earth gx:Track and gx:MultiTrack placemarks', async () => {
        const gx = '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document>' +
            '<Placemark><name>Ride</name><gx:Track><when>2026-01-01T00:00:00Z</when><gx:coord>127 37 10</gx:coord><gx:coord>127.01 37.01 12</gx:coord></gx:Track></Placemark>' +
            '<Placemark><gx:MultiTrack><gx:Track><gx:coord>128 38 0</gx:coord><gx:coord>128.1 38 0</gx:coord></gx:Track><gx:Track><gx:coord>129 39 0</gx:coord></gx:Track></gx:MultiTrack></Placemark>' +
            '</Document></kml>';
        expect((await parseGps(bytes(gx))).result).toMatchObject({ status: 'ok', document: { pointCount: 5, features: [
            { name: 'Ride', geometry: { type: 'LineString', coordinates: [[127, 37, 10], [127.01, 37.01, 12]] } },
            { geometry: { type: 'GeometryCollection', geometries: [{ type: 'LineString' }, { type: 'Point' }] } }
        ] } });
    });

    it('formats trace times independently of the host locale', async () => {
        const spy = vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(() => 'localized');
        try {
            const source = json({ traceEvents: [{ pid: 1, tid: 1, ph: 'X', name: 'Long', ts: 0, dur: 1_234_567.5 }] });
            const { root, handle } = await mount(mountTraceViewer, 'trace.json', source);
            button(root, 'Long').click();
            expect(root.querySelector('dl')?.textContent).toContain('1,234.5675 ms');
            expect(root.querySelector('dl')?.textContent).toContain('0 ms');
            handle.dispose();
        } finally {
            spy.mockRestore();
        }
    });

    it('keeps ODF comments out of body text and reads Impress custom shapes', async () => {
        const commented = odf(ODT_MIMETYPE, '<office:text><text:p>Body<office:annotation xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Scott</dc:creator><text:p>A comment</text:p></office:annotation> text</text:p></office:text>');
        expect((await parseOpenDocument(commented)).result).toMatchObject({ status: 'ok', document: { blocks: [{ text: 'Body text' }] } });
        const slides = odf(ODP_MIMETYPE, '<office:presentation><draw:page draw:name="One">' +
            '<draw:custom-shape svg:x="1in" svg:y="1in" svg:width="2in" svg:height="1in"><text:p>Col 1</text:p><draw:enhanced-geometry draw:type="rectangle"/></draw:custom-shape>' +
            '<draw:custom-shape svg:x="0in" svg:y="0in" svg:width="1in" svg:height="1in"><draw:enhanced-geometry draw:type="ellipse"/></draw:custom-shape>' +
            '</draw:page></office:presentation>');
        expect((await parseOpenDocument(slides)).result).toMatchObject({ status: 'ok', document: { pages: [{ shapes: [
            { kind: 'rect', x: 96, width: 192, blocks: [{ text: 'Col 1' }] }, { kind: 'ellipse', blocks: [] }
        ] }] } });
    });

    it('closes a Trace JSON array whose trailing bracket was never written', () => {
        const events = '[{"name":"a","ph":"X","pid":1,"tid":1,"ts":0,"dur":5},\n{"name":"b","ph":"X","pid":1,"tid":1,"ts":6,"dur":5}';
        for (const source of [events, events + ',\n']) {
            expect(detectViewer('crash.json', undefined, undefined, bytes(source), source).viewerId).toBe('trace');
            expect(parseTrace(bytes(source)).result).toMatchObject({ status: 'ok', document: { eventCount: 2 } });
        }
        expect(parseTrace(bytes('{"traceEvents":[')).result.status).toBe('failed');
    });

    it('routes Trace Event JSON with only string process and thread IDs', () => {
        const source = json({ traceEvents: [{ ph: 'X', name: 'work', pid: 'Spans', tid: 'Profiler', ts: 0, dur: 30 }] });
        expect(detectViewer('profile.json', undefined, undefined, bytes(source), source).viewerId).toBe('trace');
    });

    it('detects a Trace array with standard counter records before a timeline event', () => {
        const source = json([
            ...Array.from({ length: 8 }, (_, ts) => ({ name: 'queue', ph: 'C', pid: 1, tid: 1, ts, args: { n: 2 } })),
            { name: 'work', ph: 'X', pid: 1, tid: 1, ts: 8, dur: 2 }
        ]);
        expect(detectViewer('profile.json', undefined, undefined, bytes(source), source).viewerId).toBe('trace');
    });

    it('detects recognizable CycloneDX and Trace prefixes before later format evidence', () => {
        const sbom = json({
            bomFormat: 'CycloneDX',
            components: Array.from({ length: 2000 }, (_, i) => ({ name: `lib-${i}`, type: 'library', version: '1.0' })),
            specVersion: '1.6'
        });
        const trace = json([
            ...Array.from({ length: 1500 }, (_, ts) => ({ name: 'queue length', ph: 'C', pid: 1, tid: 1, ts, args: { n: 2 } })),
            { name: 'work', ph: 'X', pid: 1, tid: 1, ts: 1500, dur: 2 }
        ]);
        for (const [source, id] of [[sbom, 'sbom'], [trace, 'trace']] as const) {
            expect(source.length).toBeGreaterThan(64 * 1024);
            expect(detectViewer('export.json', undefined, undefined, bytes(source), source).viewerId).toBe(id);
        }
    });

    it('keeps ordinary JSON arrays with empty or unrelated phases on the JSON viewer', () => {
        const source = json(['', 'setup'].map((ph, ts) => ({ name: 'job', pid: 1, tid: 1, ph, ts })));
        expect(detectViewer('job.json', undefined, undefined, bytes(source), source).viewerId).toBe('json');
    });

    it('detects a bare Trace JSON array with one complete event', () => {
        const source = json([{ ph: 'X', name: 'work', pid: 1, tid: 1, ts: 0, dur: 5 }]);
        expect(detectViewer('profile.json', undefined, undefined, bytes(source), source).viewerId).toBe('trace');
    });

    it('keeps matching Trace begin/end events separate for IDs with a long shared prefix', () => {
        const prefix = 'x'.repeat(512);
        const source = json([
            { ph: 'B', name: 'A', pid: 1, tid: prefix + 'a', ts: 1 },
            { ph: 'B', name: 'B', pid: 1, tid: prefix + 'b', ts: 2 },
            { ph: 'E', pid: 1, tid: prefix + 'a', ts: 3 },
            { ph: 'E', pid: 1, tid: prefix + 'b', ts: 5 }
        ]);
        expect(parseTrace(bytes(source)).result).toMatchObject({
            status: 'ok', document: { tracks: [{ events: [{ name: 'A', duration: 2 }] }, { events: [{ name: 'B', duration: 3 }] }] }
        });
    });

    it('keeps PyTorch Kineto events with string pid/tid on their own named tracks', () => {
        const source = json({ traceEvents: [
            { ph: 'X', name: 'aten::mm', pid: 7, tid: 7, ts: 10, dur: 5 },
            { ph: 'X', name: 'PyTorch Profiler (0)', pid: 'Spans', tid: 'PyTorch Profiler', ts: 0, dur: 30 },
            { ph: 'i', name: 'Iteration Start', pid: 'Traces', tid: '', ts: 1, s: 'g' },
            { ph: 'X', name: 'numeric twin', pid: 1, tid: 1, ts: 2, dur: 1 },
            { ph: 'X', name: 'string twin', pid: '1', tid: '1', ts: 3, dur: 1 }
        ] });
        const result = parseTrace(bytes(source)).result;
        expect(result.status).toBe('ok');
        if (result.status === 'failed') throw new Error('Could not parse trace');
        expect(result.document.eventCount).toBe(5);
        expect(result.document.tracks.map(track => track.label)).toEqual(['7:7', 'Spans / PyTorch Profiler', 'Traces / Traces:', '1:1', '1 / 1']);
    });

    it('offsets relative draw.io children of a vertex, as BPMN boundary events are placed', async () => {
        const source = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
            '<mxCell id="task" value="Task" parent="1" vertex="1"><mxGeometry x="100" y="100" width="120" height="80" as="geometry"/></mxCell>' +
            '<mxCell id="event" style="ellipse" parent="task" vertex="1"><mxGeometry x="0.5" y="1" width="14" height="14" relative="1" as="geometry"><mxPoint x="-7" y="-14" as="offset"/></mxGeometry></mxCell>' +
            '</root></mxGraphModel>';
        const { root, handle } = await mount(mountDrawioViewer, 'bpmn.drawio', source);
        const ellipse = root.querySelector('svg ellipse')!;
        expect([ellipse.getAttribute('cx'), ellipse.getAttribute('cy')]).toEqual(['160', '173']);
        handle.dispose();
    });

    it('falls back from draw.io colour keywords and splits contenteditable div lines', async () => {
        const source = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
            '<mxCell id="a" value="Line 1&lt;div&gt;Line 2&lt;/div&gt;&lt;div&gt;&lt;br&gt;&lt;/div&gt;&lt;div&gt;Line 4&lt;/div&gt;" style="html=1;fillColor=default;strokeColor=inherit;" parent="1" vertex="1"><mxGeometry width="120" height="80" as="geometry"/></mxCell>' +
            '<mxCell id="b" value="B" style="swimlane;fillColor=swimlane;" parent="1" vertex="1"><mxGeometry x="300" width="120" height="80" as="geometry"/></mxCell>' +
            '<mxCell id="e" style="strokeColor=default;" parent="1" edge="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel>';
        const { root, handle } = await mount(mountDrawioViewer, 'keywords.drawio', source);
        const svg = root.querySelector('svg')!;
        expect(svg.innerHTML).not.toMatch(/"(?:default|inherit|swimlane)"/);
        expect(svg.querySelector('polyline')?.getAttribute('stroke')).toBe('#425466');
        expect(svg.querySelector('rect')?.getAttribute('fill')).toBe('#fff');
        const lines = [...svg.querySelector('text')!.querySelectorAll('tspan')].map(span => span.textContent);
        expect(lines).toEqual(['Line 1', 'Line 2', '', 'Line 4']);
        handle.dispose();
    });

    it('keeps ODT table-of-contents entries and warns on non-rectangular ODP presets', async () => {
        const toc = odf(ODT_MIMETYPE, '<office:text><text:table-of-content><text:table-of-content-source><text:index-title-template>Contents</text:index-title-template></text:table-of-content-source>' +
            '<text:index-body><text:index-title><text:p>Contents</text:p></text:index-title><text:p>1 Introduction<text:tab/>3</text:p></text:index-body></text:table-of-content><text:p>Body</text:p></office:text>');
        expect((await parseOpenDocument(toc)).result).toMatchObject({ status: 'ok', document: { blocks: [
            { text: 'Contents' }, { text: '1 Introduction\t3' }, { text: 'Body' }
        ] } });
        const star = odf(ODP_MIMETYPE, '<office:presentation><draw:page draw:name="One"><draw:custom-shape svg:width="1in" svg:height="1in"><text:p>Star</text:p><draw:enhanced-geometry draw:type="star5"/></draw:custom-shape></draw:page></office:presentation>');
        expect((await parseOpenDocument(star)).result).toMatchObject({ status: 'partial', diagnostics: [{ code: 'unsupported' }], document: { pages: [{ shapes: [{ kind: 'rect', blocks: [{ text: 'Star' }] }] }] } });
    });

    it('keeps the space LibreOffice writes between differently formatted ODF spans', async () => {
        const doc = odf(ODT_MIMETYPE, '<office:text><text:p><text:span>Visible</text:span> <text:span>bookmarked </text:span>text</text:p>' +
            '<text:p>Aaa<text:span> </text:span>bbb</text:p><text:p> <text:span>lead</text:span><text:s text:c="2"/><text:span>x</text:span> </text:p></office:text>');
        expect((await parseOpenDocument(doc)).result).toMatchObject({ status: 'ok', document: { blocks: [
            { text: 'Visible bookmarked text' }, { text: 'Aaa bbb' }, { text: 'lead  x' }
        ] } });
    });

    it('puts draw.io HTML table rows, list items and rules on their own lines', async () => {
        const html = '<table><tr><td colspan="2">Title</td></tr><tr><td>19</td><td>1 day</td></tr></table><ul><li>Slow</li><li>Big</li></ul>Pub/Sub<hr>Transactions';
        const escaped = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const source = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="${escaped}" style="html=1;" parent="1" vertex="1"><mxGeometry width="200" height="200" as="geometry"/></mxCell></root></mxGraphModel>`;
        const { root, handle } = await mount(mountDrawioViewer, 'table.drawio', source);
        const lines = [...root.querySelector('svg text')!.querySelectorAll('tspan')].map(span => span.textContent);
        expect(lines).toEqual(['Title', '19 | 1 day', 'Slow', 'Big', 'Pub/Sub', 'Transactions']);
        handle.dispose();
    });

    it('decodes all HTML entities in draw.io labels, drops cell-ending <br> and marks capped lines', async () => {
        const html = '&laquo;interface&raquo;<br><b>Name</b> zw&ouml;lf &ndash; &#8212;' +
            '<table><tr><td>FK1<br></td><td>foreignKey<br></td></tr><tr><td>PK</td><td>id</td></tr></table>' +
            Array.from({ length: 25 }, (_, index) => `<div>row ${index}</div>`).join('');
        const escaped = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const source = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="${escaped}" style="html=1;" parent="1" vertex="1"><mxGeometry width="200" height="200" as="geometry"/></mxCell></root></mxGraphModel>`;
        const { root, handle } = await mount(mountDrawioViewer, 'uml.drawio', source);
        const lines = [...root.querySelector('svg text')!.querySelectorAll('tspan')].map(span => span.textContent);
        expect(lines.slice(0, 4)).toEqual(['«interface»', 'Name zwölf – —', 'FK1 | foreignKey', 'PK | id']);
        expect(lines).toHaveLength(20);
        expect(lines.at(-1)).toBe('row 15 …');
        handle.dispose();
    });

    it('reads draw.io HTML labels like the rendered text, even with long inline styles', async () => {
        const style = ' style="border-color: var(--border-color); caret-color: rgb(47, 91, 124);' + ' x: y;'.repeat(80) + '"';
        const html = 'Monitoring, <br><div>Verifying Access <br></div><div>Using<br></div>Internal Records' +
            '<div><b>Tips</b></div><font>Who?</font>' + Array.from({ length: 8 }, (_, index) => `<div${style}>Item ${index}</div>`).join('');
        expect(html.length).toBeGreaterThan(4096);
        const escaped = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const source = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="${escaped}" style="html=1;" parent="1" vertex="1"><mxGeometry width="200" height="200" as="geometry"/></mxCell></root></mxGraphModel>`;
        const { root, handle } = await mount(mountDrawioViewer, 'canvas.drawio', source);
        const lines = [...root.querySelector('svg text')!.querySelectorAll('tspan')].map(span => span.textContent);
        expect(lines).toEqual(['Monitoring,', 'Verifying Access', 'Using', 'Internal Records', 'Tips', 'Who?',
            ...Array.from({ length: 8 }, (_, index) => `Item ${index}`)]);
        handle.dispose();
    });

    it('breaks draw.io HTML labels at newlines unless nl2Br=0, and budgets HTML parsing per page', async () => {
        const cell = (id: string, value: string, style: string, x = 0) =>
            `<mxCell id="${id}" value="${value}" style="${style}" parent="1" vertex="1"><mxGeometry x="${x}" width="100" height="40" as="geometry"/></mxCell>`;
        const model = (cells: string) => `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;
        const newlines = await mount(mountDrawioViewer, 'nl.drawio', model(
            cell('a', 'Coffee machine&#xa;not working', 'html=1;') + cell('b', 'a&#xa;&#xa;b', 'html=1;', 200) + cell('c', 'one&#xa;line', 'html=1;nl2Br=0;', 400)));
        expect([...newlines.root.querySelectorAll('svg text')].map(text => [...text.querySelectorAll('tspan')].map(span => span.textContent)))
            .toEqual([['Coffee machine', 'not working'], ['a', '', 'b'], ['one line']]);
        newlines.handle.dispose();
        const markup = '&lt;b&gt;x&lt;/b&gt; '.repeat(6000);
        const heavy = await mount(mountDrawioViewer, 'heavy.drawio', model(Array.from({ length: 12 }, (_, index) => cell(`h${index}`, markup, 'html=1;', index * 200)).join('')));
        expect(heavy.root.querySelector('p.preview-warning')?.textContent).toBe('Some content was omitted because it exceeded the preview limit.');
        const last = [...heavy.root.querySelectorAll('svg text')].at(-1)!;
        expect(last.querySelectorAll('tspan')).toHaveLength(1);
        expect(last.textContent?.endsWith(' …')).toBe(true);
        heavy.handle.dispose();
    });

    it('does not hand draw.io labels with runaway formatting-element reconstruction to the HTML parser', async () => {
        const html = '<div>' + Array.from({ length: 300 }, (_, index) => `<b id=${index}>`).join('') + '</div>' + '<div>x</div>'.repeat(2000);
        const escaped = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const source = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="${escaped}" style="html=1;" parent="1" vertex="1"><mxGeometry width="100" height="40" as="geometry"/></mxCell></root></mxGraphModel>`;
        const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
        try {
            const started = Date.now();
            const { root, handle } = await mount(mountDrawioViewer, 'hostile.drawio', source);
            expect(Date.now() - started).toBeLessThan(2000);
            expect(parse.mock.calls.some(([, type]) => type === 'text/html')).toBe(false);
            expect(root.querySelector('p.preview-warning')?.textContent).not.toBe('');
            expect(root.querySelector('svg text')?.textContent?.endsWith(' …')).toBe(true);
            handle.dispose();
        } finally {
            parse.mockRestore();
        }
    });

    it('keeps lists, headings and nested tables inside ODT table cells', async () => {
        const doc = odf(ODT_MIMETYPE, '<office:text><table:table xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><table:table-row><table:table-cell>' +
            '<text:p>Before</text:p><text:list><text:list-item><text:p>aaa</text:p></text:list-item><text:list-item><text:p>bbb</text:p></text:list-item></text:list>' +
            '<text:h text:outline-level="2">Heading</text:h><table:table><table:table-row><table:table-cell><text:p>x</text:p></table:table-cell><table:table-cell><text:p>y</text:p></table:table-cell></table:table-row></table:table>' +
            '<text:p>After</text:p></table:table-cell></table:table-row></table:table></office:text>');
        expect((await parseOpenDocument(doc)).result).toMatchObject({ status: 'ok', document: { blocks: [
            { kind: 'table', rows: [[{ text: 'Before\naaa\nbbb\nHeading\nx | y\nAfter' }]] }
        ] } });
    });

    it('charges ODT cell paragraph separators in display order', async () => {
        const table = (content: string) => odf(ODT_MIMETYPE, '<office:text><table:table xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">' +
            '<table:table-row><table:table-cell>' + content + '</table:table-cell></table:table-row></table:table></office:text>');
        const ascii = table('<text:p>One</text:p><text:p>Two</text:p>');
        for (const [maxPreviewBytes, text, status] of [[4, 'One\n', 'partial'], [6, 'One\nTw', 'partial'], [7, 'One\nTwo', 'ok']] as const) {
            expect((await parseOpenDocument(ascii, { limits: { maxPreviewBytes } })).result)
                .toMatchObject({ status, document: { blocks: [{ rows: [[{ text }]] }] } });
        }
        const unicode = table('<text:p>A</text:p><text:p>🙂</text:p><text:p>Z</text:p>');
        expect((await parseOpenDocument(unicode, { limits: { maxPreviewBytes: 3 } })).result)
            .toMatchObject({ status: 'partial', document: { blocks: [{ rows: [[{ text: 'A\n' }]] }] } });
    });

    it('keeps ODT list headers and preserves line structure in rendered cells', async () => {
        const doc = odf(ODT_MIMETYPE, '<office:text><text:list><text:list-header><text:p>Header</text:p></text:list-header>' +
            '<text:list-item><text:p>Item</text:p></text:list-item></text:list></office:text>');
        expect((await parseOpenDocument(doc)).result).toMatchObject({ status: 'ok', document: { blocks: [
            { kind: 'list', items: [[{ text: 'Header' }], [{ text: 'Item' }]] }
        ] } });
        expect(filePreviewCss).toMatch(/:is\(\.preview-document, \.preview-shape\) :is\(p, td, th, li\b[^)]*\) \{ white-space: pre-wrap; \}/);
    });

    it('collapses ODF character-data whitespace but keeps text:s, tabs and line breaks', async () => {
        const doc = odf(ODT_MIMETYPE, '<office:text><text:p>\n        <text:span>Height is</text:span>\n        page,   width.\n      </text:p>' +
            '<text:p>a) <text:span> b</text:span><text:line-break/> <text:s text:c="2"/>c<text:tab/>d </text:p>' +
            '<text:p>\n  <draw:frame><draw:text-box/></draw:frame>\n  After shape</text:p></office:text>');
        expect((await parseOpenDocument(doc)).result).toMatchObject({ document: { blocks: [
            { text: 'Height is page, width.' }, { text: 'a) b\n   c\td' }, { text: 'After shape' }
        ] } });
    });

    it('leaves a complete JSON file with only a SARIF $schema and no version on the JSON viewer', () => {
        const source = json({ $schema: 'https://json.schemastore.org/sarif-2.1.0.json', runs: [{ tool: { driver: { name: 'x' } }, results: [{ message: { text: 'hi' } }] }] });
        expect(detectViewer('report.json', undefined, undefined, bytes(source), source).viewerId).toBe('json');
    });

    it('honours ODP draw:fill and draw:stroke set to none', async () => {
        const styles = '<office:automatic-styles xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0">' +
            '<style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:stroke="none" draw:fill="none" draw:fill-color="#ffffff" svg:stroke-color="#000000"/></style:style>' +
            '<style:style style:name="gr2" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#ff0000"/></style:style></office:automatic-styles>';
        const slides = buildZip([
            { name: 'mimetype', data: ODP_MIMETYPE },
            { name: 'content.xml', data: `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0">${styles}<office:body><office:presentation><draw:page draw:name="One">` +
                '<draw:rect draw:style-name="gr1" svg:x="0in" svg:y="0in" svg:width="1in" svg:height="1in"/>' +
                '<draw:rect draw:style-name="gr2" svg:x="1in" svg:y="0in" svg:width="1in" svg:height="1in"/>' +
                '</draw:page></office:presentation></office:body></office:document-content>' }
        ]);
        expect((await parseOpenDocument(slides)).result).toMatchObject({ status: 'ok', document: { pages: [{ shapes: [
            { fill: 'none', stroke: 'none' }, { fill: '#ff0000', stroke: '' }
        ] }] } });
        const { root, handle } = await mount(mountOpenDocumentViewer, 'slides.odp', slides);
        const [hidden, red] = [...root.querySelectorAll<HTMLElement>('.preview-shape')];
        expect(hidden!.style.backgroundColor).toBe('transparent');
        expect(hidden!.style.border).not.toContain('solid');
        expect(red!.style.backgroundColor).toBe('rgb(255, 0, 0)');
        handle.dispose();
    });

    it('preserves ODP slides when optional styles exceed the decompression budget', async () => {
        const body = '<office:presentation><draw:page draw:name="Slide one"/></office:presentation>';
        const data = odf(ODP_MIMETYPE, body, [{ name: 'styles.xml', data: '<!--' + 'x'.repeat(1100) + '-->' }]);
        expect((await parseOpenDocument(data, { limits: { maxDecompressedBytes: 1024 } })).result)
            .toMatchObject({ status: 'partial', diagnostics: [{ code: 'truncated' }], document: { pages: [{ name: 'Slide one' }] } });
    });

    it('hides the children of collapsed draw.io containers and reroutes their edges', async () => {
        const source = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
            '<mxCell id="list" value="Activities" style="swimlane" parent="1" vertex="1" collapsed="1"><mxGeometry x="0" y="0" width="120" height="30" as="geometry"><mxRectangle x="0" y="0" width="120" height="90" as="alternateBounds"/></mxGeometry></mxCell>' +
            '<mxCell id="item" value="Activity 1" parent="list" vertex="1"><mxGeometry y="30" width="120" height="30" as="geometry"/></mxCell>' +
            '<mxCell id="other" value="Other" parent="1" vertex="1"><mxGeometry x="300" y="0" width="80" height="30" as="geometry"/></mxCell>' +
            '<mxCell id="e" parent="1" edge="1" source="item" target="other"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel>';
        const { root, handle } = await mount(mountDrawioViewer, 'lists.drawio', source);
        expect([...root.querySelectorAll('svg text')].map(node => node.textContent)).toEqual(['Activities', 'Other']);
        expect(root.querySelector('svg polyline')?.getAttribute('points')).toBe('120,15 300,15');
        handle.dispose();
    });

    it('detects large Semgrep SARIF whose tool and version keys fall past the sample', () => {
        const result = { ruleId: 'r', message: { text: 'x'.repeat(200) }, locations: [] };
        const source = JSON.stringify({
            $schema: 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json',
            runs: [{ invocations: [{ executionSuccessful: true }], results: Array.from({ length: 400 }, () => result), tool: { driver: { name: 'Semgrep OSS' } } }],
            version: '2.1.0'
        }, null, 2);
        expect(source.length).toBeGreaterThan(64 * 1024);
        for (const name of ['semgrep.json', 'semgrep']) expect(detectViewer(name, undefined, undefined, bytes(source), source).viewerId).toBe('sarif');
    });

    it('leaves plain-text .msg files such as ROS messages to the fallback viewer', () => {
        const ros = 'float64 x\nfloat64 y\n';
        expect(detectViewer('Point.msg', undefined, undefined, bytes(ros), ros).viewerId).not.toBe('msg');
        expect(detectViewer('mail.msg', undefined, undefined, msg()).viewerId).toBe('msg');
        expect(detectViewer('mail.msg').viewerId).toBe('msg');
    });

    it('keeps ROS and Tcl .msg files out of the Outlook preview with only a text sample', () => {
        for (const source of ['std_msgs/Header header\nstring name\n', '::msgcat::mcset en "greeting" "Hello"\n']) {
            expect(detectViewer('sample.msg', undefined, undefined, undefined, source).viewerId).toBe('fallback');
        }
    });

    it('does not report GPX truncation when only trailing extensions follow a full budget', async () => {
        const data = bytes('<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg><trkpt lat="37" lon="127"/></trkseg></trk><extensions/></gpx>');
        expect((await parseGps(data, { limits: { maxEntries: 1 } })).result)
            .toMatchObject({ status: 'ok', document: { pointCount: 1 } });
    });

    it('does not fill a KML polygon when a coordinate budget cuts a ring short', async () => {
        const outer = '<outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,1 0,0</coordinates></LinearRing></outerBoundaryIs>';
        const inner = '<innerBoundaryIs><LinearRing><coordinates>0.2,0.2 0.8,0.2 0.8,0.8 0.2,0.8 0.2,0.2</coordinates></LinearRing></innerBoundaryIs>';
        for (const [rings, maxEntries] of [[outer, 3], [outer + inner, 8]] as const) {
            const data = bytes(`<kml><Placemark><Polygon>${rings}</Polygon></Placemark></kml>`);
            expect((await parseGps(data, { limits: { maxEntries } })).result)
                .toMatchObject({ status: 'partial', diagnostics: expect.arrayContaining([{ severity: 'warning', code: 'truncated', messageKey: 'preview.truncated' }]), document: { features: [] } });
        }
        const data = bytes(`<kml><Placemark><Polygon>${outer}</Polygon></Placemark></kml>`);
        expect((await parseGps(data, { limits: { maxEntries: 5 } })).result)
            .toMatchObject({ status: 'ok', document: { features: [{ geometry: { type: 'Polygon' } }] } });
    });

    it('draws an antimeridian-crossing GPS segment along the short arc', async () => {
        const source = '<gpx><trk><trkseg><trkpt lon="179.9" lat="0"/><trkpt lon="-179.9" lat="0"/></trkseg></trk></gpx>';
        const { root, handle } = await mount(mountGpsViewer, 'track.gpx', source);
        const path = root.querySelector('.omni-geojson__geometry')?.getAttribute('d');
        expect(path).toBe('M179.9 0 L180.1 0');
        const width = Number(root.querySelector('svg')?.getAttribute('viewBox')?.split(' ')[2]);
        expect(width).toBeLessThan(1);
        handle.dispose();
    });

    it('aligns opposite GPS track directions with shared waypoints', async () => {
        const source = '<gpx><wpt lon="179.9" lat="0"/><wpt lon="-179.9" lat="0"/><wpt lon="1" lat="1"/>' +
            '<trk><trkseg><trkpt lon="-1" lat="1"/><trkpt lon="1" lat="1"/></trkseg></trk>' +
            '<trk><trkseg><trkpt lon="1" lat="1"/><trkpt lon="-1" lat="1"/></trkseg></trk></gpx>';
        const { root, handle } = await mount(mountGpsViewer, 'tracks.gpx', source);
        const paths = [...root.querySelectorAll('.omni-geojson__geometry')].map(node =>
            node.getAttribute('d')!.match(/[-.\d]+/g)!.map(Number));
        expect(paths[0]).toEqual([paths[1]?.[2], paths[1]?.[3], paths[1]?.[0], paths[1]?.[1]]);
        const waypoint = Number([...root.querySelectorAll('svg circle')].at(-1)?.getAttribute('cx'));
        expect(waypoint).toBe(paths[0]?.[2]);
        handle.dispose();
    });

    it('keeps inner rings inside the longitude window of a wide KML polygon', async () => {
        const boundary = (name: string, coordinates: string) =>
            `<${name}><LinearRing><coordinates>${coordinates}</coordinates></LinearRing></${name}>`;
        const source = '<kml><Placemark><Polygon>' +
            boundary('outerBoundaryIs', '-100,-20 -20,-20 100,-20 100,20 -20,20 -100,20 -100,-20') +
            boundary('innerBoundaryIs', '92,-5 92,5 96,5 96,-5 92,-5') + '</Polygon></Placemark></kml>';
        const { root, handle } = await mount(mountGpsViewer, 'area.kml', source);
        const path = root.querySelector('.omni-geojson__geometry')?.getAttribute('d') ?? '';
        const [outer, inner] = path.split(' Z');
        const longitudes = (ring: string | undefined) => [...(ring ?? '').matchAll(/[ML](-?[\d.]+)/g)].map(match => Number(match[1]));
        expect(Math.min(...longitudes(inner))).toBeGreaterThan(Math.min(...longitudes(outer)));
        expect(Math.max(...longitudes(inner))).toBeLessThan(Math.max(...longitudes(outer)));
        handle.dispose();
    });

    it('keeps horizontal and vertical ODP lines aligned with their axes', async () => {
        const body = '<office:presentation><draw:page>' +
            '<draw:line svg:x1="2px" svg:x2="4px" svg:y1="2px" svg:y2="2px"/>' +
            '<draw:line svg:x1="2px" svg:x2="2px" svg:y1="2px" svg:y2="4px"/>' +
            '</draw:page></office:presentation>';
        const { root, handle } = await mount(mountOpenDocumentViewer, 'lines.odp', odf(ODP_MIMETYPE, body));
        const [horizontal, vertical] = [...root.querySelectorAll('svg line')];
        expect(horizontal?.getAttribute('y1')).toBe(horizontal?.getAttribute('y2'));
        expect(vertical?.getAttribute('x1')).toBe(vertical?.getAttribute('x2'));
        handle.dispose();
    });

    it('places ODP line labels outside the stroke bounding box', async () => {
        const body = '<office:presentation><draw:page>' +
            '<draw:line svg:x1="40px" svg:x2="200px" svg:y1="80px" svg:y2="80px"><text:p>Line label</text:p></draw:line>' +
            '</draw:page></office:presentation>';
        const { root, handle } = await mount(mountOpenDocumentViewer, 'line-label.odp', odf(ODP_MIMETYPE, body));
        const label = root.querySelector<HTMLElement>('.preview-line-label');
        expect(label?.textContent).toBe('Line label');
        expect(label?.style.left).toBe('120px');
        expect(label?.style.top).toBe('80px');
        expect(label?.previousElementSibling?.querySelector('svg line')).toBeTruthy();
        handle.dispose();
    });

    it('preserves explicit spaces and line breaks in ODT headings', async () => {
        const body = '<office:text><text:h>A<text:line-break/>B<text:s text:c="3"/>C</text:h></office:text>';
        const { root, handle } = await mount(mountOpenDocumentViewer, 'heading.odt', odf(ODT_MIMETYPE, body));
        const style = document.createElement('style');
        style.textContent = filePreviewCss;
        document.head.append(style);
        document.body.append(root);
        try {
            const heading = root.querySelector('article h1')!;
            expect(heading.textContent).toBe('A\nB   C');
            expect(getComputedStyle(heading).whiteSpace).toBe('pre-wrap');
        } finally {
            handle.dispose();
            root.remove();
            style.remove();
        }
    });

    it('trims only retained whitespace when an ODT preview ends at a UTF-8 limit', async () => {
        const data = odf(ODT_MIMETYPE, '<office:text><text:p>가 </text:p></office:text>');
        for (const [maxPreviewBytes, text, status] of [[1, '', 'partial'], [3, '가', 'ok']] as const) {
            expect((await parseOpenDocument(data, { limits: { maxPreviewBytes } })).result)
                .toMatchObject({ status, document: { blocks: [{ text }] } });
        }
    });

    it('fits draw.io to visible layers and refits as layers are shown', async () => {
        const source = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
            '<mxCell id="2" parent="0" visible="0"/>' +
            '<mxCell id="a" parent="1" vertex="1"><mxGeometry x="10" y="10" width="100" height="40"/></mxCell>' +
            '<mxCell id="b" parent="2" vertex="1"><mxGeometry x="100000" y="100000" width="100" height="40"/></mxCell>' +
            '</root></mxGraphModel>';
        const { root, handle } = await mount(mountDrawioViewer, 'layers.drawio', source);
        const width = () => Number(root.querySelector('svg')?.getAttribute('viewBox')?.split(' ')[2]);
        expect(width()).toBeLessThan(200);
        const layer = root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!;
        layer.checked = true;
        layer.dispatchEvent(new Event('change'));
        expect(width()).toBeGreaterThan(100_000);
        layer.checked = false;
        layer.dispatchEvent(new Event('change'));
        expect(width()).toBeLessThan(200);
        handle.dispose();
    });

    it('hides draw.io cross-layer edges and their labels when a terminal layer is hidden', async () => {
        const source = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
            '<mxCell id="2" parent="0" visible="0"/>' +
            '<mxCell id="a" parent="1" vertex="1"><mxGeometry x="10" y="10" width="100" height="40"/></mxCell>' +
            '<mxCell id="b" parent="2" vertex="1"><mxGeometry x="100000" y="100000" width="100" height="40"/></mxCell>' +
            '<mxCell id="edge" value="Connector" parent="1" edge="1" source="a" target="b"/>' +
            '<mxCell id="label" value="Moved label" parent="edge" vertex="1" style="edgeLabel"><mxGeometry relative="1"/></mxCell>' +
            '</root></mxGraphModel>';
        const { root, handle } = await mount(mountDrawioViewer, 'layers.drawio', source);
        const width = () => Number(root.querySelector('svg')?.getAttribute('viewBox')?.split(' ')[2]);
        const lineGroup = root.querySelector('polyline')?.parentNode as SVGGElement;
        const labelGroup = [...root.querySelectorAll('text')].find(node => node.textContent === 'Moved label')?.parentNode as SVGGElement;
        const layer = root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!;
        expect(width()).toBeLessThan(200);
        expect(lineGroup.style.display).toBe('none');
        expect(labelGroup.style.display).toBe('none');
        layer.checked = true;
        layer.dispatchEvent(new Event('change'));
        expect(width()).toBeGreaterThan(100_000);
        expect(lineGroup.style.display).toBe('');
        expect(labelGroup.style.display).toBe('');
        handle.dispose();
    });

    it('omits a draw.io connector whose hidden terminal has no visible vertex ancestor', async () => {
        const source = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
            '<mxCell id="a" parent="1" vertex="1"><mxGeometry x="10" y="10" width="100" height="40"/></mxCell>' +
            '<mxCell id="b" parent="1" vertex="1" visible="0"><mxGeometry x="100000" y="100000" width="100" height="40"/></mxCell>' +
            '<mxCell id="edge" parent="1" edge="1" source="a" target="b"/>' +
            '</root></mxGraphModel>';
        const { root, handle } = await mount(mountDrawioViewer, 'hidden.drawio', source);
        expect(root.querySelector('polyline')).toBeNull();
        expect(Number(root.querySelector('svg')?.getAttribute('viewBox')?.split(' ')[2])).toBeLessThan(200);
        handle.dispose();
    });

    it('includes draw.io vertex labels that extend beyond their geometry in Fit', async () => {
        const source = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
            '<mxCell id="a" parent="1" vertex="1" style="text" value="Architecture diagrams and interface dependencies">' +
            '<mxGeometry width="70" height="30"/></mxCell></root></mxGraphModel>';
        const { root, handle } = await mount(mountDrawioViewer, 'text.drawio', source);
        const viewBox = root.querySelector('svg')?.getAttribute('viewBox')?.split(' ').map(Number);
        expect(viewBox?.[0]).toBeLessThan(-100);
        expect(viewBox?.[2]).toBeGreaterThan(350);
        handle.dispose();
    });

    it.each([
        ['ellipse', 50 + 50 / Math.sqrt(2), 250 - 50 / Math.sqrt(2), ''],
        ['rhombus', 75, 225, ''],
        ['triangle', 50 + 50 / 3, 200, '100,50'],
        ['triangle;direction=north', 100, 250 - 50 / 3, '50,0'],
        ['triangle;direction=south', 50 + 50 / 3, 200, '50,100'],
        ['triangle;direction=west', 100, 250 - 50 / 3, '0,50']
    ])('attaches draw.io connectors to the rendered %s perimeter', async (shape, start, end, tip) => {
        const source = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
            `<mxCell id="a" parent="1" vertex="1" style="${shape}"><mxGeometry width="100" height="100"/></mxCell>` +
            `<mxCell id="b" parent="1" vertex="1" style="${shape}"><mxGeometry x="200" y="200" width="100" height="100"/></mxCell>` +
            '<mxCell id="e" parent="1" edge="1" source="a" target="b"/></root></mxGraphModel>';
        const { root, handle } = await mount(mountDrawioViewer, 'shapes.drawio', source);
        const [x1, y1, x2, y2] = (root.querySelector('polyline')?.getAttribute('points') ?? '').split(/[ ,]/).map(Number);
        expect(x1).toBeCloseTo(start);
        expect(y1).toBeCloseTo(start);
        expect(x2).toBeCloseTo(end);
        expect(y2).toBeCloseTo(end);
        if (tip) expect(root.querySelector('polygon')?.getAttribute('points')?.split(' ')[0]).toBe(tip);
        handle.dispose();
    });

    it('keeps the same ODT UTF-8 preview prefix across inline markup', async () => {
        for (const paragraph of ['가AB', '가<text:span>AB</text:span>']) {
            const data = odf(ODT_MIMETYPE, `<office:text><text:p>${paragraph}</text:p><text:p>OK</text:p></office:text>`);
            expect((await parseOpenDocument(data, { limits: { maxPreviewBytes: 2 } })).result)
                .toMatchObject({ status: 'partial', document: { blocks: [{ text: '' }, { text: 'OK' }] } });
        }
    });

    it('reports ODT truncation only when text beyond the budget is omitted', async () => {
        const trailing = '<!--comment--><text:span/><office:annotation><text:p>hidden</text:p></office:annotation>';
        for (const [paragraph, status] of [['A' + trailing, 'ok'], ['A' + trailing + 'B', 'partial']]) {
            const data = odf(ODT_MIMETYPE, `<office:text><text:p>${paragraph}</text:p></office:text>`);
            expect((await parseOpenDocument(data, { limits: { maxPreviewBytes: 1 } })).result)
                .toMatchObject({ status, document: { blocks: [{ text: 'A' }] } });
        }
    });

    it('reads later inline draw.io pages when a compressed page lacks an inflater', async () => {
        vi.stubGlobal('DecompressionStream', undefined);
        try {
            const payload = deflateRawSync(encodeURIComponent(graph)).toString('base64');
            const source = bytes(`<mxfile><diagram>${payload}</diagram><diagram name="inline">${graph}</diagram></mxfile>`);
            expect((await parseDrawio(source)).result)
                .toMatchObject({ status: 'partial', document: { pages: [{ name: 'inline' }] } });
            expect((await parseDrawio(bytes(`<mxfile><diagram>${payload}</diagram></mxfile>`))).result)
                .toMatchObject({ status: 'failed', failure: { code: 'missing-dependency' } });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('retains earlier draw.io pages when a later page reaches the deadline', async () => {
        let time = 0;
        const now = vi.spyOn(Date, 'now').mockImplementation(() => time);
        const source = bytes(`<mxfile><diagram name="first">${graph}</diagram><diagram>eA==</diagram></mxfile>`);
        try {
            const result = (await parseDrawio(source, {
                limits: { maxParseMillis: 1 },
                inflate: async () => { time = 2; return bytes(encodeURIComponent(graph)); }
            })).result;
            expect(result).toMatchObject({ status: 'partial', document: { pages: [{ name: 'first' }] } });
        } finally {
            now.mockRestore();
        }
    });

    it('does not charge discarded ODT trailing spaces to the next paragraph', async () => {
        const data = odf(ODT_MIMETYPE, '<office:text><text:p>A </text:p><text:p>B</text:p></office:text>');
        expect((await parseOpenDocument(data, { limits: { maxPreviewBytes: 2 } })).result)
            .toMatchObject({ status: 'ok', document: { blocks: [{ text: 'A' }, { text: 'B' }] } });
    });

    it('enforces the cooperative time limit before normalizing a large JSON preview', () => {
        const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(2);
        try {
            expect(parseSarif(bytes(sarif), { limits: { maxParseMillis: 1 } }).result)
                .toMatchObject({ status: 'failed', failure: { code: 'limit-exceeded' } });
        } finally {
            now.mockRestore();
        }
    });

    it('enforces preview byte limits for multibyte SARIF and ODT text', async () => {
        const source = json({ version: '2.1.0', runs: [{ tool: { driver: { name: 'T' } }, results: [{ message: { text: '가' } }] }] });
        expect(parseSarif(bytes(source), { limits: { maxPreviewBytes: 2 } }).result)
            .toMatchObject({ status: 'partial', document: { findings: [{ message: '' }] } });
        const odt = odf(ODT_MIMETYPE, '<office:text><text:p>가</text:p></office:text>');
        expect((await parseOpenDocument(odt, { limits: { maxPreviewBytes: 2 } })).result)
            .toMatchObject({ status: 'partial', document: { blocks: [{ text: '' }] } });
    });

    it('does not add ODT content whitespace from inside XML closing tags', async () => {
        const odt = odf(ODT_MIMETYPE, '<office:text><text:p>foo<text:span>_bar</text:span >_baz</text:p></office:text>');
        expect((await parseOpenDocument(odt)).result).toMatchObject({
            status: 'ok', document: { blocks: [{ text: 'foo_bar_baz' }] }
        });
    });

    it('renders ODT structure and navigates positioned ODP slides', async () => {
        const doc = await mount(mountOpenDocumentViewer, 'outline.odt', odt());
        expect(doc.root.querySelector('article h2')?.textContent).toBe('Project outline');
        expect(doc.root.querySelector('article p')?.textContent).toBe('Intro  text');
        expect(doc.root.querySelector('li')?.textContent).toBe('First step');
        doc.handle.dispose();
        const slides = await mount(mountOpenDocumentViewer, 'slides.odp', odp());
        expect(slides.root.querySelector<HTMLElement>('.preview-shape')?.style.left).toBe('96px');
        expect(slides.root.querySelector('.preview-shape')?.textContent).toBe('First slide');
        button(slides.root, 'Next').click();
        expect(slides.root.querySelector('h3')?.textContent).toBe('Slide two');
        slides.handle.dispose();
    });

    it('uses a host inflater when the runtime only supports zlib streams', async () => {
        vi.stubGlobal('DecompressionStream', class {
            constructor() { throw new TypeError('Unsupported raw deflate'); }
        });
        try {
            const zipped = buildZip([{ name: 'doc.kml', data: kml }]);
            expect((await parseGps(zipped)).result).toMatchObject({ status: 'failed', failure: { code: 'missing-dependency' } });
            const inflate = async (input: Uint8Array, maxOutputLength: number) =>
                new Uint8Array(inflateRawSync(input, { maxOutputLength }));
            expect((await parseGps(zipped, { inflate })).result).toMatchObject({ status: 'partial', document: { format: 'kmz' } });
            expect((await parseDrawio(bytes(drawio), { inflate })).result).toMatchObject({ status: 'ok', document: { pages: [{ name: 'Plain' }, { name: 'Compressed' }] } });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('reports malformed input, abort and exceeded limits through parser and mount contracts', async () => {
        expect(parseSarif(bytes('{}')).result).toMatchObject({ status: 'failed', failure: { code: 'invalid-format' } });
        expect(parseSarif(bytes(sarif), { limits: { maxEntries: 1 } }).result).toMatchObject({ status: 'partial' });
        expect((await parseDrawio(bytes(drawio), { limits: { maxDecompressedBytes: 1 } })).result).toMatchObject({ status: 'partial' });
        const controller = new AbortController();
        controller.abort();
        const container = document.createElement('div');
        await expect(mountGpsViewer({ fileName: 'run.gpx', data: bytes(gpx) }, container, ctx, { signal: controller.signal })).rejects.toBeInstanceOf(MountAbortedError);
        expect(container.shadowRoot).toBeNull();
    });
});
