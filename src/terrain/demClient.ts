import { coverageFor, decodeTerrarium, key, sampleTrack, TILE_SIZE } from './elevation';
import type { DecodedTile, TileId } from './elevation';
import type { Track } from '../types';

/**
 * Fetching and decoding Terrarium elevation tiles.
 *
 * This is the half of the model that needs a browser: it makes network requests
 * and turns PNGs into numbers. The arithmetic it hands to is all in
 * `elevation.ts`, which is why that file has no `fetch` in it and can be tested
 * without either.
 *
 * The host is a public bucket of raster terrain tiles, the same encoding
 * MapLibre's own terrain sources use, so there is no key to hold and no account
 * to make. It is asked for a handful of tiles per track and nothing else: the
 * requests reveal roughly which valley a ride was in, which is the cost of this
 * feature and the reason it is called out in the README.
 */

const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

/** How many tile fetches are in flight at once. */
const CONCURRENCY = 6;

/**
 * Decoded tiles kept at once. Each is 256x256 floats, about 256 kB, so this is
 * roughly 16 MB. Tracks loaded side by side share tiles, and a rider comparing
 * the same route twice is exactly the case where sharing pays.
 */
const CACHE_LIMIT = 64;

export interface TerrainSource {
    /**
     * Elevations for a track, sampled from the model, or null if the model could
     * not be reached. Null rather than a partial answer: a profile drawn from
     * three of sixteen tiles is a profile of a guess.
     */
    load: (track: Track) => Promise<Float32Array | null>;
    /** Tiles fetched and held, so a test can tell a cache from a coincidence. */
    cached: () => number;
}

export interface TerrainOptions {
    /** Overridable so the E2E suite can point at a stub or block the host. */
    url?: (id: TileId) => string;
    fetchTile?: (id: TileId) => Promise<DecodedTile | null>;
}

/** Where a tile's bytes come from, unless the caller says otherwise. */
const defaultUrl = (id: TileId): string => `${TILE_URL}/${id.z}/${id.x}/${id.y}.png`;

/**
 * Decode one tile's PNG into elevations.
 *
 * A tile is decoded by the browser rather than by a PNG decoder in the app: the
 * image is already the right size and the pixels are one `getImageData` away, so
 * the only question is which API to ask. `createImageBitmap` is used in
 * preference to an `<img>` so nothing has to be in the document, and the canvas
 * is released as soon as the numbers are out of it.
 */
const decodeTile = async (id: TileId, response: Response): Promise<DecodedTile | null> => {
    if (!response.ok) {
        return null;
    }
    const blob = await response.blob();
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(blob);
    } catch {
        return null;
    }
    try {
        const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
            return null;
        }
        ctx.drawImage(bitmap, 0, 0);
        const { data } = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
        const out = new Float32Array(TILE_SIZE * TILE_SIZE);
        for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
            // Terrarium can be RGB or RGBA depending on the encoder, so the blue
            // is read from a fixed offset rather than from an assumed stride.
            const b = data[p + 2];
            out[i] = decodeTerrarium(data[p], data[p + 1], b);
        }
        return { id, elevations: out };
    } finally {
        bitmap.close();
    }
};

export function createTerrainSource(options: TerrainOptions = {}): TerrainSource {
    const url = options.url ?? defaultUrl;
    const cache = new Map<string, DecodedTile>();
    const inFlight = new Map<string, Promise<DecodedTile | null>>();

    const remember = (tile: DecodedTile): void => {
        // Re-inserted so a frequently read tile moves to the end and is the first
        // to be dropped.
        cache.delete(key(tile.id));
        cache.set(key(tile.id), tile);
        while (cache.size > CACHE_LIMIT) {
            const oldest = cache.keys().next();
            if (oldest.done) {
                break;
            }
            cache.delete(oldest.value);
        }
    };

    const fetchOne = async (id: TileId): Promise<DecodedTile | null> => {
        const cachedTile = cache.get(key(id));
        if (cachedTile) {
            remember(cachedTile);
            return cachedTile;
        }
        const running = inFlight.get(key(id));
        if (running) {
            return running;
        }
        const request = (async (): Promise<DecodedTile | null> => {
            try {
                // The injected fetcher is inside the same guard as the real one, so
                // a caller that supplies a failing fetcher gets the same "no
                // model" answer rather than a rejection escaping into whoever
                // loaded the file.
                const tile = options.fetchTile
                    ? await options.fetchTile(id)
                    : await decodeTile(id, await fetch(url(id)));
                if (tile) {
                    remember(tile);
                }
                return tile;
            } catch {
                // A blocked request, an offline browser, a host that is down. The
                // caller falls back to the recorded altitude, so there is nothing
                // to report and nothing to retry here.
                return null;
            }
        })().finally(() => {
            inFlight.delete(key(id));
        });
        inFlight.set(key(id), request);
        return request;
    };

    /** Fetch a list of tiles a few at a time, so one track cannot flood the host. */
    const fetchAll = async (ids: TileId[]): Promise<DecodedTile[]> => {
        const out: DecodedTile[] = [];
        let next = 0;
        const worker = async (): Promise<void> => {
            for (;;) {
                const index = next;
                next += 1;
                if (index >= ids.length) {
                    return;
                }
                const tile = await fetchOne(ids[index]);
                if (tile) {
                    out.push(tile);
                }
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, Math.max(1, ids.length)) }, worker),
        );
        return out;
    };

    const load = async (track: Track): Promise<Float32Array | null> => {
        const coverage = coverageFor(track.lat, track.lon);
        if (!coverage || coverage.tiles.length === 0) {
            return null;
        }
        const tiles = await fetchAll(coverage.tiles);
        if (tiles.length === 0) {
            return null;
        }
        const byKey = new Map(tiles.map((tile) => [key(tile.id), tile]));
        const { ele, answered } = sampleTrack(
            track.lat,
            track.lon,
            track.ele,
            byKey,
            coverage.zoom,
        );
        // A model that answered nothing is a failure, not a track of zeroes: it
        // happens over water and in the seams between datasets, and drawing the
        // recorded altitude under the pretence it came from the model would be
        // the one lie this fallback must not tell.
        let useful = 0;
        for (const answer of answered) {
            useful += answer;
        }
        return useful === 0 ? null : ele;
    };

    return { load, cached: () => cache.size };
}
