import { describe, expect, it } from 'vitest';
import { buildMarkerFeatures } from './markerFeatures';
import type { Track, TrackState } from '../types';

const S = 1000;
const H = 3_600_000;

const makeTrack = (
    id: string,
    t0: number,
    timesMs: number[],
    coords: [number, number][],
    extra: { segmentBreaks?: number[]; color?: string; name?: string } = {},
): Track =>
    ({
        id,
        name: extra.name ?? id,
        color: extra.color ?? '#ff0000',
        t0,
        tRel: Float64Array.from(timesMs.map((ms) => ms / S)),
        lat: Float64Array.from(coords.map(([, lat]) => lat)),
        lon: Float64Array.from(coords.map(([lon]) => lon)),
        ele: new Float32Array(timesMs.length),
        dist: new Float32Array(timesMs.length),
        segmentBreaks: new Uint32Array(extra.segmentBreaks ?? []),
        durationMs: timesMs[timesMs.length - 1] ?? 0,
        distanceM: 0,
        bounds: { minLon: 0, minLat: 0, maxLon: 0, maxLat: 0 },
        renderLine: [],
    }) as Track;

const visible = (track: Track): TrackState => ({ track, visible: true });

const twoPoints = (id: string, t0: number, from: [number, number], to: [number, number]): Track =>
    makeTrack(id, t0, [0, 10 * S], [from, to]);

describe('buildMarkerFeatures', () => {
    it('is an empty collection for no tracks', () => {
        expect(buildMarkerFeatures([], 0)).toEqual({
            type: 'FeatureCollection',
            features: [],
        });
    });

    it('builds one point feature per visible started track', () => {
        const track = twoPoints('a', 0, [1, 47], [2, 47]);
        const { features } = buildMarkerFeatures([visible(track)], 0);
        expect(features).toHaveLength(1);
        expect(features[0].geometry.type).toBe('Point');
    });

    it('orders coordinates longitude first', () => {
        // A transposed pair still renders a marker, just in the wrong
        // hemisphere, so the order has to be asserted directly.
        const track = twoPoints('a', 0, [8.54, 47.37], [8.55, 47.38]);
        const { features } = buildMarkerFeatures([visible(track)], 0);
        const coordinates = features[0].geometry.coordinates;
        expect(coordinates[0]).toBeCloseTo(8.54, 12);
        expect(coordinates[1]).toBeCloseTo(47.37, 12);
    });

    it('keeps a later-recorded track from the first frame', () => {
        // No track is ever "not started": a ride recorded two hours later still
        // has a marker on its own first point at elapsed zero.
        const early = twoPoints('early', 0, [1, 47], [2, 47]);
        const late = twoPoints('late', 2 * H, [3, 47], [4, 47]);
        const { features } = buildMarkerFeatures([visible(early), visible(late)], 0);
        expect(features.map((f) => f.properties.trackId)).toEqual(['early', 'late']);
    });

    it('omits a hidden track even when it is running', () => {
        const track = twoPoints('a', 0, [1, 47], [2, 47]);
        const { features } = buildMarkerFeatures([{ track, visible: false }], 0);
        expect(features).toEqual([]);
    });

    it('keeps a finished track on its last point', () => {
        const track = makeTrack(
            'a',
            0,
            [0, 10 * S, 20 * S],
            [
                [1, 47],
                [2, 47],
                [3, 47],
            ],
        );
        const { features } = buildMarkerFeatures([visible(track)], 20 * S);
        expect(features).toHaveLength(1);
        expect(features[0].properties.status).toBe('done');
        expect(features[0].properties.done).toBe(true);
        expect(features[0].geometry.coordinates[0]).toBeCloseTo(3, 12);
    });

    it('carries the colour, name and progress the layer styles need', () => {
        const track = makeTrack(
            'a',
            0,
            [0, 10 * S, 20 * S],
            [
                [1, 47],
                [2, 47],
                [3, 47],
            ],
        );
        const { features } = buildMarkerFeatures([visible(track)], 10 * S);
        const properties = features[0].properties;
        expect(properties.trackId).toBe('a');
        expect(properties.color).toBe('#ff0000');
        expect(properties.name).toBe('a');
        expect(properties.progress).toBeCloseTo(0.5, 12);
        expect(properties.status).toBe('running');
        expect(properties.done).toBe(false);
    });

    it('is not done while running, and done once past the end', () => {
        const track = makeTrack(
            'a',
            0,
            [0, 10 * S, 20 * S],
            [
                [1, 47],
                [2, 47],
                [3, 47],
            ],
        );
        expect(buildMarkerFeatures([visible(track)], 15 * S).features[0].properties.done).toBe(
            false,
        );
        expect(buildMarkerFeatures([visible(track)], 21 * S).features[0].properties.done).toBe(
            true,
        );
    });

    it('keeps the order of the tracks it was given', () => {
        const first = twoPoints('first', 0, [1, 47], [2, 47]);
        const second = twoPoints('second', 0, [3, 47], [4, 47]);
        const { features } = buildMarkerFeatures([visible(second), visible(first)], 0);
        expect(features.map((f) => f.properties.trackId)).toEqual(['second', 'first']);
    });

    it('places two simultaneous tracks at their own interpolated positions', () => {
        const a = twoPoints('a', 0, [1, 47], [2, 47]);
        const b = twoPoints('b', 0, [5, 48], [6, 48]);
        const { features } = buildMarkerFeatures([visible(a), visible(b)], 5 * S);
        expect(features).toHaveLength(2);
        expect(features[0].geometry.coordinates[0]).toBeCloseTo(1.5, 12);
        expect(features[1].geometry.coordinates[0]).toBeCloseTo(5.5, 12);
    });

    it('moves a later-recorded track in step with an earlier one', () => {
        const early = twoPoints('early', 0, [1, 47], [2, 47]);
        const late = twoPoints('late', 2 * H, [3, 47], [4, 47]);
        const positions = (elapsed: number) =>
            buildMarkerFeatures([visible(early), visible(late)], elapsed).features.map(
                (f) => f.geometry.coordinates,
            );
        // Both markers stand on their own first point at elapsed zero, and both
        // reach their own last point at their own ten seconds, not at the two
        // hours of t0 between them.
        expect(positions(0)).toEqual([
            [1, 47],
            [3, 47],
        ]);
        expect(positions(5 * S)).toEqual([
            [1.5, 47],
            [3.5, 47],
        ]);
        expect(positions(10 * S)).toEqual([
            [2, 47],
            [4, 47],
        ]);
    });

    it('holds a marker still through a recorded pause while progress advances', () => {
        const gappy = makeTrack(
            'g',
            0,
            [0, 10 * S, 10 * S + H, 10 * S + H + 10 * S],
            [
                [1, 47],
                [2, 47],
                [3, 47],
                [4, 47],
            ],
            { segmentBreaks: [2] },
        );
        const start = buildMarkerFeatures([visible(gappy)], 10 * S).features[0];
        const middle = buildMarkerFeatures([visible(gappy)], 10 * S + H / 2).features[0];
        expect(middle.properties.status).toBe('parked');
        expect(middle.geometry.coordinates).toEqual(start.geometry.coordinates);
        expect(middle.properties.progress).toBeGreaterThan(start.properties.progress);
    });

    it('is deterministic for the same input', () => {
        const track = makeTrack(
            'a',
            0,
            [0, 10 * S, 20 * S],
            [
                [1, 47],
                [2, 47],
                [3, 47],
            ],
        );
        const first = buildMarkerFeatures([visible(track)], 7 * S);
        const second = buildMarkerFeatures([visible(track)], 7 * S);
        expect(first).toEqual(second);
    });
});
