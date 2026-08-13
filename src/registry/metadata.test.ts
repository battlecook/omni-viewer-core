import { describe, expect, it } from 'vitest';
import { MARKDOWN_VIEWER_META } from '../viewers/markdown/index.js';
import { NUMPY_VIEWER_META } from '../viewers/numpy/index.js';
import { MARKDOWN_VIEWER_DESCRIPTOR, NUMPY_VIEWER_DESCRIPTOR } from './index.js';

describe('viewer registry metadata', () => {
    it('keeps Markdown host capabilities aligned with the viewer metadata', () => {
        expect(MARKDOWN_VIEWER_DESCRIPTOR.requiredServices).toEqual(MARKDOWN_VIEWER_META.requiredServices);
        expect(MARKDOWN_VIEWER_DESCRIPTOR.optionalServices).toEqual(MARKDOWN_VIEWER_META.optionalServices);
    });

    it('keeps NumPy host capabilities aligned with the viewer metadata', () => {
        expect(NUMPY_VIEWER_DESCRIPTOR).toMatchObject({
            id: NUMPY_VIEWER_META.id,
            displayNameKey: NUMPY_VIEWER_META.displayNameKey,
            extensions: NUMPY_VIEWER_META.extensions,
            requiredServices: NUMPY_VIEWER_META.requiredServices,
            optionalServices: NUMPY_VIEWER_META.optionalServices
        });
    });
});
