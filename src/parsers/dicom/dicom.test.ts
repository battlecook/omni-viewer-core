import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeDicomFrame, hasDicomPreamble, parseDicom, renderDicomFrame } from './index.js';
import { BE, IMPLICIT, LE, concat, delimiter, dicomFixture, element, item, words } from './__tests__/fixture.js';
const gray = (rgba: Uint8ClampedArray) => Array.from(rgba).filter((_, i) => i % 4 === 0);

describe('DICOM parsing and pixel rendering', () => {
    it('reads and renders every frame of the shipped synthetic example', () => {
        const model = parseDicom(new Uint8Array(readFileSync('examples/dicom/synthetic-phantom.dcm')));
        expect(model.image.frames).toBe(3); expect(model.image.signed).toBe(true); expect(model.previewIssue).toBeUndefined();
        const frames = [0, 1, 2].map(index => renderDicomFrame(decodeDicomFrame(model, index)));
        expect(frames.every(frame => frame.length === 128 * 128 * 4)).toBe(true);
        expect(frames[0]).not.toEqual(frames[1]); expect(frames[1]).not.toEqual(frames[2]);
    });
    it.each([LE, IMPLICIT, BE])('reads PS3.10 file metadata independently of dataset encoding ($explicit, $little)', encoding => {
        const data = dicomFixture({ encoding, pixels: words([0, 64, 128, 255], encoding.little), attributes: { '00280100': ['US', 16] } });
        const model = parseDicom(data);
        expect(model.hasPreamble).toBe(true); expect(model.littleEndian).toBe(encoding.little);
        expect(model.values['00100010']).toBe('SYNTHETIC^TEST'); expect(model.previewIssue).toBeUndefined();
        expect(model.image.rows).toBe(2); expect(gray(renderDicomFrame(decodeDicomFrame(model)))).toEqual([0, 64, 128, 255]);
        expect(model.pixelData.buffer).toBe(data.buffer);
    });
    it.each([LE, IMPLICIT])('reads raw datasets without a preamble ($explicit)', encoding => {
        const model = parseDicom(dicomFixture({ raw: true, encoding }));
        expect(model.hasPreamble).toBe(false); expect(model.image.bitsStored).toBe(8); expect(model.previewIssue).toBeUndefined();
    });
    it('accepts nonzero Uint8Array offsets and explicit raw big-endian syntax', () => {
        const data = dicomFixture(), padded = concat(new Uint8Array(7), data, new Uint8Array(9));
        expect(parseDicom(padded.subarray(7, padded.length - 9)).values['00100020']).toBe('DEMO-NO-PATIENT');
        const model = parseDicom(dicomFixture({ raw: true, encoding: BE, pixels: new Uint8Array([64, 0, 255, 128]) }), { transferSyntaxUid: '1.2.840.10008.1.2.2' });
        expect(gray(renderDicomFrame(decodeDicomFrame(model)))).toEqual([0, 64, 128, 255]);
    });
    it('sign extends stored bits, shifts high bits, and applies CT rescale before windowing', () => {
        const model = parseDicom(dicomFixture({ pixels: words([0x8000, 0xfff0, 0, 0x7ff0]), attributes: {
            '00280100': ['US', 16], '00280101': ['US', 12], '00280102': ['US', 15], '00280103': ['US', 1], '00281053': ['DS', '2'], '00281052': ['DS', '-1024'], '00281050': ['DS', '0\\40'], '00281051': ['DS', '4096\\400']
        } }));
        const frame = decodeDicomFrame(model);
        expect(Array.from(frame.pixels)).toEqual([-5120, -1026, -1024, 3070]);
        expect(frame.windowCenter).toBe(0); expect(frame.windowWidth).toBe(4096);
        expect(gray(renderDicomFrame(frame, { windowCenter: -1024, windowWidth: 1 }))).toEqual([0, 0, 255, 255]);
    });
    it('implements PS3.3 window boundaries, negative slope and MONOCHROME1 inversion', () => {
        const model = parseDicom(dicomFixture({ attributes: { '00280004': ['CS', 'MONOCHROME1'], '00281053': ['DS', '-1'] } }));
        const frame = decodeDicomFrame(model);
        expect(gray(renderDicomFrame(frame))).toEqual([0, 64, 128, 255]);
        expect(gray(renderDicomFrame(frame, { invert: true }))).toEqual([255, 191, 127, 0]);
        expect(() => renderDicomFrame(frame, { windowWidth: 0 })).toThrow('Invalid');
    });
    it('supports SIGMOID and LINEAR_EXACT VOI functions', () => {
        const frame = decodeDicomFrame(parseDicom(dicomFixture({ attributes: { '00281056': ['CS', 'SIGMOID'], '00281050': ['DS', '128'], '00281051': ['DS', '128'] } })));
        expect(gray(renderDicomFrame(frame))[2]).toBe(128);
        frame.voiFunction = 'LINEAR_EXACT'; expect(gray(renderDicomFrame(frame, { windowCenter: 128, windowWidth: 256 }))).toEqual([0, 64, 128, 254]);
    });
    it('preserves rescale precision for narrow fractional windows', () => {
        const frame = decodeDicomFrame(parseDicom(dicomFixture({ pixels: new Uint8Array([0, 1, 2, 3]), attributes: {
            '00281053': ['DS', '0.0001'], '00281052': ['DS', '10000'],
            '00281056': ['CS', 'LINEAR_EXACT'], '00281050': ['DS', '10000.00015'], '00281051': ['DS', '0.0003']
        } })));
        expect(frame.pixels[1]).toBeCloseTo(10000.0001, 8);
        expect(gray(renderDicomFrame(frame))).toEqual([0, 85, 170, 255]);
    });
    it('validates windows against the final fallback VOI function', () => {
        const model = parseDicom(dicomFixture({ attributes: {
            '00281056': ['CS', 'UNKNOWN'], '00281050': ['DS', '128'], '00281051': ['DS', '0.5']
        } }));
        const frame = decodeDicomFrame(model);
        expect(model.diagnostics.some(d => d.messageKey === 'dicom.voiFunction')).toBe(true);
        expect(frame.voiFunction).toBe('LINEAR'); expect(frame.windowWidth).toBe(256);
        expect(gray(renderDicomFrame(frame))).toEqual([0, 64, 128, 255]);
    });
    it('excludes signed pixel padding from auto-window bounds', () => {
        const frame = decodeDicomFrame(parseDicom(dicomFixture({ encoding: IMPLICIT, pixels: words([0x8000, 0, 100, 200]), attributes: {
            '00280100': ['US', 16], '00280101': ['US', 16], '00280102': ['US', 15], '00280103': ['US', 1], '00280120': ['US', 0x8000]
        } })));
        expect(frame.windowCenter).toBe(100.5); expect(frame.windowWidth).toBe(201);
    });
    it('decodes individual frames and rejects out-of-bounds indices', () => {
        const model = parseDicom(dicomFixture({ pixels: new Uint8Array([0, 64, 128, 255, 255, 128, 64, 0]), attributes: { '00280008': ['IS', '2'] } }));
        expect(gray(renderDicomFrame(decodeDicomFrame(model, 1)))).toEqual([255, 128, 64, 0]);
        for (const index of [-1, .5, 2, NaN]) expect(() => decodeDicomFrame(model, index)).toThrow('range');
    });
    it.each([0, 1])('decodes RGB with planar configuration %s', planar => {
        const pixels = planar ? new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]) : new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
        const model = parseDicom(dicomFixture({ pixels, attributes: { '00280002': ['US', 3], '00280004': ['CS', 'RGB'], '00280006': ['US', planar] } }));
        const expected = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255];
        expect(Array.from(renderDicomFrame(decodeDicomFrame(model)))).toEqual(expected);
    });
    it('converts full-range YBR to RGB', () => {
        const model = parseDicom(dicomFixture({ pixels: new Uint8Array([0, 128, 128, 255, 128, 128]), attributes: { '00280002': ['US', 3], '00280004': ['CS', 'YBR_FULL'], '00280010': ['US', 1] } }));
        expect(Array.from(renderDicomFrame(decodeDicomFrame(model)))).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    });
    it.each([LE, IMPLICIT, BE])('traverses bounded and undefined sequences without overwriting image attributes ($explicit, $little)', encoding => {
        const nested = element('00280010', 'US', 999, encoding);
        const seq1 = element('00081110', 'SQ', item(nested, encoding), encoding);
        const seq2 = element('00081115', 'SQ', concat(item(concat(nested, delimiter(false, encoding)), encoding, true), delimiter(true, encoding)), encoding, true);
        const model = parseDicom(dicomFixture({ encoding, extra: [seq1, seq2] }));
        expect(model.image.rows).toBe(2); expect(model.elements.filter(e => e.tag === '00280010')).toHaveLength(3);
        expect(model.elements.filter(e => e.tag === '00280010' && e.depth > 0)).toHaveLength(2);
    });
    it('keeps compressed-image metadata and validates encapsulated fragments', () => {
        const fragments = concat(item(new Uint8Array()), item(new Uint8Array([1, 2, 3, 4])), delimiter());
        const model = parseDicom(dicomFixture({ syntax: '1.2.840.10008.1.2.4.90', pixels: fragments, encapsulated: true }));
        expect(model.values['00100010']).toBe('SYNTHETIC^TEST'); expect(model.previewIssue?.messageKey).toBe('dicom.unsupportedSyntax');
        expect(model.pixelData.length).toBe(0); expect(() => decodeDicomFrame(model)).toThrow('unsupportedSyntax');
        expect(() => parseDicom(dicomFixture({ syntax: model.transferSyntaxUid, pixels: fragments.subarray(0, -8), encapsulated: true }))).toThrow('truncated');
    });
    it.each([LE, BE])('decodes undefined-length UN as implicit LE and restores the surrounding syntax ($little)', encoding => {
        const nested = element('00100010', 'PN', 'NESTED^TEST', IMPLICIT);
        const unknown = element('00111010', 'UN', concat(item(nested, IMPLICIT), delimiter(true, IMPLICIT)), encoding, true);
        const model = parseDicom(dicomFixture({ encoding, extra: [unknown], pixels: new Uint8Array(encoding.little ? [0, 64, 128, 255] : [64, 0, 255, 128]) }));
        expect(model.elements.find(e => e.tag === '00100010' && e.depth > 0)?.value).toBe('NESTED^TEST');
        expect(model.values['00100010']).toBe('SYNTHETIC^TEST');
        expect(gray(renderDicomFrame(decodeDicomFrame(model)))).toEqual([0, 64, 128, 255]);
    });
    it('provides metadata for non-image objects, unsupported transforms, color and deflated datasets', () => {
        expect(parseDicom(dicomFixture({ pixels: null })).previewIssue?.messageKey).toBe('dicom.noPixels');
        expect(parseDicom(dicomFixture({ attributes: { '00280004': ['CS', 'PALETTE COLOR'] } })).previewIssue?.messageKey).toBe('dicom.unsupportedColor');
        expect(parseDicom(dicomFixture({ extra: [element('52009230', 'SQ', new Uint8Array())] })).previewIssue?.messageKey).toBe('dicom.unsupportedTransform');
        expect(parseDicom(dicomFixture({ syntax: '1.2.840.10008.1.2.1.99' })).previewIssue?.messageKey).toBe('dicom.unsupportedSyntax');
    });
    it('decodes UTF-8 / Latin-1 and reports unsupported character sets', () => {
        expect(parseDicom(dicomFixture({ attributes: { '00100010': ['PN', '테스트^患者'] } })).values['00100010']).toBe('테스트^患者');
        const latin = parseDicom(dicomFixture({ attributes: { '00080005': ['CS', 'ISO_IR 100'], '00100010': ['PN', new Uint8Array([0x4a, 0xf6, 0x72, 0x67])] } }));
        expect(latin.values['00100010']).toBe('Jörg');
        expect(parseDicom(dicomFixture({ attributes: { '00080005': ['CS', 'ISO 2022 IR 87'] } })).diagnostics[0]?.messageKey).toBe('dicom.charset');
    });
    it.each([LE, IMPLICIT, BE])('scopes nested character sets to their item and restores parent and sibling encodings ($explicit, $little)', encoding => {
        const utf8Item = item(concat(element('00080005', 'CS', 'ISO_IR 192', encoding), element('00100010', 'PN', '患者', encoding)), encoding);
        const latinItem = item(concat(
            element('00080005', 'CS', 'ISO_IR 100', encoding),
            element('00081110', 'SQ', utf8Item, encoding),
            element('00100010', 'PN', new Uint8Array([0x4a, 0xf6, 0x72, 0x67]), encoding)
        ), encoding);
        const sibling = item(element('00100010', 'PN', '환자', encoding), encoding);
        const sequence = element('00081110', 'SQ', concat(latinItem, sibling), encoding);
        const model = parseDicom(dicomFixture({ encoding, extra: [sequence, element('77770010', 'LO', '루트', encoding)] }));
        expect(model.elements.filter(e => e.tag === '00100010').map(e => e.value)).toEqual(['SYNTHETIC^TEST', '患者', 'Jörg', '환자']);
        // Implicit VR private values remain opaque, but explicit VR text after the
        // sequence must also use the restored root character set.
        if (encoding.explicit) expect(model.values['77770010']).toBe('루트');
        expect(model.diagnostics).toEqual([]);
    });
    it('bounds bytes, elements, pixels, frames, text and sequence depth', () => {
        const data = dicomFixture();
        for (const options of [{ maxBytes: 10 }, { maxElements: 2 }, { maxPixels: 2 }, { maxFrames: 0 }]) expect(() => parseDicom(data, options)).toThrow(/limit|positive/);
        expect(() => parseDicom(dicomFixture({ attributes: { '00280008': ['IS', '100001'] } }))).toThrow('limits');
        const nested = element('00081110', 'SQ', item(element('00081110', 'SQ', item(element('00100010', 'PN', 'nested')))));
        expect(() => parseDicom(dicomFixture({ extra: [nested] }), { maxDepth: 2 })).toThrow('nesting');
        expect(parseDicom(dicomFixture({ attributes: { '00100010': ['PN', 'A'.repeat(6000)] } })).values['00100010']?.length).toBe(1024);
    });
    it('rejects malformed lengths, VRs, dimensions, numeric values and sequence delimiters', () => {
        expect(hasDicomPreamble(new Uint8Array(131))).toBe(false);
        for (const data of [new Uint8Array(), new Uint8Array(20), dicomFixture().subarray(0, -1), dicomFixture({ extra: [element('00100010', 'PN', 'duplicate')] }), dicomFixture({ extra: [delimiter()] })]) expect(() => parseDicom(data)).toThrow();
        expect(() => parseDicom(dicomFixture({ pixels: new Uint8Array(2) }))).toThrow('Pixel Data');
        for (const value of ['NaN', 'Infinity', '1junk', '-1', '2.5']) expect(() => parseDicom(dicomFixture({ attributes: { '00280008': ['IS', value] } }))).toThrow();
        const raw = dicomFixture({ raw: true }); raw[4] = 90; raw[5] = 90;
        expect(() => parseDicom(raw, { transferSyntaxUid: '1.2.840.10008.1.2.1' })).toThrow('representation');
    });
});
