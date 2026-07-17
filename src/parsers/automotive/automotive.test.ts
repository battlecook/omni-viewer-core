import { describe, expect, it } from 'vitest';
import { parseAvro, parseBag, parseDb3, parseReqif, parseStp } from './index.js';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('automotive parsers', () => {
    it('decodes Avro object-container metadata and schema', () => {
        const schema = '{"type":"record","name":"Ping","fields":[]}';
        const metadata = concat(
            Uint8Array.of(4),
            avroBytes('avro.schema'), avroBytes(schema),
            avroBytes('avro.codec'), avroBytes('null'),
            Uint8Array.of(0)
        );
        const model = parseAvro(concat(Uint8Array.of(0x4f, 0x62, 0x6a, 0x01), metadata, new Uint8Array(16)));
        expect(model.warnings).toEqual([]);
        expect(model.tables[0]?.rows).toEqual(expect.arrayContaining([
            ['avro.codec', 'null'],
            ['avro.schema', schema]
        ]));
        expect(model.rawPreview).toContain('"name": "Ping"');
    });

    it('recognizes ROS bag records without decoding payload bodies', () => {
        const model = parseBag(concat(encode('#ROSBAG V2.0\n'), encode('header op='), Uint8Array.of(0x07), encode(' x op='), Uint8Array.of(0x05)));
        expect(model.warnings).toEqual([]);
        expect(model.summary).toEqual(expect.arrayContaining([
            { label: 'Connection records', value: 1 },
            { label: 'Chunk records', value: 1 }
        ]));
    });

    it('bounds ROS bag, STEP, and ReqIF scans for large inputs', () => {
        const bagLimit = 8 * 1024 * 1024;
        const bag = new Uint8Array(bagLimit + 4);
        bag.set(encode('#ROSBAG V2.0\n'));
        bag.set(Uint8Array.of(0x6f, 0x70, 0x3d, 0x07), bagLimit);
        const bagModel = parseBag(bag);
        expect(bagModel.summary).toContainEqual({ label: 'Connection records', value: 0 });
        expect(bagModel.warnings.join(' ')).toContain('first 8 MiB');

        const textLimit = 4 * 1024 * 1024;
        const step = new Uint8Array(textLimit + 32);
        step.set(encode('ISO-10303-21;\n'));
        step.set(encode('#1=POINT();'), textLimit);
        const stepModel = parseStp(step);
        expect(stepModel.summary).toContainEqual({ label: 'Entity lines', value: 0 });
        expect(stepModel.warnings.join(' ')).toContain('STEP text scan');

        const reqif = new Uint8Array(textLimit + 80);
        reqif.set(encode('<REQ-IF>'));
        reqif.set(encode('<SPEC-OBJECT IDENTIFIER="LATE"/>'), textLimit);
        const reqifModel = parseReqif(reqif);
        expect(reqifModel.summary).toContainEqual({ label: 'Spec objects', value: 0 });
        expect(reqifModel.warnings.join(' ')).toContain('ReqIF XML scan');
    });

    it('extracts STEP header fields and entity counts', () => {
        const model = parseStp(encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Example'),'2;1');
FILE_NAME('part.step','2026-07-16T00:00:00',('Kim'),('Omni'),'writer','CAD','approved');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN_CC2'));
ENDSEC;
DATA;
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(1.,0.,0.));
#3=DIRECTION('',(0.,0.,1.));
ENDSEC;
END-ISO-10303-21;`));
        expect(model.summary).toEqual(expect.arrayContaining([
            { label: 'Schema', value: 'AUTOMOTIVE_DESIGN_CC2' },
            { label: 'Entity lines', value: 3 },
            { label: 'Entity types', value: 2 }
        ]));
        expect(model.tables[1]?.rows[0]).toEqual(['CARTESIAN_POINT', 2]);
    });

    it('extracts ReqIF header, objects, specifications, and relations', () => {
        const model = parseReqif(encode(`<?xml version="1.0"?>
<REQ-IF><THE-HEADER><REQ-IF-HEADER IDENTIFIER="hdr"><TITLE>Brakes &amp; Safety</TITLE><SOURCE-TOOL-ID>Omni</SOURCE-TOOL-ID></REQ-IF-HEADER></THE-HEADER>
<CORE-CONTENT><REQ-IF-CONTENT>
<SPEC-OBJECTS><SPEC-OBJECT IDENTIFIER="REQ-1" LONG-NAME="Stop &amp; hold"></SPEC-OBJECT></SPEC-OBJECTS>
<SPECIFICATIONS><SPECIFICATION IDENTIFIER="SPEC-1" LONG-NAME="Braking"></SPECIFICATION></SPECIFICATIONS>
<SPEC-RELATIONS><SPEC-RELATION IDENTIFIER="REL-1"></SPEC-RELATION></SPEC-RELATIONS>
</REQ-IF-CONTENT></CORE-CONTENT></REQ-IF>`));
        expect(model.summary).toEqual(expect.arrayContaining([
            { label: 'Title', value: 'Brakes & Safety' },
            { label: 'Spec objects', value: 1 },
            { label: 'Specifications', value: 1 },
            { label: 'Spec relations', value: 1 }
        ]));
        expect(model.tables[2]?.rows[0]).toEqual(['REQ-1', 'Stop & hold', 'SPEC-OBJECT']);
    });

    it('decodes sqlite_master and previews table rows from DB3 bytes', () => {
        const model = parseDb3(sqliteFixture());
        expect(model.warnings).toEqual([]);
        expect(model.summary).toContainEqual({ label: 'Tables', value: 1 });
        expect(model.tables[1]?.rows[0]).toEqual(['table', 'topics', 'topics', 2, 'CREATE TABLE topics(name TEXT, type TEXT)']);
        const topics = model.tables.find(table => table.title === 'Rows: topics');
        expect(topics?.headers).toEqual(['rowid', 'name', 'type']);
        expect(topics?.rows[0]).toEqual([1, '/camera', 'sensor_msgs/Image']);
    });

    it('returns useful warnings for mismatched binary formats', () => {
        expect(parseAvro(encode('not avro')).warnings).toHaveLength(1);
        expect(parseBag(encode('not bag')).warnings).toHaveLength(1);
        expect(parseDb3(encode('not sqlite')).warnings).toHaveLength(1);
    });
});

function avroBytes(value: string): Uint8Array {
    const bytes = encode(value);
    return concat(Uint8Array.of(bytes.length * 2), bytes);
}

function sqliteFixture(): Uint8Array {
    const pageSize = 512;
    const database = new Uint8Array(pageSize * 2);
    database.set(encode('SQLite format 3\0'));
    database[16] = 0x02;
    database[17] = 0x00;
    database[18] = database[19] = 1;
    database[21] = 64;
    database[22] = 32;
    database[23] = 32;
    writeU32(database, 28, 2);
    writeU32(database, 40, 1);
    writeU32(database, 44, 4);
    writeU32(database, 56, 1);

    const schemaRecord = sqliteRecord(['table', 'topics', 'topics', 2, 'CREATE TABLE topics(name TEXT, type TEXT)']);
    writeLeafPage(database, 0, 100, schemaRecord);
    const topicRecord = sqliteRecord(['/camera', 'sensor_msgs/Image']);
    writeLeafPage(database, pageSize, 0, topicRecord);
    return database;
}

function writeLeafPage(database: Uint8Array, pageStart: number, headerOffset: number, record: Uint8Array): void {
    const cellOffset = 512 - record.length - 2;
    database[pageStart + headerOffset] = 0x0d;
    writeU16(database, pageStart + headerOffset + 3, 1);
    writeU16(database, pageStart + headerOffset + 5, cellOffset);
    writeU16(database, pageStart + headerOffset + 8, cellOffset);
    database[pageStart + cellOffset] = record.length;
    database[pageStart + cellOffset + 1] = 1;
    database.set(record, pageStart + cellOffset + 2);
}

function sqliteRecord(values: Array<string | number>): Uint8Array {
    const bodies = values.map(value => typeof value === 'number' ? Uint8Array.of(value) : encode(value));
    const serialTypes = values.map((value, index) => typeof value === 'number' ? 1 : 13 + bodies[index]!.length * 2);
    const header = Uint8Array.of(serialTypes.length + 1, ...serialTypes);
    return concat(header, ...bodies);
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
    target[offset] = (value >>> 8) & 0xff;
    target[offset + 1] = value & 0xff;
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
    target[offset] = (value >>> 24) & 0xff;
    target[offset + 1] = (value >>> 16) & 0xff;
    target[offset + 2] = (value >>> 8) & 0xff;
    target[offset + 3] = value & 0xff;
}

function concat(...parts: Uint8Array[]): Uint8Array {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    parts.forEach(part => { result.set(part, offset); offset += part.length; });
    return result;
}
