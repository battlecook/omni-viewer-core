/** Synthetic fixtures only: no patient data or external resources. */
export interface Encoding { explicit: boolean; little: boolean; }
export const LE: Encoding = { explicit: true, little: true };
export const IMPLICIT: Encoding = { explicit: false, little: true };
export const BE: Encoding = { explicit: true, little: false };
export const concat = (...parts: Uint8Array[]): Uint8Array => {
    const output = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0;
    for (const part of parts) { output.set(part, at); at += part.length; } return output;
};
export function element(tag: string, vr: string, value: string | number | Uint8Array, encoding = LE, undefinedLength = false): Uint8Array {
    let bytes: Uint8Array;
    if (typeof value === 'number') {
        bytes = new Uint8Array(vr === 'UL' ? 4 : 2); const view = new DataView(bytes.buffer);
        if (vr === 'UL') view.setUint32(0, value, encoding.little); else view.setUint16(0, value, encoding.little);
    } else if (typeof value === 'string') {
        const raw = new TextEncoder().encode(value); bytes = new Uint8Array(raw.length + raw.length % 2); bytes.fill(vr === 'UI' ? 0 : 32); bytes.set(raw);
    } else bytes = value;
    const long = encoding.explicit && ['OB', 'OW', 'SQ', 'UN', 'UT', 'OF', 'OD'].includes(vr);
    const header = new Uint8Array(long ? 12 : 8), view = new DataView(header.buffer);
    view.setUint16(0, parseInt(tag.slice(0, 4), 16), encoding.little); view.setUint16(2, parseInt(tag.slice(4), 16), encoding.little);
    if (encoding.explicit) {
        header.set(new TextEncoder().encode(vr), 4);
        if (long) view.setUint32(8, undefinedLength ? 0xffffffff : bytes.length, encoding.little);
        else view.setUint16(6, bytes.length, encoding.little);
    } else view.setUint32(4, undefinedLength ? 0xffffffff : bytes.length, encoding.little);
    return concat(header, bytes);
}
export function item(bytes: Uint8Array, encoding = LE, undefinedLength = false): Uint8Array {
    const header = new Uint8Array(8), v = new DataView(header.buffer); v.setUint16(0, 0xfffe, encoding.little); v.setUint16(2, 0xe000, encoding.little); v.setUint32(4, undefinedLength ? 0xffffffff : bytes.length, encoding.little); return concat(header, bytes);
}
export function delimiter(sequence = true, encoding = LE): Uint8Array {
    const out = new Uint8Array(8), v = new DataView(out.buffer); v.setUint16(0, 0xfffe, encoding.little); v.setUint16(2, sequence ? 0xe0dd : 0xe00d, encoding.little); return out;
}
interface FixtureOptions {
    encoding?: Encoding; raw?: boolean; syntax?: string; pixels?: Uint8Array | null; encapsulated?: boolean;
    attributes?: Record<string, readonly [string, string | number | Uint8Array] | null>;
    extra?: Uint8Array[];
}
export function dicomFixture(options: FixtureOptions = {}): Uint8Array {
    const encoding = options.encoding ?? LE;
    const attributes: Record<string, readonly [string, string | number | Uint8Array] | null> = {
        '00080005': ['CS', 'ISO_IR 192'], '00080016': ['UI', '1.2.840.10008.5.1.4.1.1.7'], '00080060': ['CS', 'OT'],
        '00100010': ['PN', 'SYNTHETIC^TEST'], '00100020': ['LO', 'DEMO-NO-PATIENT'],
        '00280002': ['US', 1], '00280004': ['CS', 'MONOCHROME2'], '00280008': ['IS', '1'],
        '00280010': ['US', 2], '00280011': ['US', 2], '00280100': ['US', 8], '00280101': ['US', 8], '00280102': ['US', 7], '00280103': ['US', 0],
        ...options.attributes
    };
    const dataset = concat(...Object.entries(attributes).filter((pair): pair is [string, readonly [string, string | number | Uint8Array]] => pair[1] !== null).sort(([a], [b]) => a.localeCompare(b)).map(([tag, [vr, value]]) => element(tag, vr, value, encoding)),
        ...(options.extra ?? []), ...(options.pixels === null ? [] : [element('7FE00010', 'OW', options.pixels ?? new Uint8Array([0, 64, 128, 255]), encoding, options.encapsulated)]));
    if (options.raw) return dataset;
    const preamble = new Uint8Array(132); preamble.set([68, 73, 67, 77], 128);
    const syntax = options.syntax ?? (encoding.little ? encoding.explicit ? '1.2.840.10008.1.2.1' : '1.2.840.10008.1.2' : '1.2.840.10008.1.2.2');
    const meta = element('00020010', 'UI', syntax);
    return concat(preamble, element('00020000', 'UL', meta.length), meta, dataset);
}
export function words(values: number[], little = true): Uint8Array {
    const out = new Uint8Array(values.length * 2), view = new DataView(out.buffer);
    values.forEach((value, i) => view.setUint16(i * 2, value, little)); return out;
}
