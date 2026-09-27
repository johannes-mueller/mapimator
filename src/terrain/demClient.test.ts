import { describe, expect, it, vi } from 'vitest';
import { createTerrainSource } from './demClient';
import { TILE_SIZE, coverageFor, key, tileAt, tileCount } from './elevation';
import type { TileId } from './elevation';
import type { Track } from '../types';

/** A tile of one constant value. */
const flatTile = (id: TileId, metres: number) => ({
    id,
    elevations: Float32Array.from({ length: TILE_SIZE * TILE_SIZE }, () => metres),
});

const trackAt = (lat: number, lon: number, ele: number[]): Track =>
    ({
        id: 't',
        name: 't',
        color: '#f00',
        t0: 0,
        tRel: Float64Array.from(ele.map((_, i) => i)),
        lat: Float64Array.from(ele.map(() => lat)),
        lon: Float64Array.from(ele.map(() => lon)),
        ele: Float32Array.from(ele),
        dist: Float32Array.from(ele.map((_, i) => i)),
        segmentBreaks: new Uint32Array(0),
        durationMs: 1000,
        distanceM: 1,
        bounds: { minLon: lon, minLat: lat, maxLon: lon, maxLat: lat },
        renderLine: [],
    }) as Track;

describe('createTerrainSource', () => {
    it('samples a track from the model', async () => {
        const lat = 46;
        const lon = 7;
        const id = tileAt(lat, lon, 14);
        const source = createTerrainSource({
            fetchTile: async () => flatTile(id, 412),
        });
        const ele = await source.load(trackAt(lat, lon, [999, 999]));
        expect(ele).not.toBeNull();
        expect(ele?.[0]).toBeCloseTo(412, 3);
        expect(ele?.[1]).toBeCloseTo(412, 3);
    });

    it('asks for one tile for a short track, not the whole world', async () => {
        const asked: TileId[] = [];
        const source = createTerrainSource({
            fetchTile: async (id) => {
                asked.push(id);
                return flatTile(id, 100);
            },
        });
        await source.load(trackAt(46, 7, [1, 2, 3]));
        expect(asked.length).toBe(1);
    });

    it('fetches each tile once and reuses it for the next track', async () => {
        const lat = 46;
        const lon = 7;
        const fetchTile = vi.fn(async (tile: TileId) => flatTile(tile, 412));
        const source = createTerrainSource({ fetchTile });
        const first = await source.load(trackAt(lat, lon, [1]));
        const second = await source.load(trackAt(lat, lon, [1]));
        // The same route twice is the case this app exists for, so the second
        // lookup must not go back to the network for ground it already has.
        expect(fetchTile).toHaveBeenCalledTimes(1);
        expect(source.cached()).toBe(1);
        expect(Array.from(second ?? [])).toEqual(Array.from(first ?? []));
    });

    it('asks once for a tile two tracks want at the same time', async () => {
        const id = tileAt(46, 7, 14);
        let resolve: (tile: ReturnType<typeof flatTile>) => void = () => {};
        const fetchTile = vi.fn(
            () =>
                new Promise<ReturnType<typeof flatTile>>((r) => {
                    resolve = r;
                }),
        );
        const source = createTerrainSource({ fetchTile });
        const a = source.load(trackAt(46, 7, [1]));
        const b = source.load(trackAt(46, 7, [2]));
        resolve(flatTile(id, 300));
        await Promise.all([a, b]);
        expect(fetchTile).toHaveBeenCalledTimes(1);
    });

    it('returns nothing when the host cannot be reached', async () => {
        // Offline, blocked, or down. The chart then draws what was recorded, and
        // the app carries on as if this feature were never switched on.
        const source = createTerrainSource({
            fetchTile: async () => {
                throw new Error('network down');
            },
        });
        await expect(source.load(trackAt(46, 7, [1, 2]))).resolves.toBeNull();
    });

    it('returns nothing when every tile comes back empty', async () => {
        const source = createTerrainSource({ fetchTile: async () => null });
        await expect(source.load(trackAt(46, 7, [1, 2]))).resolves.toBeNull();
    });

    it('returns nothing when the model is reached but has no reading', async () => {
        // Over water, or in a seam between datasets: the tiles arrive and say
        // nothing, which is not the same as a track of zeroes.
        const source = createTerrainSource({
            fetchTile: async (id) => flatTile(id, -32768),
        });
        await expect(source.load(trackAt(46, 7, [1, 2]))).resolves.toBeNull();
    });

    it('returns nothing for a track with no positions to cover', async () => {
        const source = createTerrainSource({ fetchTile: async (id) => flatTile(id, 1) });
        const empty = { ...trackAt(46, 7, []), ele: new Float32Array(0) } as Track;
        await expect(source.load(empty)).resolves.toBeNull();
    });

    it('keeps the recorded altitude for a point whose tile did not arrive', async () => {
        // A partial model still beats nothing, and the samples it cannot answer
        // keep what the watch recorded rather than becoming a gap in the profile.
        // Only the tile holding the first point is answered; the tile holding the
        // second is not. The zoom is the one the client picks, not a hard-coded
        // one: half a degree of longitude needs more tiles at z14 than the budget
        // allows, so the client drops to a coarser zoom and asks about that.
        const lat = Float64Array.from([46, 46]);
        const lon = Float64Array.from([7, 7.5]);
        const coverage = coverageFor(lat, lon);
        const answered = tileAt(46, 7, coverage?.zoom ?? 0);
        const source = createTerrainSource({
            fetchTile: async (id) => (id.x === answered.x ? flatTile(id, 500) : null),
        });
        const track = { ...trackAt(46, 7, [1, 2]), lat, lon } as Track;
        const ele = await source.load(track);
        expect(ele).not.toBeNull();
        expect(ele?.[0]).toBeCloseTo(500, 3);
        expect(ele?.[1]).toBe(2);
    });

    it('fetches no more tiles than a track needs', async () => {
        let peak = 0;
        let running = 0;
        const source = createTerrainSource({
            fetchTile: async (id) => {
                running += 1;
                peak = Math.max(peak, running);
                await new Promise((r) => setTimeout(r, 1));
                running -= 1;
                return flatTile(id, 100);
            },
        });
        // A track long enough to need several tiles.
        const lat = Float64Array.from([40, 42, 44]);
        const lon = Float64Array.from([5, 7, 9]);
        await source.load({
            ...trackAt(40, 5, [1, 2, 3]),
            lat,
            lon,
            bounds: { minLon: 5, minLat: 40, maxLon: 9, maxLat: 44 },
        } as Track);
        expect(peak).toBeGreaterThan(0);
        expect(peak).toBeLessThanOrEqual(6);
    });

    it('holds a bounded number of decoded tiles', async () => {
        // Each tile is a quarter of a megabyte of floats, so the cache has to be
        // capped or a long session with many tracks grows without limit.
        const source = createTerrainSource({
            fetchTile: async (id) => flatTile(id, 100),
        });
        for (let i = 0; i < 12; i += 1) {
            await source.load(trackAt(-80 + i, -170 + i * 3, [1, 2]));
        }
        expect(source.cached()).toBeLessThanOrEqual(64);
    });

    it('keys its cache by zoom as well as column and row', () => {
        // The same column and row at two zooms are different tiles of ground, so
        // a cache that ignored the zoom would serve the wrong elevation.
        expect(key({ z: 12, x: 5, y: 6 })).not.toBe(key({ z: 14, x: 5, y: 6 }));
    });
});

describe('the coverage a track asks for', () => {
    it('is one tile for a ride inside one tile', () => {
        expect(tileCount({ minLon: 7, minLat: 46, maxLon: 7.001, maxLat: 46.001 }, 14)).toBe(1);
    });
});
