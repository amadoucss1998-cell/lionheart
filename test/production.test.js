const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-prod-'));
Object.assign(process.env, {
  NODE_ENV: 'production',
  DATA_DIR: tmp,
  ADMIN_EMAIL: 'admin@test.local',
  ADMIN_PASSWORD: 'admin-pass-123',
  SESSION_SECRET: 'test-secret',
  PUBLIC_URL: 'https://shop.lionheart.test',
});

require('./helpers').useTestDatabase();
const { bootstrap } = require('../src/seed');
const { createApp } = require('../src/app');
const { db } = require('../src/db');
const { resetDatabase } = require('./helpers');

let server;
let base;

before(async () => {
  const log = console.log;
  console.log = () => {};
  await resetDatabase(db);
  await bootstrap();
  console.log = log;
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Requests as they arrive from an HTTPS reverse proxy (Caddy, Render, Nginx).
const viaProxy = (url, init = {}) =>
  fetch(base + url, { redirect: 'manual', ...init, headers: { 'x-forwarded-proto': 'https', ...(init.headers || {}) } });

test('health check reports ok without setting cookies', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { ok: true, database: db.kind, storage: 'local' });
  assert.strictEqual(res.headers.getSetCookie().length, 0);
});

test('security headers are sent', async () => {
  const res = await viaProxy('/');
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(res.headers.get('strict-transport-security'), /max-age=31536000/);
  assert.strictEqual(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.strictEqual(res.headers.get('x-powered-by'), null);
});

test('session cookies are Secure and HttpOnly behind HTTPS', async () => {
  const res = await viaProxy('/');
  assert.strictEqual(res.status, 200);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lh_session='));
  assert.ok(cookie, 'session cookie set');
  assert.match(cookie, /; secure/i);
  assert.match(cookie, /; httponly/i);
});

test('static assets and front-end libraries are served compressed', async () => {
  for (const url of ['/static/css/style.css', '/static/js/hero3d.js', '/vendor/three/three.module.js', '/vendor/three/three.core.js', '/vendor/gsap/gsap.min.js', '/vendor/gsap/ScrollTrigger.min.js']) {
    const res = await viaProxy(url, { headers: { 'accept-encoding': 'gzip' } });
    assert.strictEqual(res.status, 200, url);
    await res.arrayBuffer();
  }
  const three = await viaProxy('/vendor/three/three.module.js', { headers: { 'accept-encoding': 'gzip' } });
  assert.strictEqual(three.headers.get('content-encoding'), 'gzip');
});

test('repeated failed sign-ins are rate limited', async () => {
  const page = await viaProxy('/login');
  const cookie = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const token = (await page.text()).match(/name="_csrf" value="([^"]+)"/)[1];
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    const res = await viaProxy('/login', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: token, email: 'admin@test.local', password: 'wrong' }).toString(),
    });
    statuses.push(res.status);
  }
  assert.deepStrictEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.deepStrictEqual(statuses.slice(10), [429, 429]);
});
