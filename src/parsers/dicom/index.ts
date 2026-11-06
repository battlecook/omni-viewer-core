import type { DicomDiagnostic, DicomDocument, DicomElement, DicomImage, DicomParseOptions } from './model.js';
export type * from './model.js';
export { decodeDicomFrame, renderDicomFrame } from './pixels.js';

const IMPLICIT_LE = '1.2.840.10008.1.2';
const EXPLICIT_LE = `${IMPLICIT_LE}.1`;
const EXPLICIT_BE = `${IMPLICIT_LE}.2`;
const VR = new Set('AE AS AT CS DA DS DT FD FL IS LO LT OB OD OF OL OV OW PN SH SL SQ SS ST SV TM UC UI UL UN UR US UT UV'.split(' '));
const LONG_VR = new Set('OB OD OF OL OV OW SQ SV UC UN UR UT UV'.split(' '));
const TEXT_VR = new Set('AE AS CS DA DS DT IS LO LT PN SH ST TM UC UI UR UT'.split(' '));
const DICTIONARY: Record<string, readonly [string, string]> = {
    '00020000': ['UL', 'File Meta Information Group Length'],
    '00020001': ['OB', 'File Meta Information Version'],
    '00020002': ['UI', 'Media Storage SOP Class UID'],
    '00020003': ['UI', 'Media Storage SOP Instance UID'],
    '00020010': ['UI', 'Transfer Syntax UID'],
    '00020012': ['UI', 'Implementation Class UID'],
    '00020013': ['SH', 'Implementation Version Name'],
    '00080005': ['CS', 'Specific Character Set'],
    '00080008': ['CS', 'Image Type'],
    '00080016': ['UI', 'SOP Class UID'],
    '00080018': ['UI', 'SOP Instance UID'],
    '00080020': ['DA', 'Study Date'],
    '00080030': ['TM', 'Study Time'],
    '00080050': ['SH', 'Accession Number'],
    '00080060': ['CS', 'Modality'],
    '00080070': ['LO', 'Manufacturer'],
    '00080080': ['LO', 'Institution Name'],
    '00081030': ['LO', 'Study Description'],
    '0008103E': ['LO', 'Series Description'],
    '00081110': ['SQ', 'Referenced Study Sequence'],
    '00100010': ['PN', 'Patient Name'],
    '00100020': ['LO', 'Patient ID'],
    '00100030': ['DA', 'Patient Birth Date'],
    '00100040': ['CS', 'Patient Sex'],
    '00101010': ['AS', 'Patient Age'],
    '00180050': ['DS', 'Slice Thickness'],
    '00185100': ['CS', 'Patient Position'],
    '0020000D': ['UI', 'Study Instance UID'],
    '0020000E': ['UI', 'Series Instance UID'],
    '00200011': ['IS', 'Series Number'],
    '00200013': ['IS', 'Instance Number'],
    '00200032': ['DS', 'Image Position (Patient)'],
    '00200037': ['DS', 'Image Orientation (Patient)'],
    '00280002': ['US', 'Samples per Pixel'],
    '00280004': ['CS', 'Photometric Interpretation'],
    '00280006': ['US', 'Planar Configuration'],
    '00280008': ['IS', 'Number of Frames'],
    '00280010': ['US', 'Rows'],
    '00280011': ['US', 'Columns'],
    '00280030': ['DS', 'Pixel Spacing'],
    '00280100': ['US', 'Bits Allocated'],
    '00280101': ['US', 'Bits Stored'],
    '00280102': ['US', 'High Bit'],
    '00280103': ['US', 'Pixel Representation'],
    '00280120': ['US', 'Pixel Padding Value'],
    '00280121': ['US', 'Pixel Padding Range Limit'],
    '00281050': ['DS', 'Window Center'],
    '00281051': ['DS', 'Window Width'],
    '00281052': ['DS', 'Rescale Intercept'],
    '00281053': ['DS', 'Rescale Slope'],
    '00281054': ['LO', 'Rescale Type'],
    '00281056': ['CS', 'VOI LUT Function'],
    '00283000': ['SQ', 'Modality LUT Sequence'],
    '00283010': ['SQ', 'VOI LUT Sequence'],
    '52009229': ['SQ', 'Shared Functional Groups Sequence'],
    '52009230': ['SQ', 'Per-frame Functional Groups Sequence'],
    '7FE00008': ['OF', 'Float Pixel Data'],
    '7FE00009': ['OD', 'Double Float Pixel Data'],
    '7FE00010': ['OW', 'Pixel Data']
};

function limit(value: number | undefined, fallback: number): number {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < 1) throw new Error('DICOM limits must be positive safe integers.');
    return result;
}
export function hasDicomPreamble(data: Uint8Array): boolean {
    return data.length >= 132 && [0x44, 0x49, 0x43, 0x4d].every((byte, i) => data[128 + i] === byte);
}

/** Bounded PS3.10 / raw dataset reader. No network, codecs, or DOM dependencies. */
export function parseDicom(data: Uint8Array, options: DicomParseOptions = {}): DicomDocument {
    if (data.length > limit(options.maxBytes, 256 * 1024 * 1024)) throw new Error('DICOM file exceeds the byte limit.');
    const maxElements = limit(options.maxElements, 50_000), maxDepth = limit(options.maxDepth, 32);
    const maxPixels = limit(options.maxPixels, 16_777_216), maxFrames = limit(options.maxFrames, 100_000);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const hasPreamble = hasDicomPreamble(data), elements: DicomElement[] = [];
    const values: Record<string, string> = Object.create(null) as Record<string, string>;
    const diagnostics: DicomDiagnostic[] = [];
    let cursor = hasPreamble ? 132 : 0, count = 0, decoder = new TextDecoder('utf-8');
    let pixelData = new Uint8Array(0) as Uint8Array, encapsulated = false;
    let pixelSeen = false, floatPixels = false, syntax = options.transferSyntaxUid ?? IMPLICIT_LE;
    let explicit = false, little = true;
    const need = (n: number, end = data.length) => {
        if (!Number.isSafeInteger(n) || n < 0 || cursor + n > end) throw new Error('DICOM element is truncated or has an invalid length.');
    };
    const u16 = (offset: number) => view.getUint16(offset, little);
    const u32 = (offset: number) => view.getUint32(offset, little);
    const tagAt = () => u16(cursor).toString(16).padStart(4, '0').toUpperCase() + u16(cursor + 2).toString(16).padStart(4, '0').toUpperCase();
    const text = (start: number, length: number) => decoder.decode(data.subarray(start, start + Math.min(length, 1024))).replace(/[\0 ]+$/g, '');
    const valueOf = (vr: string, start: number, length: number): string => {
        if (TEXT_VR.has(vr)) return text(start, length);
        const size = ['US', 'SS'].includes(vr) ? 2 : ['UL', 'SL', 'FL', 'AT'].includes(vr) ? 4 : vr === 'FD' ? 8 : 0;
        if (!size) return '';
        if (length % size) throw new Error('DICOM numeric element has an invalid length.');
        const result: string[] = [];
        for (let p = start; p < start + Math.min(length, size * 16); p += size) {
            const n = vr === 'US' ? view.getUint16(p, little) : vr === 'SS' ? view.getInt16(p, little)
                : vr === 'UL' ? view.getUint32(p, little) : vr === 'SL' ? view.getInt32(p, little)
                : vr === 'FL' ? view.getFloat32(p, little) : vr === 'FD' ? view.getFloat64(p, little)
                : `(${view.getUint16(p, little).toString(16)},${view.getUint16(p + 2, little).toString(16)})`;
            result.push(String(n));
        }
        return result.join('\\');
    };
    const walk = (end: number, depth: number, delimiter?: string, sequence = false): void => {
        if (depth > maxDepth) throw new Error('DICOM sequence exceeds the nesting limit.');
        const inheritedDecoder = decoder;
        try {
            while (cursor < end) {
                need(8, end);
                if (++count > maxElements) throw new Error('DICOM dataset exceeds the element limit.');
                const tag = tagAt();
                if (tag === 'FFFEE00D' || tag === 'FFFEE0DD') {
                    const length = u32(cursor + 4); cursor += 8;
                    if (tag !== delimiter || length !== 0) throw new Error('Unexpected DICOM sequence delimiter.');
                    return;
                }
                if (tag === 'FFFEE000') {
                    if (!sequence) throw new Error('Unexpected DICOM sequence item.');
                    const length = u32(cursor + 4); cursor += 8;
                    if (length === 0xffffffff) walk(end, depth + 1, 'FFFEE00D');
                    else { need(length, end); walk(cursor + length, depth + 1); }
                    continue;
                }
                if (sequence) throw new Error('Expected a DICOM sequence item.');
                const known = DICTIONARY[tag];
                let vr = known?.[0] ?? 'UN', length: number;
                if (explicit) {
                    vr = String.fromCharCode(data[cursor + 4]!, data[cursor + 5]!);
                    if (!VR.has(vr)) throw new Error(`Invalid DICOM value representation at ${tag}.`);
                    if (LONG_VR.has(vr)) {
                        need(12, end);
                        if (u16(cursor + 6) !== 0) throw new Error('Invalid DICOM reserved bytes.');
                        length = u32(cursor + 8); cursor += 12;
                    } else { length = u16(cursor + 6); cursor += 8; }
                } else { length = u32(cursor + 4); cursor += 8; }
                const start = cursor, undefinedLength = length === 0xffffffff;
                if (!undefinedLength) need(length, end);
                const pixel = tag === '7FE00010' || tag === '7FE00008' || tag === '7FE00009';
                const isSequence = vr === 'SQ' || (!explicit && !pixel && cursor + 8 <= end && tagAt() === 'FFFEE000');
                const value = pixel || isSequence || undefinedLength ? '' : valueOf(vr, start, length);
                elements.push({ tag, name: known?.[1] ?? '', vr, depth, length, value: value.slice(0, 1024) });
                if (tag === '00080005') {
                    const charsets: Record<string, string> = { '': 'utf-8', ISO_IR_6: 'utf-8', ISO_IR_100: 'iso-8859-1', ISO_IR_192: 'utf-8', ISO_IR_149: 'euc-kr', GB18030: 'gb18030', GBK: 'gbk' };
                    const encoding = charsets[value.replace(/ /g, '_')];
                    if (encoding) decoder = new TextDecoder(encoding);
                    else diagnostics.push({ messageKey: 'dicom.charset', args: { charset: value } });
                }
                if (depth === 0) {
                    if (Object.hasOwn(values, tag)) throw new Error(`Duplicate top-level DICOM element ${tag}.`);
                    values[tag] = value;
                    if (pixel) {
                        if (pixelSeen) throw new Error('Multiple DICOM pixel data elements are unsupported.');
                        pixelSeen = true; floatPixels = tag !== '7FE00010'; encapsulated = undefinedLength;
                        if (!undefinedLength) pixelData = data.subarray(start, start + length);
                    }
                }
                if (pixel && undefinedLength) {
                    // Encapsulation is a stream of binary fragments, never nested datasets.
                    let first = true;
                    while (true) {
                        need(8, end);
                        if (++count > maxElements) throw new Error('DICOM fragments exceed the element limit.');
                        const item = tagAt(), size = u32(cursor + 4); cursor += 8;
                        if (item === 'FFFEE0DD') { if (size || first) throw new Error('Invalid DICOM pixel sequence.'); break; }
                        if (item !== 'FFFEE000' || size === 0xffffffff || (first && size % 4)) throw new Error('Invalid DICOM pixel fragment.');
                        need(size, end); cursor += size; first = false;
                    }
                } else if (isSequence || undefinedLength) {
                    if (undefinedLength && !['SQ', 'UN'].includes(vr)) throw new Error('Invalid undefined-length DICOM element.');
                    const outerExplicit = explicit, outerLittle = little;
                    // PS3.5 6.2.2: undefined-length UN values retain Implicit VR LE
                    // encoding, even inside an Explicit VR Big Endian dataset.
                    if (undefinedLength && vr === 'UN') { explicit = false; little = true; }
                    try { walk(undefinedLength ? end : start + length, depth + 1, undefinedLength ? 'FFFEE0DD' : undefined, true); }
                    finally { explicit = outerExplicit; little = outerLittle; }
                } else cursor += length;
            }
            if (delimiter) throw new Error('DICOM sequence is missing its delimiter.');
        } finally { decoder = inheritedDecoder; }
    };
    // File Meta Information is always Explicit VR Little Endian.
    if (hasPreamble) {
        explicit = true;
        while (cursor + 8 <= data.length && view.getUint16(cursor, true) === 2) {
            // Let the normal reader consume exactly one bounded meta element.
            const vr = String.fromCharCode(data[cursor + 4]!, data[cursor + 5]!);
            const header = LONG_VR.has(vr) ? 12 : 8; need(header);
            const length = header === 12 ? view.getUint32(cursor + 8, true) : view.getUint16(cursor + 6, true);
            need(header + length); walk(cursor + header + length, 0);
        }
        syntax = values['00020010'] ?? '';
        if (!syntax) throw new Error('DICOM file is missing the Transfer Syntax UID.');
    } else if (data.length < 8) throw new Error('DICOM dataset is truncated.');
    else if (!options.transferSyntaxUid && VR.has(String.fromCharCode(data[4]!, data[5]!))) syntax = EXPLICIT_LE;
    explicit = syntax !== IMPLICIT_LE; little = syntax !== EXPLICIT_BE;
    const native = [IMPLICIT_LE, EXPLICIT_LE, EXPLICIT_BE].includes(syntax);
    const compressed = syntax.startsWith(`${IMPLICIT_LE}.4.`) || syntax === `${IMPLICIT_LE}.5`;
    if (native || compressed) walk(data.length, 0);
    if (!hasPreamble && !['00080016', '00100010', '00280010', '7FE00010'].some(tag => Object.hasOwn(values, tag))) throw new Error('Unrecognized DICOM dataset.');
    const number = (tag: string, fallback: number): number => {
        if (!values[tag]) return fallback;
        const part = values[tag]!.split('\\')[0]!.trim(), result = part ? Number(part) : NaN;
        if (!Number.isFinite(result)) throw new Error(`Invalid DICOM numeric value at ${tag}.`);
        return result;
    };
    const optional = (tag: string) => values[tag] ? number(tag, 0) : undefined;
    const image: DicomImage = {
        rows: number('00280010', 0), columns: number('00280011', 0), frames: number('00280008', 1),
        samplesPerPixel: number('00280002', 1), photometricInterpretation: values['00280004'] ?? '',
        planarConfiguration: number('00280006', 0), bitsAllocated: number('00280100', 0),
        bitsStored: number('00280101', number('00280100', 0)), highBit: number('00280102', number('00280101', number('00280100', 0)) - 1),
        signed: number('00280103', 0) === 1, slope: number('00281053', 1), intercept: number('00281052', 0),
        windowCenter: optional('00281050'), windowWidth: optional('00281051'), voiFunction: values['00281056'] ?? 'LINEAR',
        pixelSpacing: (values['00280030'] ?? '').split('\\').map(Number).filter(n => Number.isFinite(n) && n > 0),
        paddingValue: optional('00280120'), paddingRangeLimit: optional('00280121')
    };
    if (![image.rows, image.columns, image.frames].every(Number.isSafeInteger) || image.rows < 0 || image.columns < 0 || image.frames < 1 || image.frames > maxFrames || image.rows * image.columns > maxPixels) throw new Error('DICOM dimensions or frame count exceed the limits.');
    // Implicit VR padding values follow Pixel Representation, not the dictionary's US default.
    if (image.signed) {
        if (image.paddingValue !== undefined && image.paddingValue >= 32768) image.paddingValue -= 65536;
        if (image.paddingRangeLimit !== undefined && image.paddingRangeLimit >= 32768) image.paddingRangeLimit -= 65536;
    }
    let previewIssue: DicomDiagnostic | undefined;
    if (!native || encapsulated) previewIssue = { messageKey: 'dicom.unsupportedSyntax', args: { syntax } };
    else if (!pixelSeen) previewIssue = { messageKey: 'dicom.noPixels' };
    else if (floatPixels || ![8, 16].includes(image.bitsAllocated) || !Number.isInteger(image.bitsStored) || image.bitsStored < 1 || image.bitsStored > image.bitsAllocated || !Number.isInteger(image.highBit) || image.highBit < image.bitsStored - 1 || image.highBit >= image.bitsAllocated || ![0, 1].includes(number('00280103', 0))) previewIssue = { messageKey: 'dicom.unsupportedPixels' };
    else if (!image.rows || !image.columns) throw new Error('DICOM image dimensions are missing.');
    else if (!(image.samplesPerPixel === 1 && /^MONOCHROME[12]$/.test(image.photometricInterpretation)) && !(image.samplesPerPixel === 3 && ['RGB', 'YBR_FULL'].includes(image.photometricInterpretation) && image.bitsAllocated === 8 && image.bitsStored === 8 && image.highBit === 7 && !image.signed && [0, 1].includes(image.planarConfiguration))) previewIssue = { messageKey: 'dicom.unsupportedColor', args: { color: image.photometricInterpretation } };
    else if (['00283000', '52009229', '52009230'].some(tag => Object.hasOwn(values, tag))) previewIssue = { messageKey: 'dicom.unsupportedTransform' };
    if (!previewIssue && image.samplesPerPixel === 1) {
        const min = image.signed ? -(2 ** (image.bitsStored - 1)) : 0;
        const max = image.signed ? 2 ** (image.bitsStored - 1) - 1 : 2 ** image.bitsStored - 1;
        if (![min, max].every(n => Number.isFinite(n * image.slope + image.intercept) && Math.abs(n * image.slope + image.intercept) <= 3.4028234663852886e38)) previewIssue = { messageKey: 'dicom.unsupportedPixels' };
    }
    if (native && !encapsulated && pixelSeen && !floatPixels && !previewIssue) {
        const required = image.rows * image.columns * image.frames * image.samplesPerPixel * image.bitsAllocated / 8;
        if (!Number.isSafeInteger(required) || pixelData.length < required || pixelData.length > required + (required % 2)) throw new Error('DICOM Pixel Data length does not match the image dimensions.');
    }
    if (!['LINEAR', 'LINEAR_EXACT', 'SIGMOID'].includes(image.voiFunction)) diagnostics.push({ messageKey: 'dicom.voiFunction', args: { function: image.voiFunction } });
    if (Object.hasOwn(values, '00283010')) diagnostics.push({ messageKey: 'dicom.voiLut' });
    return { hasPreamble, transferSyntaxUid: syntax, littleEndian: little, elements, values, image, pixelData, previewIssue, diagnostics };
}
