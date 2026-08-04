import { describe, expect, it } from 'vitest';
import {
    countMp3Samples,
    id3v2Length,
    iterateMp3Frames,
    parseFrameHeader,
    readMp3Info
} from './mp3-demux.js';

interface FrameSpec {
    version?: 1 | 2 | 2.5;
    layer?: 1 | 2 | 3;
    bitrateIndex?: number;
    rateIndex?: number;
    padding?: 0 | 1;
    mono?: boolean;
}

/** Builds a syntactically valid MPEG frame header plus filler body, so frame
 *  layout can be tested without shipping binary fixtures. */
function frame(spec: FrameSpec = {}): Uint8Array {
    const { version = 1, layer = 3, bitrateIndex = 9, rateIndex = 0, padding = 0, mono = false } = spec;
    const versionBits = version === 1 ? 3 : version === 2 ? 2 : 0;
    const layerBits = 4 - layer;
    const header = [
        0xff,
        0xe0 | (versionBits << 3) | (layerBits << 1) | 1,
        (bitrateIndex << 4) | (rateIndex << 2) | (padding << 1),
        (mono ? 3 : 0) << 6
    ];
    const parsed = parseFrameHeader(Uint8Array.from([...header, 0, 0, 0, 0]), 0);
    if (!parsed) throw new Error('test frame spec is not a valid header');
    const bytes = new Uint8Array(parsed.frameLength);
    bytes.set(header);
    return bytes;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
};

describe('mp3 frame header', () => {
    it('derives rate, channels and length for MPEG-1 Layer III 128kbps 44.1k', () => {
        const header = parseFrameHeader(frame(), 0)!;
        expect(header.mpegVersion).toBe(1);
        expect(header.layer).toBe(3);
        expect(header.sampleRate).toBe(44100);
        expect(header.channels).toBe(2);
        expect(header.samples).toBe(1152);
        // floor(144 * 128000 / 44100) = 417
        expect(header.frameLength).toBe(417);
    });

    it('adds the padding byte when the padding bit is set', () => {
        expect(parseFrameHeader(frame({ padding: 1 }), 0)!.frameLength).toBe(418);
    });

    it('uses 576-sample frames for MPEG-2', () => {
        const header = parseFrameHeader(frame({ version: 2, rateIndex: 0, bitrateIndex: 9 }), 0)!;
        expect(header.mpegVersion).toBe(2);
        expect(header.sampleRate).toBe(22050);
        expect(header.samples).toBe(576);
    });

    it('reads mono from the channel mode', () => {
        expect(parseFrameHeader(frame({ mono: true }), 0)!.channels).toBe(1);
    });

    it('rejects reserved and invalid encodings', () => {
        expect(parseFrameHeader(Uint8Array.of(0xff, 0xea, 0x90, 0x00), 0)).toBeUndefined(); // reserved version
        expect(parseFrameHeader(Uint8Array.of(0xff, 0xf9, 0x90, 0x00), 0)).toBeUndefined(); // reserved layer
        expect(parseFrameHeader(Uint8Array.of(0xff, 0xfb, 0x00, 0x00), 0)).toBeUndefined(); // free bitrate
        expect(parseFrameHeader(Uint8Array.of(0xff, 0xfb, 0xf0, 0x00), 0)).toBeUndefined(); // bad bitrate
        expect(parseFrameHeader(Uint8Array.of(0xff, 0xfb, 0x9c, 0x00), 0)).toBeUndefined(); // reserved rate
        expect(parseFrameHeader(Uint8Array.of(0x00, 0x00, 0x00, 0x00), 0)).toBeUndefined(); // no sync
    });
});

describe('id3v2', () => {
    it('measures a tag using synchsafe sizes', () => {
        const tag = new Uint8Array(10 + 200);
        tag.set([0x49, 0x44, 0x33, 4, 0, 0]);
        tag[9] = 0x48; // 0x48 = 72 -> ... synchsafe low byte
        tag[8] = 0x01; // + 1<<7 = 128 -> 200
        expect(id3v2Length(tag)).toBe(10 + 200);
    });

    it('counts the optional footer', () => {
        const tag = new Uint8Array(30);
        tag.set([0x49, 0x44, 0x33, 4, 0, 0x10]);
        tag[9] = 10;
        expect(id3v2Length(tag)).toBe(10 + 10 + 10);
    });

    it('returns 0 without a tag', () => {
        expect(id3v2Length(frame())).toBe(0);
    });
});

describe('mp3 frame walking', () => {
    it('finds the first frame after an ID3v2 tag', () => {
        const tag = new Uint8Array(10 + 50);
        tag.set([0x49, 0x44, 0x33, 4, 0, 0]);
        tag[9] = 50;
        const bytes = concat(tag, frame(), frame(), frame());
        const info = readMp3Info(bytes);
        expect(info.firstFrameOffset).toBe(60);
        expect(info.sampleRate).toBe(44100);
        expect([...iterateMp3Frames(bytes, info)]).toHaveLength(3);
    });

    it('requires two consecutive headers so stray 0xFF bytes do not match', () => {
        // A lone byte pair that looks like sync, followed by real frames.
        const decoy = Uint8Array.of(0xff, 0xfb, 0x90, 0x00, 0x11, 0x22);
        const bytes = concat(decoy, frame(), frame());
        const info = readMp3Info(bytes);
        expect(info.firstFrameOffset).toBe(decoy.length);
        expect([...iterateMp3Frames(bytes, info)]).toHaveLength(2);
    });

    it('skips a leading Xing metadata frame', () => {
        const xing = frame();
        xing.set([0x58, 0x69, 0x6e, 0x67], 36); // 'Xing'
        const bytes = concat(xing, frame(), frame());
        const info = readMp3Info(bytes);
        const frames = [...iterateMp3Frames(bytes, info)];
        expect(frames).toHaveLength(2);
        expect(frames[0]!.offset).toBe(xing.length);
    });

    it('keeps a normal first frame', () => {
        const bytes = concat(frame(), frame());
        expect([...iterateMp3Frames(bytes, readMp3Info(bytes))]).toHaveLength(2);
    });

    it('resynchronizes over a damaged region mid-stream instead of stopping', () => {
        const bytes = concat(frame(), frame(), new Uint8Array(37).fill(0x5a), frame());
        const info = readMp3Info(bytes);
        const frames = [...iterateMp3Frames(bytes, info)];
        expect(frames).toHaveLength(3);
        expect(frames[2]!.offset).toBe(417 * 2 + 37);
    });

    // The two-consecutive-headers rule that rejects stray 0xFF bytes also
    // rejects a real first frame whose successor is damaged. Losing one frame
    // (26 ms) beats locking onto noise and misreporting the sample rate.
    it('starts after the damage when the very first frame has no valid successor', () => {
        const bytes = concat(frame(), new Uint8Array(37).fill(0x5a), frame(), frame());
        expect(readMp3Info(bytes).firstFrameOffset).toBe(417 + 37);
    });

    it('drops a truncated trailing frame rather than reading past the end', () => {
        const full = concat(frame(), frame());
        const truncated = full.subarray(0, full.length - 100);
        const frames = [...iterateMp3Frames(truncated, readMp3Info(truncated))];
        expect(frames).toHaveLength(1);
    });

    it('counts decoded samples from headers alone', () => {
        const bytes = concat(frame(), frame(), frame(), frame());
        expect(countMp3Samples(bytes, readMp3Info(bytes))).toBe(4 * 1152);
    });

    it('throws when there is no frame at all', () => {
        expect(() => readMp3Info(new Uint8Array(1000))).toThrow(/no MPEG audio frame/);
    });
});
