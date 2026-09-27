/** A marker's position on screen, in CSS pixels relative to the map container. */
export interface ScreenPoint {
    x: number;
    y: number;
}

/**
 * How much of each axis, as a fraction of that axis's own size, is left as a
 * margin a marker can move around in before the camera nudges it back. 0.15
 * means the safe area is the middle 70% of the viewport.
 */
export const FOLLOW_MARGIN_RATIO = 0.15;

/**
 * The minimal camera pan, in screen pixels, that brings every marker back
 * inside the margin — or `null` when they already all are.
 *
 * Every marker is checked independently rather than as a group, so a single
 * ride is followed exactly the same way as several: whichever one is furthest
 * past the margin on a given side decides the correction for that side, and
 * pulling it back only ever helps the others, since they were closer to safe
 * already. Only a pan is ever proposed, never a zoom — a marker at the edge is
 * pulled back to the edge of the margin, not to the centre, so the camera does
 * the least it can to keep it in view.
 *
 * Two markers past *opposite* edges of the same axis by equal amounts cannot
 * both be satisfied by one pan: the corrections cancel exactly, and the camera
 * holds still rather than oscillating between them. That is an accepted limit
 * of following by panning alone, not a bug.
 */
export function computeFollowPan(
    markers: ScreenPoint[],
    width: number,
    height: number,
    marginRatio: number = FOLLOW_MARGIN_RATIO,
): { dx: number; dy: number } | null {
    if (markers.length === 0 || !(width > 0) || !(height > 0)) {
        return null;
    }

    const marginX = width * marginRatio;
    const marginY = height * marginRatio;

    let overRight = 0;
    let overLeft = 0;
    let overBottom = 0;
    let overTop = 0;
    for (const { x, y } of markers) {
        overRight = Math.max(overRight, x - (width - marginX));
        overLeft = Math.max(overLeft, marginX - x);
        overBottom = Math.max(overBottom, y - (height - marginY));
        overTop = Math.max(overTop, marginY - y);
    }

    const dx = overRight - overLeft;
    const dy = overBottom - overTop;
    if (dx === 0 && dy === 0) {
        return null;
    }
    return { dx, dy };
}
