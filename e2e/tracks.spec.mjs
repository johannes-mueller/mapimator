import { join } from 'node:path';
import { SHOT_DIR, countDifferent, regionPixels } from './harness.mjs';

const MAP_REGION = { x: 400, y: 150, w: 700, h: 400 };

/** A frame gap this wide means the main thread was busy for a visible stretch. */
const SLOW_FRAME_MS = 250;
/** The freeze bound for the 6.1 MB load: past this the page was genuinely blocked. */
const BLOCKED_FRAME_MS = 500;

/** Plain-object snapshot of the store, so no typed arrays cross the bridge. */
const summarize = () =>
    window.mapimator.store.getAll().map(({ track, visible }) => ({
        id: track.id,
        name: track.name,
        color: track.color,
        visible,
        points: track.lat.length,
        lat0: track.lat[0],
        lon0: track.lon[0],
        ele0: track.ele[0],
        t0: track.t0,
        tRelEnd: track.tRel[track.tRel.length - 1],
        distEnd: track.dist[track.dist.length - 1],
        distanceM: track.distanceM,
        breaks: Array.from(track.segmentBreaks),
        renderLen: track.renderLine.length,
        bounds: { ...track.bounds },
    }));

/**
 * Reads the rendered geometry back out of the GeoJSON source. MapLibre v6
 * stores source data keyed by type, so this is `{ geojson: <FeatureCollection> }`
 * rather than the collection itself.
 */
const features = () => {
    const src = window.mapimator.map.getSource('track-lines');
    if (!src) {
        return null;
    }
    const raw = src._data;
    const data = raw && raw.geojson ? raw.geojson : raw;
    if (!data || data.type !== 'FeatureCollection') {
        return null;
    }
    return {
        count: data.features.length,
        items: data.features.map((f) => ({
            type: f.geometry.type,
            color: f.properties.color,
            trackId: f.properties.trackId,
            done: f.properties.done,
            name: f.properties.name,
            lines: f.geometry.coordinates.length,
            firstLen: f.geometry.coordinates[0]?.length ?? 0,
            head: f.geometry.coordinates[0]?.[0] ?? null,
        })),
    };
};

const load = async (page, dir, ...names) => {
    await page.setInputFiles(
        '#file-input',
        names.map((n) => join(dir, n)),
    );
    // setBusy(false) always writes the attribute, so compare its value.
    await page.waitForFunction(
        () => document.getElementById('dropzone').getAttribute('aria-busy') !== 'true',
        null,
        { timeout: 60_000 },
    );
    // One more frame so the redraw from the store subscription has landed.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
};

/** Every GPX fixture this spec loads through the real file input. */
export const fixtures = [
    'ride.gpx',
    'two-tracks.gpx',
    'gaps.gpx',
    'notime.gpx',
    'twoseg.gpx',
    'messy.gpx',
    'latin1.gpx',
    'waypoints-only.gpx',
    'garbage.gpx',
    'routes-only.gpx',
    'notes.txt',
    'bulk.gpx',
];

export async function run({ page, suite, errors, url, fixtures: fixtureDir }) {
    // This suite pins recorded altitudes — the <elevation> check below asserts
    // one exactly — so the elevation model is blocked rather than left to race
    // them. The app upgrades a track's altitude the moment a model answers, and
    // on a fast runner that answer lands inside another check, turning a parser
    // check into a coin flip (a shared CI runner saw it land mid-check once).
    // Blocked, the recorded value is the only elevation there is — the same
    // arrangement the terrain suite uses to prove recorded altitudes survive.
    await page.route('**/elevation-tiles-prod/**', (route) => route.abort());

    suite.section('EMPTY STATE');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.mapimator.areTrackLayersAttached(), null, {
        timeout: 30_000,
    });
    await page.waitForFunction(() => window.mapimator.map.areTilesLoaded(), null, {
        timeout: 30_000,
    });

    const rows0 = await page.locator('.legend-item').count();
    const emptyText = (await page.locator('#legend-region').innerText()).trim();
    suite.check('no legend rows initially', rows0 === 0, `rows=${rows0}`);
    suite.check('empty-state message shown', /no runs yet/i.test(emptyText), emptyText);
    const f0 = await page.evaluate(features);
    suite.check('lines source exists and is empty', f0?.count === 0, String(f0?.count));

    suite.section('BASIC PARSE');
    await load(page, fixtureDir, 'ride.gpx');
    const all = await page.evaluate(summarize);
    const ride = all[0];
    suite.check('one track loaded', all.length === 1, `count=${all.length}`);
    suite.check('name from <name>', ride?.name === 'Morning Ride', ride?.name);
    suite.check('five points', ride?.points === 5, String(ride?.points));
    suite.check('color assigned', /^#[0-9a-f]{6}$/i.test(ride?.color ?? ''), ride?.color);
    suite.check(
        't0 is 2024-03-01T08:00Z',
        ride?.t0 === Date.parse('2024-03-01T08:00:00Z'),
        String(ride?.t0),
    );
    suite.check('tRel runs to 4 minutes', ride?.tRelEnd === 240, `tRelEnd=${ride?.tRelEnd}`);
    suite.check('distance accumulated', ride?.distEnd > 1000, `${ride?.distEnd} m`);
    suite.check(
        'no spurious segment breaks',
        ride?.breaks.length === 0,
        JSON.stringify(ride?.breaks),
    );
    suite.check(
        'renderLine is 2 values per point',
        ride?.renderLen === 10,
        String(ride?.renderLen),
    );
    suite.check('bounds match data', ride?.bounds.minLat === 47.37, JSON.stringify(ride?.bounds));
    suite.check(
        'summary distance agrees with the last stored sample',
        ride?.distanceM === ride?.distEnd,
        `${ride?.distanceM} vs ${ride?.distEnd}`,
    );

    const rows1 = await page.locator('.legend-item').count();
    suite.check('legend shows the track', rows1 === 1, `rows=${rows1}`);
    const meta = (await page.locator('.legend-meta').first().innerText()).trim();
    suite.check('legend meta shows pts/km/time', /pts/.test(meta) && /km/.test(meta), meta);
    const swatch = await page
        .locator('.legend-swatch')
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor);
    suite.check('swatch painted with track colour', swatch === 'rgb(229, 72, 77)', swatch);

    suite.section('GEOMETRY ON THE MAP');
    const f1 = await page.evaluate(features);
    suite.check('one feature in lines source', f1?.count === 1, String(f1?.count));
    suite.check(
        'geometry is MultiLineString',
        f1?.items[0]?.type === 'MultiLineString',
        f1?.items[0]?.type,
    );
    suite.check(
        'positions grouped per line',
        f1?.items[0]?.lines === 1,
        `lines=${f1?.items[0]?.lines}`,
    );
    suite.check(
        '5 positions in the line',
        f1?.items[0]?.firstLen === 5,
        `len=${f1?.items[0]?.firstLen}`,
    );
    suite.check(
        'position is [lon, lat]',
        f1?.items[0]?.head?.[0] === 8.54,
        JSON.stringify(f1?.items[0]?.head),
    );
    suite.check('feature carries done=false', f1?.items[0]?.done === false);

    suite.section('POLYLINE ACTUALLY PAINTS');
    // Compare with the camera held still: the map has already fitted itself to
    // the track, so the only thing that can change the pixels is the overlay.
    const withTrack = await regionPixels(page, MAP_REGION);
    await page.locator('.legend-remove').first().click();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    await page.waitForTimeout(600);
    const withoutTrack = await regionPixels(page, MAP_REGION);
    const changed = countDifferent(withTrack, withoutTrack);
    suite.check('removing the track changes the map pixels', changed > 300, `${changed} px differ`);
    // Put it back for the checks that follow.
    await load(page, fixtureDir, 'ride.gpx');
    await page.screenshot({ path: `${SHOT_DIR}/tracks-loaded.png` });

    suite.section('MULTIPLE TRACKS');
    await load(page, fixtureDir, 'two-tracks.gpx');
    const multi = await page.evaluate(summarize);
    suite.check('now three tracks', multi.length === 3, `count=${multi.length}`);
    const names = multi.map((t) => t.name);
    suite.check(
        'two <trk> became two tracks',
        names.includes('Track A') && names.includes('Track B'),
        names.join(', '),
    );
    suite.check('each track a distinct colour', new Set(multi.map((t) => t.color)).size === 3);
    const fMulti = await page.evaluate(features);
    suite.check('three features rendered', fMulti?.count === 3, String(fMulti?.count));

    suite.section('SEGMENT BREAKS');
    await load(page, fixtureDir, 'gaps.gpx');
    const gappy = (await page.evaluate(summarize)).find((t) => t.name === 'Gappy');
    suite.check(
        '2h gap recorded as one break at index 2',
        JSON.stringify(gappy?.breaks) === '[2]',
        JSON.stringify(gappy?.breaks),
    );
    const gFeat = (await page.evaluate(features)).items.find((i) => i.name === 'Gappy');
    suite.check('gap splits the line into 2 parts', gFeat?.lines === 2, `lines=${gFeat?.lines}`);

    await load(page, fixtureDir, 'twoseg.gpx');
    const twoSeg = (await page.evaluate(summarize)).find((t) => t.name === 'Two Segs');
    suite.check(
        'explicit <trkseg> recorded as a break',
        JSON.stringify(twoSeg?.breaks) === '[2]',
        JSON.stringify(twoSeg?.breaks),
    );

    await load(page, fixtureDir, 'notime.gpx');
    const noTime = (await page.evaluate(summarize)).find((t) => t.name === 'No Timestamps');
    suite.check(
        'untimed track still gets a duration',
        noTime?.tRelEnd > 0,
        `tRelEnd=${noTime?.tRelEnd}`,
    );
    suite.check(
        'untimed track gets no time-gap breaks',
        noTime?.breaks.length === 0,
        JSON.stringify(noTime?.breaks),
    );

    suite.section('AWKWARD BUT VALID');
    await load(page, fixtureDir, 'messy.gpx');
    const afterMessy = await page.evaluate(summarize);
    const messy = afterMessy.find((t) => t.name?.includes('Messy'));
    suite.check(
        'CDATA + entity in name decoded',
        messy?.name === 'Messy & weird Track',
        messy?.name,
    );
    suite.check(
        'single-quoted attrs parsed',
        messy?.lat0 === 47 && messy?.lon0 === 8,
        `lat0=${messy?.lat0} lon0=${messy?.lon0}`,
    );
    suite.check('<elevation> read as elevation', messy?.ele0 === 450, String(messy?.ele0));
    suite.check('empty <trk> skipped', !afterMessy.some((t) => t.name === 'Empty'));
    suite.check(
        'time gap in <time> forward-filled',
        messy?.tRelEnd === 60,
        `tRelEnd=${messy?.tRelEnd}`,
    );

    suite.section('ENCODING');
    await load(page, fixtureDir, 'latin1.gpx');
    const cafe = (await page.evaluate(summarize)).find((t) => t.name?.includes('Caf'));
    suite.check('windows-1252 name decoded', cafe?.name === 'Café Réglée', cafe?.name);

    suite.section('ERROR HANDLING');
    {
        const before = (await page.evaluate(summarize)).length;
        await load(page, fixtureDir, 'waypoints-only.gpx');
        suite.check(
            'waypoint-only file rejected',
            (await page.evaluate(summarize)).length === before,
        );
        const hint = await page.locator('#dropzone .dz-hint').innerText();
        suite.check('clear message for no track points', /no track points/i.test(hint), hint);
        suite.check(
            'error styling applied',
            await page.locator('#dropzone').evaluate((el) => el.classList.contains('has-error')),
        );

        await load(page, fixtureDir, 'garbage.gpx');
        suite.check('non-GPX file rejected', (await page.evaluate(summarize)).length === before);
        await load(page, fixtureDir, 'routes-only.gpx');
        suite.check('route-only file rejected', (await page.evaluate(summarize)).length === before);

        await load(page, fixtureDir, 'notes.txt');
        const filterHint = await page.locator('#dropzone .dz-hint').innerText();
        suite.check('non-.gpx file filtered out', /no \.gpx files/i.test(filterHint), filterHint);
        suite.check(
            'no phantom track from filtered file',
            (await page.evaluate(summarize)).length === before,
        );
    }

    suite.section('REMOVE');
    {
        const before = (await page.evaluate(summarize)).length;
        await page.locator('.legend-remove').first().click();
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
        suite.check(
            'track removed from store',
            (await page.evaluate(summarize)).length === before - 1,
        );
        const f = await page.evaluate(features);
        suite.check('feature removed from map', f?.count === before - 1, String(f?.count));
    }

    suite.section('BASEMAP SWITCH KEEPS TRACKS');
    {
        // areTilesLoaded() can report true mid-transition, while setStyle has
        // already dropped the overlay source. Count style.load events instead.
        await page.evaluate(() => {
            window.__styleLoads = 0;
            window.mapimator.map.on('style.load', () => {
                window.__styleLoads += 1;
            });
        });
        const before = (await page.evaluate(summarize)).length;
        const camera = await page.evaluate(() => {
            const c = window.mapimator.map.getCenter();
            return { lng: c.lng, lat: c.lat, zoom: window.mapimator.map.getZoom() };
        });
        for (const label of ['Positron', 'Dark', 'Liberty']) {
            const seen = await page.evaluate(() => window.__styleLoads);
            await page.locator('#basemap-switcher button', { hasText: label }).click();
            await page.waitForFunction((n) => window.__styleLoads > n, seen, { timeout: 30_000 });
            await page.waitForFunction(() => window.mapimator.map.areTilesLoaded(), null, {
                timeout: 30_000,
            });
            const f = await page.evaluate(features);
            suite.check(
                `tracks re-rendered after switching to ${label}`,
                f?.count === before,
                `features=${f?.count}`,
            );
        }
        const after = await page.evaluate(() => {
            const c = window.mapimator.map.getCenter();
            return { lng: c.lng, lat: c.lat, zoom: window.mapimator.map.getZoom() };
        });
        suite.check(
            'camera preserved across switches',
            Math.abs(after.lng - camera.lng) < 1e-6 &&
                Math.abs(after.lat - camera.lat) < 1e-6 &&
                Math.abs(after.zoom - camera.zoom) < 1e-6,
            JSON.stringify({ before: camera, after }),
        );
    }

    suite.section('LARGE FILE STAYS OFF THE MAIN THREAD');
    {
        await page.evaluate(() => {
            window.__frames = [];
            let last = performance.now();
            const tick = () => {
                const now = performance.now();
                window.__frames.push(now - last);
                last = now;
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
        const started = Date.now();
        await load(page, fixtureDir, 'bulk.gpx');
        const elapsed = Date.now() - started;
        const frames = await page.evaluate(() => {
            const f = window.__frames;
            return {
                count: f.length,
                max: Math.max(...f),
                slow: f.filter((gap) => gap >= 250).length,
            };
        });
        const bulk = (await page.evaluate(summarize)).find((t) => t.name === 'Bulk');
        suite.check('60k-point track parsed', bulk?.points === 60000, `points=${bulk?.points}`);
        suite.check(
            'render line is 2 values per point',
            bulk?.renderLen === 120000,
            `renderLen=${bulk?.renderLen}`,
        );
        // The parse runs in a worker, so the main thread's work here is geometry
        // building, the chart profile, and tile decode — on a dev machine the
        // worst gap is ~60 ms. Shared CI runners add one-off gaps of a quarter
        // second or so from tile decode, GC and co-tenants, so the bound is two
        // tolerances rather than one: no single gap over half a second — a page
        // genuinely blocked that long on a 6 MB file is a regression — and at
        // most two quarter-second gaps, not a sustained stall.
        suite.check(
            'main thread never blocked >500ms',
            frames.max < BLOCKED_FRAME_MS,
            `max frame gap ${frames.max.toFixed(0)}ms`,
        );
        suite.check(
            'no more than two quarter-second freezes',
            frames.slow <= 2,
            `${frames.slow} frames over ${SLOW_FRAME_MS}ms`,
        );
        suite.check(
            'frames kept rendering',
            frames.count > 3,
            `${frames.count} frames in ${elapsed}ms`,
        );
        suite.note(
            `6.1 MB / 60k points in ${elapsed}ms, max main-thread gap ${frames.max.toFixed(0)}ms, ${frames.slow} gaps over 250ms`,
        );
    }

    suite.section('CONSOLE');
    const realErrors = errors.filter(
        (e) =>
            !/favicon/i.test(e) &&
            // The suite blocks the elevation host above, so its refusals are
            // arranged rather than app errors — the same three messages the
            // terrain suite tolerates for its blocked page.
            !/net::ERR_FAILED|ERR_ABORTED|Failed to load resource/i.test(e),
    );
    suite.check(
        'no console errors for the whole run',
        realErrors.length === 0,
        realErrors.slice(0, 4).join(' | '),
    );
}
