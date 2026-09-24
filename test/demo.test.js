// Sample data for demos: loaded and removed from Admin → Settings without
// touching real orders.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-demo-'));
Object.assign(process.env, { SEED_DEMO: 'all', DATA_DIR: tmp, ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'admin-pass-123', SESSION_SECRET: 'test-secret' });
require('./helpers').useTestDatabase();
const { db } = require('../src/db');
const { createApp } = require('../src/app');
const { makeBrowser, resetDatabase } = require('./helpers');

let server;
let browser;
before(async () => {
  const log = console.log;
  console.log = () => {};
  await resetDatabase(db);
  await require('../src/seed').bootstrap();
  console.log = log;
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  browser = makeBrowser(`http://127.0.0.1:${server.address().port}`);
});
after(async () => {
  server.close();
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const n = async (sql) => (await db.get(`SELECT COUNT(*)::int AS n FROM ${sql}`)).n;

test('admins can load and remove sample data; real orders are kept', async () => {
  await db.run("INSERT INTO orders (ref, customer_name, email) VALUES ('LH-REAL-1', 'Real Customer', 'real@example.com')");
  const admin = browser();
  await admin.post('/login', { email: 'admin@test.local', password: 'admin-pass-123' }, '/login');

  let res = await admin.post('/admin/settings/sample-data', { action: 'load' }, '/admin/settings');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(await n("orders WHERE ref LIKE 'LH-SAMPLE-%'"), 5);
  assert.strictEqual(await n("sourcing_requests WHERE ref LIKE 'RQ-SAMPLE-%'"), 2);
  assert.strictEqual(await n("suppliers WHERE name LIKE '% (sample)'"), 4);
  const statuses = (await db.all("SELECT status FROM orders WHERE ref LIKE 'LH-SAMPLE-%' ORDER BY ref")).map((r) => r.status);
  assert.deepStrictEqual(statuses, ['received', 'quoted', 'paid', 'shipped', 'delivered']);
  // The shipped order has a full history and priced lines.
  const shipped = await db.get("SELECT id, quoted_total FROM orders WHERE ref = 'LH-SAMPLE-004'");
  assert.ok(shipped.quoted_total > 0);
  assert.strictEqual(await n(`order_events WHERE order_id = ${shipped.id}`), 7);

  const dash = await (await admin.req('/admin')).text();
  assert.match(dash, /LH-SAMPLE-001/);
  assert.match(await (await admin.req('/admin/orders/LH-SAMPLE-004')).text(), /MSKU 482731-6/);

  // Loading again does not duplicate.
  await admin.post('/admin/settings/sample-data', { action: 'load' }, '/admin/settings');
  assert.strictEqual(await n("orders WHERE ref LIKE 'LH-SAMPLE-%'"), 5);

  await admin.post('/admin/settings/sample-data', { action: 'remove' }, '/admin/settings');
  assert.strictEqual(await n("orders WHERE ref LIKE 'LH-SAMPLE-%'"), 0);
  assert.strictEqual(await n("sourcing_requests WHERE ref LIKE 'RQ-SAMPLE-%'"), 0);
  assert.strictEqual(await n("suppliers WHERE name LIKE '% (sample)'"), 0);
  assert.strictEqual(await n("orders WHERE ref = 'LH-REAL-1'"), 1);
});

test('customers cannot load sample data', async () => {
  const b = browser();
  await b.post('/register', { name: 'C', email: 'c@example.com', password: 'longpassword', password2: 'longpassword' }, '/register');
  const res = await b.post('/admin/settings/sample-data', { action: 'load' }, '/account');
  assert.notStrictEqual(res.status, 302);
  assert.strictEqual(await n("orders WHERE ref LIKE 'LH-SAMPLE-%'"), 0);
});
