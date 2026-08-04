// Streaming WAV reader over a random-access byte source.
//
// WAV needs no decoder — the samples are in the file — which makes it the one
// format that can exercise the streaming/pyramid path with no dependency on
// the WASM engine or WebCodecs. `parsers/audio/index.ts` already parses a WAV
// header, but from a whole `Uint8Array`; this reads the same chunk layout
// through range reads so a multi-hundred-megabyte file is never materialized.
//
// The source shape matches the random-access inputs already promoted to
// contract for parquet and safetensors (DESIGN.md §3-①).

/** Random-access byte source, same shape as `ParquetSource`. */
export interface AudioByteSource {
    byteLength: number;
    slice(start: number, end: number): Promise<ArrayBuffer>;
}

export interface WavStreamInfo {
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
    /** True for IEEE float samples (format tag 3). */
    float: boolean;
    frames: number;
    dataOffset: number;
    dataLength: number;
}

/** Header search window. Real headers are far smaller, but LIST/INFO metadata
 *  can push `data` back a few KiB. */
const HEADER_WINDOW = 64 * 1024;
const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

const ascii = (view: DataView, offset: number, length: number): string => {
    let text = '';
    for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint8(offset + i));
    return text;
};

export async function readWavHeader(source: AudioByteSource): Promise<WavStreamInfo> {
    const window = Math.min(HEADER_WINDOW, source.byteLength);
    if (window < 12) throw new Error('wav: file is too short to contain a RIFF header');
    const view = new DataView(await source.slice(0, window));
    if (ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'WAVE') {
        throw new Error('wav: missing RIFF/WAVE header');
    }

    let channels = 0;
    let sampleRate = 0;
    let bitsPerSample = 0;
    let format = 0;
    let offset = 12;
    while (offset + 8 <= view.byteLength) {
        const id = ascii(view, offset, 4);
        const size = view.getUint32(offset + 4, true);
        const body = offset + 8;
        if (id === 'fmt ') {
            if (size < 16) throw new Error('wav: fmt chunk is shorter than 16 bytes');
            format = view.getUint16(body, true);
            channels = view.getUint16(body + 2, true);
            sampleRate = view.getUint32(body + 4, true);
            bitsPerSample = view.getUint16(body + 14, true);
            if (format === FORMAT_EXTENSIBLE && size >= 40) {
                // WAVE_FORMAT_EXTENSIBLE keeps the real tag in the GUID's first
                // two bytes; the rest of the GUID is a fixed suffix.
                format = view.getUint16(body + 24, true);
            }
        } else if (id === 'data') {
            if (!channels || !bitsPerSample) throw new Error('wav: data chunk precedes fmt chunk');
            // A streamed writer may leave size 0 or 0xFFFFFFFF; trust the file.
            const declared = size === 0 || body + size > source.byteLength
                ? source.byteLength - body
                : size;
            const bytesPerFrame = channels * (bitsPerSample / 8);
            if (bytesPerFrame <= 0) throw new Error('wav: invalid frame size');
            if (format !== FORMAT_PCM && format !== FORMAT_FLOAT) {
                throw new Error(`wav: unsupported format tag ${format} (only PCM and IEEE float)`);
            }
            if (![8, 16, 24, 32].includes(bitsPerSample)) {
                throw new Error(`wav: unsupported bit depth ${bitsPerSample}`);
            }
            return {
                channels,
                sampleRate,
                bitsPerSample,
                float: format === FORMAT_FLOAT,
                frames: Math.floor(declared / bytesPerFrame),
                dataOffset: body,
                dataLength: declared
            };
        }
        // RIFF pads chunks to an even boundary, and the pad byte is not counted.
        offset = body + size + (size & 1);
    }
    throw new Error('wav: no data chunk found in the header window');
}

/** Converts one raw block to interleaved float32 in `out`, returning the
 *  number of samples written. */
function toFloat32(raw: DataView, info: WavStreamInfo, out: Float32Array): number {
    const bytes = info.bitsPerSample / 8;
    const samples = Math.floor(raw.byteLength / bytes);
    if (info.float) {
        for (let i = 0; i < samples; i++) out[i] = raw.getFloat32(i * 4, true);
        return samples;
    }
    switch (info.bitsPerSample) {
        case 8: // unsigned
            for (let i = 0; i < samples; i++) out[i] = (raw.getUint8(i) - 128) / 128;
            return samples;
        case 16:
            for (let i = 0; i < samples; i++) out[i] = raw.getInt16(i * 2, true) / 32768;
            return samples;
        case 24:
            for (let i = 0; i < samples; i++) {
                const at = i * 3;
                const value = raw.getUint8(at) | (raw.getUint8(at + 1) << 8) | (raw.getInt8(at + 2) << 16);
                out[i] = value / 8388608;
            }
            return samples;
        default: // 32-bit int
            for (let i = 0; i < samples; i++) out[i] = raw.getInt32(i * 4, true) / 2147483648;
            return samples;
    }
}

export interface WavStreamOptions {
    /** Frames per range read. Larger trades memory for fewer round trips. */
    chunkFrames?: number;
    signal?: AbortSignal;
}

const DEFAULT_CHUNK_FRAMES = 1 << 17; // 131072 frames ≈ 1 MiB at 16-bit stereo

/**
 * Yields interleaved float32 chunks. Only one chunk is live at a time, so
 * memory stays flat no matter how long the file is. The yielded array is
 * reused between iterations — consumers that keep it must copy.
 */
export async function* streamWavFrames(
    source: AudioByteSource,
    info: WavStreamInfo,
    options: WavStreamOptions = {}
): AsyncGenerator<Float32Array> {
    const chunkFrames = options.chunkFrames ?? DEFAULT_CHUNK_FRAMES;
    const bytesPerFrame = info.channels * (info.bitsPerSample / 8);
    const buffer = new Float32Array(chunkFrames * info.channels);

    let frame = 0;
    while (frame < info.frames) {
        if (options.signal?.aborted) throw new Error('wav: aborted');
        const take = Math.min(chunkFrames, info.frames - frame);
        const start = info.dataOffset + frame * bytesPerFrame;
        const raw = new DataView(await source.slice(start, start + take * bytesPerFrame));
        const written = toFloat32(raw, info, buffer);
        yield written === buffer.length ? buffer : buffer.subarray(0, written);
        frame += take;
    }
}

/** Blob-backed source, mirroring `createParquetBlobSource`. */
export function createBlobAudioSource(blob: Blob): AudioByteSource {
    return {
        byteLength: blob.size,
        slice: (start, end) => blob.slice(start, end).arrayBuffer()
    };
}
