import { formatDistance, formatDuration, formatPointCount } from '../format';
import type { TrackState } from '../types';

export interface Legend {
    render: (states: TrackState[]) => void;
}

export function createLegend(container: HTMLElement, onRemove: (id: string) => void): Legend {
    const render = (states: TrackState[]): void => {
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
    };

    return { render };
}
