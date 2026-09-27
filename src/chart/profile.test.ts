import { describe, expect, it } from 'vitest';
import {
    buildProfile,
    distanceRange,
    metricValues,
    timeAtDistance,
    valueAtDistance,
    valueRange,
    valueAtTime,
} from './profile';
import type { Metric } from './profile';
import type { Track } from '../types';

const S = 1000;

/**
 * A track from parallel arrays. `timesS` and `distM` are the two the profile
 * cares about; everything else is filled with something harmless so a test only
 * has to spell out what it is actually about.
 */
const track = (timesS: number[], opts: { distM?: number[]; eleM?: number[] } = {}): Track => {
    const distM = opts.distM ?? timesS.map((t) => t);
    const eleM = opts.eleM ?? timesS.map((t) => 100 + t);
    const n = timesS.length;
    return {
        id: 't',
        name: 't',
        color: '#f00',
        t0: 0,
        tRel: Float64Array.from(timesS),
        lat: new Float64Array(n),
        lon: new Float64Array(n),
        ele: Float32Array.from(eleM),
        dist: Float32Array.from(distM),
        segmentBreaks: new Uint32Array(0),
        durationMs: (timesS[n - 1] ?? 0) * 1000,
        distanceM: distM[n - 1] ?? 0,
        bounds: { minLon: 0, minLat: 0, maxLon: 0, maxLat: 0 },
        renderLine: [],
    } as Track;
};

/** Speeds in m/s, for comparing against an expected profile. */
const values = (points: { value: number }[]): number[] => points.map((p) => p.value);

describe('buildProfile', () => {
    describe('elevation', () => {
        it('reads the elevation at every sample', () => {
            const t = track([0, 1, 2, 3], { eleM: [400, 410, 405, 420] });
            expect(buildProfile(t, 'elevation', 1000)).toEqual([
                { distanceM: 0, value: 400 },
                { distanceM: 1, value: 410 },
                { distanceM: 2, value: 405 },
                { distanceM: 3, value: 420 },
            ]);
        });

        it('is one point per sample while that fits the budget', () => {
            const t = track([0, 1, 2, 3, 4]);
            expect(buildProfile(t, 'elevation', 5)).toHaveLength(5);
        });

        it('is empty for a track with no samples', () => {
            expect(buildProfile(track([]), 'elevation', 100)).toEqual([]);
        });

        it('is a single point for a one-sample track', () => {
            expect(buildProfile(track([0], { eleM: [512] }), 'elevation', 100)).toEqual([
                { distanceM: 0, value: 512 },
            ]);
        });
    });

    describe('decimation', () => {
        it('never exceeds the budget however long the track is', () => {
            const times = Array.from({ length: 5000 }, (_, i) => i);
            expect(buildProfile(track(times), 'elevation', 400)).toHaveLength(400);
        });

        it('keeps the distance axis increasing', () => {
            const times = Array.from({ length: 5000 }, (_, i) => i * 2);
            const points = buildProfile(track(times), 'elevation', 300);
            for (let i = 1; i < points.length; i += 1) {
                expect(points[i].distanceM).toBeGreaterThan(points[i - 1].distanceM);
            }
        });

        it('spans the whole ride, from the start line to the end', () => {
            const times = Array.from({ length: 1000 }, (_, i) => i);
            const t = track(times, { distM: times.map((x) => x * 3) });
            const points = buildProfile(t, 'elevation', 100);
            // A bucket drawn at the middle of its range would start a pixel in
            // from the start line, so the endpoints have to be the ride's own.
            expect(points[0].distanceM).toBe(0);
            expect(points[points.length - 1].distanceM).toBe(999 * 3);
        });

        it('averages each bucket rather than sampling one point of it', () => {
            // Four samples, two buckets. The first bucket holds 100 and 200, so
            // its value is 150 — picking either sample instead would show a
            // climb that the bucket does not actually average.
            const t = track([0, 1, 2, 3], { eleM: [100, 200, 10, 20] });
            expect(values(buildProfile(t, 'elevation', 2))).toEqual([150, 15]);
        });
    });

    describe('speed', () => {
        it('reports the exact speed of a constant-speed ride', () => {
            // 10 m every second is 10 m/s, everywhere except where the window has
            // to be clipped by the ends of the ride.
            const times = Array.from({ length: 60 }, (_, i) => i);
            const t = track(times, { distM: times.map((i) => i * 10) });
            const speeds = values(buildProfile(t, 'speed', 1000));
            expect(speeds[30]).toBeCloseTo(10, 9);
            expect(speeds[45]).toBeCloseTo(10, 9);
        });

        it('clips the window at the ends instead of using one interval', () => {
            // 10 m/s throughout, except that the opening interval covers nothing:
            // the rider was stationary for the first two fixes. A speed from a
            // single interval would read 0 m/s at the start; a speed from the
            // clipped window reads the 60 m covered in the 7.5 s that exist.
            const times = Array.from({ length: 120 }, (_, i) => i);
            const distM = times.map((i) => (i < 2 ? 0 : (i - 1) * 10));
            const t = track(times, { distM });
            const speeds = values(buildProfile(t, 'speed', 1000));
            expect(speeds[0]).toBeCloseTo(60 / 7, 9);
            expect(speeds[119]).toBeCloseTo(10, 9);
            // And nothing anywhere on the ride exceeds its true speed.
            expect(Math.max(...speeds)).toBeCloseTo(10, 9);
        });

        it('reads zero where the ride stood still', () => {
            // A fix every 5 s, because a sample interval coarser than the speed
            // window would leave each sample looking at itself alone. The first
            // minute is stationary; after that it holds 10 m/s.
            const times = Array.from({ length: 25 }, (_, i) => i * 5);
            const distM = times.map((_, i) => (i < 13 ? 0 : (i - 12) * 50));
            const t = track(times, { distM });
            const speeds = values(buildProfile(t, 'speed', 1000));
            expect(speeds[0]).toBe(0);
            expect(speeds[6]).toBe(0);
            // At 1:00 the window straddles the start of the move, so it reports
            // half the ride's speed rather than either extreme.
            expect(speeds[12]).toBeCloseTo(5, 9);
            expect(speeds[24]).toBeCloseTo(10, 9);
        });

        it('is centred, so a value does not lag behind the ride', () => {
            // Stationary until 0:35, then 10 m/s. At the last stationary sample
            // the window reaches 7.5 s either side, catching the first 50 m, so
            // it reads half speed. A window looking only forwards would read 0 and
            // one looking only backwards would read the full 10 m/s, so this
            // single value is what distinguishes a centred window from either
            // one-sided one.
            const times = Array.from({ length: 13 }, (_, i) => i * 5);
            const distM = times.map((_, i) => (i < 7 ? 0 : (i - 6) * 50));
            const t = track(times, { distM });
            const speeds = values(buildProfile(t, 'speed', 1000));
            expect(speeds[6]).toBeCloseTo(5, 9);
            expect(speeds[5]).toBe(0);
            expect(speeds[7]).toBeCloseTo(10, 9);
        });

        it('never reports a non-finite speed, whatever the timestamps', () => {
            // Every sample shares one timestamp: a burst of duplicate fixes, which
            // divides by zero if the window span is not guarded.
            const duplicate = track([5, 5, 5, 5, 5], { distM: [0, 1, 2, 3, 4] });
            const speeds = values(buildProfile(duplicate, 'speed', 1000));
            expect(speeds).toEqual([0, 0, 0, 0, 0]);
            expect(speeds.every((v) => Number.isFinite(v))).toBe(true);
        });

        it('is empty for a track with no samples', () => {
            expect(buildProfile(track([]), 'speed', 100)).toEqual([]);
        });

        it('is decimated like elevation', () => {
            const times = Array.from({ length: 4000 }, (_, i) => i);
            const t = track(times, { distM: times.map((i) => i * 2) });
            expect(buildProfile(t, 'speed', 200)).toHaveLength(200);
        });
    });

    it('builds a profile for either metric from the same track', () => {
        // A fix every 5 s, so a sample has neighbours inside the speed window: at
        // 10 s the window spans 2.5 to 17.5 s and covers 100 m in 10 s.
        const t = track([0, 5, 10, 15, 20], {
            eleM: [400, 400, 400, 400, 400],
            distM: [0, 50, 100, 150, 200],
        });
        const elevation = buildProfile(t, 'elevation', 100);
        const speed = buildProfile(t, 'speed', 100);
        expect(values(elevation)).toEqual([400, 400, 400, 400, 400]);
        expect(values(speed)[2]).toBeCloseTo(10, 9);
    });
});

describe('valueAtDistance', () => {
    const points = [
        { distanceM: 0, value: 400 },
        { distanceM: 100, value: 500 },
        { distanceM: 200, value: 400 },
    ];

    it('is exact at a point on the profile', () => {
        expect(valueAtDistance(points, 0)).toBe(400);
        expect(valueAtDistance(points, 100)).toBe(500);
    });

    it('interpolates between two points', () => {
        expect(valueAtDistance(points, 50)).toBe(450);
        expect(valueAtDistance(points, 25)).toBe(425);
    });

    it('clamps before the start and after the end', () => {
        expect(valueAtDistance(points, -100)).toBe(400);
        expect(valueAtDistance(points, 9999)).toBe(400);
    });

    it('has no value for an empty profile', () => {
        expect(valueAtDistance([], 50)).toBeNull();
    });

    it('reads a single point as flat whatever the distance asked for', () => {
        const one = [{ distanceM: 50, value: 412 }];
        expect(valueAtDistance(one, 0)).toBe(412);
        expect(valueAtDistance(one, 50)).toBe(412);
        expect(valueAtDistance(one, 1000)).toBe(412);
    });

    it('does not divide by zero where two points share a distance', () => {
        // A recorded pause can leave the distance unchanged across samples, and
        // the profile can then hold two points at the same x.
        const flat = [
            { distanceM: 0, value: 400 },
            { distanceM: 0, value: 500 },
            { distanceM: 10, value: 600 },
        ];
        expect(valueAtDistance(flat, 0)).toBe(400);
        expect(Number.isFinite(valueAtDistance(flat, 5) as number)).toBe(true);
        expect(valueAtDistance(flat, 10)).toBe(600);
    });
});

describe('valueRange', () => {
    it('covers every track on the chart', () => {
        const range = valueRange([
            [
                { distanceM: 0, value: 400 },
                { distanceM: 1, value: 900 },
            ],
            [
                { distanceM: 0, value: 250 },
                { distanceM: 1, value: 600 },
            ],
        ]);
        expect(range).toEqual({ min: 250, max: 900 });
    });

    it('widens a flat range so the line is still drawable', () => {
        const range = valueRange([
            [
                { distanceM: 0, value: 500 },
                { distanceM: 1, value: 500 },
            ],
        ]);
        expect(range.min).toBeLessThan(500);
        expect(range.max).toBeGreaterThan(500);
    });

    it('falls back to a usable axis with nothing to plot', () => {
        expect(valueRange([])).toEqual({ min: 0, max: 1 });
        expect(valueRange([[]])).toEqual({ min: 0, max: 1 });
    });

    it('ignores values that are not finite', () => {
        const range = valueRange([
            [
                { distanceM: 0, value: Number.NaN },
                { distanceM: 1, value: 700 },
                { distanceM: 2, value: Number.POSITIVE_INFINITY },
                { distanceM: 3, value: 900 },
            ],
        ]);
        expect(range).toEqual({ min: 700, max: 900 });
    });
});

describe('distanceRange', () => {
    it('is the farthest point of the longest track', () => {
        expect(
            distanceRange([
                [
                    { distanceM: 0, value: 1 },
                    { distanceM: 800, value: 2 },
                ],
                [
                    { distanceM: 0, value: 1 },
                    { distanceM: 1234.5, value: 2 },
                ],
            ]),
        ).toBe(1234.5);
    });

    it('is zero with nothing loaded', () => {
        expect(distanceRange([])).toBe(0);
    });
});

describe('timeAtDistance', () => {
    it('is exact at a sample distance', () => {
        const t = track([0, 10, 20, 30], { distM: [0, 100, 200, 300] });
        expect(timeAtDistance(t, 0)).toBe(0);
        expect(timeAtDistance(t, 200)).toBe(20 * S);
    });

    it('interpolates between samples', () => {
        const t = track([0, 10, 20, 30], { distM: [0, 100, 200, 300] });
        // Halfway between 100 m at 10 s and 200 m at 20 s is 15 s.
        expect(timeAtDistance(t, 150)).toBe(15 * S);
    });

    it('clamps to the ends of the ride', () => {
        const t = track([0, 10, 20], { distM: [0, 100, 200] });
        expect(timeAtDistance(t, -50)).toBe(0);
        expect(timeAtDistance(t, 9999)).toBe(20 * S);
    });

    it('returns zero for a track with no samples', () => {
        expect(timeAtDistance(track([]), 100)).toBe(0);
    });

    it('lands where the ride first reached the distance, not where it left', () => {
        // A recorded pause: three samples at 100 m, then a jump to 200 m. The ride
        // was at 100 m from 0:10 to 0:30, and "when did it get here" means 0:10.
        // Answering 0:30 would also make 99.9 m read 0:09.99 while 100 m read
        // 0:30 — a 20 s jump for a tenth of a metre.
        const t = track([0, 10, 20, 30, 40], { distM: [0, 100, 100, 100, 200] });
        expect(timeAtDistance(t, 100)).toBe(10 * S);
        expect(timeAtDistance(t, 99.9)).toBeCloseTo(9.99 * S, 6);
        // Just past the plateau the ride is on its way again, and there the
        // answer climbs smoothly instead of jumping.
        expect(timeAtDistance(t, 150)).toBe(35 * S);
    });

    it('is monotonic in distance', () => {
        const t = track([0, 10, 20, 30, 40, 50], { distM: [0, 100, 100, 200, 300, 400] });
        let previous = -1;
        for (let d = 0; d <= 400; d += 7) {
            const at = timeAtDistance(t, d);
            expect(at).toBeGreaterThanOrEqual(previous);
            previous = at;
        }
    });
});

describe('metrics', () => {
    it('are exactly the two the toggle offers', () => {
        const metrics: Metric[] = ['elevation', 'speed'];
        expect(metrics).toHaveLength(2);
    });
});

describe('metricValues', () => {
    it('is the elevation at every fix', () => {
        const t = track([0, 1, 2], { eleM: [400, 410, 405] });
        expect(Array.from(metricValues(t, 'elevation'))).toEqual([400, 410, 405]);
    });

    it('is the smoothed speed at every fix', () => {
        // 10 m a second, so every window reads 10 m/s however wide it is.
        const t = track([0, 1, 2, 3, 4], { distM: [0, 10, 20, 30, 40] });
        expect(valuesOf(metricValues(t, 'speed'))).toEqual([10, 10, 10, 10, 10]);
    });

    it('is empty for a track with no fixes, rather than undefined', () => {
        expect(metricValues(track([]), 'speed')).toHaveLength(0);
    });

    it('agrees with the profile it is drawn from, sample for sample', () => {
        // The marker reads this array and the line is drawn from the profile, so
        // while a track fits the point budget the two have to be the same numbers.
        const t = track([0, 1, 2, 3], { distM: [0, 3, 7, 9], eleM: [400, 460, 500, 520] });
        for (const metric of ['elevation', 'speed'] as Metric[]) {
            const drawn = buildProfile(t, metric, 1000);
            expect(valuesOf(metricValues(t, metric))).toEqual(values(drawn));
            expect(drawn.map((p) => p.distanceM)).toEqual(Array.from(t.dist));
        }
    });
});

describe('valueAtTime', () => {
    const read = (v: number[]) => metricLike(Float64Array.from(v));

    it('reads the fix it is on exactly', () => {
        expect(valueAtTime(read([10, 20, 30]), 1, 0)).toBe(20);
    });

    it('reads partway between two fixes', () => {
        expect(valueAtTime(read([10, 20]), 0, 0.5)).toBe(15);
        expect(valueAtTime(read([0, 100]), 0, 0.25)).toBe(25);
    });

    it('reads the last fix when the playhead is on it', () => {
        expect(valueAtTime(read([10, 20, 30]), 2, 0)).toBe(30);
    });

    it('clamps a playhead past the last fix to the last value', () => {
        expect(valueAtTime(read([10, 20, 30]), 2, 0.5)).toBe(30);
        expect(valueAtTime(read([10, 20, 30]), 99, 0.5)).toBe(30);
    });

    it('clamps a playhead before the first fix to the first value', () => {
        expect(valueAtTime(read([10, 20, 30]), -4, 0.5)).toBe(10);
    });

    it('clamps a fraction outside the pair it was given', () => {
        expect(valueAtTime(read([10, 20]), 0, 4)).toBe(20);
        expect(valueAtTime(read([10, 20]), 0, -4)).toBe(10);
    });

    it('has no value to read from a track with no fixes', () => {
        expect(valueAtTime(read([]), 0, 0)).toBe(0);
    });

    it('reads a recorded stop as stopped, not as the speed carried into it', () => {
        // The whole reason this is read by time: 0 m/s at the stop, 10 m/s either
        // side, so a rider waiting at a junction reads as waiting.
        const held = read([10, 0, 0, 0, 10]);
        expect(valueAtTime(held, 2, 0)).toBe(0);
        expect(valueAtTime(held, 1, 0.5)).toBe(0);
        expect(valueAtTime(held, 0, 0)).toBe(10);
        expect(valueAtTime(held, 3, 1)).toBe(10);
    });

    it('disagrees with a distance lookup across a stop, which is the point', () => {
        // Moving at 10 m/s, then stationary for five fixes, then moving again: the
        // fixes at 100 m all share one distance, so the profile can only answer for
        // that distance with the first arrival — the speed the rider had while
        // arriving, not the one they were doing while waiting there.
        // Five *seconds* a fix, 10 m/s while moving, then a
        // stop spanning five fixes, then moving again. The two fixes either side of
        // the stop average across it, which is what smoothing is for, and the middle
        // of the stop sees nothing but stationary fixes and so reads nothing at all.
        const t = track([0, 5, 10, 15, 20, 25, 30, 35, 40], {
            distM: [0, 50, 100, 100, 100, 100, 100, 150, 200],
        });
        const values = valuesOf(metricValues(t, 'speed'));
        expect(values).toEqual([10, 10, 5, 0, 0, 0, 5, 10, 10]);

        // Read by time in the middle of the stop: stationary. Read by distance,
        // which cannot tell the middle of a stop from the moment it arrived: 5.
        expect(valueAtTime(metricValues(t, 'speed'), 4, 0)).toBe(0);
        expect(valueAtDistance(buildProfile(t, 'speed', 1000), 100)).toBe(5);
    });
});

/** A stand-in for the array `metricValues` returns, built from plain numbers. */
const metricLike = (values: Float64Array): Float64Array => values;

const valuesOf = (values: Float64Array): number[] =>
    Array.from(values, (v) => Number(v.toFixed(6)));
