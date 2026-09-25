// Removing products that have no photos: the one-time cleanup of sample
// products on start, and the admin bulk-delete button.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-cleanup-'));
Object.assign(process.env, {
  SEED_DEMO: 'all',
  DATA_DIR: tmp,
  ADMIN_EMAIL: 'admin@test.local',
  ADMIN_PASSWORD: 'admin-pass-123',
  SESSION_SECRET: 'test-secret',
});
require('./helpers').useTestDatabase();
const { db } = require('../src/db');
const seed = require('../src/seed');
const { createApp } = require('../src/app');
const { makeBrowser, resetDatabase } = require('./helpers');

let server;
let browser;

before(async () => {
  const log = console.log;
  console.log = () => {};
  await resetDatabase(db);
  await seed.bootstrap(); // an "old" database with all 24 sample products
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

const skus = async () => (await db.all('SELECT sku FROM products ORDER BY sku')).map((r) => r.sku);

test('start-up cleanup removes only sample products that have no photo', async () => {
  assert.strictEqual((await skus()).length, 24);
  // A product staff added themselves, without a photo, must survive.
  await db.run("INSERT INTO products (sku, name, slug) VALUES ('OWN-1', 'Own product', 'own-product')");
  // An order referencing a product that will be removed keeps its line.
  const order = await db.insert("INSERT INTO orders (ref, customer_name, email) VALUES ('LH-TEST-1', 'A', 'a@b.c')");
  const tile = await db.get("SELECT id, name FROM products WHERE sku = 'TL-3060-W'");
  await db.run("INSERT INTO order_items (order_id, product_id, product_name, mode, qty) VALUES (?, ?, ?, 'source', 10)", [order, tile.id, tile.name]);

  process.env.SEED_DEMO = 'true';
  await seed.removeSamplesWithoutPhotos();
  const left = await skus();
  assert.deepStrictEqual(left, [...seed.PHOTO_SKUS, 'OWN-1'].sort());
  const item = await db.get('SELECT product_id, product_name FROM order_items WHERE order_id = ?', [order]);
  assert.deepStrictEqual(item, { product_id: null, product_name: tile.name });

  // Runs only once: a sample re-added later is not deleted again.
  await db.run("INSERT INTO products (sku, name, slug) VALUES ('TL-3060-W', 'Tile again', 'tile-again')");
  await seed.removeSamplesWithoutPhotos();
  assert.ok((await skus()).includes('TL-3060-W'));
});

test('admins can delete all products without photos in one step', async () => {
  const admin = browser();
  await admin.post('/login', { email: 'admin@test.local', password: 'admin-pass-123' }, '/login');
  const page = await (await admin.req('/admin/products')).text();
  const count = Number(page.match(/name="count" value="(\d+)"/)[1]);
  assert.strictEqual(count, (await skus()).length); // none of the test products has a photo yet

  // Give one product a photo: it must be kept.
  const keep = await db.get("SELECT id FROM products WHERE sku = 'RF-DECRA-BD'");
  await db.run("INSERT INTO product_images (product_id, filename) VALUES (?, '/static/products/rf-decra-bd.jpg')", [keep.id]);

  // A stale count (the list changed since the page was shown) deletes nothing.
  let res = await admin.post('/admin/products-without-photos/delete', { count: String(count) }, '/admin/products');
  assert.strictEqual(res.status, 302);
  assert.strictEqual((await skus()).length, count);

  res = await admin.post('/admin/products-without-photos/delete', { count: String(count - 1) }, '/admin/products');
  assert.deepStrictEqual(await skus(), ['RF-DECRA-BD']);
  const after = await (await admin.req('/admin/products')).text();
  assert.match(after, /Deleted \d+ products without photos/);
  assert.doesNotMatch(after, /Delete products without photos/);
});
