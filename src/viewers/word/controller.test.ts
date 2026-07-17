import { describe, expect, it } from 'vitest';
import { createWordController, WORD_MAX_ZOOM, WORD_MIN_ZOOM } from './controller.js';

describe('WordController', () => {
    it('zooms in 10% steps and resets', () => {
        const controller = createWordController();
        controller.dispatch({ type: 'zoom-in' });
        expect(controller.state.zoom).toBe(1.1);
        controller.dispatch({ type: 'zoom-out' });
        expect(controller.state.zoom).toBe(1);
        controller.dispatch({ type: 'zoom-in' });
        controller.dispatch({ type: 'reset-zoom' });
        expect(controller.state.zoom).toBe(1);
    });

    it('clamps to the documented 25–250% range', () => {
        const controller = createWordController();
        for (let i = 0; i < 100; i++) controller.dispatch({ type: 'zoom-out' });
        expect(controller.state.zoom).toBe(WORD_MIN_ZOOM);
        for (let i = 0; i < 100; i++) controller.dispatch({ type: 'zoom-in' });
        expect(controller.state.zoom).toBe(WORD_MAX_ZOOM);
    });
});
