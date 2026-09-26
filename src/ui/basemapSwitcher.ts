import { BASEMAPS } from '../map/basemaps';

export interface BasemapSwitcher {
    setActive: (id: string) => void;
}

export function createBasemapSwitcher(
    container: HTMLElement,
    onSelect: (id: string) => void,
    activeId: string,
): BasemapSwitcher {
    const buttons = new Map<string, HTMLButtonElement>();

    const setActive = (id: string): void => {
        for (const [basemapId, button] of buttons) {
            button.setAttribute('aria-pressed', String(basemapId === id));
        }
    };

    for (const basemap of BASEMAPS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = basemap.label;
        button.dataset.basemapId = basemap.id;
        button.addEventListener('click', () => {
            setActive(basemap.id);
            onSelect(basemap.id);
        });
        container.append(button);
        buttons.set(basemap.id, button);
    }

    setActive(activeId);
    return { setActive };
}
