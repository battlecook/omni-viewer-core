import { DEFAULT_LIMITS, LimitTracker, type Diagnostic, type ParseFailure, type ParseOptions, type ParseOutcome } from '../types.js';
import { McapDecompressionLimitError } from './errors.js';
export { McapDecompressionLimitError } from './errors.js';

export const MCAP_MAGIC = [0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a] as const;
export const MCAP_INPUT_OWNERSHIP = 'borrows' as const;
export interface McapPreview { text: string; hex: string; truncated: boolean }
export interface McapSchema { id: number; name: string; encoding: string; sizeBytes: number; preview: McapPreview }
export interface McapChannel { id: number; schemaId: number; topic: string; messageEncoding: string; metadata: Record<string, string>; messageCount: string }
export interface McapMessage { channelId: number; sequence: number; logTime: string; publishTime: string; sizeBytes: number; preview: McapPreview }
export interface McapChunk { offset: number; startTime: string; endTime: string; compression: string; compressedBytes: number; uncompressedBytes: string; decoded: boolean }
export interface McapAttachment { name: string; mediaType: string; logTime: string; createTime: string; sizeBytes: number }
export interface McapMetadata { name: string; values: Record<string, string> }
export interface McapStatistics {
    messageCount: string; schemaCount: number; channelCount: number; attachmentCount: number; metadataCount: number; chunkCount: number;
    startTime: string; endTime: string; channelMessageCounts: Record<string, string>;
}
export interface McapDocument {
    profile: string; library: string; fileSizeBytes: number;
    schemas: McapSchema[]; channels: McapChannel[]; messages: McapMessage[];
    chunks: McapChunk[]; attachments: McapAttachment[]; metadata: McapMetadata[];
    /** All uint64 values use decimal strings, including nanosecond timestamps. */
    messageCount: string; startTime: string | null; endTime: string | null;
    /** False when any records were skipped; Statistics may still provide exact totals. */
    scanComplete: boolean; previewLimited: boolean; statistics?: McapStatistics;
}
export interface McapParseDeps {
    /** Must bound output to expectedBytes; maxWindowBytes bounds decoder history. */
    decompressLz4?: (data: Uint8Array, expectedBytes: number, maxWindowBytes?: number) => Uint8Array;
    decompressZstd?: (data: Uint8Array, expectedBytes: number, maxWindowBytes?: number) => Uint8Array;
}
export interface McapParseOptions extends ParseOptions {
    /** Retained message samples (default 5,000); totals still count every scanned message. */
    previewMessages?: number;
    /** Bytes per message/schema preview (default 4,096). */
    previewBytesPerMessage?: number;
}

class McapError extends Error {
    constructor(readonly code: ParseFailure['code'], readonly key = `diag.mcap.${code}`) { super(key); }
}
const corrupt = (): never => { throw new McapError('corrupted'); };
const bounded = (value: number | undefined, fallback: number): number => value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
const hasMagic = (data: Uint8Array, offset: number): boolean => MCAP_MAGIC.every((value, i) => data[offset + i] === value);

/** A bounded, DOM-free MCAP v0 reader. The base entry has no runtime peers. */
export function parseMcap(input: Uint8Array, deps: McapParseDeps = {}, options: McapParseOptions = {}): ParseOutcome<McapDocument> {
    const started = Date.now();
    const limits = {
        maxInputBytes: bounded(options.limits?.maxInputBytes, DEFAULT_LIMITS.maxInputBytes),
        maxEntries: bounded(options.limits?.maxEntries, DEFAULT_LIMITS.maxEntries),
        maxParseMillis: bounded(options.limits?.maxParseMillis, DEFAULT_LIMITS.maxParseMillis),
        maxDecompressedBytes: bounded(options.limits?.maxDecompressedBytes, 256 * 1024 * 1024)
    };
    const tracker = new LimitTracker(limits, options.signal);
    const diagnostics: Diagnostic[] = [];
    const warned = new Set<string>();
    const warn = (code: string, args?: Record<string, string | number>) => {
        if (warned.has(code)) return;
        warned.add(code);
        diagnostics.push({ code: `mcap.${code}`, severity: 'warning', messageKey: `diag.mcap.${code}`, ...(args ? { args } : {}) });
    };
    const check = () => {
        const violation = tracker.checkpoint();
        if (violation) throw new McapError(violation.kind === 'aborted' ? 'aborted' : 'limit-exceeded');
    };
    const entry = () => { tracker.addEntries(1); check(); };
    let budget = bounded(options.limits?.maxPreviewBytes, 8 * 1024 * 1024);
    const previewCount = bounded(options.previewMessages, 5000);
    const previewSize = bounded(options.previewBytesPerMessage, 4096);
    const model: McapDocument = {
        profile: '', library: '', fileSizeBytes: input.byteLength, schemas: [], channels: [], messages: [], chunks: [], attachments: [], metadata: [],
        messageCount: '0', startTime: null, endTime: null, scanComplete: true, previewLimited: false
    };
    const limited = () => { model.previewLimited = true; warn('preview'); };
    const text = (bytes: Uint8Array): string => {
        const count = Math.min(bytes.length, 16_384, budget);
        budget -= count;
        if (count < bytes.length) limited();
        return new TextDecoder().decode(bytes.subarray(0, count));
    };
    const reader = (bytes: Uint8Array) => new Reader(bytes, text, entry);
    const preview = (bytes: Uint8Array): McapPreview => {
        // A byte can require three characters in either a hex or UTF-8 preview.
        const length = Math.min(bytes.length, previewSize, Math.floor(budget / 6));
        budget -= length * 6;
        const sample = bytes.subarray(0, length);
        const truncated = length < bytes.length;
        if (truncated) limited();
        return { text: new TextDecoder().decode(sample), hex: Array.from(sample, value => value.toString(16).padStart(2, '0')).join(' '), truncated };
    };
    const schemas = new Map<number, McapSchema>(), channels = new Map<number, McapChannel>();
    const channelCounts = new Map<number, bigint>();
    let messages = 0n, startTime: bigint | null = null, endTime: bigint | null = null;
    let header = false, footer = false, dataEnd = false;
    const addTime = (start: bigint, end: bigint) => {
        if (end < start) corrupt();
        startTime = startTime === null || start < startTime ? start : startTime;
        endTime = endTime === null || end > endTime ? end : endTime;
    };
    const scan = (bytes: Uint8Array, baseOffset: number, inChunk: boolean): void => {
        const source = reader(bytes);
        while (source.remaining) {
            entry();
            const offset = source.position;
            const opcode = source.u8(), size = source.length64();
            const r = reader(source.bytes(size));
            if (opcode === 0) corrupt();
            if (!inChunk && !header && opcode !== 1) corrupt();
            if (inChunk && opcode <= 15 && ![3, 4, 5].includes(opcode)) corrupt();
            switch (opcode) {
            case 1:
                if (header || inChunk) corrupt();
                model.profile = r.string(); model.library = r.string(); header = true;
                break;
            case 2: {
                if (inChunk || source.remaining !== 0 || size !== 20) corrupt();
                const summaryStart = r.length64(), summaryOffsetStart = r.length64(), crc = r.u32();
                const footerOffset = baseOffset + offset;
                if (summaryStart && (summaryStart < 8 || summaryStart >= footerOffset)) corrupt();
                if (summaryOffsetStart && (!summaryStart || summaryOffsetStart < summaryStart || summaryOffsetStart >= footerOffset)) corrupt();
                if (crc && crc32(input.subarray(summaryStart || footerOffset, footerOffset + 25), check) !== crc) throw new McapError('corrupted', 'diag.mcap.crc');
                footer = true;
                break;
            }
            case 3: {
                const id = r.u16();
                if (id === 0) { warn('schemaZero'); break; }
                // Summary copies are identical by specification; never duplicate their previews.
                if (schemas.has(id)) break;
                const name = r.string(), encoding = r.identifier(), data = r.bytes(r.u32());
                schemas.set(id, { id, name, encoding, sizeBytes: data.length, preview: preview(data) });
                break;
            }
            case 4: {
                const id = r.u16();
                if (channels.has(id)) break;
                const schemaId = r.u16(), topic = r.string(), messageEncoding = r.identifier(), metadata = r.map();
                channels.set(id, { id, schemaId, topic, messageEncoding, metadata, messageCount: '0' });
                break;
            }
            case 5: {
                if (dataEnd) corrupt();
                const channelId = r.u16(), sequence = r.u32(), logTime = r.u64(), publishTime = r.u64();
                messages++; channelCounts.set(channelId, (channelCounts.get(channelId) ?? 0n) + 1n);
                addTime(logTime, logTime);
                if (model.messages.length < previewCount && budget > 0) {
                    const data = r.bytes(r.remaining);
                    model.messages.push({ channelId, sequence, logTime: String(logTime), publishTime: String(publishTime), sizeBytes: data.length, preview: preview(data) });
                } else limited();
                break;
            }
            case 6: {
                if (dataEnd) corrupt();
                const start = r.u64(), end = r.u64(), expected = r.u64(), crc = r.u32(), compression = r.identifier();
                const data = r.bytes(r.length64());
                const chunk: McapChunk = { offset: baseOffset + offset, startTime: String(start), endTime: String(end), compression, compressedBytes: data.length, uncompressedBytes: String(expected), decoded: false };
                model.chunks.push(chunk);
                if (start || end) addTime(start, end);
                const decode = compression === 'lz4' ? deps.decompressLz4 : compression === 'zstd' ? deps.decompressZstd : undefined;
                if (compression && !decode) {
                    model.scanComplete = false;
                    warn(compression === 'lz4' || compression === 'zstd' ? 'compression' : 'unsupportedCompression');
                    break;
                }
                if (expected > BigInt(limits.maxDecompressedBytes)) throw new McapError('limit-exceeded');
                tracker.addDecompressedBytes(Number(expected)); check();
                let decoded: Uint8Array;
                try { decoded = compression ? decode!(data, Number(expected), limits.maxDecompressedBytes) : data; }
                catch (error) {
                    check();
                    throw new McapError(error instanceof McapDecompressionLimitError ? 'limit-exceeded' : 'corrupted');
                }
                check();
                if (BigInt(decoded.length) !== expected) corrupt();
                if (crc && crc32(decoded, check) !== crc) throw new McapError('corrupted', 'diag.mcap.crc');
                scan(decoded, chunk.offset, true);
                chunk.decoded = true;
                break;
            }
            case 9: {
                const logTime = String(r.u64()), createTime = String(r.u64()), name = r.string(), mediaType = r.string();
                const sizeBytes = r.length64(); r.bytes(sizeBytes); r.u32();
                model.attachments.push({ name, mediaType, logTime, createTime, sizeBytes });
                break;
            }
            case 11: {
                const statistics: McapStatistics = {
                    messageCount: String(r.u64()), schemaCount: r.u16(), channelCount: r.u32(), attachmentCount: r.u32(), metadataCount: r.u32(), chunkCount: r.u32(),
                    startTime: String(r.u64()), endTime: String(r.u64()), channelMessageCounts: {}
                };
                const counts = reader(r.bytes(r.u32()));
                while (counts.remaining) { entry(); statistics.channelMessageCounts[String(counts.u16())] = String(counts.u64()); }
                if (BigInt(statistics.endTime) < BigInt(statistics.startTime)) corrupt();
                model.statistics = statistics;
                break;
            }
            case 12: model.metadata.push({ name: r.string(), values: r.map() }); break;
            case 15: {
                if (dataEnd || size !== 4) corrupt();
                const crc = r.u32();
                if (crc && crc32(input.subarray(0, baseOffset + offset), check) !== crc) throw new McapError('corrupted', 'diag.mcap.crc');
                dataEnd = true;
                break;
            }
            // Index records and forward-compatible/private records contain no preview data.
            default: break;
            }
        }
    };
    let failure: McapError | undefined;
    try {
        check();
        if (input.length > limits.maxInputBytes) throw new McapError('limit-exceeded');
        if (!hasMagic(input, 0)) throw new McapError('invalid-format');
        const trailingMagic = input.length >= 16 && hasMagic(input, input.length - 8);
        scan(input.subarray(8, trailingMagic ? input.length - 8 : input.length), 8, false);
        if (!trailingMagic || !footer || !dataEnd) throw new McapError('corrupted');
    } catch (error) {
        if (!(error instanceof McapError)) throw error;
        failure = error;
    }
    model.schemas = [...schemas.values()];
    model.channels = [...channels.values()].map(channel => ({ ...channel, messageCount: model.statistics?.channelMessageCounts[channel.id] ?? String(channelCounts.get(channel.id) ?? 0n) }));
    model.messageCount = model.statistics?.messageCount ?? String(messages);
    model.startTime = model.statistics && model.statistics.messageCount !== '0' ? model.statistics.startTime : startTime === null ? null : String(startTime);
    model.endTime = model.statistics && model.statistics.messageCount !== '0' ? model.statistics.endTime : endTime === null ? null : String(endTime);
    for (const channel of model.channels) if (channel.schemaId && !schemas.has(channel.schemaId)) warn('references');
    for (const id of channelCounts.keys()) if (!channels.has(id)) warn('references');
    if (failure) model.scanComplete = false;
    const execution = { workerUsed: false, hardLimitEnforced: false, elapsedMillis: Date.now() - started };
    if (failure && (!header || failure.code === 'aborted')) return {
        result: { status: 'failed', failure: { code: failure.code, retryable: failure.code === 'aborted', messageKey: failure.key }, diagnostics }, execution
    };
    if (failure) diagnostics.push({ code: `mcap.${failure.code}`, severity: 'warning', messageKey: failure.key });
    return { result: { status: diagnostics.length ? 'partial' : 'ok', document: model, diagnostics }, execution };
}

class Reader {
    position = 0;
    private readonly view: DataView;
    constructor(private readonly data: Uint8Array, private readonly decode: (bytes: Uint8Array) => string, private readonly entry: () => void) {
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    }
    get remaining(): number { return this.data.length - this.position; }
    bytes(length: number): Uint8Array {
        if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) corrupt();
        const start = this.position; this.position += length;
        return this.data.subarray(start, this.position);
    }
    u8(): number { const p = this.position; this.bytes(1); return this.view.getUint8(p); }
    u16(): number { const p = this.position; this.bytes(2); return this.view.getUint16(p, true); }
    u32(): number { const p = this.position; this.bytes(4); return this.view.getUint32(p, true); }
    u64(): bigint { const p = this.position; this.bytes(8); return this.view.getBigUint64(p, true); }
    length64(): number { const value = this.u64(); if (value > BigInt(Number.MAX_SAFE_INTEGER)) corrupt(); return Number(value); }
    string(): string { return this.decode(this.bytes(this.u32())); }
    /** Structural identifiers must survive preview exhaustion without partial decoding. */
    identifier(): string {
        const bytes = this.bytes(this.u32());
        if (bytes.length > 16_384) throw new McapError('limit-exceeded');
        return new TextDecoder().decode(bytes);
    }
    map(): Record<string, string> {
        const map = new Reader(this.bytes(this.u32()), this.decode, this.entry);
        const result: Array<[string, string]> = [];
        while (map.remaining) { this.entry(); result.push([map.string(), map.string()]); }
        return Object.fromEntries(result);
    }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    return value >>> 0;
});
function crc32(data: Uint8Array, check: () => void): number {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        if ((i & 0xffff) === 0) check();
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]!) & 255]!;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
