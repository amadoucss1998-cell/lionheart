// Sample products whose photo arrives in a later deploy are added to an
// existing catalog once, and a sample product staff delete does not come back.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-samples-'));
Object.assign(process.env, { SEED_DEMO: '', DATA_DIR: tmp, ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'admin-pass-123', SESSION_SECRET: 'test-secret' });
require('./helpers').useTestDatabase();
const { db } = require('../src/db');
const { resetDatabase } = require('./helpers');
const seed = require('../src/seed');

// A stand-in photo for one sample SKU (public/static/products is build output).
const SKU = 'SW-VAN-80';
const photo = path.join(__dirname, '..', 'public', 'static', 'products', `${SKU.toLowerCase()}.jpg`);
let createdPhoto = false;

before(async () => {
  const log = console.log;
  console.log = () => {};
  await resetDatabase(db);
  await seed.bootstrap();
  console.log = log;
  if (!fs.existsSync(photo)) {
    fs.mkdirSync(path.dirname(photo), { recursive: true });
    await require('sharp')({ create: { width: 40, height: 30, channels: 3, background: '#888' } }).jpeg().toFile(photo);
    createdPhoto = true;
  }
});
after(async () => {
  if (createdPhoto) fs.rmSync(photo, { force: true });
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('every SKU in the photo list is a sample product', () => {
  const skus = seed.PRODUCTS.map((p) => p[2]);
  for (const sku of seed.PHOTO_SKUS) assert.ok(skus.includes(sku), `${sku} is not a sample product`);
});

test('a sample product whose photo now exists is added once, and stays deleted after staff remove it', async () => {
  const log = console.log;
  console.log = () => {};
  try {
    // An older catalog: the product is missing and was never offered.
    await db.run('DELETE FROM products WHERE sku = ?', [SKU]);
    await db.run("DELETE FROM settings WHERE key = 'sample_skus_offered'");

    await seed.addSamplesWithPhotos();
    await seed.attachStockPhotos();
    const added = await db.get('SELECT id FROM products WHERE sku = ?', [SKU]);
    assert.ok(added, 'product added');
    const images = await db.all('SELECT filename FROM product_images WHERE product_id = ?', [added.id]);
    assert.deepStrictEqual(images.map((i) => i.filename), [`/static/products/${SKU.toLowerCase()}.jpg`]);

    // Running again does not duplicate it.
    await seed.addSamplesWithPhotos();
    assert.strictEqual((await db.get('SELECT COUNT(*)::int AS n FROM products WHERE sku = ?', [SKU])).n, 1);

    // Staff delete it: it is not put back.
    await db.run('DELETE FROM products WHERE sku = ?', [SKU]);
    await seed.addSamplesWithPhotos();
    assert.strictEqual(await db.get('SELECT id FROM products WHERE sku = ?', [SKU]), undefined);
  } finally {
    console.log = log;
  }
});
