import type { GeoJSONSource, LngLatBoundsLike, Map as MaplibreMap } from 'maplibre-gl';
import type { FeatureCollection, MultiLineString, Point } from 'geojson';
import type { Bounds, Track, TrackState } from '../types';
import type { TrackLineProperties } from '../tracks/lineFeatures';
import { buildLineFeatures } from '../tracks/lineFeatures';
import type { TrackMarkerProperties } from '../playback/markerFeatures';
import { buildMarkerFeatures } from '../playback/markerFeatures';

export const TRACK_LINES_SOURCE = 'track-lines';
export const TRACK_MARKERS_SOURCE = 'track-markers';
export const TRACK_LINE_FULL_LAYER = 'track-line-full';
export const TRACK_LINE_DONE_LAYER = 'track-line-done';
export const TRACK_MARKER_LAYER = 'track-marker';

const EMPTY_LINES: FeatureCollection<MultiLineString, TrackLineProperties> = {
    type: 'FeatureCollection',
    features: [],
};

const EMPTY_MARKERS: FeatureCollection<Point, TrackMarkerProperties> = {
    type: 'FeatureCollection',
    features: [],
};

/**
 * Adds the overlay sources and layers. Called on every `style.load`, because
 * `setStyle` throws the previous style's sources and layers away.
 */
export function attachTrackLayers(map: MaplibreMap): void {
    if (map.getSource(TRACK_LINES_SOURCE)) {
        return;
    }

    map.addSource(TRACK_LINES_SOURCE, {
        type: 'geojson',
        data: EMPTY_LINES,
        lineMetrics: true,
    });

    map.addSource(TRACK_MARKERS_SOURCE, {
        type: 'geojson',
        data: EMPTY_MARKERS,
    });

    map.addLayer({
        id: TRACK_LINE_FULL_LAYER,
        type: 'line',
        source: TRACK_LINES_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': ['get', 'color'],
            'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 14, 3, 18, 5],
            // Bright while the track is still ahead of the playhead, dim once
            // it has been travelled, so the two layers read as one progress bar.
            'line-opacity': ['case', ['get', 'done'], 0.18, 0.7],
        },
    });

    map.addLayer({
        id: TRACK_LINE_DONE_LAYER,
        type: 'line',
        source: TRACK_LINES_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': ['get', 'color'],
            'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2, 14, 4, 18, 6.5],
            'line-opacity': ['case', ['get', 'done'], 0.5, 0.95],
        },
    });

    map.addLayer({
        id: TRACK_MARKER_LAYER,
        type: 'circle',
        source: TRACK_MARKERS_SOURCE,
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 14, 6, 18, 9],
            'circle-color': ['get', 'color'],
            'circle-stroke-width': 1.5,
            'circle-stroke-color': 'rgba(8, 10, 14, 0.85)',
            'circle-opacity': ['case', ['get', 'done'], 0.55, 1],
        },
    });
}

export function renderTracks(
    map: MaplibreMap,
    tracks: TrackState[],
    isDone: (track: Track) => boolean,
): void {
    const source = map.getSource(TRACK_LINES_SOURCE) as GeoJSONSource | undefined;
    if (!source) {
        // Style still loading; the style.load handler renders again.
        return;
    }
    source.setData(buildLineFeatures(tracks, isDone));
}

/**
 * Moves the playhead markers. Called on every animation frame while playing and
 * once whenever the track set changes.
 */
export function renderMarkers(map: MaplibreMap, tracks: TrackState[], elapsedMs: number): void {
    const source = map.getSource(TRACK_MARKERS_SOURCE) as GeoJSONSource | undefined;
    if (!source) {
        return;
    }
    source.setData(buildMarkerFeatures(tracks, elapsedMs));
}

export function fitTracksInView(map: MaplibreMap, bounds: Bounds, maxZoom = 15): void {
    const box: LngLatBoundsLike = [
        [bounds.minLon, bounds.minLat],
        [bounds.maxLon, bounds.maxLat],
    ];
    map.fitBounds(box, { padding: 64, maxZoom, duration: 0 });
}
