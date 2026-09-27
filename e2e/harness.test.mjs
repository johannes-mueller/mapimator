import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { preflight, startStaticServer } from './harness.mjs';

/** A port nothing is listening on, for the unreachable-endpoint cases. */
async function closedPort() {
    return new Promise((resolve) => {
        const probe = createServer();
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

describe('preflight', () => {
    let dir;
    let server;
    let deadUrl;

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'mapimator-harness-'));
        writeFileSync(join(dir, 'index.html'), '<!doctype html><title>ok</title>');
        server = await startStaticServer(dir, '/mapimator/');
        deadUrl = `http://127.0.0.1:${await closedPort()}/styles/liberty`;
    });

    afterAll(() => {
        server?.stop();
    });

    it('resolves when the endpoint answers', async () => {
        await expect(preflight(server.url)).resolves.toBeUndefined();
    });

    it('throws when the endpoint is unreachable', async () => {
        await expect(preflight(deadUrl)).rejects.toThrow(/Cannot reach/);
    });

    it('names the endpoint it could not reach', async () => {
        // Without this a network failure reads as a generic code failure.
        await expect(preflight(deadUrl)).rejects.toThrow(deadUrl);
    });

    it('says plainly that the suite needs network access', async () => {
        // The whole point of the preflight: a missing network must be legible
        // as an environment problem, not a bug in the app.
        await expect(preflight(deadUrl)).rejects.toThrow(/needs live network access/);
        await expect(preflight(deadUrl)).rejects.toThrow(/environment\s+problem, not a code/);
    });

    it('fails on a non-OK response as well as a dead host', async () => {
        await expect(preflight(`${server.base}/not-here`)).rejects.toThrow(/HTTP 404/);
    });

    it('does not hang when the host accepts but never responds', async () => {
        // A server that accepts the socket and then goes quiet is the case a
        // naive fetch waits on forever; the timeout is what saves the run.
        const blackhole = await new Promise((resolve) => {
            const socket = createServer(() => {});
            socket.listen(0, '127.0.0.1', () => resolve(socket));
        });
        const port = blackhole.address().port;
        await expect(preflight(`http://127.0.0.1:${port}/`, 300)).rejects.toThrow();
        blackhole.close();
    });
});

describe('startStaticServer', () => {
    let dir;
    let server;

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'mapimator-harness-'));
        writeFileSync(join(dir, 'index.html'), '<!doctype html><title>root</title>');
        writeFileSync(join(dir, 'app.js'), 'console.log(1);');
        server = await startStaticServer(dir, '/mapimator/');
    });

    afterAll(() => {
        server?.stop();
    });

    it('serves index.html at the prefix root', async () => {
        const response = await fetch(server.url);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('<title>root</title>');
    });

    it('serves a file under the prefix', async () => {
        const response = await fetch(`${server.base}/mapimator/app.js`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/javascript/);
    });

    it('refuses anything outside the prefix', async () => {
        // This is the property that makes the subpath spec meaningful: a
        // root-absolute asset URL must 404, not quietly resolve.
        expect((await fetch(`${server.base}/app.js`)).status).toBe(404);
        expect((await fetch(`${server.base}/`)).status).toBe(404);
    });

    it('404s a missing file under the prefix', async () => {
        expect((await fetch(`${server.base}/mapimator/nope.js`)).status).toBe(404);
    });

    it('does not serve anything outside the served directory', async () => {
        const escaped = await fetch(`${server.base}/mapimator/../index.html`);
        expect(escaped.status).toBe(404);
        const encoded = await fetch(`${server.base}/mapimator/%2e%2e%2f%2e%2e%2fetc/passwd`);
        expect(encoded.status).toBe(404);
    });

    it('reports a url inside the prefix', () => {
        expect(server.url).toBe(`${server.base}/mapimator/`);
    });
});
