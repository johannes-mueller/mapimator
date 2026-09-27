import type { Track } from '../types';

export const MIN_SPEED = 1;
export const MAX_SPEED = 300;

export interface PlaybackClock {
    /** Replaces the track set and recomputes the shared origin and total span. */
    setTracks: (tracks: readonly Track[]) => void;
    play: () => void;
    pause: () => void;
    isPlaying: () => boolean;
    /**
     * Advances the clock from an explicit timestamp and returns the new shared
     * elapsed time. `nowMs` is injected rather than read from the environment so
     * the tests can drive frames by hand; the caller normally passes
     * `performance.now()` once per animation frame.
     */
    tick: (nowMs: number) => number;
    /** Jumps to an absolute shared elapsed time, clamped to the total. */
    seek: (elapsedMs: number) => void;
    getElapsedMs: () => number;
    getTotalMs: () => number;
    getSpeed: () => number;
    setSpeed: (multiplier: number) => void;
    /** The shared elapsed time projected onto one track's own timeline. */
    getTrackTime: (track: Track) => number;
    isTrackDone: (track: Track) => boolean;
    subscribe: (listener: (elapsedMs: number) => void) => () => void;
}

/**
 * One clock drives every track.
 *
 * Tracks are recorded independently, so two rides can start hours apart. Rather
 * than aligning them, each track keeps its own `t0` and the clock's shared
 * elapsed time is projected onto it as `elapsed - (t0 - earliestT0)`. A track
 * whose offset has not been reached yet reports a negative local time, which is
 * what lets several recordings run side by side instead of being forced into
 * step.
 */
export function createPlaybackClock(): PlaybackClock {
    let tracks: readonly Track[] = [];
    let origin = 0;
    let totalMs = 0;
    let elapsedMs = 0;
    let playing = false;
    let speed = 1;
    let lastNow: number | null = null;
    const listeners = new Set<(elapsedMs: number) => void>();

    const recompute = (): void => {
        if (tracks.length === 0) {
            origin = 0;
            totalMs = 0;
            return;
        }
        // Two passes: the span depends on the earliest t0, which is only known
        // once every track has been seen.
        let earliest = Infinity;
        for (const track of tracks) {
            earliest = Math.min(earliest, track.t0);
        }
        origin = earliest;
        let latest = 0;
        for (const track of tracks) {
            latest = Math.max(latest, track.t0 - origin + track.durationMs);
        }
        totalMs = latest;
    };

    const clamp = (value: number): number => {
        if (!Number.isFinite(value)) {
            return 0;
        }
        return Math.min(Math.max(value, 0), totalMs);
    };

    const emit = (): void => {
        for (const listener of [...listeners]) {
            listener(elapsedMs);
        }
    };

    const setElapsed = (value: number): void => {
        const next = clamp(value);
        if (next === elapsedMs) {
            return;
        }
        elapsedMs = next;
        emit();
    };

    return {
        setTracks: (next) => {
            const previousOrigin = origin;
            const previousElapsed = elapsedMs;
            tracks = [...next];
            recompute();
            if (tracks.length > 0 && origin === previousOrigin) {
                // The origin is what defines every track's local time, so if it
                // has not moved the elapsed time is still meaningful. Adding or
                // removing a track that does not redefine "earliest" should not
                // interrupt a run in progress.
                setElapsed(previousElapsed);
                return;
            }
            // Either the origin moved, which means every track's offset changed
            // and the old elapsed time no longer refers to the same moment, or
            // the set is empty and there is no timeline left to run. Reset and
            // stop rather than silently teleporting every marker.
            playing = false;
            lastNow = null;
            setElapsed(0);
        },

        play: () => {
            if (playing || totalMs === 0) {
                return;
            }
            playing = true;
            // Baseline on the next frame so the interval between the click and
            // that frame is not counted twice.
            lastNow = null;
        },

        pause: () => {
            playing = false;
            lastNow = null;
        },

        isPlaying: () => playing,

        tick: (nowMs) => {
            if (lastNow === null) {
                lastNow = nowMs;
                return elapsedMs;
            }
            const delta = nowMs - lastNow;
            lastNow = nowMs;
            if (!playing || delta <= 0) {
                // A non-positive delta means the host clock moved backwards
                // (an NTP correction, say). Nothing to advance.
                return elapsedMs;
            }
            // Real elapsed time, not a capped one: a backgrounded tab should
            // resume where the wall clock says it is, not lose the interval.
            setElapsed(elapsedMs + delta * speed);
            return elapsedMs;
        },

        seek: (value) => {
            lastNow = null;
            setElapsed(value);
        },

        getElapsedMs: () => elapsedMs,
        getTotalMs: () => totalMs,
        getSpeed: () => speed,

        setSpeed: (multiplier) => {
            if (!Number.isFinite(multiplier) || multiplier <= 0) {
                return;
            }
            speed = Math.min(Math.max(multiplier, MIN_SPEED), MAX_SPEED);
        },

        getTrackTime: (track) => elapsedMs - (track.t0 - origin),

        isTrackDone: (track) => elapsedMs - (track.t0 - origin) >= track.durationMs,

        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
