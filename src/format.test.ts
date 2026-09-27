import { describe, expect, it } from 'vitest';
import { formatDistance, formatDuration, formatPointCount } from './format';

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
