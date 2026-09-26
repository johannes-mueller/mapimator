import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { readStoredBasemapId } from './map/basemaps';
import { createMapView } from './map/mapView';
import type { MapViewHandle } from './map/mapView';
import { createBasemapSwitcher } from './ui/basemapSwitcher';

declare global {
    interface Window {
        mapimator: MapViewHandle;
    }
}

function requireElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing required element #${id}`);
    }
    return element as T;
}

const initialBasemapId = readStoredBasemapId();
const view = createMapView(requireElement<HTMLElement>('map'), initialBasemapId);
window.mapimator = view;

const switcher = createBasemapSwitcher(
    requireElement<HTMLElement>('basemap-switcher'),
    (id) => view.setBasemap(id),
    initialBasemapId,
);

view.map.on('style.load', () => {
    switcher.setActive(view.getBasemapId());
});

window.addEventListener('beforeunload', () => {
    view.map.remove();
});
