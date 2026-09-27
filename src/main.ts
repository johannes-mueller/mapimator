import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { readStoredBasemapId } from './map/basemaps';
import { createMapView } from './map/mapView';
import type { MapViewHandle } from './map/mapView';
import { fitTracksInView } from './map/trackLayers';
import { GpxParseClient } from './gpx/parseClient';
import { createTrackStore } from './tracks/trackStore';
import { createBasemapSwitcher } from './ui/basemapSwitcher';
import { createDropzone } from './ui/dropzone';
import { createLegend } from './ui/legend';
import { createTransport } from './ui/transport';
import type { TransportHandle } from './ui/transport';
import { readoutText } from './playback/readout';

declare global {
    interface Window {
        mapimator: MapViewHandle & {
            store: ReturnType<typeof createTrackStore>;
            trackCount: () => number;
            /** Exposed so the E2E suite can drive playback deterministically. */
            playback: TransportHandle;
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

function requireSelect(id: string): HTMLSelectElement {
    const element = requireElement<HTMLElement>(id);
    if (!(element instanceof HTMLSelectElement)) {
        throw new Error(`#${id} must be a <select>`);
    }
    return element;
}

const initialBasemapId = readStoredBasemapId();
const view = createMapView(requireElement<HTMLElement>('map'), initialBasemapId);
const store = createTrackStore();
const parser = new GpxParseClient();

const transport = createTransport({
    map: view.map,
    playButton: requireButton('play-toggle'),
    clockElement: requireElement<HTMLElement>('clock'),
    speedSelect: requireSelect('speed-select'),
    timeline: requireInput('timeline'),
    getTracks: () => store.getAll(),
});

window.mapimator = {
    ...view,
    store,
    trackCount: () => store.getAll().length,
    playback: transport,
};

const switcher = createBasemapSwitcher(
    requireElement<HTMLElement>('basemap-switcher'),
    (id) => view.setBasemap(id),
    initialBasemapId,
);

const legend = createLegend(
    requireElement<HTMLElement>('legend-region'),
    (id) => {
        store.remove(id);
    },
    {
        // The per-track numbers come from the transport, which owns the clock,
        // rather than from a second copy of it here.
        getElapsedMs: () => transport.getElapsedMs(),
        readout: readoutText,
    },
);
transport.subscribe(() => {
    legend.updateReadouts();
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
    // The transport owns the track overlays, so a store change is handed to it
    // rather than rendered here: it has to update the shared clock as well.
    transport.refresh();
};

store.subscribe(redraw);
view.onStyleReady(() => {
    switcher.setActive(view.getBasemapId());
    legend.render(store.getAll());
    // A new style starts with empty sources, so the overlays are fed again.
    transport.redraw();
});
redraw();

window.addEventListener('beforeunload', () => {
    transport.dispose();
    parser.dispose();
    view.map.remove();
});
