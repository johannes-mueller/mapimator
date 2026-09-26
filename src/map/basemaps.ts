import type { BasemapDef } from '../types';

const OFM_STYLES = 'https://tiles.openfreemap.org/styles';

export const BASEMAPS: readonly BasemapDef[] = [
    { id: 'liberty', label: 'Liberty', styleUrl: `${OFM_STYLES}/liberty` },
    { id: 'positron', label: 'Positron', styleUrl: `${OFM_STYLES}/positron` },
    { id: 'bright', label: 'Bright', styleUrl: `${OFM_STYLES}/bright` },
    { id: 'fiord', label: 'Fiord', styleUrl: `${OFM_STYLES}/fiord` },
    { id: 'dark', label: 'Dark', styleUrl: `${OFM_STYLES}/dark` },
];

export const DEFAULT_BASEMAP_ID = 'liberty';

const STORAGE_KEY = 'mapimator.basemap';

export function isBasemapId(value: string | null): value is string {
    return value !== null && BASEMAPS.some((b) => b.id === value);
}

export function resolveBasemap(id: string | null): BasemapDef {
    const found = BASEMAPS.find((b) => b.id === id);
    return found ?? BASEMAPS.find((b) => b.id === DEFAULT_BASEMAP_ID)!;
}

export function readStoredBasemapId(): string {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return isBasemapId(stored) ? stored : DEFAULT_BASEMAP_ID;
    } catch {
        return DEFAULT_BASEMAP_ID;
    }
}

export function writeStoredBasemapId(id: string): void {
    try {
        localStorage.setItem(STORAGE_KEY, id);
    } catch {
        return;
    }
}
