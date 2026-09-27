import { describe, expect, it, vi } from 'vitest';
import { createTrackStore } from './trackStore';
import { TRACK_COLORS } from './palette';
import type { ParsedTrack } from '../gpx/parseGpx';

const makeParsed = (name: string, over: Partial<ParsedTrack> = {}): ParsedTrack => ({
    name,
    t0: 0,
    tRel: new Float64Array([0]),
    lat: new Float64Array([47]),
    lon: new Float64Array([8]),
    ele: new Float32Array([0]),
    dist: new Float32Array([0]),
    segmentBreaks: new Uint32Array([]),
    durationMs: 0,
    distanceM: 0,
    bounds: { minLon: 8, minLat: 47, maxLon: 8, maxLat: 47 },
    renderLine: [8, 47],
    ...over,
});

describe('createTrackStore', () => {
    it('starts empty', () => {
        const store = createTrackStore();
        expect(store.getAll()).toEqual([]);
        expect(store.getCombinedBounds()).toBeNull();
    });

    it('assigns unique ids, colours, and visible state on add', () => {
        const store = createTrackStore();
        const [a, b] = store.add([makeParsed('A'), makeParsed('B')]);

        expect(a.id).not.toBe(b.id);
        expect(a.color).not.toBe(b.color);
        expect(store.getAll().map((s) => s.visible)).toEqual([true, true]);
        expect(store.getAll().map((s) => s.done)).toEqual([false, false]);
    });

    it('keeps ids unique across separate add calls', () => {
        const store = createTrackStore();
        store.add([makeParsed('A')]);
        const [c] = store.add([makeParsed('B')]);
        expect(c.id).not.toBe('track-1');
    });

    it('continues the palette across calls instead of restarting it', () => {
        const store = createTrackStore();
        const [a] = store.add([makeParsed('A')]);
        const [b] = store.add([makeParsed('B')]);
        expect(b.color).toBe(TRACK_COLORS[1]);
        expect(a.color).toBe(TRACK_COLORS[0]);
    });

    it('wraps the palette rather than running out of colours', () => {
        const store = createTrackStore();
        const many = store.add(
            Array.from({ length: TRACK_COLORS.length + 2 }, (_, i) => makeParsed(`T${i}`)),
        );
        expect(many[TRACK_COLORS.length].color).toBe(TRACK_COLORS[0]);
        expect(new Set(many.map((t) => t.color)).size).toBe(TRACK_COLORS.length);
    });

    it('removes by id and leaves the rest in order', () => {
        const store = createTrackStore();
        const [a, b, c] = store.add([makeParsed('A'), makeParsed('B'), makeParsed('C')]);
        store.remove(b.id);
        expect(store.getAll().map((s) => s.track.id)).toEqual([a.id, c.id]);
    });

    it('ignores a remove for an unknown id', () => {
        const store = createTrackStore();
        store.add([makeParsed('A')]);
        store.remove('nope');
        expect(store.getAll()).toHaveLength(1);
    });

    it('clears everything', () => {
        const store = createTrackStore();
        store.add([makeParsed('A'), makeParsed('B')]);
        store.clear();
        expect(store.getAll()).toEqual([]);
    });

    it('unions bounds across all tracks', () => {
        const store = createTrackStore();
        store.add([
            makeParsed('A', { bounds: { minLon: 1, minLat: 2, maxLon: 3, maxLat: 4 } }),
            makeParsed('B', { bounds: { minLon: -5, minLat: 0, maxLon: 10, maxLat: 6 } }),
        ]);
        expect(store.getCombinedBounds()).toEqual({
            minLon: -5,
            minLat: 0,
            maxLon: 10,
            maxLat: 6,
        });
    });

    it('looks a track up by id', () => {
        const store = createTrackStore();
        const [a] = store.add([makeParsed('A')]);
        expect(store.getById(a.id)?.track.name).toBe('A');
        expect(store.getById('missing')).toBeUndefined();
    });

    describe('subscriptions', () => {
        it('notifies on add, remove, and clear', () => {
            const store = createTrackStore();
            const listener = vi.fn();
            store.subscribe(listener);

            const [a] = store.add([makeParsed('A')]);
            expect(listener).toHaveBeenCalledTimes(1);

            store.remove(a.id);
            expect(listener).toHaveBeenCalledTimes(2);

            store.add([makeParsed('B')]);
            store.clear();
            expect(listener).toHaveBeenCalledTimes(4);
        });

        it('stays silent when nothing actually changed', () => {
            const store = createTrackStore();
            const listener = vi.fn();
            store.subscribe(listener);

            store.remove('nope');
            store.clear();
            store.add([]);
            expect(listener).not.toHaveBeenCalled();
        });

        it('stops notifying after unsubscribe', () => {
            const store = createTrackStore();
            const listener = vi.fn();
            const off = store.subscribe(listener);
            off();
            store.add([makeParsed('A')]);
            expect(listener).not.toHaveBeenCalled();
        });

        it('sees current state when it fires', () => {
            const store = createTrackStore();
            const seen: number[] = [];
            store.subscribe(() => seen.push(store.getAll().length));
            store.add([makeParsed('A'), makeParsed('B')]);
            store.remove(store.getAll()[0].track.id);
            expect(seen).toEqual([2, 1]);
        });
    });
});
