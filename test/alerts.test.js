const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-alerts-'));
Object.assign(process.env, {
  SEED_DEMO: 'all',
  DATA_DIR: tmp,
  ADMIN_EMAIL: 'admin@test.local',
  ADMIN_PASSWORD: 'admin-pass-123',
  SESSION_SECRET: 'test-secret',
  PUBLIC_URL: 'https://shop.lionheart.test',
  COOKIE_SECURE: 'false',
  WHATSAPP_PROVIDER: 'cloud',
  WHATSAPP_TOKEN: 'test-token',
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
});

const nodemailer = require('nodemailer');
require('./helpers').useTestDatabase();
const { bootstrap } = require('../src/seed');
const { createApp } = require('../src/app');
const { db, setSetting } = require('../src/db');
const notify = require('../src/notify');
const { makeBrowser, resetDatabase } = require('./helpers');

let server;
let browser;
const realFetch = global.fetch;
let emails = [];
let whatsapp = [];
let whatsappFails = false;

// Capture outgoing email instead of sending it.
const transport = nodemailer.createTransport({ jsonTransport: true });
const origSend = transport.sendMail.bind(transport);
transport.sendMail = async (msg) => {
  emails.push(msg);
  return origSend(msg);
};

before(async () => {
  const log = console.log;
  console.log = () => {};
  await resetDatabase(db);
  await bootstrap();
  console.log = log;
  notify._setTransport(transport);
  await setSetting('alert_emails', 'sales@lionheart.test, boss@lionheart.test');
  await setSetting('alert_whatsapp_numbers', '+231 888 979 704, 971500000001');

  // Intercept calls to the WhatsApp API; let calls to the test server through.
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://graph.facebook.com/')) {
      whatsapp.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return whatsappFails
        ? new Response('{"error":{"message":"Invalid token"}}', { status: 401 })
        : new Response('{"messages":[{"id":"wamid.1"}]}', { status: 200 });
    }
    return realFetch(url, init);
  };

  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  browser = makeBrowser(`http://127.0.0.1:${server.address().port}`);
});

after(async () => {
  global.fetch = realFetch;
  server.close();
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  emails = [];
  whatsapp = [];
  whatsappFails = false;
  (await db.run('DELETE FROM notification_log'));
});

async function waitFor(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('timed out waiting for alerts');
}

async function placeOrder() {
  const b = browser();
  const p = (await db.get("SELECT * FROM products WHERE sku = 'RF-DECRA-BD'"));
  await b.post('/cart/add', { product_id: p.id, mode: 'source', qty: 800, notes: 'Red, Milano profile' }, `/products/${p.slug}`);
  const res = await b.post(
    '/checkout',
    { customer_name: 'Musa Kamara', company: 'Kamara Builders', email: 'musa@example.com', phone: '+231 770 000 111', country: 'Liberia', city: 'Monrovia', shipping_method: 'sea_fcl' },
    '/checkout'
  );
  assert.strictEqual(res.status, 302);
  return res.headers.get('location').split('/').pop().split('?')[0];
}

test('new order sends email and WhatsApp alerts to every recipient', async () => {
  const ref = await placeOrder();
  await waitFor(async () => (await db.get('SELECT COUNT(*) AS n FROM notification_log')).n === 3);

  const mail = emails[0];
  assert.strictEqual(mail.to, 'sales@lionheart.test, boss@lionheart.test');
  assert.match(mail.subject, new RegExp(`New order ${ref}: Musa Kamara, Liberia`));
  assert.match(mail.html, /Kamara Builders/);
  assert.match(mail.html, /Red, Milano profile/);
  assert.match(mail.html, new RegExp(`https://shop.lionheart.test/admin/orders/${ref}`));
  assert.match(mail.text, /800 sheet × Stone-Coated Roofing Tile/);

  assert.deepStrictEqual(whatsapp.map((w) => w.body.to).sort(), ['231888979704', '971500000001']);
  const wa = whatsapp[0];
  assert.strictEqual(wa.url, 'https://graph.facebook.com/v21.0/1234567890/messages');
  assert.strictEqual(wa.headers.Authorization, 'Bearer test-token');
  assert.strictEqual(wa.body.type, 'text');
  assert.match(wa.body.text.body, new RegExp(`NEW ORDER ${ref}`));
  assert.match(wa.body.text.body, /\+231 770 000 111/);

  const log = (await db.all('SELECT * FROM notification_log'));
  assert.strictEqual(log.length, 3);
  assert.ok(log.every((l) => l.status === 'sent'));
});

test('WhatsApp templates get single-line parameters', async () => {
  process.env.WHATSAPP_TEMPLATE = 'new_order_alert';
  try {
    const ref = await placeOrder();
    await waitFor(() => whatsapp.length === 2);
    const tpl = whatsapp[0].body.template;
    assert.strictEqual(tpl.name, 'new_order_alert');
    const params = tpl.components[0].parameters.map((p) => p.text);
    assert.strictEqual(params.length, 6);
    assert.strictEqual(params[0], ref);
    assert.ok(params.every((p) => !/[\n\t]| {4}/.test(p)));
  } finally {
    delete process.env.WHATSAPP_TEMPLATE;
  }
});

test('a failing alert channel is logged and does not affect the order', async () => {
  whatsappFails = true;
  const ref = await placeOrder();
  assert.ok((await db.get('SELECT 1 FROM orders WHERE ref = ?', [ref])));
  await waitFor(async () => (await db.get("SELECT COUNT(*) AS n FROM notification_log WHERE status = 'failed'")).n === 2);
  const failed = (await db.get("SELECT * FROM notification_log WHERE status = 'failed'"));
  assert.match(failed.error, /HTTP 401/);
  assert.strictEqual(emails.length, 1);

  const admin = browser();
  await admin.post('/login', { email: 'admin@test.local', password: 'admin-pass-123' }, '/login');
  const page = await (await admin.req('/admin/settings')).text();
  assert.match(page, /Invalid token/);
});

test('sourcing requests alert unless switched off', async () => {
  const b = browser();
  const fd = new FormData();
  fd.append('_csrf', await b.csrf('/request'));
  fd.append('name', 'Fatu');
  fd.append('email', 'fatu@example.com');
  fd.append('phone', '+231 555 222');
  fd.append('description', 'Kitchen cabinets for 12 apartments');
  await b.req('/request', { method: 'POST', body: fd });
  await waitFor(() => emails.length === 1 && whatsapp.length === 2);
  assert.match(emails[0].subject, /New sourcing request RQ-/);
  assert.match(emails[0].html, /Kitchen cabinets for 12 apartments/);

  await setSetting('alert_on_requests', 'no');
  emails = [];
  const fd2 = new FormData();
  fd2.append('_csrf', await b.csrf('/request'));
  fd2.append('name', 'Fatu');
  fd2.append('email', 'fatu@example.com');
  fd2.append('description', 'Second request');
  await b.req('/request', { method: 'POST', body: fd2 });
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(emails.length, 0);
  await setSetting('alert_on_requests', 'yes');
});

test('admin can send a test alert', async () => {
  const admin = browser();
  await admin.post('/login', { email: 'admin@test.local', password: 'admin-pass-123' }, '/login');
  const res = await admin.post('/admin/settings/test-alert', {}, '/admin/settings');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(emails.length, 1);
  assert.strictEqual(emails[0].subject, 'Lionheart test alert');
  assert.strictEqual(whatsapp.length, 2);
  const page = await (await admin.req('/admin/settings')).text();
  assert.match(page, /Test alert sent/);
});

test('HTML in customer input is escaped in alert emails', async () => {
  const order = { ref: 'LH-X', customer_name: '<script>x</script>', email: 'a@b.c', country: 'LR', estimate_total: null };
  const { html } = notify.orderMessages(order, [{ product_name: '<b>Tile</b>', mode: 'stock', qty: 1, unit: 'sqm', unit_price: null }], '');
  assert.ok(!html.includes('<script>x</script>'));
  assert.ok(html.includes('&lt;b&gt;Tile&lt;/b&gt;'));
});
