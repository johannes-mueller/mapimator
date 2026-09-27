import type { Map as MaplibreMap } from 'maplibre-gl';
import type { TrackState } from '../types';
import { renderMarkers, renderTracks } from '../map/trackLayers';
import { buildMarkerFeatures } from '../playback/markerFeatures';
import { computeFollowPan } from '../map/followCamera';
import { createPlaybackClock } from '../playback/clock';
import type { PlaybackClock } from '../playback/clock';
import { formatDuration } from '../format';
import { acceptsTransportKey, keyAction } from './transportKeys';

const PLAY_ICON = '▶';
const PAUSE_ICON = '❚❚';

export interface TransportOptions {
    map: MaplibreMap;
    playButton: HTMLButtonElement;
    clockElement: HTMLElement;
    speedSelect: HTMLSelectElement;
    timeline: HTMLInputElement;
    /** Read fresh on every change, so the controller never holds a stale list. */
    getTracks: () => TrackState[];
    /** Where key presses are heard. The document by default; injected for tests. */
    keyTarget?: EventTarget;
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
    getSpeed: () => number;
    /** True once a real drag/scroll/pinch has suspended the follow camera,
     *  until play() is called again. Exposed for the E2E suite. */
    isFollowSuspended: () => boolean;
    /** Called whenever the transport redraws, for readouts it does not own. */
    subscribe: (listener: () => void) => () => void;
    /** Re-reads the track set and redraws; call when the store changes. */
    refresh: () => void;
    /** Redraws including the lines; call when the basemap style reloads, since
     *  the new style starts with empty sources. */
    redraw: () => void;
    dispose: () => void;
}

/** Roughly how many positions the timeline should be able to address. */
export const TIMELINE_STEPS = 1000;

/**
 * The timeline's step, in milliseconds.
 *
 * A range input steps by `step`, so a step of 1 ms would make the arrow keys
 * useless on a focused timeline — a hundred presses to cross a ten-second gap —
 * and there is no such thing as a pixel-accurate millisecond on a slider a few
 * hundred pixels wide anyway. Dividing the total into a fixed number of steps
 * makes one key press a visible move on any length of ride.
 */
export function timelineStep(totalMs: number): number {
    if (!(totalMs > 0)) {
        return 1;
    }
    return Math.max(1, Math.round(totalMs / TIMELINE_STEPS));
}

/**
 * Wires the play button, the time readout and the animation frame loop to the
 * shared playback clock, and follows the visible markers with the camera
 * while playing — panning just enough to keep them in view, suspended by a
 * real drag/scroll/pinch until play is pressed again.
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
        speedSelect,
        timeline,
        getTracks,
        keyTarget = document,
        requestFrame = (callback) => requestAnimationFrame(callback),
        cancelFrame = (handle) => cancelAnimationFrame(handle),
    } = options;

    const clock: PlaybackClock = createPlaybackClock();
    let frame: number | null = null;
    let lastDoneKey: string | null = null;
    let lastClockText: string | null = null;
    let lastValueText: string | null = null;
    let followSuspended = false;
    const listeners = new Set<() => void>();

    /**
     * Pans just enough to keep every visible marker inside the margin, unless
     * a real drag/scroll/pinch has suspended following. The correction is a
     * `jumpTo` with no `originalEvent`, so the `movestart` it fires is not
     * mistaken for the user interaction that suspends following.
     */
    const applyFollow = (markers: ReturnType<typeof buildMarkerFeatures>): void => {
        if (!clock.isPlaying() || followSuspended) {
            return;
        }
        const container = map.getContainer();
        const width = container.clientWidth;
        const height = container.clientHeight;
        const points = markers.features.map((feature) => {
            const [lon, lat] = feature.geometry.coordinates;
            const p = map.project([lon, lat]);
            return { x: p.x, y: p.y };
        });
        const pan = computeFollowPan(points, width, height);
        if (!pan) {
            return;
        }
        const centerPx = map.project(map.getCenter());
        const newCenter = map.unproject([centerPx.x + pan.dx, centerPx.y + pan.dy]);
        map.jumpTo({ center: newCenter });
    };

    /** A real drag/scroll/pinch carries the DOM event that caused it; our own
     *  corrective jumps do not, so they cannot suspend themselves. */
    const onMoveStart = (event: { originalEvent?: unknown }): void => {
        if (event.originalEvent != null && clock.isPlaying()) {
            followSuspended = true;
        }
    };
    map.on('movestart', onMoveStart);

    /** Which tracks are finished, as a cheap comparable key. */
    const doneKey = (tracks: TrackState[]): string =>
        tracks.map((t) => (t.visible && clock.isTrackDone(t.track) ? '1' : '0')).join('');

    const updateReadout = (): void => {
        const text = `${formatDuration(clock.getElapsedMs())} / ${formatDuration(clock.getTotalMs())}`;
        // Written at most once per visible change: this runs on every frame, and
        // replacing identical text still costs a layout pass.
        if (text !== lastClockText) {
            lastClockText = text;
            clockElement.textContent = text;
        }
    };

    const updateButton = (): void => {
        const playing = clock.isPlaying();
        playButton.textContent = playing ? PAUSE_ICON : PLAY_ICON;
        playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
        playButton.setAttribute('aria-pressed', String(playing));
        playButton.disabled = clock.getTotalMs() === 0;
    };

    const updateSpeed = (): void => {
        // Written back from the clock rather than trusted from the event, so a
        // value the clock refused (the select can be tampered with from the
        // console, and an unknown option reports no value at all) cannot leave
        // the control claiming a speed the animation is not running at.
        const speed = String(clock.getSpeed());
        if (speedSelect.value !== speed) {
            speedSelect.value = speed;
        }
        speedSelect.disabled = clock.getTotalMs() === 0;
    };

    const updateTimeline = (): void => {
        const total = clock.getTotalMs();
        const elapsed = clock.getElapsedMs();
        // Only written when it differs, so a drag is not fought by the playhead
        // repainting the handle the pointer is holding.
        if (timeline.max !== String(total)) {
            timeline.max = String(total);
        }
        const step = String(timelineStep(total));
        if (timeline.step !== step) {
            timeline.step = step;
        }
        const value = String(elapsed);
        if (timeline.value !== value) {
            timeline.value = value;
        }
        const valueText = `${formatDuration(elapsed)} of ${formatDuration(total)}`;
        if (valueText !== lastValueText) {
            lastValueText = valueText;
            // A screen reader would otherwise announce a bare millisecond count.
            timeline.setAttribute('aria-valuetext', valueText);
        }
        timeline.disabled = total === 0;
    };

    const render = (withLines: boolean): void => {
        const tracks = getTracks();
        const markers = buildMarkerFeatures(tracks, clock.getElapsedMs());
        renderMarkers(map, markers);
        applyFollow(markers);
        const key = doneKey(tracks);
        if (withLines || key !== lastDoneKey) {
            lastDoneKey = key;
            renderTracks(map, tracks, clock.isTrackDone);
        }
        updateReadout();
        updateButton();
        updateSpeed();
        updateTimeline();
        for (const listener of listeners) {
            listener();
        }
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
        // Pressing play always re-arms following, suspended or not: that is the
        // one gesture agreed to bring it back.
        followSuspended = false;
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

    const seek = (ms: number): void => {
        clock.seek(ms);
        render(false);
    };

    const onSpeedChange = (): void => {
        clock.setSpeed(Number(speedSelect.value));
        // Written back from the clock, so a refused value corrects the control
        // instead of leaving it lying about the rate.
        updateSpeed();
    };

    const onTimelineInput = (): void => {
        // `input` rather than `change`, so the map follows the pointer instead of
        // jumping once on release. Scrubbing does not pause: the clock rebaselines
        // on the next frame, so playback carries on from wherever it was dropped.
        clock.seek(Number(timeline.value));
        render(false);
    };

    const onKeyDown = (event: Event): void => {
        const keyEvent = event as KeyboardEvent;
        const action = keyAction(keyEvent.key, keyEvent.shiftKey, clock.getTotalMs());
        if (!action) {
            return;
        }
        if (!acceptsTransportKey(keyEvent.target, timeline, keyEvent.key)) {
            return;
        }
        // Only for keys we act on: Space would otherwise scroll the page, and the
        // rest are ours alone.
        keyEvent.preventDefault();
        if (action.kind === 'toggle') {
            toggle();
        } else if (action.kind === 'seek') {
            seek(action.ms);
        } else {
            const total = clock.getTotalMs();
            seek(clock.getElapsedMs() + (total * action.percent) / 100);
        }
    };

    clock.subscribe(() => {
        render(false);
    });

    playButton.addEventListener('click', toggle);
    speedSelect.addEventListener('change', onSpeedChange);
    timeline.addEventListener('input', onTimelineInput);
    keyTarget.addEventListener('keydown', onKeyDown);

    // The clock has to know the track set before the first readout, or the
    // timeline would read as empty until the store happened to change.
    clock.setTracks(getTracks().map((t) => t.track));
    render(true);

    return {
        play,
        pause,
        toggle,
        isPlaying: () => clock.isPlaying(),
        seek,
        getElapsedMs: () => clock.getElapsedMs(),
        getTotalMs: () => clock.getTotalMs(),
        getSpeed: () => clock.getSpeed(),
        isFollowSuspended: () => followSuspended,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
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
            listeners.clear();
            playButton.removeEventListener('click', toggle);
            speedSelect.removeEventListener('change', onSpeedChange);
            timeline.removeEventListener('input', onTimelineInput);
            keyTarget.removeEventListener('keydown', onKeyDown);
            map.off('movestart', onMoveStart);
        },
    };
}
