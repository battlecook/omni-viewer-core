import { describe, expect, it } from 'vitest';
import { parseJsonl } from './index.js';
describe('parseJsonl', () => {
    it('keeps valid records when another line is invalid', () => {
        const result = parseJsonl('{"a":1}\r\nnope\r\n[2]').result;
        expect(result.status).toBe('partial');
        if (result.status === 'failed') return;
        expect(result.document.entries.map(e => e.lineEnding)).toEqual(['\r\n', '\r\n', '']);
        expect(result.document.entries[0]?.value?.kind).toBe('object');
        expect(result.document.entries[1]?.diagnostics.some(d => d.code === 'invalid-jsonl-line')).toBe(true);
    });
});
