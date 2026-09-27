import { join } from 'node:path';

/**
 * Phase 6: the camera keeps a played run in view.
 *
 * `followCamera.test.ts` pins the geometry exactly — the margin, the worst-of
 * -two-markers rule, the cancelling-overflows case — with plain numbers and no
 * browser. `transport.test.ts` pins the wiring — suspend, resume, dispose —
 * against a fake camera. What only a real browser can show is that a genuine
 * MapLibre projection agrees with that geometry, and that a genuine mouse drag
 * on the map produces the `originalEvent` the suspend logic is watching for.
 * So the checks here stay coarse on purpose: "on screen" and "off screen",
 * not the exact pixel the margin sits at — that number is the unit tests' job,
 * and duplicating it here would only make this suite break in step with a
 * tuning change that broke nothing.
 */

export const fixtures = ['ride.gpx'];

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

/** Where the one marker is on screen, and how big the map is, right now. */
const markerState = () => {
    const source = window.mapimator.map.getSource('track-markers');
    const raw = source?._data;
    const data = raw && raw.geojson ? raw.geojson : raw;
    const feature = data?.features?.[0];
    const container = window.mapimator.map.getContainer();
    const center = window.mapimator.map.getCenter();
    return {
        marker: feature ? window.mapimator.map.project(feature.geometry.coordinates) : null,
        width: container.clientWidth,
        height: container.clientHeight,
        center: [center.lng, center.lat],
        zoom: window.mapimator.map.getZoom(),
        elapsed: window.mapimator.playback.getElapsedMs(),
        suspended: window.mapimator.playback.isFollowSuspended(),
    };
};

export async function run({ page, suite, errors, url, fixtures: fixtureDir }) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.mapimator.areTrackLayersAttached(), null, {
        timeout: 30_000,
    });
    await load(page, fixtureDir, 'ride.gpx');

    // Presses play and resolves after exactly two animation frames — the first
    // only primes the clock's own delta, per its own tick() contract, so the
    // first frame in which a correction can happen is the second. Frame-counted
    // rather than timed, so it takes however long the machine's frames take and
    // proves the same thing regardless of how slow that is.
    const playTwoFramesInPage = () =>
        page.evaluate(
            () =>
                new Promise((resolve) => {
                    window.mapimator.playback.play();
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            resolve();
                        });
                    });
                }),
        );

    suite.section('THE MARKER STARTS OFF THE PADDED EDGE OF THE FIT');
    const before = await page.evaluate(markerState);
    await playTwoFramesInPage();
    await page.evaluate(() => window.mapimator.playback.pause());
    const afterStart = await page.evaluate(markerState);
    suite.check(
        'two frames in, the marker sits inside the visible map',
        afterStart.marker &&
            afterStart.marker.x >= 0 &&
            afterStart.marker.x <= afterStart.width &&
            afterStart.marker.y >= 0 &&
            afterStart.marker.y <= afterStart.height,
        JSON.stringify(afterStart.marker),
    );
    suite.check(
        'getting it there moved the camera',
        afterStart.center[0] !== before.center[0] || afterStart.center[1] !== before.center[1],
        `${JSON.stringify(before.center)} -> ${JSON.stringify(afterStart.center)}`,
    );
    suite.check(
        'and never by zooming',
        afterStart.zoom === before.zoom,
        `${before.zoom} -> ${afterStart.zoom}`,
    );

    suite.section('THE MIDDLE OF A STRAIGHT LINE IS ALREADY WELL FRAMED');
    // Ride.gpx runs corner to corner of its own fitted bounds, so its own
    // midpoint lands close to the centre of the viewport with no help at all.
    await page.evaluate(() => window.mapimator.playback.seek(120_000));
    const beforeMiddle = await page.evaluate(markerState);
    await playTwoFramesInPage();
    await page.evaluate(() => window.mapimator.playback.pause());
    const afterMiddle = await page.evaluate(markerState);
    suite.check(
        'so two frames of play move the camera not at all',
        afterMiddle.center[0] === beforeMiddle.center[0] &&
            afterMiddle.center[1] === beforeMiddle.center[1],
        `${JSON.stringify(beforeMiddle.center)} -> ${JSON.stringify(afterMiddle.center)}`,
    );

    suite.section('A REAL DRAG SUSPENDS IT');
    await page.evaluate(() => window.mapimator.playback.seek(0));
    await page.selectOption('#speed-select', '5');
    await page.evaluate(() => window.mapimator.playback.play());
    // Real time, not frames: a drag is a sequence of real mouse events, and the
    // point is only to land it somewhere inside the first ~7 real seconds
    // (36 track-seconds at 5x) during which the marker is still off the padded
    // edge and the camera is actively correcting.
    await page.waitForTimeout(300);
    const box = await page.locator('#map').boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4, { steps: 8 });
    await page.mouse.up();
    // A real drag can leave MapLibre's own inertia easing the camera onward for a
    // moment after the release, which is nothing to do with following — waiting
    // for that to finish is what makes "holds still" below an exact claim rather
    // than a race against MapLibre's glide.
    await page.waitForFunction(() => !window.mapimator.map.isMoving(), null, { timeout: 5_000 });
    const afterDrag = await page.evaluate(markerState);
    suite.check('the drag suspends following', afterDrag.suspended === true);

    // With following suspended, the marker keeps moving along its line but the
    // camera the drag left behind has to hold exactly still — not "roughly", not
    // "eventually settles" — for as long as it stays suspended. Where exactly the
    // drag left the camera is not the point, so this does not assume a position.
    await page.waitForTimeout(1500);
    const stillSuspended = await page.evaluate(markerState);
    suite.check(
        'and the camera stays exactly where the drag left it, not pulled back next frame',
        stillSuspended.center[0] === afterDrag.center[0] &&
            stillSuspended.center[1] === afterDrag.center[1],
        `${JSON.stringify(afterDrag.center)} -> ${JSON.stringify(stillSuspended.center)}`,
    );

    suite.section('PRESSING PLAY AGAIN RE-ARMS IT');
    await page.evaluate(() => window.mapimator.playback.pause());
    await page.evaluate(() => window.mapimator.playback.play());
    const rearmed = await page.evaluate(markerState);
    suite.check('following is no longer suspended', rearmed.suspended === false);
    await page.waitForFunction(
        () => {
            const source = window.mapimator.map.getSource('track-markers');
            const raw = source?._data;
            const data = raw && raw.geojson ? raw.geojson : raw;
            const feature = data?.features?.[0];
            if (!feature) return false;
            const p = window.mapimator.map.project(feature.geometry.coordinates);
            const c = window.mapimator.map.getContainer();
            return p.x >= 0 && p.x <= c.clientWidth && p.y >= 0 && p.y <= c.clientHeight;
        },
        null,
        { timeout: 15_000 },
    );
    suite.check('and the marker is brought back on screen', true);
    await page.evaluate(() => window.mapimator.playback.pause());
    await page.selectOption('#speed-select', '1');

    suite.section('A HIDDEN RUN IS EXCLUDED FROM FOLLOWING');
    await page.evaluate(() => window.mapimator.playback.seek(0));
    const beforeHide = await page.evaluate(markerState);
    await page.click('.legend-item .legend-toggle');
    await page.evaluate(() => window.mapimator.playback.play());
    await page.waitForTimeout(500);
    await page.evaluate(() => window.mapimator.playback.pause());
    const whileHidden = await page.evaluate(markerState);
    suite.check('playback still ran', whileHidden.elapsed > 0, `elapsed=${whileHidden.elapsed}`);
    suite.check(
        'but the camera never moved, because there was nothing left to follow',
        whileHidden.center[0] === beforeHide.center[0] &&
            whileHidden.center[1] === beforeHide.center[1],
        `${JSON.stringify(beforeHide.center)} -> ${JSON.stringify(whileHidden.center)}`,
    );

    suite.check('no console errors', errors.length === 0, errors.join(' | '));
}
