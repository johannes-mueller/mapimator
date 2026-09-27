import type { Feature, FeatureCollection, MultiLineString, Position } from 'geojson';
import type { Track, TrackState } from '../types';

/** Declared as a type, not an interface, so it stays assignable to GeoJSON's
 *  index-signature property bags without a cast. */
export type TrackLineProperties = {
    trackId: string;
    name: string;
    color: string;
    done: boolean;
    pointCount: number;
};

export type TrackLineFeature = Feature<MultiLineString, TrackLineProperties>;

/**
 * Splits a flat `[lon, lat, ...]` line into the runs separated by recorded
 * breaks, regrouped as GeoJSON positions. A `LineString` cannot express a gap,
 * so the result is a `MultiLineString` and the renderer leaves pauses blank
 * instead of drawing a straight line through them.
 *
 * This is the only place flat data is expanded into many small arrays, which is
 * part of why `Track.renderLine` stays flat: the typed arrays remain the
 * canonical store and only the geometry handed to MapLibre is copied.
 */
export function buildSegments(renderLine: number[], segmentBreaks: Uint32Array): Position[][] {
    const segments: Position[][] = [];

    const push = (from: number, to: number): void => {
        if (to - from < 4) {
            return;
        }
        const positions: Position[] = new Array((to - from) / 2);
        for (let offset = from, k = 0; offset < to; offset += 2, k += 1) {
            positions[k] = [renderLine[offset], renderLine[offset + 1]];
        }
        segments.push(positions);
    };

    let start = 0;
    for (const breakIndex of segmentBreaks) {
        const end = breakIndex * 2;
        if (end > start) {
            push(start, end);
        }
        start = end;
    }
    if (start < renderLine.length) {
        push(start, renderLine.length);
    }

    return segments;
}

function featureFor(track: Track, done: boolean): TrackLineFeature {
    return {
        type: 'Feature',
        properties: {
            trackId: track.id,
            name: track.name,
            color: track.color,
            done,
            pointCount: track.lat.length,
        },
        geometry: {
            type: 'MultiLineString',
            coordinates: buildSegments(track.renderLine, track.segmentBreaks),
        },
    };
}

/**
 * Builds the whole-lines collection. Hidden tracks contribute nothing.
 *
 * `isDone` comes from the playback clock rather than from the track state,
 * because whether a line reads as travelled depends on where the playhead is,
 * not on anything the file itself records. A track that has not been reached
 * yet is not done, so it stays bright ahead of the playhead.
 */
export function buildLineFeatures(
    tracks: TrackState[],
    isDone: (track: Track) => boolean,
): FeatureCollection<MultiLineString, TrackLineProperties> {
    return {
        type: 'FeatureCollection',
        features: tracks.filter((t) => t.visible).map((t) => featureFor(t.track, isDone(t.track))),
    };
}
