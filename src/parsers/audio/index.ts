export interface AudioInfo { format: string; mimeType: string; sampleRate?: number; channels?: number; bitsPerSample?: number; warnings: string[]; }
const MIME: Record<string,string> = { mp3:'audio/mpeg',wav:'audio/wav',pcm:'audio/L16',aiff:'audio/aiff',aif:'audio/aiff',aifc:'audio/aiff',amr:'audio/amr',awb:'audio/amr-wb',ogg:'audio/ogg',flac:'audio/flac',ac3:'audio/ac3',aac:'audio/aac',m4a:'audio/mp4' };
/** Returns the audio MIME type for a file name's extension, or undefined when
 *  the extension is not a recognized audio format. */
export function audioMimeType(fileName: string): string | undefined {
    return MIME[fileName.toLowerCase().split('.').pop() ?? ''];
}
export function parseAudioInfo(fileName: string, data: Uint8Array): AudioInfo {
    const ext = fileName.toLowerCase().split('.').pop() ?? ''; const info: AudioInfo = { format: ext.toUpperCase() || 'AUDIO', mimeType: MIME[ext] ?? 'application/octet-stream', warnings: [] };
    if (ext === 'wav') parseWaveChunks(data, info);
    else if (ext === 'pcm') info.warnings.push('Raw PCM has no embedded sample-rate/channel metadata and may not be playable by the browser.');
    if (data.byteLength === 0) info.warnings.push('The audio file is empty.');
    return info;
}

function parseWaveChunks(data: Uint8Array, info: AudioInfo): void {
    if (data.length < 12 || ascii(data, 0, 4) !== 'RIFF' || ascii(data, 8, 4) !== 'WAVE') {
        info.warnings.push('The WAV file does not contain a valid RIFF/WAVE header.');
        return;
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 12;
    let chunks = 0;
    while (offset + 8 <= data.length && chunks++ < 10_000) {
        const id = ascii(data, offset, 4);
        const size = view.getUint32(offset + 4, true);
        const start = offset + 8;
        const end = start + size;
        if (end > data.length) {
            info.warnings.push(`The WAV ${id.trim() || 'unknown'} chunk is truncated.`);
            return;
        }
        if (id === 'fmt ') {
            if (size < 16) {
                info.warnings.push('The WAV fmt chunk is shorter than 16 bytes.');
                return;
            }
            info.channels = view.getUint16(start + 2, true);
            info.sampleRate = view.getUint32(start + 4, true);
            info.bitsPerSample = view.getUint16(start + 14, true);
            return;
        }
        // RIFF chunks are padded to an even byte boundary; the padding byte is
        // not included in the declared chunk size.
        offset = end + (size & 1);
    }
    info.warnings.push('The WAV file does not contain a fmt chunk.');
}
function ascii(data:Uint8Array,offset:number,length:number):string { return [...data.subarray(offset,offset+length)].map(x=>String.fromCharCode(x)).join(''); }
