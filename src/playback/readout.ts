import { formatDistance, formatDuration } from '../format';
import { distanceAt, positionAt } from './interpolate';
import type { TrackPosition } from './interpolate';
import type { Track } from '../types';

/** Shown for a track the playhead has not reached yet. */
export const PENDING_READOUT = '—';

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
 * legend and the map can never disagree.
 */
export function readoutText(track: Track, timeMs: number): string {
    const position = positionAt(track, timeMs);
    if (position.status === 'pending') {
        return PENDING_READOUT;
    }
    const time = markerTimeMs(track, position, timeMs);
    return `${formatDuration(time)} · ${formatDistance(distanceAt(track, position))}`;
}
