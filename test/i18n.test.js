// French version of the customer pages, and the Guinea (Conakry) location.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-i18n-'));
Object.assign(process.env, { SEED_DEMO: 'all', DATA_DIR: tmp, ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'admin-pass-123', SESSION_SECRET: 'test-secret' });
require('./helpers').useTestDatabase();
const { db } = require('../src/db');
const { createApp } = require('../src/app');
const { makeBrowser, resetDatabase } = require('./helpers');
const { translate, translateHtml } = require('../src/i18n');

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

test('translator handles phrases, values, entities and leaves scripts alone', () => {
  assert.strictEqual(translate('Order LH-1', 'fr'), 'Commande LH-1');
  assert.strictEqual(translate('Factory minimum: 36 piece(s)', 'fr'), 'Minimum usine : 36 pièce(s)');
  assert.strictEqual(translate('Some product name', 'fr'), 'Some product name');
  const html = translateHtml('<html lang="en"><a title="Search products">Doors &amp; Windows</a><script>var x = "Cart";</script></html>', 'fr');
  assert.match(html, /<html lang="fr">/);
  assert.match(html, /title="Rechercher des produits"/);
  assert.match(html, />Portes et fenêtres</);
  assert.match(html, /var x = "Cart";/);
});

test('English by default, French on request, and the choice is remembered', async () => {
  const b = browser();
  const en = await (await b.req('/')).text();
  assert.match(en, /<html lang="en">/);
  assert.match(en, /Shop by category/);

  const fr = await (await b.req('/?lang=fr')).text();
  assert.match(fr, /<html lang="fr">/);
  assert.match(fr, /Acheter par catégorie/);
  assert.match(fr, /Produits <em>phares<\/em>/);
  assert.doesNotMatch(fr, />Shop by category</);

  const next = await (await b.req('/products')).text();
  assert.match(next, /Tous les produits/);

  const back = await (await b.req('/products?lang=en')).text();
  assert.match(back, /All products/);
});

test('French-speaking browsers get French automatically', async () => {
  const res = await browser().req('/contact', { headers: { 'accept-language': 'fr-FR,fr;q=0.9,en;q=0.5' } });
  const html = await res.text();
  assert.match(html, /Nous contacter/);
  assert.match(res.headers.get('vary') || '', /Accept-Language/i);
});

test('form errors and messages are translated', async () => {
  const b = browser();
  await b.req('/?lang=fr');
  const res = await b.post('/request', { name: '', email: 'bad', description: '' }, '/request');
  const html = await res.text();
  assert.match(html, /Veuillez saisir votre nom\./);
  assert.match(html, /Veuillez saisir une adresse e-mail valide\./);
});

test('admin pages stay in English', async () => {
  const b = browser();
  await b.req('/?lang=fr');
  await b.post('/login', { email: 'admin@test.local', password: 'admin-pass-123' }, '/login');
  const html = await (await b.req('/admin')).text();
  assert.match(html, /<html lang="en">/);
  assert.match(html, /Dashboard/);
});

test('Conakry, Guinea is listed as a location', async () => {
  const b = browser();
  const home = await (await b.req('/')).text();
  assert.match(home, /Kipé, Conakry, Guinea/);
  assert.match(home, /Guangzhou, Dubai, Monrovia, Conakry/);
  const contact = await (await b.req('/contact')).text();
  assert.match(contact, /Guinea<\/h3>/);
  assert.match(contact, /Kipé, Conakry, Guinea/);
  const setting = await db.get("SELECT value FROM settings WHERE key = 'address_guinea'");
  assert.strictEqual(setting.value, 'Kipé, Conakry, Guinea');
});
