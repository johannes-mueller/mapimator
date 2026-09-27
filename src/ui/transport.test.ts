import { describe, expect, it } from 'vitest';
import { createTransport, TIMELINE_STEPS, timelineStep } from './transport';
import { MAX_SPEED } from '../playback/clock';
import type { Track, TrackState } from '../types';

const S = 1000;
const M = 60_000;
const H = 3_600_000;
const MINUTE = 60_000;

const makeTrack = (
    id: string,
    t0: number,
    timesMs: number[],
    coords: [number, number][],
): Track => {
    const tRel = new Float64Array(timesMs.length);
    for (let i = 0; i < timesMs.length; i += 1) {
        tRel[i] = timesMs[i] / S;
    }
    return {
        id,
        name: id,
        color: '#ff0000',
        t0,
        tRel,
        lat: Float64Array.from(coords.map(([, lat]) => lat)),
        lon: Float64Array.from(coords.map(([lon]) => lon)),
        ele: new Float32Array(timesMs.length),
        dist: new Float32Array(timesMs.length),
        segmentBreaks: new Uint32Array(0),
        durationMs: timesMs[timesMs.length - 1] ?? 0,
        distanceM: 0,
        bounds: { minLon: 0, minLat: 0, maxLon: 0, maxLat: 0 },
        renderLine: [1, 47, 2, 47, 3, 47],
    } as Track;
};

/** One minute of travel in a straight line, so a minute of playback is visible. */
const minuteTrack = (id = 'a', t0 = 0): Track =>
    makeTrack(
        id,
        t0,
        [0, 15 * S, 30 * S, 45 * S, 60 * S],
        [
            [1, 47],
            [2, 47],
            [3, 47],
            [4, 47],
            [5, 47],
        ],
    );

const state = (track: Track, visible = true): TrackState => ({ track, visible });

/** Just enough of a button for the controller to drive. */
const fakeButton = () => {
    const listeners = new Map<string, (() => void)[]>();
    const element = {
        tagName: 'BUTTON',
        textContent: '',
        disabled: false,
        attrs: new Map<string, string>(),
        addEventListener: (type: string, listener: () => void) => {
            listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        removeEventListener: (type: string, listener: () => void) => {
            listeners.set(
                type,
                (listeners.get(type) ?? []).filter((l) => l !== listener),
            );
        },
        click: () => {
            for (const listener of listeners.get('click') ?? []) {
                listener();
            }
        },
        setAttribute: (name: string, value: string) => {
            element.attrs.set(name, value);
        },
    };
    return element;
};

/** Just enough of a range input for the scrub wiring. */
const fakeRange = () => {
    const listeners = new Map<string, (() => void)[]>();
    const element = {
        tagName: 'INPUT',
        value: '0',
        min: '0',
        max: '0',
        step: '1',
        disabled: false,
        attrs: new Map<string, string>(),
        addEventListener: (type: string, listener: () => void) => {
            listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        removeEventListener: (type: string, listener: () => void) => {
            listeners.set(
                type,
                (listeners.get(type) ?? []).filter((l) => l !== listener),
            );
        },
        setAttribute: (name: string, value: string) => {
            element.attrs.set(name, value);
        },
        /** Moves the handle and fires `input`, as a drag or an arrow key would. */
        slide: (value: number | string): void => {
            element.value = String(value);
            for (const listener of listeners.get('input') ?? []) {
                listener();
            }
        },
    };
    return element;
};

/** Just enough of a select for the speed wiring. */
const fakeSelect = () => {
    const listeners = new Map<string, (() => void)[]>();
    const element = {
        tagName: 'SELECT',
        value: '1',
        disabled: false,
        addEventListener: (type: string, listener: () => void) => {
            listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        removeEventListener: (type: string, listener: () => void) => {
            listeners.set(
                type,
                (listeners.get(type) ?? []).filter((l) => l !== listener),
            );
        },
        /** Picks an option and fires `change`, as a real selection would. */
        choose: (value: string): void => {
            element.value = value;
            for (const listener of listeners.get('change') ?? []) {
                listener();
            }
        },
    };
    return element;
};

/** A key event the transport can read without a DOM. */
interface FakeKeyEvent {
    key: string;
    shiftKey: boolean;
    target: unknown;
    defaultPrevented: boolean;
    preventDefault: () => void;
}

const fakeKeyTarget = () => {
    const listeners: ((event: FakeKeyEvent) => void)[] = [];
    return {
        listeners,
        addEventListener: (type: string, listener: (event: FakeKeyEvent) => void) => {
            if (type === 'keydown') {
                listeners.push(listener);
            }
        },
        removeEventListener: (_type: string, listener: (event: FakeKeyEvent) => void) => {
            const at = listeners.indexOf(listener);
            if (at >= 0) {
                listeners.splice(at, 1);
            }
        },
        press: (key: string, options: { shiftKey?: boolean; target?: unknown } = {}) => {
            const event: FakeKeyEvent = {
                key,
                shiftKey: options.shiftKey ?? false,
                target: options.target ?? null,
                defaultPrevented: false,
                preventDefault: () => {
                    event.defaultPrevented = true;
                },
            };
            for (const listener of [...listeners]) {
                listener(event);
            }
            return event;
        },
    };
};

/** A frame loop the test can step by hand, standing in for rAF. */
const frameDriver = () => {
    const pending = new Map<number, (now: number) => void>();
    let nextId = 1;

    const requestFrame = (callback: (now: number) => void): number => {
        const id = nextId;
        nextId += 1;
        pending.set(id, callback);
        return id;
    };

    const cancelFrame = (id: number): void => {
        pending.delete(id);
    };

    /** Runs the oldest pending frame, as the browser would. */
    const run = (now: number): boolean => {
        const first = [...pending.entries()][0];
        if (!first) {
            return false;
        }
        pending.delete(first[0]);
        first[1](now);
        return true;
    };

    const runFrames = (count: number, startMs: number, stepMs: number): void => {
        for (let i = 0; i < count; i += 1) {
            if (!run(startMs + i * stepMs)) {
                return;
            }
        }
    };

    return {
        requestFrame,
        cancelFrame,
        count: (): number => pending.size,
        run,
        runFrames,
    };
};

interface RenderedFeature {
    properties: { trackId: string; done: boolean; status: string };
    geometry: { coordinates: number[] };
}

const harness = (initial: TrackState[] = []) => {
    const button = fakeButton();
    const clockElement = { textContent: '' };
    const speedSelect = fakeSelect();
    const timeline = fakeRange();
    const keys = fakeKeyTarget();
    const data = new Map<string, unknown[]>();
    const map = {
        getSource: (id: string) => {
            const set = (value: unknown): void => {
                data.set(id, [...(data.get(id) ?? []), value]);
            };
            return { setData: set };
        },
    } as unknown as Parameters<typeof createTransport>[0]['map'];

    let tracks = initial;
    const frames = frameDriver();
    const transport = createTransport({
        map,
        playButton: button as unknown as HTMLButtonElement,
        clockElement: clockElement as unknown as HTMLElement,
        speedSelect: speedSelect as unknown as HTMLSelectElement,
        timeline: timeline as unknown as HTMLInputElement,
        keyTarget: keys as unknown as EventTarget,
        getTracks: () => tracks,
        requestFrame: frames.requestFrame,
        cancelFrame: frames.cancelFrame,
    });

    const featuresOf = (sourceId: string): RenderedFeature[] => {
        const calls = data.get(sourceId) ?? [];
        const latest = calls[calls.length - 1] as { features: RenderedFeature[] } | undefined;
        return latest?.features ?? [];
    };

    return {
        transport,
        button,
        clockElement,
        speedSelect,
        timeline,
        keys,
        frames,
        setTracks: (next: TrackState[]) => {
            tracks = next;
            transport.refresh();
        },
        /** How many times the markers source has been fed. */
        markerWrites: (): number => (data.get('track-markers') ?? []).length,
        markers: (): RenderedFeature[] => featuresOf('track-markers'),
        /** How many times the lines source has been rebuilt. */
        lineWrites: (): number => (data.get('track-lines') ?? []).length,
        lines: (): RenderedFeature[] => featuresOf('track-lines'),
    };
};

describe('createTransport', () => {
    describe('with no tracks', () => {
        it('disables the play button', () => {
            const { button } = harness();
            expect(button.disabled).toBe(true);
        });

        it('reads as an empty clock', () => {
            const { clockElement } = harness();
            expect(clockElement.textContent).toBe('0:00 / 0:00');
        });

        it('will not play', () => {
            const h = harness();
            h.transport.play();
            expect(h.transport.isPlaying()).toBe(false);
            expect(h.frames.count()).toBe(0);
        });

        it('shows no markers', () => {
            expect(harness().markers()).toEqual([]);
        });
    });

    describe('with a track', () => {
        it('enables the play button', () => {
            const h = harness([state(minuteTrack())]);
            expect(h.button.disabled).toBe(false);
        });

        it('reads out the total duration', () => {
            const h = harness([state(minuteTrack())]);
            expect(h.clockElement.textContent).toBe('0:00 / 1:00');
        });

        it('places a marker at the start of the track', () => {
            const markers = harness([state(minuteTrack())]).markers();
            expect(markers).toHaveLength(1);
            expect(markers[0].geometry.coordinates[0]).toBeCloseTo(1, 12);
        });
    });

    describe('the play button', () => {
        it('starts on play and toggles to pause', () => {
            const h = harness([state(minuteTrack())]);
            expect(h.button.textContent).toBe('▶');
            expect(h.button.attrs.get('aria-label')).toBe('Play');
            h.button.click();
            expect(h.transport.isPlaying()).toBe(true);
            expect(h.button.textContent).toBe('❚❚');
            expect(h.button.attrs.get('aria-label')).toBe('Pause');
            expect(h.button.attrs.get('aria-pressed')).toBe('true');
        });

        it('toggles back to play', () => {
            const h = harness([state(minuteTrack())]);
            h.button.click();
            h.button.click();
            expect(h.transport.isPlaying()).toBe(false);
            expect(h.button.textContent).toBe('▶');
            expect(h.button.attrs.get('aria-pressed')).toBe('false');
        });

        it('does not react after dispose', () => {
            const h = harness([state(minuteTrack())]);
            h.transport.dispose();
            h.button.click();
            expect(h.transport.isPlaying()).toBe(false);
        });
    });

    describe('the animation loop', () => {
        it('schedules a frame when playing and none when paused', () => {
            const h = harness([state(minuteTrack())]);
            expect(h.frames.count()).toBe(0);
            h.transport.play();
            expect(h.frames.count()).toBe(1);
            h.transport.pause();
            expect(h.frames.count()).toBe(0);
        });

        it('keeps exactly one frame pending', () => {
            const h = harness([state(minuteTrack())]);
            h.transport.play();
            h.frames.run(0);
            expect(h.frames.count()).toBe(1);
            h.frames.run(100);
            expect(h.frames.count()).toBe(1);
        });

        it('advances the clock by the real frame delta', () => {
            const h = harness([state(minuteTrack())]);
            h.transport.play();
            h.frames.run(0);
            h.frames.run(1000);
            expect(h.transport.getElapsedMs()).toBe(1000);
            h.frames.run(2000);
            expect(h.transport.getElapsedMs()).toBe(2000);
        });

        it('stops at the end of the timeline and pauses', () => {
            const h = harness([state(minuteTrack())]);
            h.transport.play();
            h.frames.run(0);
            h.frames.runFrames(4, 15 * S, 15 * S);
            expect(h.transport.getElapsedMs()).toBe(M);
            expect(h.transport.isPlaying()).toBe(false);
            expect(h.frames.count()).toBe(0);
            expect(h.button.textContent).toBe('▶');
        });

        it('does not run past the end however long frames continue', () => {
            const h = harness([state(minuteTrack())]);
            h.transport.play();
            h.frames.runFrames(20, 0, 30 * S);
            expect(h.transport.getElapsedMs()).toBe(M);
        });

        it('restarts from the beginning when played at the end', () => {
            const h = harness([state(minuteTrack())]);
            h.transport.seek(M);
            h.transport.play();
            expect(h.transport.getElapsedMs()).toBe(0);
            expect(h.transport.isPlaying()).toBe(true);
        });

        it('leaves the elapsed time alone while paused', () => {
            const h = harness([state(minuteTrack())]);
            h.transport.play();
            h.frames.run(0);
            h.frames.run(1000);
            h.transport.pause();
            h.frames.runFrames(3, 5000, 1000);
            expect(h.transport.getElapsedMs()).toBe(1000);
        });

        it('stops the loop when the tracks are removed mid-playback', () => {
            const h = harness([state(minuteTrack())]);
            h.transport.play();
            h.frames.run(0);
            h.setTracks([]);
            expect(h.frames.count()).toBe(0);
            expect(h.transport.isPlaying()).toBe(false);
        });
    });

    describe('the readout', () => {
        it('counts up as frames are played', () => {
            const h = harness([state(minuteTrack())]);
            h.transport.play();
            h.frames.run(0);
            h.frames.run(5 * S);
            expect(h.clockElement.textContent).toBe('0:05 / 1:00');
        });

        it('follows a seek while paused', () => {
            const h = harness([state(minuteTrack())]);
            h.transport.seek(30 * S);
            expect(h.clockElement.textContent).toBe('0:30 / 1:00');
        });

        it('spans the longest ride for tracks recorded far apart', () => {
            // The two hours between the recordings are not part of either ride,
            // so they are not part of the run either.
            const h = harness([state(minuteTrack('a', 0)), state(minuteTrack('b', 2 * H))]);
            expect(h.clockElement.textContent).toBe('0:00 / 1:00');
        });
    });

    describe('markers', () => {
        it('moves the marker as the clock advances', () => {
            const h = harness([state(minuteTrack())]);
            h.transport.seek(30 * S);
            expect(h.markers()[0].geometry.coordinates[0]).toBeCloseTo(3, 12);
        });

        it('keeps a later-recorded track on screen from the first frame', () => {
            // No track is ever "not started": measured from its own first point,
            // a ride recorded two hours later still has a marker on the line.
            const h = harness([state(minuteTrack('a', 0)), state(minuteTrack('b', 2 * H))]);
            expect(h.markers().map((f) => f.properties.trackId)).toEqual(['a', 'b']);
        });

        it('moves a later-recorded track in step with the run', () => {
            const h = harness([state(minuteTrack('a', 0)), state(minuteTrack('b', 2 * H))]);
            h.transport.seek(30 * S);
            // Both rides stand at their own thirty seconds, not one at thirty
            // seconds and the other still waiting.
            expect(h.markers().map((f) => f.geometry.coordinates[0])).toEqual([3, 3]);
        });

        it('follows a seek to the end of a track', () => {
            const h = harness([state(minuteTrack())]);
            h.transport.seek(M);
            const features = h.markers();
            expect(features[0].properties.trackId).toBe('a');
            expect(features[0].geometry.coordinates[0]).toBeCloseTo(5, 12);
        });

        it('draws markers for two simultaneous tracks independently', () => {
            const h = harness([state(minuteTrack('a', 0)), state(minuteTrack('b', 0))]);
            h.transport.seek(30 * S);
            const features = h.markers();
            expect(features).toHaveLength(2);
            expect(features[0].geometry.coordinates[0]).toBeCloseTo(3, 12);
            expect(features[1].geometry.coordinates[0]).toBeCloseTo(3, 12);
        });
    });

    describe('line rebuilding', () => {
        it('rebuilds once at startup', () => {
            expect(harness([state(minuteTrack())]).lineWrites()).toBe(1);
        });

        it('does not rebuild while the playhead moves within a track', () => {
            const h = harness([state(minuteTrack())]);
            h.transport.seek(10 * S);
            h.transport.seek(20 * S);
            h.transport.seek(30 * S);
            expect(h.lineWrites()).toBe(1);
        });

        it('rebuilds when a track finishes', () => {
            const h = harness([state(minuteTrack())]);
            h.transport.seek(M);
            expect(h.lineWrites()).toBe(2);
        });

        it('marks the finished line as done', () => {
            const h = harness([state(minuteTrack())]);
            h.transport.seek(M);
            expect(h.lines()[0].properties.done).toBe(true);
        });

        it('rebuilds on an explicit redraw, for a basemap switch', () => {
            // A new style starts with empty sources, so the lines have to be fed
            // again even when nothing about the playhead has changed.
            const h = harness([state(minuteTrack())]);
            h.transport.seek(10 * S);
            h.transport.redraw();
            expect(h.lineWrites()).toBe(2);
        });

        it('rebuilds when the track set changes', () => {
            const h = harness([state(minuteTrack())]);
            h.setTracks([state(minuteTrack('a', 0)), state(minuteTrack('b', 2 * H))]);
            expect(h.lineWrites()).toBe(2);
        });
    });

    describe('changing the tracks', () => {
        it('keeps the position when a later track is added', () => {
            const h = harness([state(minuteTrack('a', 0))]);
            h.transport.seek(20 * S);
            h.setTracks([state(minuteTrack('a', 0)), state(minuteTrack('b', 2 * H))]);
            expect(h.transport.getElapsedMs()).toBe(20 * S);
        });

        it('keeps the position and playback when an earlier track is added', () => {
            // Under per-start alignment there is no origin that a new t0 can move,
            // so adding a ride recorded earlier changes nothing about where the
            // playhead is and must not interrupt a run in progress.
            const h = harness([state(minuteTrack('b', 2 * H))]);
            h.transport.seek(20 * S);
            h.transport.play();
            h.setTracks([state(minuteTrack('a', 0)), state(minuteTrack('b', 2 * H))]);
            expect(h.transport.getElapsedMs()).toBe(20 * S);
            expect(h.transport.isPlaying()).toBe(true);
        });

        it('clamps the position when the replacement set is shorter', () => {
            const long = makeTrack(
                'long',
                0,
                [0, 2 * H],
                [
                    [1, 47],
                    [5, 47],
                ],
            );
            const h = harness([state(long)]);
            h.transport.seek(H);
            h.setTracks([state(minuteTrack('a', 0))]);
            expect(h.transport.getElapsedMs()).toBe(MINUTE);
        });

        it('clears the readout when everything is removed', () => {
            const h = harness([state(minuteTrack())]);
            h.setTracks([]);
            expect(h.clockElement.textContent).toBe('0:00 / 0:00');
            expect(h.button.disabled).toBe(true);
        });
    });
});

describe('timelineStep', () => {
    it('divides a run into a fixed number of addressable positions', () => {
        // Otherwise a step of 1 ms would make the arrow keys useless on a
        // focused timeline: a hundred presses to cross a ten-second gap.
        expect(timelineStep(MINUTE)).toBe(60);
        expect(timelineStep(33 * H)).toBe(Math.round((33 * H) / 1000));
    });

    it('takes a thousand presses to cross the whole run, whatever its length', () => {
        for (const total of [4 * M, MINUTE, H, 33 * H]) {
            const presses = Math.ceil(total / timelineStep(total));
            expect(presses).toBeGreaterThanOrEqual(TIMELINE_STEPS);
            expect(presses).toBeLessThanOrEqual(TIMELINE_STEPS + 1);
        }
    });

    it('never steps below one millisecond', () => {
        expect(timelineStep(1)).toBe(1);
        expect(timelineStep(0)).toBe(1);
        expect(timelineStep(-5)).toBe(1);
    });
});

describe('the speed control', () => {
    it('is disabled until there is something to play', () => {
        expect(harness().speedSelect.disabled).toBe(true);
        expect(harness([state(minuteTrack())]).speedSelect.disabled).toBe(false);
    });

    it('runs the animation at the chosen rate', () => {
        const h = harness([state(minuteTrack())]);
        h.transport.play();
        h.frames.runFrames(6, 0, 100);
        expect(h.transport.getElapsedMs()).toBe(500);

        const fast = harness([state(minuteTrack())]);
        fast.speedSelect.choose('20');
        fast.transport.play();
        fast.frames.runFrames(6, 0, 100);
        // Same six frames of real time, twenty times as far along the ride.
        expect(fast.transport.getElapsedMs()).toBe(10_000);
        expect(fast.transport.getSpeed()).toBe(20);
    });

    it('clamps to the supported range', () => {
        const h = harness([state(minuteTrack())]);
        h.speedSelect.choose('9999');
        expect(h.transport.getSpeed()).toBe(MAX_SPEED);
        expect(h.speedSelect.value).toBe(String(MAX_SPEED));
    });

    it('corrects a value the clock refuses instead of leaving a lie on screen', () => {
        const h = harness([state(minuteTrack())]);
        h.speedSelect.choose('60');
        // An unknown option reports no value at all, which reaches the clock as
        // zero and is refused. The speed keeps what it was rather than being
        // thrown away by a stray keystroke, and the control is written back so it
        // cannot claim a speed the animation is not running at.
        h.speedSelect.choose('');
        expect(h.transport.getSpeed()).toBe(60);
        expect(h.speedSelect.value).toBe('60');
    });

    it('corrects a tampered value that is not a number', () => {
        const h = harness([state(minuteTrack())]);
        h.speedSelect.value = 'quickly';
        h.speedSelect.choose('quickly');
        expect(h.transport.getSpeed()).toBe(1);
        expect(h.speedSelect.value).toBe('1');
    });

    it('survives a pause', () => {
        const h = harness([state(minuteTrack())]);
        h.speedSelect.choose('120');
        h.transport.pause();
        h.transport.play();
        h.frames.runFrames(3, 0, 100);
        expect(h.transport.getSpeed()).toBe(120);
        expect(h.transport.getElapsedMs()).toBe(200 * 120);
    });

    it('survives a scrub', () => {
        const h = harness([state(minuteTrack())]);
        h.speedSelect.choose('5');
        h.timeline.slide(30_000);
        expect(h.transport.getElapsedMs()).toBe(30_000);
        expect(h.transport.getSpeed()).toBe(5);
    });

    it('survives a change of tracks', () => {
        const h = harness([state(minuteTrack())]);
        h.speedSelect.choose('60');
        h.setTracks([state(minuteTrack('b', 0))]);
        expect(h.transport.getSpeed()).toBe(60);
    });
});

describe('the timeline', () => {
    it('is disabled until there is something to play', () => {
        expect(harness().timeline.disabled).toBe(true);
        expect(harness([state(minuteTrack())]).timeline.disabled).toBe(false);
    });

    it('spans the whole run', () => {
        const h = harness([state(minuteTrack())]);
        expect(h.timeline.max).toBe(String(MINUTE));
        expect(h.timeline.step).toBe(String(timelineStep(MINUTE)));
    });

    it('follows the playhead', () => {
        const h = harness([state(minuteTrack())]);
        h.timeline.slide(20_000);
        expect(h.timeline.value).toBe('20000');
    });

    it('announces a readable position rather than milliseconds', () => {
        const h = harness([state(minuteTrack())]);
        h.timeline.slide(65_000 / 2);
        expect(h.timeline.attrs.get('aria-valuetext')).toBe('0:33 of 1:00');
    });

    it('scrubs as the handle is dragged, not only on release', () => {
        const h = harness([state(minuteTrack())]);
        h.timeline.slide(45_000);
        expect(h.transport.getElapsedMs()).toBe(45_000);
        h.timeline.slide(10_000);
        expect(h.transport.getElapsedMs()).toBe(10_000);
    });

    it('moves every marker while scrubbing', () => {
        const h = harness([state(minuteTrack())]);
        h.timeline.slide(MINUTE);
        expect(h.markers()[0]?.geometry.coordinates).toEqual([5, 47]);
    });

    it('is not fought by the playhead repainting the handle', () => {
        // A value write during a drag would snap the handle back under the
        // pointer, so the render must leave an unchanged value alone.
        const h = harness([state(minuteTrack())]);
        h.timeline.slide(45_000);
        expect(h.timeline.value).toBe('45000');
        h.timeline.slide(45_000);
        expect(h.timeline.value).toBe('45000');
    });

    it('keeps playing through a scrub', () => {
        const h = harness([state(minuteTrack())]);
        h.transport.play();
        h.timeline.slide(30_000);
        expect(h.transport.isPlaying()).toBe(true);
        // The clock rebaselines on the next frame rather than counting the
        // interval between the last frame and the seek.
        h.frames.runFrames(2, 0, 100);
        expect(h.transport.getElapsedMs()).toBe(30_100);
    });
});

describe('keyboard transport', () => {
    const loaded = () => harness([state(minuteTrack())]);

    it('toggles on space and on k', () => {
        const h = loaded();
        h.keys.press(' ');
        expect(h.transport.isPlaying()).toBe(true);
        h.keys.press(' ');
        expect(h.transport.isPlaying()).toBe(false);

        h.keys.press('k');
        expect(h.transport.isPlaying()).toBe(true);
    });

    it('stops the page scrolling on a key it acts on', () => {
        expect(loaded().keys.press(' ').defaultPrevented).toBe(true);
        expect(loaded().keys.press('a').defaultPrevented).toBe(false);
    });

    it('steps a percent of the run per arrow press', () => {
        const h = loaded();
        h.timeline.slide(0);
        h.keys.press('ArrowRight');
        expect(h.transport.getElapsedMs()).toBe(MINUTE * 0.01);
        h.keys.press('ArrowRight');
        expect(h.transport.getElapsedMs()).toBe(MINUTE * 0.02);
        h.keys.press('ArrowLeft');
        expect(h.transport.getElapsedMs()).toBe(MINUTE * 0.01);
    });

    it('steps five percent with shift', () => {
        const h = loaded();
        h.keys.press('ArrowRight', { shiftKey: true });
        expect(h.transport.getElapsedMs()).toBe(MINUTE * 0.05);
    });

    it('clamps a step that would run off either end', () => {
        const h = loaded();
        h.keys.press('ArrowLeft');
        expect(h.transport.getElapsedMs()).toBe(0);
        h.keys.press('End');
        expect(h.transport.getElapsedMs()).toBe(MINUTE);
        h.keys.press('ArrowRight', { shiftKey: true });
        expect(h.transport.getElapsedMs()).toBe(MINUTE);
    });

    it('jumps to the ends of the run', () => {
        const h = loaded();
        h.keys.press('End');
        expect(h.transport.getElapsedMs()).toBe(MINUTE);
        h.keys.press('Home');
        expect(h.transport.getElapsedMs()).toBe(0);
    });

    it('leaves a focused button alone, so space does not toggle twice', () => {
        const h = loaded();
        // Space on a focused button fires a click, which already toggles.
        h.keys.press(' ', { target: { tagName: 'BUTTON' } });
        expect(h.transport.isPlaying()).toBe(false);
    });

    it('leaves a focused timeline its own arrows, which already seek', () => {
        const h = loaded();
        h.keys.press('ArrowRight', { target: h.timeline });
        expect(h.transport.getElapsedMs()).toBe(0);
    });

    it('still takes space from a focused timeline', () => {
        // A range ignores Space, so without this the page would scroll and the
        // play button would be unreachable once a drag had left focus here.
        const h = loaded();
        expect(h.keys.press(' ', { target: h.timeline }).defaultPrevented).toBe(true);
        expect(h.transport.isPlaying()).toBe(true);
    });

    it('does not type into the file picker or scrub from it', () => {
        const h = loaded();
        h.keys.press('k', { target: { tagName: 'INPUT' } });
        h.keys.press('ArrowRight', { target: { tagName: 'SELECT' } });
        expect(h.transport.isPlaying()).toBe(false);
        expect(h.transport.getElapsedMs()).toBe(0);
    });

    it('does nothing with no tracks loaded', () => {
        const h = harness();
        h.keys.press('End');
        h.keys.press(' ');
        expect(h.transport.getElapsedMs()).toBe(0);
        expect(h.transport.isPlaying()).toBe(false);
    });
});

describe('subscribers', () => {
    it('are told about every redraw', () => {
        const h = harness([state(minuteTrack())]);
        let calls = 0;
        h.transport.subscribe(() => {
            calls += 1;
        });
        h.transport.seek(1000);
        expect(calls).toBeGreaterThan(0);
    });

    it('are told when the track set changes', () => {
        const h = harness();
        let calls = 0;
        h.transport.subscribe(() => {
            calls += 1;
        });
        h.setTracks([state(minuteTrack())]);
        expect(calls).toBeGreaterThan(0);
    });

    it('can unsubscribe', () => {
        const h = harness([state(minuteTrack())]);
        let calls = 0;
        const stop = h.transport.subscribe(() => {
            calls += 1;
        });
        h.transport.seek(1000);
        const after = calls;
        stop();
        h.transport.seek(2000);
        expect(calls).toBe(after);
    });
});

describe('tracks recorded at different times', () => {
    it('reads the total from the longest ride, not the widest time span', () => {
        // Two one-minute rides two hours apart: the run is one minute long.
        const h = harness([state(minuteTrack('a', 0)), state(minuteTrack('b', 2 * H))]);
        expect(h.clockElement.textContent).toBe('0:00 / 1:00');
    });

    it('exposes one shared elapsed time rather than a per-track one', () => {
        // There is no per-track time to read, because t0 never shifts the playhead.
        const h = harness([state(minuteTrack('a', 0)), state(minuteTrack('b', 2 * H))]);
        h.transport.seek(30 * S);
        expect(h.transport.getElapsedMs()).toBe(30 * S);
        expect(h.timeline.value).toBe('30000');
        expect(h.markers().map((f) => f.geometry.coordinates[0])).toEqual([3, 3]);
    });
});
