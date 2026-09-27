/**
 * Keyboard transport, kept as pure functions so the bindings can be tested
 * without a browser. The only DOM-aware part is `acceptsTransportKey`, which is
 * still a pure decision given the event target.
 */

export type TransportKeyAction =
    | { kind: 'toggle' }
    | { kind: 'seek'; ms: number }
    /** A move relative to where the playhead is now, in percent of the total. */
    | { kind: 'nudge'; percent: number };

/** One arrow press, as a share of the whole run. */
export const NUDGE_PERCENT = 1;
export const NUDGE_PERCENT_FAST = 5;

const isSpace = (key: string): boolean => key === ' ' || key === 'Spacebar';

/**
 * Maps a key press to a transport action, or `null` if the key is not ours.
 *
 * The arrow steps are a percentage of the total rather than a fixed number of
 * seconds, so one learned gesture behaves the same on a four-minute clip and on
 * a thirty-hour ride: an arrow press always moves the playhead a visible
 * fraction of the way along. A fixed ten seconds would be invisible on a long
 * recording and a huge jump on a short one.
 */
export function keyAction(
    key: string,
    shiftKey: boolean,
    totalMs: number,
): TransportKeyAction | null {
    switch (key) {
        case ' ':
        case 'Spacebar':
        case 'k':
        case 'K':
            return { kind: 'toggle' };
        case 'ArrowRight':
            return {
                kind: 'nudge',
                percent: shiftKey ? NUDGE_PERCENT_FAST : NUDGE_PERCENT,
            };
        case 'ArrowLeft':
            return {
                kind: 'nudge',
                percent: shiftKey ? -NUDGE_PERCENT_FAST : -NUDGE_PERCENT,
            };
        case 'Home':
            return { kind: 'seek', ms: 0 };
        case 'End':
            return { kind: 'seek', ms: totalMs };
        default:
            return null;
    }
}

/** Keys a focused element handles itself, which we must not handle twice. */
const OWN_KEYS = new Set(['BUTTON', 'SELECT', 'TEXTAREA', 'OPTION', 'A']);

/**
 * Whether a key press aimed at `target` should be handled by the transport.
 *
 * The form controls all react to keys themselves, and handling a key here as
 * well would act twice: Space on the focused play button fires a click *and*
 * would toggle again, and the arrows on a focused timeline would move the range
 * by its step *and* nudge the clock.
 *
 * The timeline is the exception that proves the rule. Its arrows are left alone,
 * because the browser's own range stepping is already exactly the right
 * behaviour and it is routed to the same seek. Space is taken from it, though,
 * because a range does nothing with Space and the page would scroll instead —
 * and after a drag the timeline holds focus, which would otherwise make the
 * play button unreachable by keyboard.
 */
export function acceptsTransportKey(target: unknown, timeline: unknown, key: string): boolean {
    const element = target as { tagName?: string; isContentEditable?: boolean } | null;
    if (!element) {
        return true;
    }
    if (element.isContentEditable) {
        return false;
    }
    const tag = element.tagName;
    if (!tag) {
        // The document or the body: nothing is focused, so every binding is free.
        return true;
    }
    if (OWN_KEYS.has(tag)) {
        return false;
    }
    if (tag === 'INPUT') {
        return target === timeline && isSpace(key);
    }
    return true;
}
