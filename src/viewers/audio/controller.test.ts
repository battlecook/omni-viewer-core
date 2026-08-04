import { describe, expect, it } from 'vitest';
import {
    AUDIO_MAX_ZOOM,
    AUDIO_MIN_VISIBLE_PEAK_COLUMNS,
    AUDIO_MIN_VISIBLE_SECONDS,
    AUDIO_MIN_ZOOM,
    AUDIO_REGION_MIN_DURATION,
    channelStats,
    createAudioController,
    formatZoomLabel,
    normalizeRegionBounds,
    showsSpectrogram,
    showsWaveform,
    timelineIntervals,
    zoomCeilingFor,
    zoomCeilingForPeaks
} from './controller.js';

describe('zoom ceiling', () => {
    // A fixed 32x ceiling meant a one-hour track could not be zoomed past
    // ~112 s per screen, which is the regression this replaces.
    it('scales with duration so the closest view is a couple of seconds', () => {
        expect(zoomCeilingFor(3600)).toBe(1800);
        expect(3600 / zoomCeilingFor(3600)).toBe(AUDIO_MIN_VISIBLE_SECONDS);
        expect(zoomCeilingFor(120)).toBe(60);
    });

    it('never drops below 1x for very short or unknown tracks', () => {
        expect(zoomCeilingFor(1)).toBe(1);
        expect(zoomCeilingFor(0)).toBe(AUDIO_MAX_ZOOM);
        expect(zoomCeilingFor(Number.NaN)).toBe(AUDIO_MAX_ZOOM);
        expect(zoomCeilingFor(-5)).toBe(AUDIO_MAX_ZOOM);
    });
});

describe('zoom ceiling in peaks mode', () => {
    // A two-hour track reduced to 8000 columns holds ~0.9s per column. The
    // duration-based ceiling would leave two or three columns on screen and
    // present stretched bars as detail.
    it('caps at the peak resolution rather than the duration', () => {
        const twoHours = 7200;
        expect(zoomCeilingFor(twoHours)).toBe(3600);
        expect(zoomCeilingForPeaks(twoHours, 8000)).toBe(8000 / AUDIO_MIN_VISIBLE_PEAK_COLUMNS);
        // At that ceiling the screen still holds a usable number of columns.
        expect(8000 / zoomCeilingForPeaks(twoHours, 8000)).toBe(AUDIO_MIN_VISIBLE_PEAK_COLUMNS);
    });

    it('keeps the duration ceiling when it is the tighter of the two', () => {
        // A 20-second track cannot be zoomed past 2s visible regardless of how
        // many columns it was reduced to.
        expect(zoomCeilingForPeaks(20, 8000)).toBe(zoomCeilingFor(20));
        expect(zoomCeilingForPeaks(20, 8000)).toBe(10);
    });

    it('never drops below 1x, and ignores a missing column count', () => {
        expect(zoomCeilingForPeaks(7200, 10)).toBe(AUDIO_MIN_ZOOM);
        expect(zoomCeilingForPeaks(7200, 0)).toBe(zoomCeilingFor(7200));
        expect(zoomCeilingForPeaks(7200, Number.NaN)).toBe(zoomCeilingFor(7200));
    });
});

describe('zoom label', () => {
    it('reports the visible window rather than a bare multiplier', () => {
        expect(formatZoomLabel(3600)).toBe('60m');
        expect(formatZoomLabel(120)).toBe('2m');
        expect(formatZoomLabel(30)).toBe('30s');
        expect(formatZoomLabel(10)).toBe('10s');
        expect(formatZoomLabel(2)).toBe('2.0s');
        expect(formatZoomLabel(1.5)).toBe('1.5s');
    });

    it('degrades to a placeholder before the duration is known', () => {
        expect(formatZoomLabel(0)).toBe('--');
        expect(formatZoomLabel(Number.NaN)).toBe('--');
        expect(formatZoomLabel(Number.POSITIVE_INFINITY)).toBe('--');
    });
});

describe('controller zoom ceiling', () => {
    it('raises the ceiling once the duration is known', () => {
        const controller = createAudioController();
        expect(controller.state.maxZoom).toBe(AUDIO_MAX_ZOOM);
        for (let i = 0; i < 12; i++) controller.dispatch({ type: 'zoom-in' });
        expect(controller.state.zoom).toBe(AUDIO_MAX_ZOOM);

        controller.dispatch({ type: 'set-max-zoom', maxZoom: zoomCeilingFor(3600) });
        expect(controller.state.maxZoom).toBe(1800);
        // 32 doubled five times is 1024; the sixth would overshoot and clamps.
        for (let i = 0; i < 5; i++) controller.dispatch({ type: 'zoom-in' });
        expect(controller.state.zoom).toBe(1024);
        controller.dispatch({ type: 'zoom-in' });
        expect(controller.state.zoom).toBe(1800);
        expect(3600 / controller.state.zoom).toBe(AUDIO_MIN_VISIBLE_SECONDS);
    });

    it('re-clamps the current zoom when the ceiling drops', () => {
        const controller = createAudioController();
        controller.dispatch({ type: 'set-max-zoom', maxZoom: 500 });
        for (let i = 0; i < 12; i++) controller.dispatch({ type: 'zoom-in' });
        expect(controller.state.zoom).toBe(500);
        controller.dispatch({ type: 'set-max-zoom', maxZoom: 4 });
        expect(controller.state.zoom).toBe(4);
    });

    it('refuses a ceiling below the minimum zoom', () => {
        const controller = createAudioController();
        controller.dispatch({ type: 'set-max-zoom', maxZoom: 0 });
        expect(controller.state.maxZoom).toBe(1);
        expect(controller.state.zoom).toBe(1);
    });
});

describe('timeline intervals', () => {
    // The plugin default packs ticks too densely on long tracks; steps must be
    // round numbers with at least ~100px between them.
    it('picks a round step that keeps ticks readable', () => {
        expect(timelineIntervals(60, 1000).timeInterval).toBe(10);
        expect(timelineIntervals(600, 1000).timeInterval).toBe(60);
        expect(timelineIntervals(3600, 1000).timeInterval).toBe(600);
        expect(timelineIntervals(10, 1000).timeInterval).toBe(1);
    });

    it('labels every fifth tick', () => {
        const { timeInterval, primaryLabelInterval, secondaryLabelInterval } = timelineIntervals(60, 1000);
        expect(primaryLabelInterval).toBe(timeInterval * 5);
        expect(secondaryLabelInterval).toBe(timeInterval);
    });

    it('falls back to a default width and to safe values for an unknown duration', () => {
        expect(timelineIntervals(60, 0)).toEqual(timelineIntervals(60, 1000));
        expect(timelineIntervals(0, 1000)).toEqual({
            timeInterval: 1, primaryLabelInterval: 5, secondaryLabelInterval: 1
        });
        expect(timelineIntervals(Number.NaN, 1000).timeInterval).toBe(1);
    });

    it('caps at the largest step for extremely long tracks', () => {
        expect(timelineIntervals(360000, 1000).timeInterval).toBe(3600);
    });
});

describe('channel stats', () => {
    it('reports peak magnitude and RMS', () => {
        const samples = new Float32Array([0, 0.5, -0.8, 0.3]);
        const { peak, rms } = channelStats(samples);
        expect(peak).toBeCloseTo(0.8, 6);
        expect(rms).toBeCloseTo(Math.sqrt((0 + 0.25 + 0.64 + 0.09) / 4), 6);
    });

    it('reports a full-scale sine near 1 peak and 0.707 RMS', () => {
        const samples = new Float32Array(4096).map((_, i) => Math.sin((i / 4096) * Math.PI * 2 * 8));
        const { peak, rms } = channelStats(samples);
        expect(peak).toBeCloseTo(1, 2);
        expect(rms).toBeCloseTo(Math.SQRT1_2, 2);
    });

    it('samples rather than scanning everything', () => {
        const samples = new Float32Array(1_000_000).fill(0.25);
        const { peak, rms } = channelStats(samples, 1000);
        expect(peak).toBeCloseTo(0.25, 6);
        expect(rms).toBeCloseTo(0.25, 6);
    });

    it('returns zeros for an empty channel', () => {
        expect(channelStats(new Float32Array(0))).toEqual({ peak: 0, rms: 0 });
    });
});

describe('visualization modes', () => {
    it('maps each mode to the panes it shows', () => {
        expect(showsWaveform('waveform')).toBe(true);
        expect(showsSpectrogram('waveform')).toBe(false);
        expect(showsWaveform('spectrogram')).toBe(false);
        expect(showsSpectrogram('spectrogram')).toBe(true);
        expect(showsWaveform('both')).toBe(true);
        expect(showsSpectrogram('both')).toBe(true);
    });

    it('ignores an unknown spectrogram scale', () => {
        const controller = createAudioController();
        controller.dispatch({ type: 'set-spectrogram-scale', scale: 'bark' });
        expect(controller.state.spectrogramScale).toBe('bark');
        controller.dispatch({ type: 'set-spectrogram-scale', scale: 'nonsense' as never });
        expect(controller.state.spectrogramScale).toBe('bark');
    });
});

describe('region bounds', () => {
    it('keeps ordinary typed bounds untouched', () => {
        expect(normalizeRegionBounds(2, 5, 60)).toEqual({ start: 2, end: 5 });
    });

    it('swaps reversed bounds so typing an end before the start still works', () => {
        expect(normalizeRegionBounds(9, 3, 60)).toEqual({ start: 3, end: 9 });
    });

    it('clamps into the track', () => {
        expect(normalizeRegionBounds(-4, 90, 60)).toEqual({ start: 0, end: 60 });
        expect(normalizeRegionBounds(70, 80, 60)).toEqual({
            start: 60 - AUDIO_REGION_MIN_DURATION,
            end: 60
        });
    });

    it('enforces the minimum duration', () => {
        const { start, end } = normalizeRegionBounds(10, 10, 60);
        expect(end - start).toBeCloseTo(AUDIO_REGION_MIN_DURATION, 10);
        expect(start).toBe(10);
    });

    // Editing the duration field must move the end, never the start — that is
    // the difference between "make this 3 seconds long" and "move this".
    it('holds the start when preserveStart is set', () => {
        expect(normalizeRegionBounds(10, 13, 60, { preserveStart: true }))
            .toEqual({ start: 10, end: 13 });
        const shrunk = normalizeRegionBounds(10, 10.01, 60, { preserveStart: true });
        expect(shrunk.start).toBe(10);
        expect(shrunk.end - shrunk.start).toBeCloseTo(AUDIO_REGION_MIN_DURATION, 10);
    });

    it('does not swap under preserveStart even when the end is earlier', () => {
        const result = normalizeRegionBounds(20, 5, 60, { preserveStart: true });
        expect(result.start).toBe(20);
        expect(result.end).toBeGreaterThan(result.start);
    });

    it('collapses to zero for an unknown duration', () => {
        expect(normalizeRegionBounds(1, 2, 0)).toEqual({ start: 0, end: 0 });
        expect(normalizeRegionBounds(1, 2, Number.NaN)).toEqual({ start: 0, end: 0 });
    });

    it('handles a track shorter than the minimum region', () => {
        const result = normalizeRegionBounds(0, 0, 0.05);
        expect(result.start).toBe(0);
        expect(result.end).toBeCloseTo(0.05, 10);
    });

    it('substitutes a default end for a non-numeric one', () => {
        const result = normalizeRegionBounds(5, Number.NaN, 60);
        expect(result.start).toBe(5);
        expect(result.end - result.start).toBeCloseTo(AUDIO_REGION_MIN_DURATION, 10);
    });
});
