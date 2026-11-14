import { CFB_MAGIC, parseCfb, type CfbEntry } from '../cfb.js';
import { invalidPreview, previewParser } from '../file-preview.js';
import { decodeMarkupText, decodeWindows1252 } from '../epub/index.js';
import type { ParseOptions, ParseOutcome } from '../types.js';

export interface MsgAttachment { name: string; size: number; data: Uint8Array | undefined }
export interface MsgDocument {
    subject: string;
    from: string;
    to: string;
    cc: string;
    date: string;
    text: string;
    html: string;
    attachments: MsgAttachment[];
}

const PROPERTIES = '__properties_version1.0';
const WINDOWS_EPOCH = 116444736000000000n;

function stripTrailingNuls(value: string): string {
    let end = value.length;
    while (end && value.charCodeAt(end - 1) === 0) end--;
    return value.slice(0, end);
}

function dateValue(data: Uint8Array, tag: number): string {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let offset = 32; offset + 16 <= data.length; offset += 16) {
        if (view.getUint32(offset, true) !== tag) continue;
        const ticks = view.getBigUint64(offset + 8, true);
        const date = new Date(Number((ticks - WINDOWS_EPOCH) / 10_000n));
        return ticks && Number.isFinite(date.getTime()) ? date.toISOString() : '';
    }
    return '';
}

/** Primary language ids whose ANSI code page is not Windows-1252 (CJK, Cyrillic, Central European, Greek, Turkish, Hebrew, Arabic, Baltic, Vietnamese, Thai, …). */
const ANSI_LOCALES = new Set([0x01, 0x02, 0x04, 0x05, 0x08, 0x0d, 0x0e, 0x11, 0x12, 0x15, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1e, 0x1f, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x29, 0x2a, 0x2c, 0x2f, 0x3f, 0x40, 0x43, 0x44, 0x50, 0x6d]);
const WESTERN_CODE_PAGES = new Set([1252, 20127, 28591, 28605, 65001]);
const LEGACY_CODE_PAGES: ReadonlyMap<number, string> = new Map([
    [874, 'windows-874'],
    [932, 'shift_jis'],
    [936, 'gbk'],
    [949, 'euc-kr'],
    [950, 'big5'],
    [20866, 'koi8-r'],
    [21866, 'koi8-u'],
    [28592, 'iso-8859-2'],
    [28593, 'iso-8859-3'],
    [28594, 'iso-8859-4'],
    [28597, 'iso-8859-7'],
    [28599, 'windows-1254'],
    [28605, 'iso-8859-15'],
    [38598, 'iso-8859-8-i'],
    [50220, 'iso-2022-jp'],
    [50221, 'iso-2022-jp'],
    [51932, 'euc-jp'],
    [51949, 'euc-kr'],
    [54936, 'gb18030']
]);

export function parseMsg(input: Uint8Array, options: ParseOptions = {}): ParseOutcome<MsgDocument> {
    const parser = previewParser(input, options);
    try {
        parser.check();
        if (!CFB_MAGIC.every((byte, index) => input[index] === byte)) return invalidPreview();
        let cfb;
        try {
            cfb = parseCfb(input);
        } catch {
            return invalidPreview();
        }
        parser.requireTime();
        if (!cfb.root) return invalidPreview();
        const streams = (entries: CfbEntry[]) => new Map(entries.filter(entry => entry.type === 2).map(entry => [entry.name.toLowerCase(), entry]));
        const childrenOf = (entry: CfbEntry, cap: number) => {
            const children = cfb.children(entry, cap);
            if (children.truncated) parser.warn('truncated');
            return children.entries;
        };
        const entries = childrenOf(cfb.root, 10_000);
        const root = streams(entries);
        if (!root.has(PROPERTIES)) return invalidPreview();
        const limit = options.limits?.maxPreviewBytes ?? 8 * 1024 * 1024;
        let budget = options.limits?.maxDecompressedBytes ?? 24 * 1024 * 1024;
        const read = (entry: CfbEntry | undefined, cap = limit): Uint8Array | undefined => {
            if (!entry) return undefined;
            if (entry.size > cap || entry.size > budget) {
                parser.warn('truncated');
                return undefined;
            }
            const bytes = cfb.readStream(entry);
            budget -= bytes.length;
            if (bytes.length !== entry.size) {
                parser.warn('skipped');
                return undefined;
            }
            return bytes;
        };
        const property = (map: Map<string, CfbEntry>, id: string, type: string) => map.get(`__substg1.0_${id}${type}`.toLowerCase());
        const header = read(root.get(PROPERTIES), 1024 * 1024);
        if (!header || header.length < 32) return invalidPreview();
        const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
        let codePage: number | undefined, internetCodePage: number | undefined, localeId: number | undefined;
        for (let offset = 32; offset + 16 <= header.length; offset += 16) {
            parser.requireTime();
            const tag = headerView.getUint32(offset, true);
            if (tag === 0x3ffd0003) codePage = headerView.getUint32(offset + 8, true);
            if (tag === 0x3fde0003) internetCodePage = headerView.getUint32(offset + 8, true);
            if (tag === 0x3ff10003) localeId = headerView.getUint32(offset + 8, true);
        }
        const bodyCodePage = codePage || internetCodePage || undefined;
        // Non-Unicode Outlook messages often omit PidTagMessageCodepage; the locale or internet code page
        // still tells whether the string8 properties are outside Windows-1252.
        codePage ??= localeId !== undefined && ANSI_LOCALES.has(localeId & 0x3ff) ? 0
            : internetCodePage !== undefined && !WESTERN_CODE_PAGES.has(internetCodePage) ? 0 : undefined;
        const decodeCodePage = (bytes: Uint8Array, page: number | undefined) => {
            if (page === 1200 || page === 1201) return new TextDecoder(page === 1200 ? 'utf-16le' : 'utf-16be').decode(bytes);
            if (page === 65000 || page === 12000 || page === 12001 || page === 50222 || page === 52936) {
                parser.warn('unsupported');
                return undefined;
            }
            if (page === 65001) return new TextDecoder().decode(bytes);
            if (page === 28591) return decodeWindows1252(bytes, true);
            if (page === undefined || page === 1252 || page === 20127) return decodeWindows1252(bytes);
            const encoding = page >= 1250 && page <= 1258 ? `windows-${page}` : LEGACY_CODE_PAGES.get(page);
            if (encoding) {
                try {
                    return new TextDecoder(encoding).decode(bytes);
                } catch {
                    // Some runtimes ship a smaller set of legacy decoders.
                }
            } else if (bytes.every(byte => byte < 0x80)) return decodeWindows1252(bytes);
            parser.warn('unsupported');
            return undefined;
        };
        const getText = (map: Map<string, CfbEntry>, id: string, cap?: number, page = codePage) => {
            const unicode = read(property(map, id, '001F'), cap);
            if (unicode) return stripTrailingNuls(new TextDecoder('utf-16le').decode(unicode));
            const bytes = read(property(map, id, '001E'), cap);
            return bytes ? stripTrailingNuls(decodeCodePage(bytes, page) ?? decodeWindows1252(bytes)) : '';
        };
        const messageClass = getText(root, '001A', 4096);
        if (messageClass && !/^IPM\.Note(?:\.|$)|^REPORT\./i.test(messageClass)) parser.warn('unsupported');
        const subject = getText(root, '0037', 128 * 1024);
        let sender = getText(root, '0042', 128 * 1024);
        let address = getText(root, '5D02', 128 * 1024) || getText(root, '0065', 128 * 1024);
        if (!sender && !address) {
            sender = getText(root, '0C1A', 128 * 1024);
            address = getText(root, '5D01', 128 * 1024) || getText(root, '0C1F', 128 * 1024);
        }
        const from = sender && address && sender !== address ? `${sender} <${address}>` : sender || address;
        let to = getText(root, '0E04', 128 * 1024);
        let cc = getText(root, '0E03', 128 * 1024);
        const date = dateValue(header, 0x00390040) || dateValue(header, 0x0e060040);
        const text = getText(root, '1000', undefined, bodyCodePage ?? codePage);
        const htmlText = getText(root, '1013', undefined, bodyCodePage ?? codePage);
        const rawHtml = htmlText ? undefined : read(property(root, '1013', '0102'));
        let html = htmlText;
        if (rawHtml) {
            const decoded = internetCodePage === undefined ? undefined : decodeCodePage(rawHtml, internetCodePage);
            if (decoded !== undefined) html = decoded;
            else {
                const markup = decodeMarkupText(rawHtml);
                if (markup.unsupportedEncoding) parser.warn('unsupported');
                html = markup.text;
            }
        }
        html = stripTrailingNuls(html);
        if (!text && !html && property(root, '1009', '0102')) parser.warn('unsupported');
        const attachments: MsgAttachment[] = [];
        const recipients: { to: string[]; cc: string[] } = { to: [], cc: [] };
        let seen = 0;
        for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
            if (!parser.checkpoint()) break;
            if (entry.type !== 1 || !/^__(?:attach|recip)_version1\.0_#/.test(entry.name)) continue;
            if (seen++ >= (options.limits?.maxEntries ?? 500)) {
                parser.warn('truncated');
                break;
            }
            const children = childrenOf(entry, 1000);
            const map = streams(children);
            if (entry.name.startsWith('__recip')) {
                if (to && cc) continue;
                const name = getText(map, '39FE', 8192) || getText(map, '3003', 8192) || getText(map, '3001', 8192);
                const properties = read(map.get(PROPERTIES), 64 * 1024);
                let type = 1;
                if (properties) {
                    const view = new DataView(properties.buffer, properties.byteOffset, properties.byteLength);
                    for (let offset = 8; offset + 16 <= properties.length; offset += 16) {
                        if (view.getUint32(offset, true) === 0x0c150003) type = view.getUint32(offset + 8, true);
                    }
                }
                if (name && (type === 1 || type === 2)) recipients[type === 2 ? 'cc' : 'to'].push(name);
                continue;
            }
            const name = getText(map, '3707', 8192) || getText(map, '3704', 8192) || getText(map, '3001', 8192);
            const payload = property(map, '3701', '0102');
            if (!payload) parser.warn('unsupported');
            attachments.push({ name, size: payload?.size ?? 0, data: read(payload) });
        }
        to ||= recipients.to.join('; ');
        cc ||= recipients.cc.join('; ');
        return parser.success({ subject, from, to, cc, date, text, html, attachments });
    } catch (error) {
        return parser.failure(error);
    }
}
