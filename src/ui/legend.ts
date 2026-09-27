import { formatDistance, formatDuration, formatPointCount } from '../format';
import type { Track, TrackState } from '../types';

/** How the legend gets the live per-track values, injected so it stays pure DOM. */
export interface LegendLive {
    /** The shared clock's elapsed time projected onto this track's own timeline. */
    getTrackTime: (track: Track) => number;
    /** The line to show for a track at a given local time. */
    readout: (track: Track, timeMs: number) => string;
}

export interface Legend {
    render: (states: TrackState[]) => void;
    /** Rewrites only the live values; call on every clock change. */
    updateReadouts: () => void;
}

export function createLegend(
    container: HTMLElement,
    onRemove: (id: string) => void,
    live?: LegendLive,
): Legend {
    let states: TrackState[] = [];
    const readoutElements = new Map<string, HTMLElement>();

    /**
     * The rows are written in place rather than rebuilt. A rebuild per frame
     * would be thrown away sixty times a second and, worse, would move the
     * remove button out from under a pointer that was heading for it.
     */
    const updateReadouts = (): void => {
        if (!live) {
            return;
        }
        for (const { track } of states) {
            const element = readoutElements.get(track.id);
            if (!element) {
                continue;
            }
            const text = live.readout(track, live.getTrackTime(track));
            if (element.textContent !== text) {
                element.textContent = text;
            }
        }
    };

    const render = (next: TrackState[]): void => {
        states = next;
        readoutElements.clear();
        container.replaceChildren();

        if (states.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'placeholder';
            empty.textContent = 'No tracks yet — drop a GPX file to begin.';
            container.append(empty);
            return;
        }

        const list = document.createElement('ul');
        list.className = 'legend-list';

        for (const { track } of states) {
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
            meta.textContent = [
                `${formatPointCount(track.lat.length)} pts`,
                formatDistance(track.distanceM),
                formatDuration(track.durationMs),
            ].join(' · ');

            text.append(name, meta);

            if (live) {
                const readout = document.createElement('span');
                readout.className = 'legend-readout';
                text.append(readout);
                readoutElements.set(track.id, readout);
            }

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'legend-remove';
            remove.setAttribute('aria-label', `Remove ${track.name}`);
            remove.textContent = '×';
            remove.addEventListener('click', () => {
                onRemove(track.id);
            });

            item.append(swatch, text, remove);
            list.append(item);
        }

        container.append(list);
        // Written through the same path the clock uses, so the first frame is
        // never drawn with an empty readout that later corrects itself.
        updateReadouts();
    };

    return { render, updateReadouts };
}
