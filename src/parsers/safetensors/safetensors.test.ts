import { describe, expect, it } from 'vitest';
import { formatCount, parseSafetensors } from './index.js';

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
});

describe('formatCount', () => {
    it('formats parameter counts compactly', () => {
        expect(formatCount(999)).toBe('999');
        expect(formatCount(12_300)).toBe('12.3K');
        expect(formatCount(7_000_000_000)).toBe('7.00B');
    });
});
