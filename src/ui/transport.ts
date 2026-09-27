import type { Map as MaplibreMap } from 'maplibre-gl';
import type { TrackState } from '../types';
import { renderMarkers, renderTracks } from '../map/trackLayers';
import { createPlaybackClock } from '../playback/clock';
import type { PlaybackClock } from '../playback/clock';
import { formatDuration } from '../format';

const PLAY_ICON = '▶';
const PAUSE_ICON = '❚❚';

export interface TransportOptions {
    map: MaplibreMap;
    playButton: HTMLButtonElement;
    clockElement: HTMLElement;
    /** Read fresh on every change, so the controller never holds a stale list. */
    getTracks: () => TrackState[];
    /** Injected so the loop can be driven without a browser. */
    requestFrame?: (callback: (now: number) => void) => number;
    cancelFrame?: (handle: number) => void;
}

export interface TransportHandle {
    play: () => void;
    pause: () => void;
    toggle: () => void;
    isPlaying: () => boolean;
    seek: (ms: number) => void;
    getElapsedMs: () => number;
    getTotalMs: () => number;
    /** Re-reads the track set and redraws; call when the store changes. */
    refresh: () => void;
    /** Redraws including the lines; call when the basemap style reloads, since
     *  the new style starts with empty sources. */
    redraw: () => void;
    dispose: () => void;
}

/**
 * Wires the play button, the time readout and the animation frame loop to the
 * shared playback clock.
 *
 * Redraws come from the clock's subscription rather than straight from the frame
 * callback, so a frame that does not move the playhead costs nothing. The line
 * geometry is rebuilt only when the set of finished tracks changes, because
 * `buildLineFeatures` walks every sample of every track and doing that sixty
 * times a second would make a large file unplayable.
 */
export function createTransport(options: TransportOptions): TransportHandle {
    const {
        map,
        playButton,
        clockElement,
        getTracks,
        requestFrame = (callback) => requestAnimationFrame(callback),
        cancelFrame = (handle) => cancelAnimationFrame(handle),
    } = options;

    const clock: PlaybackClock = createPlaybackClock();
    let frame: number | null = null;
    let lastDoneKey: string | null = null;

    /** Which tracks are finished, as a cheap comparable key. */
    const doneKey = (tracks: TrackState[]): string =>
        tracks.map((t) => (t.visible && clock.isTrackDone(t.track) ? '1' : '0')).join('');

    const updateReadout = (): void => {
        const elapsed = formatDuration(clock.getElapsedMs());
        const total = formatDuration(clock.getTotalMs());
        clockElement.textContent = `${elapsed} / ${total}`;
    };

    const updateButton = (): void => {
        const playing = clock.isPlaying();
        playButton.textContent = playing ? PAUSE_ICON : PLAY_ICON;
        playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
        playButton.setAttribute('aria-pressed', String(playing));
        playButton.disabled = clock.getTotalMs() === 0;
    };

    const render = (withLines: boolean): void => {
        const tracks = getTracks();
        renderMarkers(map, tracks, clock.getTrackTime);
        const key = doneKey(tracks);
        if (withLines || key !== lastDoneKey) {
            lastDoneKey = key;
            renderTracks(map, tracks, clock.isTrackDone);
        }
        updateReadout();
        updateButton();
    };

    const stopLoop = (): void => {
        if (frame !== null) {
            cancelFrame(frame);
            frame = null;
        }
    };

    const step = (now: number): void => {
        frame = null;
        clock.tick(now);
        // The clock holds at the end instead of running past it, and an emptied
        // store has no timeline at all; either way there is nothing left to
        // animate, so the loop stops rather than spinning on dead frames.
        if (clock.getTotalMs() === 0 || clock.getElapsedMs() >= clock.getTotalMs()) {
            clock.pause();
            render(false);
        }
        syncLoop();
    };

    /** The loop runs exactly while the clock does, and never runs twice over. */
    function syncLoop(): void {
        if (clock.isPlaying()) {
            if (frame === null) {
                frame = requestFrame(step);
            }
        } else {
            stopLoop();
        }
    }

    const play = (): void => {
        if (clock.getTotalMs() === 0) {
            return;
        }
        if (clock.getElapsedMs() >= clock.getTotalMs()) {
            // Pressing play on a finished timeline restarts it, rather than
            // sitting at the end doing nothing.
            clock.seek(0);
        }
        clock.play();
        updateButton();
        syncLoop();
    };

    const pause = (): void => {
        clock.pause();
        syncLoop();
        updateButton();
    };

    const toggle = (): void => {
        if (clock.isPlaying()) {
            pause();
        } else {
            play();
        }
    };

    clock.subscribe(() => {
        render(false);
    });

    playButton.addEventListener('click', toggle);

    // The clock has to know the track set before the first readout, or the
    // timeline would read as empty until the store happened to change.
    clock.setTracks(getTracks().map((t) => t.track));
    render(true);

    return {
        play,
        pause,
        toggle,
        isPlaying: () => clock.isPlaying(),
        seek: (ms) => {
            clock.seek(ms);
            render(false);
        },
        getElapsedMs: () => clock.getElapsedMs(),
        getTotalMs: () => clock.getTotalMs(),
        refresh: () => {
            clock.setTracks(getTracks().map((t) => t.track));
            // Clearing the tracks stops the clock, and the loop has to follow it
            // rather than waiting for a frame that would do nothing.
            syncLoop();
            render(true);
        },
        redraw: () => {
            render(true);
        },
        dispose: () => {
            stopLoop();
            playButton.removeEventListener('click', toggle);
        },
    };
}
