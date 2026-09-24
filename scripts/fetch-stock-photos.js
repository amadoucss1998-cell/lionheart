// Downloads the AI-generated product photos listed in scripts/stock-photos.json
// (SKU -> image URL), converts them to 1200×900 JPEGs in
// public/static/products/<sku>.jpg, and records which SKUs have a photo in
// src/stock-photos.generated.json so the server (e.g. a Vercel function, which
// has no access to public/) knows which photos exist. Runs during the build;
// failures only print a warning, they never break the build.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const manifestFile = process.env.STOCK_PHOTOS_MANIFEST || path.join(__dirname, 'stock-photos.json');
const outDir = path.join(root, 'public', 'static', 'products');
const listFile = path.join(root, 'src', 'stock-photos.generated.json');

(async () => {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.warn('fetch-stock-photos: sharp is not installed, skipping.');
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });
  const available = [];
  for (const [sku, url] of Object.entries(manifest)) {
    const file = path.join(outDir, `${sku.toLowerCase()}.jpg`);
    try {
      if (!fs.existsSync(file)) {
        const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        await sharp(buf).resize(1200, 900, { fit: 'cover' }).jpeg({ quality: 82, mozjpeg: true }).toFile(file);
      }
      available.push(sku);
    } catch (err) {
      console.warn(`fetch-stock-photos: ${sku} skipped (${err.message})`);
    }
  }
  // Photos already in the folder (e.g. made with generate-product-images.js) count too.
  for (const f of fs.readdirSync(outDir)) {
    const sku = f.replace(/\.jpg$/, '').toUpperCase();
    if (f.endsWith('.jpg') && !available.includes(sku)) available.push(sku);
  }
  fs.writeFileSync(listFile, JSON.stringify(available.sort(), null, 2) + '\n');
  console.log(`fetch-stock-photos: ${available.length} product photo(s) ready.`);
})().catch((err) => console.warn(`fetch-stock-photos: ${err.message}`));
