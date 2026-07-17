import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createWasmAudioEngine, encodeWavFromFloat32, type AudioEngineModuleLike } from './engine.js';

const assetDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'assets', 'audio-engine');

async function loadRealModule(): Promise<AudioEngineModuleLike> {
    const factory = (await import(path.join(assetDir, 'audio_engine.mjs')) as {
        default(options: Record<string, unknown>): Promise<AudioEngineModuleLike>;
    }).default;
    const wasm = await readFile(path.join(assetDir, 'audio_engine.wasm'));
    // Node cannot fetch() file:// URLs, so hand the binary over directly.
    return factory({
        instantiateWasm: (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) => {
            void WebAssembly.instantiate(wasm, imports).then((result) => receive(result.instance));
            return {};
        }
    });
}

describe('encodeWavFromFloat32', () => {
    it('writes a valid 16-bit PCM RIFF header and clamped samples', () => {
        const wav = encodeWavFromFloat32(new Float32Array([0, 0.5, -0.5, 2]), 1, 8000);
        const view = new DataView(wav.buffer);
        const ascii = (offset: number, length: number): string =>
            [...wav.subarray(offset, offset + length)].map((c) => String.fromCharCode(c)).join('');
        expect(ascii(0, 4)).toBe('RIFF');
        expect(ascii(8, 4)).toBe('WAVE');
        expect(view.getUint16(20, true)).toBe(1); // PCM
        expect(view.getUint16(22, true)).toBe(1);
        expect(view.getUint32(24, true)).toBe(8000);
        expect(view.getUint16(34, true)).toBe(16);
        expect(view.getUint32(40, true)).toBe(8);
        const samples = new Int16Array(wav.buffer, 44);
        expect(samples[0]).toBe(0);
        expect(samples[1]).toBe(Math.round(0.5 * 0x7fff));
        expect(samples[2]).toBe(-0x4000);
        expect(samples[3]).toBe(0x7fff); // clamped
    });
});

describe('wasm audio engine (real artifact)', () => {
    it('decodes a WAV round-trip produced by encodeWavFromFloat32', async () => {
        const engine = createWasmAudioEngine(loadRealModule);
        const source = new Float32Array([0, 0.25, -0.25, 0.99, -0.99, 0.5]);
        const wav = encodeWavFromFloat32(source, 2, 44100);
        const decoded = await engine.decode(wav);
        expect(decoded.channels).toBe(2);
        expect(decoded.sampleRate).toBe(44100);
        expect(decoded.frames).toBe(3);
        for (let i = 0; i < source.length; i++) {
            expect(decoded.pcm[i]).toBeCloseTo(source[i]!, 2);
        }
    });

    it('computes peak analysis without exporting PCM', async () => {
        const engine = createWasmAudioEngine(loadRealModule);
        const source = new Float32Array(8000).map((_, i) => (i < 4000 ? 0.25 : 0.75) * Math.sign(Math.sin(i)));
        const wav = encodeWavFromFloat32(source, 1, 8000);
        const analysis = await engine.analyze(wav, 4);
        expect(analysis.channels).toBe(1);
        expect(analysis.sampleRate).toBe(8000);
        expect(analysis.duration).toBeCloseTo(1, 3);
        expect(analysis.peaks).toHaveLength(4);
        expect(analysis.peaks[0]!).toBeLessThan(analysis.peaks[3]!);
    });

    it('rejects undecodable bytes', async () => {
        const engine = createWasmAudioEngine(loadRealModule);
        await expect(engine.decode(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow(/unsupported/);
    });
});
