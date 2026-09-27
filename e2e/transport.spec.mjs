import { join } from 'node:path';

/**
 * Phase 4: the controls you actually operate a run with.
 *
 * The unit tests cover the arithmetic behind the speed, the scrub and the key
 * bindings. What only a browser can show is whether a real drag reaches the map,
 * whether a real key press is swallowed by whatever currently has focus, and
 * whether the numbers in the legend agree with the marker on screen.
 */

const S = 1000;
const M = 60_000;

const transportState = () => {
    const timeline = document.getElementById('timeline');
    const speed = document.getElementById('speed-select');
    return {
        elapsed: window.mapimator.playback.getElapsedMs(),
        total: window.mapimator.playback.getTotalMs(),
        speed: window.mapimator.playback.getSpeed(),
        playing: window.mapimator.playback.isPlaying(),
        timelineValue: timeline.value,
        timelineMax: timeline.max,
        timelineStep: timeline.step,
        timelineDisabled: timeline.disabled,
        timelineValueText: timeline.getAttribute('aria-valuetext'),
        speedValue: speed.value,
        speedDisabled: speed.disabled,
        center: [window.mapimator.map.getCenter().lng, window.mapimator.map.getCenter().lat],
        zoom: window.mapimator.map.getZoom(),
    };
};

const markerStates = () => {
    const src = window.mapimator.map.getSource('track-markers');
    const raw = src?._data;
    const data = raw && raw.geojson ? raw.geojson : raw;
    if (!data || data.type !== 'FeatureCollection') {
        return null;
    }
    return data.features.map((f) => ({
        trackId: f.properties.trackId,
        name: f.properties.name,
        status: f.properties.status,
        progress: f.properties.progress,
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
    }));
};

/** The live line under each legend row, in row order. */
const readouts = () =>
    [...document.querySelectorAll('.legend-readout')].map((el) => el.textContent);

/** What the store says a track is, for a comparison the readout has to meet. */
const trackFacts = () =>
    window.mapimator.store.getAll().map(({ track }) => ({
        name: track.name,
        durationMs: track.durationMs,
        distanceM: track.distanceM,
        t0: track.t0,
        samples: track.tRel.length,
        dist: Array.from(track.dist),
    }));

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

/**
 * Waits for one named marker to reach a progress, since `setData` goes via the
 * worker. Progress is a share of that track's own duration, not of the shared
 * run, so a track that has been overtaken by the playhead can sit at 1 while the
 * clock is only halfway along the run.
 */
const settle = async (page, name, expectedProgress) => {
    try {
        await page.waitForFunction(
            ([trackName, p]) => {
                const src = window.mapimator.map.getSource('track-markers');
                const raw = src._data;
                const data = raw && raw.geojson ? raw.geojson : raw;
                return (data?.features ?? []).some(
                    (f) =>
                        f.properties.name === trackName &&
                        Math.abs(f.properties.progress - p) < 1e-6,
                );
            },
            [name, expectedProgress],
            { timeout: 5000 },
        );
        return true;
    } catch {
        return false;
    }
};

const seekAndSettle = async (page, ms, name, expectedProgress) => {
    await page.evaluate((value) => {
        window.mapimator.playback.seek(value);
    }, ms);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    return settle(page, name, expectedProgress);
};

const byName = (list, name) => (list ?? []).find((m) => m.name === name) ?? null;

/**
 * A formatter written from scratch, so the legend's numbers are compared against
 * an independent implementation rather than against the app's own.
 */
const independentDuration = (ms) => {
    const total = Math.round(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (v) => String(v).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
};

const independentDistance = (m) => {
    if (!Number.isFinite(m)) {
        return '—';
    }
    if (m < 1000) {
        return `${Math.round(m)} m`;
    }
    return `${(m / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`;
};

export const fixtures = ['offset-riders.gpx', 'gaps.gpx'];

export async function run({ page, suite, errors, url, fixtures: fixtureDir }) {
    suite.section('EMPTY STATE');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.mapimator.areTrackLayersAttached(), null, {
        timeout: 30_000,
    });

    const empty = await page.evaluate(transportState);
    suite.check('timeline is disabled with no tracks', empty.timelineDisabled === true);
    suite.check('speed is disabled with no tracks', empty.speedDisabled === true);
    suite.check('the timeline spans nothing', empty.timelineMax === '0', empty.timelineMax);

    suite.section('TWO RIDES NINETY SECONDS APART');
    await load(page, fixtureDir, 'offset-riders.gpx');

    const facts = await page.evaluate(trackFacts);
    suite.check('both rides loaded', facts.length === 2, `count=${facts.length}`);
    // The late rider starts 90 s in, so the shared run is its own length plus 90 s.
    const expectedTotal = 90 * S + facts[1].durationMs;
    const loaded = await page.evaluate(transportState);
    suite.check(
        'the run lasts as long as the later ride plus its offset',
        loaded.total === expectedTotal,
        `${loaded.total} vs ${expectedTotal}`,
    );
    suite.check('timeline is enabled once tracks exist', loaded.timelineDisabled === false);
    suite.check('speed is enabled once tracks exist', loaded.speedDisabled === false);
    suite.check(
        'the timeline can address the whole run',
        Number(loaded.timelineMax) === expectedTotal,
        loaded.timelineMax,
    );
    const stepMs = Number(loaded.timelineStep);
    suite.check(
        'one key press on the timeline is a visible move but not a leap',
        stepMs <= expectedTotal * 0.01 && stepMs >= expectedTotal * 0.001,
        `${stepMs}ms of ${expectedTotal}ms`,
    );
    suite.check(
        'the timeline announces a readable position',
        loaded.timelineValueText === `0:00 of ${independentDuration(expectedTotal)}`,
        String(loaded.timelineValueText),
    );

    suite.section('SCRUBBING');
    const beforeDrag = await page.evaluate(transportState);
    const box = await page.locator('#timeline').boundingBox();
    const midY = box.y + box.height / 2;

    // A real press-and-drag, not a synthetic event, so the value has to arrive
    // through the browser's own hit-testing of the range.
    await page.mouse.move(box.x + box.width * 0.5, midY);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.75, midY, { steps: 8 });

    // Read the state with the button still down. Scrubbing that waits for the
    // release would land on the same final position as one that follows the
    // pointer, so only a reading taken mid-drag can tell the two apart.
    const midDrag = await page.evaluate(transportState);
    suite.check(
        'the map follows the handle while it is being dragged',
        midDrag.elapsed > expectedTotal * 0.5,
        `at ${((midDrag.elapsed / expectedTotal) * 100).toFixed(1)}%, button still down`,
    );

    await page.mouse.up();
    const dragged = await page.evaluate(transportState);
    const travelled = dragged.elapsed / expectedTotal;
    suite.check(
        'releasing leaves the playhead where it was dropped',
        travelled > 0.55 && travelled < 0.9,
        `at ${(travelled * 100).toFixed(1)}%`,
    );
    suite.check(
        'the readout follows the playhead',
        dragged.timelineValue === String(dragged.elapsed),
        `${dragged.timelineValue} vs ${dragged.elapsed}`,
    );
    suite.check(
        'the clock text follows the playhead',
        dragged.timelineValueText ===
            `${independentDuration(dragged.elapsed)} of ${independentDuration(expectedTotal)}`,
        String(dragged.timelineValueText),
    );
    suite.check(
        'scrubbing does not move the camera',
        dragged.center[0] === beforeDrag.center[0] &&
            dragged.center[1] === beforeDrag.center[1] &&
            dragged.zoom === beforeDrag.zoom,
        JSON.stringify([dragged.center, dragged.zoom]),
    );

    // The marker has to have followed the scrub, or the map is showing one time
    // while the bar shows another. The early rider may be finished by now, so the
    // wait is on the later one, which is still running wherever the handle landed.
    const lateLocal = Math.max(0, dragged.elapsed - 90 * S);
    const settled = await settle(page, 'Late Rider', Math.min(1, lateLocal / facts[1].durationMs));
    suite.check('the markers caught up with the scrub', settled);
    const draggedMarkers = await page.evaluate(markerStates);
    const draggedEarly = byName(draggedMarkers, 'Early Rider');
    suite.check(
        'the early rider has moved along its line',
        draggedEarly !== null && draggedEarly.lon > 8 && draggedEarly.lat > 47,
        `lon=${draggedEarly?.lon} lat=${draggedEarly?.lat}`,
    );
    suite.check(
        'the late rider is still running by now',
        draggedEarly !== null && byName(draggedMarkers, 'Late Rider')?.status === 'running',
        `${byName(draggedMarkers, 'Late Rider')?.status}`,
    );

    suite.section('KEYBOARD TRANSPORT');
    // The file input keeps focus after a load, and a focused input would swallow
    // the keys, so this is also a check that blurring is all it takes.
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press('Home');
    const atHome = await page.evaluate(transportState);
    suite.check('Home returns to the start', atHome.elapsed === 0, String(atHome.elapsed));

    await page.keyboard.press('ArrowRight');
    const nudged = await page.evaluate(transportState);
    const onePercent = expectedTotal * 0.01;
    suite.check(
        'an arrow press steps a percent of the run',
        Math.abs(nudged.elapsed - onePercent) <= 1,
        `${nudged.elapsed} vs ${onePercent}`,
    );

    await page.keyboard.press('Shift+ArrowRight');
    const fastNudged = await page.evaluate(transportState);
    suite.check(
        'shift and an arrow step five percent',
        Math.abs(fastNudged.elapsed - onePercent * 6) <= 1,
        String(fastNudged.elapsed),
    );

    // Two steps out and one back leaves the playhead at five percent, so a
    // backwards step is one percent from where it was, not from the start.
    await page.keyboard.press('ArrowLeft');
    const backNudged = await page.evaluate(transportState);
    suite.check(
        'an arrow steps back the same way',
        Math.abs(backNudged.elapsed - onePercent * 5) <= 1,
        String(backNudged.elapsed),
    );

    await page.keyboard.press('End');
    const atEnd = await page.evaluate(transportState);
    suite.check('End jumps to the end', atEnd.elapsed === expectedTotal, String(atEnd.elapsed));
    suite.check(
        'the playhead cannot be pushed past the end',
        (await page.evaluate(() => {
            window.mapimator.playback.seek(1e12);
            return window.mapimator.playback.getElapsedMs();
        })) === expectedTotal,
    );
    await page.keyboard.press('Home');

    await page.keyboard.press('Space');
    const afterSpace = await page.evaluate(transportState);
    suite.check('space starts the run', afterSpace.playing === true, String(afterSpace.playing));
    await page.keyboard.press('Space');
    const afterSpace2 = await page.evaluate(transportState);
    suite.check(
        'space pauses it again',
        afterSpace2.playing === false,
        String(afterSpace2.playing),
    );

    await page.keyboard.press('k');
    const afterK = await page.evaluate(transportState);
    suite.check('k toggles too', afterK.playing === true, String(afterK.playing));
    await page.keyboard.press('k');

    suite.section('KEYS MUST NOT BE DOUBLE-COUNTED');
    // A focused range already seeks with its own arrows, through an `input` event.
    // If the document handler acted as well, one press would move the playhead by
    // the step *and* by a percent of the run.
    await page.locator('#timeline').focus();
    const step = Number((await page.evaluate(transportState)).timelineStep);
    const before = (await page.evaluate(transportState)).elapsed;
    await page.keyboard.press('ArrowRight');
    const afterArrow = (await page.evaluate(transportState)).elapsed;
    suite.check(
        'an arrow on the focused timeline moves it exactly one step',
        Math.abs(afterArrow - before - step) < 1,
        `moved ${afterArrow - before}, step ${step}`,
    );

    // Space on a focused timeline is the opposite case: a range does nothing with
    // it, so without the exception the page would scroll and play would be
    // unreachable after a drag.
    //
    // Registered after the transport's own document listener, so it observes
    // whether the app claimed the key: this layout does not scroll, so asserting
    // a scroll position could not fail however the key was handled.
    await page.evaluate(() => {
        window.__keys = [];
        document.addEventListener('keydown', (event) => {
            window.__keys.push({ key: event.key, prevented: event.defaultPrevented });
        });
    });
    await page.keyboard.press('Space');
    const claimedSpace = await page.evaluate(() => window.__keys.at(-1));
    suite.check(
        'space on a focused timeline is claimed, so the page cannot scroll',
        claimedSpace?.key === ' ' && claimedSpace?.prevented === true,
        JSON.stringify(claimedSpace),
    );
    const afterTimelineSpace = await page.evaluate(transportState);
    suite.check(
        'and it still reaches the transport',
        afterTimelineSpace.playing === true,
        String(afterTimelineSpace.playing),
    );
    await page.keyboard.press('Space');
    await page.keyboard.press('a');
    const ignoredKey = await page.evaluate(() => window.__keys.at(-1));
    suite.check(
        'a key with no binding is left to the browser',
        ignoredKey?.key === 'a' && ignoredKey?.prevented === false,
        JSON.stringify(ignoredKey),
    );
    await page.locator('#play-toggle').focus();
    await page.keyboard.press('Space');
    const afterButtonSpace = await page.evaluate(transportState);
    suite.check(
        'space on the focused play button toggles exactly once',
        afterButtonSpace.playing === true,
        String(afterButtonSpace.playing),
    );
    await page.keyboard.press('Space');
    await page.evaluate(() => document.activeElement?.blur?.());

    suite.section('SPEED');
    // Both windows are the same length of real time, so the ratio of how far the
    // playhead travelled is the multiplier, whatever the machine's frame rate did.
    const runFor = async (ms) => {
        await page.evaluate(() => window.mapimator.playback.seek(0));
        await page.evaluate(() => window.mapimator.playback.play());
        const start = await page.evaluate(() => window.mapimator.playback.getElapsedMs());
        await page.waitForTimeout(ms);
        const end = await page.evaluate(() => window.mapimator.playback.getElapsedMs());
        await page.evaluate(() => window.mapimator.playback.pause());
        return end - start;
    };

    await page.selectOption('#speed-select', '1');
    const at1x = await runFor(400);
    await page.selectOption('#speed-select', '60');
    const at60x = await runFor(400);
    const ratio = at1x > 0 ? at60x / at1x : 0;
    suite.check(
        'the select reports the speed the clock is running at',
        (await page.evaluate(transportState)).speed === 60,
    );
    suite.check(
        'sixty times the rate moves the playhead sixty times as far',
        ratio > 15 && ratio < 240,
        `1x ${at1x}ms, 60x ${at60x}ms, ratio ${ratio.toFixed(1)}`,
    );

    // A change of speed is a choice about the next run too, not just this one.
    await page.evaluate((ms) => window.mapimator.playback.seek(ms), 30 * S);
    await page.evaluate(() => window.mapimator.playback.pause());
    const afterScrub = await page.evaluate(transportState);
    suite.check(
        'speed survives a scrub',
        afterScrub.speed === 60 && afterScrub.elapsed === 30 * S,
        `${afterScrub.speed} at ${afterScrub.elapsed}`,
    );
    suite.check('the select still shows it', afterScrub.speedValue === '60', afterScrub.speedValue);

    suite.section('PER-TRACK READOUTS');
    await page.evaluate(() => window.mapimator.playback.seek(0));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    const atZero = await page.evaluate(readouts);
    suite.check('there is a readout per track', atZero.length === 2, `count=${atZero.length}`);
    suite.check(
        'a ride that has not started reads as a dash, not zero',
        atZero[0] !== '—' && atZero[1] === '—',
        JSON.stringify(atZero),
    );

    const totalEarly = facts[0].durationMs;
    await seekAndSettle(page, totalEarly / 2, 'Early Rider', 0.5);
    const midEarly = await page.evaluate(readouts);
    // Straight line, equal steps: half the time is half the distance.
    const halfDistance = facts[0].distanceM / 2;
    suite.check(
        'the running ride reads its own elapsed time and distance',
        midEarly[0] ===
            `${independentDuration(totalEarly / 2)} · ${independentDistance(halfDistance)}`,
        `${midEarly[0]} vs ${independentDuration(totalEarly / 2)} · ${independentDistance(halfDistance)}`,
    );
    // Halfway through the early ride is exactly when the late one starts, so it
    // reads as started there. A moment earlier, it has not been reached at all.
    suite.check(
        'a ride the playhead has not reached yet reads as a dash',
        midEarly[1] === '0:00 · 0 m',
        midEarly[1],
    );
    await seekAndSettle(page, 60 * S, 'Early Rider', 60 / 180);
    const beforeLate = await page.evaluate(readouts);
    suite.check(
        'which is not the same as a ride that has not started',
        beforeLate[1] === '—',
        `${beforeLate[1]} at ${independentDuration(60 * S)} in`,
    );

    await seekAndSettle(page, 90 * S, 'Early Rider', 0.5);
    const atLateStart = await page.evaluate(readouts);
    suite.check(
        'the later ride starts reading the moment the clock reaches it',
        atLateStart[1] === `0:00 · ${independentDistance(0)}`,
        atLateStart[1],
    );
    const lateFacts = facts[1];
    const lateDistance = lateFacts.distanceM * 0.25;
    const lateTime = 90 * S + lateFacts.durationMs * 0.25;
    await seekAndSettle(page, lateTime, 'Late Rider', 0.25);
    const quarterLate = await page.evaluate(readouts);
    suite.check(
        'each ride counts from its own start, not the shared one',
        quarterLate[1] ===
            `${independentDuration(lateFacts.durationMs * 0.25)} · ${independentDistance(lateDistance)}`,
        quarterLate[1],
    );

    await page.evaluate(() =>
        window.mapimator.playback.seek(window.mapimator.playback.getTotalMs()),
    );
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    const finished = await page.evaluate(readouts);
    suite.check(
        'a finished run reads the full ride, matching the track totals',
        finished[0] ===
            `${independentDuration(facts[0].durationMs)} · ${independentDistance(facts[0].distanceM)}` &&
            finished[1] ===
                `${independentDuration(facts[1].durationMs)} · ${independentDistance(facts[1].distanceM)}`,
        JSON.stringify(finished),
    );

    suite.section('A READOUT FOLLOWS A PARKED MARKER');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.mapimator.areTrackLayersAttached(), null, {
        timeout: 30_000,
    });
    await load(page, fixtureDir, 'gaps.gpx');
    const gapFacts = await page.evaluate(trackFacts);
    // An hour into a track that stopped at 1:00 for a two-hour break: the marker
    // is still on the point it reached at 1:00, and the readout has to say so
    // rather than reporting the playhead's own time.
    const stoppedAt = gapFacts[0].dist[1];
    const gapProgress = 60 / (gapFacts[0].durationMs / S);
    await seekAndSettle(page, M, 'Gappy', gapProgress);
    const parked = await page.evaluate(readouts);
    suite.check(
        'a marker parked in a pause reads the time it stopped at',
        parked[0] === `1:00 · ${independentDistance(stoppedAt)}`,
        `${parked[0]} (ride is ${independentDuration(gapFacts[0].durationMs)})`,
    );
    suite.check(
        'and the distance it had covered when it stopped, not the whole ride',
        stoppedAt > 0 &&
            parked[0].includes(independentDistance(stoppedAt)) &&
            !parked[0].includes(independentDistance(gapFacts[0].distanceM)),
        `stopped at ${independentDistance(stoppedAt)} of ${independentDistance(gapFacts[0].distanceM)}`,
    );
    suite.check(
        'and certainly not the playhead time',
        !parked[0].startsWith('1:00:00'),
        String(parked[0]),
    );

    suite.check('no console errors', errors.length === 0, errors.join(' | '));
}
