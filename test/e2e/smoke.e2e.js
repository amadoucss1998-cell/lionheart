// End-to-end check of a running site in a real browser (Chromium).
//   BASE_URL=https://shop.example.com ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run test:e2e
// It places a real test order (customer "E2E Test"); cancel or ignore it in the admin.
// First time on a new machine: npx playwright install chromium
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
// Font requests fail in some sandboxes/offline networks; they are not app errors.
const IGNORED = /fonts\.(googleapis|gstatic)\.com|ERR_CERT_AUTHORITY_INVALID|net::ERR_/;

let browser;
const errors = [];

async function newPage(opts = {}) {
  // E2E_INSECURE=1 accepts self-signed certificates (e.g. a local Caddy on https://localhost).
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, ignoreHTTPSErrors: process.env.E2E_INSECURE === '1', ...opts });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !IGNORED.test(m.text())) errors.push(`${page.url()}: ${m.text()}`);
  });
  return page;
}

before(async () => {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
});
after(async () => browser && browser.close());

let orderRef;

test('home page renders the 3D globe and animations without errors', async () => {
  const page = await newPage();
  const res = await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  assert.strictEqual(res.status(), 200);
  await page.waitForSelector('#hero-globe.is-ready canvas', { timeout: 15000 });
  assert.ok(await page.evaluate(() => typeof window.gsap === 'object' && typeof window.ScrollTrigger === 'function'));
  await page.mouse.wheel(0, 2500);
  await page.waitForTimeout(2500); // let the staggered reveal finish
  const hidden = await page.$$eval('.pcard', (els) => els.filter((e) => getComputedStyle(e).opacity === '0' && e.getBoundingClientRect().top < innerHeight).length);
  assert.strictEqual(hidden, 0, 'cards in view have been revealed');
  assert.deepStrictEqual(errors, []);
  await page.context().close();
});

test('customer finds a product, orders from China and from stock', async () => {
  const page = await newPage();
  await page.goto(BASE + '/');
  await page.fill('#q', 'roofing');
  await page.press('#q', 'Enter');
  await page.click('.pcard h3 a >> text=Stone-Coated');
  await page.waitForSelector('h1:has-text("Stone-Coated")');

  await page.fill('#qty-s', '600');
  await page.click('.buy-option.source button:has-text("Add to cart")');
  await page.waitForSelector('text=added to your cart');
  await page.goBack();
  await page.fill('#qty-w', '40');
  await page.click('.buy-option.stock button:has-text("Buy now")');

  await page.waitForURL(/\/checkout$/);
  await page.fill('#customer_name', 'E2E Test');
  await page.fill('#email', 'e2e@example.com');
  await page.fill('#phone', '+231 770 000 999');
  await page.fill('#country', 'Liberia');
  await page.fill('#city', 'Monrovia');
  await page.selectOption('#shipping_method', 'sea_lcl');
  await page.fill('#notes', 'Automated end-to-end test order — please ignore.');
  await page.click('button:has-text("Submit order for quotation")');

  await page.waitForSelector('text=has been received');
  orderRef = (await page.textContent('h1')).replace('Order', '').trim();
  assert.match(orderRef, /^LH-\d{8}-[0-9A-F]{6}$/);
  const body = await page.textContent('main');
  assert.match(body, /600 sheet/);
  assert.match(body, /40 sheet/);
  assert.deepStrictEqual(errors, []);
  global.customerPage = page;
});

test('staff quote the order, customer accepts, staff ship it', { skip: !ADMIN_PASSWORD && 'set ADMIN_EMAIL/ADMIN_PASSWORD to test the admin flow' }, async () => {
  const admin = await newPage();
  await admin.goto(BASE + '/login');
  await admin.fill('#email', ADMIN_EMAIL);
  await admin.fill('#password', ADMIN_PASSWORD);
  await admin.click('main button[type=submit]');
  await admin.waitForURL(/\/admin$/);

  await admin.goto(`${BASE}/admin/orders/${orderRef}`);
  const prices = admin.locator('input[name=unit_price]');
  await prices.nth(0).fill('3.05');
  await prices.nth(1).fill('5.20');
  await admin.fill('#shipping_cost', '850');
  await admin.fill('#quote_message', 'Prices valid for 7 days. E2E test.');
  await admin.click('button:has-text("send quotation")');
  await admin.waitForSelector('text=Quotation sent');

  const customer = global.customerPage;
  await customer.reload();
  await customer.waitForSelector('text=Your quotation is ready');
  assert.match(await customer.textContent('.quote-box'), /\$2,888\.00/); // 600×3.05 + 40×5.20 + 850
  customer.once('dialog', (d) => d.accept());
  await customer.click('button:has-text("Accept quotation")');
  await customer.waitForSelector('text=Quotation accepted');

  await admin.reload();
  await admin.selectOption('#status', 'shipped');
  await admin.fill('#tracking_number', 'E2E-CONTAINER-1');
  await admin.fill('#message', 'Test shipment update.');
  await admin.click('button:has-text("Update order")');
  await admin.waitForSelector('text=Order updated');

  await customer.reload();
  assert.match(await customer.textContent('main'), /E2E-CONTAINER-1/);

  // Tidy up: cancel the test order.
  await admin.selectOption('#status', 'cancelled');
  await admin.fill('#message', 'Automated test order.');
  await admin.click('button:has-text("Update order")');
  assert.deepStrictEqual(errors, []);
});

test('staff add a product with a photo and it appears in the shop', { skip: !ADMIN_PASSWORD && 'set ADMIN_EMAIL/ADMIN_PASSWORD to test the admin flow' }, async () => {
  const admin = await newPage();
  await admin.goto(BASE + '/login');
  await admin.fill('#email', ADMIN_EMAIL);
  await admin.fill('#password', ADMIN_PASSWORD);
  await admin.click('main button[type=submit]');
  await admin.waitForURL(/\/admin$/);

  // A 1.5 MB photo, generated in the browser, to exercise real upload sizes.
  const png = await admin.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 2600; c.height = 1800;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(c.width, c.height);
    for (let i = 0; i < img.data.length; i++) img.data[i] = i % 4 === 3 ? 255 : (Math.random() * 256) | 0;
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const name = `E2E Test Product ${Date.now()}`;
  await admin.goto(BASE + '/admin/products/new');
  await admin.fill('#name', name);
  await admin.fill('#china_price', '99');
  await admin.setInputFiles('#images', { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await admin.click('button:has-text("Save product")');
  await admin.waitForSelector('text=created');
  const editUrl = admin.url();

  const shop = await newPage();
  await shop.goto(`${BASE}/products?q=${encodeURIComponent(name)}`);
  const src = await shop.getAttribute('.pcard img', 'src');
  assert.match(src, /^(\/uploads\/|https?:\/\/)/); // local disk or Supabase Storage
  const photo = await shop.request.get(src.startsWith('/') ? BASE + src : src);
  assert.strictEqual(photo.status(), 200);
  assert.match(photo.headers()['content-type'], /^image\//);
  // Large photos are shrunk in the browser before upload (max 1800px JPEG).
  assert.ok((await photo.body()).length > 50000);
  assert.ok(await shop.$eval('.pcard img', (img) => img.complete && img.naturalWidth > 0), 'photo displays');

  await admin.goto(editUrl);
  admin.once('dialog', (d) => d.accept());
  await admin.click('button:has-text("Delete product")');
  await admin.waitForSelector('text=Deleted');
  assert.deepStrictEqual(errors, []);
});

test('pages fit on a phone screen without sideways scrolling', async () => {
  const page = await newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  for (const url of ['/', '/products', '/products?category=tiles-ceramics', '/cart', '/checkout', '/request', '/how-it-works', '/track', '/login']) {
    await page.goto(BASE + url, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `${url} overflows by ${overflow}px`);
  }
  assert.deepStrictEqual(errors, []);
});
