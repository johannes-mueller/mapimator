import { join } from 'node:path';

export const fixtures = ['chart-rides.gpx'];

/** The two runs in chart-rides.gpx, which cover the same ground at different speeds. */
const CLIMBER = 'Climber';
const CRUISER = 'Cruiser';

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

/** Wait for every elevation model the app asked for, so heights are settled. */
const waitForModels = (page) =>
    page.waitForFunction(() => window.mapimator.terrain.pending() === 0, null, {
        timeout: 60_000,
    });

/**
 * What is drawn for each run, read from the DOM and the map sources rather than
 * from the store — the store is not the question, what reached the screen is.
 *
 * This has to be self-contained: `page.evaluate` ships the function to the
 * browser, so it cannot see anything defined out here. The track ids come from
 * the data each source actually holds, which MapLibre v6 keeps at `_data.geojson`
 * and which reads as empty rather than missing once it has been emptied.
 */
const drawnState = () => {
    const sourceIds = (id) => {
        const source = window.mapimator.map.getSource(id);
        const raw = source?._data;
        const data = raw && raw.geojson ? raw.geojson : raw;
        if (!data || data.type !== 'FeatureCollection') {
            return [];
        }
        return data.features.map((f) => f.properties?.trackId);
    };
    const legendRows = [...document.querySelectorAll('.legend-item')].map((item) => {
        const toggle = item.querySelector('.legend-toggle');
        return {
            trackId: item.dataset.trackId,
            name: item.querySelector('.legend-name')?.textContent ?? '',
            pressed: toggle?.getAttribute('aria-pressed') ?? null,
            toggleLabel: toggle?.getAttribute('aria-label') ?? null,
            toggleText: toggle?.textContent ?? '',
            dimmed: item.classList.contains('legend-item-hidden'),
            readout: item.querySelector('.legend-readout')?.textContent ?? '',
        };
    });
    const region = document.getElementById('chart-region');
    const svg = region.querySelector('.chart-plot');
    return {
        legendRows,
        /** One entry per line actually in the map source. */
        mapLines: sourceIds('track-lines'),
        profiles: [...region.querySelectorAll('.chart-profile')].map((el) => el.dataset.trackId),
        chartVisible: svg?.hasAttribute('hidden') === false,
        chartLabel: svg?.getAttribute('aria-label') ?? null,
        placeholderShown: region.querySelector('.placeholder')?.hasAttribute('hidden') === false,
        placeholder: region.querySelector('.placeholder')?.textContent ?? '',
        dots: window.mapimator.chart.getState().dots.map((d) => d.trackId),
        totalMs: window.mapimator.playback.getTotalMs(),
    };
};

const rowFor = (state, name) => state.legendRows.find((r) => r.name === name);

/**
 * Why rows are found by walking them rather than by selector: an evaluate body
 * runs in the browser against the real DOM, where neither Playwright's
 * `:text-is()` nor a `:has()` built around it is a selector that exists. A row
 * with a name in it has to be found the plain way, by reading the names out.
 */
/** The label on whatever currently has focus, which is how focus is located. */
const activeLabel = () => document.activeElement?.getAttribute('aria-label') ?? null;

const pressToggle = async (page, name) => {
    await page.evaluate((n) => {
        for (const item of document.querySelectorAll('.legend-item')) {
            if (item.querySelector('.legend-name')?.textContent === n) {
                item.querySelector('.legend-toggle').click();
                return;
            }
        }
        throw new Error(`no legend row named ${n}`);
    }, name);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
};

export async function run({ page, suite, errors, url, fixtures: fixtureDir }) {
    suite.section('TWO RUNS, AND A TOGGLE ON EACH');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.mapimator.areTrackLayersAttached(), null, {
        timeout: 30_000,
    });
    await load(page, fixtureDir, 'chart-rides.gpx');
    await waitForModels(page);

    // The app's own words for a run. Pinned here because nothing else in the
    // suite looks at them, and a string that reads right in a diff can still be
    // the one place the app says "track" to a user.
    const wording = await page.evaluate(() => ({
        load: document.querySelector('.dz-hint')?.textContent ?? '',
        list: document.getElementById('legend-region')?.getAttribute('aria-label') ?? null,
    }));
    suite.check(
        'the load message calls them runs',
        wording.load === 'Loaded 2 runs.',
        JSON.stringify(wording.load),
    );
    suite.check(
        'and the list is labelled as a list of runs',
        wording.list === 'Run list',
        String(wording.list),
    );

    const before = await page.evaluate(drawnState);
    suite.check(
        'both runs are listed',
        before.legendRows.length === 2,
        `${before.legendRows.length}`,
    );
    suite.check(
        'both are switched on to begin with',
        before.legendRows.every((r) => r.pressed === 'true'),
        JSON.stringify(before.legendRows.map((r) => r.pressed)),
    );
    suite.check(
        'the toggle says what pressing it will do',
        before.legendRows.every((r) => r.toggleLabel === `Hide ${r.name}`),
        JSON.stringify(before.legendRows.map((r) => r.toggleLabel)),
    );
    suite.check(
        'both runs are drawn on the map',
        before.mapLines.length === 2,
        JSON.stringify(before.mapLines),
    );
    suite.check(
        'both are drawn on the chart',
        before.profiles.length === 2,
        JSON.stringify(before.profiles),
    );
    suite.check(
        'both have a marker following the playhead',
        before.dots.length === 2,
        JSON.stringify(before.dots),
    );

    suite.section('HIDING A RUN TAKES IT OFF THE MAP AND THE CHART');
    await pressToggle(page, CRUISER);
    const hidden = await page.evaluate(drawnState);
    const hiddenRow = rowFor(hidden, CRUISER);
    const shownRow = rowFor(hidden, CLIMBER);

    suite.check(
        'the run stays in the legend',
        hidden.legendRows.length === 2,
        `${hidden.legendRows.length}`,
    );
    suite.check(
        'and says it is switched off',
        hiddenRow?.pressed === 'false',
        String(hiddenRow?.pressed),
    );
    suite.check(
        'the label now says what pressing it will do instead',
        hiddenRow?.toggleLabel === `Show ${CRUISER}`,
        String(hiddenRow?.toggleLabel),
    );
    suite.check(
        'the row is dimmed rather than gone',
        hiddenRow?.dimmed === true,
        String(hiddenRow?.dimmed),
    );

    suite.check(
        'its line leaves the map',
        hidden.mapLines.length === 1,
        JSON.stringify(hidden.mapLines),
    );
    suite.check(
        'and it is the other run that is still there',
        hidden.mapLines.includes(shownRow.trackId) === true,
        JSON.stringify(hidden.mapLines),
    );
    suite.check(
        'its chart profile goes',
        hidden.profiles.length === 1,
        JSON.stringify(hidden.profiles),
    );
    suite.check(
        'and it is the other run that is still drawn',
        hidden.profiles.includes(shownRow.trackId),
        JSON.stringify(hidden.profiles),
    );
    suite.check(
        'its marker stops following the playhead',
        hidden.dots.length === 1,
        JSON.stringify(hidden.dots),
    );
    suite.check(
        'the chart is still up, because one run is still on it',
        hidden.chartVisible === true,
    );

    suite.section('HIDING IS ONLY ABOUT WHAT IS DRAWN');
    // The decision this was built to: a run that cannot be seen still counts.
    suite.check(
        'the run keeps its data in the store',
        (await page.evaluate(() => window.mapimator.store.getAll().length)) === 2,
    );
    suite.check(
        'and the run is exactly as long as it was',
        hidden.totalMs === before.totalMs,
        `${before.totalMs} then ${hidden.totalMs}`,
    );
    suite.check(
        'which is the longest run, still',
        hidden.totalMs ===
            (await page.evaluate((n) => {
                const runs = window.mapimator.store.getAll().map((s) => s.track);
                return Math.max(...runs.filter((t) => t.name === n).map((t) => t.durationMs));
            }, CRUISER)),
        `${hidden.totalMs}`,
    );

    suite.check(
        'the hidden run still reports where it is',
        hiddenRow.readout !== '' && hiddenRow.readout !== '—',
        JSON.stringify(hiddenRow.readout),
    );

    suite.section('SWITCHING IT BACK ON');
    await pressToggle(page, CRUISER);
    const back = await page.evaluate(drawnState);
    suite.check(
        'it says it is switched on again',
        rowFor(back, CRUISER)?.pressed === 'true',
        String(rowFor(back, CRUISER)?.pressed),
    );
    suite.check('the row is no longer dimmed', rowFor(back, CRUISER)?.dimmed === false);
    suite.check('its line comes back', back.mapLines.length === 2, JSON.stringify(back.mapLines));
    suite.check(
        'its chart profile comes back',
        back.profiles.length === 2,
        JSON.stringify(back.profiles),
    );
    suite.check('and its marker comes back', back.dots.length === 2, JSON.stringify(back.dots));

    suite.section('THE TOGGLE SURVIVES THE POINTER AND THE KEYBOARD');
    // The legend writes rows in place precisely so a button does not move out
    // from under whatever is on it. A rebuild would replace the button that was
    // just pressed, and the focus with it.
    const identity = await page.evaluate((n) => {
        let toggle = null;
        for (const item of document.querySelectorAll('.legend-item')) {
            if (item.querySelector('.legend-name')?.textContent === n) {
                toggle = item.querySelector('.legend-toggle');
            }
        }
        return toggle
            ? { tag: toggle.tagName, type: toggle.type, disabled: toggle.disabled }
            : null;
    }, CLIMBER);
    suite.check(
        'the toggle is a real button, and not disabled',
        identity?.tag === 'BUTTON' && identity?.type === 'button' && !identity?.disabled,
        JSON.stringify(identity),
    );

    await page.evaluate((n) => {
        for (const item of document.querySelectorAll('.legend-item')) {
            if (item.querySelector('.legend-name')?.textContent === n) {
                item.querySelector('.legend-toggle').focus();
                return;
            }
        }
    }, CLIMBER);
    const focusedBefore = await page.evaluate(activeLabel);
    suite.check(
        'it can take keyboard focus',
        focusedBefore === `Hide ${CLIMBER}`,
        String(focusedBefore),
    );

    await page.keyboard.press('Enter');
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    const afterEnter = await page.evaluate(drawnState);
    const focusedAfter = await page.evaluate(activeLabel);
    suite.check(
        'pressing it hides the run',
        afterEnter.mapLines.length === 1,
        JSON.stringify(afterEnter.mapLines),
    );
    suite.check(
        'and focus is still on that same toggle, not lost to the page',
        focusedAfter === `Show ${CLIMBER}`,
        String(focusedAfter),
    );
    suite.check(
        'and the row it belongs to is still the same element',
        (await page.evaluate((n) => {
            for (const item of document.querySelectorAll('.legend-item')) {
                if (item.querySelector('.legend-name')?.textContent === n) {
                    return item.contains(document.activeElement);
                }
            }
            return false;
        }, CLIMBER)) === true,
    );

    await page.keyboard.press('Space');
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    const afterSpace = await page.evaluate(drawnState);
    suite.check(
        'pressing it again shows the run',
        afterSpace.mapLines.length === 2,
        JSON.stringify(afterSpace.mapLines),
    );
    suite.check('with focus still on it', (await page.evaluate(activeLabel)) === `Hide ${CLIMBER}`);

    suite.section('SWITCHING EVERY RUN OFF');
    await pressToggle(page, CLIMBER);
    await pressToggle(page, CRUISER);
    const none = await page.evaluate(drawnState);
    suite.check(
        'both runs are still listed',
        none.legendRows.length === 2,
        `${none.legendRows.length}`,
    );
    suite.check(
        'the map has nothing left on it',
        none.mapLines.length === 0,
        JSON.stringify(none.mapLines),
    );
    suite.check(
        'the chart draws no profiles',
        none.profiles.length === 0,
        JSON.stringify(none.profiles),
    );
    suite.check('the chart hides its plot', none.chartVisible === false);
    suite.check(
        'and says why, rather than claiming there is no chart',
        none.placeholderShown === true && /switched off/i.test(none.placeholder),
        JSON.stringify(none.placeholder),
    );
    suite.check(
        'which the screen reader is told too',
        /switched off/i.test(none.chartLabel ?? ''),
        String(none.chartLabel),
    );
    suite.check(
        'and the run is still the length it was',
        none.totalMs === before.totalMs,
        `${before.totalMs} then ${none.totalMs}`,
    );

    suite.section('AND BACK ON FROM THERE');
    await pressToggle(page, CLIMBER);
    const oneBack = await page.evaluate(drawnState);
    suite.check(
        'one run back is enough to draw a chart',
        oneBack.chartVisible === true,
        String(oneBack.chartVisible),
    );
    suite.check(
        'and only that run is on it',
        oneBack.profiles.length === 1,
        JSON.stringify(oneBack.profiles),
    );
    suite.check(
        'with the placeholder gone',
        oneBack.placeholderShown === false,
        JSON.stringify(oneBack.placeholder),
    );

    suite.check(
        'no console errors through the whole cycle',
        errors.length === 0,
        errors.join(' | '),
    );
}
