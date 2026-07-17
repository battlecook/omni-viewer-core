import { parseDbc } from '../dbc/index.js';

export type AutomotiveFormat = 'avro' | 'bag' | 'stp' | 'db3' | 'reqif' | 'dbc' | 'arxml' | 'a2l' | 'asc' | 'blf' | 'mf4' | 'pcap' | 'pcapng';

export type AutomotiveCell = string | number;

export interface AutomotiveSummaryItem {
    label: string;
    value: AutomotiveCell;
}

export interface AutomotiveTable {
    title: string;
    headers: string[];
    rows: AutomotiveCell[][];
}

export interface AutomotiveViewerModel {
    format: string;
    title: string;
    fileSizeBytes: number;
    summary: AutomotiveSummaryItem[];
    tables: AutomotiveTable[];
    rawPreview?: string;
    warnings: string[];
}

interface SqliteSchemaEntry {
    type: string;
    name: string;
    tableName: string;
    rootPage: number;
    sql: string;
}

interface SqliteRecord {
    rowid: number | string;
    values: AutomotiveCell[];
}

interface SqliteParseResult {
    schema: SqliteSchemaEntry[];
    previews: Array<{
        tableName: string;
        columns: string[];
        rows: SqliteRecord[];
        truncated: boolean;
    }>;
    warnings: string[];
}

const SQLITE_HEADER = 'SQLite format 3\0';
const utf8 = new TextDecoder();
const latin1 = new TextDecoder('latin1');
const TEXT_SCAN_LIMIT = 4 * 1024 * 1024;
const BINARY_SCAN_LIMIT = 8 * 1024 * 1024;
const ROW_LIMIT = 5_000;

export function parseAutomotive(format: AutomotiveFormat, data: Uint8Array): AutomotiveViewerModel {
    switch (format) {
    case 'avro': return parseAvro(data);
    case 'bag': return parseBag(data);
    case 'stp': return parseStp(data);
    case 'db3': return parseDb3(data);
    case 'reqif': return parseReqif(data);
    case 'dbc': return parseDbcAutomotive(data);
    case 'arxml': return parseArxml(data);
    case 'a2l': return parseA2l(data);
    case 'asc': return parseAsc(data);
    case 'blf': return parseBlf(data);
    case 'mf4': return parseMf4(data);
    case 'pcap': return parsePcap(data);
    case 'pcapng': return parsePcapng(data);
    }
}

function parseDbcAutomotive(data: Uint8Array): AutomotiveViewerModel {
    const model = parseDbc(data);
    const messages = model.messages.slice(0, 2_000);
    const signals = messages.flatMap(message => message.signals.map(signal => [message.idHex, message.name, signal.name, signal.startBit, signal.length, signal.byteOrder, signal.valueType, signal.factor, signal.offset, signal.unit, signal.receivers.join(', ')] as AutomotiveCell[]));
    return {
        format: 'DBC', title: 'CAN database', fileSizeBytes: data.byteLength,
        summary: [{ label: 'Version', value: model.version || '-' }, { label: 'Messages', value: model.stats.messageCount }, { label: 'Signals', value: model.stats.signalCount }, { label: 'Nodes', value: model.stats.nodeCount }],
        tables: [
            { title: 'Messages', headers: ['ID', 'Name', 'DLC', 'Transmitter', 'Signals', 'Comment'], rows: messages.map(x => [x.idHex, x.name, x.dlc, x.transmitter, x.signals.length, x.comment ?? '-']) },
            { title: 'Signals', headers: ['Message ID', 'Message', 'Signal', 'Start bit', 'Length', 'Byte order', 'Sign', 'Factor', 'Offset', 'Unit', 'Receivers'], rows: signals.slice(0, 20_000) },
            { title: 'Nodes', headers: ['#', 'Name'], rows: model.nodes.map((name, index) => [index + 1, name]) }
        ], rawPreview: preview(new TextDecoder().decode(data.subarray(0, TEXT_SCAN_LIMIT))), warnings: model.warnings
    };
}

export function parseAvro(data: Uint8Array): AutomotiveViewerModel {
    const isObjectContainer = matchesBytes(data, 0, [0x4f, 0x62, 0x6a, 0x01]);
    const metadata = isObjectContainer ? readAvroMetadata(data) : [];
    const schema = metadata.find(row => row[0] === 'avro.schema')?.[1];
    const codec = metadata.find(row => row[0] === 'avro.codec')?.[1];
    const syncMarker = data.length >= 16 ? toHex(data.subarray(data.length - 16)) : '-';

    return {
        format: 'AVRO',
        title: 'Apache Avro object container',
        fileSizeBytes: data.byteLength,
        summary: [
            { label: 'Magic', value: isObjectContainer ? 'Obj\\x01' : '-' },
            { label: 'Metadata entries', value: metadata.length },
            { label: 'Codec', value: codec || 'null' },
            { label: 'Sync marker hint', value: syncMarker }
        ],
        tables: [
            {
                title: 'Metadata',
                headers: ['Key', 'Value'],
                rows: metadata.length ? metadata : [['-', 'No Avro metadata map could be decoded from the header.']]
            },
            { title: 'Header preview', headers: ['Offset', 'Hex', 'ASCII'], rows: hexRows(data, 0, Math.min(data.length, 256)) }
        ],
        ...(schema ? { rawPreview: prettyJson(String(schema)) } : {}),
        warnings: isObjectContainer ? [] : ['The file does not start with the expected Avro object container magic bytes.']
    };
}

export function parseBag(data: Uint8Array): AutomotiveViewerModel {
    const headerLine = firstAsciiLine(data);
    const isRosBag = headerLine.startsWith('#ROSBAG V2.');
    const scan = data.subarray(0, BINARY_SCAN_LIMIT);
    const counts = countBagOperations(scan);
    const operationRows: AutomotiveCell[][] = [
        ['Bag header', counts.bagHeader], ['Connection', counts.connection], ['Chunk', counts.chunk],
        ['Index data', counts.indexData], ['Chunk info', counts.chunkInfo], ['Message data', counts.messageData]
    ].filter(row => Number(row[1]) > 0);

    return {
        format: 'BAG',
        title: 'ROS bag',
        fileSizeBytes: data.byteLength,
        summary: [
            { label: 'Header', value: headerLine || '-' },
            { label: 'Connection records', value: counts.connection },
            { label: 'Chunk records', value: counts.chunk },
            { label: 'Message data records', value: counts.messageData }
        ],
        tables: [
            { title: 'Record op hints', headers: ['Record type', 'Count'], rows: operationRows },
            { title: 'Header preview', headers: ['Offset', 'Hex', 'ASCII'], rows: hexRows(data, 0, Math.min(data.length, 256)) }
        ],
        warnings: [
            ...(isRosBag ? [] : ['The file does not start with the expected ROS bag header.']),
            ...(data.length > scan.length ? ['ROS bag record scan is limited to the first 8 MiB.'] : [])
        ]
    };
}

export function parseStp(data: Uint8Array): AutomotiveViewerModel {
    const { source, truncated } = boundedText(data);
    const header = extractStepHeader(source);
    const entities = collectStepEntities(source);
    const counts = new Map<string, number>();
    entities.forEach(entity => counts.set(entity.type, (counts.get(entity.type) ?? 0) + 1));

    return {
        format: 'STP',
        title: 'ISO 10303 STEP model',
        fileSizeBytes: data.byteLength,
        summary: [
            { label: 'Schema', value: header.schema || '-' }, { label: 'Name', value: header.name || '-' },
            { label: 'Entity lines', value: entities.length }, { label: 'Entity types', value: counts.size }
        ],
        tables: [
            {
                title: 'Header', headers: ['Field', 'Value'], rows: [
                    ['Name', header.name || '-'], ['Timestamp', header.timestamp || '-'], ['Author', header.author || '-'],
                    ['Organization', header.organization || '-'], ['Preprocessor', header.preprocessor || '-'],
                    ['Originating system', header.originatingSystem || '-'], ['Authorization', header.authorization || '-'],
                    ['Schema', header.schema || '-']
                ]
            },
            {
                title: 'Top entity types', headers: ['Entity', 'Count'],
                rows: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100)
            },
            { title: 'Entity preview', headers: ['ID', 'Type', 'Line'], rows: entities.slice(0, 1000).map(item => [item.id, item.type, item.line]) }
        ],
        rawPreview: preview(source),
        warnings: [
            ...limitWarning(truncated, 'STEP text scan'),
            ...(entities.length > 1000 ? ['Large STEP file: entity preview is limited to the first 1,000 entities.'] : [])
        ]
    };
}

export function parseDb3(data: Uint8Array): AutomotiveViewerModel {
    const isSqlite = ascii(data.subarray(0, SQLITE_HEADER.length)) === SQLITE_HEADER;
    const pageSize = data.length >= 18 ? readSqlitePageSize(data) : 0;
    const pageCount = data.length >= 32 ? readU32BE(data, 28) : 0;
    const sqlite: SqliteParseResult = isSqlite && pageSize > 0
        ? parseSqliteDatabase(data, pageSize)
        : { schema: [], previews: [], warnings: [] };
    const schemaRows: AutomotiveCell[][] = sqlite.schema.length
        ? sqlite.schema.map(entry => [entry.type, entry.name, entry.tableName, entry.rootPage, entry.sql])
        : extractSqliteSchemaHints(data).map((sql, index) => ['hint', `schema-${index + 1}`, '-', '-', sql]);
    const userTables = sqlite.schema.filter(entry => entry.type === 'table' && !entry.name.startsWith('sqlite_'));
    const ros2Tables = ['topics', 'messages', 'schemas', 'metadata'].filter(name => userTables.some(entry => entry.name === name));

    return {
        format: 'DB3',
        title: 'SQLite 3 database',
        fileSizeBytes: data.byteLength,
        summary: [
            { label: 'Signature', value: isSqlite ? 'SQLite format 3' : '-' }, { label: 'Page size', value: pageSize || '-' },
            { label: 'Page count hint', value: pageCount || '-' }, { label: 'Tables', value: userTables.length }
        ],
        tables: [
            {
                title: 'Database header', headers: ['Field', 'Value'], rows: [
                    ['Page size', pageSize || '-'], ['Page count hint', pageCount || '-'], ['Schema entries', sqlite.schema.length],
                    ['ROS2 tables detected', ros2Tables.length ? ros2Tables.join(', ') : '-']
                ]
            },
            {
                title: 'Schema', headers: ['Type', 'Name', 'Table', 'Root page', 'SQL'],
                rows: schemaRows.length ? schemaRows : [['-', '-', '-', '-', 'No sqlite_master schema rows could be decoded.']]
            },
            ...sqlite.previews.map(table => ({
                title: `Rows: ${table.tableName}`,
                headers: ['rowid', ...table.columns],
                rows: table.rows.map(row => [row.rowid, ...row.values])
            })),
            { title: 'Header preview', headers: ['Offset', 'Hex', 'ASCII'], rows: hexRows(data, 0, Math.min(data.length, 256)) }
        ],
        warnings: isSqlite ? sqlite.warnings : ['The file does not start with the expected SQLite 3 database header.']
    };
}

export function parseReqif(data: Uint8Array): AutomotiveViewerModel {
    const { source, truncated } = boundedText(data);
    const header = extractReqifHeader(source);
    const specObjects = collectReqifElements(source, 'SPEC-OBJECT');
    const specifications = collectReqifElements(source, 'SPECIFICATION');
    const relations = collectReqifElements(source, 'SPEC-RELATION');
    const datatypes = collectReqifElements(source, 'DATATYPE-DEFINITION-[A-Z-]+');
    const specTypes = collectReqifElements(source, 'SPEC-[A-Z-]*TYPE');

    return {
        format: 'REQIF',
        title: 'Requirements Interchange Format',
        fileSizeBytes: data.byteLength,
        summary: [
            { label: 'Title', value: header.title || '-' }, { label: 'Spec objects', value: specObjects.length },
            { label: 'Specifications', value: specifications.length }, { label: 'Spec relations', value: relations.length }
        ],
        tables: [
            {
                title: 'Header', headers: ['Field', 'Value'], rows: [
                    ['Title', header.title || '-'], ['Identifier', header.identifier || '-'],
                    ['Source tool ID', header.sourceToolId || '-'], ['ReqIF tool ID', header.reqifToolId || '-'],
                    ['Creation time', header.creationTime || '-'], ['Comment', header.comment || '-']
                ]
            },
            { title: 'Specifications', headers: ['Identifier', 'Long name', 'Type'], rows: reqifRows(specifications, 1000) },
            { title: 'Spec objects', headers: ['Identifier', 'Long name', 'Type'], rows: reqifRows(specObjects, 1000) },
            { title: 'Spec relations', headers: ['Identifier', 'Long name', 'Type'], rows: reqifRows(relations, 1000) },
            {
                title: 'Definitions', headers: ['Kind', 'Identifier', 'Long name'], rows: [
                    ...datatypes.slice(0, 500).map(item => [item.type, item.identifier, item.longName]),
                    ...specTypes.slice(0, 500).map(item => [item.type, item.identifier, item.longName])
                ]
            }
        ],
        rawPreview: preview(source),
        warnings: [
            ...limitWarning(truncated, 'ReqIF XML scan'),
            ...(specObjects.length > 1000 || specifications.length > 1000 || relations.length > 1000
                ? ['Large ReqIF file: object, specification, and relation tables are limited to the first 1,000 entries.']
                : [])
        ]
    };
}

function boundedText(data: Uint8Array): { source: string; truncated: boolean } {
    const truncated = data.byteLength > TEXT_SCAN_LIMIT;
    return { source: utf8.decode(data.subarray(0, TEXT_SCAN_LIMIT)), truncated };
}

function limitWarning(truncated: boolean, kind = 'text scan'): string[] {
    return truncated ? [`Large input: ${kind} is limited to the first ${TEXT_SCAN_LIMIT.toLocaleString()} bytes.`] : [];
}

export function parseArxml(data: Uint8Array): AutomotiveViewerModel {
    const { source, truncated } = boundedText(data);
    const valid = /<AUTOSAR(?:\s|>)/i.test(source);
    const complete = /<\/AUTOSAR\s*>/i.test(source);
    const packageNames = collectXmlChildText(source, 'AR-PACKAGE', 'SHORT-NAME', 1_000);
    const tags = ['CAN-CLUSTER', 'CAN-PHYSICAL-CHANNEL', 'CAN-FRAME-TRIGGERING', 'FRAME', 'I-SIGNAL', 'I-PDU', 'SIGNAL-I-PDU', 'ECU-INSTANCE'];
    const elements: AutomotiveCell[][] = [];
    for (const tag of tags) {
        const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<SHORT-NAME\\b[^>]*>([\\s\\S]*?)<\\/SHORT-NAME>`, 'gi');
        let match: RegExpExecArray | null;
        while (elements.length < 1_000 && (match = re.exec(source))) elements.push([tag, cleanXmlText(match[1] ?? '')]);
    }
    const refs: AutomotiveCell[][] = [];
    const refRe = /<([A-Z0-9-]*REF)\b([^>]*)>([^<]{0,4096})<\/\1>/gi;
    let ref: RegExpExecArray | null;
    while (refs.length < 1_000 && (ref = refRe.exec(source))) refs.push([ref[1] ?? '', /\bDEST\s*=\s*["']([^"']*)/i.exec(ref[2] ?? '')?.[1] ?? '-', cleanXmlText(ref[3] ?? '')]);
    const namespace = /<AUTOSAR\b[^>]*\bxmlns\s*=\s*["']([^"']+)/i.exec(source)?.[1] ?? '-';
    return {
        format: 'ARXML', title: 'AUTOSAR XML', fileSizeBytes: data.byteLength,
        summary: [{ label: 'Packages', value: packageNames.length }, { label: 'Named elements', value: elements.length }, { label: 'References', value: refs.length }, { label: 'XML namespace', value: namespace }],
        tables: [
            { title: 'Packages', headers: ['#', 'Short name'], rows: packageNames.map((name, i) => [i + 1, name]) },
            { title: 'Named elements', headers: ['Type', 'Short name'], rows: elements },
            { title: 'References', headers: ['Tag', 'Dest', 'Target'], rows: refs }
        ], rawPreview: preview(source),
        warnings: [...(!valid ? ['The input does not contain an AUTOSAR root element.'] : []), ...(valid && !complete ? ['The AUTOSAR XML document appears truncated or is missing its closing root element.'] : []), ...limitWarning(truncated, 'XML scan'), ...(elements.length >= 1_000 || refs.length >= 1_000 ? ['ARXML tables are limited to 1,000 rows.'] : [])]
    };
}

export function parseA2l(data: Uint8Array): AutomotiveViewerModel {
    const { source, truncated } = boundedText(data);
    const blocks: Array<{ type: string; name: string; line: number }> = [];
    const counts = new Map<string, number>();
    source.split(/\r?\n/).forEach((line, index) => {
        const match = /^\s*\/begin\s+([A-Z0-9_]+)(?:\s+([^\s/]+))?/i.exec(line);
        if (!match?.[1]) return;
        const type = match[1].toUpperCase(); counts.set(type, (counts.get(type) ?? 0) + 1);
        if (blocks.length < 1_000) blocks.push({ type, name: (match[2] ?? '-').replace(/^"|"$/g, ''), line: index + 1 });
    });
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    return {
        format: 'A2L', title: 'ASAM MCD-2 MC / ASAP2', fileSizeBytes: data.byteLength,
        summary: [{ label: 'Blocks', value: total }, { label: 'Measurements', value: counts.get('MEASUREMENT') ?? 0 }, { label: 'Characteristics', value: counts.get('CHARACTERISTIC') ?? 0 }, { label: 'IF_DATA', value: counts.get('IF_DATA') ?? 0 }],
        tables: [
            { title: 'Important blocks', headers: ['Type', 'Name', 'Line'], rows: blocks.map(x => [x.type, x.name, x.line]) },
            { title: 'Block counts', headers: ['Type', 'Count'], rows: [...counts].sort((a, b) => b[1] - a[1]) }
        ], rawPreview: preview(source), warnings: [...(total === 0 ? ['No A2L /begin blocks were found.'] : []), ...(total > (source.match(/^\s*\/end\b/gim)?.length ?? 0) ? ['The A2L document appears truncated: one or more /begin blocks have no /end.'] : []), ...limitWarning(truncated), ...(total > blocks.length ? ['A2L block preview is limited to 1,000 rows.'] : [])]
    };
}

export function parseAsc(data: Uint8Array): AutomotiveViewerModel {
    const { source, truncated } = boundedText(data);
    const headers: AutomotiveCell[][] = []; const events: AutomotiveCell[][] = [];
    let total = 0; let fd = 0;
    source.split(/\r?\n/).forEach((line, index) => {
        const trimmed = line.trim(); if (!trimmed) return;
        if (!/^\d+(?:\.\d+)?\s+/.test(trimmed)) { if (headers.length < 20) headers.push([headers.length + 1, trimmed]); return; }
        const event = parseAscEvent(trimmed, index + 1);
        if (!event) return;
        total++; if (event.type === 'CANFD') fd++;
        if (events.length < ROW_LIMIT) events.push([event.time, event.type, event.channel, event.direction, event.id, event.dlc, event.data, event.line]);
    });
    return {
        format: 'ASC', title: 'Vector ASCII CAN log', fileSizeBytes: data.byteLength,
        summary: [{ label: 'Parsed events', value: total }, { label: 'CAN FD events', value: fd }, { label: 'Classic CAN events', value: total - fd }, { label: 'Header lines', value: headers.length }],
        tables: [{ title: 'Header', headers: ['#', 'Line'], rows: headers }, { title: 'CAN events', headers: ['Time', 'Type', 'Channel', 'Dir', 'ID', 'DLC', 'Data', 'Line'], rows: events }],
        rawPreview: preview(source), warnings: [...(total === 0 ? ['No timestamped ASC events were found.'] : []), ...limitWarning(truncated), ...(total > events.length ? [`ASC event preview is limited to ${ROW_LIMIT.toLocaleString()} rows.`] : [])]
    };
}

function parseAscEvent(line: string, lineNumber: number): {
    time: string;
    type: 'CAN' | 'CANFD';
    channel: string;
    direction: string;
    id: string;
    dlc: string;
    data: string;
    line: number;
} | null {
    const canFd = /^(\d+(?:\.\d+)?)\s+CANFD\s+(\S+)\s+(Rx|Tx)\s+((?:0x)?[0-9A-Fa-f]+x?)\s+(.+)$/i.exec(line);
    if (canFd) {
        const fields = (canFd[5] ?? '').trim().split(/\s+/);
        // Vector CAN FD ASC rows contain an optional symbolic name before
        // BRS, ESI, DLC and DataLength. Like python-can, a numeric first
        // field identifies the no-symbol variant.
        const flagsOffset = /^\d+$/.test(fields[0] ?? '') ? 0 : 1;
        const brs = fields[flagsOffset];
        const esi = fields[flagsOffset + 1];
        const dlc = fields[flagsOffset + 2];
        const dataLengthText = fields[flagsOffset + 3];
        const dataLength = /^\d+$/.test(dataLengthText ?? '') ? Number(dataLengthText) : -1;
        if (/^[01]$/.test(brs ?? '') && /^[01]$/.test(esi ?? '') && /^[0-9A-Fa-f]+$/.test(dlc ?? '') && dataLength >= 0 && dataLength <= 64) {
            const dataStart = flagsOffset + 4;
            return {
                time: canFd[1] ?? '-', type: 'CANFD', channel: canFd[2] ?? '-', direction: canFd[3] ?? '-',
                id: canFd[4] ?? '-', dlc: dlc ?? '-', data: fields.slice(dataStart, dataStart + dataLength).join(' '), line: lineNumber
            };
        }
    }

    const classic = /^(\d+(?:\.\d+)?)\s+(\S+)\s+((?:0x)?[0-9A-Fa-f]+x?)\s+(Rx|Tx)\s+d\s+(\d+)\s*(.*)$/i.exec(line);
    return classic ? {
        time: classic[1] ?? '-', type: 'CAN', channel: classic[2] ?? '-', direction: classic[4] ?? '-',
        id: classic[3] ?? '-', dlc: classic[5] ?? '-', data: classic[6]?.trim() ?? '', line: lineNumber
    } : null;
}

export function parseBlf(data: Uint8Array): AutomotiveViewerModel {
    const signature = ascii(data.subarray(0, 4));
    const headerSize = data.length >= 8 ? view(data).getUint32(4, true) : 0;
    const applicationId = data.length >= 9 ? data[8] ?? 0 : 0;
    const objectCount = data.length >= 36 ? view(data).getUint32(32, true) : 0;
    return { format: 'BLF', title: 'Vector Binary Logging Format', fileSizeBytes: data.byteLength,
        summary: [{ label: 'Signature', value: signature || '-' }, { label: 'Header size', value: headerSize }, { label: 'Application ID', value: applicationId }, { label: 'Object count hint', value: objectCount || '-' }],
        tables: [{ title: 'Header preview', headers: ['Offset', 'Hex', 'ASCII'], rows: hexRows(data, 0, Math.min(data.length, 256)) }],
        warnings: [...(signature === 'LOGG' ? [] : ['The file does not start with the expected BLF LOGG signature.']), ...(signature === 'LOGG' && data.length < 144 ? ['The BLF file header is truncated.'] : [])] };
}

export function parseMf4(data: Uint8Array): AutomotiveViewerModel {
    const magic = ascii(data.subarray(0, 8)).replace(/\0/g, '').trim();
    const version = ascii(data.subarray(8, 16)).replace(/\0/g, '').trim();
    const program = ascii(data.subarray(16, 24)).replace(/\0/g, '').trim();
    const scan = data.subarray(0, BINARY_SCAN_LIMIT); const markers = ['##HD','##DG','##CG','##CN','##CC','##DT','##DZ','##TX','##MD'];
    const rows = markers.map(marker => [marker, countBytes(scan, [...marker].map(c => c.charCodeAt(0))) ] as AutomotiveCell[]).filter(row => Number(row[1]) > 0);
    return { format: 'MF4', title: 'ASAM MDF 4 measurement data', fileSizeBytes: data.byteLength,
        summary: [{ label: 'Magic', value: magic || '-' }, { label: 'Version', value: version || '-' }, { label: 'Program ID', value: program || '-' }, { label: 'Known block markers', value: rows.reduce((n, r) => n + Number(r[1]), 0) }],
        tables: [{ title: 'MDF block markers', headers: ['Block', 'Count'], rows }, { title: 'Header preview', headers: ['Offset', 'Hex', 'ASCII'], rows: hexRows(data, 0, Math.min(data.length, 256)) }],
        warnings: [...(!/^MDF/i.test(magic) ? ['The file does not start with an MDF identification block.'] : []), ...(/^MDF/i.test(magic) && data.length < 64 ? ['The MDF identification/header block is truncated.'] : []), ...(data.length > scan.length ? ['MDF marker scan is limited to the first 8 MiB.'] : [])] };
}

export function parsePcap(data: Uint8Array): AutomotiveViewerModel {
    const magic = data.length >= 4 ? view(data).getUint32(0, false) : 0;
    const little = magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1; const valid = little || magic === 0xa1b2c3d4 || magic === 0xa1b23c4d;
    const nanos = magic === 0x4d3cb2a1 || magic === 0xa1b23c4d;
    const linkType = data.length >= 24 ? view(data).getUint32(20, little) : 0; const rows: AutomotiveCell[][] = [];
    let offset = 24; let total = 0; let malformed = valid && data.length < 24;
    while (valid && offset + 16 <= data.length && total < ROW_LIMIT) {
        const seconds = view(data).getUint32(offset, little); const fraction = view(data).getUint32(offset + 4, little); const captured = view(data).getUint32(offset + 8, little); const original = view(data).getUint32(offset + 12, little);
        if (captured > 64 * 1024 * 1024 || offset + 16 + captured > data.length) { malformed = true; break; }
        rows.push([total + 1, `${seconds}.${String(fraction).padStart(nanos ? 9 : 6, '0')}`, captured, original, packetPreview(data.subarray(offset + 16, offset + 16 + captured))]); total++; offset += 16 + captured;
    }
    return packetModel('PCAP', 'PCAP packet capture', data, valid, linkType, rows, malformed, total >= ROW_LIMIT);
}

export function parsePcapng(data: Uint8Array): AutomotiveViewerModel {
    const valid = matchesBytes(data, 0, [0x0a,0x0d,0x0d,0x0a]); let little = true; let offset = 0; let total = 0; let malformed = valid && data.length < 12;
    const blocks = new Map<number, number>(); const packets: AutomotiveCell[][] = [];
    while (valid && offset + 12 <= data.length && total < ROW_LIMIT) {
        // The SHB type is byte-order invariant. Its BOM selects the byte order
        // for that section, including the SHB length itself. A later SHB may
        // switch byte order again within the same file.
        if (view(data).getUint32(offset, false) === 0x0a0d0d0a) {
            const bom = view(data).getUint32(offset + 8, false);
            if (bom === 0x1a2b3c4d) little = false;
            else if (bom === 0x4d3c2b1a) little = true;
            else { malformed = true; break; }
        }
        const type = view(data).getUint32(offset, little); const length = view(data).getUint32(offset + 4, little);
        if (length < 12 || length % 4 !== 0 || offset + length > data.length) { malformed = true; break; }
        blocks.set(type, (blocks.get(type) ?? 0) + 1);
        if (type === 6 && length >= 32) { const captured = view(data).getUint32(offset + 20, little); const original = view(data).getUint32(offset + 24, little); const payloadStart = offset + 28; packets.push([packets.length + 1, view(data).getUint32(offset + 8, little), captured, original, packetPreview(data.subarray(payloadStart, Math.min(payloadStart + captured, offset + length - 4)))]); }
        total++; offset += length;
    }
    const model = packetModel('PCAPNG', 'PCAP Next Generation capture', data, valid, 0, packets, malformed, total >= ROW_LIMIT);
    model.tables.unshift({ title: 'Block counts', headers: ['Block type', 'Count'], rows: [...blocks].map(([type, count]) => [`0x${type.toString(16).padStart(8, '0')}`, count]) });
    return model;
}

function packetModel(format: string, title: string, data: Uint8Array, valid: boolean, linkType: number, rows: AutomotiveCell[][], malformed: boolean, limited: boolean): AutomotiveViewerModel {
    return { format, title, fileSizeBytes: data.byteLength,
        summary: [{ label: 'Signature', value: valid ? format : '-' }, { label: 'Packets previewed', value: rows.length }, { label: 'Link type', value: linkType || '-' }, { label: 'Bytes', value: data.byteLength }],
        tables: [{ title: 'Packets', headers: ['#', 'Timestamp / interface', 'Captured', 'Original', 'Payload preview'], rows }],
        warnings: [...(!valid ? [`The file does not start with a valid ${format} signature.`] : []), ...(malformed ? ['Parsing stopped at a truncated or invalid block.'] : []), ...(limited ? [`Preview is limited to ${ROW_LIMIT.toLocaleString()} packets or blocks.`] : [])] };
}

function collectXmlChildText(source: string, parent: string, child: string, limit: number): string[] {
    const result: string[] = []; const re = new RegExp(`<${parent}\\b[^>]*>[\\s\\S]*?<${child}\\b[^>]*>([\\s\\S]*?)<\\/${child}>`, 'gi'); let match: RegExpExecArray | null;
    while (result.length < limit && (match = re.exec(source))) result.push(cleanXmlText(match[1] ?? ''));
    return result;
}

function cleanXmlText(value: string): string { return decodeXml(value.replace(/<[^>]*>/g, '').trim()); }
function packetPreview(data: Uint8Array): string { return [...data.subarray(0, 32)].map(x => x.toString(16).padStart(2, '0')).join(' '); }

function readAvroMetadata(data: Uint8Array): AutomotiveCell[][] {
    const rows: AutomotiveCell[][] = [];
    let offset = 4;
    const maxOffset = Math.min(data.length, 64 * 1024);
    try {
        while (offset < maxOffset) {
            const countResult = readAvroLong(data, offset);
            offset = countResult.offset;
            let count = countResult.value;
            if (count === 0n) break;
            if (count < 0n) {
                offset = readAvroLong(data, offset).offset;
                count = -count;
            }
            if (count > 64n) break;
            for (let index = 0n; index < count && offset < maxOffset; index++) {
                const key = readAvroBytes(data, offset);
                offset = key.offset;
                const value = readAvroBytes(data, offset);
                offset = value.offset;
                const keyText = utf8.decode(key.bytes);
                rows.push([keyText, printableMetadataValue(keyText, value.bytes)]);
            }
        }
    } catch {
        return rows;
    }
    return rows;
}

function readAvroLong(data: Uint8Array, offset: number): { value: bigint; offset: number } {
    let result = 0n;
    let shift = 0n;
    let cursor = offset;
    while (cursor < data.length) {
        const byte = data[cursor++];
        if (byte === undefined) break;
        result |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return { value: (result >> 1n) ^ -(result & 1n), offset: cursor };
        shift += 7n;
        if (shift > 63n) break;
    }
    throw new Error('Invalid Avro long value.');
}

function readAvroBytes(data: Uint8Array, offset: number): { bytes: Uint8Array; offset: number } {
    const lengthResult = readAvroLong(data, offset);
    const length = Number(lengthResult.value);
    if (!Number.isSafeInteger(length) || length < 0 || lengthResult.offset + length > data.length) {
        throw new Error('Invalid Avro bytes value.');
    }
    return { bytes: data.subarray(lengthResult.offset, lengthResult.offset + length), offset: lengthResult.offset + length };
}

function printableMetadataValue(key: string, value: Uint8Array): string {
    const text = utf8.decode(value);
    if (key === 'avro.schema') return compactJson(text);
    return value.every(byte => (byte >= 32 && byte <= 126) || byte === 9 || byte === 10 || byte === 13) ? text : toHex(value);
}

function extractStepHeader(source: string): Record<'name' | 'timestamp' | 'author' | 'organization' | 'preprocessor' | 'originatingSystem' | 'authorization' | 'schema', string> {
    const description = matchStepHeaderValue(source, 'FILE_DESCRIPTION');
    const nameFields = splitStepArguments(matchStepHeaderValue(source, 'FILE_NAME'));
    return {
        name: nameFields[0] ?? '', timestamp: nameFields[1] ?? '', author: nameFields[2] ?? '',
        organization: nameFields[3] ?? '', preprocessor: nameFields[4] ?? '', originatingSystem: nameFields[5] ?? '',
        authorization: nameFields[6] ?? description, schema: splitStepArguments(matchStepHeaderValue(source, 'FILE_SCHEMA')).join(', ')
    };
}

function matchStepHeaderValue(source: string, keyword: string): string {
    return new RegExp(`${keyword}\\s*\\(([^;]*)\\);`, 'i').exec(source)?.[1]?.trim() ?? '';
}

function splitStepArguments(value: string): string[] {
    const args: string[] = [];
    let current = '';
    let inString = false;
    let depth = 0;
    for (const char of value) {
        if (char === "'") { inString = !inString; continue; }
        if (!inString && char === '(') { depth++; continue; }
        if (!inString && char === ')') { depth = Math.max(0, depth - 1); continue; }
        if (!inString && depth === 0 && char === ',') { args.push(cleanStepValue(current)); current = ''; continue; }
        current += char;
    }
    if (current.trim()) args.push(cleanStepValue(current));
    return args;
}

function cleanStepValue(value: string): string {
    return value.replace(/^\s*\$?\s*|\s*$/g, '').replace(/^'(.*)'$/s, '$1').trim();
}

function collectStepEntities(source: string): Array<{ id: string; type: string; line: number }> {
    const entities: Array<{ id: string; type: string; line: number }> = [];
    source.split(/\r?\n/).forEach((line, index) => {
        const match = /^\s*#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(/i.exec(line);
        if (match?.[1] && match[2]) entities.push({ id: `#${match[1]}`, type: match[2].toUpperCase(), line: index + 1 });
    });
    return entities;
}

function extractReqifHeader(source: string): Record<'title' | 'identifier' | 'sourceToolId' | 'reqifToolId' | 'creationTime' | 'comment', string> {
    const match = /<REQ-IF-HEADER\b[^>]*>([\s\S]*?)<\/REQ-IF-HEADER>/i.exec(source);
    const header = match?.[1] ?? '';
    return {
        title: extractFirstTagText(header, 'TITLE'), identifier: extractAttribute(match?.[0] ?? '', 'IDENTIFIER'),
        sourceToolId: extractFirstTagText(header, 'SOURCE-TOOL-ID'), reqifToolId: extractFirstTagText(header, 'REQ-IF-TOOL-ID'),
        creationTime: extractFirstTagText(header, 'CREATION-TIME'), comment: extractFirstTagText(header, 'COMMENT')
    };
}

function collectReqifElements(source: string, tagPattern: string): Array<{ identifier: string; longName: string; type: string }> {
    const elements: Array<{ identifier: string; longName: string; type: string }> = [];
    const pattern = new RegExp(`<(${tagPattern})(?!-)\\b([^>]*)>`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
        elements.push({
            type: match[1]?.toUpperCase() ?? '',
            identifier: extractAttribute(match[2] ?? '', 'IDENTIFIER') || '-',
            longName: decodeXml(extractAttribute(match[2] ?? '', 'LONG-NAME') || '-')
        });
    }
    return elements;
}

function reqifRows(items: Array<{ identifier: string; longName: string; type: string }>, limit: number): AutomotiveCell[][] {
    return items.slice(0, limit).map(item => [item.identifier, item.longName, item.type]);
}

function extractFirstTagText(source: string, tagName: string): string {
    const value = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i').exec(source)?.[1];
    return value ? decodeXml(value.trim()) : '';
}

function extractAttribute(source: string, name: string): string {
    return new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(source)?.[1] ?? '';
}

function parseSqliteDatabase(data: Uint8Array, pageSize: number): SqliteParseResult {
    const warnings: string[] = [];
    const schemaRecords = readSqliteTableRecords(data, pageSize, 1, 500, warnings);
    const schema = schemaRecords.map(toSqliteSchemaEntry).filter((entry): entry is SqliteSchemaEntry => entry !== null);
    const previews = schema
        .filter(entry => entry.type === 'table' && entry.rootPage > 0 && !entry.name.startsWith('sqlite_'))
        .slice(0, 12)
        .map(entry => {
            const columns = extractSqliteColumnNames(entry.sql);
            const rows = readSqliteTableRecords(data, pageSize, entry.rootPage, 100, warnings);
            return {
                tableName: entry.name, columns,
                rows: rows.map(row => ({ rowid: row.rowid, values: alignSqliteRowValues(columns, row) })),
                truncated: rows.length >= 100
            };
        });
    if (!schemaRecords.length) warnings.push('Could not decode sqlite_master rows from page 1.');
    previews.filter(item => item.truncated).forEach(item => warnings.push(`Table ${item.tableName} preview is limited to the first 100 rows.`));
    return { schema, previews, warnings: [...new Set(warnings)] };
}

function toSqliteSchemaEntry(record: SqliteRecord): SqliteSchemaEntry | null {
    if (record.values.length < 5) return null;
    return {
        type: String(record.values[0] ?? ''), name: String(record.values[1] ?? ''), tableName: String(record.values[2] ?? ''),
        rootPage: Number(record.values[3]) || 0, sql: String(record.values[4] ?? '')
    };
}

function readSqliteTableRecords(data: Uint8Array, pageSize: number, rootPage: number, limit: number, warnings: string[], visited = new Set<number>()): SqliteRecord[] {
    if (rootPage <= 0 || visited.has(rootPage) || visited.size > 512) return [];
    visited.add(rootPage);
    const page = getSqlitePage(data, pageSize, rootPage);
    if (!page) { warnings.push(`Could not read SQLite page ${rootPage}.`); return []; }
    const headerOffset = rootPage === 1 ? 100 : 0;
    if (page.length < headerOffset + 8) { warnings.push(`SQLite page ${rootPage} is too small to contain a b-tree header.`); return []; }
    const pageType = page[headerOffset];
    const cellCount = readU16BE(page, headerOffset + 3);
    const records: SqliteRecord[] = [];
    if (pageType === 0x0d) {
        for (let index = 0; index < cellCount && records.length < limit; index++) {
            const pointerOffset = headerOffset + 8 + index * 2;
            if (pointerOffset + 2 > page.length) break;
            const record = readSqliteTableLeafCell(data, page, pageSize, readU16BE(page, pointerOffset), rootPage, warnings);
            if (record) records.push(record);
        }
        return records;
    }
    if (pageType === 0x05) {
        for (let index = 0; index < cellCount && records.length < limit; index++) {
            const pointerOffset = headerOffset + 12 + index * 2;
            if (pointerOffset + 2 > page.length) break;
            const cellOffset = readU16BE(page, pointerOffset);
            if (cellOffset + 4 <= page.length) {
                records.push(...readSqliteTableRecords(data, pageSize, readU32BE(page, cellOffset), limit - records.length, warnings, visited));
            }
        }
        if (records.length < limit && headerOffset + 12 <= page.length) {
            records.push(...readSqliteTableRecords(data, pageSize, readU32BE(page, headerOffset + 8), limit - records.length, warnings, visited));
        }
        return records;
    }
    warnings.push(`SQLite page ${rootPage} has unsupported b-tree page type 0x${(pageType ?? 0).toString(16)}.`);
    return [];
}

function readSqliteTableLeafCell(data: Uint8Array, page: Uint8Array, pageSize: number, cellOffset: number, pageNumber: number, warnings: string[]): SqliteRecord | null {
    if (cellOffset <= 0 || cellOffset >= page.length) return null;
    try {
        const payloadSize = readSqliteVarint(page, cellOffset);
        const rowid = readSqliteVarint(page, payloadSize.offset);
        const payload = readSqlitePayload(data, page, pageSize, rowid.offset, Number(payloadSize.value), warnings);
        return { rowid: displaySqliteInteger(rowid.value), values: decodeSqliteRecord(payload) };
    } catch {
        warnings.push(`Could not decode SQLite table cell on page ${pageNumber} at offset 0x${cellOffset.toString(16)}.`);
        return null;
    }
}

function readSqlitePayload(data: Uint8Array, page: Uint8Array, pageSize: number, payloadStart: number, payloadSize: number, warnings: string[]): Uint8Array {
    if (payloadSize <= 0) return new Uint8Array();
    const maxLocal = pageSize - 35;
    let localSize = payloadSize;
    let overflowPointerOffset = -1;
    if (payloadSize > maxLocal) {
        const minLocal = Math.floor((pageSize - 12) * 32 / 255) - 23;
        localSize = minLocal + (payloadSize - minLocal) % (pageSize - 4);
        if (localSize > maxLocal) localSize = minLocal;
        overflowPointerOffset = payloadStart + localSize;
    }
    const chunks = [page.subarray(payloadStart, Math.min(payloadStart + localSize, page.length))];
    if (overflowPointerOffset >= 0 && overflowPointerOffset + 4 <= page.length) {
        let nextPage = readU32BE(page, overflowPointerOffset);
        let remaining = payloadSize - localSize;
        let guard = 0;
        while (nextPage > 0 && remaining > 0 && guard++ < 256) {
            const overflow = getSqlitePage(data, pageSize, nextPage);
            if (!overflow || overflow.length < 4) { warnings.push(`SQLite overflow page ${nextPage} could not be read.`); break; }
            nextPage = readU32BE(overflow, 0);
            const chunk = overflow.subarray(4, Math.min(4 + remaining, overflow.length));
            chunks.push(chunk);
            remaining -= chunk.length;
        }
        if (remaining > 0) warnings.push('A SQLite record uses overflow pages that could not be fully reconstructed.');
    }
    return concatBytes(chunks, payloadSize);
}

function decodeSqliteRecord(payload: Uint8Array): AutomotiveCell[] {
    if (!payload.length) return [];
    const header = readSqliteVarint(payload, 0);
    const headerSize = Number(header.value);
    const serialTypes: bigint[] = [];
    let cursor = header.offset;
    while (cursor < headerSize && cursor < payload.length) {
        const serial = readSqliteVarint(payload, cursor);
        serialTypes.push(serial.value);
        cursor = serial.offset;
    }
    let bodyOffset = headerSize;
    return serialTypes.map(serialType => {
        const decoded = decodeSqliteValue(payload, bodyOffset, serialType);
        bodyOffset += decoded.bytesRead;
        return decoded.value;
    });
}

function decodeSqliteValue(payload: Uint8Array, offset: number, serialType: bigint): { value: AutomotiveCell; bytesRead: number } {
    const type = Number(serialType);
    const requireBytes = (count: number): void => { if (offset < 0 || offset + count > payload.length) throw new Error('SQLite value exceeds payload.'); };
    switch (type) {
    case 0: return { value: 'NULL', bytesRead: 0 };
    case 1: requireBytes(1); return { value: view(payload).getInt8(offset), bytesRead: 1 };
    case 2: requireBytes(2); return { value: view(payload).getInt16(offset), bytesRead: 2 };
    case 3: requireBytes(3); return { value: readSignedInteger(payload, offset, 3), bytesRead: 3 };
    case 4: requireBytes(4); return { value: view(payload).getInt32(offset), bytesRead: 4 };
    case 5: requireBytes(6); return { value: readSignedInteger(payload, offset, 6), bytesRead: 6 };
    case 6: requireBytes(8); return { value: displaySqliteInteger(view(payload).getBigInt64(offset)), bytesRead: 8 };
    case 7: requireBytes(8); return { value: view(payload).getFloat64(offset), bytesRead: 8 };
    case 8: return { value: 0, bytesRead: 0 };
    case 9: return { value: 1, bytesRead: 0 };
    default: {
        if (type < 12) return { value: `reserved(${type})`, bytesRead: 0 };
        const length = type % 2 === 0 ? (type - 12) / 2 : (type - 13) / 2;
        requireBytes(length);
        const bytes = payload.subarray(offset, offset + length);
        return type % 2 === 0
            ? { value: `BLOB(${length} bytes) ${toHex(bytes.subarray(0, 24))}${length > 24 ? '...' : ''}`, bytesRead: length }
            : { value: utf8.decode(bytes), bytesRead: length };
    }
    }
}

function readSqliteVarint(data: Uint8Array, offset: number): { value: bigint; offset: number } {
    let value = 0n;
    for (let index = 0; index < 9; index++) {
        const byte = data[offset + index];
        if (byte === undefined) throw new Error('SQLite varint exceeds buffer bounds.');
        if (index === 8) return { value: (value << 8n) | BigInt(byte), offset: offset + 9 };
        value = (value << 7n) | BigInt(byte & 0x7f);
        if ((byte & 0x80) === 0) return { value, offset: offset + index + 1 };
    }
    throw new Error('Invalid SQLite varint.');
}

function readSignedInteger(data: Uint8Array, offset: number, byteLength: number): number {
    let value = 0n;
    for (let index = 0; index < byteLength; index++) value = (value << 8n) | BigInt(data[offset + index] ?? 0);
    const signBit = 1n << BigInt(byteLength * 8 - 1);
    if ((value & signBit) !== 0n) value -= 1n << BigInt(byteLength * 8);
    return Number(value);
}

function displaySqliteInteger(value: bigint): number | string {
    return value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER) ? value.toString() : Number(value);
}

function extractSqliteColumnNames(sql: string): string[] {
    const open = sql.indexOf('(');
    const close = sql.lastIndexOf(')');
    if (open < 0 || close <= open) return [];
    return splitSqliteDefinitions(sql.slice(open + 1, close)).map(extractSqliteColumnName).filter((name): name is string => Boolean(name));
}

function splitSqliteDefinitions(source: string): string[] {
    const values: string[] = [];
    let current = '';
    let depth = 0;
    let quote: string | null = null;
    for (const char of source) {
        if (quote) { current += char; if (char === quote) quote = null; continue; }
        if (char === "'" || char === '"' || char === '`' || char === '[') { quote = char === '[' ? ']' : char; current += char; continue; }
        if (char === '(') depth++;
        else if (char === ')') depth = Math.max(0, depth - 1);
        else if (char === ',' && depth === 0) { values.push(current.trim()); current = ''; continue; }
        current += char;
    }
    if (current.trim()) values.push(current.trim());
    return values;
}

function extractSqliteColumnName(definition: string): string | null {
    const trimmed = definition.trim();
    if (!trimmed || /^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|KEY)\b/i.test(trimmed)) return null;
    const quoted = /^"([^"]+)"|^`([^`]+)`|^\[([^\]]+)\]|^'([^']+)'/.exec(trimmed);
    return quoted ? quoted[1] ?? quoted[2] ?? quoted[3] ?? quoted[4] ?? null : /^([^\s,]+)/.exec(trimmed)?.[1] ?? null;
}

function alignSqliteRowValues(columns: string[], row: SqliteRecord): AutomotiveCell[] {
    const values = [...row.values];
    if (values.length < columns.length) values.push(...Array<AutomotiveCell>(columns.length - values.length).fill(''));
    return values.slice(0, Math.max(columns.length, values.length));
}

function readSqlitePageSize(data: Uint8Array): number {
    const size = readU16BE(data, 16);
    return size === 1 ? 65_536 : size;
}

function extractSqliteSchemaHints(data: Uint8Array): string[] {
    const text = latin1.decode(data.subarray(0, Math.min(data.length, 1024 * 1024)));
    return (text.match(/CREATE\s+(?:TABLE|INDEX|VIEW|TRIGGER)[\s\S]{0,400}?(?=\0|$)/gi) ?? [])
        .map(value => value.replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 100);
}

function getSqlitePage(data: Uint8Array, pageSize: number, pageNumber: number): Uint8Array | null {
    const offset = (pageNumber - 1) * pageSize;
    return pageNumber > 0 && offset >= 0 && offset < data.length ? data.subarray(offset, Math.min(offset + pageSize, data.length)) : null;
}

function view(data: Uint8Array): DataView {
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function readU16BE(data: Uint8Array, offset: number): number {
    if (offset < 0 || offset + 2 > data.length) throw new Error('Read exceeds buffer bounds.');
    return view(data).getUint16(offset);
}

function readU32BE(data: Uint8Array, offset: number): number {
    if (offset < 0 || offset + 4 > data.length) throw new Error('Read exceeds buffer bounds.');
    return view(data).getUint32(offset);
}

function concatBytes(chunks: Uint8Array[], limit: number): Uint8Array {
    const length = Math.min(limit, chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        const next = chunk.subarray(0, Math.min(chunk.length, length - offset));
        result.set(next, offset);
        offset += next.length;
        if (offset >= length) break;
    }
    return result;
}

function hexRows(data: Uint8Array, start: number, end: number): AutomotiveCell[][] {
    const rows: AutomotiveCell[][] = [];
    for (let offset = start; offset < end; offset += 16) {
        const bytes = data.subarray(offset, Math.min(offset + 16, end));
        rows.push([
            `0x${offset.toString(16).padStart(8, '0')}`,
            [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(' '),
            [...bytes].map(byte => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('')
        ]);
    }
    return rows;
}

function firstAsciiLine(data: Uint8Array): string {
    const newline = data.indexOf(0x0a);
    return ascii(data.subarray(0, newline < 0 ? Math.min(data.length, 256) : newline)).trim();
}

function countBagOperations(data: Uint8Array): {
    bagHeader: number;
    chunk: number;
    connection: number;
    indexData: number;
    chunkInfo: number;
    messageData: number;
} {
    const counts = { bagHeader: 0, chunk: 0, connection: 0, indexData: 0, chunkInfo: 0, messageData: 0 };
    for (let offset = 0; offset + 3 < data.length; offset++) {
        if (data[offset] !== 0x6f || data[offset + 1] !== 0x70 || data[offset + 2] !== 0x3d) continue;
        switch (data[offset + 3]) {
        case 0x02: counts.messageData++; break;
        case 0x03: counts.bagHeader++; break;
        case 0x04: counts.indexData++; break;
        case 0x05: counts.chunk++; break;
        case 0x06: counts.chunkInfo++; break;
        case 0x07: counts.connection++; break;
        }
        offset += 3;
    }
    return counts;
}

function countBytes(data: Uint8Array, needle: readonly number[]): number {
    let count = 0;
    for (let offset = 0; offset <= data.length - needle.length; offset++) {
        if (matchesBytes(data, offset, needle)) { count++; offset += needle.length - 1; }
    }
    return count;
}

function matchesBytes(data: Uint8Array, offset: number, expected: readonly number[]): boolean {
    return offset >= 0 && offset + expected.length <= data.length && expected.every((byte, index) => data[offset + index] === byte);
}

function ascii(data: Uint8Array): string {
    return [...data].map(byte => String.fromCharCode(byte)).join('');
}

function toHex(data: Uint8Array): string {
    return [...data].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function compactJson(value: string): string {
    try { return JSON.stringify(JSON.parse(value)); } catch { return value; }
}

function prettyJson(value: string): string {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

function preview(source: string): string {
    return source.length > 200_000 ? `${source.slice(0, 200_000)}\n\n[Preview truncated]` : source;
}

function decodeXml(value: string): string {
    return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
