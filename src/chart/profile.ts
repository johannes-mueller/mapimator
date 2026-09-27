import type { Track } from '../types';

/** Which quantity the chart plots against distance. */
export type Metric = 'elevation' | 'speed';

/** One drawn point: how far along the ride, and what the metric read there. */
export interface ProfilePoint {
    distanceM: number;
    value: number;
}

/**
 * The total width of the window the speed is averaged over, in milliseconds, so
 * each sample is smoothed across half of it either side.
 *
 * Raw speed between two GPS fixes is mostly noise: a single noisy coordinate can
 * imply a sprint or a standstill that never happened. Averaging the distance
 * covered over a short window instead of dividing one gap by one interval gives
 * a number a rider would recognise. Fifteen seconds is wide enough to bury a bad
 * fix and narrow enough not to flatten a genuine effort; wider and a 30-second
 * sprint stops appearing in the profile at all.
 *
 * The window is centred, because the profile shows the whole ride and a value
 * that lagged behind the playhead would not sit on the line it is drawn on. A
 * trailing window would read half a minute late at the end of every ride.
 */
export const SPEED_WINDOW_MS = 15_000;

/**
 * The profile of one track: its metric sampled against distance, decimated to at
 * most `maxPoints` points.
 *
 * Decimation is not an optimisation the chart could do without. A 200,000-point
 * track has far more points than the panel has pixels, and building a path string
 * that long on every track change is the difference between instant and a visible
 * stall. Buckets are averaged rather than sampled, so a decimated profile is a
 * smoothed version of the real one rather than a subset of it: at a bucket about
 * one pixel wide the two are indistinguishable, and picking every Nth sample
 * would alias badly whenever a climb lands between the chosen ones.
 */
export function buildProfile(track: Track, metric: Metric, maxPoints: number): ProfilePoint[] {
    const count = track.lat.length;
    if (count === 0) {
        return [];
    }
    const values = metricValues(track, metric);
    if (count <= maxPoints) {
        return pointsFromSamples(track, values);
    }
    return pointsFromBuckets(track, values, maxPoints);
}

/**
 * The metric sampled at every fix, in the track's own order: elevation straight
 * from the file, speed smoothed over the window above.
 *
 * A profile decimates these into something a panel can draw, but a marker has to
 * report the ride's own value at the playhead rather than a bucket's average of
 * it, so the chart holds this array alongside the line it draws from. Recomputing
 * it per frame would be O(fixes) sixty times a second; it is built when the
 * profile is, which is when the metric or the track actually changes.
 */
export function metricValues(track: Track, metric: Metric): Float64Array {
    return metric === 'elevation' ? elevations(track) : speeds(track);
}

/**
 * The metric at a playhead position, from the per-fix values.
 *
 * Indexed by the same sample and fraction the map marker uses, so the two agree
 * without the chart having to search the track again. A position held on a single
 * sample — parked in a recorded pause, finished, or two fixes sharing a timestamp
 * — has a fraction of zero and so reads exactly that fix.
 *
 * This is deliberately *not* `valueAtDistance`. The two disagree wherever a ride
 * visited one distance more than once, which is every recorded pause: the distance
 * is the same at both ends of the stop, so a distance lookup can only return the
 * value from the first time past, and a rider standing at a junction would read
 * the speed they had while approaching it. Reading by time is what makes a
 * stationary ride show as stationary.
 */
export function valueAtTime(values: Float64Array, index: number, fraction: number): number {
    if (values.length === 0) {
        return 0;
    }
    const last = values.length - 1;
    const from = Math.min(Math.max(index, 0), last);
    const to = from + 1;
    // An index outside the track means the playhead is before the start or after the
    // end, and the answer is then that end's own value. Carrying the fraction across
    // the clamp would interpolate into a fix the playhead is nowhere near, which is
    // how a position before the start comes to read a third of the way to the second.
    if (index !== from || to >= values.length || fraction <= 0) {
        return values[from];
    }
    return values[from] + (values[to] - values[from]) * Math.min(fraction, 1);
}

/** The polyline's value at a distance: exact at a point, linear between two. */
export function valueAtDistance(points: ProfilePoint[], distanceM: number): number | null {
    if (points.length === 0) {
        return null;
    }
    if (points.length === 1 || distanceM <= points[0].distanceM) {
        return points[0].value;
    }
    const last = points[points.length - 1];
    if (distanceM >= last.distanceM) {
        return last.value;
    }
    for (let i = 1; i < points.length; i += 1) {
        const to = points[i];
        if (distanceM <= to.distanceM) {
            const from = points[i - 1];
            const span = to.distanceM - from.distanceM;
            if (span <= 0) {
                return to.value;
            }
            const t = (distanceM - from.distanceM) / span;
            return from.value + (to.value - from.value) * t;
        }
    }
    return last.value;
}

/**
 * The value span the y-axis has to cover, across every track on the chart.
 *
 * A flat range is widened deliberately rather than left as a zero-height axis: a
 * track with no elevation data at all still has to be drawable, and a line
 * squashed onto a single pixel is indistinguishable from no line.
 */
export function valueRange(profiles: ProfilePoint[][]): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    for (const points of profiles) {
        for (const { value } of points) {
            if (Number.isFinite(value)) {
                min = Math.min(min, value);
                max = Math.max(max, value);
            }
        }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return { min: 0, max: 1 };
    }
    if (max - min < 1e-9) {
        return { min: min - 0.5, max: max + 0.5 };
    }
    return { min, max };
}

/**
 * The farthest any track has travelled, which is where the x-axis ends.
 *
 * Repeat runs of one course are close to the same length, so the axis has to be
 * driven by the longest or the longest ride would run off the end of its own
 * chart.
 */
export function distanceRange(profiles: ProfilePoint[][]): number {
    let max = 0;
    for (const points of profiles) {
        const last = points[points.length - 1];
        if (last) {
            max = Math.max(max, last.distanceM);
        }
    }
    return max;
}

/**
 * The elapsed time at which a track first reached a distance — the inverse of
 * reading the playhead off a profile, and what makes a click on the chart able to
 * seek.
 *
 * `dist` is cumulative, so it never decreases and the answer is a single point on
 * the track. Distances outside the ride clamp to its ends: clicking past the end
 * of a chart means "the end", not "nowhere".
 *
 * A recorded pause leaves the distance unchanged across a run of samples, so the
 * answer for a distance inside that plateau is genuinely ambiguous — the ride was
 * there for as long as the stop lasted. This returns the moment it *arrived*,
 * which is the intuitive reading of "when did it reach here" and keeps a click
 * on the plateau rewinding to the start of the stop rather than skipping it.
 */
export function timeAtDistance(track: Track, distanceM: number): number {
    const count = track.dist.length;
    if (count === 0) {
        return 0;
    }
    const total = track.dist[count - 1];
    if (distanceM <= 0) {
        return 0;
    }
    if (distanceM >= total) {
        return track.tRel[count - 1] * 1000;
    }
    // The first index at or past the target, so the pair to interpolate across is
    // the one either side of it. `dist` never decreases, so this converges.
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (track.dist[mid] >= distanceM) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    const to = lo;
    if (to === 0) {
        return 0;
    }
    const from = to - 1;
    // `dist[from] < distanceM <= dist[to]`, so the span is positive by
    // construction and the fraction cannot divide by zero.
    const span = track.dist[to] - track.dist[from];
    const t = (distanceM - track.dist[from]) / span;
    const fromS = track.tRel[from];
    return (fromS + (track.tRel[to] - fromS) * t) * 1000;
}

const elevations = (track: Track): Float64Array => {
    const out = new Float64Array(track.ele.length);
    for (let i = 0; i < track.ele.length; i += 1) {
        out[i] = track.ele[i];
    }
    return out;
};

/**
 * Speed in metres per second at every sample, as the distance covered over a
 * window centred on it.
 *
 * The window is clipped at both ends of the ride rather than padded, so the value
 * at the start is the average over however much of the window exists. That is
 * what stops a ride from opening with a division by a half-second interval and a
 * spike to 40 m/s.
 */
const speeds = (track: Track): Float64Array => {
    const count = track.dist.length;
    const out = new Float64Array(count);
    if (count === 0) {
        return out;
    }
    const halfWindowS = SPEED_WINDOW_MS / 2000;
    // Sample times are seconds; walking them as such keeps this in the track's own
    // units and avoids a conversion per sample.
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < count; i += 1) {
        const t = track.tRel[i];
        while (lo < i && track.tRel[lo] < t - halfWindowS) {
            lo += 1;
        }
        while (hi + 1 < count && track.tRel[hi + 1] <= t + halfWindowS) {
            hi += 1;
        }
        if (hi < i) {
            hi = i;
        }
        if (lo > i) {
            lo = i;
        }
        const span = track.tRel[hi] - track.tRel[lo];
        if (span > 0) {
            out[i] = (track.dist[hi] - track.dist[lo]) / span;
        } else {
            // Every sample in the window shares one timestamp, so there is no rate
            // to report. Zero is the honest answer: nothing was covered over no
            // time, which is what a burst of duplicate fixes looks like.
            out[i] = 0;
        }
    }
    return out;
};

const pointsFromSamples = (track: Track, values: Float64Array): ProfilePoint[] => {
    const count = track.dist.length;
    const points: ProfilePoint[] = [];
    for (let i = 0; i < count; i += 1) {
        points.push({ distanceM: track.dist[i], value: values[i] });
    }
    return points;
};

/**
 * Average the samples into `maxPoints` buckets, each spanning a contiguous slice
 * of the ride. Buckets are cut by sample count rather than by distance so that a
 * track which spent most of its points crawling up one hill still gets a
 * representative value there.
 */
const pointsFromBuckets = (
    track: Track,
    values: Float64Array,
    maxPoints: number,
): ProfilePoint[] => {
    const count = track.dist.length;
    const points: ProfilePoint[] = [];
    const bucketSize = count / maxPoints;
    for (let b = 0; b < maxPoints; b += 1) {
        const start = Math.floor(b * bucketSize);
        const end = Math.min(count, Math.floor((b + 1) * bucketSize));
        if (end <= start) {
            continue;
        }
        let sum = 0;
        let n = 0;
        for (let i = start; i < end; i += 1) {
            sum += values[i];
            n += 1;
        }
        // A bucket is drawn at the distance of its own first sample rather than
        // the middle of the range it covers: averaging the value but placing the
        // point at the middle would inset the line at both ends, so the profile
        // would start a pixel or two in from the start line and stop short of the
        // finish — small, but it would misreport where the ride began and ended.
        // The final bucket is the exception, and takes its last sample, or the
        // ride's own end would be a whole bucket short of the last point drawn.
        const at = b === maxPoints - 1 ? end - 1 : start;
        points.push({
            distanceM: track.dist[at],
            value: n > 0 ? sum / n : 0,
        });
    }
    return points;
};
