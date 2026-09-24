// Sample activity for demonstrating the admin (Admin → Settings → Sample data).
// Every sample record is clearly labelled and removed again in one step:
// orders LH-SAMPLE-…, requests RQ-SAMPLE-…, suppliers named "… (sample)".
const { db } = require('./db');

const SUPPLIERS = [
  ['Foshan Ceramic Works (sample)', 'Mr. Chen', 'Foshan', 'Porcelain and ceramic tiles, 60x60 and 80x80 formats.'],
  ['Guangzhou Roofing Materials (sample)', 'Ms. Li', 'Guangzhou', 'Stone-coated Decra-type tiles and zinc sheets.'],
  ['Changzhou Solar Tech (sample)', 'Mr. Wang', 'Changzhou', 'Tier-1 mono PERC panels, inverters and batteries.'],
  ['Jining Heavy Machinery (sample)', 'Mr. Zhao', 'Jining', 'Excavators, loaders and dump trucks, new and used.'],
];

// [customer, company, country, city, shipping, status, days ago, items: [skuHint, mode, qty, price]]
const ORDERS = [
  ['Joseph Kollie', 'Kollie Construction Ltd', 'Liberia', 'Monrovia', 'sea_fcl', 'received', 0, [['roof', 'source', 2400, null], ['door', 'source', 40, null]]],
  ['Aminata Sesay', 'Sesay Hotels', 'Sierra Leone', 'Freetown', 'sea_lcl', 'quoted', 2, [['tv', 'stock', 24, 260], ['solar', 'source', 60, 68]]],
  ['Emmanuel Doe', '', 'Liberia', 'Gbarnga', 'roro', 'paid', 6, [['excavator', 'source', 1, 61500]]],
  ['Fatou Jallow', 'Jallow Trading', 'Gambia', 'Banjul', 'sea_lcl', 'shipped', 18, [['solar', 'source', 120, 66], ['roof', 'stock', 800, 5.2]]],
  ['Samuel Tarr', 'Tarr Builders', 'Liberia', 'Buchanan', 'sea_fcl', 'delivered', 45, [['door', 'stock', 25, 160], ['roof', 'source', 3000, 3.05]]],
];

const STATUS_FLOW = ['received', 'quoted', 'accepted', 'paid', 'purchasing', 'inspection', 'shipped', 'arrived', 'delivered'];

async function hasSampleData() {
  return Boolean(await db.get("SELECT 1 AS ok FROM orders WHERE ref LIKE 'LH-SAMPLE-%' LIMIT 1"));
}

async function loadSampleData(userId) {
  await removeSampleData();
  const products = await db.all('SELECT id, name, sku, unit, china_price, stock_price FROM products WHERE active = 1 ORDER BY id');
  if (!products.length) throw new Error('Add at least one product first.');
  const pick = (hint) =>
    products.find((p) => `${p.name} ${p.sku}`.toLowerCase().includes(hint)) || products[Math.abs(hint.length * 7) % products.length];

  await db.transaction(async (tx) => {
    for (const [name, contact, city, notes] of SUPPLIERS) {
      await tx.run('INSERT INTO suppliers (name, contact_person, city, country, notes) VALUES (?, ?, ?, ?, ?)', [name, contact, city, 'China', notes]);
    }
    for (const [i, [customer, company, country, city, shipping, status, daysAgo, items]] of ORDERS.entries()) {
      const ref = `LH-SAMPLE-${String(i + 1).padStart(3, '0')}`;
      const lines = items.map(([hint, mode, qty, price]) => ({ p: pick(hint), mode, qty, price }));
      const priced = lines.every((l) => l.price !== null);
      const goods = priced ? lines.reduce((t, l) => t + l.price * l.qty, 0) : null;
      const shippingCost = priced ? Math.round(goods * 0.12) : null;
      const created = `now() - interval '${daysAgo} days'`;
      const orderId = await tx.insert(
        `INSERT INTO orders (ref, customer_name, email, phone, company, country, city, shipping_method, status, estimate_total, goods_total, shipping_cost, quoted_total,
           customer_message, tracking_number, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${created}, ${created})`,
        [
          ref, customer, `${customer.split(' ')[0].toLowerCase()}@example.com`, '+231 770 000 000', company || null, country, city, shipping, status,
          goods, priced ? goods : null, shippingCost, priced ? goods + shippingCost : null,
          status === 'received' ? null : 'Sample order for demonstration.',
          ['shipped', 'delivered'].includes(status) ? 'MSKU 482731-6' : null,
          'Sample order created for the demo. Remove it in Admin → Settings.',
        ]
      );
      for (const l of lines) {
        await tx.run('INSERT INTO order_items (order_id, product_id, product_name, sku, mode, qty, unit, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
          orderId, l.p.id, l.p.name, l.p.sku, l.mode, l.qty, l.p.unit, status === 'received' ? null : l.price,
        ]);
      }
      // History up to the current status, one step per day.
      const steps = STATUS_FLOW.slice(0, STATUS_FLOW.indexOf(status) + 1);
      for (const [n, st] of steps.entries()) {
        await tx.run(
          `INSERT INTO order_events (order_id, status, message, created_by, created_at) VALUES (?, ?, ?, ?, now() - interval '${Math.max(daysAgo - n, 0)} days')`,
          [orderId, st, n === 0 ? 'Order placed online.' : null, n === 0 ? null : userId]
        );
      }
    }
    await tx.run(
      `INSERT INTO sourcing_requests (ref, name, email, phone, country, description, quantity, target_price, status)
       VALUES ('RQ-SAMPLE-001', 'Grace Kamara', 'grace@example.com', '+231 880 000 000', 'Liberia', 'Kitchen cabinets for a 24-unit apartment block, white gloss doors, quartz tops.', '24 kitchens', 'USD 1,500 per kitchen', 'new'),
              ('RQ-SAMPLE-002', 'Musa Bangura', 'musa@example.com', '+232 76 000 000', 'Sierra Leone', '200 kVA diesel generator for a hotel, soundproof canopy, ATS.', '1 unit', '', 'searching')`
    );
  });
}

async function removeSampleData() {
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM orders WHERE ref LIKE 'LH-SAMPLE-%'");
    await tx.run("DELETE FROM sourcing_requests WHERE ref LIKE 'RQ-SAMPLE-%'");
    await tx.run("DELETE FROM suppliers WHERE name LIKE '% (sample)'");
  });
}

module.exports = { loadSampleData, removeSampleData, hasSampleData };
