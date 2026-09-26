import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    BASEMAPS,
    DEFAULT_BASEMAP_ID,
    isBasemapId,
    readStoredBasemapId,
    resolveBasemap,
    writeStoredBasemapId,
} from './basemaps';

/** Minimal localStorage stand-in; the real one is absent in the Node env. */
const stubStorage = (initial: Record<string, string> = {}) => {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, value),
        removeItem: (key: string) => void data.delete(key),
        clear: () => data.clear(),
        key: (i: number) => [...data.keys()][i] ?? null,
        get length() {
            return data.size;
        },
    };
};

const useStorage = (initial: Record<string, string> = {}) => {
    const storage = stubStorage(initial);
    vi.stubGlobal('localStorage', storage);
    return storage;
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('BASEMAPS', () => {
    it('exposes exactly the five documented styles, in switcher order', () => {
        expect(BASEMAPS.map((b) => b.id)).toEqual([
            'liberty',
            'positron',
            'bright',
            'fiord',
            'dark',
        ]);
    });

    it('gives every style a non-empty label and https style URL', () => {
        for (const basemap of BASEMAPS) {
            expect(basemap.label.length).toBeGreaterThan(0);
            expect(basemap.styleUrl.startsWith('https://')).toBe(true);
        }
    });

    it('has a unique style URL per style', () => {
        const urls = BASEMAPS.map((b) => b.styleUrl);
        expect(new Set(urls).size).toBe(urls.length);
    });

    it('defaults to Liberty', () => {
        expect(DEFAULT_BASEMAP_ID).toBe('liberty');
        expect(BASEMAPS[0].id).toBe(DEFAULT_BASEMAP_ID);
    });
});

describe('isBasemapId', () => {
    it('accepts a known id', () => {
        expect(isBasemapId('dark')).toBe(true);
    });

    it('rejects null', () => {
        expect(isBasemapId(null)).toBe(false);
    });

    it('rejects an unknown id', () => {
        expect(isBasemapId('satellite')).toBe(false);
    });

    it('rejects the label, which is not the id', () => {
        expect(isBasemapId('Dark')).toBe(false);
    });
});

describe('resolveBasemap', () => {
    it('resolves a known id', () => {
        expect(resolveBasemap('fiord').id).toBe('fiord');
    });

    it('falls back to the default for an unknown id', () => {
        expect(resolveBasemap('nope').id).toBe(DEFAULT_BASEMAP_ID);
    });

    it('falls back to the default for null', () => {
        expect(resolveBasemap(null).id).toBe(DEFAULT_BASEMAP_ID);
    });
});

describe('readStoredBasemapId', () => {
    it('returns the default when nothing is stored', () => {
        useStorage();
        expect(readStoredBasemapId()).toBe(DEFAULT_BASEMAP_ID);
    });

    it('returns a stored valid id', () => {
        useStorage({ 'mapimator.basemap': 'positron' });
        expect(readStoredBasemapId()).toBe('positron');
    });

    it('ignores a stored value that is no longer a known style', () => {
        // A style removed from BASEMAPS must not break start-up.
        useStorage({ 'mapimator.basemap': 'satellite' });
        expect(readStoredBasemapId()).toBe(DEFAULT_BASEMAP_ID);
    });

    it('returns the default when localStorage throws', () => {
        // Private browsing modes can make even reading localStorage throw.
        vi.stubGlobal('localStorage', {
            getItem: () => {
                throw new Error('SecurityError');
            },
            setItem: () => {
                throw new Error('SecurityError');
            },
        });
        expect(readStoredBasemapId()).toBe(DEFAULT_BASEMAP_ID);
    });
});

describe('writeStoredBasemapId', () => {
    it('round-trips through readStoredBasemapId', () => {
        useStorage();
        writeStoredBasemapId('bright');
        expect(readStoredBasemapId()).toBe('bright');
    });

    it('does not throw when localStorage rejects writes', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => null,
            setItem: () => {
                throw new Error('QuotaExceededError');
            },
        });
        expect(() => writeStoredBasemapId('dark')).not.toThrow();
    });
});
