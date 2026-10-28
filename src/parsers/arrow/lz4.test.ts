import { describe, expect, it } from 'vitest';
import * as lz4 from 'lz4js';
import { hash } from 'lz4js/xxh32.js';
import { decodeLz4Frame } from './lz4.js';
import { loadArrowDeps } from './self-loading.js';

function frame(blocks: Uint8Array[], flags = 0x70, contents?: Uint8Array): Uint8Array {
    const header = new Uint8Array(7 + ((flags & 8) ? 8 : 0));
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x184d2204, true); header[4] = flags; header[5] = 0x40;
    if (flags & 8) view.setBigUint64(6, BigInt(contents!.length), true);
    header[header.length - 1] = (hash(0, header, 4, header.length - 5) >>> 8) & 255;
    const parts: Uint8Array[] = [header];
    for (const block of blocks) {
        const size = new Uint8Array(4); new DataView(size.buffer).setUint32(0, 0x80000000 | block.length, true);
        parts.push(size, block);
        if (flags & 0x10) { const checksum = new Uint8Array(4); new DataView(checksum.buffer).setUint32(0, hash(0, block, 0, block.length), true); parts.push(checksum); }
    }
    parts.push(new Uint8Array(4));
    if (flags & 4) { const checksum = new Uint8Array(4); new DataView(checksum.buffer).setUint32(0, hash(0, contents!, 0, contents!.length), true); parts.push(checksum); }
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; }
    return output;
}
const decode = (input: Uint8Array, length: number) => decodeLz4Frame(input, length, lz4, hash);

describe('bounded LZ4 framing', () => {
    it('reads block checksums after the payload instead of treating them as data', async () => {
        const content = new Uint8Array([1, 2, 3, 4]);
        const encoded = frame([content]);
        const deps = await loadArrowDeps();
        expect(deps.decompressLz4!(encoded, content.length)).toEqual(content);
    });
    it('checks content size, block checksums and content checksum across multiple blocks', () => {
        const content = new Uint8Array([1, 2, 3, 4]);
        const encoded = frame([content.subarray(0, 2), content.subarray(2)], 0x7c, content);
        expect(decode(encoded, 4)).toEqual(content);
        for (const offset of [encoded.length - 1, 21]) {
            const broken = encoded.slice(); broken[offset] = broken[offset]! ^ 1;
            expect(() => decode(broken, 4)).toThrow();
        }
    });
    it('reads compressed blocks and concatenated frames', () => {
        const content = new TextEncoder().encode('repeating content '.repeat(1000));
        const compressed = lz4.compress(content);
        expect(decode(compressed, content.length)).toEqual(content);
        const tail = new Uint8Array([1, 2]), encodedTail = frame([tail]);
        const encoded = new Uint8Array(compressed.length + encodedTail.length); encoded.set(compressed); encoded.set(encodedTail, compressed.length);
        const expected = new Uint8Array(content.length + tail.length); expected.set(content); expected.set(tail, content.length);
        expect(decode(encoded, expected.length)).toEqual(expected);
    });
    it('rejects truncated, oversized, invalid-checksum and malformed-match frames', () => {
        const content = new Uint8Array([1, 2, 3, 4]), encoded = frame([content]);
        expect(() => decode(encoded, 3)).toThrow(); expect(() => decode(encoded, 5)).toThrow();
        for (let length = 0; length < encoded.length; length++) expect(() => decode(encoded.subarray(0, length), 4)).toThrow();
        const badHeader = encoded.slice(); badHeader[6] = badHeader[6]! ^ 1;
        expect(() => decode(badHeader, 4)).toThrow();
        const invalidMatch = frame([new Uint8Array([0, 0, 0])], 0x60);
        new DataView(invalidMatch.buffer).setUint32(7, 3, true);
        expect(() => decode(invalidMatch, 4)).toThrow();
    });
});
