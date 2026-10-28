import { DEFAULT_LIMITS, LimitTracker, type ParseOptions, type ParseOutcome, type Diagnostic } from '../types.js';

export interface FontTable { tag: string; offset: number; length: number; compressedLength: number }
export interface FontCharacter { codePoint: number; glyphIndex: number }
export interface FontAxis { tag: string; min: number; default: number; max: number }
export const FONT_INPUT_OWNERSHIP = 'borrows' as const;
export interface FontDocument {
    format: 'TrueType' | 'OpenType' | 'WOFF';
    family: string;
    subfamily: string;
    fullName: string;
    postScriptName: string;
    version: string;
    copyright: string;
    license: string;
    glyphCount: number;
    unitsPerEm: number;
    weight: number;
    italic: boolean;
    tables: FontTable[];
    characters: FontCharacter[];
    charactersTruncated: boolean;
    axes: FontAxis[];
}

class FontFailure extends Error {
    constructor(readonly code: 'invalid-format' | 'corrupted' | 'limit-exceeded' | 'aborted' | 'missing-dependency') { super(code); }
}

/** Reads sfnt/WOFF metadata without interpreting outlines or executing font code. */
export async function parseFont(data: Uint8Array, options: ParseOptions = {}): Promise<ParseOutcome<FontDocument>> {
    const started = Date.now();
    const limits = { ...DEFAULT_LIMITS, maxInputBytes: 64 * 1024 * 1024, maxDecompressedBytes: 64 * 1024 * 1024, ...options.limits };
    const tracker = new LimitTracker(limits, options.signal);
    const diagnostics: Diagnostic[] = [];
    const check = (): void => {
        const violation = tracker.checkpoint();
        if (violation) throw new FontFailure(violation.kind === 'aborted' ? 'aborted' : 'limit-exceeded');
    };
    const execution = () => ({ workerUsed: false, hardLimitEnforced: false, elapsedMillis: Date.now() - started });
    try {
        check();
        if (data.byteLength > limits.maxInputBytes) throw new FontFailure('limit-exceeded');
        const source = view(data);
        const signature = source.getUint32(0);
        const woff = signature === 0x774f4646;
        const flavor = woff ? source.getUint32(4) : signature;
        if (![0x00010000, 0x4f54544f, 0x74727565].includes(flavor)) throw new FontFailure('invalid-format');
        const header = woff ? 44 : 12, stride = woff ? 20 : 16;
        const count = source.getUint16(woff ? 12 : 4);
        if (!count) throw new FontFailure('corrupted');
        if (count > Math.min(limits.maxEntries, 4096)) throw new FontFailure('limit-exceeded');
        if (data.length < header + count * stride || (woff && (source.getUint32(8) !== data.length || source.getUint16(14) !== 0))) throw new FontFailure('corrupted');
        const tables: FontTable[] = [];
        const tags = new Set<string>();
        let total = 0;
        for (let i = 0; i < count; i++) {
            check();
            const p = header + i * stride;
            const tag = String.fromCharCode(...data.subarray(p, p + 4));
            const offset = source.getUint32(p + (woff ? 4 : 8));
            const compressedLength = source.getUint32(p + (woff ? 8 : 12));
            const length = woff ? source.getUint32(p + 12) : compressedLength;
            if (tags.has(tag) || !/^[\x20-\x7e]{4}$/.test(tag) || offset < header + count * stride || offset + compressedLength > data.length || compressedLength > length || (!compressedLength && length)) throw new FontFailure('corrupted');
            total += length;
            if (total > limits.maxDecompressedBytes) throw new FontFailure('limit-exceeded');
            tags.add(tag); tables.push({ tag, offset, length, compressedLength });
        }
        const ordered = [...tables].sort((a, b) => a.offset - b.offset);
        for (let i = 1; i < ordered.length; i++) if (ordered[i]!.offset < ordered[i - 1]!.offset + ordered[i - 1]!.compressedLength) throw new FontFailure('corrupted');
        if (woff && source.getUint32(16) !== 12 + count * 16 + tables.reduce((sum, table) => sum + Math.ceil(table.length / 4) * 4, 0)) throw new FontFailure('corrupted');
        const read = async (tag: string): Promise<DataView | undefined> => {
            const table = tables.find(t => t.tag === tag);
            if (!table) return undefined;
            check();
            let bytes = data.subarray(table.offset, table.offset + table.compressedLength);
            if (table.compressedLength < table.length) {
                if (typeof DecompressionStream === 'undefined') throw new FontFailure('missing-dependency');
                const reader = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
                const cancel = () => { void reader.cancel().catch(() => undefined); };
                options.signal?.addEventListener('abort', cancel, { once: true });
                try {
                    const output = new Uint8Array(table.length);
                    let position = 0;
                    for (;;) {
                        check();
                        const { value, done } = await reader.read();
                        check();
                        if (done) break;
                        if (position + value.length > output.length) throw new FontFailure('corrupted');
                        output.set(value, position); position += value.length;
                    }
                    if (position !== output.length) throw new FontFailure('corrupted');
                    bytes = output;
                } finally {
                    options.signal?.removeEventListener('abort', cancel);
                    await reader.cancel().catch(() => undefined);
                    reader.releaseLock();
                }
            }
            return view(bytes);
        };
        const names = new Map<number, { score: number; text: string }>();
        const name = await read('name');
        if (name) {
            const n = name.getUint16(2), storage = name.getUint16(4);
            if (n > limits.maxEntries) throw new FontFailure('limit-exceeded');
            if (6 + n * 12 > name.byteLength || storage < 6 + n * 12) throw new FontFailure('corrupted');
            for (let i = 0; i < n; i++) {
                check();
                const p = 6 + i * 12, platform = name.getUint16(p), encoding = name.getUint16(p + 2), language = name.getUint16(p + 4), id = name.getUint16(p + 6);
                const length = name.getUint16(p + 8), offset = storage + name.getUint16(p + 10);
                if (offset + length > name.byteLength) throw new FontFailure('corrupted');
                if (![0, 1, 2, 4, 5, 6, 13, 16, 17].includes(id)) continue;
                const unicode = platform === 0 || platform === 3 && [0, 1, 10].includes(encoding);
                if (!unicode && !(platform === 1 && encoding === 0)) continue;
                if (unicode && length % 2) throw new FontFailure('corrupted');
                const score = (unicode ? 10 : 0) + (language === 0x0409 ? 2 : language === 0 ? 1 : 0);
                if ((names.get(id)?.score ?? -1) >= score) continue;
                const bytes = new Uint8Array(name.buffer, name.byteOffset + offset, Math.min(length, 8192));
                const text = new TextDecoder(unicode ? 'utf-16be' : 'macintosh').decode(bytes).replace(/\0/g, '');
                names.set(id, { score, text });
            }
        }
        const head = await read('head'), maxp = await read('maxp'), os2 = await read('OS/2');
        const glyphCount = maxp?.getUint16(4) ?? 0;
        const model: FontDocument = {
            format: woff ? 'WOFF' : flavor === 0x4f54544f ? 'OpenType' : 'TrueType',
            family: names.get(16)?.text ?? names.get(1)?.text ?? '', subfamily: names.get(17)?.text ?? names.get(2)?.text ?? '',
            fullName: names.get(4)?.text ?? '', postScriptName: names.get(6)?.text ?? '', version: names.get(5)?.text ?? '',
            copyright: names.get(0)?.text ?? '', license: names.get(13)?.text ?? '', glyphCount,
            unitsPerEm: head?.getUint16(18) ?? 0, weight: os2?.getUint16(4) ?? 400,
            italic: !!(head && head.getUint16(44) & 2), tables, characters: [], charactersTruncated: false, axes: []
        };
        const fvar = await read('fvar');
        if (fvar) {
            const offset = fvar.getUint16(4), axes = fvar.getUint16(8), size = fvar.getUint16(10);
            if (axes > 64 || size < 20 || offset + axes * size > fvar.byteLength) throw new FontFailure('corrupted');
            for (let i = 0; i < axes; i++) {
                const p = offset + i * size;
                const tag = String.fromCharCode(...new Uint8Array(fvar.buffer, fvar.byteOffset + p, 4));
                const min = fvar.getInt32(p + 4) / 65536, def = fvar.getInt32(p + 8) / 65536, max = fvar.getInt32(p + 12) / 65536;
                if (!/^[\x20-\x7e]{4}$/.test(tag) || min > def || def > max) throw new FontFailure('corrupted');
                model.axes.push({ tag, min, default: def, max });
            }
        }
        const cmap = await read('cmap');
        const charLimit = Math.max(0, Math.min(65536, limits.maxEntries, Math.floor((limits.maxPreviewBytes ?? 256 * 1024) / 16)));
        const add = (codePoint: number, glyphIndex: number): boolean => {
            check();
            if (codePoint > 0x10ffff || codePoint >= 0xd800 && codePoint <= 0xdfff || glyphIndex === 0) return true;
            if (glyphCount && glyphIndex >= glyphCount) throw new FontFailure('corrupted');
            if (model.characters.length >= charLimit) { model.charactersTruncated = true; return false; }
            model.characters.push({ codePoint, glyphIndex }); return true;
        };
        let supported = false;
        if (cmap) {
            const n = cmap.getUint16(2);
            if (n > limits.maxEntries) throw new FontFailure('limit-exceeded');
            if (4 + n * 8 > cmap.byteLength) throw new FontFailure('corrupted');
            const candidates: { offset: number; score: number }[] = [];
            for (let i = 0; i < n; i++) {
                const p = 4 + i * 8, platform = cmap.getUint16(p), encoding = cmap.getUint16(p + 2), offset = cmap.getUint32(p + 4);
                const format = cmap.getUint16(offset);
                if ((platform === 0 || platform === 3 && [0, 1, 10].includes(encoding)) && [0, 4, 6, 12, 13].includes(format)) candidates.push({ offset, score: (format === 12 ? 100 : format === 4 ? 90 : format === 13 ? 80 : 0) + (platform === 0 ? 1 : 0) });
            }
            candidates.sort((a, b) => b.score - a.score);
            const candidate = candidates[0];
            if (candidate) {
                supported = true;
                const offset = candidate.offset, format = cmap.getUint16(offset);
                const length = format >= 12 ? cmap.getUint32(offset + 4) : cmap.getUint16(offset + 2);
                if (offset + length > cmap.byteLength) throw new FontFailure('corrupted');
                const sub = new DataView(cmap.buffer, cmap.byteOffset + offset, length);
                if (format === 12 || format === 13) {
                    const groups = sub.getUint32(12);
                    if (groups > limits.maxEntries) throw new FontFailure('limit-exceeded');
                    if (16 + groups * 12 > length) throw new FontFailure('corrupted');
                    let previous = -1;
                    outer: for (let i = 0; i < groups; i++) {
                        const p = 16 + i * 12, start = sub.getUint32(p), end = sub.getUint32(p + 4), glyph = sub.getUint32(p + 8);
                        if (start > end || end > 0x10ffff || start <= previous) throw new FontFailure('corrupted');
                        previous = end;
                        for (let cp = start; cp <= end; cp++) if (!add(cp, format === 13 ? glyph : glyph + cp - start)) break outer;
                    }
                } else if (format === 4) {
                    const segments = sub.getUint16(6) / 2;
                    if (!Number.isInteger(segments) || !segments || 16 + segments * 8 > length) throw new FontFailure('corrupted');
                    let previous = -1;
                    outer: for (let i = 0; i < segments; i++) {
                        const end = sub.getUint16(14 + i * 2), start = sub.getUint16(16 + segments * 2 + i * 2);
                        const delta = sub.getInt16(16 + segments * 4 + i * 2), p = 16 + segments * 6 + i * 2, range = sub.getUint16(p);
                        if (start > end || start <= previous) throw new FontFailure('corrupted');
                        previous = end;
                        for (let cp = start; cp <= end && cp < 0xffff; cp++) {
                            let glyph = range ? sub.getUint16(p + range + (cp - start) * 2) : (cp + delta) & 0xffff;
                            if (range && glyph) glyph = (glyph + delta) & 0xffff;
                            if (!add(cp, glyph)) break outer;
                        }
                    }
                } else {
                    const start = format === 6 ? sub.getUint16(6) : 0, n = format === 6 ? sub.getUint16(8) : 256;
                    if (start + n > 0x10000) throw new FontFailure('corrupted');
                    for (let i = 0; i < n; i++) if (!add(start + i, format === 6 ? sub.getUint16(10 + i * 2) : sub.getUint8(6 + i))) break;
                }
            }
        }
        if (!supported) diagnostics.push({ severity: 'warning', code: 'font.cmap', messageKey: 'diag.font.cmap' });
        if (model.charactersTruncated) diagnostics.push({ severity: 'warning', code: 'font.preview', messageKey: 'diag.font.preview' });
        check();
        return { result: { status: diagnostics.length ? 'partial' : 'ok', document: model, diagnostics }, execution: execution() };
    } catch (error) {
        const code = options.signal?.aborted ? 'aborted' : error instanceof FontFailure ? error.code : 'corrupted';
        const messageKey = code === 'aborted' ? 'diag.aborted' : code === 'limit-exceeded' ? 'diag.font.limit' : code === 'invalid-format' ? 'diag.font.invalid' : code === 'missing-dependency' ? 'diag.font.decompression' : 'diag.font.corrupted';
        return { result: { status: 'failed', failure: { code, retryable: false, messageKey }, diagnostics }, execution: execution() };
    }
}

function view(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
