/**
 * HTTP smoke test for the Express 5 route/middleware surface.
 *
 * The mode-switching integration test only exercises Socket.IO; this covers the
 * plain-HTTP routes (auth gate, public pages, JSON-API 401, redirect) that a
 * dependency upgrade like Express 4->5 could silently break. It boots the REAL
 * server as a subprocess on a discovered free port with throwaway env (fake
 * Google creds are accepted at client construction — validated lazily), probes
 * a few routes over HTTP, then shuts it down. No new test dependency: uses
 * Node's built-in http.
 */
const { describe, it, before, after } = require('mocha');
const { expect } = require('chai');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

// Ask the OS for a currently-free port (avoids colliding with anything already
// listening; a strict TOCTOU race remains but is acceptable for a smoke test).
function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

describe('HTTP smoke (Express 5 route/middleware surface)', function () {
    this.timeout(20000);
    let srv;
    let base;

    function get(p) {
        return new Promise((resolve, reject) => {
            const r = http.get(base + p, (res) => {
                res.resume(); // drain so the socket frees
                resolve({ status: res.statusCode, location: res.headers.location });
            });
            r.on('error', reject);
            r.setTimeout(4000, () => r.destroy(new Error('request timeout')));
        });
    }

    before(async function () {
        const port = await freePort();
        base = `http://127.0.0.1:${port}`;
        const env = {
            ...process.env,
            NODE_ENV: 'test',
            PORT: String(port),
            SESSION_SECRET: '0123456789abcdef0123456789abcdef',
            APP_PASSWORD: 'test',
            DEEPGRAM_API_KEY: 'dummy',
            DATABASE_URL: '', // -> MemoryStore, no DB needed
            GOOGLE_CREDENTIALS_JSON: JSON.stringify({
                type: 'service_account', project_id: 'test', private_key_id: 'x',
                client_email: 't@test.iam.gserviceaccount.com', client_id: '1',
                token_uri: 'https://oauth2.googleapis.com/token',
                private_key: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n',
            }),
        };
        srv = spawn('node', ['server.js'], {
            cwd: path.join(__dirname, '..'),
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (err) => { if (!settled) { settled = true; err ? reject(err) : resolve(); } };
            const watch = (buf) => { if (/Ready to receive connections/.test(buf.toString())) finish(); };
            srv.stdout.on('data', watch);
            srv.stderr.on('data', watch);
            srv.on('error', (err) => finish(err)); // e.g. ENOENT -> clean failure, not uncaught
            srv.on('exit', (code) => finish(new Error('server exited before becoming ready (code ' + code + ')')));
        });
    });

    after(function (done) {
        if (!srv) return done();
        const killer = setTimeout(() => { try { srv.kill('SIGKILL'); } catch (_) { /* already gone */ } }, 3000);
        srv.once('exit', () => { clearTimeout(killer); done(); });
        srv.kill('SIGTERM');
    });

    it('GET /health -> 200', async () => {
        expect((await get('/health')).status).to.equal(200);
    });

    it('GET /login -> 200 (public page)', async () => {
        expect((await get('/login')).status).to.equal(200);
    });

    it('GET /api/billing/summary without auth -> 401 (JSON API gate, not a redirect)', async () => {
        expect((await get('/api/billing/summary')).status).to.equal(401);
    });

    it('GET / without auth -> 302 redirect to /login', async () => {
        const r = await get('/');
        expect(r.status).to.equal(302);
        expect(r.location).to.equal('/login');
    });
});
