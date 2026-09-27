import { describe, expect, it } from 'vitest';
import { MAX_SPEED, createPlaybackClock } from './clock';
import type { Track } from '../types';

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** A track with only the fields the clock reads. */
const track = (t0: number, durationMs: number, id = `t${t0}`): Track =>
    ({
        id,
        name: id,
        color: '#fff',
        t0,
        tRel: new Float64Array([0, durationMs]),
        lat: new Float64Array([0, 0]),
        lon: new Float64Array([0, 0]),
        ele: new Float32Array([0, 0]),
        dist: new Float32Array([0, 0]),
        segmentBreaks: new Uint32Array(0),
        durationMs,
        distanceM: 0,
        bounds: { minLon: 0, minLat: 0, maxLon: 0, maxLat: 0 },
        renderLine: [],
    }) as Track;

const clockWith = (tracks: Track[]) => {
    const clock = createPlaybackClock();
    clock.setTracks(tracks);
    return clock;
};

describe('createPlaybackClock', () => {
    it('starts stopped at zero', () => {
        const clock = clockWith([track(0, MINUTE)]);
        expect(clock.isPlaying()).toBe(false);
        expect(clock.getElapsedMs()).toBe(0);
    });

    it('has zero total with no tracks', () => {
        const clock = clockWith([]);
        expect(clock.getTotalMs()).toBe(0);
    });

    it('reports a single track duration as the total', () => {
        expect(clockWith([track(0, 90_000)]).getTotalMs()).toBe(90_000);
    });

    it('refuses to play with nothing loaded', () => {
        const clock = clockWith([]);
        clock.play();
        expect(clock.isPlaying()).toBe(false);
    });

    describe('ticking', () => {
        it('does not advance while paused', () => {
            const clock = clockWith([track(0, HOUR)]);
            clock.tick(1000);
            clock.tick(5000);
            expect(clock.getElapsedMs()).toBe(0);
        });

        it('advances by the real delta once playing', () => {
            const clock = clockWith([track(0, HOUR)]);
            clock.play();
            clock.tick(0);
            clock.tick(250);
            expect(clock.getElapsedMs()).toBe(250);
            clock.tick(1000);
            expect(clock.getElapsedMs()).toBe(1000);
        });

        it('does not count the interval before the first frame after play', () => {
            // The click and the next frame are separate moments; counting both
            // would advance the clock twice for the same wall time.
            const clock = clockWith([track(0, HOUR)]);
            clock.play();
            clock.tick(10_000);
            expect(clock.getElapsedMs()).toBe(0);
            clock.tick(10_016);
            expect(clock.getElapsedMs()).toBe(16);
        });

        it('does not count the time spent paused', () => {
            const clock = clockWith([track(0, HOUR)]);
            clock.play();
            clock.tick(0);
            clock.tick(100);
            clock.pause();
            clock.tick(60_000);
            expect(clock.getElapsedMs()).toBe(100);
            clock.play();
            clock.tick(60_000);
            clock.tick(60_050);
            expect(clock.getElapsedMs()).toBe(150);
        });

        it('advances by zero for a repeated timestamp', () => {
            const clock = clockWith([track(0, HOUR)]);
            clock.play();
            clock.tick(500);
            clock.tick(500);
            expect(clock.getElapsedMs()).toBe(0);
        });

        it('ignores a host clock that jumps backwards', () => {
            const clock = clockWith([track(0, HOUR)]);
            clock.play();
            clock.tick(0);
            clock.tick(1000);
            expect(clock.getElapsedMs()).toBe(1000);
            clock.tick(900);
            expect(clock.getElapsedMs()).toBe(1000);
        });

        it('resumes by real elapsed time after a long pause in the browser', () => {
            // A tab left open overnight should catch up, not drift.
            const clock = clockWith([track(0, 10 * HOUR)]);
            clock.play();
            clock.tick(0);
            clock.tick(3 * HOUR);
            expect(clock.getElapsedMs()).toBe(3 * HOUR);
        });

        it('stops at the total rather than running past the end', () => {
            const clock = clockWith([track(0, 1000)]);
            clock.play();
            clock.tick(0);
            clock.tick(99_999);
            expect(clock.getElapsedMs()).toBe(1000);
            expect(clock.isPlaying()).toBe(true);
        });
    });

    describe('speed', () => {
        it('defaults to 1x', () => {
            expect(clockWith([track(0, HOUR)]).getSpeed()).toBe(1);
        });

        it('multiplies the advance', () => {
            const clock = clockWith([track(0, HOUR)]);
            clock.setSpeed(300);
            clock.play();
            clock.tick(0);
            clock.tick(10);
            expect(clock.getElapsedMs()).toBe(3000);
        });

        it('clamps to the documented 300x ceiling', () => {
            const clock = clockWith([track(0, HOUR)]);
            clock.setSpeed(5000);
            expect(clock.getSpeed()).toBe(MAX_SPEED);
        });

        it('ignores a speed below 1x', () => {
            const clock = clockWith([track(0, HOUR)]);
            clock.setSpeed(0.25);
            expect(clock.getSpeed()).toBe(1);
        });

        it('ignores non-positive and non-finite speeds', () => {
            const clock = clockWith([track(0, HOUR)]);
            clock.setSpeed(20);
            clock.setSpeed(0);
            clock.setSpeed(-5);
            clock.setSpeed(Number.NaN);
            expect(clock.getSpeed()).toBe(20);
        });

        it('applies a speed change from the next frame, not retroactively', () => {
            const clock = clockWith([track(0, HOUR)]);
            clock.play();
            clock.tick(0);
            clock.tick(100);
            clock.setSpeed(10);
            clock.tick(200);
            expect(clock.getElapsedMs()).toBe(100 + 1000);
        });
    });

    describe('seeking', () => {
        it('jumps to an absolute time', () => {
            const clock = clockWith([track(0, HOUR)]);
            clock.seek(30_000);
            expect(clock.getElapsedMs()).toBe(30_000);
        });

        it('clamps below zero', () => {
            const clock = clockWith([track(0, HOUR)]);
            clock.seek(-5000);
            expect(clock.getElapsedMs()).toBe(0);
        });

        it('clamps above the total', () => {
            const clock = clockWith([track(0, 1000)]);
            clock.seek(99_999);
            expect(clock.getElapsedMs()).toBe(1000);
        });

        it('ignores a non-finite seek', () => {
            const clock = clockWith([track(0, HOUR)]);
            clock.seek(1000);
            clock.seek(Number.NaN);
            expect(clock.getElapsedMs()).toBe(0);
        });

        it('does not count the seek interval as played time', () => {
            // tick(0) and tick(100) play 100 ms, then the seek jumps to 10 s.
            // The following 20 s gap belongs to no interval played, so the clock
            // lands on 10.1 s rather than 30.1 s.
            const clock = clockWith([track(0, HOUR)]);
            clock.play();
            clock.tick(0);
            clock.tick(100);
            clock.seek(10_000);
            clock.tick(20_000);
            clock.tick(20_100);
            expect(clock.getElapsedMs()).toBe(10_100);
        });
    });

    describe('the shared clock across tracks', () => {
        it('spans every track, including the later ones', () => {
            const clock = clockWith([track(0, 600_000), track(2 * HOUR, 600_000)]);
            expect(clock.getTotalMs()).toBe(2 * HOUR + 600_000);
        });

        it('uses the earliest t0 as the shared origin, not the first added', () => {
            // The later ride is added first, so "first" and "earliest" differ and
            // picking the wrong one would give it a negative span.
            const late = track(2 * HOUR, 60_000);
            const early = track(0, 60_000);
            const clock = clockWith([late, early]);
            expect(clock.getTotalMs()).toBe(2 * HOUR + 60_000);
            clock.seek(0);
            expect(clock.getTrackTime(early)).toBe(0);
            expect(clock.getTrackTime(late)).toBe(-2 * HOUR);
        });

        it('gives a later track a negative local time until its offset passes', () => {
            // This is the whole point of the shared clock: a ride recorded two
            // hours later has not started yet at shared time zero, rather than
            // being yanked into step with the first one.
            const early = track(0, 60_000);
            const late = track(2 * HOUR, 60_000);
            const clock = clockWith([early, late]);
            clock.seek(0);
            expect(clock.getTrackTime(early)).toBe(0);
            expect(clock.getTrackTime(late)).toBe(-2 * HOUR);
            expect(clock.isTrackDone(late)).toBe(false);
            clock.seek(2 * HOUR);
            expect(clock.getTrackTime(late)).toBe(0);
            clock.seek(2 * HOUR + 30_000);
            expect(clock.getTrackTime(late)).toBe(30_000);
        });

        it('marks a track done once its own duration has passed', () => {
            const short = track(0, 60_000);
            const long = track(0, 2 * HOUR);
            const clock = clockWith([short, long]);
            clock.seek(59_000);
            expect(clock.isTrackDone(short)).toBe(false);
            clock.seek(60_000);
            expect(clock.isTrackDone(short)).toBe(true);
            expect(clock.isTrackDone(long)).toBe(false);
        });

        it('accounts for a later track when deciding it is done', () => {
            const late = track(2 * HOUR, 60_000);
            const clock = clockWith([late]);
            clock.seek(0);
            expect(clock.isTrackDone(late)).toBe(false);
            clock.seek(2 * HOUR + 60_000);
            expect(clock.isTrackDone(late)).toBe(true);
        });
    });

    describe('changing the track set', () => {
        it('shrinks the total when the longest track is removed', () => {
            const short = track(0, 60_000);
            const long = track(0, 2 * HOUR);
            const clock = clockWith([short, long]);
            expect(clock.getTotalMs()).toBe(2 * HOUR);
            clock.setTracks([short]);
            expect(clock.getTotalMs()).toBe(60_000);
        });

        it('clamps elapsed to the new total when a track is removed', () => {
            const short = track(0, 60_000);
            const long = track(0, 2 * HOUR);
            const clock = clockWith([short, long]);
            clock.seek(2 * HOUR);
            clock.setTracks([short]);
            expect(clock.getElapsedMs()).toBe(60_000);
        });

        it('keeps elapsed and playing when a later track is added', () => {
            // Dropping a second, later ride mid-playback must not interrupt the
            // first one: the origin is unchanged, so the elapsed time still means
            // the same moment.
            const clock = clockWith([track(0, HOUR)]);
            clock.seek(30_000);
            clock.play();
            clock.setTracks([track(0, HOUR), track(2 * HOUR, HOUR)]);
            expect(clock.getElapsedMs()).toBe(30_000);
            expect(clock.isPlaying()).toBe(true);
        });

        it('resets and pauses when an earlier track is added', () => {
            // An earlier t0 redefines the origin, so every track's offset changes
            // and the old elapsed time no longer refers to the same moment.
            const clock = clockWith([track(2 * HOUR, HOUR)]);
            clock.seek(30_000);
            clock.play();
            clock.setTracks([track(0, HOUR), track(2 * HOUR, HOUR)]);
            expect(clock.getElapsedMs()).toBe(0);
            expect(clock.isPlaying()).toBe(false);
        });

        it('resets and pauses when the earliest track is removed', () => {
            // Removing it moves the origin later, so the remaining tracks shift.
            const clock = clockWith([track(0, HOUR), track(2 * HOUR, HOUR)]);
            clock.seek(30_000);
            clock.play();
            clock.setTracks([track(2 * HOUR, HOUR)]);
            expect(clock.getElapsedMs()).toBe(0);
            expect(clock.isPlaying()).toBe(false);
        });

        it('keeps elapsed and playing when handed the same tracks again', () => {
            const tracks = [track(0, HOUR)];
            const clock = clockWith(tracks);
            clock.seek(30_000);
            clock.play();
            clock.setTracks(tracks);
            expect(clock.getElapsedMs()).toBe(30_000);
            expect(clock.isPlaying()).toBe(true);
        });

        it('resets to zero and stops when everything is cleared', () => {
            const clock = clockWith([track(0, HOUR)]);
            clock.seek(30_000);
            clock.play();
            clock.setTracks([]);
            expect(clock.getElapsedMs()).toBe(0);
            expect(clock.getTotalMs()).toBe(0);
            expect(clock.isPlaying()).toBe(false);
        });
    });

    describe('subscribe', () => {
        it('notifies on every change', () => {
            const clock = clockWith([track(0, HOUR)]);
            const seen: number[] = [];
            clock.subscribe((elapsed) => seen.push(elapsed));
            clock.seek(1000);
            clock.seek(2000);
            expect(seen).toEqual([1000, 2000]);
        });

        it('does not notify when a tick changes nothing', () => {
            const clock = clockWith([track(0, HOUR)]);
            let calls = 0;
            clock.subscribe(() => {
                calls += 1;
            });
            clock.tick(0);
            clock.tick(0);
            expect(calls).toBe(0);
        });

        it('stops notifying once unsubscribed', () => {
            const clock = clockWith([track(0, HOUR)]);
            let calls = 0;
            const off = clock.subscribe(() => {
                calls += 1;
            });
            off();
            clock.seek(1000);
            expect(calls).toBe(0);
        });
    });
});
