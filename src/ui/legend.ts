import { formatDistance, formatDuration, formatPointCount } from '../format';
import type { Track, TrackState } from '../types';

/** How the legend gets the live per-track values, injected so it stays pure DOM. */
export interface LegendLive {
    /** The shared elapsed time, which is every track's own time as well. */
    getElapsedMs: () => number;
    /** The line to show for a track at a given time. */
    readout: (track: Track, timeMs: number) => string;
}

export interface Legend {
    render: (states: TrackState[]) => void;
    /** Rewrites only the live values; call on every clock change. */
    updateReadouts: () => void;
}

/** The elements one row is made of, kept so a row can be rewritten in place. */
interface Row {
    item: HTMLLIElement;
    swatch: HTMLSpanElement;
    name: HTMLSpanElement;
    meta: HTMLSpanElement;
    readout: HTMLSpanElement | null;
    toggle: HTMLButtonElement;
    remove: HTMLButtonElement;
}

export function createLegend(
    container: HTMLElement,
    onRemove: (id: string) => void,
    onToggle: (id: string) => void,
    live?: LegendLive,
): Legend {
    let states: TrackState[] = [];
    const rows = new Map<string, Row>();
    let list: HTMLUListElement | null = null;

    /**
     * The rows are written in place rather than rebuilt, whenever the same rows
     * are still on show. A rebuild throws away the button the pointer — or the
     * keyboard focus — is on: a toggle clicked with the keyboard would leave
     * focus on nothing at all, because the element that had it was replaced by
     * an identical one. Rows are only built from scratch when the set of runs
     * changes, which is the one case where there is nothing to preserve.
     */
    const buildRow = (track: Track, earliestT0: number): Row => {
        const item = document.createElement('li');
        item.className = 'legend-item';
        item.dataset.trackId = track.id;

        const swatch = document.createElement('span');
        swatch.className = 'legend-swatch';
        swatch.style.setProperty('--track-color', track.color);

        const text = document.createElement('span');
        text.className = 'legend-text';

        const name = document.createElement('span');
        name.className = 'legend-name';
        // Track names come from a user-supplied file, so they are only ever
        // set as text, never parsed as markup.
        name.textContent = track.name;
        name.title = track.name;

        const meta = document.createElement('span');
        meta.className = 'legend-meta';

        text.append(name, meta);

        let readout: HTMLSpanElement | null = null;
        if (live) {
            readout = document.createElement('span');
            readout.className = 'legend-readout';
            text.append(readout);
        }

        // Drawn as text rather than as an icon font or an image, so it is the
        // same shape in every state and needs no separate asset. The label
        // carries the meaning for a screen reader, and the pressed state carries
        // it for everyone, so the glyph is decoration either way.
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'legend-toggle';
        toggle.textContent = 'Shown';
        toggle.addEventListener('click', () => {
            onToggle(track.id);
        });

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'legend-remove';
        remove.textContent = '×';
        remove.addEventListener('click', () => {
            onRemove(track.id);
        });

        item.append(swatch, text, toggle, remove);

        const startOffset = track.t0 - earliestT0;
        meta.textContent = [
            `${formatPointCount(track.lat.length)} pts`,
            formatDistance(track.distanceM),
            formatDuration(track.durationMs),
            startOffset > 0 ? `recorded ${formatDuration(startOffset)} later` : null,
        ]
            .filter((part): part is string => part !== null)
            .join(' · ');

        return { item, swatch, name, meta, readout, toggle, remove };
    };

    /** Writes everything about a row that can change while the row is on screen. */
    const updateRow = (row: Row, state: TrackState): void => {
        const { track, visible } = state;
        row.name.textContent = track.name;
        row.name.title = track.name;
        row.swatch.style.setProperty('--track-color', track.color);
        // aria-pressed is the state of the toggle itself: pressed means the run
        // is on the map. The label says what pressing it will do, which is the
        // opposite question and the one a name has to answer.
        row.toggle.setAttribute('aria-pressed', String(visible));
        row.toggle.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} ${track.name}`);
        row.toggle.textContent = visible ? 'Shown' : 'Hidden';
        row.item.classList.toggle('legend-item-hidden', !visible);
    };

    const updateReadouts = (): void => {
        if (!live) {
            return;
        }
        for (const state of states) {
            const row = rows.get(state.track.id);
            if (!row?.readout) {
                continue;
            }
            const text = live.readout(state.track, live.getElapsedMs());
            if (row.readout.textContent !== text) {
                row.readout.textContent = text;
            }
        }
    };

    const renderEmpty = (): void => {
        rows.clear();
        list = null;
        const empty = document.createElement('p');
        empty.className = 'placeholder';
        empty.textContent = 'No runs yet — drop a GPX file to begin.';
        container.replaceChildren(empty);
    };

    const render = (next: TrackState[]): void => {
        states = next;

        if (states.length === 0) {
            renderEmpty();
            return;
        }

        // Playback measures every run from its own first point, so the markers
        // start together whatever the timestamps said. The gap between the
        // recordings is still a fact about the files worth showing, measured
        // against the earliest one rather than spread into a call that would
        // overflow on a very large set.
        let earliestT0 = Infinity;
        for (const { track } of states) {
            earliestT0 = Math.min(earliestT0, track.t0);
        }

        // The list is built once and kept. Replacing it would take every row with
        // it, and a row that is detached takes the keyboard focus on it with it —
        // so a toggle pressed with the keyboard would lose focus on every press,
        // which is the whole reason the rows are written in place.
        if (!list) {
            list = document.createElement('ul');
            list.className = 'legend-list';
            container.replaceChildren(list);
        }

        const wanted = new Set<string>();
        states.forEach((state, index) => {
            const id = state.track.id;
            wanted.add(id);
            const existing = rows.get(id);
            const row = existing ?? buildRow(state.track, earliestT0);
            if (!existing) {
                rows.set(id, row);
            }
            updateRow(row, state);
            // Moved only when it is genuinely in the wrong place. Moving a node
            // that is already where it belongs would be a change with no visible
            // result and one real cost: the browser drops focus.
            if (list?.children[index] !== row.item) {
                list?.insertBefore(row.item, list?.children[index] ?? null);
            }
        });

        for (const id of [...rows.keys()]) {
            if (!wanted.has(id)) {
                rows.get(id)?.item.remove();
                rows.delete(id);
            }
        }
        // Written through the same path the clock uses, so the first frame is
        // never drawn with an empty readout that later corrects itself.
        updateReadouts();
    };

    return { render, updateReadouts };
}
