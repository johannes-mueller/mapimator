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

    describe('replacing elevations from an elevation model', () => {
        it('swaps the elevations and keeps everything else', () => {
            const store = createTrackStore();
            const [a] = store.add([makeParsed('A')]);
            const before = store.getById(a.id)!.track;
            const ele = Float32Array.from([412, 430]);
            expect(store.updateElevation(a.id, ele)).toBe(true);
            const after = store.getById(a.id)!.track;
            expect(Array.from(after.ele)).toEqual([412, 430]);
            expect(after.ele).toBe(ele);
            expect(after.id).toBe(before.id);
            expect(after.name).toBe('A');
            expect(after.color).toBe(before.color);
            expect(after.lat).toBe(before.lat);
            expect(after.lon).toBe(before.lon);
            expect(after.tRel).toBe(before.tRel);
            expect(after.dist).toBe(before.dist);
        });

        it('keeps whether a track is shown', () => {
            // A model arriving must not switch a hidden ride back on, or a rider
            // who muted a track to compare two others gets it back unasked.
            const store = createTrackStore();
            const [a] = store.add([makeParsed('A')]);
            store.updateElevation(a.id, Float32Array.from([1]));
            // Hiding is a store concern elsewhere; the state object is what carries
            // it, so check the flag survives the replacement.
            const state = store.getById(a.id)!;
            expect(state.visible).toBe(true);
        });

        it('leaves the other tracks alone', () => {
            const store = createTrackStore();
            const [a, b] = store.add([makeParsed('A'), makeParsed('B')]);
            store.updateElevation(a.id, Float32Array.from([999]));
            expect(Array.from(store.getById(b.id)!.track.ele)).toEqual([0]);
            expect(store.getById(b.id)!.track.name).toBe('B');
        });

        it('says no for a track that is no longer there', () => {
            // The normal answer when a model arrives after the file was removed.
            const store = createTrackStore();
            expect(store.updateElevation('track-99', new Float32Array([1]))).toBe(false);
        });

        it('notifies, because the chart has to redraw', () => {
            const store = createTrackStore();
            const [a] = store.add([makeParsed('A')]);
            const listener = vi.fn();
            store.subscribe(listener);
            listener.mockClear();
            store.updateElevation(a.id, Float32Array.from([412]));
            expect(listener).toHaveBeenCalledTimes(1);
        });
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

    describe('hiding a run', () => {
        const twoRuns = () => {
            const store = createTrackStore();
            store.add([makeParsed('A'), makeParsed('B')]);
            return store;
        };
        const visibility = (store: ReturnType<typeof createTrackStore>) =>
            store.getAll().map((state) => state.visible);

        it('hides one run and leaves the others alone', () => {
            const store = twoRuns();
            expect(store.setVisible(store.getAll()[0].track.id, false)).toBe(true);
            expect(visibility(store)).toEqual([false, true]);
        });

        it('brings a hidden run back', () => {
            const store = twoRuns();
            const [first] = store.getAll();
            store.setVisible(first.track.id, false);
            expect(store.setVisible(first.track.id, true)).toBe(true);
            expect(visibility(store)).toEqual([true, true]);
        });

        it('keeps a hidden run in the store, with its data intact', () => {
            // Hiding is about what is drawn. A run that left the store would take
            // its duration with it and shorten the run, which is the one thing
            // this deliberately does not do.
            const store = twoRuns();
            const [first] = store.getAll();
            store.setVisible(first.track.id, false);
            expect(store.getAll()).toHaveLength(2);
            expect(store.getById(first.track.id)?.track).toEqual(first.track);
        });

        it('leaves the run as long as the longest run in the store', () => {
            const store = createTrackStore();
            store.add([makeParsed('short', { durationMs: 1000 })]);
            store.add([makeParsed('long', { durationMs: 9000 })]);
            const longest = store
                .getAll()
                .reduce((a, b) => (a.track.durationMs >= b.track.durationMs ? a : b));
            store.setVisible(longest.track.id, false);
            expect(Math.max(...store.getAll().map((s) => s.track.durationMs))).toBe(9000);
        });

        it('does nothing for a run that is not there', () => {
            const store = twoRuns();
            const listener = vi.fn();
            store.subscribe(listener);
            expect(store.setVisible('track-999', false)).toBe(false);
            expect(visibility(store)).toEqual([true, true]);
            expect(listener).not.toHaveBeenCalled();
        });

        it('does not notify when a run is already how it was asked to be', () => {
            // Every notify rebuilds the legend rows, and the legend goes out of
            // its way to write them in place, so a notify that changed nothing
            // would undo the one thing it was built to avoid.
            const store = twoRuns();
            const listener = vi.fn();
            store.subscribe(listener);
            expect(store.setVisible(store.getAll()[0].track.id, true)).toBe(false);
            expect(store.setVisible(store.getAll()[0].track.id, false)).toBe(true);
            expect(store.setVisible(store.getAll()[0].track.id, false)).toBe(false);
            expect(listener).toHaveBeenCalledTimes(1);
        });

        it('can still remove a run that is hidden', () => {
            const store = twoRuns();
            const [first] = store.getAll();
            store.setVisible(first.track.id, false);
            store.remove(first.track.id);
            expect(store.getAll()).toHaveLength(1);
            expect(store.getAll()[0].track.name).toBe('B');
        });

        it('notifies once per real change', () => {
            const store = twoRuns();
            const listener = vi.fn();
            store.subscribe(listener);
            const [first, second] = store.getAll();
            store.setVisible(first.track.id, false);
            store.setVisible(second.track.id, false);
            expect(listener).toHaveBeenCalledTimes(2);
        });
    });
});
