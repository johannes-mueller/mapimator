import type { Feature, FeatureCollection, Point } from 'geojson';
import type { TrackState } from '../types';
import type { PlaybackStatus } from './interpolate';
import { positionAt } from './interpolate';

/** Declared as a type, not an interface, so it stays assignable to GeoJSON's
 *  index-signature property bags without a cast. */
export type TrackMarkerProperties = {
    trackId: string;
    name: string;
    color: string;
    status: PlaybackStatus;
    done: boolean;
    progress: number;
};

export type TrackMarkerFeature = Feature<Point, TrackMarkerProperties>;

/**
 * Builds the playhead markers for the current shared time.
 *
 * `trackTimeMs` is the clock's own `getTrackTime`, passed in rather than
 * re-derived here, so the offset arithmetic has exactly one implementation.
 *
 * Tracks that have not started yet are omitted entirely: the agreed behaviour is
 * that a later ride stays invisible until the shared clock reaches it, rather
 * than showing a marker sitting on its start point. A track that has finished
 * keeps its marker, resting on the final point.
 */
export function buildMarkerFeatures(
    tracks: TrackState[],
    elapsedMs: number,
): FeatureCollection<Point, TrackMarkerProperties> {
    const features: TrackMarkerFeature[] = [];

    for (const { track, visible } of tracks) {
        if (!visible) {
            continue;
        }
        const position = positionAt(track, elapsedMs);
        // GeoJSON is longitude first, and the typed arrays are latitude first.
        features.push({
            type: 'Feature',
            properties: {
                trackId: track.id,
                name: track.name,
                color: track.color,
                status: position.status,
                done: position.status === 'done',
                progress: position.progress,
            },
            geometry: {
                type: 'Point',
                coordinates: [position.lon, position.lat],
            },
        });
    }

    return { type: 'FeatureCollection', features };
}
