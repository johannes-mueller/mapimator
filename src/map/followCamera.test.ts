import { describe, expect, it } from 'vitest';
import { computeFollowPan } from './followCamera';

const W = 1000;
const H = 800;
// With the default 0.15 margin, the safe box is [150, 850] x [120, 680].
const MARGIN_X = W * 0.15;
const MARGIN_Y = H * 0.15;

describe('computeFollowPan', () => {
    it('proposes nothing when there are no markers', () => {
        expect(computeFollowPan([], W, H)).toBeNull();
    });

    it('proposes nothing for a marker in the middle of the box', () => {
        expect(computeFollowPan([{ x: W / 2, y: H / 2 }], W, H)).toBeNull();
    });

    it('treats the margin line itself as safe', () => {
        expect(
            computeFollowPan(
                [
                    { x: MARGIN_X, y: H / 2 },
                    { x: W - MARGIN_X, y: H / 2 },
                    { x: W / 2, y: MARGIN_Y },
                    { x: W / 2, y: H - MARGIN_Y },
                ],
                W,
                H,
            ),
        ).toBeNull();
    });

    it('pans right by exactly the overflow when a marker is past the right margin', () => {
        expect(computeFollowPan([{ x: W - MARGIN_X + 12, y: H / 2 }], W, H)).toEqual({
            dx: 12,
            dy: 0,
        });
    });

    it('pans left by exactly the overflow when a marker is past the left margin', () => {
        expect(computeFollowPan([{ x: MARGIN_X - 9, y: H / 2 }], W, H)).toEqual({
            dx: -9,
            dy: 0,
        });
    });

    it('pans down by exactly the overflow when a marker is past the bottom margin', () => {
        expect(computeFollowPan([{ x: W / 2, y: H - MARGIN_Y + 30 }], W, H)).toEqual({
            dx: 0,
            dy: 30,
        });
    });

    it('pans up by exactly the overflow when a marker is past the top margin', () => {
        expect(computeFollowPan([{ x: W / 2, y: MARGIN_Y - 5 }], W, H)).toEqual({
            dx: 0,
            dy: -5,
        });
    });

    it('combines both axes when a marker overflows a corner', () => {
        expect(computeFollowPan([{ x: W - MARGIN_X + 12, y: H - MARGIN_Y + 30 }], W, H)).toEqual({
            dx: 12,
            dy: 30,
        });
    });

    it('follows the worse of two markers past the same edge, not their average', () => {
        expect(
            computeFollowPan(
                [
                    { x: W - MARGIN_X + 5, y: H / 2 },
                    { x: W - MARGIN_X + 40, y: H / 2 },
                ],
                W,
                H,
            ),
        ).toEqual({ dx: 40, dy: 0 });
    });

    it('holds still when two markers overflow opposite edges by equal amounts', () => {
        // Fixing one would push the other exactly as far past the other edge, so
        // no pan is proposed rather than one that helps one marker and hurts the
        // other.
        expect(
            computeFollowPan(
                [
                    { x: W - MARGIN_X + 20, y: H / 2 },
                    { x: MARGIN_X - 20, y: H / 2 },
                ],
                W,
                H,
            ),
        ).toBeNull();
    });

    it('corrects only the axis that needs it when the other axis cancels', () => {
        expect(
            computeFollowPan(
                [
                    { x: W - MARGIN_X + 20, y: H - MARGIN_Y + 15 },
                    { x: MARGIN_X - 20, y: H / 2 },
                ],
                W,
                H,
            ),
        ).toEqual({ dx: 0, dy: 15 });
    });

    it('proposes nothing for a viewport with no laid-out size yet', () => {
        expect(computeFollowPan([{ x: 10, y: 10 }], 0, 0)).toBeNull();
        expect(computeFollowPan([{ x: 10, y: 10 }], -100, 800)).toBeNull();
    });

    it('respects a different margin ratio', () => {
        // Well inside the default 0.15 margin...
        const marker = [{ x: W / 2 + 100, y: H / 2 }];
        expect(computeFollowPan(marker, W, H)).toBeNull();
        // ...but outside a much tighter one, at the same position.
        expect(computeFollowPan(marker, W, H, 0.49)).toEqual({ dx: 90, dy: 0 });
    });
});
