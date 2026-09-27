/** Human-readable helpers for the legend and (later) the chart readouts. */

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
