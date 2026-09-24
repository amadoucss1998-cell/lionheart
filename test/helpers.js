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

module.exports = { makeBrowser };
