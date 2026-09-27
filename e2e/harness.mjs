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

/**
 * Fails fast when the tile service is unreachable. Every spec needs the live
 * style JSON at boot, and the basemap checks need live tiles on top of that, so
 * without this the suite would die as an opaque 30 s `waitForFunction` timeout
 * that reads like a code failure.
 */
export async function preflight(
    url = 'https://tiles.openfreemap.org/styles/liberty',
    timeoutMs = 10_000,
) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        await response.body?.cancel();
    } catch (error) {
        throw new Error(
            `Cannot reach ${url} (${error.message}).\n\n` +
                'The e2e suite renders real OpenFreeMap styles and tiles, so it needs live ' +
                'network access. Check connectivity, then re-run. This is an environment ' +
                'problem, not a code problem.\n' +
                'Unit tests need no network:  npm test',
        );
    } finally {
        clearTimeout(timer);
    }
}

export function ensureDirs() {
    mkdirSync(SHOT_DIR, { recursive: true });
}

/**
 * Counts distinct colours and mean luma in a screen region. This is how a check
 * proves that something was actually painted, rather than inferring it from
 * state that MapLibre reports regardless of what reached the screen.
 */
export async function analyzeRegion(page, region) {
    const png = (await page.screenshot()).toString('base64');
    return page.evaluate(
        async ({ png, region }) => {
            const img = new Image();
            img.src = `data:image/png;base64,${png}`;
            await img.decode();
            const off = new OffscreenCanvas(region.w, region.h);
            const ctx = off.getContext('2d');
            ctx.drawImage(img, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
            const { data } = ctx.getImageData(0, 0, region.w, region.h);
            const counts = new Map();
            let luma = 0;
            for (let i = 0; i < data.length; i += 4) {
                const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
                counts.set(key, (counts.get(key) ?? 0) + 1);
                luma += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
            }
            const total = data.length / 4;
            return {
                exactColors: counts.size,
                dominantShare: Number((Math.max(...counts.values()) / total).toFixed(3)),
                meanLuma: Number((luma / total).toFixed(1)),
            };
        },
        { png, region },
    );
}

/** Raw RGBA pixels of a screen region, for comparing two frames. */
export async function regionPixels(page, region) {
    const png = (await page.screenshot()).toString('base64');
    return page.evaluate(
        async ({ png, region }) => {
            const img = new Image();
            img.src = `data:image/png;base64,${png}`;
            await img.decode();
            const off = new OffscreenCanvas(region.w, region.h);
            const ctx = off.getContext('2d');
            ctx.drawImage(img, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
            return Array.from(ctx.getImageData(0, 0, region.w, region.h).data);
        },
        { png, region },
    );
}

/** Counts pixels differing by more than `threshold` in any channel. */
export function countDifferent(a, b, threshold = 8) {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
        if (
            Math.abs(a[i] - b[i]) > threshold ||
            Math.abs(a[i + 1] - b[i + 1]) > threshold ||
            Math.abs(a[i + 2] - b[i + 2]) > threshold
        ) {
            n += 1;
        }
    }
    return n;
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
};

/**
 * Serves `dir` under a path prefix, so a deployment at a subpath can be tested
 * for real. `vite preview` only ever serves from the root, which is exactly the
 * case that needs no verification: the promise in the README is that `dist/`
 * works from *a subpath too*, and that is the case a root-served preview hides.
 */
export async function startStaticServer(dir, prefix = '/mapimator/') {
    const http = await import('node:http');
    const { readFile } = await import('node:fs/promises');
    const { normalize, extname, join: joinPath } = await import('node:path');

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const url = `${base}${prefix}`;

    const server = http.createServer(async (req, res) => {
        const requested = decodeURIComponent((req.url ?? '/').split('?')[0]);
        if (!requested.startsWith(prefix)) {
            // Nothing is served outside the prefix, so a root-absolute asset URL
            // becomes a 404 here instead of silently working.
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('outside prefix');
            return;
        }
        const relative = normalize(requested.slice(prefix.length)).replace(/^(\.\.[/\\])+/, '');
        const target =
            relative === '' || relative === '.'
                ? joinPath(dir, 'index.html')
                : joinPath(dir, relative);
        try {
            const body = await readFile(target);
            res.writeHead(200, {
                'content-type': MIME[extname(target)] ?? 'application/octet-stream',
            });
            res.end(body);
        } catch {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found');
        }
    });

    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

    try {
        await waitForHttp(url);
    } catch (error) {
        server.close();
        throw error;
    }

    return { url, base, port, stop: () => server.close() };
}
