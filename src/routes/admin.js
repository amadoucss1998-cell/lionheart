const express = require('express');
const bcrypt = require('bcryptjs');
const { db, getSettings, setSetting, DEFAULT_SETTINGS } = require('../db');
const { upload, csvUpload, withUpload, flash, requireStaff, requireAdmin, clearCatalogCache } = require('../middleware');
const { listProducts, getProduct } = require('../catalog');
const { loadOrderDetail } = require('../orders');
const { saveImages, removeImage } = require('../storage');
const h = require('../helpers');
const notify = require('../notify');
const demo = require('../demo');

const router = express.Router();
router.use(requireStaff);
// Any change made in the admin can affect the cached category menu.
router.use((req, res, next) => {
  if (req.method === 'POST') res.on('finish', clearCatalogCache);
  next();
});

const trim = (v, max = 4000) => String(v || '').trim().slice(0, max);
const checkbox = (v) => (v ? 1 : 0);
const count = async (sql, params) => (await db.get(sql, params)).n;
const WITHOUT_PHOTOS = 'FROM products p WHERE NOT EXISTS (SELECT 1 FROM product_images i WHERE i.product_id = p.id)';

router.get('/', async (req, res) => {
  const [products, ordersOpen, ordersNew, requestsNew, customers, suppliers, byStatus, recentOrders, recentRequests, alerts] = await Promise.all([
    count('SELECT COUNT(*)::int AS n FROM products WHERE active = 1'),
    count("SELECT COUNT(*)::int AS n FROM orders WHERE status NOT IN ('delivered','cancelled')"),
    count("SELECT COUNT(*)::int AS n FROM orders WHERE status = 'received'"),
    count("SELECT COUNT(*)::int AS n FROM sourcing_requests WHERE status = 'new'"),
    count("SELECT COUNT(*)::int AS n FROM users WHERE role = 'customer'"),
    count('SELECT COUNT(*)::int AS n FROM suppliers'),
    db.all('SELECT status, COUNT(*)::int AS n FROM orders GROUP BY status'),
    db.all('SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT 8'),
    db.all('SELECT * FROM sourcing_requests ORDER BY created_at DESC, id DESC LIMIT 5'),
    notify.status(),
  ]);
  const stats = { products, ordersOpen, ordersNew, requestsNew, customers, suppliers };
  const alertsOff = !alerts.emailConfigured && !alerts.whatsappProvider;
  res.render('admin/dashboard', { title: 'Dashboard', stats, byStatus, recentOrders, recentRequests, alertsOff });
});

// ---------------- Products ----------------

router.get('/products', async (req, res) => {
  const q = trim(req.query.q, 100);
  const category = trim(req.query.category, 100);
  const [{ items, total }, { n: withoutPhotos }] = await Promise.all([
    listProducts({ q, category, sort: 'newest', limit: 500, includeInactive: true }),
    db.get(`SELECT COUNT(*)::int AS n ${WITHOUT_PHOTOS}`),
  ]);
  res.render('admin/products', { title: 'Products', items, total, q, category, withoutPhotos });
});

async function productFormData() {
  const [categories, suppliers] = await Promise.all([
    db.all('SELECT * FROM categories ORDER BY sort_order, name'),
    db.all('SELECT id, name, city FROM suppliers ORDER BY name'),
  ]);
  return { categories, suppliers };
}

function readProductForm(body) {
  return {
    name: trim(body.name, 200),
    sku: trim(body.sku, 60) || null,
    category_id: h.toIntOrNull(body.category_id),
    supplier_id: h.toIntOrNull(body.supplier_id),
    short_description: trim(body.short_description, 300),
    description: trim(body.description, 20000),
    specs: trim(body.specs, 10000),
    unit: trim(body.unit, 40) || 'piece',
    moq: Math.max(1, h.toIntOrNull(body.moq) || 1),
    sourcing_available: checkbox(body.sourcing_available),
    china_price: h.toNumberOrNull(body.china_price),
    china_lead_days: h.toIntOrNull(body.china_lead_days),
    stock_available: checkbox(body.stock_available),
    stock_price: h.toNumberOrNull(body.stock_price),
    stock_qty: h.toIntOrNull(body.stock_qty),
    stock_location: trim(body.stock_location, 80),
    featured: checkbox(body.featured),
    active: checkbox(body.active),
  };
}

async function validateProduct(p, id) {
  const errors = [];
  if (!p.name) errors.push('Product name is required.');
  if (!p.sourcing_available && !p.stock_available) errors.push('Enable at least one way to buy: China sourcing or Lionheart stock.');
  if (p.sku && (await db.get('SELECT id FROM products WHERE sku = ? AND id IS DISTINCT FROM ?', [p.sku, id || null]))) {
    errors.push('Another product already uses this SKU.');
  }
  return errors;
}

async function addImages(productId, files) {
  if (!files || !files.length) return;
  const stored = await saveImages(files, 'products');
  const { n: start } = await db.get('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM product_images WHERE product_id = ?', [productId]);
  for (const [i, filename] of stored.entries()) {
    await db.run('INSERT INTO product_images (product_id, filename, sort_order) VALUES (?, ?, ?)', [productId, filename, start + i]);
  }
}

const blankProduct = { active: 1, sourcing_available: 1, stock_available: 0, unit: 'piece', moq: 1, images: [] };

const PRODUCT_COLUMNS = `sku, name, slug, category_id, supplier_id, short_description, description, specs, unit, moq,
  sourcing_available, china_price, china_lead_days, stock_available, stock_price, stock_qty, stock_location, featured, active`;
const PRODUCT_VALUES = `@sku, @name, @slug, @category_id, @supplier_id, @short_description, @description, @specs, @unit, @moq,
  @sourcing_available, @china_price, @china_lead_days, @stock_available, @stock_price, @stock_qty, @stock_location, @featured, @active`;

router.get('/products/new', async (req, res) => {
  res.render('admin/product-form', { title: 'Add product', product: blankProduct, errors: [], ...(await productFormData()) });
});

router.post('/products/new', ...withUpload(upload.array('images', 12)), async (req, res) => {
  const p = readProductForm(req.body);
  const errors = await validateProduct(p);
  if (errors.length) {
    return res.status(400).render('admin/product-form', { title: 'Add product', product: { ...p, images: [] }, errors, ...(await productFormData()) });
  }
  const slug = await h.uniqueSlug(db, 'products', p.name);
  const id = await db.insert(`INSERT INTO products (${PRODUCT_COLUMNS}) VALUES (${PRODUCT_VALUES})`, { ...p, slug });
  await addImages(id, req.files);
  flash(req, 'success', `Product "${p.name}" created.`);
  res.redirect(req.body.save_and_new ? '/admin/products/new' : `/admin/products/${id}`);
});

router.get('/products/:id', async (req, res) => {
  const product = await getProduct({ id: h.toIntOrNull(req.params.id) });
  if (!product) return res.status(404).render('error', { title: 'Not found', message: 'Product not found.' });
  res.render('admin/product-form', { title: `Edit: ${product.name}`, product, errors: [], ...(await productFormData()) });
});

router.post('/products/:id', ...withUpload(upload.array('images', 12)), async (req, res) => {
  const existing = await getProduct({ id: h.toIntOrNull(req.params.id) });
  if (!existing) return res.status(404).render('error', { title: 'Not found', message: 'Product not found.' });
  const p = readProductForm(req.body);
  const errors = await validateProduct(p, existing.id);
  if (errors.length) {
    return res.status(400).render('admin/product-form', { title: `Edit: ${existing.name}`, product: { ...existing, ...p }, errors, ...(await productFormData()) });
  }
  const slug = p.name === existing.name ? existing.slug : await h.uniqueSlug(db, 'products', p.name, existing.id);
  await db.run(
    `UPDATE products SET sku=@sku, name=@name, slug=@slug, category_id=@category_id, supplier_id=@supplier_id,
      short_description=@short_description, description=@description, specs=@specs, unit=@unit, moq=@moq,
      sourcing_available=@sourcing_available, china_price=@china_price, china_lead_days=@china_lead_days,
      stock_available=@stock_available, stock_price=@stock_price, stock_qty=@stock_qty, stock_location=@stock_location,
      featured=@featured, active=@active, updated_at=now() WHERE id=@id`,
    { ...p, slug, id: existing.id }
  );

  const removeIds = [].concat(req.body.remove_image || []).map(h.toIntOrNull).filter(Boolean);
  for (const imgId of removeIds) {
    const img = await db.get('SELECT * FROM product_images WHERE id = ? AND product_id = ?', [imgId, existing.id]);
    if (img) {
      await db.run('DELETE FROM product_images WHERE id = ?', [img.id]);
      await removeImage(img.filename);
    }
  }
  const mainId = h.toIntOrNull(req.body.main_image);
  if (mainId && !removeIds.includes(mainId)) {
    await db.run('UPDATE product_images SET sort_order = CASE WHEN id = ? THEN 0 ELSE sort_order + 1 END WHERE product_id = ?', [mainId, existing.id]);
  }
  await addImages(existing.id, req.files);
  flash(req, 'success', 'Product saved.');
  res.redirect(`/admin/products/${existing.id}`);
});

router.post('/products-without-photos/delete', async (req, res) => {
  const expected = h.toIntOrNull(req.body.count);
  const { n } = await db.get(`SELECT COUNT(*)::int AS n ${WITHOUT_PHOTOS}`);
  // The count shown to the admin must still be current, so nothing unexpected is deleted.
  if (expected === null || expected !== n) {
    flash(req, 'error', 'The product list changed. Please review it and try again.');
    return res.redirect('/admin/products');
  }
  const { changes } = await db.run(`DELETE ${WITHOUT_PHOTOS}`);
  flash(req, 'success', `Deleted ${changes} product${changes === 1 ? '' : 's'} without photos. Past orders keep their copy of the product name.`);
  res.redirect('/admin/products');
});

router.post('/products/:id/duplicate', async (req, res) => {
  const src = await getProduct({ id: h.toIntOrNull(req.params.id) });
  if (!src) return res.redirect('/admin/products');
  const name = `${src.name} (copy)`;
  const id = await db.insert(`INSERT INTO products (${PRODUCT_COLUMNS}) VALUES (${PRODUCT_VALUES})`, {
    ...src,
    sku: null,
    name,
    slug: await h.uniqueSlug(db, 'products', name),
    featured: 0,
    active: 0,
  });
  flash(req, 'success', 'Copy created (hidden until you activate it). Add photos and adjust the details.');
  res.redirect(`/admin/products/${id}`);
});

router.post('/products/:id/delete', async (req, res) => {
  const product = await getProduct({ id: h.toIntOrNull(req.params.id) });
  if (product) {
    await db.run('DELETE FROM products WHERE id = ?', [product.id]);
    await Promise.all(product.images.map((img) => removeImage(img.filename)));
    flash(req, 'success', `Deleted "${product.name}". Past orders keep their copy of the product name.`);
  }
  res.redirect('/admin/products');
});

// ---- Bulk import ----

const CSV_COLUMNS = [
  'name', 'sku', 'category', 'supplier', 'short_description', 'description', 'specs', 'unit', 'moq',
  'sourcing_available', 'china_price', 'china_lead_days', 'stock_available', 'stock_price', 'stock_qty', 'stock_location', 'featured',
];

router.get('/products-import', (req, res) => {
  res.render('admin/import', { title: 'Bulk import products', columns: CSV_COLUMNS, result: null });
});

router.get('/products-import/template.csv', (req, res) => {
  const sample = [
    CSV_COLUMNS,
    ['Porcelain Floor Tile 60x60 Polished', 'TL-6060-P', 'Tiles & Ceramics', '', 'Glossy polished porcelain tile', 'High quality polished porcelain tile for living rooms and offices.',
      'Size: 600x600mm\nThickness: 9.5mm\nFinish: Polished', 'sqm', '200', 'yes', '6.80', '25', 'yes', '11.50', '1500', 'Dubai warehouse', 'no'],
  ];
  res.type('text/csv').attachment('lionheart-products-template.csv').send(sample.map((r) => r.map(h.csvEscape).join(',')).join('\r\n'));
});

const yes = (v) => /^(1|y|yes|true|x)$/i.test(String(v || '').trim());

router.post('/products-import', ...withUpload(csvUpload.single('file')), async (req, res) => {
  if (!req.file) {
    flash(req, 'error', 'Please choose a CSV file.');
    return res.redirect('/admin/products-import');
  }
  const rows = h.parseCSV(req.file.buffer.toString('utf8'));
  const result = { created: 0, updated: 0, errors: [] };

  await db.transaction(async (tx) => {
    const catByName = new Map((await tx.all('SELECT id, name, slug FROM categories')).flatMap((c) => [[c.name.toLowerCase(), c.id], [c.slug, c.id]]));
    const supByName = new Map((await tx.all('SELECT id, name FROM suppliers')).map((s) => [s.name.toLowerCase(), s.id]));

    for (const [i, r] of rows.entries()) {
      const line = i + 2;
      if (!r.name) {
        result.errors.push(`Line ${line}: missing name — skipped.`);
        continue;
      }
      let categoryId = null;
      if (r.category) {
        categoryId = catByName.get(r.category.toLowerCase()) || catByName.get(h.slugify(r.category));
        if (!categoryId) {
          const slug = await h.uniqueSlug(tx, 'categories', r.category);
          categoryId = await tx.insert('INSERT INTO categories (name, slug, icon, sort_order) VALUES (?, ?, ?, 100)', [r.category, slug, 'box']);
          catByName.set(r.category.toLowerCase(), categoryId);
        }
      }
      let supplierId = null;
      if (r.supplier) {
        supplierId = supByName.get(r.supplier.toLowerCase());
        if (!supplierId) {
          supplierId = await tx.insert('INSERT INTO suppliers (name) VALUES (?)', [r.supplier]);
          supByName.set(r.supplier.toLowerCase(), supplierId);
        }
      }
      const stockAvailable = r.stock_available ? yes(r.stock_available) : h.toNumberOrNull(r.stock_price) !== null;
      const p = {
        name: r.name.slice(0, 200),
        sku: r.sku || null,
        category_id: categoryId,
        supplier_id: supplierId,
        short_description: r.short_description || '',
        description: r.description || '',
        specs: (r.specs || '').replace(/\s*\|\s*/g, '\n'),
        unit: r.unit || 'piece',
        moq: Math.max(1, h.toIntOrNull(r.moq) || 1),
        sourcing_available: r.sourcing_available ? (yes(r.sourcing_available) ? 1 : 0) : 1,
        china_price: h.toNumberOrNull(r.china_price),
        china_lead_days: h.toIntOrNull(r.china_lead_days),
        stock_available: stockAvailable ? 1 : 0,
        stock_price: h.toNumberOrNull(r.stock_price),
        stock_qty: h.toIntOrNull(r.stock_qty),
        stock_location: r.stock_location || '',
        featured: yes(r.featured) ? 1 : 0,
        active: 1,
      };
      if (!p.sourcing_available && !p.stock_available) p.sourcing_available = 1;
      const existing = p.sku ? await tx.get('SELECT id FROM products WHERE sku = ?', [p.sku]) : null;
      if (existing) {
        await tx.run(
          `UPDATE products SET name=@name, category_id=@category_id, supplier_id=COALESCE(@supplier_id, supplier_id), short_description=@short_description,
            description=@description, specs=@specs, unit=@unit, moq=@moq, sourcing_available=@sourcing_available, china_price=@china_price,
            china_lead_days=@china_lead_days, stock_available=@stock_available, stock_price=@stock_price, stock_qty=@stock_qty,
            stock_location=@stock_location, featured=@featured, updated_at=now() WHERE id=@id`,
          { ...p, id: existing.id }
        );
        result.updated++;
      } else {
        await tx.run(`INSERT INTO products (${PRODUCT_COLUMNS}) VALUES (${PRODUCT_VALUES})`, { ...p, slug: await h.uniqueSlug(tx, 'products', p.name) });
        result.created++;
      }
    }
  });
  res.render('admin/import', { title: 'Bulk import products', columns: CSV_COLUMNS, result });
});

// ---------------- Categories ----------------

const ICONS = ['cpu', 'cog', 'truck', 'car', 'sofa', 'bricks', 'grid', 'droplet', 'roof', 'door', 'bolt', 'sun', 'box', 'shirt', 'tool', 'leaf'];

router.get('/categories', async (req, res) => {
  const categories = await db.all(
    'SELECT c.*, (SELECT COUNT(*)::int FROM products p WHERE p.category_id = c.id) AS product_count FROM categories c ORDER BY sort_order, name'
  );
  res.render('admin/categories', { title: 'Categories', categories, icons: ICONS });
});

router.post('/categories', async (req, res) => {
  const name = trim(req.body.name, 100);
  if (!name) {
    flash(req, 'error', 'Category name is required.');
    return res.redirect('/admin/categories');
  }
  const id = h.toIntOrNull(req.body.id);
  const data = {
    name,
    description: trim(req.body.description, 500),
    icon: ICONS.includes(req.body.icon) ? req.body.icon : 'box',
    sort_order: h.toIntOrNull(req.body.sort_order) || 0,
  };
  if (id) {
    await db.run('UPDATE categories SET name=@name, description=@description, icon=@icon, sort_order=@sort_order WHERE id=@id', { ...data, id });
  } else {
    await db.run('INSERT INTO categories (name, slug, description, icon, sort_order) VALUES (@name, @slug, @description, @icon, @sort_order)', {
      ...data,
      slug: await h.uniqueSlug(db, 'categories', name),
    });
  }
  flash(req, 'success', 'Category saved.');
  res.redirect('/admin/categories');
});

router.post('/categories/:id/delete', async (req, res) => {
  await db.run('DELETE FROM categories WHERE id = ?', [h.toIntOrNull(req.params.id)]);
  flash(req, 'success', 'Category deleted. Its products are now uncategorised.');
  res.redirect('/admin/categories');
});

// ---------------- Suppliers ----------------

router.get('/suppliers', async (req, res) => {
  const [suppliers, editing] = await Promise.all([
    db.all('SELECT s.*, (SELECT COUNT(*)::int FROM products p WHERE p.supplier_id = s.id) AS product_count FROM suppliers s ORDER BY name'),
    req.query.edit ? db.get('SELECT * FROM suppliers WHERE id = ?', [h.toIntOrNull(req.query.edit)]) : null,
  ]);
  res.render('admin/suppliers', { title: 'Suppliers', suppliers, editing });
});

router.post('/suppliers', async (req, res) => {
  const data = {
    name: trim(req.body.name, 160),
    contact_person: trim(req.body.contact_person, 120),
    phone: trim(req.body.phone, 60),
    email: trim(req.body.email, 160),
    wechat: trim(req.body.wechat, 80),
    city: trim(req.body.city, 80),
    country: trim(req.body.country, 80) || 'China',
    notes: trim(req.body.notes, 4000),
  };
  if (!data.name) {
    flash(req, 'error', 'Supplier name is required.');
    return res.redirect('/admin/suppliers');
  }
  const id = h.toIntOrNull(req.body.id);
  if (id) {
    await db.run(
      'UPDATE suppliers SET name=@name, contact_person=@contact_person, phone=@phone, email=@email, wechat=@wechat, city=@city, country=@country, notes=@notes WHERE id=@id',
      { ...data, id }
    );
  } else {
    await db.run(
      'INSERT INTO suppliers (name, contact_person, phone, email, wechat, city, country, notes) VALUES (@name, @contact_person, @phone, @email, @wechat, @city, @country, @notes)',
      data
    );
  }
  flash(req, 'success', 'Supplier saved.');
  res.redirect('/admin/suppliers');
});

router.post('/suppliers/:id/delete', async (req, res) => {
  await db.run('DELETE FROM suppliers WHERE id = ?', [h.toIntOrNull(req.params.id)]);
  flash(req, 'success', 'Supplier deleted.');
  res.redirect('/admin/suppliers');
});

// ---------------- Orders ----------------

router.get('/orders', async (req, res) => {
  const status = h.STATUS_KEYS.includes(req.query.status) ? req.query.status : '';
  const q = trim(req.query.q, 100);
  const where = [];
  const params = {};
  if (status) {
    where.push('o.status = @status');
    params.status = status;
  }
  if (q) {
    where.push('(o.ref ILIKE @q OR o.customer_name ILIKE @q OR o.email ILIKE @q OR o.phone ILIKE @q OR o.company ILIKE @q)');
    params.q = `%${q}%`;
  }
  const orders = await db.all(
    `SELECT o.*, (SELECT COUNT(*)::int FROM order_items i WHERE i.order_id = o.id) AS item_count,
      (SELECT string_agg(DISTINCT mode, ',') FROM order_items i WHERE i.order_id = o.id) AS modes
     FROM orders o ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.created_at DESC, o.id DESC LIMIT 500`,
    params
  );
  res.render('admin/orders', { title: 'Orders', orders, status, q });
});

router.get('/orders.csv', async (req, res) => {
  const rows = await db.all('SELECT * FROM orders ORDER BY created_at DESC');
  const cols = ['ref', 'created_at', 'status', 'customer_name', 'email', 'phone', 'company', 'country', 'city', 'shipping_method', 'estimate_total', 'goods_total', 'shipping_cost', 'other_charges', 'quoted_total', 'tracking_number'];
  const value = (v) => (v instanceof Date ? v.toISOString() : v);
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => h.csvEscape(value(r[c]))).join(','))].join('\r\n');
  res.type('text/csv').attachment('lionheart-orders.csv').send(csv);
});

function findOrder(ref) {
  return db.get('SELECT * FROM orders WHERE ref = ?', [String(ref || '').toUpperCase()]);
}

router.get('/orders/:ref', async (req, res) => {
  const order = await findOrder(req.params.ref);
  if (!order) return res.status(404).render('error', { title: 'Not found', message: 'Order not found.' });
  const detail = await loadOrderDetail(order);
  const productIds = detail.items.map((i) => i.product_id).filter(Boolean);
  const suppliers = productIds.length
    ? await db.all(
        `SELECT p.id AS product_id, s.* FROM products p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id IN (${productIds.map(() => '?').join(', ')})`,
        productIds
      )
    : [];
  detail.items.forEach((i) => {
    i.supplier = suppliers.find((s) => s.product_id === i.product_id) || null;
  });
  res.render('admin/order', { title: `Order ${order.ref}`, ...detail });
});

// Update pricing / quotation
router.post('/orders/:ref/quote', async (req, res) => {
  const order = await findOrder(req.params.ref);
  if (!order) return res.redirect('/admin/orders');
  const items = await db.all('SELECT id FROM order_items WHERE order_id = ? ORDER BY id', [order.id]);
  const prices = [].concat(req.body.unit_price || []);
  for (const [i, it] of items.entries()) {
    await db.run('UPDATE order_items SET unit_price = ? WHERE id = ? AND order_id = ?', [h.toNumberOrNull(prices[i]), it.id, order.id]);
  }
  const goods = await db.get(
    'SELECT COALESCE(SUM(unit_price * qty), 0) AS t, COUNT(*) FILTER (WHERE unit_price IS NULL)::int AS missing FROM order_items WHERE order_id = ?',
    [order.id]
  );
  const shipping = h.toNumberOrNull(req.body.shipping_cost);
  const other = h.toNumberOrNull(req.body.other_charges);
  const goodsTotal = goods.t || 0;
  const quoted = h.toNumberOrNull(req.body.quoted_total) ?? goodsTotal + (shipping || 0) + (other || 0);
  await db.run('UPDATE orders SET goods_total = ?, shipping_cost = ?, other_charges = ?, quoted_total = ?, updated_at = now() WHERE id = ?', [
    goodsTotal,
    shipping,
    other,
    quoted,
    order.id,
  ]);

  if (req.body.send_quote) {
    if (goods.missing) {
      flash(req, 'error', 'Prices saved, but every item needs a unit price before the quotation can be sent.');
      return res.redirect(`/admin/orders/${order.ref}`);
    }
    const msg = trim(req.body.quote_message, 2000) || 'Your quotation is ready. Please review the prices and accept to proceed.';
    await db.run("UPDATE orders SET status = 'quoted', customer_message = ?, updated_at = now() WHERE id = ?", [msg, order.id]);
    await db.run('INSERT INTO order_events (order_id, status, message, created_by) VALUES (?, ?, ?, ?)', [order.id, 'quoted', msg, req.user.id]);
    flash(req, 'success', 'Quotation sent. The customer can now see and accept it from their order page.');
  } else flash(req, 'success', 'Prices saved.');
  res.redirect(`/admin/orders/${order.ref}`);
});

router.post('/orders/:ref/status', async (req, res) => {
  const order = await findOrder(req.params.ref);
  if (!order) return res.redirect('/admin/orders');
  const status = h.STATUS_KEYS.includes(req.body.status) ? req.body.status : order.status;
  const message = trim(req.body.message, 2000);
  const tracking = trim(req.body.tracking_number, 120);
  await db.run(
    "UPDATE orders SET status = ?, tracking_number = ?, customer_message = COALESCE(NULLIF(?, ''), customer_message), updated_at = now() WHERE id = ?",
    [status, tracking || null, message, order.id]
  );
  if (status !== order.status || message) {
    await db.run('INSERT INTO order_events (order_id, status, message, created_by) VALUES (?, ?, ?, ?)', [order.id, status, message || null, req.user.id]);
  }
  flash(req, 'success', `Order updated: ${h.statusLabel(status)}.`);
  res.redirect(`/admin/orders/${order.ref}`);
});

router.post('/orders/:ref/notes', async (req, res) => {
  const order = await findOrder(req.params.ref);
  if (!order) return res.redirect('/admin/orders');
  await db.run('UPDATE orders SET internal_notes = ?, updated_at = now() WHERE id = ?', [trim(req.body.internal_notes, 10000), order.id]);
  flash(req, 'success', 'Internal notes saved.');
  res.redirect(`/admin/orders/${order.ref}`);
});

// ---------------- Sourcing requests ----------------

router.get('/requests', async (req, res) => {
  const requests = await db.all(
    'SELECT r.*, c.name AS category_name FROM sourcing_requests r LEFT JOIN categories c ON c.id = r.category_id ORDER BY r.created_at DESC, r.id DESC LIMIT 500'
  );
  res.render('admin/requests', { title: 'Sourcing requests', requests });
});

router.get('/requests/:ref', async (req, res) => {
  const request = await db.get(
    'SELECT r.*, c.name AS category_name FROM sourcing_requests r LEFT JOIN categories c ON c.id = r.category_id WHERE r.ref = ?',
    [String(req.params.ref).toUpperCase()]
  );
  if (!request) return res.status(404).render('error', { title: 'Not found', message: 'Request not found.' });
  res.render('admin/request', { title: `Request ${request.ref}`, request });
});

router.post('/requests/:ref', async (req, res) => {
  const status = h.SOURCING_STATUSES.some((s) => s.key === req.body.status) ? req.body.status : 'new';
  await db.run('UPDATE sourcing_requests SET status = ?, admin_reply = ?, updated_at = now() WHERE ref = ?', [
    status,
    trim(req.body.admin_reply, 4000),
    String(req.params.ref).toUpperCase(),
  ]);
  flash(req, 'success', 'Request updated.');
  res.redirect(`/admin/requests/${encodeURIComponent(req.params.ref)}`);
});

// ---------------- Customers & staff ----------------

router.get('/customers', async (req, res) => {
  const users = await db.all(
    `SELECT u.id, u.name, u.email, u.phone, u.company, u.country, u.role, u.created_at,
      (SELECT COUNT(*)::int FROM orders o WHERE o.user_id = u.id) AS order_count
     FROM users u ORDER BY u.role = 'customer', u.created_at DESC`
  );
  res.render('admin/customers', { title: 'Customers & team', users });
});

router.post('/users', requireAdmin, async (req, res) => {
  const email = trim(req.body.email, 160).toLowerCase();
  const name = trim(req.body.name, 120);
  const password = String(req.body.password || '');
  const role = ['staff', 'admin'].includes(req.body.role) ? req.body.role : 'staff';
  if (!name || !email || password.length < 8) {
    flash(req, 'error', 'Name, email and a password of at least 8 characters are required.');
  } else if (await db.get('SELECT 1 AS ok FROM users WHERE lower(email) = ?', [email])) {
    flash(req, 'error', 'A user with that email already exists.');
  } else {
    await db.run('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', [name, email, await bcrypt.hash(password, 10), role]);
    flash(req, 'success', `Team member ${name} added.`);
  }
  res.redirect('/admin/customers');
});

router.post('/users/:id/role', requireAdmin, async (req, res) => {
  const id = h.toIntOrNull(req.params.id);
  const role = ['customer', 'staff', 'admin'].includes(req.body.role) ? req.body.role : null;
  if (id === req.user.id) flash(req, 'error', 'You cannot change your own role.');
  else if (role) {
    await db.run('UPDATE users SET role = ? WHERE id = ?', [role, id]);
    flash(req, 'success', 'Role updated.');
  }
  res.redirect('/admin/customers');
});

// ---------------- Settings ----------------

router.get('/settings', requireAdmin, async (req, res) => {
  const [values, alerts, alertLog, sampleData] = await Promise.all([getSettings(), notify.status(), notify.recentLog(), demo.hasSampleData()]);
  res.render('admin/settings', {
    title: 'Settings',
    values,
    keys: Object.keys(DEFAULT_SETTINGS).filter((k) => !k.startsWith('alert_')),
    alerts,
    alertLog,
    sampleData,
  });
});

router.post('/settings', requireAdmin, async (req, res) => {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (req.body[key] !== undefined) await setSetting(key, trim(req.body[key], 4000));
  }
  flash(req, 'success', 'Settings saved.');
  res.redirect(req.body.alerts_form ? '/admin/settings#alerts' : '/admin/settings');
});

router.post('/settings/sample-data', requireAdmin, async (req, res) => {
  if (req.body.action === 'remove') {
    await demo.removeSampleData();
    flash(req, 'success', 'Sample orders, requests and suppliers removed.');
  } else {
    try {
      await demo.loadSampleData(req.user.id);
      flash(req, 'success', 'Sample data loaded: 5 orders at different stages, 2 sourcing requests and 4 suppliers.');
    } catch (err) {
      flash(req, 'error', err.message);
    }
  }
  res.redirect('/admin/settings#sample-data');
});

router.post('/settings/test-alert', requireAdmin, async (req, res) => {
  const { emailConfigured, whatsappProvider } = await notify.status();
  if (!emailConfigured && !whatsappProvider) {
    flash(req, 'error', 'No alert channel is set up yet. Follow the setup steps below, then restart the server.');
  } else {
    await notify.sendTest(`${req.protocol}://${req.get('host')}`);
    const failed = (await notify.recentLog(10)).filter((l) => l.subject === 'Lionheart test alert' && l.status === 'failed').length;
    flash(req, failed ? 'error' : 'success', failed ? 'Some test alerts failed. See the log below for the reason.' : 'Test alert sent. Check your inbox and WhatsApp.');
  }
  res.redirect('/admin/settings#alerts');
});

module.exports = router;
