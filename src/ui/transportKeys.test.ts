import { describe, expect, it } from 'vitest';
import { acceptsTransportKey, keyAction, NUDGE_PERCENT, NUDGE_PERCENT_FAST } from './transportKeys';

const H = 3_600_000;
const TOTAL = 30 * H;

const el = (tagName: string, extra: Record<string, unknown> = {}) => ({
    tagName,
    ...extra,
});

describe('keyAction', () => {
    it('toggles on both space and k', () => {
        for (const key of [' ', 'Spacebar', 'k', 'K']) {
            expect(keyAction(key, false, TOTAL)).toEqual({ kind: 'toggle' });
        }
    });

    it('nudges by a percent of the total, so one gesture fits every ride', () => {
        expect(keyAction('ArrowRight', false, TOTAL)).toEqual({
            kind: 'nudge',
            percent: NUDGE_PERCENT,
        });
        expect(keyAction('ArrowLeft', false, TOTAL)).toEqual({
            kind: 'nudge',
            percent: -NUDGE_PERCENT,
        });
    });

    it('nudges further with shift', () => {
        expect(keyAction('ArrowRight', true, TOTAL)).toEqual({
            kind: 'nudge',
            percent: NUDGE_PERCENT_FAST,
        });
        expect(keyAction('ArrowLeft', true, TOTAL)).toEqual({
            kind: 'nudge',
            percent: -NUDGE_PERCENT_FAST,
        });
    });

    it('has a five-times jump, not a differently signed one', () => {
        expect(NUDGE_PERCENT_FAST / NUDGE_PERCENT).toBe(5);
    });

    it('jumps to the ends of the run', () => {
        expect(keyAction('Home', false, TOTAL)).toEqual({ kind: 'seek', ms: 0 });
        expect(keyAction('End', false, TOTAL)).toEqual({ kind: 'seek', ms: TOTAL });
    });

    it('ignores keys it has no binding for', () => {
        for (const key of ['a', 'Escape', 'Tab', 'F5', 'PageUp', 'ArrowUp', 'ArrowDown']) {
            expect(keyAction(key, false, TOTAL)).toBeNull();
        }
    });

    it('leaves the arrow keys free for the speed control and the page', () => {
        // Up and down are unbound so they can mean "faster" and "slower" later,
        // and so they keep scrolling a page that has anything to scroll.
        expect(keyAction('ArrowUp', false, TOTAL)).toBeNull();
        expect(keyAction('ArrowDown', true, TOTAL)).toBeNull();
    });
});

describe('acceptsTransportKey', () => {
    const timeline = el('INPUT');

    it('takes every binding when nothing is focused', () => {
        expect(acceptsTransportKey(null, timeline, 'ArrowRight')).toBe(true);
        expect(acceptsTransportKey(el('BODY'), timeline, ' ')).toBe(true);
        expect(acceptsTransportKey({}, timeline, 'Home')).toBe(true);
    });

    it('leaves buttons alone, so space does not toggle twice', () => {
        // Space on a focused button already fires a click, which toggles.
        expect(acceptsTransportKey(el('BUTTON'), timeline, ' ')).toBe(false);
        expect(acceptsTransportKey(el('BUTTON'), timeline, 'k')).toBe(false);
    });

    it('leaves selects, textareas and links alone', () => {
        for (const tag of ['SELECT', 'TEXTAREA', 'OPTION', 'A']) {
            expect(acceptsTransportKey(el(tag), timeline, 'ArrowRight')).toBe(false);
            expect(acceptsTransportKey(el(tag), timeline, ' ')).toBe(false);
        }
    });

    it('leaves the file picker alone, so typing does not scrub', () => {
        const picker = el('INPUT');
        expect(acceptsTransportKey(picker, timeline, 'ArrowRight')).toBe(false);
        expect(acceptsTransportKey(picker, timeline, 'k')).toBe(false);
    });

    it('leaves the timeline arrows to the browser, which already seeks', () => {
        // The browser's own range stepping reaches the same seek through an
        // `input` event; acting here too would move the playhead twice.
        expect(acceptsTransportKey(timeline, timeline, 'ArrowRight')).toBe(false);
        expect(acceptsTransportKey(timeline, timeline, 'Home')).toBe(false);
        expect(acceptsTransportKey(timeline, timeline, 'End')).toBe(false);
    });

    it('still takes space from the timeline, which does nothing with it', () => {
        // A range ignores Space, so without this the page would scroll and the
        // play button would be unreachable after a drag left focus here.
        expect(acceptsTransportKey(timeline, timeline, ' ')).toBe(true);
        expect(acceptsTransportKey(timeline, timeline, 'Spacebar')).toBe(true);
    });

    it('stays out of anything being edited', () => {
        expect(acceptsTransportKey(el('DIV', { isContentEditable: true }), timeline, 'k')).toBe(
            false,
        );
        expect(acceptsTransportKey(el('SPAN', { isContentEditable: false }), timeline, 'k')).toBe(
            true,
        );
    });

    it('does not take Space from the timeline twice over when both are the same node', () => {
        // Guards the identity check: a same-shaped object that is not the
        // timeline must not inherit its exception.
        const lookalike = el('INPUT');
        expect(acceptsTransportKey(lookalike, timeline, ' ')).toBe(false);
    });
});
