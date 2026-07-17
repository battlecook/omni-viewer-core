import { describe, expect, it } from 'vitest';
import { createHwpController, HWP_MAX_ZOOM, HWP_MIN_ZOOM } from './controller.js';

describe('createHwpController', () => {
    it('zooms, resets, and clamps to the supported range', () => {
        const controller = createHwpController();
        controller.dispatch({ type: 'zoom-in' }); expect(controller.state.zoom).toBe(1.1);
        controller.dispatch({ type: 'reset-zoom' }); expect(controller.state.zoom).toBe(1);
        for (let i = 0; i < 40; i++) controller.dispatch({ type: 'zoom-out' }); expect(controller.state.zoom).toBe(HWP_MIN_ZOOM);
        for (let i = 0; i < 40; i++) controller.dispatch({ type: 'zoom-in' }); expect(controller.state.zoom).toBe(HWP_MAX_ZOOM);
    });
});
