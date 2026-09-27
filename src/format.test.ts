import { describe, expect, it } from 'vitest';
import {
    distanceAxisLabels,
    elevationAxisLabels,
    formatDistance,
    formatDuration,
    formatElevation,
    formatPointCount,
    formatSpeed,
    speedAxisLabels,
} from './format';

describe('formatDistance', () => {
    it('uses metres below a kilometre', () => {
        expect(formatDistance(0)).toBe('0 m');
        expect(formatDistance(850)).toBe('850 m');
        expect(formatDistance(999)).toBe('999 m');
    });

    it('switches to kilometres at 1000 m', () => {
        expect(formatDistance(1000)).toMatch(/^1(\.0)? km$/);
    });

    it('keeps one decimal place on kilometres', () => {
        // Grouping is locale-dependent, so match the shape rather than the text.
        expect(formatDistance(12_345)).toMatch(/^12\.3 km$/);
        expect(formatDistance(1_234_567)).toMatch(/^1,234\.6 km$/);
    });

    it('reports unknown values', () => {
        expect(formatDistance(Number.NaN)).toBe('—');
        expect(formatDistance(Number.POSITIVE_INFINITY)).toBe('—');
    });
});

describe('formatDuration', () => {
    it('omits hours under an hour', () => {
        expect(formatDuration(0)).toBe('0:00');
        expect(formatDuration(59_000)).toBe('0:59');
        expect(formatDuration(60_000)).toBe('1:00');
        expect(formatDuration(3_599_000)).toBe('59:59');
    });

    it('includes hours from an hour up', () => {
        expect(formatDuration(3_600_000)).toBe('1:00:00');
        expect(formatDuration(3_661_000)).toBe('1:01:01');
        expect(formatDuration(36_000_000)).toBe('10:00:00');
    });

    it('zero-pads every field', () => {
        expect(formatDuration(3_600_000 + 61_000)).toBe('1:01:01');
    });

    it('rounds to whole seconds', () => {
        expect(formatDuration(59_600)).toBe('1:00');
        expect(formatDuration(999)).toBe('0:01');
    });

    it('reports unknown and negative values', () => {
        expect(formatDuration(Number.NaN)).toBe('—');
        expect(formatDuration(-1)).toBe('—');
    });
});

describe('formatPointCount', () => {
    it('groups thousands', () => {
        expect(formatPointCount(0)).toBe('0');
        expect(formatPointCount(1234)).toMatch(/^1,234$|^1.234$/);
    });
});

describe('formatElevation', () => {
    it('uses metres below a kilometre', () => {
        expect(formatElevation(0)).toBe('0 m');
        expect(formatElevation(400.4)).toBe('400 m');
        expect(formatElevation(999)).toBe('999 m');
    });

    it('switches to kilometres at 1000 m, like formatDistance does', () => {
        expect(formatElevation(1000)).toMatch(/^1(\.0)? km$/);
        expect(formatElevation(2450)).toMatch(/^2\.5 km$/);
    });

    it('keeps negative elevations, which is a real elevation', () => {
        expect(formatElevation(-12)).toBe('-12 m');
        expect(formatElevation(-1500)).toMatch(/^-1\.5 km$/);
    });

    it('reports unknown values', () => {
        expect(formatElevation(Number.NaN)).toBe('—');
    });
});

describe('formatSpeed', () => {
    it('uses metres per second at walking pace and below', () => {
        expect(formatSpeed(0)).toBe('0.0 m/s');
        expect(formatSpeed(1.25)).toBe('1.3 m/s');
        expect(formatSpeed(2.99)).toBe('3.0 m/s');
    });

    it('switches to km/h above 3 m/s', () => {
        // 10 m/s is 36 km/h, which is where the switch has to be unambiguous.
        expect(formatSpeed(3)).toMatch(/^10\.8 km\/h$/);
        expect(formatSpeed(10)).toMatch(/^36 km\/h$/);
    });

    it('keeps the unit the axis is drawn in', () => {
        // A chart y-axis is labelled at its extremes only, so the two labels have
        // to read in the same units or the gap between them means nothing.
        expect(formatSpeed(0).endsWith('m/s')).toBe(true);
        expect(formatSpeed(20).endsWith('km/h')).toBe(true);
    });

    it('reports unknown values', () => {
        expect(formatSpeed(Number.NaN)).toBe('—');
        expect(formatSpeed(Number.POSITIVE_INFINITY)).toBe('—');
    });
});

describe('axis labels', () => {
    it('puts both ends of an elevation axis in the unit it is drawn in', () => {
        expect(elevationAxisLabels(380, 520)).toEqual(['520 m', '380 m']);
    });

    it('and keeps them in kilometres when the axis reaches that far', () => {
        // 900 m and 1.1 km are the same axis, and reading it as two numbers in
        // different units means converting between the labels to compare them.
        expect(elevationAxisLabels(900, 1100)).toEqual(['1.1 km', '0.9 km']);
    });

    it('reads a speed axis in one unit even when it crosses the switch', () => {
        // The case the value formatter gets wrong on its own: 0 formatted on its own
        // is m/s, 5.4 on its own is km/h, and the axis would claim both.
        expect(speedAxisLabels(0, 5.4)).toEqual(['19.4 km/h', '0 km/h']);
        expect(speedAxisLabels(0, 2.5)).toEqual(['2.5 m/s', '0.0 m/s']);
    });

    it('takes the unit from whichever end is further from zero', () => {
        expect(elevationAxisLabels(0, 900)).toEqual(['900 m', '0 m']);
        expect(elevationAxisLabels(-1200, -300)).toEqual(['-0.3 km', '-1.2 km']);
        expect(speedAxisLabels(-4, 0)).toEqual(['0 km/h', '-14.4 km/h']);
    });

    it('reads the higher end first, the way an axis is drawn', () => {
        // Ascending in value, so the top label is the biggest number, negatives and
        // all: a descending axis has to be read upside down to compare its ends.
        expect(elevationAxisLabels(-1200, -300)).toEqual(['-0.3 km', '-1.2 km']);
        expect(speedAxisLabels(-4, 0)).toEqual(['0 km/h', '-14.4 km/h']);
    });

    it('orders the ends whichever way round they are given', () => {
        expect(elevationAxisLabels(520, 380)).toEqual(['520 m', '380 m']);
        expect(speedAxisLabels(2.5, 0)).toEqual(['2.5 m/s', '0.0 m/s']);
    });

    it('has both labels of a distance axis in one unit too', () => {
        expect(distanceAxisLabels(0, 542)).toEqual(['542 m', '0 m']);
        expect(distanceAxisLabels(0, 5400)).toEqual(['5.4 km', '0 km']);
    });

    it('answers a range that is not a number without printing NaN', () => {
        expect(elevationAxisLabels(Number.NaN, 520)).toEqual(['0 m', '0 m']);
        expect(speedAxisLabels(0, Number.POSITIVE_INFINITY)).toEqual(['0.0 m/s', '0.0 m/s']);
    });
});
