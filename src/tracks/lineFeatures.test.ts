import { describe, expect, it } from 'vitest';
import { buildLineFeatures, buildSegments } from './lineFeatures';
import type { Track, TrackState } from '../types';

const breaks = (...values: number[]): Uint32Array => new Uint32Array(values);

// Five points on a flat [lon, lat, ...] line.
const line = [1, 10, 2, 20, 3, 30, 4, 40, 5, 50];
const pos = (n: number): number[][] =>
    [
        [1, 10],
        [2, 20],
        [3, 30],
        [4, 40],
        [5, 50],
    ].slice(0, n);

describe('buildSegments', () => {
    it('returns a single run when there are no breaks', () => {
        expect(buildSegments(line, breaks())).toEqual([pos(5)]);
    });

    it('splits at a recorded break', () => {
        expect(buildSegments(line, breaks(3))).toEqual([pos(3), pos(5).slice(3)]);
    });

    it('keeps positions in [lon, lat] order', () => {
        expect(buildSegments([8.54, 47.37, 8.55, 47.38], breaks())).toEqual([
            [
                [8.54, 47.37],
                [8.55, 47.38],
            ],
        ]);
    });

    it('ignores a break at index 0 rather than emitting an empty run', () => {
        expect(buildSegments(line, breaks(0))).toEqual([pos(5)]);
    });

    it('drops the degenerate run a break at the final index leaves behind', () => {
        // A break at the last point starts a run holding one point, which is
        // not a line; the preceding run is unaffected.
        expect(buildSegments(line, breaks(5))).toEqual([pos(5)]);
    });

    it('drops single-point runs between closely spaced breaks', () => {
        expect(buildSegments(line, breaks(1, 2, 4))).toEqual([pos(5).slice(2, 4)]);
    });

    it('produces nothing for a single point, which cannot be a line', () => {
        expect(buildSegments([1, 10], breaks())).toEqual([]);
        expect(buildSegments([], breaks())).toEqual([]);
    });

    it('is empty when breaks leave nothing but single points', () => {
        expect(buildSegments([1, 10, 2, 20], breaks(1))).toEqual([]);
    });
});

const makeTrack = (over: Partial<Track> = {}): Track => ({
    id: 'track-1',
    name: 'T',
    color: '#e5484d',
    t0: 0,
    tRel: new Float64Array([0, 60]),
    lat: new Float64Array([10, 20]),
    lon: new Float64Array([1, 2]),
    ele: new Float32Array([0, 0]),
    dist: new Float32Array([0, 100]),
    segmentBreaks: new Uint32Array([]),
    durationMs: 60_000,
    distanceM: 100,
    bounds: { minLon: 1, minLat: 10, maxLon: 2, maxLat: 20 },
    renderLine: [1, 10, 2, 20],
    ...over,
});

const state = (track: Track, over: Partial<TrackState> = {}): TrackState => ({
    track,
    visible: true,
    ...over,
});

/** Nothing finished, unless a test says otherwise. */
const noneDone = (): boolean => false;

describe('buildLineFeatures', () => {
    it('emits one MultiLineString feature per visible track', () => {
        const fc = buildLineFeatures(
            [state(makeTrack({ name: 'A' })), state(makeTrack({ name: 'B' }))],
            noneDone,
        );
        expect(fc.type).toBe('FeatureCollection');
        expect(fc.features).toHaveLength(2);
        expect(fc.features[0].geometry.type).toBe('MultiLineString');
    });

    it('carries the styling and identity properties the layers read', () => {
        const track = makeTrack({ id: 'track-9', name: 'Ride', color: '#30a8e0' });
        const [feature] = buildLineFeatures([state(track)], () => true).features;
        expect(feature.properties).toEqual({
            trackId: 'track-9',
            name: 'Ride',
            color: '#30a8e0',
            done: true,
            pointCount: 2,
        });
    });

    it('omits hidden tracks', () => {
        const fc = buildLineFeatures(
            [
                state(makeTrack({ name: 'Shown' })),
                state(makeTrack({ name: 'Hidden' }), { visible: false }),
            ],
            noneDone,
        );
        expect(fc.features.map((f) => f.properties.name)).toEqual(['Shown']);
    });

    it('returns an empty collection for no tracks', () => {
        expect(buildLineFeatures([], noneDone).features).toEqual([]);
    });

    it('asks the predicate about each visible track', () => {
        const a = makeTrack({ id: 'a' });
        const b = makeTrack({ id: 'b' });
        const asked: string[] = [];
        buildLineFeatures([state(a), state(b)], (track) => {
            asked.push(track.id);
            return false;
        });
        expect(asked).toEqual(['a', 'b']);
    });

    it('takes done from the predicate rather than the track state', () => {
        // Whether a line reads as travelled depends on the playhead, not on the
        // file, so the store does not carry the flag.
        const track = makeTrack({ id: 'a' });
        expect(buildLineFeatures([state(track)], noneDone).features[0].properties.done).toBe(false);
        expect(buildLineFeatures([state(track)], () => true).features[0].properties.done).toBe(
            true,
        );
    });
});
