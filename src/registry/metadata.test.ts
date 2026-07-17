import { describe, expect, it } from 'vitest';
import { MARKDOWN_VIEWER_META } from '../viewers/markdown/index.js';
import { MARKDOWN_VIEWER_DESCRIPTOR } from './index.js';

describe('viewer registry metadata', () => {
    it('keeps Markdown host capabilities aligned with the viewer metadata', () => {
        expect(MARKDOWN_VIEWER_DESCRIPTOR.requiredServices).toEqual(MARKDOWN_VIEWER_META.requiredServices);
        expect(MARKDOWN_VIEWER_DESCRIPTOR.optionalServices).toEqual(MARKDOWN_VIEWER_META.optionalServices);
    });
});
