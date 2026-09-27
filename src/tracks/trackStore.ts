import type { Bounds, Track, TrackState } from '../types';
import type { ParsedTrack } from '../gpx/parseGpx';
import { trackColorFor } from './palette';
import { withElevation } from '../terrain/elevation';

export interface TrackStore {
    getAll: () => TrackState[];
    getById: (id: string) => TrackState | undefined;
    /** Appends parsed tracks, assigning ids and colours. Returns what was added. */
    add: (parsed: ParsedTrack[]) => Track[];
    /**
     * Replaces a track's elevations with ones sampled from an elevation model,
     * keeping the id, the colour and whether it is shown. Returns false for a
     * track that is no longer there, which is the normal answer when a model
     * arrives after the rider has removed the file.
     */
    updateElevation: (id: string, ele: Float32Array) => boolean;
    remove: (id: string) => void;
    clear: () => void;
    getCombinedBounds: () => Bounds | null;
    subscribe: (listener: () => void) => () => void;
}

export function createTrackStore(): TrackStore {
    let states: TrackState[] = [];
    let nextId = 1;
    const listeners = new Set<() => void>();

    const notify = (): void => {
        for (const listener of [...listeners]) {
            listener();
        }
    };

    const add = (parsed: ParsedTrack[]): Track[] => {
        if (parsed.length === 0) {
            return [];
        }
        const added = parsed.map((track, offset): Track => {
            const id = `track-${nextId}`;
            nextId += 1;
            return {
                ...track,
                id,
                // Offset keeps colours distinct when several files arrive in one
                // batch instead of restarting the palette per file.
                color: trackColorFor(states.length + offset),
            };
        });
        states = [...states, ...added.map((track) => ({ track, visible: true }))];
        notify();
        return added;
    };

    const updateElevation = (id: string, ele: Float32Array): boolean => {
        const state = states.find((candidate) => candidate.track.id === id);
        if (!state) {
            return false;
        }
        // Replaced on the state rather than the track, so the object the chart is
        // holding keeps the elevations it drew with while the store moves on. The
        // next redraw reads the new ones, and nothing in between sees a track
        // whose elevation disagrees with the store's.
        states = states.map((candidate) =>
            candidate === state
                ? { ...candidate, track: withElevation(candidate.track, ele) }
                : candidate,
        );
        notify();
        return true;
    };

    const remove = (id: string): void => {
        const next = states.filter((state) => state.track.id !== id);
        if (next.length === states.length) {
            return;
        }
        states = next;
        notify();
    };

    const clear = (): void => {
        if (states.length === 0) {
            return;
        }
        states = [];
        notify();
    };

    const getCombinedBounds = (): Bounds | null => {
        if (states.length === 0) {
            return null;
        }
        const bounds: Bounds = {
            minLon: Infinity,
            minLat: Infinity,
            maxLon: -Infinity,
            maxLat: -Infinity,
        };
        for (const { track } of states) {
            bounds.minLon = Math.min(bounds.minLon, track.bounds.minLon);
            bounds.minLat = Math.min(bounds.minLat, track.bounds.minLat);
            bounds.maxLon = Math.max(bounds.maxLon, track.bounds.maxLon);
            bounds.maxLat = Math.max(bounds.maxLat, track.bounds.maxLat);
        }
        return bounds;
    };

    return {
        getAll: () => states,
        getById: (id) => states.find((state) => state.track.id === id),
        add,
        updateElevation,
        remove,
        clear,
        getCombinedBounds,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
