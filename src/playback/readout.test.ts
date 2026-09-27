import { describe, expect, it } from 'vitest';
import { markerTimeMs, readoutText } from './readout';
import { positionAt } from './interpolate';
import type { Track } from '../types';

const S = 1000;
const M = 60_000;
const H = 3_600_000;

const makeTrack = (
    timesMs: number[],
    extra: { segmentBreaks?: number[]; dist?: number[]; durationMs?: number } = {},
): Track => {
    const tRel = new Float64Array(timesMs.length);
    for (let i = 0; i < timesMs.length; i += 1) {
        tRel[i] = timesMs[i] / S;
    }
    const dist = Float32Array.from(extra.dist ?? new Array(timesMs.length).fill(0));
    return {
        id: 'test',
        name: 'test',
        color: '#f00',
        t0: 0,
        tRel,
        lat: Float64Array.from(new Array(timesMs.length).fill(47)),
        lon: Float64Array.from(new Array(timesMs.length).fill(0)),
        ele: new Float32Array(timesMs.length),
        dist,
        segmentBreaks: new Uint32Array(extra.segmentBreaks ?? []),
        durationMs: extra.durationMs ?? timesMs[timesMs.length - 1] ?? 0,
        distanceM: dist[dist.length - 1] ?? 0,
        bounds: { minLon: 0, minLat: 0, maxLon: 0, maxLat: 0 },
        renderLine: [],
    } as Track;
};

/** Every 10 s, 100 m of ground covered per sample. */
const steady = makeTrack([0, 10 * S, 20 * S, 30 * S], { dist: [0, 100, 200, 300] });

/** Ten minutes of travel, then a twenty-minute recorded pause, then a minute. */
const withPause = makeTrack([0, 5 * M, 10 * M, 30 * M, 31 * M], {
    dist: [0, 500, 1000, 2000, 2100],
    segmentBreaks: [3],
});

describe('readoutText', () => {
    it('reads as zero for a time before the start', () => {
        // A track recorded two hours later is measured from its own start, so
        // it reads exactly like the first one rather than being hidden behind a
        // dash: the marker is at the start line and has not travelled.
        expect(readoutText(steady, -2 * H)).toBe('0:00 · 0 m');
    });

    it('shows the elapsed time and the distance covered', () => {
        // Halfway between 100 m and 200 m is 150 m.
        expect(readoutText(steady, 15 * S)).toBe('0:15 · 150 m');
    });

    it('switches to kilometres past a thousand metres', () => {
        expect(readoutText(steady, 20 * S)).toBe('0:20 · 200 m');
        const long = makeTrack([0, 10 * M], { dist: [0, 4200] });
        expect(readoutText(long, 10 * M)).toBe('10:00 · 4.2 km');
    });

    it('keeps counting while the marker is parked in a pause', () => {
        // The playhead is at 20:00 and the marker has been sitting at 10:00 for
        // half of it, so the time shown has to be the marker's, not the clock's.
        const readout = readoutText(withPause, 20 * M);
        expect(readout).toBe('10:00 · 1 km');
        expect(readout).not.toContain('20:00');
    });

    it('resumes when the pause ends', () => {
        expect(readoutText(withPause, 30 * M)).toBe('30:00 · 2 km');
    });

    it('freezes on the full ride once the track is done', () => {
        // One minute of travel in a 31-minute ride: the marker has been parked
        // at 10:00 for the other thirty, and stays there.
        expect(readoutText(withPause, 5 * H)).toBe('31:00 · 2.1 km');
    });

    it('agrees with the track totals shown beside it in the legend', () => {
        // The static meta line reads the whole ride; the readout has to land on
        // exactly those two numbers when the run finishes, or the row contradicts
        // itself.
        const finished = readoutText(steady, 10 * M);
        expect(finished).toBe('0:30 · 300 m');
        expect(steady.durationMs).toBe(30 * S);
        expect(steady.distanceM).toBe(300);
    });

    it('never shows a negative time', () => {
        expect(readoutText(steady, -1)).toBe('0:00 · 0 m');
    });

    it('reads the same for every track at the same elapsed time, whatever t0', () => {
        // The readout is per track only because each track has its own distance;
        // the clock is shared, so a later recording must not read differently
        // from an earlier one at the same moment of the run.
        const later = { ...steady, id: 'later', t0: 5 * H } as Track;
        expect(readoutText(steady, 15 * S)).toBe(readoutText(later, 15 * S));
    });
});

describe('markerTimeMs', () => {
    it('is the playhead while the marker is moving', () => {
        const position = positionAt(steady, 12.5 * S);
        expect(position.status).toBe('running');
        expect(markerTimeMs(steady, position, 12.5 * S)).toBe(12.5 * S);
    });

    it('is the sample time when the marker is held', () => {
        const parked = positionAt(withPause, 20 * M);
        expect(parked.status).toBe('parked');
        expect(markerTimeMs(withPause, parked, 20 * M)).toBe(10 * M);
    });

    it('is the last sample time when the track is done', () => {
        const done = positionAt(steady, H);
        expect(markerTimeMs(steady, done, H)).toBe(30 * S);
    });
});
