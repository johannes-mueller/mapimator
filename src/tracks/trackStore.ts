import type { Bounds, Track, TrackState } from '../types';
import type { ParsedTrack } from '../gpx/parseGpx';
import { trackColorFor } from './palette';

export interface TrackStore {
    getAll: () => TrackState[];
    getById: (id: string) => TrackState | undefined;
    /** Appends parsed tracks, assigning ids and colours. Returns what was added. */
    add: (parsed: ParsedTrack[]) => Track[];
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
        states = [...states, ...added.map((track) => ({ track, visible: true, done: false }))];
        notify();
        return added;
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
