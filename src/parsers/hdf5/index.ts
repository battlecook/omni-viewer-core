export interface Hdf5SummaryItem {
    label: string;
    value: string | number;
}

export interface Hdf5Table {
    title: string;
    headers: string[];
    rows: Array<Array<string | number>>;
}

export interface Hdf5Document {
    format: 'HDF5';
    title: string;
    fileSize: string;
    summary: Hdf5SummaryItem[];
    tables: Hdf5Table[];
    rawPreview?: string | undefined;
    warnings: string[];
}

/**
 * One decoded attribute of a group or dataset.
 *
 * Attributes are where format-specific metadata lives (Keras keeps its model
 * config and layer names there), so string and fixed-width numeric values are
 * decoded; anything else is reported by datatype only, with `values` empty.
 */
export interface Hdf5Attribute {
    name: string;
    /** Datatype class name — 'String', 'Integer', 'Float', … */
    type: string;
    /** Dataspace dimensions; empty for a scalar attribute. */
    shape: number[];
    values: Array<string | number>;
    /** true when the datatype is not decoded, or a budget stopped decoding. */
    truncated: boolean;
}

/** A group or dataset with its attributes, for format-specific readers. */
export interface Hdf5Object {
    path: string;
    kind: EntryKind;
    /** Human-readable dimensions ('3 × 4', 'scalar'). */
    shape: string;
    /** Numeric dimensions when the dataspace was decoded. */
    dimensions: number[];
    type: string;
    elementSize: number;
    attributes: Hdf5Attribute[];
}

export interface Hdf5ObjectTree {
    objects: Hdf5Object[];
    warnings: string[];
    /** true when an inspection limit stopped the traversal early. */
    truncated: boolean;
}

/**
 * Minimal HDF5 (.h5/.hdf5) structure reader.
 *
 * It validates the file signature, decodes the superblock and walks the object
 * header hierarchy to enumerate the groups and datasets stored in the file.
 *
 * Only metadata (superblock, B-trees, local heaps, object headers) is read, and
 * it is read on demand through an {@link Hdf5Reader} rather than by loading the
 * whole file. This keeps inspection of multi-gigabyte/terabyte HDF5 files cheap
 * because the large dataset payloads are never touched.
 *
 * Superblock versions 0 and 1 use the classic B-tree + local heap + symbol
 * table layout and are traversed fully. Superblock versions 2 and 3 use version
 * 2 object headers ("OHDR"); compact link messages are decoded, while groups
 * that keep their links in a fractal heap (dense storage) are reported with a
 * warning because that index is not walked here.
 */

const HDF5_SIGNATURE = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
const UNDEFINED_ADDRESS = -1;
const EMPTY = new Uint8Array(0);

const MAX_ENTRIES = 5000;
// Object-tree reads (readObjects) enumerate metadata only, and formats layered
// on HDF5 legitimately reach far more objects than a document view ever shows:
// a Keras model spends four objects per layer, so a deep one needs tens of
// thousands before its parameter counts stop being complete.
// 100k objects is ~25k layers of headroom while capping the retained tree at
// tens of megabytes.
const MAX_OBJECT_ENTRIES = 100_000;
const MAX_OBJECT_NODES = 200_000;
const MAX_DEPTH = 64;
const MAX_NODES = 20000;
// Object header message blocks are tiny; cap reads to guard against corrupt sizes.
const MAX_BLOCK_BYTES = 32 * 1024 * 1024;
// Link names are almost always short; the heap is read in windows of this size
// and a name is abandoned past the cap so a heap without a terminator cannot
// walk the whole file.
const HEAP_STRING_WINDOW = 1024;
const MAX_LINK_NAME_BYTES = 64 * 1024;

export type EntryKind = 'Group' | 'Dataset' | 'Unknown';

// Attribute decoding budgets. Keras stores a whole model config as one string
// attribute, so single values are allowed to be large while the per-file total
// stays bounded.
const MAX_ATTRIBUTES_PER_OBJECT = 256;
// Ceiling on attributes retained for one file. Distinct objects each holding
// the per-object maximum would otherwise scale with the raised object cap.
const MAX_TOTAL_ATTRIBUTES = 250_000;
const MAX_ATTRIBUTE_ELEMENTS = 8192;
const MAX_ATTRIBUTE_VALUE_BYTES = 8 * 1024 * 1024;
const MAX_ATTRIBUTE_TOTAL_BYTES = 32 * 1024 * 1024;
// Global heap collections are indexed on first use; both caps bound what a
// crafted file can make the index hold.
const MAX_CACHED_GLOBAL_HEAPS = 8;
const MAX_GLOBAL_HEAP_OBJECTS = 65_536;

/** Random-access view over the bytes of an HDF5 file. */
export interface Hdf5Reader {
    readonly size: number;
    /** Reads up to `length` bytes at absolute `offset`. May return fewer bytes near EOF. */
    read(offset: number, length: number): Uint8Array;
    close(): void;
}

/** Reader backed by an in-memory byte array. */
export class Hdf5Uint8ArrayReader implements Hdf5Reader {
    public readonly size: number;

    constructor(private readonly buffer: Uint8Array) {
        this.size = buffer.length;
    }

    public read(offset: number, length: number): Uint8Array {
        const start = Math.max(0, offset);
        const end = Math.min(offset + length, this.size);
        return end <= start ? EMPTY : this.buffer.subarray(start, end);
    }

    public close(): void {
        // Nothing to release for an in-memory buffer.
    }
}

interface Hdf5Entry {
    path: string;
    kind: EntryKind;
    shape: string;
    dimensions: number[];
    type: string;
    elementSize: number;
    attributes: Hdf5Attribute[];
}

interface Hdf5Message {
    type: number;
    data: Uint8Array;
}

interface Superblock {
    version: number;
    sizeOfOffsets: number;
    sizeOfLengths: number;
    baseAddress: number;
    endOfFile: number;
    rootHeaderAddress: number;
}

const DATATYPE_CLASS_NAMES: Record<number, string> = {
    0: 'Integer',
    1: 'Float',
    2: 'Time',
    3: 'String',
    4: 'Bitfield',
    5: 'Opaque',
    6: 'Compound',
    7: 'Reference',
    8: 'Enum',
    9: 'Variable-length',
    10: 'Array'
};

// HDF5 object header message type identifiers.
const MSG_DATASPACE = 0x0001;
const MSG_DATATYPE = 0x0003;
const MSG_LINK = 0x0006;
const MSG_DATA_LAYOUT = 0x0008;
const MSG_ATTRIBUTE = 0x000c;
const MSG_ATTRIBUTE_INFO = 0x0015;
const MSG_CONTINUATION = 0x0010;
const MSG_SYMBOL_TABLE = 0x0011;

export class Hdf5Parser {
    private readonly reader: Hdf5Reader;
    private readonly entries: Hdf5Entry[] = [];
    private readonly warnings: string[] = [];
    private superblock: Superblock | null = null;
    private nodeBudget = MAX_NODES;
    private entryLimit = MAX_ENTRIES;
    private truncated = false;
    /** Attribute decoding is opt-in: the document view never shows attributes,
     *  and skipping them keeps the common traversal free of global-heap reads. */
    private readAttributes = false;
    private attributeByteBudget = MAX_ATTRIBUTE_TOTAL_BYTES;
    private readonly globalHeaps = new Map<number, Map<number, { offset: number; size: number }> | null>();
    private denseAttributesReported = false;
    private readonly attributesByHeader = new Map<number, Hdf5Attribute[]>();
    private attributeCount = 0;

    private constructor(reader: Hdf5Reader) {
        this.reader = reader;
    }

    /** Parses HDF5 metadata through a random-access reader without reading dataset payloads. */
    public static parseReader(reader: Hdf5Reader, fileSize = formatFileSize(reader.size)): Hdf5Document {
        return new Hdf5Parser(reader).build(fileSize);
    }

    /** Parses an in-memory HDF5 byte array. */
    public static parse(buffer: Uint8Array, fileSize = formatFileSize(buffer.byteLength)): Hdf5Document {
        return new Hdf5Parser(new Hdf5Uint8ArrayReader(buffer)).build(fileSize);
    }

    /**
     * Walks the object hierarchy and returns every group and dataset together
     * with its decoded attributes, for readers of formats that store their
     * metadata in HDF5 attributes (Keras). Dataset payloads are still not read.
     */
    public static readObjects(reader: Hdf5Reader): Hdf5ObjectTree {
        const parser = new Hdf5Parser(reader);
        parser.readAttributes = true;
        parser.entryLimit = MAX_OBJECT_ENTRIES;
        parser.nodeBudget = MAX_OBJECT_NODES;
        parser.walk();
        return {
            objects: parser.entries.map(entry => ({
                path: entry.path,
                kind: entry.kind,
                shape: entry.shape,
                dimensions: entry.dimensions,
                type: entry.type,
                elementSize: entry.elementSize,
                attributes: entry.attributes
            })),
            warnings: [...parser.warnings],
            truncated: parser.truncated || parser.nodeBudget <= 0
        };
    }

    private build(fileSize: string): Hdf5Document {
        const signatureOffset = this.findSignature();
        if (signatureOffset < 0) {
            return {
                format: 'HDF5',
                title: 'Hierarchical Data Format 5',
                fileSize,
                summary: [{ label: 'Signature', value: 'not found' }],
                tables: [this.headerPreviewTable()],
                warnings: ['The file does not start with the expected HDF5 signature (\\x89HDF\\r\\n\\x1a\\n).']
            };
        }

        this.walk();
        return this.toModel(fileSize);
    }

    /** Locates the superblock and traverses the object hierarchy from the root. */
    private walk(): void {
        const signatureOffset = this.findSignature();
        if (signatureOffset < 0) {
            this.warnings.push('The file does not start with the expected HDF5 signature (\\x89HDF\\r\\n\\x1a\\n).');
            return;
        }
        try {
            this.superblock = this.parseSuperblock(signatureOffset);
            if (this.superblock.rootHeaderAddress !== UNDEFINED_ADDRESS) {
                this.visitObject(this.superblock.rootHeaderAddress, '/', 0, new Set<number>());
            }
        } catch (error) {
            this.warnings.push(`Structure parsing stopped: ${error instanceof Error ? error.message : 'unknown error'}.`);
        }
    }

    private toModel(fileSize: string): Hdf5Document {
        const sb = this.superblock;
        const datasets = this.entries.filter(entry => entry.kind === 'Dataset');
        const groups = this.entries.filter(entry => entry.kind === 'Group');

        const summary: Hdf5Document['summary'] = [
            { label: 'Superblock version', value: sb ? sb.version : '-' },
            { label: 'Groups', value: groups.length },
            { label: 'Datasets', value: datasets.length },
            { label: 'Size of offsets', value: sb ? sb.sizeOfOffsets : '-' }
        ];

        const tables: Hdf5Document['tables'] = [];

        if (sb) {
            tables.push({
                title: 'Superblock',
                headers: ['Field', 'Value'],
                rows: [
                    ['Version', sb.version],
                    ['Size of offsets', sb.sizeOfOffsets],
                    ['Size of lengths', sb.sizeOfLengths],
                    ['Base address', formatAddress(sb.baseAddress)],
                    ['End of file address', formatAddress(sb.endOfFile)],
                    ['Root group header', formatAddress(sb.rootHeaderAddress)]
                ]
            });
        }

        tables.push({
            title: `Datasets (${datasets.length})`,
            headers: ['Path', 'Shape', 'Type', 'Element bytes'],
            rows: datasets.length > 0
                ? datasets.map(entry => [entry.path, entry.shape, entry.type, entry.elementSize])
                : [['-', '-', 'No datasets were decoded from the file structure.', '-']]
        });

        tables.push({
            title: `Groups (${groups.length})`,
            headers: ['Path', 'Kind'],
            rows: groups.length > 0
                ? groups.map(entry => [entry.path, entry.kind])
                : [['/', 'Group']]
        });

        tables.push(this.headerPreviewTable());

        const warnings = [...this.warnings];
        if (this.truncated || this.nodeBudget <= 0) {
            warnings.push('Traversal stopped early because the file structure exceeded the inspection limits.');
        }
        if (sb && (sb.version === 2 || sb.version === 3)) {
            warnings.push('Superblock version 2/3 detected: links stored in dense (fractal heap) indexes are not enumerated.');
        }

        return {
            format: 'HDF5',
            title: 'Hierarchical Data Format 5',
            fileSize,
            summary,
            tables,
            rawPreview: this.buildTreePreview(),
            warnings
        };
    }

    private headerPreviewTable(): Hdf5Document['tables'][number] {
        const preview = this.reader.read(0, 256);
        return {
            title: 'Header preview',
            headers: ['Offset', 'Hex', 'ASCII'],
            rows: hexRows(preview, 0, preview.length)
        };
    }

    private buildTreePreview(): string | undefined {
        if (this.entries.length === 0) {
            return undefined;
        }
        const lines = this.entries
            .slice()
            .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
            .map(entry => {
                const depth = entry.path === '/' ? 0 : entry.path.split('/').filter(Boolean).length;
                const indent = '  '.repeat(Math.max(0, depth));
                const name = entry.path === '/' ? '/' : entry.path.split('/').filter(Boolean).pop() ?? entry.path;
                if (entry.kind === 'Dataset') {
                    return `${indent}${name}  [${entry.shape}] ${entry.type}`;
                }
                return `${indent}${name}/`;
            });
        const text = lines.join('\n');
        return text.length > 20000 ? `${text.slice(0, 20000)}\n\n... preview truncated ...` : text;
    }

    private findSignature(): number {
        let offset = 0;
        while (offset + HDF5_SIGNATURE.length <= this.reader.size) {
            const buf = this.reader.read(offset, HDF5_SIGNATURE.length);
            if (buf.length === HDF5_SIGNATURE.length && HDF5_SIGNATURE.every((byte, index) => buf[index] === byte)) {
                return offset;
            }
            // The signature may follow a user block placed at 0, 512, 1024, 2048, ...
            offset = offset === 0 ? 512 : offset * 2;
        }
        return -1;
    }

    private parseSuperblock(offset: number): Superblock {
        const sb = this.reader.read(offset, 256);
        if (sb.length < 12) throw new Error('truncated superblock');
        const version = byteAt(sb, 8);

        if (version === 0 || version === 1) {
            const sizeOfOffsets = byteAt(sb, 13);
            const sizeOfLengths = byteAt(sb, 14);
            this.validateAddressSizes(sizeOfOffsets, sizeOfLengths);
            let p = 24;
            if (version === 1) {
                p += 4; // Indexed storage internal node K (2 bytes) + reserved (2 bytes)
            }
            const baseAddress = readOffsetBuf(sb, p, sizeOfOffsets); p += sizeOfOffsets;
            p += sizeOfOffsets; // Free-space info address
            const endOfFile = readOffsetBuf(sb, p, sizeOfOffsets); p += sizeOfOffsets;
            p += sizeOfOffsets; // Driver information block address
            p += sizeOfOffsets; // Root symbol table entry: link name offset
            const rootHeaderAddress = readOffsetBuf(sb, p, sizeOfOffsets);
            return { version, sizeOfOffsets, sizeOfLengths, baseAddress, endOfFile, rootHeaderAddress };
        }

        if (version === 2 || version === 3) {
            const sizeOfOffsets = byteAt(sb, 9);
            const sizeOfLengths = byteAt(sb, 10);
            this.validateAddressSizes(sizeOfOffsets, sizeOfLengths);
            let p = 12;
            const baseAddress = readOffsetBuf(sb, p, sizeOfOffsets); p += sizeOfOffsets;
            p += sizeOfOffsets; // Superblock extension address
            const endOfFile = readOffsetBuf(sb, p, sizeOfOffsets); p += sizeOfOffsets;
            const rootHeaderAddress = readOffsetBuf(sb, p, sizeOfOffsets);
            return { version, sizeOfOffsets, sizeOfLengths, baseAddress, endOfFile, rootHeaderAddress };
        }

        throw new Error(`unsupported superblock version ${version}`);
    }

    private validateAddressSizes(sizeOfOffsets: number, sizeOfLengths: number): void {
        if (sizeOfOffsets < 1 || sizeOfOffsets > 8 || sizeOfLengths < 1 || sizeOfLengths > 8) {
            throw new Error('invalid HDF5 offset/length size');
        }
    }

    private visitObject(headerAddress: number, path: string, depth: number, ancestors: Set<number>): void {
        if (headerAddress === UNDEFINED_ADDRESS || depth > MAX_DEPTH || this.entries.length >= this.entryLimit) {
            if (this.entries.length >= this.entryLimit) {
                this.truncated = true;
            }
            return;
        }
        if (ancestors.has(headerAddress)) {
            return; // Guard against cyclic links.
        }
        if (--this.nodeBudget <= 0) {
            this.truncated = true;
            return;
        }

        const messages = this.readObjectHeader(headerAddress);
        const dataspace = messages.find(message => message.type === MSG_DATASPACE);
        const datatype = messages.find(message => message.type === MSG_DATATYPE);
        const hasLayout = messages.some(message => message.type === MSG_DATA_LAYOUT);
        const symbolTable = messages.find(message => message.type === MSG_SYMBOL_TABLE);
        const linkMessages = messages.filter(message => message.type === MSG_LINK);

        const isDataset = Boolean(datatype && (dataspace || hasLayout));
        // HDF5 hard links let many paths share one object header. Decoding its
        // attributes once and sharing the result keeps a file with thousands of
        // links to an attribute-rich object from multiplying the retained set.
        const attributes = this.readAttributes ? this.attributesFor(headerAddress, messages) : [];

        if (isDataset) {
            this.entries.push({
                path,
                kind: 'Dataset',
                shape: dataspace ? this.describeDataspace(dataspace.data) : 'scalar',
                dimensions: dataspace ? this.dataspaceDimensions(dataspace.data) : [],
                type: datatype ? this.describeDatatype(datatype.data) : 'unknown',
                elementSize: datatype ? this.datatypeSize(datatype.data) : 0,
                attributes
            });
            return;
        }

        // Anything that is not a dataset is treated as a group node.
        this.entries.push({ path, kind: 'Group', shape: '-', dimensions: [], type: '-', elementSize: 0, attributes });

        const nextAncestors = new Set(ancestors).add(headerAddress);
        const children: Array<{ name: string; address: number }> = [];

        if (symbolTable) {
            children.push(...this.readSymbolTable(symbolTable.data));
        }
        for (const link of linkMessages) {
            const decoded = this.decodeLinkMessage(link.data);
            if (decoded) {
                children.push(decoded);
            }
        }

        for (const child of children) {
            const childPath = path === '/' ? `/${child.name}` : `${path}/${child.name}`;
            this.visitObject(child.address, childPath, depth + 1, nextAncestors);
        }
    }

    private readObjectHeader(address: number): Hdf5Message[] {
        const start = this.resolve(address);
        if (start < 0 || start >= this.reader.size) {
            return [];
        }
        if (this.matchesAscii(start, 'OHDR')) {
            return this.readObjectHeaderV2(start);
        }
        return this.readObjectHeaderV1(start);
    }

    private readObjectHeaderV1(start: number): Hdf5Message[] {
        const prefix = this.reader.read(start, 16);
        if (prefix.length < 16) {
            return [];
        }
        const totalMessages = readU16(prefix, 2);
        // 16-byte prefix: version, reserved, message count, ref count, header size, padding.
        const blocks: Array<{ offset: number; length: number }> = [{ offset: start + 16, length: readU32(prefix, 8) }];
        return this.collectMessages(blocks, totalMessages + 256, { version2: false, creationOrderBytes: 0 });
    }

    private readObjectHeaderV2(start: number): Hdf5Message[] {
        const head = this.reader.read(start, 64);
        if (head.length < 6) {
            return [];
        }
        const flags = byteAt(head, 5);
        let p = 6;
        if (flags & 0x20) {
            p += 16; // Access, modification, change, and birth times.
        }
        if (flags & 0x10) {
            p += 4; // Max compact / min dense attribute counts.
        }
        const chunkSizeBytes = 1 << (flags & 0x03);
        const chunkSize = readLittleBuf(head, p, chunkSizeBytes);
        p += chunkSizeBytes;
        const trackOrder = (flags & 0x04) !== 0;
        const blocks: Array<{ offset: number; length: number }> = [{ offset: start + p, length: chunkSize }];
        return this.collectMessages(blocks, MAX_ENTRIES, { version2: true, creationOrderBytes: trackOrder ? 2 : 0 });
    }

    private collectMessages(
        blocks: Array<{ offset: number; length: number }>,
        maxMessages: number,
        options: { version2: boolean; creationOrderBytes: number }
    ): Hdf5Message[] {
        const messages: Hdf5Message[] = [];
        const visited = new Set<number>();
        const headerSize = options.version2 ? 4 : 8;
        let guard = 0;

        while (blocks.length > 0 && messages.length < maxMessages && guard++ < 4096) {
            const block = blocks.shift()!;
            const region = this.reader.read(block.offset, Math.min(block.length, MAX_BLOCK_BYTES));
            let p = 0;
            while (p + headerSize <= region.length) {
                const type = options.version2 ? byteAt(region, p) : readU16(region, p);
                const size = options.version2 ? readU16(region, p + 1) : readU16(region, p + 2);
                // Version 2 message headers add a creation-order field when the header tracks order.
                const dataStart = p + headerSize + options.creationOrderBytes;
                if (dataStart + size > region.length) {
                    break;
                }
                const data = region.subarray(dataStart, dataStart + size);
                if (type === MSG_CONTINUATION) {
                    this.queueContinuation(blocks, visited, data, options.version2);
                } else {
                    messages.push({ type, data });
                }
                p = dataStart + size;
            }
        }
        return messages;
    }

    private queueContinuation(blocks: Array<{ offset: number; length: number }>, visited: Set<number>, data: Uint8Array, version2: boolean): void {
        const contAddress = readOffsetBuf(data, 0, this.sizeOfOffsets());
        const contLength = readLittleBuf(data, this.sizeOfOffsets(), this.sizeOfLengths());
        const contStart = this.resolve(contAddress);
        if (contAddress === UNDEFINED_ADDRESS || contStart < 0 || visited.has(contStart)) {
            return;
        }
        visited.add(contStart);
        if (version2) {
            // Version 2 continuation blocks carry an "OCHK" signature (4 bytes) + trailing checksum (4 bytes).
            if (!this.matchesAscii(contStart, 'OCHK')) {
                return;
            }
            blocks.push({ offset: contStart + 4, length: Math.max(0, contLength - 8) });
        } else {
            blocks.push({ offset: contStart, length: contLength });
        }
    }

    private readSymbolTable(data: Uint8Array): Array<{ name: string; address: number }> {
        const sizeOfOffsets = this.sizeOfOffsets();
        const btreeAddress = readOffsetBuf(data, 0, sizeOfOffsets);
        const heapAddress = readOffsetBuf(data, sizeOfOffsets, sizeOfOffsets);
        const heapDataStart = this.readLocalHeapDataStart(heapAddress);
        if (heapDataStart < 0) {
            return [];
        }
        const snodAddresses: number[] = [];
        this.collectSymbolTableNodes(btreeAddress, snodAddresses, new Set<number>());

        const children: Array<{ name: string; address: number }> = [];
        for (const snodAddress of snodAddresses) {
            children.push(...this.readSymbolTableNode(snodAddress, heapDataStart));
        }
        return children;
    }

    private collectSymbolTableNodes(address: number, output: number[], visited: Set<number>): void {
        const start = this.resolve(address);
        if (address === UNDEFINED_ADDRESS || start < 0 || visited.has(start) || output.length > this.entryLimit) {
            return;
        }
        visited.add(start);
        if (!this.matchesAscii(start, 'TREE')) {
            return;
        }
        const sizeOfOffsets = this.sizeOfOffsets();
        const sizeOfLengths = this.sizeOfLengths();
        // Header: signature(4) + node type(1) + level(1) + entries used(2) + left(off) + right(off).
        const headerSize = 8 + sizeOfOffsets * 2;
        const header = this.reader.read(start, headerSize);
        if (header.length < 8) {
            return;
        }
        const nodeLevel = byteAt(header, 5);
        const entriesUsed = readU16(header, 6);
        // Keys and children: key0, [child, key] * entriesUsed. Group-node keys are heap offsets.
        const regionLength = sizeOfLengths + entriesUsed * (sizeOfOffsets + sizeOfLengths);
        const region = this.reader.read(start + headerSize, regionLength);
        let p = sizeOfLengths; // The first key precedes the first child pointer.
        for (let i = 0; i < entriesUsed; i++) {
            const childAddress = readOffsetBuf(region, p, sizeOfOffsets);
            p += sizeOfOffsets + sizeOfLengths; // Child pointer + following key.
            if (nodeLevel > 0) {
                this.collectSymbolTableNodes(childAddress, output, visited);
            } else if (childAddress !== UNDEFINED_ADDRESS) {
                output.push(childAddress);
            }
        }
    }

    private readSymbolTableNode(address: number, heapDataStart: number): Array<{ name: string; address: number }> {
        const start = this.resolve(address);
        if (start < 0 || !this.matchesAscii(start, 'SNOD')) {
            return [];
        }
        const header = this.reader.read(start, 8);
        if (header.length < 8) {
            return [];
        }
        const count = readU16(header, 6);
        const sizeOfOffsets = this.sizeOfOffsets();
        const entrySize = sizeOfOffsets * 2 + 8 + 16; // Name offset + header address + cache type + reserved + scratch pad.
        const region = this.reader.read(start + 8, count * entrySize);
        const children: Array<{ name: string; address: number }> = [];
        for (let i = 0; i < count; i++) {
            const base = i * entrySize;
            const nameOffset = readOffsetBuf(region, base, sizeOfOffsets);
            const headerAddress = readOffsetBuf(region, base + sizeOfOffsets, sizeOfOffsets);
            const name = this.readHeapString(heapDataStart + nameOffset);
            if (name && headerAddress !== UNDEFINED_ADDRESS) {
                children.push({ name, address: headerAddress });
            }
        }
        return children;
    }

    private readLocalHeapDataStart(address: number): number {
        const start = this.resolve(address);
        if (start < 0 || !this.matchesAscii(start, 'HEAP')) {
            return -1;
        }
        const sizeOfOffsets = this.sizeOfOffsets();
        const sizeOfLengths = this.sizeOfLengths();
        // signature(4) + version(1) + reserved(3) + data segment size + free-list head + data segment address.
        const buf = this.reader.read(start + 8 + sizeOfLengths * 2, sizeOfOffsets);
        const dataSegmentAddress = readOffsetBuf(buf, 0, sizeOfOffsets);
        return this.resolve(dataSegmentAddress);
    }

    private decodeLinkMessage(data: Uint8Array): { name: string; address: number } | null {
        if (data.length < 2 || data[0] !== 1) {
            return null;
        }
        const flags = byteAt(data, 1);
        let p = 2;
        let linkType = 0;
        if (flags & 0x08) {
            linkType = byteAt(data, p);
            p += 1;
        }
        if (flags & 0x04) {
            p += 8; // Creation order.
        }
        if (flags & 0x10) {
            p += 1; // Link name character set.
        }
        const lengthFieldSize = 1 << (flags & 0x03);
        if (p + lengthFieldSize > data.length) {
            return null;
        }
        const nameLength = readLittleBuf(data, p, lengthFieldSize);
        p += lengthFieldSize;
        if (p + nameLength > data.length) {
            return null;
        }
        const name = decodeUtf8(data.subarray(p, p + nameLength));
        p += nameLength;
        if (linkType !== 0) {
            return null; // Only hard links point straight at an object header.
        }
        const address = readOffsetBuf(data, p, this.sizeOfOffsets());
        if (address === UNDEFINED_ADDRESS) {
            return null;
        }
        return { name, address };
    }

    private describeDataspace(data: Uint8Array): string {
        if (data.length < 2) {
            return 'scalar';
        }
        const version = byteAt(data, 0);
        const rank = byteAt(data, 1);
        if (rank === 0) {
            return 'scalar';
        }
        const sizeOfLengths = this.sizeOfLengths();
        // v1: version, rank, flags, reserved, reserved(4). v2: version, rank, flags, type.
        let p = version >= 2 ? 4 : 8;
        const dims: number[] = [];
        for (let i = 0; i < rank && p + sizeOfLengths <= data.length; i++) {
            dims.push(readLittleBuf(data, p, sizeOfLengths));
            p += sizeOfLengths;
        }
        return dims.length > 0 ? dims.join(' × ') : `rank ${rank}`;
    }

    /** Numeric dimensions of a dataspace message; empty for a scalar. */
    private dataspaceDimensions(data: Uint8Array): number[] {
        if (data.length < 2) return [];
        const version = byteAt(data, 0);
        const rank = byteAt(data, 1);
        if (rank === 0) return [];
        const sizeOfLengths = this.sizeOfLengths();
        let p = version >= 2 ? 4 : 8;
        const dims: number[] = [];
        for (let i = 0; i < rank && p + sizeOfLengths <= data.length; i++) {
            dims.push(readLittleBuf(data, p, sizeOfLengths));
            p += sizeOfLengths;
        }
        return dims;
    }

    /** Decoded attributes of an object header, shared across links to it. */
    private attributesFor(headerAddress: number, messages: Hdf5Message[]): Hdf5Attribute[] {
        const cached = this.attributesByHeader.get(headerAddress);
        if (cached) return cached;
        const decoded = this.decodeAttributes(messages);
        // The cache is what makes hard links cheap, so it is only bounded by
        // the number of distinct headers the traversal already admits.
        this.attributesByHeader.set(headerAddress, decoded);
        this.attributeCount += decoded.length;
        return decoded;
    }

    private decodeAttributes(messages: Hdf5Message[]): Hdf5Attribute[] {
        if (this.attributeCount >= MAX_TOTAL_ATTRIBUTES) {
            this.truncated = true;
            return [];
        }
        const attributes: Hdf5Attribute[] = [];
        for (const message of messages) {
            // Above a threshold HDF5 moves an object's attributes into a
            // fractal heap, which this reader does not walk. Reporting the
            // traversal as truncated keeps that from looking like an object
            // that simply has no attributes.
            if (message.type === MSG_ATTRIBUTE_INFO && this.hasDenseAttributes(message.data)) {
                this.truncated = true;
                if (!this.denseAttributesReported) {
                    this.denseAttributesReported = true;
                    this.warnings.push('Attributes stored in a dense (fractal heap) index were not read.');
                }
            }
            if (message.type !== MSG_ATTRIBUTE) continue;
            if (attributes.length >= MAX_ATTRIBUTES_PER_OBJECT) {
                this.truncated = true;
                break;
            }
            const attribute = this.decodeAttribute(message.data);
            if (attribute) attributes.push(attribute);
        }
        return attributes;
    }

    /**
     * An Attribute Info message points at the fractal heap holding an object's
     * attributes once they no longer fit in the object header: version(1),
     * flags(1), [maximum creation index(2) when flags bit 0 is set], then the
     * heap address. An undefined heap address means the attributes are still
     * stored compactly in the header.
     */
    private hasDenseAttributes(data: Uint8Array): boolean {
        if (data.length < 2) return false;
        const flags = byteAt(data, 1);
        const offset = 2 + ((flags & 0x01) !== 0 ? 2 : 0);
        return readOffsetBuf(data, offset, this.sizeOfOffsets()) !== UNDEFINED_ADDRESS;
    }

    /**
     * Attribute message layout (versions 1-3). Version 1 pads the name,
     * datatype, and dataspace sections to 8-byte boundaries; versions 2 and 3
     * store them back to back, and version 3 adds a name character set byte.
     * Shared datatype/dataspace messages (version 2+ flags) are not followed.
     */
    private decodeAttribute(data: Uint8Array): Hdf5Attribute | null {
        if (data.length < 8) return null;
        const version = byteAt(data, 0);
        if (version < 1 || version > 3) return null;
        const flags = version === 1 ? 0 : byteAt(data, 1);
        const nameSize = readU16(data, 2);
        const datatypeSize = readU16(data, 4);
        const dataspaceSize = readU16(data, 6);
        let p = version === 3 ? 9 : 8;
        const pad = (size: number): number => version === 1 ? Math.ceil(size / 8) * 8 : size;

        if (p + nameSize > data.length) return null;
        const rawName = data.subarray(p, p + nameSize);
        const nameEnd = rawName.indexOf(0);
        const name = decodeUtf8(nameEnd < 0 ? rawName : rawName.subarray(0, nameEnd));
        p += pad(nameSize);

        if (p + datatypeSize > data.length) return null;
        const datatype = data.subarray(p, p + datatypeSize);
        p += pad(datatypeSize);
        if (p + dataspaceSize > data.length) return null;
        const dataspace = data.subarray(p, p + dataspaceSize);
        p += pad(dataspaceSize);

        const shape = this.dataspaceDimensions(dataspace);
        const type = this.describeDatatype(datatype);
        // Bits 0/1 mark a shared datatype/dataspace, which points at a message
        // elsewhere in the file instead of carrying it inline.
        if (flags & 0x03) return { name, type, shape, values: [], truncated: true };
        const decoded = this.decodeAttributeValues(datatype, shape, data.subarray(p));
        return { name, type, shape, values: decoded.values, truncated: decoded.truncated };
    }

    private decodeAttributeValues(
        datatype: Uint8Array,
        shape: readonly number[],
        payload: Uint8Array
    ): { values: Array<string | number>; truncated: boolean } {
        const classId = datatype.length > 0 ? byteAt(datatype, 0) & 0x0f : -1;
        const itemSize = this.datatypeSize(datatype);
        const declared = shape.reduce((product, dimension) => product * dimension, 1);
        const count = Math.min(declared, MAX_ATTRIBUTE_ELEMENTS);
        let truncated = count < declared;
        const values: Array<string | number> = [];

        const spend = (bytes: number): boolean => {
            if (bytes > MAX_ATTRIBUTE_VALUE_BYTES || bytes > this.attributeByteBudget) return false;
            this.attributeByteBudget -= bytes;
            return true;
        };

        if (classId === 3) {
            // Fixed-length string: `itemSize` bytes per element, null padded.
            if (itemSize <= 0) return { values, truncated: true };
            for (let index = 0; index < count; index++) {
                const start = index * itemSize;
                if (start + itemSize > payload.length || !spend(itemSize)) { truncated = true; break; }
                values.push(trimNulls(payload.subarray(start, start + itemSize)));
            }
            return { values, truncated };
        }

        // Class bit field bits 0-3 select the variable-length flavour: 1 = string.
        if (classId === 9 && (byteAt(datatype, 1) & 0x0f) === 1) {
            // Variable-length string: each element is a descriptor of
            // length + global heap collection address + object index.
            const sizeOfOffsets = this.sizeOfOffsets();
            const descriptorSize = 4 + sizeOfOffsets + 4;
            for (let index = 0; index < count; index++) {
                const start = index * descriptorSize;
                if (start + descriptorSize > payload.length) { truncated = true; break; }
                const length = readU32(payload, start);
                const heapAddress = readOffsetBuf(payload, start + 4, sizeOfOffsets);
                const objectIndex = readU32(payload, start + 4 + sizeOfOffsets);
                if (!spend(Math.min(length, MAX_ATTRIBUTE_VALUE_BYTES + 1))) { truncated = true; break; }
                const bytes = this.readGlobalHeapObject(heapAddress, objectIndex);
                if (!bytes) { truncated = true; break; }
                values.push(decodeUtf8(bytes.subarray(0, Math.min(length, bytes.length))));
            }
            return { values, truncated };
        }

        const numeric = classId === 0 ? [1, 2, 4, 8].includes(itemSize) : classId === 1 && [4, 8].includes(itemSize);
        if (numeric) {
            const bigEndian = (byteAt(datatype, 1) & 0x01) === 1;
            const signed = classId === 0 && (byteAt(datatype, 1) & 0x08) !== 0;
            for (let index = 0; index < count; index++) {
                const start = index * itemSize;
                if (start + itemSize > payload.length || !spend(itemSize)) { truncated = true; break; }
                values.push(readNumber(payload, start, itemSize, bigEndian, signed, classId === 1));
            }
            return { values, truncated };
        }

        return { values, truncated: true };
    }

    /**
     * Reads one object out of a global heap collection ('GCOL'), where
     * variable-length values keep their payload.
     *
     * A collection packs thousands of objects, and every value of an attribute
     * usually lands in the same one, so the object offsets are indexed on first
     * use. Rescanning per lookup would make reading n values cost O(n²) — a few
     * hundred thousand strings took tens of seconds before this cache.
     */
    private readGlobalHeapObject(address: number, index: number): Uint8Array | null {
        const start = this.resolve(address);
        if (index === 0 || start < 0) return null;
        const collection = this.globalHeapIndex(start);
        const object = collection?.get(index);
        if (!object) return null;
        const bytes = this.reader.read(object.offset, Math.min(object.size, MAX_ATTRIBUTE_VALUE_BYTES));
        return bytes.length > 0 || object.size === 0 ? bytes : null;
    }

    /** Object offsets of one global heap collection, built once per address. */
    private globalHeapIndex(start: number): Map<number, { offset: number; size: number }> | null {
        const cached = this.globalHeaps.get(start);
        if (cached !== undefined) return cached;
        const index = this.readGlobalHeapIndex(start);
        // Bounded so a file full of collections cannot pin unbounded memory;
        // insertion order makes the first entry the oldest.
        if (this.globalHeaps.size >= MAX_CACHED_GLOBAL_HEAPS) {
            const oldest = this.globalHeaps.keys().next();
            if (!oldest.done) this.globalHeaps.delete(oldest.value);
        }
        this.globalHeaps.set(start, index);
        return index;
    }

    private readGlobalHeapIndex(start: number): Map<number, { offset: number; size: number }> | null {
        if (!this.matchesAscii(start, 'GCOL')) return null;
        const sizeOfLengths = this.sizeOfLengths();
        const header = this.reader.read(start + 8, sizeOfLengths);
        const collectionSize = Math.min(readLittleBuf(header, 0, sizeOfLengths), MAX_BLOCK_BYTES);
        const objectHeaderSize = 8 + sizeOfLengths;
        const objects = new Map<number, { offset: number; size: number }>();
        let p = 8 + sizeOfLengths;
        while (p + objectHeaderSize <= collectionSize && objects.size < MAX_GLOBAL_HEAP_OBJECTS) {
            const objectHeader = this.reader.read(start + p, objectHeaderSize);
            if (objectHeader.length < objectHeaderSize) break;
            const objectIndex = readU16(objectHeader, 0);
            const size = readLittleBuf(objectHeader, 8, sizeOfLengths);
            // Index 0 is the collection's free space, which ends the object list.
            if (objectIndex === 0) break;
            if (!objects.has(objectIndex)) objects.set(objectIndex, { offset: start + p + objectHeaderSize, size });
            const next = p + objectHeaderSize + Math.ceil(size / 8) * 8;
            if (next <= p) break;
            p = next;
        }
        return objects;
    }

    private describeDatatype(data: Uint8Array): string {
        if (data.length < 1) {
            return 'unknown';
        }
        const classId = byteAt(data, 0) & 0x0f;
        const name = DATATYPE_CLASS_NAMES[classId] ?? `class ${classId}`;
        const size = this.datatypeSize(data);
        if (classId === 0 || classId === 1) {
            return `${name}${size * 8}`;
        }
        return name;
    }

    private datatypeSize(data: Uint8Array): number {
        return data.length >= 8 ? readU32(data, 4) : 0;
    }

    /**
     * Reads a null-terminated name out of a local heap. Names are usually short,
     * so the heap is read a window at a time and only grows for the rare long
     * one — a fixed window would silently truncate the name, and a truncated
     * name becomes a wrong object path rather than a visible failure.
     */
    private readHeapString(offset: number): string {
        if (offset < 0 || offset >= this.reader.size) {
            return '';
        }
        const chunks: Uint8Array[] = [];
        for (let read = 0; read < MAX_LINK_NAME_BYTES; read += HEAP_STRING_WINDOW) {
            const buf = this.reader.read(offset + read, Math.min(HEAP_STRING_WINDOW, MAX_LINK_NAME_BYTES - read));
            if (buf.length === 0) break;
            const end = buf.indexOf(0);
            chunks.push(end < 0 ? buf : buf.subarray(0, end));
            if (end >= 0 || buf.length < HEAP_STRING_WINDOW) break;
        }
        if (chunks.length === 1) return decodeUtf8(chunks[0]!);
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const name = new Uint8Array(total);
        let position = 0;
        for (const chunk of chunks) {
            name.set(chunk, position);
            position += chunk.length;
        }
        return decodeUtf8(name);
    }

    private matchesAscii(offset: number, signature: string): boolean {
        if (offset < 0) {
            return false;
        }
        const buf = this.reader.read(offset, signature.length);
        if (buf.length < signature.length) {
            return false;
        }
        for (let i = 0; i < signature.length; i++) {
            if (buf[i] !== signature.charCodeAt(i)) {
                return false;
            }
        }
        return true;
    }

    private resolve(address: number): number {
        if (address === UNDEFINED_ADDRESS) {
            return -1;
        }
        const base = this.superblock ? this.superblock.baseAddress : 0;
        return address + (base > 0 ? base : 0);
    }

    private sizeOfOffsets(): number {
        return this.superblock ? this.superblock.sizeOfOffsets : 8;
    }

    private sizeOfLengths(): number {
        return this.superblock ? this.superblock.sizeOfLengths : 8;
    }
}

function readOffsetBuf(buffer: Uint8Array, offset: number, size: number): number {
    if (offset < 0 || offset + size > buffer.length) {
        return UNDEFINED_ADDRESS;
    }
    let allOnes = true;
    for (let i = 0; i < size; i++) {
        if (buffer[offset + i] !== 0xff) {
            allOnes = false;
            break;
        }
    }
    if (allOnes) {
        return UNDEFINED_ADDRESS;
    }
    return readLittleBuf(buffer, offset, size);
}

function readLittleBuf(buffer: Uint8Array, offset: number, size: number): number {
    if (offset < 0 || offset + size > buffer.length) {
        return 0;
    }
    if (size <= 6) {
        let value = 0;
        for (let i = size - 1; i >= 0; i--) value = value * 256 + byteAt(buffer, offset + i);
        return value;
    }
    let value = 0n;
    for (let i = size - 1; i >= 0; i--) {
        value = (value << 8n) | BigInt(byteAt(buffer, offset + i));
    }
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function byteAt(buffer: Uint8Array, offset: number): number {
    return buffer[offset] ?? 0;
}

/** Decodes a null-padded fixed-length string element. */
function trimNulls(buffer: Uint8Array): string {
    let end = buffer.length;
    while (end > 0 && buffer[end - 1] === 0) end--;
    return decodeUtf8(buffer.subarray(0, end));
}

function readNumber(
    buffer: Uint8Array,
    offset: number,
    size: number,
    bigEndian: boolean,
    signed: boolean,
    float: boolean
): number {
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset, size);
    const little = !bigEndian;
    if (float) return size === 4 ? view.getFloat32(0, little) : view.getFloat64(0, little);
    if (size === 1) return signed ? view.getInt8(0) : view.getUint8(0);
    if (size === 2) return signed ? view.getInt16(0, little) : view.getUint16(0, little);
    if (size === 4) return signed ? view.getInt32(0, little) : view.getUint32(0, little);
    const wide = signed ? view.getBigInt64(0, little) : view.getBigUint64(0, little);
    // Attributes carry counters and flags, never values needing 64-bit range;
    // clamping keeps the decoded type a plain number.
    return wide > BigInt(Number.MAX_SAFE_INTEGER) || wide < BigInt(Number.MIN_SAFE_INTEGER)
        ? Number.NaN
        : Number(wide);
}

function readU16(buffer: Uint8Array, offset: number): number {
    if (offset < 0 || offset + 2 > buffer.length) return 0;
    return (buffer[offset] ?? 0) | ((buffer[offset + 1] ?? 0) << 8);
}

function readU32(buffer: Uint8Array, offset: number): number {
    if (offset < 0 || offset + 4 > buffer.length) return 0;
    return ((buffer[offset] ?? 0) | ((buffer[offset + 1] ?? 0) << 8) |
        ((buffer[offset + 2] ?? 0) << 16) | ((buffer[offset + 3] ?? 0) << 24)) >>> 0;
}

function decodeUtf8(buffer: Uint8Array): string {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
}

export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return String(bytes) + ' bytes';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = units[0]!;
    for (let i = 1; i < units.length && value >= 1024; i++) {
        value /= 1024;
        unit = units[i]!;
    }
    return value.toFixed(value >= 10 ? 1 : 2) + ' ' + unit;
}
function formatAddress(address: number): string {
    if (address === UNDEFINED_ADDRESS) {
        return 'undefined';
    }
    return `0x${address.toString(16)}`;
}

function hexRows(buffer: Uint8Array, start: number, end: number): Array<Array<string>> {
    const rows: Array<Array<string>> = [];
    for (let offset = start; offset < end; offset += 16) {
        const slice = buffer.subarray(offset, Math.min(offset + 16, end));
        const hex = Array.from(slice).map(byte => byte.toString(16).padStart(2, '0')).join(' ');
        const ascii = Array.from(slice).map(byte => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.')).join('');
        rows.push([`0x${offset.toString(16).padStart(4, '0')}`, hex, ascii]);
    }
    return rows;
}

/** Convenience function for adapters and the built-in viewer. */
export function parseHdf5(input: Uint8Array, fileSize = formatFileSize(input.byteLength)): Hdf5Document {
    return Hdf5Parser.parse(input, fileSize);
}

/**
 * Groups, datasets, and attributes of an in-memory HDF5 file — the entry point
 * for parsers of formats layered on HDF5 (Keras `.h5`, `.keras` weights).
 */
export function readHdf5Objects(input: Uint8Array | Hdf5Reader): Hdf5ObjectTree {
    return Hdf5Parser.readObjects(input instanceof Uint8Array ? new Hdf5Uint8ArrayReader(input) : input);
}
