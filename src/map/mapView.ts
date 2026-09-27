import {
    Map as MaplibreMap,
    AttributionControl,
    NavigationControl,
    setWorkerUrl,
} from 'maplibre-gl';
import { resolveBasemap, writeStoredBasemapId } from './basemaps';
import { attachTrackLayers, TRACK_MARKER_LAYER } from './trackLayers';

import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(workerUrl);

export interface MapViewHandle {
    map: MaplibreMap;
    setBasemap: (id: string) => void;
    getBasemapId: () => string;
    areTrackLayersAttached: () => boolean;
    /**
     * Runs `callback` after the overlay layers exist, both now (if the style is
     * already up) and after every later `style.load`. Basemap switching wipes
     * the overlay sources, so anything that drew tracks has to redraw here.
     */
    onStyleReady: (callback: () => void) => void;
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
    let styleReady = false;
    const styleReadyHandlers = new Set<() => void>();

    map.on('style.load', () => {
        attachTrackLayers(map);
        styleReady = true;
        for (const handler of [...styleReadyHandlers]) {
            handler();
        }
    });

    const setBasemap = (id: string): void => {
        const next = resolveBasemap(id);
        if (next.id === currentBasemapId) {
            return;
        }
        currentBasemapId = next.id;
        writeStoredBasemapId(next.id);
        styleReady = false;
        map.setStyle(next.styleUrl, { diff: false });
    };

    const onStyleReady = (callback: () => void): void => {
        if (styleReady) {
            callback();
            return;
        }
        styleReadyHandlers.add(callback);
    };

    return {
        map,
        setBasemap,
        getBasemapId: () => currentBasemapId,
        areTrackLayersAttached: () => map.getLayer(TRACK_MARKER_LAYER) !== undefined,
        onStyleReady,
    };
}
