import { describe, expect, it } from 'vitest';
import { detectViewer } from './index.js';

describe('automotive viewer detection', () => {
    it.each([
        ['sample.avro', 'avro'], ['sample.bag', 'bag'], ['part.stp', 'stp'], ['part.step', 'stp'],
        ['recording.db3', 'db3'], ['requirements.reqif', 'reqif']
    ])('routes %s to %s', (fileName, viewerId) => {
        expect(detectViewer(fileName).viewerId).toBe(viewerId);
    });

    it.each([
        [Uint8Array.of(0x4f, 0x62, 0x6a, 0x01), 'avro'],
        [new TextEncoder().encode('#ROSBAG V2.0\n'), 'bag'],
        [new TextEncoder().encode('ISO-10303-21;'), 'stp'],
        [new TextEncoder().encode('SQLite format 3\0'), 'db3']
    ])('detects extensionless files by unambiguous magic', (bytes, viewerId) => {
        expect(detectViewer('unnamed', undefined, undefined, bytes)).toEqual({ viewerId, matchedBy: 'content' });
    });

    it('reroutes contradictory extensions using unambiguous magic', () => {
        expect(detectViewer('wrong.avro', undefined, undefined, new TextEncoder().encode('SQLite format 3\0'))).toEqual({ viewerId: 'db3', matchedBy: 'content' });
        expect(detectViewer('wrong.db3', undefined, undefined, Uint8Array.of(0x4f, 0x62, 0x6a, 0x01))).toEqual({ viewerId: 'avro', matchedBy: 'content' });
    });
});
