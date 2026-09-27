import { formatDistance, formatDuration } from '../format';
import { distanceAt, positionAt } from './interpolate';
import type { TrackPosition } from './interpolate';
import type { Track } from '../types';

/**
 * The track's own elapsed time at a position.
 *
 * A moving marker's time is the playhead's. A held one is not: a marker parked
 * in a recorded pause is sitting on a sample at the end of the segment it has
 * finished, so its time is that sample's, and a finished marker is on the last
 * one. Reading the playhead instead would put the number somewhere the marker
 * has not been, which is the sort of small lie that makes a comparison panel
 * untrustworthy.
 */
export function markerTimeMs(track: Track, position: TrackPosition, playheadMs: number): number {
    if (position.status === 'running') {
        return playheadMs;
    }
    return track.tRel[position.index] * 1000;
}

/**
 * The live per-track readout: how long that track has been going, and how far
 * it has got.
 *
 * Both figures describe where the marker is, not where the playhead is, so the
 * legend and the map can never disagree. A time before the start is reported as
 * zero rather than as a negative, since a marker clamped to the start has
 * genuinely not travelled yet.
 */
export function readoutText(track: Track, timeMs: number): string {
    const position = positionAt(track, timeMs);
    const time = Math.max(0, markerTimeMs(track, position, timeMs));
    return `${formatDuration(time)} · ${formatDistance(distanceAt(track, position))}`;
}
