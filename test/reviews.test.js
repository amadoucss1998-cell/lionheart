// Customer reviews: only on delivered orders, published after approval,
// sample reviews always labelled.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-reviews-'));
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

async function placeOrder(b) {
  const p = await db.get("SELECT * FROM products WHERE sku = 'SW-WC-1P'");
  await b.post('/cart/add', { product_id: p.id, mode: 'stock', qty: 2 }, `/products/${p.slug}`);
  const res = await b.post('/checkout', { customer_name: 'Kofi Mensah', company: 'Mensah Ltd', email: 'kofi@example.com', phone: '1', country: 'Ghana' }, '/checkout');
  return res.headers.get('location').split('/').pop().split('?')[0];
}

test('customers review delivered orders; reviews go live after approval', async () => {
  const customer = browser();
  const ref = await placeOrder(customer);
  const review = { rating: '5', body: 'Great service <script>alert(1)</script> and fast delivery.', name: 'Kofi M.' };

  // Not delivered yet: no form and no review saved.
  assert.doesNotMatch(await (await customer.req(`/orders/${ref}`)).text(), /How did we do\?/);
  await customer.post(`/orders/${ref}/review`, review, '/track');
  assert.strictEqual((await db.get('SELECT COUNT(*)::int AS n FROM reviews')).n, 0);

  await db.run("UPDATE orders SET status = 'delivered' WHERE ref = ?", [ref]);
  assert.match(await (await customer.req(`/orders/${ref}`)).text(), /How did we do\?/);

  // A stranger cannot review someone else's order.
  const stranger = browser();
  await stranger.req('/');
  await stranger.post(`/orders/${ref}/review`, review, '/track');
  assert.strictEqual((await db.get('SELECT COUNT(*)::int AS n FROM reviews')).n, 0);

  // Invalid rating is refused, a valid review is saved as pending, only once.
  await customer.post(`/orders/${ref}/review`, { ...review, rating: '9' }, `/orders/${ref}`);
  assert.strictEqual((await db.get('SELECT COUNT(*)::int AS n FROM reviews')).n, 0);
  await customer.post(`/orders/${ref}/review`, review, `/orders/${ref}`);
  await customer.post(`/orders/${ref}/review`, { ...review, rating: '1' }, '/track');
  const saved = await db.all('SELECT * FROM reviews');
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].status, 'pending');
  assert.strictEqual(saved[0].rating, 5);
  assert.strictEqual(saved[0].name, 'Kofi M.');
  assert.match(await (await customer.req(`/orders/${ref}`)).text(), /will appear on our website once our team has checked it/);

  // Not public until approved.
  const visitor = browser();
  assert.doesNotMatch(await (await visitor.req('/')).text(), /What our customers say/);

  const admin = browser();
  await admin.post('/login', { email: 'admin@test.local', password: 'admin-pass-123' }, '/login');
  assert.match(await (await admin.req('/admin/reviews')).text(), /Awaiting approval/);
  await admin.post(`/admin/reviews/${saved[0].id}`, { action: 'approved' }, '/admin/reviews');

  const home = await (await visitor.req('/')).text();
  assert.match(home, /What our customers say/);
  assert.match(home, /Kofi M\./);
  assert.match(home, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/); // escaped, not executed
  assert.doesNotMatch(home, /<script>alert\(1\)/);
  assert.match(home, /<strong>5\.0<\/strong>/);
});

test('team testimonials and labelled sample reviews', async () => {
  const admin = browser();
  await admin.post('/login', { email: 'admin@test.local', password: 'admin-pass-123' }, '/login');
  await admin.post('/admin/reviews', { name: 'Grace Doe', company: 'Doe Hardware', country: 'Liberia', rating: '4', body: 'Reliable partner for our tiles.' }, '/admin/reviews');
  assert.match(await (await admin.req('/')).text(), /Reliable partner for our tiles\./);

  await admin.post('/admin/settings/sample-data', { action: 'load' }, '/admin/settings');
  const samples = await db.all("SELECT * FROM reviews WHERE source = 'sample'");
  assert.strictEqual(samples.length, 3);
  const home = await (await admin.req('/')).text();
  const sampleCards = home.split('<figure class="review">').slice(1).filter((c) => /Tarr Builders|Jallow Trading|Sesay Hotels/.test(c));
  assert.strictEqual(sampleCards.length, 3);
  assert.ok(sampleCards.every((c) => c.includes('>Sample</span>')), 'every sample review is labelled');
  assert.ok(!home.split('<figure class="review">').slice(1).filter((c) => /Grace Doe|Kofi M\./.test(c)).some((c) => c.includes('>Sample</span>')), 'real reviews are not labelled as samples');

  await admin.post('/admin/settings/sample-data', { action: 'remove' }, '/admin/settings');
  assert.strictEqual((await db.get("SELECT COUNT(*)::int AS n FROM reviews WHERE source = 'sample'")).n, 0);
  assert.strictEqual((await db.get("SELECT COUNT(*)::int AS n FROM reviews WHERE source <> 'sample'")).n, 2);
});
