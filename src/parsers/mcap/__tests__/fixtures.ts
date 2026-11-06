export const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
export function concat(...parts: Uint8Array[]): Uint8Array {
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let position = 0; for (const part of parts) { bytes.set(part, position); position += part.length; }
    return bytes;
}
export function u16(value: number): Uint8Array { const data = new Uint8Array(2); new DataView(data.buffer).setUint16(0, value, true); return data; }
export function u32(value: number): Uint8Array { const data = new Uint8Array(4); new DataView(data.buffer).setUint32(0, value, true); return data; }
export function u64(value: bigint | number): Uint8Array { const data = new Uint8Array(8); new DataView(data.buffer).setBigUint64(0, BigInt(value), true); return data; }
export const str = (value: string): Uint8Array => concat(u32(encode(value).length), encode(value));
export const map = (entries: Array<[string, string]>): Uint8Array => { const body = concat(...entries.map(([key, value]) => concat(str(key), str(value)))); return concat(u32(body.length), body); };
export const record = (opcode: number, body: Uint8Array): Uint8Array => concat(Uint8Array.of(opcode), u64(body.length), body);
export const magic = Uint8Array.of(0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a);
export const time = 1700000000000000123n;
export const header = record(1, concat(str(''), str('omni-viewer fixture')));
export const schema = record(3, concat(u16(1), str('Telemetry'), str('jsonschema'), str('{"type":"object"}')));
export const channel = (id = 1, topic = '/telemetry', encoding = 'json'): Uint8Array => record(4, concat(u16(id), u16(1), str(topic), str(encoding), map([['source', 'robot']])));
export const message = (sequence = 1, channelId = 1, body = '{"speed":42}'): Uint8Array => record(5, concat(u16(channelId), u32(sequence), u64(time + BigInt(sequence - 1)), u64(time), encode(body)));
export const metadata = record(12, concat(str('session'), map([['robot', 'alpha'], ['__proto__', 'safe']])));
export const attachment = record(9, concat(u64(time), u64(0), str('calibration.txt'), str('text/plain'), u64(3), encode('abc'), u32(0)));
export const statistics = (count = 2n): Uint8Array => record(11, concat(u64(count), u16(1), u32(1), u32(0), u32(0), u32(1), u64(time), u64(time + 1n), u32(10), u16(1), u64(count)));
export function file(records: Uint8Array[] = [schema, channel(), message()], summary: Uint8Array[] = []): Uint8Array {
    const data = concat(magic, header, ...records, record(15, u32(0)));
    return concat(data, ...summary, record(2, concat(u64(summary.length ? data.length : 0), u64(0), u32(0))), magic);
}
export function chunk(records: Uint8Array, compression = '', compressed = records, expected = records.length, crc = 0): Uint8Array {
    return record(6, concat(u64(time), u64(time + 1n), u64(expected), u32(crc), str(compression), u64(compressed.length), compressed));
}
/** Valid Zstandard frame with one uncompressed block, decoded by the real fzstd peer. */
export function zstdRaw(bytes: Uint8Array): Uint8Array {
    const block = (bytes.length << 3) | 1;
    return concat(Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0xa0), u32(bytes.length), Uint8Array.of(block & 255, (block >>> 8) & 255, (block >>> 16) & 255), bytes);
}
export function crc(bytes: Uint8Array): number {
    let value = 0xffffffff;
    for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0;
}
