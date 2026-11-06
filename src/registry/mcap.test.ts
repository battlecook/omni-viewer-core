import { describe, expect, it } from 'vitest';
import { createCatalogI18n } from '../i18n/index.js';
import { MCAP_VIEWER_META } from '../viewers/mcap/index.js';
import { MCAP_MAGIC } from '../parsers/mcap/index.js';
import { CORE_VIEWER_DESCRIPTORS, detectViewer, MCAP_VIEWER_DESCRIPTOR, REQUIRED_SNIFF_BYTES } from './index.js';

describe('MCAP registry', () => {
    it('detects case-insensitive extensions and binary content with misleading extensions', () => {
        expect(detectViewer('robot.mcap').viewerId).toBe('mcap');
        expect(detectViewer('ROBOT.MCAP').viewerId).toBe('mcap');
        const magic = Uint8Array.from(MCAP_MAGIC);
        expect(detectViewer('recording', new Set(), undefined, magic).viewerId).toBe('mcap');
        expect(detectViewer('recording.bag', new Set(), undefined, magic).viewerId).toBe('mcap');
        expect(detectViewer('recording.mcap', new Set(), undefined, new Uint8Array(16)).viewerId).toBe('fallback');
        expect(detectViewer('recording', new Set(), undefined, magic.subarray(0, 7)).viewerId).toBe('fallback');
        expect(REQUIRED_SNIFF_BYTES).toBeGreaterThanOrEqual(magic.length);
    });
    it('keeps registry metadata, public viewer metadata and translations aligned', () => {
        const { inputOwnership, ...meta } = MCAP_VIEWER_META;
        expect(inputOwnership).toBe('borrows'); expect(MCAP_VIEWER_DESCRIPTOR).toEqual(meta);
        expect(CORE_VIEWER_DESCRIPTORS.filter(item => item.id === 'mcap')).toHaveLength(1);
        expect(createCatalogI18n('ko').t(MCAP_VIEWER_META.displayNameKey)).toBe('MCAP');
    });
});
