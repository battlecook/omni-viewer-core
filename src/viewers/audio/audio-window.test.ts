import { describe, expect, it } from 'vitest';
import {
    decodeMp3Window,
    planMp3Window,
    readDecodedWindow,
    readWavWindow,
    type DecodedBuffer
} from './audio-window.js';
import { encodeWavFromFloat32 } from './engine.js';
import { parseFrameHeader, readMp3Info } from './mp3-demux.js';
import type { AudioByteSource } from './wav-stream.js';
import type { AudioDataLike, AudioDecoderLike, WebCodecsEnvironment } from './webcodecs-decoder.js';

/** Counts bytes read so a window can be shown not to touch the whole file. */
function source(bytes: Uint8Array): AudioByteSource & { bytesRead: number } {
    const src = {
        byteLength: bytes.byteLength,
        bytesRead: 0,
        async slice(start: number, end: number) {
            src.bytesRead += end - start;
            return bytes.slice(start, end).buffer as ArrayBuffer;
        }
    };
    return src;
}

/** Stereo WAV whose left channel ramps with the frame index. */
function rampWav(frames: number, rate = 8000): Uint8Array {
    const pcm = new Float32Array(frames * 2);
    for (let f = 0; f < frames; f++) {
        pcm[f * 2] = (f % 1000) / 1000;
        pcm[f * 2 + 1] = (f % 1000) / 1000;
    }
    return encodeWavFromFloat32(pcm, 2, rate);
}

describe('wav window', () => {
    it('returns the requested range as mono', async () => {
        const wav = rampWav(5000);
        const window = await readWavWindow(source(wav), 1000, 500);
        expect(window.sampleRate).toBe(8000);
        expect(window.startFrame).toBe(1000);
        expect(window.samples).toHaveLength(500);
        // Both channels carry the same ramp, so the downmix keeps it.
        expect(window.samples[0]).toBeCloseTo(1000 / 1000 % 1, 2);
        expect(window.samples[250]).toBeCloseTo(((1250 % 1000) / 1000), 2);
    });

    // The whole point: a window must not read the file it sits in.
    it('reads only the window plus the header, not the file', async () => {
        const wav = rampWav(500000); // ~2 MiB of samples
        const src = source(wav);
        await readWavWindow(src, 100000, 1000);
        // Header window (64 KiB) twice — readWavHeader plus the inner reader —
        // plus 1000 stereo 16-bit frames.
        expect(src.bytesRead).toBeLessThan(200 * 1024);
        expect(src.bytesRead).toBeLessThan(wav.byteLength / 5);
    });

    it('clamps a range that runs past the end', async () => {
        const wav = rampWav(1000);
        const window = await readWavWindow(source(wav), 900, 500);
        expect(window.startFrame).toBe(900);
        expect(window.samples).toHaveLength(100);
    });

    it('returns nothing for a range beyond the stream', async () => {
        const window = await readWavWindow(source(rampWav(100)), 5000, 100);
        expect(window.samples).toHaveLength(0);
    });

    it('honours an abort signal', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(readWavWindow(source(rampWav(50000)), 0, 10000, { signal: controller.signal }))
            .rejects.toThrow(/aborted/);
    });
});

/** MPEG-1 Layer III 128 kbps 44.1 kHz stereo: 417-byte frames, 1152 samples. */
function mp3Stream(frames: number): Uint8Array {
    const header = [0xff, 0xfb, 0x90, 0x00];
    const length = parseFrameHeader(Uint8Array.from([...header, 0, 0, 0, 0]), 0)!.frameLength;
    const out = new Uint8Array(length * frames);
    for (let i = 0; i < frames; i++) out.set(header, i * length);
    return out;
}

describe('mp3 window planning', () => {
    const bytes = mp3Stream(200);
    const info = readMp3Info(bytes);

    it('selects only the frames covering the range', () => {
        const plan = planMp3Window(bytes, info, 100 * 1152, 5 * 1152);
        // 5 frames of payload, plus the pre-roll ahead of them.
        expect(plan.packets.length).toBeGreaterThanOrEqual(5);
        expect(plan.packets.length).toBeLessThanOrEqual(5 + 13);
        expect(plan.packets.length).toBeLessThan(200);
        expect(plan.start).toBe(100 * 1152);
        expect(plan.count).toBe(5 * 1152);
    });

    // MPEG-1 carries part of a frame's data in preceding frames, so decoding
    // must start earlier or the window opens on garbage.
    it('starts decoding before the requested sample', () => {
        const plan = planMp3Window(bytes, info, 100 * 1152, 1152);
        expect(plan.decodeStart).toBeLessThan(plan.start);
        expect(plan.packets[0]!.offset).toBeLessThan(100 * 417);
    });

    it('needs no pre-roll at the very start', () => {
        const plan = planMp3Window(bytes, info, 0, 1152);
        expect(plan.decodeStart).toBe(0);
    });

    it('clamps a range past the end', () => {
        const plan = planMp3Window(bytes, info, 199 * 1152, 10 * 1152);
        expect(plan.count).toBe(1152);
    });

    it('plans nothing for an empty range', () => {
        expect(planMp3Window(bytes, info, 0, 0).packets).toEqual([]);
    });
});

/** Fake decoder emitting a constant per packet so the skip can be checked. */
function fakeEnvironment(valueFor: (packet: number) => number): WebCodecsEnvironment {
    let packet = 0;
    class FakeDecoder implements AudioDecoderLike {
        decodeQueueSize = 0;
        constructor(private init: { output(data: AudioDataLike): void; error(error: Error): void }) {}
        configure(): void { /* nothing */ }
        decode(): void {
            const value = valueFor(packet++);
            this.init.output({
                numberOfFrames: 1152,
                numberOfChannels: 2,
                format: 'f32-planar',
                allocationSize: () => 1152 * 4,
                copyTo: (destination: ArrayBufferView) => (destination as Float32Array).fill(value, 0, 1152),
                close: () => undefined
            });
        }
        async flush(): Promise<void> { /* synchronous fake */ }
        close(): void { /* nothing */ }
    }
    return {
        AudioDecoder: FakeDecoder as unknown as WebCodecsEnvironment['AudioDecoder'],
        EncodedAudioChunk: class { constructor(public init: unknown) {} } as unknown as WebCodecsEnvironment['EncodedAudioChunk']
    };
}

describe('mp3 window decode', () => {
    it('discards the pre-roll and returns the requested samples', async () => {
        const bytes = mp3Stream(200);
        // Each packet emits its own index, so the value identifies which frame
        // a sample came from.
        const environment = fakeEnvironment((packet) => packet / 100);
        const window = await decodeMp3Window(bytes, 100 * 1152, 2 * 1152, { environment });

        expect(window.startFrame).toBe(100 * 1152);
        expect(window.samples).toHaveLength(2 * 1152);
        // The pre-roll packets are dropped, so the first returned sample is the
        // 13th emitted packet (12 pre-roll frames), not the first.
        expect(window.samples[0]).toBeCloseTo(12 / 100, 6);
    });

    it('returns the head of the stream without skipping', async () => {
        const bytes = mp3Stream(50);
        const window = await decodeMp3Window(bytes, 0, 1152, {
            environment: fakeEnvironment((packet) => packet / 100)
        });
        expect(window.samples[0]).toBeCloseTo(0, 6);
    });

    it('refuses without WebCodecs', async () => {
        await expect(decodeMp3Window(mp3Stream(10), 0, 1152)).rejects.toThrow(/WebCodecs/);
    });

    it('rejects input that is not an mp3', async () => {
        await expect(decodeMp3Window(new Uint8Array(4096), 0, 1152, {
            environment: fakeEnvironment(() => 0.5)
        })).rejects.toThrow(/no MPEG audio frame/);
    });

    it('honours an abort signal', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(decodeMp3Window(mp3Stream(200), 0, 100 * 1152, {
            environment: fakeEnvironment(() => 0.5), signal: controller.signal
        })).rejects.toThrow(/aborted/);
    });
});

/** Stereo WAV whose channels differ, so a downmix cannot be mistaken for one. */
function stereoWav(frames: number, left: number, right: number, rate = 8000): Uint8Array {
    const pcm = new Float32Array(frames * 2);
    for (let f = 0; f < frames; f++) { pcm[f * 2] = left; pcm[f * 2 + 1] = right; }
    return encodeWavFromFloat32(pcm, 2, rate);
}

describe('keeping channels', () => {
    it('leaves channels out unless asked', async () => {
        const window = await readWavWindow(source(stereoWav(2000, 0.5, -0.5)), 0, 500);
        expect(window.channels).toBeUndefined();
    });

    it('returns each wav channel alongside the downmix', async () => {
        const window = await readWavWindow(
            source(stereoWav(2000, 0.5, -0.25)), 100, 500, { keepChannels: true }
        );
        expect(window.channels).toHaveLength(2);
        expect(window.channels![0]).toHaveLength(500);
        expect(window.channels![0]![10]).toBeCloseTo(0.5, 3);
        expect(window.channels![1]![10]).toBeCloseTo(-0.25, 3);
        // The downmix is still the average, so existing callers are unaffected.
        expect(window.samples[10]).toBeCloseTo(0.125, 3);
    });

    it('returns each mp3 channel alongside the downmix', async () => {
        // A fake whose planes differ, so the split cannot pass by accident.
        let packet = 0;
        const environment: WebCodecsEnvironment = {
            AudioDecoder: class {
                decodeQueueSize = 0;
                constructor(private init: { output(data: AudioDataLike): void; error(error: Error): void }) {}
                configure(): void { /* nothing */ }
                decode(): void {
                    packet++;
                    this.init.output({
                        numberOfFrames: 1152,
                        numberOfChannels: 2,
                        format: 'f32-planar',
                        allocationSize: () => 1152 * 4,
                        copyTo: (destination: ArrayBufferView, options: { planeIndex: number }) =>
                            (destination as Float32Array).fill(options.planeIndex === 0 ? 0.8 : -0.4, 0, 1152),
                        close: () => undefined
                    });
                }
                async flush(): Promise<void> { /* synchronous fake */ }
                close(): void { /* nothing */ }
            } as unknown as WebCodecsEnvironment['AudioDecoder'],
            EncodedAudioChunk: class { constructor(public init: unknown) {} } as unknown as WebCodecsEnvironment['EncodedAudioChunk']
        };
        const window = await decodeMp3Window(mp3Stream(200), 50 * 1152, 2 * 1152, {
            environment, keepChannels: true
        });
        expect(packet).toBeGreaterThan(0);
        expect(window.channels).toHaveLength(2);
        expect(window.channels![0]![0]).toBeCloseTo(0.8, 6);
        expect(window.channels![1]![0]).toBeCloseTo(-0.4, 6);
        expect(window.samples[0]).toBeCloseTo(0.2, 6);
    });
});

describe('window from an already-decoded buffer', () => {
    const buffer = (frames: number): DecodedBuffer => ({
        numberOfChannels: 2,
        sampleRate: 44100,
        getChannelData: (channel) => {
            const data = new Float32Array(frames);
            for (let f = 0; f < frames; f++) data[f] = channel === 0 ? f / frames : -(f / frames);
            return data;
        }
    });

    it('slices the requested range out of the decoded audio', () => {
        const window = readDecodedWindow(buffer(1000), 100, 200);
        expect(window?.startFrame).toBe(100);
        expect(window?.sampleRate).toBe(44100);
        expect(window?.samples).toHaveLength(200);
        // Channels cancel, so the downmix of this buffer is silence.
        expect(window!.samples[50]).toBeCloseTo(0, 6);
    });

    it('keeps channels when asked', () => {
        const window = readDecodedWindow(buffer(1000), 0, 10, { keepChannels: true });
        expect(window!.channels![0]![5]).toBeCloseTo(0.005, 6);
        expect(window!.channels![1]![5]).toBeCloseTo(-0.005, 6);
    });

    it('clamps past the end', () => {
        expect(readDecodedWindow(buffer(100), 90, 500)?.samples).toHaveLength(10);
    });

    // Peaks mode hands the engine a buffer with no real samples behind it;
    // using it would paint a spectrogram of nothing.
    it('declines a buffer with no usable channel data', () => {
        expect(readDecodedWindow(undefined, 0, 10)).toBeUndefined();
        expect(readDecodedWindow({ numberOfChannels: 2, sampleRate: 44100 }, 0, 10)).toBeUndefined();
        expect(readDecodedWindow({
            numberOfChannels: 2,
            sampleRate: 44100,
            getChannelData: () => { throw new Error('not decoded'); }
        }, 0, 10)).toBeUndefined();
        expect(readDecodedWindow({
            numberOfChannels: 1, sampleRate: 44100, getChannelData: () => new Float32Array(0)
        }, 0, 10)).toBeUndefined();
    });
});
