import { SHOT_DIR } from './harness.mjs';

const MAP_REGION = { x: 380, y: 130, w: 620, h: 360 };
const STYLES = [
    { label: 'Liberty', dark: false },
    { label: 'Positron', dark: false },
    { label: 'Bright', dark: false },
    { label: 'Fiord', dark: false },
    { label: 'Dark', dark: true },
];

/** Counts distinct colours and mean luma in a screen region. */
async function analyze(page, region) {
    const png = (await page.screenshot()).toString('base64');
    return page.evaluate(
        async ({ png, region }) => {
            const img = new Image();
            img.src = `data:image/png;base64,${png}`;
            await img.decode();
            const off = new OffscreenCanvas(region.w, region.h);
            const ctx = off.getContext('2d');
            ctx.drawImage(img, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
            const { data } = ctx.getImageData(0, 0, region.w, region.h);
            const counts = new Map();
            let luma = 0;
            for (let i = 0; i < data.length; i += 4) {
                const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
                counts.set(key, (counts.get(key) ?? 0) + 1);
                luma += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
            }
            const total = data.length / 4;
            return {
                exactColors: counts.size,
                dominantShare: Number((Math.max(...counts.values()) / total).toFixed(3)),
                meanLuma: Number((luma / total).toFixed(1)),
            };
        },
        { png, region },
    );
}

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

        const px = await analyze(page, MAP_REGION);
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
