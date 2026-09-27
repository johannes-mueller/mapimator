import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { readStoredBasemapId } from './map/basemaps';
import { createMapView } from './map/mapView';
import type { MapViewHandle } from './map/mapView';
import { fitTracksInView, renderTracks } from './map/trackLayers';
import { GpxParseClient } from './gpx/parseClient';
import { createTrackStore } from './tracks/trackStore';
import { createBasemapSwitcher } from './ui/basemapSwitcher';
import { createDropzone } from './ui/dropzone';
import { createLegend } from './ui/legend';

declare global {
    interface Window {
        mapimator: MapViewHandle & {
            store: ReturnType<typeof createTrackStore>;
            trackCount: () => number;
        };
    }
}

function requireElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing required element #${id}`);
    }
    return element as T;
}

function requireButton(id: string): HTMLButtonElement {
    const element = requireElement<HTMLElement>(id);
    if (!(element instanceof HTMLButtonElement)) {
        throw new Error(`#${id} must be a <button>`);
    }
    return element;
}

function requireInput(id: string): HTMLInputElement {
    const element = requireElement<HTMLElement>(id);
    if (!(element instanceof HTMLInputElement)) {
        throw new Error(`#${id} must be an <input>`);
    }
    return element;
}

const initialBasemapId = readStoredBasemapId();
const view = createMapView(requireElement<HTMLElement>('map'), initialBasemapId);
const store = createTrackStore();
const parser = new GpxParseClient();

window.mapimator = {
    ...view,
    store,
    trackCount: () => store.getAll().length,
};

const switcher = createBasemapSwitcher(
    requireElement<HTMLElement>('basemap-switcher'),
    (id) => view.setBasemap(id),
    initialBasemapId,
);

const legend = createLegend(requireElement<HTMLElement>('legend-region'), (id) => {
    store.remove(id);
});

const dropzone = createDropzone({
    button: requireButton('dropzone'),
    input: requireInput('file-input'),
    onFiles: (files) => {
        void loadFiles(files);
    },
});

let loadInFlight = false;

async function loadFiles(files: File[]): Promise<void> {
    if (loadInFlight || files.length === 0) {
        dropzone.setStatus(
            files.length === 0
                ? 'No .gpx files in that drop.'
                : 'Still parsing — try again shortly.',
            'error',
        );
        return;
    }

    loadInFlight = true;
    dropzone.setBusy(true);
    dropzone.setStatus(null, 'info');

    let addedCount = 0;
    const failures: string[] = [];

    try {
        for (const file of files) {
            try {
                const result = await parser.parseFile(file);
                const wasEmpty = store.getAll().length === 0;
                store.add(result.tracks);
                addedCount += result.tracks.length;
                if (wasEmpty) {
                    const bounds = store.getCombinedBounds();
                    if (bounds) {
                        fitTracksInView(view.map, bounds);
                    }
                }
            } catch (error) {
                failures.push(
                    `${file.name}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    } finally {
        loadInFlight = false;
        dropzone.setBusy(false);
    }

    if (failures.length > 0) {
        dropzone.setStatus(
            failures.length === 1 ? failures[0] : `${failures.length} files failed to parse.`,
            'error',
        );
    } else if (addedCount > 0) {
        dropzone.setStatus(
            `Loaded ${addedCount} ${addedCount === 1 ? 'track' : 'tracks'}.`,
            'info',
        );
    }
}

const redraw = (): void => {
    legend.render(store.getAll());
    renderTracks(view.map, store.getAll());
};

store.subscribe(redraw);
view.onStyleReady(() => {
    switcher.setActive(view.getBasemapId());
    redraw();
});
redraw();

window.addEventListener('beforeunload', () => {
    parser.dispose();
    view.map.remove();
});
