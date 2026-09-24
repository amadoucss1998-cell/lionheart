const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { db, initDb } = require('./db');
const { uniqueSlug } = require('./helpers');

const CATEGORIES = [
  ['Electronics', 'cpu', 'Phones, laptops, TVs, appliances and accessories.'],
  ['Machinery', 'cog', 'Production lines, block machines, generators, pumps and workshop tools.'],
  ['Heavy Equipment', 'truck', 'Excavators, loaders, bulldozers, cranes and trucks.'],
  ['Vehicles', 'car', 'Cars, SUVs, pickups, buses and motorcycles — new and used.'],
  ['Furniture', 'sofa', 'Home, office, hotel and school furniture.'],
  ['Building Materials', 'bricks', 'Cement, steel, rebar, plywood, paint, pipes and more.'],
  ['Tiles & Ceramics', 'grid', 'Floor and wall tiles, porcelain, granite and marble.'],
  ['Sanitary Ware', 'droplet', 'Toilets, basins, showers, faucets and bathroom sets.'],
  ['Roofing (Decra & Zinc)', 'roof', 'Stone-coated Decra tiles, zinc and aluminium roofing sheets.'],
  ['Doors & Windows', 'door', 'Steel security doors, wooden doors, aluminium windows.'],
  ['Electrical & Solar', 'sun', 'Solar panels, inverters, batteries, cables and lighting.'],
];

// Sample listings so the catalog is not empty on first run.
// Prices are illustrative — edit or delete them from the admin panel.
const PRODUCTS = [
  ['Electronics', 'Android Smartphone 6.7" 8GB/256GB', 'EL-PH-001', 'Dual SIM, 5000mAh battery, 50MP camera', 'piece', 20, 118, 21, 165, 40, 'Dubai', 1,
    'Display: 6.7" AMOLED\nRAM: 8GB\nStorage: 256GB\nBattery: 5000mAh\nNetwork: 4G/5G dual SIM'],
  ['Electronics', '55" 4K Smart LED TV', 'EL-TV-055', 'Android TV with Wi-Fi, HDMI x3', 'piece', 10, 185, 25, 260, 15, 'Dubai', 1,
    'Screen: 55 inch\nResolution: 3840x2160\nOS: Android TV\nVoltage: 110–240V'],
  ['Electronics', 'Split Air Conditioner 18,000 BTU', 'EL-AC-18K', 'Inverter, R410A, tropical compressor (T3)', 'set', 10, 265, 30, null, null, '', 0,
    'Capacity: 18,000 BTU\nType: Inverter wall split\nVoltage: 220V/50Hz\nClimate: T3 tropical'],
  ['Machinery', 'Automatic Concrete Block Making Machine QT4-15', 'MC-BLK-415', 'Hollow & solid blocks, paving stones', 'set', 1, 9800, 30, null, null, '', 1,
    'Output: 4 blocks per cycle\nCycle time: 15–20s\nPower: 22kW\nPallet size: 880x550mm'],
  ['Machinery', 'Diesel Generator 100kVA Silent', 'MC-GEN-100', 'Soundproof canopy, ATS ready', 'set', 1, 7600, 20, 9900, 3, 'Dubai', 1,
    'Prime power: 100kVA / 80kW\nEngine: 4-cylinder diesel\nFrequency: 50Hz\nNoise: 72dB @ 7m'],
  ['Heavy Equipment', '20-Ton Crawler Excavator', 'HE-EXC-20T', '1.0 m³ bucket, Cummins engine', 'unit', 1, null, 35, null, null, '', 1,
    'Operating weight: 20,500 kg\nBucket: 1.0 m³\nEngine power: 110 kW\nMax dig depth: 6.6 m'],
  ['Heavy Equipment', 'Wheel Loader 5-Ton', 'HE-WL-5T', '3 m³ bucket, pilot control', 'unit', 1, null, 30, null, null, '', 0,
    'Rated load: 5,000 kg\nBucket: 3 m³\nEngine: Weichai 162 kW\nTransmission: Powershift'],
  ['Heavy Equipment', 'Sinotruk HOWO 371 Dump Truck 6x4', 'HE-HOWO-371', 'Right/left-hand drive, 25–30 m³ body', 'unit', 1, null, 30, null, null, '', 1,
    'Drive: 6x4\nEngine: 371 HP\nBody: 25–30 m³\nEmission: Euro II/III'],
  ['Vehicles', 'Toyota Land Cruiser Prado (Used, 2019)', 'VH-PRADO-19', 'Inspected used SUV, export ready', 'unit', 1, null, 21, null, null, 'Dubai', 1,
    'Year: 2019\nFuel: Petrol\nTransmission: Automatic\nDrive: 4WD'],
  ['Vehicles', 'Pickup Truck Double Cabin 4x4 Diesel', 'VH-PU-4X4', 'New Chinese brand pickup, manual', 'unit', 1, null, 30, null, null, '', 0,
    'Engine: 2.5L turbo diesel\nDrive: 4x4\nGearbox: 6-speed manual\nSeats: 5'],
  ['Furniture', 'L-Shape Fabric Sofa Set (7-Seater)', 'FN-SOFA-L7', 'Modern design, choice of colours', 'set', 2, 420, 30, 780, 6, 'Dubai', 1,
    'Seats: 7\nFrame: Solid wood\nCover: Linen fabric\nColours: Grey, beige, navy'],
  ['Furniture', 'Executive Office Desk with Side Cabinet', 'FN-DESK-EX', '1.8m, MDF with walnut finish', 'set', 5, 190, 25, null, null, '', 0,
    'Size: 1800x900x760mm\nMaterial: E1 MDF\nFinish: Walnut veneer'],
  ['Building Materials', 'Deformed Steel Rebar HRB400', 'BM-REB-400', 'Diameters 8–32mm, 12m length', 'ton', 25, 560, 20, null, null, '', 0,
    'Grade: HRB400 / B500B\nDiameter: 8–32mm\nLength: 12m'],
  ['Building Materials', 'Marine Plywood 18mm', 'BM-PLY-18', 'WBP glue, film faced', 'sheet', 500, 14.5, 20, 21, 1200, 'Dubai', 0,
    'Size: 1220x2440mm\nThickness: 18mm\nGlue: WBP phenolic'],
  ['Tiles & Ceramics', 'Porcelain Floor Tile 60x60 Polished', 'TL-6060-P', 'Glossy polished, many designs', 'sqm', 200, 6.8, 25, 11.5, 1500, 'Dubai', 1,
    'Size: 600x600mm\nThickness: 9.5mm\nFinish: Polished glazed\nWater absorption: <0.5%'],
  ['Tiles & Ceramics', 'Ceramic Wall Tile 30x60', 'TL-3060-W', 'Kitchen and bathroom wall tile', 'sqm', 300, 4.2, 25, null, null, '', 0,
    'Size: 300x600mm\nFinish: Matt / glossy\nUse: Interior walls'],
  ['Sanitary Ware', 'One-Piece Toilet with Soft-Close Seat', 'SW-WC-1P', 'Siphonic flush, S-trap', 'set', 20, 58, 25, 95, 60, 'Dubai', 1,
    'Type: One-piece\nFlush: Dual 3/6L\nTrap: S-trap 250mm'],
  ['Sanitary Ware', 'Bathroom Vanity Cabinet with Basin & Mirror', 'SW-VAN-80', '80cm, waterproof PVC', 'set', 10, 88, 30, null, null, '', 0,
    'Width: 800mm\nMaterial: PVC\nIncludes: Basin, mirror, faucet'],
  ['Roofing (Decra & Zinc)', 'Stone-Coated Roofing Tile (Decra type)', 'RF-DECRA-BD', 'Bond / Milano / Shingle profiles', 'sheet', 500, 3.1, 20, 5.2, 4000, 'Dubai', 1,
    'Size: 1340x420mm\nThickness: 0.4mm AZ150\nCoverage: ~0.46 m² per sheet\nWarranty: 30 years'],
  ['Roofing (Decra & Zinc)', 'Corrugated Zinc Roofing Sheet 0.3mm', 'RF-ZINC-03', 'Galvanised, gauge 30', 'sheet', 1000, 4.4, 20, null, null, '', 0,
    'Thickness: 0.3mm\nLength: 2–3.6m (custom)\nCoating: Z80 galvanised'],
  ['Doors & Windows', 'Steel Security Door with Frame', 'DW-SEC-96', 'Anti-theft, many colours', 'set', 10, 95, 25, 160, 30, 'Dubai', 1,
    'Size: 960x2050mm (custom available)\nLock: Multi-point\nFinish: Powder coated / wood-grain transfer'],
  ['Doors & Windows', 'Aluminium Sliding Window with Mosquito Net', 'DW-ALU-SL', 'Double glass, custom sizes', 'sqm', 30, 48, 30, null, null, '', 0,
    'Profile: 1.4mm aluminium\nGlass: 5mm tempered\nColours: White, black, champagne'],
  ['Electrical & Solar', 'Solar Panel 550W Mono PERC', 'ES-PV-550', 'Tier-1 half-cut cells', 'piece', 36, 68, 20, 105, 200, 'Dubai', 1,
    'Power: 550W\nCells: 144 half-cut mono\nEfficiency: 21.3%\nSize: 2279x1134x35mm'],
  ['Electrical & Solar', 'Hybrid Inverter 10kW with Lithium Battery 10kWh', 'ES-HYB-10', 'Complete home backup kit', 'set', 1, 2350, 20, null, null, '', 0,
    'Inverter: 10kW hybrid, MPPT\nBattery: 10kWh LiFePO4\nCycles: 6000+'],
];

// Both functions run inside a transaction holding an advisory lock, so two
// instances starting at the same moment (e.g. serverless cold starts) cannot
// create duplicate admins or seed the catalog twice.
async function ensureAdmin() {
  let created = null;
  await db.transaction(async (tx) => {
    await tx.run('SELECT pg_advisory_xact_lock(727275)');
    if (await tx.get("SELECT 1 AS ok FROM users WHERE role = 'admin'")) return;
    const email = (process.env.ADMIN_EMAIL || 'admin@lionheartgroup.info').toLowerCase();
    const generated = !process.env.ADMIN_PASSWORD;
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    const hash = await bcrypt.hash(password, 10);
    const existing = await tx.get('SELECT id FROM users WHERE lower(email) = ?', [email]);
    if (existing) await tx.run("UPDATE users SET role = 'admin', password_hash = ? WHERE id = ?", [hash, existing.id]);
    else await tx.run("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')", ['Administrator', email, hash]);
    created = { email, password: generated ? password : null };
  });
  if (!created) return;
  console.log('\n==============================================');
  console.log(' Admin account created');
  console.log(`   Email:    ${created.email}`);
  console.log(`   Password: ${created.password || '(from ADMIN_PASSWORD)'}`);
  if (created.password) console.log('   Save this password now — change it after signing in.');
  console.log('==============================================\n');
}

async function seedCatalog() {
  await db.transaction(async (tx) => {
    await tx.run('SELECT pg_advisory_xact_lock(727276)');
    if (!(await tx.get('SELECT 1 AS ok FROM categories LIMIT 1'))) {
      for (const [i, [name, icon, desc]] of CATEGORIES.entries()) {
        await tx.run('INSERT INTO categories (name, slug, icon, description, sort_order) VALUES (?, ?, ?, ?, ?)', [
          name,
          await uniqueSlug(tx, 'categories', name),
          icon,
          desc,
          i,
        ]);
      }
    }
    if (await tx.get('SELECT 1 AS ok FROM products LIMIT 1')) return;
    const catIds = new Map((await tx.all('SELECT id, name FROM categories')).map((c) => [c.name, c.id]));
    for (const [cat, name, sku, short, unit, moq, chinaPrice, lead, stockPrice, stockQty, location, featured, specs] of PRODUCTS) {
      await tx.run(
        `INSERT INTO products (sku, name, slug, category_id, short_description, description, specs, unit, moq,
          sourcing_available, china_price, china_lead_days, stock_available, stock_price, stock_qty, stock_location, featured)
         VALUES (@sku, @name, @slug, @category_id, @short, @description, @specs, @unit, @moq, 1, @china_price, @lead, @stock_available, @stock_price, @stock_qty, @stock_location, @featured)`,
        {
          sku,
          name,
          slug: await uniqueSlug(tx, 'products', name),
          category_id: catIds.get(cat) || null,
          short,
          description:
            `${short}. We source this product directly from verified manufacturers in China, inspect it at our warehouse ` +
            'and ship it to your port or door. Custom specifications, colours and branding are available on request.',
          specs,
          unit,
          moq,
          china_price: chinaPrice,
          lead,
          stock_available: stockPrice !== null || location === 'Dubai' ? 1 : 0,
          stock_price: stockPrice,
          stock_qty: stockQty,
          stock_location: location ? `${location} warehouse` : '',
          featured,
        }
      );
    }
  });
}

// Stock photos shipped with the site (public/static/products/<sku>.jpg) are
// attached to the matching sample products that have no photo yet. This also
// fills in photos on databases that were seeded before the photos existed.
const STOCK_DIR = path.join(__dirname, '..', 'public', 'static', 'products');

function stockPhotoFor(sku) {
  const file = `${String(sku).toLowerCase()}.jpg`;
  return fs.existsSync(path.join(STOCK_DIR, file)) ? `/static/products/${file}` : null;
}

// Runs once per database (flag in settings), so a photo an admin removes later
// is not put back on the next start.
async function attachStockPhotos() {
  const skus = PRODUCTS.map((p) => p[2]).filter((sku) => stockPhotoFor(sku));
  if (!skus.length) return;
  await db.transaction(async (tx) => {
    await tx.run('SELECT pg_advisory_xact_lock(727277)');
    if (await tx.get("SELECT 1 AS ok FROM settings WHERE key = 'stock_photos_attached'")) return;
    const missing = await tx.all(
      `SELECT id, sku FROM products p WHERE sku IN (${skus.map(() => '?').join(', ')})
         AND NOT EXISTS (SELECT 1 FROM product_images i WHERE i.product_id = p.id)`,
      skus
    );
    for (const p of missing) {
      await tx.run('INSERT INTO product_images (product_id, filename, sort_order) VALUES (?, ?, 0)', [p.id, stockPhotoFor(p.sku)]);
    }
    await tx.run("INSERT INTO settings (key, value) VALUES ('stock_photos_attached', ?)", [new Date().toISOString()]);
  });
}

// Everything the app needs before serving requests. Memoised, so it runs once
// per process (or per serverless instance).
let bootPromise;
function bootstrap() {
  if (!bootPromise) {
    bootPromise = (async () => {
      await initDb();
      await ensureAdmin();
      if (process.env.SEED_DEMO !== 'false') {
        await seedCatalog();
        await attachStockPhotos();
      }
    })().catch((err) => {
      bootPromise = null;
      throw err;
    });
  }
  return bootPromise;
}

module.exports = { ensureAdmin, seedCatalog, attachStockPhotos, bootstrap, PRODUCTS };

if (require.main === module) {
  bootstrap()
    .then(() => {
      console.log('Seed complete.');
      return db.close();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
