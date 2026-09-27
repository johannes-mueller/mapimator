import type { Track } from '../types';

/**
 * Where the playhead sits relative to a track.
 *
 * - `pending` — the playhead has not reached this track's start yet.
 * - `running` — between two samples, so the position is interpolated.
 * - `parked` — the playhead is inside a recorded pause, so the marker is held
 *   at the end of the segment it has just finished.
 * - `done` — the track has run out; the marker rests on its last point.
 */
export type PlaybackStatus = 'pending' | 'running' | 'parked' | 'done';

export interface TrackPosition {
    status: PlaybackStatus;
    lat: number;
    lon: number;
    ele: number;
    /** Fraction of the track's own duration elapsed: 0 before it starts, 1 after. */
    progress: number;
    /** Index of the sample the position was derived from. */
    index: number;
}

const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max);

/**
 * Where a marker should sit at a given time on a track's own timeline.
 *
 * `timeMs` is the track's local time, in milliseconds, i.e. the shared clock's
 * elapsed time less this track's offset. A negative value means the track has
 * not started. Note that `Track.tRel` is in seconds while `Track.durationMs` is
 * in milliseconds; the conversion happens once, here, so callers never mix them.
 *
 * The interesting case is a recorded pause. The parser records a segment break
 * for any gap over 60 s, and this function refuses to interpolate across one:
 * the marker sits on the last point of the finished segment for the whole length
 * of the gap, then resumes at the first point of the next one. Without that, a
 * marker would glide in a straight line across open country for the length of a
 * lunch break.
 *
 * Throws if the track has no samples, which the parser cannot produce but which
 * would otherwise surface as a marker at the uninitialised origin (0, 0).
 */
export function positionAt(track: Track, timeMs: number): TrackPosition {
    const count = track.lat.length;
    if (count === 0) {
        throw new Error(`positionAt called on a track with no samples: ${track.id}`);
    }

    const lastIndex = count - 1;
    const timeS = timeMs / 1000;

    if (timeMs < 0) {
        return { status: 'pending', ...sampleAt(track, 0), progress: 0 };
    }

    if (timeMs >= track.durationMs) {
        return { status: 'done', ...sampleAt(track, lastIndex), progress: 1 };
    }

    // Reached only when `timeMs < durationMs`, so `durationMs > 0` holds here
    // and the fraction cannot divide by zero.
    const progress = clamp(timeS / (track.durationMs / 1000), 0, 1);
    const from = lastIndexAtOrBefore(track, timeS, lastIndex);
    if (from === lastIndex) {
        // Only reachable if `durationMs` outruns the final sample, which the
        // parser cannot produce but which would otherwise read past the end of
        // every array and put a NaN marker on the map.
        return { status: 'running', ...sampleAt(track, lastIndex), progress };
    }
    const to = from + 1;

    // A break at `to` means the span between these two samples is a recorded
    // pause rather than travel, so hold at `from` instead of crossing it.
    if (isSegmentStart(track, to)) {
        return { status: 'parked', ...sampleAt(track, from), progress };
    }

    // `to` is in range and its time is at or after `from`'s by construction of
    // the search, so `span` is non-negative. A zero span means two samples share
    // a timestamp; there is nothing to interpolate between, so hold the earlier
    // one rather than divide by zero.
    const span = track.tRel[to] - track.tRel[from];
    const fraction = span > 0 ? clamp((timeS - track.tRel[from]) / span, 0, 1) : 0;

    return {
        status: 'running',
        lat: track.lat[from] + (track.lat[to] - track.lat[from]) * fraction,
        lon: track.lon[from] + (track.lon[to] - track.lon[from]) * fraction,
        ele: track.ele[from] + (track.ele[to] - track.ele[from]) * fraction,
        progress,
        index: from,
    };
}

function sampleAt(
    track: Track,
    index: number,
): Pick<TrackPosition, 'lat' | 'lon' | 'ele' | 'index'> {
    return { lat: track.lat[index], lon: track.lon[index], ele: track.ele[index], index };
}

/** Largest index whose `tRel` is at or before `timeS`. Assumes `tRel` is sorted. */
function lastIndexAtOrBefore(track: Track, timeS: number, lastIndex: number): number {
    let low = 0;
    let high = lastIndex;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (track.tRel[mid] <= timeS) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return low;
}

function isSegmentStart(track: Track, index: number): boolean {
    for (const start of track.segmentBreaks) {
        if (start === index) {
            return true;
        }
    }
    return false;
}
