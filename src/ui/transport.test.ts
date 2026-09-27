import { describe, expect, it } from 'vitest';
import { createTransport } from './transport';
import type { Track, TrackState } from '../types';

const S = 1000;
const M = 60_000;
const H = 3_600_000;

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

        it('spans the whole shared timeline for tracks recorded far apart', () => {
            const h = harness([state(minuteTrack('a', 0)), state(minuteTrack('b', 2 * H))]);
            expect(h.clockElement.textContent).toBe('0:00 / 2:01:00');
        });
    });

    describe('markers', () => {
        it('moves the marker as the clock advances', () => {
            const h = harness([state(minuteTrack())]);
            h.transport.seek(30 * S);
            expect(h.markers()[0].geometry.coordinates[0]).toBeCloseTo(3, 12);
        });

        it('hides a track that has not started and shows it once reached', () => {
            const h = harness([state(minuteTrack('a', 0)), state(minuteTrack('b', 2 * H))]);
            expect(h.markers().map((f) => f.properties.trackId)).toEqual(['a']);
            h.transport.seek(2 * H);
            expect(h.markers().map((f) => f.properties.trackId)).toEqual(['a', 'b']);
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

        it('resets when an earlier track is added', () => {
            const h = harness([state(minuteTrack('b', 2 * H))]);
            h.transport.seek(20 * S);
            h.transport.play();
            h.setTracks([state(minuteTrack('a', 0)), state(minuteTrack('b', 2 * H))]);
            expect(h.transport.getElapsedMs()).toBe(0);
            expect(h.transport.isPlaying()).toBe(false);
        });

        it('clears the readout when everything is removed', () => {
            const h = harness([state(minuteTrack())]);
            h.setTracks([]);
            expect(h.clockElement.textContent).toBe('0:00 / 0:00');
            expect(h.button.disabled).toBe(true);
        });
    });
});
