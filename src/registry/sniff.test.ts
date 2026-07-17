import { describe, expect, it } from 'vitest';
import { looksLikeJsonDocument, looksLikeJsonl, sniffTextViewer } from './sniff.js';

describe('looksLikeJsonDocument (부록 B-6)', () => {
    it('accepts objects and arrays', () => {
        expect(looksLikeJsonDocument('{"a":1}')).toBe(true);
        expect(looksLikeJsonDocument('  [1, 2, 3]\n')).toBe(true);
    });

    it('rejects non-object/array and malformed input', () => {
        expect(looksLikeJsonDocument('42')).toBe(false); // must start with { or [
        expect(looksLikeJsonDocument('"just a string"')).toBe(false);
        expect(looksLikeJsonDocument('{ broken')).toBe(false);
        expect(looksLikeJsonDocument('{"a":1} trailing')).toBe(false);
        expect(looksLikeJsonDocument('plain text')).toBe(false);
    });
});

describe('looksLikeJsonl (부록 B-6)', () => {
    it('needs at least two object/array lines', () => {
        expect(looksLikeJsonl('{"a":1}\n{"b":2}')).toBe(true);
        expect(looksLikeJsonl('{"a":1}\n{"b":2}\n')).toBe(true); // trailing newline ok
        expect(looksLikeJsonl('{"a":1}')).toBe(false); // single line
        expect(looksLikeJsonl('{"a":1}\nnot json')).toBe(false);
    });
});

describe('sniffTextViewer — JSONL wins over JSON', () => {
    it('classifies single documents as json', () => {
        expect(sniffTextViewer('{"a":1}')).toBe('json');
        expect(sniffTextViewer('[1,2]')).toBe('json');
    });

    it('classifies multi-line object streams as jsonl', () => {
        expect(sniffTextViewer('{"a":1}\n{"b":2}')).toBe('jsonl');
    });

    it('returns null for non-JSON text', () => {
        expect(sniffTextViewer('hello world')).toBeNull();
    });
});
