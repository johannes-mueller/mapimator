/** Human-readable helpers for the legend and the chart readouts. */

export function formatDistance(meters: number): string {
    if (!Number.isFinite(meters)) {
        return '—';
    }
    if (meters < 1000) {
        return `${Math.round(meters)} m`;
    }
    return `${(meters / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`;
}

/** `h:mm:ss`, or `m:ss` when the track is under an hour. */
export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) {
        return '—';
    }
    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (value: number): string => String(value).padStart(2, '0');

    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function formatPointCount(count: number): string {
    return count.toLocaleString();
}

/**
 * Metres, switching to kilometres above 1000 m the way `formatDistance` does, so
 * a chart axis and a legend row never describe the same number two ways.
 */
export function formatElevation(meters: number): string {
    if (!Number.isFinite(meters)) {
        return '—';
    }
    if (Math.abs(meters) < 1000) {
        return `${Math.round(meters)} m`;
    }
    return `${(meters / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`;
}

/**
 * Metres per second, switching to km/h above 3 m/s.
 *
 * The switch is at walking pace on purpose. Below it, `m/s` is the unit anyone
 * would say out loud — "two and a half" — and above it the same number in km/h is
 * the one a bike computer shows.
 */
export function formatSpeed(metersPerSecond: number): string {
    if (!Number.isFinite(metersPerSecond)) {
        return '—';
    }
    if (Math.abs(metersPerSecond) < 3) {
        return `${metersPerSecond.toFixed(1)} m/s`;
    }
    return `${(metersPerSecond * 3.6).toLocaleString(undefined, { maximumFractionDigits: 1 })} km/h`;
}

/**
 * The two labels at the ends of an elevation axis, in one unit.
 *
 * `formatElevation` is right for a single number, where switching to kilometres
 * makes 1400 m easier to read. An axis is not a single number: it is two, and they
 * have to be comparable at a glance, so the unit is chosen once from whichever end
 * is further from zero and then applied to both. A speed axis from 0 to 5.4 m/s
 * labelled "19.5 km/h" at the top and "0.0 m/s" at the bottom is asking the reader
 * to convert between the labels to compare them, which is the one thing an axis
 * exists to avoid.
 */
export function elevationAxisLabels(min: number, max: number): [string, string] {
    const [lo, hi] = ordered(min, max);
    const kilometers = Math.max(Math.abs(lo), Math.abs(hi)) >= 1000;
    const format = kilometers
        ? (m: number) => `${(m / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`
        : (m: number) => `${Math.round(m)} m`;
    return [format(hi), format(lo)];
}

/** The two labels at the ends of a speed axis, in one unit. See `elevationAxisLabels`. */
export function speedAxisLabels(min: number, max: number): [string, string] {
    const [lo, hi] = ordered(min, max);
    const kmh = Math.max(Math.abs(lo), Math.abs(hi)) >= 3;
    const format = kmh
        ? (mps: number) =>
              `${(mps * 3.6).toLocaleString(undefined, { maximumFractionDigits: 1 })} km/h`
        : (mps: number) => `${mps.toFixed(1)} m/s`;
    return [format(hi), format(lo)];
}

/**
 * The two labels at the ends of a distance axis, in one unit. A ride reads "0 m" at
 * one end and "5.0 km" at the other under `formatDistance`, which is the same
 * problem the value axes have.
 */
export function distanceAxisLabels(min: number, max: number): [string, string] {
    const [lo, hi] = ordered(min, max);
    const kilometers = Math.max(Math.abs(lo), Math.abs(hi)) >= 1000;
    const format = kilometers
        ? (m: number) => `${(m / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`
        : (m: number) => `${Math.round(m)} m`;
    return [format(hi), format(lo)];
}

/** The ends of a range, ascending, with the higher end first as an axis draws them. */
function ordered(min: number, max: number): [number, number] {
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return [0, 0];
    }
    return min <= max ? [min, max] : [max, min];
}
