// Deterministic, entirely synthetic DICOM Part 10 image. Contains no real patient data.
import { mkdir, writeFile } from 'node:fs/promises';
const output = new URL('../examples/dicom/', import.meta.url);
const concat = (...parts) => Buffer.concat(parts.map(p => Buffer.from(p)));
function element(tag, vr, value) {
    let data;
    if (typeof value === 'number') { data = Buffer.alloc(2); data.writeUInt16LE(value); }
    else if (typeof value === 'string') { data = Buffer.from(value); if (data.length % 2) data = concat(data, [vr === 'UI' ? 0 : 32]); }
    else data = Buffer.from(value);
    const long = ['OB', 'OW', 'SQ'].includes(vr), header = Buffer.alloc(long ? 12 : 8);
    header.writeUInt16LE(parseInt(tag.slice(0, 4), 16)); header.writeUInt16LE(parseInt(tag.slice(4), 16), 2); header.write(vr, 4);
    if (long) header.writeUInt32LE(data.length, 8); else header.writeUInt16LE(data.length, 6);
    return concat(header, data);
}
const rows = 128, columns = 128, frames = 3, pixels = Buffer.alloc(rows * columns * frames * 2);
for (let f = 0; f < frames; f++) for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const radius = Math.hypot((x - 63.5) / 1, (y - 63.5) / 1.15);
    const hu = radius > 48 ? -1000 : radius > 43 ? 900 : Math.hypot(x - 50 - f * 9, y - 54) < 12 ? -600 : Math.hypot(x - 74, y - 72 + f * 8) < 11 ? 400 : 40 + Math.round((x + y) / 8);
    pixels.writeInt16LE(hu, ((f * rows + y) * columns + x) * 2);
}
const sopClass = '1.2.840.10008.5.1.4.1.1.2', sopInstance = '2.25.100000000000000000000000000000000001';
const meta = concat(element('00020001', 'OB', [0, 1]), element('00020002', 'UI', sopClass), element('00020003', 'UI', sopInstance), element('00020010', 'UI', '1.2.840.10008.1.2.1'), element('00020012', 'UI', '2.25.100000000000000000000000000000000002'));
const length = Buffer.alloc(4); length.writeUInt32LE(meta.length);
const metaHeader = Buffer.from([2, 0, 0, 0, 85, 76, 4, 0]);
const preamble = Buffer.alloc(132); preamble.write('DICM', 128);
const attrs = [
 ['00080005', 'CS', 'ISO_IR 192'], ['00080008', 'CS', 'DERIVED\\SECONDARY'], ['00080016', 'UI', sopClass], ['00080018', 'UI', sopInstance], ['00080020', 'DA', '20000101'], ['00080060', 'CS', 'CT'], ['0008103E', 'LO', 'Synthetic phantom - no patient data'],
 ['00100010', 'PN', 'SYNTHETIC^PHANTOM'], ['00100020', 'LO', 'DEMO-NO-PATIENT'], ['00180050', 'DS', '1'],
 ['0020000D', 'UI', '2.25.100000000000000000000000000000000003'], ['0020000E', 'UI', '2.25.100000000000000000000000000000000004'], ['00200011', 'IS', '1'], ['00200013', 'IS', '1'],
 ['00280002', 'US', 1], ['00280004', 'CS', 'MONOCHROME2'], ['00280008', 'IS', String(frames)], ['00280010', 'US', rows], ['00280011', 'US', columns], ['00280030', 'DS', '1\\1'],
 ['00280100', 'US', 16], ['00280101', 'US', 16], ['00280102', 'US', 15], ['00280103', 'US', 1], ['00281050', 'DS', '40'], ['00281051', 'DS', '400'], ['00281052', 'DS', '0'], ['00281053', 'DS', '1'], ['00281054', 'LO', 'HU']
];
await mkdir(output, { recursive: true });
await writeFile(new URL('synthetic-phantom.dcm', output), concat(preamble, metaHeader, length, meta, ...attrs.map(a => element(...a)), element('7FE00010', 'OW', pixels)));
console.log('examples/dicom/synthetic-phantom.dcm written (synthetic data only)');
