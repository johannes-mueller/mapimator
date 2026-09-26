import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

export const FIXTURE_DIR = join(tmpdir(), 'mapimator-e2e-fixtures');
export const SHOT_DIR = join(tmpdir(), 'mapimator-e2e-shots');

/** Collects check results and prints them as they happen. */
export class Suite {
    constructor(name) {
        this.name = name;
        this.failures = [];
        this.total = 0;
    }

    get passed() {
        return this.total - this.failures.length;
    }

    section(title) {
        console.log(`\n  ${title}`);
    }

    check(name, condition, detail = '') {
        this.total += 1;
        if (!condition) {
            this.failures.push(name);
        }
        const mark = condition ? 'PASS' : 'FAIL';
        console.log(`    [${mark}] ${name}${detail ? ` :: ${detail}` : ''}`);
        return Boolean(condition);
    }

    note(text) {
        console.log(`    (${text})`);
    }
}

async function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function waitForHttp(url, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                return;
            }
        } catch {
            // Not listening yet.
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Server did not become ready at ${url} within ${timeoutMs}ms`);
}

/**
 * Serves the built `dist/` with vite preview on a free port. The suite tests
 * the production bundle rather than the dev server, so the worker split and
 * asset paths are exercised the way a deployment would exercise them.
 */
export async function startPreview(root) {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const child = spawn(
        process.execPath,
        [
            join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
            'preview',
            '--port',
            String(port),
            '--host',
            '127.0.0.1',
            '--strictPort',
        ],
        { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const log = [];
    child.stdout.on('data', (b) => log.push(String(b)));
    child.stderr.on('data', (b) => log.push(String(b)));

    const stop = () => {
        if (!child.killed) {
            child.kill('SIGTERM');
        }
    };

    try {
        await waitForHttp(url);
    } catch (error) {
        stop();
        throw new Error(`${error.message}\n--- vite preview output ---\n${log.join('')}`);
    }

    return { url, stop };
}

/**
 * Launches Playwright's bundled Chromium. `npx playwright install chromium`
 * is required once; a missing browser is by far the most likely reason this
 * suite cannot start, so it gets its own message.
 */
export async function launchBrowser() {
    try {
        return await chromium.launch();
    } catch (error) {
        throw new Error(
            `Could not launch Chromium: ${error.message}\n\n` +
                'The e2e suite uses the browser Playwright manages. Install it once with:\n' +
                '  npx playwright install chromium',
        );
    }
}

export function ensureDirs() {
    mkdirSync(SHOT_DIR, { recursive: true });
}
