import { join } from 'node:path';
import { countDifferent, regionPixels } from './harness.mjs';

const S = 1000;

export const fixtures = ['chart-rides.gpx', 'bulk.gpx', 'offset-riders.gpx'];

/**
 * Label reading, written from scratch, so the chart's numbers are checked against
 * what a label says rather than against the app's own copy of itself.
 */
/**
 * Read a label back into the unit it is written in, so a label can be checked
 * against the value it claims to be. Comparing the strings would mean copying the
 * app's rounding and padding into the test, which tests the copy rather than the
 * chart; this only has to know what a unit is worth.
 */
const UNIT_SCALE = { m: 1, km: 1000, 'm/s': 1, 'km/h': 1 / 3.6 };
const unitOf = (label) => label.split(' ')[1];
/**
 * A label is right if it is in the expected unit and rounds to the expected value —
 * the tolerance is half of the last digit the label actually prints, so "542 m" is
 * accepted for 541.56 m and "19.4 km/h" is not accepted for 19.42.
 */
const labelReads = (label, expected, unit) => {
    const [number, written] = label.split(' ');
    const decimals = (number.split('.')[1] ?? '').length;
    const read = Number(number.replace(/,/g, '')) * UNIT_SCALE[written];
    // The tolerance is the half of the last digit the label prints, and it is
    // scaled into metres before it is compared: "0.9 km" is allowed to stand for
    // 937.9 m, and "0.9 km" is also allowed to mean nothing more precise than
    // 950 m. Left unscaled it would be half a centimetre, which is not what a
    // label with one digit is claiming, and the check would reject a correct
    // answer for being written in kilometres.
    return (
        written === unit && Math.abs(read - expected) <= 0.5 * 10 ** -decimals * UNIT_SCALE[written]
    );
};

/**
 * Wait for every elevation model the app has been asked for to finish, answered
 * or given up on.
 *
 * Elevations are read from a terrain model once it answers, which happens after
 * the file has loaded, so a spec that reads them straight after a load reads two
 * different sets of numbers: the watch's on the first read and the ground's on
 * every read after that. Waiting here means each section reads one set.
 */
const waitForModels = (page) =>
    page.waitForFunction(() => window.mapimator.terrain.pending() === 0, null, {
        timeout: 60_000,
    });

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

/** What the store says a track is, for a comparison the chart has to meet. */
const trackFacts = () =>
    window.mapimator.store.getAll().map(({ track }) => ({
        id: track.id,
        name: track.name,
        color: track.color,
        durationMs: track.durationMs,
        distanceM: track.distanceM,
        timesS: Array.from(track.tRel),
        distM: Array.from(track.dist),
        eleM: Array.from(track.ele),
    }));

const chartState = () => {
    const region = document.getElementById('chart-region');
    const svg = region.querySelector('.chart-plot');
    const profiles = [...region.querySelectorAll('.chart-profile')].map((el) => ({
        trackId: el.dataset.trackId,
        stroke: el.getAttribute('stroke'),
        d: el.getAttribute('d') ?? '',
        /**
         * The length the SVG resolved, and the box it resolved to. An element can
         * hold a complete set of path data, the right class, and the right colour
         * and still paint nothing, because it was told about its shape in a way the
         * element does not read. This is the only way to tell that apart.
         */
        drawnLength: (() => {
            try {
                return el.getTotalLength();
            } catch {
                return -1;
            }
        })(),
        box: (() => {
            const b = el.getBBox();
            return { w: Math.round(b.width), h: Math.round(b.height) };
        })(),
    }));
    return {
        placeholderShown: region.querySelector('.placeholder')?.hasAttribute('hidden') === false,
        visible: svg?.hasAttribute('hidden') === false,
        profiles,
        label: svg?.getAttribute('aria-label') ?? null,
        /** The label text actually in the SVG, to catch a state that lies about it. */
        yLabelText: [...region.querySelectorAll('.chart-y-label')].map((el) => el.textContent),
        xLabelText: [...region.querySelectorAll('.chart-x-label')].map((el) => el.textContent),
        /** The dot positions as the SVG has them, which is the only thing on screen. */
        drawn: [...region.querySelectorAll('.chart-dot')].map((el) => ({
            trackId: el.dataset.trackId,
            cx: Number(el.getAttribute('cx')),
            cy: Number(el.getAttribute('cy')),
        })),
        guides: [...region.querySelectorAll('.chart-playhead')].map((el) => ({
            trackId: el.dataset.trackId,
            x1: Number(el.getAttribute('x1')),
            y1: Number(el.getAttribute('y1')),
            y2: Number(el.getAttribute('y2')),
        })),
        metric: window.mapimator.chart.getState().metric,
        pressed: [...region.querySelectorAll('.chart-metric')].map((el) => ({
            metric: el.dataset.metric,
            pressed: el.getAttribute('aria-pressed'),
        })),
        ...window.mapimator.chart.getState(),
    };
};

/** The path's own vertices, as [x, y] pairs. */
const pathPoints = (d) =>
    [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);

/** Shortest distance from a point to a polyline, not to its vertices. */
const distanceToPolyline = ([x, y], points) => {
    let best = Infinity;
    for (let i = 1; i < points.length; i += 1) {
        const [x1, y1] = points[i - 1];
        const [x2, y2] = points[i];
        const dx = x2 - x1;
        const dy = y2 - y1;
        const lengthSq = dx * dx + dy * dy;
        const t =
            lengthSq > 0 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSq)) : 0;
        const gap = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
        best = Math.min(best, gap);
    }
    return best;
};

/**
 * The cumulative distance a track had reached at a moment, worked out here from
 * the store's own arrays rather than by calling the app's interpolation.
 */
const distanceAtTime = (facts, timeMs) => {
    const timeS = timeMs / 1000;
    if (timeS <= facts.timesS[0]) {
        return facts.distM[0];
    }
    for (let i = 1; i < facts.timesS.length; i += 1) {
        if (timeS <= facts.timesS[i]) {
            const from = facts.timesS[i - 1];
            const span = facts.timesS[i] - from;
            const t = span > 0 ? (timeS - from) / span : 0;
            return facts.distM[i - 1] + (facts.distM[i] - facts.distM[i - 1]) * t;
        }
    }
    return facts.distM[facts.distM.length - 1];
};

const byName = (facts, name) => facts.find((f) => f.name === name) ?? null;

/**
 * The speed a ride is doing at one fix, worked out from the store's own arrays.
 *
 * Both rides have a fix every 5 s and the window is 15 s wide, so the window around
 * any fix away from the ends holds exactly its two neighbours — which makes the
 * smoothed speed here exactly the distance between them over the time between them.
 */
const speedAt = (facts, index) =>
    (facts.distM[index + 1] - facts.distM[index - 1]) /
    (facts.timesS[index + 1] - facts.timesS[index - 1]);

/**
 * Where a ride's elevation at a given fix falls in the plot, in the SVG's own
 * pixels, worked out from the axis the chart is currently using.
 *
 * A click is placed on the *line* rather than at the top or the bottom of the
 * plot, because which of two rides is on top of a plot is a property of where
 * they are on the ground. The Climber and the Cruiser are a degree apart, so on
 * the model's elevations the Cruiser is the higher of the two by two kilometres,
 * and a click at the top of the plot lands on the Cruiser whatever the test
 * meant. Placing the click on the line makes the check say what it is about.
 */
const pointOnLine = (state, xMax, distanceM, metres) => ({
    x: state.plot.left + (distanceM / xMax) * state.plot.width,
    y: state.plot.top + (1 - (metres - state.yMin) / (state.yMax - state.yMin)) * state.plot.height,
});

/** Click a data point on the chart, in the SVG's own pixel coordinates. */
const clickAt = async (page, x, y) => {
    await page.locator('#chart-region .chart-plot').click({ position: { x, y } });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
};

export async function run({ page, suite, errors, url, fixtures: fixtureDir }) {
    suite.section('EMPTY STATE');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.mapimator.areTrackLayersAttached(), null, {
        timeout: 30_000,
    });

    const empty = await page.evaluate(chartState);
    suite.check('the chart hides its plot with no tracks', empty.visible === false);
    suite.check('and says why instead', empty.placeholderShown === true);
    suite.check('and draws no profiles', empty.profiles.length === 0, `${empty.profiles.length}`);
    suite.check(
        'and the empty chart still says what it is',
        empty.label === 'No chart yet',
        JSON.stringify(empty.label),
    );
    suite.check(
        'the metric toggle is out of the way too',
        empty.pressed.length === 2,
        JSON.stringify(empty.pressed),
    );

    suite.section('TWO RIDES, A CLIMB AND A STOP');
    await load(page, fixtureDir, 'chart-rides.gpx');
    await waitForModels(page);
    const facts = await page.evaluate(trackFacts);
    const climber = byName(facts, 'Climber');
    const cruiser = byName(facts, 'Cruiser');
    suite.check('both rides loaded', facts.length === 2, `count=${facts.length}`);

    const loaded = await page.evaluate(chartState);
    suite.check(
        'one profile per track',
        loaded.profiles.length === 2,
        JSON.stringify(loaded.profiles.map((p) => p.trackId)),
    );
    suite.check(
        'each profile is drawn in its own track colour',
        loaded.profiles.every(
            (p) =>
                p.stroke === byName(facts, p.trackId === climber.id ? 'Climber' : 'Cruiser').color,
        ),
        JSON.stringify(loaded.profiles.map((p) => p.stroke)),
    );
    suite.check('the plot is shown once there is something to draw', loaded.visible === true);

    // The two checks above read the attributes. These read the pixels, because an
    // element can be given path data in a form it does not read, and then hold a
    // class, a colour, and a full set of coordinates while painting nothing at all.
    // That is not a hypothetical: it is what a `d` on a <polyline> does.
    suite.check(
        'each profile resolves to a line with real length',
        loaded.profiles.every((p) => p.drawnLength > 100),
        JSON.stringify(loaded.profiles.map((p) => p.drawnLength)),
    );
    suite.check(
        'which spans the plot rather than sitting at one point',
        loaded.profiles.every(
            (p) => p.box.w > 0.5 * loaded.plot.width && p.box.h > 0 && p.box.h < loaded.plot.height,
        ),
        JSON.stringify(loaded.profiles.map((p) => p.box)),
    );
    const plotPixels = await page.evaluate(() => {
        const r = document.querySelector('.chart-plot').getBoundingClientRect();
        return {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
        };
    });
    const painted = await regionPixels(page, plotPixels);
    await page.evaluate(() => {
        document.querySelector('.chart-profiles').style.visibility = 'hidden';
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    const withoutProfiles = await regionPixels(page, plotPixels);
    await page.evaluate(() => {
        document.querySelector('.chart-profiles').style.visibility = '';
    });
    const profilePixels = countDifferent(painted, withoutProfiles);
    suite.check(
        'and the profiles really are painted on screen',
        profilePixels > 200,
        `${profilePixels} px of the plot belong to the profiles`,
    );
    suite.check('it starts on elevation', loaded.metric === 'elevation');
    suite.check(
        'and names itself for a screen reader',
        loaded.label === 'Elevation against distance for 2 tracks. Click to seek.',
        JSON.stringify(loaded.label),
    );

    // The axis has to span every ride on it rather than just the one on screen,
    // and it is read against the store's own elevations rather than numbers
    // written out here: the elevations are the ground's, wherever they came from,
    // and a check that carried a copy of them would be testing the copy.
    const rideMin = Math.min(...facts.flatMap((f) => f.eleM));
    const rideMax = Math.max(...facts.flatMap((f) => f.eleM));
    suite.check(
        'the y-axis covers every ride on the chart',
        loaded.yMin === rideMin && loaded.yMax === rideMax,
        `${loaded.yMin}..${loaded.yMax} against ${rideMin}..${rideMax}`,
    );
    suite.check(
        'and the two rides really do sit far enough apart to need that',
        rideMax - rideMin > 100,
        `${rideMin}..${rideMax}`,
    );
    // In whatever unit the axis chose. These rides are a kilometre and change
    // apart on the model's elevations, and a label that insisted on metres would
    // be rejecting a correct answer; the next check holds it to using one unit
    // for both ends, and the one after that to that unit being the axis's.
    suite.check(
        'and labels both ends with the numbers on the axis',
        labelReads(loaded.yLabels[0], rideMax, unitOf(loaded.yLabels[0])) &&
            labelReads(loaded.yLabels[1], rideMin, unitOf(loaded.yLabels[1])),
        JSON.stringify(loaded.yLabels),
    );
    suite.check(
        'in one unit, so the two ends can be compared',
        unitOf(loaded.yLabels[0]) === unitOf(loaded.yLabels[1]),
        JSON.stringify(loaded.yLabels),
    );
    suite.check(
        'and those are the labels on screen',
        JSON.stringify(loaded.yLabelText) === JSON.stringify(loaded.yLabels),
        `${JSON.stringify(loaded.yLabelText)} vs ${JSON.stringify(loaded.yLabels)}`,
    );
    suite.check(
        'the x-axis runs to the longest ride',
        Math.abs(loaded.xMax - Math.max(climber.distanceM, cruiser.distanceM)) < 1,
        `${loaded.xMax} vs ${Math.max(climber.distanceM, cruiser.distanceM)}`,
    );
    suite.check(
        'the left end of the x-axis is labelled first, the way it is drawn',
        labelReads(loaded.xLabels[0], 0, unitOf(loaded.xLabels[0])),
        JSON.stringify(loaded.xLabels),
    );
    suite.check(
        'and the right end is labelled last',
        labelReads(loaded.xLabels[1], loaded.xMax, unitOf(loaded.xLabels[0])),
        JSON.stringify(loaded.xLabels),
    );
    // The state and the SVG are drawn from the same helper, so comparing them can
    // only catch the state drifting from what is on screen — which is the point, and
    // the reason it is checked rather than assumed.
    suite.check(
        'and the state reports the x labels in the order they are on screen',
        JSON.stringify(loaded.xLabelText) === JSON.stringify(loaded.xLabels),
        `${JSON.stringify(loaded.xLabelText)} vs ${JSON.stringify(loaded.xLabels)}`,
    );
    suite.check(
        'with those labels on screen too',
        JSON.stringify(loaded.xLabelText) === JSON.stringify(loaded.xLabels),
        `${JSON.stringify(loaded.xLabelText)}`,
    );

    suite.section('THE PLAYHEAD ON THE CHART');
    await page.evaluate((ms) => window.mapimator.playback.seek(ms), 50 * S);
    const halfway = await page.evaluate(chartState);
    const climberDot = halfway.dots.find((d) => d.trackId === climber.id);
    const cruiserDot = halfway.dots.find((d) => d.trackId === cruiser.id);
    suite.check(
        'there is a dot per track',
        halfway.dots.length === 2,
        JSON.stringify(halfway.dots),
    );

    // Climber's peak is at 0:50, so at half a minute past it the dot has to be
    // read off the descending side of the climb, on the drawn line.
    const expectedClimber = distanceAtTime(climber, 50 * S);
    suite.check(
        'the dot sits where that ride had got to at the playhead',
        Math.abs(climberDot.distanceM - expectedClimber) < 1.5,
        `${climberDot.distanceM} vs ${expectedClimber}`,
    );
    suite.check(
        'and the slower ride is behind it, at its own distance',
        cruiserDot.distanceM < climberDot.distanceM,
        `${cruiserDot.distanceM} vs ${climberDot.distanceM}`,
    );

    for (const dot of halfway.dots) {
        const line = halfway.profiles.find((p) => p.trackId === dot.trackId);
        const gap = distanceToPolyline([dot.x, dot.y], pathPoints(line.d));
        suite.check(
            `the ${dot.trackId === climber.id ? 'climber' : 'cruiser'} dot lies on its own line`,
            gap < 1.5,
            `${gap.toFixed(2)}px away`,
        );
    }

    suite.check(
        "a guide line per ride, at that ride's own distance",
        // The guides are drawn to a tenth of a pixel, so they are compared at that
        // resolution rather than exactly.
        halfway.guides.length === 2 &&
            halfway.guides.every((g) => {
                const dot = halfway.dots.find((d) => d.trackId === g.trackId);
                return dot && Math.abs(g.x1 - dot.x) <= 0.05;
            }),
        `${JSON.stringify(halfway.guides)} vs ${JSON.stringify(halfway.dots.map((d) => d.x))}`,
    );
    suite.check(
        'and the two guides are at different places, the rides being at different distances',
        Math.abs(halfway.guides[0].x1 - halfway.guides[1].x1) > 10,
        `${halfway.guides.map((g) => g.x1).join(', ')}`,
    );
    suite.check(
        'and each one spans the plot',
        halfway.guides.every(
            (g) => g.y1 === halfway.plot.top && g.y2 - g.y1 === halfway.plot.height,
        ),
        JSON.stringify(halfway.guides),
    );

    await page.evaluate((ms) => window.mapimator.playback.seek(ms), 0);
    const atStart = await page.evaluate(chartState);
    suite.check(
        'at the start every dot is on the start line',
        atStart.dots.every((d) => d.distanceM < 1),
        JSON.stringify(atStart.dots.map((d) => d.distanceM)),
    );
    suite.check(
        'and every guide has come back to it',
        atStart.guides.every((g) => g.x1 === atStart.plot.left),
        JSON.stringify(atStart.guides.map((g) => g.x1)),
    );

    suite.section('SWITCHING METRIC');
    await page.locator('.chart-metric[data-metric="speed"]').click();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    const speed = await page.evaluate(chartState);
    suite.check('the chart is on speed now', speed.metric === 'speed');
    suite.check(
        'and the name follows the quantity it is drawing',
        speed.label === 'Speed against distance for 2 tracks. Click to seek.',
        JSON.stringify(speed.label),
    );
    suite.check(
        'the toggle shows which one is selected',
        speed.pressed.find((p) => p.metric === 'speed').pressed === 'true' &&
            speed.pressed.find((p) => p.metric === 'elevation').pressed === 'false',
        JSON.stringify(speed.pressed),
    );
    // Both ends of the speed axis have to be in the same unit. The range runs from
    // the stop's zero up past 3 m/s, so labelling each end on its own would put km/h
    // at the top and m/s at the bottom, and the reader would have to convert between
    // the two labels to compare them.
    suite.check(
        'and one end does not switch unit out from under the other',
        unitOf(speed.yLabels[0]) === unitOf(speed.yLabels[1]),
        JSON.stringify(speed.yLabels),
    );
    suite.check(
        'with the numbers the axis actually runs between',
        labelReads(speed.yLabels[0], speed.yMax, unitOf(speed.yLabels[0])) &&
            labelReads(speed.yLabels[1], 0, unitOf(speed.yLabels[0])),
        JSON.stringify(speed.yLabels),
    );

    // Climber's moving rate is a step every 5 s; the top of the axis is that rate,
    // and its stop is the zero at the bottom.
    // `dist` is float32 and cumulative, so a rate recovered from it cannot be
    // compared for exact equality with one the app computed from the same array: the
    // running total carries a few parts in 100,000 of rounding by the fortieth fix,
    // and the two round the subtraction differently. That is still four orders of
    // magnitude tighter than a wrong window, a wrong index, or a missing divide.
    const sameRate = (a, b) => Math.abs(a - b) <= Math.abs(b) * 1e-4;
    const climberMoving = speedAt(climber, 5);
    const cruiserMoving = speedAt(cruiser, 20);
    suite.check(
        "the top of the speed axis is the faster ride's moving speed",
        sameRate(speed.yMax, climberMoving),
        `${speed.yMax} vs ${climberMoving}`,
    );
    suite.check('and the bottom of it is where the stop reads', speed.yMin === 0, `${speed.yMin}`);
    suite.check(
        'a ride that never stops has a dead flat speed profile',
        sameRate(cruiserMoving, speedAt(cruiser, 2)) &&
            sameRate(cruiserMoving, speedAt(cruiser, 38)),
        `${[2, 20, 38].map((i) => speedAt(cruiser, i)).join(', ')}`,
    );

    // Climber's stop is 50 seconds long, with one fix in the middle of it. That fix
    // and everything either side of it sit at the same distance, so the distance
    // cannot tell a rider waiting at a junction from the moment they arrived at it —
    // only the clock can. A marker read by distance would report the speed they had
    // on the way in.
    await page.evaluate((ms) => window.mapimator.playback.seek(ms), 70 * S);
    const stopped = await page.evaluate(chartState);
    const stoppedDot = stopped.dots.find((d) => d.trackId === climber.id);
    const movingDot = stopped.dots.find((d) => d.trackId === cruiser.id);
    suite.check(
        'a stationary section reads no speed at all',
        Math.abs(stoppedDot.value) < 1e-9,
        `${stoppedDot.value} m/s`,
    );
    suite.check(
        'while the ride alongside it carries on',
        sameRate(movingDot.value, cruiserMoving),
        `${movingDot.value} vs ${cruiserMoving} m/s`,
    );
    suite.check(
        'and the stationary ride is held at the distance it stopped at',
        Math.abs(stoppedDot.distanceM - climber.distM[9]) < 1e-6,
        `${stoppedDot.distanceM} vs ${climber.distM[9]}`,
    );
    // A stop drawn against distance is a vertical drop: the profile passes through
    // the same distance twice, once arriving and once standing still. The dot has to
    // be at the foot of it. Read by distance it would hang at the top of the drop, in
    // mid-air, still reporting the speed it had on the way in.
    const climberLine = pathPoints(stopped.profiles.find((p) => p.trackId === climber.id).d);
    suite.check(
        'and sits at the foot of the stop rather than above it',
        distanceToPolyline([stoppedDot.x, stoppedDot.y], climberLine) < 1.5,
        `${distanceToPolyline([stoppedDot.x, stoppedDot.y], climberLine).toFixed(2)}px from the line`,
    );

    // Switching metric rescales the axis, and the markers carry pixel coordinates,
    // so they have to be redrawn against it. Nothing else will: the clock is stopped,
    // so no transport tick is coming to put them right, and the switch is exactly
    // when they would be left behind.
    suite.check(
        'the markers are redrawn against the new axis, not left on the old one',
        speed.drawn.every((el) => {
            const dot = speed.dots.find((d) => d.trackId === el.trackId);
            return dot && Math.abs(el.cx - dot.x) <= 0.05 && Math.abs(el.cy - dot.y) <= 0.05;
        }),
        `${JSON.stringify(speed.drawn)} vs ${JSON.stringify(speed.dots)}`,
    );
    suite.check(
        'and they have actually moved, rather than being redrawn in place',
        speed.drawn.some((el) => {
            const before = halfway.drawn.find((d) => d.trackId === el.trackId);
            return before && Math.abs(el.cy - before.cy) > 1;
        }),
        `${JSON.stringify(halfway.drawn)} -> ${JSON.stringify(speed.drawn)}`,
    );

    await page.locator('.chart-metric[data-metric="elevation"]').click();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    const back = await page.evaluate(chartState);
    suite.check(
        'and the elevation axis comes back',
        back.metric === 'elevation' && back.yMax === rideMax,
        `${back.metric}/${back.yMax}`,
    );
    suite.check(
        'with the markers back on the elevation line',
        back.drawn.every((el) => {
            const dot = back.dots.find((d) => d.trackId === el.trackId);
            return dot && Math.abs(el.cy - dot.y) <= 0.05;
        }),
        `${JSON.stringify(back.drawn)} vs ${JSON.stringify(back.dots)}`,
    );

    suite.section('CLICKING THE CHART TO SEEK');
    await page.evaluate(() => window.mapimator.playback.seek(0));
    // The Climber's own peak, found in its elevations rather than written down
    // here, and clicked *on its line*. Its peak is the highest fix it has, so a
    // click there can only mean that fix, and the seek has to land on that fix's
    // time and nowhere else.
    const peakIndex = climber.eleM.indexOf(Math.max(...climber.eleM));
    const peakDistance = climber.distM[peakIndex];
    const peak = pointOnLine(halfway, loaded.xMax, peakDistance, climber.eleM[peakIndex]);
    await clickAt(page, peak.x, peak.y);
    const afterPeak = await page.evaluate(() => window.mapimator.playback.getElapsedMs());
    suite.check(
        'clicking the peak of a ride seeks to when it was there',
        Math.abs(afterPeak - climber.timesS[peakIndex] * S) < 1000,
        `${afterPeak}ms, expected about ${climber.timesS[peakIndex] * S}`,
    );
    const atPeak = await page.evaluate(chartState);
    suite.check(
        'and puts that ride back exactly where the click was',
        Math.abs(atPeak.dots.find((d) => d.trackId === climber.id).distanceM - peakDistance) < 1.5,
        `${atPeak.dots.find((d) => d.trackId === climber.id).distanceM} vs ${peakDistance}`,
    );

    await page.evaluate(() => window.mapimator.playback.seek(0));
    await clickAt(page, halfway.plot.left + 1, halfway.plot.top + 2);
    const nearStart = await page.evaluate(() => window.mapimator.playback.getElapsedMs());
    suite.check('clicking the far left seeks to the start', nearStart < 2 * S, `${nearStart}ms`);

    // The far right of the axis is the Climber's finish — it and the Cruiser cover
    // the same ground, so they finish at the same distance, and the Climber is the
    // lower of the two on the model's elevations. The click is placed on the
    // Climber's own line at that distance, so it lands on the Climber and nothing
    // else can answer for it. The seek then has to be the *end of that ride*, which
    // is not the shared total: the timeline runs as long as the longest ride, and
    // that one is the Cruiser. Worth pinning, because the obvious thing to expect is
    // the end of the timeline.
    await page.evaluate(() => window.mapimator.playback.seek(0));
    const finish = pointOnLine(
        halfway,
        loaded.xMax,
        climber.distM[climber.distM.length - 1],
        climber.eleM[climber.eleM.length - 1],
    );
    await clickAt(page, finish.x - 1, finish.y);
    const nearEnd = await page.evaluate(() => window.mapimator.playback.getElapsedMs());
    const total = await page.evaluate(() => window.mapimator.playback.getTotalMs());
    suite.check(
        'clicking the far right seeks to the end of the ride that is there',
        Math.abs(nearEnd - climber.durationMs) < 1000,
        `${nearEnd}ms, expected Climber's ${climber.durationMs}ms`,
    );
    suite.check(
        'which is short of the shared total, the longest ride being longer',
        total > nearEnd + S,
        `total ${total}ms vs seek ${nearEnd}ms`,
    );

    suite.section('RESIZING');
    const beforeResize = (await page.evaluate(chartState)).plot.width;
    await page.setViewportSize({ width: 900, height: 700 });
    await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    const afterResize = await page.evaluate(chartState);
    suite.check(
        'the plot follows the panel',
        afterResize.plot.width < beforeResize,
        `${afterResize.plot.width} vs ${beforeResize}`,
    );
    suite.check(
        'and every profile is redrawn against the new size',
        afterResize.profiles.every((p) => {
            const points = pathPoints(p.d);
            return points.length > 1 && Math.abs(points[0][0] - afterResize.plot.left) < 1.5;
        }),
        JSON.stringify(afterResize.profiles.map((p) => pathPoints(p.d)[0])),
    );
    // The markers carry pixel coordinates, so a resize has to put them back or they
    // sit wherever the old size put them. A paused ride gets no transport tick to do
    // it, which is why this is checked with the clock stopped.
    suite.check(
        'the markers are moved onto the new size as well',
        afterResize.dots.every(
            (d) =>
                d.x >= afterResize.plot.left - 1 &&
                d.x <= afterResize.plot.left + afterResize.plot.width + 1,
        ) &&
            afterResize.guides.every((g) => {
                const dot = afterResize.dots.find((d) => d.trackId === g.trackId);
                return dot && Math.abs(g.x1 - dot.x) <= 0.05;
            }),
        `${JSON.stringify(afterResize.dots.map((d) => d.x))} in ${afterResize.plot.left}..${afterResize.plot.left + afterResize.plot.width}`,
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );

    suite.section('A VERY LONG TRACK ALONGSIDE THE OTHERS');
    // Loads add to the store rather than replacing it, so the long track joins the
    // two rides rather than standing in for them. It is found by name, because its
    // position in the chart is the store's business, not the test's.
    const started = Date.now();
    await load(page, fixtureDir, 'bulk.gpx');
    const took = Date.now() - started;
    const withBulk = await page.evaluate(chartState);
    const bulkFacts = byName(await page.evaluate(trackFacts), 'Bulk');
    suite.check('the long track loaded', bulkFacts !== null, `${bulkFacts ? '' : 'not found'}`);
    suite.check(
        'and really is a very long track',
        bulkFacts.timesS.length > 50_000,
        `${bulkFacts.timesS.length} fixes`,
    );
    suite.check(
        'every track on the chart is still drawn',
        withBulk.profiles.length === 3,
        `${withBulk.profiles.length}`,
    );
    const bulkLine = withBulk.profiles.find((p) => p.trackId === bulkFacts.id);
    const bulkPoints = pathPoints(bulkLine?.d ?? '');
    suite.check(
        'and it is drawn decimated rather than point for point',
        bulkPoints.length > 1 && bulkPoints.length < bulkFacts.timesS.length / 10,
        `${bulkPoints.length} drawn points for ${bulkFacts.timesS.length} fixes`,
    );
    suite.check('which took no longer than a few seconds', took < 15_000, `${took}ms`);
    suite.check(
        'and a dot still follows the playhead on it',
        withBulk.dots.some((d) => d.trackId === bulkFacts.id),
        `${withBulk.dots.length} dots`,
    );

    suite.section('A SECOND COPY OF THE RIDES');
    await load(page, fixtureDir, 'chart-rides.gpx');
    await waitForModels(page);
    const five = await page.evaluate(chartState);
    const fiveFacts = await page.evaluate(trackFacts);
    suite.check(
        'both copies load, so there are five rides',
        fiveFacts.length === 5,
        `${fiveFacts.length}`,
    );
    suite.check(
        'and the chart draws one profile for each',
        five.profiles.length === 5,
        `${five.profiles.length}`,
    );
    suite.check(
        'each in its own colour',
        new Set(five.profiles.map((p) => p.stroke)).size === 5,
        JSON.stringify(five.profiles.map((p) => p.stroke)),
    );
    // The axis has to cover every ride on it. Read against the store's own
    // elevations, with one thing deliberately *not* asserted: the top of the axis is
    // the top of the long ride's *drawn* profile, and that ride is decimated, so its
    // extremes are bucket averages and can sit inside the real ones. The axis follows
    // what is drawn, which is why nothing can ever fall off the top of it.
    const elevations = fiveFacts.flatMap((f) => f.eleM);
    const lowest = Math.min(...elevations);
    const highest = Math.max(...elevations);
    // The axis follows the drawn curve, and the long ride's ends are bucket
    // averages of decimated data, so each end of the axis can sit a little inside
    // the true extreme. One percent of the span is the room it is given, and it is
    // room rather than a second number to match, because how far inside a
    // decimated bucket average lands is a property of the decimation.
    const slack = (highest - lowest) * 0.01;
    suite.check(
        'and the y-axis still covers every one of them',
        five.yMin <= lowest + slack && five.yMax >= highest - slack,
        `${five.yMin}..${five.yMax} does not cover ${lowest}..${highest}`,
    );
    suite.check(
        'without inventing a range the rides do not have',
        five.yMin >= lowest && five.yMax <= highest,
        `${five.yMin}..${five.yMax} against ${lowest}..${highest}`,
    );

    suite.check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}
