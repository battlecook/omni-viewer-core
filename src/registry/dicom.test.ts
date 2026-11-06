import { describe, expect, it } from 'vitest';
import { dicomFixture } from '../parsers/dicom/__tests__/fixture.js';
import { DICOM_VIEWER_META } from '../viewers/dicom/index.js';
import { CORE_VIEWER_DESCRIPTORS, detectViewer, DICOM_VIEWER_DESCRIPTOR, OLE_MAGIC, REQUIRED_SNIFF_BYTES, ZIP_MAGIC } from './index.js';
describe('DICOM routing', () => {
    it('registers aligned public metadata exactly once', () => {
        const { inputOwnership: _, ...meta } = DICOM_VIEWER_META;
        expect(meta).toEqual(DICOM_VIEWER_DESCRIPTOR);
        expect(CORE_VIEWER_DESCRIPTORS.filter(d => d.id === 'dicom')).toHaveLength(1);
    });
    it('routes .dcm/.dicom including raw datasets and uppercase names', () => {
        for (const name of ['scan.dcm', 'SCAN.DCM', 'scan.dicom']) {
            expect(detectViewer(name).viewerId).toBe('dicom');
            expect(detectViewer(name, undefined, undefined, dicomFixture({ raw: true })).viewerId).toBe('dicom');
        }
    });
    it('detects extensionless Part 10 files at offset 128, respecting adapter opt-out', () => {
        const bytes = dicomFixture().subarray(0, REQUIRED_SNIFF_BYTES);
        expect(REQUIRED_SNIFF_BYTES).toBeGreaterThanOrEqual(132);
        expect(detectViewer('scan', undefined, undefined, bytes)).toEqual({ viewerId: 'dicom', matchedBy: 'content' });
        expect(detectViewer('scan', undefined, CORE_VIEWER_DESCRIPTORS.filter(d => d.id !== 'dicom'), bytes).viewerId).toBe('fallback');
        expect(detectViewer('scan', undefined, undefined, bytes.subarray(0, 131)).viewerId).toBe('fallback');
        expect(detectViewer('scan', undefined, undefined, dicomFixture({ raw: true })).viewerId).toBe('fallback');
    });
    it.each([['zip', ZIP_MAGIC], ['ole', OLE_MAGIC]] as const)('recognizes DICOM with a %s signature in its arbitrary preamble', (container, magic) => {
        const bytes = dicomFixture().subarray(0, REQUIRED_SNIFF_BYTES); bytes.set(magic);
        expect(detectViewer('scan', undefined, undefined, bytes)).toEqual({ viewerId: 'dicom', matchedBy: 'content' });
        expect(detectViewer('scan', undefined, CORE_VIEWER_DESCRIPTORS.filter(d => d.id !== 'dicom'), bytes))
            .toEqual({ viewerId: 'fallback', matchedBy: 'ambiguous-container', container });
        bytes[128] = 0;
        expect(detectViewer('scan', undefined, undefined, bytes))
            .toEqual({ viewerId: 'fallback', matchedBy: 'ambiguous-container', container });
    });
});
