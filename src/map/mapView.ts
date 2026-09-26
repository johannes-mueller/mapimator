import {
    Map as MaplibreMap,
    AttributionControl,
    NavigationControl,
    setWorkerUrl,
} from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollection, LineString, Point } from 'geojson';
import { resolveBasemap, writeStoredBasemapId } from './basemaps';

import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(workerUrl);

export const TRACK_LINES_SOURCE = 'track-lines';
export const TRACK_MARKERS_SOURCE = 'track-markers';
export const TRACK_LINE_FULL_LAYER = 'track-line-full';
export const TRACK_LINE_DONE_LAYER = 'track-line-done';
export const TRACK_MARKER_LAYER = 'track-marker';

const EMPTY_LINES: FeatureCollection<LineString> = {
    type: 'FeatureCollection',
    features: [],
};

const EMPTY_MARKERS: FeatureCollection<Point> = {
    type: 'FeatureCollection',
    features: [],
};

export interface MapViewHandle {
    map: MaplibreMap;
    setBasemap: (id: string) => void;
    getBasemapId: () => string;
    areTrackLayersAttached: () => boolean;
}

function attachTrackLayers(map: MaplibreMap): void {
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
            'line-opacity': ['case', ['get', 'done'], 0.18, 0.4],
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

export function createMapView(container: HTMLElement, initialBasemapId: string): MapViewHandle {
    const basemap = resolveBasemap(initialBasemapId);

    const map = new MaplibreMap({
        container,
        style: basemap.styleUrl,
        center: [8.5, 47.4],
        zoom: 4,
        minZoom: 1,
        maxZoom: 19,
        attributionControl: false,
    });

    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-left');
    map.addControl(new AttributionControl({ compact: true }), 'bottom-left');

    let currentBasemapId = basemap.id;

    map.on('style.load', () => {
        attachTrackLayers(map);
    });

    const setBasemap = (id: string): void => {
        const next = resolveBasemap(id);
        if (next.id === currentBasemapId) {
            return;
        }
        currentBasemapId = next.id;
        writeStoredBasemapId(next.id);
        map.setStyle(next.styleUrl, { diff: false });
    };

    return {
        map,
        setBasemap,
        getBasemapId: () => currentBasemapId,
        areTrackLayersAttached: () => map.getLayer(TRACK_MARKER_LAYER) !== undefined,
    };
}

export function getLinesSource(map: MaplibreMap): GeoJSONSource | undefined {
    return map.getSource(TRACK_LINES_SOURCE) as GeoJSONSource | undefined;
}

export function getMarkersSource(map: MaplibreMap): GeoJSONSource | undefined {
    return map.getSource(TRACK_MARKERS_SOURCE) as GeoJSONSource | undefined;
}
