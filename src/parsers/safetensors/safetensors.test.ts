import { describe, expect, it } from 'vitest';
import { formatCount, parseSafetensors, parseSafetensorsSource } from './index.js';

/** Build a safetensors buffer from a header object plus a trailing data buffer. */
function buildSafetensors(header: Record<string, unknown>, dataBytes = 0): Uint8Array {
    const headerJson = new TextEncoder().encode(JSON.stringify(header));
    const out = new Uint8Array(8 + headerJson.length + dataBytes);
    new DataView(out.buffer).setBigUint64(0, BigInt(headerJson.length), true);
    out.set(headerJson, 8);
    return out;
}

describe('parseSafetensors', () => {
    it('reads tensors, parameter counts, dtypes and metadata from the header', () => {
        const buffer = buildSafetensors({
            __metadata__: { format: 'pt', producer: 'unit-test' },
            'model.weight': { dtype: 'F32', shape: [2, 3], data_offsets: [0, 24] },
            'model.bias': { dtype: 'F32', shape: [3], data_offsets: [24, 36] }
        }, 36);

        const doc = parseSafetensors(buffer);
        expect(doc.format).toBe('safetensors');
        expect(doc.warnings).toHaveLength(0);

        const tensors = doc.tables.find(t => t.title.startsWith('Tensors'))!;
        expect(tensors.rows).toHaveLength(2);
        // Sorted by data offset: weight (0) before bias (24).
        expect(tensors.rows[0]).toEqual(['model.weight', 'F32', '2 × 3', 6, '24 bytes']);
        expect(tensors.rows[1]).toEqual(['model.bias', 'F32', '3', 3, '12 bytes']);

        const meta = doc.tables.find(t => t.title.startsWith('Metadata'))!;
        expect(meta.rows).toContainEqual(['producer', 'unit-test']);

        expect(doc.summary).toContainEqual({ label: 'Tensors', value: 2 });
        expect(doc.summary).toContainEqual({ label: 'Parameters', value: '9' });
        expect(doc.summary).toContainEqual({ label: 'Data types', value: 'F32' });
    });

    it('warns when a byte range disagrees with dtype and shape', () => {
        const buffer = buildSafetensors({
            't': { dtype: 'F32', shape: [4], data_offsets: [0, 8] } // 4×4=16 expected, 8 given
        }, 8);
        const doc = parseSafetensors(buffer);
        expect(doc.warnings.some(w => w.includes('inconsistent'))).toBe(true);
    });

    it('recognizes current packed and float8 dtypes', () => {
        const buffer = buildSafetensors({
            packed4: { dtype: 'F4', shape: [2], data_offsets: [0, 1] },
            packed6: { dtype: 'F6_E2M3', shape: [4], data_offsets: [1, 4] },
            scale: { dtype: 'F8_E8M0', shape: [1], data_offsets: [4, 5] }
        }, 5);
        expect(parseSafetensors(buffer).warnings).toEqual([]);
    });

    it('warns about malformed entries and unpacked data buffers', () => {
        const buffer = buildSafetensors({
            broken: { dtype: 'F32', shape: [-1], data_offsets: [1, 5] }
        }, 5);
        const warnings = parseSafetensors(buffer).warnings.join('\n');
        expect(warnings).toContain('invalid dtype, shape, or data offset');
        expect(warnings).toContain('byte ranges are inconsistent');
    });

    it('keeps only string metadata values', () => {
        const buffer = buildSafetensors({ __metadata__: { valid: 'yes', invalid: 3 } });
        const doc = parseSafetensors(buffer);
        expect(doc.tables.find(table => table.title.startsWith('Metadata'))?.rows)
            .toEqual([['valid', 'yes']]);
        expect(doc.warnings.join('\n')).toContain('not strings');
    });

    it('flags a header longer than the file as invalid', () => {
        const buffer = new Uint8Array(8);
        new DataView(buffer.buffer).setBigUint64(0, 999n, true);
        const doc = parseSafetensors(buffer);
        expect(doc.tables).toHaveLength(0);
        expect(doc.warnings[0]).toContain('past the end');
    });

    it('rejects a non-JSON header', () => {
        const bad = new TextEncoder().encode('not json');
        const buffer = new Uint8Array(8 + bad.length);
        new DataView(buffer.buffer).setBigUint64(0, BigInt(bad.length), true);
        buffer.set(bad, 8);
        const doc = parseSafetensors(buffer);
        expect(doc.warnings[0]).toContain('begin with a JSON object');
    });

    it('rejects invalid UTF-8 in the JSON header', () => {
        const buffer = new Uint8Array(10);
        new DataView(buffer.buffer).setBigUint64(0, 2n, true);
        buffer.set([0x7b, 0xff], 8);
        expect(parseSafetensors(buffer).warnings[0]).toContain('not valid JSON');
    });

    it('handles a file too small to hold a header length', () => {
        expect(parseSafetensors(new Uint8Array(4)).warnings[0]).toContain('too small');
    });

    it('reads only the length prefix and JSON header from a large random-access source', async () => {
        const payloadBytes = 10 * 1024 * 1024 * 1024;
        const header = buildSafetensors({
            weight: { dtype: 'U8', shape: [payloadBytes], data_offsets: [0, payloadBytes] }
        });
        const reads: Array<[number, number]> = [];
        const doc = await parseSafetensorsSource({
            size: header.byteLength + payloadBytes,
            read(offset, length) {
                reads.push([offset, length]);
                return header.subarray(offset, Math.min(offset + length, header.byteLength));
            }
        });

        expect(reads).toEqual([[0, 8], [8, header.byteLength - 8]]);
        expect(doc.fileSize).toBe('10.0 GB');
        expect(doc.warnings).toEqual([]);
        expect(doc.tables[0]?.rows[0]).toEqual(['weight', 'U8', String(payloadBytes), payloadBytes, '10.0 GB']);
    });

    it('does not read a JSON header declared beyond the source size', async () => {
        const prefix = new Uint8Array(8);
        new DataView(prefix.buffer).setBigUint64(0, 999n, true);
        const reads: Array<[number, number]> = [];
        const doc = await parseSafetensorsSource({
            size: 100,
            read(offset, length) {
                reads.push([offset, length]);
                return prefix.subarray(offset, offset + length);
            }
        });

        expect(reads).toEqual([[0, 8]]);
        expect(doc.warnings[0]).toContain('past the end');
    });
});

describe('parseSafetensors hostile headers', () => {
    // `dtype` is attacker-controlled text. A plain-object lookup resolved
    // these to inherited functions, and `BigInt(fn)` threw a SyntaxError that
    // made an otherwise readable model unviewable.
    it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])(
        'treats the inherited member name %s as an unrecognized dtype',
        dtype => {
            const buffer = buildSafetensors({
                w: { dtype, shape: [1], data_offsets: [0, 4] }
            }, 4);

            const doc = parseSafetensors(buffer);
            expect(doc.warnings).toContain('Some tensors use a dtype this viewer does not recognize.');
            expect(doc.tables[0]?.rows[0]?.[1]).toBe(dtype);
        }
    );

    it('lists a __proto__ metadata key instead of dropping it', () => {
        // A `__proto__:` key in a JS object literal sets the prototype, so the
        // fixture has to come through JSON.parse to carry it as a real key —
        // exactly how it arrives out of a file.
        const buffer = buildSafetensors({
            __metadata__: JSON.parse('{"__proto__":"pwned","format":"pt"}') as unknown,
            w: { dtype: 'U8', shape: [4], data_offsets: [0, 4] }
        }, 4);

        const doc = parseSafetensors(buffer);
        const meta = doc.tables.find(t => t.title.startsWith('Metadata'))!;
        expect(meta.rows).toContainEqual(['__proto__', 'pwned']);
        expect(doc.summary).toContainEqual({ label: 'Metadata keys', value: 2 });
        // The header must not reach Object.prototype.
        expect(({} as Record<string, unknown>).pwned).toBeUndefined();
    });

    it('caps a header declaring more entries than any real model has', () => {
        const header: Record<string, unknown> = { __metadata__: { format: 'pt' } };
        for (let i = 0; i < 50_010; i++) {
            header[`t${i}`] = { dtype: 'U8', shape: [0], data_offsets: [0, 0] };
        }

        const doc = parseSafetensors(buildSafetensors(header));
        // Exactly the cap: `__metadata__` is not a tensor and must not eat a slot.
        expect(doc.tables[0]?.rows).toHaveLength(50_000);
        expect(doc.summary).toContainEqual({ label: 'Tensors', value: 50_000 });
        expect(doc.warnings.some(w => w.includes('50010') && w.includes('50000'))).toBe(true);
    });

    it('does not claim truncation for a header that exactly fills the cap', () => {
        const header: Record<string, unknown> = { __metadata__: { format: 'pt' } };
        for (let i = 0; i < 50_000; i++) {
            header[`t${i}`] = { dtype: 'U8', shape: [0], data_offsets: [0, 0] };
        }

        const doc = parseSafetensors(buildSafetensors(header));
        expect(doc.tables[0]?.rows).toHaveLength(50_000);
        expect(doc.warnings.some(w => w.includes('only the first'))).toBe(false);
    });

    it('refuses an oversized header without parsing it', async () => {
        // 40 MB of "header": legal per the spec, but JSON.parse on it would
        // freeze the host for seconds. The bytes must never be read.
        const prefix = new Uint8Array(8);
        new DataView(prefix.buffer).setBigUint64(0, 40_000_000n, true);
        const reads: Array<[number, number]> = [];

        const doc = await parseSafetensorsSource({
            size: 41_000_000,
            read(offset, length) {
                reads.push([offset, length]);
                return prefix.subarray(offset, offset + length);
            }
        });

        expect(reads).toEqual([[0, 8]]);
        expect(doc.warnings[0]).toContain('too large to display');
        expect(doc.summary).toContainEqual({ label: 'Status', value: 'invalid' });
    });

    it('shortens a tensor name too long to display and says so', () => {
        const buffer = buildSafetensors({
            ['w'.repeat(5_000_000)]: { dtype: 'U8', shape: [4], data_offsets: [0, 4] }
        }, 4);

        const doc = parseSafetensors(buffer);
        const name = doc.tables[0]?.rows[0]?.[0] as string;
        expect(name.length).toBeLessThan(600);
        expect(doc.warnings).toContain('Some names or metadata values were too long to show in full and were shortened.');
        // The preview is a second copy of every name; it must be bounded too.
        expect(doc.rawPreview!.length).toBeLessThan(1_000);
    });

    it('bounds the Data types summary and keys it on the shortened dtype', () => {
        const header: Record<string, unknown> = {};
        for (let i = 0; i < 200; i++) {
            header[`t${i}`] = { dtype: `D${'x'.repeat(5000)}${i}`, shape: [0], data_offsets: [0, 0] };
        }

        const doc = parseSafetensors(buildSafetensors(header));
        const dataTypes = doc.summary.find(item => item.label === 'Data types')!.value as string;
        expect(dataTypes.length).toBeLessThan(20_000);
        expect(dataTypes).toContain('more');
    });

    it('bounds a tensor whose shape declares a huge number of dimensions', () => {
        const buffer = buildSafetensors({
            w: { dtype: 'U8', shape: Array.from({ length: 100_000 }, () => 1), data_offsets: [0, 1] }
        }, 1);

        const doc = parseSafetensors(buffer);
        expect((doc.tables[0]?.rows[0]?.[2] as string).length).toBeLessThan(600);
        expect(doc.rawPreview!.length).toBeLessThan(2_000);
    });

    it('caps the __metadata__ map the same way it caps tensors', () => {
        const meta: Record<string, string> = {};
        for (let i = 0; i < 10_050; i++) meta[`k${i}`] = 'v';
        const buffer = buildSafetensors({
            __metadata__: meta,
            w: { dtype: 'U8', shape: [1], data_offsets: [0, 1] }
        }, 1);

        const doc = parseSafetensors(buffer);
        const table = doc.tables.find(item => item.title.startsWith('Metadata'))!;
        expect(table.rows).toHaveLength(10_000);
        expect(table.title).toBe('Metadata (10000)');
        expect(doc.summary).toContainEqual({ label: 'Metadata keys', value: 10_000 });
        expect(doc.warnings.some(w => w.includes('10050') && w.includes('10000'))).toBe(true);
    });

    it('does not claim __metadata__ truncation when only non-string values were skipped', () => {
        // Non-string values are reported on their own and never occupy a slot,
        // so a map whose string entries all fit must not also be called cut.
        const meta: Record<string, unknown> = {};
        for (let i = 0; i < 9_990; i++) meta[`k${i}`] = 'v';
        for (let i = 0; i < 100; i++) meta[`bad${i}`] = 5;
        const buffer = buildSafetensors({
            __metadata__: meta,
            w: { dtype: 'U8', shape: [1], data_offsets: [0, 1] }
        }, 1);

        const doc = parseSafetensors(buffer);
        const table = doc.tables.find(item => item.title.startsWith('Metadata'))!;
        expect(table.rows).toHaveLength(9_990);
        expect(doc.warnings).toContain('Some "__metadata__" values are not strings and were ignored.');
        expect(doc.warnings.some(w => w.includes('only the first'))).toBe(false);
    });

    it('counts metadata keys after shortening so the title matches its rows', () => {
        // Two keys past the clamp differing only in the middle collapse onto one
        // row; a title counting them separately would contradict what is shown.
        const key = (middle: string): string => `${'p'.repeat(400)}${middle}${'s'.repeat(400)}`;
        const buffer = buildSafetensors({
            __metadata__: { [key('A')]: 'one', [key('B')]: 'two' },
            w: { dtype: 'U8', shape: [1], data_offsets: [0, 1] }
        }, 1);

        const doc = parseSafetensors(buffer);
        const table = doc.tables.find(item => item.title.startsWith('Metadata'))!;
        // Both keys really do collapse — otherwise this test proves nothing.
        expect(table.rows).toHaveLength(1);
        expect(table.title).toBe('Metadata (1)');
        expect(doc.summary).toContainEqual({ label: 'Metadata keys', value: 1 });
    });

    it('does not split a surrogate pair when shortening a name', () => {
        // An emoji straddling the cut offset would otherwise leave a lone
        // surrogate — a replacement glyph in the table and in the copied JSON.
        const name = `${'a'.repeat(255)}😀${'b'.repeat(400)}😀${'c'.repeat(254)}`;
        const buffer = buildSafetensors({
            [name]: { dtype: 'U8', shape: [1], data_offsets: [0, 1] }
        }, 1);

        const doc = parseSafetensors(buffer);
        const cell = doc.tables[0]?.rows[0]?.[0] as string;
        expect(cell.length).toBeLessThanOrEqual(512);
        // `String.prototype.isWellFormed` is past this package's lib target,
        // so the surrogate check is spelled out.
        expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cell)).toBe(false);
    });

    it('shortens a long shape by whole dimensions and warns about shapes, not names', () => {
        const buffer = buildSafetensors({
            w: { dtype: 'U8', shape: [0, ...Array.from({ length: 31 }, () => 9007199254740991)], data_offsets: [0, 0] }
        });

        const doc = parseSafetensors(buffer);
        const shapeCell = doc.tables[0]?.rows[0]?.[2] as string;
        expect(doc.warnings).toContain('Some tensor shapes have too many dimensions to show in full.');
        expect(doc.warnings).not.toContain('Some names or metadata values were too long to show in full and were shortened.');
        // Every token shown is a dimension the shape actually declares.
        for (const token of shapeCell.split(' × ')) {
            if (token === '…') continue;
            expect(['0', '9007199254740991']).toContain(token);
        }
    });

    it('keeps two tensors distinguishable when their names share a long prefix', () => {
        const prefix = 'p'.repeat(600);
        const buffer = buildSafetensors({
            [`${prefix}A`]: { dtype: 'U8', shape: [1], data_offsets: [0, 1] },
            [`${prefix}B`]: { dtype: 'U8', shape: [1], data_offsets: [1, 2] }
        }, 2);

        const doc = parseSafetensors(buffer);
        const [first, second] = doc.tables[0]!.rows;
        expect(first?.[0]).not.toBe(second?.[0]);
        expect(String(first?.[0]).endsWith('A')).toBe(true);
        expect(String(second?.[0]).endsWith('B')).toBe(true);
    });

    it('bounds the structure preview for a model with many tensors', () => {
        const header: Record<string, unknown> = {};
        for (let i = 0; i < 40_000; i++) {
            header[`model.layers.${i}.self_attn.q_proj.weight`] = { dtype: 'U8', shape: [0], data_offsets: [0, 0] };
        }

        const doc = parseSafetensors(buildSafetensors(header));
        expect(doc.rawPreview!.length).toBeLessThanOrEqual(1_000_100);
        expect(doc.rawPreview!.endsWith('…')).toBe(true);
    });

    it('still reports overlapping byte ranges in a truncated tensor list', () => {
        // Truncation hides holes, but two tensors claiming the same bytes is a
        // contradiction in any subset — a corrupt huge file must not read as
        // merely "large".
        const header: Record<string, unknown> = {};
        for (let i = 0; i < 60_000; i++) {
            header[`t${i}`] = { dtype: 'U8', shape: [1], data_offsets: [0, 1] };
        }

        const doc = parseSafetensors(buildSafetensors(header, 999_999));
        expect(doc.warnings).toContain('Some tensor byte ranges are inconsistent with their dtype and shape.');
    });
});

describe('formatCount', () => {
    it('formats parameter counts compactly', () => {
        expect(formatCount(999)).toBe('999');
        expect(formatCount(12_300)).toBe('12.3K');
        expect(formatCount(7_000_000_000)).toBe('7.00B');
    });
});
