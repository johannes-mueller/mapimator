#!/usr/bin/env node
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    FIXTURE_DIR,
    Suite,
    ensureDirs,
    launchBrowser,
    preflight,
    startPreview,
} from './harness.mjs';
import { writeFixtures } from './make-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

// Every *.spec.mjs in e2e/ runs, so adding a spec needs no edit here. Each spec
// may export a `fixtures` list of the GPX files it loads; only those get written.
async function loadSpecs() {
    const names = readdirSync(HERE)
        .filter((name) => name.endsWith('.spec.mjs'))
        .sort();
    return Promise.all(
        names.map(async (name) => ({
            name: name.replace('.spec.mjs', ''),
            mod: await import(join(HERE, name)),
        })),
    );
}

async function main() {
    if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
        console.error('dist/ is missing. Build first:  npm run build');
        process.exit(1);
    }

    ensureDirs();
    const specs = await loadSpecs();
    if (specs.length === 0) {
        console.error('No *.spec.mjs files found in e2e/.');
        return 1;
    }
    // Start from an empty directory, so a fixture left behind by an earlier run
    // cannot stand in for one the registry no longer builds. A spec that loads
    // a file it did not declare should fail, not quietly pass on a stale copy.
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
    const wanted = [...new Set(specs.flatMap((s) => s.mod.fixtures ?? []))];
    writeFixtures(FIXTURE_DIR, wanted);

    await preflight();

    const preview = await startPreview(ROOT);
    console.log(`serving dist/ at ${preview.url}`);

    const browser = await launchBrowser();
    const suites = [];

    try {
        for (const spec of specs) {
            console.log(`\n${'='.repeat(60)}\n${spec.name}\n${'='.repeat(60)}`);

            // A fresh context per spec, so one spec's localStorage or store
            // state cannot make the next one pass or fail for the wrong reason.
            const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
            const page = await context.newPage();
            const errors = [];
            page.on('console', (m) => {
                if (m.type() === 'error') {
                    errors.push(m.text());
                }
            });
            page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

            const suite = new Suite(spec.name);
            try {
                await spec.mod.run({
                    page,
                    suite,
                    errors,
                    url: preview.url,
                    fixtures: FIXTURE_DIR,
                    root: ROOT,
                });
            } catch (error) {
                suite.check(
                    `${spec.name} suite ran to completion`,
                    false,
                    String(error.message ?? error),
                );
            }
            suites.push(suite);
            await context.close();
        }
    } finally {
        await browser.close();
        preview.stop();
    }

    const total = suites.reduce((n, s) => n + s.total, 0);
    const failed = suites.flatMap((s) => s.failures.map((f) => `${s.name}: ${f}`));

    console.log(`\n${'='.repeat(60)}`);
    for (const suite of suites) {
        console.log(`${suite.name}: ${suite.passed}/${suite.total} passed`);
    }
    console.log(`${'='.repeat(60)}`);

    if (failed.length === 0) {
        console.log(`ALL ${total} E2E CHECKS PASSED`);
        return 0;
    }
    console.log(`${failed.length} of ${total} E2E checks FAILED:`);
    for (const name of failed) {
        console.log(`  - ${name}`);
    }
    return 1;
}

main().then(
    (code) => process.exit(code),
    (error) => {
        console.error(error);
        process.exit(1);
    },
);
