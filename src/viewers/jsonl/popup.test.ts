import { describe, expect, it } from 'vitest';
import { clampJsonlPopupPosition } from './popup.js';

describe('clampJsonlPopupPosition', () => {
    it('uses the cursor offset when the popup fits', () => {
        expect(clampJsonlPopupPosition({ mouseX: 100, mouseY: 100, popupWidth: 400, popupHeight: 300, viewportWidth: 1200, viewportHeight: 900 }))
            .toEqual({ left: 116, top: 112 });
    });

    it('flips left and clamps vertically at viewport edges', () => {
        expect(clampJsonlPopupPosition({ mouseX: 800, mouseY: 700, popupWidth: 400, popupHeight: 300, viewportWidth: 900, viewportHeight: 800 }))
            .toEqual({ left: 384, top: 488 });
    });
});
