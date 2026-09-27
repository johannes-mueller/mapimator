/**
 * Track colours. Every entry is a mid-to-light hue that stays readable on the
 * light basemaps (Positron, Bright) *and* the dark ones (Fiord, Dark), which is
 * the constraint that rules out the very dark and very pale ends of the
 * spectrum that a purely hue-distinct palette would reach for.
 */
export const TRACK_COLORS = [
    '#e5484d',
    '#ff8b3d',
    '#f5c518',
    '#8ac926',
    '#30a46c',
    '#12a594',
    '#30a8e0',
    '#4d63f0',
    '#8e4ec6',
    '#d6409f',
    '#b07a5a',
    '#8b8f98',
] as const;

export function trackColorFor(index: number): string {
    return TRACK_COLORS[index % TRACK_COLORS.length];
}
