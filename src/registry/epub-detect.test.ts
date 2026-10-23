import { describe, expect, it } from 'vitest';
import { buildZip, epub3Fixture } from '../parsers/epub/__tests__/fixture.js';
import { detectViewer, probeContainer, REQUIRED_SNIFF_BYTES } from './index.js';

describe('EPUB detection', () => {
    it('trusts the .epub extension over the generic ZIP signature', () => {
        const data = epub3Fixture();
        expect(detectViewer('Alice.EPUB', new Set(), undefined, data.subarray(0, REQUIRED_SNIFF_BYTES))).toEqual({ viewerId: 'epub', matchedBy: 'extension' });
    });

    it('routes an extensionless book through the stored mimetype member', async () => {
        const data = epub3Fixture();
        const stage1 = detectViewer('download', new Set(), undefined, data.subarray(0, REQUIRED_SNIFF_BYTES));
        expect(stage1).toEqual({ viewerId: 'fallback', matchedBy: 'ambiguous-container', container: 'zip' });
        expect(await probeContainer(data, 'zip')).toBe('epub');
    });

    it('leaves a ZIP with a different mimetype to the other viewers', async () => {
        const odt = buildZip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' }, { name: 'content.xml', data: '<x/>' }]);
        expect(await probeContainer(odt, 'zip')).toBeNull();
    });
});
