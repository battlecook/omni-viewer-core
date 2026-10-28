import { describe, expect, it } from 'vitest';
import { FONT_VIEWER_META } from '../viewers/font/index.js';
import { CORE_VIEWER_DESCRIPTORS, FONT_MAGIC_SIGNATURES, FONT_VIEWER_DESCRIPTOR, detectViewer } from './index.js';

describe('font detection', () => {
    it.each(['sample.ttf', 'sample.otf', 'sample.woff', 'SAMPLE.TTF', 'SAMPLE.OTF', 'SAMPLE.WOFF'])('detects %s by extension', fileName => {
        expect(detectViewer(fileName)).toEqual({ viewerId: 'font', matchedBy: 'extension' });
    });
    it.each(FONT_MAGIC_SIGNATURES.map(s => [s[0]!.bytes]))('detects font signatures by content', bytes => {
        expect(detectViewer('no-extension', undefined, undefined, Uint8Array.from(bytes))).toEqual({ viewerId: 'font', matchedBy: 'content' });
    });
    it('does not claim corrupt files, WOFF2, or collections', () => {
        expect(detectViewer('bad.ttf', undefined, undefined, new Uint8Array([1, 2, 3, 4])).viewerId).toBe('fallback');
        for (const signature of ['wOF2', 'ttcf']) expect(detectViewer('font', undefined, undefined, new TextEncoder().encode(signature)).viewerId).toBe('fallback');
        expect(detectViewer('font', undefined, CORE_VIEWER_DESCRIPTORS.filter(d => d.id !== 'font'), Uint8Array.of(0, 1, 0, 0)).viewerId).toBe('fallback');
    });
    it('keeps viewer metadata and registry descriptors aligned', () => {
        const { inputOwnership: _, ...meta } = FONT_VIEWER_META;
        expect(FONT_VIEWER_DESCRIPTOR).toEqual(meta);
        expect(CORE_VIEWER_DESCRIPTORS.filter(d => d.id === 'font')).toHaveLength(1);
    });
});
