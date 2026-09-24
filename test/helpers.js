const assert = require('node:assert');

// Tiny cookie-keeping browser.
function makeBrowser(base) {
  return () => browser(base);
}

function browser(base) {
  const jar = new Map();
  async function req(url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  }
  async function csrf(url = '/') {
    const html = await (await req(url)).text();
    const m = html.match(/name="_csrf" value="([^"]+)"/);
    assert.ok(m, `no csrf token on ${url}`);
    return m[1];
  }
  async function post(url, data, from) {
    const token = await csrf(from || url);
    return req(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: token, ...data }).toString(),
    });
  }
  return { req, csrf, post };
}

// With TEST_DATABASE_URL set, the suite runs against that PostgreSQL server
// (e.g. a local Postgres or a Supabase test project) instead of the embedded
// database. Each test file starts from an empty schema; run files one at a time:
//   TEST_DATABASE_URL=postgres://… npm run test:postgres
function useTestDatabase() {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

async function resetDatabase(db) {
  if (db.kind !== 'postgres') return;
  await db.run('DROP SCHEMA public CASCADE');
  await db.run('CREATE SCHEMA public');
}

module.exports = { makeBrowser, useTestDatabase, resetDatabase };
