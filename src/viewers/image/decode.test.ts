import { describe, expect, it } from 'vitest';
import { checkInputLimit, detectImageMime, isAnimated, isSvgText } from './decode.js';

const bytes = (...b: number[]) => new Uint8Array(b);
const withTail = (head: number[], len: number) => {
    const a = new Uint8Array(len);
    a.set(head);
    return a;
};

describe('detectImageMime (image.md §1)', () => {
    it('recognizes raster signatures', () => {
        expect(detectImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'a.png')).toBe('image/png');
        expect(detectImageMime(bytes(0xff, 0xd8, 0xff, 0xe0), 'a.jpg')).toBe('image/jpeg');
        expect(detectImageMime(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61), 'a.gif')).toBe('image/gif');
        expect(detectImageMime(bytes(0x42, 0x4d, 0, 0), 'a.bmp')).toBe('image/bmp');
    });

    it('requires both RIFF and WEBP for webp', () => {
        const webp = new Uint8Array(12);
        webp.set([0x52, 0x49, 0x46, 0x46], 0);
        webp.set([0x57, 0x45, 0x42, 0x50], 8);
        expect(detectImageMime(webp, 'a.webp')).toBe('image/webp');
        const wav = new Uint8Array(12);
        wav.set([0x52, 0x49, 0x46, 0x46], 0);
        wav.set([0x57, 0x41, 0x56, 0x45], 8);
        expect(detectImageMime(wav, 'a.webp')).toBeNull();
    });

    it('admits SVG only by extension + probe', () => {
        const svg = new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="...">');
        expect(detectImageMime(svg, 'a.svg')).toBe('image/svg+xml');
        // SVG content but a non-svg extension → not claimed here.
        expect(detectImageMime(svg, 'a.txt')).toBeNull();
    });

    it('returns null when bytes match nothing (extension/byte conflict)', () => {
        expect(detectImageMime(bytes(0x25, 0x50, 0x44, 0x46), 'a.png')).toBeNull();
    });
});

describe('isSvgText', () => {
    it('detects an svg root and rejects html documents', () => {
        expect(isSvgText(new TextEncoder().encode('<svg width="1"></svg>'))).toBe(true);
        expect(isSvgText(new TextEncoder().encode('<!DOCTYPE html><html><svg></svg></html>'))).toBe(false);
        expect(isSvgText(new TextEncoder().encode('plain text'))).toBe(false);
    });
});

describe('isAnimated', () => {
    it('flags a GIF with multiple graphic control extensions', () => {
        const gif = bytes(0x47, 0x49, 0x46, 0x38, 0x21, 0xf9, 0x00, 0x21, 0xf9, 0x00);
        expect(isAnimated(gif, 'image/gif')).toBe(true);
        const still = bytes(0x47, 0x49, 0x46, 0x38, 0x21, 0xf9, 0x00);
        expect(isAnimated(still, 'image/gif')).toBe(false);
    });

    it('is false for formats without an animation marker', () => {
        expect(isAnimated(bytes(0x89, 0x50), 'image/png')).toBe(false);
    });
});

describe('checkInputLimit (image.md §4)', () => {
    it('fails past the byte cap and passes within it', () => {
        expect(checkInputLimit(withTail([], 10), 100)).toBeNull();
        const over = checkInputLimit(withTail([], 200), 100);
        expect(over?.status).toBe('failed');
        if (over?.status === 'failed') expect(over.failure.code).toBe('limit-exceeded');
    });
});
