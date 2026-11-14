export const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
const END = 0xfffffffe;
const FREE = 0xffffffff;

export interface CfbEntry {
    name: string;
    type: number;
    size: number;
    startSector: number;
    left: number;
    right: number;
    child: number;
}
export interface CfbReader {
    root: CfbEntry | undefined;
    getStream(name: string): Uint8Array | null;
    readStream(entry: CfbEntry): Uint8Array;
    children(entry: CfbEntry, maxEntries: number): { entries: CfbEntry[]; truncated: boolean };
    listStreams(): CfbEntry[];
}

export function parseCfb(file: Uint8Array, maxDirectoryEntries = Infinity): CfbReader {
    if (file.length < 512 || !CFB_MAGIC.every((byte, index) => file[index] === byte)) throw new Error('invalid CFB');
    // Preserve Uint8Array slice semantics even when a Node host supplies Buffer.
    file = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const header = (offset: number) => view.getUint32(offset, true);
    const shift = view.getUint16(30, true);
    if ((shift !== 9 && shift !== 12) || view.getUint16(32, true) !== 6) throw new Error('unsupported CFB');
    const sectorSize = 2 ** shift, miniSize = 64;
    const sectorCount = Math.max(0, Math.floor(file.length / sectorSize) - 1);
    const sector = (id: number) => id < sectorCount ? file.subarray((id + 1) * sectorSize, (id + 2) * sectorSize) : undefined;
    const table = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fatSectors = new Set<number>();
    const maxFat = Math.min(header(44), sectorCount);
    for (let index = 0; index < 109 && fatSectors.size < maxFat; index++) {
        const id = header(76 + index * 4);
        if (id < sectorCount) fatSectors.add(id);
    }
    let next = header(68);
    const difat = new Set<number>();
    for (let index = 0; index < header(72) && next < sectorCount && !difat.has(next) && fatSectors.size < maxFat; index++) {
        difat.add(next);
        const part = table(sector(next)!);
        for (let offset = 0; offset < sectorSize - 4 && fatSectors.size < maxFat; offset += 4) {
            const id = part.getUint32(offset, true);
            if (id < sectorCount) fatSectors.add(id);
        }
        next = part.getUint32(sectorSize - 4, true);
    }
    const fat = [...fatSectors].map(id => table(sector(id)!));
    const fatNext = (id: number) => {
        const offset = id * 4;
        return fat[Math.floor(offset / sectorSize)]?.getUint32(offset % sectorSize, true) ?? END;
    };
    const chain = (start: number, get: (id: number) => Uint8Array | undefined, follow: (id: number) => number, limit: number) => {
        const chunks: Uint8Array[] = [];
        const seen = new Set<number>();
        let id = start, size = 0;
        while (id !== END && id !== FREE && !seen.has(id) && size < limit) {
            const bytes = get(id);
            if (!bytes) break;
            seen.add(id);
            const chunk = bytes.subarray(0, limit - size);
            chunks.push(chunk);
            size += chunk.length;
            id = follow(id);
        }
        if (chunks.length === 1) return chunks[0]!;
        const result = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    };
    const directory = chain(header(48), sector, fatNext, Math.min(file.length, maxDirectoryEntries * 128));
    const dir = table(directory);
    const entries: CfbEntry[] = [];
    const decoder = new TextDecoder('utf-16le');
    for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
        const length = dir.getUint16(offset + 64, true);
        const name = length >= 2 && length <= 64 && length % 2 === 0 ? decoder.decode(directory.subarray(offset, offset + length - 2)).replace(/\0/g, '') : '';
        entries.push({
            name, type: dir.getUint8(offset + 66),
            size: shift === 9 ? dir.getUint32(offset + 120, true) : Number(dir.getBigUint64(offset + 120, true)),
            startSector: dir.getUint32(offset + 116, true),
            left: dir.getUint32(offset + 68, true), right: dir.getUint32(offset + 72, true),
            child: dir.getUint32(offset + 76, true)
        });
    }
    const root = entries.find(entry => entry.type === 5);
    const miniCutoff = header(56);
    let miniStream: Uint8Array | undefined;
    let miniFat: DataView | undefined;
    const readStream = (entry: CfbEntry) => {
        if (entry.size >= miniCutoff) return chain(entry.startSector, sector, fatNext, entry.size);
        miniStream ??= root ? chain(root.startSector, sector, fatNext, root.size) : new Uint8Array();
        miniFat ??= table(chain(header(60), sector, fatNext, Math.min(header(64), sectorCount) * sectorSize));
        return chain(entry.startSector, id => {
            const offset = id * miniSize;
            return offset + miniSize <= miniStream!.length ? miniStream!.subarray(offset, offset + miniSize) : undefined;
        }, id => id * 4 + 4 <= miniFat!.byteLength ? miniFat!.getUint32(id * 4, true) : END, entry.size);
    };
    const streams = entries.filter(entry => entry.type === 2 && entry.name);
    return {
        root, readStream,
        getStream(name) {
            const entry = streams.find(item => item.name === name);
            return entry ? readStream(entry) : null;
        },
        children(entry, maxEntries) {
            const children: CfbEntry[] = [];
            const pending = [entry.child];
            const seen = new Set<number>();
            while (pending.length) {
                const id = pending.pop()!;
                const child = entries[id];
                if (!child || seen.has(id) || child === entry || child === root) continue;
                if (seen.size >= maxEntries) return { entries: children, truncated: true };
                seen.add(id);
                if (child.name && (child.type === 1 || child.type === 2)) children.push(child);
                pending.push(child.right, child.left);
            }
            return { entries: children, truncated: false };
        },
        listStreams: () => streams.slice()
    };
}
