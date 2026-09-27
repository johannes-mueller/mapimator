import { join } from 'node:path';
import { countDifferent, regionPixels } from './harness.mjs';

const S = 1000;

/**
 * Interpolated coordinates are computed in binary floating point, so they are
 * compared with a tolerance rather than `===`. 1e-9 degrees is a nanodegree:
 * far tighter than any real error, and loose enough that it does not encode the
 * order of additions in the interpolator.
 */
const close = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

/** Plain-object snapshot of the rendered markers, so no typed arrays cross. */
const markers = () => {
    const src = window.mapimator.map.getSource('track-markers');
    if (!src) {
        return null;
    }
    const raw = src._data;
    const data = raw && raw.geojson ? raw.geojson : raw;
    if (!data || data.type !== 'FeatureCollection') {
        return null;
    }
    return data.features.map((f) => ({
        trackId: f.properties.trackId,
        name: f.properties.name,
        color: f.properties.color,
        status: f.properties.status,
        done: f.properties.done,
        progress: f.properties.progress,
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
    }));
};

/** The rendered lines, which carry the `done` flag the layers dim on. */
const lines = () => {
    const src = window.mapimator.map.getSource('track-lines');
    if (!src) {
        return null;
    }
    const raw = src._data;
    const data = raw && raw.geojson ? raw.geojson : raw;
    if (!data || data.type !== 'FeatureCollection') {
        return null;
    }
    return data.features.map((f) => ({
        trackId: f.properties.trackId,
        done: f.properties.done,
        lines: f.geometry.coordinates.length,
    }));
};

const state = () => ({
    elapsed: window.mapimator.playback.getElapsedMs(),
    total: window.mapimator.playback.getTotalMs(),
    playing: window.mapimator.playback.isPlaying(),
    clock: document.getElementById('clock').textContent,
    label: document.getElementById('play-toggle').getAttribute('aria-label'),
    disabled: document.getElementById('play-toggle').disabled,
    pressed: document.getElementById('play-toggle').getAttribute('aria-pressed'),
    center: [window.mapimator.map.getCenter().lng, window.mapimator.map.getCenter().lat],
});

const seek = (ms) => {
    window.mapimator.playback.seek(ms);
    return new Promise((r) => requestAnimationFrame(() => r()));
};

/**
 * Seeks and then waits for the rendered markers to catch up.
 *
 * `setData` on a GeoJSON source round-trips through the worker, so the source
 * data read back straight after a seek can still be the previous frame's. The
 * wait is on the marker progress, which is a direct function of the shared time,
 * so it cannot be satisfied by stale data from a different point on the
 * timeline. Returns null if it never converges, so the caller's value checks
 * fail with what is actually on screen rather than the wait throwing.
 */
const seekTo = async (page, ms, expectedProgress) => {
    await page.evaluate(seek, ms);
    try {
        await page.waitForFunction(
            (p) => {
                const src = window.mapimator.map.getSource('track-markers');
                const raw = src._data;
                const data = raw && raw.geojson ? raw.geojson : raw;
                return (data?.features ?? []).some(
                    (f) => Math.abs(f.properties.progress - p) < 1e-6,
                );
            },
            expectedProgress,
            { timeout: 5000 },
        );
    } catch {
        return null;
    }
    return page.evaluate(markers);
};

const load = async (page, dir, ...names) => {
    await page.setInputFiles(
        '#file-input',
        names.map((n) => join(dir, n)),
    );
    await page.waitForFunction(
        () => document.getElementById('dropzone').getAttribute('aria-busy') !== 'true',
        null,
        { timeout: 60_000 },
    );
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
};

const byId = (list, id) => (list ?? []).find((m) => m.trackId === id) ?? null;

/** Store ids keep counting across a clear, so the gappy track is found by name. */
const byName = (list, name) => (list ?? []).find((m) => m.name === name) ?? null;

/** Every GPX fixture this spec loads through the real file input. */
export const fixtures = ['simultaneous.gpx', 'early-finisher.gpx', 'gaps.gpx', 'bulk.gpx'];

export async function run({ page, suite, errors, url, fixtures: fixtureDir }) {
    suite.section('EMPTY STATE');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.mapimator.areTrackLayersAttached(), null, {
        timeout: 30_000,
    });

    const empty = await page.evaluate(state);
    suite.check('clock reads an empty timeline', empty.clock === '0:00 / 0:00', empty.clock);
    suite.check('play is disabled with no tracks', empty.disabled === true, String(empty.disabled));
    suite.check('play reads as Play', empty.label === 'Play', String(empty.label));
    suite.check('nothing is playing', empty.playing === false, String(empty.playing));
    const emptyMarkers = await page.evaluate(markers);
    suite.check('no markers', emptyMarkers?.length === 0, `count=${emptyMarkers?.length}`);

    suite.section('TWO TRACKS, ONE CLOCK');
    await load(page, fixtureDir, 'simultaneous.gpx');
    const loaded = await page.evaluate(state);
    suite.check(
        'both tracks share one 4 minute timeline',
        loaded.total === 240_000,
        `${loaded.total}`,
    );
    suite.check('readout shows the shared total', loaded.clock === '0:00 / 4:00', loaded.clock);
    suite.check(
        'play is enabled once a track exists',
        loaded.disabled === false,
        String(loaded.disabled),
    );

    const atStart = await page.evaluate(markers);
    suite.check('a marker per track', atStart?.length === 2, `count=${atStart?.length}`);
    const startA = byId(atStart, 'track-1');
    const startB = byId(atStart, 'track-2');
    suite.check(
        'track 1 starts at its first point',
        startA?.lon === 8 && startA?.lat === 47,
        JSON.stringify([startA?.lon, startA?.lat]),
    );
    suite.check(
        'track 2 starts at its first point',
        startB?.lon === 7 && startB?.lat === 46,
        JSON.stringify([startB?.lon, startB?.lat]),
    );
    suite.check(
        'both markers are running',
        startA?.status === 'running' && startB?.status === 'running',
        `${startA?.status}/${startB?.status}`,
    );

    suite.section('INTERPOLATION IS EXACT');
    // 90 s into tracks sampled every 60 s is exactly halfway between the 60 s
    // point (8.01) and the 120 s point (8.02), so 8.015/47.015 and 7.015/46.015.
    const halfway = await seekTo(page, 90 * S, 90 / 240);
    const halfA = byId(halfway, 'track-1');
    const halfB = byId(halfway, 'track-2');
    suite.check(
        'track 1 is exactly halfway',
        close(halfA?.lon, 8.015) && close(halfA?.lat, 47.015),
        `${halfA?.lon},${halfA?.lat}`,
    );
    suite.check(
        'track 2 is exactly halfway',
        close(halfB?.lon, 7.015) && close(halfB?.lat, 46.015),
        `${halfB?.lon},${halfB?.lat}`,
    );
    suite.check(
        'progress is 90s of the 240s track',
        close(halfA?.progress, 90 / 240),
        String(halfA?.progress),
    );
    suite.check(
        'both tracks read the same progress',
        halfA?.progress === halfB?.progress,
        `${halfA?.progress}/${halfB?.progress}`,
    );

    const rewound = await seekTo(page, 0, 0);
    const backToStart = byId(rewound, 'track-1');
    const rewoundState = await page.evaluate(state);
    suite.check(
        'seeking back returns to the start',
        backToStart?.lon === 8,
        String(backToStart?.lon),
    );
    suite.check(
        'readout follows the seek',
        rewoundState.clock === '0:00 / 4:00',
        rewoundState.clock,
    );

    await page.evaluate(seek, 999 * S);
    const past = await page.evaluate(state);
    suite.check(
        'a seek past the end clamps to the total',
        past.elapsed === 240_000,
        `${past.elapsed}`,
    );
    suite.check('readout shows the end of the timeline', past.clock === '4:00 / 4:00', past.clock);
    const atEnd = await page.evaluate(markers);
    suite.check(
        'a finished track is marked done',
        byId(atEnd, 'track-1')?.status === 'done',
        String(byId(atEnd, 'track-1')?.status),
    );
    suite.check(
        'a finished marker rests on the last point',
        byId(atEnd, 'track-1')?.lon === 8.04,
        String(byId(atEnd, 'track-1')?.lon),
    );

    suite.section('PLAYING MOVES THE MARKERS');
    await page.evaluate(seek, 0);
    const before = byId(await page.evaluate(markers), 'track-1');
    await page.locator('#play-toggle').click();
    const playing = await page.evaluate(state);
    suite.check(
        'clicking play starts the clock',
        playing.playing === true,
        String(playing.playing),
    );
    suite.check('the button reads as Pause', playing.label === 'Pause', String(playing.label));
    suite.check(
        'the button is marked pressed',
        playing.pressed === 'true',
        String(playing.pressed),
    );
    await page.waitForTimeout(300);
    const during = await page.evaluate(state);
    const afterPlay = byId(await page.evaluate(markers), 'track-1');
    suite.check('the clock advances while playing', during.elapsed > 0, `${during.elapsed}`);
    suite.check(
        'the marker moved off its start',
        afterPlay?.lon > before.lon,
        `${before.lon} -> ${afterPlay?.lon}`,
    );

    suite.section('PAUSING FREEZES EVERYTHING');
    await page.locator('#play-toggle').click();
    const paused = await page.evaluate(state);
    suite.check('clicking again pauses', paused.playing === false, String(paused.playing));
    suite.check('the button reads as Play', paused.label === 'Play', String(paused.label));
    const frozen = byId(await page.evaluate(markers), 'track-1');
    await page.waitForTimeout(400);
    const stillPaused = await page.evaluate(state);
    const stillFrozen = byId(await page.evaluate(markers), 'track-1');
    suite.check(
        'the clock does not advance while paused',
        stillPaused.elapsed === paused.elapsed,
        `${paused.elapsed} -> ${stillPaused.elapsed}`,
    );
    suite.check(
        'the marker does not drift while paused',
        stillFrozen?.lon === frozen?.lon,
        `${frozen?.lon} -> ${stillFrozen?.lon}`,
    );
    suite.check(
        'the camera was never hijacked by playback',
        stillPaused.center[0] === playing.center[0] && stillPaused.center[1] === playing.center[1],
        JSON.stringify([playing.center, stillPaused.center]),
    );

    suite.section('MARKERS ARE PAINTED, NOT JUST STORED');
    // The region is built from where the markers actually project, rather than a
    // hard-coded box, because at the fitted view the two tracks sit at opposite
    // corners and a fixed rectangle would miss them.
    const painted = await page.evaluate(async () => {
        const playback = window.mapimator.playback;
        const map = window.mapimator.map;
        const points = [];
        for (const ms of [0, 240_000]) {
            playback.seek(ms);
            await new Promise((r) => requestAnimationFrame(() => r()));
            const src = map.getSource('track-markers');
            const raw = src._data;
            const data = raw && raw.geojson ? raw.geojson : raw;
            for (const f of data.features) {
                points.push(map.project(f.geometry.coordinates));
            }
        }
        const xs = points.map((p) => p.x);
        const ys = points.map((p) => p.y);
        const pad = 24;
        const x = Math.max(0, Math.floor(Math.min(...xs)) - pad);
        const y = Math.max(0, Math.floor(Math.min(...ys)) - pad);
        return {
            x,
            y,
            w: Math.ceil(Math.max(...xs) + pad) - x,
            h: Math.ceil(Math.max(...ys) + pad) - y,
        };
    });
    suite.check(
        'the marker positions are on screen',
        painted.w > 0 && painted.h > 0,
        JSON.stringify(painted),
    );

    await page.evaluate(seek, 0);
    await page.waitForTimeout(500);
    const atZero = await regionPixels(page, painted);
    await page.evaluate(seek, 240 * S);
    await page.waitForTimeout(500);
    const atFinish = await regionPixels(page, painted);
    const moved = countDifferent(atZero, atFinish);
    suite.check('moving the playhead changes the painted pixels', moved > 50, `pixels=${moved}`);

    suite.section('PLAYING TO THE END STOPS');
    await page.evaluate(seek, 240 * S - 300);
    await page.locator('#play-toggle').click();
    await page.waitForFunction(() => !window.mapimator.playback.isPlaying(), null, {
        timeout: 10_000,
    });
    const finished = await page.evaluate(state);
    suite.check(
        'the clock stops at the total',
        finished.elapsed === 240_000,
        `${finished.elapsed}`,
    );
    suite.check(
        'the readout shows the whole timeline',
        finished.clock === '4:00 / 4:00',
        finished.clock,
    );
    suite.check('the button returns to Play', finished.label === 'Play', String(finished.label));
    const allDone = await page.evaluate(markers);
    suite.check(
        'both markers are done',
        allDone?.every((m) => m.status === 'done'),
        JSON.stringify(allDone?.map((m) => m.status)),
    );

    suite.section('A FINISHED TRACK DIMS WHILE ANOTHER CONTINUES');
    await load(page, fixtureDir, 'early-finisher.gpx');
    // Every fixture starts at the same instant, so the shared origin is
    // unchanged and the total grows to the marathon's 10 minutes.
    const mixed = await seekTo(page, 60 * S, 60 / 600);
    const sprint = byName(mixed, 'Sprint');
    const marathon = byName(mixed, 'Marathon');
    suite.check(
        'the short track is done at 1:00',
        sprint?.status === 'done',
        String(sprint?.status),
    );
    suite.check('the short track is marked done', sprint?.done === true, String(sprint?.done));
    suite.check(
        'the long track is still running',
        marathon?.status === 'running',
        String(marathon?.status),
    );
    suite.check('the long track is not done', marathon?.done === false, String(marathon?.done));
    suite.check(
        'the finished marker stays on its last point',
        sprint?.lon === 6.02,
        String(sprint?.lon),
    );
    suite.check(
        'the running marker is a tenth of the way along the line',
        close(marathon?.lon, 5.01) && close(marathon?.progress, 0.1),
        `${marathon?.lon} p=${marathon?.progress}`,
    );
    const mixedLines = await page.evaluate(lines);
    suite.check(
        'the finished line is dimmed, the other is not',
        mixedLines?.find((l) => l.trackId === sprint?.trackId)?.done === true &&
            mixedLines?.find((l) => l.trackId === marathon?.trackId)?.done === false,
        JSON.stringify(mixedLines?.map((l) => [l.trackId, l.done])),
    );

    await page.evaluate(seek, 600 * S);
    await page.waitForTimeout(200);
    const bothDone = await page.evaluate(lines);
    suite.check(
        'both lines are dimmed at the end',
        bothDone?.every((l) => l.done === true),
        JSON.stringify(bothDone?.map((l) => l.done)),
    );

    suite.section('A RECORDED PAUSE DOES NOT GLIDE');
    await page.evaluate(() => window.mapimator.store.clear());
    await load(page, fixtureDir, 'gaps.gpx');
    // The recorded gap runs from 1:00 to 2:01:00 (7260 s): 60 s is the last point
    // before it, 3600 s is deep inside, and 7260 s starts the next segment.
    const TOTAL_GAP = 7320;
    const gapStart = byName(await seekTo(page, 60 * S, 60 / TOTAL_GAP), 'Gappy');
    const inGap = byName(await seekTo(page, 3600 * S, 3600 / TOTAL_GAP), 'Gappy');
    const justBefore = byName(await seekTo(page, 7259 * S, 7259 / TOTAL_GAP), 'Gappy');
    const gapEnd = byName(await seekTo(page, 7260 * S, 7260 / TOTAL_GAP), 'Gappy');
    suite.check(
        'the marker is parked inside the gap',
        inGap?.status === 'parked',
        String(inGap?.status),
    );
    suite.check(
        'the marker holds the last point of the segment',
        inGap?.lon === gapStart?.lon && inGap?.lat === gapStart?.lat,
        `${gapStart?.lon},${gapStart?.lat} -> ${inGap?.lon},${inGap?.lat}`,
    );
    suite.check(
        'the marker is still parked one second before the gap ends',
        justBefore?.status === 'parked' && justBefore?.lon === 11.01,
        `${justBefore?.status} ${justBefore?.lon}`,
    );
    suite.check(
        'the marker resumes at the next segment start',
        close(gapEnd?.lon, 11.5) && close(gapEnd?.lat, 48.5),
        `${gapEnd?.lon},${gapEnd?.lat}`,
    );
    suite.check(
        'the marker is running again after the gap',
        gapEnd?.status === 'running',
        String(gapEnd?.status),
    );
    const gapLines = await page.evaluate(lines);
    suite.check(
        'the line is still split at the break',
        gapLines?.[0]?.lines === 2,
        `lines=${gapLines?.[0]?.lines}`,
    );
    const gapState = await page.evaluate(state);
    suite.check(
        'the gap counts towards the timeline',
        gapState.total === 7_320_000,
        `${gapState.total}`,
    );

    suite.section('A LARGE FILE STAYS CORRECT');
    await page.evaluate(() => window.mapimator.store.clear());
    await load(page, fixtureDir, 'bulk.gpx');
    const bulkState = await page.evaluate(() => {
        const { track } = window.mapimator.store.getAll()[0];
        return {
            points: track.lat.length,
            lastTrel: track.tRel[track.tRel.length - 1],
            total: window.mapimator.playback.getTotalMs(),
        };
    });
    suite.check(
        '60k points survived the worker',
        bulkState.points === 60_000,
        `${bulkState.points}`,
    );
    suite.check(
        'the clock total matches the last sample time',
        Math.round(bulkState.lastTrel * 1000) === bulkState.total,
        `${Math.round(bulkState.lastTrel * 1000)} vs ${bulkState.total}`,
    );

    // Interpolate independently from the raw arrays and compare with the marker
    // the renderer produced, so this checks the search rather than restating it.
    const bulkSeek = 3600 * S;
    const bulk = await page.evaluate(async (ms) => {
        window.mapimator.playback.seek(ms);
        await new Promise((r) => requestAnimationFrame(() => r()));
        const { track } = window.mapimator.store.getAll()[0];
        const target = ms / 1000;
        let from = 0;
        while (from + 1 < track.lat.length && track.tRel[from + 1] <= target) {
            from += 1;
        }
        const span = track.tRel[from + 1] - track.tRel[from];
        const f = (target - track.tRel[from]) / span;
        const src = window.mapimator.map.getSource('track-markers');
        const raw = src._data;
        const data = raw && raw.geojson ? raw.geojson : raw;
        const feature = data.features[0];
        return {
            expectedLon: track.lon[from] + (track.lon[from + 1] - track.lon[from]) * f,
            expectedLat: track.lat[from] + (track.lat[from + 1] - track.lat[from]) * f,
            gotLon: feature.geometry.coordinates[0],
            gotLat: feature.geometry.coordinates[1],
            index: from,
        };
    }, bulkSeek);
    suite.check(
        'the marker sits in the right segment of 60k samples',
        bulk.index === 1800,
        `index=${bulk.index}`,
    );
    suite.check(
        'the marker longitude matches an independent interpolation',
        close(bulk.gotLon, bulk.expectedLon),
        `${bulk.gotLon} vs ${bulk.expectedLon}`,
    );
    suite.check(
        'the marker latitude matches an independent interpolation',
        close(bulk.gotLat, bulk.expectedLat),
        `${bulk.gotLat} vs ${bulk.expectedLat}`,
    );

    suite.section('NO ERRORS');
    suite.check('no console errors during playback', errors.length === 0, errors.join(' | '));
}
