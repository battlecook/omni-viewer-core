import { describe, expect, it } from 'vitest';
import { detectViewer } from './index.js';
import { OLE_MAGIC, ZIP_MAGIC } from './container.js';

describe('HWP detection', () => {
    it('routes HWP and HWPX with matching containers', () => {
        expect(detectViewer('document.hwp', new Set(), undefined, new Uint8Array(OLE_MAGIC)).viewerId).toBe('hwp');
        expect(detectViewer('document.hwpx', new Set(), undefined, new Uint8Array(ZIP_MAGIC)).viewerId).toBe('hwp');
    });
    it('rejects a contradictory HWP container', () => {
        expect(detectViewer('document.hwpx', new Set(), undefined, new Uint8Array(OLE_MAGIC)).matchedBy).toBe('ambiguous-container');
    });
});
