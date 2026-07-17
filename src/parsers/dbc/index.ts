export interface DbcSignalValue { value: number; label: string; }
export interface DbcSignal {
    name: string; multiplexer: string | null; startBit: number; length: number;
    byteOrder: 'little_endian' | 'big_endian'; valueType: 'unsigned' | 'signed';
    factor: number; offset: number; minimum: number; maximum: number; unit: string;
    receivers: string[]; comment: string | null; values: DbcSignalValue[]; line: number;
}
export interface DbcMessage {
    /** Actual 11-bit or 29-bit CAN identifier, without DBC's bit-31 flag. */
    id: number;
    /** Decimal identifier exactly as encoded in the BO_ declaration. */
    encodedId: number;
    idHex: string;
    isExtended: boolean;
    name: string;
    dlc: number;
    transmitter: string;
    comment: string | null;
    signals: DbcSignal[];
    line: number;
}
export interface DbcViewerModel {
    version: string; busConfiguration: string | null; nodes: string[]; messages: DbcMessage[]; warnings: string[];
    stats: { messageCount: number; signalCount: number; nodeCount: number; extendedMessageCount: number; maxDlc: number };
}
export interface DbcParseOptions { maxBytes?: number; maxMessages?: number; maxSignals?: number; signal?: AbortSignal; }

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export function parseDbc(input: string | Uint8Array, options: DbcParseOptions = {}): DbcViewerModel {
    if (options.signal?.aborted) throw new Error('aborted');
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const truncated = bytes.byteLength > maxBytes;
    const source = new TextDecoder().decode(bytes.subarray(0, maxBytes));
    const maxMessages = options.maxMessages ?? 2_000; const maxSignals = options.maxSignals ?? 20_000;
    const model: DbcViewerModel = { version: '', busConfiguration: null, nodes: [], messages: [], warnings: [], stats: { messageCount: 0, signalCount: 0, nodeCount: 0, extendedMessageCount: 0, maxDlc: 0 } };
    const byId = new Map<number, DbcMessage>(); let current: DbcMessage | undefined; let totalMessages = 0; let totalSignals = 0;
    for (const [index, line] of source.split(/\r?\n/).entries()) {
        if (options.signal?.aborted) throw new Error('aborted');
        const text = line.trim(); if (!text) continue;
        if (text.startsWith('VERSION')) { model.version = unquote(text.replace(/^VERSION\s*/, '')); continue; }
        if (text.startsWith('BS_:')) { model.busConfiguration = text.slice(4).trim() || null; continue; }
        if (text.startsWith('BU_:')) { model.nodes = text.slice(4).trim().split(/\s+/).filter(Boolean).slice(0, 10_000); continue; }
        const message = /^BO_\s+(\d+)\s+([A-Za-z_][\w.]*)\s*:\s*(\d+)\s+(\S+)/.exec(text);
        if (message?.[1] && message[2] && message[3] && message[4]) {
            totalMessages++;
            const encodedId = Number(message[1]);
            const isExtended = (encodedId & 0x80000000) !== 0;
            const id = isExtended ? encodedId & 0x1fffffff : encodedId;
            current = { id, encodedId, idHex: `0x${id.toString(16).toUpperCase()}`, isExtended, name: message[2], dlc: Number(message[3]), transmitter: message[4], comment: null, signals: [], line: index + 1 };
            // DBC comments and value declarations address messages using the
            // encoded BO_ identifier, including the extended-frame flag.
            byId.set(encodedId, current); if (model.messages.length < maxMessages) model.messages.push(current); continue;
        }
        const signal = /^SG_\s+([A-Za-z_][\w.]*)\s*(M|m\d+)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s+\(([-+.\deE]+),([-+.\deE]+)\)\s+\[([-+.\deE]+)\|([-+.\deE]+)\]\s+"([^"]*)"\s*(.*)$/.exec(text);
        if (signal?.[1]) {
            totalSignals++; if (!current) { model.warnings.push(`Line ${index + 1}: signal appears before any message.`); continue; }
            if (totalSignals <= maxSignals && model.messages.includes(current)) current.signals.push({ name: signal[1], multiplexer: signal[2] ?? null, startBit: Number(signal[3]), length: Number(signal[4]), byteOrder: signal[5] === '1' ? 'little_endian' : 'big_endian', valueType: signal[6] === '+' ? 'unsigned' : 'signed', factor: Number(signal[7]), offset: Number(signal[8]), minimum: Number(signal[9]), maximum: Number(signal[10]), unit: signal[11] ?? '', receivers: (signal[12] ?? '').split(',').map(x => x.trim()).filter(Boolean), comment: null, values: [], line: index + 1 });
            continue;
        }
        let comment = /^CM_\s+BO_\s+(\d+)\s+"((?:[^"\\]|\\.)*)"\s*;/.exec(text);
        if (comment?.[1]) { const target = byId.get(Number(comment[1])); if (target) target.comment = unescapeDbc(comment[2] ?? ''); continue; }
        comment = /^CM_\s+SG_\s+(\d+)\s+([A-Za-z_][\w.]*)\s+"((?:[^"\\]|\\.)*)"\s*;/.exec(text);
        if (comment?.[1]) { const target = byId.get(Number(comment[1]))?.signals.find(x => x.name === comment![2]); if (target) target.comment = unescapeDbc(comment[3] ?? ''); continue; }
        const values = /^VAL_\s+(\d+)\s+([A-Za-z_][\w.]*)\s+(.+);$/.exec(text);
        if (values?.[1]) {
            const target = byId.get(Number(values[1]))?.signals.find(x => x.name === values[2]); if (!target) continue;
            for (const match of (values[3] ?? '').matchAll(/(-?\d+)\s+"((?:[^"\\]|\\.)*)"/g)) target.values.push({ value: Number(match[1]), label: unescapeDbc(match[2] ?? '') });
        }
    }
    model.stats = { messageCount: totalMessages, signalCount: totalSignals, nodeCount: model.nodes.length, extendedMessageCount: model.messages.filter(x => x.isExtended).length, maxDlc: model.messages.reduce((n, x) => Math.max(n, x.dlc), 0) };
    if (truncated) model.warnings.push(`DBC scan is limited to ${maxBytes.toLocaleString()} bytes.`);
    if (totalMessages > model.messages.length) model.warnings.push(`Message preview is limited to ${maxMessages.toLocaleString()} entries.`);
    if (totalSignals > maxSignals) model.warnings.push(`Signal preview is limited to ${maxSignals.toLocaleString()} entries.`);
    if (totalMessages === 0) model.warnings.push('No DBC BO_ messages were found.');
    return model;
}

function unquote(value: string): string { return value.trim().replace(/^"|"$/g, ''); }
function unescapeDbc(value: string): string { return value.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\\\/g, '\\'); }
