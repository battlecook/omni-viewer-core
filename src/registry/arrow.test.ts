import { describe, expect, it } from 'vitest';
import * as arrow from 'apache-arrow';
import { ARROW_VIEWER_DESCRIPTOR, CORE_VIEWER_DESCRIPTORS, detectViewer } from './index.js';
import { looksLikeArrowIpc } from '../parsers/arrow/sniff.js';
import { ARROW_VIEWER_META } from '../viewers/arrow/index.js';

const table = arrow.tableFromArrays({ id: new Int32Array([1]) });
describe('Arrow IPC / Feather V2 detection', () => {
    it('registers one viewer with matching public metadata', () => {
        expect(CORE_VIEWER_DESCRIPTORS.filter(item => item.id === 'arrow')).toEqual([ARROW_VIEWER_DESCRIPTOR]);
        const { inputOwnership: _, ...meta } = ARROW_VIEWER_META;
        const { magicSignatures: __, ...descriptor } = ARROW_VIEWER_DESCRIPTOR;
        expect(meta).toEqual(descriptor);
    });
    it.each(['arrow', 'feather', 'ARROW', 'FEATHER'])('detects .%s by extension, file magic and stream schema', ext => {
        expect(detectViewer(`sample.${ext}`).viewerId).toBe('arrow');
        for (const type of ['file', 'stream'] as const) expect(detectViewer(`sample.${ext}`, new Set(), undefined, arrow.tableToIPC(table, type)).viewerId).toBe('arrow');
    });
    it.each(['file', 'stream'] as const)('detects extensionless %s content with a bounded sniff sample', type => {
        const data = arrow.tableToIPC(table, type);
        expect(looksLikeArrowIpc(data.subarray(0, 128))).toBe(true);
        expect(detectViewer('unknown', new Set(), undefined, data.subarray(0, 128))).toEqual({ viewerId: 'arrow', matchedBy: 'content' });
    });
    it('rejects conflicting signatures, Feather V1 and continuation markers without a schema', () => {
        expect(detectViewer('invalid.arrow', new Set(), undefined, new TextEncoder().encode('PAR1xxxxxxxxxxxx')).viewerId).toBe('fallback');
        expect(looksLikeArrowIpc(new TextEncoder().encode('FEA1'))).toBe(false);
        expect(looksLikeArrowIpc(new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]))).toBe(false);
        for (let length = 0; length < 50; length++) expect(() => looksLikeArrowIpc(new Uint8Array(length).fill(255))).not.toThrow();
    });
});
