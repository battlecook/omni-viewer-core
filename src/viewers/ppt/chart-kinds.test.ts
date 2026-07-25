import { describe, expect, it } from 'vitest';
import type { SlideChartData, SlideChartKind } from '../../parsers/slide-model.js';
import { drawChart, formatChartValue } from './chart.js';

function canvas() {
    const calls = { fillRect: 0, arc: 0, fillText: [] as string[] };
    const noop = (): void => {};
    const context = {
        clearRect: noop,
        beginPath: noop,
        stroke: noop,
        fill: noop,
        moveTo: noop,
        lineTo: noop,
        strokeRect: noop,
        fillRect: () => { calls.fillRect += 1; },
        fillText: (value: string) => { calls.fillText.push(value); },
        arc: () => { calls.arc += 1; },
        set fillStyle(_value: string) {},
        set strokeStyle(_value: string) {},
        set lineWidth(_value: number) {},
        set font(_value: string) {},
        set textAlign(_value: CanvasTextAlign) {},
        set textBaseline(_value: CanvasTextBaseline) {}
    } as unknown as CanvasRenderingContext2D;
    return {
        calls,
        value: {
            width: 600,
            height: 400,
            getContext: () => context
        } as unknown as HTMLCanvasElement
    };
}

const data = (kind: SlideChartKind): SlideChartData => ({
    kind,
    categories: ['A', 'B'],
    series: [
        { name: 'One', color: '#f00', values: [2, -1] },
        { name: 'Two', color: '#00f', values: [3, 4] }
    ]
});

describe('extended PPT chart kinds', () => {
    it.each([
        'clusteredColumn',
        'percentStackedColumn',
        'clusteredBar',
        'stackedBar',
        'percentStackedBar'
    ] as const)('renders %s with data-driven bars', (kind) => {
        const target = canvas();
        drawChart(target.value, data(kind));
        expect(target.calls.fillRect).toBeGreaterThan(0);
        expect(target.calls.fillText.length).toBeGreaterThan(0);
    });

    it('renders pie slices and legend labels', () => {
        const target = canvas();
        drawChart(target.value, {
            kind: 'pie',
            categories: ['A', 'B'],
            series: [
                { name: 'A', color: '#f00', values: [2] },
                { name: 'B', color: '#00f', values: [3] }
            ]
        });
        expect(target.calls.arc).toBe(2);
        expect(target.calls.fillText.length).toBeGreaterThanOrEqual(2);
    });

    it('keeps percentage number formats', () => {
        expect(formatChartValue(75, '0%')).toBe('75%');
    });
});
