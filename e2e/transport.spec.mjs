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
    // Every ride is measured from its own first point, so the 90 s between the
    // two recordings is not part of either ride and not part of the run: the run
    // is as long as the longer of the two.
    const expectedTotal = Math.max(facts[0].durationMs, facts[1].durationMs);
    const offsetMs = facts[1].t0 - facts[0].t0;
    const loaded = await page.evaluate(transportState);
    suite.check(
        'the run lasts as long as the longest ride, not the widest span',
        loaded.total === expectedTotal,
        `${loaded.total} vs ${expectedTotal}`,
    );
    // If offset alignment ever came back, the total would grow by the 90 s gap
    // and this would fail, so the gap is provably not part of the run.
    suite.check(
        'and is not stretched by the gap between the recordings',
        loaded.total < offsetMs + facts[1].durationMs,
        `total=${loaded.total}, offset-aligned would be ${offsetMs + facts[1].durationMs}`,
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

    // The whole premise: the two rides were recorded 90 s apart and must still
    // start together, so at the same moment of the run both markers are the same
    // fraction of the way along their own line.
    await seekAndSettle(page, expectedTotal / 5, 'Late Rider', 0.2);
    const together = await page.evaluate(markerStates);
    suite.check(
        'both rides are 20% along their own line at 20% of the run',
        together !== null &&
            together.length === 2 &&
            together.every((f) => Math.abs(f.progress - 0.2) < 1e-6) &&
            byName(together, 'Late Rider')?.lon < byName(together, 'Early Rider')?.lon,
        JSON.stringify(together?.map((f) => [f.name, f.progress, f.lon])),
    );

    // The offset is real information about the files, so it is shown rather than
    // silently dropped along with the alignment that used to act on it.
    const legendMeta = await page.evaluate(() =>
        [...document.querySelectorAll('.legend-meta')].map((el) => el.textContent),
    );
    suite.check(
        'the legend says how much later the second ride was recorded',
        legendMeta.length === 2 &&
            legendMeta[0].includes(`recorded ${independentDuration(offsetMs)} later`) === false &&
            legendMeta[1].includes(`recorded ${independentDuration(offsetMs)} later`),
        JSON.stringify(legendMeta),
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
    // while the bar shows another. The later ride is the one to wait on, because
    // the whole run is its own length.
    const draggedFraction = Math.min(1, dragged.elapsed / facts[1].durationMs);
    const settled = await settle(page, 'Late Rider', draggedFraction);
    suite.check('the markers caught up with the scrub', settled);
    const draggedMarkers = await page.evaluate(markerStates);
    const draggedEarly = byName(draggedMarkers, 'Early Rider');
    suite.check(
        'the early rider has moved along its line',
        draggedEarly !== null && draggedEarly.lon > 8 && draggedEarly.lat > 47,
        `lon=${draggedEarly?.lon} lat=${draggedEarly?.lat}`,
    );
    suite.check(
        'the later ride is running at the same fraction, not waiting for its offset',
        draggedEarly !== null &&
            byName(draggedMarkers, 'Late Rider')?.status === 'running' &&
            Math.abs(byName(draggedMarkers, 'Late Rider').progress - draggedFraction) < 1e-6,
        JSON.stringify(byName(draggedMarkers, 'Late Rider')),
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
    // Parked on a whole number of steps first. The `space` and `k` presses above
    // each ran the clock for a moment, and paused it wherever the animation frame
    // happened to land — a fraction of a step. A focused range snaps an arrow press
    // to its own step grid, so from a fractional value one press moves it to the
    // next step rather than *by* a step, and this would be measuring the rounding.
    await page.evaluate(() => window.mapimator.playback.pause());
    await page.evaluate(() => window.mapimator.playback.seek(0));
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
    // The multiplier is a claim about arithmetic — every frame's real delta,
    // times the speed — so it is checked as arithmetic rather than by timing two
    // windows from outside the browser.
    //
    // Timing two windows cannot work. The clock only advances when a frame runs,
    // so getElapsedMs() reports the last frame's value: a stall between a frame
    // and the read loses whatever those frames have not yet accounted for. Each
    // window was also a separate round trip, and page.waitForTimeout(400) is not
    // 400 ms of the browser's time. The two windows therefore never matched, and
    // the tolerance had to be 15 to 240 to cover the drift — a band wide enough
    // to pass a clock that was wrong by a factor of ten. Under load it failed
    // anyway, reporting a ratio of 13, which said nothing at all about the speed.
    //
    // Sampling on a frame removes both errors. The rAF timestamp handed to this
    // callback is the same value the clock was ticked with, and the clock's
    // deltas sum to exactly the span between two of them however many frames were
    // dropped in between, because a dropped frame is simply a longer delta. So
    // real time and clock time are bracketed by the same pair of instants, and
    // the rate comes out as the speed exactly. A slow machine changes how long
    // the windows take and nothing about the answer.
    const sample = () =>
        page.evaluate(
            () =>
                new Promise((resolve) => {
                    requestAnimationFrame((frameMs) => {
                        resolve({
                            real: frameMs,
                            sim: window.mapimator.playback.getElapsedMs(),
                        });
                    });
                }),
        );

    const runFor = async (ms) => {
        await page.evaluate(() => window.mapimator.playback.seek(0));
        await page.evaluate(() => window.mapimator.playback.play());
        const start = await sample();
        await page.waitForTimeout(ms);
        const end = await sample();
        await page.evaluate(() => window.mapimator.playback.pause());
        return { sim: end.sim - start.sim, real: end.real - start.real };
    };

    // Simulated milliseconds per real millisecond: one at 1x, sixty at 60x.
    const rate = (window_) => window_.sim / window_.real;

    await page.selectOption('#speed-select', '1');
    const at1x = await runFor(400);
    await page.selectOption('#speed-select', '60');
    const at60x = await runFor(400);
    suite.check(
        'the select reports the speed the clock is running at',
        (await page.evaluate(transportState)).speed === 60,
    );
    suite.check(
        'at 1x the clock runs at real time',
        Math.abs(rate(at1x) - 1) < 0.01,
        `1x rate ${rate(at1x).toFixed(4)} over ${at1x.real.toFixed(0)}ms`,
    );
    suite.check(
        'sixty times the rate moves the playhead sixty times as far',
        Math.abs(rate(at60x) / rate(at1x) - 60) < 0.5,
        `1x ${rate(at1x).toFixed(4)}, 60x ${rate(at60x).toFixed(4)}, ratio ${(
            rate(at60x) / rate(at1x)
        ).toFixed(2)}`,
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
        'every ride starts at zero, whichever order they were recorded in',
        atZero[0] === `0:00 · ${independentDistance(0)}` &&
            atZero[1] === `0:00 · ${independentDistance(0)}`,
        JSON.stringify(atZero),
    );

    // Halfway through the longer ride, both are halfway through: a ride recorded
    // 90 s later is not sitting at a dash waiting for the clock to catch up.
    const totalEarly = facts[0].durationMs;
    await seekAndSettle(page, totalEarly / 2, 'Early Rider', 0.5);
    const midEarly = await page.evaluate(readouts);
    // Straight lines, equal steps: half the time is half the distance.
    const halfDistance = facts[0].distanceM / 2;
    const expectedMid = `${independentDuration(totalEarly / 2)} · ${independentDistance(halfDistance)}`;
    suite.check(
        'the running ride reads its own elapsed time and distance',
        midEarly[0] === expectedMid,
        `${midEarly[0]} vs ${expectedMid}`,
    );
    const lateDistance = facts[1].distanceM * 0.5;
    suite.check(
        'and the later ride reads the same moment, not a dash',
        midEarly[1] ===
            `${independentDuration(totalEarly / 2)} · ${independentDistance(lateDistance)}`,
        midEarly[1],
    );
    suite.check(
        'and neither readout is a dash anywhere in the run',
        !midEarly.some((text) => text.includes('—')),
        JSON.stringify(midEarly),
    );

    const lateFacts = facts[1];
    const quarterDistance = lateFacts.distanceM * 0.25;
    await seekAndSettle(page, lateFacts.durationMs * 0.25, 'Late Rider', 0.25);
    const quarterLate = await page.evaluate(readouts);
    suite.check(
        'a quarter of the way in, each ride is a quarter of the way along its own line',
        quarterLate[1] ===
            `${independentDuration(lateFacts.durationMs * 0.25)} · ${independentDistance(quarterDistance)}`,
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
