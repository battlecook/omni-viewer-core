import { describe, expect, it } from 'vitest';
import { TEXT_VIEWER_META } from '../viewers/text/index.js';
import { CORE_VIEWER_DESCRIPTORS, detectViewer, TEXT_VIEWER_DESCRIPTOR } from './index.js';

describe('plain text routing', () => {
    it('keeps public metadata aligned and registers txt exactly once', () => {
        const { inputOwnership: _, ...metadata } = TEXT_VIEWER_META;
        expect(TEXT_VIEWER_DESCRIPTOR).toEqual(metadata);
        expect(CORE_VIEWER_DESCRIPTORS.filter(d => d.extensions.includes('txt'))).toEqual([TEXT_VIEWER_DESCRIPTOR]);
    });

    it.each(['notes.txt', 'NOTES.TXT', 'folder/My notes.TxT', '.txt'])('routes %s explicitly', fileName => {
        expect(detectViewer(fileName)).toEqual({ viewerId: 'text', matchedBy: 'extension' });
    });

    it.each(['<html><body>hello</body></html>', '# heading', '{"answer":42}', 'a,b\n1,2'])('keeps structured content literal for txt: %s', text => {
        expect(detectViewer('notes.txt', undefined, undefined, new TextEncoder().encode(text), text))
            .toEqual({ viewerId: 'text', matchedBy: 'extension' });
    });

    it('does not claim other extensions or extensionless plain text', () => {
        expect(detectViewer('notes.md').viewerId).toBe('markdown');
        expect(detectViewer('notes.csv').viewerId).toBe('csv');
        expect(detectViewer('notes.html').viewerId).toBe('html');
        expect(detectViewer('notes.txt.bak').viewerId).toBe('fallback');
        expect(detectViewer('notes', undefined, undefined, undefined, 'plain words').viewerId).toBe('fallback');
    });

    it('allows hosts to disable the text descriptor', () => {
        expect(detectViewer('notes.txt', undefined, CORE_VIEWER_DESCRIPTORS.filter(d => d.id !== 'text')).viewerId).toBe('fallback');
    });
});
