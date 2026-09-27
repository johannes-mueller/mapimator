import type { Bounds, Track } from '../types';

/**
 * Sampling a digital elevation model, as pure arithmetic.
 *
 * The app draws elevation from a DEM rather than from the recorded altitude,
 * because a watch's altitude is a noisy reading of the same ground: two runs of
 * one route come out tens of metres apart at every point, which makes the chart
 * useless for the one thing it is for, comparing two runs of a course. A DEM is
 * a function of position and nothing else, so the same coordinate always gives
 * the same number and two rides of one route lie on top of each other.
 *
 * The tiles are Terrarium rasters: 256x256 PNGs with elevation encoded in the
 * RGB triple, the encoding MapLibre's own terrain sources use. Nothing here
 * fetches anything or decodes a PNG, so all of it can be tested without a
 * browser or a network; `demClient.ts` fetches and decodes, and hands over plain
 * elevations.
 */

/** Terrarium tiles are 256x256 pixels. */
export const TILE_SIZE = 256;

/**
 * The deepest zoom fetched. The underlying data is a global DEM at roughly 30 m
 * spacing, and by z14 one pixel is about 7 m at mid latitudes, so anything
 * deeper reads the same ground more finely than it is known rather than learning
 * anything new. It costs tiles and buys nothing.
 */
export const MAX_ZOOM = 14;

/**
 * The most tiles one track may cost. A track that would need more is sampled at a
 * shallower zoom instead, which is why the zoom is chosen from the track's size
 * rather than fixed: a short ride is worth a precise tile, and a day-long one
 * would otherwise ask for a hundred requests to draw one line.
 */
export const TILE_BUDGET = 16;

/** Elevations are never below this, so the sentinel cannot be a real reading. */
const NO_DATA = -32768;

/** Longitude to a fractional tile column at a zoom. */
export const lonToTileX = (lon: number, zoom: number): number => ((lon + 180) / 360) * 2 ** zoom;

/** Latitude to a fractional tile row at a zoom. */
export const latToTileY = (lat: number, zoom: number): number => {
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const rad = (clamped * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** zoom;
};

/** A fractional tile column back to a longitude. */
export const tileXToLon = (x: number, zoom: number): number => (x / 2 ** zoom) * 360 - 180;

/** A fractional tile row back to a latitude. */
export const tileYToLat = (y: number, zoom: number): number =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** zoom))) * 180) / Math.PI;

export interface TileId {
    z: number;
    x: number;
    y: number;
}

/**
 * The tile containing a position, clamped to the world rather than wrapped.
 *
 * A position past a pole or past 180 degrees is a broken track, and wrapping it
 * to the far side of the planet would report a plausible elevation for a place
 * the ride was never at. Clamping fails visibly instead.
 */
export const tileAt = (lat: number, lon: number, zoom: number): TileId => {
    const limit = 2 ** zoom;
    return {
        z: zoom,
        x: Math.max(0, Math.min(limit - 1, Math.floor(lonToTileX(lon, zoom)))),
        y: Math.max(0, Math.min(limit - 1, Math.floor(latToTileY(lat, zoom)))),
    };
};

const boundsOf = (lat: Float64Array, lon: Float64Array): Bounds | null => {
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (let i = 0; i < lat.length; i += 1) {
        if (!Number.isFinite(lat[i]) || !Number.isFinite(lon[i])) {
            continue;
        }
        if (lat[i] < minLat) minLat = lat[i];
        if (lat[i] > maxLat) maxLat = lat[i];
        if (lon[i] < minLon) minLon = lon[i];
        if (lon[i] > maxLon) maxLon = lon[i];
    }
    if (minLat > maxLat) {
        return null;
    }
    return { minLat, maxLat, minLon, maxLon };
};

/** The inclusive tile range a box covers at a zoom. */
const tileRange = (bounds: Bounds, zoom: number): TileRange => {
    const limit = 2 ** zoom;
    return {
        x0: Math.max(0, Math.floor(lonToTileX(bounds.minLon, zoom))),
        x1: Math.max(0, Math.min(limit - 1, Math.floor(lonToTileX(bounds.maxLon, zoom)))),
        y0: Math.max(0, Math.floor(latToTileY(bounds.maxLat, zoom))),
        y1: Math.max(0, Math.min(limit - 1, Math.floor(latToTileY(bounds.minLat, zoom)))),
    };
};

interface TileRange {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
}

/**
 * How many tiles a box covers, counted rather than listed.
 *
 * Counted because the zoom search asks this question about boxes of every size,
 * including a track with a latitude past the pole, and listing the tiles of such a
 * box means building tens of millions of objects to throw away. The count is
 * exact and costs four subtractions.
 */
export const tileCount = (bounds: Bounds, zoom: number): number => {
    const { x0, x1, y0, y1 } = tileRange(bounds, zoom);
    return (x1 - x0 + 1) * (y1 - y0 + 1);
};

/**
 * Every tile covering a box, deduplicated, in row-major order.
 *
 * A one-point box is one tile, not the four its edges touch, and a box on a tile
 * boundary includes the tile on the far side of it: a track that runs along a
 * boundary has points in both, and reading the nearest-neighbour answer from
 * whichever tile was fetched first would make the profile depend on the order of
 * a Map.
 */
export const tilesForBounds = (bounds: Bounds, zoom: number): TileId[] => {
    const { x0, x1, y0, y1 } = tileRange(bounds, zoom);
    const tiles: TileId[] = [];
    for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
            tiles.push({ z: zoom, x, y });
        }
    }
    return tiles;
};

/**
 * The zoom a track is sampled at: the deepest one whose tiles still fit the
 * budget.
 *
 * Searched downwards rather than solved, because the number of tiles a box needs
 * is a count of integers on a tile grid and a closed form for it is a rounding
 * away from the truth at the boundary. MAX_ZOOM is fifteen steps down, so
 * searching costs nothing.
 *
 * The margin on the budget is the point. The zoom decides which tile a coordinate
 * is read from, so if two rides of one route could land either side of the line
 * between two zooms they would come back with slightly different elevations for
 * the same piece of road, which is the exact problem this is here to solve. With
 * a margin the answer changes when the route changes and not when the GPS wobbles.
 */
export const chooseZoom = (bounds: Bounds): number => {
    const affordable = TILE_BUDGET * 0.9;
    for (let zoom = MAX_ZOOM; zoom > 0; zoom -= 1) {
        if (tileCount(bounds, zoom) <= affordable) {
            return zoom;
        }
    }
    return 0;
};

/**
 * One Terrarium pixel in metres.
 *
 * Red and green carry the whole metres and blue carries 1/256 m of it, which is
 * far finer than the DEM is known to any useful accuracy. It is kept because it
 * costs nothing, and because discarding it would quantise every reading to a
 * whole metre.
 */
export const decodeTerrarium = (r: number, g: number, b: number): number =>
    r * 256 + g + b / 256 - 32768;

/** True for a pixel carrying no reading rather than a low one. */
export const isNoData = (metres: number): boolean => metres <= NO_DATA;

/**
 * A tile's elevations in metres, one per pixel, row-major from the top left. The
 * sentinel is left in place so the sampler can tell it from a real reading.
 */
export type TileElevations = Float32Array;

/** Where a position sits inside a tile, in pixels. */
export interface TilePosition {
    x: number;
    y: number;
}

/** A position's fractional pixel coordinates within the tile that contains it. */
export const pixelInTile = (lat: number, lon: number, tile: TileId): TilePosition => ({
    x: (lonToTileX(lon, tile.z) - tile.x) * TILE_SIZE,
    y: (latToTileY(lat, tile.z) - tile.y) * TILE_SIZE,
});

/**
 * A bilinear read of a tile, with the edges clamped.
 *
 * Bilinear rather than nearest, because the pixels sample a continuous surface
 * and a profile read by nearest pixels is a staircase: a steady climb comes out
 * as a row of flat shelves. The edges are clamped because the last pixel of a
 * tile is shared with the next tile over, so a rider a pixel from a boundary has
 * to get the same answer whichever tile is read.
 */
export const sampleTile = (elev: TileElevations, at: TilePosition): number => {
    const last = TILE_SIZE - 1;
    const x0 = Math.max(0, Math.min(last, Math.floor(at.x)));
    const y0 = Math.max(0, Math.min(last, Math.floor(at.y)));
    const x1 = Math.min(last, x0 + 1);
    const y1 = Math.min(last, y0 + 1);
    const tx = Math.max(0, Math.min(1, at.x - x0));
    const ty = Math.max(0, Math.min(1, at.y - y0));
    const at1 = (px: number, py: number): number => elev[py * TILE_SIZE + px];
    const top = at1(x0, y0) + (at1(x1, y0) - at1(x0, y0)) * tx;
    const bottom = at1(x0, y1) + (at1(x1, y1) - at1(x0, y1)) * tx;
    return top + (bottom - top) * ty;
};

/** The tiles one set of samples needs, and the zoom they are at. */
export interface Coverage {
    zoom: number;
    tiles: TileId[];
}

/** The zoom and tiles covering every sample, or null if there is nothing to cover. */
export const coverageFor = (lat: Float64Array, lon: Float64Array): Coverage | null => {
    const bounds = boundsOf(lat, lon);
    if (!bounds) {
        return null;
    }
    const zoom = chooseZoom(bounds);
    return { zoom, tiles: tilesForBounds(bounds, zoom) };
};

/** A tile the sampler can read: which tile it is, and its pixels. */
export interface DecodedTile {
    id: TileId;
    elevations: TileElevations;
}

/**
 * What the model had to say about a track.
 *
 * `answered` is one byte per sample and says whether `ele` came from the model or
 * is the recorded altitude put back. It cannot be worked out afterwards: a
 * fallback and a reading that happens to match it look identical in the numbers,
 * and the difference matters, because "the model was reached and answered
 * nothing" has to be able to fall back on the whole track rather than draw a
 * profile of a model that was never consulted.
 */
export interface Sampled {
    ele: Float32Array;
    answered: Uint8Array;
}

/**
 * Elevation for every sample, in the track's own order.
 *
 * A sample on a tile that was not fetched, or on a pixel with no reading in it,
 * keeps the elevation it arrived with. A DEM has holes — the sea floor is one,
 * and so is anywhere its source satellite saw nothing — and the recorded altitude
 * is a far better answer there than a sentinel drawn as if it were a measurement.
 */
export const sampleTrack = (
    lat: Float64Array,
    lon: Float64Array,
    recorded: Float32Array,
    tiles: ReadonlyMap<string, DecodedTile>,
    zoom: number,
): Sampled => {
    const ele = new Float32Array(lat.length);
    const answered = new Uint8Array(lat.length);
    for (let i = 0; i < lat.length; i += 1) {
        const fallback = Number.isFinite(recorded[i]) ? recorded[i] : 0;
        ele[i] = fallback;
        if (!Number.isFinite(lat[i]) || !Number.isFinite(lon[i])) {
            continue;
        }
        const tile = tiles.get(key(tileAt(lat[i], lon[i], zoom)));
        if (!tile) {
            continue;
        }
        const metres = sampleTile(tile.elevations, pixelInTile(lat[i], lon[i], tile.id));
        if (isNoData(metres)) {
            continue;
        }
        ele[i] = metres;
        answered[i] = 1;
    }
    return { ele, answered };
};

/** A tile's cache key. */
export const key = (id: TileId): string => `${id.z}/${id.x}/${id.y}`;

/**
 * The same track with its elevations replaced.
 *
 * A new object rather than a mutation, because the track on screen is the one the
 * chart is drawing, and swapping the array underneath it would leave anything
 * holding the track disagreeing with the store about what the ground does there.
 * Every other field is carried over by reference, so a 60,000-point track costs
 * one new array and no copying.
 */
export const withElevation = (track: Track, ele: Float32Array): Track => ({
    ...track,
    ele,
});
