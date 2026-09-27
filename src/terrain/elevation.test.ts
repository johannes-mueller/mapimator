import { describe, expect, it } from 'vitest';
import {
    MAX_ZOOM,
    TILE_BUDGET,
    TILE_SIZE,
    chooseZoom,
    coverageFor,
    decodeTerrarium,
    isNoData,
    key,
    latToTileY,
    lonToTileX,
    pixelInTile,
    sampleTile,
    sampleTrack,
    tileAt,
    tileCount,
    tileXToLon,
    tileYToLat,
    tilesForBounds,
    withElevation,
} from './elevation';
import type { DecodedTile, TileElevations } from './elevation';
import type { Bounds, Track } from '../types';

/** A box, with the fields in the order the app declares them. */
const box = (minLon: number, minLat: number, maxLon: number, maxLat: number): Bounds => ({
    minLon,
    minLat,
    maxLon,
    maxLat,
});

/** A tile of one constant value, for reading a known answer out of. */
const flatTile = (metres: number): TileElevations => {
    const out = new Float32Array(TILE_SIZE * TILE_SIZE);
    out.fill(metres);
    return out;
};

/** A tile whose value is its own pixel index, for testing the interpolation. */
const rampTile = (): TileElevations => {
    const out = new Float32Array(TILE_SIZE * TILE_SIZE);
    for (let i = 0; i < out.length; i += 1) {
        out[i] = i;
    }
    return out;
};

const track = (eleM: number[]): Track =>
    ({
        id: 't',
        name: 't',
        color: '#f00',
        t0: 0,
        tRel: Float64Array.from([0, 1]),
        lat: new Float64Array(2),
        lon: new Float64Array(2),
        ele: Float32Array.from(eleM),
        dist: Float32Array.from([0, 1]),
        segmentBreaks: new Uint32Array(0),
        durationMs: 1000,
        distanceM: 1,
        bounds: box(0, 0, 0, 0),
        renderLine: [],
    }) as Track;

describe('tile addressing', () => {
    it('puts longitude 0 at the middle of the world', () => {
        expect(lonToTileX(0, 1)).toBe(1);
        expect(lonToTileX(-180, 0)).toBe(0);
        expect(lonToTileX(180, 0)).toBe(1);
    });

    it('puts latitude 0 at the middle row and grows away from it', () => {
        expect(latToTileY(0, 1)).toBe(1);
        expect(latToTileY(45, 4)).toBeLessThan(latToTileY(0, 4));
        expect(latToTileY(-45, 4)).toBeGreaterThan(latToTileY(0, 4));
    });

    it('puts the origin on the boundary between four tiles, as it should be', () => {
        // 0,0 is the one position whose tile index needs no arithmetic: half of
        // 2^12 in each direction at z12, and an exact multiple, so it lands on
        // the corner shared by four tiles rather than inside one.
        expect(lonToTileX(0, 12)).toBe(2048);
        expect(latToTileY(0, 12)).toBe(2048);
        expect(tileAt(0, 0, 12)).toEqual({ z: 12, x: 2048, y: 2048 });
        expect(tileAt(0, -0.001, 12).x).toBe(2047);
        // Zero is the *top* edge of row 2048, so a point just south of it is in
        // that same row and a point just north of it is in the row above.
        expect(tileAt(-0.001, 0, 12).y).toBe(2048);
        expect(tileAt(0.001, 0, 12).y).toBe(2047);
    });

    it('round-trips a tile centre back into the same tile', () => {
        // The centre of row 2048 is not latitude 0: zero is the row *boundary*,
        // so the centre sits a little south of it. What has to hold is that
        // going out to a tile and back lands on the same tile.
        const lat = tileYToLat(2048.5, 12);
        const lon = tileXToLon(2048.5, 12);
        expect(lat).toBeLessThan(0);
        expect(lon).toBeGreaterThan(0);
        expect(tileAt(lat, lon, 12)).toEqual({ z: 12, x: 2048, y: 2048 });
        // And the inverse of the forward function, for a point inside a tile.
        const inside = pixelInTile(lat, lon, { z: 12, x: 2048, y: 2048 });
        expect(inside.x).toBeCloseTo(128, 6);
        expect(inside.y).toBeCloseTo(128, 6);
    });

    it('puts a point just east and north of a tile edge in the next tile', () => {
        const edge = tileXToLon(2049, 12);
        expect(tileAt(0, edge - 0.001, 12).x).toBe(2048);
        expect(tileAt(0, edge + 0.001, 12).x).toBe(2049);
    });

    it('clamps a position past the edge of the world rather than wrapping it', () => {
        // 200 degrees east is a broken coordinate. Wrapping would put it on the
        // far side of the planet and report a plausible elevation for a place the
        // ride never went.
        expect(tileAt(0, 200, 4).x).toBe(15);
        expect(tileAt(0, -200, 4).x).toBe(0);
        expect(tileAt(89, 0, 4).y).toBe(0);
        expect(tileAt(-89, 0, 4).y).toBe(15);
    });
});

describe('choosing a zoom', () => {
    it('uses the deepest zoom for a track shorter than one tile', () => {
        // 200 m of road at z14 is a few pixels, so one tile covers it.
        expect(chooseZoom(box(0, 0, 0.002, 0.001))).toBe(MAX_ZOOM);
    });

    it('steps down as the track grows', () => {
        const zooms = [0.02, 0.2, 2, 20, 200].map((deg) =>
            chooseZoom(box(7.0, 46.0, 7.0 + deg, 46.0 + deg)),
        );
        for (let i = 1; i < zooms.length; i += 1) {
            expect(zooms[i]).toBeLessThanOrEqual(zooms[i - 1]);
        }
        expect(zooms[zooms.length - 1]).toBeLessThan(MAX_ZOOM);
    });

    it('never asks for more tiles than the budget, at any size', () => {
        for (const deg of [0.0001, 0.01, 0.1, 0.5, 1, 5, 20, 90, 180]) {
            const bounds = box(-40, -30, -40 + deg, -30 + deg);
            const zoom = chooseZoom(bounds);
            expect(tileCount(bounds, zoom)).toBeLessThanOrEqual(TILE_BUDGET);
        }
    });

    it('survives a track with a latitude past the pole', () => {
        // A broken coordinate must not take the app down. The count is exact and
        // the zoom falls to the top level, where the whole world is one tile.
        const broken = box(7, 46, 207, 246);
        const zoom = chooseZoom(broken);
        expect(tileCount(broken, zoom)).toBeLessThanOrEqual(TILE_BUDGET);
        expect(tileCount(broken, zoom)).toBeGreaterThan(0);
        expect(tilesForBounds(broken, zoom).length).toBe(tileCount(broken, zoom));
    });

    it('counts a box the same way it lists it', () => {
        for (const deg of [0.01, 0.5, 5]) {
            const bounds = box(-40, -30, -40 + deg, -30 + deg);
            for (const zoom of [4, 8, 12]) {
                expect(tileCount(bounds, zoom)).toBe(tilesForBounds(bounds, zoom).length);
            }
        }
    });

    it('gives two tracks a few metres apart the same zoom', () => {
        // The point of the choice being a smooth function: two rides of one route
        // must not be sampled at different zooms, or they come back with
        // different elevations and the comparison the chart exists for is lost.
        const a = chooseZoom(box(7.0, 46.0, 7.05, 46.02));
        const b = chooseZoom(box(7.00002, 46.00001, 7.05002, 46.02001));
        expect(b).toBe(a);
    });

    it('answers the deepest zoom for a track with no extent', () => {
        expect(chooseZoom(box(7.0, 46.0, 7.0, 46.0))).toBe(MAX_ZOOM);
    });
});

describe('choosing tiles', () => {
    it('is one tile for a track inside one tile', () => {
        // 0.05 to 0.30 degrees sits wholly inside tile 512/511 at z10: that tile
        // spans 0 to 0.3516 degrees in both directions.
        expect(tilesForBounds(box(0.05, 0.05, 0.3, 0.3), 10)).toEqual([{ z: 10, x: 512, y: 511 }]);
    });

    it('is two tiles for a track straddling the equator', () => {
        // The equator is a tile row boundary, so a track across it needs the row
        // above as well as the row below. Forgetting that is a profile drawn from
        // half its data.
        expect(tilesForBounds(box(0.05, -0.05, 0.3, 0.05), 10).map((t) => t.y)).toEqual([511, 512]);
    });

    it('includes the tile on the far side of a boundary', () => {
        // A track that runs along a tile edge has points in both tiles, and the
        // far one is the one that is easy to forget.
        const edge = tileXToLon(2049, 12);
        const tiles = tilesForBounds(box(edge - 0.01, 0.001, edge + 0.01, 0.05), 12);
        expect(tiles.map((t) => t.x)).toEqual([2048, 2049]);
    });

    it('lists each tile once, in row-major order', () => {
        const tiles = tilesForBounds(box(0.05, 0.05, 0.8, 0.05), 10);
        expect(new Set(tiles.map(key)).size).toBe(tiles.length);
        expect(tiles.every((t) => t.z === 10)).toBe(true);
        expect(tiles).toEqual([
            { z: 10, x: 512, y: 511 },
            { z: 10, x: 513, y: 511 },
            { z: 10, x: 514, y: 511 },
        ]);
    });

    it('reports no coverage for a track with no usable positions', () => {
        expect(coverageFor(new Float64Array(0), new Float64Array(0))).toBeNull();
        expect(coverageFor(Float64Array.from([NaN, 46]), Float64Array.from([7, NaN]))).toBeNull();
    });

    it('covers a track, and the coverage is what the zoom asked for', () => {
        const coverage = coverageFor(Float64Array.from([0, 0.01]), Float64Array.from([0, 0.01]));
        expect(coverage?.zoom).toBe(chooseZoom(box(0, 0, 0.01, 0.01)));
        expect(coverage?.tiles.length).toBeGreaterThan(0);
    });
});

describe('decoding a Terrarium pixel', () => {
    it('reads sea level as zero', () => {
        // 32768 is the offset: red 128 is 32768, which is exactly sea level.
        expect(decodeTerrarium(128, 0, 0)).toBe(0);
    });

    it('reads a whole metre from the red and green channels', () => {
        expect(decodeTerrarium(129, 0, 0)).toBe(256);
        expect(decodeTerrarium(128, 100, 0)).toBe(100);
    });

    it('reads the blue channel as a fraction of a metre', () => {
        expect(decodeTerrarium(128, 0, 128)).toBeCloseTo(0.5, 6);
    });

    it('reads bathymetry as negative', () => {
        expect(decodeTerrarium(127, 200, 0)).toBeLessThan(0);
    });

    it('knows the empty pixel from a deep one', () => {
        // Black is the fill for a pixel the source satellite saw nothing in, and
        // the deepest real reading is the Mariana Trench at about -11,000 m.
        expect(isNoData(decodeTerrarium(0, 0, 0))).toBe(true);
        expect(isNoData(decodeTerrarium(64, 0, 0))).toBe(false);
        expect(decodeTerrarium(0, 0, 0)).toBe(-32768);
    });
});

describe('sampling a tile', () => {
    it('reads a flat tile as itself', () => {
        expect(sampleTile(flatTile(412), { x: 10, y: 10 })).toBeCloseTo(412, 3);
        expect(sampleTile(flatTile(412), { x: 0, y: 0 })).toBeCloseTo(412, 3);
        expect(sampleTile(flatTile(412), { x: 255.9, y: 255.9 })).toBeCloseTo(412, 3);
    });

    it('reads a pixel centre as that pixel', () => {
        // A ramp tile's value at a pixel is that pixel's own index, so a ramp
        // rises 1 per column and 256 per row. Halfway along the first row is
        // therefore 2.5, and halfway down the first column is 128, not 0.5.
        expect(sampleTile(rampTile(), { x: 2.5, y: 0 })).toBeCloseTo(2.5, 3);
        expect(sampleTile(rampTile(), { x: 0, y: 0.5 })).toBeCloseTo(128, 3);
        expect(sampleTile(rampTile(), { x: 0, y: 1 })).toBeCloseTo(256, 3);
    });

    it('interpolates between neighbours rather than stepping', () => {
        // The reason this is bilinear and not nearest: a steady climb read by
        // nearest pixel is a staircase, and the staircase is visible on the chart.
        expect(sampleTile(rampTile(), { x: 4.25, y: 0 })).toBeCloseTo(4.25, 3);
    });

    it('clamps at the edges instead of reading past them', () => {
        const tile = rampTile();
        // Past the last pixel there is no neighbour, so the edge pixel answers.
        expect(sampleTile(tile, { x: 300, y: 0 })).toBeCloseTo(255, 3);
        expect(sampleTile(tile, { x: 0, y: -5 })).toBeCloseTo(0, 3);
    });

    it('puts a position inside its own tile at a pixel between 0 and 256', () => {
        const at = pixelInTile(-0.02, 0.02, { z: 12, x: 2048, y: 2048 });
        expect(at.x).toBeGreaterThanOrEqual(0);
        expect(at.x).toBeLessThan(TILE_SIZE);
        expect(at.y).toBeGreaterThanOrEqual(0);
        expect(at.y).toBeLessThan(TILE_SIZE);
        // Dead centre of the tile.
        expect(
            pixelInTile(tileYToLat(1442.5, 12), tileXToLon(2138.5, 12), {
                z: 12,
                x: 2138,
                y: 1442,
            }),
        ).toEqual({ x: 128, y: 128 });
    });
});

describe('sampling a track', () => {
    const tilesOf = (list: DecodedTile[]): Map<string, DecodedTile> =>
        new Map(list.map((t) => [key(t.id), t]));

    const tile = { z: 14, x: 8799, y: 5873 } as const;

    it('replaces the recorded elevation with the model', () => {
        const { ele, answered } = sampleTrack(
            Float64Array.from([tileYToLat(5873.5, 14)]),
            Float64Array.from([tileXToLon(8799.5, 14)]),
            Float32Array.from([9999]),
            tilesOf([{ id: tile, elevations: flatTile(412) }]),
            14,
        );
        expect(ele[0]).toBeCloseTo(412, 3);
        expect(answered[0]).toBe(1);
    });

    it('keeps the recorded elevation where the model has no tile', () => {
        const { ele, answered } = sampleTrack(
            Float64Array.from([tileYToLat(5873.5, 14)]),
            Float64Array.from([tileXToLon(8799.5, 14)]),
            Float32Array.from([730]),
            new Map(),
            14,
        );
        expect(ele[0]).toBe(730);
        // Which is the part that cannot be recovered from the numbers afterwards.
        expect(answered[0]).toBe(0);
    });

    it('keeps the recorded elevation on a pixel with no reading in it', () => {
        // A hole in the model must not become a drawn value: a sentinel plotted
        // as if it were a measurement is worse than the noisy reading it replaced.
        const out = sampleTrack(
            Float64Array.from([tileYToLat(5873.5, 14)]),
            Float64Array.from([tileXToLon(8799.5, 14)]),
            Float32Array.from([730]),
            tilesOf([{ id: tile, elevations: flatTile(-32768) }]),
            14,
        );
        expect(out.ele[0]).toBe(730);
        expect(out.answered[0]).toBe(0);
    });

    it('keeps the recorded elevation for a position that is not a number', () => {
        const out = sampleTrack(
            Float64Array.from([NaN]),
            Float64Array.from([7]),
            Float32Array.from([12]),
            tilesOf([{ id: tile, elevations: flatTile(412) }]),
            14,
        );
        expect(out.ele[0]).toBe(12);
        expect(out.answered[0]).toBe(0);
    });

    it('samples every point in the track, in the track order', () => {
        // Three points far enough apart to be in three different z14 tiles, with
        // only the middle tile fetched.
        const out = sampleTrack(
            Float64Array.from([46, 46, 46]),
            Float64Array.from([7, 7.5, 8]),
            Float32Array.from([1, 2, 3]),
            tilesOf([{ id: tileAt(46, 7.5, 14), elevations: rampTile() }]),
            14,
        );
        expect(out.ele).toHaveLength(3);
        // The outer two are on tiles that were not fetched, so they keep theirs.
        expect(out.ele[0]).toBe(1);
        expect(out.ele[2]).toBe(3);
        expect(out.answered[0]).toBe(0);
        expect(out.answered[2]).toBe(0);
        expect(Number.isFinite(out.ele[1])).toBe(true);
        expect(out.ele[1]).not.toBe(2);
        expect(out.answered[1]).toBe(1);
    });

    it('reports a model that answered nothing at all', () => {
        // Over water, or in the seam between two datasets. The caller has to be
        // able to tell this from a track that was sampled, or it draws the
        // recorded altitude as if the model had confirmed it.
        const out = sampleTrack(
            Float64Array.from([46, 46.001]),
            Float64Array.from([7, 7.001]),
            Float32Array.from([10, 20]),
            tilesOf([{ id: tileAt(46.0005, 7.0005, 14), elevations: flatTile(-32768) }]),
            14,
        );
        expect(Array.from(out.answered)).toEqual([0, 0]);
        expect(Array.from(out.ele)).toEqual([10, 20]);
    });

    it('reports a model that answered part of a track', () => {
        // Two points a tile apart, with one tile fetched: the answer is half
        // model and half recorded, and the caller can see which is which.
        const out = sampleTrack(
            Float64Array.from([46, 46]),
            Float64Array.from([7, 7.5]),
            Float32Array.from([10, 20]),
            tilesOf([{ id: tileAt(46, 7, 14), elevations: flatTile(400) }]),
            14,
        );
        expect(Array.from(out.answered)).toEqual([1, 0]);
        expect(out.ele[0]).toBeCloseTo(400, 3);
        expect(out.ele[1]).toBe(20);
    });

    it('reads the same coordinate to the same value twice', () => {
        // The property the whole feature rests on: the same ground gives the same
        // answer, so two runs of one route lie on top of each other.
        const args = [
            Float64Array.from([46.0004]),
            Float64Array.from([7.0004]),
            Float32Array.from([111]),
        ] as const;
        const built = tilesOf([{ id: tileAt(46.0004, 7.0004, 14), elevations: rampTile() }]);
        const first = sampleTrack(...args, built, 14);
        const second = sampleTrack(...args, built, 14);
        expect(first.ele[0]).toBe(second.ele[0]);
    });
});

describe('replacing a track elevation', () => {
    it('swaps the elevations and carries everything else by reference', () => {
        const original = track([100, 200]);
        const ele = Float32Array.from([412, 430]);
        const next = withElevation(original, ele);
        expect(next.ele).toBe(ele);
        expect(next.id).toBe(original.id);
        expect(next.name).toBe(original.name);
        expect(next.color).toBe(original.color);
        expect(next.lat).toBe(original.lat);
        expect(next.lon).toBe(original.lon);
        expect(next.tRel).toBe(original.tRel);
        expect(next.dist).toBe(original.dist);
        expect(next.segmentBreaks).toBe(original.segmentBreaks);
        expect(next.renderLine).toBe(original.renderLine);
        expect(next.bounds).toBe(original.bounds);
    });

    it('leaves the track it was given alone', () => {
        const original = track([100, 200]);
        withElevation(original, Float32Array.from([1, 2]));
        expect(Array.from(original.ele)).toEqual([100, 200]);
    });
});
