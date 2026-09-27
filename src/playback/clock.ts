import type { Track } from '../types';

export const MIN_SPEED = 1;
export const MAX_SPEED = 300;

export interface PlaybackClock {
    /** Replaces the track set and recomputes how long the run lasts. */
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
    isTrackDone: (track: Track) => boolean;
    subscribe: (listener: (elapsedMs: number) => void) => () => void;
}

/**
 * One clock drives every track, measured from each track's own first point.
 *
 * Two rides of the same course are rarely recorded at the same moment, so their
 * timestamps differ by however long it took to do them twice. This clock ignores
 * that: every track is read against the shared elapsed time directly, so all the
 * markers start together at the start line and at elapsed ten minutes you are
 * looking at where each ride was ten minutes in. `t0` is not discarded — the
 * legend shows how far after the first ride each one began — it just does not
 * decide what the playhead means.
 */
export function createPlaybackClock(): PlaybackClock {
    let tracks: readonly Track[] = [];
    let totalMs = 0;
    let elapsedMs = 0;
    let playing = false;
    let speed = 1;
    let lastNow: number | null = null;
    const listeners = new Set<(elapsedMs: number) => void>();

    const recompute = (): void => {
        // The run lasts as long as the longest ride in it. Every track is read
        // from its own start, so a short ride simply finishes early and waits,
        // and an empty set leaves nothing to run.
        let latest = 0;
        for (const track of tracks) {
            latest = Math.max(latest, track.durationMs);
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
            const previousElapsed = elapsedMs;
            tracks = [...next];
            recompute();
            if (tracks.length > 0) {
                // Changing the set never moves any marker, because each track is
                // read against the shared elapsed time and nothing about that
                // depends on which other tracks are loaded. So the playhead stays
                // where the user left it, clamped down if the new set is shorter
                // than the position they were at.
                setElapsed(previousElapsed);
                return;
            }
            // An empty store has no timeline left to run, so reset and stop
            // rather than leaving a playhead stranded against a total of zero.
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

        isTrackDone: (track) => elapsedMs >= track.durationMs,

        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
