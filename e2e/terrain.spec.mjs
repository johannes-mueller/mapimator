import { join } from 'node:path';

export const fixtures = ['terrain-run-a.gpx', 'terrain-run-b.gpx'];

/**
 * The height of the Lauterbrunnen valley, in metres, as a terrain model reports
 * it: a 600 m drop under a cliff. Two watches recording this route disagree by
 * hundreds of metres and neither is close, so a model elevation is easy to tell
 * from a recorded one.
 *
 * These are bands rather than the model's exact numbers, because the model is a
 * third party that may sharpen its data. What has to stay true is that the number
 * on screen is a height of this valley and not a watch's opinion of it.
 */
const MODEL_PEAK = [1300, 1500];
const MODEL_FLOOR = [700, 850];
/** The band each fixture's watch recorded, which the model has to displace. */
const RECORDED_A = [850, 950];
const RECORDED_B = [1050, 1150];

/** Is one reading inside a band? */
const within = (value, [low, high]) => value >= low && value <= high;
/** Does every reading of a track fall inside a band? */
const allIn = (values, band) => values.every((e) => within(e, band));
const range = (values) => [Math.min(...values), Math.max(...values)];

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
 * Wait for every model the app has been asked for to finish, answered or given up
 * on. The app counts them, so this waits on the work rather than on a delay, and a
 * model that never arrives fails here instead of quietly reading as a fallback.
 */
const waitForModels = (page) =>
    page.waitForFunction(() => window.mapimator.terrain.pending() === 0, null, {
        timeout: 60_000,
    });

/** What the store and the chart say about elevation, for a comparison. */
const elevationFacts = () => ({
    tracks: window.mapimator.store.getAll().map(({ track }) => ({
        name: track.name,
        eleM: Array.from(track.ele),
    })),
    chart: window.mapimator.chart.getState(),
    applied: window.mapimator.terrain.applied(),
});

const byName = (facts, name) => facts.find((t) => t.name === name);

export async function run({ page, suite, errors, url, fixtures: fixtureDir }) {
    suite.section('ELEVATION FROM A TERRAIN MODEL');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.mapimator.areTrackLayersAttached(), null, {
        timeout: 30_000,
    });

    await load(page, fixtureDir, 'terrain-run-a.gpx');
    const shown = await page.evaluate(elevationFacts);

    // A track is never withheld while a network is waited on, so the recorded
    // altitude has to be on screen before the model is.
    suite.check(
        'a track is not held back waiting for the model',
        allIn(shown.tracks[0].eleM, RECORDED_A),
        `reads ${shown.tracks[0].eleM[0]} m`,
    );
    suite.check(
        'a model was asked for',
        shown.applied === 0 || shown.applied === 1,
        `${shown.applied}`,
    );

    await waitForModels(page);
    const model = await page.evaluate(elevationFacts);
    const runA = byName(model.tracks, 'Run A');
    const modelPeak = range(runA.eleM);

    suite.check('the model answered', model.applied === 1, `applied=${model.applied}`);
    suite.check(
        'the store holds the model, not the watch',
        within(runA.eleM[0], MODEL_PEAK),
        `first fix reads ${runA.eleM[0]} m`,
    );
    suite.check(
        'the model puts the climb back',
        within(modelPeak[1], MODEL_PEAK),
        `peak ${Math.round(modelPeak[1])} m`,
    );
    suite.check(
        'and the drop to the valley floor',
        within(modelPeak[0], MODEL_FLOOR),
        `floor ${Math.round(modelPeak[0])} m`,
    );
    suite.check(
        'no recorded altitude survived',
        !allIn(runA.eleM, RECORDED_A),
        `${runA.eleM.filter((e) => within(e, RECORDED_A)).length} of ${runA.eleM.length} still in the recorded band`,
    );
    suite.check(
        'the chart is scaled to the model',
        within(model.chart.yMax, MODEL_PEAK) && within(model.chart.yMin, MODEL_FLOOR),
        `y ${model.chart.yMin}..${model.chart.yMax}`,
    );
    suite.check(
        'the axis is neither watch',
        !within(model.chart.yMax, RECORDED_A) && !within(model.chart.yMax, RECORDED_B),
        `yMax ${model.chart.yMax}`,
    );

    suite.section('THE SAME ROUTE, RECORDED BY TWO WATCHES THAT DISAGREE');
    await load(page, fixtureDir, 'terrain-run-b.gpx');
    await waitForModels(page);
    const both = await page.evaluate(elevationFacts);
    const first = byName(both.tracks, 'Run A');
    const second = byName(both.tracks, 'Run B');

    suite.check('both runs loaded', both.tracks.length === 2, `count=${both.tracks.length}`);
    suite.check('a model answered for each', both.applied === 2, `applied=${both.applied}`);

    // Compared point for point rather than as ranges, so two curves that happen
    // to share a peak and a floor still fail this.
    const identical =
        first.eleM.length === second.eleM.length &&
        first.eleM.every((e, i) => e === second.eleM[i]);
    suite.check(
        'both runs get the identical profile',
        identical,
        identical ? `${first.eleM.length} points` : `${first.eleM[0]} vs ${second.eleM[0]}`,
    );
    suite.check(
        'and it is the model, not either watch',
        within(first.eleM[0], MODEL_PEAK) && within(range(second.eleM)[0], MODEL_FLOOR),
        `first ${first.eleM[0]} m, floor ${Math.round(range(second.eleM)[0])} m`,
    );

    suite.section('WHEN THE MODEL CANNOT BE REACHED');
    // A fresh page with the host blocked, so the model never gets a chance to
    // answer and the recorded altitude is the only elevation there is. Both runs
    // are loaded, which is also the proof that the two recordings really do
    // disagree — without it, an identical profile could be two fallbacks that
    // happen to match rather than one model answering twice.
    const blocked = await page.context().newPage();
    const blockedErrors = [];
    blocked.on('console', (m) => {
        if (m.type() === 'error') {
            blockedErrors.push(m.text());
        }
    });
    blocked.on('pageerror', (e) => blockedErrors.push(`pageerror: ${e.message}`));
    let requests = 0;
    blocked.on('request', (r) => {
        if (r.url().includes('elevation-tiles-prod')) {
            requests += 1;
        }
    });
    await blocked.route('**/elevation-tiles-prod/**', (route) => route.abort());

    await blocked.goto(url, { waitUntil: 'domcontentloaded' });
    await blocked.waitForFunction(() => window.mapimator.areTrackLayersAttached(), null, {
        timeout: 30_000,
    });
    await load(blocked, fixtureDir, 'terrain-run-a.gpx', 'terrain-run-b.gpx');
    await waitForModels(blocked);
    const offline = await blocked.evaluate(elevationFacts);
    const keptA = byName(offline.tracks, 'Run A').eleM;
    const keptB = byName(offline.tracks, 'Run B').eleM;

    suite.check('the app did ask for a model', requests > 0, `${requests} requests`);
    suite.check('and was refused', offline.applied === 0, `applied=${offline.applied}`);
    suite.check(
        "run A's recorded altitude is kept exactly",
        allIn(keptA, RECORDED_A),
        `${Math.round(range(keptA)[0])}..${Math.round(range(keptA)[1])} m`,
    );
    suite.check(
        "run B's recorded altitude is kept exactly",
        allIn(keptB, RECORDED_B),
        `${Math.round(range(keptB)[0])}..${Math.round(range(keptB)[1])} m`,
    );
    suite.check(
        'so the two profiles are not identical, as the recordings were not',
        !keptA.every((e, i) => e === keptB[i]),
        `a gap of ${Math.round(range(keptB)[0] - range(keptA)[0])} m at the floor`,
    );
    suite.check(
        'the chart still draws both',
        offline.chart.trackIds.length === 2 &&
            within(offline.chart.yMax, RECORDED_B) &&
            within(offline.chart.yMin, RECORDED_A),
        `y ${offline.chart.yMin}..${offline.chart.yMax}, ${offline.chart.trackIds.length} profiles`,
    );
    suite.check(
        'nothing threw',
        blockedErrors.every((text) =>
            /net::ERR_FAILED|ERR_ABORTED|Failed to load resource/.test(text),
        ),
        blockedErrors
            .filter((t) => !/net::ERR_FAILED|ERR_ABORTED|Failed to load resource/.test(t))
            .join(' | '),
    );
    suite.note(
        `the browser logged ${blockedErrors.length} refused resource loads, which is the network talking, not the app`,
    );
    await blocked.close();

    suite.check(
        'no console errors anywhere in this suite',
        errors.length === 0,
        errors.join(' | '),
    );
}
