// Photo uploads to Supabase Storage, tested against a stand-in server that
// implements the Storage REST endpoints the app uses.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-storage-'));
const { server: fake, buckets, objects, calls } = require('./fake-supabase-storage').createFakeSupabaseStorage();

let server;
let browser;
let db;
let supabaseUrl;

before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  supabaseUrl = `http://127.0.0.1:${fake.address().port}`;
  Object.assign(process.env, {
  SEED_DEMO: 'all',
    DATA_DIR: tmp,
    ADMIN_EMAIL: 'admin@test.local',
    ADMIN_PASSWORD: 'admin-pass-123',
    SESSION_SECRET: 'test-secret',
    SUPABASE_URL: supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
  });
  require('./helpers').useTestDatabase();
  ({ db } = require('../src/db'));
  const { resetDatabase, makeBrowser } = require('./helpers');
  const log = console.log;
  console.log = () => {};
  await resetDatabase(db);
  await require('../src/seed').bootstrap();
  console.log = log;
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  browser = makeBrowser(`http://127.0.0.1:${server.address().port}`);
});

after(async () => {
  server.close();
  fake.close();
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const png = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex'
);

test('product photos are stored in a public Supabase bucket', async () => {
  const admin = browser();
  await admin.post('/login', { email: 'admin@test.local', password: 'admin-pass-123' }, '/login');
  const fd = new FormData();
  fd.append('_csrf', await admin.csrf('/admin/products/new'));
  fd.append('name', 'Cloud Photo Product');
  fd.append('sku', 'CLOUD-1');
  fd.append('sourcing_available', '1');
  fd.append('active', '1');
  fd.append('images', new Blob([png], { type: 'image/png' }), 'a.png');
  fd.append('images', new Blob([png], { type: 'image/png' }), 'b.png');
  const res = await admin.req('/admin/products/new', { method: 'POST', body: fd });
  assert.strictEqual(res.status, 302);

  // Bucket created once, public, restricted to images.
  const bucket = buckets.get('lionheart-uploads');
  assert.ok(bucket, 'bucket created');
  assert.strictEqual(bucket.public, true);
  assert.deepStrictEqual(bucket.allowed_mime_types, ['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  assert.strictEqual(calls.filter((c) => c.method === 'POST' && c.path === '/storage/v1/bucket').length, 1);
  assert.ok(calls.every((c) => c.auth === 'Bearer service-role-test-key'));

  // Both photos uploaded with the right type; the database stores public URLs.
  const p = await db.get("SELECT id, slug FROM products WHERE sku = 'CLOUD-1'");
  const images = await db.all('SELECT filename FROM product_images WHERE product_id = ? ORDER BY sort_order', [p.id]);
  assert.strictEqual(images.length, 2);
  for (const { filename } of images) {
    assert.match(filename, new RegExp(`^${supabaseUrl}/storage/v1/object/public/lionheart-uploads/products/\\d+-[0-9a-f]{12}\\.png$`));
    const photo = await fetch(filename);
    assert.strictEqual(photo.status, 200);
    assert.strictEqual(photo.headers.get('content-type'), 'image/png');
    assert.deepStrictEqual(Buffer.from(await photo.arrayBuffer()), png);
  }
  assert.strictEqual(fs.existsSync(path.join(tmp, 'uploads')), false, 'nothing written to local disk');

  // The shop links straight to Supabase, and the CSP allows it.
  const page = await admin.req(`/products/${p.slug}`);
  assert.match(page.headers.get('content-security-policy'), new RegExp(`img-src 'self' data: blob: ${supabaseUrl}`));
  assert.ok((await page.text()).includes(images[0].filename));

  // Removing a photo and deleting the product removes the files from storage.
  const edit = await admin.csrf(`/admin/products/${p.id}`);
  const img = await db.get('SELECT id, filename FROM product_images WHERE product_id = ? ORDER BY sort_order LIMIT 1', [p.id]);
  const form = new FormData();
  form.append('_csrf', edit);
  form.append('name', 'Cloud Photo Product');
  form.append('sku', 'CLOUD-1');
  form.append('sourcing_available', '1');
  form.append('active', '1');
  form.append('remove_image', String(img.id));
  await admin.req(`/admin/products/${p.id}`, { method: 'POST', body: form });
  assert.strictEqual(objects.size, 1);
  await admin.post(`/admin/products/${p.id}/delete`, {}, `/admin/products/${p.id}`);
  assert.strictEqual(objects.size, 0);
});

test('customer request photos go to the requests folder', async () => {
  const b = browser();
  const fd = new FormData();
  fd.append('_csrf', await b.csrf('/request'));
  fd.append('name', 'Ama');
  fd.append('email', 'ama@example.com');
  fd.append('description', 'Blue glazed roof tiles like this photo');
  fd.append('image', new Blob([png], { type: 'image/png' }), 'roof.png');
  const res = await b.req('/request', { method: 'POST', body: fd });
  assert.strictEqual(res.status, 200);
  const r = await db.get("SELECT image_filename FROM sourcing_requests WHERE email = 'ama@example.com'");
  assert.match(r.image_filename, /\/lionheart-uploads\/requests\/.+\.png$/);
  assert.ok(objects.has(`lionheart-uploads/${r.image_filename.split('/lionheart-uploads/')[1]}`));
});
