import { describe, expect, it, vi } from 'vitest';
import { parseFrameHeader } from './mp3-demux.js';
import {
    decodeMp3,
    isWebCodecsAvailable,
    type AudioDataLike,
    type AudioDecoderLike,
    type WebCodecsEnvironment
} from './webcodecs-decoder.js';

/** A valid MPEG-1 Layer III 128 kbps 44.1 kHz stereo frame with filler body. */
function frame(): Uint8Array {
    const header = [0xff, 0xfb, 0x90, 0x00];
    const parsed = parseFrameHeader(Uint8Array.from([...header, 0, 0, 0, 0]), 0)!;
    const bytes = new Uint8Array(parsed.frameLength);
    bytes.set(header);
    return bytes;
}

function stream(count: number): Uint8Array {
    const one = frame();
    const out = new Uint8Array(one.length * count);
    for (let i = 0; i < count; i++) out.set(one, i * one.length);
    return out;
}

interface FakeState {
    configured: Array<Record<string, unknown>>;
    chunks: Array<{ timestamp: number; duration: number; bytes: number }>;
    closed: number;
    flushed: number;
}

/** Fake WebCodecs that emits one planar AudioData per decode call. */
function fakeEnvironment(options: {
    channels?: number;
    framesPerPacket?: number;
    format?: string;
    failOn?: number;
} = {}): { environment: WebCodecsEnvironment; state: FakeState } {
    const channels = options.channels ?? 2;
    const framesPerPacket = options.framesPerPacket ?? 1152;
    const format = options.format ?? 'f32-planar';
    const state: FakeState = { configured: [], chunks: [], closed: 0, flushed: 0 };

    class FakeChunk {
        constructor(public init: { type: string; timestamp: number; duration: number; data: Uint8Array }) {
            state.chunks.push({
                timestamp: init.timestamp,
                duration: init.duration,
                bytes: init.data.byteLength
            });
        }
    }

    class FakeDecoder implements AudioDecoderLike {
        decodeQueueSize = 0;
        private decoded = 0;
        constructor(private init: { output(data: AudioDataLike): void; error(error: Error): void }) {}
        configure(config: Record<string, unknown>): void { state.configured.push(config); }
        decode(): void {
            this.decoded++;
            if (options.failOn && this.decoded === options.failOn) {
                this.init.error(new Error('fake decoder failure'));
                return;
            }
            // Channel c carries the constant value (c + 1) / 10, so the
            // interleaving can be checked exactly.
            this.init.output({
                numberOfFrames: framesPerPacket,
                numberOfChannels: channels,
                format,
                allocationSize: () => framesPerPacket * 4,
                copyTo(destination: ArrayBufferView, opts: { planeIndex: number }) {
                    const view = destination as Float32Array;
                    if (format === 'f32') {
                        for (let f = 0; f < framesPerPacket; f++) {
                            for (let c = 0; c < channels; c++) view[f * channels + c] = (c + 1) / 10;
                        }
                    } else {
                        view.fill((opts.planeIndex + 1) / 10, 0, framesPerPacket);
                    }
                },
                close: () => undefined
            });
        }
        async flush(): Promise<void> { state.flushed++; }
        close(): void { state.closed++; }
    }

    return {
        state,
        environment: {
            AudioDecoder: FakeDecoder as unknown as WebCodecsEnvironment['AudioDecoder'],
            EncodedAudioChunk: FakeChunk as unknown as WebCodecsEnvironment['EncodedAudioChunk']
        }
    };
}

/** Float32 cannot hold 0.1 exactly, so sample layout is compared elementwise. */
function expectSamples(received: number[], expected: number[]): void {
    expect(received).toHaveLength(expected.length);
    received.forEach((value, index) => expect(value, `sample ${index}`).toBeCloseTo(expected[index]!, 6));
}

describe('webcodecs availability', () => {
    it('reports absence rather than throwing when the globals are missing', () => {
        expect(isWebCodecsAvailable()).toBe(false);
    });

    it('refuses to decode without an environment', async () => {
        await expect(decodeMp3(stream(2), () => undefined)).rejects.toThrow(/not available/);
    });
});

describe('webcodecs mp3 decode', () => {
    it('configures the decoder from the demuxed stream parameters', async () => {
        const { environment, state } = fakeEnvironment();
        await decodeMp3(stream(4), () => undefined, { environment });
        expect(state.configured).toEqual([{ codec: 'mp3', sampleRate: 44100, numberOfChannels: 2 }]);
    });

    it('submits one chunk per frame with monotonic timestamps', async () => {
        const { environment, state } = fakeEnvironment();
        await decodeMp3(stream(5), () => undefined, { environment });
        expect(state.chunks).toHaveLength(5);
        expect(state.chunks.every((chunk) => chunk.bytes === 417)).toBe(true);
        const expected = Math.round(1152 / 44100 * 1e6);
        expect(state.chunks[1]!.timestamp).toBe(expected);
        expect(state.chunks[4]!.timestamp).toBe(expected * 4);
    });

    it('interleaves planar output into the layout the pyramid expects', async () => {
        const { environment } = fakeEnvironment({ channels: 2, framesPerPacket: 3 });
        const received: number[] = [];
        const result = await decodeMp3(stream(1), (interleaved) => received.push(...interleaved), { environment });
        expect(result.frames).toBe(3);
        expectSamples(received, [0.1, 0.2, 0.1, 0.2, 0.1, 0.2]);
    });

    it('passes packed f32 output through unchanged', async () => {
        const { environment } = fakeEnvironment({ channels: 2, framesPerPacket: 3, format: 'f32' });
        const received: number[] = [];
        await decodeMp3(stream(1), (interleaved) => received.push(...interleaved), { environment });
        expectSamples(received, [0.1, 0.2, 0.1, 0.2, 0.1, 0.2]);
    });

    it('handles mono without interleaving artefacts', async () => {
        const { environment } = fakeEnvironment({ channels: 1, framesPerPacket: 4 });
        const received: number[] = [];
        await decodeMp3(stream(1), (interleaved) => received.push(...interleaved), { environment });
        expectSamples(received, [0.1, 0.1, 0.1, 0.1]);
    });

    it('surfaces decoder errors and still closes the decoder', async () => {
        const { environment, state } = fakeEnvironment({ failOn: 2 });
        await expect(decodeMp3(stream(6), () => undefined, { environment })).rejects.toThrow(/fake decoder failure/);
        expect(state.closed).toBe(1);
    });

    it('flushes so trailing packets are not lost', async () => {
        const { environment, state } = fakeEnvironment();
        await decodeMp3(stream(3), () => undefined, { environment });
        expect(state.flushed).toBe(1);
        expect(state.closed).toBe(1);
    });

    it('aborts mid-stream', async () => {
        const { environment } = fakeEnvironment();
        const controller = new AbortController();
        let packets = 0;
        await expect(decodeMp3(stream(50), () => {
            if (++packets === 3) controller.abort();
        }, { environment, signal: controller.signal })).rejects.toThrow(/aborted/);
    });

    // Memory must not scale with file length: the callback receives a reused
    // buffer sized to one packet, never a growing accumulation.
    it('keeps only one packet live regardless of stream length', async () => {
        const { environment } = fakeEnvironment({ framesPerPacket: 1152 });
        let largest = 0;
        const seen = new Set<ArrayBufferLike>();
        await decodeMp3(stream(500), (interleaved) => {
            largest = Math.max(largest, interleaved.byteLength);
            seen.add(interleaved.buffer);
        }, { environment });
        expect(largest).toBe(1152 * 2 * 4);
        expect(seen.size).toBe(1);
    });

    it('applies backpressure when the decode queue grows', async () => {
        const { environment } = fakeEnvironment();
        const decoder = environment.AudioDecoder;
        let peakQueue = 0;
        // Wrap the fake so decodeQueueSize climbs until awaited.
        const throttled = class {
            private inner: AudioDecoderLike;
            decodeQueueSize = 0;
            constructor(init: { output(data: AudioDataLike): void; error(error: Error): void }) {
                this.inner = new (decoder as unknown as new (i: typeof init) => AudioDecoderLike)(init);
            }
            configure(config: never): void { this.inner.configure(config); }
            decode(chunk: unknown): void {
                this.inner.decode(chunk);
                this.decodeQueueSize++;
                peakQueue = Math.max(peakQueue, this.decodeQueueSize);
                setTimeout(() => { this.decodeQueueSize = 0; }, 0);
            }
            flush(): Promise<void> { return this.inner.flush(); }
            close(): void { this.inner.close(); }
        };
        await decodeMp3(stream(200), () => undefined, {
            environment: { ...environment, AudioDecoder: throttled as never },
            maxQueue: 8
        });
        expect(peakQueue).toBeLessThanOrEqual(9);
    });
});

describe('webcodecs isConfigSupported probe', () => {
    it('is optional on the environment', () => {
        const { environment } = fakeEnvironment();
        expect(environment.AudioDecoder.isConfigSupported).toBeUndefined();
        expect(vi.isMockFunction(environment.AudioDecoder)).toBe(false);
    });
});
