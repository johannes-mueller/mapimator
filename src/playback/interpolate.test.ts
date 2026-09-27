import { describe, expect, it } from 'vitest';
import { distanceAt, positionAt } from './interpolate';
import type { Track } from '../types';

const S = 1000;
const M = 60_000;
const H = 3_600_000;

/**
 * A track from parallel arrays. Times are given in milliseconds, as they are
 * in a GPX file, but stored in `tRel` as seconds — the same conversion
 * `parseGpx` performs — so these tests cannot pass against a unit mix-up.
 */
const makeTrack = (
    timesMs: number[],
    coords: [number, number][],
    extra: {
        segmentBreaks?: number[];
        ele?: number[];
        dist?: number[];
        durationMs?: number;
    } = {},
): Track => {
    const tRel = new Float64Array(timesMs.length);
    for (let i = 0; i < timesMs.length; i += 1) {
        tRel[i] = timesMs[i] / S;
    }
    return {
        id: 'test',
        name: 'test',
        color: '#f00',
        t0: 0,
        tRel,
        lat: Float64Array.from(coords.map(([, lat]) => lat)),
        lon: Float64Array.from(coords.map(([lon]) => lon)),
        ele: Float32Array.from(extra.ele ?? new Array(timesMs.length).fill(0)),
        // Defaults to a flat run, so a test that does not care about distance
        // is not quietly reading a real interpolation.
        dist: Float32Array.from(extra.dist ?? new Array(timesMs.length).fill(0)),
        segmentBreaks: new Uint32Array(extra.segmentBreaks ?? []),
        durationMs: extra.durationMs ?? timesMs[timesMs.length - 1] ?? 0,
        distanceM: 0,
        bounds: { minLon: 0, minLat: 0, maxLon: 0, maxLat: 0 },
        renderLine: [],
    } as Track;
};

/** Straight north, one sample every 10 s, one degree of longitude per 100 s. */
const straight = makeTrack(
    [0, 10 * S, 20 * S, 30 * S],
    [
        [0, 47],
        [0.1, 47],
        [0.2, 47],
        [0.3, 47],
    ],
    { ele: [100, 110, 120, 130] },
);

describe('positionAt', () => {
    it('rejects a track with no samples', () => {
        const empty = { ...straight, lat: new Float64Array(0) } as Track;
        expect(() => positionAt(empty, 0)).toThrow(/no samples/);
    });

    describe('before the track starts', () => {
        it('is pending at the first sample', () => {
            const position = positionAt(straight, -1);
            expect(position.status).toBe('pending');
            expect(position.lat).toBe(47);
            expect(position.lon).toBe(0);
            expect(position.index).toBe(0);
        });

        it('is pending for the local time a later track starts at', () => {
            // A track two hours into a shared run begins with a large negative
            // local time, and must not be treated as finished.
            expect(positionAt(straight, -2 * H).status).toBe('pending');
        });

        it('has zero progress', () => {
            expect(positionAt(straight, -H).progress).toBe(0);
        });
    });

    describe('after the track ends', () => {
        it('rests on the final point once the duration has passed', () => {
            const position = positionAt(straight, 30 * S);
            expect(position.status).toBe('done');
            expect(position.lat).toBe(47);
            expect(position.lon).toBe(0.3);
            expect(position.index).toBe(3);
        });

        it('stays there however far past the end it goes', () => {
            expect(positionAt(straight, 99 * H).status).toBe('done');
        });

        it('has full progress', () => {
            expect(positionAt(straight, 30 * S).progress).toBe(1);
        });
    });

    describe('at a sample', () => {
        it('lands exactly on the coordinates', () => {
            for (let i = 0; i < 4; i += 1) {
                const position = positionAt(straight, i * 10 * S);
                expect(position.lon).toBeCloseTo(i * 0.1, 12);
                expect(position.ele).toBeCloseTo(100 + i * 10, 5);
            }
        });

        it('reports the index it landed on', () => {
            expect(positionAt(straight, 0).index).toBe(0);
            expect(positionAt(straight, 10 * S).index).toBe(1);
        });

        it('treats the very first moment as running, not done', () => {
            expect(positionAt(straight, 0).status).toBe('running');
        });
    });

    describe('between samples', () => {
        it('is exactly halfway at the midpoint', () => {
            const position = positionAt(straight, 5 * S);
            expect(position.status).toBe('running');
            expect(position.lon).toBeCloseTo(0.05, 12);
        });

        it('is exactly a quarter of the way at the quarter point', () => {
            expect(positionAt(straight, 2.5 * S).lon).toBeCloseTo(0.025, 12);
        });

        it('interpolates three quarters of the way', () => {
            expect(positionAt(straight, 7.5 * S).lon).toBeCloseTo(0.075, 12);
        });

        it('interpolates the latitude too', () => {
            const climbing = makeTrack(
                [0, 10 * S],
                [
                    [0, 47],
                    [1, 48],
                ],
            );
            expect(positionAt(climbing, 5 * S).lat).toBeCloseTo(47.5, 12);
            expect(positionAt(climbing, 2.5 * S).lat).toBeCloseTo(47.25, 12);
        });

        it('reports the earlier of the two samples as the index', () => {
            expect(positionAt(straight, 5 * S).index).toBe(0);
            expect(positionAt(straight, 15 * S).index).toBe(1);
        });

        it('reads times in milliseconds while samples are stored in seconds', () => {
            // 5 s into a 30 s track is a sixth of the way along, not "past the
            // end". A seconds/milliseconds mix-up would report this as done.
            const position = positionAt(straight, 5 * S);
            expect(position.status).toBe('running');
            expect(position.progress).toBeCloseTo(5 / 30, 12);
        });
    });

    describe('progress', () => {
        it('is the fraction of the track duration elapsed', () => {
            expect(positionAt(straight, 0).progress).toBeCloseTo(0, 12);
            expect(positionAt(straight, 7.5 * S).progress).toBeCloseTo(0.25, 12);
            expect(positionAt(straight, 15 * S).progress).toBeCloseTo(0.5, 12);
            expect(positionAt(straight, 30 * S).progress).toBe(1);
        });

        it('never exceeds one', () => {
            expect(positionAt(straight, 45 * S).progress).toBeLessThanOrEqual(1);
        });
    });

    describe('recorded pauses', () => {
        // Samples 0 and 1 are the first segment; an hour-long break follows;
        // samples 2 and 3 are the second segment.
        const gappy = makeTrack(
            [0, 10 * S, 10 * S + H, 10 * S + H + 10 * S],
            [
                [0, 47],
                [0.1, 47],
                [0.2, 47],
                [0.3, 47],
            ],
            { segmentBreaks: [2], ele: [100, 110, 120, 130] },
        );

        it('holds the last point of the segment for the whole gap', () => {
            // Straight-line interpolation here would put the marker far out in
            // the country, a degree of longitude away.
            for (const offset of [1, 100 * S, 30 * M, 59 * M]) {
                const position = positionAt(gappy, 10 * S + offset);
                expect(position.status).toBe('parked');
                expect(position.lon).toBeCloseTo(0.1, 12);
                expect(position.lat).toBeCloseTo(47, 12);
                expect(position.index).toBe(1);
            }
        });

        it('does not glide across the gap at any point inside it', () => {
            const first = positionAt(gappy, 10 * S);
            const middle = positionAt(gappy, 10 * S + H / 2);
            expect(middle.lon).toBeCloseTo(first.lon, 12);
            expect(middle.lat).toBeCloseTo(first.lat, 12);
        });

        it('is parked at the very start of the gap', () => {
            expect(positionAt(gappy, 10 * S).status).toBe('parked');
        });

        it('is still parked one millisecond before the gap ends', () => {
            const position = positionAt(gappy, 10 * S + H - 1);
            expect(position.status).toBe('parked');
            expect(position.lon).toBeCloseTo(0.1, 12);
        });

        it('resumes exactly at the first sample of the next segment', () => {
            const position = positionAt(gappy, 10 * S + H);
            expect(position.status).toBe('running');
            expect(position.lon).toBeCloseTo(0.2, 12);
            expect(position.index).toBe(2);
        });

        it('interpolates normally again after the gap', () => {
            const position = positionAt(gappy, 10 * S + H + 5 * S);
            expect(position.status).toBe('running');
            expect(position.lon).toBeCloseTo(0.25, 12);
        });

        it('keeps counting progress while parked', () => {
            // The track has not finished just because the marker is standing
            // still; the readout has to keep moving.
            const position = positionAt(gappy, 10 * S + 30 * M);
            expect(position.progress).toBeGreaterThan((10 * S) / (10 * S + H + 10 * S));
        });

        it('parks a whole segment at a time for several breaks', () => {
            // A second segment, another break, then a final segment with real
            // travel in it, so "after the last break" is testable.
            const twice = makeTrack(
                [0, 10 * S, 10 * S + H, 20 * S + H, 20 * S + H + M, 20 * S + H + M + 10 * S],
                [
                    [0, 47],
                    [0.1, 47],
                    [0.2, 47],
                    [0.3, 47],
                    [0.4, 47],
                    [0.5, 47],
                ],
                { segmentBreaks: [2, 4] },
            );
            expect(positionAt(twice, 10 * S + 30 * M).status).toBe('parked');
            expect(positionAt(twice, 10 * S + 30 * M).lon).toBeCloseTo(0.1, 12);
            expect(positionAt(twice, 20 * S + H + 30 * S).status).toBe('parked');
            expect(positionAt(twice, 20 * S + H + 30 * S).lon).toBeCloseTo(0.3, 12);
            expect(positionAt(twice, 20 * S + H + M + 5 * S).status).toBe('running');
            expect(positionAt(twice, 20 * S + H + M + 5 * S).lon).toBeCloseTo(0.45, 12);
        });

        it('ignores a break beyond the end of the samples', () => {
            const beyond = makeTrack(
                [0, 10 * S, 20 * S],
                [
                    [0, 47],
                    [0.1, 47],
                    [0.2, 47],
                ],
                { segmentBreaks: [7] },
            );
            expect(positionAt(beyond, 15 * S).status).toBe('running');
        });
    });

    describe('degenerate samples', () => {
        it('takes the newer of two samples sharing a timestamp', () => {
            // Two fixes recorded at the same instant: at that instant the marker
            // belongs on the later one, not the earlier.
            const duplicated = makeTrack(
                [0, 10 * S, 10 * S, 20 * S],
                [
                    [0, 47],
                    [0.1, 47],
                    [0.5, 47],
                    [0.6, 47],
                ],
            );
            const position = positionAt(duplicated, 10 * S);
            expect(position.index).toBe(2);
            expect(position.lon).toBeCloseTo(0.5, 12);
            expect(Number.isFinite(position.lon)).toBe(true);
        });

        it('returns a finite position when a duration outruns the last sample', () => {
            // Reading past the end of the typed arrays would put a NaN marker on
            // the map, so the last sample is held instead.
            const overrun = makeTrack(
                [0, 10 * S, 20 * S],
                [
                    [0, 47],
                    [0.1, 47],
                    [0.2, 47],
                ],
                { durationMs: 30 * S },
            );
            const position = positionAt(overrun, 25 * S);
            expect(Number.isFinite(position.lon)).toBe(true);
            expect(Number.isFinite(position.lat)).toBe(true);
            expect(position.lon).toBeCloseTo(0.2, 12);
            expect(position.index).toBe(2);
        });

        it('is done at zero duration for a single-sample track', () => {
            const single = makeTrack([0], [[7, 47]]);
            const position = positionAt(single, 0);
            expect(position.status).toBe('done');
            expect(position.lon).toBe(7);
            expect(position.index).toBe(0);
        });

        it('reports full progress for a zero-duration track', () => {
            // Zero duration means the track is over before it starts, so the
            // fraction is 1 rather than a division by zero.
            expect(positionAt(makeTrack([0], [[7, 47]], { durationMs: 0 }), 0).progress).toBe(1);
        });

        it('is pending for a single-sample track before its start', () => {
            expect(positionAt(makeTrack([0], [[7, 47]]), -1).status).toBe('pending');
        });
    });

    describe('larger tracks', () => {
        it('finds the right segment in a long track', () => {
            const times: number[] = [];
            const coords: [number, number][] = [];
            for (let i = 0; i < 5000; i += 1) {
                times.push(i * S);
                coords.push([i * 0.001, 47 + i * 0.0001]);
            }
            const long = makeTrack(times, coords);
            expect(positionAt(long, 2500.5 * S).index).toBe(2500);
            expect(positionAt(long, 2500.5 * S).lon).toBeCloseTo(2.5005, 9);
            expect(positionAt(long, 4999.25 * S).index).toBe(4999);
        });

        it('finds the first and last samples', () => {
            const times = Array.from({ length: 1000 }, (_, i) => i * S);
            const coords = times.map((_, i): [number, number] => [i, 0]);
            const long = makeTrack(times, coords);
            expect(positionAt(long, 0).index).toBe(0);
            expect(positionAt(long, 999.5 * S).index).toBe(999);
        });
    });
});

describe('the interpolation fraction', () => {
    it('is where the position sits between the two samples', () => {
        expect(positionAt(straight, 15 * S).fraction).toBe(0.5);
        expect(positionAt(straight, 12.5 * S).fraction).toBeCloseTo(0.25, 10);
        expect(positionAt(straight, 17.5 * S).fraction).toBeCloseTo(0.75, 10);
    });

    it('is zero on a sample boundary', () => {
        expect(positionAt(straight, 10 * S).fraction).toBe(0);
    });

    it('is zero whenever the position is held on one sample', () => {
        // There is no span to be partway across in any of these, which is what
        // keeps a parked marker from reading as somewhere it is not.
        expect(positionAt(straight, -H).fraction).toBe(0);
        expect(positionAt(straight, 60 * S).fraction).toBe(0);
    });

    it('is zero across a recorded pause', () => {
        const gapped = makeTrack(
            [0, 10 * S, 20 * M, 20 * M + 30 * S],
            [
                [0, 47],
                [0.1, 47],
                [9, 47],
                [9.1, 47],
            ],
            { segmentBreaks: [2] },
        );
        expect(positionAt(gapped, 5 * M).status).toBe('parked');
        expect(positionAt(gapped, 5 * M).fraction).toBe(0);
    });
});

describe('distanceAt', () => {
    /** Ten metres per sample, so the arithmetic is checkable by eye. */
    const walked = makeTrack(
        [0, 10 * S, 20 * S, 30 * S],
        [
            [0, 47],
            [0.1, 47],
            [0.2, 47],
            [0.3, 47],
        ],
        { dist: [0, 10, 25, 60] },
    );

    it('reads the cumulative distance at a sample', () => {
        expect(distanceAt(walked, positionAt(walked, 0))).toBe(0);
        expect(distanceAt(walked, positionAt(walked, 10 * S))).toBe(10);
    });

    it('interpolates between the two samples', () => {
        // Halfway between 10 m and 25 m is 17.5 m.
        expect(distanceAt(walked, positionAt(walked, 15 * S))).toBeCloseTo(17.5, 6);
    });

    it('is the exact total once the track is done', () => {
        const position = positionAt(walked, 60 * S);
        expect(position.status).toBe('done');
        expect(distanceAt(walked, position)).toBe(60);
    });

    it('holds at the segment end during a recorded pause', () => {
        // The pause is not travel, so the distance must not creep across it.
        const gapped = makeTrack(
            [0, 10 * S, 20 * M, 20 * M + 30 * S],
            [
                [0, 47],
                [0.1, 47],
                [9, 47],
                [9.1, 47],
            ],
            { dist: [0, 100, 9000, 9100], segmentBreaks: [2] },
        );
        const position = positionAt(gapped, 15 * M);
        expect(position.status).toBe('parked');
        expect(distanceAt(gapped, position)).toBe(100);
    });

    it('agrees with the track total at the end, which is the whole point', () => {
        // The legend shows the total distance beside the live readout, so the
        // two have to meet exactly when the run finishes.
        const total = walked.distanceM || walked.dist[walked.dist.length - 1];
        const finished = { ...walked, distanceM: total } as Track;
        expect(distanceAt(finished, positionAt(finished, 30 * S))).toBe(finished.distanceM);
    });

    it('does not read past the last sample', () => {
        const short = makeTrack([0], [[0, 47]], { dist: [42] });
        expect(distanceAt(short, positionAt(short, 0))).toBe(42);
    });
});
