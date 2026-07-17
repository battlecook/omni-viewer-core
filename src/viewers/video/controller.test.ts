import { describe, expect, it } from 'vitest';
import {
    createVideoController,
    formatMediaTime,
    VIDEO_MAX_ZOOM,
    VIDEO_MIN_ZOOM
} from './controller.js';

describe('video controller', () => {
    it('starts at 100% zoom and 1x speed', () => {
        const controller = createVideoController();
        expect(controller.state).toEqual({ zoom: 1, speed: 1 });
    });

    it('steps and clamps zoom', () => {
        const controller = createVideoController();
        controller.dispatch({ type: 'zoom-in' });
        expect(controller.state.zoom).toBe(1.25);
        controller.dispatch({ type: 'set-zoom', zoom: 99 });
        expect(controller.state.zoom).toBe(VIDEO_MAX_ZOOM);
        controller.dispatch({ type: 'set-zoom', zoom: 0 });
        expect(controller.state.zoom).toBe(VIDEO_MIN_ZOOM);
        controller.dispatch({ type: 'zoom-fit' });
        expect(controller.state.zoom).toBe(1);
    });

    it('accepts only known speeds', () => {
        const controller = createVideoController();
        controller.dispatch({ type: 'set-speed', speed: 1.5 });
        expect(controller.state.speed).toBe(1.5);
        controller.dispatch({ type: 'set-speed', speed: 3 });
        expect(controller.state.speed).toBe(1.5);
    });

    it('notifies subscribers only on change and stops after unsubscribe', () => {
        const controller = createVideoController();
        const seen: number[] = [];
        const unsubscribe = controller.subscribe((state) => seen.push(state.zoom));
        controller.dispatch({ type: 'zoom-fit' }); // no-op: already 1
        controller.dispatch({ type: 'zoom-in' });
        unsubscribe();
        controller.dispatch({ type: 'zoom-in' });
        expect(seen).toEqual([1.25]);
    });
});

describe('formatMediaTime', () => {
    it('formats seconds, minutes and hours', () => {
        expect(formatMediaTime(0)).toBe('0:00');
        expect(formatMediaTime(65)).toBe('1:05');
        expect(formatMediaTime(3661)).toBe('1:01:01');
        expect(formatMediaTime(Number.NaN)).toBe('0:00');
        expect(formatMediaTime(-5)).toBe('0:00');
    });
});
