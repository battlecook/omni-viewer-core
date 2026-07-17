import type { Diagnostic, ParseOutcome, ParseResult } from '../types.js';
export { DocBinaryParser } from './vscode-parser.js';

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

export interface DocTextRun { text: string; bold?: boolean; italic?: boolean; underline?: boolean }
export interface DocParagraph { kind: 'paragraph'; text: string; runs: DocTextRun[]; pageBreakBefore?: boolean }
export interface DocTable { kind: 'table'; rows: string[][] }
export interface DocImage { kind: 'image'; mimeType: string; data: Uint8Array; alt: string }
export type DocBlock = DocParagraph | DocTable | DocImage;
export interface DocSection { blocks: DocBlock[]; header?: string; footer?: string }
export interface DocBinaryDocument { sections: DocSection[]; text: string }

interface CfbEntry { name: string; type: number; startSector: number; size: number }
interface CfbReader { getStream(name: string): Uint8Array | null; listStreams(): CfbEntry[] }
interface FibInfo { tableStreamName: '0Table' | '1Table'; ccpText: number; ccpHdd: number; fcClx: number; lcbClx: number }
interface Piece { cpStart: number; cpEnd: number; byteOffset: number; compressed: boolean }

const u16 = (data: Uint8Array, offset: number): number => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset, true);
const i32 = (data: Uint8Array, offset: number): number => new DataView(data.buffer, data.byteOffset, data.byteLength).getInt32(offset, true);
const u32 = (data: Uint8Array, offset: number): number => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
const concat = (chunks: Uint8Array[]): Uint8Array => { const size = chunks.reduce((n, c) => n + c.length, 0); const out = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; } return out; };

function outcome(result: ParseResult<DocBinaryDocument>): ParseOutcome<DocBinaryDocument> {
    return { result, execution: { workerUsed: false, hardLimitEnforced: false, elapsedMillis: 0 } };
}

export function parseDocBinary(input: Uint8Array): ParseOutcome<DocBinaryDocument> {
    try {
        const cfb = parseCfb(input);
        const word = cfb.getStream('WordDocument');
        if (!word) return failed('corrupted');
        const fib = parseFib(word);
        const table = cfb.getStream(fib.tableStreamName);
        if (!table) return failed('corrupted');
        const pieces = parsePieceTable(table, fib);
        if (pieces.length === 0) return failed('corrupted');
        const decoded = decodePieces(word, pieces);
        const mainText = normalize(decoded.slice(0, fib.ccpText || decoded.length));
        const headerText = fib.ccpHdd > 0 ? normalize(decoded.slice(fib.ccpText, fib.ccpText + fib.ccpHdd)) : '';
        const diagnostics: Diagnostic[] = [];
        const blocks = buildBlocks(mainText);
        const images = extractImages(cfb);
        if (images.length) blocks.push(...images);
        const headerParts = headerText.split(/\n+/).filter(Boolean);
        const section: DocSection = { blocks };
        if (headerParts[0]) section.header = headerParts[0];
        const footer = headerParts.at(-1);
        if (headerParts.length > 1 && footer) section.footer = footer;
        if (images.length === 0 && cfb.listStreams().some((entry) => /ObjectPool|Ole10Native|Package/i.test(entry.name))) {
            diagnostics.push({ severity: 'warning', code: 'unsupported-feature', messageKey: 'diag.word.embedded-partial' });
        }
        return outcome({ status: diagnostics.length ? 'partial' : 'ok', document: { sections: [section], text: mainText }, diagnostics });
    } catch (error) {
        return outcome({ status: 'failed', failure: { code: 'invalid-format', retryable: false, messageKey: 'diag.word.invalid-format' }, diagnostics: [{ severity: 'error', code: 'parse-error', messageKey: 'diag.word.invalid-format', location: error instanceof Error ? error.message : String(error) }] });
    }
}

function failed(code: 'invalid-format' | 'corrupted'): ParseOutcome<DocBinaryDocument> {
    return outcome({ status: 'failed', failure: { code, retryable: false, messageKey: 'diag.word.invalid-format' }, diagnostics: [] });
}

function parseFib(word: Uint8Array): FibInfo {
    if (word.length < 64 || u16(word, 0) !== 0xa5ec) throw new Error('invalid FIB');
    const flags = u16(word, 10);
    const tableStreamName = ((flags >> 9) & 1) ? '1Table' : '0Table';
    let offset = 32;
    const csw = u16(word, offset); offset += 2 + csw * 2;
    const cslw = u16(word, offset); offset += 2;
    const lwOffset = offset;
    const ccpText = cslw >= 4 ? u32(word, lwOffset + 12) : 0;
    const ccpHdd = cslw >= 6 ? u32(word, lwOffset + 20) : 0;
    offset += cslw * 4;
    const pairCount = u16(word, offset); offset += 2;
    const pair = (index: number): [number, number] => index < pairCount && offset + index * 8 + 8 <= word.length ? [u32(word, offset + index * 8), u32(word, offset + index * 8 + 4)] : [0, 0];
    const [fcClx, lcbClx] = pair(33);
    return { tableStreamName, ccpText, ccpHdd, fcClx, lcbClx };
}

function parsePieceTable(table: Uint8Array, fib: FibInfo): Piece[] {
    if (fib.lcbClx <= 0 || fib.fcClx + fib.lcbClx > table.length) return scanPieceTables(table);
    const clx = table.subarray(fib.fcClx, fib.fcClx + fib.lcbClx);
    let offset = 0;
    while (offset < clx.length && clx[offset] === 1) { if (offset + 3 > clx.length) return []; offset += 3 + u16(clx, offset + 1); }
    if (clx[offset] !== 2 || offset + 5 > clx.length) return scanPieceTables(table);
    const length = u32(clx, offset + 1);
    return decodePlc(clx.subarray(offset + 5, offset + 5 + length));
}

function scanPieceTables(table: Uint8Array): Piece[] {
    let best: Piece[] = [];
    for (let offset = 0; offset + 21 < table.length; offset++) {
        if (table[offset] !== 2) continue;
        const length = u32(table, offset + 1);
        if (length < 16 || (length - 4) % 12 || offset + 5 + length > table.length) continue;
        const candidate = decodePlc(table.subarray(offset + 5, offset + 5 + length));
        if (candidate.length > best.length) best = candidate;
    }
    return best;
}

function decodePlc(plc: Uint8Array): Piece[] {
    const count = (plc.length - 4) / 12;
    if (!Number.isInteger(count) || count <= 0 || count > 200000) return [];
    const cpBytes = (count + 1) * 4;
    const pieces: Piece[] = [];
    let previous = u32(plc, 0);
    for (let index = 0; index < count; index++) {
        const next = u32(plc, (index + 1) * 4);
        if (next < previous || next - previous > 10_000_000) return [];
        const pcdOffset = cpBytes + index * 8;
        const raw = u32(plc, pcdOffset + 2);
        const compressed = (raw & 0x40000000) !== 0;
        const byteOffset = compressed ? ((raw & 0x3fffffff) >>> 1) : (raw & 0x3fffffff);
        pieces.push({ cpStart: previous, cpEnd: next, byteOffset, compressed }); previous = next;
    }
    return pieces;
}

function decodePieces(word: Uint8Array, pieces: Piece[]): string {
    const candidates = ['windows-1252', 'euc-kr', 'shift_jis'].map((encoding) => ({ encoding, parts: [] as string[] }));
    for (const piece of pieces) {
        const chars = piece.cpEnd - piece.cpStart, bytes = chars * (piece.compressed ? 1 : 2);
        if (piece.byteOffset + bytes > word.length) continue;
        const data = word.subarray(piece.byteOffset, piece.byteOffset + bytes);
        if (!piece.compressed) { const text = decodeUtf16(data); candidates.forEach((candidate) => candidate.parts.push(text)); continue; }
        for (const candidate of candidates) candidate.parts.push(decodeLegacy(data, candidate.encoding));
    }
    return candidates.map((candidate) => candidate.parts.join('')).sort((a, b) => readableScore(b) - readableScore(a))[0] ?? '';
}

function decodeUtf16(data: Uint8Array): string { let text = ''; for (let i = 0; i + 1 < data.length; i += 2) text += String.fromCharCode((data[i] ?? 0) | ((data[i + 1] ?? 0) << 8)); return text; }
const CP1252: Record<number, number> = {128:0x20ac,130:0x201a,131:0x0192,132:0x201e,133:0x2026,134:0x2020,135:0x2021,136:0x02c6,137:0x2030,138:0x0160,139:0x2039,140:0x0152,142:0x017d,145:0x2018,146:0x2019,147:0x201c,148:0x201d,149:0x2022,150:0x2013,151:0x2014,152:0x02dc,153:0x2122,154:0x0161,155:0x203a,156:0x0153,158:0x017e,159:0x0178};
function decodeCp1252(data: Uint8Array): string { let text = ''; for (const byte of data) text += String.fromCharCode(CP1252[byte] ?? byte); return text; }
function decodeLegacy(data: Uint8Array, encoding: string): string { try { return new TextDecoder(encoding).decode(data); } catch { return decodeCp1252(data); } }
function readableScore(text: string): number { const readable = (text.match(/[A-Za-z0-9가-힣ぁ-んァ-ン一-龯]/g) ?? []).length; const replacement = (text.match(/�/g) ?? []).length; const mojibake = (text.match(/[ÃÂÐÑØÞãäåæçðñøþ]/g) ?? []).length; return readable * 3 + text.length - replacement * 30 - mojibake * 12; }

function normalize(text: string): string {
    return text.replace(/[\u0002-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\u0007/g, '\t').replace(/\r/g, '\n').replace(/\u0013[^\u0014]*(?:\u0014)?/g, '').replace(/\u0015/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function buildBlocks(text: string): DocBlock[] {
    const blocks: DocBlock[] = []; let tableRows: string[][] = [];
    const flushTable = (): void => { if (tableRows.length) { blocks.push({ kind: 'table', rows: tableRows }); tableRows = []; } };
    for (const line of text.split('\n')) {
        if (line.includes('\t')) { tableRows.push(line.split('\t').map((cell) => cell.trim())); continue; }
        flushTable(); if (line.trim()) blocks.push({ kind: 'paragraph', text: line.trim(), runs: [{ text: line.trim() }] });
    }
    flushTable(); return blocks;
}

function extractImages(cfb: CfbReader): DocImage[] {
    const images: DocImage[] = [];
    for (const entry of cfb.listStreams()) {
        if (!/Data|Pictures|OfficeArt|Ole10Native|Package/i.test(entry.name)) continue;
        const stream = cfb.getStream(entry.name); if (!stream) continue;
        for (const sig of [{ bytes:[0xff,0xd8,0xff], mime:'image/jpeg', end:[0xff,0xd9] }, { bytes:[0x89,0x50,0x4e,0x47], mime:'image/png', end:[0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82] }, { bytes:[0x47,0x49,0x46,0x38], mime:'image/gif' }]) {
            const start = indexOf(stream, sig.bytes); if (start < 0) continue;
            const endAt = sig.end ? indexOf(stream, sig.end, start + sig.bytes.length) : -1;
            const end = endAt >= 0 && sig.end ? endAt + sig.end.length : stream.length;
            images.push({ kind: 'image', mimeType: sig.mime, data: stream.slice(start, end), alt: entry.name }); break;
        }
    }
    return images;
}
function indexOf(data: Uint8Array, needle: number[], from = 0): number { outer: for (let i = from; i <= data.length - needle.length; i++) { for (let j = 0; j < needle.length; j++) if (data[i + j] !== needle[j]) continue outer; return i; } return -1; }

function parseCfb(file: Uint8Array): CfbReader {
    if (file.length < 512 || !OLE_MAGIC.every((byte, index) => file[index] === byte)) throw new Error('invalid CFB');
    const sectorSize = 1 << u16(file, 30), miniSectorSize = 1 << u16(file, 32);
    if (![512, 4096].includes(sectorSize) || miniSectorSize !== 64) throw new Error('unsupported CFB');
    const numFat = u32(file, 44), firstDir = i32(file, 48), miniCutoff = u32(file, 56), firstMiniFat = i32(file, 60), numMiniFat = u32(file, 64), firstDifat = i32(file, 68), numDifat = u32(file, 72);
    const sector = (sid: number): Uint8Array => { const start = (sid + 1) * sectorSize; return sid >= 0 && start + sectorSize <= file.length ? file.subarray(start, start + sectorSize) : new Uint8Array(); };
    const difat: number[] = []; for (let i = 0; i < 109; i++) { const sid = i32(file, 76 + i * 4); if (sid >= 0) difat.push(sid); }
    let difatSid = firstDifat; for (let n = 0; n < numDifat && difatSid >= 0; n++) { const data = sector(difatSid); if (!data.length) break; for (let i = 0; i < sectorSize / 4 - 1; i++) { const sid = i32(data, i * 4); if (sid >= 0) difat.push(sid); } difatSid = i32(data, sectorSize - 4); }
    const fat: number[] = []; for (const sid of difat.slice(0, numFat)) { const data = sector(sid); for (let i = 0; i + 4 <= data.length; i += 4) fat.push(u32(data, i)); }
    const chain = (start: number): Uint8Array => { const chunks: Uint8Array[] = [], seen = new Set<number>(); let sid = start; while (sid >= 0 && sid !== ENDOFCHAIN && sid !== FREESECT && !seen.has(sid) && sid < fat.length) { seen.add(sid); const data = sector(sid); if (!data.length) break; chunks.push(data); sid = fat[sid] ?? ENDOFCHAIN; } return concat(chunks); };
    const dir = chain(firstDir), entries: CfbEntry[] = [];
    for (let offset = 0; offset + 128 <= dir.length; offset += 128) { const nameLength = u16(dir, offset + 64); const name = decodeUtf16(dir.subarray(offset, offset + Math.max(0, nameLength - 2))).replace(/\0/g, ''); const type = dir[offset + 66] ?? 0; const startSector = i32(dir, offset + 116); const size = u32(dir, offset + 120); entries.push({ name, type, startSector, size }); }
    const root = entries.find((entry) => entry.type === 5); const miniStream = root ? chain(root.startSector).subarray(0, root.size) : new Uint8Array(); const miniFatBytes = chain(firstMiniFat); const miniFat: number[] = []; for (let i = 0; i + 4 <= miniFatBytes.length && i / 4 < numMiniFat * sectorSize / 4; i += 4) miniFat.push(u32(miniFatBytes, i));
    const miniChain = (start: number, size: number): Uint8Array => { const chunks: Uint8Array[] = [], seen = new Set<number>(); let sid = start; while (sid >= 0 && sid !== ENDOFCHAIN && sid !== FREESECT && !seen.has(sid) && sid < miniFat.length) { seen.add(sid); const offset = sid * miniSectorSize; if (offset + miniSectorSize > miniStream.length) break; chunks.push(miniStream.subarray(offset, offset + miniSectorSize)); sid = miniFat[sid] ?? ENDOFCHAIN; } return concat(chunks).subarray(0, size); };
    const streams = entries.filter((entry) => entry.type === 2 && entry.name);
    return { getStream(name) { const entry = streams.find((item) => item.name === name); if (!entry) return null; return entry.size < miniCutoff ? miniChain(entry.startSector, entry.size) : chain(entry.startSector).subarray(0, entry.size); }, listStreams() { return streams.slice(); } };
}
