import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SHOT_DIR, analyzeRegion, startStaticServer } from './harness.mjs';

const MAP_REGION = { x: 380, y: 130, w: 620, h: 360 };
const PREFIX = '/mapimator/';

export const fixtures = [];

/**
 * Covers the deployment promise made in the README: `base: './'` means `dist/`
 * works unchanged from a domain root *or* a subpath, which is what a GitHub
 * Pages project site needs. A root-served preview cannot show that, because a
 * root-absolute asset URL happens to work there — so this spec serves the same
 * built `dist/` under a prefix and refuses to answer outside it. A regression to
 * `base: '/'` turns every asset into a 404 and this spec goes red.
 */
/**
 * Wait for the map region to actually be painted in the new style's colours.
 *
 * areTilesLoaded() can report true while setStyle is still swapping sources —
 * the trap the tracks suite's basemap section calls out too — so a fixed wait
 * after it is a guess at the runner's speed. A busy shared runner once captured
 * a frame before the Dark style's tiles had painted at all (luma 12, one flat
 * colour). Polling the pixels waits for the observable instead, and the check
 * below still fails when painting never lands.
 */
const painted = async (page, label) => {
    const deadline = Date.now() + 15_000;
    const ready = (after) =>
        after.exactColors > 50 && (label === 'Dark' ? after.meanLuma < 80 : after.meanLuma > 80);
    let after = await analyzeRegion(page, MAP_REGION);
    while (!ready(after) && Date.now() < deadline) {
        await page.waitForTimeout(500);
        after = await analyzeRegion(page, MAP_REGION);
    }
    return after;
};

export async function run({ page, suite, errors, root }) {
    suite.section('BUILT ASSET URLS');
    const html = await readFile(join(root, 'dist', 'index.html'), 'utf8');

    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    const local = urls.filter((u) => !/^https?:|^data:|^#/.test(u));
    suite.check(
        'index.html references some local assets',
        local.length > 0,
        `${local.length} found`,
    );

    // The specific invariant: nothing may be absolute from the site root, since
    // that path does not exist on a subpath deployment.
    const rootAbsolute = local.filter((u) => u.startsWith('/') && !u.startsWith('//'));
    suite.check(
        'no root-absolute asset URLs in dist/index.html',
        rootAbsolute.length === 0,
        rootAbsolute.join(' '),
    );
    suite.check(
        'local asset URLs are relative',
        local.every((u) => u.startsWith('./')),
        local.join(' '),
    );
    suite.check(
        'favicon uses a relative path too',
        local.some((u) => u.endsWith('favicon.svg')),
        local.join(' '),
    );

    suite.section('APP BOOTS FROM A SUBPATH');
    const server = await startStaticServer(join(root, 'dist'), PREFIX);
    const notFound = [];
    page.on('response', (response) => {
        if (response.status() === 404) {
            notFound.push(response.url());
        }
    });

    try {
        await page.goto(server.url, { waitUntil: 'load' });
        await page.waitForFunction(() => window.mapimator?.areTrackLayersAttached(), null, {
            timeout: 30_000,
        });
        await page.waitForFunction(() => window.mapimator.map.areTilesLoaded(), null, {
            timeout: 30_000,
        });
        await page.waitForTimeout(1200);

        const shell = await page.evaluate(() => ({
            title: document.title,
            mapHasSize: (() => {
                const canvas = document.querySelector('#map canvas');
                return Boolean(canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0);
            })(),
            active: document.querySelector('#basemap-switcher button[aria-pressed="true"]')
                ?.textContent,
            workerUrls: performance
                .getEntriesByType('resource')
                .map((e) => e.name)
                .filter((n) => /parseWorker|maplibre-gl-worker/.test(n)),
        }));

        suite.check('page title loaded', shell.title === 'Mapimator', shell.title);
        suite.check('map canvas has non-zero size', shell.mapHasSize);
        suite.check('basemap switcher rendered', shell.active === 'Liberty', String(shell.active));
        suite.check(
            'both workers loaded from the subpath',
            shell.workerUrls.some((u) => u.startsWith(server.base + PREFIX)) &&
                shell.workerUrls.some((u) => u.includes('maplibre-gl-worker')),
            shell.workerUrls.join(' '),
        );
        suite.check(
            'no request escaped the subpath prefix',
            notFound.length === 0,
            notFound.slice(0, 3).join(' '),
        );

        const px = await analyzeRegion(page, MAP_REGION);
        suite.note(
            `subpath luma=${px.meanLuma} colors=${px.exactColors} dominant=${px.dominantShare}`,
        );
        suite.check(
            'basemap tiles painted from the subpath',
            px.exactColors > 100,
            `${px.exactColors} exact colors`,
        );
        suite.check(
            'subpath screen is not flat',
            px.dominantShare < 0.9,
            `dominant ${px.dominantShare}`,
        );

        suite.section('BASEMAP SWITCHING FROM A SUBPATH');
        for (const label of ['Dark', 'Liberty']) {
            // Count style.load events: areTilesLoaded() can report true while
            // setStyle has already dropped the overlay source.
            await page.evaluate(() => {
                window.__loads = 0;
                window.mapimator.map.on('style.load', () => {
                    window.__loads += 1;
                });
            });
            const seen = await page.evaluate(() => window.__loads);
            await page.locator('#basemap-switcher button', { hasText: label }).click();
            await page.waitForFunction((n) => window.__loads > n, seen, { timeout: 30_000 });
            await page.waitForFunction(() => window.mapimator.map.areTilesLoaded(), null, {
                timeout: 30_000,
            });
            const after = await painted(page, label);
            suite.check(
                `${label} painted from the subpath`,
                after.exactColors > 50 &&
                    (label === 'Dark' ? after.meanLuma < 80 : after.meanLuma > 80),
                `luma ${after.meanLuma}, colors ${after.exactColors}`,
            );
        }

        await page.screenshot({ path: `${SHOT_DIR}/subpath.png` });
    } finally {
        server.stop();
    }

    suite.section('CONSOLE');
    const realErrors = errors.filter((e) => !/favicon/i.test(e));
    suite.check(
        'no console errors when served from a subpath',
        realErrors.length === 0,
        realErrors.slice(0, 3).join(' || '),
    );
}
