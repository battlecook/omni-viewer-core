import { describe, expect, it } from 'vitest';
import { analyzeMp3Source } from './mp3-analyzer.js';
import { parseFrameHeader } from './mp3-demux.js';
import type { AudioDataLike, AudioDecoderLike, WebCodecsEnvironment } from './webcodecs-decoder.js';

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz stereo frames with filler bodies. */
function stream(frames: number): Uint8Array {
    const header = [0xff, 0xfb, 0x90, 0x00];
    const length = parseFrameHeader(Uint8Array.from([...header, 0, 0, 0, 0]), 0)!.frameLength;
    const out = new Uint8Array(length * frames);
    for (let i = 0; i < frames; i++) out.set(header, i * length);
    return out;
}

/** Fake decoder emitting planar packets whose amplitude the test controls. */
function fakeEnvironment(options: {
    channels?: number;
    framesPerPacket?: number;
    amplitude?: (packet: number, channel: number) => number;
} = {}): WebCodecsEnvironment {
    const channels = options.channels ?? 2;
    const framesPerPacket = options.framesPerPacket ?? 1152;
    const amplitude = options.amplitude ?? (() => 0.5);
    let packet = 0;

    class FakeDecoder implements AudioDecoderLike {
        decodeQueueSize = 0;
        constructor(private init: { output(data: AudioDataLike): void; error(error: Error): void }) {}
        configure(): void { /* nothing to set up */ }
        decode(): void {
            const index = packet++;
            this.init.output({
                numberOfFrames: framesPerPacket,
                numberOfChannels: channels,
                format: 'f32-planar',
                allocationSize: () => framesPerPacket * 4,
                copyTo(destination: ArrayBufferView, opts: { planeIndex: number }) {
                    const view = destination as Float32Array;
                    const value = amplitude(index, opts.planeIndex);
                    // Alternate sign so min and max are both meaningful.
                    for (let f = 0; f < framesPerPacket; f++) view[f] = f % 2 ? value : -value;
                },
                close: () => undefined
            });
        }
        async flush(): Promise<void> { /* synchronous fake */ }
        close(): void { /* nothing to release */ }
    }

    return {
        AudioDecoder: FakeDecoder as unknown as WebCodecsEnvironment['AudioDecoder'],
        EncodedAudioChunk: class { constructor(public init: unknown) {} } as unknown as WebCodecsEnvironment['EncodedAudioChunk']
    };
}

describe('mp3 analyzer', () => {
    it('reports rate, channels and duration from the stream', async () => {
        const environment = fakeEnvironment();
        // 38 frames x 1152 samples ≈ 1 second at 44.1 kHz.
        const analysis = await analyzeMp3Source(stream(38), 50, { environment });
        expect(analysis.sampleRate).toBe(44100);
        expect(analysis.channels).toBe(2);
        expect(analysis.duration).toBeCloseTo(38 * 1152 / 44100, 6);
    });

    // The whole point of routing mp3 here: the engine collapses channels and
    // cannot handle the format at all.
    it('keeps channels separate', async () => {
        const environment = fakeEnvironment({
            amplitude: (_packet, channel) => (channel === 0 ? 0.9 : 0.2)
        });
        const analysis = await analyzeMp3Source(stream(40), 25, { environment });
        expect(analysis.channelPeaks).toHaveLength(2);
        for (const value of analysis.channelPeaks[0]!) expect(value).toBeCloseTo(0.9, 2);
        for (const value of analysis.channelPeaks[1]!) expect(value).toBeCloseTo(0.2, 2);
    });

    it('locates a loud passage at the right column', async () => {
        const environment = fakeEnvironment({
            amplitude: (packet) => (packet >= 40 && packet < 60 ? 0.9 : 0.05)
        });
        const analysis = await analyzeMp3Source(stream(100), 100, { environment });
        const columns = analysis.channelPeaks[0]!;
        expect(Math.max(...columns.slice(0, 35))).toBeCloseTo(0.05, 2);
        expect(Math.max(...columns.slice(42, 58))).toBeCloseTo(0.9, 2);
        expect(Math.max(...columns.slice(65))).toBeCloseTo(0.05, 2);
    });

    it('produces the requested number of columns', async () => {
        const environment = fakeEnvironment();
        for (const columns of [1, 13, 512]) {
            const analysis = await analyzeMp3Source(stream(60), columns, { environment });
            expect(analysis.channelPeaks[0], `columns=${columns}`).toHaveLength(columns);
        }
    });

    // Constant memory is the property that removes the length ceiling.
    it('holds a pyramid far smaller than the audio it summarizes', async () => {
        const environment = fakeEnvironment();
        const frames = 2000; // ~52 s
        const analysis = await analyzeMp3Source(stream(frames), 1000, { environment });
        const pcmBytes = frames * 1152 * 2 * 4;
        expect(analysis.pyramidByteLength).toBeLessThan(pcmBytes / 50);
    });

    it('refuses without WebCodecs so the caller can fall back', async () => {
        await expect(analyzeMp3Source(stream(10), 10)).rejects.toThrow(/WebCodecs/);
    });

    it('rejects input that is not an mp3', async () => {
        await expect(analyzeMp3Source(new Uint8Array(4096), 10, { environment: fakeEnvironment() }))
            .rejects.toThrow(/no MPEG audio frame/);
    });

    it('honours an abort signal', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(analyzeMp3Source(stream(200), 10, {
            environment: fakeEnvironment(), signal: controller.signal
        })).rejects.toThrow(/aborted/);
    });
});
