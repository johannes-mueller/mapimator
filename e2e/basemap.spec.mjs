import { SHOT_DIR, analyzeRegion } from './harness.mjs';

const MAP_REGION = { x: 380, y: 130, w: 620, h: 360 };
const STYLES = [
    { label: 'Liberty', dark: false },
    { label: 'Positron', dark: false },
    { label: 'Bright', dark: false },
    { label: 'Fiord', dark: false },
    { label: 'Dark', dark: true },
];

/** This spec drives only the shell and the basemap switcher, so it loads no GPX. */
export const fixtures = [];

export async function run({ page, suite, errors, url }) {
    suite.section('SHELL');
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.mapimator?.areTrackLayersAttached(), null, {
        timeout: 30_000,
    });
    await page.waitForFunction(() => window.mapimator.map.areTilesLoaded(), null, {
        timeout: 30_000,
    });
    await page.waitForTimeout(1200);

    const shell = await page.evaluate(() => {
        const ids = [
            'map',
            'topbar',
            'basemap-switcher',
            'github-link',
            'sidebar',
            'dropzone',
            'file-input',
            'legend-region',
            'chart-region',
            'playback-bar',
            'play-toggle',
            'speed-select',
            'timeline',
            'clock',
        ];
        const link = document.getElementById('github-link');
        return {
            missing: ids.filter((id) => !document.getElementById(id)),
            buttons: [...document.querySelectorAll('#basemap-switcher button')].map(
                (b) => b.textContent,
            ),
            title: document.title,
            activeButton: document.querySelector('#basemap-switcher button[aria-pressed="true"]')
                ?.textContent,
            attribution:
                document.querySelector('.maplibregl-ctrl-attrib')?.textContent?.trim() ?? '',
            controlsDisabled: [
                document.getElementById('play-toggle').disabled,
                document.getElementById('speed-select').disabled,
                document.getElementById('timeline').disabled,
            ],
            githubLink: {
                href: link?.getAttribute('href'),
                target: link?.getAttribute('target'),
                rel: link?.getAttribute('rel'),
                label: link?.getAttribute('aria-label'),
                iconHidden: link?.querySelector('svg')?.getAttribute('aria-hidden'),
            },
        };
    });

    suite.check('all shell elements present', shell.missing.length === 0, shell.missing.join(','));
    suite.check('title', shell.title === 'Mapimator', shell.title);
    suite.check(
        '5 basemap buttons in order',
        shell.buttons.join('|') === 'Liberty|Positron|Bright|Fiord|Dark',
        shell.buttons.join('|'),
    );
    suite.check(
        'Liberty marked active',
        shell.activeButton === 'Liberty',
        String(shell.activeButton),
    );
    suite.check(
        'attribution credits OpenStreetMap',
        /OpenStreetMap/i.test(shell.attribution),
        shell.attribution.slice(0, 70),
    );
    suite.check('attribution credits OpenFreeMap', /openfreemap/i.test(shell.attribution));
    suite.check(
        'playback controls disabled with no tracks',
        shell.controlsDisabled.every(Boolean),
        JSON.stringify(shell.controlsDisabled),
    );
    // A real address, not a placeholder, and opened without handing the new tab
    // a `window.opener` back into this one.
    suite.check(
        'the GitHub link points at the real repo, opened safely in a new tab',
        shell.githubLink.href === 'https://github.com/johannes-mueller/mapimator' &&
            shell.githubLink.target === '_blank' &&
            shell.githubLink.rel === 'noopener noreferrer',
        JSON.stringify(shell.githubLink),
    );
    suite.check(
        'and it has a name a screen reader can announce, since the icon alone has none',
        shell.githubLink.label === 'Mapimator on GitHub' && shell.githubLink.iconHidden === 'true',
        JSON.stringify(shell.githubLink),
    );

    const cam0 = await page.evaluate(() => {
        const c = window.mapimator.map.getCenter();
        return { lng: c.lng, lat: c.lat, zoom: window.mapimator.map.getZoom() };
    });

    suite.section('BASEMAP SWITCHING');
    for (const [i, style] of STYLES.entries()) {
        if (i > 0) {
            await page.click(`#basemap-switcher button:text-is("${style.label}")`);
            await page.waitForFunction(() => window.mapimator.map.isStyleLoaded(), null, {
                timeout: 30_000,
            });
            await page.waitForFunction(() => window.mapimator.map.areTilesLoaded(), null, {
                timeout: 30_000,
            });
            await page.waitForTimeout(1000);
        }

        const state = await page.evaluate(() => {
            const map = window.mapimator.map;
            const c = map.getCenter();
            return {
                attached: window.mapimator.areTrackLayersAttached(),
                basemap: window.mapimator.getBasemapId(),
                layerCount: map.getStyle().layers.length,
                markers: Boolean(map.getSource('track-markers')),
                lines: Boolean(map.getSource('track-lines')),
                lng: c.lng,
                lat: c.lat,
                zoom: map.getZoom(),
                pressed: document.querySelector('#basemap-switcher button[aria-pressed="true"]')
                    ?.textContent,
            };
        });

        const px = await analyzeRegion(page, MAP_REGION);
        suite.note(
            `${style.label.padEnd(9)} layers=${String(state.layerCount).padStart(3)} ` +
                `colors=${String(px.exactColors).padStart(5)} luma=${String(px.meanLuma).padStart(5)} ` +
                `dominant=${px.dominantShare}`,
        );

        suite.check(
            `${style.label}: basemap id applied`,
            state.basemap === style.label.toLowerCase(),
            state.basemap,
        );
        suite.check(
            `${style.label}: button pressed state`,
            state.pressed === style.label,
            String(state.pressed),
        );
        suite.check(
            `${style.label}: track layers re-attached`,
            state.attached && state.markers && state.lines,
        );
        suite.check(
            `${style.label}: camera held`,
            Math.abs(state.lng - cam0.lng) < 1e-6 &&
                Math.abs(state.lat - cam0.lat) < 1e-6 &&
                Math.abs(state.zoom - cam0.zoom) < 1e-6,
            `z${state.zoom}`,
        );
        suite.check(
            `${style.label}: tiles painted (not blank)`,
            px.exactColors > 100,
            `${px.exactColors} exact colors`,
        );
        suite.check(
            `${style.label}: not a flat screen`,
            px.dominantShare < 0.9,
            `dominant ${px.dominantShare * 100}%`,
        );
        suite.check(
            `${style.label}: luma matches ${style.dark ? 'dark' : 'light'} style`,
            style.dark ? px.meanLuma < 80 : px.meanLuma > 80,
            `meanLuma ${px.meanLuma}`,
        );

        await page.screenshot({
            path: `${SHOT_DIR}/${String(i)}-${style.label.toLowerCase()}.png`,
        });
    }

    suite.section('PERSISTENCE');
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.mapimator?.areTrackLayersAttached(), null, {
        timeout: 30_000,
    });
    const persisted = await page.evaluate(() => ({
        basemap: window.mapimator.getBasemapId(),
        stored: localStorage.getItem('mapimator.basemap'),
        pressed: document.querySelector('#basemap-switcher button[aria-pressed="true"]')
            ?.textContent,
    }));
    suite.check(
        'basemap persisted across reload',
        persisted.basemap === 'dark' && persisted.stored === 'dark',
        JSON.stringify(persisted),
    );
    suite.check(
        'active button correct after reload',
        persisted.pressed === 'Dark',
        String(persisted.pressed),
    );

    suite.section('CONSOLE');
    const realErrors = errors.filter((e) => !/favicon/i.test(e));
    suite.check(
        'no console errors across all switches',
        realErrors.length === 0,
        realErrors.slice(0, 3).join(' || '),
    );
}
