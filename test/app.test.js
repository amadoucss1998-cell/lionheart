const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-test-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.SESSION_SECRET = 'test-secret';
process.env.SEED_DEMO = 'all';

require('./helpers').useTestDatabase();
const { bootstrap } = require('../src/seed');
const { createApp } = require('../src/app');
const { db } = require('../src/db');
const { makeBrowser, resetDatabase } = require('./helpers');

let server;
let browser;

before(async () => {
  const log = console.log;
  console.log = () => {};
  await resetDatabase(db);
  await bootstrap();
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

const productBySku = (sku) => db.get('SELECT * FROM products WHERE sku = ?', [sku]);

test('public pages render with seeded catalog', async () => {
  const b = browser();
  const home = await (await b.req('/')).text();
  assert.match(home, /Shop by category/);
  assert.match(home, /Roofing \(Decra &amp; Zinc\)/);
  const list = await (await b.req('/products?category=tiles-ceramics')).text();
  assert.match(list, /Porcelain Floor Tile/);
  const search = await (await b.req('/products?q=excavator')).text();
  assert.match(search, /Crawler Excavator/);
});

test('POST without CSRF token is rejected', async () => {
  const b = browser();
  await b.req('/');
  const res = await b.req('/cart/add', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'product_id=1&mode=source&qty=1',
  });
  assert.strictEqual(res.status, 403);
});

test('guest can order, admin quotes, customer accepts', async () => {
  const tile = await productBySku('TL-6060-P');
  const guest = browser();

  // Quantity below MOQ is raised to the MOQ for China sourcing.
  let res = await guest.post('/cart/add', { product_id: tile.id, mode: 'source', qty: 5 }, `/products/${tile.slug}`);
  assert.strictEqual(res.status, 302);
  res = await guest.post('/cart/add', { product_id: tile.id, mode: 'stock', qty: 10 }, `/products/${tile.slug}`);
  const cart = await (await guest.req('/cart')).text();
  assert.match(cart, new RegExp(`value="${tile.moq}"`));
  assert.match(cart, /From our stock/);

  // Missing fields -> validation errors.
  res = await guest.post('/checkout', { customer_name: '', email: 'bad' }, '/checkout');
  assert.strictEqual(res.status, 400);

  res = await guest.post(
    '/checkout',
    { customer_name: 'Test Buyer', email: 'buyer@example.com', phone: '+231 555 0101', country: 'Liberia', city: 'Monrovia', shipping_method: 'sea_lcl' },
    '/checkout'
  );
  assert.strictEqual(res.status, 302);
  const orderUrl = res.headers.get('location').split('?')[0];
  const ref = orderUrl.split('/').pop();
  assert.match(ref, /^LH-\d{8}-[0-9A-F]{6}$/);

  const order = (await db.get('SELECT * FROM orders WHERE ref = ?', [ref]));
  const items = (await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [order.id]));
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].qty, tile.moq);
  assert.strictEqual(order.estimate_total, tile.moq * tile.china_price + 10 * tile.stock_price);

  // The guest who placed it can view it; a stranger cannot.
  assert.strictEqual((await guest.req(orderUrl)).status, 200);
  const stranger = browser();
  assert.strictEqual((await stranger.req(orderUrl)).status, 302);
  // ...unless they know the order number AND email.
  res = await stranger.post('/track', { ref, email: 'wrong@example.com' }, '/track');
  assert.strictEqual(res.status, 404);
  res = await stranger.post('/track', { ref, email: 'BUYER@example.com' }, '/track');
  assert.strictEqual(res.headers.get('location'), `/orders/${ref}`);

  // Customers cannot reach admin.
  assert.strictEqual((await guest.req('/admin')).status, 302);

  const admin = browser();
  res = await admin.post('/login', { email: 'admin@test.local', password: 'admin-pass-123' }, '/login');
  assert.strictEqual(res.headers.get('location'), '/admin');
  assert.strictEqual((await admin.req(`/admin/orders/${ref}`)).status, 200);

  // Sending a quote requires every item to be priced.
  const token = await admin.csrf(`/admin/orders/${ref}`);
  const form = new URLSearchParams({ _csrf: token, shipping_cost: '350', other_charges: '', quoted_total: '', send_quote: '1' });
  form.append('unit_price', '7');
  form.append('unit_price', '');
  await admin.req(`/admin/orders/${ref}/quote`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  assert.strictEqual((await db.get('SELECT status FROM orders WHERE ref = ?', [ref])).status, 'received');

  form.set('_csrf', token);
  form.delete('unit_price');
  form.append('unit_price', '7');
  form.append('unit_price', '11');
  await admin.req(`/admin/orders/${ref}/quote`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  const quoted = (await db.get('SELECT * FROM orders WHERE ref = ?', [ref]));
  assert.strictEqual(quoted.status, 'quoted');
  assert.strictEqual(quoted.quoted_total, tile.moq * 7 + 10 * 11 + 350);

  const view = await (await guest.req(orderUrl)).text();
  assert.match(view, /Your quotation is ready/);
  res = await guest.post(`/orders/${ref}/accept`, {}, orderUrl);
  assert.strictEqual((await db.get('SELECT status FROM orders WHERE ref = ?', [ref])).status, 'accepted');

  res = await admin.post(`/admin/orders/${ref}/status`, { status: 'shipped', tracking_number: 'MSKU1234567', message: 'Loaded' }, `/admin/orders/${ref}`);
  const shipped = await (await guest.req(orderUrl)).text();
  assert.match(shipped, /MSKU1234567/);
});

test('registration attaches guest orders and account lists them', async () => {
  const b = browser();
  const p = await productBySku('SW-WC-1P');
  await b.post('/cart/add', { product_id: p.id, mode: 'stock', qty: 2 }, `/products/${p.slug}`);
  const res = await b.post('/checkout', { customer_name: 'Ama', email: 'ama@example.com', phone: '1', country: 'Ghana' }, '/checkout');
  const ref = res.headers.get('location').split('/').pop().split('?')[0];
  await b.post('/register', { name: 'Ama', email: 'ama@example.com', password: 'longpassword', password2: 'longpassword' }, '/register');
  const account = await (await b.req('/account')).text();
  assert.match(account, new RegExp(ref));
});

test('admin can create a product with an image and bulk import CSV', async () => {
  const admin = browser();
  await admin.post('/login', { email: 'admin@test.local', password: 'admin-pass-123' }, '/login');
  const token = await admin.csrf('/admin/products/new');

  const png = await require('sharp')({ create: { width: 800, height: 600, channels: 3, background: '#1b3654' } }).png().toBuffer();
  const fd = new FormData();
  fd.append('_csrf', token);
  fd.append('name', 'Kitchen Cabinet Set');
  fd.append('sku', 'KC-001');
  fd.append('sourcing_available', '1');
  fd.append('china_price', '1200');
  fd.append('moq', '1');
  fd.append('active', '1');
  fd.append('images', new Blob([png], { type: 'image/png' }), 'cab.png');
  let res = await admin.req('/admin/products/new', { method: 'POST', body: fd });
  assert.strictEqual(res.status, 302);
  const p = await productBySku('KC-001');
  assert.ok(p);
  const img = (await db.get('SELECT * FROM product_images WHERE product_id = ?', [p.id]));
  assert.ok(img && fs.existsSync(path.join(tmp, 'uploads', img.filename)));
  assert.strictEqual((await admin.req(`/uploads/${img.filename}`)).status, 200);
  // A 600px WebP thumbnail is stored next to it for product cards.
  assert.match(img.thumb, /\.webp$/);
  const thumbRes = await admin.req(`/uploads/${img.thumb}`);
  assert.strictEqual(thumbRes.status, 200);
  assert.strictEqual((await require('sharp')(Buffer.from(await thumbRes.arrayBuffer())).metadata()).width, 600);

  // Multipart without a valid token is rejected and the upload discarded.
  const bad = new FormData();
  bad.append('_csrf', 'nope');
  bad.append('name', 'X');
  bad.append('images', new Blob([png], { type: 'image/png' }), 'x.png');
  const before = fs.readdirSync(path.join(tmp, 'uploads')).length;
  res = await admin.req('/admin/products/new', { method: 'POST', body: bad });
  assert.strictEqual(res.status, 403);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(fs.readdirSync(path.join(tmp, 'uploads')).length, before);

  const csv = 'name,sku,category,china_price,moq,stock_price,specs\n"Gypsum Board 12mm",GB-12,Building Materials,3.2,1000,,"Size: 1200x2400 | Thickness: 12mm"\nKC updated,KC-001,Furniture,1100,2,,\n,NO-NAME,,,,,\n';
  const fd2 = new FormData();
  fd2.append('_csrf', await admin.csrf('/admin/products-import'));
  fd2.append('file', new Blob([csv], { type: 'text/csv' }), 'p.csv');
  const html = await (await admin.req('/admin/products-import', { method: 'POST', body: fd2 })).text();
  assert.match(html, /1 created, 1 updated/);
  assert.match(html, /missing name/);
  assert.strictEqual((await productBySku('GB-12')).specs, 'Size: 1200x2400\nThickness: 12mm');
  assert.strictEqual((await productBySku('KC-001')).china_price, 1100);
});

test('sourcing request with photo is stored', async () => {
  const b = browser();
  const fd = new FormData();
  fd.append('_csrf', await b.csrf('/request'));
  fd.append('name', 'Kofi');
  fd.append('email', 'kofi@example.com');
  fd.append('description', '40ft container of red Decra roofing tiles, Milano profile');
  const res = await b.req('/request', { method: 'POST', body: fd });
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /RQ-\d{8}-/);
  assert.ok((await db.get("SELECT 1 FROM sourcing_requests WHERE email = 'kofi@example.com'")));
});

test('open redirect via next= is blocked', async () => {
  const b = browser();
  const res = await b.post('/login', { email: 'admin@test.local', password: 'admin-pass-123', next: '//evil.example' }, '/login');
  assert.strictEqual(res.headers.get('location'), '/admin');
});
