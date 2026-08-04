// MPEG audio frame walker.
//
// WebCodecs' AudioDecoder consumes already-separated encoded chunks: it does
// not parse containers. For mp3 that separation is just walking frame headers,
// which is what this does — no decoding, no packages.
//
// Pure and synchronous so the frame layout can be tested without a browser;
// the AudioDecoder wrapper that consumes it lives in webcodecs-decoder.ts.

export interface Mp3Frame {
    /** Byte offset of the frame header. */
    offset: number;
    /** Total frame length in bytes, header included. */
    length: number;
    /** PCM frames this MPEG frame decodes to. */
    samples: number;
}

export interface Mp3Info {
    sampleRate: number;
    channels: number;
    /** 1, 2 or 2.5 — MPEG-1 uses 1152-sample frames, the others 576. */
    mpegVersion: 1 | 2 | 2.5;
    layer: 1 | 2 | 3;
    /** Offset of the first audio frame, past any ID3v2 tag. */
    firstFrameOffset: number;
}

const SAMPLE_RATES: Record<string, readonly number[]> = {
    '1': [44100, 48000, 32000],
    '2': [22050, 24000, 16000],
    '2.5': [11025, 12000, 8000]
};

// Layer III bitrates in kbps; index 0 is "free" and 15 is invalid.
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const BITRATES_V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0];
const BITRATES_V1_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0];

/** Bytes of an ID3v2 tag at `offset`, or 0 when there is none. */
export function id3v2Length(bytes: Uint8Array, offset = 0): number {
    if (offset + 10 > bytes.length) return 0;
    if (bytes[offset] !== 0x49 || bytes[offset + 1] !== 0x44 || bytes[offset + 2] !== 0x33) return 0; // 'ID3'
    // Synchsafe integer: 7 bits per byte.
    const size = ((bytes[offset + 6]! & 0x7f) << 21)
        | ((bytes[offset + 7]! & 0x7f) << 14)
        | ((bytes[offset + 8]! & 0x7f) << 7)
        | (bytes[offset + 9]! & 0x7f);
    const footer = (bytes[offset + 5]! & 0x10) ? 10 : 0;
    return 10 + size + footer;
}

interface ParsedHeader extends Mp3Info { frameLength: number; samples: number }

/** Parses a 4-byte frame header, or returns undefined when `offset` is not a
 *  valid frame start. Callers use that to resynchronize. */
export function parseFrameHeader(bytes: Uint8Array, offset: number): ParsedHeader | undefined {
    if (offset + 4 > bytes.length) return undefined;
    const b0 = bytes[offset]!, b1 = bytes[offset + 1]!, b2 = bytes[offset + 2]!, b3 = bytes[offset + 3]!;
    // 11 sync bits.
    if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return undefined;

    const versionBits = (b1 >> 3) & 0x03;
    if (versionBits === 1) return undefined; // reserved
    const mpegVersion = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;

    const layerBits = (b1 >> 1) & 0x03;
    if (layerBits === 0) return undefined; // reserved
    const layer = (4 - layerBits) as 1 | 2 | 3;

    const bitrateIndex = (b2 >> 4) & 0x0f;
    const rateIndex = (b2 >> 2) & 0x03;
    if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return undefined;

    const table = mpegVersion === 1
        ? (layer === 3 ? BITRATES_V1_L3 : layer === 2 ? BITRATES_V1_L2 : BITRATES_V1_L1)
        : BITRATES_V2_L3;
    const bitrate = table[bitrateIndex]! * 1000;
    if (!bitrate) return undefined;

    const sampleRate = SAMPLE_RATES[String(mpegVersion)]![rateIndex]!;
    const padding = (b2 >> 1) & 0x01;
    const channels = ((b3 >> 6) & 0x03) === 3 ? 1 : 2;

    // Layer I is measured in 4-byte slots; II and III in bytes.
    const samples = layer === 1 ? 384 : layer === 2 ? 1152 : (mpegVersion === 1 ? 1152 : 576);
    const frameLength = layer === 1
        ? (Math.floor(12 * bitrate / sampleRate) + padding) * 4
        : Math.floor((samples / 8) * bitrate / sampleRate) + padding;
    if (frameLength <= 4) return undefined;

    return { sampleRate, channels, mpegVersion, layer, firstFrameOffset: offset, frameLength, samples };
}

/** Xing/Info/VBRI headers occupy an otherwise silent frame that only carries
 *  VBR metadata. Feeding it to a decoder is harmless but adds phantom samples
 *  at the start, so it is skipped. */
function isMetadataFrame(bytes: Uint8Array, frame: ParsedHeader): boolean {
    const end = Math.min(frame.firstFrameOffset + frame.frameLength, bytes.length);
    for (let at = frame.firstFrameOffset + 4; at + 4 <= end; at++) {
        const tag = String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
        if (tag === 'Xing' || tag === 'Info' || tag === 'VBRI') return true;
    }
    return false;
}

/**
 * Locates the first audio frame and reports the stream parameters.
 * Scans past ID3v2 and any leading garbage, requiring two consecutive valid
 * headers so a random 0xFF byte cannot be mistaken for a frame start.
 */
export function readMp3Info(bytes: Uint8Array): Mp3Info {
    const start = id3v2Length(bytes);
    const limit = Math.min(bytes.length, start + 512 * 1024);
    for (let at = start; at < limit; at++) {
        const header = parseFrameHeader(bytes, at);
        if (!header) continue;
        const next = parseFrameHeader(bytes, at + header.frameLength);
        // A final frame at EOF has no successor, which is still valid.
        if (!next && at + header.frameLength < bytes.length - 4) continue;
        return {
            sampleRate: header.sampleRate,
            channels: header.channels,
            mpegVersion: header.mpegVersion,
            layer: header.layer,
            firstFrameOffset: at
        };
    }
    throw new Error('mp3: no MPEG audio frame found');
}

/**
 * Walks frames from `firstFrameOffset`. Yields descriptors rather than copies
 * so nothing is duplicated until a consumer slices a chunk for the decoder.
 * Resynchronizes over damaged regions instead of aborting.
 */
export function* iterateMp3Frames(bytes: Uint8Array, info: Mp3Info): Generator<Mp3Frame> {
    let at = info.firstFrameOffset;
    let skippedMetadata = false;
    while (at + 4 <= bytes.length) {
        const header = parseFrameHeader(bytes, at);
        if (!header) {
            at++; // resync
            continue;
        }
        if (at + header.frameLength > bytes.length) break; // truncated tail
        if (!skippedMetadata) {
            skippedMetadata = true;
            if (isMetadataFrame(bytes, header)) {
                at += header.frameLength;
                continue;
            }
        }
        yield { offset: at, length: header.frameLength, samples: header.samples };
        at += header.frameLength;
    }
}

/** Total decoded frames, by walking headers only — no decoding. */
export function countMp3Samples(bytes: Uint8Array, info: Mp3Info): number {
    let total = 0;
    for (const frame of iterateMp3Frames(bytes, info)) total += frame.samples;
    return total;
}
